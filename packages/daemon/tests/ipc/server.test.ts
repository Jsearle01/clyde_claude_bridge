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

// Send one line, await one line in response, close the connection.
function rpc(address: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(address);
    let buf = "";
    let settled = false;
    client.setEncoding("utf8");
    client.on("connect", () => {
      client.write(line + "\n");
    });
    client.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1 && !settled) {
        settled = true;
        const response = buf.slice(0, idx);
        client.end();
        resolve(response);
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
        reject(new Error("connection closed without response"));
      }
    });
  });
}

// Send two lines on the same connection, await two responses.
function rpcDouble(
  address: string,
  line1: string,
  line2: string,
): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    const client = connect(address);
    let buf = "";
    const responses: string[] = [];
    let settled = false;
    client.setEncoding("utf8");
    client.on("connect", () => {
      client.write(line1 + "\n");
    });
    client.on("data", (chunk: string) => {
      if (settled) return;
      buf += chunk;
      let idx = buf.indexOf("\n");
      while (idx !== -1 && responses.length < 2) {
        responses.push(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
        if (responses.length === 1) {
          client.write(line2 + "\n");
        }
        idx = buf.indexOf("\n");
      }
      if (responses.length === 2 && !settled) {
        settled = true;
        client.end();
        const [r1, r2] = responses;
        if (r1 === undefined || r2 === undefined) {
          reject(new Error("missing response"));
        } else {
          resolve([r1, r2]);
        }
      }
    });
    client.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
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
});
