// Startup-time orphan handling for transcript files. Per Decision 2,
// T-P1-006: this runs once during daemon init (after audit log, before
// workspace registry). Daily timer does NOT get a transcript-orphan
// callback in P1; flag for v0.5 if accumulation surfaces.
//
// Tiering per Decision 2:
//   - File matches `j_[A-Z2-7]{12}.jsonl` (legitimate transcript):
//       mtime < 24h  → leave alone (recent; user may still inspect)
//       mtime 24h-30d → rename to `j_XXXX.orphan.jsonl`
//       mtime >30d   → delete
//   - File matches `j_[A-Z2-7]{12}.orphan.jsonl` (already-tagged orphan):
//       mtime >30d   → delete
//       otherwise    → leave
//   - Filename doesn't match either pattern: leave alone (user files).
//
// Per-file errors (stat/rename/unlink failures) increment the `errors`
// counter and the scan continues — best-effort cleanup, not gate-blocking
// for daemon startup.

import { readdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const ID_PATTERN = /^j_[A-Z2-7]{12}\.jsonl$/;
const ORPHAN_PATTERN = /^j_[A-Z2-7]{12}\.orphan\.jsonl$/;
const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DELETE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

export interface OrphanScanResult {
  scanned: number;
  left_alone: number;
  renamed: number;
  deleted: number;
  errors: number;
}

export interface OrphanScanOptions {
  /** Test-injection clock; defaults to Date.now. */
  now?: () => number;
  orphanThresholdMs?: number;
  deleteThresholdMs?: number;
}

export async function scanTranscriptOrphans(
  transcriptsDir: string,
  opts: OrphanScanOptions = {},
): Promise<OrphanScanResult> {
  const now = opts.now ?? ((): number => Date.now());
  const orphanThreshold = opts.orphanThresholdMs ?? ORPHAN_THRESHOLD_MS;
  const deleteThreshold = opts.deleteThresholdMs ?? DELETE_THRESHOLD_MS;
  const result: OrphanScanResult = {
    scanned: 0,
    left_alone: 0,
    renamed: 0,
    deleted: 0,
    errors: 0,
  };

  let entries: string[];
  try {
    entries = await readdir(transcriptsDir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return result;
    // Other readdir errors are surfaced as a single error and zero scan.
    result.errors++;
    return result;
  }

  for (const name of entries) {
    result.scanned++;
    const fullPath = join(transcriptsDir, name);
    const isLegit = ID_PATTERN.test(name);
    const isOrphan = ORPHAN_PATTERN.test(name);
    if (!isLegit && !isOrphan) {
      result.left_alone++;
      continue;
    }
    let mtimeMs: number;
    try {
      const s = await stat(fullPath);
      mtimeMs = s.mtimeMs;
    } catch {
      result.errors++;
      continue;
    }
    const ageMs = now() - mtimeMs;
    try {
      if (isLegit) {
        if (ageMs < orphanThreshold) {
          result.left_alone++;
        } else if (ageMs < deleteThreshold) {
          const newName = name.replace(/\.jsonl$/, ".orphan.jsonl");
          await rename(fullPath, join(transcriptsDir, newName));
          result.renamed++;
        } else {
          await unlink(fullPath);
          result.deleted++;
        }
      } else {
        // isOrphan
        if (ageMs >= deleteThreshold) {
          await unlink(fullPath);
          result.deleted++;
        } else {
          result.left_alone++;
        }
      }
    } catch {
      result.errors++;
    }
  }

  return result;
}
