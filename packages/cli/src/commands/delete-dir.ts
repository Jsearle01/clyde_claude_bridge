// `claude-bridge delete-dir --name <name>` — T-CLI-2: the only path that removes
// durable binding state, so it carries the full safety stack:
//   (a) bare → LISTS the config-dirs (workspace+name) and requires an explicit
//       TYPED --name. NO numbered pick (a number can be misread for an
//       irreversible target; a typed name that doesn't match just errors).
//       Always-name regardless of count; no --all.
//   (b) live target → ALERT + require typing the whole word `confirm`/`cancel`
//       (typing is the friction that makes an irreversible delete deliberate).
//   (c) confirm on a live target → graceful STOP (the daemon shuts itself down
//       cleanly) THEN delete — never yank the dir from under a running process.
//   (d) deletion is the CLI's filesystem action against a DEAD dir; the daemon
//       has no delete-config-dir capability (structural self-protection).
// Composes with `unbind` (token-level) — delete-dir is dir-level, never
// re-implements unbind's revoke.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  enumerateConfigDirs,
  type ConfigDirEntry,
  type EnumerateConfigDirsOpts,
} from "../util/config-dirs.js";
import { formatConfigDirList } from "./list.js";
import { stopCommand } from "./stop.js";
import { ipcAddressForHash } from "../util/paths.js";

export class DeleteDirNameRequiredError extends Error {
  constructor() {
    super(
      "delete-dir requires an explicit --name (the list above shows the names). " +
        "It never deletes on a bare invocation and offers no numbered pick — " +
        "type the name of the daemon to delete.",
    );
    this.name = "DeleteDirNameRequiredError";
  }
}

export class DeleteDirNameNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`No config dir for a daemon named '${name}' (see the list above).`);
    this.name = "DeleteDirNameNotFoundError";
  }
}

export interface DeleteDirOpts extends EnumerateConfigDirsOpts {
  name?: string;
  /** Injected typed-input reader for the live-target confirm/cancel. */
  readConfirm?: () => Promise<string>;
  /** Test-only: inject the destructive ops. */
  removeDir?: (dir: string) => Promise<void>;
  gracefulStop?: (target: ConfigDirEntry) => Promise<void>;
}

export async function deleteDirCommand(opts: DeleteDirOpts = {}): Promise<void> {
  const entries = await enumerateConfigDirs(opts);

  // (a) Bare → list + require a typed --name. Never deletes; no number.
  if (opts.name === undefined || opts.name === "") {
    process.stdout.write(formatConfigDirList(entries));
    throw new DeleteDirNameRequiredError();
  }

  const target = entries.find((e) => e.name === opts.name);
  if (target === undefined) {
    process.stdout.write(formatConfigDirList(entries));
    throw new DeleteDirNameNotFoundError(opts.name);
  }

  // (b) Live target → alert + typed confirm/cancel (the friction).
  if (target.live) {
    process.stdout.write(
      `⚠ '${target.name}' is a LIVE daemon ` +
        `(${target.workspace ?? target.hash}). Deleting its config dir will ` +
        `STOP it and remove its durable binding state — this is irreversible.\n` +
        `Type 'confirm' to stop + delete, or 'cancel' to abort: `,
    );
    const read = opts.readConfirm ?? defaultReadConfirm;
    const answer = (await read()).trim().toLowerCase();
    if (answer !== "confirm") {
      process.stdout.write("Cancelled. Nothing was deleted.\n");
      return;
    }
    // (c) Graceful stop THEN delete — never yank a running daemon's dir.
    const stop = opts.gracefulStop ?? defaultGracefulStop;
    await stop(target);
  }

  // (d) CLI-only filesystem delete against the now-dead dir.
  const remove =
    opts.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true }));
  await remove(target.configDir);
  process.stdout.write(
    `Deleted the config dir for '${target.name}' (${target.hash}).\n`,
  );
}

// Reuse commit 1's stop path: graceful IPC stop + verified termination, against
// the target's pipe + pid file. The daemon dies cleanly before we delete its dir.
async function defaultGracefulStop(target: ConfigDirEntry): Promise<void> {
  await stopCommand({
    addressOverride: ipcAddressForHash(target.hash, target.configDir),
    pidPath: join(target.configDir, "daemon.pid"),
  });
}

async function defaultReadConfirm(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  try {
    return await new Promise<string>((resolve) => {
      rl.once("line", (line) => resolve(line));
    });
  } finally {
    rl.close();
  }
}
