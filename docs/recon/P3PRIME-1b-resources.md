# Recon: P3′-1b — Per-daemon resources (config-dir + port + pipe)

**Task:** T-P3′-1b · **Date:** 2026-06-07 · **Refs:** ADR-001 Addenda 1&4,
`P3PRIME-BUILD-SEQUENCE` Phase 1b, T-P3′-1a verdict. **Status:** daemon-side
GROUND-TRUTH verified (two-daemon live run on win32).

## The derivation contract (frozen)
```
identity  = workspaceIdentityKey(--workspace)        (shared; case-folded key, 1a)
hash      = sha256(identity)[:16]                     (deterministic, fs-safe)
configDir = %APPDATA%\claude-bridge\<hash>\           (per-daemon state dir)
ipc       = win32:  \\.\pipe\claude-bridge-<hash>     (per-daemon pipe)
            posix:  <configDir>/daemon.sock           (per-daemon socket)
port      = --port <n> (explicit; error if taken) | else next-free from config
            (default 7423); legacy/no-`--workspace` mode keeps the config port
```
Hash scheme: **SHA-256 of the identity, first 16 hex chars (64 bits)** —
deterministic (same workspace → same hash → same dir → tokens persist across
restart), collision-resistant at this scale, filesystem-safe (hex only). A
readable prefix was considered and dropped: pure hash + the startup log mapping
keeps it trivially fs-safe and unambiguous. node:crypto lives package-side
(daemon `resources.ts`, duplicated in cli `util/paths.ts`) so `@claude-bridge/
shared` stays dependency-free; the error-prone identity half is the one shared
function (`workspaceIdentityKey`).

## Live example mapping (win32, captured 2026-06-07)
| --workspace | identity | hash | config-dir | port | pipe |
|---|---|---|---|---|---|
| `C:\Projects\clyde_claude_bridge` | `c:\projects\clyde_claude_bridge` | `135cfaa3d11a768c` | `…\claude-bridge\135cfaa3d11a768c\` | 7423 | `\\.\pipe\claude-bridge-135cfaa3d11a768c` |
| `C:\Projects\ClaudeDiss` | `c:\projects\claudediss` | `2d7c6310c46c5916` | `…\claude-bridge\2d7c6310c46c5916\` | 7424 | `\\.\pipe\claude-bridge-2d7c6310c46c5916` |

Two **sequentially**-started daemons → distinct dir + port + pipe, both running,
each with its own `config.json`/`daemon.pid`/`daemon.log`/`transcripts/`, no
shared writes (verified by filesystem listing). Same-workspace restart → same
`135cfaa3d11a768c` dir, no first-run init, `config.json` token unchanged
(`tokens.json` persists) — the determinism payoff.

## ⚠️ POST-1b LOCK / PORT BEHAVIOR (the AC-1b-9 finding — input to 1c)
The single-instance lock was **not re-scoped** (1c). Its post-1b behavior,
characterized live:

1. **Different-workspace daemons coexist freely.** The port-bind lock no longer
   blocks the 2nd daemon: next-free allocation hands each a distinct port, and
   the pid file is now per-daemon (separate dirs). Sequential `start A; start B`
   → 7423 + 7424, both live. **This is the desired isolation** — but it means
   the old "second start refuses" guarantee is GONE for different workspaces.

2. **Concurrent-start port RACE (the sharp edge for 1c).** `allocatePort` probes
   "is port free?" then the MCP server binds later (separate steps) — a TOCTOU
   gap. Two daemons started at the *same instant* both saw 7423 free and both
   claimed it (both logged `bind_port:7423`); the loser then failed at MCP bind
   (EADDRINUSE), NOT blocked by the lock. **Sequential start is race-free** (the
   real `claude-bridge start` flow waits for "ready", so a script's `start A &&
   start B` is serialized). Robust fix = bind-with-retry / atomic allocation —
   deferred to 1c (lock re-scope), not built here.

3. **Same-workspace double-start is UNGUARDED.** Same workspace → same dir →
   same `daemon.pid`, but the current pid check only WARNS (the port check was
   the authoritative guard, now neutralized by next-free). A concurrent
   same-workspace double-start would resolve to the same dir and both proceed →
   `tokens.json` write contention. **1c priority:** make the per-daemon pid the
   authoritative same-identity guard (refuse on a live same-dir pid).

## Ground-truth found during recon (flagged — §0(b))
- **config.json / config.workspace:** read in exactly ONE place pre-1b
  (`main.ts` `validateWorkspaceConfig(config.workspace)`). Retired — `--workspace`
  is now the single source. The validator function remains defined but
  unreferenced by startup (candidate for later removal).
- **Flat state-dir (pre-1b):** config.json, daemon.pid, daemon.log, audit*.jsonl,
  interaction.jsonl, clients.json, tokens.json, workspaces.json, transcripts/ —
  all at the flat root. Post-1b (with `--workspace`) every one resolves under
  `<root>/<hash>/`. No auto-migration (clean cutover, scope b): the flat
  `tokens.json` (6/6 clyde+cocoai dual binding) is now orphaned; operator
  re-binds. The flat root remains for the legacy/no-`--workspace` daemon and the
  future top-level `daemons/` advert dir (2a).
- **Pipe name was hardcoded** `\\.\pipe\claude-bridge` in THREE places (daemon
  ipc/server, cli util/paths, extension ipc/client); win32 ignored config
  `ipc_socket`. Daemon now listens on the per-daemon pipe (via addressOverride);
  CLI `start` derives the same. **Extension auto-connect breaks until 2b**
  (scope d, intended) — the extension still targets the legacy pipe; the
  per-daemon pipe is in the startup log for an interim manual connect.
- **Lock baseline:** port-bind probe (`isDaemonPortListening`) authoritative +
  pid file diagnostic (CB-DAEMON-LIFECYCLE-FIX) — confirmed, as the 6/6 facts said.

## Scope held
No hashing beyond the dir/pipe derivation, no `daemons/` advert (2a), no lock
re-scope (1c), no extension changes (2b), no auto-migration. `04-p3-oauth.md` +
P3 build plan untouched.
