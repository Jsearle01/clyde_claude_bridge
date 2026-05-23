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
  stopCommand,
  DaemonStopTimeoutError,
} from "../../src/commands/stop.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-stop-test-${randomBytes(6).toString("hex")}`;
}

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.reject(new Error("not used")),
    stop: () => Promise.resolve(),
    tokenRotate: () => Promise.reject(new Error("not used")),
    tunnelRestart: () => Promise.reject(new Error("not used")),
    ...overrides,
  };
}

describe("stopCommand", () => {
  let tempDir: string;
  let pidPath: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-stop-test-"));
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

  it("PID absent path: exits 0 with friendly message (no IPC)", async () => {
    await stopCommand({ pidPath });
    expect(stdoutSpy).toHaveBeenCalledWith("Daemon not running.\n");
  });

  it("PID stale path: removes stale file with notice", async () => {
    await writeFile(pidPath, "99999", { mode: 0o600 });
    await stopCommand({ pidPath });
    expect(stdoutSpy).toHaveBeenCalledWith(
      "Daemon PID file is stale; removing.\n",
    );
  });

  it("PID alive + successful IPC → 'Stopped.'", async () => {
    await startServer(makeHandlers());
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await stopCommand({ pidPath, addressOverride: address });
    expect(stdoutSpy).toHaveBeenCalledWith("Stopped.\n");
  });

  it("PID alive + connection error → 'Daemon shut down.' (idempotent)", async () => {
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    // No server started — sendIpc gets ECONNREFUSED/ENOENT
    const fakeAddress =
      process.platform === "win32"
        ? uniquePipeName()
        : join(tempDir, "nonexistent.sock");
    await stopCommand({ pidPath, addressOverride: fakeAddress });
    expect(stdoutSpy).toHaveBeenCalledWith("Daemon shut down.\n");
  });

  it("PID alive + timeout → throws DaemonStopTimeoutError", async () => {
    await startServer(
      makeHandlers({
        stop: () => new Promise(() => undefined), // never resolves
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await expect(
      stopCommand({
        pidPath,
        addressOverride: address,
      }),
    ).rejects.toBeInstanceOf(DaemonStopTimeoutError);
  }, 20000);
});
