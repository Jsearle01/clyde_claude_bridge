# claude-bridge — milestones

## Phases (subsystem work)

Phases here align with the gate sequence in `00-overview.md`. Each phase is a body of subsystem work that has its own design doc.

| Phase | Description | Status | Design doc |
|-------|-------------|--------|------------|
| P0 | Bus validation | **GATE-CLOSED** 2026-05-23 (all 10 ACs VERIFIED) | `01-p0-bus.md` |
| P1 | Headless delegation | IN PROGRESS (Phase 1 — Shared types) | `02-p1-delegation.md` |
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
| Phase 10 — Cancellation cross-platform + live SMOKE on Win + WSL | T-P1-010 | COMPLETE, awaiting verdict (5/5 SMOKE on both platforms; AC-5/6/8/9 MECH-VERIFIED; reactive read_only hardening via `disallowedTools`) |
| Phase 11 — Acceptance harness expansion | — | not started |
| Phase 12 — WSL cross-platform run | — | not started |
| Phase 13 — Runbook + walkthrough | — | not started |
| Phase 14 — P1 gate close | — | not started |

Phase 4/5 swap applied during T-P1-001 verdict (tool surface must precede harness so the harness can exercise the MCP path); reflected in `p1-build-plan.md` and `orchestrator-context-p1-open.md`.

## Phase-to-task mapping

P0 work decomposes into T-0001 through T-0020. See `project-state.md` task queue. The task list is the operational unit; this milestone doc is the index.

## Cross-AC infrastructure dependencies

Some AC closures depend on infrastructure landed in non-AC-closing tasks. Tracking explicitly so AC verification at T-0019 has a paper trail:

- AC-2 (`claude-bridge status` reports daemon up) — depends on T-0008 (IPC server, status handler shape) and T-0013 (daemon main wires the actual status payload). Verification at T-0019.
- AC-7 (`claude-bridge stop` cleanly shuts down) — depends on T-0008 (IPC stop handler) and T-0013 (daemon main shutdown sequencing). Verification at T-0019.
- AC-9 (daemon refuses on loose perms) — **IMPLEMENTED at T-0006**; final Unix-host verification required before P0 gate close.
