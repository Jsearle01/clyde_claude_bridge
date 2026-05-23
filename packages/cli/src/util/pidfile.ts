// CLI-side PID file helpers. Duplicated from `packages/daemon/src/pidfile.ts`
// (same rationale as util/paths.ts — T-0002's design intent).
//
// Extraction note: inlined in `commands/start.ts` (T-0015); T-0016's stop
// command needed the same logic plus removePidFile for the stale-cleanup
// path, so the extraction matched the AC's util/ refactor scope.

import { readFile, unlink } from "node:fs/promises";

export type PidState = "alive" | "stale" | "absent";

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
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
  if (Number.isNaN(pid) || pid <= 0) return "stale";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (isErrnoCode(err, "ESRCH")) return "stale";
    return "alive";
  }
}

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
