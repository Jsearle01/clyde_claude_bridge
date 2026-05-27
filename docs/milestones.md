# claude-bridge — milestones

## Phases (subsystem work)

Phases here align with the gate sequence in `00-overview.md`. Each phase is a body of subsystem work that has its own design doc.

| Phase | Description | Status | Design doc |
|-------|-------------|--------|------------|
| P0 | Bus validation | **GATE-CLOSED** 2026-05-23 (all 10 ACs VERIFIED) | `01-p0-bus.md` |
| P1 | Headless delegation | **GATE-CLOSED** 2026-05-24 (all 16 ACs MECH/MCP/INFER-VERIFIED; both harnesses pass on Windows + WSL) | `02-p1-delegation.md` |
| P2 | VS Code extension | NOT STARTED | Written after P1 ships |
| P3 | Polish (last-shell, named tunnels, autostart) | NOT STARTED | Written after P2 ships |
| P4 | Stretch (co-agent, multi-window, streaming) | NOT STARTED | Written after P3 ships |

## Integration milestones (convergence)

Integration milestones track when components combine into running, human-verifiable deliverables. They're tracked separately from phases per methodology §18.1.

| Milestone | Description | Status | Depends on |
|-----------|-------------|--------|------------|
| INT-1 | First ping roundtrip from Claude.ai project | OPEN | P0 |
| INT-2 | First delegation runs end-to-end against a test workspace | NOT STARTED | P1 |
| INT-3 | Steady-state multi-workspace UX in VS Code | NOT STARTED | P2 |

## INT-1 blocker list

Derived from the 10 P0 acceptance criteria in `01-p0-bus.md`. When the last blocker closes, INT-1 closes and P0 closes (methodology §18.2).

| ID | Blocker | Status | Verified at | Notes |
|----|---------|--------|-------------|-------|
| AC-1 | `claude-bridge start` brings up daemon + tunnel <10s, prints URL and token | **VERIFIED** | T-0015 (`cli/src/commands/start.ts`, `cli/src/index.ts`); T-0019 acceptance run | Acceptance harness 2026-05-23: cold-start 7.6s (< 10s budget); URL + token extracted from `status` + `config.json` (the harness avoids stdout-capture for `start` due to a Windows file-handle inheritance trap — see T-0019 calibration). T-0019 also raised `READY_TIMEOUT_MS` 5s → 15s to align with daemon's tunnel start budget. |
| AC-2 | `claude-bridge status` reports `Daemon: up` and `Tunnel: up` | **VERIFIED** | T-0016 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 2 PASS; unit tests on formatters + integration tests against real IpcServer cover the failure modes. |
| AC-3 | Claude.ai project calls `ping(message='hello')` and receives correct response | **VERIFIED** | T-0011 + smoke test 2026-05-22 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 3 PASS via `scripts/mcp-ping-client.mjs` (official MCP SDK client over the live cloudflared tunnel); PingOutput shape includes echo/daemon_version/uptime_s/attached_workspaces/tunnel_status/server_time. SMOKE-2 still applies for the connector-UI subset; static-Bearer path works in all SDK-class clients. |
| AC-4 | Wrong bearer token returns 401 + audit log entry `allowed:false, reason:"invalid_token"` | **VERIFIED** | T-0010 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 4 PASS: helper with `--expect-401` flag receives auth rejection; audit log records a recent entry with `allowed:false, reason:"invalid_token"`. Unit tests 12.a-12.i + integration 15.g/15.h still cover the breakdown. |
| AC-5 | Successful ping produces audit log entry `allowed:true, tool:"ping"` with non-zero duration_ms | **VERIFIED** | T-0011 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 5 PASS. T-0019 reactive fix: dispatch.ts switched `Date.now()` → `performance.now()` + `Math.ceil` because ms-granularity rounded sub-ms tools to 0, violating the "non-zero" wording. Integration test 17.c also verifies the entry shape. |
| AC-6 | Killing cloudflared respawns within 30s with new URL; status reflects new URL | **VERIFIED** | T-0012 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 6 PASS: cloudflared killed by PID, daemon's TunnelManager respawned within the window, new URL observed via status (differed from original). manager.test.ts 15.c/15.d cover the mechanism in unit form. Manual `degraded`-recovery path: `claude-bridge tunnel restart` (T-0017). |
| AC-7 | `claude-bridge stop` cleanly shuts down both processes, removes PID file, flushes audit log | **VERIFIED** | T-0016 + T-0008 + T-0013 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 7 PASS: stop returns `Stopped.`, PID file absent after wait. CLI-side unit tests + SMOKE-3 14ms reverse-instantiation cover the breakdown. |
| AC-8 | `claude-bridge token rotate` generates new token, invalidates old (verified 401), prints new | **VERIFIED** | T-0017 + T-0013 + T-0010 + T-0019 acceptance run | Acceptance harness 2026-05-23 step 8 PASS: rotated cb_live_...ZR73 → cb_live_...N35O; old token receives 401, new token successfully pings. End-to-end exercise of the in-memory thunk + on-disk config + auth middleware chain. |
| AC-9 | Daemon refuses to start if `config.json` permissions are looser than 0600 on Unix | **VERIFIED** | T-0006 (`loadConfig`) + T-0019.6 WSL verification 2026-05-23 | Verified on WSL (Ubuntu, Linux 6.6.87.2-microsoft-standard-WSL2). Procedure: first start created config at `-rw-------`; `chmod 0644` then `start` exited 1 with `Daemon failed to start: daemon startup failed: Config file at /home/jaysearle/.claude-bridge/config.json has loose permissions (0644); must be 0600`; `chmod 0600` restored normal start. Full verbatim transcript in T-0019.6 report. Windows hosts intentionally no-op the check (CC-3). |
| AC-10 | Audit log rotates at midnight UTC; previous day's file renamed `audit-YYYY-MM-DD.jsonl` | **VERIFIED** (MANUAL-VERIFIED-AT-GATE per gate close 2026-05-23) | T-0007 (`audit/log.ts` hybrid midnight timer + per-append guardrail) + T-0019 acceptance run | Acceptance harness 2026-05-23 step 10 SKIP with note: rotation requires either a 24-hour wait or a clock-fake harness. Unit tests in T-0007 audit/log.test.ts cover the mechanism; live midnight rotation reviewed manually at P0 gate. |

## P1 — Headless Delegation

P1 design at `docs/design/02-p1-delegation.md`. 16 acceptance criteria, tagged per methodology v0.4 §29.4 (`[MECH]` / `[SMOKE]` / `[INFER]`). Build plan at `docs/design/p1-build-plan.md` slices the work into 14 build phases. Tasks land in `project-state.md` as T-P1-NNN. Per-AC closure tracking will populate this section as work lands.

| Build phase | Task(s) | Status |
|---|---|---|
| Phase 1 — Shared types | T-P1-001 | COMPLETE (bundled in T-P1-001.5 commit) |
| (infra) | T-P1-001.5 | P1 design handoff + github.com remote |
| (infra) | T-P1-001.6 | README factual correction; gh CLI installed + authenticated; T-P1-001.5 AC-6 visibility=PUBLIC mechanically verified |
| Phase 2 — Workspace registry stub | T-P1-002 | COMPLETE |
| Phase 3 — Job queue + state machine | T-P1-003 | COMPLETE |
| Phase 4 — Tool surface | T-P1-004 | COMPLETE |
| Phase 5 — Acceptance harness skeleton | T-P1-005 | COMPLETE |
| Phase 6 — Transcript writer | T-P1-006 | COMPLETE |
| Phase 7 — Snapshot + diff | T-P1-007 | COMPLETE |
| Phase 8 — Report assembler | T-P1-008 | COMPLETE |
| Phase 9 — Claude Code SDK integration | T-P1-009 | COMPLETE |
| Phase 10 — Cancellation cross-platform + live SMOKE on Win + WSL | T-P1-010 | COMPLETE |
| Phase 11 — Acceptance harness MCP-path SMOKE expansion | T-P1-011 | COMPLETE |
| Phase 12 — WSL cross-platform run | T-P1-012 | COMPLETE |
| Phase 13 — Runbook + walkthrough | T-P1-013 | COMPLETE |
| Phase 14 — P1 gate close | T-P1-014 | COMPLETE |
| (post-gate) | T-P1-015 | COMPLETE |
| (pre-P2) | T-P2-000-review | COMPLETE |
| (pre-P2) | T-P2-000-refinement | COMPLETE — applied 9 dispatched resolutions (3 blockers + 6 concerns) from review verdict + 1 reactive cross-reference fix; v0_6_candidates seeded with C-1 through C-10; design artifacts ready to drive T-P2-001 |
| P2 Phase 1 | T-P2-001 | COMPLETE |
| P2 Phase 2 | T-P2-002 | COMPLETE |
| P2 Phase 3 | T-P2-003 | COMPLETE |
| P2 Phase 4 | T-P2-004 | COMPLETE (with T-P2-004.5 follow-up) |
| (T-P2-004 followup) | T-P2-004.5 | COMPLETE (insufficient — see T-P2-004.6) |
| (T-P2-004 followup #2) | T-P2-004.6 | COMPLETE |
| P2 Phase 5 | T-P2-005 | COMPLETE |
| P2 Phase 6 | T-P2-006 | COMPLETE (with T-P2-006.5 follow-up) |
| (T-P2-006 followup) | T-P2-006.5 | COMPLETE, awaiting verdict — field-vs-state-ordering fix in WorkspaceRegistration. T-P2-007.5 manual verification surfaced status bar showing `(no identifier)` for a registered workspace because `setState("registered")` fired the onStateChange callback BEFORE `this.identifier = ...` was assigned. 3 defective `setState` sites in `packages/extension/src/registration.ts` reordered (lines 117/118, 147/148, 175/176) — identifier/existingPid assignments now precede setState. 10 other setState sites audited; no field dependencies present. 3 regression tests added in `tests/registration.test.ts`; pre-fix verification confirmed test catches the bug (expected null vs `"myproject-54ab07"`). **Closes C-26**. Tests 535 passing + 15 skipped (+3 net). Lint clean (C-25 fresh-verified). .vsix repackaged at 18.03 KB/11 files via `vsce package --no-dependencies`. AC-10 operator-side reload step is the final user-observable confirmation. |
| (T-P2-007 followup) | T-P2-007.5 | COMPLETE, awaiting verdict — Windows path case-insensitivity at workspace registry lookup. New `packages/shared/src/path.ts` exporting `normalizeAbsPath(p)` (lowercase on Windows, identity on Unix). `WorkspacesStore.findByPath` normalizes both query and stored values before comparison; stored `abs_path` preserves original case for display/audit/cwd. `WorkspacesStore.load()` runs `dedupeOnLoad`: detects entries with colliding normalized abs_path, retains earliest by `trusted_at`, removes the rest, emits a per-removal warn log via injected optional `Logger`, rewrites `workspaces.json` to canonical state. Idempotent — no-op after first run. **Closes C-24**. Manual Windows verification PASS: pre-state 3 entries with `c:\Projects\clyde_claude_bridge` (54ab07, 2026-05-25) + `c:\Temp\clyde-bridge-dup` + `c:\projects\clyde_claude_bridge` (06e146, 2026-05-26); post-startup workspaces.json has 2 entries with 54ab07 canonical retained + lowercase removed; daemon.log shows warn `workspaces.json dedupe: removed duplicate entry` with all 4 fields populated. **Tests:** +7 daemon (case-variant lookup on Windows, abs_path preserves case, case-sensitive on Unix, dedupe-by-trusted_at, dedupe-rewrites-disk, no-op-when-no-dupes, three-way-dedupe) +6 shared (path.test.ts: identity-linux, identity-darwin, lowercase-windows, idempotent, UNC-windows, UNC-unix). 532 passing + 15 skipped (was 519+15; +13 net). **Out-of-scope user-requested addition mid-task:** 10 pre-existing lint errors in extension + CLI test files cleaned up — latent in commit b0b8586 (T-P2-007); the "lint clean" claim in T-P2-007's verdict was contradicted by actual `npm run lint`. New v0.6 candidate **C-25** logged (verdict-claim verification: orchestrator-side memory-asserted streak counters can drift from actual workspace state if not freshly run). |
| (T-P2-008 followup #2) | T-P2-008.6 | COMPLETE, awaiting verdict — CLAUDE_BRIDGE_DEBUG diagnostic instrumentation for C-29 (extension stuck at "registering" state after T-P2-008.5 .vsix install). New `packages/extension/src/diag.ts` helper (`diag(msg, data?)` gated on `process.env.CLAUDE_BRIDGE_DEBUG === '1' \|\| 'true'`; `[cb-diag]` prefix automatic; module-load-time const resolution). 8 `diag()` call sites: 2 in `extension.ts` (activate entry/complete), 3 in `registration.ts` (1 centralized inside `setState` covering all 13 transition sites + 2 catch boundaries), 6 in `ipc/client.ts` (connect entry, doConnect socket-creating, sock.on connect/error/close, request send). New `tests/diag.test.ts` with 6 cases. No behavior change when env var unset. **Adopts new C-25.c sub-rule** (operator-performed runtime smoke for build/packaging-pipeline tasks; agent verdict can commit on agent-verifiable ACs, follow-up tasks blocked until smoke captured). **C-29 added** to v0.6 candidates table (open, blocks AC-24). Tests: 114 passing + 15 skipped extension-side (+6 net); workspace-root 604+15 (+6). Lint clean (C-25 fresh-verified). .vsix repackaged at 93.05 KB / 5 files; `grep -c "@claude-bridge/"` → 0 (C-25.b). Operator runtime smoke is the input to the C-29 fix task. |
| (T-P2-008 followup) | T-P2-008.5 | COMPLETE, awaiting verdict — Extension `.vsix` bundling fix via esbuild. tsc-only emit left package-name imports of `@claude-bridge/shared` in `dist/extension.js`; Node's ESM loader in VS Code's extension host couldn't resolve workspace siblings at runtime (vsce `--no-dependencies` strips workspace deps from the package). esbuild now bundles `src/extension.ts` → single `dist/extension.js` (581 KB, CJS, `vscode` external); tsc kept for type-checking only (`noEmit: true`; `composite` dropped). New regression test asserts no external `@claude-bridge/*` imports in bundled output. `.vsix` size dropped from 20.91 KB / 12 files (per-module emit) to 92.63 KB / 5 files (one bundled .js). **Closes C-28**; unblocks AC-24 retry. New v0.6 sub-rule C-25.b (bundled-artifact verification) documented. Tests: 598 passing + 15 skipped (+4 net). Lint clean (C-25 fresh-verified). |
| P2 Phase 8 | T-P2-008 | COMPLETE — per-delegation approval flow (auto / per_call / session_bypass). First daemon-initiated IPC mechanism via new `IpcServerMessageSchema` discriminated union (with `approval_request` variant). Daemon: `ApprovalGate` composes WorkspacesStore + `PendingApprovalRegistry` (5-min timeout) + extension-IPC sender; `delegate.ts` handler inserts gate between exhibits-caps and enqueue. Approval layer joins layered shutdown sequence (logs `shutdown layer stopped layer:approval`). Extension: `IpcClient.onApprovalRequest` (4th instance of single-subscriber callback pattern) + modal via `showWarningMessage({modal: true})` with 3 buttons (Approve / Approve for this session / Deny; dismissal → deny). Status-bar menu gains "Change approval mode" item opening secondary QuickPick. `workspaces.json` schema additively extended with optional `mode` field (default `per_call` on read). `register_workspace_ok` carries optional mode. New `set_workspace_mode` / `set_workspace_mode_ok` / `approval_response` IPC variants. **Files:** 6 new (`daemon/approval/{pending,gate}.ts`, `extension/approval-modal.ts`, `daemon/tests/approval/{pending,gate}.test.ts`, `daemon/tests/integration/approval-flow.test.ts`, `extension/tests/approval-modal.test.ts`) + 9 modified (shared/{ipc,workspace}.ts, daemon/{main,mcp/tools/delegate,ipc/server,workspace/store}.ts, extension/{extension,registration,status-bar,status-bar-menu,ipc/client}.ts) + 2 test extensions (daemon/mcp/tools/delegate.test.ts +8 approval cases; extension/tests/status-bar-menu.test.ts +8 mode-change cases). **Tests:** 594 passing + 15 skipped (was 532+15; **+62 net**: daemon +38, extension +24). Lint clean (C-25 fresh-verified). **C-26 compliance:** new `currentMode` field on WorkspaceRegistration is assigned BEFORE `setState("registered")` at both register_workspace_ok call sites (mirrors T-P2-006.5 invariant). **Manual verification:** .vsix repackaged at 20.91 KB / 12 files (added `approval-modal.js`); reinstalled on Windows; daemon restarted; `daemon.log` shows new `approval gate initialized` info line; integration test (AC-21) exercises full daemon ↔ extension ↔ daemon wire round-trip. AC-24 final claude.ai end-to-end is operator-side. |
| P2 Phase 7 | T-P2-007 | COMPLETE — workspace registry replacement. P1's `StubWorkspaceRegistry` removed from production; new `WorkspaceRegistryImpl` backed by `WorkspacesStore` (T-P2-003) + read-only getter for IpcServer's `activeRegistry`. Interface preserved verbatim (`resolve`/`list`/`default`) — all callers (`SdkJobRunner`, `delegate.ts`) unchanged. P2 semantic shifts: `resolve(undefined)` → null; `default()` → null always; `list()` reads trusted workspaces from persistent store. **Wire format:** `DelegateInputSchema.workspace` now required (dropped `.optional()`); daemon enforces `503 no_workspace_registered` on unknown identifiers (collapsed P1's two-branch error: `no_workspace_configured` + `workspace_not_found` → single `no_workspace_registered`). **Closes C-23**: daemon's main.ts now loads `WorkspacesStore` before constructing the registry, with a forward-declared `ipcServerRef` thunk for the activeRegistry getter (registry needs both, ipcServer is built later). New AC-12 integration test exercises daemon-restart-against-pre-populated-store. `ipc/server.ts` exports `ActiveRegistration` interface + new `getActiveRegistry()` read-only accessor. delegate.test.ts + sdk-runner.test.ts switch from `StubWorkspaceRegistry` to small inline `makeTestRegistry()` helpers. shared/tests/delegation.test.ts updated for the new required-workspace shape (4 tests adjusted + 1 new for the rejection case). Tests 519/519 passing + 15 skipped (+3 net: daemon +2 from registry rewrite; shared +1). One new v0.6 candidate: C-23 (fresh-state-assumption test antipattern). |

Phase 4/5 swap applied during T-P1-001 verdict (tool surface must precede harness so the harness can exercise the MCP path); reflected in `p1-build-plan.md` and `orchestrator-context-p1-open.md`.

## Phase-to-task mapping

P0 work decomposes into T-0001 through T-0020. See `project-state.md` task queue. The task list is the operational unit; this milestone doc is the index.

## Cross-AC infrastructure dependencies

Some AC closures depend on infrastructure landed in non-AC-closing tasks. Tracking explicitly so AC verification at T-0019 has a paper trail:

- AC-2 (`claude-bridge status` reports daemon up) — depends on T-0008 (IPC server, status handler shape) and T-0013 (daemon main wires the actual status payload). Verification at T-0019.
- AC-7 (`claude-bridge stop` cleanly shuts down) — depends on T-0008 (IPC stop handler) and T-0013 (daemon main shutdown sequencing). Verification at T-0019.
- AC-9 (daemon refuses on loose perms) — **IMPLEMENTED at T-0006**; final Unix-host verification required before P0 gate close.
