import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DelegateInput } from "@claude-bridge/shared";
import {
  ToolRegistry,
  ToolHandlerError,
  type ToolContext,
} from "../../../src/mcp/dispatch.js";
import {
  makeDelegateTool,
  resolveCwd,
} from "../../../src/mcp/tools/delegate.js";
import { StubWorkspaceRegistry } from "../../../src/workspace/registry.js";
import { JobQueue } from "../../../src/jobs/queue.js";
import { StubJobRunner } from "../../../src/jobs/runner.js";
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
  startedAt: Date.now(),
  tunnelStatus: "up",
  tunnelUrl: "https://stub.trycloudflare.com",
  config: {} as never,
};

function makeCtx(auditLog: AuditLog): ToolContext {
  return {
    request_id: "req_delg0000",
    remote_addr: "tunnel",
    auditLog,
    logger: silentLogger,
    state: stubState,
  };
}

let workspaceDir: string;
let auditDir: string;
let auditLog: AuditLog;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "cb-deleg-ws-"));
  auditDir = mkdtempSync(join(tmpdir(), "cb-deleg-audit-"));
  auditLog = new AuditLog(join(auditDir, "audit.jsonl"), 30);
});

afterEach(async () => {
  await auditLog.stop();
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

function makeDeps(opts: { workspaceConfigured?: boolean } = {}) {
  const cfg = opts.workspaceConfigured !== false
    ? {
        id: "local#default",
        abs_path: workspaceDir,
        default_mode: "agentic" as const,
      }
    : undefined;
  return {
    registry: new StubWorkspaceRegistry(cfg),
    queue: new JobQueue(),
    runner: new StubJobRunner(new JobQueue()), // runner's queue independent for tickle no-op
  };
}

const baseInput: DelegateInput = {
  prompt: "do the thing",
};

describe("delegate_to_claude_code — happy path + workspace resolution", () => {
  it("returns job_id + status + queued_position for a valid request", async () => {
    const deps = makeDeps();
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(baseInput, makeCtx(auditLog));
    expect(out.job_id).toMatch(/^j_[A-Z2-7]{12}$/);
    expect(out.status).toBe("queued");
    expect(out.workspace_id).toBe("local#default");
    expect(out.queued_position).toBe(0);
  });

  it("503 no_workspace_configured when registry empty", async () => {
    const deps = makeDeps({ workspaceConfigured: false });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      name: "ToolHandlerError",
      code: 503,
      reason: "no_workspace_configured",
    });
  });

  it("404 workspace_not_found when explicit workspace doesn't match", async () => {
    const deps = makeDeps();
    const tool = makeDelegateTool(deps);
    await expect(
      tool.handler({ ...baseInput, workspace: "other#ws" }, makeCtx(auditLog)),
    ).rejects.toMatchObject({
      name: "ToolHandlerError",
      code: 404,
      reason: "workspace_not_found",
    });
  });
});

describe("delegate_to_claude_code — input validation (handler-level caps)", () => {
  it("rejects exhibits count > 100", async () => {
    const deps = makeDeps();
    const tool = makeDelegateTool(deps);
    const exhibits = Array.from({ length: 101 }, (_, i) => ({ path: `f${i}` }));
    await expect(
      tool.handler({ ...baseInput, exhibits }, makeCtx(auditLog)),
    ).rejects.toMatchObject({
      code: 400,
      reason: "exhibits_count_exceeded",
    });
  });

  it("rejects exhibits total inline > 256KB", async () => {
    const deps = makeDeps();
    const tool = makeDelegateTool(deps);
    const big = "x".repeat(130 * 1024);
    const exhibits = [
      { path: "a", content: big },
      { path: "b", content: big },
    ];
    await expect(
      tool.handler({ ...baseInput, exhibits }, makeCtx(auditLog)),
    ).rejects.toMatchObject({
      code: 400,
      reason: "exhibits_inline_bytes_exceeded",
    });
  });
});

describe("delegate_to_claude_code — input validation (schema)", () => {
  it("schema rejects empty prompt at registry boundary", async () => {
    const deps = makeDeps();
    const reg = new ToolRegistry();
    reg.register(makeDelegateTool(deps));
    await expect(
      reg.invoke("delegate_to_claude_code", { prompt: "" }, makeCtx(auditLog)),
    ).rejects.toBeInstanceOf(Error);
  });

  it("schema rejects max_turns out of [1, 200] at registry boundary", async () => {
    const deps = makeDeps();
    const reg = new ToolRegistry();
    reg.register(makeDelegateTool(deps));
    await expect(
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "hi", max_turns: 0 },
        makeCtx(auditLog),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "hi", max_turns: 201 },
        makeCtx(auditLog),
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});

describe("resolveCwd", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cb-cwd-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns workspaceRoot when working_directory is null/undefined/empty", () => {
    expect(resolveCwd(root, null)).toBe(root);
    expect(resolveCwd(root, undefined)).toBe(root);
    expect(resolveCwd(root, "")).toBe(root);
  });

  it("resolves a subdirectory inside the workspace", () => {
    const sub = join(root, "src");
    mkdirSync(sub);
    expect(resolveCwd(root, "src")).toBe(sub);
  });

  it("throws working_directory_absolute on absolute path", () => {
    expect(() => resolveCwd(root, "/etc")).toThrow(ToolHandlerError);
    try {
      resolveCwd(root, "/etc");
    } catch (err) {
      expect((err as ToolHandlerError).reason).toBe("working_directory_absolute");
    }
  });

  it("throws working_directory_escapes_workspace on ../ escape", () => {
    expect(() => resolveCwd(root, "../escape")).toThrow(ToolHandlerError);
    try {
      resolveCwd(root, "../escape");
    } catch (err) {
      expect((err as ToolHandlerError).reason).toBe(
        "working_directory_escapes_workspace",
      );
    }
  });

  it("accepts a subdirectory that does not yet exist (realpath gracefully skipped)", () => {
    // Workspace exists; subdir does not. Realpath would ENOENT; allowed
    // since textual check passes — the SDK can choose to create it.
    expect(() => resolveCwd(root, "will-be-created")).not.toThrow();
  });
});

describe("delegate_to_claude_code — runner tickle + audit metadata", () => {
  it("calls runner.tickle() after enqueue", async () => {
    let tickled = false;
    const deps = makeDeps();
    deps.runner = {
      tickle: () => {
        tickled = true;
      },
      cancel: () => Promise.resolve(),
    };
    const tool = makeDelegateTool(deps);
    await tool.handler(baseInput, makeCtx(auditLog));
    expect(tickled).toBe(true);
  });

  it("populates audit metadata (job_id + workspace_id) via setAuditMetadata", async () => {
    const deps = makeDeps();
    const reg = new ToolRegistry();
    reg.register(makeDelegateTool(deps));
    const out = (await reg.invoke(
      "delegate_to_claude_code",
      baseInput,
      makeCtx(auditLog),
    )) as { job_id: string; workspace_id: string };
    // After auditLog flushes, the entry should contain both fields.
    await auditLog.stop(); // flush queue
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(join(auditDir, "audit.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1] ?? "{}") as {
      job_id?: string;
      workspace_id?: string;
    };
    expect(entry.job_id).toBe(out.job_id);
    expect(entry.workspace_id).toBe(out.workspace_id);
    // Re-open auditLog so afterEach's stop() doesn't double-close.
    auditLog = new AuditLog(join(auditDir, "audit.jsonl"), 30);
  });
});
