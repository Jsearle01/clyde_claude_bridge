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

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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
    tokenRotate: vi.fn(() => Promise.resolve({ new_token: INERT_TOKEN })),
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

  it("token_rotate request returns token_rotate_ok (11.d)", async () => {
    const { s, address } = startConfig();
    await s.start();
    const line = await rpc(address, JSON.stringify({ kind: "token_rotate" }));
    const response = JSON.parse(line) as IpcResponse;
    expect(response.kind).toBe("token_rotate_ok");
    if (response.kind === "token_rotate_ok") {
      expect(response.new_token).toBe(INERT_TOKEN);
    }
  });

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
    }
    const status = JSON.parse(statusRaw) as IpcResponse;
    expect(status.kind).toBe("status_ok");
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
