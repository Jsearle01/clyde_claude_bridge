import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import type { IpcResponse, StatusPayload } from "@claude-bridge/shared";
import {
  IpcServer,
  IpcSocketBusyError,
  type IpcHandlers,
} from "../../src/ipc/server.js";
import type { Logger } from "../../src/log/logger.js";

const INERT_TUNNEL_URL = "https://plum-otter-7821.trycloudflare.com";

const FIXED_PAYLOAD: StatusPayload = {
  daemon_pid: 12345,
  daemon_uptime_s: 60,
  endpoint: "127.0.0.1:7423",
  tunnel_status: "up",
  tunnel_url: INERT_TUNNEL_URL,
  token_suffix: "AAAA",
  audit_path: "/tmp/audit.jsonl",
  audit_size_bytes: 1024,
  attached_workspaces: 0,
};

// Silent logger — server tests don't assert on log lines.
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function makeHandlers(): IpcHandlers {
  return {
    status: vi.fn(() => Promise.resolve(FIXED_PAYLOAD)),
    stop: vi.fn(() => Promise.resolve()),
    // T-BEARER-1: tokenRotate handler removed.
    tunnelRestart: vi.fn(() => Promise.resolve({ new_url: INERT_TUNNEL_URL })),
  };
}

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-test-${randomBytes(6).toString("hex")}`;
}

// T-P2-002: every connection must hello-handshake before sending requests.
// `rpc()` does hello → hello_ok → request → response transparently for
// tests that don't care about the hello mechanics. `rpcRaw()` is for the
// hello-gate tests that need to send non-hello as the first message.
const HELLO_LINE = JSON.stringify({
  kind: "hello",
  version: "1.0",
  role: "cli",
  pid: 0,
});

function rpcRaw(
  address: string,
  lines: string[],
  expectedResponses: number,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const client = connect(address);
    let buf = "";
    const responses: string[] = [];
    let nextLine = 0;
    let settled = false;
    client.setEncoding("utf8");
    client.on("connect", () => {
      if (lines.length > 0) {
        client.write(lines[nextLine] + "\n");
        nextLine += 1;
      }
    });
    client.on("data", (chunk: string) => {
      if (settled) return;
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1 && responses.length < expectedResponses) {
        responses.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (nextLine < lines.length) {
          client.write(lines[nextLine] + "\n");
          nextLine += 1;
        }
        idx = buf.indexOf("\n");
      }
      if (responses.length >= expectedResponses) {
        settled = true;
        client.end();
        resolve(responses);
      }
    });
    client.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    client.on("close", () => {
      if (!settled) {
        settled = true;
        if (responses.length >= expectedResponses) {
          resolve(responses);
        } else {
          reject(new Error(`connection closed; got ${responses.length}/${expectedResponses} responses`));
        }
      }
    });
  });
}

// Hello-prelude wrapper: returns just the application-level response line
// (the hello_ok line is discarded).
async function rpc(address: string, line: string): Promise<string> {
  const [, response] = await rpcRaw(address, [HELLO_LINE, line], 2);
  if (response === undefined) throw new Error("missing response after hello");
  return response;
}

// Send two application-level lines on the same connection (with hello
// prelude), await two responses. The hello_ok response is consumed
// implicitly inside rpcRaw and discarded here.
async function rpcDouble(
  address: string,
  line1: string,
  line2: string,
): Promise<[string, string]> {
  const responses = await rpcRaw(address, [HELLO_LINE, line1, line2], 3);
  const [, r1, r2] = responses;
  if (r1 === undefined || r2 === undefined) {
    throw new Error("missing response after hello");
  }
  return [r1, r2];
}

describe("IpcServer", () => {
  let tempDir: string;
  let socketPath: string;
  let server: IpcServer | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-ipc-"));
    socketPath = join(tempDir, "daemon.sock");
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop().catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  // Helper: start a server with a per-test address override on Windows so
  // parallel test runs don't collide on the single canonical pipe name.
  function startConfig(
    handlers: IpcHandlers = makeHandlers(),
  ): { s: IpcServer; address: string } {
    const address =
      process.platform === "win32" ? uniquePipeName() : socketPath;
    const override = process.platform === "win32" ? address : undefined;
    const s = new IpcServer(socketPath, handlers, silentLogger, override);
    server = s;
    return { s, address };
  }

  it("starts and accepts a connection (11.a)", async () => {
    const { s, address } = startConfig();
    await s.start();
    await new Promise<void>((resolve, reject) => {
      const client = connect(address);
      client.on("connect", () => {
        client.end();
        resolve();
      });
      client.on("error", reject);
    });
  });

  it("status request returns status_ok with payload (11.b)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const line = await rpc(address, JSON.stringify({ kind: "status" }));
    const response = JSON.parse(line) as IpcResponse;
    expect(response.kind).toBe("status_ok");
    if (response.kind === "status_ok") {
      expect(response.payload.daemon_pid).toBe(FIXED_PAYLOAD.daemon_pid);
      expect(response.payload.endpoint).toBe(FIXED_PAYLOAD.endpoint);
      expect(response.payload.token_suffix).toBe(FIXED_PAYLOAD.token_suffix);
    }
  });

  it("stop request returns stop_ok and invokes the stop handler (11.c)", async () => {
    const handlers = makeHandlers();
    const { s, address } = startConfig(handlers);
    await s.start();
    const line = await rpc(address, JSON.stringify({ kind: "stop" }));
    expect((JSON.parse(line) as IpcResponse).kind).toBe("stop_ok");
    expect(handlers.stop).toHaveBeenCalledOnce();
  });

  // T-BEARER-1: the token_rotate IPC (11.d) was removed — no Bearer to rotate.

  it("tunnel_restart request returns tunnel_restart_ok (11.e)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const line = await rpc(
      address,
      JSON.stringify({ kind: "tunnel_restart" }),
    );
    const response = JSON.parse(line) as IpcResponse;
    expect(response.kind).toBe("tunnel_restart_ok");
    if (response.kind === "tunnel_restart_ok") {
      expect(response.new_url).toBe(INERT_TUNNEL_URL);
    }
  });

  // CB-SMOKE-READINESS-BATCH: CLI unbind routing.
  it("unbind_binding routes to the handler and returns unbind_binding_ok", async () => {
    const handlers = makeHandlers();
    const seen: Array<{ target: string | null; all: boolean }> = [];
    handlers.unbindBinding = (args) => {
      seen.push(args);
      return Promise.resolve({
        unbound: [
          {
            client_id: "cb_client_x",
            bound_workspace: "ws-A",
            tokens_revoked: 2,
          },
        ],
      });
    };
    const { s, address } = startConfig(handlers);
    await s.start();
    const line = await rpc(
      address,
      JSON.stringify({ kind: "unbind_binding", target: "ws-A", all: false }),
    );
    const response = JSON.parse(line) as IpcResponse;
    expect(response.kind).toBe("unbind_binding_ok");
    if (response.kind === "unbind_binding_ok") {
      expect(response.unbound).toHaveLength(1);
      expect(response.unbound[0]?.bound_workspace).toBe("ws-A");
      expect(response.unbound[0]?.tokens_revoked).toBe(2);
    }
    expect(seen).toEqual([{ target: "ws-A", all: false }]);
  });

  it("unbind_binding returns an error when the daemon has no unbind handler wired", async () => {
    const { s, address } = startConfig(makeHandlers()); // no unbindBinding
    await s.start();
    const line = await rpc(
      address,
      JSON.stringify({ kind: "unbind_binding", target: "ws-A", all: false }),
    );
    const response = JSON.parse(line) as IpcResponse;
    expect(response.kind).toBe("error");
  });

  it("invalid JSON returns error but connection stays open (11.f)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const [r1, r2] = await rpcDouble(
      address,
      "not-json",
      JSON.stringify({ kind: "status" }),
    );
    expect((JSON.parse(r1) as IpcResponse).kind).toBe("error");
    expect((JSON.parse(r2) as IpcResponse).kind).toBe("status_ok");
  });

  it("unknown request kind returns error (11.g)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const line = await rpc(address, JSON.stringify({ kind: "explode" }));
    expect((JSON.parse(line) as IpcResponse).kind).toBe("error");
  });

  it("handler exception returns error and keeps connection open (11.h)", async () => {
    const handlers = makeHandlers();
    handlers.status = vi.fn(() => Promise.reject(new Error("boom")));
    const { s, address } = startConfig(handlers);
    await s.start();
    const [r1, r2] = await rpcDouble(
      address,
      JSON.stringify({ kind: "status" }),
      JSON.stringify({ kind: "stop" }),
    );
    const resp1 = JSON.parse(r1) as IpcResponse;
    expect(resp1.kind).toBe("error");
    if (resp1.kind === "error") {
      expect(resp1.message).toContain("boom");
    }
    expect((JSON.parse(r2) as IpcResponse).kind).toBe("stop_ok");
  });

  it("stop is idempotent (11.i)", async () => {
    const { s } = startConfig();
    await s.start();
    await s.stop();
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "cleans up a stale socket file on start (Unix) (11.j)",
    async () => {
      // Create a stale file at the socket path. It's not a real socket, so a
      // connect probe will fail with ECONNREFUSED/ENOENT and start() will
      // unlink-and-proceed.
      await writeFile(socketPath, "", { mode: 0o600 });
      const { s } = startConfig();
      await s.start();
      await new Promise<void>((resolve, reject) => {
        const client = connect(socketPath);
        client.on("connect", () => {
          client.end();
          resolve();
        });
        client.on("error", reject);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses to start when another daemon owns the socket (Unix) (11.k)",
    async () => {
      const sA = new IpcServer(socketPath, makeHandlers(), silentLogger);
      const sB = new IpcServer(socketPath, makeHandlers(), silentLogger);
      try {
        await sA.start();
        await expect(sB.start()).rejects.toBeInstanceOf(IpcSocketBusyError);
      } finally {
        await sA.stop();
        await sB.stop().catch(() => undefined);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "refuses to start when pipe name is in use (Windows) (11.l)",
    async () => {
      const pipe = uniquePipeName();
      const sA = new IpcServer(
        socketPath,
        makeHandlers(),
        silentLogger,
        pipe,
      );
      const sB = new IpcServer(
        socketPath,
        makeHandlers(),
        silentLogger,
        pipe,
      );
      try {
        await sA.start();
        await expect(sB.start()).rejects.toBeInstanceOf(IpcSocketBusyError);
      } finally {
        await sA.stop();
        await sB.stop().catch(() => undefined);
      }
    },
  );

  // T-P2-002 hello-gate behavior.

  it("non-hello first message returns error reason=protocol_error and closes (T-P2-002)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const [raw] = await rpcRaw(
      address,
      [JSON.stringify({ kind: "status" })],
      1,
    );
    if (raw === undefined) throw new Error("expected one response");
    const response = JSON.parse(raw) as IpcResponse;
    expect(response.kind).toBe("error");
    if (response.kind === "error") {
      expect(response.reason).toBe("protocol_error");
    }
  });

  it("hello with mismatched version returns error reason=version_mismatch (T-P2-002)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const helloBad = JSON.stringify({
      kind: "hello",
      version: "99.0",
      role: "cli",
      pid: 0,
    });
    const [raw] = await rpcRaw(address, [helloBad], 1);
    if (raw === undefined) throw new Error("expected one response");
    const response = JSON.parse(raw) as IpcResponse;
    expect(response.kind).toBe("error");
    if (response.kind === "error") {
      expect(response.reason).toBe("version_mismatch");
    }
  });

  it("hello_ok returned on accept; subsequent status request succeeds (T-P2-002)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const [helloRaw, statusRaw] = await rpcRaw(
      address,
      [HELLO_LINE, JSON.stringify({ kind: "status" })],
      2,
    );
    if (helloRaw === undefined || statusRaw === undefined) {
      throw new Error("expected two responses");
    }
    const hello = JSON.parse(helloRaw) as IpcResponse;
    expect(hello.kind).toBe("hello_ok");
    if (hello.kind === "hello_ok") {
      expect(hello.daemon_version).toBe("1.0");
      expect(hello.min_supported).toBe("1.0");
      // CB-DAEMON-LIFECYCLE-FIX (b): hello_ok carries the daemon's pid so the
      // extension can show which daemon it's bound to. Here the daemon IS this
      // test process.
      expect(hello.daemon_pid).toBe(process.pid);
    }
    const status = JSON.parse(statusRaw) as IpcResponse;
    expect(status.kind).toBe("status_ok");
  });

  it("countConnectedExtensions is 0 before any extension hello (CB-DAEMON-LIFECYCLE-FIX b/c2)", async () => {
    const { s } = startConfig();
    await s.start();
    expect(s.countConnectedExtensions()).toBe(0);
    await s.stop();
  });
});

describe("checkVersion (T-P2-002)", () => {
  it("returns null when client_version matches daemon_version", async () => {
    const { checkVersion } = await import("../../src/ipc/server.js");
    expect(checkVersion("1.0", "1.0", "1.0")).toBeNull();
  });

  it("returns version_mismatch payload when versions disagree", async () => {
    const { checkVersion } = await import("../../src/ipc/server.js");
    const result = checkVersion("0.5", "1.0", "1.0");
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("version_mismatch");
    expect(result?.message).toContain("0.5");
    expect(result?.message).toContain("1.0");
  });

  it("returns version_mismatch even when only min_supported differs from client (string-equality contract)", async () => {
    const { checkVersion } = await import("../../src/ipc/server.js");
    expect(checkVersion("0.9", "1.0", "0.9")).not.toBeNull();
  });
});

// T-P2-003: workspace registration handlers via IPC.

describe("IpcServer workspace registration (T-P2-003)", () => {
  let tempDir: string;
  let socketPath: string;
  let storePath: string;
  let server: IpcServer | null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-wsreg-"));
    socketPath = join(tempDir, "daemon.sock");
    storePath = join(tempDir, "workspaces.json");
    server = null;
  });

  afterEach(async () => {
    if (server !== null) await server.stop().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startServerWithStore(): Promise<{
    address: string;
    store: import("../../src/workspace/store.js").WorkspacesStore;
  }> {
    const address =
      process.platform === "win32" ? uniquePipeName() : socketPath;
    const override = process.platform === "win32" ? address : undefined;
    const { WorkspacesStore } = await import("../../src/workspace/store.js");
    const store = new WorkspacesStore(storePath);
    await store.load();
    server = new IpcServer(
      socketPath,
      makeHandlers(),
      silentLogger,
      override,
      store,
    );
    await server.start();
    return { address, store };
  }

  it("register_workspace returns needs_trust for unknown path; file unwritten", async () => {
    const { address } = await startServerWithStore();
    const raw = await rpc(
      address,
      JSON.stringify({
        kind: "register_workspace",
        abs_path: "/some/new/path",
        name: "New Path",
      }),
    );
    const response = JSON.parse(raw) as IpcResponse;
    expect(response.kind).toBe("register_workspace_needs_trust");
    // File should not exist yet — needs_trust doesn't write.
    await expect(
      (async () => {
        const { stat: statFn } = await import("node:fs/promises");
        await statFn(storePath);
      })(),
    ).rejects.toThrow();
  });

  it("T-P3-002R: auth_consent_response threads the responding connection's workspace into recordDecision", async () => {
    const { address } = await startServerWithStore();
    if (server === null) throw new Error("server not started");
    // Capture what the consent receiver is handed.
    const captured: Array<{
      request_id: string;
      decision: string;
      bound_workspace: string | null;
    }> = [];
    server.setConsentReceiver({
      recordAck: () => undefined,
      recordDecision: (request_id, decision, bound_workspace) =>
        captured.push({ request_id, decision, bound_workspace }),
    });

    // One persistent connection: hello → register → confirm_trust (so the
    // socket is in the active registry), then auth_consent_response (which
    // writes no reply). The identifier must be recovered from THIS socket.
    const client = connect(address);
    client.setEncoding("utf8");
    const lines: string[] = [];
    let buf = "";
    client.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("error", reject);
    });
    const send = (obj: unknown): void => {
      client.write(JSON.stringify(obj) + "\n");
    };
    const waitForLines = async (n: number): Promise<void> => {
      for (let i = 0; i < 100 && lines.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    send({ kind: "hello", version: "1.0", role: "extension", pid: 4242 });
    send({ kind: "register_workspace", abs_path: "/ws/alpha", name: "Alpha" });
    send({ kind: "confirm_trust", abs_path: "/ws/alpha", name: "Alpha" });
    await waitForLines(3); // hello_ok, needs_trust, register_workspace_ok
    const okRaw = lines[2];
    if (okRaw === undefined) throw new Error("expected register_workspace_ok");
    const ok = JSON.parse(okRaw) as IpcResponse;
    if (ok.kind !== "register_workspace_ok") {
      throw new Error(`expected register_workspace_ok, got ${ok.kind}`);
    }
    const identifier = ok.identifier;

    // Now the consent response on the SAME (registered) socket.
    send({
      kind: "auth_consent_response",
      request_id: "req-alpha",
      decision: "approve",
    });
    // No reply line for a consent response; give the server a tick.
    await new Promise((r) => setTimeout(r, 30));
    client.end();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.request_id).toBe("req-alpha");
    expect(captured[0]?.decision).toBe("approve");
    // The binding: recovered from the responding socket's registration.
    expect(captured[0]?.bound_workspace).toBe(identifier);
  });

  it("T-P3-004b: unbind_workspace calls the revoker, sends binding_cleared, and replies ok", async () => {
    const { address } = await startServerWithStore();
    if (server === null) throw new Error("server not started");
    const revoked: string[] = [];
    server.setBindingRevoker({
      revoke: (identifier) => {
        revoked.push(identifier);
        return Promise.resolve(2); // pretend 2 tokens torn down
      },
    });

    const client = connect(address);
    client.setEncoding("utf8");
    const lines: string[] = [];
    let buf = "";
    client.on("data", (chunk: string) => {
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        lines.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve());
      client.on("error", reject);
    });
    const send = (obj: unknown): void => {
      client.write(JSON.stringify(obj) + "\n");
    };
    const waitForLines = async (n: number): Promise<void> => {
      for (let i = 0; i < 100 && lines.length < n; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    send({ kind: "hello", version: "1.0", role: "extension", pid: 99 });
    send({ kind: "register_workspace", abs_path: "/ws/beta", name: "Beta" });
    send({ kind: "confirm_trust", abs_path: "/ws/beta", name: "Beta" });
    await waitForLines(3);
    const ok = JSON.parse(lines[2] ?? "{}") as IpcResponse;
    if (ok.kind !== "register_workspace_ok") {
      throw new Error(`expected register_workspace_ok, got ${ok.kind}`);
    }
    const identifier = ok.identifier;

    send({ kind: "unbind_workspace", identifier });
    await waitForLines(5); // + binding_cleared (server msg) + unbind_workspace_ok
    client.end();

    // The revoker was invoked for this workspace.
    expect(revoked).toEqual([identifier]);
    // A binding_cleared server message AND an unbind_workspace_ok reply were
    // both written.
    const kinds = lines.map((l) => {
      try {
        return (JSON.parse(l) as { kind?: string }).kind;
      } catch {
        return undefined;
      }
    });
    expect(kinds).toContain("binding_cleared");
    const okReply = lines
      .map((l) => JSON.parse(l) as { kind?: string; revoked_count?: number })
      .find((m) => m.kind === "unbind_workspace_ok");
    expect(okReply?.revoked_count).toBe(2);
  });

  it("T-P3-004b: unbind_workspace from a connection that doesn't hold the registration → protocol_error", async () => {
    const { address } = await startServerWithStore();
    if (server === null) throw new Error("server not started");
    server.setBindingRevoker({ revoke: () => Promise.resolve(0) });
    // A connection that registers nothing tries to unbind someone else's id.
    const raw = await rpc(
      address,
      JSON.stringify({ kind: "unbind_workspace", identifier: "not-mine-abc123" }),
    );
    const resp = JSON.parse(raw) as IpcResponse;
    expect(resp.kind).toBe("error");
    if (resp.kind === "error") expect(resp.reason).toBe("protocol_error");
  });

  it("confirm_trust after needs_trust writes file with trusted entry", async () => {
    const { address, store } = await startServerWithStore();
    const responses = await rpcRaw(
      address,
      [
        HELLO_LINE,
        JSON.stringify({
          kind: "register_workspace",
          abs_path: "/new/path/here",
          name: "New Here",
        }),
        JSON.stringify({
          kind: "confirm_trust",
          abs_path: "/new/path/here",
          name: "New Here",
        }),
      ],
      3,
    );
    // [hello_ok, needs_trust, register_workspace_ok]
    const confirmRaw = responses[2];
    if (confirmRaw === undefined) throw new Error("expected three responses");
    const response = JSON.parse(confirmRaw) as IpcResponse;
    expect(response.kind).toBe("register_workspace_ok");
    if (response.kind === "register_workspace_ok") {
      expect(response.identifier).toMatch(/^[a-z0-9-]+-[0-9a-f]{6}$/);
      expect(response.was_already_trusted).toBe(false);
    }
    // Reload store from disk to confirm persistence.
    const { WorkspacesStore } = await import("../../src/workspace/store.js");
    const fresh = new WorkspacesStore(storePath);
    await fresh.load();
    expect(fresh.findByPath("/new/path/here")?.trust_state).toBe("trusted");
    void store;
  });

  it("register_workspace against an existing trusted entry returns ok with was_already_trusted=true", async () => {
    const { address, store } = await startServerWithStore();
    await store.addTrustedEntry({
      abs_path: "/pre/trusted",
      identifier: "pre-aaaaaa",
      name: "Pre Trusted",
    });
    const raw = await rpc(
      address,
      JSON.stringify({
        kind: "register_workspace",
        abs_path: "/pre/trusted",
        name: "Pre Trusted",
      }),
    );
    const response = JSON.parse(raw) as IpcResponse;
    expect(response.kind).toBe("register_workspace_ok");
    if (response.kind === "register_workspace_ok") {
      expect(response.identifier).toBe("pre-aaaaaa");
      expect(response.was_already_trusted).toBe(true);
    }
  });

  it("second register_workspace from a different connection returns path_already_registered", async () => {
    const { address, store } = await startServerWithStore();
    await store.addTrustedEntry({
      abs_path: "/dup/path",
      identifier: "dup-aaaaaa",
      name: "Dup",
    });
    // First connection registers.
    await rpc(
      address,
      JSON.stringify({
        kind: "register_workspace",
        abs_path: "/dup/path",
        name: "Dup",
      }),
    );
    // Second connection (separate hello prelude) attempts the same path.
    const raw = await rpc(
      address,
      JSON.stringify({
        kind: "register_workspace",
        abs_path: "/dup/path",
        name: "Dup",
      }),
    );
    const response = JSON.parse(raw) as IpcResponse;
    expect(response.kind).toBe("error");
    if (response.kind === "error") {
      expect(response.reason).toBe("path_already_registered");
      expect(response.message).toMatch(/pid \d+/);
    }
  });

  it("deregister_workspace removes from active registry but preserves on-disk entry", async () => {
    const { address, store } = await startServerWithStore();
    await store.addTrustedEntry({
      abs_path: "/dr/path",
      identifier: "dr-aaaaaa",
      name: "DR",
    });
    // Register + deregister on the same connection.
    const responses = await rpcRaw(
      address,
      [
        HELLO_LINE,
        JSON.stringify({
          kind: "register_workspace",
          abs_path: "/dr/path",
          name: "DR",
        }),
        JSON.stringify({
          kind: "deregister_workspace",
          identifier: "dr-aaaaaa",
        }),
      ],
      3,
    );
    // [hello_ok, register_workspace_ok, deregister_workspace_ok]
    const derR = responses[2];
    if (derR === undefined) throw new Error("expected three responses");
    const response = JSON.parse(derR) as IpcResponse;
    expect(response.kind).toBe("deregister_workspace_ok");
    // On-disk entry still present.
    expect(store.findByPath("/dr/path")?.trust_state).toBe("trusted");
    // A fresh connection should be able to register again (active registry
    // cleared on the prior deregister).
    const raw = await rpc(
      address,
      JSON.stringify({
        kind: "register_workspace",
        abs_path: "/dr/path",
        name: "DR",
      }),
    );
    const reregResponse = JSON.parse(raw) as IpcResponse;
    expect(reregResponse.kind).toBe("register_workspace_ok");
    if (reregResponse.kind === "register_workspace_ok") {
      // Same identifier reused from on-disk store.
      expect(reregResponse.identifier).toBe("dr-aaaaaa");
      expect(reregResponse.was_already_trusted).toBe(true);
    }
  });
});
