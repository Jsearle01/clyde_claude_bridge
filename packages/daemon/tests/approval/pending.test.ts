// T-P2-008: unit tests for PendingApprovalRegistry. Fake timers for the
// 5-minute timeout path; everything else exercises the resolve/cancel
// flows synchronously.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PendingApprovalRegistry, ApprovalRejectedError } from "../../src/approval/pending.js";
import type { ApprovalRequest } from "@claude-bridge/shared";

function makeRequest(delegation_id = "d_test_1", identifier = "ws-aaaaaa"): ApprovalRequest {
  return {
    kind: "approval_request",
    delegation_id,
    identifier,
    prompt: "do a thing",
    mode_requested: "agentic",
    timestamp: "2026-05-25T12:00:00.000Z",
  };
}

describe("PendingApprovalRegistry (T-P2-008)", () => {
  let registry: PendingApprovalRegistry;
  beforeEach(() => {
    registry = new PendingApprovalRegistry();
  });
  afterEach(() => {
    void registry.stop();
  });

  it("awaitApproval resolves to 'approve' when resolve(id, 'approve') is called", async () => {
    const req = makeRequest();
    const promise = registry.awaitApproval(req);
    registry.resolve(req.delegation_id, "approve");
    await expect(promise).resolves.toBe("approve");
  });

  it("awaitApproval resolves to 'deny' when resolve(id, 'deny') is called", async () => {
    const req = makeRequest();
    const promise = registry.awaitApproval(req);
    registry.resolve(req.delegation_id, "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("awaitApproval resolves to 'approve_session' when resolve(id, 'approve_session') is called", async () => {
    const req = makeRequest();
    const promise = registry.awaitApproval(req);
    registry.resolve(req.delegation_id, "approve_session");
    await expect(promise).resolves.toBe("approve_session");
  });

  it("awaitApproval rejects with 'timeout' after 5 minutes", async () => {
    vi.useFakeTimers();
    try {
      const req = makeRequest();
      const promise = registry.awaitApproval(req);
      vi.advanceTimersByTime(5 * 60 * 1000 + 100);
      await expect(promise).rejects.toBeInstanceOf(ApprovalRejectedError);
      await expect(promise).rejects.toMatchObject({ reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("awaitApproval rejects with 'shutdown' when stop() is called", async () => {
    const req = makeRequest();
    const promise = registry.awaitApproval(req);
    void registry.stop();
    await expect(promise).rejects.toMatchObject({ reason: "shutdown" });
  });

  it("cancel(id, 'extension_reconnected') rejects the pending promise", async () => {
    const req = makeRequest();
    const promise = registry.awaitApproval(req);
    registry.cancel(req.delegation_id, "extension_reconnected");
    await expect(promise).rejects.toMatchObject({
      reason: "extension_reconnected",
    });
  });

  it("cancelByWorkspace rejects all pending approvals for that workspace", async () => {
    const a = registry.awaitApproval(makeRequest("d1", "ws-A"));
    const b = registry.awaitApproval(makeRequest("d2", "ws-A"));
    const c = registry.awaitApproval(makeRequest("d3", "ws-B"));
    registry.cancelByWorkspace("ws-A", "extension_reconnected");
    await expect(a).rejects.toMatchObject({ reason: "extension_reconnected" });
    await expect(b).rejects.toMatchObject({ reason: "extension_reconnected" });
    // 'c' is still pending — resolve it so the test cleans up.
    registry.resolve("d3", "approve");
    await expect(c).resolves.toBe("approve");
  });

  it("resolve on unknown delegation_id is a silent no-op", () => {
    expect(() => registry.resolve("unknown", "approve")).not.toThrow();
  });

  it("size() reflects in-flight approvals", async () => {
    expect(registry.size()).toBe(0);
    const a = registry.awaitApproval(makeRequest("d1"));
    const b = registry.awaitApproval(makeRequest("d2"));
    expect(registry.size()).toBe(2);
    registry.resolve("d1", "approve");
    await a;
    expect(registry.size()).toBe(1);
    registry.resolve("d2", "deny");
    await b;
    expect(registry.size()).toBe(0);
  });

  it("awaitApproval after stop() rejects immediately with 'shutdown'", async () => {
    await registry.stop();
    await expect(registry.awaitApproval(makeRequest())).rejects.toMatchObject({
      reason: "shutdown",
    });
  });
});
