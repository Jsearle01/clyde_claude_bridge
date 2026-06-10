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
  verifyTerminationAndCleanup,
  DaemonStopTimeoutError,
  type ProcessControl,
} from "../../src/commands/stop.js";
import {
  AmbiguousDaemonError,
} from "../../src/util/selector.js";
import { readFile } from "node:fs/promises";

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

// CB-DAEMON-LIFECYCLE-FIX: termination is VERIFIED after the stop ack (which
// only means shutdown began). Tested directly (the full stopCommand path
// gates on a real live pid, and the only live pid is the test's own — which
// the self-guard intentionally skips).
describe("verifyTerminationAndCleanup (reliable stop)", () => {
  let tempDir: string;
  let pidPath: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-verify-test-"));
    pidPath = join(tempDir, "daemon.pid");
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const fast = { verifyTimeoutMs: 10, escalateTimeoutMs: 10, verifyPollMs: 1 };

  it("escalates SIGTERM→SIGKILL when the daemon never dies, then cleans the pid file", async () => {
    await writeFile(pidPath, "4242424", { mode: 0o600 });
    const signals: ("SIGTERM" | "SIGKILL")[] = [];
    const control: ProcessControl = {
      isAlive: () => true, // never dies → forces full escalation
      kill: (_pid, sig) => signals.push(sig),
    };
    await verifyTerminationAndCleanup(4242424, pidPath, {
      processControl: control,
      ...fast,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    // pid file removed even though the (simulated) process was zombied.
    await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does NOT escalate when the process exits promptly", async () => {
    await writeFile(pidPath, "4242425", { mode: 0o600 });
    const signals: string[] = [];
    const control: ProcessControl = {
      isAlive: () => false, // already gone
      kill: (_pid, sig) => signals.push(sig),
    };
    await verifyTerminationAndCleanup(4242425, pidPath, {
      processControl: control,
      ...fast,
    });
    expect(signals).toEqual([]);
  });

  it("never signals our own pid (self-guard) but still cleans the pid file", async () => {
    await writeFile(pidPath, String(process.pid), { mode: 0o600 });
    const signals: string[] = [];
    const control: ProcessControl = {
      isAlive: () => true,
      kill: (_pid, sig) => signals.push(sig),
    };
    await verifyTerminationAndCleanup(process.pid, pidPath, {
      processControl: control,
      ...fast,
    });
    expect(signals).toEqual([]); // never signalled self
    await expect(readFile(pidPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // T-CLI-1 (AC-C1-3): bare `stop` no longer falls through to the flat layout and
  // misreports "Daemon not running" while per-daemon daemons are live. It routes
  // through the unified selector: act-on-sole if one, error-and-list if many.
  describe("bare stop acts-on-sole / errors-many, never flat-fallthrough misreport", () => {
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);
    });
    afterEach(() => {
      spy.mockRestore();
    });
    function advert(name: string): string {
      return JSON.stringify({
        canonical_workspace: `c:\\ws\\${name}`,
        name,
        pipe: `pipe-${name}`,
        port: 7423,
        pid: 1,
        started_at: "2026-06-10T00:00:00.000Z",
      });
    }
    function captured(): string {
      return spy.mock.calls.map((c) => c[0] as string).join("");
    }

    it("MANY daemons → AmbiguousDaemonError (lists), NOT silent 'Daemon not running'", async () => {
      const daemonsDir = await mkdtemp(join(tmpdir(), "cb-stop-many-"));
      await writeFile(join(daemonsDir, "a.json"), advert("alpha"));
      await writeFile(join(daemonsDir, "b.json"), advert("beta"));
      await expect(stopCommand({ daemonsDir })).rejects.toBeInstanceOf(
        AmbiguousDaemonError,
      );
      expect(captured()).not.toContain("Daemon not running"); // the killed misreport
      await rm(daemonsDir, { recursive: true, force: true });
    });

    it("NO daemons → idempotent 'No daemons running.' via the selector (not flat)", async () => {
      const daemonsDir = await mkdtemp(join(tmpdir(), "cb-stop-none-"));
      await stopCommand({ daemonsDir });
      expect(captured()).toContain("No daemons running.");
      await rm(daemonsDir, { recursive: true, force: true });
    });
  });
});
