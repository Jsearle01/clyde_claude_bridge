import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import {
  locateCliBinary,
  candidatesFor,
  getApiKey,
  startDaemon,
  runStartDaemonCommand,
  makeDaemonNotRunningHandler,
  CliBinaryNotFoundError,
} from "../src/daemon-lifecycle.js";
import type { SecretsApi } from "../src/daemon-lifecycle.js";
import { deriveSpawnArgs } from "../src/daemon-lifecycle.js";
import { makeWorkspaceConfig } from "./mocks/vscode.js";

// P3′-3: startDaemon now takes a derived per-workspace target (--workspace/--name).
const TARGET = { workspace: "c:\\projects\\demo", name: "demo" };

function makeSecretsMock(initial: Record<string, string> = {}): {
  api: SecretsApi;
  store: Record<string, string>;
  getMock: ReturnType<typeof vi.fn>;
  storeMock: ReturnType<typeof vi.fn>;
} {
  const store: Record<string, string> = { ...initial };
  const getMock = vi.fn((key: string) => Promise.resolve(store[key]));
  const storeMock = vi.fn((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  });
  const deleteMock = vi.fn((key: string) => {
    delete store[key];
    return Promise.resolve();
  });
  return {
    api: { get: getMock, store: storeMock, delete: deleteMock },
    store,
    getMock,
    storeMock,
  };
}

// Fake ChildProcess that lets tests control exit/error events.
class FakeChild extends EventEmitter {
  public pid: number | undefined = 4242;
  public stderr: EventEmitter & { setEncoding: (enc: string) => void };
  public unref(): void {
    /* noop */
  }
  constructor() {
    super();
    const stderr = new EventEmitter() as EventEmitter & {
      setEncoding: (enc: string) => void;
    };
    stderr.setEncoding = () => undefined;
    this.stderr = stderr;
  }
}

describe("locateCliBinary (T-P2-004 + T-P2-004.5)", () => {
  it("returns the override path verbatim when configOverride is non-empty", () => {
    expect(locateCliBinary("/custom/claude-bridge")).toBe("/custom/claude-bridge");
  });

  it("Unix candidate list: bare claude-bridge reachable returns 'claude-bridge'", () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    expect(
      locateCliBinary(undefined, { spawnSync, candidates: ["claude-bridge"] }),
    ).toBe("claude-bridge");
    expect(
      locateCliBinary("", { spawnSync, candidates: ["claude-bridge"] }),
    ).toBe("claude-bridge");
  });

  it("throws CliBinaryNotFoundError when override empty and all candidates fail", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as never;
    expect(() =>
      locateCliBinary(undefined, { spawnSync, candidates: ["claude-bridge"] }),
    ).toThrow(CliBinaryNotFoundError);
  });

  it("CliBinaryNotFoundError.searchedNames lists all tried candidates + message points at cliPath setting", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as never;
    try {
      locateCliBinary(undefined, {
        spawnSync,
        candidates: ["claude-bridge.cmd", "claude-bridge.exe", "claude-bridge"],
      });
    } catch (err) {
      expect(err).toBeInstanceOf(CliBinaryNotFoundError);
      if (err instanceof CliBinaryNotFoundError) {
        expect(err.searchedNames).toEqual([
          "claude-bridge.cmd",
          "claude-bridge.exe",
          "claude-bridge",
        ]);
        expect(err.message).toContain("claude-bridge.cmd");
        expect(err.message).toContain("claudeBridge.cliPath");
      }
    }
  });
});

// T-P2-004.5: Windows .cmd shim resolution.
// Reproduces the production bug where bare-name `spawnSync("claude-bridge", ...)`
// failed even though `claude-bridge.cmd` was reachable. Fix iterates platform
// candidates explicitly rather than relying on Node's PATHEXT auto-resolution.

describe("locateCliBinary — Windows shim resolution (T-P2-004.5)", () => {
  const winCandidates = ["claude-bridge.cmd", "claude-bridge.exe", "claude-bridge"];

  it("returns claude-bridge.cmd when .cmd shim is reachable (probe stops at first hit)", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, error: undefined }) as never;
    const result = locateCliBinary(undefined, {
      spawnSync,
      candidates: winCandidates,
    });
    expect(result).toBe("claude-bridge.cmd");
    expect(spawnSync).toHaveBeenCalledTimes(1);
    // objectContaining (not strict equality) so the shell option's
    // platform-conditional value (true on Windows for CVE-2024-27980;
    // false on Unix) doesn't break the test across hosts. Tests assert
    // the option-shape we care about; daemon-lifecycle.ts owns the rest.
    expect(spawnSync).toHaveBeenCalledWith(
      "claude-bridge.cmd",
      ["--version"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("falls through to .exe when .cmd probe fails", () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: null, error: new Error("ENOENT") })
      .mockReturnValueOnce({ status: 0, error: undefined }) as never;
    const result = locateCliBinary(undefined, {
      spawnSync,
      candidates: winCandidates,
    });
    expect(result).toBe("claude-bridge.exe");
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("throws CliBinaryNotFoundError with full Windows candidate list when all three fail", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as never;
    try {
      locateCliBinary(undefined, { spawnSync, candidates: winCandidates });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliBinaryNotFoundError);
      if (err instanceof CliBinaryNotFoundError) {
        expect(err.searchedNames).toEqual(winCandidates);
        expect(err.message).toContain("claude-bridge.cmd");
        expect(err.message).toContain("claude-bridge.exe");
        expect(err.message).toContain("claude-bridge");
      }
    }
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
});

describe("getApiKey (T-P2-004)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns env value when present; does not consult SecretStorage", async () => {
    const secrets = makeSecretsMock();
    const showInputBox = vi.fn(() => Promise.resolve(undefined as string | undefined));
    const result = await getApiKey(secrets.api, {
      envValue: "sk-ant-fromenv",
      showInputBox,
    });
    expect(result).toBe("sk-ant-fromenv");
    expect(secrets.getMock).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("treats empty-string env as missing and falls through to SecretStorage", async () => {
    const secrets = makeSecretsMock({ "claudeBridge.anthropicApiKey": "sk-ant-stored" });
    const showInputBox = vi.fn(() => Promise.resolve(undefined as string | undefined));
    const result = await getApiKey(secrets.api, {
      envValue: "",
      showInputBox,
    });
    expect(result).toBe("sk-ant-stored");
    expect(secrets.getMock).toHaveBeenCalledWith("claudeBridge.anthropicApiKey");
    expect(showInputBox).not.toHaveBeenCalled();
  });

  it("prompts when both env and SecretStorage are empty; stores and returns submitted value", async () => {
    const secrets = makeSecretsMock();
    const showInputBox = vi.fn(() =>
      Promise.resolve("sk-ant-typed" as string | undefined),
    );
    const result = await getApiKey(secrets.api, {
      envValue: undefined,
      showInputBox,
    });
    expect(result).toBe("sk-ant-typed");
    expect(secrets.storeMock).toHaveBeenCalledWith(
      "claudeBridge.anthropicApiKey",
      "sk-ant-typed",
    );
    const callArg = showInputBox.mock.calls[0]?.[0];
    expect(callArg?.password).toBe(true);
    expect(callArg?.ignoreFocusOut).toBe(true);
    expect(callArg?.prompt).toMatch(/SecretStorage/i);
  });

  it("returns undefined when prompt is dismissed (undefined return)", async () => {
    const secrets = makeSecretsMock();
    const showInputBox = vi.fn(() => Promise.resolve(undefined as string | undefined));
    const result = await getApiKey(secrets.api, {
      envValue: undefined,
      showInputBox,
    });
    expect(result).toBeUndefined();
    expect(secrets.storeMock).not.toHaveBeenCalled();
  });

  it("returns undefined when prompt submits empty string; does not store", async () => {
    const secrets = makeSecretsMock();
    const showInputBox = vi.fn(() => Promise.resolve("" as string | undefined));
    const result = await getApiKey(secrets.api, {
      envValue: undefined,
      showInputBox,
    });
    expect(result).toBeUndefined();
    expect(secrets.storeMock).not.toHaveBeenCalled();
  });
});

describe("startDaemon (T-P2-004)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns binary_not_found when locateCliBinary throws", async () => {
    const secrets = makeSecretsMock();
    const result = await startDaemon(
      { secrets: secrets.api },
      { cliPath: undefined },
      TARGET,
      {
        spawnSync: vi.fn(() => ({
          status: null,
          error: new Error("ENOENT"),
        })) as never,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("binary_not_found");
    }
  });

  it("happy path: env key + spawn succeeds + returns pid before observation window closes", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const showInputBox = vi.fn(() => Promise.resolve(undefined));
    const promise = startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
      TARGET,
      {
        spawn,
        showInputBox,
        envValue: "sk-ant-env",
        observationWindowMs: 100,
      },
    );
    // Don't fire any exit/error events — let the observation window close.
    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(4242);
    }
    expect(secrets.getMock).not.toHaveBeenCalled();
    expect(showInputBox).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const spawnCall = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    if (spawnCall === undefined) throw new Error("expected spawn call");
    expect(spawnCall[0]).toBe("/fake/claude-bridge");
    // P3′-3: derived args forwarded (platform-agnostic — quoting differs by OS).
    const args = spawnCall[1] as string[];
    expect(args[0]).toBe("start");
    expect(args).toContain("--workspace");
    expect(args).toContain("--name");
  });

  it("classifies daemon-already-running based on stderr text", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const promise = startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
      TARGET,
      {
        spawn,
        envValue: "sk-ant-env",
        observationWindowMs: 100,
      },
    );
    // Simulate stderr + early exit
    setImmediate(() => {
      child.stderr.emit("data", "Daemon already running (pid 99999)\n");
      child.emit("exit", 1);
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("already_running");
      expect(result.error).toContain("already running");
    }
  });

  it("classifies generic early-exit stderr as spawn_failed", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const promise = startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
      TARGET,
      {
        spawn,
        envValue: "sk-ant-env",
        observationWindowMs: 100,
      },
    );
    setImmediate(() => {
      child.stderr.emit("data", "cloudflared not found on PATH\n");
      child.emit("exit", 1);
    });
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("spawn_failed");
      expect(result.error).toContain("cloudflared");
    }
  });

  it("returns spawn_failed when spawn throws synchronously", async () => {
    const secrets = makeSecretsMock();
    const spawn = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    }) as never;
    const result = await startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
      TARGET,
      {
        spawn,
        envValue: "sk-ant-env",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("spawn_failed");
      expect(result.error).toContain("EACCES");
    }
  });

  it("integration: no API key anywhere + prompt dismissed → spawn still proceeds without ANTHROPIC_API_KEY", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const showInputBox = vi.fn(() => Promise.resolve(undefined as string | undefined));
    const promise = startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
      TARGET,
      {
        spawn,
        showInputBox,
        envValue: undefined,
        observationWindowMs: 100,
      },
    );
    const result = await promise;
    expect(result.ok).toBe(true);
    // Prompt was offered.
    expect(showInputBox).toHaveBeenCalledTimes(1);
    // Nothing was stored.
    expect(secrets.storeMock).not.toHaveBeenCalled();
    // Spawn was invoked with env that does NOT carry an injected api key.
    const spawnOpts = (spawn as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | { env?: Record<string, string> }
      | undefined;
    expect(spawnOpts?.env?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// CB-LINUX-LAUNCH-TESTS: the platform-driven launch contract. Locks in the
// Linux-native (generic-POSIX) decision logic — bare binary + shell:false —
// alongside the win32 contract, by injecting `platform` rather than mutating
// the global process.platform. CEILING: correct-by-construction +
// mocked-platform-covered, NOT live-confirmed (a real unix-socket connect /
// detached-spawn / bare-binary PATH resolution needs a real Linux host; P4 CI).

describe("platform launch contract — Linux-native + win32 (CB-LINUX-LAUNCH-TESTS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("candidatesFor: linux/darwin -> single bare binary; win32 -> .cmd/.exe/bare", () => {
    expect(candidatesFor("linux")).toEqual(["claude-bridge"]);
    expect(candidatesFor("darwin")).toEqual(["claude-bridge"]);
    expect(candidatesFor("win32")).toEqual([
      "claude-bridge.cmd",
      "claude-bridge.exe",
      "claude-bridge",
    ]);
  });

  it("locateCliBinary on linux: probes bare 'claude-bridge' with shell:false", () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    const result = locateCliBinary(undefined, { spawnSync, platform: "linux" });
    expect(result).toBe("claude-bridge");
    expect(spawnSync).toHaveBeenCalledWith(
      "claude-bridge",
      ["--version"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("locateCliBinary on win32: probes the .cmd shim first with shell:true", () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    const result = locateCliBinary(undefined, { spawnSync, platform: "win32" });
    expect(result).toBe("claude-bridge.cmd");
    expect(spawnSync).toHaveBeenCalledWith(
      "claude-bridge.cmd",
      ["--version"],
      expect.objectContaining({ shell: true }),
    );
  });

  it("startDaemon on linux: spawns bare 'claude-bridge start' with shell:false + detached:true", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    // Probe resolves the bare binary (no cliPath override).
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    const result = await startDaemon(
      { secrets: secrets.api },
      { cliPath: undefined },
      TARGET,
      { spawn, spawnSync, envValue: "sk-ant-env", observationWindowMs: 50, platform: "linux" },
    );
    expect(result.ok).toBe(true);
    const call = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    if (call === undefined) throw new Error("expected spawn call");
    expect(call[0]).toBe("claude-bridge");
    // P3′-3: linux (shell:false) passes args verbatim — no quoting.
    expect(call[1]).toEqual([
      "start",
      "--workspace",
      "c:\\projects\\demo",
      "--name",
      "demo",
    ]);
    expect(call[2]).toEqual(
      expect.objectContaining({ shell: false, detached: true }),
    );
  });

  it("startDaemon on win32: resolves the .cmd shim and spawns with shell:true + detached:true", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    // First candidate (claude-bridge.cmd) probes successfully.
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    const result = await startDaemon(
      { secrets: secrets.api },
      { cliPath: undefined },
      TARGET,
      { spawn, spawnSync, envValue: "sk-ant-env", observationWindowMs: 50, platform: "win32" },
    );
    expect(result.ok).toBe(true);
    const call = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    if (call === undefined) throw new Error("expected spawn call");
    expect(call[0]).toBe("claude-bridge.cmd");
    expect(call[2]).toEqual(
      expect.objectContaining({ shell: true, detached: true }),
    );
  });
});

// T-P2-005: runStartDaemonCommand UI binding tests. Extracted from
// extension.ts at T-P2-005's second-use moment (palette command +
// autoStart hook + new daemon-not-running notification button).

describe("deriveSpawnArgs (P3'-3, AC-3-5)", () => {
  it("win32: --workspace = canonicalized fsPath, --name = basename", () => {
    // The captured fsPath (T-P3'-0) canonicalizes to a case-preserving form;
    // the daemon then case-folds it to the identity the advert carries, which
    // is what discovery byte-matches. basename is the folder name.
    expect(deriveSpawnArgs("C:\\Projects\\clyde_claude_bridge", "win32")).toEqual({
      workspace: "c:\\Projects\\clyde_claude_bridge",
      name: "clyde_claude_bridge",
    });
  });
  it("win32: forward-slash + trailing-slash input still derives the basename", () => {
    expect(deriveSpawnArgs("C:/Projects/demo/", "win32")).toEqual({
      workspace: "c:\\Projects\\demo",
      name: "demo",
    });
  });
  it("posix: case-preserving canonical + basename", () => {
    expect(deriveSpawnArgs("/home/jay/Projects/clyde", "posix")).toEqual({
      workspace: "/home/jay/Projects/clyde",
      name: "clyde",
    });
  });
});

describe("runStartDaemonCommand (T-P2-005 / P3'-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default config: empty cliPath, autoStartDaemon false.
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
      makeWorkspaceConfig({ cliPath: "/fake/claude-bridge" }),
    );
    // P3′-3: runStartDaemonCommand derives --workspace/--name from folder [0].
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: "C:\\Projects\\demo" }, name: "demo" },
    ];
  });
  afterEach(() => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it("happy path: maps {ok, pid} to showInformationMessage with 'daemon starting' text", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    await runStartDaemonCommand(
      { secrets: secrets.api },
      {
        spawn,
        envValue: "sk-ant-env",
        observationWindowMs: 50,
      },
    );
    const info = vi.mocked(vscode.window.showInformationMessage);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/daemon starting/i);
    expect(info.mock.calls[0]?.[0]).toMatch(/pid 4242/);
  });

  it("AC-3-9 already_running path: benign info 'already running — connected'", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const promise = runStartDaemonCommand(
      { secrets: secrets.api },
      {
        spawn,
        envValue: "sk-ant-env",
        observationWindowMs: 100,
      },
    );
    setImmediate(() => {
      child.stderr.emit("data", "Daemon already running (pid 99999)\n");
      child.emit("exit", 1);
    });
    await promise;
    // P3′-3 (AC-3-9): the 1c lock refused the duplicate; surfaced as a benign
    // info ("already running — connected"), not a warning/error.
    const info = vi.mocked(vscode.window.showInformationMessage);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/already running/i);
  });

  it("error path: maps to showErrorMessage with the error reason", async () => {
    const secrets = makeSecretsMock();
    const spawn = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    }) as never;
    await runStartDaemonCommand(
      { secrets: secrets.api },
      {
        spawn,
        envValue: "sk-ant-env",
      },
    );
    const err = vi.mocked(vscode.window.showErrorMessage);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[0]).toContain("EACCES");
  });
});

// T-P2-005: makeDaemonNotRunningHandler threshold + once-per-session +
// autoStart-suppression tests. Each factory call yields a fresh handler
// with closure-local guard state (no shared module state across tests).

describe("makeDaemonNotRunningHandler (T-P2-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHandlerWithMocks(opts: {
    autoStart?: boolean;
  } = {}): {
    handler: (attempt: number) => void;
    showWarning: ReturnType<typeof vi.fn>;
    runStart: ReturnType<typeof vi.fn>;
  } {
    const secrets = makeSecretsMock();
    const showWarning = vi.fn<
      (msg: string, ...items: string[]) => Promise<string | undefined>
    >(() => Promise.resolve(undefined));
    const runStart = vi.fn(() => Promise.resolve());
    const handler = makeDaemonNotRunningHandler(
      { secrets: secrets.api },
      {
        getAutoStartSetting: () => opts.autoStart ?? false,
        showWarningMessage: showWarning,
        runStartDaemon: runStart,
      },
    );
    return { handler, showWarning, runStart };
  }

  it("does not fire on attempts 1 and 2 (below threshold)", () => {
    const { handler, showWarning } = makeHandlerWithMocks();
    handler(1);
    handler(2);
    expect(showWarning).not.toHaveBeenCalled();
  });

  it("fires on attempt 3 with expected message text and Start Daemon button", async () => {
    const { handler, showWarning } = makeHandlerWithMocks();
    handler(3);
    // The async-IIFE inside the handler awaits showWarning; flush microtasks.
    await Promise.resolve();
    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(showWarning.mock.calls[0]?.[0]).toContain(
      "Claude Bridge daemon is not running",
    );
    expect(showWarning.mock.calls[0]?.[1]).toBe("Start Daemon");
  });

  it("does not re-fire on attempts 4, 5, ... (once-per-session guard)", async () => {
    const { handler, showWarning } = makeHandlerWithMocks();
    handler(3);
    await Promise.resolve();
    handler(4);
    handler(5);
    handler(10);
    expect(showWarning).toHaveBeenCalledTimes(1);
  });

  it("does not fire when autoStartDaemon setting is true", async () => {
    const { handler, showWarning } = makeHandlerWithMocks({ autoStart: true });
    handler(3);
    handler(10);
    await Promise.resolve();
    expect(showWarning).not.toHaveBeenCalled();
  });

  it("autoStart setting is read at notification-time (each invocation)", async () => {
    // Build the handler with a getAutoStartSetting that returns true on
    // first call and false on second; if the handler caches the value at
    // factory time, the second fire wouldn't proceed. If it reads on each
    // call (correct behavior), the first call suppresses and the
    // subsequent threshold-met call fires.
    const secrets = makeSecretsMock();
    let lookupCount = 0;
    const showWarning = vi.fn<
      (msg: string, ...items: string[]) => Promise<string | undefined>
    >(() => Promise.resolve(undefined));
    const handler = makeDaemonNotRunningHandler(
      { secrets: secrets.api },
      {
        getAutoStartSetting: (): boolean => {
          lookupCount += 1;
          return lookupCount === 1; // true first call, false thereafter
        },
        showWarningMessage: showWarning,
        runStartDaemon: vi.fn(() => Promise.resolve()),
      },
    );
    handler(3);
    expect(showWarning).not.toHaveBeenCalled();
    handler(4);
    await Promise.resolve();
    expect(showWarning).toHaveBeenCalledTimes(1);
  });

  it("clicking Start Daemon invokes runStartDaemon with the context", async () => {
    const { handler, showWarning, runStart } = makeHandlerWithMocks();
    showWarning.mockResolvedValueOnce("Start Daemon");
    handler(3);
    // Flush via setImmediate so all queued microtasks (showWarning
    // resolve → await unblock → runStart call) drain. Matches the
    // daemon-test microtask-flush pattern from T-0012.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runStart).toHaveBeenCalledTimes(1);
  });

  it("dismissing the notification (undefined return) does not invoke runStartDaemon", async () => {
    const { handler, showWarning, runStart } = makeHandlerWithMocks();
    showWarning.mockResolvedValueOnce(undefined);
    handler(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(showWarning).toHaveBeenCalledTimes(1);
    expect(runStart).not.toHaveBeenCalled();
  });
});
