# P0 — Bus Validation

**Status:** Design
**Last updated:** 2026-05-01
**Prerequisite:** None
**Successor:** P1 (headless delegation) — design doc written after P0 ships

## Goals

1. Prove end-to-end MCP roundtrip from a Claude.ai project to a daemon running on the user's machine.
2. Validate the auth and tunnel mechanisms under realistic latency.
3. Establish the daemon process model, config file, and CLI shell that all later gates extend.
4. Lock the wire format for tool requests/responses early so P1+ doesn't have to renegotiate it.

## Non-goals (explicitly deferred)

- No workspace concept. The daemon doesn't track workspaces in P0.
- No VS Code extension. P0 is daemon + CLI only.
- No Claude Code integration. The only tool is `ping`.
- No job queue. `ping` is synchronous.
- No persistence beyond the audit log and the config file.
- No autostart. Daemon is started manually with `claude-bridge start`.
- No webview, no approvals, no auto-attach, no Tier-2 tools.

The point of P0 is to fail cheaply if the bus doesn't work. Everything else is layered on once the bus is proven.

## Sequence diagrams

### Cold start

```
User                CLI                 Daemon              Cloudflared
 │                   │                    │                       │
 │  start            │                    │                       │
 ├──────────────────►│                    │                       │
 │                   │  spawn             │                       │
 │                   ├───────────────────►│                       │
 │                   │                    │  bind 127.0.0.1:7423  │
 │                   │                    │  load config          │
 │                   │                    │  start MCP server     │
 │                   │                    │  spawn cloudflared    │
 │                   │                    ├──────────────────────►│
 │                   │                    │                       │  establish tunnel
 │                   │                    │  parse stdout for URL │◄──────────────────
 │                   │                    │◄──────────────────────┤
 │                   │  print URL + token │                       │
 │                   │◄───────────────────┤                       │
 │  URL + token      │                    │                       │
 │◄──────────────────┤                    │                       │
```

### Ping roundtrip

```
Claude.ai project        Tunnel             Daemon              Audit log
  │                        │                   │                     │
  │  POST /mcp             │                   │                     │
  │  Authorization: Bearer │                   │                     │
  │  body: ping("hello")   │                   │                     │
  ├───────────────────────►├──────────────────►│                     │
  │                        │                   │  validate token     │
  │                        │                   │  dispatch ping      │
  │                        │                   │  build response     │
  │                        │                   ├────────────────────►│
  │                        │                   │   write log line    │
  │                        │  response         │                     │
  │◄───────────────────────┤◄──────────────────┤                     │
```

## The `ping` tool

### Schema

```typescript
{
  name: "ping",
  description: "Roundtrip test. Returns daemon liveness info.",
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Optional echo string. Capped at 1024 chars."
      }
    },
    additionalProperties: false
  }
}
```

### Response shape

```typescript
{
  echo: string | null,            // null if no message provided
  daemon_version: string,         // semver, e.g. "0.1.0"
  uptime_s: number,               // seconds since daemon start
  attached_workspaces: number,    // always 0 in P0
  tunnel_status: "up" | "degraded",
  server_time: string             // ISO 8601 UTC
}
```

`tunnel_status: "degraded"` is reserved for P0 only when cloudflared has reconnected within the last 60s. Future gates may add finer-grained states.

### Validation rules

- `message` capped at 1024 characters; longer requests rejected with `400 invalid_input`.
- Empty body acceptable; treated as `message: null`.

## Auth

- **Token format:** `cb_live_` prefix + 32 random base32 characters. Generated on first daemon start, persisted to config. Rotatable via `claude-bridge token rotate`.
- **Header:** `Authorization: Bearer <token>` on every MCP request.
- **Validation:** constant-time compare against the canonical token in config.
- **Failure mode:** `401 invalid_token` with no body. Recorded in audit log with `allowed: false` and `input_hash` only (never log the presented token).
- **Rotation:** writes new token to config, prints to stdout, invalidates old immediately. User must update Claude.ai connector configuration with the new value.

## Tunnel

### Subprocess

- Daemon spawns `cloudflared tunnel --url http://127.0.0.1:7423` as a child process.
- Stdout parsed line-by-line for the assigned `https://*.trycloudflare.com` URL.
- Tunnel URL surfaced via daemon API and printed by `claude-bridge start`.

### Restart policy

- If cloudflared exits non-zero or stops emitting heartbeats for 30s, daemon respawns it.
- New URL replaces the old. Daemon updates its internal state.
- **User impact:** the public URL changes. User must repaste into Claude.ai connector config. Acceptable in v1; persistent named tunnels are a P3 enhancement.
- After 5 restart attempts in 5 minutes, daemon enters degraded state (`tunnel_status: "degraded"`) and stops auto-respawning. User runs `claude-bridge tunnel restart` to retry.

### Alternatives

- ngrok supported via config flag (`tunnel.provider: "ngrok"`). Same parsing pattern, different binary.
- Default is cloudflared. No registration required for quick tunnels.

## Config file

**Path:** `~/.claude-bridge/config.json` (Linux/Mac), `%APPDATA%/claude-bridge/config.json` (Windows)

**Schema:**

```jsonc
{
  "version": 1,
  "daemon": {
    "bind_host": "127.0.0.1",
    "bind_port": 7423,
    "ipc_socket": "~/.claude-bridge/daemon.sock"
  },
  "auth": {
    "token": "cb_live_a7f3...d219"
  },
  "tunnel": {
    "provider": "cloudflared",
    "binary": "cloudflared",
    "args_extra": []
  },
  "audit": {
    "path": "~/.claude-bridge/audit.jsonl",
    "retention_days": 30
  },
  "log": {
    "path": "~/.claude-bridge/daemon.log",
    "level": "info"
  }
}
```

- Created on first `claude-bridge start` if absent. Token generated then.
- Permissions enforced to `0600` on Unix; daemon refuses to start if perms are looser.
- Schema versioned. Migrations live in `packages/daemon/src/config/migrations/`.

## CLI commands

All commands talk to the daemon over `~/.claude-bridge/daemon.sock` (Unix) or `\\.\pipe\claude-bridge` (Windows). `start` is the exception — it launches the daemon directly.

### `claude-bridge start`

- Reads config; creates default if missing.
- Refuses to start if PID file shows daemon already running (verifies process is alive; clears stale PID).
- Forks daemon, waits up to 5s for it to bind and emit `ready`.
- Prints:
  ```
  Daemon up on 127.0.0.1:7423
  Tunnel: https://plum-otter-7821.trycloudflare.com
  Token:  cb_live_a7f3f20d4e8b6c9a1d219abcd... (32 chars)
  ```
- Exit code 0 on success, non-zero with diagnostic on failure.

### `claude-bridge stop`

- Sends SIGTERM via socket. Daemon shuts down tunnel, closes audit log, removes PID file, exits.
- 10s grace; SIGKILL after.

### `claude-bridge status`

```
Daemon:    up (pid 84231, uptime 2h14m)
Endpoint:  127.0.0.1:7423
Tunnel:    up
URL:       https://plum-otter-7821.trycloudflare.com
Token:     cb_live_…d219 (last 4)
Audit:     ~/.claude-bridge/audit.jsonl (current size: 14 KB)
```

### `claude-bridge tail-log [-f]`

- Streams `daemon.log`. `-f` follows. Plain text passthrough.

### `claude-bridge token rotate`

- Generates new token, writes config, broadcasts to running daemon.
- Prints new token. Old becomes invalid immediately.
- User responsibility: update Claude.ai connector config.

### `claude-bridge tunnel restart`

- Forces tunnel subprocess restart. Useful when stuck in degraded state.
- Returns new URL on success.

### Out of scope for P0

- `claude-bridge list-workspaces` (needs P2)
- Any per-workspace command

## Audit log format

`~/.claude-bridge/audit.jsonl`, one JSON object per line:

```json
{
  "ts": "2026-05-01T18:42:11.043Z",
  "tool": "ping",
  "input_hash": "sha256:8a2c…",
  "allowed": true,
  "duration_ms": 4,
  "result_bytes": 187,
  "request_id": "req_8f2a1b",
  "remote_addr": "tunnel"
}
```

- `input_hash` is sha256 of the canonicalized input JSON. Lets you detect repeated identical calls without recording payloads.
- `allowed: false` entries also record `reason` (e.g. `"invalid_token"`).
- Daily rotation: `audit-2026-05-01.jsonl`. 30-day retention.

## Daemon process model

- Single Node 20 process, ESM.
- Listens on:
  - `127.0.0.1:7423` (configurable) — MCP HTTP endpoint, exposed via tunnel
  - `daemon.sock` — local IPC for CLI
- Background tasks:
  - Tunnel subprocess monitor
  - Audit log rotator (checks midnight)
  - Heartbeat to log every 5 minutes at `info`
- Graceful shutdown on SIGTERM: stop accepting new requests, drain in-flight (none in P0), kill tunnel subprocess, flush logs, exit.

## Acceptance criteria

P0 is complete when **all** of the following are true:

1. `claude-bridge start` brings up the daemon and cloudflared tunnel from a clean state in under 10 seconds, prints the URL and token.
2. `claude-bridge status` reports `Daemon: up` and `Tunnel: up`.
3. With the printed URL and token configured as a custom MCP connector in a Claude.ai project, asking project-Claude to "call the ping tool with message 'hello'" results in a response containing `echo: "hello"`, `daemon_version`, `uptime_s`, and `attached_workspaces: 0`.
4. Calling the MCP endpoint directly with a wrong bearer token returns 401, no payload, and an audit log entry with `allowed: false, reason: "invalid_token"`.
5. The successful `ping` produces an audit log entry with `allowed: true`, `tool: "ping"`, and a non-zero `duration_ms`.
6. Killing cloudflared manually triggers an automatic respawn within 30 seconds, producing a new tunnel URL. `claude-bridge status` reflects the new URL.
7. `claude-bridge stop` cleanly shuts down both the daemon and the tunnel subprocess. PID file is removed. Audit log is flushed.
8. `claude-bridge token rotate` generates a new token, invalidates the old (verified by old-token request returning 401), and prints the new token.
9. Daemon refuses to start if `~/.claude-bridge/config.json` permissions are looser than `0600` on Unix.
10. Audit log rotates at midnight UTC; previous day's file renamed to `audit-YYYY-MM-DD.jsonl`.

Each criterion has a manual test step in the runbook. P0 ships when all 10 pass on a clean machine.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cloudflared quick tunnels rate-limit or block on high traffic | P0 traffic is trivial (one tool). If it bites in P1, document switch to ngrok or named tunnel. |
| Claude.ai MCP connector format changes | Lock the OAuth-bearer + HTTPS pattern that's standard for Anthropic remote MCP. If the format diverges, P0 doc gets a revision. |
| Tunnel URL changes on restart break the connector | Documented in runbook. Persistent named tunnels deferred to P3. |
| Token leaks via shell history | `claude-bridge start` prints once, then config holds the canonical copy. User responsibility to redact when sharing logs. |
| Windows IPC differs from Unix | Named pipe abstraction in shared/ipc.ts. Tested on both at gate. |

## Open questions

None. All previously-flagged decisions are locked in `00-overview.md`. If P0 implementation surfaces new questions, they get logged in this doc as amendments before the gate.

## Out of scope (explicit)

The following are intentionally not part of P0 and require their own design docs:

- **P1:** delegation tools, job queue, Claude Code SDK integration, transcripts.
- **P2:** VS Code extension, workspace registration, Tier-2 tools, auto-attach, webview, toast approvals, deny-list enforcement.
- **P3:** last-shell capture, webview-with-diff approvals, autostart, named tunnels, transcript search.
- **P4:** co-agent mode, multi-window driving, streaming responses.

## Acceptance checklist for the gate review

When P0 is ready to gate, the following must all be in place:

- [ ] All 10 acceptance criteria pass on a clean machine
- [ ] Runbook covers install, start, stop, rotate, status, tail-log
- [ ] Audit log inspected manually for one full day; rotation verified
- [ ] One Claude.ai project successfully configured and exercised
- [ ] Token rotation tested end-to-end (rotate, fail with old, succeed with new)
- [ ] Tunnel-down scenario tested manually; recovery verified
- [ ] No TODO comments in `packages/daemon/src/mcp/` or `packages/cli/src/`
- [ ] P1 design doc started (kicks off the next gate)
