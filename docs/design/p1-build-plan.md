# P1 Build Plan

**Status:** Ready for implementation
**Last updated:** 2026-05-23
**Implements:** `02-p1-delegation.md`
**Conventions:** `00-overview.md`, `docs/conventions.md`
**Prior gate:** `p0-build-plan.md` (P0 GATE-CLOSED 2026-05-23)

This is a **build plan**, not a design doc. The design — what gets built and why — lives in `02-p1-delegation.md`. This doc translates that design into ordered, concrete work: file paths, exports, function shapes, dependencies, and verification steps. The 16 acceptance criteria in `02-p1-delegation.md` are the contract this build plan must satisfy.

Phase numbering below indicates build order. The orchestrator may slice each phase into one or more `T-P1-NNN` tasks during execution; the slicing is a per-task scope decision, not a build-plan constraint. Phases 4 and 11 are explicitly multi-task in expected granularity.

## Prerequisites

- P0 GATE-CLOSED. Daemon, tunnel, CLI, audit, MCP server, tool registry all functional and committed.
- `@anthropic-ai/claude-code` SDK accessible via npm. Version to be pinned at Phase 9; until then, install latest minor and treat the pin as a Phase 9 deliverable.
- Node 20.10+ (already pinned in P0).
- A real workspace directory for SMOKE acceptance: any git repo with simple structure works. Suggested: a throwaway repo created specifically for P1 testing under `~/projects/p1-sandbox/` or equivalent.
- A Bearer-compatible MCP client for SMOKE runs. Options: MCP Inspector, Claude Code CLI (`claude mcp add --transport http --header`), Claude Desktop. The acceptance harness will exercise the first of these.

## Methodology applied

Per v0.4 §9.5: **acceptance harness lands in Phase 5** (within first third of phases). The harness is built against the stub runner from Phase 4 before the SDK is wired in at Phase 9, then extended at Phase 11 to cover [SMOKE] ACs. The harness is a discovery instrument, not a closure ceremony. Phase 4 (tool surface) precedes Phase 5 (harness) so the harness can exercise the MCP path.

Per v0.4 §8.5/§8.6: each non-trivial task opens with 2-4 scope decisions confirmed before prompt draft.

Per v0.4 §14.7: working-tree-mid-dispatch protocol applies whenever the orchestrator dispatches T-(N+1) before issuing T-N verdict.

## Task order

### Phase 1 — Shared types

This phase extends `packages/shared/` with the type surface P1 needs. No runtime logic, no I/O. Other packages import these.

**1.1 — Workspace types**

```
packages/shared/src/workspace.ts
```

```typescript
export interface Workspace {
  id: string;
  abs_path: string;
  default_mode: "read_only" | "agentic";
}

export const WorkspaceConfigSchema = z.object({
  id: z.string().min(1),
  abs_path: z.string().min(1),
  default_mode: z.enum(["read_only", "agentic"]).default("agentic")
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
```

**1.2 — Job types**

```
packages/shared/src/jobs.ts
```

```typescript
export type JobStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlyArray<JobStatus> =
  ["complete", "failed", "cancelled"] as const;

export function isTerminal(s: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export interface PartialProgress {
  turns_so_far: number;
  last_tool: string | null;
  elapsed_ms: number;
}
```

**1.3 — Delegation report types**

```
packages/shared/src/delegation.ts
```

Mirror the schema in `02-p1-delegation.md` "DelegationReport" section exactly. Each interface gets a Zod schema and an inferred type:

- `DelegationReportSchema` / `DelegationReport`
- `ShellCommandSchema` / `ShellCommand`
- `DiagnosticSchema` / `Diagnostic`
- `ErrorDetailSchema` / `ErrorDetail`

Plus the tool input/output schemas:

- `DelegateInputSchema` / `DelegateInput`
- `DelegateOutputSchema` / `DelegateOutput`
- `PollInputSchema` / `PollInput`
- `PollOutputSchema` / `PollOutput`
- `CancelInputSchema` / `CancelInput`
- `CancelOutputSchema` / `CancelOutput`

**1.4 — Config schema extension**

Extend `packages/shared/src/config.ts`:

```typescript
export const ConfigSchema = z.object({
  // existing P0 fields...
  workspace: z.optional(WorkspaceConfigSchema)
});
```

The `workspace` block is optional. `delegate_to_claude_code` returns `503 no_workspace_configured` when absent (AC-12); P0 tools (`ping`) work either way.

**1.5 — Index re-exports**

Update `packages/shared/src/index.ts` to re-export everything from `workspace.ts`, `jobs.ts`, `delegation.ts`.

**Verify:** `npm run build -w packages/shared && npm run test -w packages/shared` passes. Unit tests cover each schema's accept/reject cases for the new types.

**Bucket:** Small (30-60 min). Pure types + schemas, established patterns from P0.

---

### Phase 2 — Workspace registry stub

```
packages/daemon/src/workspace/
  registry.ts
  config.ts
```

**`registry.ts`** — the interface and stub implementation:

```typescript
export interface WorkspaceRegistry {
  resolve(id?: string): Workspace | null;
  list(): Workspace[];
  default(): Workspace | null;
}

export class StubWorkspaceRegistry implements WorkspaceRegistry {
  private workspace: Workspace | null;

  constructor(workspaceConfig: WorkspaceConfig | undefined) {
    this.workspace = workspaceConfig
      ? { id: workspaceConfig.id, abs_path: workspaceConfig.abs_path, default_mode: workspaceConfig.default_mode }
      : null;
  }

  resolve(id?: string): Workspace | null {
    if (!this.workspace) return null;
    if (id !== undefined && id !== this.workspace.id) return null;
    return this.workspace;
  }

  list(): Workspace[] {
    return this.workspace ? [this.workspace] : [];
  }

  default(): Workspace | null {
    return this.workspace;
  }
}
```

**`config.ts`** — workspace-specific config helpers (separate from the global config layer; this is workspace-level concerns like validating abs_path exists at startup):

```typescript
export function validateWorkspaceConfig(cfg: WorkspaceConfig): void {
  // Throw if abs_path doesn't exist on disk
  // Throw if abs_path is not absolute
  // Throw if abs_path contains symlinks that escape the resolved path
}
```

The daemon's startup wiring (Phase 6 of P0 build plan, already shipped) calls `validateWorkspaceConfig` if the `workspace` block is present. Validation failure prevents start with a clear error; no `workspace` block is acceptable and the daemon starts without delegation capability.

**Verify:** Unit tests for `StubWorkspaceRegistry` resolve/list/default. Unit tests for `validateWorkspaceConfig` accept/reject cases (missing path, relative path, symlink escape).

**Bucket:** Small (30-60 min).

---

### Phase 3 — Job queue and state machine

```
packages/daemon/src/jobs/
  queue.ts
  id.ts
```

**`id.ts`** — job ID generation:

```typescript
import { randomBytes } from "node:crypto";

export function generateJobId(): string {
  // RFC 4648 base32, 12 chars (60 bits). Reuse base32 helper from token.ts if extracted; otherwise inline.
  // Format: "j_" + base32(8 random bytes truncated to 12 chars)
}
```

Per P0's third-use extraction pattern: if the token base32 logic is reused here, extract to `packages/daemon/src/util/base32.ts` (this would be the third use; first two in token.ts).

**`queue.ts`** — job queue + state machine:

```typescript
export interface Job {
  id: string;
  workspace_id: string;
  prompt: string;
  exhibits: Exhibit[];
  mode: "read_only" | "agentic";
  model: string | null;
  max_turns: number;
  working_directory: string | null;
  status: JobStatus;
  prior_status: JobStatus | null;       // for transition tracking
  enqueued_at: number;                  // Date.now()
  started_at: number | null;
  terminal_at: number | null;
  partial: PartialProgress | null;
  report: DelegationReport | null;
  error: ErrorDetail | null;
  terminal_promise: Promise<void>;      // resolves on transition to terminal state
  resolve_terminal: () => void;         // captured resolver
  cancel_requested: boolean;            // set by cancel_delegation
}

export class JobQueue {
  private jobs: Map<string, Job> = new Map();
  private pending: string[] = [];        // FIFO of queued job IDs
  private running: string | null = null; // currently running job ID
  private listeners: Set<(job: Job) => void> = new Set();

  enqueue(input: EnqueueInput): { job: Job; queued_position: number } { /* ... */ }
  get(id: string): Job | null { /* ... */ }
  list(): Job[] { /* ... */ }
  cancel(id: string): { status: "cancelled" | "already_terminal" | "not_found"; prior_status: JobStatus | null } { /* ... */ }

  // internal — called by runner when SDK invocation completes
  markRunning(id: string): void { /* ... */ }
  markComplete(id: string, report: DelegationReport): void { /* ... */ }
  markFailed(id: string, error: ErrorDetail, report: DelegationReport): void { /* ... */ }
  markCancelled(id: string, report: DelegationReport): void { /* ... */ }
  updatePartial(id: string, partial: PartialProgress): void { /* ... */ }

  // observer
  on(listener: (job: Job) => void): () => void { /* returns unsubscribe */ }

  // retention sweeper — call from a timer; removes jobs in terminal state >24h
  sweep(now?: number): number { /* returns count removed */ }
}
```

State transitions enforced inside the queue. Direct mutation of `Job.status` from outside is not allowed; all transitions go through `markX` methods.

`terminal_promise` is the long-poll primitive (used by Phase 4's poll tool). Each job has one, resolved when status reaches terminal.

**Cancellation semantics inside the queue:**

- Job in `queued` state → flip to `cancelled` immediately, resolve terminal_promise, remove from pending array.
- Job in `running` state → set `cancel_requested = true`. The runner (Phase 9/10) observes this and initiates SDK termination. The queue does not directly kill the subprocess; the runner owns the SDK process lifecycle.

**Retention sweeper:**

Run a 1-minute interval timer (or align to the existing midnight timer pattern from P0). Remove from `jobs` map any job in terminal state with `terminal_at + 24h < now`.

**Verify:** Unit tests for enqueue (queued vs running placement), state transitions (legal vs illegal), cancellation paths, terminal_promise resolution timing, sweeper behavior with fake clock. Use fake timers (vitest's `vi.useFakeTimers()`) for the retention test.

**Bucket:** Medium-fresh (60-120 min). Discovery in state machine wiring and the long-poll primitive.

---

### Phase 4 — Tool surface

```
packages/daemon/src/mcp/tools/
  delegate.ts
  poll.ts
  cancel.ts
```

**`delegate.ts`**:

```typescript
export function makeDelegateTool(deps: {
  registry: WorkspaceRegistry;
  queue: JobQueue;
  runner: JobRunner;       // Phase 9; in Phase 4 this is a stub
}): Tool<DelegateInput, DelegateOutput> {
  return {
    name: "delegate_to_claude_code",
    description: "...",
    inputSchema: DelegateInputSchema,
    handler: async (input, ctx) => {
      const workspace = deps.registry.resolve(input.workspace);
      if (!workspace) {
        if (deps.registry.list().length === 0) throw new ToolError(503, "no_workspace_configured");
        throw new ToolError(404, "workspace_not_found");
      }

      // Resolve mode
      const mode = input.mode ?? workspace.default_mode;

      // Resolve working_directory (validate against escape)
      const cwd = resolveCwd(workspace.abs_path, input.working_directory);

      // Enqueue
      const { job, queued_position } = deps.queue.enqueue({
        workspace_id: workspace.id,
        prompt: input.prompt,
        exhibits: input.exhibits ?? [],
        mode,
        model: input.model ?? null,
        max_turns: input.max_turns ?? 30,
        working_directory: cwd
      });

      // Kick the runner if idle
      deps.runner.tickle();

      return {
        job_id: job.id,
        status: job.status,
        workspace_id: workspace.id,
        queued_position
      };
    }
  };
}
```

**`poll.ts`**:

```typescript
export function makePollTool(deps: { queue: JobQueue }): Tool<PollInput, PollOutput> {
  return {
    name: "poll_delegation",
    inputSchema: PollInputSchema,
    handler: async (input, ctx) => {
      const job = deps.queue.get(input.job_id);
      if (!job) throw new ToolError(404, "job_not_found");

      const waitMs = input.wait_ms ?? 0;
      if (waitMs > 0 && !isTerminal(job.status)) {
        await Promise.race([
          job.terminal_promise,
          sleep(waitMs)
        ]);
      }

      const fresh = deps.queue.get(input.job_id)!; // re-read after wait
      return {
        job_id: fresh.id,
        status: fresh.status,
        queued_position: fresh.status === "queued" ? computeQueuedPosition(fresh, deps.queue) : null,
        report: isTerminal(fresh.status) ? fresh.report : null,
        partial: fresh.status === "running" ? fresh.partial : null
      };
    }
  };
}
```

**`cancel.ts`**:

```typescript
export function makeCancelTool(deps: { queue: JobQueue; runner: JobRunner }): Tool<CancelInput, CancelOutput> {
  return {
    name: "cancel_delegation",
    inputSchema: CancelInputSchema,
    handler: async (input, ctx) => {
      const result = deps.queue.cancel(input.job_id);
      if (result.status === "cancelled" && result.prior_status === "running") {
        // Ask runner to terminate the SDK subprocess
        await deps.runner.cancel(input.job_id);
      }
      return {
        job_id: input.job_id,
        status: result.status,
        prior_status: result.prior_status
      };
    }
  };
}
```

**`cwd` resolution** (used by delegate.ts):

```typescript
function resolveCwd(workspaceRoot: string, workingDirectory: string | null | undefined): string {
  if (!workingDirectory) return workspaceRoot;
  if (path.isAbsolute(workingDirectory)) throw new ToolError(400, "working_directory_absolute");
  const resolved = path.resolve(workspaceRoot, workingDirectory);
  const root = path.resolve(workspaceRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ToolError(400, "working_directory_escapes_workspace");
  }
  // additional realpath check to catch symlink escapes
  const realResolved = fs.realpathSync(resolved);
  if (!realResolved.startsWith(fs.realpathSync(root) + path.sep) && realResolved !== fs.realpathSync(root)) {
    throw new ToolError(400, "working_directory_escapes_workspace");
  }
  return resolved;
}
```

**Stub runner** (lives in `packages/daemon/src/jobs/runner.ts`; Phase 9 replaces with real SDK):

```typescript
export interface JobRunner {
  tickle(): void;                            // signal that a job is available; idempotent
  cancel(job_id: string): Promise<void>;     // initiate cancellation of running job
}

export class StubJobRunner implements JobRunner {
  constructor(private queue: JobQueue) {}

  tickle(): void {
    // pull next from queue, mark running, then immediately mark complete with a canned report
    queueMicrotask(() => this.advance());
  }

  cancel(_job_id: string): Promise<void> {
    return Promise.resolve();
  }

  private advance(): void { /* ... */ }
}
```

**Registration in main:**

`packages/daemon/src/main.ts` — register the three new tools in the existing ToolRegistry from P0. Add JobQueue and StubJobRunner (Phase 9 swap) to the daemon state.

**Verify:** Daemon starts cleanly with the three new tools registered in ToolRegistry. Manual invocation via direct JSON-RPC call (e.g., via `mcp-ping-client.mjs` extended ad hoc, or via a small inline test script) confirms each tool dispatches. The Phase 5 acceptance harness provides comprehensive verification.

**Bucket:** Small-medium (30-90 min). Follows the P0 tool registration pattern.

---

### Phase 5 — Acceptance harness skeleton

**Per methodology v0.4 §9.5: this phase lands within the first third of the build plan (5 of 14 phases). It is a discovery instrument, not a closure ceremony. Phase order rationale: Phase 4 (tool surface) must precede Phase 5 (harness) so the harness can exercise the MCP path rather than only the in-process queue.**

```
scripts/acceptance-p1.ps1               # Windows primary
scripts/acceptance-p1.sh                # Unix variant (WSL Ubuntu, Linux, macOS)
scripts/mcp-delegate-client.mjs         # MCP client driver, reused across both scripts
```

**`mcp-delegate-client.mjs`** — a Node script that:

- Connects to a running daemon via its tunnel URL + Bearer token (read from `claude-bridge status` or args)
- Exposes a small CLI with subcommands: `delegate`, `poll`, `cancel`, `wait`, `list-tools`
- Used by the acceptance shell scripts and available for ad-hoc developer use

Modeled on `scripts/mcp-ping-client.mjs` from P0. Uses the same MCP SDK client patterns; P0's helper for DNS-via-undici-dispatcher carries forward (this was an environmental workaround discovered in T-0019).

**`acceptance-p1.ps1`** / `.sh` — exercise [MECH] ACs sequentially:

- AC-1: delegate returns within 500ms
- AC-2: queue position correctness (first job → running, second job → queued)
- AC-3: poll(wait_ms=0) returns current status with partial when running
- AC-4: poll(wait_ms=N) blocks and resolves event-driven (instrument daemon to log wakeup type; assert no busy-wait via timing pattern check)
- AC-7: cancel queued job → cancelled immediately
- AC-10: audit log entries for each tool call with new job_id/workspace_id fields
- AC-12: no workspace configured → 503
- AC-13: second delegation queues behind first; transitions to running after first completes
- AC-15: tool input validation (empty prompt, oversized prompt, max_turns out of range, working_directory escape)

The harness at this phase tests against **the stub runner brought up in Phase 4**, not a real SDK invocation. Stub runner just resolves jobs immediately with a canned `complete` status. This proves the queue/poll/cancel surface works without dragging SDK integration in.

**Smoke ACs (5, 6) and cancellation-of-running (8) and cross-platform (9) and transcript inspection (11) and inferred (14) are NOT in this phase's harness.** They land at Phase 11.

**Verify:** Run the harness against a daemon with stub runner. All listed [MECH] ACs report PASS. Failures here mean queue/poll/cancel mechanics are broken — surface bugs to be fixed before SDK integration.

**Bucket:** Medium-fresh (60-120 min). First-time work on this harness; some discovery in MCP client driver patterns vs P0's ping client.

**Discovery this phase should surface:**
- Audit log field shape correctness
- Tool input validation completeness
- Event-driven vs busy-wait long-poll behavior
- 503 path correctness when workspace absent

---

### Phase 6 — Transcript writer

```
packages/daemon/src/jobs/transcript.ts
```

```typescript
export class TranscriptWriter {
  private stream: fs.WriteStream;
  private bytesWritten: number = 0;
  private readonly cap: number;

  constructor(private path: string, opts: { cap_bytes?: number } = {}) {
    this.cap = opts.cap_bytes ?? 50 * 1024 * 1024; // 50MB
    this.stream = fs.createWriteStream(path, { flags: "a", mode: 0o600 });
  }

  append(message: unknown): { written: boolean; truncated: boolean } {
    if (this.bytesWritten >= this.cap) return { written: false, truncated: true };
    const line = JSON.stringify(message) + "\n";
    this.bytesWritten += Buffer.byteLength(line, "utf8");
    this.stream.write(line);
    return { written: true, truncated: false };
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => err ? reject(err) : resolve());
    });
  }
}

export function transcriptPath(job_id: string, configDir: string): string {
  return path.join(configDir, "transcripts", `${job_id}.jsonl`);
}

export function transcriptUri(transcriptPath: string): string {
  return `file://${transcriptPath}`;
}
```

**Orphan handling:**

Add to daemon startup (`main.ts`): scan `~/.claude-bridge/transcripts/`, find files whose job IDs are not in the in-memory queue at startup. These are orphans (daemon crashed mid-job).

- Orphans <24h old: leave as-is. (User may want to inspect.)
- Orphans 24h-30d old: rename to `{job_id}.orphan.jsonl`.
- Orphans >30d old: delete.

**File permissions:** 0600 per CC-3 from `docs/conventions.md`. Mode is set on stream creation; verified by integration test.

**Cross-platform:** the `transcripts/` subdirectory must exist before write. Create on first use; check on daemon start.

**Verify:** Unit tests for append (under cap, at cap, over cap), close (flush + permission). Integration test: write a transcript, kill the process, restart, verify orphan handling.

**Bucket:** Small (30-60 min). Pure I/O, established patterns (per P0's audit log writer).

---

### Phase 7 — Workspace snapshot and diff

```
packages/daemon/src/jobs/snapshot.ts
packages/daemon/src/jobs/diff.ts
```

**`snapshot.ts`**:

```typescript
export interface WorkspaceSnapshot {
  workspace_id: string;
  taken_at: number;
  files: Map<string, FileEntry>;          // path → {hash, size}
  is_git_repo: boolean;
  git_head: string | null;                // commit SHA at snapshot time
  git_status: string | null;              // raw `git status --porcelain` output
}

export interface FileEntry {
  hash: string;                            // sha256 hex of content; empty for binary >cap
  size: number;
  is_binary: boolean;
}

export async function takeSnapshot(absPath: string, opts?: SnapshotOptions): Promise<WorkspaceSnapshot> {
  // 1. Detect if git repo (look for .git)
  // 2. Walk file tree respecting .gitignore (use ignore package or shell out to git ls-files)
  // 3. For each file: stat, hash if not binary or under binary-cap, mark binary if so
  // 4. If git repo: capture HEAD SHA and `git status --porcelain`
  // 5. Return snapshot
}
```

**Performance considerations:**

- File-tree walk on large workspaces: cap at 50,000 files; if exceeded, log a warning and proceed with what was captured.
- Hashing: streaming sha256, parallel up to N=4 concurrent.
- Skip directories matching standard ignores: `node_modules/`, `.git/`, `target/`, `dist/`, `build/`, `.next/`, etc. (use a default deny list + `.gitignore` patterns).

**`diff.ts`**:

```typescript
export interface DiffResult {
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  diff: string;
  diff_truncated: boolean;
  binary_files_changed: number;
}

export async function computeDiff(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  workspaceRoot: string
): Promise<DiffResult> {
  // 1. files_created = paths in after.files but not before.files
  // 2. files_deleted = paths in before.files but not after.files
  // 3. files_modified = paths in both with different hashes
  // 4. Binary files: count separately, exclude from diff text
  // 5. If both snapshots have is_git_repo=true and same git_head: use `git diff` for the diff string
  // 6. Else: per-file unified diff via the `diff` npm package or shell-out to `diff -u`
  // 7. Cap total diff at 256 KB; set diff_truncated if exceeded
}
```

**Git path:** when available and snapshots are at consistent HEAD, `git diff HEAD -- <paths>` is the canonical diff. Faster and produces standard format.

**Fallback path:** non-git workspaces or git unavailable. Use the `diff` npm package (small, focused) to produce per-file unified diffs, concatenate.

**Binary detection:** check first 8 KB for null bytes; standard heuristic. Binary files are listed in `files_modified`/`files_created`/`files_deleted` but excluded from the diff text. `binary_files_changed` count is set in the result.

**Verify:** Unit tests with fixture directories (use vitest's `vi.mock` for fs, or `mock-fs` package, or temp dirs created in setup). Cover: file added, file removed, file modified, binary file added, gitignore'd file change excluded, diff truncation at cap.

**Bucket:** Medium-fresh (60-120 min). Diff computation has discovery (git path vs fallback, binary handling, truncation behavior).

---

### Phase 8 — Report assembler

```
packages/daemon/src/jobs/report.ts
```

```typescript
export interface ReportAssemblyInput {
  job: Job;
  before_snapshot: WorkspaceSnapshot | null;
  after_snapshot: WorkspaceSnapshot;
  transcript_path: string;
  transcript_truncated: boolean;
  transcript_truncation_reason: string | null;
  error: ErrorDetail | null;
}

export async function assembleReport(input: ReportAssemblyInput): Promise<DelegationReport> {
  // 1. Compute diff if before_snapshot present
  // 2. Read transcript, derive shell_commands, count tool_calls and turns, extract summary
  // 3. Compose report
}

function extractSummary(transcriptPath: string): Promise<string> { /* last assistant non-tool-call message */ }
function extractShellCommands(transcriptPath: string): Promise<ShellCommand[]> { /* filter for bash tool calls */ }
function countTurns(transcriptPath: string): Promise<{ turns: number; tool_calls: number }> { /* ... */ }
```

**Transcript parsing:**

- Read jsonl line-by-line (don't slurp).
- Identify message types: user / assistant / system / tool_use / tool_result.
- Turn count = number of assistant messages.
- Tool calls = number of tool_use blocks.
- Shell commands = tool_use entries where the tool is the SDK's bash tool (name to be confirmed at Phase 9; placeholder pattern: `tool === "Bash"` or `tool === "bash"`).
- Summary = content of last assistant message that has no tool_use blocks (the final natural-language closer).

**Resilience:** transcript may be incomplete (cancelled mid-message, daemon crashed). Parser must handle truncated lines, missing final message, partial JSON. On parse failures: skip the malformed line, continue. Log to daemon log at warn level.

**Diagnostics fields:** populated with empty arrays in P1. The interface shape is preserved for P2.

**Status mapping:**

- `complete`: SDK exited 0, transcript has a final assistant message.
- `failed`: SDK exited non-0 OR a runner-level error (timeout, spawn failure). `error` field populated.
- `cancelled`: user-initiated cancellation. `error.category = "cancelled"`.

**Verify:** Unit tests with fixture transcripts (jsonl files in `packages/daemon/test/fixtures/transcripts/`). Cover: clean completion, mid-turn cancellation, mid-message truncation, no final assistant message, only-tool-calls transcript.

**Bucket:** Small-medium (60-90 min). Most discovery is in transcript schema (Phase 9 finalizes it).

---

### Phase 9 — Claude Code SDK integration

**The largest task in P1.** Replaces `StubJobRunner` with `SdkJobRunner`. Resolves Q-P1-1, Q-P1-2, Q-P1-3.

```
packages/daemon/src/jobs/sdk-runner.ts
packages/daemon/src/jobs/runner.ts          # update: SdkJobRunner replaces StubJobRunner
```

**Steps within this phase:**

1. **Install the SDK.** `npm install @anthropic-ai/claude-code -w packages/daemon`. Pin to a specific minor in `package.json`. Record the pinned version in a project-state note for awareness.

2. **Discover the SDK's actual surface.** Read its README/docs. Inspect the package's TypeScript definitions. Confirm what the daemon needs:
   - Programmatic invocation (function call, not CLI subprocess unless that's the only path)
   - Inputs: prompt, cwd, max_turns, model, permission mode
   - Outputs: streamed messages with a stable schema
   - Termination: signal-based or via a returned controller object
   - Auth: how the SDK gets its own Anthropic API key (env var, config, etc.)

   **This is a scope-decision pre-conversation moment.** Surface the SDK's actual constraints to the user before drafting the runner. The lean is "use the SDK as it presents itself; don't shim". If the SDK requires meaningful adapter work, escalate.

3. **Build `SdkJobRunner`:**

```typescript
export class SdkJobRunner implements JobRunner {
  private currentJobId: string | null = null;
  private currentSdkHandle: SdkHandle | null = null;  // exact type from SDK
  private configDir: string;

  constructor(
    private queue: JobQueue,
    private registry: WorkspaceRegistry,
    private logger: Logger,
    configDir: string
  ) {
    this.configDir = configDir;
    this.queue.on(job => this.onJobChange(job));
  }

  tickle(): void {
    if (this.currentJobId !== null) return;  // busy
    queueMicrotask(() => this.dispatchNext());
  }

  async cancel(job_id: string): Promise<void> {
    if (this.currentJobId !== job_id) return; // not running this one
    if (!this.currentSdkHandle) return;
    // Cross-platform termination: see Phase 10
  }

  private async dispatchNext(): Promise<void> {
    const next = this.queue.nextQueued();
    if (!next) return;

    const workspace = this.registry.resolve(next.workspace_id);
    if (!workspace) {
      // Workspace removed between enqueue and dispatch — rare but possible
      this.queue.markFailed(next.id, { category: "internal", message: "workspace_resolved_null", details: null }, /* report */);
      return;
    }

    this.currentJobId = next.id;
    this.queue.markRunning(next.id);

    const transcriptPath = transcriptPathFor(next.id, this.configDir);
    const writer = new TranscriptWriter(transcriptPath);
    const before = await takeSnapshot(workspace.abs_path);

    try {
      // Invoke SDK; pipe messages to writer + partial-progress tracking
      this.currentSdkHandle = invokeSdk({
        prompt: composePrompt(next, workspace),
        cwd: next.working_directory ?? workspace.abs_path,
        max_turns: next.max_turns,
        model: next.model,
        permission_mode: mapMode(next.mode),
        onMessage: (msg) => {
          writer.append(msg);
          this.updatePartial(next.id, msg);
        }
      });

      await this.currentSdkHandle.done;
      await writer.close();

      const after = await takeSnapshot(workspace.abs_path);
      const report = await assembleReport({
        job: next, before_snapshot: before, after_snapshot: after,
        transcript_path: transcriptPath, transcript_truncated: false,
        transcript_truncation_reason: null, error: null
      });
      this.queue.markComplete(next.id, report);
    } catch (err) {
      await writer.close();
      const after = await takeSnapshot(workspace.abs_path);
      const errorDetail = classifyError(err);
      const report = await assembleReport({
        job: next, before_snapshot: before, after_snapshot: after,
        transcript_path: transcriptPath, transcript_truncated: false,
        transcript_truncation_reason: null, error: errorDetail
      });
      if (next.cancel_requested) this.queue.markCancelled(next.id, report);
      else this.queue.markFailed(next.id, errorDetail, report);
    } finally {
      this.currentJobId = null;
      this.currentSdkHandle = null;
      // Process next in queue
      this.tickle();
    }
  }
}
```

4. **Compose prompt:** in P1 this is a thin wrapper. The prompt that goes to the SDK is: a header line identifying the workspace_id, then the user's `prompt` field, then exhibits if any (formatted as ` --- EXHIBIT: <path> --- ` blocks with content). P2's auto-attach snapshot extends this.

5. **Map mode to SDK permission flag:** lean is direct passthrough (`read_only` → SDK's read-only flag, `agentic` → SDK's full-tool flag). Exact flag names come from Phase 9's SDK discovery. Document the mapping in a comment in the runner.

6. **Partial progress tracking:**

```typescript
private updatePartial(job_id: string, msg: unknown): void {
  // Increment turns counter when assistant message arrives
  // Set last_tool when tool_use block appears
  // Update elapsed_ms
  this.queue.updatePartial(job_id, { turns_so_far, last_tool, elapsed_ms });
}
```

7. **Error classification:**

```typescript
function classifyError(err: unknown): ErrorDetail {
  // SDK auth error → category: "auth"
  // SDK permission error (read_only refusal) → category: "permission"
  // SDK runtime exception → category: "sdk_runtime"
  // Spawn failure / not found → category: "internal"
  // Process killed by us → category: "cancelled" (set elsewhere)
  // Timeout → category: "timeout"
}
```

**Verify:** Integration test with the real SDK against a small throwaway workspace (a fresh `git init` repo with one file). Tests:

- A trivial delegation completes; transcript exists; report has correct fields.
- A delegation hitting `max_turns: 1` returns with `truncated: true`, `truncation_reason: "max_turns"`.
- A delegation against a malformed SDK config returns `status: failed` with `error.category: "internal"`.

**Bucket:** Medium-fresh, leaning toward Large (90-180 min). Two reasons: (a) SDK discovery has unknown surface; (b) first end-to-end real invocation surfaces real-world issues per P0's pattern.

**Discovery this phase likely surfaces:** SDK permission flag names, SDK message schema details, SDK process/cancellation primitives, auth-via-API-key plumbing. Each is a scope-decision-or-escalation moment per v0.4 §22.5.

---

### Phase 10 — Cancellation of running jobs

```
packages/daemon/src/jobs/sdk-runner.ts     # extend cancel()
packages/daemon/src/util/process-kill.ts   # cross-platform termination helper
```

**`process-kill.ts`**:

```typescript
export async function terminateProcess(handle: SdkHandle, opts?: { graceMs?: number }): Promise<void> {
  const grace = opts?.graceMs ?? 10_000;
  if (process.platform === "win32") {
    // taskkill /T /F /PID <pid> — kills process tree
    // Use child_process.exec; await completion
  } else {
    // SIGTERM, wait up to graceMs, then SIGKILL
    handle.kill("SIGTERM");
    await Promise.race([handle.exited, sleep(grace)]);
    if (!handle.hasExited) handle.kill("SIGKILL");
  }
}
```

The exact SDK handle interface is the one Phase 9 settled on. The helper adapts to whatever shape that is.

**Extension to `SdkJobRunner.cancel()`:**

```typescript
async cancel(job_id: string): Promise<void> {
  if (this.currentJobId !== job_id) return;
  if (!this.currentSdkHandle) return;
  this.queue.markCancelRequested(job_id);
  await terminateProcess(this.currentSdkHandle, { graceMs: 10_000 });
  // dispatchNext()'s catch block will mark the job cancelled
}
```

**Verify:** Integration test on Windows AND WSL Ubuntu (cross-platform per P0 carry). Test: start a delegation with a prompt designed to take >20s ("count slowly to 100 by writing to a log file, with a 200ms sleep between each number"). Cancel after 5s. Assert: job reaches terminal cancelled state within 15s, SDK subprocess is verifiably gone (PID check), report is assembled with cancelled status.

**Bucket:** Small-medium (60-90 min). Cross-platform process termination has known gotchas; the test surfaces them.

---

### Phase 11 — Acceptance harness expansion ([SMOKE] ACs)

Extends the harness from Phase 5 to cover [SMOKE] and remaining ACs.

```
scripts/acceptance-p1.ps1   # extend
scripts/acceptance-p1.sh    # extend
```

Add steps for:

- **AC-5** (agentic delegation end-to-end): delegate "write a file called hello.txt in the workspace root with content 'hi from claude-code'", wait for terminal, assert report status complete, files_created includes hello.txt, transcript_uri readable.
- **AC-6** (read_only refusal): delegate "write a file called bad.txt" in read_only mode, assert either status complete with no file change OR status failed with error.category permission.
- **AC-8** (cancel running): delegate a long-running prompt, cancel after 5s, assert terminal cancelled within 15s, SDK process gone.
- **AC-11** (transcript readability): after AC-5, open the transcript file, parse as jsonl, assert it has at least one assistant message and at least one tool_use entry.
- **AC-14** (job retention inference): unit test with fake clock; harness step references the unit test result. AC is marked VERIFIED-WITH-UNIT-TEST per the [INFER] category.

**Sandbox workspace:** the harness creates a temporary workspace at `${TEMP_DIR}/claude-bridge-p1-sandbox/` for each run. `git init`, single file, then runs the SMOKE delegations against it. Cleans up at the end.

**Verify:** Run on Windows. All [MECH], [SMOKE], and [INFER]-referenced ACs PASS. This phase's PASS is one of the gate-close criteria.

**Bucket:** Small-medium (60-90 min). Mostly assembly; expect some discovery in real SDK behavior under SMOKE conditions.

**Discovery this phase likely surfaces:** real SDK behavior differences from the stub-runner assumptions, transcript schema details, permission-mode behavior nuances.

---

### Phase 12 — Cross-platform verification (WSL Ubuntu)

Trivial+setup task. Run the Phase 11 harness on WSL Ubuntu. Capture results. Reconcile any Windows-vs-WSL differences (likely paths, process termination, file permissions).

**Bucket:** Trivial+setup (10-25 min). Mechanical re-run.

**Likely findings:** carry from P0 — Windows-vs-Unix discipline is continuous. Don't be surprised by differences; document and fix at site.

---

### Phase 13 — Runbook and walkthrough updates

```
docs/runbook.md            # extend
docs/walkthrough.md        # update OAuth-dependent UX claims (flag deferred)
README.md                  # mention P1 capability
```

**Runbook additions:**

- Configuring the `workspace` block in `config.json`.
- Invoking a delegation from MCP Inspector (worked example with screenshots or transcript).
- Invoking a delegation from Claude Code CLI (`claude mcp add` command + `claude -p "use the delegate_to_claude_code tool to ..."`).
- Reading transcripts: format, location, manual inspection.
- Troubleshooting: 503 no_workspace_configured, job stuck in queued, SDK auth failures, transcript truncation.

**Walkthrough updates:**

- Add a banner near the top noting that the OAuth path (Claude.ai project chat connector) is deferred. The walkthrough describes the target UX; the Bearer-compatible-client path is what works today.
- Flag specific UX claims that depend on OAuth: the "First delegation" section's project-Claude flow assumes Claude.ai project chat works, which it doesn't yet for static Bearer.

**README:** add a paragraph about P1 capability (delegations work via Bearer-compatible MCP clients).

**Verify:** Run the runbook procedures end-to-end on a clean machine. Each step produces the expected outcome.

**Bucket:** Medium-consolidation (15-30 min). Doc-only, consolidating known material.

---

### Phase 14 — P1 gate close

Trivial. Mirror of P0's gate-close pattern.

- Update `docs/milestones.md`: P1 GATE-CLOSED, date, AC table.
- Update `docs/project-state.md`: phase = P2, next-action set.
- Calibration data captured in `docs/calibration-log.md` or equivalent.
- Final commit with subject `gate: P1 — Headless Delegation GATE-CLOSED`.
- Open P2 design conversation (or schedule it).
- Produce P1-close context snapshot at `docs/snapshot/orchestrator-context-p1-close.md` per methodology v0.4 §17.7.

**Bucket:** Trivial (5-15 min).

---

## Acceptance test summary

The harness at `scripts/acceptance-p1.ps1` (and `.sh`) is the canonical verification surface. It exercises ACs in this order:

| AC | Phase covered | Verification category |
|----|---------------|----------------------|
| AC-1 | Phase 5 | MECH |
| AC-2 | Phase 5 | MECH |
| AC-3 | Phase 5 | MECH |
| AC-4 | Phase 5 | MECH |
| AC-5 | Phase 11 | SMOKE |
| AC-6 | Phase 11 | SMOKE |
| AC-7 | Phase 5 | MECH |
| AC-8 | Phase 11 | MECH (cross-platform Phase 10/12) |
| AC-9 | Phase 12 | MECH (cross-platform re-run) |
| AC-10 | Phase 5 | MECH |
| AC-11 | Phase 11 | MECH |
| AC-12 | Phase 5 | MECH |
| AC-13 | Phase 5 | MECH |
| AC-14 | Phase 3 | INFER (unit test referenced) |
| AC-15 | Phase 5 | MECH |
| AC-16 | Phases 5+11 | (the harness itself) |

## Definition of done

- [ ] All 16 acceptance criteria pass per their verification category
- [ ] `npm run build` clean from root
- [ ] `npm run test` passes; new tests cover Phase 1-3, 6-8 unit-testable surface
- [ ] `npm run lint` clean (zero-fire streak on `recommendedTypeChecked` continues, or any new fires explained)
- [ ] No TODO comments in `packages/daemon/src/jobs/` or `packages/daemon/src/mcp/tools/`
- [ ] Runbook covers workspace config, delegation invocation, transcript reading, troubleshooting
- [ ] Walkthrough flags OAuth-deferred sections
- [ ] One real end-to-end delegation exercised via Bearer-compatible MCP client
- [ ] Cross-platform: at least AC-5 verified on Windows AND WSL Ubuntu
- [ ] P1-close context snapshot produced at `docs/snapshot/orchestrator-context-p1-close.md`
- [ ] P2 design doc (`docs/design/03-p2-extension.md`) started

## Estimated effort

Rough sizing for execution (Clyde-time on no-wait dev host, per P0 calibration buckets):

| Phase | Bucket | Effort |
|-------|--------|--------|
| 1. Shared types | Small | 30-60 min |
| 2. Workspace registry stub | Small | 30-60 min |
| 3. Job queue + state machine | Medium-fresh | 60-120 min |
| 4. Tool surface | Small-medium | 30-90 min |
| 5. Acceptance harness skeleton | Medium-fresh | 60-120 min |
| 6. Transcript writer | Small | 30-60 min |
| 7. Snapshot + diff | Medium-fresh | 60-120 min |
| 8. Report assembler | Small-medium | 60-90 min |
| 9. SDK integration | Large | 90-180 min |
| 10. Cancellation cross-platform | Small-medium | 60-90 min |
| 11. Acceptance harness expansion | Small-medium | 60-90 min |
| 12. WSL cross-platform run | Trivial+setup | 10-25 min |
| 13. Runbook + walkthrough | Medium-consolidation | 15-30 min |
| 14. Gate close | Trivial | 5-15 min |
| **Total Clyde-time** | | **~10-15 hours** |

Calendar effort with evening-pace dispatch + verdict cycles: roughly 2-3 weeks. Comparable to P0 (~2.5 weeks for 22 tasks); P1's phases will slice into ~14-18 tasks during execution.

## Out of scope (still)

Same as `02-p1-delegation.md` "Out of scope" section. No extension, no auto-attach, no Tier-2 tools, no OAuth, no approval UI, no concurrent jobs, no persistent job state, no diagnostics in reports. Resist scope creep — each shortcut is a P2/P3 problem to absorb later.

Per v0.4 §22.5: reactive fixes inside scope are encouraged; reactive scope expansion is a consultation trigger. When uncertain, consult orchestrator.
