# Recon: P3′-2b — Extension discovery + auto-pair

**Task:** T-P3′-2b · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 5,
`P3PRIME-BUILD-SEQUENCE` Phase 2b, T-P3′-0/1a (case-folded-key contract), 2a
(advert schema). **Status:** mechanism GROUND-TRUTH verified (win32); VS-Code-host
currency = operator-reload residual.

## The discovery / match / connect flow
1. Extension reads `workspaceFolders[0].uri.fsPath` → `workspaceIdentityKey(fsPath)`
   (shared, the SAME composition the daemon used) → the case-folded identity.
2. Scan the shared `daemons/` dir; `findMatchingAdvert` returns the advert whose
   `canonical_workspace` **byte-matches** the identity (the Phase-0 contract,
   finally exercised on the MATCH side).
3. On match → `ipcClient.setEndpoint(advert.pipe)` + `connect()`. The existing
   register/hello **handshake is REUSED unchanged** — it IS the liveness proof.
   A stale advert (dead daemon) fails the handshake → never reaches "connected"
   → treated as no-match (no false "connected"). The extension never deletes
   adverts (read-only; the daemon sweeps them, 2a).
4. **Either order:** `startPairing` scans immediately (daemon-first) and POLLS
   `daemons/` (every 2s) for a matching advert to appear (window-first), firing
   `onMatch` exactly once then stopping. The per-daemon pipe is STABLE per
   workspace (hash-derived), so discovery is once-only — the IpcClient's existing
   reconnect loop owns liveness across daemon restarts thereafter.

Polling (not fs.watch) was chosen for cross-platform robustness (fs.watch is
finicky on win32 + throws on an absent dir); ≤2s pairing latency is fine for
auto-connect.

## What's NEW vs REUSED (scope a — mechanism only)
- NEW: `discovery.ts` (identity/scan/match/poll), `IpcClient.setEndpoint()`
  (re-target the endpoint post-discovery), the activate() pairing block, the
  multi-root notice.
- REUSED unchanged: the hello/register handshake (`registration.ts` untouched),
  the IpcClient reconnect loop, the status bar (no rewrite — Phase 3).
- `discoverDaemonEndpoint()` (the legacy hardcoded `\\.\pipe\claude-bridge`) is
  now only a harmless initial placeholder, superseded by `setEndpoint` on match.

## Build-id currency mechanism (scope c — the structural closer)
esbuild injects `__CB_BUILD_ID__` = `<version>+<base36 build time>` (unique per
build) into the bundle. The extension sends it in the hello (`build_id`); the
daemon logs `extension build connected {build_id}`. That log line is the
machine-verified "running == built" check — it retires the manual reload-eyeball
for all future extension tasks. Live: daemon logged
`"build_id":"0.1.0+mq4cz57w"` (the exact value baked into the installed VSIX).

## Multi-root (scope b)
`workspaceFolders.length > 1` → pair on `[0]` + a clear notice ("multi-root
detected; pairing on the first folder: <name>"). Not a silent pick, not a hard
decline.

## Live ground truth (win32, 2026-06-07 — mechanism, via a sim mimicking the
extension exactly)
- byte-match: fsPath `c:\Projects\clyde_claude_bridge` → identity
  `c:\projects\clyde_claude_bridge` === advert `canonical_workspace` (TRUE);
  uppercase variant folds to the same identity (MATCH).
- connect: HELLO_OK on the advert's pipe; daemon logged the real build-id.
- stale: kill-9 the daemon → stale advert remains → match still true but the
  handshake fails (`connect ENOENT`) → no connect; advert NOT deleted by the
  extension.
- VS-Code-host currency (AC-2b-2 in the real editor + AC-2b-7 from the running
  extension): operator-reload residual — VS Code must be closed+reopened to load
  the installed VSIX; the daemon will then log build `0.1.0+mq4cz57w`.

## Out of scope (held)
Status-bar rewrite / no-daemon-paired surface / manual re-scan / spawn = Phase 3.
Multi-folder pairing beyond [0]+notice. Daemon changes beyond the build-id log.
`04-p3-oauth.md` + P3 build plan untouched.
