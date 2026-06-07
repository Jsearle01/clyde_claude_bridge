// Daemon advert lifecycle (P3′ Phase 2a).
//
// The advert is the daemon's "I'm here, at this workspace, on this pipe" beacon
// that 2b's extension discovery reads to find + connect to the daemon serving
// its folder. Adverts live at the TOP-LEVEL shared dir `<root>/daemons/` (NOT
// under the per-daemon config-dir) so discovery scans ONE place to see every
// daemon: `<root>/daemons/<hash>.json`.
//
// Because an advert describes a RUNNING process, it goes stale on non-graceful
// exit. So every daemon boot SWEEPS adverts it can confirm dead — making the
// advert surface self-healing so 2b never trusts a corpse.
//
// THE LOAD-BEARING INVARIANT (scope c): an advert is deleted ONLY on a FAILED
// HANDSHAKE — never on pid, never on age — and "failed" means timeout-AND-RETRY,
// not one fast ping. This makes concurrent boot-sweeps idempotent (two boots
// deleting one corpse both just unlink it; the loser finds it already gone) and
// guarantees a live-but-slow daemon is never swept.

import { readdir, mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonAdvertSchema, type DaemonAdvert } from "@claude-bridge/shared";
import { isIpcAddressLive } from "./resources.js";
import type { Logger } from "../log/logger.js";

// The shared rendezvous dir holding every daemon's advert.
export function getDaemonsDir(rootConfigDir: string): string {
  return join(rootConfigDir, "daemons");
}

export function advertPath(rootConfigDir: string, hash: string): string {
  return join(getDaemonsDir(rootConfigDir), `${hash}.json`);
}

// Write (or overwrite) this daemon's advert. Overwriting is exactly the
// reclaim-own path: a restart after a non-graceful exit replaces its own stale
// advert with fresh pid/port/pipe — no duplicate (filename is identity-keyed).
// Generalizes the 1b/1c ephemeral reclaim (the pid-file overwrite) to the
// shared advert surface.
export async function writeAdvert(
  rootConfigDir: string,
  hash: string,
  advert: DaemonAdvert,
): Promise<string> {
  const dir = getDaemonsDir(rootConfigDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = advertPath(rootConfigDir, hash);
  await writeFile(path, JSON.stringify(advert, null, 2), { mode: 0o600 });
  return path;
}

// Remove this daemon's own advert on graceful exit. Best-effort: an
// already-absent advert (raced sweep / double shutdown) is not an error. Only
// ever touches the advert file — never durable per-daemon state.
export async function removeAdvert(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// Retry-gated liveness for the sweep (scope c). A single `isIpcAddressLive`
// is one connect attempt with a timeout; here we require BOTH attempts to fail
// before declaring an advert dead, so a live-but-slow daemon (transient timeout)
// survives. Injectable `probe` for deterministic tests.
export async function isAdvertLive(
  pipe: string,
  probe: (address: string, timeoutMs?: number) => Promise<boolean> = isIpcAddressLive,
  attempts = 2,
  timeoutMs = 1000,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await probe(pipe, timeoutMs)) return true;
  }
  return false;
}

export interface SweepResult {
  swept: string[]; // hashes whose dead adverts were removed
  kept: string[]; // hashes whose adverts handshook live (or were skipped self)
}

// Sweep every OTHER daemon's advert on startup: handshake each advert's pipe;
// delete only those that fail the retry-gated handshake. `liveOf` is injected
// (production: isAdvertLive) so the gate — including the live-but-slow safety —
// is unit-testable. Unparseable adverts are LEFT intact (can't be handshaked →
// can't be confirmed dead → the invariant forbids deleting them). Unlink is
// best-effort (ENOENT from a concurrent sweep is ignored → idempotent).
export async function sweepAdverts(
  rootConfigDir: string,
  liveOf: (pipe: string) => Promise<boolean>,
  opts: { selfHash?: string; logger?: Logger } = {},
): Promise<SweepResult> {
  const dir = getDaemonsDir(rootConfigDir);
  const result: SweepResult = { swept: [], kept: [] };
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result; // no adverts yet
    throw err;
  }

  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const hash = file.slice(0, -".json".length);
    if (opts.selfHash !== undefined && hash === opts.selfHash) {
      result.kept.push(hash); // never sweep our own freshly-written advert
      continue;
    }
    const path = join(dir, file);
    let advert: DaemonAdvert;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      advert = DaemonAdvertSchema.parse(parsed);
    } catch {
      // Unparseable → cannot handshake → cannot confirm dead → leave it (the
      // invariant: delete ONLY on failed handshake). Logged, not deleted.
      opts.logger?.warn("advert sweep: skipping unparseable advert", { path });
      result.kept.push(hash);
      continue;
    }
    if (await liveOf(advert.pipe)) {
      result.kept.push(hash);
      continue;
    }
    // Confirmed dead by failed handshake → remove (idempotent: ENOENT ignored).
    try {
      await unlink(path);
      result.swept.push(hash);
      opts.logger?.info("advert sweep: removed dead advert", {
        hash,
        name: advert.name,
        pipe: advert.pipe,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      result.swept.push(hash); // another boot beat us to it — same outcome
    }
  }
  return result;
}
