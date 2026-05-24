# claude-bridge — Orchestrator Context Snapshot (P1 GATE-CLOSED)

**Date:** 2026-05-24
**Project:** claude-bridge
**Phase:** P1 (Headless delegation) — **GATE-CLOSED**
**Next phase:** P2 (VS Code extension) — design conversation pending, no kickoff content produced at gate close
**Methodology:** v0.5 (in effect since post-T-P1-012; placed at `docs/claude-orchestrated-methodology-v0_5.md`)
**Conversation role:** Orchestrator (Claude.ai, project chat)
**Counterpart:** Executor is Clyde (Claude Code) in the local repo
**Branch:** main
**Final commit:** *(this snapshot's commit — see git log for hash)*

---

## P1 status

**GATE-CLOSED.** All 16 acceptance criteria from `02-p1-delegation.md` at MECH-VERIFIED, MCP-VERIFIED, or INFER-VERIFIED status (table below).

**Commits:** 16 (T-P1-001 through T-P1-014 plus T-P1-001.5 and T-P1-001.6 inserts, plus the T-P1-009 reshape revert).

**Calendar:** P1 ran 2026-05-23 → 2026-05-24 (one calendar day). Active Clyde-time across all 14 tasks ≈ 2:30 cumulative.

## Phase summary table

| Task | Phase | Status | Commit | Description |
|---|---|---|---|---|
| T-P1-001 | 1 — Shared types | COMPLETE | (bundled in 292b837) | DelegateInput/DelegateOutput/PollInput/PollOutput/CancelInput/CancelOutput + Job/JobRunState/JobView + DelegationReport + ErrorDetail + PartialProgress + WorkspaceConfig schemas |
| T-P1-001.5 | Infra insert | COMPLETE | 292b837 | P1 design doc handoff; github.com remote; bundled T-P1-001 source |
| T-P1-001.6 | Infra insert | COMPLETE | c821ebd | README factual correction; gh CLI install + auth; AC-6 visibility=PUBLIC mechanically verified |
| T-P1-002 | 2 — Workspace registry stub | COMPLETE | 1b534c0 | StubWorkspaceRegistry + WorkspaceConfig validation + config wiring |
| T-P1-003 | 3 — Job queue + state machine | COMPLETE | b556871 | JobQueue with terminal-promise + retention sweep + DailyTimer extraction from T-0007 AuditLog. See [retroactive-notes.md](retroactive-notes.md) for shutdown-layer coverage gap surfaced at T-P1-005. |
| T-P1-004 | 4 — Tool surface | COMPLETE | ffb3316 | delegate/poll/cancel handlers + ToolHandlerError typed errors + audit-metadata side-channel + StubJobRunner |
| T-P1-005 | 5 — Acceptance harness skeleton | COMPLETE | d10f608 | scripts/acceptance-p1.mjs StubJobRunner-via-MCP harness; 9 [MECH] ACs; first harness run found 3 real bugs immediately fixed |
| T-P1-006 | 6 — Transcript writer | COMPLETE | 92b8348 | TranscriptWriter JSONL stream + 50MB cap + orphan handling at startup |
| T-P1-007 | 7 — Snapshot + diff | COMPLETE | 2ab9d05 | takeSnapshot (git ls-files + ignore-package fallback + binary detect + sha256) + computeDiff (git path + diff-package fallback) |
| T-P1-008 | 8 — Report assembler | COMPLETE | 2541fbf | assembleReport + parseTranscript fail-soft + 4-tier truncation precedence + cross-platform-test-inputs pattern doc |
| T-P1-009 | 9 — SDK integration | COMPLETE | 12120e4 + d6bcdc1 reshape | SdkJobRunner via @anthropic-ai/claude-agent-sdk + AbortController cancellation + report.ts SDK-shape update; 32KB prompt cap added then reverted via reshape |
| T-P1-010 | 10 — Cancellation cross-platform + live SMOKE | COMPLETE | 018829a | Windows + WSL Ubuntu 5/5 SMOKE PASS via direct unit tests; reactive READ_ONLY_DISALLOWED_TOOLS hardening for ExitPlanMode flip |
| T-P1-011 | 11 — Acceptance harness MCP-path SMOKE | COMPLETE | 15bf359 | acceptance-p1-smoke.mjs + harness-common.mjs lib extraction (~190 lines); Windows 3/3 PASS for AC-5/6/8 via wire; harness brittleness fix (unwrapOrThrow) |
| T-P1-012 | 12 — WSL cross-platform run | COMPLETE | f1eae52 | WSL Ubuntu both harnesses PASS; two platform fixes (Linux cloudflared branch in ensureCloudflaredOnPath, lazy undici load) |
| T-P1-013 | 13 — Runbook + walkthrough | COMPLETE | 3e5b8f0 | runbook +301 lines; walkthrough +189 lines P1 narrative |
| T-P1-014 | 14 — Gate close + doc-debt sweep | COMPLETE | *(this commit)* | 11-item doc-debt sweep across design docs + code comments + retroactive notes + v0.5 methodology tracked + this snapshot |

## Final acceptance criteria status

All 16 ACs from `02-p1-delegation.md` mapped to verifying tasks. Tags per v0.4 §29.4: [MECH] = mechanical verification via unit/integration test; [SMOKE] = live exercise against real SDK/API; [INFER] = derivable from unit test + architectural review.

| AC | Tag | Description | Status | Verifying task(s) | Platforms | Notes |
|---|---|---|---|---|---|---|
| AC-1 | [MECH] | delegate returns valid shape within 500ms | MECH-VERIFIED | T-P1-005 | Windows + WSL | T-P1-012 measured 56ms on both platforms |
| AC-2 | [MECH] | queued_position FIFO semantic | MECH-VERIFIED | T-P1-005 | Windows + WSL | AC-2 text updated at T-P1-014 to match impl semantic (per doc-debt item 1) |
| AC-3 | [MECH] | poll non-blocking when wait_ms=0 | MECH-VERIFIED | T-P1-005 | Windows + WSL | 6-10ms typical |
| AC-4 | [MECH] | long-poll resolves event-driven on terminal | MECH-VERIFIED | T-P1-005 | Windows + WSL | 1513ms with stub delay 1500ms (well before 6000ms wait cap) |
| AC-5 | [SMOKE] | agentic happy path end-to-end | MECH-VERIFIED + MCP-VERIFIED | T-P1-009 unit / T-P1-010 cross-platform unit / T-P1-011 MCP-wire / T-P1-012 WSL MCP | Windows + WSL | 9-13s typical |
| AC-6 | [SMOKE] | read_only refusal semantics | MECH-VERIFIED + MCP-VERIFIED | T-P1-009 unit / T-P1-010 cross-platform unit / T-P1-011 MCP-wire / T-P1-012 WSL MCP | Windows + WSL | Hardened at T-P1-010 with READ_ONLY_DISALLOWED_TOOLS; AC-6 design wording extended at T-P1-014 (item 7) to document the belt-and-suspenders rationale |
| AC-7 | [MECH] | cancel queued → cancelled immediately | MECH-VERIFIED | T-P1-005 | Windows + WSL | StubJobRunner harness |
| AC-8 | [MECH] | cancel running → terminal within 15s | MECH-VERIFIED + MCP-VERIFIED | T-P1-009 unit / T-P1-010 cross-platform unit / T-P1-011 MCP-wire / T-P1-012 WSL MCP | Windows + WSL | Windows 2.2s, WSL 1.4s typical — well under budget |
| AC-9 | [MECH] | Cross-platform AC-5 on Windows + WSL | MECH-VERIFIED | T-P1-010 + T-P1-012 | Windows + WSL | Both unit and MCP-wire paths verified on both platforms |
| AC-10 | [MECH] | audit entries carry job_id + workspace_id | MECH-VERIFIED | T-P1-004 unit / T-P1-005 harness AC-10 | Windows + WSL | 21/27 delegation entries in harness run |
| AC-11 | [MECH] | transcript is well-formed JSONL + readable | MECH-VERIFIED | T-P1-006 unit / T-P1-009 SMOKE | Windows + WSL | T-P1-009 smoke #1 verified transcript readable post-daemon-stop |
| AC-12 | [MECH] | no-workspace → 503 no_workspace_configured | MECH-VERIFIED | T-P1-004 unit / T-P1-005 harness AC-12 | Windows + WSL | ping still works in this state |
| AC-13 | [MECH] | second delegate queues; auto-runs after first | MECH-VERIFIED | T-P1-005 harness AC-13 | Windows + WSL | A→complete, B transitions automatically |
| AC-14 | [INFER] | 24h retention via fake-clock | INFER-VERIFIED | T-P1-003 unit + architectural review | n/a | DailyTimer + JobQueue retention sweep unit-tested with fake clock |
| AC-15 | [MECH] | input validation (empty prompt, max_turns, working_directory) | MECH-VERIFIED | T-P1-004 unit / T-P1-005 harness AC-15 | Windows + WSL | "32KB cap" case included for visibility but expected to NOT reject (no cap in P1 by design per T-P1-009 reshape) |
| AC-16 | [SMOKE] | acceptance harness reproducible | MECH-VERIFIED | T-P1-005 + T-P1-011 | Windows + WSL | Two harnesses: StubJobRunner (acceptance-p1.{ps1,sh}) and SdkJobRunner (acceptance-p1-smoke.{ps1,sh}) |

## Performance datapoint (per doc-debt item 9)

**claude-bridge's overhead is negligible relative to SDK inference latency.** T-P1-011 measured AC-5 at 10.2s via MCP vs 10.1s unit-direct (within noise); AC-6 at 37.8s via MCP vs 37.5s unit-direct. The MCP wire is essentially free overhead. User-visible delegation latency is dominated by Anthropic API inference, independent of claude-bridge infrastructure. Conclusion: optimizing the daemon for delegation-path latency would have no user-visible effect; design effort should target the inference-bound surfaces (prompt size, max_turns, model selection) rather than the bus.

## Calibration summary

14 P1 datapoints. Dual-band reporting in effect from T-P1-004 onward (v0.5 §5.1 standardized at T-P1-013).

| Task | Empirical | Actual | Variance vs empirical mid | Landing |
|---|---|---|---|---|
| T-P1-001 | (legacy Small 30-60) | 0:07 | n/a | sub-band |
| T-P1-001.5 | (legacy Small 30-60) | 0:05 | n/a | sub-band |
| T-P1-001.6 | (legacy Small 30-60) | 0:06 | n/a | sub-band |
| T-P1-002 | (legacy Small 30-60) | 0:06 | n/a | sub-band |
| T-P1-003 | Medium-fresh 60-120 | 0:14 | n/a | sub-band |
| T-P1-004 | empirical 15-25 / legacy Small-medium 30-90 | 0:17 | mid | **in band (mid)** |
| T-P1-005 | empirical 25-45 / legacy Medium-fresh 60-120 | 0:16 | -54% vs mid | just-below band |
| T-P1-006 | empirical 15-25 / legacy Small 30-60 | 0:08 | -60% vs mid | sub-band |
| T-P1-007 | empirical 25-40 / legacy Medium-fresh 60-120 | 0:08 | -75% vs mid | sub-band |
| T-P1-008 | empirical 10-20 / legacy Small-medium 60-90 | 0:06 | -60% vs mid | sub-band |
| T-P1-009 | empirical 30-50 / legacy Large 90-180 | 0:18 + 0:05 reshape | -43% vs mid | sub-band (with reshape) |
| T-P1-010 | empirical 25-45 / legacy Medium-fresh 60-120 | 0:24 | -31% vs mid | **in band (low-mid)** |
| T-P1-011 | empirical 20-30 / legacy Medium-fresh 60-120 | 0:30 | +20% vs mid | **in band (high edge)** |
| T-P1-012 | empirical 15-25 / legacy Trivial+setup 10-25 | 0:20 | 0% vs mid | **in band (mid)** |
| T-P1-013 | empirical 15-25 / legacy Small 30-60 | 0:20 | 0% vs mid | **in band (mid)** |
| T-P1-014 | empirical 15-25 / legacy Medium-mature 30-90 | *(see calibration log)* | *(see)* | *(see)* |

**Key findings (per v0.5 §5.2 empirical-band table refinement):**

1. **10 sub-band landings out of 14.** Empirical bands derived from P0's legacy bucket framework systematically overestimate scope-pre-resolved + cached-context work. v0.5 §5.2 codifies the refined bands.
2. **4 in-band landings** all clustered around live-runtime or genuine-discovery tasks (T-P1-004, T-P1-010, T-P1-011, T-P1-012, T-P1-013). The pattern: tasks with real wall-clock work (SDK calls, cross-platform validation, doc production) land in band; tasks with only typing-speed-bounded work land sub-band.
3. **Dual-band reporting effectiveness.** Standardized from T-P1-004; mandatory in v0.5 §5.1. The "compute variance arithmetically" discipline (v0.5 §5.3) caught the orchestrator's narrative-fitting tendency on multiple verdicts.
4. **Live-runtime upper-band headroom.** T-P1-010 reactive read_only fix took ~5 min of the 24-min total; T-P1-011 reactive harness brittleness fix took ~7 min of the 30-min total. v0.5 §5.2 explicitly accounts for this: "Live-runtime tasks consume 5-10 min of upper-band headroom when defects surface."
5. **Pure-doc tasks compress legacy bands by 50-67%.** T-P1-013 landed at empirical 20 (mid) but legacy-mid 45 → -56% below midpoint. Legacy bands need a "doc-extension" sub-bucket distinct from "design-from-scratch" doc work. v0.6 candidate (per v0.5 §10).
6. **Bands-converging signal at T-P1-012.** First task where empirical and legacy bands largely overlap (15-25 vs 10-25); landing in the overlap. The empirical adjustment is specifically for scope-pre-resolved + cached-context work; pure-execution tasks have no such effect to compress.

## Pattern inventory

**Promoted (8 patterns total in `docs/patterns/project/`):**

| Pattern | Status | First use | Brief description |
|---|---|---|---|
| `node-esm-imports.md` | active | T-0003 | NodeNext + `.js` import extensions for ESM |
| `zod-schema-validation.md` | active | T-0003 | `.strict()` at trust boundaries; type derivation via `z.infer` |
| `constant-time-compare.md` | active | T-0006 | Token compare resistant to timing side-channels |
| `test-token-fixtures.md` | active | T-0005 | Inert conforming token strings for tests |
| `async-sink-queue.md` | active | T-0007 | Queue + lazy handle + idempotent close shape |
| `line-buffered-stream-reader.md` | active | T-0012 | Accumulate-and-split stdout parsing |
| `safe-narrow-of-unknown-shape.md` | draft | T-0011 | unknown+typeof workaround for Array.isArray narrowing under recommendedTypeChecked |
| `cross-platform-test-inputs.md` | active | T-P1-008 | Use `path.join` for test inputs to keep cross-platform fidelity |

**Pending candidates (single-use; await second/third instance per v0.5 §3.3 promotion rule):**

- `unwrapOrThrow` harness pattern (1 use at T-P1-011; strong candidate — directly applicable to any future MCP-client harness).
- `requireCli(name)` helper (1 use; CLI gating — would earn if more "check that X is installed" runbook items grow).
- `lazy-load-with-graceful-degradation` (1 use at T-P1-012 for undici — natural candidate if other optional deps surface).
- `docs-vs-runtime verification` (3 instances at T-P1-008/009/010 — codified in v0.5 §6 as methodology pattern rather than code pattern).
- `harness brittleness defense / unwrap-or-throw` (codified in v0.5 §7).
- `mechanical-replacement refactor of harness code` (1 use at T-P1-011; safe-to-bundle pattern when re-run is cheap — note in calibration log; not promoted yet).

## Methodology version in effect

**v0.5** — at `docs/claude-orchestrated-methodology-v0_5.md`. Tracked in git as of T-P1-014 (per doc-debt item 11).

Key v0.5 additions over v0.4:
- §3.5 Form B with mandatory "User interaction during task" section.
- §5.1 dual-band reporting standard.
- §5.3 explicit variance arithmetic in verdicts.
- §6 docs-describe-happy-path-runtime-reveals-edges pattern.
- §7 harness brittleness defense (unwrap-or-throw).
- §8 CC-4 (defensive clean install), CC-5 (lazy-load graceful degradation), CC-6 (Node engine pinning matrix).
- §9 pattern doc template normalization (deferred actual normalization to v0.6).
- §10 open v0.6 candidates.

## Test surface (final at P1 close)

| Workspace | Pass | Skip (rationale) | Total |
|---|---|---|---|
| `@claude-bridge/shared` | (per latest run) | 0 | (per latest run) |
| `@claude-bridge/daemon` | **280** | **13** (5 SMOKE without ANTHROPIC_API_KEY + 8 platform-skip for Unix-only file-mode/symlink) | **293** |
| `@claude-bridge/cli` | (per latest run) | (per latest run) | (per latest run) |

The 5 SDK SMOKE tests in `tests/jobs/sdk-runner.test.ts` skip without `ANTHROPIC_API_KEY`. When run with the key (T-P1-010): 5/5 PASS on Windows and WSL. The 8 platform-skip tests cover Unix-only file-mode assertions and symlink behavior.

Lint clean across all 3 workspaces. Build clean across all 3 workspaces.

## Cross-platform evidence

**Windows + WSL Ubuntu validated end-to-end on both code-direct and MCP-wire paths.**

- **Unit-direct SMOKE (T-P1-010):** 5/5 PASS on Windows (80.78s); 5/5 PASS on WSL (67.20s).
- **MCP-wire SMOKE (T-P1-012):** 3/3 PASS on Windows (T-P1-011) and on WSL Ubuntu (T-P1-012).
- **StubJobRunner-via-MCP (T-P1-005 + T-P1-012):** 9/9 PASS on both platforms.

**Per-platform behavioral semantics are identical.** Per-task elapsed varies (model nondeterminism on read_only delegations produced 37.8s on Windows vs 6.7s on WSL — both within the semantic contract). Cancel-to-terminal latency comparable (Windows 2.2s, WSL 1.4s; both well under the 15s budget).

**Platform-specific code points:**
- `ensureCloudflaredOnPath` (in `scripts/lib/harness-common.mjs`): Windows path + Linux/darwin paths.
- `mcp-delegate-client.mjs` lazy undici load: needed on hosts with Node < 22.19 (e.g., WSL user-local Node 20.18). CC-5 codified.
- Daemon's `loadConfig` mode-0600 check: Unix-only by design (CC-3 inherited from P0).

**Untested:** native Linux (non-WSL) and macOS. Should work given POSIX paths + cross-platform discipline; documented in runbook as "untested but should work; please report results." macOS Apple-Silicon Homebrew cloudflared path (`/opt/homebrew/bin/cloudflared`) is a known deferred follow-up.

## Open items deferred to P2

These items surfaced during P1 but were intentionally not resolved:

1. **Bash deny pattern tightening** — P1 hardcoded list from `00-overview.md`. P2 will layer per-workspace `.claude-bridge.json` overrides.
2. **Cancellation streaming-input revisit** — T-P1-009 used AbortController (correct for non-streaming). If P2/P3 adds streaming input/output via `query.interrupt()`, revisit.
3. **macOS cloudflared path** — `ensureCloudflaredOnPath` doesn't yet probe `/opt/homebrew/bin/cloudflared`. Runbook documents the symlink workaround. Add probe when a macOS-host task lands.
4. **Unit test for `ensureCloudflaredOnPath` Linux branch** — currently exercised end-to-end at T-P1-012 but not unit-isolated. P2 candidate.
5. **Per-workspace `.claude-bridge.json` policy** — P2 design.
6. **OAuth** — Claude.ai connector UI requires OAuth-style credentials. Static Bearer tokens work via MCP Inspector, Claude Code CLI, Claude Desktop. May land between P1 and P2 or be absorbed into P2.
7. **VS Code extension** — full P2 design (workspace registration, status bar, webview, toast approvals).
8. **Tier-2 inspection tools** — `list_workspace`, `read_file`, `get_git_status`, `get_git_diff`, `get_diagnostics`, `search_workspace`, `get_open_editors`. All P2.
9. **Persistent job state** — daemon crash loses in-memory `JobRunState`. P3 candidate.
10. **Multi-concurrent runner** — single-concurrent is the P1 constraint. P3 if real demand.
11. **Streaming responses** — P1 is poll-only. SSE streaming via MCP is a P4 stretch.
12. **Named persistent tunnels** — cloudflared URL changes on restart. P3.
13. **Pattern doc template normalization** — 8 existing patterns use slightly different templates. v0.5 §9 codifies the new template; retroactive normalization is P2 candidate.

## Next-phase pointers

**P2 design conversation starts post-gate.** This snapshot does not produce P2 kickoff content (no `docs/design/03-p2-extension.md` skeleton, no P2 Q-items). Per the dispatch's explicit out-of-scope list, P2 design happens in a separate post-gate phase.

**For the P2 design conversation:**

1. Read this snapshot, the P0-close snapshot, and `docs/walkthrough.md`'s "P1 — Delegation surface" section.
2. Re-read `docs/design/00-overview.md` for the P2 scope outline.
3. Review the P2 deferral list above; convert to P2 ACs as appropriate.
4. Decide OAuth direction (still open from P0 SMOKE-2).
5. Decide VS Code extension architecture: pure-WebSocket-to-daemon vs RPC-via-extension-host vs hybrid.
6. Produce `docs/design/03-p2-extension.md` and `docs/design/p2-build-plan.md`.
7. Carry methodology v0.5 forward.

**Recommended carry-forward methodology adjustments for P2:**

- Continue dual-band reporting; the empirical bands will need fresh datapoints as the project shape changes (VS Code extension is a different cost profile than headless delegation).
- Watch for `unwrapOrThrow`, `requireCli`, and `lazy-load-with-graceful-degradation` to earn promotion via third use.
- v0.6 work (per v0.5 §10) starts after P2 evidence accumulates.

## Files in `docs/`

- `design/00-overview.md` — architecture, gate sequence, frozen decisions (T-P1-014 updated: SDK package name)
- `design/01-p0-bus.md` — P0 design + 10 ACs (unchanged in P1)
- `design/02-p1-delegation.md` — P1 design + 16 ACs (T-P1-014 updated: AC-2 text, "32KB" phrase removed, DiffResult opaque-text contract added, ExitPlanMode/READ_ONLY_DISALLOWED_TOOLS paragraph added, wait_ms cap clarification, snapshot caps + binary detection, package rename)
- `design/p0-build-plan.md` — P0 concrete task plan (unchanged in P1)
- `design/p1-build-plan.md` — P1 concrete task plan (T-P1-014 updated: SDK package name)
- `runbook.md` — operator reference (T-P1-013 extended; T-0020 P0 base preserved)
- `walkthrough.md` — UX narrative + P1 delegation surface (T-P1-013 extended)
- `milestones.md` — phase + AC tracking
- `project-state.md` — task queue + calibration findings
- `calibration-log.md` — dual-band actuals per task
- `conventions.md` — cross-cutting concerns (CC-1 through CC-6 referenced in v0.5)
- `claude-orchestrated-methodology-v0.3.md` / `_v0_4.md` / `_v0_5.md` — methodology evolution; v0.5 in effect
- `snapshot/orchestrator-context-p0-close.md` — P0 gate-close snapshot
- `snapshot/orchestrator-context-p1-open.md` — P1 open snapshot (early P1 context)
- **`snapshot/orchestrator-context-p1-close.md`** — this snapshot (final P1)
- `snapshot/retroactive-notes.md` — post-hoc verdict annotations (T-P1-003 entry added at T-P1-014)
- `patterns/project/*.md` — 8 promoted patterns (1 draft, 7 active)

## What to celebrate

P1 is done. 16 commits (T-P1-001 through T-P1-014 + 2 inserts + 1 reshape revert), 0 unrecoverable reverts, 0 forced rollbacks, 0 quality regressions. The methodology held across the entire gate; v0.5 emerged from the experience as a refined replacement. The delegation surface works end-to-end on Windows and WSL Ubuntu, validated through 9 mechanical ACs + 3 SMOKE ACs via both unit-direct and MCP-wire paths.

The bus from P0 carries delegations cleanly. The job queue, snapshot pipeline, transcript writer, report assembler, SDK runner, deny enforcement, and cancellation all compose into a coherent surface that an MCP client can drive end-to-end. P2's VS Code extension layers on top of this without disturbing what works.

End of P1-close snapshot.
