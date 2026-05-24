// JobRunner contract + StubJobRunner. The interface is what the tool
// surface depends on; Phase 9's SdkJobRunner implements the same shape
// and swaps in without changing tool factories.
//
// StubJobRunner is configurable so Phase 5's acceptance harness can
// exercise complete / failed / cancelled / partial-progress paths
// without monkeypatching or needing per-test subclasses. The configurable
// behavior is implementation-only; `JobRunner` stays minimal.

import type {
  DelegationReport,
  ErrorDetail,
  PartialProgress,
} from "@claude-bridge/shared";
import type { JobQueue } from "./queue.js";
import type { Job, JobRunState } from "./types.js";

export interface JobRunner {
  /** Signal that a job may be available. Idempotent; no-op if busy or
   * if no jobs are queued. The tool's delegate handler calls this after
   * enqueueing; the runner calls it on its own after marking a terminal
   * state (to pick up the next queued job). */
  tickle(): void;

  /** Initiate cancellation of a running job. Resolves when the runner
   * has finished its cancellation work (which may include awaiting
   * subprocess termination in P1 Phase 10's SdkJobRunner). StubJobRunner
   * resolves immediately — its cancel_requested honoring happens at the
   * next outcome-apply boundary, not via this method. */
  cancel(job_id: string): Promise<void>;
}

export interface StubJobRunnerBehavior {
  outcome: "complete" | "failed" | "cancelled";
  /** Simulated work duration in ms before applying the outcome. Default 0. */
  delay_ms?: number;
  /** Optional override of report fields; merged onto the stub's canned
   * default. */
  report?: Partial<DelegationReport>;
  /** Sequence of partial-progress payloads to apply via
   * queue.updatePartial during the simulated run. Spread evenly across
   * `delay_ms` (or applied instantly with no delay if delay_ms is 0). */
  partial_updates?: PartialProgress[];
  /** Optional error detail used when outcome is "failed". */
  error?: ErrorDetail;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export class StubJobRunner implements JobRunner {
  private behavior: StubJobRunnerBehavior;
  private busy = false;

  constructor(
    private readonly queue: JobQueue,
    defaultBehavior: StubJobRunnerBehavior = { outcome: "complete" },
  ) {
    this.behavior = defaultBehavior;
  }

  /** Reconfigure subsequent jobs' canned outcome. Used by the Phase 5
   * acceptance harness to switch between complete / failed / cancelled
   * paths without per-test subclasses. */
  setBehavior(b: StubJobRunnerBehavior): void {
    this.behavior = b;
  }

  tickle(): void {
    if (this.busy) return;
    queueMicrotask(() => {
      void this.advance();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  cancel(job_id: string): Promise<void> {
    // Stub: no subprocess to terminate. The queue's cancel_requested
    // flag (set by queue.cancel for running jobs) is honored at the
    // outcome-apply boundary inside advance(). Phase 10's SdkJobRunner
    // will implement real cross-platform process termination here.
    return Promise.resolve();
  }

  private async advance(): Promise<void> {
    if (this.busy) return;
    const claimed = this.queue.claimNext();
    if (claimed === null) return;
    this.busy = true;
    try {
      await this.simulateWork(claimed.job);
      this.applyOutcome(claimed);
    } finally {
      this.busy = false;
    }
    // Pick up next queued job, if any.
    this.tickle();
  }

  private async simulateWork(job: Job): Promise<void> {
    const updates = this.behavior.partial_updates ?? [];
    const delay = this.behavior.delay_ms ?? 0;
    if (updates.length === 0) {
      if (delay > 0) await sleep(delay);
      return;
    }
    const slice = updates.length > 0 ? Math.floor(delay / updates.length) : 0;
    for (const u of updates) {
      if (slice > 0) await sleep(slice);
      this.queue.updatePartial(job.id, u);
    }
  }

  private applyOutcome(claimed: { job: Job; state: JobRunState }): void {
    const { job, state } = claimed;
    // Honor user-initiated cancellation: if cancel_requested was set
    // (queue.cancel called on a running job), apply cancelled regardless
    // of configured outcome.
    const effective = state.cancel_requested ? "cancelled" : this.behavior.outcome;
    const report = this.buildReport(job, effective);
    switch (effective) {
      case "complete":
        this.queue.markComplete(job.id, report);
        return;
      case "failed":
        this.queue.markFailed(job.id, this.buildError(), report);
        return;
      case "cancelled":
        this.queue.markCancelled(job.id, report);
        return;
    }
  }

  private buildReport(
    job: Job,
    status: "complete" | "failed" | "cancelled",
  ): DelegationReport {
    const base: DelegationReport = {
      job_id: job.id,
      workspace_id: job.workspace_id,
      status,
      summary: `<stub: ${status}>`,
      files_created: [],
      files_modified: [],
      files_deleted: [],
      diff: "",
      diff_truncated: false,
      diagnostics_before: [],
      diagnostics_after: [],
      diagnostics_delta: { added: [], resolved: [] },
      shell_commands: [],
      tool_calls_made: 0,
      turns: 0,
      duration_ms: this.behavior.delay_ms ?? 0,
      truncated: false,
      truncation_reason: null,
      transcript_uri: `file:///stub/transcripts/${job.id}.jsonl`,
      error: null,
    };
    return this.behavior.report !== undefined
      ? { ...base, ...this.behavior.report }
      : base;
  }

  private buildError(): ErrorDetail {
    return (
      this.behavior.error ?? {
        category: "sdk_runtime",
        message: "<stub: failed>",
        details: null,
      }
    );
  }
}
