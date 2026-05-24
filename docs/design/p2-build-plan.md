# P2 Build Plan

**Phase:** P2
**Status:** Draft — pending Clyde review and user final approval
**Predecessor:** `docs/design/p1-build-plan.md` (14 phases, gate-closed)
**Methodology in effect:** v0.5

This document is the per-task breakdown of P2. Each task is a numbered phase. The design rationale for each phase is in `docs/design/03-p2-extension.md`.

P2 has 15 phases (vs P1's 14) — the additional phase is **T-P2-14 (Methodology v0.6 creation)**, a deliberate slot for codifying methodology refinements that surface during P2. P1 produced v0.5 opportunistically; P2 schedules it.

---

## Phase summary

| # | Task | Phase | Description |
|---|---|---|---|
| 1 | T-P2-001 | Extension scaffolding | Monorepo extension package; minimal activation; palette hello-world |
| 2 | T-P2-002 | IPC client + protocol | Extension connects to daemon's existing IPC; versioned hello/registration message format |
| 3 | T-P2-003 | Workspace registration | Register on activate; first-registration trust prompt (Q7); deregister on deactivate |
| 4 | T-P2-004 | Daemon-lifecycle commands | "Start Daemon" palette command; auto-detect binary path; SecretStorage API key |
| 5 | T-P2-005 | Daemon-not-running detection | Surface actionable notification when IPC fails; "start daemon" action button |
| 6 | T-P2-006 | Status bar surface | Display workspace identifier + name; click for full details |
| 7 | T-P2-007 | Workspace registry replacement | Daemon-side: replace P1 stub with real registration-backed registry; reject unregistered workspaces |
| 8 | T-P2-008 | Approval flow scaffolding | Daemon pauses delegation; extension surfaces approval UI; session-grant semantics (Q6) |
| 9 | T-P2-009 | `get_open_editors` tool | Daemon proxies; extension serves from `vscode.window.tabGroups` |
| 10 | T-P2-010 | `get_diagnostics` tool | Daemon proxies; extension serves from `vscode.languages.getDiagnostics()` |
| 11 | T-P2-011 | Acceptance harness for extension path | End-to-end test of registration, delegation with approval, inspection tools |
| 12 | T-P2-012 | Cross-platform validation | Windows + WSL Ubuntu; `.vsix` install verified on both |
| 13 | T-P2-013 | Runbook + walkthrough updates | Extension install instructions; P2 walkthrough narrative |
| 14 | T-P2-014 | Methodology v0.6 creation | Codify P2-surfaced methodology candidates; refresh empirical bands |
| 15 | T-P2-015 | P2 gate close + close snapshot | Doc-debt sweep; P2-close snapshot; clean handoff for P3 |

Estimated total: ~12-14 hours at P1 cadence.

---

## How P2 differs from P1 (process)

Three process changes worth being explicit about:

**1. Running v0.6 candidate list in `project-state.md`.** Each task's verdict appends to a `v0_6_candidates` field if anything methodology-relevant surfaces. T-P2-014 reads from this list as its scope, rather than reconstructing from 13 prior verdicts at task time.

**2. Methodology v0.5 in effect from day one.** Every dispatch follows v0.5 conventions: dual-band reporting, mandatory "User interaction during task" section, explicit variance arithmetic in verdicts, CC-4/5/6 cross-platform discipline, docs-vs-runtime pattern recognition. No transition cost; methodology is settled going in.

**3. Extension introduces a new package boundary.** Code lives under `extension/` (or `packages/extension/` if we mirror the monorepo style; T-P2-001 makes the call). VS Code-specific code stays out of `packages/daemon/` and `packages/shared/`. Cross-package dependencies follow the existing monorepo conventions.

---

## Per-phase detail

### Phase 1 — T-P2-001: Extension scaffolding

**Goal:** Empty-but-installable VS Code extension. No daemon interaction yet. Verifies the install path works.

**Deliverables:**
- New package directory (`packages/extension/` or `extension/`).
- `package.json` with VS Code engine pin, activation events, command contribution, build scripts.
- `tsconfig.json` matching monorepo TypeScript conventions.
- `src/extension.ts` with `activate()` and `deactivate()` exports.
- One palette command: `Claude Bridge: Show Status` that opens a notification reading "Claude Bridge extension active. Workspace: <abs_path>. Daemon: not yet connected (Phase 2)."
- `.vsix` build script.

**ACs:**
- `npm run build` produces a `.vsix` file.
- `code --install-extension <vsix>` succeeds on Windows + WSL.
- Activation fires on `onStartupFinished`.
- Palette command shows the expected notification.
- Lint clean; async-discipline streak preserved.

**Patterns:** Cross-platform-test-inputs; node-esm-imports; TypeScript strict mode matching daemon's config.

**Empirical prediction:** 10-15 min (scaffolding from VS Code template; nothing novel).

---

### Phase 2 — T-P2-002: IPC client + protocol

**Goal:** Extension talks to daemon over IPC. Versioned hello/registration message exchange.

**Deliverables:**
- IPC client module in extension that connects to daemon's existing socket/pipe.
- Shared protocol types in `packages/shared/src/extension-ipc.ts` (or similar).
- Hello message: `{type: "hello", version: "1.0", role: "extension", pid: number}`.
- Daemon-side: handle hello messages (extension client identity); P0's CLI hello is unaffected (different role).
- Reconnection logic in extension: detect disconnection, attempt reconnection with exponential backoff (max 30s between attempts).
- Status command in extension showing IPC connection state.

**ACs:**
- Extension connects to running daemon.
- Hello exchange completes; daemon recognizes extension role.
- Disconnect handling: extension detects daemon stop; reconnects when daemon restarts.
- Existing P0 CLI IPC continues to work without regression.
- Lint clean; async-discipline streak preserved.

**Patterns:** Typed-error-family for IPC errors; idempotent-close-via-cached-promise carry-over.

**Empirical prediction:** 15-20 min (real protocol design + daemon-side handler + extension client + reconnection logic).

---

### Phase 3 — T-P2-003: Workspace registration

**Goal:** Extension registers workspace with daemon on activate; deregisters on deactivate. First-registration trust prompt (Q7).

**Deliverables:**
- Registration message: `{type: "register_workspace", abs_path: string, name: string, ipc_endpoint: string}`.
- Daemon-side: receive registration, generate workspace identifier (slug + 6-char suffix per Q5), store metadata, route trust prompt if path is new.
- Trust prompt routing: daemon → extension via IPC; extension surfaces modal; response routes back.
- Trust store on daemon: file-backed (probably `~/.claude-bridge/workspace-trust.json`); records `abs_path → {trusted_at, name}`.
- Deregistration: extension sends `{type: "deregister_workspace", identifier}` on deactivate; daemon removes from active registry but preserves trust store.

**ACs:**
- First registration of a workspace fires trust prompt.
- Trust approval persists; second registration skips prompt.
- Trust denial rejects registration; status bar shows error.
- Deregistration removes from active registry; trust persists.
- Daemon-side trust store survives daemon restart.

**Patterns:** Audit-jsonl-tier-aging may inspire trust store file format; cross-platform-test-inputs.

**Empirical prediction:** 20-30 min (real registration flow + trust store + modal UI + IPC routing).

---

### Phase 4 — T-P2-004: Daemon-lifecycle commands

**Goal:** Extension can start the daemon. Handles binary path resolution and API key.

**Deliverables:**
- "Claude Bridge: Start Daemon" palette command.
- Binary path resolution: check PATH, check `node_modules/.bin/claude-bridge`, fall back to setting `claudeBridge.daemonPath`.
- `child_process.spawn` with `detached: true` so daemon survives VS Code close.
- API key handling:
  - Read `process.env.ANTHROPIC_API_KEY` first; forward to spawned daemon.
  - If absent: prompt via `vscode.SecretStorage`; store on first entry; forward to spawned daemon.
- Setting `claudeBridge.autoStartDaemon` (default `false`): if true, run start command on activate if daemon not running.
- Success/failure notifications via VS Code notification API.

**ACs:**
- Palette command spawns daemon when not running.
- No-op when daemon already running.
- API key inheritance from env works.
- API key prompt + SecretStorage works when env absent.
- Setting `autoStartDaemon: true` triggers start on activate.

**Patterns:** Cross-platform process spawn (CC-2); subprocess detached: true semantics; ESM-compatible spawn options.

**Empirical prediction:** 20-30 min (binary path resolution + spawn + API key flow + setting plumbing).

---

### Phase 5 — T-P2-005: Daemon-not-running detection + error UX

**Goal:** When IPC fails because daemon is not running, surface actionable notification.

**Deliverables:**
- Detect "daemon not running" via IPC connection failure (ENOENT on socket, ECONNREFUSED, etc.).
- Notification: "Claude Bridge daemon is not running. Start it via 'Claude Bridge: Start Daemon'?"
- Action button: "Start Daemon" — runs Phase 4's command directly.
- Distinguish from other IPC errors (daemon crashed mid-conversation, daemon protocol error); those get different messages.
- Suppress repeated identical notifications within a short window (don't spam if extension polls).

**ACs:**
- IPC connection failure surfaces correct notification.
- "Start Daemon" action button works.
- Repeated failures don't spam notifications.
- Other IPC errors get distinct messages.

**Patterns:** Notification UX in VS Code; typed-error-family discrimination.

**Empirical prediction:** 10-15 min (mostly UX wiring; logic is straightforward).

---

### Phase 6 — T-P2-006: Status bar surface

**Goal:** Status bar shows registered workspace info per Q5.

**Deliverables:**
- Status bar item showing `Claude Bridge: <identifier>` when registered, or `Claude Bridge: (not connected)` when not.
- Click to show full info: identifier, name, abs_path, registered_at timestamp, IPC connection state.
- Color coding: subtle indicator when connected (default text); error color when daemon unreachable.
- Updates reactively: registration state changes, IPC connection state changes.

**ACs:**
- Status bar shows correct state for: not connected, connected/registered, daemon unreachable.
- Click expands full info.
- State transitions update status bar without manual refresh.

**Patterns:** VS Code StatusBarItem API; reactive state subscription.

**Empirical prediction:** 10-15 min (VS Code status bar is well-documented; mostly UX work).

---

### Phase 7 — T-P2-007: Workspace registry replacement

**Goal:** Daemon-side: replace P1 stub registry with real registration-backed registry. Reject delegations against unregistered workspaces.

**Deliverables:**
- New `WorkspaceRegistry` class in `packages/daemon/src/workspace/registry.ts` (replacing the stub).
- Registry holds: `Map<identifier, {abs_path, name, ipc_endpoint, registered_at, trust_state}>`.
- Methods: `register`, `deregister`, `get`, `getByPath`, `list`, `isAvailable` (for tool routing).
- Integration with delegate.ts handler: resolve workspace by identifier; reject with `503 no_workspace_registered` if not present; reject with `403 workspace_untrusted` if trust state is denied.
- Migration: remove `config.workspace` from config schema (or mark deprecated with warning). Document the change in T-P2-013 runbook update.

**ACs:**
- Delegation against registered workspace succeeds.
- Delegation against unregistered workspace returns `503 no_workspace_registered`.
- Delegation against denied-trust workspace returns `403 workspace_untrusted`.
- Existing T-P1-005 acceptance harness updated to use registration flow (not config-declared).
- T-P1-005 harness still passes after refactor (9/9 stub ACs).

**Patterns:** Typed-error-family; existing P1 patterns for registry shape.

**Empirical prediction:** 25-35 min (registry rewrite + tests + harness refactor; real surface).

---

### Phase 8 — T-P2-008: Approval flow scaffolding

**Goal:** Daemon-side: pause delegation before SDK invocation, await extension approval, proceed or deny. Extension-side: surface approval UI, send response.

**Deliverables:**
- Daemon-side: `ApprovalGate` module that handles per-delegation approval requests.
- Request message: `{type: "approval_request", delegation_id, workspace, mode, prompt, exhibits_count}`.
- Response message: `{type: "approval_response", delegation_id, decision: "approve" | "approve_session" | "deny"}`.
- Mode-sensitivity: `read_only` mode bypasses approval (auto-approves with audit log entry); `agentic` requires extension response.
- Session-grant tracking: daemon remembers `approve_session` decisions per `(workspace_id, vscode_session_id)` until extension deregisters.
- Timeout: default 60s; configurable; timeout treated as deny.
- Extension-side: surface notification with action buttons; show truncated prompt (first ~500 chars) with "View details" expanding to full prompt + exhibits.
- Extension setting `claudeBridge.approvalMode`: `prompt-per-agentic-session` (default), `prompt-per-delegation`, `trust-workspace`.

**ACs:**
- `read_only` delegation: no extension prompt; audit log entry shows auto-approval.
- `agentic` delegation first call: extension prompt fires; user approves; SDK runs.
- `agentic` delegation second call same session: no prompt; runs immediately (with session-grant).
- User denies: `403 user_denied` returned to MCP caller; audit log records denial.
- Timeout: treated as deny; `403 user_denied` returned with timeout reason.
- `claudeBridge.approvalMode: "trust-workspace"`: no prompts ever; audit log only.
- `claudeBridge.approvalMode: "prompt-per-delegation"`: every agentic delegation prompts.

**Patterns:** Typed-error-family for approval responses; ctx-async-local-storage for delegation context propagation.

**Empirical prediction:** 35-50 min. Largest task in P2. Real cross-process flow with multiple modes, session grants, timeout handling, and UI work. Live-runtime-with-reactive-debug headroom likely.

---

### Phase 9 — T-P2-009: `get_open_editors` tool

**Goal:** New MCP tool. Daemon receives, routes to extension via IPC, returns response.

**Deliverables:**
- Tool registration in MCP server: `get_open_editors` with input/output schemas.
- Daemon-side handler: receive tool call, route to extension via `{type: "tool_call", tool: "get_open_editors", workspace, input}`, await response with 5s timeout.
- Extension-side handler: respond with serialized state from `vscode.window.tabGroups.all`.
- Output: list of `{uri, language_id, is_dirty, is_active, selection?}` per open editor.
- Workspace argument: required if multiple workspaces registered; optional otherwise.

**ACs:**
- Tool returns correct editor state from VS Code.
- Multi-window scenario: `workspace` argument routes correctly.
- `workspace` omitted with multiple registered → `400 ambiguous_workspace`.
- `workspace` omitted with single registered → routes correctly.
- Extension unreachable → `503 extension_offline` returned.

**Patterns:** Existing MCP tool patterns from P1 (delegate.ts, poll.ts shape); ctx side-channel for audit metadata.

**Empirical prediction:** 15-25 min (tool surface is well-established; the new work is IPC routing + VS Code API call).

---

### Phase 10 — T-P2-010: `get_diagnostics` tool

**Goal:** Second inspection tool. Same pattern as Phase 9.

**Deliverables:**
- Tool registration: `get_diagnostics` with input schema (`workspace?`, `severity?`) and output schema.
- Daemon-side handler routes to extension.
- Extension-side handler: respond from `vscode.languages.getDiagnostics()` with severity filter.
- Output: list of `{uri, range, severity, message, source?}` per diagnostic.

**ACs:**
- Tool returns correct diagnostics from VS Code.
- Severity filter works (`error` / `warning` / `all`).
- Multi-window routing per Phase 9 pattern.

**Patterns:** Same as Phase 9. Likely a small refactor opportunity to extract shared "extension tool routing" code if Phase 9 didn't already.

**Empirical prediction:** 10-15 min (mostly mechanical after Phase 9 establishes the pattern).

---

### Phase 11 — T-P2-011: Acceptance harness for extension path

**Goal:** End-to-end test of P2 surface — registration, delegation with approval, inspection tools.

**Deliverables:**
- New script `scripts/acceptance-p2.mjs` (or extension to existing harness suite).
- Test daemon startup + extension mock (or real extension via headless VS Code if feasible; if not, a mock IPC client serves as extension).
- Test cases:
  - Registration with trust prompt approval.
  - Delegation with session-grant approval.
  - Inspection tool calls.
  - Workspace argument routing in multi-workspace scenario.
- Result table in harness output.
- Lessons from T-P1-011 carried forward: unwrapOrThrow discipline, drainJobs between tests, harness-common.mjs reuse.

**ACs:**
- All P2 SMOKE ACs pass via the harness.
- Harness runs on Windows; WSL run is Phase 12's concern.
- No silent-pass failures (assertion discipline per v0.5 §7).

**Patterns:** Harness-common.mjs (from T-P1-011); unwrapOrThrow; cross-platform-test-inputs.

**Empirical prediction:** 25-35 min (real harness production + live-cycle debug-fix headroom). Live-API wire-path harness shape per v0.5 calibration table.

---

### Phase 12 — T-P2-012: Cross-platform validation

**Goal:** Run P2 acceptance harness on Windows + WSL Ubuntu. Reconcile any differences. Verify `.vsix` install on both.

**Deliverables:**
- WSL Ubuntu run of acceptance-p2 harness.
- `.vsix` install verification on WSL Ubuntu.
- Platform-fix work (anticipated <20 lines per fix, per T-P1-012 pattern).
- Two SMOKE result tables in report (Windows + WSL).

**ACs:**
- Both platforms pass acceptance harness.
- Any platform-specific code stays under 20-line budget per fix.
- AC-P2-15 cross-platform parity verified.

**Patterns:** CC-4 (defensive clean install); CC-5 (lazy-load with graceful degradation if relevant); T-P1-012 patterns for cross-platform validation tasks.

**Empirical prediction:** 15-25 min (execution-only validation; T-P1-012's 20-min midpoint as the analog).

---

### Phase 13 — T-P2-013: Runbook + walkthrough updates

**Goal:** Document P2 changes for operators (runbook) and contributors (walkthrough).

**Deliverables:**
- Runbook additions: extension install instructions, daemon-lifecycle from extension, approval modes, troubleshooting (extension not connecting, daemon binary not found, etc.).
- Walkthrough additions: P2 narrative section covering all 10 architecture decisions; updated diagram showing 3-process flow with extension; cross-references to runbook.
- Update README to mention P2 (similar pattern to T-P1-015).
- Doc-debt items from T-P2 verdicts land here if runbook-shaped.

**ACs:**
- Runbook covers extension install + lifecycle.
- Walkthrough P2 section structurally matches P1 section style.
- All links verified to resolve.
- README mentions P2 gate-closed (when T-P2-015 completes; T-P2-013 sets up the structure).

**Patterns:** Doc-extension pattern from T-P1-013; preserve-existing-content discipline.

**Empirical prediction:** 15-25 min (doc-extension task; T-P1-013's 20-min midpoint as the analog).

---

### Phase 14 — T-P2-014: Methodology v0.6 creation

**Goal:** Codify P2-surfaced methodology refinements; refresh empirical band table with P2 calibration data.

**Deliverables:**
- Read `project-state.md`'s `v0_6_candidates` accumulated list.
- AskUserQuestion to resolve scope: which candidates to include, which to defer, what new structural sections (if any).
- New methodology document at `docs/claude-orchestrated-methodology-v0_6.md` as full standalone replacement.
- Updated empirical band table reflecting P2 data alongside P1.
- Update walkthrough + runbook to reference v0.6 instead of v0.5 where applicable.

**ACs:**
- v0.6 doc exists as standalone replacement.
- All confirmed v0.6 candidates from the running list are addressed (included or explicitly deferred to v0.7 with rationale).
- Empirical band table refreshed.
- Cross-references in other docs updated.

**Patterns:** v0.5 itself as template structure; user-confirmation-on-scope via AskUserQuestion (same as v0.5 creation flow).

**Empirical prediction:** 25-40 min (full methodology document drafting; scope conversation; data aggregation).

---

### Phase 15 — T-P2-015: P2 gate close + doc-debt sweep

**Goal:** Final gate close. Doc-debt sweep across design docs. Gate-close snapshot for P3 handoff.

**Deliverables:**
- P2-close doc-debt sweep (analog of T-P1-014's 11-item sweep; specific items accumulate through P2 verdicts).
- Gate-close snapshot at `docs/snapshot/orchestrator-context-p2-close.md` modeled on P0/P1 close snapshots.
- Updated milestones, project-state, calibration-log.
- README updated to reflect P2 gate-closed (post-gate cleanup analog to T-P1-015).

**ACs:**
- All P2-close doc-debt items applied.
- Gate-close snapshot well-formed (all sections per P0/P1 close template).
- P2 milestones row marked GATE-CLOSED.
- Calibration log captures all 15 P2 tasks.

**Patterns:** T-P1-014 doc-sweep template; T-P1-015 README refresh pattern.

**Empirical prediction:** 20-30 min (sweep + snapshot; T-P1-014's 22-min actual as the analog).

---

## Pre-task scope-decision matrix

For each phase, the orchestrator+user pre-conversation will surface task-specific scope decisions. The matrix below names the most likely decision surfaces per phase:

| Phase | Likely decisions |
|---|---|
| T-P2-001 | Monorepo placement (`extension/` vs `packages/extension/`); VS Code engine pin; activation event |
| T-P2-002 | IPC protocol versioning scheme; reconnection backoff strategy |
| T-P2-003 | Trust store file format (JSON vs JSONL); modal vs notification for trust prompt |
| T-P2-004 | Binary path resolution order; SecretStorage key naming |
| T-P2-005 | Notification deduplication window; error message wording |
| T-P2-006 | Status bar icon (text only vs Codicon); click behavior |
| T-P2-007 | Migration story for existing `config.workspaces` (deprecated warning vs hard error) |
| T-P2-008 | Approval timeout default; prompt UI shape (notification vs webview); "approve session" vs "approve for N minutes" |
| T-P2-009 | Whether to extract shared "extension tool routing" lib or duplicate from Phase 9 to Phase 10 |
| T-P2-010 | Same as Phase 9 if not resolved there |
| T-P2-011 | Headless VS Code feasibility for harness; mock-extension fallback shape |
| T-P2-012 | Platform-fix budget per fix (likely match T-P1-012's 20-line rule) |
| T-P2-013 | Runbook section ordering; walkthrough cross-reference style |
| T-P2-014 | v0.6 candidate inclusion list (scope conversation) |
| T-P2-015 | Doc-debt items final list |

---

## Dependencies and ordering

The 15 phases are largely sequential but with some parallelism possible:

**Strict sequential chain:** 1 → 2 → 3 → 7 → 8 → 11 → 12 → 13 → 14 → 15

**Independent within their layer:**
- 4 (Daemon-lifecycle commands) depends only on 1 (extension exists); can run in parallel with 2-3.
- 5 (Not-running detection) depends on 2 (IPC client) and 4 (start command); can land alongside 6.
- 6 (Status bar) depends on 3 (registration); can run in parallel with 4-5.
- 9 and 10 (inspection tools) depend on 2 (IPC), 7 (registry), 8 (approval scaffolding for the call-side); can sequence as 9 then 10 since 10 reuses 9's patterns.

In practice the cadence will likely follow the numbered sequence because each task's verdict informs the next dispatch's scope conversation. Parallelism is theoretical.

---

## Estimated total

15 tasks at observed P1 cadence of ~40 min average per task = ~10 hours.

This is a rough number. Empirical bands vary: T-P2-008 (approval flow) and T-P2-011 (acceptance harness) are the heaviest; small tasks like T-P2-001 and T-P2-005 may land in the 8-15 min range. Range estimate: 8-14 hours total.

---

## References

- Design doc: `docs/design/03-p2-extension.md`
- Methodology in effect: `docs/claude-orchestrated-methodology-v0_5.md`
- P1 close snapshot: `docs/snapshot/orchestrator-context-p1-close.md`
- P1 build plan: `docs/design/p1-build-plan.md` (template for P2 plan structure)

---

## Appendix — Clyde review notes (T-P2-000-review)

Review pass performed 2026-05-24 alongside the companion `03-p2-extension.md` review. Procedure: cross-reference verification, codebase reality-check, empirical-prediction sanity-check against P1 calibration data, then surface findings.

**What I read.** This document end-to-end; the companion `03-p2-extension.md` end-to-end; `packages/shared/src/config.ts` and `packages/daemon/src/ipc/protocol.ts` for codebase reality; `docs/calibration-log.md` for P1 actual-vs-predicted data.

**Corrections applied (low-risk, in-place):**

1. **Phase 7 config field name.** Changed "remove `config.workspaces` from config schema" → "remove `config.workspace` from config schema." P1's `ConfigSchema` (at `packages/shared/src/config.ts:59`) has `workspace: WorkspaceConfigSchema.optional()` — singular, not plural. Plural would have been a factual error that propagated through Phase 7's migration story.

**Concerns raised for orchestrator follow-up (not modified in-doc):**

1. **Phase 2 "P0's CLI hello is unaffected" — there is no CLI hello.** P0's IPC protocol (`packages/daemon/src/ipc/protocol.ts`) is fire-and-respond newline-delimited JSON. Request kinds: `status`, `stop`, `token_rotate`, `tunnel_restart`. No hello message, no session handshake, no role advertisement. Phase 2's deliverable list ("Hello message: `{type: 'hello', version: '1.0', role: 'extension', pid: number}`. Daemon-side: handle hello messages (extension client identity); P0's CLI hello is unaffected (different role)") presumes a hello primitive that doesn't exist. **The actual work is: introduce a hello-message concept to the IPC protocol for the first time, ensure P0's existing CLI commands still work without one (they need to be hello-optional), and define the protocol versioning story.** This is a larger scope item than the current Phase 2 framing suggests. **Recommend: rephrase Phase 2 to acknowledge the new-protocol-concept work.**

2. **Total-time estimates inconsistent across the doc.** Three different totals are stated:
   - §"Estimated total" (line 34): "~12-14 hours at P1 cadence."
   - §"Estimated total" (line 449-453): "15 tasks at observed P1 cadence of ~40 min average per task = ~10 hours" and "Range estimate: 8-14 hours total."
   - Sum of per-phase midpoint predictions (my arithmetic): 337.5 min ≈ 5.6 hours.
   - Sum of per-phase range bands: low 270 min (4.5h) to high 470 min (7.8h).
   
   The "~40 min average per task" claim doesn't match P1 actuals. P1 calibration: 14 tracked tasks summed to 223 min (T-P1-002 through T-P1-015) → average **~16 min/task**, not 40. **Recommend: drop the two top-level total estimates entirely; let the per-phase predictions speak for themselves, with a single accurate sum if the user wants a planning number.** Current estimates over-anchor on a 2x-too-large average.

3. **Phase ordering — Phase 9/10 vs Phase 8 dependency unclear.** Phase 8 builds the approval flow scaffolding for delegations. Phase 9/10 ship inspection tools (`get_open_editors`, `get_diagnostics`). The build plan's dependency section says "9 and 10 (inspection tools) depend on 2 (IPC), 7 (registry), 8 (approval scaffolding for the call-side)." But inspection tools are pure-read and shouldn't go through approval (this is also a design-doc concern — see appendix item #3 in `03-p2-extension.md`). **If inspection tools bypass approval, Phase 9/10 do NOT depend on Phase 8.** Recommend: either explicitly route inspection tools through approval (and document why), or remove the Phase-9/10-depends-on-Phase-8 claim.

4. **Phase 2 prediction (15-20 min) is optimistic given protocol-versioning work.** Once Phase 2's actual scope is clear (introducing the hello/versioning concept, see concern #1), the empirical band should probably shift to 20-30 min. The P1 calibration analog is T-P1-009 (SDK integration, 23 min including 5-min reshape) for a similarly-shaped "introduce-new-protocol-surface" task.

5. **Phase 7 prediction (25-35 min) may need T-P1-005 harness re-run cost.** AC requires "T-P1-005 harness still passes after refactor (9/9 stub ACs)." That's an explicit harness re-run cost on top of the registry rewrite. Per T-P1-011's mechanical-replacement-refactor experience, the re-run is cheap (~5s), but the AC implies discovery-of-breakage is in scope. **Realistic prediction is the upper edge of the band (30-35 min) if any harness adjustment is needed.**

6. **Phase 11 prediction (25-35 min) probably tight if "headless VS Code" is chosen.** The pre-task scope-decision matrix flags this. Real headless VS Code via the extension testing framework is non-trivial setup. Mock IPC client is faster but limits realism. **Recommend: pre-resolve the decision in the scope conversation before T-P2-011 dispatches.** If headless VS Code, bump prediction to 35-50 min.

7. **`v0_6_candidates` field doesn't exist in `project-state.md` yet.** Build plan §"How P2 differs from P1" claims "Each task's verdict appends to a `v0_6_candidates` field [in project-state.md]." T-P2-014 reads from this list. The field needs initialization before T-P2-001 — either as a pre-flight step in T-P2-001 or as an addition to be made at the same time as the design-doc approval. **Recommend: initialize the field via a tiny housekeeping commit before T-P2-001, OR add as a T-P2-001 deliverable.**

8. **Methodology v0.6 task scope is undefined at dispatch time.** Phase 14 deliverables include "AskUserQuestion to resolve scope: which candidates to include, which to defer, what new structural sections." That makes Phase 14 a scope-resolution-during-task pattern, which v0.5 §1.1 explicitly identifies as the **anti-pattern** to pre-task scope-decision conversation. **Recommend: scope conversation for v0.6 happens pre-dispatch, same as every other P2 task, NOT during dispatch via AskUserQuestion.** Adjust Phase 14 deliverables accordingly.

9. **No explicit Phase for the initial workspace-trust file format decision.** Phase 3 mentions a trust store ("`~/.claude-bridge/workspace-trust.json`") without naming format. JSON vs JSONL is in the per-task scope-decision matrix for Phase 3 — fine. But what about the identifier-persistence concern (see design doc appendix concern #7)? If identifiers are persisted, that's part of the trust store too. Phase 3's deliverables don't unify these. **Recommend: explicit Phase 3 deliverable for the trust+identifier persistent-store schema.**

10. **No phase for OAuth — fine, but flag for clarity.** Q6 in the design doc says OAuth is P3. Build plan doesn't have a Phase for it. ✓ Correct deferral. (Not a concern, just noting verification.)

**Codebase reality-check findings (no in-doc changes):**

- **Config field name** (corrected; see above).
- **IPC protocol shape** — newline-delimited JSON, `kind`-discriminated requests, no hello concept. Phase 2 needs to be aware (see concern #1).
- **MCP tool registration pattern** — `makeTool()` factory at `packages/daemon/src/mcp/tools/*.ts` is the template Phase 9/10 will follow. ✓
- **Workspace registry interface** — `WorkspaceRegistry` (T-P1-002) is a small interface with one method `resolve(id)`. Phase 7's expanded surface (`register`, `deregister`, `get`, `getByPath`, `list`, `isAvailable`) is a clean expansion. ✓

**Empirical-prediction sanity-check summary.**

Aggregating: most per-phase predictions are reasonable against P1 cadence. The ones I'd flag as needing recalibration are Phase 2 (probably too low; see concern #1 + #4) and the overall totals at lines 34 and 449-453 (see concern #2). The doc's per-phase predictions sum to ~5.6 hours midpoint / 4.5-7.8 hours range — half of what the top-level summary claims.

**Confidence assessment for T-P2-001 readiness.**

The build plan's 15-phase structure is sound; the dependency analysis is mostly correct (one needs revision per concern #3); per-phase deliverables and ACs are concrete. The major blocker is **concern #1 (Phase 2 protocol-versioning scope)** — this affects how the very first non-scaffolding task gets dispatched. **Recommend: resolve concern #1 (Phase 2 actual scope) and concern #2 (total estimate accuracy) before T-P2-001 dispatches.** Concerns #3-9 are smaller and can be folded into per-task scope conversations as the phases come up.

**Verdict:** plan is ~85% ready. Resolve concerns #1, #2, and #7 (`v0_6_candidates` field initialization) pre-T-P2-001; the rest can land in per-task scope conversations.

End of Clyde review notes.

End of P2 build plan.
