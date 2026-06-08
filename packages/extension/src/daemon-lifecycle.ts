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
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import * as vscode from "vscode";
import { canonicalizeWorkspacePath } from "@claude-bridge/shared";

const SECRET_KEY = "claudeBridge.anthropicApiKey";
const SPAWN_OBSERVATION_WINDOW_MS = 5_000;

// Windows requires explicit shim extensions because Node's child_process
// doesn't reliably resolve bare names via PATHEXT in the VS Code extension
// host (regardless of why — see v0.6 candidate C-20). Iterating candidates
// is explicit and avoids the shell:true escape hazard. The bare name is
// kept at the end of the Windows list as a defensive fallback in case a
// future host resolves it natively. T-P2-004.5 fix.
//
// Computed from `platform` (defaulted to the host) rather than an
// import-time const so the win32-vs-posix selection is directly assertable
// in tests (CB-LINUX-LAUNCH-TESTS) — Linux-native takes the single-element
// bare-name arm.
export function candidatesFor(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === "win32"
    ? ["claude-bridge.cmd", "claude-bridge.exe", "claude-bridge"]
    : ["claude-bridge"];
}

// P3′-3 (AC-3-5): derive the daemon's start args from the VS Code workspace
// folder so the spawned daemon's identity can't drift from what discovery will
// match. --workspace = canonicalized fsPath (the daemon re-canonicalizes +
// case-folds to the identity the advert carries); --name = the folder basename.
// Platform-injected basename so the win32 backslash path splits correctly on a
// posix CI host too.
export function deriveSpawnArgs(
  fsPath: string,
  platform: NodeJS.Platform = process.platform,
): { workspace: string; name: string } {
  const canonPlatform = platform === "win32" ? "win32" : "posix";
  const workspace = canonicalizeWorkspacePath(fsPath, canonPlatform);
  const pathApi = canonPlatform === "win32" ? pathWin32 : pathPosix;
  const name = pathApi.basename(workspace) || workspace;
  return { workspace, name };
}

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
  // Test injection point: defaults to candidatesFor(platform) (Windows-aware
  // list). Tests pass explicit platform-shaped lists rather than mutating
  // process.platform — matches cross-platform-test-inputs pattern.
  candidates?: readonly string[];
  // Injectable platform (defaulted to the host) — drives both the default
  // candidate list and the probe's shell flag, so the win32-vs-posix
  // behavior is assertable without mutating the global process.platform.
  platform?: NodeJS.Platform;
};

// Returns the binary name to invoke. If `configOverride` is non-empty, it
// wins (no liveness check — spawn will surface a clear error if wrong).
// Otherwise iterates platform candidates (candidatesFor(platform) by default) and
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
  const platform = deps.platform ?? process.platform;
  const candidates = deps.candidates ?? candidatesFor(platform);
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
      shell: platform === "win32",
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
  // Injectable platform (defaulted to the host) — drives the spawn's shell
  // flag and the candidate list, so the win32-vs-posix spawn contract is
  // assertable without mutating the global process.platform.
  platform?: NodeJS.Platform;
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
  // P3′-3: the derived per-workspace target (canonical --workspace + --name).
  target: { workspace: string; name: string },
  deps: StartDaemonDeps = {},
): Promise<StartDaemonResult> {
  const platform = deps.platform ?? process.platform;
  let binary: string;
  try {
    binary = locateCliBinary(config.cliPath, {
      spawnSync: deps.spawnSync,
      platform,
    });
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
  // P3′-3: forward the derived --workspace/--name. On win32 the spawn uses
  // shell:true (CVE-2024-27980 — the .cmd shim needs it), so the VALUE args
  // (which can contain spaces) are double-quoted for cmd.exe; the literal flags
  // need no quoting. On posix (shell:false) args pass through verbatim.
  const q = platform === "win32" ? (s: string): string => `"${s}"` : (s: string): string => s;
  const args = [
    "start",
    "--workspace",
    q(target.workspace),
    "--name",
    q(target.name),
  ];
  let child: ChildProcess;
  try {
    child = spawnFn(binary, args, {
      detached: true,
      // stdio: ignore stdin/stdout (CLI's ready signal goes to stdout but
      // we're non-blocking; we only care about stderr for immediate
      // failures). Matches the CLI's own daemon-spawn idiom from
      // packages/cli/src/commands/start.ts (detached + windowsHide).
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env,
      // CVE-2024-27980: same workaround as the locateCliBinary probe —
      // required for spawning a .cmd shim on Windows.
      shell: platform === "win32",
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

// UI binding for the daemon-start flow. Maps the typed `startDaemon()`
// result to VS Code notifications. Used by three call sites:
//   - The "Claude Bridge: Start Daemon" palette command (T-P2-004)
//   - The autoStartDaemon activation hook (T-P2-004)
//   - The daemon-not-running notification button (T-P2-005)
// Extracted from extension.ts at T-P2-005's second-use moment so all
// three call sites share the same mapping. Behavior is identical to the
// inline version it replaced.
export async function runStartDaemonCommand(
  context: { secrets: SecretsApi },
  deps: StartDaemonDeps = {},
): Promise<void> {
  // P3′-3: derive --workspace/--name from the open folder so the spawned daemon
  // advertises the identity discovery will match. Multi-root → folder [0]
  // (consistent with 2b pairing-on-[0]).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    void vscode.window.showErrorMessage(
      "Claude Bridge: open a workspace folder before starting a daemon.",
    );
    return;
  }
  const target = deriveSpawnArgs(folder.uri.fsPath);
  const config = vscode.workspace.getConfiguration("claudeBridge");
  const cliPath = config.get<string>("cliPath", "");
  const result = await startDaemon(
    context,
    { cliPath: cliPath === "" ? undefined : cliPath },
    target,
    deps,
  );
  if (result.ok) {
    // AC-3-8 (honest promise): the spawn brings the daemon UP + ADVERTISING; it
    // does NOT create the tunnel/connector/OAuth binding (those stay operator
    // steps). Discovery (2b) pairs once the advert appears — no "seamless setup".
    void vscode.window.showInformationMessage(
      `Claude Bridge: daemon starting for '${target.name}' (pid ${String(result.pid)}) — ` +
        `pairing automatically once it's advertising.`,
    );
    return;
  }
  if (result.kind === "already_running") {
    // AC-3-9: the 1c lock refused a duplicate; the incumbent is fine and
    // discovery is already (or will be) paired with it. Benign.
    void vscode.window.showInformationMessage(
      "Claude Bridge: a daemon for this workspace is already running — connected.",
    );
    return;
  }
  void vscode.window.showErrorMessage(`Claude Bridge: ${result.error}`);
}

// T-P2-005: factory for the IpcClient.onReconnectAttempt callback. Each
// activation builds a fresh handler with closure-local guard state, so
// the once-per-session guard naturally resets on extension reactivation
// without needing a module-scope reset. All UI dependencies are
// injectable for unit testing.
const NOTIFICATION_THRESHOLD = 3;

export interface DaemonNotRunningHandlerDeps {
  getAutoStartSetting?: () => boolean;
  // PromiseLike covers both VS Code's Thenable return and Promise-returning
  // test mocks (T-P2-004 SecretStorage precedent).
  showWarningMessage?: (
    message: string,
    ...items: string[]
  ) => PromiseLike<string | undefined>;
  runStartDaemon?: (context: { secrets: SecretsApi }) => Promise<void>;
}

export function makeDaemonNotRunningHandler(
  context: { secrets: SecretsApi },
  deps: DaemonNotRunningHandlerDeps = {},
): (attempt: number) => void {
  let fired = false; // closure-local once-per-session guard
  const getAutoStart =
    deps.getAutoStartSetting ??
    ((): boolean =>
      vscode.workspace
        .getConfiguration("claudeBridge")
        .get<boolean>("autoStartDaemon", false));
  const showWarning =
    deps.showWarningMessage ?? vscode.window.showWarningMessage;
  const runStart = deps.runStartDaemon ?? runStartDaemonCommand;
  return (attempt: number): void => {
    if (attempt < NOTIFICATION_THRESHOLD) return;
    if (fired) return;
    if (getAutoStart()) return;
    fired = true;
    void (async () => {
      const choice = await showWarning(
        "Claude Bridge daemon is not running. Workspace delegations won't work until it's started.",
        "Start Daemon",
      );
      if (choice === "Start Daemon") {
        await runStart(context);
      }
    })();
  };
}
