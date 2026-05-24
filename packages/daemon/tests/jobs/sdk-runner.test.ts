// SDK smoke tests for SdkJobRunner. Gated by ANTHROPIC_API_KEY presence:
// without the key, the entire suite skips cleanly (CI can run without
// burning credits; local dev with the key set exercises the real SDK).
//
// These tests satisfy the SMOKE half of design doc ACs 5 (agentic), 6
// (read_only), 8 (cancellation). AC-9 (cross-platform) is Phase 10's
// scope. Each test spawns a fresh temp workspace + git init, runs a
// real delegation, asserts on the resulting Job state and on filesystem
// effects in the workspace.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue } from "../../src/jobs/queue.js";
import { SdkJobRunner } from "../../src/jobs/sdk-runner.js";
import { StubWorkspaceRegistry } from "../../src/workspace/registry.js";

const HAS_KEY =
  typeof process.env.ANTHROPIC_API_KEY === "string" &&
  process.env.ANTHROPIC_API_KEY.length > 0;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

function waitForTerminal(queue: JobQueue, id: string, maxMs: number): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      const v = queue.get(id);
      if (v === null) {
        reject(new Error(`job ${id} not found`));
        return;
      }
      if (
        v.status === "complete" ||
        v.status === "failed" ||
        v.status === "cancelled"
      ) {
        resolve();
        return;
      }
      if (Date.now() - start > maxMs) {
        reject(new Error(`job ${id} did not reach terminal within ${maxMs}ms (status=${v.status})`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

describe.skipIf(!HAS_KEY)("SdkJobRunner — live smoke (ANTHROPIC_API_KEY required)", () => {
  let workspaceDir: string;
  let configDir: string;
  let queue: JobQueue;
  let runner: SdkJobRunner;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "cb-sdk-ws-"));
    configDir = mkdtempSync(join(tmpdir(), "cb-sdk-cfg-"));
    execFileSync("git", ["init", "-q"], { cwd: workspaceDir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspaceDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir });
    queue = new JobQueue();
    const registry = new StubWorkspaceRegistry({
      id: "local#smoke",
      abs_path: workspaceDir,
      default_mode: "agentic",
    });
    runner = new SdkJobRunner(queue, registry, configDir, silentLogger);
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("smoke #1 happy path: trivial write delegation completes; file exists; transcript valid", async () => {
    const { job } = queue.enqueue({
      workspace_id: "local#smoke",
      prompt: "Create a file named hello.txt in the workspace root with the exact content 'hi'. Do not modify anything else.",
      mode: "agentic",
      max_turns: 5,
    });
    runner.tickle();
    await waitForTerminal(queue, job.id, 60_000);
    const v = queue.get(job.id);
    expect(v?.status).toBe("complete");
    expect(existsSync(join(workspaceDir, "hello.txt"))).toBe(true);
    expect(v?.report?.summary.length).toBeGreaterThan(0);
    const transcriptPath = join(configDir, "transcripts", `${job.id}.jsonl`);
    expect(existsSync(transcriptPath)).toBe(true);
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
  }, 90_000);

  it("smoke #2 read_only mode: write attempt refused or file unchanged", async () => {
    const { job } = queue.enqueue({
      workspace_id: "local#smoke",
      prompt: "Write a file named bad.txt with content 'should not exist'.",
      mode: "read_only",
      max_turns: 3,
    });
    runner.tickle();
    await waitForTerminal(queue, job.id, 60_000);
    const v = queue.get(job.id);
    // Acceptable: complete with no file change OR failed permission.
    const acceptedComplete = v?.status === "complete" && !existsSync(join(workspaceDir, "bad.txt"));
    const acceptedFailed = v?.status === "failed" && v.error?.category === "permission";
    expect(acceptedComplete || acceptedFailed).toBe(true);
  }, 90_000);

  it("smoke #3 bash deny: sudo-attempt blocked by canUseTool", async () => {
    const { job } = queue.enqueue({
      workspace_id: "local#smoke",
      prompt: "Run the bash command `sudo echo hello` to check what happens. Report what you observed.",
      mode: "agentic",
      max_turns: 5,
    });
    runner.tickle();
    await waitForTerminal(queue, job.id, 60_000);
    const v = queue.get(job.id);
    expect(v?.status).toBe("complete");
    // The block message should appear in the transcript as a tool_result.
    const transcriptPath = join(configDir, "transcripts", `${job.id}.jsonl`);
    const content = readFileSync(transcriptPath, "utf8");
    expect(content).toMatch(/Blocked by claude-bridge deny list/);
  }, 90_000);

  it("smoke #4 cancellation: long delegation cancelled reaches terminal cancelled within 15s", async () => {
    const { job } = queue.enqueue({
      workspace_id: "local#smoke",
      prompt: "Count slowly from 1 to 50, writing each number as a separate line to a file called counter.txt, one number per assistant turn. Take your time.",
      mode: "agentic",
      max_turns: 50,
    });
    runner.tickle();
    // Give the run a few seconds to start, then cancel.
    await new Promise((res) => setTimeout(res, 4000));
    queue.cancel(job.id);
    await runner.cancel(job.id);
    await waitForTerminal(queue, job.id, 15_000);
    expect(queue.get(job.id)?.status).toBe("cancelled");
  }, 30_000);

  it("smoke #5 max_turns: 1-turn cap triggers truncation_reason max_turns", async () => {
    const { job } = queue.enqueue({
      workspace_id: "local#smoke",
      prompt: "Step 1: read the workspace. Step 2: write a summary. Step 3: verify. Do this in order.",
      mode: "agentic",
      max_turns: 1,
    });
    runner.tickle();
    await waitForTerminal(queue, job.id, 60_000);
    const v = queue.get(job.id);
    expect(v?.report?.truncation_reason).toBe("max_turns");
    expect(v?.report?.truncated).toBe(true);
  }, 90_000);
});
