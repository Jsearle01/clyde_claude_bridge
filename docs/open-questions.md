# claude-bridge — open questions

Numbered Q-items with lifecycle OPEN / TRIED / CLOSED / DEFERRED per methodology §19.

## Q001 — Linter choice

**State:** CLOSED (2026-05-21)
**Context:** Build plan §1.1 referenced `npm run lint --workspaces` but didn't pick a linter. ESLint flat config is the modern default; Biome was the alternative (faster, all-in-one, but newer and may lag on TS coverage).
**Tried:** Deferred from T-0001 → T-0002 → T-0003 because there was no source code to lint until T-0003 introduced `packages/shared/src/config.ts`. Adding lint earlier would have been busywork.
**Resolution:** **ESLint flat config** with `typescript-eslint` (v8+ meta-package, flat-config-native), using `eslint.configs.recommended` + `tseslint.configs.recommendedTypeChecked`. `projectService: true` for monorepo tsconfig auto-discovery. `eslint.config.js` lives at repo root; per-workspace `lint` scripts invoke `eslint src tests`.
**Rationale for type-checked rules:** the type-aware rules (especially `no-floating-promises`, `no-misused-promises`) directly enforce CC-1 (async error handling). Lint runs slightly slower; for project size this is invisible.
**Implementation pointer:** `eslint.config.js` (T-0003 commit), root `package.json` devDeps (`eslint`, `typescript-eslint`, `@eslint/js`), `packages/shared/package.json` script `"lint": "eslint src tests"`.

## Q002 — base32 implementation source

**State:** CLOSED (2026-05-21)
**Context:** Token generation needs RFC 4648 base32 encoding. Build plan §3.3 suggested either `base32-encode` package or a hand-rolled ~30-line implementation. Hand-roll has zero-dep advantage and the algorithm is simple; package is more standard.
**Tried:** (none — fast decision)
**Resolution:** **Hand-rolled.** The encoder is a private function inside `packages/daemon/src/config/token.ts`, ~25 lines. RFC 4648 alphabet (A–Z + 2–7), 5-bits-at-a-time over 20-byte random input → 32 char output, no padding required (20 bytes = 160 bits is an exact multiple of 5). Tested via 11.a/11.b/11.c: format match, entropy sanity, alphabet conformance.
**Implementation pointer:** `packages/daemon/src/config/token.ts` (T-0006 commit).
**Why not the package:** single use site, ~25 lines including comments, well-specified algorithm, dep adds supply-chain surface for trivial gain.
**Why not the build plan's modulo-bias version:** the build plan flagged it explicitly as wrong ("Don't ship the modulo bias version"). Real base32 uses 5-bit reads, not `byte % 32`, which would produce a non-uniform distribution over the alphabet.

## Q003 — Audit log rotation timing strategy

**State:** CLOSED (2026-05-21)
**Context:** Build plan §3.4 specified `startMidnightTimer` that schedules rotate+prune at next midnight UTC. A pure timer loses correctness if the host sleeps through midnight (laptop suspend, system standby). Alternative: check date on every append (cheap, always correct, but per-write overhead).
**Tried:** Implemented the hybrid resolution proposed in the tentative — both the midnight timer AND a cheap per-append date check. The per-append check compares `new Date().toISOString().slice(0, 10)` against the tracked date for the currently-open file; if they differ, `rotate()` runs inline before the write.
**Resolution:** **Hybrid: timer + per-append guardrail.** The timer handles the common case (daemon awake at midnight). The per-append check is the safety net for sleep-through-midnight scenarios. Cost per append is one Date construction and one string slice + comparison — negligible compared to the file write itself.
**Implementation pointer:** `packages/daemon/src/audit/log.ts` `startMidnightTimer()` schedules `rotate() + pruneOld()` at next UTC midnight; `append(entry)` checks `currentDate !== today` and calls `rotate()` inline before the write if true (the check runs inside the queue chain so it can't race with concurrent appends).
**Why not timer-only:** loses correctness if host sleeps through midnight (laptop standby, system suspend, VM pause). The daemon could be silent during sleep and still need to rotate when it wakes up — the next append should land in a fresh file with the new date.
**Why not per-append-only:** the timer is the more efficient path when the daemon is awake and continuously serving. The per-append check is genuinely a guardrail, not the primary mechanism.

## Q004 — Token rotation UX

**State:** DEFERRED → P3
**Context:** P0 design (auth and CLI rotate sections) accepts that rotating the token requires the user to manually update the Claude.ai connector configuration. This is a real UX wart but not in scope for P0.
**Tried:** Documented as known limitation in design.
**Resolution:** Closed for P0. Token rotation UX improvements (e.g. rotation hooks, named tunnel auth-rotation) deferred to P3 per `00-overview.md` gate sequence.
**Closure target:** P3 design doc.

## Q005 — Windows named pipe collision detection

**State:** CLOSED (2026-05-22)
**Context:** Build plan §3.5 uses `\\.\pipe\claude-bridge` for Windows IPC. Needed to confirm (a) Node's `net.createServer` accepts this exact form, (b) a stale pipe handle from a crashed daemon doesn't block a fresh start, (c) two intended daemons on one host can't both bind successfully.
**Tried:** Implemented in T-0008. Verified on both Unix (domain socket) and Windows (named pipe) paths:
- Unix: stale-socket detection via connect-first probe before unlink; succeeds for stale file, throws `IpcSocketBusyError` if connection succeeds.
- Windows: named-pipe collision surfaces as EADDRINUSE on `listen`; throw `IpcSocketBusyError` from `start()`'s error handler.
- Both: caller layer (daemon main, T-0013) also enforces PID-file check; the two mechanisms together provide layered collision protection.
**Resolution:** **Layered: PID-file check (CC-5, lands at T-0013) + connect-first stale-socket detection on Unix (T-0008) + EADDRINUSE detection on Windows (T-0008).** The Q-item's original concern was specifically Windows-pipe semantics; verified that Node's `net.createServer` handles `\\.\pipe\name` paths cleanly with `EADDRINUSE` on collision and clean teardown on `server.close`.
**Implementation pointers:**
- `packages/daemon/src/ipc/server.ts` `start()` — both platform paths
- `packages/daemon/src/ipc/server.ts` `IpcSocketBusyError` — thrown on collision (both platforms)
- Tests 11.j (Unix-only stale-socket cleanup), 11.k (Unix-only concurrent refused), 11.l (Windows-only concurrent refused)
**Why not just rely on the PID file:** the PID file solves "another daemon is alive"; the socket-level checks add a defense-in-depth layer for cases where the PID file is missing (stale, deleted, race-during-init) or stale-in-the-wrong-way (PID got reused by an unrelated process). Two cheap checks beat one.

## Q006 — Vitest vs Node's built-in test runner

**State:** CLOSED (2026-05-21)
**Context:** Build plan §1.1 specified Vitest. Node 20 ships a built-in test runner (`node:test`) that's stable and dep-free. Vitest is more featureful (mocks, snapshots, TS handling out of the box) but adds a dep.
**Tried:** T-0001's `npm install` produced 4 moderate dev-only advisories all tracing to the esbuild → vite → vite-node → vitest chain (GHSA-67mh-4wv8-2f99, vite dev-server CORS). This was new information not available when the Q-item was opened — the supply-chain surface of vitest is non-trivial and recurring.
**Resolution:** **Vitest.** Verifiability over minimalism. The verifiability gap with `node:test` (mocks, snapshots, TS-out-of-the-box behavior) matters more than the dev-only supply-chain surface. The advisory chain is dev-only (vite dev-server is never invoked in production daemon code paths) and the standing advisory is registered with a revisit trigger.
**Implementation pointer:** `package.json` devDependencies pinned `vitest ^1.4.0` (T-0001 commit).
**Standing advisory:** see `conventions.md` §Dev-dependency audit policy — registered as the first entry with revisit trigger "vite ships fixed esbuild, OR P0→P1 gate transition (whichever first)."

---

**Format note (methodology §19):** Q-items have lifecycle OPEN → TRIED → CLOSED. Skipping TRIED is fine for fast resolutions. Skipping CLOSED is not — a question that resolves without a recorded resolution is unauditable. Followup questions discovered during closure get Q-followup-N or QNNN.followup-N notation, never new top-level numbers.

**D-items** are different: in-task decisions surfaced in execution reports for orchestrator approval. They live in commit history and execution reports, NOT in this doc.
