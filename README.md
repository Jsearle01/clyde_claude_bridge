# claude-bridge

An MCP bridge that connects Claude.ai project chats to local development workspaces over a Cloudflare tunnel. The bridge daemon hosts a single MCP endpoint, owns the bearer token, writes an audit log, and (in future gates) coordinates job delegation to VS Code workspaces.

**Project status:** P0 (bus validation) is gate-review-ready. The only tool exposed at this gate is `ping` — enough to prove the end-to-end roundtrip Claude.ai → tunnel → daemon → response works with auth. The acceptance harness reports 8 of 10 criteria mechanically verified; 1 awaits a Unix-host run, 1 awaits midnight-rotation observation. P1 (headless delegation) and P2 (VS Code extension) are future gates.

## What is this?

A long-running local daemon publishes one MCP endpoint over a Cloudflare ephemeral tunnel (`*.trycloudflare.com`). An MCP client — MCP Inspector, Claude Code, Claude Desktop, or any HTTP-capable MCP client — connects to that endpoint with a Bearer token. The daemon authenticates, dispatches the request to a registered tool, writes an audit entry, and responds.

P0 ships exactly this surface: one tool (`ping`), one tunnel, one token, one audit log. Subsequent gates add headless job delegation (P1), a VS Code extension for workspace attachment (P2), and operational polish (P3+).

The architecture is intentionally layered:

| Gate | Adds | Status |
|---|---|---|
| P0 | Bus validation: daemon + tunnel + auth + audit + one tool | Gate-ready |
| P1 | Headless delegation: queued jobs + result streaming | Not started |
| P2 | VS Code extension: workspace attachment | Not started |
| P3+ | Polish: last-shell routing, named tunnels, autostart | Not started |

## Prerequisites

- **Node 20.10+** (tested on 20 and 24)
- **npm 10+**
- **`cloudflared`** on PATH or configured at `tunnel.binary` in config:
  - Windows: `winget install --id Cloudflare.cloudflared` (or the installer from [cloudflare/cloudflared releases](https://github.com/cloudflare/cloudflared/releases))
  - macOS: `brew install cloudflared`
  - Linux: distribution package manager or the GitHub release tarball

## Install

```bash
git clone <repo>
cd claude-bridge
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
Token:  cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

The CLI exits; the daemon stays running detached. Subsequent commands work from any directory:

```bash
claude-bridge status     # daemon + tunnel state
claude-bridge tail-log   # stream daemon log
claude-bridge stop       # graceful shutdown
```

Token and tunnel management:

```bash
claude-bridge token rotate    # mint new token; old token immediately invalidated
claude-bridge tunnel restart  # restart cloudflared with a new URL
```

## Connecting an MCP client

Recommended for P0 testing: **[MCP Inspector](https://github.com/modelcontextprotocol/inspector)**

```bash
npx @modelcontextprotocol/inspector
```

In the Inspector UI, set:
- Transport: **Streamable HTTP**
- URL: `<tunnel-url>/mcp`
- Header: `Authorization: Bearer <token>`

Click `Connect`, then `tools/list` should show `ping`. Call it with `{"message": "hello"}` and inspect the response.

**Claude.ai connector UI caveat.** The custom MCP connector in Claude.ai's project settings currently requires OAuth client credentials; static Bearer tokens are not supported. For static-Bearer testing, use MCP Inspector, Claude Code (`claude mcp add --transport http <url>/mcp --header "Authorization: Bearer <token>"`), or Claude Desktop's `mcpServers` config entry. See [`docs/runbook.md`](docs/runbook.md) for full client procedures.

## Where to dive deeper

- [`docs/runbook.md`](docs/runbook.md) — operational procedures, troubleshooting (cloudflared, DNS, Windows quirks), AC verification procedures
- [`docs/design/00-overview.md`](docs/design/00-overview.md) — architecture overview, topology, frozen design decisions
- [`docs/design/01-p0-bus.md`](docs/design/01-p0-bus.md) — P0 specification and acceptance criteria
- [`docs/design/p0-build-plan.md`](docs/design/p0-build-plan.md) — concrete file paths and build order
- [`docs/walkthrough.md`](docs/walkthrough.md) — steady-state UX target (P2)
- [`docs/conventions.md`](docs/conventions.md) — TypeScript / ESM / cross-cutting concerns

## License

Not yet declared. Treat as all-rights-reserved until a license file lands.
