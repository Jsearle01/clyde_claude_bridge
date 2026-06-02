// T-P3-003: tests for the OAuth consent modal handler. Verifies
// ack-before-resolve, named-modal content (client + codebase), approve/
// deny/dismiss mapping, and the dismiss-siblings (auth_consent_resolved)
// best-effort handling.

import { describe, it, expect, vi } from "vitest";
import type {
  AuthConsentRequest,
  AuthConsentResolved,
} from "@claude-bridge/shared";
import {
  composeConsentModalText,
  formatClientLabel,
  makeConsentHandlers,
  BTN_APPROVE,
  BTN_DENY,
} from "../src/oauth-consent.js";
import type { IpcClient } from "../src/ipc/client.js";

function makeRequest(
  overrides: Partial<AuthConsentRequest> = {},
): AuthConsentRequest {
  return {
    kind: "auth_consent_request",
    request_id: "req-abc",
    client_id: "cb_client_0123456789abcdef",
    client_name: "Claude.ai Project Foo",
    redirect_uri: "https://claude.ai/callback",
    ...overrides,
  };
}

interface FakeIpcClient {
  send: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeIpcClient & IpcClient {
  return { send: vi.fn() } as unknown as FakeIpcClient & IpcClient;
}

// A controllable showWarningMessage: resolves with whatever `resolveWith`
// returns, and exposes the pending promise so tests can interleave a
// resolved-elsewhere signal before the user "clicks".
function deferredWarning(): {
  fn: ReturnType<typeof vi.fn>;
  resolve: (choice: string | undefined) => void;
} {
  let resolveOuter: (choice: string | undefined) => void = () => undefined;
  const fn = vi.fn(
    () =>
      new Promise<string | undefined>((res) => {
        resolveOuter = res;
      }),
  );
  return { fn, resolve: (c) => resolveOuter(c) };
}

describe("formatClientLabel (T-P3-003)", () => {
  it("shows client_name + id-prefix when name is meaningful", () => {
    const label = formatClientLabel("cb_client_0123456789abcdef", "My Project");
    expect(label).toContain("My Project");
    expect(label).toContain("cb_client_01234567"); // 18-char prefix
  });

  it("falls back to id-prefix only when name is the generic default", () => {
    const label = formatClientLabel(
      "cb_client_0123456789abcdef",
      "unnamed-client",
    );
    expect(label).not.toContain("unnamed-client");
    expect(label).toContain("cb_client_01234567");
  });

  it("falls back to id-prefix when name is empty", () => {
    const label = formatClientLabel("cb_client_0123456789abcdef", "");
    expect(label).toContain("cb_client_01234567");
  });
});

describe("composeConsentModalText (T-P3-003) — names both parties", () => {
  it("names the claude.ai client and the codebase", () => {
    const t = composeConsentModalText(makeRequest(), "my-app");
    expect(t).toContain("Claude.ai Project Foo");
    expect(t).toContain("cb_client_01234567"); // id prefix always
    expect(t).toContain("my-app"); // codebase
  });

  it("the codebase name appears so a misclick (wrong window) is visible", () => {
    const t = composeConsentModalText(makeRequest(), "WRONG-workspace");
    expect(t).toContain("WRONG-workspace");
  });
});

describe("makeConsentHandlers.onAuthConsentRequest (T-P3-003)", () => {
  it("ACKs immediately, before the modal resolves (ack-before-resolve)", async () => {
    const warn = deferredWarning();
    const client = makeFakeClient();
    const { onAuthConsentRequest } = makeConsentHandlers(client, {
      showWarningMessage: warn.fn as never,
      getCodebaseName: () => "my-app",
    });
    const p = onAuthConsentRequest(makeRequest());
    // The modal is still pending — but the ack must already be sent.
    expect(client.send).toHaveBeenCalledWith({
      kind: "auth_consent_ack",
      request_id: "req-abc",
    });
    // The response must NOT have been sent yet.
    expect(client.send).toHaveBeenCalledTimes(1);
    warn.resolve(BTN_APPROVE);
    await p;
  });

  it("shows a modal:true dialog with Approve + Deny", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_APPROVE));
    const client = makeFakeClient();
    const { onAuthConsentRequest } = makeConsentHandlers(client, {
      showWarningMessage: showWarning,
      getCodebaseName: () => "my-app",
    });
    await onAuthConsentRequest(makeRequest());
    expect(showWarning).toHaveBeenCalledWith(
      expect.any(String),
      { modal: true },
      BTN_APPROVE,
      BTN_DENY,
    );
  });

  it("maps Approve → response.decision='approve'", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_APPROVE));
    const client = makeFakeClient();
    const { onAuthConsentRequest } = makeConsentHandlers(client, {
      showWarningMessage: showWarning,
      getCodebaseName: () => "my-app",
    });
    await onAuthConsentRequest(makeRequest());
    expect(client.send).toHaveBeenCalledWith({
      kind: "auth_consent_response",
      request_id: "req-abc",
      decision: "approve",
    });
  });

  it("maps Deny → 'deny'", async () => {
    const showWarning = vi.fn(() => Promise.resolve(BTN_DENY));
    const client = makeFakeClient();
    const { onAuthConsentRequest } = makeConsentHandlers(client, {
      showWarningMessage: showWarning,
      getCodebaseName: () => "my-app",
    });
    await onAuthConsentRequest(makeRequest());
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
    );
  });

  it("maps dismissal (undefined) → 'dismiss' (distinct from deny)", async () => {
    const showWarning = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentRequest } = makeConsentHandlers(client, {
      showWarningMessage: showWarning as never,
      getCodebaseName: () => "my-app",
    });
    await onAuthConsentRequest(makeRequest());
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "dismiss" }),
    );
  });
});

describe("dismiss-siblings — onAuthConsentResolved (T-P3-003, AC-6b)", () => {
  it("a sibling resolved while the modal is open suppresses this window's response (no-op click)", async () => {
    const warn = deferredWarning();
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentRequest, onAuthConsentResolved } = makeConsentHandlers(
      client,
      {
        showWarningMessage: warn.fn as never,
        showInformationMessage: showInfo as never,
        getCodebaseName: () => "my-app",
      },
    );
    const p = onAuthConsentRequest(makeRequest());
    client.send.mockClear(); // drop the ack from the assertion below

    // Another window wins: the daemon broadcasts auth_consent_resolved.
    const resolved: AuthConsentResolved = {
      kind: "auth_consent_resolved",
      request_id: "req-abc",
    };
    onAuthConsentResolved(resolved);
    expect(showInfo).toHaveBeenCalledTimes(1); // best-effort notification

    // The user then clicks this (now-stale) modal — no response is sent.
    warn.resolve(BTN_APPROVE);
    await p;
    expect(client.send).not.toHaveBeenCalled();
  });

  it("auth_consent_resolved for an unknown request_id is a harmless no-op", () => {
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentResolved } = makeConsentHandlers(client, {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)) as never,
      showInformationMessage: showInfo as never,
      getCodebaseName: () => "my-app",
    });
    onAuthConsentResolved({
      kind: "auth_consent_resolved",
      request_id: "never-seen",
    });
    expect(showInfo).not.toHaveBeenCalled();
  });

  it("the responder's own resolved signal is a no-op (modal already resolved + deleted)", async () => {
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentRequest, onAuthConsentResolved } = makeConsentHandlers(
      client,
      {
        showWarningMessage: vi.fn(() => Promise.resolve(BTN_APPROVE)),
        showInformationMessage: showInfo as never,
        getCodebaseName: () => "my-app",
      },
    );
    await onAuthConsentRequest(makeRequest()); // resolves + deletes from open
    onAuthConsentResolved({
      kind: "auth_consent_resolved",
      request_id: "req-abc",
    });
    // No "resolved elsewhere" notification — this window WAS the resolver.
    expect(showInfo).not.toHaveBeenCalled();
  });
});

describe("onAuthConsentTimeout (T-P3-003, AC-6/AC-7 modal-close-on-timeout)", () => {
  it("a 30s daemon timeout closes this window's open modal + suppresses its click", async () => {
    const warn = deferredWarning();
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentRequest, onAuthConsentTimeout } = makeConsentHandlers(
      client,
      {
        showWarningMessage: warn.fn as never,
        showInformationMessage: showInfo as never,
        getCodebaseName: () => "my-app",
      },
    );
    const p = onAuthConsentRequest(makeRequest());
    client.send.mockClear(); // drop the ack

    onAuthConsentTimeout({ kind: "auth_consent_timeout", request_id: "req-abc" });
    expect(showInfo).toHaveBeenCalledTimes(1); // timeout notice

    // The user then clicks the stale modal — no (discarded) response sent.
    warn.resolve(BTN_APPROVE);
    await p;
    expect(client.send).not.toHaveBeenCalled();
  });

  it("timeout for an unknown request_id is a harmless no-op", () => {
    const showInfo = vi.fn(() => Promise.resolve(undefined));
    const client = makeFakeClient();
    const { onAuthConsentTimeout } = makeConsentHandlers(client, {
      showWarningMessage: vi.fn(() => Promise.resolve(undefined)) as never,
      showInformationMessage: showInfo as never,
      getCodebaseName: () => "my-app",
    });
    onAuthConsentTimeout({
      kind: "auth_consent_timeout",
      request_id: "never-seen",
    });
    expect(showInfo).not.toHaveBeenCalled();
  });
});
