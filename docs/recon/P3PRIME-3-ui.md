# Recon: P3′-3 — Extension UI (status bar + spawn) + detached-survival

**Task:** T-P3′-3 · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 6,
`P3PRIME-BUILD-SEQUENCE` Phase 3, extension-spawn design item. **Addendum applied:**
re-scan dropped, near-miss folded into the bar.

## What the current terminal `start` does (§0b3 — the long-open question)
The extension's `startDaemon` (daemon-lifecycle.ts) spawns the **`claude-bridge`
CLI** (the `.cmd` shim on win32) as a child with:
- `shell: platform === "win32"` — i.e. **cmd.exe runs the `.cmd` shim** on Windows
  (NOT a PowerShell window, NOT `cmd /c start`); a direct `node` spawn on posix.
- `detached: true` + `windowsHide: true` + `stdio: ["ignore","ignore","pipe"]`,
  then `child.unref()`.

The CLI's own `start` then **double-detaches**: it `spawn(node, [daemonMain], {
detached:true })` + `child.unref()` and exits after the daemon prints `ready`.
So the daemon's direct parent (the CLI) exits almost immediately, leaving the
daemon an independent process — NOT in VS Code's live child tree.

## Detached survival (AC-3-7) — PROVEN, not assumed
Reproduced the extension idiom exactly (shell:true + detached + unref + the
double-detaching CLI) from a throwaway parent, waited for the daemon to advertise
(`DAEMON_PID`), then **exited the parent** (simulating VS Code closing). Result:
the daemon stayed **ALIVE** (pid present) and **ADVERTISING** (advert present on
its next-free port) after the parent exited. Survival is inherited from the CLI's
double-detach — the daemon is parentless (its CLI exited) by the time VS Code goes
away, so nothing in VS Code's tree owns it.

Note: `shell:true` + an args array triggers Node's DEP0190 (args concatenated, not
escaped). The value args (`--workspace`/`--name`) are therefore **double-quoted**
for cmd.exe so paths with spaces parse correctly; the literal flags need none.

## P3′-3 surface
- **Two-segment status bar** `[daemon] $(arrow-both) [claude.ai]` — independent
  connections (extension↔daemon pipe vs daemon↔claude.ai OAuth). Tooltip is just
  `click for commands` (no status — state is inline). Daemon states (handshake
  reality, no stale/waiting):
  - `<name> (pid) · live` (connected) · `connecting…` · `version mismatch`
  - `daemon: not running — start from command palette` (no advert, total 0)
  - **`daemon: found but workspace mismatch`** (adverts present, none byte-match —
    the **case-fold canary** folded into the bar per the addendum; the one signal
    the silent poller wouldn't otherwise surface).
- **Menu = exactly Start daemon + Unbind** (addendum: re-scan dropped — the 2b
  poller already pairs on advert-appear; the diagnostic moved into the bar).
- **Derived-args spawn (AC-3-5/3-6/3-8):** `deriveSpawnArgs(fsPath)` →
  `--workspace <canonicalizeWorkspacePath(fsPath)>` + `--name <basename>`; the
  daemon advertises, 2b discovery pairs. The spawn does NOT connect itself and
  promises ONLY "daemon up + advertising" — no tunnel/connector/OAuth binding.
- **Discovery poller now runs continuously** (was once-then-stop): `onScan` feeds
  `discoveryTotal` so the bar stays truthful after a daemon dies; `onMatch`
  connects once (the reconnect loop owns liveness on the stable pipe after).
- `makeDaemonNotRunningHandler` (the old retry notification) is no longer wired
  into activate (retry surface stripped); the function remains exported + tested,
  a candidate for later removal.

## Out of scope (held)
No daemon-side changes; no CLI list/delete-dir; no tunnel-lifecycle; no
reclaim-on-fresh-consent (Phase 4). `04-p3-oauth.md` + build plan untouched.
