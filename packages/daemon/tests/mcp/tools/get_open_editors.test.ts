import { describe, it, expect } from "vitest";
import { makeGetOpenEditorsTool } from "../../../src/mcp/tools/get_open_editors.js";
import { ExtensionToolRouter } from "../../../src/mcp/tools/extension-router.js";
import { ToolHandlerError, type ToolContext } from "../../../src/mcp/dispatch.js";
import type { WorkspaceBinding } from "../../../src/mcp/auth.js";
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

function makeCtx(binding?: WorkspaceBinding): ToolContext {
  return {
    request_id: "req_goe0000",
    remote_addr: "tunnel",
    workspaceBinding: binding,
    auditLog: {} as AuditLog,
    logger: silentLogger,
    state: stubState,
    setAuditMetadata: () => undefined,
  };
}

// A router that always answers with an empty editor list — for tests that
// only care whether the call was ALLOWED past the binding gate.
function respondingRouter(): ExtensionToolRouter {
  const router = new ExtensionToolRouter((_, request) => {
    const req = request as { request_id: string };
    setImmediate(() => {
      router.resolveResponse({
        kind: "get_open_editors_response",
        request_id: req.request_id,
        editors: [],
      });
    });
    return Promise.resolve();
  });
  return router;
}

function singleWorkspaceRegistry() {
  return {
    list: () => [{ id: "only", abs_path: "/p", default_mode: "agentic" as const }],
    resolve: (id?: string) =>
      id === "only" || id === undefined
        ? { id: "only", abs_path: "/p", default_mode: "agentic" as const }
        : null,
    default: () => null,
  };
}

function twoWorkspaceRegistry() {
  return {
    list: () => [
      { id: "a", abs_path: "/a", default_mode: "agentic" as const },
      { id: "b", abs_path: "/b", default_mode: "agentic" as const },
    ],
    resolve: (id?: string) => {
      if (id === "a") return { id: "a", abs_path: "/a", default_mode: "agentic" as const };
      if (id === "b") return { id: "b", abs_path: "/b", default_mode: "agentic" as const };
      return null;
    },
    default: () => null,
  };
}

describe("get_open_editors tool (T-P2-009)", () => {
  it("happy path: single registered workspace, returns editor list from extension", async () => {
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as { kind: string; request_id: string };
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_open_editors_response",
          request_id: req.request_id,
          editors: [
            {
              uri: "file:///c:/projects/foo.ts",
              fs_path: "c:\\projects\\foo.ts",
              is_active: true,
              is_dirty: false,
            },
          ],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: router,
    });
    const out = await tool.handler({}, makeCtx());
    expect(out.editors).toHaveLength(1);
    expect(out.editors[0]?.uri).toBe("file:///c:/projects/foo.ts");
    expect(out.editors[0]?.is_active).toBe(true);
  });

  it("400 ambiguous_workspace when multiple registered and arg omitted", async () => {
    const router = new ExtensionToolRouter(() => Promise.resolve());
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(tool.handler({}, makeCtx())).rejects.toMatchObject({
      code: 400,
      reason: "ambiguous_workspace",
    });
  });

  it("404 workspace_not_found for an unknown explicit workspace", async () => {
    const router = new ExtensionToolRouter(() => Promise.resolve());
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(
      tool.handler({ workspace: "ghost" }, makeCtx()),
    ).rejects.toMatchObject({
      code: 404,
      reason: "workspace_not_found",
    });
  });

  it("503 extension_offline when the extension is unreachable", async () => {
    const router = new ExtensionToolRouter(() =>
      Promise.reject(new Error("no active connection")),
    );
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(tool.handler({}, makeCtx())).rejects.toMatchObject({
      code: 503,
      reason: "extension_offline",
    });
  });

  it("attaches workspace_id to audit metadata", async () => {
    let captured: { workspace_id?: string } | null = null;
    const ctx: ToolContext = {
      ...makeCtx(),
      setAuditMetadata: (m) => {
        captured = m;
      },
    };
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as { request_id: string };
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_open_editors_response",
          request_id: req.request_id,
          editors: [],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: router,
    });
    await tool.handler({}, ctx);
    expect(captured).not.toBeNull();
    if (captured === null) throw new Error("captured");
    expect(captured.workspace_id).toBe("only");
  });

  it("does NOT invoke the approval gate (call-stack bypass — C-13 grep #6)", async () => {
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as { request_id: string };
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_open_editors_response",
          request_id: req.request_id,
          editors: [],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: router,
    });
    // The tool factory takes only registry + extensionRouter. There is
    // no approvalGate dep slot to wire — the tool literally cannot
    // invoke the gate even if it wanted to.
    type Deps = Parameters<typeof makeGetOpenEditorsTool>[0];
    const depKeys: ReadonlyArray<keyof Deps> = ["registry", "extensionRouter"];
    expect(depKeys).not.toContain("approvalGate" as keyof Deps);
    await expect(tool.handler({}, makeCtx())).resolves.toMatchObject({
      editors: [],
    });
    // Sanity: also confirm the source doesn't import from the approval
    // module. The comment block in the source intentionally names the
    // gate to document the bypass; we check the import-statement
    // surface only (i.e., what is wired at runtime), not the prose.
    const src = await import("node:fs/promises").then((f) =>
      f.readFile(
        new URL(
          "../../../src/mcp/tools/get_open_editors.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // Strip block comments and line comments so the assertion only sees
    // executable source.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/from\s+["'][^"']*approval[^"']*["']/);
    expect(codeOnly).not.toMatch(/ApprovalGate|awaitApprovalForDelegation/);
  });
});

// Defensive: route through ToolHandlerError instance check for non-matchObject
// callers.
describe("get_open_editors tool error shapes", () => {
  it("ambiguous error is a ToolHandlerError instance", async () => {
    const router = new ExtensionToolRouter(() => Promise.resolve());
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(tool.handler({}, makeCtx())).rejects.toBeInstanceOf(
      ToolHandlerError,
    );
  });
});

// ---------------------------------------------------------------------------
// T-P3-004a — auth-layer binding enforcement (THE isolation proof)
// ---------------------------------------------------------------------------
describe("T-P3-004a — binding enforcement via the real tool path", () => {
  const boundA: WorkspaceBinding = { kind: "bound", workspace: "a" };

  it("AC-9: a token bound to A CAN act on A (explicit arg matches the binding)", async () => {
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    const out = await tool.handler({ workspace: "a" }, makeCtx(boundA));
    expect(out.editors).toEqual([]);
  });

  it("AC-9: a token bound to A acts on A even with the arg omitted (binding implies it; no ambiguity)", async () => {
    // twoWorkspaceRegistry would 400 ambiguous for an unconstrained caller;
    // a bound token resolves to its workspace instead.
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    const out = await tool.handler({}, makeCtx(boundA));
    expect(out.editors).toEqual([]);
  });

  it("AC-10 (the core proof): a token bound to A CANNOT act on B — rejected 403 before any extension call", async () => {
    // Router throws if reached — proves the rejection happens at the gate,
    // not downstream.
    const router = new ExtensionToolRouter(() => {
      throw new Error("router must not be reached on a binding violation");
    });
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(
      tool.handler({ workspace: "b" }, makeCtx(boundA)),
    ).rejects.toMatchObject({ code: 403, reason: "workspace_not_bound" });
  });

  it("AC-12: with two bindings, B's token cannot reach A and A's token cannot reach B", async () => {
    const boundB: WorkspaceBinding = { kind: "bound", workspace: "b" };
    const tool = makeGetOpenEditorsTool({
      registry: twoWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    // A⊥B
    await expect(
      tool.handler({ workspace: "b" }, makeCtx(boundA)),
    ).rejects.toMatchObject({ code: 403, reason: "workspace_not_bound" });
    // B⊥A
    await expect(
      tool.handler({ workspace: "a" }, makeCtx(boundB)),
    ).rejects.toMatchObject({ code: 403, reason: "workspace_not_bound" });
    // each on its own → allowed
    expect((await tool.handler({ workspace: "a" }, makeCtx(boundA))).editors).toEqual([]);
    expect((await tool.handler({ workspace: "b" }, makeCtx(boundB))).editors).toEqual([]);
  });

  it("a bound-to-null token (non-binding approve) acts on NOTHING", async () => {
    const router = new ExtensionToolRouter(() => {
      throw new Error("router must not be reached");
    });
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: router,
    });
    await expect(
      tool.handler({}, makeCtx({ kind: "bound", workspace: null })),
    ).rejects.toMatchObject({ code: 403, reason: "workspace_not_bound" });
  });

  it("the legacy unconstrained Bearer is unaffected (acts globally)", async () => {
    const tool = makeGetOpenEditorsTool({
      registry: singleWorkspaceRegistry(),
      extensionRouter: respondingRouter(),
    });
    const out = await tool.handler(
      {},
      makeCtx({ kind: "unconstrained" }),
    );
    expect(out.editors).toEqual([]);
  });
});
