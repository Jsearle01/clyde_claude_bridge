import { describe, it, expect } from "vitest";
import type { DelegationReport, ErrorDetail } from "@claude-bridge/shared";
import { JobQueue, JobStateError } from "../../src/jobs/index.js";
import type { EnqueueInput } from "../../src/jobs/index.js";

const baseInput: EnqueueInput = {
  workspace_id: "local#default",
  prompt: "do the thing",
  mode: "agentic",
  max_turns: 30,
};

function makeReport(job_id: string, status: "complete" | "failed" | "cancelled" = "complete"): DelegationReport {
  return {
    job_id,
    workspace_id: "local#default",
    status,
    summary: status === "complete" ? "done" : "",
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

const sampleError: ErrorDetail = {
  category: "sdk_runtime",
  message: "exploded",
  details: null,
};

describe("JobQueue — enqueue + initial state", () => {
  it("enqueue sets status=queued, returns position 0 for first job", () => {
    const q = new JobQueue({ now: () => 1000 });
    const { job, queued_position } = q.enqueue(baseInput);
    expect(job.status).toBe("queued");
    expect(job.enqueued_at).toBe(1000);
    expect(queued_position).toBe(0);
    expect(job.id).toMatch(/^j_[A-Z2-7]{12}$/);
  });

  it("enqueue returns a snapshot — mutating it does not affect queue state", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    // JobView is `readonly` at the type level; assert at runtime that the
    // queue's internal state is decoupled. Re-reading via get() gives a
    // fresh snapshot reflecting only legitimate transitions.
    const before = q.get(job.id);
    // Force-mutate the returned object (cast away readonly):
    (job as { status: string }).status = "complete";
    const after = q.get(job.id);
    expect(before.status).toBe("queued");
    expect(after.status).toBe("queued");
  });

  it("enqueue increments queued_position for subsequent jobs", () => {
    const q = new JobQueue();
    const a = q.enqueue(baseInput);
    const b = q.enqueue(baseInput);
    const c = q.enqueue(baseInput);
    expect(a.queued_position).toBe(0);
    expect(b.queued_position).toBe(1);
    expect(c.queued_position).toBe(2);
  });
});

describe("JobQueue — claimNext (atomic + FIFO + single-concurrent)", () => {
  it("claimNext atomically transitions queued → running", () => {
    const q = new JobQueue({ now: () => 5000 });
    const { job } = q.enqueue(baseInput);
    const claim = q.claimNext();
    expect(claim).not.toBeNull();
    expect(claim.state.status).toBe("running");
    expect(claim.state.started_at).toBe(5000);
    expect(claim.state.prior_status).toBe("queued");
    expect(q.get(job.id).status).toBe("running");
  });

  it("claimNext returns null when no queued jobs", () => {
    const q = new JobQueue();
    expect(q.claimNext()).toBeNull();
  });

  it("claimNext returns null when a job is already running (single-concurrent)", () => {
    const q = new JobQueue();
    q.enqueue(baseInput);
    q.enqueue(baseInput);
    expect(q.claimNext()).not.toBeNull();
    expect(q.claimNext()).toBeNull();
  });

  it("claimNext is FIFO across multiple enqueues", () => {
    const q = new JobQueue();
    const a = q.enqueue(baseInput);
    const b = q.enqueue(baseInput);
    const c = q.enqueue(baseInput);
    const first = q.claimNext();
    expect(first.job.id).toBe(a.job.id);
    q.markComplete(a.job.id, makeReport(a.job.id));
    const second = q.claimNext();
    expect(second.job.id).toBe(b.job.id);
    q.markComplete(b.job.id, makeReport(b.job.id));
    const third = q.claimNext();
    expect(third.job.id).toBe(c.job.id);
  });
});

describe("JobQueue — queuedPosition", () => {
  it("returns null for a currently-running job", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    expect(q.queuedPosition(job.id)).toBeNull();
  });

  it("returns 1+ for jobs behind a running one", () => {
    const q = new JobQueue();
    q.enqueue(baseInput);
    const b = q.enqueue(baseInput);
    const c = q.enqueue(baseInput);
    q.claimNext(); // claims A
    // After claim, pending is [b, c] → b is at index 0, c at index 1.
    expect(q.queuedPosition(b.job.id)).toBe(0);
    expect(q.queuedPosition(c.job.id)).toBe(1);
  });

  it("returns null for terminal jobs", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    expect(q.queuedPosition(job.id)).toBeNull();
  });

  it("returns null for unknown ids", () => {
    const q = new JobQueue();
    expect(q.queuedPosition("j_NOPE")).toBeNull();
  });
});

describe("JobQueue — cancel semantics", () => {
  it("cancel queued job → status flips to cancelled immediately + report assembled", async () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    const result = q.cancel(job.id);
    expect(result.status).toBe("cancelled");
    expect(result.prior_status).toBe("queued");
    const v = q.get(job.id);
    expect(v.status).toBe("cancelled");
    expect(v.report?.status).toBe("cancelled");
    expect(v.report?.error?.category).toBe("cancelled");
    // terminal_promise resolves
    await q.terminalPromise(job.id);
  });

  it("cancel running job → sets cancel_requested, status stays running", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    const claim = q.claimNext();
    const result = q.cancel(job.id);
    expect(result.status).toBe("cancelled");
    expect(result.prior_status).toBe("running");
    expect(claim.state.cancel_requested).toBe(true);
    expect(q.get(job.id).status).toBe("running");
  });

  it("cancel already-terminal job → already_terminal with prior_status", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    const result = q.cancel(job.id);
    expect(result.status).toBe("already_terminal");
    expect(result.prior_status).toBe("complete");
  });

  it("cancel unknown id → not_found", () => {
    const q = new JobQueue();
    const result = q.cancel("j_NOPE");
    expect(result.status).toBe("not_found");
    expect(result.prior_status).toBeNull();
  });

  it("cancel of queued removes from FIFO order", () => {
    const q = new JobQueue();
    const a = q.enqueue(baseInput);
    const b = q.enqueue(baseInput);
    const c = q.enqueue(baseInput);
    q.cancel(b.job.id);
    // A is still next; cancelling B should leave A → C order.
    const first = q.claimNext();
    expect(first.job.id).toBe(a.job.id);
    q.markComplete(a.job.id, makeReport(a.job.id));
    const second = q.claimNext();
    expect(second.job.id).toBe(c.job.id);
  });
});

describe("JobQueue — state-transition rules", () => {
  it("markComplete on a queued job throws JobStateError", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    expect(() => q.markComplete(job.id, makeReport(job.id))).toThrow(
      JobStateError,
    );
  });

  it("markComplete on already-terminal throws", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    expect(() => q.markComplete(job.id, makeReport(job.id))).toThrow(
      JobStateError,
    );
  });

  it("markFailed on unknown id throws", () => {
    const q = new JobQueue();
    expect(() => q.markFailed("j_NOPE", sampleError, makeReport("j_NOPE", "failed"))).toThrow(
      JobStateError,
    );
  });

  it("markCancelled on a queued job throws (queued cancel goes through cancel())", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    expect(() => q.markCancelled(job.id, makeReport(job.id, "cancelled"))).toThrow(
      JobStateError,
    );
  });

  it("markFailed transitions running → failed and populates error", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markFailed(job.id, sampleError, makeReport(job.id, "failed"));
    const v = q.get(job.id);
    expect(v.status).toBe("failed");
    expect(v.error?.category).toBe("sdk_runtime");
  });
});

describe("JobQueue — terminal_promise resolution", () => {
  async function expectsResolvesQuickly(p: Promise<void>): Promise<void> {
    const timeout = new Promise<string>((r) => setTimeout(() => r("TIMEOUT"), 50));
    const result = await Promise.race([p.then(() => "RESOLVED"), timeout]);
    expect(result).toBe("RESOLVED");
  }

  it("resolves on markComplete", async () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    const p = q.terminalPromise(job.id);
    q.markComplete(job.id, makeReport(job.id));
    await expectsResolvesQuickly(p);
  });

  it("resolves on markFailed", async () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    const p = q.terminalPromise(job.id);
    q.markFailed(job.id, sampleError, makeReport(job.id, "failed"));
    await expectsResolvesQuickly(p);
  });

  it("resolves on markCancelled", async () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    const p = q.terminalPromise(job.id);
    q.markCancelled(job.id, makeReport(job.id, "cancelled"));
    await expectsResolvesQuickly(p);
  });

  it("resolves on cancel-of-queued", async () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    const p = q.terminalPromise(job.id);
    q.cancel(job.id);
    await expectsResolvesQuickly(p);
  });
});

describe("JobQueue — updatePartial", () => {
  it("sets partial on a running job", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.updatePartial(job.id, {
      turns_so_far: 3,
      last_tool: "Bash",
      elapsed_ms: 100,
    });
    expect(q.get(job.id).partial?.turns_so_far).toBe(3);
  });

  it("is a no-op on a queued job (partial stays null)", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.updatePartial(job.id, {
      turns_so_far: 1,
      last_tool: null,
      elapsed_ms: 0,
    });
    expect(q.get(job.id).partial).toBeNull();
  });

  it("is a no-op on a terminal job (does not throw, does not mutate)", () => {
    const q = new JobQueue();
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    expect(() =>
      q.updatePartial(job.id, {
        turns_so_far: 99,
        last_tool: "x",
        elapsed_ms: 0,
      }),
    ).not.toThrow();
    expect(q.get(job.id).partial).toBeNull();
  });

  it("is a no-op on unknown id (silent)", () => {
    const q = new JobQueue();
    expect(() =>
      q.updatePartial("j_NOPE", {
        turns_so_far: 0,
        last_tool: null,
        elapsed_ms: 0,
      }),
    ).not.toThrow();
  });
});

describe("JobQueue — sweep (24h retention)", () => {
  it("retains terminal jobs younger than 24h", () => {
    let t = 1000;
    const q = new JobQueue({ now: () => t });
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    // terminal_at = 1000; advance to just under 24h later.
    t = 1000 + 24 * 60 * 60 * 1000 - 1;
    expect(q.sweep()).toBe(0);
    expect(q.get(job.id)).not.toBeNull();
  });

  it("removes terminal jobs older than 24h", () => {
    let t = 1000;
    const q = new JobQueue({ now: () => t });
    const { job } = q.enqueue(baseInput);
    q.claimNext();
    q.markComplete(job.id, makeReport(job.id));
    t = 1000 + 24 * 60 * 60 * 1000 + 1;
    expect(q.sweep()).toBe(1);
    expect(q.get(job.id)).toBeNull();
  });

  it("does not remove non-terminal jobs (queued, running)", () => {
    let t = 1000;
    const q = new JobQueue({ now: () => t });
    const a = q.enqueue(baseInput);
    q.enqueue(baseInput); // stays queued
    q.claimNext(); // a is now running; terminal_at still null
    t += 24 * 60 * 60 * 1000 * 365; // a year passes
    expect(q.sweep()).toBe(0);
    expect(q.get(a.job.id)?.status).toBe("running");
  });
});

describe("JobQueue — list", () => {
  it("returns all known jobs", () => {
    const q = new JobQueue();
    q.enqueue(baseInput);
    q.enqueue(baseInput);
    expect(q.list()).toHaveLength(2);
  });

  it("returns empty array when no jobs", () => {
    expect(new JobQueue().list()).toEqual([]);
  });
});
