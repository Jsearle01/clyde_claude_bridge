import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExtensionToolRouter,
  resolveInspectionWorkspace,
} from "../../../src/mcp/tools/extension-router.js";
import { ToolHandlerError } from "../../../src/mcp/dispatch.js";

describe("ExtensionToolRouter (T-P2-009 / T-P2-010)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a request, awaits a matching response by request_id, resolves with payload", async () => {
    const sent: Array<{ identifier: string; request: unknown }> = [];
    const router = new ExtensionToolRouter((identifier, request) => {
      sent.push({ identifier, request });
      return Promise.resolve();
    });
    const promise = router.send("w1", "get_open_editors_response", (rid) => ({
      kind: "get_open_editors_request",
      request_id: rid,
    }));
    await Promise.resolve();
    expect(sent.length).toBe(1);
    const req = sent[0]?.request as { kind: string; request_id: string };
    expect(req.kind).toBe("get_open_editors_request");
    router.resolveResponse({
      kind: "get_open_editors_response",
      request_id: req.request_id,
      editors: [
        { uri: "u", fs_path: "/u", is_active: true, is_dirty: false },
      ],
    });
    const out = await promise;
    expect(out.editors).toHaveLength(1);
    expect(router.pendingSize()).toBe(0);
  });

  it("returns 503 extension_offline when sendToExtension throws", async () => {
    const router = new ExtensionToolRouter(() =>
      Promise.reject(new Error("no active connection for w1")),
    );
    await expect(
      router.send("w1", "get_open_editors_response", (rid) => ({
        kind: "get_open_editors_request",
        request_id: rid,
      })),
    ).rejects.toMatchObject({
      code: 503,
      reason: "extension_offline",
    });
    expect(router.pendingSize()).toBe(0);
  });

  it("returns 504 extension_timeout when no response arrives in time", async () => {
    const router = new ExtensionToolRouter(
      () => Promise.resolve(),
      100,
    );
    const p = router.send("w1", "get_diagnostics_response", (rid) => ({
      kind: "get_diagnostics_request",
      request_id: rid,
      severities: ["error"],
    }));
    // attach catch synchronously to avoid unhandled rejection during the
    // timer advance
    const settled = p.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(150);
    const err = (await settled) as ToolHandlerError;
    expect(err).toBeInstanceOf(ToolHandlerError);
    expect(err.code).toBe(504);
    expect(err.reason).toBe("extension_timeout");
    expect(router.pendingSize()).toBe(0);
  });

  it("returns 502 extension_error when extension responds with extension_tool_error", async () => {
    let captured: { request_id: string } | null = null;
    const router = new ExtensionToolRouter((_, request) => {
      captured = request;
      return Promise.resolve();
    });
    const p = router.send("w1", "get_open_editors_response", (rid) => ({
      kind: "get_open_editors_request",
      request_id: rid,
    }));
    await Promise.resolve();
    expect(captured).not.toBeNull();
    if (captured === null) throw new Error("captured");
    router.resolveError(captured.request_id, "vscode threw");
    await expect(p).rejects.toMatchObject({
      code: 502,
      reason: "extension_error",
    });
    expect(router.pendingSize()).toBe(0);
  });

  it("drops late responses for already-timed-out requests without throwing", async () => {
    let captured: { request_id: string } | null = null;
    const router = new ExtensionToolRouter((_, request) => {
      captured = request;
      return Promise.resolve();
    }, 100);
    const p = router.send("w1", "get_open_editors_response", (rid) => ({
      kind: "get_open_editors_request",
      request_id: rid,
    }));
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(150);
    await settled;
    // Late response arrives — should be a silent no-op.
    if (captured === null) throw new Error("captured");
    const rid = captured.request_id;
    expect(() => {
      router.resolveResponse({
        kind: "get_open_editors_response",
        request_id: rid,
        editors: [],
      });
    }).not.toThrow();
  });

  it("cancelAll rejects every in-flight call with 503", async () => {
    const router = new ExtensionToolRouter(() => Promise.resolve());
    const p1 = router.send("w1", "get_open_editors_response", (rid) => ({
      kind: "get_open_editors_request",
      request_id: rid,
    }));
    const p2 = router.send("w1", "get_diagnostics_response", (rid) => ({
      kind: "get_diagnostics_request",
      request_id: rid,
      severities: ["error"],
    }));
    await Promise.resolve();
    expect(router.pendingSize()).toBe(2);
    router.cancelAll("extension disconnected");
    await expect(p1).rejects.toMatchObject({ code: 503 });
    await expect(p2).rejects.toMatchObject({ code: 503 });
    expect(router.pendingSize()).toBe(0);
  });

  it("stop() cancels in-flight and refuses new sends", async () => {
    const router = new ExtensionToolRouter(() => Promise.resolve());
    const p = router.send("w1", "get_open_editors_response", (rid) => ({
      kind: "get_open_editors_request",
      request_id: rid,
    }));
    await Promise.resolve();
    router.stop();
    await expect(p).rejects.toMatchObject({ code: 503 });
    await expect(
      router.send("w1", "get_open_editors_response", (rid) => ({
        kind: "get_open_editors_request",
        request_id: rid,
      })),
    ).rejects.toMatchObject({ code: 503 });
  });
});

describe("resolveInspectionWorkspace (T-P2-009 / T-P2-010)", () => {
  it("returns the resolved id when caller supplies a valid workspace arg", () => {
    const reg = {
      list: () => [{ id: "w1" }, { id: "w2" }],
      resolve: (id?: string) => (id === "w1" ? { id: "w1" } : null),
    };
    expect(resolveInspectionWorkspace(reg, "w1")).toBe("w1");
  });

  it("returns 404 workspace_not_found when caller supplies an unknown identifier", () => {
    const reg = {
      list: () => [{ id: "w1" }],
      resolve: () => null,
    };
    expect(() => resolveInspectionWorkspace(reg, "ghost")).toThrowError(
      ToolHandlerError,
    );
    try {
      resolveInspectionWorkspace(reg, "ghost");
    } catch (e) {
      const err = e as ToolHandlerError;
      expect(err.code).toBe(404);
      expect(err.reason).toBe("workspace_not_found");
    }
  });

  it("auto-picks the single registered workspace when omitted", () => {
    const reg = {
      list: () => [{ id: "only" }],
      resolve: () => ({ id: "only" }),
    };
    expect(resolveInspectionWorkspace(reg, undefined)).toBe("only");
  });

  it("returns 400 ambiguous_workspace when multiple are registered and arg is omitted", () => {
    const reg = {
      list: () => [{ id: "a" }, { id: "b" }],
      resolve: () => null,
    };
    try {
      resolveInspectionWorkspace(reg, undefined);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolHandlerError;
      expect(err.code).toBe(400);
      expect(err.reason).toBe("ambiguous_workspace");
    }
  });

  it("returns 503 no_workspace_registered when nothing is registered", () => {
    const reg = {
      list: () => [],
      resolve: () => null,
    };
    try {
      resolveInspectionWorkspace(reg, undefined);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ToolHandlerError;
      expect(err.code).toBe(503);
      expect(err.reason).toBe("no_workspace_registered");
    }
  });
});
