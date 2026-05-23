# claude-bridge — milestones

## Phases (subsystem work)

Phases here align with the gate sequence in `00-overview.md`. Each phase is a body of subsystem work that has its own design doc.

| Phase | Description | Status | Design doc |
|-------|-------------|--------|------------|
| P0 | Bus validation | OPEN | `01-p0-bus.md` |
| P1 | Headless delegation | NOT STARTED | Written after P0 ships |
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
| AC-1 | `claude-bridge start` brings up daemon + tunnel <10s, prints URL and token | IMPLEMENTED | T-0015 (`cli/src/commands/start.ts`, `cli/src/index.ts`) | Acceptance test §1; unit tests on testable helpers (checkCloudflared, checkExistingDaemon, waitForReady); end-to-end smoke validation at T-0019 |
| AC-2 | `claude-bridge status` reports `Daemon: up` and `Tunnel: up` | OPEN | — | Acceptance test §2 |
| AC-3 | Claude.ai project calls `ping(message='hello')` and receives correct response | **VERIFIED** | T-0011 (`mcp/dispatch.ts`, `mcp/tools/ping.ts`); smoke test 2026-05-22 | Smoke test 2026-05-22 via MCP Inspector; PingOutput shape returned correctly with all six fields populated. Claude.ai connector UI cannot satisfy literal AC wording (no Bearer token field); functional satisfaction via MCP Inspector / Claude Code / Claude Desktop. |
| AC-4 | Wrong bearer token returns 401 + audit log entry `allowed:false, reason:"invalid_token"` | IMPLEMENTED | T-0010 (`mcp/auth.ts`, `mcp/server.ts` integration) | Acceptance test §4; unit tests 12.a–12.i + integration tests 15.g/15.h verify; end-to-end verification via curl against running daemon at T-0019 |
| AC-5 | Successful ping produces audit log entry `allowed:true, tool:"ping"` with non-zero duration_ms | **VERIFIED** | T-0011 (`mcp/dispatch.ts` `ToolRegistry.invoke` audit-write path); smoke test 2026-05-22 | Smoke test 2026-05-22 audit entry req_b12f9ac2 with tool="ping", allowed=true, valid input_hash. Integration test 17.c also verifies. |
| AC-6 | Killing cloudflared respawns within 30s with new URL; status reflects new URL | IMPLEMENTED | T-0012 (`tunnel/manager.ts` exit-handler triggers respawn; emits url_change on new URL) | Acceptance test §6; manager.test.ts 15.c/15.d verify mechanism; end-to-end with real cloudflared at T-0019 |
| AC-7 | `claude-bridge stop` cleanly shuts down both processes, removes PID file, flushes audit log | OPEN | — | Acceptance test §7 |
| AC-8 | `claude-bridge token rotate` generates new token, invalidates old (verified 401), prints new | OPEN | — | Acceptance test §8 |
| AC-9 | Daemon refuses to start if `config.json` permissions are looser than 0600 on Unix | IMPLEMENTED (Unix runtime verification pending) | T-0006 (`loadConfig`) | Acceptance test §9; unit test 13.f covers; final verification requires Unix host (skipped on Windows dev host) |
| AC-10 | Audit log rotates at midnight UTC; previous day's file renamed `audit-YYYY-MM-DD.jsonl` | OPEN | — | Acceptance test §10 — manual verification acceptable for v1 |

## Phase-to-task mapping

P0 work decomposes into T-0001 through T-0020. See `project-state.md` task queue. The task list is the operational unit; this milestone doc is the index.

## Cross-AC infrastructure dependencies

Some AC closures depend on infrastructure landed in non-AC-closing tasks. Tracking explicitly so AC verification at T-0019 has a paper trail:

- AC-2 (`claude-bridge status` reports daemon up) — depends on T-0008 (IPC server, status handler shape) and T-0013 (daemon main wires the actual status payload). Verification at T-0019.
- AC-7 (`claude-bridge stop` cleanly shuts down) — depends on T-0008 (IPC stop handler) and T-0013 (daemon main shutdown sequencing). Verification at T-0019.
- AC-9 (daemon refuses on loose perms) — **IMPLEMENTED at T-0006**; final Unix-host verification required before P0 gate close.
