// Claude Agent SDK-driven JobRunner. Replaces StubJobRunner as the
// default runner; StubJobRunner stays available behind --allow-stub-config
// for the T-P1-005 acceptance harness.
//
// SDK INTEGRATION SHAPE (confirmed against @anthropic-ai/claude-agent-sdk
// 0.3.x at T-P1-009):
//
//   Package: @anthropic-ai/claude-agent-sdk (renamed from
//   @anthropic-ai/claude-code in late 2025; build plan + design doc still
//   reference the old name — P1-close doc-debt sweep handles).
//
//   Entry: `query({ prompt, options })` returns a Query which extends
//   AsyncGenerator<SDKMessage, void>. Iterate to drive the conversation.
//
//   Permission mode mapping:
//     read_only  → "plan"         (SDK's plan/read-only mode)
//     agentic    → "acceptEdits"  (auto-accept edits + filesystem ops)
//
//   Cancellation: via Options.abortController (NOT query.interrupt()).
//   Reactive deviation from Decision 4: interrupt() per the SDK d.ts
//   comment is "only supported when streaming input/output is used".
//   For single-prompt (non-streaming) delegations, AbortController is the
//   documented path — works regardless of streaming mode and doesn't
//   require restructuring the prompt as an AsyncIterable.
//
//   Bash deny list: enforced via canUseTool callback (per Decision 3).
//   Hardcoded P1; .claude-bridge.json per-workspace overrides are P2.
//
//   Auth: SDK reads ANTHROPIC_API_KEY from environment. Daemon startup
//   warns when the key is absent (main.ts) but doesn't block —
//   delegations will fail at runtime with category: "auth".

import { AbortError, query, type CanUseTool, type Options, type PermissionMode, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  DelegationReport,
  ErrorDetail,
  PartialProgress,
} from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";
import type { JobQueue } from "./queue.js";
import { assembleReport } from "./report.js";
import { takeSnapshot } from "./snapshot.js";
import { TranscriptWriter, transcriptPath } from "./transcript.js";
import type { Job, JobRunState } from "./types.js";
import type { JobRunner } from "./runner.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

const INTERRUPT_TIMEOUT_MS = 10_000;

// Bash command deny patterns sourced from `docs/design/00-overview.md`
// §"Bash deny list". P1-only — P2 layers per-workspace .claude-bridge.json
// overrides on top.
const BASH_DENY_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[rRf]+\s+)*\/(?:\s|$)/, reason: "rm of root filesystem" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "dd to device file" },
  { pattern: /\bsudo\b/, reason: "sudo invocation" },
  { pattern: /\bnpm\s+install\b/, reason: "npm install" },
  { pattern: /\bpip\s+install\b/, reason: "pip install" },
  { pattern: /\bapt(-get)?\s+install\b/, reason: "apt install" },
  { pattern: /\bbrew\s+install\b/, reason: "brew install" },
  { pattern: /(\$HOME|~|\/)\/?\.ssh(\/|\b)/, reason: "~/.ssh access" },
  { pattern: /(\$HOME|~|\/)\/?\.aws(\/|\b)/, reason: "~/.aws access" },
];

function mapMode(mode: "read_only" | "agentic"): PermissionMode {
  return mode === "read_only" ? "plan" : "acceptEdits";
}

function commandToString(value: unknown): string {
  // Avoid Object's default stringification ("[object Object]") for the
  // common-error case where input.command is missing or non-string.
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function makeCanUseTool(): CanUseTool {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (toolName, input, options) => {
    if (toolName !== "Bash") {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    const command = commandToString((input as { command?: unknown }).command);
    for (const { pattern, reason } of BASH_DENY_PATTERNS) {
      if (pattern.test(command)) {
        return Promise.resolve({
          behavior: "deny",
          message: `Blocked by claude-bridge deny list: ${reason}`,
        });
      }
    }
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  };
}

function classifyError(err: unknown): ErrorDetail {
  if (err instanceof AbortError) {
    return { category: "cancelled", message: "interrupted", details: null };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const details = err instanceof Error ? (err.stack ?? null) : null;
  if (/auth|api[_\s-]?key|401|unauthorized/i.test(msg)) {
    return { category: "auth", message: msg, details };
  }
  if (/permission|denied|forbidden/i.test(msg)) {
    return { category: "permission", message: msg, details };
  }
  if (/timeout|timed out/i.test(msg)) {
    return { category: "timeout", message: msg, details };
  }
  if (/spawn|ENOENT|cannot find/i.test(msg)) {
    return { category: "internal", message: msg, details };
  }
  return { category: "sdk_runtime", message: msg, details };
}

function composePrompt(job: Job, workspaceAbsPath: string): string {
  const header =
    `# Workspace: ${job.workspace_id}\n` +
    `# Path: ${workspaceAbsPath}\n\n`;
  let exhibits = "";
  for (const e of job.exhibits) {
    exhibits += `\n--- EXHIBIT: ${e.path} ---\n`;
    if (e.content !== undefined) exhibits += `${e.content}\n`;
    exhibits += `--- END EXHIBIT: ${e.path} ---\n`;
  }
  return `${header}${job.prompt}${exhibits}`;
}

interface SDKMessageWithMessage {
  type: string;
  message?: {
    content?: unknown;
  };
}

function lastToolNameFromMessage(msg: SDKMessage): string | null {
  // SDKAssistantMessage.message.content can be an array of content blocks;
  // each block has a `type` and (for tool_use) a `name`. Return the most
  // recent tool name observed in the message.
  const m = msg as SDKMessageWithMessage;
  if (m.type !== "assistant") return null;
  const content = m.message?.content;
  if (!Array.isArray(content)) return null;
  let last: string | null = null;
  for (const block of content) {
    const b = block as { type?: unknown; name?: unknown };
    if (b.type === "tool_use" && typeof b.name === "string") last = b.name;
  }
  return last;
}

export class SdkJobRunner implements JobRunner {
  private currentJobId: string | null = null;
  private currentAbort: AbortController | null = null;
  private currentQuery: Query | null = null;
  private busy = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly registry: WorkspaceRegistry,
    private readonly configDir: string,
    private readonly logger: Logger,
  ) {}

  tickle(): void {
    if (this.busy) return;
    queueMicrotask(() => {
      void this.dispatchNext();
    });
  }

  async cancel(job_id: string): Promise<void> {
    if (this.currentJobId !== job_id) return;
    const ac = this.currentAbort;
    if (ac === null) return;
    // AbortController.abort triggers AbortError inside the SDK's iterator
    // on the next yield boundary. Race against a hard timeout so we don't
    // hang indefinitely if the SDK doesn't honor the abort cleanly.
    ac.abort();
    await Promise.race([
      new Promise<void>((res) => {
        const id = setInterval(() => {
          if (this.currentJobId !== job_id) {
            clearInterval(id);
            res();
          }
        }, 50);
        // Safety: clear if the wait outlives the runner state.
        setTimeout(() => {
          clearInterval(id);
          res();
        }, INTERRUPT_TIMEOUT_MS);
      }),
    ]);
  }

  private async dispatchNext(): Promise<void> {
    if (this.busy) return;
    const claimed = this.queue.claimNext();
    if (claimed === null) return;
    this.busy = true;
    const { job, state } = claimed;
    this.currentJobId = job.id;
    const startedAt = Date.now();

    const workspace = this.registry.resolve(job.workspace_id);
    if (workspace === null) {
      const report = await assembleReport({
        job,
        run_state: state,
        before_snapshot: null,
        after_snapshot: null,
        transcript_path: null,
        transcript_writer_truncated: false,
        error: {
          category: "internal",
          message: "workspace_resolved_null",
          details: null,
        },
        duration_ms: Date.now() - startedAt,
        turns_cap: job.max_turns,
        workspace_root: "",
      });
      this.queue.markFailed(
        job.id,
        { category: "internal", message: "workspace_resolved_null", details: null },
        report,
      );
      this.finishCycle();
      return;
    }

    const tpath = transcriptPath(job.id, this.configDir);
    const writer = new TranscriptWriter(tpath);
    const beforeSnapshot = await takeSnapshot(workspace.id, workspace.abs_path).catch(
      (err: unknown) => {
        this.logger.warn("before-snapshot failed", { error: String(err) });
        return null;
      },
    );

    const composedPrompt = composePrompt(job, workspace.abs_path);
    const abortController = new AbortController();
    this.currentAbort = abortController;

    const options: Options = {
      cwd: workspace.abs_path,
      maxTurns: job.max_turns,
      permissionMode: mapMode(job.mode),
      canUseTool: makeCanUseTool(),
      abortController,
      settingSources: [],
    };
    if (job.model !== null) options.model = job.model;

    let q: Query;
    try {
      q = query({ prompt: composedPrompt, options });
      this.currentQuery = q;
    } catch (err) {
      // Construction-time error (rare; SDK validates options).
      await this.failJob(job, state, beforeSnapshot, workspace.abs_path, tpath, writer, classifyError(err), startedAt);
      this.finishCycle();
      return;
    }

    let turnsSeen = 0;
    let lastTool: string | null = null;
    let caughtErr: unknown = null;

    try {
      for await (const msg of q) {
        try {
          writer.append(msg);
        } catch {
          // Writer should not throw under normal load; ignore.
        }
        if (msg.type === "assistant") {
          turnsSeen++;
          const t = lastToolNameFromMessage(msg);
          if (t !== null) lastTool = t;
          const partial: PartialProgress = {
            turns_so_far: turnsSeen,
            last_tool: lastTool,
            elapsed_ms: Date.now() - startedAt,
          };
          this.queue.updatePartial(job.id, partial);
        }
      }
    } catch (err) {
      caughtErr = err;
    }

    try {
      await writer.close();
    } catch {
      // Best-effort.
    }

    const afterSnapshot = await takeSnapshot(workspace.id, workspace.abs_path).catch(
      (err: unknown) => {
        this.logger.warn("after-snapshot failed", { error: String(err) });
        return null;
      },
    );

    // Cancellation: either the caller invoked cancel() (queue's
    // cancel_requested flag is set) OR the SDK raised AbortError.
    const wasCancelled =
      state.cancel_requested === true ||
      caughtErr instanceof AbortError;

    if (wasCancelled) {
      const report = await assembleReport({
        job,
        run_state: state,
        before_snapshot: beforeSnapshot,
        after_snapshot: afterSnapshot,
        transcript_path: tpath,
        transcript_writer_truncated: writer.truncated,
        error: { category: "cancelled", message: "cancelled by user", details: null },
        duration_ms: Date.now() - startedAt,
        turns_cap: job.max_turns,
        workspace_root: workspace.abs_path,
      });
      this.queue.markCancelled(job.id, report);
    } else if (caughtErr !== null) {
      const errDetail = classifyError(caughtErr);
      const report = await assembleReport({
        job,
        run_state: state,
        before_snapshot: beforeSnapshot,
        after_snapshot: afterSnapshot,
        transcript_path: tpath,
        transcript_writer_truncated: writer.truncated,
        error: errDetail,
        duration_ms: Date.now() - startedAt,
        turns_cap: job.max_turns,
        workspace_root: workspace.abs_path,
      });
      this.queue.markFailed(job.id, errDetail, report);
    } else {
      const report = await assembleReport({
        job,
        run_state: state,
        before_snapshot: beforeSnapshot,
        after_snapshot: afterSnapshot,
        transcript_path: tpath,
        transcript_writer_truncated: writer.truncated,
        error: null,
        duration_ms: Date.now() - startedAt,
        turns_cap: job.max_turns,
        workspace_root: workspace.abs_path,
      });
      this.queue.markComplete(job.id, report);
    }

    this.finishCycle();
  }

  private async failJob(
    job: Job,
    state: JobRunState,
    beforeSnapshot: import("./snapshot.js").WorkspaceSnapshot | null,
    workspaceRoot: string,
    tpath: string,
    writer: TranscriptWriter,
    errDetail: ErrorDetail,
    startedAt: number,
  ): Promise<void> {
    try {
      await writer.close();
    } catch {
      // ignore
    }
    const afterSnapshot = await takeSnapshot(job.workspace_id, workspaceRoot).catch(
      () => null,
    );
    const report = await assembleReport({
      job,
      run_state: state,
      before_snapshot: beforeSnapshot,
      after_snapshot: afterSnapshot,
      transcript_path: tpath,
      transcript_writer_truncated: writer.truncated,
      error: errDetail,
      duration_ms: Date.now() - startedAt,
      turns_cap: job.max_turns,
      workspace_root: workspaceRoot,
    });
    this.queue.markFailed(job.id, errDetail, report);
    // void unused-report to satisfy lint if needed; report is consumed above.
    void report;
  }

  private finishCycle(): void {
    this.currentJobId = null;
    this.currentAbort = null;
    this.currentQuery = null;
    this.busy = false;
    // Pick up next queued job, if any.
    this.tickle();
  }
}

// Re-export type for downstream test files that want to use it.
export type { DelegationReport };
