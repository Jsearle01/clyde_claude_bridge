import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import type { WorkspaceRegistry } from "../../../src/workspace/registry.js";
import type { Workspace } from "@claude-bridge/shared";
import { JobQueue } from "../../../src/jobs/queue.js";
import { StubJobRunner } from "../../../src/jobs/runner.js";
import { AuditLog } from "../../../src/audit/log.js";
import type {
  InteractionEvent,
  InteractionRecorder,
} from "../../../src/audit/interaction.js";
import type { Logger } from "../../../src/log/logger.js";
import type { DaemonState } from "../../../src/state.js";
import type { ApprovalGate } from "../../../src/approval/gate.js";
import {
  PendingApprovalRegistry,
  ApprovalRejectedError,
} from "../../../src/approval/pending.js";

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

// T-P2-007: small in-memory WorkspaceRegistry test helper. Replaces
// P1's `StubWorkspaceRegistry` (removed from production). Identical
// resolve/list/default contract; no file I/O.
function makeTestRegistry(workspaces: Workspace[]): WorkspaceRegistry {
  return {
    resolve: (id?: string) =>
      id === undefined
        ? null
        : (workspaces.find((w) => w.id === id) ?? null),
    list: () => workspaces.slice(),
    default: () => null,
  };
}

// T-P2-008: stub approval gate. Defaults to "auto" so existing tests
// pass through without prompting; tests that need other modes override
// via overrides param.
function makeStubGate(mode: "auto" | "per_call" | "session_bypass" = "auto"): ApprovalGate {
  const pending = new PendingApprovalRegistry();
  const sessionBypassed = new Set<string>();
  let currentMode = mode;
  return {
    getModeForWorkspace: () => currentMode,
    // T-P2-008.7: bypass keyed by (sessionId + workspace). Stub mirrors
    // the production composite-key shape.
    isSessionBypassed: (sid, id) => sessionBypassed.has(`${sid ?? ""} ${id}`),
    markSessionBypassed: (sid, id) => sessionBypassed.add(`${sid ?? ""} ${id}`),
    clearSessionBypass: (sid, id) => sessionBypassed.delete(`${sid ?? ""} ${id}`),
    requestApproval: (req) => {
      // Default behavior: pending forever until test calls resolve via
      // returned helper. Tests that don't override should use "auto" mode
      // so this path doesn't fire.
      return pending.awaitApproval(req);
    },
    setModeForWorkspace: (_id, m) => {
      currentMode = m;
      return Promise.resolve();
    },
    resolveApproval: (id, dec) => pending.resolve(id, dec),
    cancelByWorkspace: (id, reason) => pending.cancelByWorkspace(id, reason),
    pendingSize: () => pending.size(),
    stop: () => pending.stop(),
  };
}

function makeDeps(opts: { workspaceConfigured?: boolean; mode?: "auto" | "per_call" | "session_bypass"; gate?: ApprovalGate } = {}) {
  const workspaces: Workspace[] =
    opts.workspaceConfigured !== false
      ? [
          {
            id: "local#default",
            abs_path: workspaceDir,
            default_mode: "agentic",
          },
        ]
      : [];
  return {
    registry: makeTestRegistry(workspaces),
    queue: new JobQueue(),
    runner: new StubJobRunner(new JobQueue()), // runner's queue independent for tickle no-op
    approvalGate: opts.gate ?? makeStubGate(opts.mode),
  };
}

const baseInput: DelegateInput = {
  prompt: "do the thing",
  workspace: "local#default",
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

  it("503 no_workspace_registered when registry empty (T-P2-007)", async () => {
    const deps = makeDeps({ workspaceConfigured: false });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      name: "ToolHandlerError",
      code: 503,
      reason: "no_workspace_registered",
    });
  });

  it("503 no_workspace_registered when explicit workspace doesn't match (T-P2-007)", async () => {
    const deps = makeDeps();
    const tool = makeDelegateTool(deps);
    await expect(
      tool.handler({ ...baseInput, workspace: "other#ws" }, makeCtx(auditLog)),
    ).rejects.toMatchObject({
      name: "ToolHandlerError",
      code: 503,
      reason: "no_workspace_registered",
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
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "", workspace: "local#default" },
        makeCtx(auditLog),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("schema rejects missing workspace field (T-P2-007: workspace is required)", async () => {
    const deps = makeDeps();
    const reg = new ToolRegistry();
    reg.register(makeDelegateTool(deps));
    await expect(
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "hi" },
        makeCtx(auditLog),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("schema rejects max_turns out of [1, 200] at registry boundary", async () => {
    const deps = makeDeps();
    const reg = new ToolRegistry();
    reg.register(makeDelegateTool(deps));
    await expect(
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "hi", workspace: "local#default", max_turns: 0 },
        makeCtx(auditLog),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      reg.invoke(
        "delegate_to_claude_code",
        { prompt: "hi", workspace: "local#default", max_turns: 201 },
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

describe("delegate_to_claude_code — approval gate (T-P2-008)", () => {
  it("auto mode skips the gate; delegation enqueues directly", async () => {
    const gate = makeStubGate("auto");
    const requestSpy = vi.fn(gate.requestApproval);
    const wrapped: ApprovalGate = { ...gate, requestApproval: requestSpy };
    const deps = makeDeps({ gate: wrapped });
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(baseInput, makeCtx(auditLog));
    expect(out.status).toBe("queued");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("per_call mode invokes the gate; approve flows through to enqueue", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: vi.fn(() => Promise.resolve("approve")),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(baseInput, makeCtx(auditLog));
    expect(out.status).toBe("queued");
    expect(gate.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("T-P3-005: a per-operation granularity=auto on the delegate call skips the gate even when the workspace mode is per_call", async () => {
    const gate = makeStubGate("per_call"); // workspace default would prompt…
    const requestSpy = vi.fn(gate.requestApproval);
    const wrapped: ApprovalGate = { ...gate, requestApproval: requestSpy };
    const deps = makeDeps({ gate: wrapped });
    const tool = makeDelegateTool(deps);
    // …but the operation specifies auto → no prompt (operation wins).
    const out = await tool.handler(
      { ...baseInput, granularity: "auto" },
      makeCtx(auditLog),
    );
    expect(out.status).toBe("queued");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("T-P3-005: granularity=per_call on the call prompts even when the workspace mode is auto", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("auto"), // workspace default would skip…
      requestApproval: vi.fn(() => Promise.resolve("approve")),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(
      { ...baseInput, granularity: "per_call" },
      makeCtx(auditLog),
    );
    expect(out.status).toBe("queued");
    expect(gate.requestApproval).toHaveBeenCalledTimes(1); // operation forced a prompt
  });

  it("session_bypass when cached short-circuits the gate", async () => {
    const gate = makeStubGate("session_bypass");
    // makeCtx leaves mcp_session_id undefined → handler passes undefined as
    // the session id; mark the bypass with the same (undefined) session.
    gate.markSessionBypassed(undefined, "local#default");
    const requestSpy = vi.fn(gate.requestApproval);
    const wrapped: ApprovalGate = { ...gate, requestApproval: requestSpy };
    const deps = makeDeps({ gate: wrapped });
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(baseInput, makeCtx(auditLog));
    expect(out.status).toBe("queued");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("denial → ToolHandlerError 403 delegation_denied", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: () => Promise.resolve("deny"),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      name: "ToolHandlerError",
      code: 403,
      reason: "delegation_denied",
    });
  });

  it("timeout → ToolHandlerError 408 approval_timeout", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: () => Promise.reject(new ApprovalRejectedError("timeout")),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      code: 408,
      reason: "approval_timeout",
    });
  });

  it("extension_reconnected → 408 approval_extension_reconnected", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: () =>
        Promise.reject(new ApprovalRejectedError("extension_reconnected")),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      code: 408,
      reason: "approval_extension_reconnected",
    });
  });

  it("shutdown → 503 daemon_shutting_down", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: () => Promise.reject(new ApprovalRejectedError("shutdown")),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    await expect(tool.handler(baseInput, makeCtx(auditLog))).rejects.toMatchObject({
      code: 503,
      reason: "daemon_shutting_down",
    });
  });

  it("approve_session sets session-bypassed mark for subsequent calls", async () => {
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: () => Promise.resolve("approve_session"),
    };
    const deps = makeDeps({ gate });
    const tool = makeDelegateTool(deps);
    await tool.handler(baseInput, makeCtx(auditLog));
    // Handler passes ctx.mcp_session_id (undefined in makeCtx) to the gate.
    expect(gate.isSessionBypassed(undefined, "local#default")).toBe(true);
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

describe("delegate_to_claude_code — interaction log (T-P3-007)", () => {
  function recordingRecorder(): {
    rec: InteractionRecorder;
    events: InteractionEvent[];
  } {
    const events: InteractionEvent[] = [];
    const rec = {
      record: (b: Omit<InteractionEvent, "ts">) =>
        events.push({ ...b, ts: "t" } as InteractionEvent),
      stop: () => Promise.resolve(),
    } as unknown as InteractionRecorder;
    return { rec, events };
  }

  it("emits gate_decision + delegation_dispatched on approve; prompt is HASHED not raw", async () => {
    const { rec, events } = recordingRecorder();
    const deps = { ...makeDeps({ mode: "auto" }), interactionRecorder: rec };
    const tool = makeDelegateTool(deps);
    const out = await tool.handler(baseInput, makeCtx(auditLog));
    expect(out.status).toBe("queued");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("gate_decision");
    expect(kinds).toContain("delegation_dispatched");
    const dispatched = events.find((e) => e.kind === "delegation_dispatched");
    if (dispatched?.kind === "delegation_dispatched") {
      expect(dispatched.prompt_hash).toMatch(/^sha256:/);
      expect(dispatched.job_id.length).toBeGreaterThan(0);
    }
    // The raw prompt text must NOT appear anywhere in the events.
    expect(JSON.stringify(events)).not.toContain("do the thing");
  });

  it("a denied delegation emits gate_decision with job_id null and NO dispatched", async () => {
    const { rec, events } = recordingRecorder();
    const gate: ApprovalGate = {
      ...makeStubGate("per_call"),
      requestApproval: vi.fn(() => Promise.resolve("deny")),
    };
    const deps = { ...makeDeps({ gate }), interactionRecorder: rec };
    const tool = makeDelegateTool(deps);
    await expect(
      tool.handler(baseInput, makeCtx(auditLog)),
    ).rejects.toMatchObject({ code: 403 });
    const gd = events.find((e) => e.kind === "gate_decision");
    expect(gd?.kind).toBe("gate_decision");
    if (gd?.kind === "gate_decision") {
      expect(gd.job_id).toBeNull();
      expect(gd.decision).toBe("deny");
    }
    expect(
      events.find((e) => e.kind === "delegation_dispatched"),
    ).toBeUndefined();
  });
});
