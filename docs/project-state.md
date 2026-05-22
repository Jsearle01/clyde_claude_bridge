# claude-bridge — project state

**Project:** claude-bridge
**Methodology version:** v0.3
**Current phase:** P0 (bus validation)
**Current integration milestone:** INT-1 (first ping roundtrip from Claude.ai project)
**Last conversation date:** 2026-05-21
**Status:** T-0007 CONFIRMED; T-0008 in progress (IPC server; closes Q005).

## Gate status

| Gate | Status | Owner | Notes |
|------|--------|-------|-------|
| Day-zero setup | CLOSED | Orchestrator | Methodology infrastructure produced 2026-05-21 |
| P0 (bus validation) | OPEN | — | 10 acceptance criteria in `01-p0-bus.md`; AC-* blockers tracked in `milestones.md` |
| P1 (headless delegation) | NOT STARTED | — | Design doc written after P0 ships |
| P2 (VS Code extension) | NOT STARTED | — | Design doc written after P1 ships |
| INT-1 (ping roundtrip) | OPEN | — | All 10 AC blockers still OPEN |

## Task queue

### In progress
- T-0008 — Daemon IPC server + Q005 closure (build plan §3.5)

### Pending (ordered, mapped from `p0-build-plan.md` sections)
- T-0009 — packages/daemon MCP server skeleton + HTTP transport (build plan §4.1)
- T-0010 — packages/daemon MCP auth middleware (build plan §4.1)
- T-0011 — packages/daemon tool dispatch + ping (build plan §4.1)
- T-0012 — packages/daemon tunnel manager (build plan §5)
- T-0013 — packages/daemon main wiring + pidfile + state (build plan §6)
- T-0014 — packages/cli ipc-client (build plan §7.2)
- T-0015 — packages/cli start command (build plan §7.2)
- T-0016 — packages/cli stop/status/tail-log (build plan §7.2)
- T-0017 — packages/cli token rotate + tunnel restart (build plan §7.2)
- T-0018 — packages/cli bin entry + global install (build plan §7.3)
- T-0019 — Acceptance test script (build plan §8)
- T-0020 — README + runbook (Definition of done items)

### Recently completed
- **T-0007** — Daemon audit log + Q003 closure + sink-queue pattern (CONFIRMED 2026-05-22; commit 17b30d4)
  - All 16 gate-blocking AC passed; zero reactive deviations
  - `packages/daemon/src/audit/{hash,log}.ts`: hashInput with recursive canonicalization; AuditLog with queued writes, hybrid midnight-timer + per-append-guardrail rotation, idempotent stop()
  - `append()` returns flushed Promise (departure from logger's void return)
  - Per-append date check inside queue handler (race fix documented as anti-example in new pattern doc)
  - `patterns/project/async-sink-queue.md` created at status `active` (codifies logger + audit-log shared shape)
  - Q003 CLOSED via hybrid resolution
  - conventions.md: ESLint glob maintenance note + temp-file test pattern
  - milestones.md: AC-9 → IMPLEMENTED (Unix runtime verification pending)
  - 16 new daemon tests; 66 total passing
  - `recommendedTypeChecked` 4th consecutive zero-fire on async code — rule set declared validated
- **T-0006** — Daemon config layer (paths, load, init, token) (CONFIRMED 2026-05-21; commit ca6ae92)
  - All 19 gate-blocking AC passed
  - `packages/daemon/src/config/{paths,token,load,init}.ts` — full surface for T-0013 wiring and T-0015 CLI start
  - `loadConfig` implements **AC-9** from `01-p0-bus.md` (mode-0600 enforcement on Unix) — first P0 acceptance criterion implemented
  - Q002 CLOSED via hand-rolled RFC 4648 base32 encoder (~25 lines, no dep, no modulo bias)
  - `constant-time-compare.md` promoted draft → active
  - `ConfigAlreadyExistsError` introduced for T-0015's first-run vs already-initialized distinction
  - 22 new daemon tests (20 run + 2 platform-skipped on Windows)
  - One reactive: ESLint allowDefaultProject glob widened by one level for `tests/<subdir>/*.test.ts`
- **T-0005** — Daemon logger + carried fixes + pattern promotion (CONFIRMED 2026-05-21; commit 4e74331)
  - All 14 gate-blocking AC passed; second consecutive zero-deviation task
  - `packages/daemon/src/log/logger.ts`: Promise-chain queue (CC-1), lazy file-handle open, idempotent close()
  - `packages/daemon/tests/logger.test.ts`: 6 cases (4.a–4.f)
  - Daemon tsconfig transition (second instance of lifecycle pattern)
  - `packages/shared/src/ipc.ts`: `daemon_uptime_s` tightened to `.int().nonnegative()` (carried from T-0004 verdict)
  - `patterns/project/test-token-fixtures.md` created at status `active` (two prior instances + one anticipated)
  - `recommendedTypeChecked` ran clean on first real async code — calibration signal validated
  - 30 tests total across 4 files
- **T-0004** — Remaining shared contracts: audit, ipc, tools (CONFIRMED 2026-05-21; commit 2a516f7)
  - All 11 gate-blocking AC passed; **zero reactive deviations** (first such task)
  - `packages/shared/src/audit.ts` (AuditEntry interface — no trust boundary)
  - `packages/shared/src/ipc.ts` (IpcRequestSchema + IpcResponseSchema as discriminated unions with .strict() per variant; StatusPayloadSchema; trust boundary)
  - `packages/shared/src/tools.ts` (PingInputSchema schema + PingOutput interface)
  - `packages/shared/src/index.ts` extended to re-export all four modules
  - 19 new tests across 2 files (24 total in shared)
  - `packages/shared` feature-complete for P0
  - Carried forward: `daemon_uptime_s` schema tighten + "inert conforming tokens" pattern promotion → T-0005
- **T-0003** — Config schema in @claude-bridge/shared (CONFIRMED 2026-05-21; commit 74b853e)
  - All 13 gate-blocking AC passed; first impl: commit on the project
  - `packages/shared/src/config.ts` (ConfigSchema with .strict() at trust boundary) + index.ts re-export
  - Five-case test suite (happy, defaults, missing required, malformed token, strict rejection)
  - ESLint flat config wired (eslint v10, typescript-eslint v8, recommendedTypeChecked); Q001 CLOSED
  - Vitest defaults sufficient for NodeNext-ESM (no config file needed)
  - Reactive fixes: zod resolved to v4 (works as-spec); `allowDefaultProject` glob narrowed from `**` to `*.test.ts` per typescript-eslint v8 perf rule
  - Patterns `node-esm-imports.md` and `zod-schema-validation.md` promoted draft → active
- **T-0002.5** — Line-ending hygiene + T-0002 closure docs (CONFIRMED 2026-05-21; commit 6490ed7)
  - `.gitattributes` created at repo root; `* text=auto eol=lf` + per-extension explicits + binary list
  - `git add --renormalize .` confirmed index never held CRLF (bug was prospective)
  - Boundary test (re-stage T-0001-era file) produces zero LF/CRLF warning — load-bearing AC passed
  - Three doc edits applied per spec; open-questions.md confirmed no-change needed
  - First task using doc-edit-delta dispatch protocol — worked cleanly
- **T-0002** — Package skeletons (CONFIRMED 2026-05-21; commit e0bf6c9)
  - All 9 gate-blocking AC passed
  - Three workspace packages (`@claude-bridge/{shared,daemon,cli}`) with TS project references
  - Reactive design: empty-input form switched from `include: []` to `files: []` after the former triggered TS18003 — both were valid in the prompt
  - cli references shared only (NOT daemon) — runtime spawn dep ≠ TS project reference; design held
  - npm install: +3 packages (workspace symlinks); audit unchanged at 4 moderate
  - `node-esm-imports.md` stays at `draft`; promotes at T-0003 first-import use
- **T-0001** — Initialize workspace root (CONFIRMED 2026-05-21; commit 9fffba0)
  - All 8 gate-blocking AC passed
  - Files produced: `package.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`
  - Verified: `npm install` clean (126 packages, 4 moderate dev-only advisories below threshold); Node v24.10.0 ≥ v20.10.0 floor
  - Deviations from AC minimum (all reasoned and accepted): `engines` field added; 4 extra `.gitignore` entries (coverage/, *.log, .env*); 4 extra `tsconfig.base.json` options (lib, forceConsistentCasingInFileNames, resolveJsonModule, declaration triplet)
  - Q006 closed inline (vitest ^1.4.0)
  - Standing advisory registered in `conventions.md` §Dev-dependency audit policy
- **Day-zero** — Methodology infrastructure (committed 2026-05-21; commit fff652e)

### Failed / awaiting resolution
(none)

## Completed work manifest

| File | Task | Notes |
|------|------|-------|
| `package.json` | T-0001 | npm workspaces, devDeps pinned, `engines: { node: ">=20.10" }` |
| `tsconfig.base.json` | T-0001 | NodeNext, strict, composite-ready (declaration triplet at base) |
| `.gitignore` | T-0001 | 9 entries (5 required, 4 reasoned additions) |
| `.editorconfig` | T-0001 | utf-8, lf, 2-space TS/JSON/MD |
| `.nvmrc` | T-0001 | `20` |
| `README.md` | T-0001 | Real description + links to design docs |

## Pattern library cross-references

Project-specific patterns in `patterns/project/`. Status as of last conversation:

| Pattern | Status | First-use target | Notes |
|---------|--------|------------------|-------|
| `node-esm-imports.md` | **active** | promoted at T-0003 | Rules exercised in shared's src + tests; build/lint/test clean |
| `zod-schema-validation.md` | **active** | promoted at T-0003 | ConfigSchema implements .strict() at trust boundary; test suite verifies pattern application |
| `constant-time-compare.md` | **active** | promoted at T-0006 | Used by `packages/daemon/src/config/token.ts` `constantTimeEqual` |
| `test-token-fixtures.md` | **active** | created at T-0005 (codifies pattern observed in T-0003 + T-0004) | Inert conforming strings for token-format test fixtures; CC-4 corollary |
| `async-sink-queue.md` | **active** | created at T-0007 (codifies pattern observed in T-0005 logger + T-0007 audit log) | Queue + lazy handle + idempotent close shape; departure point is whether per-call API returns void or flushed Promise |

Promotion from `draft` to `active` happens at orchestrator review after first real use.

## Open issues

See `open-questions.md`.

Recent activity (this conversation):
- **Q001 CLOSED** — ESLint flat config with typescript-eslint v8+ and `recommendedTypeChecked` ruleset; `eslint.config.js` at repo root; `projectService: true` for monorepo discovery (closed at T-0003).
- **Q006 CLOSED** — vitest ^1.4.0 with standing-advisory tracking (decided 2026-05-21).
- **Q001 OPEN** — closure target moved from "T-0001 or T-0002" → T-0003 (no source files to lint until then; adding ESLint to scaffolding-only tasks is busywork).
- Q002, Q003, Q004, Q005 unchanged.

## Calibration findings (rolling)

Findings from completed tasks that inform future task design:

**From T-0001:**
- §3.5.1 report format works well for mechanical config tasks; the structured summary is sufficient evidence and verbatim file content is NOT required for AC verification of config-class files.
- For T-0003+ (source files with meaningful degrees of freedom), verbatim diffs in the report ARE required per §8.2. T-0002 prompt's reporting section will start enforcing this for tsconfig files (config but with meaningful freedom).
- "Executor extends slightly beyond AC minimum, with reasoning" is acceptable when each addition is small, defensive, and explicitly justified in REASONING. Track whether this scales — if it grows, tighten scope statements.
- Dev-dependency audit advisories will surface again on `npm install` and at every dep-adding task. Codified handling in `conventions.md` §Dev-dependency audit policy.

**From T-0002:**
- Anticipatory risk flagging works. The prompt named TS18003 as a known risk with valid alternative forms upfront; executor hit it, used the documented alternative, zero revision rounds. **Pattern for future prompts:** when multiple valid forms exist for a config choice, the prompt names them all rather than picking one — converts a likely revision into one-shot success.
- Verbatim-tsconfig + summarized-package.json reporting cadence works. Continue for source-class config files.
- Executor self-throttled on new pattern candidate (proposed lightweight form, deferred call to orchestrator). Good restraint to preserve.

**From T-0002 closure (post-commit, surfaced during git add):**
- `.editorconfig` without `.gitattributes` is a real cross-platform bug on Windows hosts. T-0001's prompt scope and AC both missed it. Two methodology lessons:
  - When conventions span tool boundaries (editorconfig governs editors; gitattributes governs git), AC for either tool alone is insufficient. Verification must touch the boundary: e.g., "`git add <file>` produces no LF/CRLF warning."
  - CC-2 (cross-platform concerns) extends to line endings, not just paths. Conventions doc updated at T-0002.5.
- Out-of-sequence task numbering: T-0002.5 used. Mid-decimal IDs reserved for "inserted between" semantics; T-NNNN integer IDs stay aligned to build plan sections. No methodology revision needed; this convention is self-explanatory.
- Process refinement: the orchestrator was producing full new doc files each task. Switched to delta instructions in the executor prompt — the executor edits in place, one new file per dispatch (the prompt itself).

**From T-0002.5:**
- Doc-edit-delta dispatch protocol works. Verbatim before/after strings in the prompt made the Edit-tool operations mechanical. Explicit "no edits expected here" sections (AC-7 for open-questions.md) prevent drift-by-omission.
- Watched item, not yet codified: if a doc drifts between prompt-authoring and prompt-execution, an Edit-tool delta would fail on a missing `old_string`. Mitigation that worked: executor reads target files before applying edits. Promote to methodology rule only if this bites us empirically.
- "Prospective vs retroactive" framing for warnings: distinguish between "the bad thing already happened" (retroactive) vs "the bad thing will happen later if you don't intervene" (prospective). T-0002.5's LF/CRLF warnings were prospective. Useful diagnostic frame when interpreting any verification warning.

**From T-0003:**
- Anticipatory risk flagging continues to work. Prompt named zod v3/v4 drift, vitest config sufficiency, and typescript-eslint version sensitivity as likely-failure-modes; two hit (zod v4, typescript-eslint glob), both fixed in one iteration each because the failure modes were named in advance.
- Orchestrator-side error caught by executor: the prompt's eslint.config.js template used the same `**` glob in both `files:` (ESLint matcher, allowed) and `allowDefaultProject:` (parserOption, disallowed). Lesson: when a prompt template includes config shared across tool boundaries, check that the same patterns are valid in every place they appear. Adding to orchestrator checklist for config-heavy prompts.
- Verbatim source-file reporting at the right cadence. Verbatim config.ts, index.ts, config.test.ts, eslint.config.js; summarized everything else. Verification was complete from the report alone; no round-tripping needed.

**From T-0004:**
- First zero-deviation task. Prompts that name design choices explicitly (the schemas-vs-interfaces table) and leave structure flexibility (it.each as suggestion not mandate) produce clean executions when the toolchain is settled.
- `recommendedTypeChecked` lint rules caught nothing for the second consecutive task — expected at the contract layer (no async, no unsafe patterns). Watch signal for T-0005 onward: first async code will be the real test of whether the rule set earns its cost or whether we're paying for unused enforcement.
- Pattern promotion threshold validated: "inert conforming token strings" reached two confirmed instances (T-0003 + T-0004) — promoted to a proper pattern doc at T-0005 (with status `active`, not `draft`, because two instances already exist).

**From T-0005:**
- Two consecutive zero-deviation tasks (T-0004, T-0005). As patterns become active and the toolchain settles, the compounding effect makes well-bounded tasks one-shot.
- `recommendedTypeChecked` validated on first real async code: zero fires, zero noise, queue/catch/void-method discipline all caught preventively. Continue with confidence; watch T-0006 onward for the second affirmative data point.
- Pattern promotion threshold (two confirmed instances) worked for `test-token-fixtures.md` — created at status `active` rather than going through a `draft` phase since the prior use already validated the rule. Methodology's "promotion happens after first confirmed use" generalizes to "creation at `active` is fine when use already precedes the doc."
- Two new pattern candidates flagged: "Async sink queue discipline" (await T-0007's audit log for second instance) and "Temp file lifecycle in tests" (await T-0006/T-0007 for second/third instances; promote to conventions.md note if it recurs).

**From T-0006:**
- First P0 acceptance criterion implemented: AC-9 mode-0600 enforcement lives in `loadConfig`. Implementation verifiable; verification platform-specific (Unix-only). Added to INT-1 blocker list as "verified-on-Unix-CI" pending.
- Three consecutive zero-deviation source tasks (T-0004, T-0005, T-0006). The one reactive deviation in T-0006 was tooling config (ESLint glob), not source.
- `recommendedTypeChecked` second affirmative on real async code (config layer's loadConfig/initConfig). Third data point at T-0007.
- ESLint `allowDefaultProject` glob is a maintenance lever as test-tree structure evolves. Documented as a maintenance pattern in conventions.md to remove the surprise next time it surfaces.

**From T-0007:**
- `recommendedTypeChecked` validated: 4 consecutive zero-fire runs on real async code, including this task's deferred-resolve Promise machinery and IIFE-wrapped setTimeout callbacks. T-0008+ uses the rule set without further evaluation.
- Pattern doc creation from real implementation experience: `async-sink-queue.md` was created at status `active` AND includes an anti-example drawn from a race the executor caught and fixed during T-0007 itself. The methodology working as intended: docs absorb real lessons.
- Reporting cadence calibration: the executor summarized the ~200-line `log.ts` rather than pasting verbatim. Acceptable for T-0007 because REASONING covered the load-bearing choices, but tightening for T-0008: server.ts is safety-relevant (request dispatch, error envelope), so verbatim required.
- Q003 closure validates the "tentative resolution becomes implementation" lifecycle: Q-item opened with tentative resolution → became implementation at T-0007 with no surprises. The Q lifecycle is working.

**Orchestrator self-correction (2026-05-22):**
- The orchestrator was using a fixed date (2026-05-21) on dated entries in project-state, Q-item closures, and pattern docs starting from T-0001 closure onward. The actual current date drifted past 5/21 to 5/22 mid-execution but the dates didn't update — confirmation bias on a value already present in project files.
- **Correction going forward:** every dated entry uses today's actual date as read from the orchestrator's environment context. Existing entries in committed files stay as-is (methodology §22.6 forbids amending pushed commits, and the historical record is part of the audit trail even when wrong by one day).
- Not a methodology defect; an orchestrator-discipline drift. The lesson generalizes: any value the orchestrator can re-read fresh from environment context (date, time, available tools, system state) should be re-read each turn, not anchored to a previously-observed value.

## Handoff notes

T-0007 committed (17b30d4). T-0008 (IPC server; closes Q005) in progress. After T-0008 closes, T-0009 begins MCP server skeleton + HTTP transport (build plan §4.1 first slice). Note: the IPC stop/status path is a prerequisite for AC-2 and AC-7 verification at the acceptance test stage (T-0019).
