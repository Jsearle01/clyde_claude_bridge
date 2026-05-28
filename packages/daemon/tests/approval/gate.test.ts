// T-P2-008: unit tests for ApprovalGateImpl. Uses a real WorkspacesStore
// backed by a temp file (matching store.test.ts patterns) and a stub
// sendToExtension that records calls.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspacesStore } from "../../src/workspace/store.js";
import {
  ApprovalGateImpl,
  awaitApprovalForDelegation,
  truncateForApproval,
  generateDelegationId,
} from "../../src/approval/gate.js";
import { PendingApprovalRegistry } from "../../src/approval/pending.js";
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

describe("ApprovalGateImpl (T-P2-008)", () => {
  let tempDir: string;
  let storePath: string;
  let store: WorkspacesStore;
  let pending: PendingApprovalRegistry;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cb-gate-"));
    storePath = join(tempDir, "workspaces.json");
    store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/some/path",
      identifier: "ws-aaaaaa",
      name: "WS",
    });
    pending = new PendingApprovalRegistry();
  });

  afterEach(async () => {
    await pending.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("getModeForWorkspace returns 'per_call' by default when entry has no mode", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    expect(gate.getModeForWorkspace("ws-aaaaaa")).toBe("per_call");
  });

  it("getModeForWorkspace returns 'per_call' for an unknown identifier (defensive default)", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    expect(gate.getModeForWorkspace("does-not-exist")).toBe("per_call");
  });

  it("setModeForWorkspace persists the mode; getModeForWorkspace reflects it", async () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    await gate.setModeForWorkspace("ws-aaaaaa", "auto");
    expect(gate.getModeForWorkspace("ws-aaaaaa")).toBe("auto");
  });

  it("isSessionBypassed returns false by default; true after markSessionBypassed", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    expect(gate.isSessionBypassed("sess-1", "ws-aaaaaa")).toBe(false);
    gate.markSessionBypassed("sess-1", "ws-aaaaaa");
    expect(gate.isSessionBypassed("sess-1", "ws-aaaaaa")).toBe(true);
  });

  it("clearSessionBypass removes the session-bypassed mark", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    gate.markSessionBypassed("sess-1", "ws-aaaaaa");
    gate.clearSessionBypass("sess-1", "ws-aaaaaa");
    expect(gate.isSessionBypassed("sess-1", "ws-aaaaaa")).toBe(false);
  });

  it("session-bypass is per-workspace (T-P2-008.7: keyed by session+workspace)", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    gate.markSessionBypassed("sess-1", "ws-A");
    expect(gate.isSessionBypassed("sess-1", "ws-A")).toBe(true);
    expect(gate.isSessionBypassed("sess-1", "ws-B")).toBe(false);
  });

  it("session-bypass does NOT leak across MCP sessions (T-P2-008.7 / C-30)", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    gate.markSessionBypassed("sess-1", "ws-A");
    expect(gate.isSessionBypassed("sess-1", "ws-A")).toBe(true);
    // A different MCP session must NOT inherit the bypass.
    expect(gate.isSessionBypassed("sess-2", "ws-A")).toBe(false);
  });

  it("requestApproval calls sendToExtension with the request payload", async () => {
    const sender = vi.fn(() => Promise.resolve());
    const gate = new ApprovalGateImpl(store, pending, sender);
    const req = makeRequest();
    const promise = gate.requestApproval(req);
    gate.resolveApproval(req.delegation_id, "approve");
    await promise;
    expect(sender).toHaveBeenCalledWith("ws-aaaaaa", req);
  });

  it("requestApproval propagates sender failures as ApprovalRejectedError", async () => {
    const sender = vi.fn(() => Promise.reject(new Error("no connection")));
    const gate = new ApprovalGateImpl(store, pending, sender);
    await expect(gate.requestApproval(makeRequest())).rejects.toMatchObject({
      reason: "extension_reconnected",
    });
  });

  it("cancelByWorkspace cancels pending approvals + clears session bypass (all sessions)", async () => {
    const sender = vi.fn(() => Promise.resolve());
    const gate = new ApprovalGateImpl(store, pending, sender);
    // Bypass set in two distinct sessions for the same workspace.
    gate.markSessionBypassed("sess-1", "ws-aaaaaa");
    gate.markSessionBypassed("sess-2", "ws-aaaaaa");
    const promise = gate.requestApproval(makeRequest());
    gate.cancelByWorkspace("ws-aaaaaa", "extension_reconnected");
    await expect(promise).rejects.toMatchObject({
      reason: "extension_reconnected",
    });
    // Disconnect drops runtime trust for that workspace across all sessions.
    expect(gate.isSessionBypassed("sess-1", "ws-aaaaaa")).toBe(false);
    expect(gate.isSessionBypassed("sess-2", "ws-aaaaaa")).toBe(false);
  });
});

describe("awaitApprovalForDelegation (T-P2-008)", () => {
  let tempDir: string;
  let storePath: string;
  let store: WorkspacesStore;
  let pending: PendingApprovalRegistry;
  let gate: ApprovalGateImpl;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cb-gate-helper-"));
    storePath = join(tempDir, "workspaces.json");
    store = new WorkspacesStore(storePath);
    await store.load();
    await store.addTrustedEntry({
      abs_path: "/some/path",
      identifier: "ws-aaaaaa",
      name: "WS",
    });
    pending = new PendingApprovalRegistry();
    gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
  });

  afterEach(async () => {
    await pending.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("auto mode skips approval (resolves to 'approve' without prompting)", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "auto");
    const decision = await awaitApprovalForDelegation(gate, "sess-1", "ws-aaaaaa", makeRequest());
    expect(decision).toBe("approve");
  });

  it("per_call mode invokes the gate (awaits resolve)", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "per_call");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "sess-1", "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve");
    await expect(promise).resolves.toBe("approve");
  });

  it("session_bypass when uncached invokes the gate", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "session_bypass");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "sess-1", "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve");
    await expect(promise).resolves.toBe("approve");
  });

  it("session_bypass when cached short-circuits to 'approve'", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "session_bypass");
    gate.markSessionBypassed("sess-1", "ws-aaaaaa");
    const decision = await awaitApprovalForDelegation(gate, "sess-1", "ws-aaaaaa", makeRequest());
    expect(decision).toBe("approve");
  });

  it("approve_session marks the workspace as session-bypassed", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "per_call");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "sess-1", "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve_session");
    await promise;
    expect(gate.isSessionBypassed("sess-1", "ws-aaaaaa")).toBe(true);
  });

  // C-30 regression: the three-tuple scenarios from the dispatch fix spec.
  // approve_session in per_call mode must suppress the modal on the NEXT
  // call for the SAME (session, workspace) — previously the modal re-fired
  // because the bypass check was gated on `mode === "session_bypass"`.
  describe("C-30 regression — approve_session in per_call mode (T-P2-008.7)", () => {
    beforeEach(async () => {
      // Default per_call mode (the case that exposed C-30).
      await gate.setModeForWorkspace("ws-aaaaaa", "per_call");
      await store.addTrustedEntry({
        abs_path: "/other/path",
        identifier: "ws-other",
        name: "Other",
      });
      await gate.setModeForWorkspace("ws-other", "per_call");
    });

    it("R3a approve_session then R3b same (session, workspace) → NO second modal", async () => {
      // R3a: user picks "Approve for this session".
      const r3a = makeRequest("d_r3a", "ws-aaaaaa");
      const p3a = awaitApprovalForDelegation(gate, "sess-A", "ws-aaaaaa", r3a);
      gate.resolveApproval("d_r3a", "approve_session");
      await expect(p3a).resolves.toBe("approve_session");

      // R3b: same MCP session + same workspace. Must auto-approve WITHOUT
      // creating a new pending approval (no modal fires). pendingSize===0
      // proves requestApproval was never entered.
      const r3b = makeRequest("d_r3b", "ws-aaaaaa");
      const decision = await awaitApprovalForDelegation(gate, "sess-A", "ws-aaaaaa", r3b);
      expect(decision).toBe("approve");
      expect(gate.pendingSize()).toBe(0);
    });

    it("different workspace, same session → modal DOES fire", async () => {
      // Bypass set for (sess-A, ws-aaaaaa).
      gate.markSessionBypassed("sess-A", "ws-aaaaaa");
      // A call for (sess-A, ws-other) must NOT inherit the bypass.
      const req = makeRequest("d_other", "ws-other");
      const promise = awaitApprovalForDelegation(gate, "sess-A", "ws-other", req);
      // It went to the gate (pending created) — resolve so the test cleans up.
      expect(gate.pendingSize()).toBe(1);
      gate.resolveApproval("d_other", "deny");
      await expect(promise).resolves.toBe("deny");
    });

    it("different session, same workspace → modal DOES fire", async () => {
      // Bypass set for (sess-A, ws-aaaaaa).
      gate.markSessionBypassed("sess-A", "ws-aaaaaa");
      // A call for (sess-B, ws-aaaaaa) must NOT inherit the bypass.
      const req = makeRequest("d_sessB", "ws-aaaaaa");
      const promise = awaitApprovalForDelegation(gate, "sess-B", "ws-aaaaaa", req);
      expect(gate.pendingSize()).toBe(1);
      gate.resolveApproval("d_sessB", "deny");
      await expect(promise).resolves.toBe("deny");
    });
  });
});

describe("helpers (T-P2-008)", () => {
  it("truncateForApproval returns the input unchanged when within limit", () => {
    expect(truncateForApproval("hi", 100)).toBe("hi");
  });
  it("truncateForApproval truncates and appends ellipsis when over limit", () => {
    const long = "x".repeat(600);
    const out = truncateForApproval(long, 500);
    expect(out.length).toBe(501); // 500 + "…"
    expect(out.endsWith("…")).toBe(true);
  });
  it("generateDelegationId returns unique strings on repeated calls", () => {
    const a = generateDelegationId();
    const b = generateDelegationId();
    expect(a).not.toBe(b);
    expect(a.startsWith("d_")).toBe(true);
  });
});
