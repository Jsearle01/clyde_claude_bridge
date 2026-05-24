// In-memory job queue for P1 delegation. Single-concurrent design: at
// most one job in `running` state at any time. Strict state machine —
// illegal transitions throw `JobStateError`. The queue is the source of
// truth for job state; the runner (Phase 9) drives transitions through
// the `markX` methods.
//
// Long-poll primitive: each job's `terminal_promise` resolves when its
// status reaches a terminal state (complete / failed / cancelled). The
// poll tool (Phase 4) awaits it inside `Promise.race` with a timeout.
//
// Retention: terminal-state jobs are removed by `sweep()`, called from
// the daemon's daily timer (T-P1-003 wired DailyTimer); 24h after
// `terminal_at`. The dangling-resolver footgun (runner forgets to call a
// markX method) is bounded by sweep removing the whole record.
//
// Clock injection (`opts.now`) lets tests control elapsed time without
// vitest-timer-API coupling.

import type {
  DelegationReport,
  ErrorDetail,
  JobStatus,
  PartialProgress,
} from "@claude-bridge/shared";
import { isTerminal } from "@claude-bridge/shared";
import { generateJobId } from "./id.js";
import {
  JobStateError,
  type CancelResult,
  type EnqueueInput,
  type Job,
  type JobRunState,
  type JobView,
} from "./types.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;

interface JobRecord {
  job: Job;
  state: JobRunState;
}

export interface JobQueueOpts {
  now?: () => number;
}

export class JobQueue {
  private readonly now: () => number;
  private readonly records = new Map<string, JobRecord>();
  private readonly pending: string[] = []; // FIFO of queued job ids
  private running: string | null = null;

  constructor(opts: JobQueueOpts = {}) {
    this.now = opts.now ?? ((): number => Date.now());
  }

  // ---- mutation API ----

  enqueue(input: EnqueueInput): { job: JobView; queued_position: number } {
    const id = generateJobId();
    const enqueued_at = this.now();
    const job: Job = {
      id,
      workspace_id: input.workspace_id,
      prompt: input.prompt,
      exhibits: input.exhibits ?? [],
      mode: input.mode,
      model: input.model ?? null,
      max_turns: input.max_turns,
      working_directory: input.working_directory ?? null,
      enqueued_at,
    };
    let resolveTerminal!: () => void;
    const terminal_promise = new Promise<void>((res) => {
      resolveTerminal = res;
    });
    const state: JobRunState = {
      status: "queued",
      prior_status: null,
      started_at: null,
      terminal_at: null,
      partial: null,
      report: null,
      error: null,
      terminal_promise,
      resolve_terminal: resolveTerminal,
      cancel_requested: false,
    };
    this.records.set(id, { job, state });
    this.pending.push(id);
    const queued_position = this.pending.length - 1;
    return { job: this.viewOf(id)!, queued_position };
  }

  /** Atomic queued → running transition for the runner. Returns null
   * when no queued job is available OR a job is already running (single-
   * concurrent design). The runner calls this on each dispatch cycle. */
  claimNext(): { job: Job; state: JobRunState } | null {
    if (this.running !== null) return null;
    const id = this.pending.shift();
    if (id === undefined) return null;
    const rec = this.records.get(id);
    if (rec === undefined) return null; // shouldn't happen; defensive
    rec.state.prior_status = rec.state.status;
    rec.state.status = "running";
    rec.state.started_at = this.now();
    this.running = id;
    return { job: rec.job, state: rec.state };
  }

  cancel(id: string): CancelResult {
    const rec = this.records.get(id);
    if (rec === undefined) {
      return { status: "not_found", prior_status: null };
    }
    const prior = rec.state.status;
    if (isTerminal(prior)) {
      return { status: "already_terminal", prior_status: prior };
    }
    if (prior === "queued") {
      // Remove from FIFO, transition directly to cancelled, assemble
      // minimal report (no SDK invocation occurred).
      const idx = this.pending.indexOf(id);
      if (idx !== -1) this.pending.splice(idx, 1);
      const report = this.minimalCancelledReport(rec.job);
      this.transitionToTerminal(rec, "cancelled", prior, report, null);
      return { status: "cancelled", prior_status: prior };
    }
    // Running: set cancel_requested and let the runner drive termination.
    // State remains "running" until runner calls markCancelled.
    rec.state.cancel_requested = true;
    return { status: "cancelled", prior_status: prior };
  }

  // ---- read API ----

  get(id: string): JobView | null {
    return this.viewOf(id);
  }

  list(): JobView[] {
    return Array.from(this.records.keys())
      .map((id) => this.viewOf(id))
      .filter((v): v is JobView => v !== null);
  }

  /** Position of `id` in the FIFO queue (0 = next to run after the
   * currently-running one finishes). Returns null if the job is not in
   * `queued` state, or is unknown. */
  queuedPosition(id: string): number | null {
    const rec = this.records.get(id);
    if (rec === undefined) return null;
    if (rec.state.status !== "queued") return null;
    const idx = this.pending.indexOf(id);
    return idx === -1 ? null : idx;
  }

  /** Exposed for the poll tool's long-poll: await this with a timeout. */
  terminalPromise(id: string): Promise<void> | null {
    return this.records.get(id)?.state.terminal_promise ?? null;
  }

  // ---- state-transition API (called by the runner) ----

  markComplete(id: string, report: DelegationReport): void {
    const rec = this.requireRunning(id, "markComplete");
    this.transitionToTerminal(rec, "complete", rec.state.status, report, null);
  }

  markFailed(id: string, error: ErrorDetail, report: DelegationReport): void {
    const rec = this.requireRunning(id, "markFailed");
    this.transitionToTerminal(rec, "failed", rec.state.status, report, error);
  }

  markCancelled(id: string, report: DelegationReport): void {
    const rec = this.requireRunning(id, "markCancelled");
    const err: ErrorDetail = {
      category: "cancelled",
      message: "cancelled by user",
      details: null,
    };
    this.transitionToTerminal(rec, "cancelled", rec.state.status, report, err);
  }

  updatePartial(id: string, partial: PartialProgress): void {
    const rec = this.records.get(id);
    if (rec === undefined) return; // silent: runner may race with cancellation/sweep
    if (rec.state.status !== "running") return;
    rec.state.partial = partial;
  }

  // ---- lifecycle ----

  /** Removes terminal jobs whose `terminal_at` is older than 24h.
   * Returns the count removed. Best-effort: does not throw. */
  sweep(): number {
    const cutoff = this.now() - RETENTION_MS;
    let removed = 0;
    for (const [id, rec] of this.records) {
      if (
        rec.state.terminal_at !== null &&
        rec.state.terminal_at < cutoff
      ) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // ---- internal helpers ----

  private viewOf(id: string): JobView | null {
    const rec = this.records.get(id);
    if (rec === undefined) return null;
    return {
      id: rec.job.id,
      workspace_id: rec.job.workspace_id,
      prompt: rec.job.prompt,
      exhibits: rec.job.exhibits,
      mode: rec.job.mode,
      model: rec.job.model,
      max_turns: rec.job.max_turns,
      working_directory: rec.job.working_directory,
      enqueued_at: rec.job.enqueued_at,
      status: rec.state.status,
      prior_status: rec.state.prior_status,
      started_at: rec.state.started_at,
      terminal_at: rec.state.terminal_at,
      partial: rec.state.partial,
      report: rec.state.report,
      error: rec.state.error,
    };
  }

  private requireRunning(id: string, op: string): JobRecord {
    const rec = this.records.get(id);
    if (rec === undefined) {
      throw new JobStateError(`${op}: unknown job id ${id}`);
    }
    if (rec.state.status !== "running") {
      throw new JobStateError(
        `${op}: job ${id} is in state ${rec.state.status}, expected running`,
      );
    }
    return rec;
  }

  private transitionToTerminal(
    rec: JobRecord,
    next: JobStatus,
    prior: JobStatus,
    report: DelegationReport | null,
    error: ErrorDetail | null,
  ): void {
    rec.state.prior_status = prior;
    rec.state.status = next;
    rec.state.terminal_at = this.now();
    rec.state.report = report;
    if (error !== null) rec.state.error = error;
    if (this.running === rec.job.id) this.running = null;
    rec.state.resolve_terminal();
  }

  private minimalCancelledReport(job: Job): DelegationReport {
    return {
      job_id: job.id,
      workspace_id: job.workspace_id,
      status: "cancelled",
      summary: "<cancelled before run>",
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
      duration_ms: 0,
      truncated: false,
      truncation_reason: null,
      transcript_uri: "",
      error: {
        category: "cancelled",
        message: "cancelled before run",
        details: null,
      },
    };
  }
}
