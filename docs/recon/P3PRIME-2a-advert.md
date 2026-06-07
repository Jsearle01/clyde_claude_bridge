# Recon: P3′-2a — Daemon advert lifecycle + cross-daemon sweep

**Task:** T-P3′-2a · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 5,
`P3PRIME-BUILD-SEQUENCE` Phase 2a, cleanup-item-(a), DESIGN-NOTE-2a-advert-content.
**Status:** GROUND-TRUTH verified live (win32).

## Advert schema written (scope a — local-pairing only, NO tunnel URL)
`<root>/daemons/<hash>.json` (top-level shared dir, NOT per-daemon — scope b):
```json
{
  "canonical_workspace": "c:\\projects\\clyde_claude_bridge",
  "name": "clyde-dev",
  "pipe": "\\\\.\\pipe\\claude-bridge-135cfaa3d11a768c",
  "port": 7423,
  "pid": 12016,
  "started_at": "2026-06-07T21:45:38.043Z"
}
```
- `canonical_workspace` = the **case-folded identity** (1a/1b key) — 2b's match
  key: the extension canonicalizes+case-folds its `workspaceFolders[0].uri.fsPath`
  and compares to this.
- `pipe` = the per-daemon IPC address 2b connects to. `port` = TCP bind
  (status/diagnostics).
- **NO tunnel URL** (ADR-002): a rotating cloudflare URL is noise; deferred to the
  stable-tunnel work. Schema is `.strict()` so adding it later is deliberate.
- `DaemonAdvertSchema` lives in `@claude-bridge/shared` (2b will consume it).

## THE LOAD-BEARING SWEEP INVARIANT (scope c)
An advert is deleted **only on a FAILED HANDSHAKE — never pid, never age** — and
"failed" means **timeout-AND-RETRY**, not one fast ping. Implemented as:
- `isAdvertLive(pipe)` = `isIpcAddressLive` (1c's connect-probe, reused — not
  reinvented) wrapped in **2 attempts**; only if BOTH fail is the advert dead. A
  live-but-slow daemon (one transient timeout) survives the retry (AC-2a-5).
- The sweep deletes ONLY adverts whose handshake fails this gate. Consequences:
  - **idempotent** (AC-2a-6): two concurrent boots deleting one corpse both just
    `unlink`; the loser's ENOENT is swallowed → same outcome.
  - **live never swept**: a live advert always handshakes → kept.
  - **unparseable advert → LEFT intact** (can't handshake → can't confirm dead →
    the invariant forbids deleting it). Logged, not removed.
  - **own advert skipped** by `selfHash` (just (re)written, live by construction).

## Lifecycle composition (reclaim-own unified, not duplicated)
- WRITE on startup AFTER `ipcServer.start()` (so `pipe` is a live rendezvous).
  Overwriting `<hash>.json` IS the **reclaim-own** path (AC-2a-3) — it generalizes
  the 1b/1c ephemeral reclaim (the pid-file overwrite) to the shared advert
  surface; no separate reclaim code.
- REMOVE on graceful exit in `shutdown()` (the advert half of the ephemeral
  cleanup, beside `removePidFile`). Durable per-daemon state never touched
  (AC-2a-7 — the sweep only scans `daemons/`).
- Both write+sweep are **best-effort** (logged, never abort an otherwise-healthy
  daemon) and **per-daemon mode only** (legacy/no-`--workspace` writes no advert).

## Live ground truth (win32, 2026-06-07)
- write → schema above present; graceful stop (IPC `stop`) → advert removed;
  kill-9 → stale advert → restart reclaimed it with the fresh pid.
- sweep: daemon A live + a planted dead advert → daemon B's boot logged
  `removed dead advert … swept:1 kept:2`; dead advert gone, A's + B's live adverts
  intact.

## Out of scope (held)
NO tunnel-lifecycle ownership (separate dispatch). NO tunnel URL in the advert.
NO extension discovery (2b). `04-p3-oauth.md` + P3 build plan untouched.
