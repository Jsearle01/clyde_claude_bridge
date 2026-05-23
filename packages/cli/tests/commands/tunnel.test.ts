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
import { DaemonNotRunningError } from "../../src/commands/token.js";
import {
  tunnelRestartCommand,
  TunnelRestartConnectionLostError,
  TunnelRestartFailedError,
} from "../../src/commands/tunnel.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const NEW_URL = "https://plum-otter-9999.trycloudflare.com";

function uniquePipeName(): string {
  return `\\\\.\\pipe\\claude-bridge-tunnel-test-${randomBytes(6).toString("hex")}`;
}

function makeHandlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => Promise.reject(new Error("not used")),
    stop: () => Promise.reject(new Error("not used")),
    tokenRotate: () => Promise.reject(new Error("not used")),
    tunnelRestart: () => Promise.resolve({ new_url: NEW_URL }),
    ...overrides,
  };
}

describe("tunnelRestartCommand", () => {
  let tempDir: string;
  let pidPath: string;
  let socketPath: string;
  let address: string;
  let server: IpcServer | null = null;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-tunnel-test-"));
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
    await expect(tunnelRestartCommand({ pidPath })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("PID alive + successful restart prints new URL", async () => {
    await startServer(makeHandlers());
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    await tunnelRestartCommand({ pidPath, addressOverride: address });
    expect(stdoutSpy).toHaveBeenCalledOnce();
    const out = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(out).toContain("Tunnel restarted.");
    expect(out).toContain(`New URL: ${NEW_URL}`);
    expect(out).toContain("Update any MCP clients with the new URL.");
  });

  it("PID alive + connection error → TunnelRestartConnectionLostError", async () => {
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    const fakeAddress =
      process.platform === "win32"
        ? uniquePipeName()
        : join(tempDir, "nonexistent.sock");
    await expect(
      tunnelRestartCommand({ pidPath, addressOverride: fakeAddress }),
    ).rejects.toBeInstanceOf(TunnelRestartConnectionLostError);
  });

  it("PID alive + error envelope (degraded) → TunnelRestartFailedError surfaces daemon message", async () => {
    await startServer(
      makeHandlers({
        tunnelRestart: () =>
          Promise.reject(
            new Error("tunnel degraded: 5 restarts in 5 minutes"),
          ),
      }),
    );
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    const rejection = tunnelRestartCommand({
      pidPath,
      addressOverride: address,
    });
    await expect(rejection).rejects.toBeInstanceOf(TunnelRestartFailedError);
    await expect(rejection).rejects.toThrow(
      "Tunnel restart failed: tunnel degraded: 5 restarts in 5 minutes",
    );
  });
});
