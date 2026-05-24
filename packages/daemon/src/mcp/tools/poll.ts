// `poll_delegation` tool handler. Non-blocking by default; if `wait_ms > 0`
// and the job is not yet terminal, awaits the queue's terminal_promise
// with a timeout. Event-driven, not busy-wait.

import {
  PollInputSchema,
  type PollInput,
  type PollOutput,
  isTerminal,
} from "@claude-bridge/shared";
import { ToolHandlerError, type ToolDef } from "../dispatch.js";
import type { JobQueue } from "../../jobs/queue.js";

export interface PollDeps {
  queue: JobQueue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function makePollTool(deps: PollDeps): ToolDef<PollInput, PollOutput> {
  return {
    name: "poll_delegation",
    description:
      "Poll a delegation job. Optionally long-poll for terminal state up to wait_ms.",
    inputSchema: PollInputSchema,
    async handler(input, ctx) {
      const initial = deps.queue.get(input.job_id);
      if (initial === null) {
        throw new ToolHandlerError(
          404,
          "job_not_found",
          `unknown job_id: ${input.job_id}`,
        );
      }

      const waitMs = input.wait_ms ?? 0;
      if (waitMs > 0 && !isTerminal(initial.status)) {
        const tp = deps.queue.terminalPromise(input.job_id);
        if (tp !== null) {
          await Promise.race([tp, sleep(waitMs)]);
        }
      }

      const fresh = deps.queue.get(input.job_id);
      if (fresh === null) {
        // Job was swept between poll start and now — extremely unlikely
        // (24h retention) but defend.
        throw new ToolHandlerError(
          404,
          "job_not_found",
          `job_id no longer exists: ${input.job_id}`,
        );
      }

      ctx.setAuditMetadata?.({
        job_id: fresh.id,
        workspace_id: fresh.workspace_id,
      });

      return {
        job_id: fresh.id,
        status: fresh.status,
        queued_position:
          fresh.status === "queued"
            ? deps.queue.queuedPosition(fresh.id)
            : null,
        report: isTerminal(fresh.status) ? fresh.report : null,
        partial: fresh.status === "running" ? fresh.partial : null,
      };
    },
  };
}
