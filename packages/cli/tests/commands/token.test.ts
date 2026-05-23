import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  IpcServer,
  type IpcHandlers,
} from "../../../daemon/src/ipc/server.js";
import type { Logger } from "../../../daemon/src/log/logger.js";
import {
  tokenRotateCommand,
  DaemonNotRunningError,
  TokenRotateConnectionLostError,
  TokenRotateTimeoutError,
} from "../../src/commands/token.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const NEW_TOKEN = "cb_live_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-token-test-${randomBytes(6).toString("hex")}`;
}

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.reject(new Error("not used")),
    stop: () => Promise.reject(new Error("not used")),
    tokenRotate: () => Promise.resolve({ new_token: NEW_TOKEN }),
    tunnelRestart: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

describe("tokenRotateCommand", () => {
  let tempDir: string;
  let pidPath: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-token-test-"));
    pidPath = join(tempDir, "daemon.pid");
    socketPath = join(tempDir, "daemon.sock");
    address = process.platform === "win32" ? uniquePipeName() : socketPath;
    server = null;
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    if (server !== null) await server.stop().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startServer(handlers: IpcHandlers): Promise<void> {
    const override = process.platform === "win32" ? address : undefined;
    server = new IpcServer(socketPath, handlers, silentLogger, override);
    await server.start();
  }

  it("PID absent → throws DaemonNotRunningError, no IPC attempted", async () => {
    await expect(tokenRotateCommand({ pidPath })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("PID stale → throws DaemonNotRunningError", async () => {
    await writeFile(pidPath, "99999", { mode: 0o600 });
    await expect(tokenRotateCommand({ pidPath })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
  });

  it("PID alive + successful rotation prints formatted block", async () => {
    await startServer(makeHandlers());
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await tokenRotateCommand({ pidPath, addressOverride: address });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("Token rotated.");
    expect(out).toContain(`New token: ${NEW_TOKEN}`);
    expect(out).toContain("The previous token is no longer valid.");
  });

  it("PID alive + connection error → TokenRotateConnectionLostError", async () => {
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    const fakeAddress =
      process.platform === "win32"
        ? uniquePipeName()
        : join(tempDir, "nonexistent.sock");
    await expect(
      tokenRotateCommand({ pidPath, addressOverride: fakeAddress }),
    ).rejects.toBeInstanceOf(TokenRotateConnectionLostError);
  });

  it("PID alive + timeout → TokenRotateTimeoutError", async () => {
    await startServer(
      makeHandlers({
        tokenRotate: () => new Promise(() => undefined), // never resolves
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await expect(
      tokenRotateCommand({ pidPath, addressOverride: address }),
    ).rejects.toBeInstanceOf(TokenRotateTimeoutError);
  }, 20000);
});
