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
// CB-DAEMON-LIFECYCLE-FIX: after the daemon acks the stop IPC (which only
// means shutdown BEGAN), verify the process actually terminates. The daemon's
// own shutdown budget is ~10s, so wait a little longer before escalating.
const VERIFY_TIMEOUT_MS = 12000;
const ESCALATE_TIMEOUT_MS = 2000;
const VERIFY_POLL_MS = 200;

// Injectable process control so the escalation logic is unit-testable without
// sending real signals. Defaults to the real process.kill.
export interface ProcessControl {
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

const realProcessControl: ProcessControl = {
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH ⟹ definitely gone. EPERM/other ⟹ treat as alive (conservative).
      return !(err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ESRCH");
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll until the process is gone or the timeout elapses. Returns true if it
// exited within the window.
async function waitForExit(
  pid: number,
  control: ProcessControl,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!control.isAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !control.isAlive(pid);
}

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
  // CB-DAEMON-LIFECYCLE-FIX: injectable process control + timings so the
  // termination-verification + escalation path is unit-testable without real
  // signals. Production omits these (real process.kill, default timings).
  processControl?: ProcessControl;
  verifyTimeoutMs?: number;
  escalateTimeoutMs?: number;
  verifyPollMs?: number;
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
    // CB-DAEMON-LIFECYCLE-FIX: the stop ack only means shutdown BEGAN. Verify
    // the process actually terminated, escalate (SIGTERM→SIGKILL) if it hangs,
    // and clean the pid file — rather than printing "Stopped" while it drains
    // or zombies. (Was: print success on signal-receipt.)
    await verifyTerminationAndCleanup(pid, pidPath, opts);
    process.stdout.write("Stopped.\n");
  } catch (err) {
    if (err instanceof IpcClientConnectionError) {
      // Daemon shut down (or never reachable) before/while we sent.
      // Idempotent semantic: treat as success — and clean the pid file in
      // case a crashed daemon left it behind.
      await removePidFile(pidPath);
      process.stdout.write("Daemon shut down.\n");
      return;
    }
    if (err instanceof IpcClientTimeoutError) {
      throw new DaemonStopTimeoutError(STOP_TIMEOUT_MS, pid);
    }
    throw err;
  }
}

// CB-DAEMON-LIFECYCLE-FIX: confirm the daemon process is gone after the stop
// ack; escalate SIGTERM→SIGKILL if it hangs; then remove the pid file. Never
// signals our own pid (in real use the daemon pid ≠ the CLI pid; the guard is
// defensive + keeps tests that write process.pid from self-terminating).
export async function verifyTerminationAndCleanup(
  pid: number | null,
  pidPath: string,
  opts: StopOpts,
): Promise<void> {
  if (pid !== null && pid !== process.pid) {
    const control = opts.processControl ?? realProcessControl;
    const verifyMs = opts.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    const escalateMs = opts.escalateTimeoutMs ?? ESCALATE_TIMEOUT_MS;
    const pollMs = opts.verifyPollMs ?? VERIFY_POLL_MS;

    let dead = await waitForExit(pid, control, verifyMs, pollMs);
    if (!dead) {
      // Hung mid-drain — escalate.
      try {
        control.kill(pid, "SIGTERM");
      } catch {
        // already gone / not permitted — fall through to the recheck
      }
      dead = await waitForExit(pid, control, escalateMs, pollMs);
    }
    if (!dead) {
      try {
        control.kill(pid, "SIGKILL");
      } catch {
        // already gone / not permitted
      }
      await waitForExit(pid, control, escalateMs, pollMs);
    }
  }
  // The daemon removes its own pid file on a clean shutdown; this is a no-op
  // then, and the authoritative cleanup when it was killed/zombied.
  await removePidFile(pidPath);
}
