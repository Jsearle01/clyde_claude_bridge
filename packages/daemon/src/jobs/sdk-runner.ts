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
import { checkToolFloor } from "./floor.js";
import { hashInput } from "../audit/hash.js";
import type { InteractionRecorder, ReportSummary } from "../audit/interaction.js";
import { assembleReport } from "./report.js";
import { takeSnapshot } from "./snapshot.js";
import { TranscriptWriter, transcriptPath } from "./transcript.js";
import type { Job, JobRunState } from "./types.js";
import type { JobRunner } from "./runner.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

const INTERRUPT_TIMEOUT_MS = 10_000;

// T-P3-006: the Bash deny-list + the always-gate floor (force-push, remote-
// ref deletion, rm-rf outside-workspace / workspace-root / .git, and the
// ~/.claude-bridge self-protection) live in `floor.ts` and apply to Bash
// commands AND Write/Edit target paths via `checkToolFloor`.

function mapMode(mode: "read_only" | "agentic"): PermissionMode {
  return mode === "read_only" ? "plan" : "acceptEdits";
}

// In plan mode the SDK lets Claude exit-plan via ExitPlanMode (auto-approved),
// flipping permissionMode to "default" mid-run and letting writes through on
// the next turn. Pinning `disallowedTools` for read_only delegations blocks
// the write tools regardless of mode flips. T-P1-010 SMOKE caught this on
// Windows (smoke #2 failed with status=failed+category=sdk_runtime — file
// happened not to be written only because max_turns=3 ran out mid-plan).
const READ_ONLY_DISALLOWED_TOOLS: ReadonlyArray<string> = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "ExitPlanMode",
];

// T-P3-007: compact mechanical summary of a DelegationReport for the
// interaction log's terminal events.
function reportSummary(report: DelegationReport): ReportSummary {
  return {
    status: report.status,
    files_created: report.files_created.length,
    files_modified: report.files_modified.length,
    files_deleted: report.files_deleted.length,
    shell_commands: report.shell_commands.length,
    turns: report.turns,
  };
}

// T-P3-006: hard-deny floor. `canUseTool` is the only in-execution daemon
// interception point (the delegate gate fires once, pre-execution, blind to
// concrete ops). It returns a HARD-DENY — not an approval prompt: there is no
// mid-run human channel; the floor BLOCKS and Clyde abort-reports the reason.
// Inspects Bash commands AND Write/Edit/MultiEdit/NotebookEdit target paths.
// T-P3-007: also emits accountability events — floor_denied on a block, and
// push_observed when a (NOT-floored) git push is seen. Exported for tests.
export function makeCanUseTool(
  workspaceRoot: string,
  configDir: string,
  recorder: InteractionRecorder | undefined,
  job_id: string,
  workspace_id: string,
): CanUseTool {
  return (toolName, input) => {
    const decision = checkToolFloor(toolName, input, workspaceRoot, configDir);
    if (decision.denied) {
      const reason = decision.reason ?? "forbidden operation";
      recorder?.record({
        kind: "floor_denied",
        job_id,
        workspace_id,
        tool: toolName,
        reason,
      });
      return Promise.resolve({
        behavior: "deny",
        message: `Blocked by claude-bridge floor: ${reason}`,
      });
    }
    // Observe (do not block) a git push — non-force push is authorization-
    // governed, but OBSERVING it is the accountability record's job.
    if (toolName === "Bash" && recorder !== undefined) {
      const command =
        typeof (input as { command?: unknown }).command === "string"
          ? (input as { command: string }).command
          : "";
      if (/\bgit\s+push\b/.test(command)) {
        recorder.record({
          kind: "push_observed",
          job_id,
          workspace_id,
          command_hash: hashInput(command),
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
    // T-P3-007: optional so existing constructions (tests) compile unchanged;
    // production wiring (main.ts) passes the recorder for terminal +
    // floor_denied + push_observed events.
    private readonly interactionRecorder?: InteractionRecorder,
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
      // T-P3-006: floor keyed to this job's workspace root (the SDK cwd) +
      // the daemon's auth dir (~/.claude-bridge), for the self-protection rule.
      // T-P3-007: also emits floor_denied + push_observed to the interaction log.
      canUseTool: makeCanUseTool(
        workspace.abs_path,
        // P3′-1b: the floor's self-protected auth dir is THIS daemon's state
        // dir (where tokens.json now lives), i.e. the per-daemon config-dir
        // threaded in at construction — not the flat root.
        this.configDir,
        this.interactionRecorder,
        job.id,
        workspace.id,
      ),
      abortController,
      settingSources: [],
    };
    if (job.mode === "read_only") {
      options.disallowedTools = [...READ_ONLY_DISALLOWED_TOOLS];
    }
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
      this.interactionRecorder?.record({
        kind: "delegation_cancelled",
        job_id: job.id,
        workspace_id: workspace.id,
        duration_ms: Date.now() - startedAt,
        report_summary: reportSummary(report),
      });
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
      this.interactionRecorder?.record({
        kind: "delegation_aborted",
        job_id: job.id,
        workspace_id: workspace.id,
        duration_ms: Date.now() - startedAt,
        error_category: errDetail.category,
        report_summary: reportSummary(report),
      });
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
      this.interactionRecorder?.record({
        kind: "delegation_completed",
        job_id: job.id,
        workspace_id: workspace.id,
        duration_ms: Date.now() - startedAt,
        report_summary: reportSummary(report),
      });
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
