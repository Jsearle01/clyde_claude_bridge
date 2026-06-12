# claude-bridge

**Repository:** https://github.com/Jsearle01/clyde_claude_bridge

claude-bridge connects a Claude.ai project chat to a local VS Code workspace. Each workspace runs its own **daemon** — an MCP server exposed over a Cloudflare tunnel, authenticated by a per-workspace OAuth binding — and a **VS Code extension** discovers, launches, and monitors it. From the project chat, Claude.ai delegates work to a headless Claude Code SDK sub-agent running against the bound workspace; delegations enqueue, run to completion (or cancel), and return a structured report (diff, files-changed, transcript URI, shell-command record).

The architecture is **daemon-per-workspace** (ADR-001): one workspace = one daemon = one tunnel URL = one named connector in Claude.ai. Isolation is **physical** (separate processes), not logical.

## What it is

A long-running local daemon publishes one MCP endpoint over a Cloudflare tunnel (`*.trycloudflare.com`). Claude.ai's custom MCP connector connects to that endpoint and completes the **OAuth binding flow** (register via RFC 7591 DCR → operator consent → workspace-bound access token); the daemon authenticates the bound token, dispatches the request to a registered tool, writes an audit entry, and responds. Each daemon serves exactly the one workspace its binding names.

The MCP tool surface: `ping`, `delegate_to_claude_code` (enqueues an SDK-driven Claude Code session against the bound workspace), `poll_delegation` (event-driven long-poll for completion, no busy-wait), `cancel_delegation` (aborts via AbortController), plus read-only inspection tools (`get_open_editors`, `get_diagnostics`). Transcripts persist as JSONL under the daemon's config-dir; reports include git/fallback diff, files created/modified/deleted, shell commands, and any truncation reason.

| Gate | Adds | Status |
|---|---|---|
| P0 | Bus validation: daemon + tunnel + auth + audit + one tool | **GATE-CLOSED** 2026-05-23 |
| P1 | Headless delegation: queued jobs, SDK integration, snapshot/diff, transcripts, cross-platform | **GATE-CLOSED** 2026-05-24 |
| P2 | VS Code extension + workspace registration + approval flow + inspection tools | **GATE-CLOSED** 2026-05-30 |
| P3′ | Per-workspace binding (ADR-001 daemon-per-workspace), OAuth-only auth (T-BEARER-1), the full multi-daemon CLI (T-CLI), tunnel lifecycle (T-TUNNEL-1) | **SHIPPED** |
| next | The autonomous-collaboration LOOP layer (restructure-reissue, retry limit, loop logging); the operator cycle dashboard; stable named tunnels (ADR-002, opt-in) | In progress / opt-in |

The current design authority is [`docs/design/05-autonomous-collaboration-model.md`](docs/design/05-autonomous-collaboration-model.md) (the binding/isolation model, the per-operation granularity clamp, the autonomy floor, and §9 — what has shipped). The phase build records (`docs/design/00`–`04`) are historically stamped; where they and `05` conflict, `05` wins.

---

# For operators — running the bridge

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

The VS Code extension ships as a `.vsix` sideload (`packages/extension`) — it discovers and launches the workspace's daemon, shows daemon/tunnel state in the status bar, and surfaces the consent + tunnel-drop modals.

## Start a daemon for a workspace

Each workspace gets its **own** daemon (ADR-001) — its own config-dir, its own tunnel URL, its own connector in Claude.ai:

```bash
claude-bridge start --workspace /path/to/your/workspace --name my-project
```

Output:

```
Daemon up on 127.0.0.1:7423
Tunnel: https://random-words-here.trycloudflare.com
```

The CLI exits; the daemon runs detached. (The VS Code extension can launch the daemon for the current workspace folder for you.)

## Connect it to Claude.ai (OAuth binding)

The daemon authenticates via the **OAuth binding flow only** — there is no static Bearer / manual-client connection. In Claude.ai's project settings, add a custom MCP connector pointing at **`<tunnel-url>/mcp`** and complete the OAuth consent prompt; the daemon binds the resulting token to the workspace you approve. The binding is **workspace-bound, consent-gated, and revocable** (`claude-bridge unbind`); a non-bound credential is rejected.

Once connected, `tools/list` shows `ping`, `delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`. A typical delegation: call `delegate_to_claude_code` with `{"prompt": "...", "mode": "agentic"}` to enqueue, then `poll_delegation` with `{"job_id": "...", "wait_ms": 30000}` until the response includes a `report` field. See the [runbook's Operating Delegations section](docs/runbook.md#operating-delegations-p1) and the [walkthrough](docs/walkthrough.md) for end-to-end usage.

## Managing daemons — the CLI

The CLI is **multi-daemon**: target a specific daemon with `--name` or `--workspace`; a bare command acts on the sole daemon if exactly one runs, and lists / offers a numbered pick (for non-destructive verbs) when several do.

| command | what it does |
|---|---|
| `start --workspace <path> [--name <n>]` | launch a daemon for a workspace |
| `stop [--name\|--workspace]` | graceful shutdown |
| `status [--name\|--workspace]` | daemon + tunnel + bindings state (bare = all daemons) |
| `list` | what daemons exist — name, workspace, live/dead |
| `directories` | where each daemon's files live on disk (verify before pruning) |
| `delete-dir --name <n>` (or `--hash <h>`) | prune a daemon's config-dir; confirms on a live target, then graceful-stops it before deleting |
| `unbind [--name\|--workspace]` | list a daemon's OAuth bindings; revoke one by typed target (or `--all`) |
| `tail-log [-f]` | stream a daemon's log |
| `tunnel restart` | restart cloudflared with a new URL |

## Tunnel behavior

A daemon owns **exactly one** cloudflared tunnel for its life (kill-before-respawn; reclaims an orphaned tunnel on startup). If the tunnel drops and respawns with a **new URL**, you **confirm adopting it** (via the extension modal) — never a silent swap; re-point the Claude.ai connector at the new URL after you adopt it. Stable named tunnels (a fixed URL) are an operator **opt-in** (ADR-002; needs a domain — currently optional/deferred).

---

# For contributors — architecture

## Components

- **daemon** (`packages/daemon`, TypeScript/Node) — the MCP server, the OAuth auth layer (per-workspace bound tokens), the cloudflared tunnel manager, the job queue + Claude Code SDK runner, the audit log, the approval gate.
- **VS Code extension** (`packages/extension`, ships as `.vsix`) — daemon discovery/launch, the status bar, workspace registration (one-time trust prompt), and the consent + tunnel-drop modals.
- **CLI** (`packages/cli`) — multi-daemon management (the command table above), built on a shared daemon selector + a single surface-tested list renderer.
- **shared** (`packages/shared`) — the config and IPC schemas (zod), shared by daemon and CLI.

## Topology — daemon-per-workspace (ADR-001)

Each workspace runs its own daemon, keyed by a hash of the workspace path, with its own config-dir (`%APPDATA%/claude-bridge/<hash>/` on Windows, `~/.claude-bridge/<hash>/` elsewhere), its own IPC pipe/socket, its own tunnel URL, and its own named connector in Claude.ai. Connectors are account-global and URL-keyed in Claude.ai but **enabled per-project** — that is the isolation seam. Isolation is **physical by construction**: one daemon is a separate process and cannot see another daemon's workspace.

## Auth — OAuth-bound is the only model (T-BEARER-1)

The daemon authenticates via the OAuth binding flow only. A presented token must resolve to a workspace-bound binding (`{kind:"bound", workspace}`) or it is rejected (`invalid_token`). The legacy unconstrained static Bearer (and `token rotate`, and the `Token:`/`Bearer:` surface) was **removed** — there is no manual-client / non-OAuth path. Because every connection is now bound, the **per-workspace targeting enforcement** and the **operator approval clamp** apply to *every* connection — no unconstrained bypass. Bindings are consent-gated and revocable (`unbind`).

## Connection path

```
Claude.ai project chat
  → custom MCP connector (the workspace's tunnel URL)
    → cloudflared tunnel
      → daemon (OAuth-authenticated; bound to the workspace)
        → MCP tool dispatch (approval gate)
          → headless Claude Code SDK against the local VS Code workspace
```

## Design authority

- [`docs/design/05-autonomous-collaboration-model.md`](docs/design/05-autonomous-collaboration-model.md) — **the current design authority**: the binding/isolation model (§3), per-operation granularity + the tighten-only clamp (§4), the autonomy floor and gate boundary (§5–6), and §9 reconciliation (what has shipped). The architectural decisions **ADR-001** (daemon-per-workspace) and **ADR-002** (stable-tunnel opt-in) are referenced throughout the design docs; daemon-per-workspace is implemented per the P3′ build sequence.
- [`docs/design/04-p3-oauth.md`](docs/design/04-p3-oauth.md) — OAuth mechanics (DCR, consent, bound-token lookup); topology + Bearer-coexistence portions are superseded (stamped).
- [`docs/design/00-overview.md`](docs/design/00-overview.md) – [`03-p2-extension.md`](docs/design/03-p2-extension.md) — phase build records (historically stamped; one-daemon-many-workspaces + static-Bearer portions superseded).

## Build / dev

```bash
npm install          # install workspace deps (npm workspaces monorepo)
npm run build        # tsc -b across packages + esbuild bundle for the extension
npm test             # vitest, per workspace
npm run lint         # eslint (flat config, recommendedTypeChecked)
```

`packages/{daemon,extension,cli,shared}` are npm workspaces. See [`docs/conventions.md`](docs/conventions.md) for the TypeScript / ESM / cross-cutting conventions.

---

## Where to dive deeper

- [`docs/runbook.md`](docs/runbook.md) — operator reference: prerequisites, installation, configuration, lifecycle, operating delegations, troubleshooting (WSL pre-flight, undici warning, cloudflared per OS, Node engine matrix), AC verification, uninstallation
- [`docs/walkthrough.md`](docs/walkthrough.md) — contributor narrative: steady-state UX, the delegation surface (job lifecycle, MCP tools, snapshot/diff, transcripts, report assembly), SDK integration with the read-only `disallowedTools` rationale, acceptance harnesses, cross-platform discipline
- [`docs/design/05-autonomous-collaboration-model.md`](docs/design/05-autonomous-collaboration-model.md) — the current design authority (binding, granularity clamp, autonomy floor, shipped-reconciliation §9)
- [`docs/design/00-overview.md`](docs/design/00-overview.md) — architecture overview (historically stamped)
- [`docs/design/02-p1-delegation.md`](docs/design/02-p1-delegation.md) — the delegation surface: tool schemas, modes, snapshot/diff, transcripts
- [`docs/conventions.md`](docs/conventions.md) — TypeScript / ESM / cross-cutting concerns

## License

Not yet declared. Treat as all-rights-reserved until a license file lands.
