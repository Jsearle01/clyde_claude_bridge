# Walkthrough — New Workspace, End to End

## Status (2026-05-30, post-P2)

P2 ships the developer workflow via Bearer-compatible MCP clients (Claude Code CLI, MCP Inspector, Claude Desktop, raw curl). Claude.ai project-chat integration via the connector UI requires OAuth in the daemon's auth layer; deferred to P3. See C-27 in [project-state.md](project-state.md).

This document is split:

- **Part 1: What works today (P2 shipped)** — actual operational flow you can run now.
- **Part 2: P3 target state (where we're going)** — preserved aspirational content for the Claude.ai project-chat integration that requires OAuth.

---

## Part 1: What works today (P2 shipped)

### Prerequisite: daemon already installed

The daemon is started once and runs persistently. Either install the CLI globally and run `claude-bridge start`, or invoke "Claude Bridge: Start Daemon" from the VS Code command palette (the extension wraps the same spawn under the hood).

```
$ claude-bridge start
Daemon up on 127.0.0.1:7423
Tunnel: https://plum-otter-7821.trycloudflare.com
Token:  cb_live_a7f3...d219  (copy this)
```

The tunnel URL and Bearer token are the two values any MCP client needs in order to reach the daemon. Both are also surfaced by `claude-bridge status` at any time. See the [runbook](runbook.md) for full lifecycle commands, config locations, and troubleshooting.

### Connecting an MCP client

Any Bearer-compatible MCP client works today. Four common paths:

**Claude Code CLI.** The canonical command per the [runbook's MCP client section](runbook.md#claude-code):

```bash
claude mcp add --transport http <tunnel-url>/mcp --header "Authorization: Bearer <token>"
```

Substitute the tunnel URL and token from `claude-bridge start` / `claude-bridge status`. Note the `/mcp` path suffix on the URL.

**MCP Inspector.** Useful for poking at the tool surface interactively:

```bash
npx @modelcontextprotocol/inspector
```

Then in the Inspector UI set transport to **Streamable HTTP**, URL to `<tunnel-url>/mcp`, and add header `Authorization: Bearer <token>`.

**Claude Desktop.** Edit Claude Desktop's MCP config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows; `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "claude-bridge": {
      "type": "http",
      "url": "https://plum-otter-7821.trycloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer cb_live_a7f3...d219"
      }
    }
  }
}
```

Restart Claude Desktop; `ping`, `delegate_to_claude_code`, `get_open_editors`, and the rest of the tool list appear.

**Raw curl** (sanity check):

```bash
curl -X POST https://plum-otter-7821.trycloudflare.com/mcp \
  -H "Authorization: Bearer cb_live_a7f3...d219" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**What does NOT work today:** the Claude.ai project-settings connector UI. It exposes only OAuth client_id / client_secret fields — no Bearer header field. C-27 captures this; OAuth in the daemon's auth layer is a P3 deliverable. Until then, drive claude.ai work through the Claude Code CLI bridge.

### First attach — fresh workspace

Scenario: a new folder at `~/projects/new-thing`, freshly `git init`'d with a remote at `github.com/jay/new-thing`. Empty except for `README.md` and `.gitignore`.

**1. Extension activates on workspace open.**

VS Code opens the folder. The claude-bridge extension activates (it has `activationEvents: ["onStartupFinished"]`), connects to the running daemon via its IPC channel, and sends a `register_workspace` request keyed by absolute path.

**2. Daemon issues a trust prompt on first registration.**

The daemon has no prior trust record for this path, so it stores a "pending trust" state and routes a trust-prompt to the extension. VS Code surfaces a modal (per T-P2-006):

> Permit this workspace (`/home/jay/projects/new-thing`) to receive delegations from claude-bridge clients?
>
> This authorizes any MCP client connected to your daemon to delegate work against this workspace, subject to per-call approval.
>
> [Trust] [Don't trust]

User clicks **Trust**.

**3. Daemon persists the trust decision and the workspace identifier.**

Daemon writes an entry to `~/.claude-bridge/workspaces.json` (per T-P2-005/006):

```json
{
  "abs_path": "/home/jay/projects/new-thing",
  "identifier": "new-thing",
  "name": "new-thing",
  "trust_state": "trusted",
  "trusted_at": "2026-05-30T14:22:31Z",
  "mode": "per_call"
}
```

Subsequent activations of the same path skip the prompt — the extension just re-registers and the daemon reuses the persisted entry.

**4. Status bar updates.**

Bottom-right of VS Code shows the registered identifier (per T-P2-007):

```
Claude Bridge: new-thing
```

Clicking the status bar item opens a quick-pick menu (T-P2-008) where the user can change approval mode (`per_call` / `session_bypass` / `auto`) or rename the workspace.

**Total elapsed:** a few seconds and one modal click. The workspace is now drivable from any connected MCP client.

### First delegation via Claude Code CLI

Operator launches Claude Code CLI with the daemon configured as an MCP server (per the [Connecting an MCP client](#connecting-an-mcp-client) step above) and prompts:

> I want to start a Rust CLI for parsing Karateka save files. Use the delegate_to_claude_code tool to scaffold it in the new-thing workspace.

Claude Code reasons about the bridge tools available, then calls:

```
delegate_to_claude_code(
  prompt: "Create a Rust CLI project named karateka-saves. Use clap for args.
           Single subcommand `inspect <FILE>` that for now just prints
           file size and first 16 bytes as hex. cargo init, add deps,
           write src/main.rs, run cargo check.",
  workspace: "new-thing",
  mode: "agentic",
  max_turns: 30
)
```

**What the operator sees in VS Code.**

Because `new-thing` is in `per_call` mode (the default — see [03-p2-extension.md §Q6](design/03-p2-extension.md#q6--runtime-approval-flow)), the daemon routes an approval request to the extension before invoking the SDK. A notification appears with the delegation parameters (workspace, mode, prompt text truncated to ~500 chars, exhibits count) and four buttons: **Approve** / **Approve for session** / **Deny** / **View details**.

User clicks **Approve**.

**What happens next.**

- Daemon spawns the Claude Code SDK process with `cwd` set to `/home/jay/projects/new-thing`, mode `acceptEdits` (per the `agentic` mapping at `packages/daemon/src/sdk-runner.ts`), and the transcript piped to `~/.claude-bridge/transcripts/j_8f2a.jsonl`.
- The SDK runs `cargo init`, edits `Cargo.toml`, writes `src/main.rs`, runs `cargo check`.
- Bash deny list (hardcoded P1 surface; see [runbook → Operating delegations](runbook.md#operating-delegations-p1)) blocks anything risky (`sudo`, `rm -rf /`, package installs at system scope, SSH/AWS credential access).
- Operator's Claude Code CLI long-polls `poll_delegation` with `wait_ms: 30000`; the long-poll resolves the moment the job reaches terminal.

**Job completes.**

Daemon returns the structured `DelegationReport`:

```json
{
  "job_id": "j_8f2a",
  "summary": "Created karateka-saves Rust CLI with clap-based `inspect` subcommand. cargo check passes.",
  "files_created": ["Cargo.toml", "Cargo.lock", "src/main.rs", ".gitignore"],
  "files_modified": [],
  "files_deleted": [],
  "diff": "...",
  "shell_commands": [
    {"cmd": "cargo init --name karateka-saves", "exit_code": 0},
    {"cmd": "cargo add clap --features derive", "exit_code": 0},
    {"cmd": "cargo check", "exit_code": 0}
  ],
  "tool_calls_made": 7,
  "turns": 6,
  "duration_ms": 23410,
  "truncated": false,
  "transcript_uri": "file:///home/jay/.claude-bridge/transcripts/j_8f2a.jsonl"
}
```

Claude Code surfaces the summary back to the operator. The operator can verify the files exist in VS Code (they're right there) and re-read the transcript anytime via the `transcript_uri`. Full field-by-field interpretation is in the [runbook's `DelegationReport` section](runbook.md#interpreting-delegationreport).

### Inspection tools

P2 ships two read-only inspection tools (per T-P2-009 and T-P2-010) that bypass the approval gate — they're metadata-only and designed for high-frequency client use (e.g., before every delegation):

**`get_open_editors`** — returns the list of currently-open editor tabs in the registered VS Code window, with active/dirty metadata. Input: `{ workspace?: string }`. Output:

```json
{
  "editors": [
    {
      "uri": "file:///c:/projects/new-thing/src/main.rs",
      "fs_path": "c:\\projects\\new-thing\\src\\main.rs",
      "is_active": true,
      "is_dirty": false
    }
  ]
}
```

**`get_diagnostics`** — returns LSP/extension diagnostics for the registered workspace, filtered by severity threshold. Input: `{ workspace?: string, severity?: "error" | "warning" | "all" }` (default `"all"`). Output:

```json
{
  "diagnostics": [
    {
      "uri": "file:///c:/projects/new-thing/src/main.rs",
      "fs_path": "c:\\projects\\new-thing\\src\\main.rs",
      "range": { "start": {"line": 12, "character": 4}, "end": {"line": 12, "character": 18} },
      "severity": "error",
      "message": "cannot find type `SaveFile` in this scope",
      "source": "rust-analyzer"
    }
  ]
}
```

Invoke from any MCP client. From Claude Code CLI:

> Use get_open_editors on the new-thing workspace and tell me what files I have open.

From MCP Inspector: pick the tool, fill in `{ "workspace": "new-thing" }`, click **Call Tool**.

From raw curl:

```bash
curl -X POST https://plum-otter-7821.trycloudflare.com/mcp \
  -H "Authorization: Bearer cb_live_a7f3...d219" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","arguments":{"name":"get_open_editors","arguments":{"workspace":"new-thing"}}}'
```

**Workspace argument routing.** When exactly one workspace is registered, `workspace` is optional (the single registration is implied). When multiple workspaces are registered, omitting `workspace` returns `400 ambiguous_workspace` — the caller must supply one. Mismatch on an unknown identifier returns `404 workspace_not_found`. The daemon proxies the call to the matching extension via IPC with a 5-second timeout; on timeout the tool returns `503 extension_offline`.

### Subsequent sessions in the same workspace

User closes VS Code, comes back the next day, reopens the workspace.

- Extension activates, sends `register_workspace` to the daemon — **no trust prompt this time** because `workspaces.json` already has a `trust_state: "trusted"` entry for this path.
- Daemon restores per-workspace settings (approval mode, name) from the persisted entry.
- Status bar: `Claude Bridge: new-thing`.
- Workspace is drivable again immediately.

If the daemon was restarted, the same recovery applies — the extension re-registers on next activation, and the trust state survives because it's on disk, not in the daemon's in-memory state.

### Multiple workspaces simultaneously

Scenario: ATTN-CC3 open in one VS Code window, the new Rust project open in another.

- Each VS Code window's extension instance registers its own workspace independently with the daemon.
- Both entries live in `~/.claude-bridge/workspaces.json`.
- The daemon's `WorkspaceRegistry` tracks both; tool dispatch routes by the `workspace` argument.

For inspection tools and delegations alike, the caller passes `workspace: "attn-cc3"` or `workspace: "new-thing"` explicitly (per T-P2-009 / T-P2-010's argument routing). With two workspaces registered, omitting the arg on an inspection tool returns `400 ambiguous_workspace`.

Approval mode is per-workspace: ATTN-CC3 can sit on `session_bypass` (approve once per VS Code session) while the experimental Rust project stays on `per_call` (approve every time).

### Steady-state UX

Day-to-day with P2 shipped:

- User opens VS Code; extension attaches silently (no prompt after first-trust).
- User drives delegations from Claude Code CLI / MCP Inspector / Claude Desktop.
- Bridge is invisible except for the approval modal on agentic delegations (`per_call` mode) or never (`auto` mode for sandbox workspaces).

The only times the bridge becomes visible:

| Event | Visibility |
|---|---|
| First registration of a new workspace | Trust modal, one click |
| An agentic delegation runs in `per_call` mode | Approval notification, one click |
| `auto` mode | Never — audit log is the only record |
| Something denies | Notification surfacing the denial |
| User checks `claude-bridge status` | Manual diagnostic action |

That's the target UX for P2. P3 will collapse the Claude Code CLI intermediary by adding OAuth so claude.ai project chats can drive delegations directly.

### Failure modes worth being aware of

**Tunnel URL changes after cloudflared restart.** Any MCP client configured with the old URL gets fetch errors. User must repaste the new URL (`claude-bridge status` to retrieve). P3 mitigation: persistent named tunnels.

**Daemon crashes mid-job.** In-memory job state is lost. Transcript file may be partial but readable. Client's `poll_delegation` returns an error. User restarts daemon, retries delegation.

**VS Code window closes mid-job.** Extension disconnects from daemon. Daemon detects disconnect; in-flight delegations against that workspace fail with `503 extension_offline`-class errors. Partial diff and transcript still recoverable from `~/.claude-bridge/transcripts/`.

**Two windows open the same workspace.** Documented behavior is one-extension-per-path; multi-instance routing for the same `abs_path` is in the P3 backlog per [03-p2-extension.md §6](design/03-p2-extension.md).

**Token rotated while a client still has the old.** All requests 401 until the user updates the client config. Audit log records the rejected attempts.

**Approval timeout.** Default 60 seconds (per `claudeBridge.approvalTimeoutMs`). If the operator is AFK when an approval arrives, the timeout is treated as deny; the caller gets `403 user_denied`.

---

## Part 2: P3 target state (where we're going)

### Claude.ai project-chat integration

This is the architectural target for P3: claude.ai project chats connect to the daemon directly via the connector UI — no Claude Code CLI intermediary. The connector UI currently requires OAuth, which the daemon's auth layer doesn't yet implement (C-27 captures the deferral). Until P3 ships OAuth, claude.ai project chats use Bearer auth via Claude Code CLI as the bridge (Part 1 above).

The aspirational shape, once OAuth lands:

The tunnel URL and Bearer/OAuth credential are pasted **once** into a Claude.ai project's custom MCP connector configuration. From that point on, any new VS Code workspace just needs to register itself with the running daemon — no further Claude.ai-side configuration required.

User opens the relevant Claude.ai project and starts chatting. Project-Claude has whatever context lives in that project (design docs, memory). It does not yet know what files exist on disk in `new-thing` — only that the workspace exists, via the connector.

**User prompt:**

> I want to start a Rust CLI for parsing Karateka save files. Set up the scaffolding.

**Project-Claude's reasoning (requires OAuth in daemon's auth layer — P3 deliverable).**

This is workspace-side work. Project-Claude calls the bridge:

```
list_workspaces()
  → [{
      id: "github.com/jay/new-thing#new-thing",
      folder_name: "new-thing",
      branch: "main",
      status: "attached",
      is_default: true
    }]
```

Sees `new-thing` is default. Confirms it's empty before delegating:

```
list_workspace(glob: "*")
  → [
      {path: "README.md", type: "file", size: 47},
      {path: ".gitignore", type: "file", size: 1203}
    ]
```

Decides to delegate the scaffolding rather than do it itself:

```
delegate_to_claude_code(
  prompt: "Create a Rust CLI project named karateka-saves. ...",
  mode: "agentic",
  max_turns: 30
)
  → {job_id: "j_8f2a", status: "queued"}
```

**What happens on the user's machine** (same flow as Part 1's delegation — daemon, extension snapshot, SDK spawn, transcript pass-through).

**Claude.ai side meanwhile** (requires OAuth in daemon's auth layer — P3 deliverable):

- Project-Claude calls `poll_delegation("j_8f2a", wait_ms: 30000)` — long-poll.
- Daemon returns when job finishes (or 30s elapses, returning `status: running` and project-Claude polls again).

**Job completes.** Project-Claude receives the structured `DelegationReport` on its next poll and tells the user:

> Scaffolding's in place. `karateka-saves` with clap, `inspect` subcommand stubbed, `cargo check` passes. Created Cargo.toml, src/main.rs, .gitignore. Next I'd suggest figuring out the save-file format — do you have a sample file, or should we start from disassembly?

User can verify in VS Code (the files are right there) and re-read the transcript anytime via `~/.claude-bridge/transcripts/j_8f2a.jsonl`.

**Aspirational additional surface (requires OAuth in daemon's auth layer — P3 deliverable):**

- A **webview panel** in VS Code that opens automatically when a delegation kicks off, streaming the conversation in real time (tool calls, tool results, model reasoning).
- A **per-workspace `.claude-bridge.json`** file at the workspace root capturing local policy (additional bash-deny patterns, additional inspection-tool deny patterns, `auto_attach` snapshot configuration).
- A **default-workspace** concept so single-workspace operators don't have to pass `workspace:` on every call.
- **Offline workspaces** surfaced in `list_workspaces()` with `status: "offline"` and `last_attached`, so project-Claude can tell the user "the attn-cc3 workspace is offline — open it in VS Code and I'll pick up there."

All of these depend on the OAuth-enabled claude.ai connector path landing first; until then, Bearer-via-Claude-Code-CLI (Part 1) is the operational path.

### What this looks like for ATTN-CC3 specifically (P3+ target)

For the existing ATTN-CC3 project:

- One-time: open ATTN-CC3 in VS Code, click attach. `.claude-bridge.json` gets `id_override: "attn-cc3"` so the ID stays stable even if the GitHub repo is renamed.
- Optionally: `auto_attach.extra_files` set to `["design/stack_drift_diagnosis.md", "ATTN-CC3-DESIGN.md"]` so every delegation snapshot includes the live design state.
- Project-Claude in the existing ATTN-CC3 Claude.ai project can now delegate things like:
  - "Run the binary-search drift diagnosis: instrument CVT16_ALL's table-walk loop, run FINAL_TEST under MAME, report the per-iteration drift delta"
  - "Run the reversal regression test, report whether ATTN-CC3 still produces the expected output"
  - "Refactor the BKWRD nested-loop scope to use indexed addressing instead of stack-relative; do not touch CVT16_ALL"

Each delegation runs locally with full ATTN-CC3 workspace context, and the structured report comes back with diff, diagnostics delta, and transcript URI. The user watches it run in the VS Code webview, and project-Claude reasons about the result on the Claude.ai side.

That is the system, fully realized.
