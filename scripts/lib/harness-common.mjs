// Shared daemon-lifecycle primitives for the P1 acceptance harnesses.
// Extracted at T-P1-011 (Phase 11) when the second harness (live SMOKE)
// landed and the duplication exceeded the >50-line threshold from the
// dispatch. Both `acceptance-p1.mjs` (StubJobRunner harness, T-P1-005)
// and `acceptance-p1-smoke.mjs` (SdkJobRunner live SMOKE harness,
// T-P1-011) import from here.
//
// Surface kept intentionally minimal: temp env, config write, daemon
// spawn/stop, ready-poll, and the small pass/fail/extractResult helpers
// the AC implementations need. Harness-specific concerns (group runners,
// per-AC drain semantics, MCP-vs-direct call shapes) stay in the
// per-harness files.

import process from "node:process";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(dirname(__dirname));
export const DAEMON_MAIN = join(REPO_ROOT, "packages/daemon/dist/main.js");

export const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const READY_WAIT_MS = 20_000;
export const POLL_INTERVAL_MS = 250;

// Augment PATH with a well-known cloudflared location. Daemon main.ts
// awaits `tunnelManager.start()` before emitting `ready\n`, so a
// cloudflared spawn failure means the daemon never signals ready and
// the harness times out. Same pattern as P0's acceptance harness on
// Windows; Linux branch added at T-P1-012 for WSL/Ubuntu coverage
// (T-0019.6 left `~/cloudflared` as a user-local install, the same
// shape Phase 12 inherits).
export function ensureCloudflaredOnPath() {
  if (process.platform === "win32") {
    const cfDir = "C:\\Program Files (x86)\\cloudflared";
    if (existsSync(join(cfDir, "cloudflared.exe"))) {
      process.env.PATH = `${cfDir};${process.env.PATH ?? ""}`;
    }
    return;
  }
  if (process.platform === "linux" || process.platform === "darwin") {
    const home = process.env.HOME ?? "";
    const candidates = [
      join(home, "cloudflared"),
      "/usr/local/bin/cloudflared",
      "/usr/bin/cloudflared",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        const dir = dirname(c);
        const parts = (process.env.PATH ?? "").split(":");
        if (!parts.includes(dir)) {
          process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
        }
        return;
      }
    }
  }
}

// ---- Temp env setup ----

export function setupTempEnv(prefix = "cb-p1-accept-") {
  const tmpRoot = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(tmpRoot, "home");
  const workspaceDir = join(tmpRoot, "workspace");
  const configDir =
    platform() === "win32"
      ? join(homeDir, "claude-bridge")
      : join(homeDir, ".claude-bridge");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  return {
    tmpRoot,
    homeDir,
    workspaceDir,
    configDir,
    configPath: join(configDir, "config.json"),
    auditPath: join(configDir, "audit.jsonl"),
    logPath: join(configDir, "daemon.log"),
    ipcSocket: join(configDir, "daemon.sock"),
  };
}

export function cleanupTempEnv(env) {
  try {
    rmSync(env.tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// Write a daemon config to env.configPath. opts:
//   bind_port?: number (default 7423)
//   token?: string (default INERT_TOKEN)
//   workspace?: false (omit workspace block) | object (override workspace)
//   stub_behavior?: object (only meaningful when daemon launched with
//                          allowStubConfig=true; ignored by SdkJobRunner)
export function writeConfig(env, opts = {}) {
  const cfg = {
    version: 1,
    daemon: {
      bind_host: "127.0.0.1",
      bind_port: opts.bind_port ?? 7423,
      ipc_socket: env.ipcSocket,
    },
    auth: { token: opts.token ?? INERT_TOKEN },
    tunnel: {
      provider: "cloudflared",
      binary: "cloudflared",
      args_extra: [],
    },
    audit: { path: env.auditPath, retention_days: 30 },
    log: { path: env.logPath, level: "info" },
  };
  if (opts.workspace !== false) {
    cfg.workspace = opts.workspace ?? {
      id: "local#test",
      abs_path: env.workspaceDir,
      default_mode: "agentic",
    };
  }
  if (opts.stub_behavior) {
    cfg.stub_behavior = opts.stub_behavior;
  }
  writeFileSync(env.configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

// ---- Daemon lifecycle ----

// Spawn the daemon as a child process and wait for `ready\n` on stdout.
// opts:
//   allowStubConfig?: boolean (default false; pass true for StubJobRunner)
//   extraEnv?: object (env vars to forward, e.g. ANTHROPIC_API_KEY)
// Returns { child, url, token, tunnelUrl, stdoutBuf, stderrBuf }.
export async function startDaemon(env, opts = {}) {
  ensureCloudflaredOnPath();
  const args = [DAEMON_MAIN];
  if (opts.allowStubConfig === true) args.push("--allow-stub-config");
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      ...(opts.extraEnv ?? {}),
      HOME: env.homeDir,
      APPDATA: env.homeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let ready = false;
  let tunnelUrl = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    if (!ready && (stdoutBuf.includes("\nready\n") || stdoutBuf.startsWith("ready\n"))) {
      ready = true;
    }
    const m = /Tunnel:\s+(https?:\/\/\S+)/.exec(stdoutBuf);
    if (m) tunnelUrl = m[1];
  });
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
  });

  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) {
      throw new Error(
        `daemon exited early (code ${child.exitCode}); stderr: ${stderrBuf}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(
      `daemon did not signal ready within ${READY_WAIT_MS}ms; stderr: ${stderrBuf}`,
    );
  }

  // Localhost MCP URL is reachable as soon as the daemon emits ready,
  // even if cloudflared hasn't finished publishing the tunnel URL.
  const cfg = JSON.parse(readFileSync(env.configPath, "utf8"));
  const url = `http://${cfg.daemon.bind_host}:${cfg.daemon.bind_port}`;
  return { child, url, token: cfg.auth.token, tunnelUrl, stdoutBuf, stderrBuf };
}

export async function stopDaemon(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return undefined;
  return new Promise((resolve) => {
    handle.child.once("exit", () => resolve());
    handle.child.kill("SIGTERM");
    setTimeout(() => {
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGKILL");
      }
    }, 10_000).unref();
  });
}

// ---- AC helpers ----

export function pass(message, evidence) {
  return { pass: true, message, evidence };
}
export function fail(message, evidence) {
  return { pass: false, message, evidence };
}

export function extractResult(callResult) {
  return callResult.result.structuredContent ?? callResult.result;
}
