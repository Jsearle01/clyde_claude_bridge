// `cancel_delegation` tool handler. Cancels via JobQueue.cancel; if the
// job was running, also kicks the runner's cancel path (no-op in
// StubJobRunner; Phase 10's SdkJobRunner does cross-platform process
// termination).

import {
  CancelInputSchema,
  type CancelInput,
  type CancelOutput,
} from "@claude-bridge/shared";
import { type ToolDef } from "../dispatch.js";
import type { JobQueue } from "../../jobs/queue.js";
import type { JobRunner } from "../../jobs/runner.js";

export interface CancelDeps {
  queue: JobQueue;
  runner: JobRunner;
}

export function makeCancelTool(
  deps: CancelDeps,
): ToolDef<CancelInput, CancelOutput> {
  return {
    name: "cancel_delegation",
    description: "Request cancellation of a delegation job.",
    inputSchema: CancelInputSchema,
    async handler(input, ctx) {
      // Resolve workspace_id BEFORE cancel — cancel may transition to a
      // terminal state immediately, but the JobView still has the field.
      // For not_found we omit workspace_id from audit metadata.
      const view = deps.queue.get(input.job_id);
      if (view !== null) {
        ctx.setAuditMetadata?.({
          job_id: view.id,
          workspace_id: view.workspace_id,
        });
      } else {
        ctx.setAuditMetadata?.({ job_id: input.job_id });
      }

      const result = deps.queue.cancel(input.job_id);

      // For running jobs, kick the runner's cancel path. The queue's
      // cancel() has already set cancel_requested; the runner observes
      // it at outcome-apply time (StubJobRunner) or initiates process
      // termination (Phase 10's SdkJobRunner).
      if (result.status === "cancelled" && result.prior_status === "running") {
        await deps.runner.cancel(input.job_id);
      }

      return {
        job_id: input.job_id,
        status: result.status,
        prior_status: result.prior_status,
      };
    },
  };
}
