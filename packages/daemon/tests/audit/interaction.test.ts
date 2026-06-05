// T-P3-007: interaction event log + recorder. Verifies events land in
// ~/.claude-bridge/interaction.jsonl (reusing AuditLog: own filename/prefix,
// not audit.jsonl), JSONL shape with stamped ts, and that the canUseTool
// emitter fires floor_denied + push_observed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeInteractionLog,
  InteractionRecorder,
  type InteractionEvent,
} from "../../src/audit/interaction.js";
import { makeCanUseTool } from "../../src/jobs/sdk-runner.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cb-interaction-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readEvents(): Promise<InteractionEvent[]> {
  const raw = await readFile(join(dir, "interaction.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as InteractionEvent);
}

describe("InteractionRecorder + makeInteractionLog (T-P3-007)", () => {
  it("writes events to interaction.jsonl (NOT audit.jsonl) as JSONL with stamped ts", async () => {
    const log = makeInteractionLog(dir, 30);
    const rec = new InteractionRecorder(log);
    rec.record({
      kind: "delegation_dispatched",
      job_id: "j1",
      workspace_id: "ws-a",
      prompt_hash: "sha256:abc",
      bound_workspace: "ws-a",
      granularity: "task",
    });
    rec.record({
      kind: "gate_decision",
      job_id: "j1",
      workspace_id: "ws-a",
      decision: "approve",
      granularity: "task",
    });
    await log.stop(); // flush

    const events = await readEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("delegation_dispatched");
    expect(events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // recorder-stamped ISO
    expect(events[1]?.kind).toBe("gate_decision");
  });

  it("records the prompt HASH, never the raw prompt (privacy)", async () => {
    const log = makeInteractionLog(dir, 30);
    new InteractionRecorder(log).record({
      kind: "delegation_dispatched",
      job_id: "j1",
      workspace_id: "ws-a",
      prompt_hash: "sha256:deadbeef",
      bound_workspace: null,
      granularity: "per_call",
    });
    await log.stop();
    const onDisk = await readFile(join(dir, "interaction.jsonl"), "utf8");
    expect(onDisk).toContain("sha256:deadbeef");
    expect(onDisk).toContain("prompt_hash");
    expect(onDisk).not.toContain("raw_prompt");
  });

  it("the file lives in the (006-protected) config dir at 0600 on Unix", async () => {
    const log = makeInteractionLog(dir, 30);
    new InteractionRecorder(log).record({
      kind: "push_observed",
      job_id: "j1",
      workspace_id: "ws-a",
      command_hash: "sha256:x",
    });
    await log.stop();
    if (process.platform !== "win32") {
      const s = await stat(join(dir, "interaction.jsonl"));
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it("terminal events carry the DelegationReport summary", async () => {
    const log = makeInteractionLog(dir, 30);
    new InteractionRecorder(log).record({
      kind: "delegation_completed",
      job_id: "j1",
      workspace_id: "ws-a",
      duration_ms: 1234,
      report_summary: {
        status: "complete",
        files_created: 2,
        files_modified: 1,
        files_deleted: 0,
        shell_commands: 3,
        turns: 5,
      },
    });
    await log.stop();
    const e = (await readEvents())[0];
    expect(e?.kind).toBe("delegation_completed");
    if (e?.kind === "delegation_completed") {
      expect(e.report_summary.files_created).toBe(2);
      expect(e.duration_ms).toBe(1234);
    }
  });
});

describe("makeCanUseTool emission (T-P3-007 floor_denied + push_observed)", () => {
  // A recording recorder stub (no file I/O).
  function recorder() {
    const events: InteractionEvent[] = [];
    const rec = {
      record: (body: Omit<InteractionEvent, "ts">) =>
        events.push({ ...body, ts: "2026-06-05T00:00:00Z" } as InteractionEvent),
      stop: () => Promise.resolve(),
    } as unknown as InteractionRecorder;
    return { rec, events };
  }
  const WS = join(tmpdir(), "ws");
  const CFG = join(tmpdir(), "cfg", ".claude-bridge");

  it("a floor-denied tool call emits floor_denied (with the reason)", async () => {
    const { rec, events } = recorder();
    const canUse = makeCanUseTool(WS, CFG, rec, "j1", "ws-a");
    const res = await canUse("Bash", { command: "git push --force origin main" }, {} as never);
    expect(res.behavior).toBe("deny");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("floor_denied");
    if (events[0]?.kind === "floor_denied") {
      expect(events[0].reason).toMatch(/force-push/);
      expect(events[0].job_id).toBe("j1");
    }
  });

  it("a (non-floored) git push emits push_observed and is ALLOWED", async () => {
    const { rec, events } = recorder();
    const canUse = makeCanUseTool(WS, CFG, rec, "j1", "ws-a");
    const res = await canUse("Bash", { command: "git push origin main" }, {} as never);
    expect(res.behavior).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("push_observed");
    if (events[0]?.kind === "push_observed") {
      expect(events[0].command_hash).toMatch(/^sha256:/); // hashed, not raw
    }
  });

  it("an ordinary allowed tool emits nothing", async () => {
    const { rec, events } = recorder();
    const canUse = makeCanUseTool(WS, CFG, rec, "j1", "ws-a");
    const res = await canUse("Bash", { command: "npm test" }, {} as never);
    expect(res.behavior).toBe("allow");
    expect(events).toHaveLength(0);
  });
});
