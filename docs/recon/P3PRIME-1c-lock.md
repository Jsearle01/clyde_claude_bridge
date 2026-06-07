# Recon: P3′-1c — Identity-keyed single-instance lock + atomic bind-with-retry

**Task:** T-P3′-1c · **Date:** 2026-06-07 · **Refs:** ADR-001 Addendum 1,
`P3PRIME-BUILD-SEQUENCE` Phase 1c, T-P3′-1b verdict AC-1b-9. **Status:** both
items GROUND-TRUTH verified live (win32).

## Lock mechanism chosen: connect-probe the per-daemon IPC pipe/socket — and why
The invariant (scope a) is **liveness, not bare pid-file presence, decides
refuse-vs-reclaim**. The mechanism: **`isIpcAddressLive(ipcAddress)` — connect to
THIS daemon's per-daemon pipe/socket; a successful connect means a live
same-identity incumbent is listening → REFUSE; ECONNREFUSED/ENOENT → not live →
RECLAIM.**

Why this over the alternatives (the §0b2 ground truth that drove it):
- **win32 named pipes allow multiple server *instances* by default** — confirmed
  by reading `IpcServer.start()`: on win32 it just `server.listen(pipe)` with no
  `FIRST_PIPE_INSTANCE` / single-instance flag, and (unlike posix) does NO
  stale-socket cleanup. So **binding the pipe does NOT lock on win32** — a second
  listener can coexist. That kills "pipe-as-lock" via bind semantics.
- posix unix-socket bind *does* refuse a live incumbent (IpcServer's
  `cleanupStaleSocket` connect-probes → `IpcSocketBusyError`), but that's late
  (at IpcServer.start) and platform-asymmetric.
- A **connect-probe is uniform**: a live listener answers a connect on BOTH
  platforms regardless of multi-instance bind semantics, and it's liveness-true
  (a crashed daemon's pipe/socket is OS-released → connect fails → reclaim). No
  new dependency (vs flock libs). Reuses the exact pattern already in the
  codebase (`isDaemonPortListening`, IpcServer's `probeConnect`).

Acquired **early** (main.ts step 2.3, before port/MCP work) so a refused start
has zero side effects (scope b): incumbent's files + process untouched, and the
explicit-`--port` check + pid write both happen *after* the lock, so a refusal
writes nothing.

## ITEM 2: bind-with-retry (the TOCTOU closer)
1b allocated the port by **probe-then-bind** (connect-probe free? → return port →
McpServer binds later) — two concurrent starts both saw 7423 free, both claimed
it, the loser died `EADDRINUSE`. 1c makes **the bind the claim**:
`McpServer.start()` (autoAllocate mode) calls `bindWithRetry(tryListen,
{startPort})` — attempt `listen(port)`; on EADDRINUSE advance to port+1; first
success wins; bounded by `MAX_PORT_SCAN` → `NoFreePortError`. Explicit `--port`
keeps a single pre-check + `ExplicitPortInUseError` (no retry past the operator's
choice). The retry logic is injectable (`tryBind`) for the deterministic
mock-EADDRINUSE unit test (the §5 ITEM 2 proof; the live race is timing-dependent
and only corroborates).

## Live ground truth (win32, 2026-06-07)
- **AC-1c-1 refuse-live:** dup start of clyde → `Daemon for this workspace is
  already running (pid 24240) … it remains active`, log `refusing start: live
  same-identity incumbent`, exit 1.
- **AC-1c-7 untouched:** incumbent pid 24240 still alive post-dup, pid file
  unchanged, no `shutdown starting` in its log.
- **AC-1c-2 reclaim:** `kill -9` incumbent → restart came up `ready`, zero
  refusals (liveness, not the stale pid file, decided).
- **AC-1c-3/4 race closed:** concurrent start of clyde + ClaudeDiss → distinct
  ports **7423 + 7424, both up, zero EADDRINUSE deaths** (1b killed one here).
- **AC-1c-5:** `--port 7500` taken → `ExplicitPortInUseError`, exit 1.

## How 1b left things (read-first findings, flagged)
- The single-instance "guard" 1b left was a **vacuous port check** (after
  next-free allocation `config.daemon.bind_port` is already free, so the check
  always passed) + a **warn-only** stale-pid log. Both removed/replaced for
  per-daemon mode; legacy/no-`--workspace` mode keeps the original port-based
  guard unchanged.
- `IpcServer.start()` win32 path: no first-instance flag, no stale cleanup
  (posix has connect-probe cleanup) — the asymmetry that ruled out pipe-as-lock.

## Residual (honest, narrow — not in this phase's scope)
The IPC pipe (the lock signal) comes up late in startup, so two *exactly
simultaneous* SAME-workspace starts have a sub-second window where both pass the
connect-probe before either's IPC listens. The real operator flow is race-free:
`claude-bridge start` waits for `ready` (full startup incl. IPC), so a
restart/second-start sees the incumbent live and refuses. A fully race-proof
same-identity lock would need an OS-early lock (flock-style) — out of scope here;
noted should it ever matter.

## Scope held
SAME-identity lock reclaim only — no cross-daemon advert sweep (2a), no
`daemons/` advert, no extension changes (2b), no CLI list/delete. `04-p3-oauth.md`
+ P3 build plan untouched.
