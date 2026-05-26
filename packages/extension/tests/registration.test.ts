import { describe, it, expect, vi, beforeEach } from "vitest";
import { Uri, type WorkspaceFolder } from "./mocks/vscode.js";
import { WorkspaceRegistration } from "../src/registration.js";
import type { IpcClient } from "../src/ipc/client.js";

// Minimal IpcClient stand-in. We only need getConnectionState() + request();
// the real IpcClient has more surface but registration doesn't touch it.
interface FakeIpcClient {
  getConnectionState: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
}

function makeConnectedClient(
  responseQueue: unknown[],
): FakeIpcClient & IpcClient {
  const queue = [...responseQueue];
  const client: FakeIpcClient = {
    getConnectionState: vi.fn(() => "connected"),
    request: vi.fn(() => {
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(new Error("test: no more queued responses"));
      }
      return Promise.resolve(next);
    }),
  };
  return client as FakeIpcClient & IpcClient;
}

function makeFolder(fsPath: string, name: string): WorkspaceFolder {
  return { uri: Uri.file(fsPath), name };
}

describe("WorkspaceRegistration (T-P2-003)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns no_workspace when no workspace folder is open", async () => {
    const client = makeConnectedClient([]);
    const reg = new WorkspaceRegistration(client, undefined);
    const result = await reg.register();
    expect(result).toEqual({ state: "no_workspace" });
    expect(reg.getState()).toBe("unregistered");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("transitions to registered when daemon returns already-trusted ok", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "myproject-aaaaaa",
        name: "MyProject",
        abs_path: "/some/path",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/some/path", "MyProject"),
    );
    const result = await reg.register();
    expect(result).toEqual({
      state: "registered",
      identifier: "myproject-aaaaaa",
      was_already_trusted: true,
    });
    expect(reg.getState()).toBe("registered");
    expect(reg.getIdentifier()).toBe("myproject-aaaaaa");
  });

  it("shows trust prompt on needs_trust + sends confirm_trust on Trust", async () => {
    const client = makeConnectedClient([
      { kind: "register_workspace_needs_trust", abs_path: "/new/path" },
      {
        kind: "register_workspace_ok",
        identifier: "new-bbbbbb",
        name: "New",
        abs_path: "/new/path",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: false,
      },
    ]);
    const trustPrompt = vi.fn<(p: string) => Promise<"trust" | "deny">>(
      () => Promise.resolve("trust"),
    );
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/new/path", "New"),
      trustPrompt,
    );
    const result = await reg.register();
    expect(result).toEqual({
      state: "registered",
      identifier: "new-bbbbbb",
      was_already_trusted: false,
    });
    expect(trustPrompt).toHaveBeenCalledWith("/new/path");
    expect(client.request).toHaveBeenCalledTimes(2);
    const secondCall = (client.request as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as { kind: string };
    expect(secondCall.kind).toBe("confirm_trust");
  });

  it("transitions to trust_denied on user Don't trust without sending confirm_trust", async () => {
    const client = makeConnectedClient([
      { kind: "register_workspace_needs_trust", abs_path: "/new/path" },
    ]);
    const trustPrompt = vi.fn<(p: string) => Promise<"trust" | "deny">>(
      () => Promise.resolve("deny"),
    );
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/new/path", "New"),
      trustPrompt,
    );
    const result = await reg.register();
    expect(result).toEqual({ state: "trust_denied" });
    expect(reg.getState()).toBe("trust_denied");
    expect(client.request).toHaveBeenCalledTimes(1); // only register, no confirm
  });

  it("transitions to duplicate on path_already_registered + parses existing pid", async () => {
    const client = makeConnectedClient([
      {
        kind: "error",
        message:
          "Workspace path already registered by another VS Code window (pid 12345)",
        reason: "path_already_registered",
      },
    ]);
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/dup/path", "Dup"),
    );
    const result = await reg.register();
    expect(result).toEqual({ state: "duplicate", existing_pid: 12345 });
    expect(reg.getState()).toBe("duplicate");
    expect(reg.getExistingPid()).toBe(12345);
  });

  it("deregister sends deregister_workspace after successful registration", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: true,
      },
      { kind: "deregister_workspace_ok" },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    await reg.register();
    await reg.deregister();
    expect(client.request).toHaveBeenCalledTimes(2);
    const secondCall = (client.request as ReturnType<typeof vi.fn>).mock
      .calls[1]?.[0] as { kind: string; identifier: string };
    expect(secondCall.kind).toBe("deregister_workspace");
    expect(secondCall.identifier).toBe("x-aaaaaa");
    expect(reg.getState()).toBe("unregistered");
  });
});

// T-P2-006: onStateChange callback. Single-subscriber settable field;
// fires inside setState helper on each transition; idempotent assigns
// are no-ops; subscriber errors swallowed.

describe("WorkspaceRegistration.onStateChange callback (T-P2-006)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires on each state transition with the new state value", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    const transitions: string[] = [];
    reg.onStateChange = (s) => transitions.push(s);
    await reg.register();
    // Initial state is "unregistered"; register() transitions to
    // "registering" (fire 1) then to "registered" (fire 2).
    expect(transitions).toEqual(["registering", "registered"]);
  });

  it("does not fire on no-op assignment (initial state stays 'unregistered')", async () => {
    const client = makeConnectedClient([]);
    const reg = new WorkspaceRegistration(client, undefined);
    const transitions: string[] = [];
    reg.onStateChange = (s) => transitions.push(s);
    // register() with no workspace folder returns {state: "no_workspace"}
    // and the internal state stays at the initial "unregistered" —
    // setState("unregistered") is a no-op.
    await reg.register();
    expect(transitions).toEqual([]);
  });

  it("swallows subscriber errors; state machine continues", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    let callCount = 0;
    reg.onStateChange = (): void => {
      callCount += 1;
      throw new Error("subscriber blew up");
    };
    await reg.register();
    expect(callCount).toBe(2); // registering + registered
    expect(reg.getState()).toBe("registered");
  });
});

// T-P2-006.5: field-vs-state-ordering invariant. setState fires the
// onStateChange callback synchronously; class fields the callback reads
// must be assigned BEFORE setState. T-P2-006 introduced the callback;
// 3 call sites in registration.ts (the two register_workspace_ok branches
// and the path_already_registered branch) had setState BEFORE the field
// assignment, producing stale field reads in subscribers. These tests
// pin the ordering invariant.

describe("WorkspaceRegistration field-vs-state ordering (T-P2-006.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("identifier is set when onStateChange('registered') fires (ok branch)", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "myproject-54ab07",
        name: "MyProject",
        abs_path: "/some/path",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/some/path", "MyProject"),
    );
    let identifierAtRegistered: string | null | undefined = undefined;
    reg.onStateChange = (state) => {
      if (state === "registered") {
        identifierAtRegistered = reg.getIdentifier();
      }
    };
    await reg.register();
    expect(identifierAtRegistered).toBe("myproject-54ab07");
  });

  it("identifier is set when onStateChange('registered') fires (confirm_trust branch)", async () => {
    const client = makeConnectedClient([
      { kind: "register_workspace_needs_trust", abs_path: "/new/path" },
      {
        kind: "register_workspace_ok",
        identifier: "newproject-bbbbbb",
        name: "New",
        abs_path: "/new/path",
        trusted_at: "2026-05-24T00:00:00.000Z",
        was_already_trusted: false,
      },
    ]);
    const trustPrompt = vi.fn<(p: string) => Promise<"trust" | "deny">>(
      () => Promise.resolve("trust"),
    );
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/new/path", "New"),
      trustPrompt,
    );
    let identifierAtRegistered: string | null | undefined = undefined;
    reg.onStateChange = (state) => {
      if (state === "registered") {
        identifierAtRegistered = reg.getIdentifier();
      }
    };
    await reg.register();
    expect(identifierAtRegistered).toBe("newproject-bbbbbb");
  });

  it("existingPid is set when onStateChange('duplicate') fires", async () => {
    const client = makeConnectedClient([
      {
        kind: "error",
        message:
          "Workspace path already registered by another VS Code window (pid 12345)",
        reason: "path_already_registered",
      },
    ]);
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/dup/path", "Dup"),
    );
    let pidAtDuplicate: number | null | undefined = undefined;
    reg.onStateChange = (state) => {
      if (state === "duplicate") {
        pidAtDuplicate = reg.getExistingPid();
      }
    };
    await reg.register();
    expect(pidAtDuplicate).toBe(12345);
  });
});
