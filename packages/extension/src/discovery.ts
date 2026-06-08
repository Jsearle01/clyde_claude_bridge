// Daemon discovery + auto-pair (P3′ Phase 2b).
//
// Auto-connect was intentionally broken since 1b (the pipe name went
// per-daemon). 2b restores it by DISCOVERING the daemon instead of assuming a
// fixed pipe: the extension canonicalizes + case-folds its
// workspaceFolders[0].uri.fsPath to the same identity key the daemon used to
// produce the advert's `canonical_workspace` (the Phase-0 contract, proven
// daemon-side in 1a, written into the advert in 2a — finally exercised on the
// MATCH side here), scans the shared `daemons/` dir, and connects to the
// matching advert's `pipe`.
//
// The per-daemon pipe is STABLE for a given workspace (hash-derived), so
// discovery is once-only: scan/poll until the first match, hand the pipe to the
// IpcClient, and let its existing reconnect loop own liveness thereafter. The
// register/hello HANDSHAKE (reused, not reinvented) is the liveness proof — a
// stale advert whose daemon is dead fails the handshake and never reaches
// "connected", so it's treated as no-match (no false "connected", and the
// extension never deletes adverts — the daemon sweeps).

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
  workspaceIdentityKey,
  DaemonAdvertSchema,
  type DaemonAdvert,
} from "@claude-bridge/shared";
import { diag } from "./diag.js";

// The shared rendezvous dir holding every daemon's advert. Mirrors the daemon's
// getConfigDir()/daemons (duplicated root logic per the cli↔daemon convention —
// the extension can't depend on the daemon package).
export function getDaemonsDir(platform: NodeJS.Platform = process.platform): string {
  const root =
    platform === "win32"
      ? join(process.env.APPDATA ?? "", "claude-bridge")
      : join(process.env.HOME ?? homedir(), ".claude-bridge");
  return join(root, "daemons");
}

// The extension's identity key for a folder — the SAME composition the daemon
// used (shared workspaceIdentityKey), so the match against `canonical_workspace`
// is byte-identical regardless of drive-letter / separator / case variance.
export function computeWorkspaceIdentity(
  fsPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return workspaceIdentityKey(fsPath, platform);
}

export interface ScanResult {
  /** Total parseable adverts present (any workspace) — drives the "no daemon"
   *  vs "no matching daemon" distinction in the status bar. */
  total: number;
  /** The advert byte-matching `identity`, or null. */
  match: DaemonAdvert | null;
  /** canonical_workspace of every parseable advert — for the re-scan near-miss
   *  diagnostic (so a path/case mismatch is visible to the operator). */
  workspaces: string[];
}

// Scan `daemons/` once: count all parseable adverts and find the one whose
// canonical_workspace byte-matches `identity`. Read-only: never mutates or
// deletes adverts (the daemon owns the sweep, AC-2b-3).
export async function scanAdverts(
  daemonsDir: string,
  identity: string,
): Promise<ScanResult> {
  let files: string[];
  try {
    files = await readdir(daemonsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { total: 0, match: null, workspaces: [] }; // no daemons yet
    }
    throw err;
  }
  let match: DaemonAdvert | null = null;
  const workspaces: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(daemonsDir, file), "utf8"),
      );
      const advert = DaemonAdvertSchema.parse(parsed);
      workspaces.push(advert.canonical_workspace);
      if (advert.canonical_workspace === identity) match = advert;
    } catch {
      // Unparseable / partial advert — skip (a daemon mid-write or a corrupt
      // file). Not counted; the daemon sweep handles dead/corrupt ones.
    }
  }
  return { total: workspaces.length, match, workspaces };
}

// Convenience wrapper used by the manual re-scan: just the matching advert.
export async function findMatchingAdvert(
  daemonsDir: string,
  identity: string,
): Promise<DaemonAdvert | null> {
  return (await scanAdverts(daemonsDir, identity)).match;
}

export interface PairingHandle {
  dispose: () => void;
}

export interface PairingDeps {
  daemonsDir: string;
  identity: string;
  // Resolve {total, match} for the identity (defaults to scanAdverts); injected
  // in tests.
  scan?: (daemonsDir: string, identity: string) => Promise<ScanResult>;
  // Called once when a matching advert is found — wires the IpcClient endpoint
  // and connects (the handshake decides liveness).
  onMatch: (advert: DaemonAdvert) => void;
  // Called after EVERY scan (P3′-3) with the latest discovery state so the
  // status bar can show "daemon not running" (total 0) vs "no matching daemon"
  // (total > 0) while not yet paired.
  onScan?: (result: ScanResult) => void;
  pollMs?: number;
  // Injectable timers for deterministic tests.
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_POLL_MS = 2000;

// Start pairing: scan immediately; if no match yet (window-first ordering),
// poll `daemons/` until a matching advert appears, then hand it to onMatch ONCE
// and stop polling (the IpcClient reconnect loop owns the stable pipe after).
// Every scan also reports via onScan (P3′-3 status). The extension re-starts
// pairing on disconnect so the status stays truthful after a daemon dies.
export function startPairing(deps: PairingDeps): PairingHandle {
  const scan = deps.scan ?? scanAdverts;
  const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  let done = false;
  let timer: unknown = null;

  const stop = (): void => {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  };

  const tryScan = async (): Promise<void> => {
    let result: ScanResult;
    try {
      result = await scan(deps.daemonsDir, deps.identity);
    } catch (err) {
      diag("discovery: scan error", { error: String(err) });
      return; // transient (e.g. dir vanished mid-scan) — keep polling
    }
    // Every scan feeds the status bar (P3′-3). The poll keeps running for the
    // life of the window so discoveryTotal stays truthful after a daemon dies.
    deps.onScan?.(result);
    if (result.match === null || done) return;
    // First match → connect ONCE. The IpcClient reconnect loop owns liveness on
    // the stable per-daemon pipe thereafter, so we don't re-connect on later
    // polls — but we keep polling for the status feed.
    const advert = result.match;
    done = true;
    diag("discovery: matched advert", {
      name: advert.name,
      pipe: advert.pipe,
      pid: advert.pid,
    });
    deps.onMatch(advert);
  };

  // Immediate attempt (daemon-first: the advert already exists), then poll
  // (window-first: pair when it appears; status feed continues after).
  void tryScan();
  timer = setIntervalFn(() => void tryScan(), pollMs);

  return { dispose: stop };
}
