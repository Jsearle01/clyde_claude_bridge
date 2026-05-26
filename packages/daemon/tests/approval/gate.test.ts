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
    expect(gate.isSessionBypassed("ws-aaaaaa")).toBe(false);
    gate.markSessionBypassed("ws-aaaaaa");
    expect(gate.isSessionBypassed("ws-aaaaaa")).toBe(true);
  });

  it("clearSessionBypass removes the session-bypassed mark", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    gate.markSessionBypassed("ws-aaaaaa");
    gate.clearSessionBypass("ws-aaaaaa");
    expect(gate.isSessionBypassed("ws-aaaaaa")).toBe(false);
  });

  it("session-bypass is per-workspace", () => {
    const gate = new ApprovalGateImpl(store, pending, () => Promise.resolve());
    gate.markSessionBypassed("ws-A");
    expect(gate.isSessionBypassed("ws-A")).toBe(true);
    expect(gate.isSessionBypassed("ws-B")).toBe(false);
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

  it("cancelByWorkspace cancels pending approvals + clears session bypass", async () => {
    const sender = vi.fn(() => Promise.resolve());
    const gate = new ApprovalGateImpl(store, pending, sender);
    gate.markSessionBypassed("ws-aaaaaa");
    const promise = gate.requestApproval(makeRequest());
    gate.cancelByWorkspace("ws-aaaaaa", "extension_reconnected");
    await expect(promise).rejects.toMatchObject({
      reason: "extension_reconnected",
    });
    expect(gate.isSessionBypassed("ws-aaaaaa")).toBe(false);
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
    const decision = await awaitApprovalForDelegation(gate, "ws-aaaaaa", makeRequest());
    expect(decision).toBe("approve");
  });

  it("per_call mode invokes the gate (awaits resolve)", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "per_call");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve");
    await expect(promise).resolves.toBe("approve");
  });

  it("session_bypass when uncached invokes the gate", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "session_bypass");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve");
    await expect(promise).resolves.toBe("approve");
  });

  it("session_bypass when cached short-circuits to 'approve'", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "session_bypass");
    gate.markSessionBypassed("ws-aaaaaa");
    const decision = await awaitApprovalForDelegation(gate, "ws-aaaaaa", makeRequest());
    expect(decision).toBe("approve");
  });

  it("approve_session marks the workspace as session-bypassed", async () => {
    await gate.setModeForWorkspace("ws-aaaaaa", "per_call");
    const req = makeRequest();
    const promise = awaitApprovalForDelegation(gate, "ws-aaaaaa", req);
    gate.resolveApproval(req.delegation_id, "approve_session");
    await promise;
    expect(gate.isSessionBypassed("ws-aaaaaa")).toBe(true);
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
