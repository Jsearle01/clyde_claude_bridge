# Walkthrough — New Workspace, End to End

This document walks through the full operational flow of using claude-bridge with a brand-new VS Code workspace, from first attach through a complete delegation. It assumes the system is fully built (P0 through P2 shipped) and serves as reference material for what the day-to-day UX looks like in steady state.

## Prerequisite: daemon already installed

The daemon is started once and runs persistently:

```
$ claude-bridge start
Daemon up on 127.0.0.1:7423
Tunnel: https://plum-otter-7821.trycloudflare.com
Token:  cb_live_a7f3...d219  (copy this)
```

The tunnel URL and bearer token are pasted **once** into a Claude.ai project's custom MCP connector configuration. From that point on, any new VS Code workspace just needs to register itself with the running daemon — no further Claude.ai-side configuration required.

## First attach — fresh workspace

Scenario: a new folder at `~/projects/new-thing`, freshly `git init`'d with a remote at `github.com/jay/new-thing`. Empty except for `README.md` and `.gitignore`.

### 1. Extension activates on workspace open

VS Code opens the folder. The claude-bridge extension activates, scans the workspace root, finds no existing `.claude-bridge.json`. A one-time prompt appears:

> Attach this workspace to claude-bridge? [Yes] [No] [Don't ask again]

User clicks **Yes**.

### 2. Extension registers with daemon

Extension opens local WebSocket to `127.0.0.1:7423` and sends:

```json
{
  "kind": "register",
  "abs_path": "/home/jay/projects/new-thing",
  "folder_name": "new-thing",
  "git_remote": "github.com/jay/new-thing",
  "vscode_window_id": "..."
}
```

Daemon computes ID `github.com/jay/new-thing#new-thing`, adds to registry, returns:

```json
{
  "workspace_id": "github.com/jay/new-thing#new-thing",
  "is_default": true
}
```

It's the only attached workspace, so it's the default.

### 3. Extension writes config

Extension creates `.claude-bridge.json` at workspace root with sensible defaults:

```jsonc
{
  "default_mode": "agentic",
  "deny_list_extra": [],
  "bash_deny_extra": [],
  "auto_attach": {
    "include_claude_md": true,
    "include_last_shell": true,
    "extra_files": []
  }
}
```

Prompt: *"Add `.claude-bridge.json` to the repo? [Yes] [No]"* — usually yes; it's safe to commit, defines per-workspace policy.

### 4. Status bar updates

Bottom-right of VS Code: `Bridge: new-thing (default)`.

**Total elapsed:** ~5 seconds, two clicks. The workspace is now drivable from Claude.ai.

## First delegation

User opens the relevant Claude.ai project and starts chatting. Project-Claude has whatever context lives in that project (design docs, memory). It does not yet know what files exist on disk in `new-thing` — only that the workspace exists, via the connector.

### User prompt

> I want to start a Rust CLI for parsing Karateka save files. Set up the scaffolding.

### Project-Claude's reasoning

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
      {path: ".gitignore", type: "file", size: 1203},
      {path: ".claude-bridge.json", type: "file", size: 412}
    ]
```

Decides to delegate the scaffolding rather than do it itself:

```
delegate_to_claude_code(
  prompt: "Create a Rust CLI project named karateka-saves. Use clap for args.
           Single subcommand `inspect <FILE>` that for now just prints
           file size and first 16 bytes as hex. cargo init, add deps,
           write src/main.rs, run cargo check.",
  mode: "agentic",
  max_turns: 30
)
  → {job_id: "j_8f2a", status: "queued"}
```

### What happens on the user's machine

**Daemon side:**
- Receives delegation request
- Asks the `new-thing` extension instance for an auto-attach snapshot
- Extension assembles snapshot:
  - Workspace path and ID
  - Git: branch `main`, clean, no ahead/behind
  - No open editors
  - No CLAUDE.md present
  - No last-shell yet
  - Snapshot ID (hash for post-delegation diff)
- Daemon spawns Claude Code SDK process:
  - cwd set to `/home/jay/projects/new-thing`
  - Prompt = snapshot header + delegation prompt
  - Mode flags: `agentic`
  - Transcript piped to `~/.claude-bridge/transcripts/j_8f2a.jsonl`

**VS Code window:**
- Webview panel opens automatically (extension subscribes to job-start events from the daemon)
- Conversation streams in real-time:
  - Claude Code's reasoning about the plan
  - Each tool call (file write, bash invocation)
  - Each tool result
- User watches it run `cargo init`, edit `Cargo.toml`, write `src/main.rs`, run `cargo check`
- No toasts fire — everything's in-workspace, deny-list patterns don't trigger
- Status bar: `Bridge: new-thing (default) · job j_8f2a running · 4 turns`

**Claude.ai side meanwhile:**
- Project-Claude calls `poll_delegation("j_8f2a", wait_ms: 30000)` — long-poll
- Daemon returns when job finishes (or 30s elapses, returning `status: running` and project-Claude polls again)

### Job completes

Daemon assembles the report:

```json
{
  "job_id": "j_8f2a",
  "summary": "Created karateka-saves Rust CLI with clap-based `inspect` subcommand. cargo check passes.",
  "files_created": ["Cargo.toml", "Cargo.lock", "src/main.rs", ".gitignore"],
  "files_modified": [],
  "files_deleted": [],
  "diff": "...",
  "diagnostics_before": [],
  "diagnostics_after": [],
  "diagnostics_delta": {"added": [], "resolved": []},
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

Project-Claude receives this on its next poll. Tells the user:

> Scaffolding's in place. `karateka-saves` with clap, `inspect` subcommand stubbed, `cargo check` passes. Created Cargo.toml, src/main.rs, .gitignore. Next I'd suggest figuring out the save-file format — do you have a sample file, or should we start from disassembly?

User can verify in VS Code (the files are right there) and re-read the transcript anytime via `~/.claude-bridge/transcripts/j_8f2a.jsonl`.

## Subsequent sessions in the same workspace

User closes VS Code, comes back the next day, reopens the workspace.

- Extension activates, finds existing `.claude-bridge.json`, registers with daemon — **no prompt this time** because config exists
- Daemon recognizes the workspace ID from prior state in `~/.claude-bridge/workspaces/`, restores per-workspace settings
- Status bar: `Bridge: new-thing (default)`
- Workspace is drivable again immediately

## Multiple workspaces simultaneously

Scenario: ATTN-CC3 open in one window, the new Rust project open in another.

- Both extensions register independently with the daemon
- `list_workspaces()` returns both:
  ```json
  [
    {"id": "github.com/jay/attn-cc3#attn-cc3", "status": "attached", "is_default": false},
    {"id": "github.com/jay/new-thing#new-thing", "status": "attached", "is_default": true}
  ]
  ```
- The Claude.ai project chat for ATTN-CC3 always passes `workspace: "github.com/jay/attn-cc3#attn-cc3"` explicitly, regardless of which is default — defensive against the wrong default being current
- The Claude.ai project chat for the Rust work can rely on the default

The user changes the default by clicking the status bar item in whichever VS Code window they're driving from, or via:

```
claude-bridge default github.com/jay/new-thing#new-thing
```

(deferred to P3 along with the other multi-workspace conveniences)

## Offline workspaces

Scenario: ATTN-CC3 was attached earlier today but the VS Code window is now closed.

- `list_workspaces()` still returns it, but with `status: "offline"`:
  ```json
  {
    "id": "github.com/jay/attn-cc3#attn-cc3",
    "folder_name": "attn-cc3",
    "abs_path": "/home/jay/projects/attn-cc3",
    "status": "offline",
    "last_attached": "2026-05-01T14:22:31Z"
  }
  ```
- Project-Claude can see it exists historically and tell the user "the attn-cc3 workspace is offline — open it in VS Code and I'll pick up there"
- Tier-2 calls and delegations against an offline workspace return `{error: "workspace_not_attached", available: [...]}`

## Steady-state UX

Day-to-day:

- User opens VS Code, extension attaches silently
- Drives from Claude.ai
- Bridge is invisible most of the time — no manual steps per session, no per-prompt friction

The only times the bridge becomes visible:

| Event | Visibility |
|---|---|
| First attach to a new workspace | Two-click prompt, ~5 seconds |
| A delegation runs | Webview panel opens, conversation streams |
| Something denies | Toast appears asking to approve or deny |
| User checks `claude-bridge status` | Manual diagnostic action |

That's the target UX. Everything else is mechanism.

## Failure modes worth being aware of

**Tunnel URL changes after cloudflared restart.** User must repaste new URL into Claude.ai connector. P3 mitigation: persistent named tunnels.

**Daemon crashes mid-job.** In-memory job state is lost. Transcript file may be partial but readable. Project-Claude's `poll_delegation` returns `{error: "daemon_restart", job_id_missing: true}`. User restarts daemon, retries delegation.

**VS Code window closes mid-job.** Extension disconnects from daemon. Daemon detects disconnect, marks job `failed` with `reason: "workspace_unavailable"`. Partial diff and transcript still recoverable.

**Two windows open the same workspace.** Daemon refuses second registration with `error: "workspace_already_attached"`. The first window remains the provider. Second window's extension shows a banner explaining.

**Token rotated while a Claude.ai project still has the old.** All requests 401 until the user updates the connector. Audit log records the rejected attempts.

## What this looks like for ATTN-CC3 specifically

For the existing ATTN-CC3 project:

- One-time: open ATTN-CC3 in VS Code, click attach. `.claude-bridge.json` gets `id_override: "attn-cc3"` so the ID stays stable even if the GitHub repo is renamed.
- Optionally: `auto_attach.extra_files` set to `["design/stack_drift_diagnosis.md", "ATTN-CC3-DESIGN.md"]` so every delegation snapshot includes the live design state.
- Project-Claude in the existing ATTN-CC3 Claude.ai project can now delegate things like:
  - "Run the binary-search drift diagnosis: instrument CVT16_ALL's table-walk loop, run FINAL_TEST under MAME, report the per-iteration drift delta"
  - "Run the reversal regression test, report whether ATTN-CC3 still produces the expected output"
  - "Refactor the BKWRD nested-loop scope to use indexed addressing instead of stack-relative; do not touch CVT16_ALL"

Each delegation runs locally with full ATTN-CC3 workspace context, and the structured report comes back with diff, diagnostics delta, and transcript URI. The user watches it run in the VS Code webview, and project-Claude reasons about the result on the Claude.ai side.

That is the system, fully realized.
