// T-TUNNEL-1 (AC-T-3 — the PRIMARY orphan defense): a daemon starting after a
// NON-graceful prior exit reclaims the orphaned cloudflared it used to own.
//
// On win32 a hard stop (Stop-Process -Force, or process.kill(pid, signal) which
// is TerminateProcess) bypasses shutdown() entirely — there is no catchable
// signal — so clean-on-exit can never fire and the cloudflared child is orphaned
// (the observed-repro window that kept reopening). Windows does NOT cascade-kill
// a child when its parent dies, so the orphan survives. The hard/test stop is the
// COMMON case, which is why reclaim-on-startup — not graceful teardown — is the
// load-bearing mechanism. Read the persisted child pid; if it is still alive,
// terminate it. Best-effort + idempotent; clears the pid file either way.

import { readPidFromFile, removePidFile } from "../pidfile.js";
import type { Logger } from "../log/logger.js";

export interface ReclaimDeps {
  // Injected for tests; default to real process signals.
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = definitely gone. EPERM/unknown → treat as alive (don't assume
    // a process we can't signal is dead).
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function defaultKill(pid: number): void {
  // The orphan is parentless (its daemon died), so a hard kill is correct and
  // sufficient. win32: SIGKILL = TerminateProcess (immediate); posix: SIGKILL.
  process.kill(pid, "SIGKILL");
}

/**
 * Reclaim (detect + kill) an orphaned cloudflared recorded in `tunnelPidPath`.
 * Returns the reclaimed pid if one was alive and killed, else null. Always
 * clears the pid file (a stale/dead pid must not be reclaimed on a later boot).
 */
export async function reclaimOrphanTunnel(
  tunnelPidPath: string,
  logger: Logger,
  deps: ReclaimDeps = {},
): Promise<number | null> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? defaultKill;

  const pid = await readPidFromFile(tunnelPidPath);
  if (pid === null) return null;

  let reclaimed: number | null = null;
  if (isAlive(pid)) {
    try {
      kill(pid);
      reclaimed = pid;
      logger.warn(
        "reclaimed orphaned cloudflared from a prior non-graceful exit",
        { pid },
      );
    } catch (err) {
      logger.warn("failed to reclaim orphaned cloudflared", {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await removePidFile(tunnelPidPath);
  return reclaimed;
}
