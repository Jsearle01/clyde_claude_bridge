// Audit log writer. Queued append-only JSON-line writes with daily UTC
// rotation, retention pruning, and per-append date guardrail (Q003 hybrid:
// midnight timer + per-write date check).
//
// Same queue/handle/close discipline as `packages/daemon/src/log/logger.ts`
// (see `patterns/project/async-sink-queue.md`). Departure point: `append`
// returns a Promise that resolves when *that specific entry* has been
// flushed, so callers (MCP request handlers) can await the audit record
// before responding.

import {
  mkdir,
  open,
  rename,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import type { AuditEntry } from "@claude-bridge/shared";

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/**
 * Append-only daily-rotated JSONL sink. Generic over the entry type so the
 * same mechanism (queue/handle/close discipline, midnight rotation, retention
 * prune, 0700 dir / 0600 file) backs both the per-tool-call audit log
 * (`AuditEntry`) and T-P3-007's delegation interaction log (`InteractionEvent`)
 * without reimplementation. The archive prefix is derived from the active
 * file's basename (`audit.jsonl` → `audit-YYYY-MM-DD.jsonl`,
 * `interaction.jsonl` → `interaction-YYYY-MM-DD.jsonl`), so `audit.jsonl`
 * behavior is unchanged.
 */
export class AuditLog<E = AuditEntry> {
  private readonly path: string;
  private readonly dir: string;
  private readonly retentionDays: number;
  private readonly clock: () => Date;
  private readonly archivePrefix: string;
  private readonly archivePattern: RegExp;

  private queue: Promise<void> = Promise.resolve();
  private handlePromise: Promise<FileHandle> | null = null;
  private currentDate: string | null = null;
  private closed = false;

  constructor(
    path: string,
    retentionDays: number,
    clock: () => Date = () => new Date(),
  ) {
    this.path = path;
    this.dir = dirname(path);
    this.retentionDays = retentionDays;
    this.clock = clock;
    // e.g. "audit.jsonl" → "audit"; "interaction.jsonl" → "interaction".
    this.archivePrefix = basename(path).replace(/\.jsonl$/, "");
    const escaped = this.archivePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.archivePattern = new RegExp(`^${escaped}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  }

  private todayUtc(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private async openIfNeeded(): Promise<FileHandle> {
    if (this.handlePromise === null) {
      const dir = this.dir;
      const path = this.path;
      this.handlePromise = (async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        return open(path, "a", 0o600);
      })();
    }
    return this.handlePromise;
  }

  private async closeAndRename(previousDate: string): Promise<void> {
    if (this.handlePromise !== null) {
      try {
        const h = await this.handlePromise;
        await h.close();
      } catch {
        // Open failed previously; nothing to close.
      }
      this.handlePromise = null;
    }
    const archive = join(this.dir, `${this.archivePrefix}-${previousDate}.jsonl`);
    try {
      await rename(this.path, archive);
    } catch (err) {
      // If no writes happened on the rotated day, the file may not exist.
      // Silently ignore ENOENT; rethrow anything else.
      if (!isErrnoCode(err, "ENOENT")) throw err;
    }
  }

  // Runs only inside the queue chain so it cannot race with appends.
  private async rotateInline(now?: Date): Promise<void> {
    const today = (now ?? this.clock()).toISOString().slice(0, 10);
    if (this.currentDate === null) {
      this.currentDate = today;
      return;
    }
    if (this.currentDate === today) return;
    const previous = this.currentDate;
    await this.closeAndRename(previous);
    this.currentDate = today;
  }

  async append(entry: E): Promise<void> {
    if (this.closed) return;

    let resolveWrite!: () => void;
    let rejectWrite!: (err: unknown) => void;
    const writeDone = new Promise<void>((res, rej) => {
      resolveWrite = res;
      rejectWrite = rej;
    });

    this.queue = this.queue
      .then(async () => {
        try {
          // Per-append date guardrail (Q003 hybrid). Done inside the queue
          // so it serializes against other writes and external rotate calls.
          await this.rotateInline();
          const h = await this.openIfNeeded();
          await h.write(JSON.stringify(entry) + "\n");
          resolveWrite();
        } catch (err) {
          rejectWrite(err);
          throw err;
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`audit: write failed: ${msg}\n`);
      });

    return writeDone;
  }

  async rotate(now?: Date): Promise<void> {
    // Public rotate: serialize through the queue so it can't race appends.
    let resolveRotate!: () => void;
    let rejectRotate!: (err: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolveRotate = res;
      rejectRotate = rej;
    });

    this.queue = this.queue
      .then(async () => {
        try {
          await this.rotateInline(now);
          resolveRotate();
        } catch (err) {
          rejectRotate(err);
          throw err;
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`audit: rotate failed: ${msg}\n`);
      });

    return done;
  }

  async pruneOld(now?: Date): Promise<void> {
    // pruneOld doesn't touch the active handle (the active file
    // `audit.jsonl` doesn't match the archive pattern), so it can run
    // outside the queue without conflict.
    const nowMs = (now ?? this.clock()).getTime();
    const retentionMs = this.retentionDays * 86400 * 1000;

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) return;
      throw err;
    }

    for (const name of entries) {
      const match = this.archivePattern.exec(name);
      if (match === null) continue;
      const dateStr = match[1];
      if (dateStr === undefined) continue;
      const fileMs = Date.parse(`${dateStr}T00:00:00Z`);
      if (Number.isNaN(fileMs)) continue;
      if (nowMs - fileMs > retentionMs) {
        await unlink(join(this.dir, name));
      }
    }
  }

  /** Daily-fire entrypoint registered with `DailyTimer` at startup.
   * Performs the day-rollover rotate plus retention prune as a single
   * unit. Errors from either step are surfaced to the daemon's stderr
   * (the timer's onError hook handles further routing). */
  async runMidnightTasks(): Promise<void> {
    try {
      await this.rotate();
      await this.pruneOld();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`audit: midnight task failed: ${msg}\n`);
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    if (this.handlePromise !== null) {
      try {
        const h = await this.handlePromise;
        await h.close();
      } catch {
        // Open failed; nothing to close.
      }
      this.handlePromise = null;
    }
  }
}
