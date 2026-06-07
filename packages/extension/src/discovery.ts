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

// Scan `daemons/` and return the advert whose canonical_workspace byte-matches
// `identity` (or null). Unparseable adverts are skipped (defensive). Read-only:
// never mutates or deletes adverts (the daemon owns the sweep, AC-2b-3).
export async function findMatchingAdvert(
  daemonsDir: string,
  identity: string,
): Promise<DaemonAdvert | null> {
  let files: string[];
  try {
    files = await readdir(daemonsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; // no daemons yet
    throw err;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(
        await readFile(join(daemonsDir, file), "utf8"),
      );
      const advert = DaemonAdvertSchema.parse(parsed);
      if (advert.canonical_workspace === identity) return advert;
    } catch {
      // Unparseable / partial advert — skip (a daemon mid-write or a corrupt
      // file). Not our match; the daemon sweep handles dead/corrupt ones.
    }
  }
  return null;
}

export interface PairingHandle {
  dispose: () => void;
}

export interface PairingDeps {
  daemonsDir: string;
  identity: string;
  // Resolve a matching advert (defaults to findMatchingAdvert); injected in tests.
  scan?: (daemonsDir: string, identity: string) => Promise<DaemonAdvert | null>;
  // Called once when a matching advert is found — wires the IpcClient endpoint
  // and connects (the handshake decides liveness).
  onMatch: (advert: DaemonAdvert) => void;
  pollMs?: number;
  // Injectable timers for deterministic tests.
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_POLL_MS = 2000;

// Start pairing: scan immediately; if no match yet (window-first ordering),
// poll `daemons/` until a matching advert appears, then hand it to onMatch ONCE
// and stop polling (the IpcClient reconnect loop owns the stable pipe after).
export function startPairing(deps: PairingDeps): PairingHandle {
  const scan = deps.scan ?? findMatchingAdvert;
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

  const tryPair = async (): Promise<void> => {
    if (done) return;
    let advert: DaemonAdvert | null;
    try {
      advert = await scan(deps.daemonsDir, deps.identity);
    } catch (err) {
      diag("discovery: scan error", { error: String(err) });
      return; // transient (e.g. dir vanished mid-scan) — keep polling
    }
    if (advert === null || done) return;
    done = true;
    stop();
    diag("discovery: matched advert", {
      name: advert.name,
      pipe: advert.pipe,
      pid: advert.pid,
    });
    deps.onMatch(advert);
  };

  // Immediate attempt (daemon-first: the advert already exists), then poll
  // (window-first: pair when it appears).
  void tryPair();
  timer = setIntervalFn(() => void tryPair(), pollMs);

  return { dispose: stop };
}
