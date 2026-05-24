import { describe, it, expect } from "vitest";
import { JobQueue } from "../../src/jobs/queue.js";
import { StubJobRunner } from "../../src/jobs/runner.js";

const baseEnq = {
  workspace_id: "w",
  prompt: "hi",
  mode: "agentic" as const,
  max_turns: 30,
};

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

describe("StubJobRunner — default behavior (complete immediately)", () => {
  it("marks a queued job complete after tickle", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await queue.terminalPromise(job.id);
    const v = queue.get(job.id);
    expect(v?.status).toBe("complete");
    expect(v?.report?.status).toBe("complete");
    expect(v?.report?.transcript_uri).toMatch(/stub/);
  });

  it("processes multiple jobs sequentially (single-concurrent honored)", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    const a = queue.enqueue(baseEnq);
    const b = queue.enqueue(baseEnq);
    runner.tickle();
    await queue.terminalPromise(a.job.id);
    await queue.terminalPromise(b.job.id);
    expect(queue.get(a.job.id)?.status).toBe("complete");
    expect(queue.get(b.job.id)?.status).toBe("complete");
  });
});

describe("StubJobRunner — setBehavior", () => {
  it("outcome=failed marks job failed with non-null error", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    runner.setBehavior({ outcome: "failed" });
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await queue.terminalPromise(job.id);
    const v = queue.get(job.id);
    expect(v?.status).toBe("failed");
    expect(v?.error?.category).toBe("sdk_runtime");
  });

  it("outcome=cancelled marks job cancelled (runner-initiated path)", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    runner.setBehavior({ outcome: "cancelled" });
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await queue.terminalPromise(job.id);
    expect(queue.get(job.id)?.status).toBe("cancelled");
  });

  it("delay_ms keeps job in running state for the configured duration", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    runner.setBehavior({ outcome: "complete", delay_ms: 80 });
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await sleep(20);
    expect(queue.get(job.id)?.status).toBe("running");
    await queue.terminalPromise(job.id);
    expect(queue.get(job.id)?.status).toBe("complete");
  });

  it("partial_updates apply updatePartial during simulated work", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    runner.setBehavior({
      outcome: "complete",
      delay_ms: 60,
      partial_updates: [
        { turns_so_far: 1, last_tool: "Read", elapsed_ms: 20 },
        { turns_so_far: 2, last_tool: "Bash", elapsed_ms: 40 },
        { turns_so_far: 3, last_tool: "Write", elapsed_ms: 60 },
      ],
    });
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await sleep(30);
    const mid = queue.get(job.id);
    expect(mid?.status).toBe("running");
    expect(mid?.partial?.turns_so_far).toBeGreaterThanOrEqual(1);
    await queue.terminalPromise(job.id);
    expect(queue.get(job.id)?.status).toBe("complete");
  });
});

describe("StubJobRunner — cancel_requested honored at outcome-apply", () => {
  it("user-initiated cancel of running job → marked cancelled despite configured outcome=complete", async () => {
    const queue = new JobQueue();
    const runner = new StubJobRunner(queue);
    runner.setBehavior({ outcome: "complete", delay_ms: 60 });
    const { job } = queue.enqueue(baseEnq);
    runner.tickle();
    await sleep(10); // let the job transition to running
    queue.cancel(job.id); // sets cancel_requested = true on running job
    await queue.terminalPromise(job.id);
    expect(queue.get(job.id)?.status).toBe("cancelled");
  });
});
