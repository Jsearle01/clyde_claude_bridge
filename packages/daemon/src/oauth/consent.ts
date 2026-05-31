// T-P3-002: OAuth consent state machine + auth-code map.
//
// In-memory and ephemeral by design (Decision a): daemon restart kills
// the flow; browser re-initiates. No new JSON file.
//
// State machine per design §3.4:
//   pending  → approved (ext sent auth_consent_response{approve})
//   pending  → denied   (ext sent auth_consent_response{deny|dismiss})
//   pending  → timeout  (30s decision timer fired)
//
// DAEMON-AUTHORITATIVE RACE RESOLUTION:
//   - The state transition is the SINGLE source of truth for who "wins"
//     a race between the timer firing and the IPC response arriving.
//   - First write to `state` wins: if pending → resolved happens, the
//     timer's later transition to `timeout` is a no-op. If pending →
//     timeout happens, a late IPC response is discarded (no state
//     change, no throw).
//   - Both paths funnel through `transition(...)` which short-circuits
//     when the state is no longer `pending`.
//
// AUTH CODES:
//   - Single-use, 60s TTL, bound to (client_id, redirect_uri,
//     code_challenge, code_challenge_method, state) for T-P3-004
//     redemption per RFC 6749 §4.1.3 + PKCE (RFC 7636).
//   - Redemption clears the code from the map immediately so a second
//     redemption with the same code fails.
//
// All timers use Node's setTimeout/clearTimeout; .unref() so a daemon
// shutdown with pending consents doesn't keep the event loop alive.

import { randomBytes } from "node:crypto";
import type { Logger } from "../log/logger.js";

// Decision b — pinned named constants, not config-surfaced. Centralized
// here so a future task lifting them to config has a single edit.
export const ACK_TIMEOUT_MS = 3000;
export const DECISION_TIMEOUT_MS = 30000;
export const AUTH_CODE_TTL_MS = 60000;

export type ConsentState = "pending" | "approved" | "denied" | "timeout";

export type ConsentResolution = "approve" | "deny" | "dismiss";

export interface ConsentRecord {
  request_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  state_param: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: number;
  state: ConsentState;
  // Populated when state becomes "approved"; the auth code that
  // `/authorize/status` redirects with.
  issued_code: string | null;
  // Populated when state becomes "denied"; carries the user's intent so
  // the error page can distinguish "Cancel" from "Don't trust".
  denial_kind: "deny" | "dismiss" | null;
  // Set once the extension acks; turns off the ack-timeout pathway.
  // Independent of the resolution. If still false when the ack timer
  // fires, the consent is invalidated as "ack_timeout" (returned to the
  // caller, not stored as a state value).
  acked: boolean;
}

export interface AuthCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state_param: string;
  issued_at: number;
  // Once redeemed, the record is removed from the map. Tracked here for
  // diagnostic clarity; never relied on externally.
  redeemed: boolean;
}

/** Outcome of waiting for the extension's ack. */
export type AckOutcome = "acked" | "ack_timeout";

/** Outcome of waiting for the user's consent decision. */
export type DecisionOutcome =
  | { kind: "approved"; code: string }
  | { kind: "denied"; denial_kind: "deny" | "dismiss" }
  | { kind: "timeout" };

export interface ConsentManagerDeps {
  logger: Logger;
}

/**
 * Send-to-extension adapter. Provided by main.ts (wires it to the
 * IpcServer broadcast path for now; T-P3-003 will replace with the real
 * extension's IPC connection). Returns the number of extensions notified;
 * 0 means "no extension is online" → caller surfaces the offline error
 * page BEFORE creating a consent record.
 */
export type SendConsentRequest = (msg: {
  kind: "auth_consent_request";
  request_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
}) => number;

export type SendConsentTimeout = (msg: {
  kind: "auth_consent_timeout";
  request_id: string;
}) => void;

/** Unguessable 16-byte hex (32 chars) — third parties can't poll someone
 *  else's consent. */
export function generateRequestId(): string {
  return randomBytes(16).toString("hex");
}

/** Auth code per Decision a: 32-byte hex (64 chars). */
export function generateAuthCode(): string {
  return randomBytes(32).toString("hex");
}

export class ConsentManager {
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly authCodes = new Map<string, AuthCodeRecord>();
  // Decision timers keyed by request_id. The ack-timeout pathway is
  // handled inline in `awaitAck` (one-shot promise + setTimeout); no
  // map entry needed there.
  private readonly decisionTimers = new Map<string, NodeJS.Timeout>();
  // Auth-code expiry timers keyed by code.
  private readonly codeExpiryTimers = new Map<string, NodeJS.Timeout>();
  // Resolvers waiting for ack/decision/timeout on a request_id. Cleared
  // when consumed; preserved across transition() to allow late-arrival
  // discard semantics.
  private readonly ackResolvers = new Map<string, (o: AckOutcome) => void>();
  private readonly decisionResolvers = new Map<
    string,
    (o: DecisionOutcome) => void
  >();
  private stopped = false;

  constructor(
    private readonly deps: ConsentManagerDeps,
    private readonly sendConsentRequest: SendConsentRequest,
    private readonly sendConsentTimeout: SendConsentTimeout,
  ) {}

  /**
   * Create a consent record and notify the extension. Returns:
   *  - { ok: true, request_id } on success (consent record created;
   *    awaitAck/awaitDecision can now be called against the id).
   *  - { ok: false, reason: "extension_offline" } when no extension is
   *    connected — NO consent record is created (guardrail order: error
   *    page surfaces before any IPC fires).
   */
  beginConsent(args: {
    client_id: string;
    client_name: string;
    redirect_uri: string;
    state_param: string;
    code_challenge: string;
  }): { ok: true; request_id: string } | { ok: false; reason: "extension_offline" } {
    if (this.stopped) {
      return { ok: false, reason: "extension_offline" };
    }
    const request_id = generateRequestId();
    const record: ConsentRecord = {
      request_id,
      client_id: args.client_id,
      client_name: args.client_name,
      redirect_uri: args.redirect_uri,
      state_param: args.state_param,
      code_challenge: args.code_challenge,
      code_challenge_method: "S256",
      created_at: Date.now(),
      state: "pending",
      issued_code: null,
      denial_kind: null,
      acked: false,
    };
    // Optimistic insert so the send-adapter can find the record if it
    // synchronously triggers a callback; if send fails, we delete.
    this.consents.set(request_id, record);
    let delivered: number;
    try {
      delivered = this.sendConsentRequest({
        kind: "auth_consent_request",
        request_id,
        client_id: args.client_id,
        client_name: args.client_name,
        redirect_uri: args.redirect_uri,
      });
    } catch (err) {
      this.consents.delete(request_id);
      this.deps.logger.warn("oauth consent: send failed", {
        request_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: "extension_offline" };
    }
    if (delivered === 0) {
      this.consents.delete(request_id);
      return { ok: false, reason: "extension_offline" };
    }
    return { ok: true, request_id };
  }

  /** Awaits the extension's ack (3s window). Resolves with "acked" on
   *  receipt, "ack_timeout" if the ack timer fires first. Safe to call
   *  exactly once per request_id. */
  awaitAck(request_id: string): Promise<AckOutcome> {
    return new Promise((resolve) => {
      const record = this.consents.get(request_id);
      if (record === undefined) {
        // Defensive: caller didn't pair with a successful beginConsent.
        resolve("ack_timeout");
        return;
      }
      if (record.acked) {
        resolve("acked");
        return;
      }
      let settled = false;
      const settle = (o: AckOutcome): void => {
        if (settled) return;
        settled = true;
        this.ackResolvers.delete(request_id);
        resolve(o);
      };
      this.ackResolvers.set(request_id, settle);
      const ackTimer = setTimeout(() => {
        settle("ack_timeout");
      }, ACK_TIMEOUT_MS);
      ackTimer.unref?.();
    });
  }

  /** Starts the 30s decision timer (if not already running) and awaits
   *  the decision. Resolves on extension response or timeout. Safe to
   *  call at most once per request_id. */
  awaitDecision(request_id: string): Promise<DecisionOutcome> {
    return new Promise((resolve) => {
      const record = this.consents.get(request_id);
      if (record === undefined) {
        resolve({ kind: "timeout" });
        return;
      }
      // If the state already resolved (e.g., synchronous ack-then-approve
      // from the stub), return immediately.
      if (record.state === "approved" && record.issued_code !== null) {
        resolve({ kind: "approved", code: record.issued_code });
        return;
      }
      if (record.state === "denied" && record.denial_kind !== null) {
        resolve({ kind: "denied", denial_kind: record.denial_kind });
        return;
      }
      if (record.state === "timeout") {
        resolve({ kind: "timeout" });
        return;
      }
      let settled = false;
      const settle = (o: DecisionOutcome): void => {
        if (settled) return;
        settled = true;
        this.decisionResolvers.delete(request_id);
        const t = this.decisionTimers.get(request_id);
        if (t !== undefined) {
          clearTimeout(t);
          this.decisionTimers.delete(request_id);
        }
        resolve(o);
      };
      this.decisionResolvers.set(request_id, settle);
      if (!this.decisionTimers.has(request_id)) {
        const t = setTimeout(() => {
          // Decision timer fired. Transition to timeout (no-op if already
          // resolved — daemon-authoritative race resolution).
          const fired = this.transition(request_id, { kind: "timeout" });
          if (fired === "transitioned") {
            // Notify the extension to close its modal (best-effort).
            try {
              this.sendConsentTimeout({
                kind: "auth_consent_timeout",
                request_id,
              });
            } catch (err) {
              this.deps.logger.warn(
                "oauth consent: timeout-notify send failed",
                {
                  request_id,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            }
          }
          // Resolve the awaiter regardless — if state already resolved
          // before the timer fired, settle() reads the record's resolved
          // values.
          const r = this.consents.get(request_id);
          if (r === undefined) {
            settle({ kind: "timeout" });
            return;
          }
          if (r.state === "approved" && r.issued_code !== null) {
            settle({ kind: "approved", code: r.issued_code });
            return;
          }
          if (r.state === "denied" && r.denial_kind !== null) {
            settle({ kind: "denied", denial_kind: r.denial_kind });
            return;
          }
          settle({ kind: "timeout" });
        }, DECISION_TIMEOUT_MS);
        t.unref?.();
        this.decisionTimers.set(request_id, t);
      }
    });
  }

  /** Records the extension's ack. Idempotent; no-op if already acked or
   *  if the consent is missing/resolved. */
  recordAck(request_id: string): void {
    const record = this.consents.get(request_id);
    if (record === undefined) return;
    if (record.acked) return;
    if (record.state !== "pending") return;
    record.acked = true;
    const resolver = this.ackResolvers.get(request_id);
    if (resolver !== undefined) resolver("acked");
  }

  /** Records the extension's decision. Late arrivals (state !== pending)
   *  are SILENTLY DISCARDED — daemon-authoritative race resolution. */
  recordDecision(request_id: string, decision: ConsentResolution): void {
    const record = this.consents.get(request_id);
    if (record === undefined) {
      // Unknown request_id — discard. No throw; this is a routine race.
      return;
    }
    if (record.state !== "pending") {
      // Late arrival — state already resolved (timeout fired first, or
      // another response slipped through). Discard.
      this.deps.logger.info("oauth consent: late decision discarded", {
        request_id,
        current_state: record.state,
        attempted_decision: decision,
      });
      return;
    }
    if (decision === "approve") {
      const code = generateAuthCode();
      const codeRecord: AuthCodeRecord = {
        code,
        client_id: record.client_id,
        redirect_uri: record.redirect_uri,
        code_challenge: record.code_challenge,
        code_challenge_method: "S256",
        state_param: record.state_param,
        issued_at: Date.now(),
        redeemed: false,
      };
      this.authCodes.set(code, codeRecord);
      const expiryTimer = setTimeout(() => {
        this.authCodes.delete(code);
        this.codeExpiryTimers.delete(code);
      }, AUTH_CODE_TTL_MS);
      expiryTimer.unref?.();
      this.codeExpiryTimers.set(code, expiryTimer);
      this.transition(request_id, { kind: "approved", code });
    } else {
      this.transition(request_id, {
        kind: "denied",
        denial_kind: decision,
      });
    }
  }

  /** Look up a consent record (read-only). Used by /authorize/status. */
  getConsent(request_id: string): ConsentRecord | null {
    return this.consents.get(request_id) ?? null;
  }

  /** Look up an auth code for redemption (T-P3-004). Returns null if
   *  unknown, redeemed, or expired. Calling this DOES NOT redeem — use
   *  redeemAuthCode for the single-use semantics. */
  getAuthCode(code: string): AuthCodeRecord | null {
    const rec = this.authCodes.get(code);
    if (rec === undefined) return null;
    if (rec.redeemed) return null;
    if (Date.now() - rec.issued_at > AUTH_CODE_TTL_MS) return null;
    return rec;
  }

  /** Single-use redemption. Returns the record on the first call;
   *  returns null on subsequent calls (or if expired). T-P3-004's
   *  /token handler uses this. */
  redeemAuthCode(code: string): AuthCodeRecord | null {
    const rec = this.authCodes.get(code);
    if (rec === undefined) return null;
    if (rec.redeemed) return null;
    if (Date.now() - rec.issued_at > AUTH_CODE_TTL_MS) {
      // Expired between issuance and redemption attempt. Clean up.
      this.authCodes.delete(code);
      const t = this.codeExpiryTimers.get(code);
      if (t !== undefined) {
        clearTimeout(t);
        this.codeExpiryTimers.delete(code);
      }
      return null;
    }
    rec.redeemed = true;
    // Remove from the map immediately so any concurrent redemption sees
    // null. The expiry timer's late delete is a no-op.
    this.authCodes.delete(code);
    const t = this.codeExpiryTimers.get(code);
    if (t !== undefined) {
      clearTimeout(t);
      this.codeExpiryTimers.delete(code);
    }
    return rec;
  }

  /** Diagnostic — used in tests and verdict-time evidence. */
  size(): {
    consents: number;
    auth_codes: number;
    decision_timers: number;
    code_expiry_timers: number;
  } {
    return {
      consents: this.consents.size,
      auth_codes: this.authCodes.size,
      decision_timers: this.decisionTimers.size,
      code_expiry_timers: this.codeExpiryTimers.size,
    };
  }

  /** Daemon-shutdown hook: cancel all timers; reject all pending awaiters
   *  as timeouts. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.decisionTimers.values()) clearTimeout(t);
    this.decisionTimers.clear();
    for (const t of this.codeExpiryTimers.values()) clearTimeout(t);
    this.codeExpiryTimers.clear();
    for (const resolver of this.ackResolvers.values()) resolver("ack_timeout");
    this.ackResolvers.clear();
    for (const resolver of this.decisionResolvers.values())
      resolver({ kind: "timeout" });
    this.decisionResolvers.clear();
  }

  /**
   * The single state-mutation funnel. Returns "transitioned" when the
   * write actually applied (state was pending); "noop" when the state
   * was already resolved (race lost; discard). This is the load-bearing
   * race-resolution primitive.
   */
  private transition(
    request_id: string,
    next:
      | { kind: "approved"; code: string }
      | { kind: "denied"; denial_kind: "deny" | "dismiss" }
      | { kind: "timeout" },
  ): "transitioned" | "noop" {
    const record = this.consents.get(request_id);
    if (record === undefined) return "noop";
    if (record.state !== "pending") return "noop";
    if (next.kind === "approved") {
      record.state = "approved";
      record.issued_code = next.code;
    } else if (next.kind === "denied") {
      record.state = "denied";
      record.denial_kind = next.denial_kind;
    } else {
      record.state = "timeout";
    }
    // Wake any waiters synchronously; decision timer is cleared by the
    // settle() inside the resolver.
    const decisionResolver = this.decisionResolvers.get(request_id);
    if (decisionResolver !== undefined) {
      if (record.state === "approved" && record.issued_code !== null) {
        decisionResolver({ kind: "approved", code: record.issued_code });
      } else if (record.state === "denied" && record.denial_kind !== null) {
        decisionResolver({ kind: "denied", denial_kind: record.denial_kind });
      } else {
        decisionResolver({ kind: "timeout" });
      }
    }
    return "transitioned";
  }
}
