// Daemon-lifecycle command logic. The extension invokes the existing
// `claude-bridge` CLI's `start` subcommand as a detached subprocess
// (Option A from T-P2-004 pre-conversation): all daemon-spawn logic
// (cloudflared pre-flight, PID file, ready signal, 15s timeout) stays in
// the CLI. The extension is thin — it locates the binary, resolves the
// API key, spawns, watches for immediate-spawn-failure, and returns.
// IpcClient's existing reconnect loop (T-P2-002) handles the connecting →
// connected transition as the daemon comes up.
//
// All external dependencies are injectable for testability: `spawn`,
// `spawnSync`, and `showInputBox` (and the `process` env object) can be
// overridden. Tests do NOT spawn real processes.

import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
} from "node:child_process";
import * as vscode from "vscode";

const SECRET_KEY = "claudeBridge.anthropicApiKey";
const SPAWN_OBSERVATION_WINDOW_MS = 5_000;

// Windows requires explicit shim extensions because Node's child_process
// doesn't reliably resolve bare names via PATHEXT in the VS Code extension
// host (regardless of why — see v0.6 candidate C-20). Iterating candidates
// is explicit and avoids the shell:true escape hazard. The bare name is
// kept at the end of the Windows list as a defensive fallback in case a
// future host resolves it natively. T-P2-004.5 fix.
export const CLI_CANDIDATES: readonly string[] =
  process.platform === "win32"
    ? ["claude-bridge.cmd", "claude-bridge.exe", "claude-bridge"]
    : ["claude-bridge"];

export class CliBinaryNotFoundError extends Error {
  constructor(public readonly searchedNames: readonly string[]) {
    super(
      `claude-bridge CLI binary not found on PATH. Tried: ${searchedNames.join(", ")}. ` +
        `Set the "claudeBridge.cliPath" setting to override the auto-detection.`,
    );
    this.name = "CliBinaryNotFoundError";
  }
}

export class DaemonSpawnFailedError extends Error {
  constructor(
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(
      `Daemon failed to start: ${stderr || "unknown error"} (exit ${String(exitCode)})`,
    );
    this.name = "DaemonSpawnFailedError";
  }
}

export type LocateCliDeps = {
  spawnSync?: typeof nodeSpawnSync;
  // Test injection point: defaults to CLI_CANDIDATES (Windows-aware list).
  // Tests pass explicit platform-shaped lists rather than mutating
  // process.platform — matches cross-platform-test-inputs pattern.
  candidates?: readonly string[];
};

// Returns the binary name to invoke. If `configOverride` is non-empty, it
// wins (no liveness check — spawn will surface a clear error if wrong).
// Otherwise iterates platform candidates (CLI_CANDIDATES by default) and
// returns the first name where `spawnSync(name, ["--version"])` returns
// status 0. On all-fail, throws CliBinaryNotFoundError with the full list
// of names that were tried.
export function locateCliBinary(
  configOverride: string | undefined,
  deps: LocateCliDeps = {},
): string {
  if (configOverride !== undefined && configOverride.length > 0) {
    return configOverride;
  }
  const spawnSync = deps.spawnSync ?? nodeSpawnSync;
  const candidates = deps.candidates ?? CLI_CANDIDATES;
  const tried: string[] = [];
  for (const name of candidates) {
    tried.push(name);
    const probe = spawnSync(name, ["--version"], {
      stdio: "ignore",
      // CVE-2024-27980: Node's spawn/spawnSync returns EINVAL for .cmd
      // and .bat on Windows unless shell:true. Required for the .cmd
      // shim to resolve at all, regardless of bare/explicit/absolute
      // naming. Args here are literal ("--version") so cmd.exe parsing
      // is unambiguous; if future args carry user-controlled content
      // they need explicit quoting at that future call site.
      shell: process.platform === "win32",
    });
    if (probe.error === undefined && probe.status === 0) {
      return name;
    }
  }
  throw new CliBinaryNotFoundError(tried);
}

// PromiseLike rather than Promise so vscode.SecretStorage (which returns
// Thenable<T> = PromiseLike<T>) satisfies the interface. `await` works on
// PromiseLike just as well as on Promise.
export interface SecretsApi {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export type GetApiKeyDeps = {
  envValue?: string | undefined;
  showInputBox?: typeof vscode.window.showInputBox;
};

// API key resolution order: env → SecretStorage → showInputBox prompt.
// Empty-string env value is treated as missing. On prompt submit with a
// non-empty value, stores in SecretStorage AND returns the value. On
// dismiss (undefined) or empty submit, returns undefined — the daemon
// will warn and continue per main.ts:265-269.
export async function getApiKey(
  secrets: SecretsApi,
  deps: GetApiKeyDeps = {},
): Promise<string | undefined> {
  const envKey = deps.envValue ?? process.env.ANTHROPIC_API_KEY;
  if (envKey !== undefined && envKey.length > 0) return envKey;
  const stored = await secrets.get(SECRET_KEY);
  if (stored !== undefined && stored.length > 0) return stored;
  const showInputBox = deps.showInputBox ?? vscode.window.showInputBox;
  const entered = await showInputBox({
    password: true,
    ignoreFocusOut: true,
    prompt:
      "Enter your Anthropic API key (will be stored securely in VS Code SecretStorage)",
  });
  if (entered === undefined || entered.length === 0) return undefined;
  await secrets.store(SECRET_KEY, entered);
  return entered;
}

export type StartDaemonDeps = {
  spawn?: typeof nodeSpawn;
  spawnSync?: typeof nodeSpawnSync;
  showInputBox?: typeof vscode.window.showInputBox;
  envValue?: string | undefined;
  observationWindowMs?: number;
};

export type StartDaemonResult =
  | { ok: true; pid: number }
  | { ok: false; kind: "binary_not_found"; error: string }
  | { ok: false; kind: "already_running"; error: string }
  | { ok: false; kind: "spawn_failed"; error: string };

// Spawn `claude-bridge start` as a detached subprocess. Returns
// non-blocking within the observation window (default 5s). The CLI's own
// 15s ready-wait runs in the spawned subprocess; the extension's window
// catches "spawn failed immediately" (binary error, daemon-already-running,
// etc.) and surfaces appropriately.
export async function startDaemon(
  context: { secrets: SecretsApi },
  config: { cliPath: string | undefined },
  deps: StartDaemonDeps = {},
): Promise<StartDaemonResult> {
  let binary: string;
  try {
    binary = locateCliBinary(config.cliPath, { spawnSync: deps.spawnSync });
  } catch (err) {
    if (err instanceof CliBinaryNotFoundError) {
      return { ok: false, kind: "binary_not_found", error: err.message };
    }
    throw err;
  }

  const apiKey = await getApiKey(context.secrets, {
    envValue: deps.envValue,
    showInputBox: deps.showInputBox,
  });

  const env = { ...process.env };
  if (apiKey !== undefined) env.ANTHROPIC_API_KEY = apiKey;

  const spawnFn = deps.spawn ?? nodeSpawn;
  let child: ChildProcess;
  try {
    child = spawnFn(binary, ["start"], {
      detached: true,
      // stdio: ignore stdin/stdout (CLI's ready signal goes to stdout but
      // we're non-blocking; we only care about stderr for immediate
      // failures). Matches the CLI's own daemon-spawn idiom from
      // packages/cli/src/commands/start.ts (detached + windowsHide).
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env,
      // CVE-2024-27980: same workaround as the locateCliBinary probe —
      // required for spawning a .cmd shim on Windows. Args are literal
      // ("start") so cmd.exe parsing is unambiguous.
      shell: process.platform === "win32",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: "spawn_failed", error: msg };
  }

  if (child.pid === undefined) {
    return {
      ok: false,
      kind: "spawn_failed",
      error: "subprocess started but no pid was assigned",
    };
  }

  // Detach from parent's event loop reference so VS Code can exit while
  // the daemon keeps running (matches CLI's idiom).
  child.unref();

  const pid = child.pid;
  const windowMs = deps.observationWindowMs ?? SPAWN_OBSERVATION_WINDOW_MS;

  // Race the observation window against an early exit. The window is
  // shorter than the CLI's own 15s ready-wait because we're catching
  // "fails immediately" (binary error, already-running) — not "started
  // but timed out."
  const result = await observeEarlyFailure(child, windowMs);
  if (result.exited) {
    const stderr = result.stderr.trim();
    const isAlreadyRunning =
      stderr.includes("already running") || stderr.includes("Daemon already running");
    if (isAlreadyRunning) {
      return { ok: false, kind: "already_running", error: stderr };
    }
    return { ok: false, kind: "spawn_failed", error: stderr || "subprocess exited" };
  }
  return { ok: true, pid };
}

interface ObservationResult {
  exited: boolean;
  stderr: string;
}

function observeEarlyFailure(
  child: ChildProcess,
  windowMs: number,
): Promise<ObservationResult> {
  return new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const settle = (result: ObservationResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once("exit", () => {
      settle({ exited: true, stderr });
    });
    child.once("error", (err: Error) => {
      settle({ exited: true, stderr: err.message });
    });
    setTimeout(() => {
      settle({ exited: false, stderr });
    }, windowMs);
  });
}
