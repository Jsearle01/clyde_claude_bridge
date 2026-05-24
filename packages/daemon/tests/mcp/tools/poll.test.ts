import { describe, it, expect } from "vitest";
import {
  ToolHandlerError,
  type ToolContext,
} from "../../../src/mcp/dispatch.js";
import { makePollTool } from "../../../src/mcp/tools/poll.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { AuditLog } from "../../../src/audit/log.js";
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
  // AuditLog not actually appended through here in these tests (direct
  // handler invocation, not through registry); pass a benign placeholder.
  return {
    request_id: "req_poll0000",
    remote_addr: "tunnel",
    auditLog: {} as AuditLog,
    logger: silentLogger,
    state: stubState,
  };
}

function makeReport(job_id: string) {
  return {
    job_id,
    workspace_id: "w",
    status: "complete" as const,
    summary: "ok",
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
  };
}

const baseEnq = {
  workspace_id: "w",
  prompt: "hi",
  mode: "agentic" as const,
  max_turns: 30,
};

describe("poll_delegation — non-blocking path (wait_ms=0)", () => {
  it("returns queued status + queued_position for a queued job", async () => {
    const queue = new JobQueue();
    const { job } = queue.enqueue(baseEnq);
    const tool = makePollTool({ queue });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("queued");
    expect(out.queued_position).toBe(0);
    expect(out.report).toBeNull();
    expect(out.partial).toBeNull();
  });

  it("returns running status + partial for a running job", async () => {
    const queue = new JobQueue();
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext();
    queue.updatePartial(job.id, {
      turns_so_far: 2,
      last_tool: "Bash",
      elapsed_ms: 50,
    });
    const tool = makePollTool({ queue });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("running");
    expect(out.queued_position).toBeNull();
    expect(out.partial?.turns_so_far).toBe(2);
    expect(out.report).toBeNull();
  });

  it("returns terminal status + report for a complete job", async () => {
    const queue = new JobQueue();
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext();
    queue.markComplete(job.id, makeReport(job.id));
    const tool = makePollTool({ queue });
    const out = await tool.handler({ job_id: job.id }, makeCtx());
    expect(out.status).toBe("complete");
    expect(out.report?.status).toBe("complete");
    expect(out.partial).toBeNull();
  });

  it("404 job_not_found for unknown id", async () => {
    const queue = new JobQueue();
    const tool = makePollTool({ queue });
    await expect(
      tool.handler({ job_id: "j_NOPE" }, makeCtx()),
    ).rejects.toBeInstanceOf(ToolHandlerError);
  });
});

describe("poll_delegation — long-poll path", () => {
  it("resolves before wait_ms when the job completes mid-wait", async () => {
    const queue = new JobQueue();
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext();
    const tool = makePollTool({ queue });
    setTimeout(() => queue.markComplete(job.id, makeReport(job.id)), 20);
    const t0 = Date.now();
    const out = await tool.handler(
      { job_id: job.id, wait_ms: 500 },
      makeCtx(),
    );
    const elapsed = Date.now() - t0;
    expect(out.status).toBe("complete");
    expect(elapsed).toBeLessThan(400); // resolved early via terminal_promise
  });

  it("returns at ~wait_ms with non-terminal status when job doesn't complete", async () => {
    const queue = new JobQueue();
    const { job } = queue.enqueue(baseEnq);
    queue.claimNext(); // running
    const tool = makePollTool({ queue });
    const t0 = Date.now();
    const out = await tool.handler(
      { job_id: job.id, wait_ms: 60 },
      makeCtx(),
    );
    const elapsed = Date.now() - t0;
    expect(out.status).toBe("running");
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(500); // not a busy-wait
  });
});
