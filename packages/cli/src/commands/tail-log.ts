// `claude-bridge tail-log [-f]` — streams the daemon log to stdout.
// Without --follow: dumps existing content and exits. With --follow:
// dumps, then watches for appends via fs.watch and reads from the last
// position on change events. SIGINT exits gracefully.
//
// Rotation tolerance is deferred: daemon.log doesn't rotate yet (only
// the audit log does, per T-0007). If daemon.log gains rotation in a
// future task, this follow logic will lose the file handle across the
// rotation boundary and would need updating.

import { createReadStream, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { loadCliConfig } from "../util/config.js";
import { getCliConfigPath } from "../util/paths.js";

export interface TailLogOpts {
  follow?: boolean;
  /** Test-only override. */
  configPath?: string;
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === code
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function getSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}

async function dumpFrom(path: string, start: number): Promise<void> {
  const stream = createReadStream(path, { start, encoding: "utf8" });
  await pipeline(stream, process.stdout, { end: false });
}

export async function tailLogCommand(opts: TailLogOpts = {}): Promise<void> {
  const configPath = opts.configPath ?? getCliConfigPath();
  const config = await loadCliConfig(configPath);
  const logPath = config.log.path;

  const exists = await fileExists(logPath);

  if (!exists) {
    process.stderr.write("(log file not yet created)\n");
    if (opts.follow !== true) {
      return;
    }
    // Fall through to follow mode; we'll watch the parent dir below.
  }

  let position = 0;
  if (exists) {
    await dumpFrom(logPath, 0);
    position = await getSize(logPath);
  }

  if (opts.follow !== true) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let watcher: FSWatcher | null = null;
    let onSigint: (() => void) | null = null;

    const cleanup = (): void => {
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
      if (onSigint !== null) {
        process.off("SIGINT", onSigint);
        onSigint = null;
      }
    };

    onSigint = (): void => {
      cleanup();
      resolve();
    };
    process.once("SIGINT", onSigint);

    const onChange = (): void => {
      void (async () => {
        try {
          if (!(await fileExists(logPath))) return;
          const size = await getSize(logPath);
          if (size > position) {
            await dumpFrom(logPath, position);
            position = size;
          } else if (size < position) {
            // File truncated or rotated; start over from 0.
            position = 0;
            await dumpFrom(logPath, 0);
            position = await getSize(logPath);
          }
        } catch {
          // Best-effort during follow; the next change event will retry.
        }
      })();
    };

    try {
      watcher = watch(logPath, onChange);
      watcher.on("error", (err: Error) => {
        cleanup();
        reject(err);
      });
    } catch (err) {
      cleanup();
      reject(
        err instanceof Error ? err : new Error("watcher creation failed"),
      );
    }
  });
}
