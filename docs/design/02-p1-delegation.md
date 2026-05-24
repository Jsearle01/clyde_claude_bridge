# P1 — Headless Delegation

**Status:** Design
**Last updated:** 2026-05-23
**Prerequisite:** P0 (Bus validation) — GATE-CLOSED 2026-05-23
**Successor:** P2 (VS Code extension) — design doc written after P1 ships

## Goals

1. Implement the three delegation tools (`delegate_to_claude_code`, `poll_delegation`, `cancel_delegation`) over the bus proven in P0.
2. Drive Claude Code via the `@anthropic-ai/claude-agent-sdk` SDK with cwd set to a configured workspace path, mode flag plumbed through, and transcript captured.
3. Establish the DelegationReport assembly pattern: structured summary returned to the caller, transcript URI for full conversation reference, file/diff/shell deltas computed from workspace state.
4. Lock the tool signatures (`workspace?` argument, mode enum, report shape) so P2's extension work replaces the stub registry without changing the wire contract.
5. Validate the mechanism end-to-end with a non-Claude.ai-connector client (MCP Inspector, Claude Code CLI as MCP client, or Claude Desktop) — see "Auth scope" below.

## Non-goals (explicitly deferred)

- **No VS Code extension.** The workspace registry is a one-entry stub backed by config. Real workspace tracking lands in P2.
- **No auto-attach snapshot.** Tier-1 context (git status, open editors, CLAUDE.md, etc.) is not assembled by P1. Delegations get a bare prompt plus optional exhibits.
- **No Tier-2 inspection tools.** `list_workspace`, `read_file`, `search_workspace`, etc. land in P2 when the extension can serve them against live state.
- **No approval UI.** Mode plumbing exists; bash policy enforcement beyond what the SDK does natively is deferred to P2 when the toast/webview can prompt.
- **No diagnostics in the report.** `diagnostics_before` / `diagnostics_after` / `diagnostics_delta` fields exist in the report schema but are empty in P1 (extension populates them in P2).
- **No OAuth.** Static Bearer auth from P0 is the only auth path in P1. Claude.ai-project-chat validation requires OAuth and is deferred to a dedicated gate. P1 validates the delegation mechanism via Bearer-compatible clients only.
- **No persistent job state.** Jobs are in-memory; daemon crash loses queue and running-job state. Transcript files survive on disk for forensic recovery, but the report is not assembled if the daemon dies mid-job.
- **No concurrent jobs.** Single-job queue with FIFO ordering. Second delegation request gets queued behind the first.

The point of P1 is to prove the delegation mechanism works: that project-Claude can hand a task to a local Claude Code subprocess, the subprocess can do work in a real workspace, and the result comes back as a structured report. Everything else is layered later.

## Auth scope and the OAuth deferral

P0's SMOKE-2 finding established that the Claude.ai project-chat connector UI requires OAuth 2.1 — static Bearer tokens do not work via that path (per Anthropic GitHub issues #112 and #155 as of 2026-04). Bearer tokens do work via MCP Inspector, Claude Code CLI (`claude mcp add --transport http --header`), and Claude Desktop.

P1 validates the delegation mechanism using Bearer-compatible clients. The Claude.ai-project-chat end-to-end roundtrip — the steady-state UX in `walkthrough.md` — requires OAuth and is deferred. The daemon's auth layer is designed so OAuth-issued access tokens layer on top of the existing Bearer validation path; Bearer becomes the degenerate "static token" case of a more general scheme. This boundary is examined again before P2.

## Sequence diagrams

### Delegation cold path

```
project-Claude        Daemon              JobRunner           ClaudeCode SDK     Transcript file
      │                  │                    │                     │                  │
      │ delegate(prompt) │                    │                     │                  │
      ├─────────────────►│                    │                     │                  │
      │                  │ enqueue            │                     │                  │
      │                  ├───────────────────►│                     │                  │
      │  {job_id,        │                    │                     │                  │
      │   status:queued} │                    │                     │                  │
      │◄─────────────────┤                    │                     │                  │
      │                  │  dequeue           │                     │                  │
      │                  │◄───────────────────┤                     │                  │
      │                  │                    │ spawn SDK (cwd,     │                  │
      │                  │                    │ mode, max_turns)    │                  │
      │                  │                    ├────────────────────►│                  │
      │                  │                    │                     │  stream messages │
      │                  │                    │                     ├─────────────────►│
      │                  │                    │   (append jsonl)    │                  │
      │                  │                    │◄────────────────────┤                  │
      │                  │                    │ ...                                    │
      │                  │                    │ exit                                   │
      │                  │                    │◄────────────────────┤                  │
      │                  │                    │ compute diffs       │                  │
      │                  │                    │ assemble report     │                  │
      │                  │ status: complete   │                     │                  │
      │                  │◄───────────────────┤                     │                  │
```

### Poll long-poll

```
project-Claude        Daemon
      │                  │
      │ poll(job_id,     │
      │ wait_ms=30000)   │
      ├─────────────────►│
      │                  │  if status terminal → return immediately
      │                  │  else → register waiter, sleep
      │                  │
      │                  │  (job completes — event fires; waiter resolved)
      │                  │
      │  {status,        │
      │   report?}       │
      │◄─────────────────┤
```

If `wait_ms` elapses without the job reaching a terminal state, daemon returns `{status: "running", report: null}` and the caller polls again.

### Cancellation

```
project-Claude        Daemon              JobRunner           ClaudeCode SDK
      │                  │                    │                     │
      │ cancel(job_id)   │                    │                     │
      ├─────────────────►│                    │                     │
      │                  │  signal cancel     │                     │
      │                  ├───────────────────►│                     │
      │                  │                    │  SIGTERM (10s)      │
      │                  │                    ├────────────────────►│
      │                  │                    │                     │  exit
      │                  │                    │◄────────────────────┤
      │                  │                    │ assemble report     │
      │                  │                    │ status: cancelled   │
      │                  │  ack               │                     │
      │◄─────────────────┤                    │                     │
```

If SIGTERM does not produce exit within 10s, SIGKILL follows. Report status `cancelled`; transcript may be truncated mid-message.

## The `delegate_to_claude_code` tool

### Schema

```typescript
{
  name: "delegate_to_claude_code",
  description: "Delegate a task to Claude Code running against a registered workspace. Returns a job id for polling.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: {
        type: "string",
        description: "Workspace ID. Omit to use the daemon's default workspace."
      },
      prompt: {
        type: "string",
        description: "Task prompt for Claude Code. Required."
      },
      exhibits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to workspace root." },
            content: { type: "string", description: "Inline content; omit to reference path only." }
          }
        },
        description: "Explicit context attached to the delegation. P1 supports path references and inline content; auto-attach snapshot comes in P2."
      },
      mode: {
        type: "string",
        enum: ["read_only", "agentic"],
        description: "Tool access mode. Defaults to workspace's default_mode (agentic in P1's stub registry)."
      },
      model: {
        type: "string",
        description: "Optional model override. Defaults to SDK default."
      },
      max_turns: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Soft cap on conversation turns. Defaults to 30."
      },
      working_directory: {
        type: "string",
        description: "Subdirectory of workspace to set as cwd. Defaults to workspace root."
      }
    },
    required: ["prompt"],
    additionalProperties: false
  }
}
```

### Response shape (immediate)

```typescript
{
  job_id: string,                    // "j_" + 12 base32 chars
  status: "queued" | "running",      // "queued" if a prior job is running; "running" if dispatched immediately
  workspace_id: string,              // resolved workspace ID
  queued_position: number            // FIFO index in pending at enqueue time
                                     // (impl: pending.length - 1). 0 means
                                     // "first in pending behind any running
                                     // job"; the runner's tickle microtask
                                     // typically claims this immediately, so
                                     // a subsequent poll sees status=running.
}
```

### Validation rules

- `prompt` non-empty. **No size cap in P1**; SDK and Anthropic API enforce their real limits. (A 32 KB cap was originally written into this doc; removed at T-P1-009 as speculative architecture without empirical grounding. Revisit if pathological input surfaces in practice.)
- `exhibits` total inline content capped at 256 KB. Path-only references are unbounded count-wise but capped at 100 entries.
- `workspace` if supplied must match a registered workspace ID (in P1's stub registry, this is the single configured entry).
- `mode` defaults via workspace config.
- `max_turns` must be in [1, 200]. Default 30.
- `working_directory` must resolve under workspace root (no `..` escape, no absolute paths).

Rejected requests return `400 invalid_input` with a structured error.

## The `poll_delegation` tool

### Schema

```typescript
{
  name: "poll_delegation",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      wait_ms: {
        type: "integer",
        minimum: 0,
        maximum: 60000,
        description: "Long-poll wait. 0 = return immediately. Default 0. Max 60s."
      }
    },
    required: ["job_id"],
    additionalProperties: false
  }
}
```

### Response shape

```typescript
{
  job_id: string,
  status: "queued" | "running" | "complete" | "failed" | "cancelled",
  queued_position: number | null,         // null when not queued
  report: DelegationReport | null,        // populated only on terminal states
  partial: PartialProgress | null         // populated on running state when available
}
```

Where `PartialProgress` is a light, optional summary:

```typescript
{
  turns_so_far: number,
  last_tool: string | null,                // e.g. "Bash", "Edit"
  elapsed_ms: number
}
```

Partial progress lets callers report "in turn 3, running Bash" to the user. It is not the full transcript — that lives on disk and is referenced by URI in the final report.

### Long-poll mechanics

- Daemon maintains a `Map<job_id, Promise<TerminalStatus>>` of in-flight jobs.
- `wait_ms > 0` awaits the promise with a timeout. If the promise resolves first, return the report. If the timeout fires first, return `{status: "running", report: null, partial: ...}`.
- No busy-wait; resolution is event-driven (the runner signals job completion).

## The `cancel_delegation` tool

### Schema

```typescript
{
  name: "cancel_delegation",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string" }
    },
    required: ["job_id"],
    additionalProperties: false
  }
}
```

### Response shape

```typescript
{
  job_id: string,
  status: "cancelled" | "already_terminal" | "not_found",
  prior_status: string | null
}
```

- `cancelled`: cancellation initiated. Caller should `poll_delegation` to wait for terminal state.
- `already_terminal`: job already complete/failed/cancelled.
- `not_found`: unknown `job_id`.

### Cancellation semantics

- Queued job: removed from queue, status flipped to `cancelled` immediately. No SDK invocation occurred.
- Running job: SDK subprocess sent SIGTERM with 10s grace, then SIGKILL. Cross-platform: on Windows, equivalent process tree termination via `taskkill /T /F` if SIGTERM is unsupported by the SDK's process model.
- Final DelegationReport assembled with status `cancelled`, transcript URI present (truncated content acceptable), partial diff/files state computed against whatever the workspace looks like at termination.

## Job lifecycle

States and transitions:

```
queued ─► running ─► complete
                 ├─► failed
                 └─► cancelled
queued ─► cancelled (cancelled before running)
```

Terminal states: `complete`, `failed`, `cancelled`. Once terminal, the job is immutable and its report is the final word.

### Job ID format

`j_` + 12 RFC 4648 base32 chars (60 bits of entropy). Generated when the delegation is enqueued. Collision-free at any realistic project rate.

### Job retention

- In-memory job records retained for 24h after terminal state for late polls (`{status, report}` returnable).
- After 24h, polls for that `job_id` return `not_found`.
- Transcripts on disk follow the global 30-day retention from P0.

## Workspace addressing (stub registry)

P1's registry is a single-entry stub backed by config. The tool surface accepts the final `workspace?` argument and resolves it through a registry interface that P2 replaces with the real multi-entry implementation.

### Config addition

`~/.claude-bridge/config.json` adds:

```jsonc
{
  // existing P0 fields...
  "workspace": {
    "id": "local#default",                       // stub ID; user can edit
    "abs_path": "/home/jay/projects/some-repo",  // required; no default
    "default_mode": "agentic"
  }
}
```

If `workspace` is absent from config, the daemon starts (P0 functionality preserved) but `delegate_to_claude_code` returns `503 no_workspace_configured`. `ping` and other P0 tools work as before.

### Registry interface (forward-compatible)

```typescript
interface WorkspaceRegistry {
  resolve(id?: string): Workspace | null;
  list(): Workspace[];
  default(): Workspace | null;
}

interface Workspace {
  id: string;
  abs_path: string;
  default_mode: "read_only" | "agentic";
  // P2 will add: status, last_attached, extension_connection, etc.
}
```

P1's implementation: returns the single configured entry for any matching `id` or when `id` is omitted. P2's implementation: backed by extension registrations.

## Mode plumbing

Two modes per `00-overview.md`:

- **`read_only`:** SDK invoked with `permissionMode: "plan"` PLUS a hardcoded `disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "ExitPlanMode"]`. See the "Read-only enforcement requires belt-and-suspenders" note below for the rationale.
- **`agentic`:** SDK invoked with `permissionMode: "acceptEdits"`. Bash is allowed; the daemon's `canUseTool` callback enforces the bash deny patterns from `00-overview.md` at dispatch time. No custom layering on top of the SDK's defaults beyond the bash deny patterns.

**Read-only enforcement requires belt-and-suspenders.** SDK's `permissionMode: "plan"` is read-only-tools-only **while in plan mode**, but the `ExitPlanMode` tool flips `permissionMode` to `"default"`, undoing the read-only constraint. Claude can use `ExitPlanMode` to propose a plan; the SDK auto-approves the plan and switches to `"default"` mode; on the next turn, write tools become available and the workspace gets mutated. T-P1-010's live SMOKE caught this — on Windows the test happened to pass only because `max_turns=3` ran out before the post-flip turn; higher `max_turns` would have written the file. Defense: in `read_only` mode the daemon sets `options.disallowedTools = ["Write", "Edit", "MultiEdit", "NotebookEdit", "ExitPlanMode"]`. `disallowedTools` is enforced at the SDK's dispatch layer and survives `permissionMode` flips. Permission mode says "plan"; disallowed-tools list says "and even if plan mode is escaped, these stay forbidden."

The bash deny-list patterns (rm -rf /, dd of=/dev/, sudo, package manager installs, ~/.ssh, ~/.aws) are configured into the SDK invocation. They are enforced by the SDK, not by claude-bridge intercepting commands. If the SDK does not natively support a deny-list of this shape, P1 documents the gap and proposes either (a) shim layer in P2 or (b) restricting agentic mode to environments where the user already trusts the SDK's defaults.

**Mode is not a custom enforcement layer in P1.** Tasks (T-NNNN) discovering that SDK semantics do not match the design intent escalate to the human gate before assuming a shim is required.

## Claude Code SDK integration

The daemon imports `@anthropic-ai/claude-agent-sdk` and invokes it programmatically. Each delegation produces one SDK invocation.

### Contract the daemon depends on

- The SDK accepts: cwd, prompt, max_turns, model (optional), permission mode.
- The SDK streams messages back as they are generated.
- The SDK exits with a code reflecting completion vs error.
- The SDK can be terminated externally via signal/process kill.

The exact SDK API shape is a build-plan concern. The design doc commits to the contract above; the build plan binds it to the SDK's actual surface.

### Version pinning

SDK version pinned in `packages/daemon/package.json` to a specific minor. SDK upgrades go through their own gate task (re-verify the contract holds; re-run acceptance harness).

### Transcript capture

The SDK's streamed messages are appended to `~/.claude-bridge/transcripts/{job_id}.jsonl` as they arrive. Each line is one message (user/assistant/system) or tool call/result. Schema mirrors the SDK's message format with minimal transformation.

On daemon crash mid-job, the transcript file is left as-is (partial). On next start, orphaned transcript files older than 24h get a `.orphan` suffix; older than 30 days, deleted.

## DelegationReport

Returned by `poll_delegation` when the job reaches a terminal state. Schema:

```typescript
interface DelegationReport {
  job_id: string;
  workspace_id: string;
  status: "complete" | "failed" | "cancelled";
  summary: string;                              // 1-3 sentence executive summary from Claude Code's final message, or "<cancelled>" / "<failed: reason>"
  files_created: string[];                      // paths relative to workspace root
  files_modified: string[];
  files_deleted: string[];
  diff: string;                                 // unified diff, capped at 256 KB; truncated flag if exceeded
  diff_truncated: boolean;
  diagnostics_before: Diagnostic[];             // empty in P1; populated by P2 extension
  diagnostics_after: Diagnostic[];              // empty in P1
  diagnostics_delta: { added: Diagnostic[]; resolved: Diagnostic[] };  // empty in P1
  shell_commands: ShellCommand[];               // derived from transcript
  tool_calls_made: number;
  turns: number;
  duration_ms: number;
  truncated: boolean;                           // overall truncation flag (max_turns hit, transcript size, etc.)
  truncation_reason: string | null;             // "max_turns" | "transcript_size" | "timeout" | null
  transcript_uri: string;                       // "file:///home/jay/.claude-bridge/transcripts/{job_id}.jsonl"
  error: ErrorDetail | null;                    // populated on status=failed
}

interface ShellCommand {
  cmd: string;                                  // truncated at 512 chars
  exit_code: number | null;                     // null if command did not complete
}

interface Diagnostic {
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;                               // "typescript" | "eslint" | etc.
}

interface ErrorDetail {
  category: "auth" | "permission" | "sdk_runtime" | "timeout" | "cancelled" | "internal";
  message: string;                              // human-readable
  details: string | null;                       // stack/context if available
}
```

### Diff and file state computation

Pre-delegation: daemon takes a workspace snapshot (file paths + content hashes for tracked files; respects `.gitignore` for the file walk). Post-delegation: re-walk, compute diff via git when workspace is a git repo, otherwise structural diff.

**Snapshot caps and binary detection (impl details from T-P1-007).** The file walker caps at 50000 entries; exceeding the cap sets `truncated: true` on the snapshot and the diff propagates the truncation flag downstream into the report. Per-file binary detection reads the first 8 KB and checks for a NUL byte (presence → binary). Binary files are recorded in the snapshot with `is_binary: true` and contribute to `files_modified` by path, but are excluded from `diff` text content per the binary-file decision (Q-P1-5 lean adopted: skip).

`files_created` / `files_modified` / `files_deleted` are derived from the comparison. `diff` is the unified textual diff.

**The `diff` field is opaque display text.** Consumers should not attempt to parse hunks programmatically. Format may vary between the git-path (when both snapshots share a `git_head` and `git diff` is invoked) and the fallback-path (modified files render as creation-style entries with "(before unavailable)" labels via the `diff` npm package's `createPatch`). Treat the field as a human-readable diff suitable for rendering, not a machine-parseable artifact. T-P1-008's report assembler is the consumer of record; it treats the field as opaque and skips malformed trailing lines.

For non-git workspaces or workspaces where git is unavailable, P1 falls back to per-file content diffs assembled into a unified-diff-compatible format. Limit: total diff capped at 256 KB; if exceeded, `diff_truncated: true` and `diff` contains the first 256 KB.

### Shell command extraction

The transcript contains tool calls. Filtering for the SDK's bash/shell tool yields the `shell_commands` array. Exit codes come from the corresponding tool results.

### Summary extraction

Claude Code's final assistant message (the last non-tool-call assistant turn) is taken as the human-readable summary. If absent (cancelled before final message), summary is `"<cancelled mid-turn>"` or similar.

## Audit log additions

Each delegation tool call records one audit entry per the P0 schema. Additional fields for delegation tools:

```json
{
  "ts": "...",
  "tool": "delegate_to_claude_code",
  "input_hash": "sha256:...",
  "allowed": true,
  "duration_ms": 12,                // time to enqueue, NOT total job duration
  "result_bytes": 87,
  "request_id": "req_...",
  "remote_addr": "tunnel",
  "job_id": "j_...",                // NEW: link to job
  "workspace_id": "local#default"   // NEW: which workspace
}
```

Job completion is NOT a separate audit entry; the audit log records MCP tool calls, not internal job state transitions. The transcript file is the audit trail for what happened inside the delegation.

## Acceptance criteria

P1 is complete when **all** of the following are true. Each AC is tagged with its verification category per methodology v0.4 §29.4:

1. **[MECH]** `delegate_to_claude_code` with a valid prompt against the configured workspace returns `{job_id, status, workspace_id, queued_position}` within 500ms.

2. **[MECH]** Queue positions correctly reflect enqueue order. `delegate_to_claude_code` returns `queued_position` as the FIFO index in pending at enqueue time (0-indexed): when a job enqueues into an empty pending queue, position 0; when enqueuing behind an existing pending job, position 1+. **Implementation note:** a job that enqueues while no other job is running is claimed by the runner synchronously via `claimNext()` in a microtask, so it transitions from `queued` to `running` before the caller's next poll; this is correct and intentional. The pending-queue index is observable in the immediate delegate response; running-state is observable via subsequent `poll_delegation` calls. (The original design wording — "0 if running, 1+ if queued" — described an aspirational semantic that the actual queue implementation diverged from at T-P1-003 in favor of the simpler FIFO-index-at-enqueue model. T-P1-005's harness caught the divergence; impl semantic preserved as the canonical contract.)

3. **[MECH]** `poll_delegation(job_id, wait_ms=0)` returns the current job status without blocking; for a running job, the response includes `partial` with `turns_so_far`, `last_tool`, `elapsed_ms`.

4. **[MECH]** `poll_delegation(job_id, wait_ms=30000)` blocks until the job reaches a terminal state OR 30s elapses, whichever comes first. Resolution is event-driven (no busy-wait verified by instrumenting the daemon's wakeup mechanism). **Note on wait_ms ceiling:** the schema (`PollInputSchema`) caps `wait_ms` at 60000ms; 30000 in this AC is the *canonical client-side default* for typical SMOKE delegations, not the hard ceiling. Clients with delegations expected to exceed 60s should issue multiple polls with shorter wait windows rather than attempt a single long wait — the 60s cap is a defensive bound against unbounded connection hold.

5. **[SMOKE]** A delegation in `agentic` mode against a real Claude Code SDK invocation (using a Bearer-compatible MCP client) completes end-to-end: produces a DelegationReport with `status: "complete"`, non-empty `summary`, accurate `files_created`/`files_modified`/`files_deleted`/`diff`, non-zero `tool_calls_made` and `turns`, valid `transcript_uri` pointing to a readable jsonl file.

6. **[SMOKE]** A delegation in `read_only` mode with a prompt that attempts a file write either (a) returns `status: "complete"` with no file changes and a summary indicating the write was refused, or (b) returns `status: "failed"` with `error.category: "permission"`. Which of (a) or (b) depends on SDK behavior; both are acceptable.

7. **[MECH]** `cancel_delegation(job_id)` on a queued job flips status to `cancelled` immediately. Subsequent `poll_delegation` returns terminal `cancelled` state without any SDK process having been spawned.

8. **[MECH]** `cancel_delegation(job_id)` on a running job initiates termination; subsequent `poll_delegation(wait_ms>0)` returns terminal `cancelled` state within 15s. The SDK subprocess is verifiably terminated (no lingering process matching the job's PID).

9. **[MECH]** Cross-platform: AC-5 verified on both Windows and WSL Ubuntu against the same configured workspace shape (path translations handled).

10. **[MECH]** Audit log records one entry per delegation/poll/cancel tool call with the new `job_id` and `workspace_id` fields; job completion does not produce additional audit entries.

11. **[MECH]** Transcript file at `~/.claude-bridge/transcripts/{job_id}.jsonl` is well-formed JSONL, contains the full conversation, and is readable after the daemon stops.

12. **[MECH]** `delegate_to_claude_code` with no workspace configured (workspace block absent from config) returns `503 no_workspace_configured`. `ping` continues to work in this state.

13. **[MECH]** A second `delegate_to_claude_code` call while one is running returns `status: "queued"` with `queued_position: 1`. After the first completes, the second transitions to `running` automatically.

14. **[INFER]** Job retention: 24h after terminal state, polls for the `job_id` return `not_found`. Verified via unit test with fake clock plus an architectural review of the retention timer; full 24h wall-clock test not required.

15. **[MECH]** Tool input validation: `prompt` empty, `prompt` over 32 KB, `max_turns` out of [1,200], `working_directory` containing `..` — each returns `400 invalid_input` with a structured error.

16. **[SMOKE]** Reproducible acceptance harness (`scripts/acceptance-p1.ps1` and/or `scripts/acceptance-p1.sh`) executes ACs tagged [MECH] and [SMOKE] in sequence from a clean state and reports PASS/FAIL per criterion. Lands within the first 3-4 tasks of P1 per methodology v0.4 §9.5.

Each criterion has a corresponding step in the acceptance harness or the runbook.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code SDK API changes between versions | Pin to a specific minor in `package.json`. SDK upgrade is its own gate task. |
| SDK permission modes don't map cleanly to read_only/agentic | Document the gap when discovered. Decide at design time whether to shim or document as a known limitation. Escalate to human gate. |
| Cross-platform process termination differs | Windows: explicit `taskkill /T /F` fallback if SIGTERM unsupported. Tested in acceptance harness on both platforms (per P0 cross-platform pattern). |
| Large transcripts (>100MB) for long delegations | Transcript size cap with `truncated: true` flag and `truncation_reason: "transcript_size"`. Default cap 50MB; configurable per-workspace later. |
| Daemon crash mid-job loses report | In-memory state limitation documented. Transcript file survives for forensic recovery; project-Claude gets `{error: "daemon_restart"}` on poll and re-runs the delegation. P3+ may add persistent job state. |
| Workspace not a git repo: diff computation fallback may be slow/large | Per-file content diff with the same 256KB cap. Untracked binary files excluded from diff (filenames still reported in files_*). |
| SDK consumes high memory or CPU on user's machine | Outside claude-bridge's control. Documented in runbook. Single-concurrent-job design helps bound this. |
| `working_directory` traversal escape attempts | Validation strict: resolve path, verify it is under workspace abs_path, reject otherwise. Tested in AC-15. |
| OAuth deferred: Claude.ai project chats cannot exercise the path | Documented as known limitation. P1 acceptance uses Bearer-compatible clients (MCP Inspector, Claude Code CLI, Claude Desktop). Walkthrough.md UX claims dependent on OAuth get flagged at P1 close. |

## Open questions

These are flagged for the design conversation that opens P1's first task, and may be amended as P1 implementation surfaces specifics:

- **Q-P1-1: SDK permission mode mapping.** What flags/options does `@anthropic-ai/claude-agent-sdk` expose for read_only vs agentic modes? Does the bash deny-list pattern require a shim, or does the SDK accept a passthrough configuration? Resolution likely at T-P1-001 or T-P1-002.
- **Q-P1-2: Transcript message schema stability.** Is the SDK's streamed message format stable enough to persist as-is? Or should claude-bridge normalize to its own schema? Resolution: prefer pass-through if stable; normalize if not.
- **Q-P1-3: Partial progress instrumentation.** How does the daemon observe `turns_so_far` and `last_tool` during a running job? The SDK's streamed messages are the source of truth; the daemon maintains a counter as it tees to the transcript file.
- **Q-P1-4: Default workspace `default_mode`.** Per `00-overview.md`, `agentic` is the default. Confirm P1 ships with this; no opening question.
- **Q-P1-5: Diff format for binary files.** Skip them entirely, or include a `<binary>` marker line? Lean: skip with a count in `files_modified` of how many binaries changed (so the caller knows something happened).

## Out of scope (explicit)

The following are intentionally not part of P1 and require their own design docs:

- **P2:** VS Code extension; multi-workspace registry; auto-attach snapshot; Tier-2 inspection tools (`list_workspace`, `read_file`, `get_git_status`, `get_git_diff`, `get_diagnostics`, `search_workspace`, `get_open_editors`); toast approval UI; deny-list enforcement layer; per-workspace `.claude-bridge.json` config.
- **P3:** Webview approval with diff preview; persistent job state; multi-concurrent job queue; last-shell capture; transcript search; daemon autostart at login; named tunnels.
- **OAuth gate:** OAuth 2.1 in the daemon's auth layer; Claude.ai-project-chat connector UI validation. May land between P1 and P2 or be absorbed into P2's timeline.
- **P4:** Co-agent mode; multi-window driving; streaming responses to project-Claude (vs poll-only).

## Acceptance checklist for the gate review

When P1 is ready to gate, the following must all be in place:

- [ ] All 16 acceptance criteria pass per their verification category
- [ ] Acceptance harness lands within first 3-4 tasks per methodology v0.4 §9.5
- [ ] Runbook updated: configuring the workspace block, invoking a delegation from a Bearer-compatible client, reading transcripts, troubleshooting failed delegations
- [ ] One real delegation exercised end-to-end via MCP Inspector or Claude Code CLI (the SMOKE-5 evidence)
- [ ] Cross-platform verification: at least AC-5 on both Windows and WSL Ubuntu
- [ ] No TODO comments in `packages/daemon/src/jobs/` or `packages/daemon/src/mcp/tools/`
- [ ] OAuth deferral documented in runbook and in `walkthrough.md` (flag where steady-state UX claims depend on it)
- [ ] P2 design doc (`docs/design/03-p2-extension.md`) started — kicks off the next gate

## Methodology applications carried from P0

- **Acceptance harness as discovery instrument** (v0.4 §9.5): Build within first 3-4 tasks, not last.
- **Cross-platform discipline continuous** (P0 carry): Windows-vs-Unix differences in process termination, path handling, subprocess detachment recurred at multiple P0 tasks. P1 will encounter them in SDK invocation and process management.
- **Mechanical-vs-smoke layering** (v0.4 §9.5, §29.4): Tag each AC with its verification category. Smoke-only items must not be treated as gate-blocking by mechanical-only verification.
- **Scope-decision pre-conversation** (v0.4 §8.5/8.6): Each non-trivial task gets 2-4 scope decisions surfaced and confirmed before prompt draft.
- **Working-tree-state-mid-dispatch protocol** (v0.4 §14.7): User decides bundling vs separate commits when executor has uncommitted work from prior task at dispatch time.

End of P1 design.
