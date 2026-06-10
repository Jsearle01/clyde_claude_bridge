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
} from "./paths.js";

export class NoDaemonsRunningError extends Error {
  constructor() {
    super("No daemons running.");
    this.name = "NoDaemonsRunningError";
  }
}

export class AmbiguousDaemonError extends Error {
  constructor(public readonly names: readonly string[]) {
    super(
      `${names.length} daemons running — name one with --name <name> (or --workspace <path>):\n` +
        names.map((n) => `  - ${n}`).join("\n"),
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
  daemonsDir?: string;
  // Test-only overrides — bypass enumeration (the IPC mechanics are tested
  // directly elsewhere). Production passes neither.
  addressOverride?: string;
  pidPath?: string;
  // T-CLI-3: interactive numbered pick when bare + many daemons. Defaults to
  // process.stdin.isTTY; non-interactive (piped/CI) → error-and-list (no hang).
  interactive?: boolean;
  // Test-only: inject the pick (returns the 1-based selection) instead of
  // rendering + reading stdin.
  pickNumber?: (adverts: readonly DaemonAdvert[]) => Promise<number>;
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
  const adverts = await enumerateAdverts(opts.daemonsDir);
  // Explicit --name: match by advertised name.
  if (opts.name !== undefined && opts.name !== "") {
    const match = adverts.find((a) => a.name === opts.name);
    if (match === undefined) {
      throw new DaemonNameNotFoundError(
        opts.name,
        adverts.map((a) => a.name).sort(),
      );
    }
    return targetFromAdvert(match);
  }
  // Bare — the §2 asymmetric default.
  if (adverts.length === 0) throw new NoDaemonsRunningError();
  if (adverts.length > 1) {
    const sorted = [...adverts].sort((a, b) => a.name.localeCompare(b.name));
    // T-CLI-3: interactive → numbered pick; non-interactive → error-and-list.
    // (delete-dir does NOT call this path — it keeps typed-name-no-number.)
    const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
    if (!interactive) {
      throw new AmbiguousDaemonError(sorted.map((a) => a.name));
    }
    const pick = opts.pickNumber ?? defaultPickNumber;
    const choice = await pick(sorted);
    const chosen = sorted[choice - 1];
    if (chosen === undefined) {
      throw new InvalidDaemonPickError(String(choice), sorted.length);
    }
    return targetFromAdvert(chosen);
  }
  const sole = adverts[0];
  if (sole === undefined) throw new NoDaemonsRunningError();
  return targetFromAdvert(sole);
}

// T-CLI-3: render the numbered list (name + workspace per entry, same surface as
// `list`) and read a 1-based choice from stdin. Only used on an interactive TTY.
async function defaultPickNumber(
  adverts: readonly DaemonAdvert[],
): Promise<number> {
  process.stdout.write(`${adverts.length} daemons running:\n`);
  adverts.forEach((a, i) => {
    process.stdout.write(`  [${i + 1}] ${a.name} — ${a.canonical_workspace}\n`);
  });
  process.stdout.write(`Pick a number (1-${adverts.length}): `);
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

function targetFromAdvert(advert: DaemonAdvert): SelectedTarget {
  // The advert is authoritative for the address (it's what the daemon
  // advertised); the per-daemon pid + config paths derive from the canonical
  // workspace (match the daemon's own per-daemon resources).
  const res = perDaemonResources(advert.canonical_workspace);
  return {
    pidPath: res.pidPath,
    configPath: res.configPath,
    addressOverride: advert.pipe,
    workspace: advert.canonical_workspace,
    label: advert.name,
  };
}
