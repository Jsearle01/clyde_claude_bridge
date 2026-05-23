// `claude-bridge start` — spawn the daemon detached, wait for its ready
// signal on stdout, then send a status IPC to surface the URL + token to
// the user. Closes AC-1 from `01-p0-bus.md`.
//
// startCommand throws typed errors (CloudflaredMissingError,
// DaemonAlreadyRunningError, ...) rather than calling process.exit. The
// bin entry (index.ts) catches and maps to exit codes. This separation
// makes startCommand unit-testable without spawning real processes.

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnSyncOptions,
} from "node:child_process";
import { stat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  sendIpc,
  getCliConfigPath,
  loadCliConfig,
} from "../ipc-client.js";

const localRequire = createRequire(import.meta.url);

const READY_TIMEOUT_MS = 5000;

export class CloudflaredMissingError extends Error {
  constructor() {
    super("cloudflared not found on PATH");
    this.name = "CloudflaredMissingError";
  }
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number | null) {
    super(`Daemon already running${pid !== null ? ` (pid ${pid})` : ""}`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export class DaemonStartTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Daemon did not signal ready within ${timeoutMs}ms`);
    this.name = "DaemonStartTimeoutError";
  }
}

export class DaemonStartFailedError extends Error {
  constructor(public readonly stderrText: string) {
    super(`Daemon failed to start: ${stderrText}`);
    this.name = "DaemonStartFailedError";
  }
}

// CLI's PID file path (duplicates daemon's getPidPath; kept inline per
// T-0014's design intent to avoid cli→daemon TS coupling).
export function getCliPidPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new Error("APPDATA environment variable is not set");
    }
    return join(appData, "claude-bridge", "daemon.pid");
  }
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude-bridge", "daemon.pid");
}

// CLI's stale-PID check (duplicates daemon's checkStalePid; kept inline).
async function checkStalePid(
  path: string,
): Promise<"alive" | "stale" | "absent"> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "absent";
    }
    throw err;
  }
  const pid = Number.parseInt(content.trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) return "stale";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ESRCH") {
      return "stale";
    }
    return "alive";
  }
}

async function readPidFromFile(path: string): Promise<number | null> {
  try {
    const content = await readFile(path, "utf8");
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { status: number | null; error?: Error };

// Pre-flight: cloudflared must be on PATH. spawnSync is injectable for
// testing without depending on the host's PATH.
export function checkCloudflared(
  spawnSyncFn: SpawnSyncFn = spawnSync,
): void {
  const result = spawnSyncFn("cloudflared", ["--version"], { stdio: "ignore" });
  if (
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    throw new CloudflaredMissingError();
  }
  if (result.status !== 0) {
    throw new CloudflaredMissingError();
  }
}

// Pre-flight: refuse to start if another daemon is already running. Stale
// PID files are tolerated (daemon main.ts will overwrite). Returns the
// pre-flight outcome so the caller can decide whether to print a notice.
export async function checkExistingDaemon(): Promise<"absent" | "stale"> {
  const pidPath = getCliPidPath();
  const state = await checkStalePid(pidPath);
  if (state === "alive") {
    const pid = await readPidFromFile(pidPath);
    throw new DaemonAlreadyRunningError(pid);
  }
  return state;
}

// Wait for the daemon to write a `ready` line on stdout. Resolves on the
// first match; rejects on timeout, child exit before ready, or child error.
// `child.stderr` is consumed in parallel so any failure diagnostic is
// available in the rejection.
export function waitForReady(
  child: ChildProcess,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.stdout === null) {
      reject(new DaemonStartFailedError("child has no stdout pipe"));
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        reject(new DaemonStartTimeoutError(timeoutMs));
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    if (child.stderr !== null) child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      const idx = stdoutBuf.indexOf("\n");
      if (idx === -1) return;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "ready") {
          settle(() => {
            resolve();
          });
          return;
        }
      }
    });

    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on("exit", (code) => {
      settle(() => {
        reject(
          new DaemonStartFailedError(
            stderrBuf.trim() !== ""
              ? stderrBuf.trim()
              : `daemon exited with code ${String(code)} before signaling ready`,
          ),
        );
      });
    });

    child.on("error", (err: Error) => {
      settle(() => {
        reject(new DaemonStartFailedError(err.message));
      });
    });
  });
}

export async function startCommand(): Promise<void> {
  // 1. cloudflared on PATH
  checkCloudflared();

  // 2. config notice (the daemon itself runs first-run init; we only print
  //    a courtesy note if the file isn't there yet)
  const configPath = getCliConfigPath();
  try {
    await stat(configPath);
  } catch (err) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      process.stdout.write(
        `First-run init: daemon will create config at ${configPath}\n`,
      );
    } else {
      throw err;
    }
  }

  // 3. refuse if a daemon is already running
  const pidPreflight = await checkExistingDaemon();
  if (pidPreflight === "stale") {
    process.stderr.write("Stale PID file detected; daemon main will overwrite.\n");
  }

  // 4. spawn the daemon detached
  const daemonMainPath = localRequire.resolve("@claude-bridge/daemon");
  const child = spawn(process.execPath, [daemonMainPath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 5. wait for the ready signal
  await waitForReady(child);

  // 6. let the daemon survive our exit
  child.unref();
  child.stdout?.destroy();
  child.stderr?.destroy();

  // 7. fetch status via IPC for the tunnel URL
  const response = await sendIpc({ kind: "status" });
  if (response.kind !== "status_ok") {
    throw new Error(`Unexpected IPC response kind: ${response.kind}`);
  }

  // 8. read config for the full token (status only carries the suffix)
  const config = await loadCliConfig(configPath);

  // 9. print user-facing summary (matches daemon's own startup block)
  process.stdout.write(`Daemon up on ${response.payload.endpoint}\n`);
  process.stdout.write(
    `Tunnel: ${response.payload.tunnel_url ?? "(not available)"}\n`,
  );
  process.stdout.write(`Token:  ${config.auth.token}\n`);
}
