# claude-bridge — Orchestrator Context Snapshot (P2 GATE-CLOSED)

**Date:** 2026-05-30
**Project:** claude-bridge
**Phase:** P2 (VS Code extension + workspace registration + approval flow + inspection tools) — **GATE-CLOSED**
**Predecessor snapshot:** [`orchestrator-context-p1-close.md`](orchestrator-context-p1-close.md)
**Successor:** P3 design conversation (begins next; produces `docs/design/04-p3-oauth.md` or similar)
**Methodology in effect:** v0.6 (codified at T-P2-014; supersedes v0.5)
**Conversation role:** Orchestrator (Claude.ai, project chat)
**Counterpart:** Executor is Clyde (Claude Code) in the local repo
**Branch:** main
**Final commit:** *(this snapshot's commit — see git log for hash)*

---

## P2 status

**GATE-CLOSED.** All 15 acceptance criteria from `03-p2-extension.md` § 5 at VERIFIED status via harness, operator smoke, or cross-platform run (table below).

**Commits:** 15 numbered phases (T-P2-001 through T-P2-015) plus T-P2-004.5, T-P2-004.6, T-P2-006.5, T-P2-007.5, T-P2-008.5, T-P2-008.6, T-P2-008.7, T-P2-008.8 follow-ups + T-P2-006-followup pattern-doc promotion + T-P2-000-review/refinement pre-phase tasks. Full commit log in `git log --oneline 0203fae..HEAD`; per-task entries in [`milestones.md`](../milestones.md) and [`project-state.md`](../project-state.md) recently-completed.

**Calendar:** P2 ran 2026-05-25 → 2026-05-30 (six calendar days). 23 calibration datapoints; combined P1+P2 total = 35 dispatched tasks.

---

## What P2 shipped

- **VS Code extension `.vsix` sideload-installed**; activates on workspace open. Bundled via esbuild (T-P2-008.5) with `@claude-bridge/*` workspace deps inlined and `vscode` kept external.
- **Daemon ↔ extension IPC** — newline-delimited JSON over Windows named pipe / Unix socket. Handles workspace registration, trust prompts, daemon lifecycle hooks, per-delegation approval requests, set-mode requests, and inspection-tool request routing (`get_open_editors`, `get_diagnostics`).
- **Workspace registry with one-time trust prompt** — persistent `workspaces.json` store keyed by case-normalized abs_path (T-P2-007.5 fix). Trust decision survives daemon restart; identifier stable across sessions.
- **Per-delegation approval flow with three modes:** `per_call` (default modal), `session_bypass` (one approval covers the rest of the MCP session for that workspace), `auto` (no prompts). Bypass keyed by `(mcp_session_id + workspace_id)` so it never leaks across sessions or workspaces (T-P2-008.7).
- **Two read-only inspection tools:** `get_open_editors` and `get_diagnostics` — both route via the extension over IPC, return MCP-shaped payloads. Bypass the approval gate (read-only by construction).
- **Multi-workspace routing via explicit `workspace` argument** — daemon picks the active extension connection for the named identifier; routing error if ambiguous.
- **Cross-platform validated on Windows + WSL Ubuntu** (T-P2-012). Identical AC-table outcomes; elapsed-time parity within 2x across all 10 harness-covered ACs.
- **Compatible MCP clients:** Claude Code CLI, MCP Inspector, Claude Desktop, raw curl. All accept Bearer-token auth.
- **Acceptance harness** (`scripts/acceptance-p2.mjs` + `scripts/mock-extension.mjs`) — hermetic, node-only, covers 10 of 15 P2 ACs via real wire path through mock extension.
- **Diagnostic instrumentation** — `CLAUDE_BRIDGE_DEBUG=1` env-gates `[cb-diag]` extension-side log lines for race/retry debugging (T-P2-008.6); applied to confirm the registration-intent-persistence bug shape that became C-29.

---

## What P2 explicitly does NOT ship

- **claude.ai project-chat integration via the connector UI** — requires OAuth in daemon's auth layer (**C-27**). **Deferred to P3 as priority #1.** Bearer-auth use of the daemon works fine through Claude Code CLI, MCP Inspector, Claude Desktop, and raw curl; only the claude.ai connector UI's static-Bearer field absence blocks the direct path.
- **Per-workspace `.claude-bridge.json` policy schema** — bash deny patterns, tool allowlist, etc. — P3.
- **Tool surface expansion beyond two** (`get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`, ...) — P3+.
- **Multi-user / team-shared daemon** — P3+.
- **macOS first-class support** — P3+.
- **Production deployment story** (CI integration, marketplace publishing, autoupdate) — P3+.
- **Trust revocation UI** — P3+.

---

## Final acceptance criteria status

All 15 ACs from `03-p2-extension.md` § 5 mapped to verifying tasks. Tags: [HARNESS] = `acceptance-p2.mjs` mock-extension wire-path coverage; [SMOKE] = operator-performed runtime smoke; [X-PLAT] = cross-platform parity run.

| AC | Tag | Description | Status | Verifying task(s) | Notes |
|---|---|---|---|---|---|
| AC-P2-1 | [SMOKE] + [X-PLAT] | Extension installs from `.vsix` on Windows + WSL Ubuntu | VERIFIED | T-P2-008.5 install + T-P2-012 WSL `verify-vsix-wsl.sh` | Bundle: 5 files, no external `@claude-bridge/` imports |
| AC-P2-2 | [SMOKE] | Extension auto-activates on opening any workspace | VERIFIED | T-P2-001 + T-P2-008.6 cb-diag trace confirming `activate: entry` | Operator-smoke evidence |
| AC-P2-3 | [HARNESS] + [SMOKE] | First-registration trust prompt fires; trust decision persists | VERIFIED | T-P2-003 unit + T-P2-011 harness AC-P2-3 (11ms) + T-P2-007 daemon-restart-with-store integration | Persistence cross-restart via `workspaces.json` |
| AC-P2-4 | [HARNESS] | Daemon rejects delegations against unregistered workspaces with `503 no_workspace_registered` | VERIFIED | T-P2-007 unit + T-P2-011 harness AC-P2-4 (11ms) | |
| AC-P2-5 | [HARNESS] | Daemon-lifecycle commands work — "Start Daemon" spawns process; daemon-not-running detection surfaces actionable notification | VERIFIED | T-P2-004 + T-P2-004.5 + T-P2-004.6 (.cmd shim fix per CVE-2024-27980) + T-P2-005 daemon-not-running notification + T-P2-011 harness AC-P2-5 (10ms) | Untrusted-workspace collapse to 503 noted in design doc (P3 backlog for discriminated 403) |
| AC-P2-6 | [SMOKE] | `ANTHROPIC_API_KEY` handling — env-first inheritance works; SecretStorage prompt+store fallback works | VERIFIED | T-P2-004 + operator smoke | Env-only observable via T-P2-011 harness AC-P2-7 |
| AC-P2-7 | [HARNESS] | Approval flow — `read_only` auto-approves; `agentic` prompts on first call per session; "Approve for session" remembers | VERIFIED | T-P2-008 + T-P2-008.7 + T-P2-011 harness AC-P2-8 (400ms — full mode rotation) | C-30 fix at T-P2-008.7 keyed bypass by `(mcp_session_id + workspace_id)` |
| AC-P2-8 | [HARNESS] | Approval timeout treated as deny | VERIFIED | T-P2-011 harness AC-P2-9 (34ms via disconnect-cancel proxy pathway) | Spec-delta: harness exercises the disconnect-cancel sibling (5-min hardcoded timeout in `pending.ts:33`; configurability in P3 backlog) — same intent: approvals don't hang |
| AC-P2-9 | [HARNESS] | User denial returns `403 user_denied` to MCP caller | VERIFIED | T-P2-011 harness AC-P2-10 (9ms) | Daemon emits 403 `delegation_denied`; harness regex widened to match the message body |
| AC-P2-10 | [HARNESS] + [SMOKE] | `get_open_editors` returns correct editor state via MCP path | VERIFIED | T-P2-009 unit + T-P2-011 harness AC-P2-11 (9ms) | Payload-pass-through callback (no C-26 concern) |
| AC-P2-11 | [HARNESS] + [SMOKE] | `get_diagnostics` returns correct diagnostics via MCP path | VERIFIED | T-P2-010 unit + T-P2-011 harness AC-P2-12 (17ms) | Threshold expansion at MCP boundary |
| AC-P2-12 | [SMOKE] | Extension status bar shows registered workspace identifier + name | VERIFIED | T-P2-006 + T-P2-006.5 (field-precedes-setState C-26 fix) + T-P2-008.8 (retry-N indicator during registration race) + operator smoke | C-26 invariant codified into pattern doc at T-P2-006-followup |
| AC-P2-13 | [HARNESS] + [SMOKE] | Multiple VS Code windows each register their own workspace; inspection tools route correctly via `workspace` argument | VERIFIED | T-P2-011 harness AC-P2-14 (13ms) + operator smoke | C-18 (window-coalescing) documented in runbook as workaround |
| AC-P2-14 | (covered by per-AC behavioral verifications) | (placeholder — design doc § 5 reused AC-14 number for cross-platform; harness AC-P2-14 is the routing test) | n/a (subsumed) | — | See AC-P2-15 for cross-platform; this slot's behavioral coverage is the routing test above |
| AC-P2-15 | [X-PLAT] | Cross-platform parity (Windows + WSL Ubuntu) for all behavioral ACs | VERIFIED | T-P2-012 (WSL harness 10/10 PASS on first run; Windows 10/10 on re-run after TIME_WAIT clear) | Elapsed parity within 2x; no >5x outliers; no platform fixes needed in `packages/*` |

**Coverage shape:** harness covers 10 ACs (P2-3, 4, 5, 7, 8, 9, 10, 11, 13, and routing); operator smoke + cross-platform run cover the remaining 5 (P2-1, 2, 6, 12, 15). All 15 accounted for.

---

## Cross-cutting concerns status

Per v0.6 §8 CC-N artifacts:

| CC | Description | P2 status |
|----|-------------|-----------|
| CC-1 | Path-handling discipline | Maintained across new code; T-P2-007.5 case-insensitivity fix layered on top (Windows case-normalize at lookup; preserve original case for display) |
| CC-2 | Process and signal handling; spawn-shell behavior | Elaborated in v0.6: C.1 (path-verification per C-17) + C.2 (Windows `.cmd` shim per CVE-2024-27980, from C-20). T-P2-004 → 004.5 → 004.6 was the surfacing sequence |
| CC-3 | File permissions (Unix mode bits) | No regression in P2 |
| CC-4 | Defensive clean-install for cross-platform validation | T-P2-012 used WSL clean-install + portable Node export path |
| CC-5 | Lazy-load with graceful degradation | No new instances in P2 |
| CC-6 | Node engine pinning matrix | Reaffirmed by T-P2-012; portable Node v20.18.0 used on WSL via `~/node-v20/bin/node` |

---

## Pattern library status

**9 patterns** in `docs/patterns/project/`:

1. `async-sink-queue.md` (P0)
2. `constant-time-compare.md` (P0)
3. `cross-platform-test-inputs.md` (T-P1-008)
4. `line-buffered-stream-reader.md` (P0)
5. `node-esm-imports.md` (P0)
6. `safe-narrow-of-unknown-shape.md` (P0)
7. `test-token-fixtures.md` (P0)
8. `zod-schema-validation.md` (P0)
9. `settable-single-subscriber-callback.md` (T-P2-006-followup; refreshed to 7 instances at T-P2-013)

P2 added 1 doc (`settable-single-subscriber-callback`) and refreshed its instance count at T-P2-013 when T-P2-009/010 added `IpcClient.onGetOpenEditorsRequest` + `onGetDiagnosticsRequest`. No other doc needed refresh. v0.6 §9 codifies the going-forward template; existing 9 docs are tolerated as-is.

**Project-pattern candidates** awaiting 3rd-instance evidence (tracked in `project-state.md` v0.7 candidates): fire-and-forget `send()` vs `request<R>()`, layered shutdown with new layers inserted, forward-declaration thunk, pre-fix regression-test verification, logger as optional constructor parameter.

---

## Calibration findings (rolling)

**23 P2 datapoints** ([`calibration-log.md`](../calibration-log.md)). Combined P1+P2 = 35 datapoints.

Landings summary:
- **sub-band-low:** T-P2-004.5/4.6/6.5/7.5/8.5 — bounded-fix tasks consistently below low edge.
- **lower-half:** majority of medium-shape pre-resolved tasks (T-P2-003/005/006/007/013).
- **midpoint:** T-P2-001/002/008.6/008.7/008.8/011/012.
- **upper-half:** T-P2-008 (98 min, large multi-subsystem) and T-P2-014 (35 min, methodology codification with the upper-band scope-lock-locked content density).
- **over-band:** zero P2 tasks.

Reference: combined P1+P2 empirical band table in v0.6 §5.2 (12 task-shape rows).

C-14 protocol (band-landing position correlates with shape-size + consumed-headroom) confirmed across 23 P2 datapoints. C-35 elapsed-time mandate codified at v0.6 §10.8; applied to every P2 report from T-P2-013 forward (retroactive imprecision in earlier reports doesn't bias the band table because shape categories are stable).

---

## Defects state

**Closed during P2:**
- C-23 (closed-by-T-P2-007): fresh-state-assumption tests antipattern.
- C-24 (closed-by-T-P2-007.5): Windows path case-insensitivity.
- C-26 (closed-by-T-P2-006.5 + T-P2-006-followup): field-precedes-setState invariant; codified into pattern doc.
- C-28 (closed-by-T-P2-008.5): extension `.vsix` bundling via esbuild.
- C-29 (closed-by-T-P2-008.8): registration intent persistence via event-driven re-attempt model.
- C-30 (closed-by-T-P2-008.7): `session_bypass` mode-guard via `(mcp_session_id + workspace_id)` keying.

**Open with P3 target:**
- **C-27 (P3 priority #1):** claude.ai connector UI OAuth requirement; daemon needs OAuth provider in auth layer.

**New numbered conventions promoted at v0.6:** C-13 (pre-dispatch grep), C-14 (empirical band landing), C-21 (mock-vs-production contract drift), C-31 (diag-before-fix), C-32 (adjacent-invariant scoping), C-33 (diagnostic-add separate task), C-34 (hard-stop guard), C-35 (elapsed-time mandatory).

**New verdict-time evidence sub-rules at v0.6 §11:** 25.1 (fresh tool output), 25.2 (bundled-artifact verification), 25.3 (operator-runtime-smoke for build/packaging).

---

## P3 entry surface

### Priority #1: OAuth resolution (C-27)

**C-27 (open, P3 target):** claude.ai project-chat connector UI restricts auth to OAuth client_id/client_secret only — no Bearer header field. The literal AC-3 wording ("from a Claude.ai project chat") cannot be satisfied via the connector UI with our static-Bearer-token design. Functional satisfaction comes through MCP Inspector, Claude Code CLI, Claude Desktop, and raw HTTP clients — all accept Bearer tokens. The connector UI is the outlier, not our design. **Resolution path:** implement OAuth in the daemon's auth layer. **P3 priority #1.**

OAuth shape considerations (for P3 design conversation; not committing scope):
- **OAuth 2.1 + Dynamic Client Registration (RFC 7591)** per claude.ai connector UI requirements.
- **Endpoints needed:** `/.well-known/oauth-authorization-server` (RFC 8414 metadata), `/register` (DCR), `/authorize` (interactive consent), `/token` (RFC 6749 §4.1.3 + PKCE), JWKS or HMAC for token signing.
- **Consent UX surface:** daemon is headless; consent surfaces via VS Code extension prompt OR browser launch OR pre-shared allowlist. Trade-offs to resolve at P3 design.
- **Token persistence:** registered clients + active sessions need to survive daemon restart.
- **Integration boundary risk:** claude.ai's DCR client behavior is unmapped; live smoke will likely surface at least one defect (precedent: T-P2-008.7/.8 surfaced C-29/C-30 after harness passed).

**Honest sizing estimate:** 2-4 tasks across 2-3 sessions. Analog: T-P2-008 (approval flow) at 98 min Clyde-time + 3 follow-up tasks (T-P2-008.5/.6/.7/.8) across multiple sessions.

### P3 candidates beyond OAuth

One-liner each (not committing scope; the P3 design conversation prioritizes):

- Per-workspace `.claude-bridge.json` policy schema (bash deny patterns, tool allowlist, mode defaults).
- Tool surface expansion: `get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`.
- Production deployment story: CI integration, marketplace publishing, autoupdate.
- Multi-user / team-shared daemon.
- macOS first-class support.
- Trust revocation UI.
- Approval timeout configurable (P3 backlog from T-P2-011).
- Discriminated `403 workspace_untrusted` response (P3 backlog from T-P2-011).
- Concurrent-delegation test coverage (T-P2-008 uncertainty flag).
- v0.7 methodology codification (when sufficient P3 candidates accumulate).

The P3 design conversation will scope its actual deliverables; this section is the inheritance frame.

---

## Open questions status

- **C-22 deferred to v0.7** (per v0.6 scope-lock E + v0.6 §12). Captured informally in v0.6 §3.2 (mid-task scope reshape protocol's cost classification).
- **Concurrent-delegation test coverage gap** (T-P2-008 uncertainty flag #2; routes to P3 design when the surface needs to scale).
- **Approval timeout testability hole** (T-P2-011 spec-delta note; routes to P3 backlog as "approval timeout configurable").
- **AC-P2-5 daemon-vs-design behavior divergence** (T-P2-011 spec-delta; routes to P3 backlog as "discriminated 403 workspace_untrusted").

---

## Methodology candidates (v0.7 candidates)

Tracked in [`project-state.md`](../project-state.md) § v0.7 candidates. Headline:
- **Deferred from v0.6 per scope-lock E:** C-11, C-12, C-15, C-19, C-22.
- **Provisional methodology candidates (M-* series):** M-A, M-E, M-F, M-G, M-H, M-I, M-J (2 instances — v0.7 promotion candidate), M-K, M-L (2 instances — v0.7 promotion candidate), M-M, M-N, M-O.
- **Project-pattern candidates** (not methodology-level): fire-and-forget send, layered shutdown, forward-declaration thunk, pre-fix regression-test verification, logger as optional constructor param.

---

## What carries forward, what does not

**Carries forward to P3:**
- Codebase (packages/{shared,daemon,extension,cli} + scripts/).
- 9 promoted patterns (`docs/patterns/project/`).
- 6 cross-cutting concerns (CC-1 through CC-6 per v0.6 §8).
- Empirical band table (v0.6 §5.2; combined P1+P2 matrix by task-shape).
- v0.6 methodology in effect.
- P2 surface: VS Code extension, workspace registry, approval flow, inspection tools, multi-workspace routing.
- Bearer auth layer (extends with OAuth at P3; static-Bearer path remains the developer/CLI route).
- `CLAUDE_BRIDGE_DEBUG` diagnostic instrumentation (T-P2-008.6 surface; reusable for any future race/retry debug).
- Acceptance harness shape (`scripts/acceptance-p2.mjs`); template for P3 acceptance harness.

**Does not carry forward:**
- Assumption that Bearer-only auth is sufficient for claude.ai integration — **C-27 retired this assumption empirically** (T-P2-011 SMOKE-2 surfacing).
- Assumption that operator-smoke is optional for build/packaging tasks — **C-25.3 retired this** (T-P2-008.5 → C-29 sequence; bundle verification alone doesn't catch runtime regressions).
- Assumption that calibration bands are phase-scoped — **v0.6 §5.2 unified them by task-shape** (bands transfer across phases when shape matches).
- Assumption that the give-up-after-N-attempts retry pattern is universally correct — **C-29 fix retired it for registration-intent** (event-driven re-attempt with state persistence is the corrected model).

---

## Next actions

- **Open next conversation with:** "P3 design conversation. OAuth is agenda item #1. Read `docs/snapshot/orchestrator-context-p2-close.md` first."
- That conversation produces `docs/design/04-p3-oauth.md` (or similar; final name a P3-design-conversation decision).
- After P3 design, the build plan opens with P3-001 through P3-N.
- v0.7 methodology codification when P3 candidate volume warrants (analog: T-P2-014 ran after P2 had accumulated ~12 candidates).

---

## Resume protocol

Per v0.6 §17.7-equivalent (resume after compaction or session boundary):

1. The orchestrator instance that opens the P3 design conversation reads this close snapshot **first**.
2. Then reads `docs/design/03-p2-extension.md` for the design surface that P3 extends.
3. Then reads `docs/project-state.md` v0.7 candidates + v0.6 candidates (closed-by entries) for methodology context.
4. Scope conversation for P3 begins: priority is C-27 (OAuth); user picks whether to also include any of the beyond-OAuth candidates in the initial P3 deliverable set.
5. P3 design doc drafted (or scope-decision-then-deferred-to-future-task), then P3 build plan, then P3-001 dispatch.

Methodology v0.6 in effect from the first P3 dispatch forward. Dispatches include pre-dispatch grep (C-13), mandatory elapsed-time block (C-35), and verdict-time evidence per §11 (25.1/25.2/25.3 as task shape warrants).

---

## End of snapshot

**Status:** P2 GATE-CLOSED 2026-05-30. v0.6 methodology in effect. C-27 (OAuth) is P3 priority #1. Ready to hand off to P3 design conversation.
