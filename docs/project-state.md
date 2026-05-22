# claude-bridge — project state

**Project:** claude-bridge
**Methodology version:** v0.3
**Current phase:** P0 (bus validation)
**Current integration milestone:** INT-1 (first ping roundtrip from Claude.ai project)
**Last conversation date:** 2026-05-21
**Status:** T-0001 CONFIRMED; T-0002 queued for dispatch.

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
- T-0002 — Package skeletons (build plan §1.2)

### Pending (ordered, mapped from `p0-build-plan.md` sections)
- T-0003 — packages/shared deps + Config schema; closes Q001 (linter) (build plan §2.1, §2.2)
- T-0004 — packages/shared remaining contracts: audit, ipc, tools (build plan §2.2)
- T-0005 — packages/daemon logger (build plan §3.2)
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
- **T-0001** — Initialize workspace root (CONFIRMED 2026-05-21)
  - All 8 gate-blocking AC passed
  - Files produced: `package.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`
  - Verified: `npm install` clean (126 packages, 4 moderate dev-only advisories below threshold); Node v24.10.0 ≥ v20.10.0 floor
  - Deviations from AC minimum (all reasoned and accepted): `engines` field added; 4 extra `.gitignore` entries (coverage/, *.log, .env*); 4 extra `tsconfig.base.json` options (lib, forceConsistentCasingInFileNames, resolveJsonModule, declaration triplet)
  - Q006 closed inline (vitest ^1.4.0)
  - Standing advisory registered in `conventions.md` §Dev-dependency audit policy
  - Commit hash: TBD

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
| `node-esm-imports.md` | draft | T-0002 (first per-package config); T-0003 (first source file) | Rules informed T-0001's package.json + tsconfig.base.json choices but were not exercised at import sites |
| `zod-schema-validation.md` | draft | T-0003 (Config schema) | |
| `constant-time-compare.md` | draft | T-0006 (config layer token comparison) or T-0010 (MCP auth) | |

Promotion from `draft` to `active` happens at orchestrator review after first real use.

## Open issues

See `open-questions.md`.

Recent activity (this conversation):
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

## Handoff notes

Day-zero infrastructure committed. T-0001 committed. T-0002 prompt drafted and ready for human gate review. After approval, dispatch to executor (Claude Code), receive report, orchestrator verifies, human gate confirms before commit.

Calibration phase remains in effect: human gate reviews every task before integration (methodology §25.1).
