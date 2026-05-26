import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { StatusPayload } from "@claude-bridge/shared";
import {
  IpcServer,
  type IpcHandlers,
} from "../../daemon/src/ipc/server.js";
import type { Logger } from "../../daemon/src/log/logger.js";
import {
  sendIpc,
  IpcClientTimeoutError,
  IpcClientConnectionError,
  IpcClientVersionMismatchError,
} from "../src/ipc-client.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const INERT_TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-cli-test-${randomBytes(6).toString("hex")}`;
}

function makeStatusPayload(): StatusPayload {
  return {
    daemon_pid: 12345,
    daemon_uptime_s: 60,
    endpoint: "127.0.0.1:7423",
    tunnel_status: "up",
    tunnel_url: "https://test.trycloudflare.com",
    token_suffix: "AAAA",
    audit_path: "/tmp/audit.jsonl",
    audit_size_bytes: 1024,
    attached_workspaces: 0,
  };
}

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.resolve(makeStatusPayload()),
    stop: () => Promise.resolve(),
    tokenRotate: () => Promise.resolve({ new_token: INERT_TOKEN }),
    tunnelRestart: () =>
      Promise.resolve({ new_url: "https://test.trycloudflare.com" }),
    ...overrides,
  };
}

describe("sendIpc", () => {
  let tempDir: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-cli-ipc-"));
    socketPath = join(tempDir, "daemon.sock");
    address = process.platform === "win32" ? uniquePipeName() : socketPath;
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      await server.stop().catch(() => undefined);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startServer(handlers: IpcHandlers): Promise<void> {
    const override = process.platform === "win32" ? address : undefined;
    server = new IpcServer(socketPath, handlers, silentLogger, override);
    await server.start();
  }

  it("status roundtrip (a)", async () => {
    await startServer(makeHandlers());
    const response = await sendIpc(
      { kind: "status" },
      { addressOverride: address },
    );
    expect(response.kind).toBe("status_ok");
    if (response.kind === "status_ok") {
      expect(response.payload.daemon_pid).toBe(12345);
      expect(response.payload.endpoint).toBe("127.0.0.1:7423");
    }
  });

  it("token_rotate roundtrip (b)", async () => {
    await startServer(makeHandlers());
    const response = await sendIpc(
      { kind: "token_rotate" },
      { addressOverride: address },
    );
    expect(response.kind).toBe("token_rotate_ok");
    if (response.kind === "token_rotate_ok") {
      expect(response.new_token).toBe(INERT_TOKEN);
    }
  });

  it("connection refused for non-existent address (c)", async () => {
    const fakeAddress =
      process.platform === "win32"
        ? uniquePipeName()
        : join(tempDir, "nonexistent.sock");
    await expect(
      sendIpc(
        { kind: "status" },
        { addressOverride: fakeAddress, timeoutMs: 1000 },
      ),
    ).rejects.toBeInstanceOf(IpcClientConnectionError);
  });

  it("server error envelope rejects with the message (d)", async () => {
    await startServer(
      makeHandlers({
        status: () => Promise.reject(new Error("simulated daemon failure")),
      }),
    );
    await expect(
      sendIpc({ kind: "status" }, { addressOverride: address }),
    ).rejects.toThrow("simulated daemon failure");
  });

  it("timeout fires when handler never resolves (e)", async () => {
    await startServer(
      makeHandlers({
        // Returns a Promise that never settles to force the client-side
        // timeout to fire.
        status: () => new Promise<StatusPayload>(() => undefined),
      }),
    );
    await expect(
      sendIpc(
        { kind: "status" },
        { addressOverride: address, timeoutMs: 100 },
      ),
    ).rejects.toBeInstanceOf(IpcClientTimeoutError);
  });
});

// T-P2-002: hello-prelude error paths via a minimal mock server that
// returns version_mismatch on the hello message. The real IpcServer's
// hello-gate is exercised in daemon/tests/ipc/server.test.ts; here we
// verify the CLI client correctly classifies the mismatch error.

describe("sendIpc — hello version_mismatch (T-P2-002)", () => {
  let tempDir: string;
  let address: string;
  let server: Server | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-cli-vm-"));
    address =
      process.platform === "win32"
        ? uniquePipeName()
        : join(tempDir, "daemon.sock");
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      const s = server;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("raises IpcClientVersionMismatchError with exitCode 4", async () => {
    server = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        socket.write(
          JSON.stringify({
            kind: "error",
            message:
              "version mismatch: client 1.0, daemon 9.9, min supported 9.9",
            reason: "version_mismatch",
          }) + "\n",
        );
        socket.end();
      });
    });
    const srv = server;
    await new Promise<void>((resolve) => srv.listen(address, resolve));
    await expect(
      sendIpc({ kind: "status" }, { addressOverride: address }),
    ).rejects.toBeInstanceOf(IpcClientVersionMismatchError);
    try {
      await sendIpc({ kind: "status" }, { addressOverride: address });
    } catch (err) {
      expect(err).toBeInstanceOf(IpcClientVersionMismatchError);
      if (err instanceof IpcClientVersionMismatchError) {
        expect(err.exitCode).toBe(4);
        expect(err.daemonVersion).toBe("9.9");
        expect(err.minSupported).toBe("9.9");
      }
    }
  });
});
