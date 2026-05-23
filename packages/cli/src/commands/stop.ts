// `claude-bridge stop` — sends IPC stop to the running daemon. Idempotent:
// if no daemon is running, exits 0 with a friendly message rather than
// erroring. Per the T-0013 design, the daemon's stop handler resolves the
// IPC reply as soon as shutdown begins (the connection may close before
// the daemon finishes draining; we tolerate that).

import {
  sendIpc,
  IpcClientConnectionError,
  IpcClientTimeoutError,
} from "../ipc-client.js";
import { getCliPidPath } from "../util/paths.js";
import {
  checkStalePid,
  readPidFromFile,
  removePidFile,
} from "../util/pidfile.js";

const STOP_TIMEOUT_MS = 12000;

export class DaemonStopTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly pid: number | null,
  ) {
    const pidStr =
      pid !== null ? ` PID is ${pid}; you may need to kill it manually.` : "";
    super(`Daemon did not respond within ${timeoutMs}ms.${pidStr}`);
    this.name = "DaemonStopTimeoutError";
  }
}

export interface StopOpts {
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
}

export async function stopCommand(opts: StopOpts = {}): Promise<void> {
  const pidPath = opts.pidPath ?? getCliPidPath();
  const state = await checkStalePid(pidPath);

  if (state === "absent") {
    process.stdout.write("Daemon not running.\n");
    return;
  }
  if (state === "stale") {
    process.stdout.write("Daemon PID file is stale; removing.\n");
    await removePidFile(pidPath);
    return;
  }

  const pid = await readPidFromFile(pidPath);
  try {
    await sendIpc(
      { kind: "stop" },
      { addressOverride: opts.addressOverride, timeoutMs: STOP_TIMEOUT_MS },
    );
    process.stdout.write("Stopped.\n");
  } catch (err) {
    if (err instanceof IpcClientConnectionError) {
      // Daemon shut down (or never reachable) before/while we sent.
      // Idempotent semantic: treat as success.
      process.stdout.write("Daemon shut down.\n");
      return;
    }
    if (err instanceof IpcClientTimeoutError) {
      throw new DaemonStopTimeoutError(STOP_TIMEOUT_MS, pid);
    }
    throw err;
  }
}
