# claude-bridge — Architecture Overview

**Status:** Active
**Last updated:** 2026-05-01

> **Status (T-BEARER-1, post-P3′):** OAuth-bound is the ONLY auth model. The
> legacy unconstrained static Bearer (the P2 "Bearer-compatible MCP client" path —
> Claude Code CLI, MCP Inspector, Claude Desktop, raw curl) was REMOVED: it
> bypassed the per-workspace isolation (workspace-targeting enforcement + the
> operator clamp), and a non-OAuth client can no longer authenticate. Claude.ai's
> connector uses the OAuth binding flow (DCR → consent → workspace-bound token).
> See C-27 in `docs/project-state.md`.

## Purpose

claude-bridge is an MCP bridge that connects MCP-client agents (project-Claude, Claude Code CLI, MCP Inspector) to local VS Code workspaces, enabling delegation of code work to Claude Code running locally. P3 extends this to claude.ai project chats via OAuth-based authentication. MCP-client agents treat workspaces as remote sub-agents addressable by ID; Claude Code runs locally with full workspace context and returns structured reports.

## Topology

```
[Claude.ai project chat]
        ↓ MCP over HTTPS (single endpoint)
[Cloudflared tunnel]
        ↓
[Bridge daemon — long-lived, on user's machine]
        ↕ local WS (127.0.0.1)
[VS Code window A]   [VS Code window B]   [VS Code window C]
  workspace: foo       workspace: bar       workspace: baz
```

The **bridge daemon** is the system's center of gravity. It owns the MCP endpoint, the tunnel, the bearer token, the job queue, transcripts, and the audit log. It runs independently of any VS Code window.

**VS Code extensions** register as workspace providers by dialing out to the daemon over local WebSocket. Each extension instance corresponds to one workspace. Extensions are responsible for:

- Producing auto-attach snapshots on demand
- Serving Tier-2 inspection tools against the live workspace
- Streaming Claude Code conversations into a webview panel
- Surfacing approval prompts (toast in v1)

**Claude Code** is invoked by the daemon (not the extension) via the `@anthropic-ai/claude-agent-sdk` SDK, with cwd set to the workspace path. Output streams back through the daemon to both the originating MCP caller (project-Claude) and the extension's webview.

## Frozen decisions

### Architecture
- **Pattern:** sub-agent (not co-agent). One delegation = one MCP call returning a structured report. No mid-task back-and-forth between project-Claude and Claude Code.
- **Daemon/extension split:** daemon owns MCP, tunnel, jobs, persistence; extensions are workspace providers only.
- **UI strategy:** Option B — headless Claude Code via SDK plus a custom webview in VS Code that mirrors the conversation. The official Claude Code chat panel is not driven programmatically.

### Workspace addressing
- **Pattern:** explicit `workspace` argument on all tool calls, with fallback to a daemon-tracked default.
- **ID format:** `{remote_host}/{remote_path}#{folder_name}`
  - Example: `github.com/jay/attn-cc3#attn-cc3`
  - Multiple remotes: prefer `origin`, fall back alphabetically
  - No git: `local#{folder_name}` with collision suffix (`-2`, `-3`)
  - Override: `id_override` field in `.claude-bridge.json` for stable IDs across remote renames or git-init events
- **Default selection:** last-attached workspace, or pinned via VS Code command in any window's status bar item.

### Tool tiers
- **Tier 1 — auto-attach** (always included with delegations, free):
  - Workspace ID + absolute path
  - Git: branch, ahead/behind, dirty files, untracked files
  - Active editor + selection range (omitted entirely if no selection)
  - Open editors list
  - Last shell command + exit code (P3+; deferred from P2)
  - CLAUDE.md verbatim, capped at 16 KB
  - Snapshot ID (hash of workspace state, used for post-delegation diff)
- **Tier 2 — read-only inspection** (project-Claude calls as needed):
  - `list_workspaces()` returns attached + offline workspaces with status field
  - `list_workspace(workspace?, glob?, max_entries?)`
  - `read_file(workspace?, path, range?, max_bytes?)` — 1 MB hard cap, pagination hint above 256 KB
  - `get_git_status(workspace?)`
  - `get_git_diff(workspace?, path?, staged?, revision?)`
  - `get_diagnostics(workspace?, path?, severity_min?)`
  - `search_workspace(workspace?, pattern, path_glob?, case_sensitive?, max_results?)` — ripgrep
  - `get_open_editors(workspace?)`
- **Tier 3 — delegation:**
  - `delegate_to_claude_code(workspace?, prompt, exhibits?, mode?, model?, max_turns?, working_directory?)` returns `{job_id, status}`
  - `poll_delegation(job_id, wait_ms?)` long-poll
  - `cancel_delegation(job_id)`

### Modes
- **`read_only`:** read tools + bash allowlist (read commands, git read, build inspection). No file writes.
- **`agentic`:** full read/write + bash deny-list. Default for new workspaces.

### Bash policy
- **Read-only mode:** allowlist (read, search, git read-side, build tools, lwasm, MAME, file inspection commands).
- **Agentic mode:** deny-list. Block destructive patterns (`rm -rf /`, `dd of=/dev/`, fork bombs, sudo, package manager installs without `--dry-run`, anything touching `~/.ssh` or `~/.aws`). Allow everything else without prompting.

### Network
- Unrestricted egress for Claude Code.
- Deny-list scans command strings for credential patterns before execution.
- All network-touching commands logged in audit.

### Approvals
- **v1:** toast notification in VS Code. Two buttons (Approve / Deny). 30-second default-deny timeout.
- **P3:** webview panel with diff preview replaces toast for write operations.
- **Triggers:** writes outside workspace root, writes to deny-list paths, bash commands matching destructive patterns.

### Persistence
- **Transcripts:** `~/.claude-bridge/transcripts/{job_id}.jsonl`. Full Claude Code conversation: messages, tool calls, tool results. 30-day retention. Surfaced in reports as `transcript_uri`.
- **Audit log:** `~/.claude-bridge/audit.jsonl`. One line per tool call: `{ts, tool, input_hash, allowed, duration_ms, result_bytes, job_id?}`. Daily rotation, 30-day retention. No payloads — just metadata.
- **Per-workspace state:** `~/.claude-bridge/workspaces/{workspace_id}/` retains config cache and last-attached timestamp so offline workspaces remain visible to `list_workspaces()`.

### Privacy / deny-list
- **Default deny patterns:**
  ```
  .env, .env.*
  *.key, *.pem, *.p12, *.pfx
  **/secrets/**, **/credentials/**
  .git/config
  ~/.ssh/**, ~/.aws/**, ~/.config/gcloud/**
  ```
- **Layering:** workspace `.claude-bridge.json` extends global config (additive only — workspace cannot weaken global).
- **`.gitignore`:** honored by `list_workspace` and `search_workspace` by default. Override flag exists, defaults off.
- **Denied reads:** return `{error: "denied_by_policy", path}` — never silently empty.

### Daemon lifecycle
- **v1:** manual start via `claude-bridge start`. No autostart.
- **P3:** autostart at login (launchd / systemd-user / Windows scheduled task).
- **Survival:** daemon outlives all VS Code windows. Workspaces dynamically attach/detach.

### CLI surface (v1)
```
claude-bridge start              # launch daemon + tunnel, print URL + token
claude-bridge stop
claude-bridge status             # daemon, tunnel, workspaces, recent jobs
claude-bridge list-workspaces
claude-bridge tail-log [-f]
claude-bridge token rotate
claude-bridge tunnel restart
```

## Per-workspace config

`.claude-bridge.json` at workspace root (committed to repo):

```jsonc
{
  "id_override": "attn-cc3",          // stable ID across remote/folder changes
  "default_mode": "agentic",          // or "read_only"
  "deny_list_extra": ["doc/secrets/**"],
  "bash_deny_extra": ["lwasm.*--write-rom"],
  "auto_attach": {
    "include_claude_md": true,
    "include_last_shell": true,
    "extra_files": ["design/*.md"]    // always include in snapshot
  }
}
```

## Repository layout

```
claude-bridge/
  packages/
    shared/              # contracts: workspace IDs, tool schemas, message types
    daemon/              # long-lived MCP host
      src/
        mcp/             # MCP server + tool registry
        tunnel/          # cloudflared wrapper
        registry/        # workspace tracking
        jobs/            # P1+
        config.ts
        index.ts
    cli/                 # claude-bridge command (thin wrapper over daemon socket)
    extension/           # VS Code extension (P2+)
  scripts/
  docs/
    design/
      00-overview.md     # this document
      01-p0-bus.md
      02-p1-delegation.md   # written after P0 ships
      03-p2-extension.md    # written after P1 ships
    walkthrough.md       # operational reference
    runbook.md           # ops procedures
  package.json           # npm workspaces root
```

**Build conventions:**
- TypeScript across all packages
- `shared` builds first (other packages import contracts from it)
- Daemon: Node 20, ESM
- Extension: CommonJS via tsup, target node20
- CLI: thin Node script communicating with daemon over `~/.claude-bridge/daemon.sock` (Unix) or named pipe (Windows)

## Gate sequence

Each gate ships with a self-contained design doc written before the gate starts. Gate docs are not written ahead of time — decisions made today rot before later gates begin.

### P0 — Bus validation
Prove end-to-end MCP roundtrip from Claude.ai to local daemon with auth and tunnel. Single tool: `ping`. No workspaces, no Claude Code. Acceptance: Claude.ai project calls `ping` and receives a response. **See `01-p0-bus.md`.**

### P1 — Headless delegation
Implement `delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`. Job queue (in-memory, single concurrent job for v1). Claude Code SDK invocation with mode plumbing. Transcript persistence. DelegationReport assembly. No VS Code extension yet — daemon talks to Claude Code SDK directly against a hardcoded workspace path for testing. Gate doc written after P0 ships.

### P2 — VS Code extension
Extension registers as workspace provider. Webview panel mirrors Claude Code conversation. Auto-attach assembly (Tier-1 minus last-shell). Tier-2 inspection tools wired to VS Code APIs and ripgrep. Toast approval UI. Deny-list enforcement. Audit log. Gate doc written after P1 ships.

### P3 — Polish
Last-shell capture via `onDidEndTerminalShellExecution`. Webview approval with diff preview replaces toast for write ops. Multi-job queue. Transcript search command. Daemon autostart at login. `.claude-bridge.json` per-workspace config support beyond defaults.

### P4 — Stretch
Co-agent mode. Multi-window driving from a single project. Tool-result streaming back to project-Claude (vs poll-only). Token rotation UX improvements.

## Glossary

- **Project-Claude:** Claude in a Claude.ai project chat, calling MCP tools.
- **Claude Code:** the CLI/SDK product invoked locally as the sub-agent.
- **Daemon:** the `claude-bridge` long-lived process hosting MCP and tunnel.
- **Workspace:** a registered VS Code workspace, addressable by ID.
- **Workspace provider:** a VS Code extension instance that has registered with the daemon.
- **Delegation:** a single `delegate_to_claude_code` invocation. Has a `job_id`.
- **Auto-attach snapshot:** Tier-1 context block prepended to every delegation prompt.
- **Exhibit:** explicit context attached to a delegation by project-Claude (file refs or blobs).
- **Mode:** `read_only` or `agentic`. Controls Claude Code's tool access during a delegation.
