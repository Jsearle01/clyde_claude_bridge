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

**State:** OPEN
**Context:** Token generation needs RFC 4648 base32 encoding. Build plan §3.3 suggests either `base32-encode` package or a hand-rolled ~30-line implementation. Hand-roll has zero-dep advantage and the algorithm is simple; package is more standard.
**Tried:** (none)
**Tentative resolution:** Hand-roll. Single use site, ~30 lines, well-specified algorithm. A dep for this isn't worth the supply-chain surface.
**Closure target:** T-0006 (config layer / token generation).

## Q003 — Audit log rotation timing strategy

**State:** OPEN
**Context:** Build plan §3.4 specifies `startMidnightTimer` that schedules rotate+prune at next midnight UTC. A pure timer loses correctness if the host sleeps through midnight (laptop suspend, system standby). Alternative: check date on every append (cheap, always correct, but per-write overhead).
**Tried:** (none)
**Tentative resolution:** Hybrid — timer for the common case, plus a cheap date-compare on every append as guardrail. Test by writing during day-N and day-N+1 with simulated clock advance.
**Closure target:** T-0007 (audit log).

## Q004 — Token rotation UX

**State:** DEFERRED → P3
**Context:** P0 design (auth and CLI rotate sections) accepts that rotating the token requires the user to manually update the Claude.ai connector configuration. This is a real UX wart but not in scope for P0.
**Tried:** Documented as known limitation in design.
**Resolution:** Closed for P0. Token rotation UX improvements (e.g. rotation hooks, named tunnel auth-rotation) deferred to P3 per `00-overview.md` gate sequence.
**Closure target:** P3 design doc.

## Q005 — Windows named pipe collision detection

**State:** OPEN
**Context:** Build plan §3.5 uses `\\.\pipe\claude-bridge` for Windows IPC. Need to confirm (a) Node's `net.createServer` accepts this exact form, (b) a stale pipe handle from a crashed daemon doesn't block a fresh start, (c) two intended daemons on one host can't both bind successfully.
**Tried:** (none)
**Tentative resolution:** The PID-file + stale-PID check (CC-5 in conventions.md) provides the protection regardless of pipe semantics — if another daemon is alive, we refuse to start; if it's not, we proceed and Node either succeeds or fails clearly. If the pipe form needs adjustment, document in conventions.md.
**Closure target:** T-0008 (IPC server) — verified on Windows.

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
