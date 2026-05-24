// Job queue type surface. Two types per Decision 6, T-P1-003:
//
//   - `Job` is immutable-after-enqueue: prompt, exhibits, target workspace,
//     mode, model, max_turns, working_directory, id, enqueued_at. Set once
//     at enqueue, never mutated.
//
//   - `JobRunState` is mutable runtime bookkeeping: current status,
//     transition timestamps, partial-progress + report payloads, and the
//     internal coordination primitives (terminal_promise, resolver,
//     cancel_requested) the runner uses.
//
// `JobView` is the composed read-side surface consumers see via the queue's
// public API (`get`, `enqueue`, etc.). It carries Job fields + the readable
// JobRunState fields. The internal coordination primitives are
// deliberately not in `JobView` — callers that need to await terminal
// state go through `JobQueue` (the queue exposes the promise via
// `claimNext()` for the runner; tools call `poll()` which waits internally).
//
// `Job` and `JobRunState` are daemon-internal; nothing crosses the wire as
// these shapes. The MCP wire contracts live in `@claude-bridge/shared`
// (DelegateInput/Output, PollInput/Output, etc.) and the runner / tool
// handlers project between them and these internal types.

import type {
  Exhibit,
  PartialProgress,
  DelegationReport,
  ErrorDetail,
  CancelResult as SharedCancelResult,
  JobStatus,
} from "@claude-bridge/shared";

export interface Job {
  readonly id: string;
  readonly workspace_id: string;
  readonly prompt: string;
  readonly exhibits: readonly Exhibit[];
  readonly mode: "read_only" | "agentic";
  readonly model: string | null;
  readonly max_turns: number;
  readonly working_directory: string | null;
  readonly enqueued_at: number;
}

export interface JobRunState {
  status: JobStatus;
  prior_status: JobStatus | null;
  started_at: number | null;
  terminal_at: number | null;
  partial: PartialProgress | null;
  report: DelegationReport | null;
  error: ErrorDetail | null;
  /** Resolves when status reaches a terminal state. The runner consumes
   * this via the queue's `terminalPromise(id)` getter; the public read
   * surface (JobView) intentionally hides it to keep terminal coordination
   * inside the queue. */
  terminal_promise: Promise<void>;
  /** Captured resolver for terminal_promise. Internal coordination. */
  resolve_terminal: () => void;
  /** Set by `cancel()` when called on a running job; observed by the
   * runner to decide whether a terminating subprocess should result in
   * `cancelled` vs `failed`. */
  cancel_requested: boolean;
}

/** Read-only composed view of a job's full state for consumers. Excludes
 * the internal coordination primitives (terminal_promise, resolve_terminal,
 * cancel_requested). */
export interface JobView {
  // Job fields
  readonly id: string;
  readonly workspace_id: string;
  readonly prompt: string;
  readonly exhibits: readonly Exhibit[];
  readonly mode: "read_only" | "agentic";
  readonly model: string | null;
  readonly max_turns: number;
  readonly working_directory: string | null;
  readonly enqueued_at: number;
  // Readable JobRunState fields
  readonly status: JobStatus;
  readonly prior_status: JobStatus | null;
  readonly started_at: number | null;
  readonly terminal_at: number | null;
  readonly partial: PartialProgress | null;
  readonly report: DelegationReport | null;
  readonly error: ErrorDetail | null;
}

/** Caller-supplied fields when enqueueing a job. `id` and `enqueued_at`
 * are filled by the queue. */
export interface EnqueueInput {
  workspace_id: string;
  prompt: string;
  exhibits?: readonly Exhibit[];
  mode: "read_only" | "agentic";
  model?: string | null;
  max_turns: number;
  working_directory?: string | null;
}

/** Result of `JobQueue.cancel()`. Mirrors the shared `CancelResult`
 * shape so the cancel tool handler can return it through directly. */
export type CancelResult = {
  status: SharedCancelResult;
  prior_status: JobStatus | null;
};

/** Thrown by `JobQueue` when an illegal state transition is attempted
 * (e.g., `markComplete` on a queued or already-terminal job). */
export class JobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobStateError";
  }
}
