// T-CLI-1: THE unified daemon selector. Every verb that ADDRESSES a daemon
// resolves its target through here, so the targeting logic — and the §2
// asymmetric default — lives in ONE place instead of ad-hoc per verb. (Ad-hoc
// is exactly how it drifted: bare `status` got `enumerate` while bare `stop`
// fell through to the flat layout and misreported "not running".)
//
// Selection inputs:
//   --workspace <canonical path>  → that daemon (no enumeration needed).
//   --name <label>                → enumerate adverts, match by name.
//   neither (bare)                → the asymmetric default: exactly one daemon
//                                   live → act on it; more than one → error +
//                                   list; none → "no daemons running". Never
//                                   silently fall to the (empty) flat layout.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DaemonAdvertSchema, type DaemonAdvert } from "@claude-bridge/shared";
import {
  perDaemonResources,
  getCliConfigDir,
  getCliConfigPath,
  getCliPidPath,
  ipcAddressForHash,
} from "./paths.js";
import {
  enumerateConfigDirs,
  renderDaemonList,
  type ConfigDirEntry,
} from "./config-dirs.js";

export class NoDaemonsRunningError extends Error {
  constructor() {
    super("No daemons running.");
    this.name = "NoDaemonsRunningError";
  }
}

// A specific targeted daemon was selected but is not running (absent/stale pid).
// (Relocated from the removed token.ts in T-BEARER-1; reused by tunnel/unbind.)
export class DaemonNotRunningError extends Error {
  constructor() {
    super("Daemon not running. Start it with `claude-bridge start` first.");
    this.name = "DaemonNotRunningError";
  }
}

export class AmbiguousDaemonError extends Error {
  constructor(public readonly entries: readonly ConfigDirEntry[]) {
    super(
      `${entries.length} daemons running — name one with --name <name> (or --workspace <path>):\n` +
        // T-CLI-4a: same shared renderer as the TTY pick — name+workspace+hash,
        // not names-only.
        renderDaemonList(entries),
    );
    this.name = "AmbiguousDaemonError";
  }
}

export class DaemonNameNotFoundError extends Error {
  constructor(
    public readonly name: string,
    public readonly available: readonly string[],
  ) {
    const list =
      available.length > 0
        ? ` Running: ${available.join(", ")}.`
        : " No daemons running.";
    super(`No daemon named '${name}'.${list}`);
    this.name = "DaemonNameNotFoundError";
  }
}

// Enumerate the parseable adverts in the shared daemons dir (the 1b/2a daemon
// inventory). Shared by the selector and `status`'s bare enumerate.
export async function enumerateAdverts(
  daemonsDir?: string,
): Promise<DaemonAdvert[]> {
  const dir = daemonsDir ?? join(getCliConfigDir(), "daemons");
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const adverts: DaemonAdvert[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      adverts.push(
        DaemonAdvertSchema.parse(
          JSON.parse(await readFile(join(dir, file), "utf8")),
        ),
      );
    } catch {
      // Unparseable / partial advert — skip (same tolerance as statusEnumerate).
    }
  }
  return adverts;
}

export interface SelectedTarget {
  pidPath: string;
  /** The per-daemon config.json path (for verbs that read config, e.g. tail-log). */
  configPath: string;
  addressOverride: string | undefined;
  /** The canonical workspace targeted. */
  workspace: string;
  /** Human label for messages (the daemon name, or the workspace). */
  label: string;
}

export interface SelectorInput {
  workspace?: string;
  name?: string;
  // T-CLI-4a: the config-dir root the unified enumeration scans (test-only;
  // defaults to getCliConfigDir()). Replaces the advert-dir source so the
  // selector + `list` share ONE enumeration → identical render.
  configRoot?: string;
  // Test-only: liveness probe override (default = real IPC handshake).
  probe?: (entry: { hash: string; configDir: string }) => Promise<boolean>;
  // Test-only overrides — bypass enumeration (the IPC mechanics are tested
  // directly elsewhere). Production passes neither.
  addressOverride?: string;
  pidPath?: string;
  // T-CLI-3: interactive numbered pick when bare + many daemons. Defaults to
  // process.stdin.isTTY; non-interactive (piped/CI) → error-and-list (no hang).
  interactive?: boolean;
  // Test-only: inject the pick (returns the 1-based selection) instead of
  // rendering + reading stdin.
  pickNumber?: (entries: readonly ConfigDirEntry[]) => Promise<number>;
}

export class InvalidDaemonPickError extends Error {
  constructor(public readonly choice: string, public readonly count: number) {
    super(`'${choice}' is not a valid choice (pick 1–${count}).`);
    this.name = "InvalidDaemonPickError";
  }
}

// Resolve which per-daemon daemon a verb targets. Throws a typed error for the
// no-daemons / ambiguous / name-not-found cases (the CLI prints the message and
// exits 1) — never silently degrades to the flat layout.
export async function selectDaemonTarget(
  opts: SelectorInput,
): Promise<SelectedTarget> {
  // Test override path.
  if (opts.pidPath !== undefined || opts.addressOverride !== undefined) {
    return {
      pidPath: opts.pidPath ?? getCliPidPath(),
      configPath: getCliConfigPath(),
      addressOverride: opts.addressOverride,
      workspace: opts.workspace ?? "",
      label: opts.workspace ?? "(override)",
    };
  }
  // Explicit --workspace: target it directly (no enumeration).
  if (opts.workspace !== undefined && opts.workspace !== "") {
    const res = perDaemonResources(opts.workspace);
    return {
      pidPath: res.pidPath,
      configPath: res.configPath,
      addressOverride: res.ipcAddress,
      workspace: opts.workspace,
      label: opts.workspace,
    };
  }
  // T-CLI-4a: the unified enumeration — the config-dir layer + handshake
  // liveness, the SAME source `list`/`delete-dir` use, so a daemon renders
  // identically everywhere (no advert-vs-config-dir field divergence).
  const all = await enumerateConfigDirs({
    configRoot: opts.configRoot,
    probe: opts.probe,
  });
  // Explicit --name: match any config-dir by name (live or dead — a dead target
  // simply fails at IPC, which the verb reports).
  if (opts.name !== undefined && opts.name !== "") {
    const match = all.find((e) => e.name === opts.name);
    if (match === undefined) {
      throw new DaemonNameNotFoundError(
        opts.name,
        all
          .map((e) => e.name)
          .filter((n): n is string => n !== null)
          .sort(),
      );
    }
    return targetFromConfigDir(match);
  }
  // Bare — act on a LIVE daemon (you can't act on a dead one).
  const live = all.filter((e) => e.live);
  if (live.length === 0) throw new NoDaemonsRunningError();
  if (live.length > 1) {
    const sorted = [...live].sort((a, b) =>
      (a.name ?? a.hash).localeCompare(b.name ?? b.hash),
    );
    // T-CLI-3: interactive → numbered pick; non-interactive → error-and-list.
    // (delete-dir does NOT call this path — it keeps typed-name-no-number.)
    const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      throw new AmbiguousDaemonError(sorted);
    }
    const pick = opts.pickNumber ?? defaultPickNumber;
    const choice = await pick(sorted);
    const chosen = sorted[choice - 1];
    if (chosen === undefined) {
      throw new InvalidDaemonPickError(String(choice), sorted.length);
    }
    return targetFromConfigDir(chosen);
  }
  const sole = live[0];
  if (sole === undefined) throw new NoDaemonsRunningError();
  return targetFromConfigDir(sole);
}

// T-CLI-3/4a: render the numbered list via the SHARED renderer (same surface as
// `list`), then read a 1-based choice from stdin. Only used on an interactive TTY.
async function defaultPickNumber(
  entries: readonly ConfigDirEntry[],
): Promise<number> {
  process.stdout.write(`${entries.length} daemons running:\n`);
  process.stdout.write(renderDaemonList(entries, { numbered: true }));
  process.stdout.write(`Pick a number (1-${entries.length}): `);
  const rl = createInterface({ input: process.stdin });
  try {
    const line = await new Promise<string>((resolve) => {
      rl.once("line", (l) => resolve(l));
    });
    return Number.parseInt(line.trim(), 10);
  } finally {
    rl.close();
  }
}

function targetFromConfigDir(e: ConfigDirEntry): SelectedTarget {
  // The address derives from the config-dir hash (matches the daemon's own
  // per-daemon pipe); pid/config paths live in the dir.
  return {
    pidPath: join(e.configDir, "daemon.pid"),
    configPath: join(e.configDir, "config.json"),
    addressOverride: ipcAddressForHash(e.hash, e.configDir),
    workspace: e.workspace ?? e.hash,
    label: e.name ?? e.hash,
  };
}
