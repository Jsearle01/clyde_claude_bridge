import { describe, it, expect } from "vitest";
import type { ToolContext } from "../../../src/mcp/dispatch.js";
import { makeCancelTool } from "../../../src/mcp/tools/cancel.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { StubJobRunner } from "../../../src/jobs/runner.js";
import type { AuditLog } from "../../../src/audit/log.js";
import type { Logger } from "../../../src/log/logger.js";
import type { DaemonState } from "../../../src/state.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

const stubState: DaemonState = {
  version: "0.1.0",
  startedAt: 0,
  tunnelStatus: "up",
  tunnelUrl: null,
  config: {} as never,
};

function makeCtx(): ToolContext {
  return {
    request_id: "req_cncl0000",
    remote_addr: "tunnel",
    auditLog: {} as AuditLog,
    logger: silentLogger,
    state: stubState,
  };
}

const baseEnq = {
  workspace_id: "w",
  prompt: "hi",
  mode: "agentic" as const,
  max_turns: 30,
};

describe("cancel_delegation", () => {
  it("cancels a queued job → status cancelled, prior queued", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    const { job } = queue.enqueue(baseEnq);
    const tool = makeCancelTool({ queue, runner });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("cancelled");
    expect(out.prior_status).toBe("queued");
    expect(queue.get(job.id)?.status).toBe("cancelled");
  });

  it("cancels a running job → status cancelled, prior running; runner.cancel kicked", async () => {
    const queue = new JobQueue();
    let runnerCancelCalled = false;
    const runner = {
      tickle: () => undefined,
      cancel: () => {
        runnerCancelCalled = true;
        return Promise.resolve();
      },
    };
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext();
    const tool = makeCancelTool({ queue, runner });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("cancelled");
    expect(out.prior_status).toBe("running");
    expect(runnerCancelCalled).toBe(true);
  });

  it("already-terminal job → already_terminal + prior status", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext();
    queue.markComplete(job.id, {
      job_id: job.id,
      workspace_id: "w",
      status: "complete",
      summary: "",
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
      error: null,
    });
    const tool = makeCancelTool({ queue, runner });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("already_terminal");
    expect(out.prior_status).toBe("complete");
  });

  it("unknown id → not_found, no runner.cancel call", async () => {
    const queue = new JobQueue();
    let runnerCancelCalled = false;
    const runner = {
      tickle: () => undefined,
      cancel: () => {
        runnerCancelCalled = true;
        return Promise.resolve();
      },
    };
    const tool = makeCancelTool({ queue, runner });
    const out = await tool.handler({ job_id: "j_NOPE" }, makeCtx());
    expect(out.status).toBe("not_found");
    expect(out.prior_status).toBeNull();
    expect(runnerCancelCalled).toBe(false);
  });
});
