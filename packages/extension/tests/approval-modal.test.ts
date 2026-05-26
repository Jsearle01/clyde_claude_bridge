// T-P2-008: tests for the approval modal UX. Verifies composeModalText
// content, button → decision mapping, modal dismissal → "deny", and
// approval_response send via the mocked IpcClient.

import { describe, it, expect, vi } from "vitest";
import type { ApprovalRequest } from "@claude-bridge/shared";
import {
  composeModalText,
  makeApprovalHandler,
  BTN_APPROVE,
  BTN_APPROVE_SESSION,
  BTN_DENY,
} from "../src/approval-modal.js";
import type { IpcClient } from "../src/ipc/client.js";

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: "approval_request",
    delegation_id: "d_test_abc",
    identifier: "myproject-54ab07",
    prompt: "Please refactor index.ts",
    mode_requested: "agentic",
    estimated_size: { exhibits_count: 2, total_inline_bytes: 1024 },
    timestamp: "2026-05-25T12:00:00.000Z",
    ...overrides,
  };
}

interface FakeIpcClient {
  send: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeIpcClient & IpcClient {
  const client: FakeIpcClient = {
    send: vi.fn(),
  };
  return client as FakeIpcClient & IpcClient;
}

describe("composeModalText (T-P2-008)", () => {
  it("includes identifier in header", () => {
    const t = composeModalText(makeRequest());
    expect(t).toContain("Claude wants to delegate to myproject-54ab07");
  });

  it("includes mode line", () => {
    expect(composeModalText(makeRequest({ mode_requested: "read_only" }))).toContain(
      "Mode: read_only",
    );
    expect(composeModalText(makeRequest({ mode_requested: "agentic" }))).toContain(
      "Mode: agentic",
    );
  });

  it("includes exhibit count when present", () => {
    const t = composeModalText(makeRequest());
    expect(t).toContain("2 exhibits");
    expect(t).toContain("1.0 KB inline");
  });

  it("omits the exhibits line when estimated_size has zero counts", () => {
    const t = composeModalText(
      makeRequest({ estimated_size: { exhibits_count: 0, total_inline_bytes: 0 } }),
    );
    expect(t).not.toContain("exhibits");
  });

  it("includes the truncation indicator when prompt ends in ellipsis", () => {
    const t = composeModalText(makeRequest({ prompt: "Long prompt text…" }));
    expect(t).toContain("(prompt truncated; full text in daemon audit log)");
  });

  it("omits the truncation indicator when prompt fits in full", () => {
    const t = composeModalText(makeRequest({ prompt: "short" }));
    expect(t).not.toContain("(prompt truncated");
  });

  it("includes the prompt body between fences", () => {
    const t = composeModalText(makeRequest({ prompt: "do this thing" }));
    expect(t).toMatch(/---\nPrompt:\ndo this thing\n---/);
  });
});

describe("makeApprovalHandler (T-P2-008)", () => {
  it("invokes showWarningMessage with modal:true and 3 buttons", async () => {
    const showWarning = vi.fn<
      (
        msg: string,
        opts: { modal?: boolean },
        ...buttons: string[]
      ) => Promise<string | undefined>
    >(() => Promise.resolve(BTN_APPROVE));
    const client = makeFakeClient();
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    await handler(makeRequest());
    expect(showWarning).toHaveBeenCalledWith(
      expect.any(String),
      { modal: true },
      BTN_APPROVE,
      BTN_APPROVE_SESSION,
      BTN_DENY,
    );
  });

  it("maps 'Approve' click to approval_response.decision='approve'", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_APPROVE));
    const client = makeFakeClient();
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    await handler(makeRequest());
    expect(client.send).toHaveBeenCalledWith({
      kind: "approval_response",
      delegation_id: "d_test_abc",
      decision: "approve",
    });
  });

  it("maps 'Approve for this session' to decision='approve_session'", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_APPROVE_SESSION));
    const client = makeFakeClient();
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    await handler(makeRequest());
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approve_session" }),
    );
  });

  it("maps 'Deny' click to decision='deny'", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_DENY));
    const client = makeFakeClient();
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    await handler(makeRequest());
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
    );
  });

  it("maps modal dismissal (undefined return) to decision='deny' (default-deny)", async () => {
    const showWarning = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    await handler(makeRequest());
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
    );
  });

  it("swallows ipcClient.send errors (socket closed mid-modal)", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_APPROVE));
    const client: FakeIpcClient & IpcClient = {
      send: vi.fn(() => {
        throw new Error("ipc-client: not connected");
      }),
    } as FakeIpcClient & IpcClient;
    const handler = makeApprovalHandler(client, { showWarningMessage: showWarning });
    // Should not reject; the daemon's disconnect handler cancels the
    // pending approval on its side.
    await expect(handler(makeRequest())).resolves.toBeUndefined();
  });
});
