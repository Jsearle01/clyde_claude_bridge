// PID file management. Writes process.pid at start; signal-0 probe on next
// start detects stale files left by crashed daemons.
//
// Per CC-3 (file permissions): the PID file is mode 0600 on Unix (private to
// the daemon's user). Per CC-5 (process lifecycle): write on start, remove
// on clean shutdown, signal-0 probe with EPERM/unknown-error treated as
// "alive" to err on the side of refusing to clobber.

import { writeFile, readFile, unlink } from "node:fs/promises";

export type PidState = "alive" | "stale" | "absent";

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

export async function writePidFile(path: string): Promise<void> {
  await writeFile(path, String(process.pid), { mode: 0o600 });
}

// T-TUNNEL-1: write an ARBITRARY pid (not the daemon's own) — used for the
// owned cloudflared child's pid (tunnel.pid), which a future daemon reads to
// reclaim an orphan. Same 0600 mode.
export async function writePidValue(path: string, pid: number): Promise<void> {
  await writeFile(path, String(pid), { mode: 0o600 });
}

export async function checkStalePid(path: string): Promise<PidState> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return "absent";
    throw err;
  }
  const pid = Number.parseInt(content.trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) {
    // Malformed PID file — treat as stale and let the caller overwrite.
    return "stale";
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    // ESRCH means the process is definitely gone. Anything else (EPERM,
    // unknown) we treat as alive to avoid clobbering an active daemon
    // whose process the current user happens to lack permission to signal.
    if (isErrnoCode(err, "ESRCH")) return "stale";
    return "alive";
  }
}

// CB-DAEMON-LIFECYCLE-FIX: read the recorded pid (for diagnostics / the
// "already running (pid N)" refuse message). Returns null when absent or
// unparseable. The pid file remains a single integer (CLI compat).
export async function readPidFromFile(path: string): Promise<number | null> {
  try {
    const content = await readFile(path, "utf8");
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function removePidFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}
