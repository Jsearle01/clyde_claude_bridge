import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import { EventEmitter } from "node:events";
import {
  locateCliBinary,
  getApiKey,
  startDaemon,
  CliBinaryNotFoundError,
} from "../src/daemon-lifecycle.js";
import type { SecretsApi } from "../src/daemon-lifecycle.js";

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

describe("locateCliBinary (T-P2-004)", () => {
  it("returns the override path verbatim when configOverride is non-empty", () => {
    expect(locateCliBinary("/custom/claude-bridge")).toBe("/custom/claude-bridge");
  });

  it("auto-detects on PATH when override is empty and probe succeeds", () => {
    const spawnSync = vi.fn(() => ({ status: 0, error: undefined })) as never;
    expect(locateCliBinary(undefined, { spawnSync })).toBe("claude-bridge");
    expect(locateCliBinary("", { spawnSync })).toBe("claude-bridge");
  });

  it("throws CliBinaryNotFoundError when override empty and probe fails", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as never;
    expect(() => locateCliBinary(undefined, { spawnSync })).toThrow(
      CliBinaryNotFoundError,
    );
  });

  it("CliBinaryNotFoundError lists what was probed", () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      error: new Error("ENOENT"),
    })) as never;
    try {
      locateCliBinary(undefined, { spawnSync });
    } catch (err) {
      expect(err).toBeInstanceOf(CliBinaryNotFoundError);
      if (err instanceof CliBinaryNotFoundError) {
        expect(err.searchedPaths.length).toBeGreaterThan(0);
        expect(err.message).toContain("PATH");
      }
    }
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
    expect(spawnCall[1]).toEqual(["start"]);
  });

  it("classifies daemon-already-running based on stderr text", async () => {
    const secrets = makeSecretsMock();
    const child = new FakeChild();
    const spawn = vi.fn(() => child) as never;
    const promise = startDaemon(
      { secrets: secrets.api },
      { cliPath: "/fake/claude-bridge" },
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
