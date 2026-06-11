# claude-bridge

**Repository:** https://github.com/Jsearle01/clyde_claude_bridge

An MCP bridge that connects Claude.ai project chats to local development workspaces over a Cloudflare tunnel. The bridge daemon hosts a single MCP endpoint, authenticates clients via per-workspace OAuth bound tokens, writes an audit log, and coordinates headless delegations to a Claude Code SDK sub-agent running against a configured workspace. Delegations enqueue, run to completion (or cancel), and return a structured report with diff, files-changed, transcript URI, and shell-command record.

**Project status:** **P0 GATE-CLOSED 2026-05-23**; **P1 GATE-CLOSED 2026-05-24**. P2 (VS Code extension) is a future gate; design conversation pending. All 10 P0 ACs VERIFIED; all 16 P1 ACs MECH/MCP/INFER-VERIFIED on both Windows and WSL Ubuntu. The current tool surface: `ping`, `delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`. See [`docs/snapshot/orchestrator-context-p1-close.md`](docs/snapshot/orchestrator-context-p1-close.md) for the full P1 close snapshot.

## What is this?

A long-running local daemon publishes one MCP endpoint over a Cloudflare ephemeral tunnel (`*.trycloudflare.com`). An OAuth-capable MCP client (e.g. Claude.ai's custom connector) connects to that endpoint, completes the OAuth binding flow (DCR → consent → workspace-bound token), and the daemon authenticates the bound token, dispatches the request to a registered tool, writes an audit entry, and responds.

P0 shipped the bus. P1 shipped the delegation surface: `delegate_to_claude_code` enqueues an SDK-driven Claude Code session against a configured workspace; `poll_delegation` long-polls for completion (event-driven, no busy-wait); `cancel_delegation` aborts via AbortController. The runner is single-concurrent in P1. Read-only delegations enforce a `disallowedTools` belt-and-suspenders to prevent the SDK's plan-mode `ExitPlanMode` escape hatch. Transcripts persist as JSONL at `~/.claude-bridge/transcripts/{job_id}.jsonl`; reports include git/fallback diff, files-created/modified/deleted, shell commands, and truncation reason if any.

The architecture is intentionally layered:

| Gate | Adds | Status |
|---|---|---|
| P0 | Bus validation: daemon + tunnel + auth + audit + one tool | **GATE-CLOSED** 2026-05-23 |
| P1 | Headless delegation: queued jobs, SDK integration, snapshot/diff, transcripts, cross-platform | **GATE-CLOSED** 2026-05-24 |
| P2 | VS Code extension + workspace registration + approval flow + inspection tools | **GATE-CLOSED** 2026-05-30 |
| P3+ | Polish: last-shell routing, named tunnels, autostart | Not started |

## Prerequisites

- **Node 22 LTS recommended.** Hard floor 20.10 for the daemon; 20.19+ silences the SDK engine warning; undici@8 (transitive dev-dep used by the MCP delegate client's DNS workaround) needs ≥22.19. See [`docs/runbook.md`](docs/runbook.md#node-engine-guidance) for the full matrix.
- **npm 10+**
- **`cloudflared`** on PATH or configured at `tunnel.binary` in config:
  - Windows: `winget install --id Cloudflare.cloudflared` (or the installer from [cloudflare/cloudflared releases](https://github.com/cloudflare/cloudflared/releases))
  - macOS: `brew install cloudflared`
  - Linux: distribution package manager or the GitHub release tarball
- **`ANTHROPIC_API_KEY`** in the shell that starts the daemon — required for live delegations (the daemon's child process inherits the env var). Get one from [console.anthropic.com](https://console.anthropic.com). Without the key, `ping` still works; `delegate_to_claude_code` reaches the SDK runner and fails with `error.category: "auth"`. The key is never written to disk by claude-bridge.

## Install

```bash
git clone https://github.com/Jsearle01/clyde_claude_bridge.git
cd clyde_claude_bridge
npm install
npm run build
cd packages/cli
npm link
```

Verify:

```bash
claude-bridge --version
# 0.1.0
```

`npm link` registers `claude-bridge` as a global command pointing at your built workspace; rebuilding picks up changes automatically. To unlink: `npm unlink -g @claude-bridge/cli`.

## Quick start

```bash
claude-bridge start
```

Output:

```
Daemon up on 127.0.0.1:7423
Tunnel: https://random-words-here.trycloudflare.com
```

The CLI exits; the daemon stays running detached. Subsequent commands work from any directory:

```bash
claude-bridge status     # daemon + tunnel state
claude-bridge tail-log   # stream daemon log
claude-bridge stop       # graceful shutdown
```

Tunnel management:

```bash
claude-bridge tunnel restart  # restart cloudflared with a new URL
```

## Connecting an MCP client

The daemon authenticates via the **OAuth binding flow** — a client registers
(RFC 7591 DCR), the operator consents (per-workspace), and the daemon issues a
**workspace-bound** access token. There is no static Bearer: every connection is
bound to exactly one workspace, consent-gated, and revocable (`claude-bridge
unbind`). This is the model Claude.ai's custom MCP connector uses.

Point the connector at `<tunnel-url>/mcp` and complete the OAuth consent prompt;
the daemon binds the resulting token to the workspace you approve. `tools/list`
then shows `ping`, `delegate_to_claude_code`, `poll_delegation`,
`cancel_delegation`. A typical delegation flow: call `delegate_to_claude_code`
with `{"prompt": "...", "mode": "agentic"}` to enqueue, then `poll_delegation`
with `{"job_id": "...", "wait_ms": 30000}` until the response includes a `report`
field. See the [runbook's Operating Delegations section](docs/runbook.md#operating-delegations-p1)
for tool semantics and the [walkthrough](docs/walkthrough.md) for end-to-end usage.

> **Note (T-BEARER-1):** the legacy unconstrained static Bearer was removed —
> OAuth-bound is the only auth model. A non-OAuth MCP client (raw `curl`, a
> static-token-only connector) can no longer authenticate.

## P2 — VS Code Extension + Real Workspace Registration

**Status: GATE-CLOSED 2026-05-30.** See [`docs/snapshot/orchestrator-context-p2-close.md`](docs/snapshot/orchestrator-context-p2-close.md) for the close report.

P2 ships the developer workflow end-to-end via Bearer-compatible MCP clients
(Claude Code CLI, MCP Inspector, Claude Desktop, raw curl):

- VS Code extension installs via `.vsix` sideload
- Workspace registration with one-time trust prompt
- Daemon-side workspace registry
- Per-delegation approval flow with three modes (`per_call`, `session_bypass`, `auto`)
- Read-only inspection tools (`get_open_editors`, `get_diagnostics`)
- Multi-workspace routing via explicit `workspace` argument
- Cross-platform validated on Windows + WSL Ubuntu

Claude.ai project-chat integration via the connector UI is deferred to P3
pending OAuth implementation in the daemon's auth layer (C-27).

See `docs/walkthrough.md` Part 1 for end-to-end usage examples.

## Where to dive deeper

- [`docs/runbook.md`](docs/runbook.md) — operator reference: prerequisites, installation, configuration, lifecycle, operating delegations, troubleshooting (WSL pre-flight, undici warning, cloudflared per OS, Node engine matrix), MCP client setup, AC verification procedures, uninstallation
- [`docs/walkthrough.md`](docs/walkthrough.md) — contributor narrative: steady-state UX target (P2+) followed by the "P1 — Delegation surface" section covering job lifecycle, MCP tools, snapshot/diff, transcripts, report assembly, SDK integration with the `READ_ONLY_DISALLOWED_TOOLS` belt-and-suspenders rationale, acceptance harnesses, CC-1 through CC-6 cross-platform discipline
- [`docs/design/00-overview.md`](docs/design/00-overview.md) — architecture overview, topology, frozen design decisions
- [`docs/design/01-p0-bus.md`](docs/design/01-p0-bus.md) — P0 specification and acceptance criteria
- [`docs/design/02-p1-delegation.md`](docs/design/02-p1-delegation.md) — P1 specification: tool schemas, 16 acceptance criteria, modes, snapshot/diff, transcripts
- [`docs/design/p0-build-plan.md`](docs/design/p0-build-plan.md) — P0 concrete file paths and build order
- [`docs/design/p1-build-plan.md`](docs/design/p1-build-plan.md) — P1 concrete file paths and build order
- [`docs/snapshot/orchestrator-context-p0-close.md`](docs/snapshot/orchestrator-context-p0-close.md) — P0 close snapshot
- [`docs/snapshot/orchestrator-context-p1-close.md`](docs/snapshot/orchestrator-context-p1-close.md) — P1 close snapshot (16 ACs, 14 phases, calibration summary, pattern inventory, P2 deferrals)
- [`docs/claude-orchestrated-methodology-v0_6.md`](docs/claude-orchestrated-methodology-v0_6.md) — methodology in effect (dual-band reporting, docs-vs-runtime pattern, harness brittleness defense, CC-N artifacts, numbered C-N conventions including pre-dispatch grep + mandatory elapsed-time block, verdict-time evidence sub-rules)
- [`docs/conventions.md`](docs/conventions.md) — TypeScript / ESM / cross-cutting concerns

## License

Not yet declared. Treat as all-rights-reserved until a license file lands.
