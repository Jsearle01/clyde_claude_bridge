import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  checkCloudflared,
  checkExistingDaemon,
  waitForReady,
  CloudflaredMissingError,
  DaemonAlreadyRunningError,
  DaemonStartTimeoutError,
  DaemonStartFailedError,
  type SpawnSyncFn,
} from "../../src/commands/start.js";

describe("checkCloudflared", () => {
  it("throws CloudflaredMissingError on ENOENT (a)", () => {
    const fakeSpawn: SpawnSyncFn = () => ({
      status: null,
      error: Object.assign(new Error("not found"), { code: "ENOENT" }),
    });
    expect(() => checkCloudflared(fakeSpawn)).toThrow(CloudflaredMissingError);
  });

  it("throws CloudflaredMissingError on non-zero exit", () => {
    const fakeSpawn: SpawnSyncFn = () => ({ status: 1 });
    expect(() => checkCloudflared(fakeSpawn)).toThrow(CloudflaredMissingError);
  });

  it("does not throw when status is 0", () => {
    const fakeSpawn: SpawnSyncFn = () => ({ status: 0 });
    expect(() => checkCloudflared(fakeSpawn)).not.toThrow();
  });
});

describe("checkExistingDaemon", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalAppData: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-cli-start-"));
    originalHome = process.env.HOME;
    originalAppData = process.env.APPDATA;
    if (process.platform === "win32") {
      process.env.APPDATA = tempDir;
      await mkdir(join(tempDir, "claude-bridge"), { recursive: true });
    } else {
      process.env.HOME = tempDir;
      await mkdir(join(tempDir, ".claude-bridge"), { recursive: true });
    }
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    await rm(tempDir, { recursive: true, force: true });
  });

  function pidPath(): string {
    if (process.platform === "win32") {
      return join(tempDir, "claude-bridge", "daemon.pid");
    }
    return join(tempDir, ".claude-bridge", "daemon.pid");
  }

  it("throws DaemonAlreadyRunningError when PID file points to a live process (a)", async () => {
    // Use the current test process's PID — definitely alive.
    await writeFile(pidPath(), String(process.pid), { mode: 0o600 });
    await expect(checkExistingDaemon()).rejects.toBeInstanceOf(
      DaemonAlreadyRunningError,
    );
  });

  it("returns 'stale' when PID file points to a dead process", async () => {
    // PID 99999 is unlikely to exist; signal-0 probe will surface ESRCH.
    await writeFile(pidPath(), "99999", { mode: 0o600 });
    await expect(checkExistingDaemon()).resolves.toBe("stale");
  });

  it("returns 'absent' when no PID file exists", async () => {
    await expect(checkExistingDaemon()).resolves.toBe("absent");
  });

  it("DaemonAlreadyRunningError carries the running PID", async () => {
    await writeFile(pidPath(), String(process.pid), { mode: 0o600 });
    try {
      await checkExistingDaemon();
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
      if (err instanceof DaemonAlreadyRunningError) {
        expect(err.pid).toBe(process.pid);
      }
    }
  });
});

// FakeChild — minimal EventEmitter-based stand-in for ChildProcess. Has
// stdout/stderr Readable-like streams and supports emitting exit/error.
function makeFakeChild(): {
  child: ChildProcess;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitExit: (code: number | null) => void;
  emitError: (err: Error) => void;
} {
  const stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stdout.setEncoding = () => undefined;
  const stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (e: string) => void;
  };
  stderr.setEncoding = () => undefined;
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  return {
    child: child as unknown as ChildProcess,
    emitStdout: (chunk: string) => stdout.emit("data", chunk),
    emitStderr: (chunk: string) => stderr.emit("data", chunk),
    emitExit: (code: number | null) => child.emit("exit", code),
    emitError: (err: Error) => child.emit("error", err),
  };
}

describe("waitForReady", () => {
  it("resolves when child stdout emits 'ready' line (c)", async () => {
    const { child, emitStdout } = makeFakeChild();
    const p = waitForReady(child, 1000);
    emitStdout("ready\n");
    await expect(p).resolves.toBeUndefined();
  });

  it("resolves when 'ready' arrives in a chunk with other text", async () => {
    const { child, emitStdout } = makeFakeChild();
    const p = waitForReady(child, 1000);
    emitStdout("starting up\n");
    emitStdout("ready\n");
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects with DaemonStartTimeoutError if no ready line within timeout", async () => {
    const { child } = makeFakeChild();
    await expect(waitForReady(child, 50)).rejects.toBeInstanceOf(
      DaemonStartTimeoutError,
    );
  });

  it("rejects with DaemonStartFailedError on child exit before ready", async () => {
    const { child, emitStderr, emitExit } = makeFakeChild();
    const p = waitForReady(child, 1000);
    emitStderr("config not found\n");
    emitExit(1);
    await expect(p).rejects.toBeInstanceOf(DaemonStartFailedError);
    await p.catch((err: unknown) => {
      if (err instanceof DaemonStartFailedError) {
        expect(err.stderrText).toContain("config not found");
      }
    });
  });

  it("rejects with DaemonStartFailedError on child error event", async () => {
    const { child, emitError } = makeFakeChild();
    const p = waitForReady(child, 1000);
    emitError(new Error("spawn ENOENT"));
    await expect(p).rejects.toBeInstanceOf(DaemonStartFailedError);
  });
});
