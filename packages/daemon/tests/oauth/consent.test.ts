// T-P3-002: unit tests for the ConsentManager state machine.
//
// LOAD-BEARING (race orderings): the two race-ordering tests in the
// "race resolution" describe block are the verdict-time evidence for
// daemon-authoritative race resolution. Their failure is a verdict
// blocker.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ACK_TIMEOUT_MS,
  AUTH_CODE_TTL_MS,
  ConsentManager,
  DECISION_TIMEOUT_MS,
  generateAuthCode,
  generateRequestId,
} from "../../src/oauth/consent.js";
import type { Logger } from "../../src/log/logger.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};

interface SentMessage {
  kind: string;
  request_id?: string;
}

interface BindingMessage {
  identifier: string;
  client_id?: string;
  client_name?: string;
  bound_workspace?: string;
}

function makeManager(opts?: {
  recipients?: number;
  sendThrows?: boolean;
}): {
  manager: ConsentManager;
  sent: SentMessage[];
  timeouts: SentMessage[];
  resolved: SentMessage[];
  bindings: BindingMessage[];
} {
  const sent: SentMessage[] = [];
  const timeouts: SentMessage[] = [];
  // T-P3-002R: dismiss-siblings broadcasts.
  const resolved: SentMessage[] = [];
  // T-P3-003: targeted binding-established sends.
  const bindings: BindingMessage[] = [];
  const manager = new ConsentManager(
    { logger: silentLogger },
    (msg) => {
      if (opts?.sendThrows === true) throw new Error("send failed");
      const recipients = opts?.recipients ?? 1;
      // Faithful to broadcastServerMessage: only record sends that
      // actually had at least one recipient socket to write to.
      if (recipients > 0) sent.push(msg);
      return recipients;
    },
    (msg) => {
      timeouts.push(msg);
    },
    (msg) => {
      resolved.push(msg);
    },
    (identifier, msg) => {
      bindings.push({ identifier, ...msg });
    },
  );
  return { manager, sent, timeouts, resolved, bindings };
}

function dcrArgs(overrides: Partial<{
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state_param: string;
  code_challenge: string;
}> = {}): {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state_param: string;
  code_challenge: string;
} {
  return {
    client_id: "cb_client_abc",
    client_name: "Test Client",
    redirect_uri: "https://example.com/cb",
    state_param: "xyz",
    code_challenge: "challenge_S256_hash",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("generateRequestId / generateAuthCode (T-P3-002 Decision a)", () => {
  it("request_id is 32 hex chars (16 random bytes)", () => {
    expect(generateRequestId()).toMatch(/^[a-f0-9]{32}$/);
  });

  it("auth_code is 64 hex chars (32 random bytes)", () => {
    expect(generateAuthCode()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("values are distinct across calls (unguessable)", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
    expect(generateAuthCode()).not.toBe(generateAuthCode());
  });
});

describe("ConsentManager.beginConsent (extension-offline guardrail)", () => {
  it("returns ok + creates record + emits IPC when one+ extension is online", () => {
    const { manager, sent } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request_id).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe("auth_consent_request");
  });

  it("returns offline + does NOT create record when 0 extensions online (guardrail order)", () => {
    const { manager, sent } = makeManager({ recipients: 0 });
    const r = manager.beginConsent(dcrArgs());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("extension_offline");
    expect(sent).toHaveLength(0);
    expect(manager.size().consents).toBe(0);
  });

  it("returns offline if the send adapter throws (defensive)", () => {
    const { manager } = makeManager({ sendThrows: true });
    const r = manager.beginConsent(dcrArgs());
    expect(r.ok).toBe(false);
    expect(manager.size().consents).toBe(0);
  });

  it("returns offline after stop() (shutdown discipline)", () => {
    const { manager } = makeManager({ recipients: 1 });
    manager.stop();
    const r = manager.beginConsent(dcrArgs());
    expect(r.ok).toBe(false);
  });
});

describe("ConsentManager — happy path (ack + approve + auth-code)", () => {
  it("ack → approve → awaitDecision resolves with approved+code", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Ack-then-approve.
    manager.recordAck(r.request_id);
    const ackOutcome = await manager.awaitAck(r.request_id);
    expect(ackOutcome).toBe("acked");

    manager.recordDecision(r.request_id, "approve");
    const outcome = await manager.awaitDecision(r.request_id);
    expect(outcome.kind).toBe("approved");
    if (outcome.kind === "approved") {
      expect(outcome.code).toMatch(/^[a-f0-9]{64}$/);
    }
    const consent = manager.getConsent(r.request_id);
    expect(consent?.state).toBe("approved");
    expect(consent?.issued_code).toMatch(/^[a-f0-9]{64}$/);
  });

  it("auth code is bound to (client_id, redirect_uri, code_challenge, state)", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const args = dcrArgs({
      client_id: "cb_client_xyz",
      redirect_uri: "https://example.com/cb",
      code_challenge: "challenge_xyz",
      state_param: "client_state_value",
    });
    const r = manager.beginConsent(args);
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    const codeRec = manager.getAuthCode(outcome.code);
    expect(codeRec).not.toBeNull();
    expect(codeRec?.client_id).toBe(args.client_id);
    expect(codeRec?.redirect_uri).toBe(args.redirect_uri);
    expect(codeRec?.code_challenge).toBe(args.code_challenge);
    expect(codeRec?.code_challenge_method).toBe("S256");
    expect(codeRec?.state_param).toBe(args.state_param);
  });

  it("auth code is single-use — redeemAuthCode returns the record then null on second call", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    const first = manager.redeemAuthCode(outcome.code);
    expect(first).not.toBeNull();
    const second = manager.redeemAuthCode(outcome.code);
    expect(second).toBeNull();
  });
});

describe("ConsentManager — denial + dismissal", () => {
  it("ack → deny → awaitDecision resolves with denied{deny}", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "deny");
    const outcome = await manager.awaitDecision(r.request_id);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.denial_kind).toBe("deny");
    expect(manager.getConsent(r.request_id)?.state).toBe("denied");
  });

  it("ack → dismiss → awaitDecision resolves with denied{dismiss}", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "dismiss");
    const outcome = await manager.awaitDecision(r.request_id);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.denial_kind).toBe("dismiss");
  });

  it("deny issues NO auth code", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "deny");
    await manager.awaitDecision(r.request_id);
    expect(manager.size().auth_codes).toBe(0);
  });
});

describe("ConsentManager — ack timeout", () => {
  it("awaitAck resolves with ack_timeout after 3s if no ack arrives", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    const ackPromise = manager.awaitAck(r.request_id);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
    expect(await ackPromise).toBe("ack_timeout");
  });

  it("a late ack after ack-timeout is a no-op (idempotent recordAck)", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    const ackPromise = manager.awaitAck(r.request_id);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
    await ackPromise;
    // Late ack arrives — record it; should not throw, should not flip state
    // to acked retroactively (the consent is still pending — the
    // authorize handler has already given up).
    expect(() => manager.recordAck(r.request_id)).not.toThrow();
  });
});

describe("ConsentManager — decision timeout", () => {
  it("awaitDecision resolves with timeout after 30s if no decision arrives", async () => {
    vi.useFakeTimers();
    const { manager, timeouts } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    const decisionPromise = manager.awaitDecision(r.request_id);
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 1);
    expect((await decisionPromise).kind).toBe("timeout");
    expect(manager.getConsent(r.request_id)?.state).toBe("timeout");
    // Daemon sent auth_consent_timeout to the extension as best-effort.
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.kind).toBe("auth_consent_timeout");
  });
});

// ===========================================================================
// LOAD-BEARING: daemon-authoritative race resolution
// ===========================================================================
describe("ConsentManager — race resolution (daemon-authoritative — LOAD-BEARING)", () => {
  it("response AFTER 30s timeout fired → discarded; state stays `timeout`", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    const decisionPromise = manager.awaitDecision(r.request_id);
    // Trigger timeout.
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 1);
    const outcome = await decisionPromise;
    expect(outcome.kind).toBe("timeout");
    expect(manager.getConsent(r.request_id)?.state).toBe("timeout");
    // NOW the extension's response straggles in. Daemon-authoritative:
    // the late write is discarded; state remains timeout; no auth code is
    // issued; no throw.
    expect(() => manager.recordDecision(r.request_id, "approve")).not.toThrow();
    expect(manager.getConsent(r.request_id)?.state).toBe("timeout");
    expect(manager.getConsent(r.request_id)?.issued_code).toBeNull();
    expect(manager.size().auth_codes).toBe(0);
  });

  it("30s timeout fires AFTER response was recorded → timeout is a no-op; state stays as resolved", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    const decisionPromise = manager.awaitDecision(r.request_id);
    // Response recorded BEFORE the timer fires.
    manager.recordDecision(r.request_id, "approve");
    const outcome = await decisionPromise;
    expect(outcome.kind).toBe("approved");
    const consent = manager.getConsent(r.request_id);
    expect(consent?.state).toBe("approved");
    const code = consent?.issued_code;
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    // NOW the 30s timer fires. Daemon-authoritative: state was already
    // resolved; the timer's attempted transition to `timeout` is a no-op;
    // state remains `approved`; the issued code is intact.
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 1);
    // Allow microtasks to flush.
    await Promise.resolve();
    expect(manager.getConsent(r.request_id)?.state).toBe("approved");
    expect(manager.getConsent(r.request_id)?.issued_code).toBe(code);
  });

  it("duplicate decision arrival → first wins; second is a no-op", () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");
    const firstCode = manager.getConsent(r.request_id)?.issued_code;
    expect(firstCode).toMatch(/^[a-f0-9]{64}$/);
    // Second response (somehow) arrives — discard.
    expect(() => manager.recordDecision(r.request_id, "deny")).not.toThrow();
    expect(manager.getConsent(r.request_id)?.state).toBe("approved");
    expect(manager.getConsent(r.request_id)?.issued_code).toBe(firstCode);
    expect(manager.getConsent(r.request_id)?.denial_kind).toBeNull();
  });
});

describe("ConsentManager — auth code TTL", () => {
  it("a code older than 60s is expired (getAuthCode → null; redeem → null)", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    expect(manager.getAuthCode(outcome.code)).not.toBeNull();
    vi.advanceTimersByTime(AUTH_CODE_TTL_MS + 1);
    expect(manager.getAuthCode(outcome.code)).toBeNull();
    expect(manager.redeemAuthCode(outcome.code)).toBeNull();
  });
});

describe("ConsentManager.stop — shutdown discipline", () => {
  it("clears all timers + resolves pending awaiters as timeouts", async () => {
    vi.useFakeTimers();
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    const decisionPromise = manager.awaitDecision(r.request_id);
    manager.stop();
    expect((await decisionPromise).kind).toBe("timeout");
    expect(manager.size().decision_timers).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T-P3-002R — responder-binds + dismiss-siblings
// ---------------------------------------------------------------------------

describe("T-P3-002R — grant binds to the responding workspace", () => {
  it("AC-1/AC-2: approve from workspace-A's connection binds the grant + auth code to workspace-A", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    // The IPC server resolves the responding socket → "workspace-A".
    manager.recordDecision(r.request_id, "approve", "workspace-A");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");

    // Consent record carries the binding.
    expect(manager.getConsent(r.request_id)?.bound_workspace).toBe("workspace-A");
    // AuthCodeRecord carries it (flows into /token redemption at T-P3-004).
    expect(manager.getAuthCode(outcome.code)?.bound_workspace).toBe("workspace-A");
  });

  it("a response from workspace-B's connection binds to workspace-B (not A)", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve", "workspace-B");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    expect(manager.getAuthCode(outcome.code)?.bound_workspace).toBe("workspace-B");
  });

  it("guard: approve with no resolvable workspace records a non-binding grant (null), still issues a code", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    // null = responding socket had no active registration.
    manager.recordDecision(r.request_id, "approve", null);
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    expect(manager.getConsent(r.request_id)?.bound_workspace).toBeNull();
    expect(manager.getAuthCode(outcome.code)?.bound_workspace).toBeNull();
  });

  it("default (omitted) bound_workspace is null — back-compat with 2-arg callers", async () => {
    const { manager } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve");
    const outcome = await manager.awaitDecision(r.request_id);
    if (outcome.kind !== "approved") throw new Error("expected approved");
    expect(manager.getAuthCode(outcome.code)?.bound_workspace).toBeNull();
  });
});

describe("T-P3-002R — dismiss-siblings on resolve (AC-2b)", () => {
  it("sends auth_consent_resolved on approve", () => {
    const { manager, resolved } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve", "workspace-A");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe("auth_consent_resolved");
    expect(resolved[0]?.request_id).toBe(r.request_id);
  });

  it("sends auth_consent_resolved on deny", () => {
    const { manager, resolved } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "deny", "workspace-A");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.kind).toBe("auth_consent_resolved");
  });

  it("first-write-wins: a late sibling response does NOT re-fire the dismiss signal", () => {
    const { manager, resolved } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    // First responder wins (workspace-A approves).
    manager.recordDecision(r.request_id, "approve", "workspace-A");
    expect(resolved).toHaveLength(1);
    // A late sibling response (workspace-B) after resolution is a no-op:
    // no state change, no second dismiss broadcast, binding unchanged.
    manager.recordDecision(r.request_id, "deny", "workspace-B");
    expect(resolved).toHaveLength(1);
    expect(manager.getConsent(r.request_id)?.state).toBe("approved");
    expect(manager.getConsent(r.request_id)?.bound_workspace).toBe("workspace-A");
  });

  it("does NOT send a resolved signal on the 30s decision-timeout path (that path has its own close signal)", async () => {
    vi.useFakeTimers();
    const { manager, resolved, timeouts } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    const decisionPromise = manager.awaitDecision(r.request_id);
    vi.advanceTimersByTime(DECISION_TIMEOUT_MS + 1);
    expect((await decisionPromise).kind).toBe("timeout");
    // Timeout fires auth_consent_timeout, NOT auth_consent_resolved.
    expect(timeouts).toHaveLength(1);
    expect(resolved).toHaveLength(0);
  });
});

describe("T-P3-003 — binding-established signal to the bound window", () => {
  it("approve with a bound workspace sends binding_established (targeted) with client info", () => {
    const { manager, bindings } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(
      dcrArgs({ client_id: "cb_client_zzz", client_name: "Proj X" }),
    );
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve", "workspace-A");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.identifier).toBe("workspace-A"); // targeted to bound ws
    expect(bindings[0]?.client_id).toBe("cb_client_zzz");
    expect(bindings[0]?.client_name).toBe("Proj X");
    expect(bindings[0]?.bound_workspace).toBe("workspace-A");
  });

  it("approve with NO resolvable workspace (null) does NOT send binding_established", () => {
    const { manager, bindings } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "approve", null);
    expect(bindings).toHaveLength(0);
  });

  it("deny does NOT send binding_established", () => {
    const { manager, bindings } = makeManager({ recipients: 1 });
    const r = manager.beginConsent(dcrArgs());
    if (!r.ok) throw new Error("expected ok");
    manager.recordAck(r.request_id);
    manager.recordDecision(r.request_id, "deny", "workspace-A");
    expect(bindings).toHaveLength(0);
  });
});
