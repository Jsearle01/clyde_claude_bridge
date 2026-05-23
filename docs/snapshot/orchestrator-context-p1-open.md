# claude-bridge — Orchestrator Context Snapshot (P1 OPEN)

**Date:** 2026-05-23
**Project:** claude-bridge
**Phase:** P1 (Headless delegation) — **DESIGN COMPLETE, READY FOR EXECUTION**
**Prior phase:** P0 (Bus validation) — GATE-CLOSED 2026-05-23
**Next phase:** P2 (VS Code extension) — design doc written after P1 ships
**Methodology:** v0.4 (incorporates P0 empirical refinements over v0.3)
**Conversation role:** Orchestrator (Claude.ai, project chat)
**Counterpart:** Executor is Clyde (Claude Code) in the local repo

---

## P0 summary (carry from P0-close)

22 commits, all 10 ACs VERIFIED, 0 reverts, 0 escalations. The bus works: daemon at `127.0.0.1:7423`, cloudflared tunnel, Bearer auth, audit log, CLI. Cross-platform verified (Windows primary, WSL Ubuntu). 193 tests passing across 26 files. Full detail in `docs/snapshot/orchestrator-context-p0-close.md`.

## P1 status

**Design conversation complete.** This snapshot opens execution.

Produced in the P1 design conversation:

- **`docs/design/02-p1-delegation.md`** — 553 lines. Scope, sequence diagrams, three tool schemas, job lifecycle, workspace addressing stub, mode plumbing, SDK integration contract, transcript persistence, DelegationReport schema, audit log additions, 16 ACs tagged with verification categories, risks, 5 open questions, OAuth deferral explicit.
- **`docs/design/p1-build-plan.md`** — 1029 lines. 14 build phases with file paths, function shapes, verification steps, calibrated effort estimates, AC-to-phase mapping. Methodology applications (acceptance harness early, scope-decision pre-conversation, working-tree-mid-dispatch) called out.

## Scope decisions confirmed (P1 design conversation, 2026-05-23)

Per v0.4 §8.5/§8.6 pre-conversation pattern, three scope decisions resolved before design draft:

1. **OAuth deferred to its own gate.** P1 is Bearer-only. Claude.ai-project-chat connector UI validation is deferred. P1 acceptance uses Bearer-compatible MCP clients (MCP Inspector, Claude Code CLI, Claude Desktop). The daemon's auth layer is designed so OAuth access tokens layer onto the existing Bearer path — Bearer is a degenerate case of the more general scheme. Walkthrough.md UX claims dependent on OAuth get flagged at P1 close.

2. **Mode plumbing depth: both modes through the tool surface, defer custom enforcement to P2.** `read_only` and `agentic` both implemented end-to-end via SDK permission flag mapping. The bash deny-list patterns from `00-overview.md` are passed as SDK configuration. P1 does NOT add a custom enforcement layer that intercepts commands beyond what the SDK does natively. If SDK semantics don't match design intent, escalate to human gate (Q-P1-1).

3. **Workspace addressing: final tool surface, stub registry.** Tools ship with the final `workspace?` argument matching the `{remote_host}/{remote_path}#{folder_name}` ID format. Registry is a single-entry stub backed by a `workspace` block in `config.json`. P2 replaces the stub with the extension-backed multi-entry registry without changing the wire contract.

## P1 acceptance criteria (16 total)

Tagged with verification category per v0.4 §29.4. Full text in `docs/design/02-p1-delegation.md`.

| AC | Brief | Category | Phase |
|----|-------|----------|-------|
| AC-1 | delegate returns within 500ms | MECH | 5 |
| AC-2 | queue position correctness (1st running, 2nd queued) | MECH | 5 |
| AC-3 | poll(wait=0) returns current status + partial | MECH | 5 |
| AC-4 | poll(wait=N) blocks event-driven, no busy-wait | MECH | 5 |
| AC-5 | agentic delegation E2E with real SDK | SMOKE | 11 |
| AC-6 | read_only refuses file writes | SMOKE | 11 |
| AC-7 | cancel queued job → cancelled immediately | MECH | 5 |
| AC-8 | cancel running job → terminal within 15s, SDK gone | MECH | 11 (cross-platform 10/12) |
| AC-9 | AC-5 cross-platform (WSL Ubuntu) | MECH | 12 |
| AC-10 | audit entries include job_id/workspace_id | MECH | 5 |
| AC-11 | transcript file readable as jsonl | MECH | 11 |
| AC-12 | no workspace configured → 503 | MECH | 5 |
| AC-13 | second delegation queues, runs after first | MECH | 5 |
| AC-14 | 24h retention via unit test + architectural review | INFER | 3 |
| AC-15 | input validation (prompt size, max_turns, cwd escape) | MECH | 5 |
| AC-16 | acceptance harness lands in phases 5+11 | (meta) | 5+11 |

## Open questions

| Q-item | State | Resolution venue |
|--------|-------|------------------|
| Q-P1-1 | OPEN | T-P1-Phase9 (SDK permission mode mapping) |
| Q-P1-2 | OPEN | T-P1-Phase9 (transcript message schema stability) |
| Q-P1-3 | OPEN | T-P1-Phase9 (partial progress instrumentation source) |
| Q-P1-4 | RESOLVED at design time | agentic is default per overview |
| Q-P1-5 | OPEN | T-P1-Phase7 (binary file diff handling) |

Q-P1-1 is the largest; resolution at first SDK touch (Phase 9) is the natural moment. Q-P1-2 and Q-P1-3 resolve in the same window. Q-P1-5 resolves at Phase 7 (diff computation).

## Patterns codified during P0 (carried forward)

Project-level (in `docs/patterns/project/`):

| Pattern | Status | Use sites |
|---------|--------|-----------|
| `node-esm-imports.md` | active | Universal |
| `zod-schema-validation.md` | active | Config, IPC, audit, tools, CLI; extends to P1 tools |
| `constant-time-compare.md` | active | Auth |
| `test-token-fixtures.md` | active | Token tests |
| `async-sink-queue.md` | active | Audit log; pattern applies to transcript writer at Phase 6 |
| `line-buffered-stream-reader.md` | active | IPC server, cloudflared stdout; applies to SDK stdout if needed at Phase 9 |
| `safe-narrow-of-unknown-shape.md` | draft | T-0011; revisit promotion at P1 Phase 8 (transcript parsing has shape uncertainty) |

Methodology-level patterns observed in P0:
- Extract on third confirmed use
- Inline-duplicate-with-comment for small cross-platform helpers
- Settle-once gate for socket/timeout/event race resolution
- Verbatim discipline for safety-relevant files
- Smoke-test early, smoke-test often

## Cross-cutting concerns (from `docs/conventions.md`)

- **CC-1: Async error handling** — Promise rejections caught at expected boundary; never silent
- **CC-2: Cross-platform paths and IPC** — `node:path` joins; `~` expansion via helper; OS-specific branches via `process.platform`; LF line endings; collapsePath separator tolerance; Windows detached subprocess discipline (`windowsHide: true`, fire-and-forget redirection for daemon-spawning shell scripts)
- **CC-3: File permissions** — 0600 on config/socket/audit/transcripts; 0700 on config dir; check on read, set on write
- **CC-4: Secret handling** — never log tokens; last-4 suffix in user output; constant-time compare; audit records input_hash not raw input
- **CC-5: Process lifecycle** — SIGTERM/SIGINT handlers; 10s graceful shutdown; PID file write/clean; stale detection; EPIPE handlers for detached subprocesses
- **CC-6: Schema validation at external boundaries** — every external input → Zod schema; no `as` bypass

**P1 additions (for tracking):**
- CC-5 extends to SDK subprocess lifecycle (Phase 9, 10)
- CC-3 covers transcript file permissions (Phase 6)
- Cross-platform termination of SDK subprocess (Phase 10) is a CC-2 application

## Calibration bands (carried from P0)

For prompt prediction at P1 task dispatch:

- **Trivial:** 5-10 min (single-line fixes; verification with stable env)
- **Trivial+setup:** 10-20 min (verification requiring fresh environment install)
- **Small:** 30-60 min (one new module + tests; following established patterns)
- **Medium-consolidation:** 5-15 min (doc tasks consolidating already-known material)
- **Medium-fresh:** 60-120 min (new functionality with discovery component)
- **Large:** 90-180 min or 2h+ (architectural; multiple subsystems; first SDK touch)

**Streak to preserve:** 17 consecutive zero-fire on `recommendedTypeChecked` async-discipline rules. P1 should continue this.

## Methodology applications for P1

Codified in `docs/design/p1-build-plan.md` "Methodology applied" section. The high-impact items:

- **Acceptance harness at Phase 5** (within first third of phases) per v0.4 §9.5. Stub runner brought up in Phase 4 alongside the tool surface, so the harness exercises the MCP path from day one rather than the in-process queue only.
- **Scope-decision pre-conversation** per v0.4 §8.6 at every non-trivial task. Especially before Phase 9 (SDK integration — most discovery).
- **Working-tree-mid-dispatch protocol** per v0.4 §14.7 when dispatching T-(N+1) before T-N verdict.
- **Three forms of verification** per v0.4 §29.4 — AC tags determine ceremony.
- **Steady-state token discipline** per v0.4 §25.4 — paragraph verdicts, doc-edit deltas via find/replace, verbatim only for safety-relevant or non-canonical files.

## Build sequence summary

Per `docs/design/p1-build-plan.md`:

1. Shared types (Workspace, Job, DelegationReport schemas)
2. Workspace registry stub + config extension
3. Job queue + state machine (in-memory)
4. Tool surface (delegate/poll/cancel wired through ToolRegistry, stub runner)
5. **Acceptance harness skeleton** ← early per methodology
6. Transcript writer
7. Workspace snapshot + diff computation
8. Report assembler (against stub-runner-produced transcripts)
9. **SDK integration** (StubJobRunner → SdkJobRunner; resolves Q-P1-1/2/3)
10. Cancellation cross-platform
11. Acceptance harness expansion ([SMOKE] ACs)
12. WSL Ubuntu cross-platform re-run
13. Runbook + walkthrough updates
14. P1 gate close + P1-close snapshot + P2 design doc kickoff

Expected slicing into 14-18 T-P1-NNN tasks. Total Clyde-time ~10-15 hours; calendar ~2-3 weeks at evening pace.

## What's next: open T-P1-001

The first execution task. Bucket: Small. Scope: Phase 1 (shared types).

Suggested opening:

> Open T-P1-001. Phase 1 of p1-build-plan.md — shared types for delegation, workspace, jobs, and config extension. Five sub-files in packages/shared/src/. Pre-conversation: no scope decisions surface; the design doc and build plan have already nailed the schemas. Proceed direct to prompt draft.

Expected timing: ~30-60 min Clyde-time. Form A or Form B report acceptable (per v0.4 §3.5.1).

## Files in /mnt/project/

After committing the P1 design artifacts to the repo, the project knowledge will include:

- `00-overview.md` — architecture, gate sequence, frozen decisions (unchanged)
- `01-p0-bus.md` — P0 design (unchanged)
- `p0-build-plan.md` — P0 build plan (unchanged)
- `walkthrough.md` — steady-state UX (Phase 13 will flag OAuth-deferred sections)
- `claude-orchestrated-methodology-v0_3.md` — methodology v0.3 (carries forward as v0.4's base)
- `claude-orchestrated-methodology-v0_4.md` — methodology v0.4 (delta over v0.3, in effect for P1)
- `orchestrator-context-p0-close.md` — P0-close snapshot
- **`02-p1-delegation.md`** — P1 design doc (NEW)
- **`p1-build-plan.md`** — P1 build plan (NEW)
- **`orchestrator-context-p1-open.md`** — this snapshot (NEW)

## Resume protocol for P1 execution

For the orchestrator instance that opens T-P1-001:

1. Read this snapshot first — it's the entry point for P1 execution context.
2. Cross-reference `docs/design/02-p1-delegation.md` for design specifics when needed.
3. Cross-reference `docs/design/p1-build-plan.md` for per-phase file paths and function shapes.
4. Pull latest `docs/project-state.md`, `docs/milestones.md`, `docs/conventions.md`, `docs/patterns/project/*.md`, `docs/calibration-log.md` from the repo at the start of each working session.
5. Dispatch tasks in build-plan phase order. Slice phases into 1-3 tasks each as scope warrants.
6. Apply v0.4 methodology throughout: scope-decision pre-conversation for non-trivial tasks; acceptance harness early; cross-platform discipline continuous; reactive-fix consultation per §22.5 when uncertain.
7. Maintain calibration log; record each task's predicted-vs-actual at verdict time.
8. Produce intermediate snapshots at natural breaks (>24h pauses, ~75% context, or every ~10 tasks).
9. At P1 close: produce `orchestrator-context-p1-close.md` mirroring this snapshot's structure but pointed forward to P2.

## What carries forward, what does not

**Carries forward from P0:** the entire codebase, all 7 patterns, all 6 cross-cutting concerns, the calibration bands, the methodology (refined to v0.4), the acceptance harness pattern (now scheduled early), the cross-platform discipline, the Bearer auth layer (extends to OAuth later), the audit log shape (extends with job_id/workspace_id), the tool registry, the IPC layer, the CLI shape.

**Does not carry forward from P0:** the assumption that mechanical verification alone is sufficient (SMOKE-2 surfaced this; P1's [SMOKE] ACs reflect the correction). The assumption that the acceptance harness is a closing ceremony (Phase 5 lands it early, just after the Phase 4 tool surface that enables MCP-path exercise). The assumption that all auth is static Bearer (OAuth gate is now scheduled, not just acknowledged).

## End-of-snapshot disposition

P1 design conversation is complete. The next conversation begins T-P1-001 execution. This snapshot is the handoff.

End of P1-open snapshot.
