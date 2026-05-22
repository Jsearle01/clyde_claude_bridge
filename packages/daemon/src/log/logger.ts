// Daemon logger. JSON-line entries written to a file path with stdout mirror,
// queued so concurrent calls don't interleave on the file handle. Per CC-1,
// internal write failures surface to stderr — the level methods are
// fire-and-forget from the caller's perspective and must not propagate as
// unhandled rejections.
//
// Per CC-4, this logger is a passive sink — callers are responsible for not
// passing tokens or other secrets in the `extra` field; the logger does not
// redact.

import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  close(): Promise<void>;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(path: string, level: LogLevel): Logger {
  const threshold = LEVEL_RANK[level];
  let queue: Promise<void> = Promise.resolve();
  let handlePromise: Promise<FileHandle> | null = null;
  let closed = false;

  function getHandle(): Promise<FileHandle> {
    if (handlePromise === null) {
      handlePromise = (async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        return open(path, "a", 0o600);
      })();
    }
    return handlePromise;
  }

  function enqueue(work: () => Promise<void>): void {
    if (closed) return;
    queue = queue
      .then(work)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`logger: write failed: ${message}\n`);
      });
  }

  function logAt(
    callerLevel: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[callerLevel] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: callerLevel,
      msg,
      ...extra,
    };
    const line = JSON.stringify(entry) + "\n";
    enqueue(async () => {
      const h = await getHandle();
      await h.write(line);
      process.stdout.write(line);
    });
  }

  return {
    debug(msg, extra) {
      logAt("debug", msg, extra);
    },
    info(msg, extra) {
      logAt("info", msg, extra);
    },
    warn(msg, extra) {
      logAt("warn", msg, extra);
    },
    error(msg, extra) {
      logAt("error", msg, extra);
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      if (handlePromise === null) return;
      try {
        const h = await handlePromise;
        await h.close();
      } catch {
        // Open failed; the queue's catch already surfaced it via stderr.
      }
    },
  };
}
