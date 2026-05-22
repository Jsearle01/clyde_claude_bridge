# claude-bridge — project state

**Project:** claude-bridge
**Methodology version:** v0.3
**Current phase:** P0 (bus validation)
**Current integration milestone:** INT-1 (first ping roundtrip from Claude.ai project)
**Last conversation date:** 2026-05-21
**Status:** T-0004 CONFIRMED; T-0005 in progress (daemon logger — first daemon source).

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
- T-0005 — Daemon logger (build plan §3.2)

### Pending (ordered, mapped from `p0-build-plan.md` sections)
- T-0006 — packages/daemon config layer + token generation; closes Q002 (build plan §3.3)
- T-0007 — packages/daemon audit log; closes Q003 (build plan §3.4)
- T-0008 — packages/daemon IPC server; closes Q005 (build plan §3.5)
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
| `constant-time-compare.md` | draft | T-0006 (config layer token comparison) or T-0010 (MCP auth) | |
| `test-token-fixtures.md` | **active** | created at T-0005 (codifies pattern observed in T-0003 + T-0004) | Inert conforming strings for token-format test fixtures; CC-4 corollary |

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

## Handoff notes

T-0004 committed. T-0005 (daemon logger — first daemon source file) in progress. Carries the `daemon_uptime_s` schema tighten and the `test-token-fixtures.md` pattern promotion bundled in. After T-0005 closes, T-0006 begins config layer (config dir resolution, config file load/init, token generation — closes Q002).
