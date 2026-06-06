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

// T-P2-008.8 (C-29): registration intent persists across connection
// retries. State machine no longer transitions to "unregistered" on a
// transient connection failure; instead, it stays in "registering" and
// re-fires the register request when onConnectionStateChanged("connected")
// arrives. Retry counter is tracked for status-bar UX.

describe("WorkspaceRegistration intent persistence (T-P2-008.8 / C-29)", () => {
  // Mutable connection-state mock: starts disconnected; tests transition
  // it by calling setConnState() before invoking reg.onConnectionStateChanged().
  function makeFlakyClient(
    initialState: "connected" | "disconnected" | "connecting" = "disconnected",
    responseQueue: unknown[] = [],
  ): FakeIpcClient & IpcClient & { setConnState: (s: "connected" | "disconnected" | "connecting") => void } {
    const queue = [...responseQueue];
    let state: "connected" | "disconnected" | "connecting" = initialState;
    const client = {
      getConnectionState: vi.fn(() => state),
      request: vi.fn(() => {
        if (state !== "connected") {
          return Promise.reject(new Error("ipc-client: not connected"));
        }
        const next = queue.shift();
        if (next === undefined) {
          return Promise.reject(new Error("test: no more queued responses"));
        }
        return Promise.resolve(next);
      }),
      setConnState: (s: "connected" | "disconnected" | "connecting") => {
        state = s;
      },
    };
    return client as FakeIpcClient & IpcClient & {
      setConnState: (s: "connected" | "disconnected" | "connecting") => void;
    };
  }

  it("state stays 'registering' across N failed connect attempts", async () => {
    const client = makeFlakyClient("disconnected");
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    await reg.register();
    expect(reg.getState()).toBe("registering");
    // Simulate 5 transient-failure cycles (IpcClient fires onReconnectAttempt
    // per scheduled reconnect; onStateChange fires only on transitions —
    // disconnected is the initial state so subsequent "disconnected" assigns
    // are no-ops from IpcClient's perspective).
    for (let i = 1; i <= 5; i += 1) {
      reg.onReconnectAttempt(i);
    }
    expect(reg.getState()).toBe("registering");
    expect(reg.getRetryCount()).toBe(5);
    // request was never called (never connected).
    expect(client.request).not.toHaveBeenCalled();
  });

  it("fires register when onConnectionStateChanged('connected') arrives after retries", async () => {
    const client = makeFlakyClient("disconnected", [
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-28T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    await reg.register();
    expect(reg.getState()).toBe("registering");
    // 5 failures + 1 success.
    for (let i = 1; i <= 5; i += 1) {
      reg.onReconnectAttempt(i);
    }
    client.setConnState("connected");
    reg.onConnectionStateChanged("connected");
    // Wait for the in-flight register to resolve.
    await new Promise<void>((r) => setImmediate(r));
    expect(reg.getState()).toBe("registered");
    expect(reg.getIdentifier()).toBe("x-aaaaaa");
    expect(client.request).toHaveBeenCalledTimes(1);
    // Retry counter resets on connect.
    expect(reg.getRetryCount()).toBe(0);
  });

  it("retry counter increments on each onReconnectAttempt and fires onRetryCountChange", () => {
    const client = makeFlakyClient("disconnected");
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    void reg.register();
    const observed: number[] = [];
    reg.onRetryCountChange = (n) => observed.push(n);
    reg.onReconnectAttempt(1);
    reg.onReconnectAttempt(2);
    reg.onReconnectAttempt(3);
    expect(observed).toEqual([1, 2, 3]);
    expect(reg.getRetryCount()).toBe(3);
  });

  // C-26 invariant (field-precedes-setState): subscriber that reads
  // reg.getRetryCount() from inside the onRetryCountChange callback must
  // see the post-set counter value, not the pre-set value. Added
  // T-P2-006-followup as part of pattern-doc codification — the
  // parameter-based test above proves the arg is correct; this one proves
  // the field-accessor path is also correct (i.e., `this.retryCount` is
  // assigned BEFORE the callback fires inside setRetryCount).
  it("onRetryCountChange subscriber sees correct count via accessor (C-26 invariant)", () => {
    const client = makeFlakyClient("disconnected");
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    void reg.register();
    const accessorReads: number[] = [];
    reg.onRetryCountChange = () => {
      accessorReads.push(reg.getRetryCount());
    };
    reg.onReconnectAttempt(1);
    reg.onReconnectAttempt(2);
    reg.onReconnectAttempt(3);
    // Accessor reads inside the callback must reflect the just-set value.
    expect(accessorReads).toEqual([1, 2, 3]);
  });

  it("retry counter is NOT updated when state is already 'registered'", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-28T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    await reg.register();
    expect(reg.getState()).toBe("registered");
    reg.onReconnectAttempt(7);
    // State already registered → counter ignored.
    expect(reg.getRetryCount()).toBe(0);
  });

  it("onConnectionStateChanged('connected') is a no-op when already registered", async () => {
    const client = makeConnectedClient([
      {
        kind: "register_workspace_ok",
        identifier: "x-aaaaaa",
        name: "X",
        abs_path: "/x",
        trusted_at: "2026-05-28T00:00:00.000Z",
        was_already_trusted: true,
      },
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    await reg.register();
    reg.onConnectionStateChanged("connected");
    await new Promise<void>((r) => setImmediate(r));
    // request fired once for the initial register; the no-op listener
    // call did not fire a second.
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("transient request failure stays in 'registering' (no 'unregistered' transition)", async () => {
    const client = makeFlakyClient("connected", [
      // First attempt: rejected by the mock request impl (no queued response
      // after consuming the first — see makeFlakyClient default).
    ]);
    const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
    const transitions: string[] = [];
    reg.onStateChange = (s) => transitions.push(s);
    await reg.register();
    // Initial trigger transitions: unregistered → registering. Request
    // rejects → handler returns error result but stays in "registering"
    // (no "unregistered" transition fires).
    expect(reg.getState()).toBe("registering");
    expect(transitions).toEqual(["registering"]);
  });
});

// CB-DAEMON-LIFECYCLE-FIX (c1): the consent blocker. The daemon's activeRegistry
// is per-socket and dropped on disconnect; if the extension reconnects (daemon
// restart, or the doubled-daemon split) without RE-registering, the daemon has
// no record of it → /authorize fails extension_offline while the status bar
// still shows "registered". The fix re-arms registration on disconnect so the
// next "connected" re-sends register_workspace.
describe("WorkspaceRegistration — re-register on reconnect (CB-DAEMON-LIFECYCLE-FIX c1)", () => {
  const okResponse = {
    kind: "register_workspace_ok",
    identifier: "proj-aaaaaa",
    name: "P",
    abs_path: "/p",
    trusted_at: "2026-06-06T00:00:00.000Z",
    was_already_trusted: true,
  };

  // Flush the fire-and-forget re-attempt kicked off by onConnectionStateChanged.
  const flush = (): Promise<void> =>
    new Promise((r) => setTimeout(r, 0));

  it("re-sends register_workspace after disconnect+reconnect (the key fix)", async () => {
    const client = makeConnectedClient([okResponse, okResponse]);
    const reg = new WorkspaceRegistration(client, makeFolder("/p", "P"));

    await reg.register();
    expect(reg.getState()).toBe("registered");
    expect(client.request).toHaveBeenCalledTimes(1);

    // Daemon restarts → our socket drops.
    reg.onConnectionStateChanged("disconnected");
    expect(reg.getState()).toBe("registering"); // re-armed

    // IpcClient reconnects (possibly to a fresh daemon with an empty registry).
    reg.onConnectionStateChanged("connected");
    await flush();

    // The extension RE-REGISTERED automatically — no manual reload.
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "register_workspace", abs_path: "/p" }),
    );
    expect(reg.getState()).toBe("registered");
  });

  it("does NOT re-arm a user-decision state (trust_denied stays put across reconnect)", async () => {
    const client = makeConnectedClient([
      { kind: "register_workspace_needs_trust", abs_path: "/p" },
    ]);
    const reg = new WorkspaceRegistration(
      client,
      makeFolder("/p", "P"),
      () => Promise.resolve("deny"),
    );
    await reg.register();
    expect(reg.getState()).toBe("trust_denied");
    const callsAfterRegister = (client.request as ReturnType<typeof vi.fn>).mock
      .calls.length;

    reg.onConnectionStateChanged("disconnected");
    expect(reg.getState()).toBe("trust_denied"); // NOT re-armed
    reg.onConnectionStateChanged("connected");
    await flush();
    // No new register attempt fired.
    expect((client.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      callsAfterRegister,
    );
  });
});
