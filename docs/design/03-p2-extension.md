# P2 Design — VS Code Extension + Real Workspace Registration

**Phase:** P2
**Status:** Design — pending Clyde review and user final approval
**Predecessor:** P1 (delegation surface; gate-closed 2026-05-24)
**Successor:** P3 (OAuth, policy schema, expanded tool surface — pending P2 close)
**Date:** 2026-05-24
**Methodology in effect at P2 start:** v0.5 (`docs/claude-orchestrated-methodology-v0_5.md`)

---

## 1. What P2 ships

P2 makes claude-bridge usable end-to-end from a real VS Code workspace. The user opens VS Code with the claude-bridge extension installed, the extension registers the workspace with the daemon, project-Claude (or any MCP client) connects to the daemon and delegates work against the registered workspace, and the user sees clear approval prompts when delegations are about to mutate code.

The deliverable is a working developer workflow:

1. User installs the extension via `.vsix` sideload.
2. User opens a workspace folder in VS Code.
3. Extension auto-registers the workspace with the daemon (one-time trust prompt on first registration of a path).
4. Project-Claude calls `delegate_to_claude_code` against the registered workspace.
5. VS Code surfaces an approval prompt for agentic delegations (session-scoped grant).
6. User approves; SDK Claude Code runs in the workspace; report flows back.

P2 closes the gap between "the daemon technically works" and "you can actually use this."

## 2. What P2 explicitly does NOT ship

The following are deferred to P3 (or later) with explicit rationale:

- **OAuth.** Still on Bearer token authentication via `ANTHROPIC_API_KEY` env var. OAuth 2.1 + DCR is the right long-term answer for production-grade auth but adds substantial scope; P2 stays Bearer-only and inherits P1's auth surface.
- **Per-workspace `.claude-bridge.json` policy schema.** Bash deny patterns remain hardcoded in `SdkJobRunner`; per-workspace overrides are a P3 concern.
- **Tool surface expansion beyond two.** P2 ships `get_open_editors` and `get_diagnostics` only. The deferred list (`get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`) ships in P3 or later based on real usage feedback.
- **Production deployment story.** No CI integration, no marketplace publishing, no automatic update mechanism. Local sideload is the only install path.
- **Multi-user / team-shared daemon.** Daemon stays single-user; multi-user is a future concern.
- **macOS first-class support.** Apple Silicon cloudflared path is documented in P1's runbook as untested; P2 doesn't actively validate on macOS. Linux/macOS broader validation is a P3+ concern.

## 3. Architecture overview

Three processes interact in P2:

```
┌─────────────────────┐         ┌────────────────────┐         ┌──────────────────┐
│  project-Claude     │  MCP    │  claude-bridge     │  IPC    │  VS Code         │
│  (claude.ai chat)   │ ──────► │  daemon            │ ◄─────► │  extension       │
│                     │  HTTPS  │  (long-running)    │ socket  │  (per-window)    │
└─────────────────────┘         └────────────────────┘         └──────────────────┘
                                          │                              │
                                          │ spawn                        │ surface UI
                                          ▼                              ▼
                                ┌────────────────────┐         ┌──────────────────┐
                                │  SDK Claude Code   │         │  approval prompt │
                                │  (per delegation)  │         │  status bar      │
                                └────────────────────┘         └──────────────────┘
```

**P0 layer (bus):** Daemon runs as long-lived process. MCP over HTTPS (via cloudflared tunnel) for project-Claude. IPC over Unix socket / Windows named pipe for local CLI clients. Bearer-token auth for MCP boundary.

**P1 layer (delegation surface):** Three MCP tools (`delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`) drive the SDK Claude Code per-delegation lifecycle. Stub workspace registry validated config-declared workspaces.

**P2 layer (extension + real registration):**
- VS Code extension connects to daemon via IPC (same socket P0's CLI uses).
- Extension registers workspace on activate; deregisters on deactivate.
- Workspace registry replaces P1 stub: registrations are extension-driven, ephemeral (lost on daemon restart), and tied to live IPC connections.
- Daemon routes inspection tool calls (`get_open_editors`, `get_diagnostics`) to the appropriate registered extension via IPC.
- Daemon awaits approval response from extension before invoking SDK on agentic delegations.

## 4. Architecture decisions

Ten decisions confirmed via orchestrator+user pre-conversation (2026-05-24).

### Q1 — Extension ↔ daemon transport: IPC

Extension talks to daemon via the same IPC mechanism P0's CLI uses — Unix socket on Unix hosts, named pipe on Windows. Reuses P0's transport code; no new wire protocol.

Rationale:
- Already implemented; zero new transport code.
- Extension cannot accidentally expose anything externally.
- Process isolation: daemon crashes don't take VS Code down; VS Code restart doesn't kill the daemon.
- Matches architectural intent: daemon is a long-running service; extension is an editor-bound client.

Rejected alternatives:
- HTTP localhost — pays HTTP overhead for purely local communication; auth plumbing more complex than filesystem-permission IPC.
- Direct in-process — folds daemon into VS Code's extension host, defeating the long-running-service intent.

### Q2 — Workspace registration: tied to VS Code session lifetime

Extension registers workspace with daemon on activate; deregisters on deactivate. Registration state matches "extension is running." Multiple VS Code windows handle naturally — each activates its own extension instance, each registers its own workspace.

Subsidiary decision: daemon rejects delegations against unregistered workspaces with `503 no_workspace_registered`. No fallback to config-declared workspaces (that would undermine the architectural shift to extension-driven registration).

Headless operation (running claude-bridge without VS Code open) is not a P2 use case. If real demand surfaces, add a config-declared "headless" workspace path as an opt-in for P3.

Rationale:
- Simplest model. Registration state matches reality of who's connected.
- Multi-window users get correct behavior automatically.
- Daemon restart while VS Code is running: extension re-registers on next activity.

Rejected alternatives:
- Persistent registration across VS Code restarts: stale entries accumulate; cleanup story is real work.
- Per-delegation registration check: round-trip latency per delegation; complexity for marginal benefit.

### Q3 — Daemon lifecycle from the extension

**Q3a — Daemon binary path resolution:** auto-detect with setting override. Extension looks in PATH, then in workspace's `node_modules/.bin`, falls back to `claudeBridge.daemonPath` setting.

**Q3b — Start-on-activate:** explicit start by default via "Claude Bridge: Start Daemon" palette command. Setting `claudeBridge.autoStartDaemon` allows automation; defaults to false.

**Q3c — Auto-stop on deactivate:** never. Daemon is meant to be long-running. Stopping requires explicit user action (palette command or `claude-bridge stop` from terminal).

**Q3d — `ANTHROPIC_API_KEY` handling:** env first, VS Code SecretStorage fallback. Extension forwards `process.env.ANTHROPIC_API_KEY` to spawned daemon if present; otherwise prompts user via `vscode.SecretStorage` API; stored key persists across VS Code restarts encrypted by VS Code.

### Q4 — Inspection tool surface

P2 ships two tools: `get_open_editors` and `get_diagnostics`. Daemon proxies MCP calls to the registered extension via IPC with a 5-second timeout. Returns `503 extension_offline` on timeout (status code conforms to the `503 no_workspace_registered` / `403 user_denied` pattern used elsewhere in P2).

Tool shapes (final wire schemas pending implementation):

**`get_open_editors`**
- Input: `{ workspace?: string }` (optional when single workspace registered; required when multiple)
- Output: list of `{ uri: string, language_id: string, is_dirty: boolean, is_active: boolean, selection?: {...} }` per open editor.

**`get_diagnostics`**
- Input: `{ workspace?: string, severity?: "error" | "warning" | "all" }` (severity defaults to all)
- Output: list of `{ uri: string, range: {...}, severity: string, message: string, source?: string }` per diagnostic.

Tools deferred to P3 or later (no implementation in P2): `get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`.

### Q5 — Workspace identifier scheme

Identifier is a stable handle: lowercase slug from the workspace folder name + 6-char alphanumeric suffix for collision resistance. Example: `claude-bridge-x4k2p1`.

Display info (what humans see for verification) lives alongside the handle:
- `name`: human-readable label, defaults to folder name, user-overridable via settings.
- `abs_path`: absolute filesystem path.
- `registered_at`: ISO timestamp when extension registered.
- `ipc_endpoint`: socket path back to the registering extension.

VS Code status bar surfaces `Claude Bridge: <identifier> (this folder)` for at-a-glance verification.

### Q6 — Runtime approval flow

Daemon-side enforcement of human approval before SDK invocation, with mode sensitivity and session-grant semantics.

**Default behavior:**
- `read_only` delegations auto-approve (audit-logged on daemon side; no extension prompt).
- `agentic` delegations prompt the extension on first call per session; "Approve for this session" remembers the approval until VS Code closes.

**Configurable approval modes** (extension setting `claudeBridge.approvalMode`):
- `prompt-per-agentic-session` (default): as described above.
- `prompt-per-delegation`: every agentic delegation prompts; no session memory. Paranoid mode.
- `trust-workspace`: no prompts ever; audit log is the only record. Sandbox-workspace mode.

**Approval surface:**
- Notification with action buttons (non-blocking).
- Shows full delegation parameters: workspace, mode, prompt text (truncated to ~500 chars with "view full" link if longer), exhibits count.
- Action buttons: "Approve" / "Approve for session" / "Deny" / "View details" (expands to show full prompt + exhibits).
- Default-deny on timeout (default 60 seconds; configurable via `claudeBridge.approvalTimeoutMs`).

**Failure semantics:**
- Extension unreachable when daemon needs approval → daemon returns `503 extension_offline` to caller.
- User denies → daemon returns `403 user_denied` to caller; audit log records denial.
- Approval times out (extension reachable but user AFK) → treated as deny.

### Q7 — First-registration workspace trust prompt

When extension registers a workspace path the daemon has no prior trust record for, daemon stores a "pending trust" state and routes a one-time trust prompt to the extension. Extension surfaces a modal:

> Permit this workspace (`<abs_path>`) to receive delegations from claude-bridge clients?
>
> This authorizes any MCP client connected to your daemon (such as project-Claude chats in claude.ai) to delegate work against this workspace, subject to per-delegation approval per Q6.
>
> [Trust] [Don't trust]

Trust decision stored persistently per workspace path on daemon side (in config or a dedicated trust store; implementation detail for the registry task). Subsequent registrations of the same path skip the prompt.

Failure semantics:
- User clicks "Don't trust" → registration rejected; extension surfaces an error in status bar.
- Prompt times out → registration in pending state until user responds; extension shows "Awaiting trust decision" in status bar.

Trust store does NOT have a "revoke" mechanism in P2 — user can manually edit the trust store file if needed. Revocation UI is P3 if real demand surfaces.

## 5. Acceptance criteria

Full ACs are in `docs/design/p2-build-plan.md` per-phase. Summary:

- AC-P2-1: Extension installs from `.vsix` on Windows + WSL Ubuntu.
- AC-P2-2: Extension auto-activates on opening any workspace.
- AC-P2-3: First-registration trust prompt fires; trust decision persists.
- AC-P2-4: Daemon rejects delegations against unregistered workspaces with `503 no_workspace_registered`.
- AC-P2-5: Daemon rejects delegations against untrusted workspaces with `403 workspace_untrusted`.
- AC-P2-6: Daemon-lifecycle commands work — "Start Daemon" spawns process; daemon-not-running detection surfaces actionable notification.
- AC-P2-7: `ANTHROPIC_API_KEY` handling — env-first inheritance works; SecretStorage prompt+store fallback works.
- AC-P2-8: Approval flow — `read_only` auto-approves; `agentic` prompts on first call per session; "Approve for session" remembers.
- AC-P2-9: Approval timeout treated as deny.
- AC-P2-10: User denial returns `403 user_denied` to MCP caller.
- AC-P2-11: `get_open_editors` returns correct editor state via MCP path.
- AC-P2-12: `get_diagnostics` returns correct diagnostics via MCP path.
- AC-P2-13: Extension status bar shows registered workspace identifier + name.
- AC-P2-14: Multiple VS Code windows each register their own workspace; inspection tools route correctly via `workspace` argument.
- AC-P2-15: Cross-platform parity (Windows + WSL Ubuntu) for all behavioral ACs.

## 6. Open questions deferred to P3

- OAuth direction (deferred twice now; P3 must resolve).
- Per-workspace `.claude-bridge.json` policy schema.
- Tool surface expansion: which of the remaining 5 deferred tools to ship.
- macOS first-class validation including Apple Silicon paths.
- Marketplace publishing for the extension.
- Trust revocation UI.
- Headless mode (running claude-bridge without VS Code).
- Multi-user / team-shared daemon.
- CI integration of the extension-path harness.

## 7. References

- P1 design: `docs/design/02-p1-delegation.md`
- P1 build plan: `docs/design/p1-build-plan.md`
- P1 close snapshot: `docs/snapshot/orchestrator-context-p1-close.md`
- Methodology v0.5: `docs/claude-orchestrated-methodology-v0_5.md`
- Operator runbook: `docs/runbook.md`
- Contributor walkthrough: `docs/walkthrough.md`

---

## Appendix — Clyde review notes (T-P2-000-review)

Review pass performed 2026-05-24 against this doc + companion build plan + the P1 codebase. Procedure per the T-P2-000-review dispatch: cross-reference verification, codebase reality-check (Q1/Q2/Q4), empirical-prediction sanity-check, then surface findings.

**What I read.** This document end-to-end; the companion `p2-build-plan.md` end-to-end; `packages/shared/src/config.ts` and `packages/daemon/src/ipc/protocol.ts` for codebase reality.

**Corrections applied (low-risk, in-place):**

1. **Q4 status code consistency.** Changed "Returns `extension_offline` error on timeout" → "Returns `503 extension_offline` on timeout (status code conforms to the `503 no_workspace_registered` / `403 user_denied` pattern used elsewhere in P2)." Rationale: every other tool-rejection in this doc uses the `<3-digit-code> <symbol>` convention; the one bare `extension_offline` was the outlier.

**Concerns raised for orchestrator follow-up (not modified in-doc; substantive design discussion needed before T-P2-001 dispatches):**

1. **Decision-count rhetoric vs structure.** §4 reads "Ten decisions confirmed via orchestrator+user pre-conversation" then enumerates Q1, Q2, Q3 (containing Q3a-d), Q4-Q7 — that's seven numbered decisions if Q3 is treated as one, or ten if Q3a-d are counted separately. The build plan's Phase 13 deliverables say "P2 narrative section covering all 10 architecture decisions" — which presumes the count-Q3a-d-separately interpretation. Either pick one convention and apply consistently (recommend: keep Q1-Q7 numbering but say "ten sub-decisions across seven decision groups" up front), or rewrite §4's "Ten decisions" to "Seven decisions."

2. **Q2 + Q7 duplicate-registration semantics undefined.** Q2 says multiple VS Code windows handle naturally — each registers its own workspace. Q7 says trust is keyed by `abs_path`. If two windows open the same folder, both extensions register the same `abs_path` against the daemon simultaneously. Q5 (workspace identifier scheme) generates per-registration slugs, so the daemon's registry could have two entries with the same `abs_path` but different identifiers — or it could reject duplicates. The design doesn't say. **Recommend: explicitly define duplicate-`abs_path` registration semantics** (reject second / accept and route both / merge into one). This shapes Phase 3's deliverables.

3. **Q4 inspection tools vs Q6 approval flow.** Q6 says `read_only` delegations auto-approve and `agentic` requires approval. But inspection tools (`get_open_editors`, `get_diagnostics`) aren't delegations — they're separate MCP tools. Q6 doesn't cover them. By default they'd skip approval (which is probably right — inspection tools are pure-read), but the design should be explicit. **Recommend: extend Q6 to say "Inspection tools (Q4) bypass the approval flow entirely; they are read-only by definition and audit-logged on each call."**

4. **Q6 read_only + approval-mode interaction.** Q6 says `read_only` delegations auto-approve. The mode list adds `prompt-per-delegation` ("every agentic delegation prompts") and `trust-workspace` ("no prompts ever"). What does `prompt-per-delegation` do for `read_only` delegations? Implication is "still auto-approves," but the mode name doesn't say. **Recommend: clarify that `read_only` always auto-approves regardless of approval mode** (or, if the design intent is different, say so).

5. **Q6 `workspace_untrusted` AC reachability.** Build plan AC-P2-5 says "Daemon rejects delegations against untrusted workspaces with `403 workspace_untrusted`." But Q7 makes trust a binary decision at registration time: trust → registration proceeds; don't-trust → registration rejected. Once registered, the workspace IS trusted. Without a revoke mechanism (Q7 explicitly defers revocation to P3), how does the daemon ever encounter a registered-but-untrusted workspace? **Recommend: either remove AC-P2-5 as unreachable, or define the codepath that produces this state** (e.g., trust store edited externally between daemon restarts).

6. **Q3d API-key forwarding to already-running daemon.** Q3b makes auto-start opt-in (default `false`). So most users will have started the daemon themselves (via terminal, `claude-bridge start`) with whatever `ANTHROPIC_API_KEY` was in that shell. When the VS Code extension later connects via IPC, the daemon is already running with its established key. Q3d's "extension forwards key to spawned daemon" applies only when the extension spawns the daemon — silent gap when the daemon was spawned externally. **Recommend: define the already-running-daemon API-key story** (maybe an IPC `set_api_key` message? Or accept that externally-started daemons own their own key context and the extension's SecretStorage path is opt-in only when extension does the spawning?).

7. **Q5 workspace identifier persistence.** Q5 says "Identifier is a stable handle." Build plan Phase 3 says daemon generates identifier on registration. With a 6-char suffix on each generation, the same `abs_path` would get a different identifier on each registration (across daemon restarts or extension restarts) unless the daemon persists path→identifier mappings. The "stable handle" claim implies persistence; Phase 3 doesn't address it. **Recommend: define identifier persistence** (probably keyed by `abs_path` in the same persistent trust store from Q7).

**Codebase reality-check findings (no in-doc changes; for orchestrator awareness):**

- **Q1 IPC transport — confirmed real.** P0's IPC server lives at `packages/daemon/src/ipc/server.ts` with newline-delimited JSON protocol at `packages/daemon/src/ipc/protocol.ts`. Unix socket on Unix, named pipe on Windows. Extension can reuse the same socket. ✓
- **Q2 workspace registration — current stub matches design's "to be replaced."** `packages/daemon/src/workspace/registry.ts` exports `StubWorkspaceRegistry` with `resolve(id)` returning the single configured workspace or null. Design's intent (replace stub with registration-backed real registry) is feasible. ✓
- **Q4 inspection tool routing — feasible.** `packages/daemon/src/mcp/tools/` has `ping.ts`, `delegate.ts`, `poll.ts`, `cancel.ts`. New tools follow the same `makeTool()` factory pattern. Daemon→IPC→extension routing is a new code surface but composes cleanly with existing patterns. ✓
- **Config schema field name.** The P1 config has `workspace: WorkspaceConfigSchema.optional()` (singular). Build plan's Phase 7 originally said `config.workspaces` (plural) — corrected to `config.workspace` in this review pass.

**Confidence assessment for T-P2-001 readiness.**

The design doc is structurally sound — three-process architecture is clear; decisions Q1-Q7 are well-rationalized with explicit rejected alternatives; the deferral list at §2 is realistic. The seven substantive concerns above are not blockers — most can be resolved in a 10-15 minute orchestrator+user clarification round before T-P2-001 dispatches. The most important to resolve pre-T-P2-001 are #2 (duplicate-registration semantics — directly affects Phase 3 scope), #5 (`workspace_untrusted` reachability — affects AC list integrity), and #7 (identifier persistence — affects Phase 3 deliverables).

**Verdict:** docs are 80% ready. A short clarification round resolving the listed concerns lands them at ready. Suggest doing the clarification before dispatching T-P2-001, not during.

End of Clyde review notes.

End of P2 design document.
