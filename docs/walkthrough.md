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

---

# P1 — Delegation surface (what's actually shipped)

The section above describes the **steady-state UX** assuming P0 through P2 are complete. The section below describes the **delegation surface as it currently exists after P1**, before the VS Code extension lands at P2.

This section is for contributors and operators who want to know how the daemon actually behaves today. Cross-references throughout to the [runbook](runbook.md) for operator concerns and the [P1 design doc](design/02-p1-delegation.md) for design rationale.

## P1 overview

P0 shipped the **bus**: daemon + cloudflared tunnel + MCP server + auth + audit + `ping` tool. P1 layers the **delegation surface** on top:

```
┌──────────────────────────────────────────────────────────────────┐
│ MCP client (Bearer auth)                                         │
│   delegate_to_claude_code / poll_delegation / cancel_delegation  │
└──────────────────┬───────────────────────────────────────────────┘
                   │  HTTPS  (P0 tunnel + auth)
┌──────────────────▼───────────────────────────────────────────────┐
│ Daemon                                                            │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ MCP tools (P1)                                              │  │
│  │   delegate.ts / poll.ts / cancel.ts                         │  │
│  │   (wraps audit metadata; validates input)                   │  │
│  └────────────────┬────────────────────────────────────────────┘  │
│                   │                                                │
│  ┌────────────────▼────────────────────────────────────────────┐  │
│  │ JobQueue (P1) — single-concurrent FIFO + terminal-promise   │  │
│  └────────────────┬────────────────────────────────────────────┘  │
│                   │                                                │
│  ┌────────────────▼────────────────────────────────────────────┐  │
│  │ SdkJobRunner (P1) — query() AsyncGenerator + AbortController │  │
│  │   ↳ TranscriptWriter (P1) — JSONL stream + 50MB cap          │  │
│  │   ↳ snapshot/diff (P1) — before/after workspace state        │  │
│  │   ↳ report assembler (P1) — derives DelegationReport         │  │
│  └────────────────┬────────────────────────────────────────────┘  │
│                   │                                                │
│  ┌────────────────▼────────────────────────────────────────────┐  │
│  │ @anthropic-ai/claude-agent-sdk (external)                   │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

The P0 surface (audit, auth, tunnel manager, IPC) is unchanged in P1. The new surface is the dotted-line section.

## Job lifecycle

P1 introduces a strict three-layer model for delegation state:

- **`Job`** — immutable inputs: `id`, `workspace_id`, `prompt`, `mode`, `max_turns`, `working_directory`, `exhibits`, `model`, `created_at`. Set once at enqueue, never mutated.
- **`JobRunState`** — mutable execution state: `status` (one of `queued` / `running` / `complete` / `failed` / `cancelled`), `partial` (progress block), `started_at`, `finished_at`, `cancel_requested`, `error`, `report`. Owned by the JobQueue; mutated through `mark*` methods.
- **`JobView`** — projection for wire responses: a flattened snapshot of `Job` + `JobRunState` shaped for the MCP tool outputs.

The split (decided at T-P1-003 per Decision 6) keeps immutable design data separate from mutable runtime state. Tests and instrumentation can reason about a `Job` without worrying about race conditions on its execution status.

**Single-concurrent constraint.** The runner processes one job at a time. Additional `delegate_to_claude_code` calls enqueue; their `queued_position` is the FIFO index behind the running job (0 = first to run next). The constraint exists to bound resource usage on the user's machine (SDK can consume CPU + memory) and to keep the in-memory job state simple. P3 may revisit if multi-concurrent demand is real.

**Partial progress.** During a running job, `poll_delegation` returns a `partial` block with `turns_so_far`, `last_tool`, `elapsed_ms`. These fields update as the SDK's `query()` AsyncGenerator yields messages — the runner taps each `assistant` message to extract the last tool name and increment the turn counter. Polling with `wait_ms: 0` reads the current partial; long-polling resolves on terminal.

**Terminal-promise primitive.** The JobQueue exposes `terminalPromise(job_id)` which resolves when the job reaches a terminal state. The `poll_delegation` long-poll path races this promise against a `setTimeout(wait_ms)` — event-driven, no busy-wait. Verified at T-P1-005 AC-4 (poll resolved in 1513ms when stub delay was 1500ms, well before the 6000ms wait cap).

## The three MCP tools

Names match the design doc and the wire surface:

- **`delegate_to_claude_code`** — enqueue a new delegation. Returns `{job_id, status, workspace_id, queued_position}`.
- **`poll_delegation`** — read job state with optional long-poll. Returns `{job_id, status, workspace_id, partial?, report?}`.
- **`cancel_delegation`** — request termination. Returns `{job_id, status, prior_status}`.

Input/output shapes are fully specified by Zod schemas in `packages/shared/src/delegation.ts`; the [runbook's Operating Delegations section](runbook.md#operating-delegations-p1) is the operator-facing reference for field semantics and limits.

**Audit metadata side-channel.** The audit log records per-tool-call entries with `job_id` and `workspace_id` fields. To populate these without coupling the audit middleware to the tool implementations, T-P1-004 introduced the `ctx.setAuditMetadata()` pattern: tool handlers receive a context object that includes a setter; the dispatch wrapper reads any metadata the handler set and merges it into the audit entry. Handlers that don't set metadata produce normal audit entries (`ping` doesn't set anything; the three delegation tools all set `job_id` + `workspace_id`).

## Workspace registry stub

P1 ships a single-workspace stub: configured via the `workspace` block in `config.json`, matched by exact-string ID compare. The implementation is at `packages/daemon/src/workspace/registry.ts` — interface `WorkspaceRegistry` with one method `resolve(id): Workspace | null`. The stub validates the configured workspace at daemon startup (absolute path, exists, is a directory; symlinks resolved per CC-1).

P2 will replace the stub with a real registry: the VS Code extension registers workspaces at attach time via the IPC channel; the registry persists state to `~/.claude-bridge/workspaces/`. The interface stays the same — only the implementation changes.

In the meantime: one workspace per daemon. Multi-workspace work (the [walkthrough's UX narrative above](#multiple-workspaces-simultaneously)) is forward-looking.

## Snapshot + diff

Before each delegation, `takeSnapshot(workspace_id, abs_path)` produces a `WorkspaceSnapshot`: a list of `FileEntry` (path, size_bytes, sha256, is_binary). After the delegation, a second snapshot is taken; the pair feeds `computeDiff` to produce the textual diff that lands in the report.

**File enumeration paths:**

- **Git workspaces** (`git ls-files` returns at least one file): use `git ls-files -z` for tracked files + `git ls-files -z --others --exclude-standard` for untracked-but-not-ignored. NUL-separated to handle filenames with newlines. Two-step approach because `git ls-files` doesn't combine tracked and untracked in a single invocation cleanly.
- **Non-git workspaces** (or `git` unavailable): walk recursively with the [`ignore`](https://www.npmjs.com/package/ignore) package's `.gitignore`-syntax engine reading the workspace's `.gitignore` (if present) plus a hardcoded default exclude list (`node_modules/`, `dist/`, `.git/`).

Either path produces the same `FileEntry[]` shape. Per-file: read first 8KB to detect binary (presence of NUL byte), then either stream `sha256` of the full file (text) or just compute the size + flag binary. 50000-file cap with `truncated: true` propagation.

**Diff computation:**

- **Git path:** `git diff --no-index --binary --text <before-tree> <after-tree>` against ephemeral tree objects built from the two snapshots. Produces unified diff format directly.
- **Fallback path:** the [`diff`](https://www.npmjs.com/package/diff) npm package's `createPatch` per file pair. Concatenated into a single multi-file unified diff. Chosen at T-P1-007 after a real §22.5 consultation (the `diff` package was already a devDep candidate; user chose to keep it).

Both paths respect the 256KB-per-file cap with `truncated: true` propagation. Binary files are listed by path in `files_modified` but excluded from `diff`.

## Transcript writer

`TranscriptWriter` streams JSONL to `~/.claude-bridge/transcripts/{job_id}.jsonl`. One JSON object per line; the SDK's `SDKMessage` shape is passed through pretty-much-unchanged (no normalization — the docs-vs-runtime pattern at work; see [v0.5 §6](claude-orchestrated-methodology-v0_5.md#6-the-docs-describe-happy-path-runtime-reveals-edges-pattern-new-in-v05)). The writer:

- Creates the transcripts directory lazily on first write (mode 0700 on Unix).
- Opens the file with mode 0600 on Unix.
- Caps total bytes at 50MB; appends a final marker line `{"type":"truncation","reason":"transcript_size","truncated_at":<bytes>}` when the cap is reached. Subsequent appends are dropped silently.
- Idempotent `close()` per the async-sink-queue pattern (see `docs/patterns/project/async-sink-queue.md`).

**Orphan handling at startup** (T-P1-006): the daemon scans `~/.claude-bridge/transcripts/` and reports any transcript files whose `job_id` isn't in the JobQueue's retained-IDs set (P1 has no persistent job state, so all transcripts at startup are orphans). The default action is to leave orphans in place for forensic recovery; the runbook covers manual cleanup.

## Report assembler

`assembleReport({job, run_state, before_snapshot, after_snapshot, transcript_path, ...})` produces a `DelegationReport`. Responsibilities:

- **Parse the transcript** with `parseTranscript` — line-by-line JSON, fail-soft (one bad line doesn't abort; logged at warn level, line skipped).
- **Extract the summary** — backward-walk the parsed messages from the end, finding the last assistant message with text content; if no such message exists, return empty string.
- **Extract shell commands** — forward-walk parsed messages, looking for `tool_use` blocks with `name === "Bash"`; pair each with its `tool_result` and extract `command` + exit-code-from-result regex.
- **Compute files diff** — call `computeDiff(before_snapshot, after_snapshot)`; categorize file additions/modifications/deletions from snapshot comparison.
- **Pick truncation reason** — 4-tier precedence: `timeout` > `max_turns` > `transcript_size` > `workspace_size`. First match wins; `truncated: true` if any match.

The assembler is the reason for the docs-vs-runtime pattern showing up at T-P1-008: the orchestrator's pre-dispatch reading of SDK docs said messages have a flat `content` field; the SDK's actual TypeScript types nest assistant content under `.message.content` (full Anthropic `BetaMessage` shape). The `effectiveContent(m)` helper (in `report.ts`) reads both shapes, preferring the nested form when present. The legacy flat-content path remains for backward compatibility with messages that may not be assistant-typed.

## SDK integration

The SdkJobRunner wraps `@anthropic-ai/claude-agent-sdk@^0.3.150` (renamed from `@anthropic-ai/claude-code` in late 2025; the older name appears in some older design notes — a P1-close doc-debt item).

**Permission mode mapping:**

| `Job.mode` | SDK `permissionMode` |
|---|---|
| `agentic` | `"acceptEdits"` |
| `read_only` | `"plan"` |

**Belt-and-suspenders for `read_only` (T-P1-010 fix):** the SDK's `"plan"` mode is not actually read-only on its own. Claude in plan mode can call the `ExitPlanMode` tool which the SDK **auto-approves** and flips `permissionMode` to `"default"` — on the next turn, write tools become available. T-P1-010's SMOKE run caught this: on Windows the test happened to pass only because `max_turns=3` ran out before the post-flip turn; with higher max_turns the workspace would have been mutated.

The fix is to pin `disallowedTools` for read_only delegations: `["Write", "Edit", "MultiEdit", "NotebookEdit", "ExitPlanMode"]`. The SDK enforces `disallowedTools` at the dispatch layer regardless of any `permissionMode` flip. Belt + suspenders: permission mode says "plan," disallowed-tools list says "and even if plan mode is escaped, these stay forbidden."

See [v0.5 §6](claude-orchestrated-methodology-v0_5.md#6-the-docs-describe-happy-path-runtime-reveals-edges-pattern-new-in-v05) for the methodology lesson: orchestrator-side documentation reading said "plan mode is read-only"; runtime exercise revealed the `ExitPlanMode` escape hatch.

**Bash deny via canUseTool.** The SDK's `canUseTool` callback fires before each tool invocation. The runner inspects `toolName === "Bash"` and matches the command against a hardcoded deny pattern list (from `00-overview.md`): `sudo`, `rm -rf /`, `dd of=/dev/`, `npm install`, `pip install`, `apt install`, `brew install`, `~/.ssh` access, `~/.aws` access. Match → return `{behavior: "deny", message: "Blocked by claude-bridge deny list: <reason>"}`. The SDK surfaces the deny message in the transcript as a `tool_result`. P2 will layer per-workspace `.claude-bridge.json` overrides on top; P1 is hardcoded.

**Cancellation: AbortController, not `query.interrupt()`.** T-P1-009's original design specified `query.interrupt()` for cancellation. The SDK's TypeScript declarations explicitly say `interrupt()` is "only supported when streaming input/output is used" — for single-prompt delegations (which is all P1 does), it's a no-op. The actual primitive is `Options.abortController`: the runner constructs an `AbortController`, passes it into the SDK options, and calls `.abort()` on cancel. This was a reactive deviation at T-P1-009 documented in `sdk-runner.ts`'s header.

**Transcript pass-through.** Each `SDKMessage` from the `query()` AsyncGenerator is appended to the transcript writer's JSONL stream. Lossless from the SDK's perspective — the daemon does not normalize or filter. The transcript is the ground truth for what the SDK did; the report is a derived summary.

## Acceptance harnesses

Two harnesses, both at `scripts/`, both invoking the same MCP client (`scripts/mcp-delegate-client.mjs`):

- **`acceptance-p1.mjs`** (T-P1-005) — drives 9 [MECH] ACs against the **StubJobRunner**. No API key needed; runs in ~7 seconds. Covers `delegate_to_claude_code` latency, queue semantics, long-poll event-driven behavior, cancellation of queued jobs, audit-entry metadata, input validation, no-workspace-503 path.
- **`acceptance-p1-smoke.mjs`** (T-P1-011) — drives 3 [SMOKE] ACs against the real **SdkJobRunner** with live Anthropic API. Requires `ANTHROPIC_API_KEY`. Covers AC-5 (agentic happy path), AC-6 (read_only refusal — verifies the belt-and-suspenders), AC-8 (cancel running delegation within 15s).

Both harnesses share `scripts/lib/harness-common.mjs` (extracted at T-P1-011): temp env setup, config writing, daemon spawn/stop, ready-poll, `pass`/`fail`/`extractResult` helpers, the `ensureCloudflaredOnPath` PATH-augmentation function (covers Windows install paths + Linux user-local `~/cloudflared` per T-0019.6 + system paths per T-P1-012).

**Harness brittleness defense** (T-P1-011 reactive fix; codified in [v0.5 §7](claude-orchestrated-methodology-v0_5.md#7-harness-brittleness-defense-new-in-v05)): the SMOKE harness uses an `unwrapOrThrow(callResult, where)` helper that hard-fails when the MCP response carries `isError: true`. Without it, a schema-rejection or other server-side error gets wrapped in an envelope, `extractResult` returns the bare result object (no `structuredContent`), and assertions like `p.status === "cancelled"` evaluate `undefined === "cancelled"` → false → silent "pass." T-P1-011's first run had AC-6 "pass" in 38ms because of exactly this — a `wait_ms: 90000` rejected at the `PollInputSchema` boundary (60000 cap).

Cross-platform parity verified at T-P1-012: both harnesses run identically on Windows and WSL Ubuntu with the same PASS counts. Per-AC elapsed varies (Claude's model nondeterminism on read_only delegations can produce 5x wall-time variance for the same semantic outcome — neither is wrong).

## Cross-platform considerations

P1 inherits CC-1 through CC-3 from P0 and adds CC-4 through CC-6 (per [v0.5 §8](claude-orchestrated-methodology-v0_5.md#8-cross-platform-discipline-cc-n-artifacts)):

| Discipline | What it means | P1 manifestation |
|---|---|---|
| CC-1 | Path-handling: canonical forward slashes; `path.join`; `pathToFileURL` for file URIs | Transcript URIs use `pathToFileURL`; snapshot paths normalized at the boundary. |
| CC-2 | Process/signal handling: Windows vs Unix subprocess semantics | Daemon spawns SDK + cloudflared with platform-aware kill chains (SIGTERM with 5s SIGKILL watchdog on Unix; equivalent shape on Windows). |
| CC-3 | File permissions: Unix mode bits no-op on Windows | Daemon's loose-perms refusal is Unix-only (`0600` check skipped on `win32`). Audit log file mode 0600 set when supported. |
| CC-4 | Defensive clean install before cross-platform validation | The runbook's [WSL pre-flight](runbook.md#wsl-pre-flight-checklist) documents this. |
| CC-5 | Lazy-load with graceful degradation for rare-case dependencies | The MCP client's `undici` import is wrapped in try/catch — load failure (Node 20.18 vs `>=22.19` engine) drops the DNS workaround with a stderr warning. Localhost MCP unaffected. |
| CC-6 | Node engine pinning matrix | The runbook's [Node engine guidance](runbook.md#node-engine-guidance) makes the matrix explicit. |

The `ensureCloudflaredOnPath` helper is the most-edited cross-platform surface in the harness — Windows install path at T-0019, Linux user-local + system paths at T-P1-012. macOS Homebrew paths are an open follow-up.

## What's deferred to P2

P1 explicitly excludes (will land at P2 or later):

- **VS Code extension** — workspace registration via IPC, status bar, webview for live delegation streaming, toast approval UI.
- **Real workspace registry** — multi-workspace support, attach/detach lifecycle, persistent state.
- **Per-workspace `.claude-bridge.json`** — additional bash-deny patterns, additional inspection-tool deny patterns, `auto_attach` snapshot configuration.
- **OAuth** — Claude.ai connector UI requires OAuth-style credentials; static Bearer tokens (P1's mechanism) work via MCP Inspector, Claude Code CLI, Claude Desktop, and any other Bearer-capable MCP client, but not the Claude.ai connector. May land between P1 and P2 or be absorbed into P2.
- **Tier-2 inspection tools** — `list_workspace`, `read_file`, `get_git_status`, `get_git_diff`, `get_diagnostics`, `search_workspace`, `get_open_editors`.
- **Persistent job state** — daemon crash mid-job loses the in-memory `JobRunState`. P3 candidate.
- **Multi-concurrent runner** — single-concurrent is a soft constraint; multi could land at P3 if there's real demand.
- **Streaming responses to project-Claude** — P1 is poll-only. Streaming via MCP server-sent events is a P4 stretch.
- **Persistent named tunnels** — every cloudflared restart issues a new URL. Named tunnels (P3) avoid the re-paste-the-URL friction.

Cross-references: the [P1 design doc](design/02-p1-delegation.md) has the full out-of-scope list with rationale.
