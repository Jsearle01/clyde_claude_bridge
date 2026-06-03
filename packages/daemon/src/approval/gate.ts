// T-P2-008: ApprovalGate — composition over WorkspacesStore (per-workspace
// mode reader/writer) + PendingApprovalRegistry (in-flight approvals) +
// extension-IPC sender. Delegate handler calls into this; the gate decides
// whether to skip (auto mode), prompt (per_call or session_bypass-cold), or
// pass-through (session_bypass-warm).

import type {
  ApprovalRequest,
  WorkspaceMode,
  OperationGranularity,
} from "@claude-bridge/shared";
import {
  PendingApprovalRegistry,
  type ApprovalDecision,
  ApprovalRejectedError,
} from "./pending.js";
import type { WorkspacesStore } from "../workspace/store.js";
import type { WorkspaceBinding } from "../mcp/auth.js";

export interface ApprovalGate {
  getModeForWorkspace(identifier: string): WorkspaceMode;
  // T-P2-008.7 (C-30): session-bypass is keyed by (mcp_session_id +
  // workspace_id). A bypass set in one MCP session must NOT apply to
  // another session, and a bypass for one workspace must NOT apply to
  // another workspace.
  isSessionBypassed(sessionId: string | undefined, identifier: string): boolean;
  markSessionBypassed(sessionId: string | undefined, identifier: string): void;
  clearSessionBypass(sessionId: string | undefined, identifier: string): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  setModeForWorkspace(identifier: string, mode: WorkspaceMode): Promise<void>;
  resolveApproval(delegation_id: string, decision: ApprovalDecision): void;
  cancelByWorkspace(identifier: string, reason: "extension_reconnected" | "workspace_deregistered"): void;
  pendingSize(): number;
  stop(): Promise<void>;
}

// T-P2-008.7: composite bypass key. The space separator is unambiguous
// because neither component contains a space (session ids are UUIDs;
// workspace identifiers are kebab+hex). Undefined session id (non-MCP caller)
// degrades to an empty-session key — still workspace-isolated.
function bypassKey(sessionId: string | undefined, identifier: string): string {
  return `${sessionId ?? ""}::${identifier}`;
}

// Adapter for sending the approval_request over IPC. Provided by the
// daemon's main.ts (which wires it to IpcServer.sendServerMessage). Tests
// inject a recording stub.
export type SendApprovalRequest = (
  identifier: string,
  request: ApprovalRequest,
) => Promise<void>;

export class ApprovalGateImpl implements ApprovalGate {
  private readonly sessionBypassed = new Set<string>();

  constructor(
    private readonly store: WorkspacesStore,
    private readonly pending: PendingApprovalRegistry,
    private readonly sendToExtension: SendApprovalRequest,
  ) {}

  getModeForWorkspace(identifier: string): WorkspaceMode {
    const entry = this.store.findByIdentifier(identifier);
    return entry?.mode ?? "per_call";
  }

  isSessionBypassed(sessionId: string | undefined, identifier: string): boolean {
    return this.sessionBypassed.has(bypassKey(sessionId, identifier));
  }

  markSessionBypassed(sessionId: string | undefined, identifier: string): void {
    this.sessionBypassed.add(bypassKey(sessionId, identifier));
  }

  clearSessionBypass(sessionId: string | undefined, identifier: string): void {
    this.sessionBypassed.delete(bypassKey(sessionId, identifier));
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // Register the pending promise BEFORE sending — the extension can
    // respond synchronously in tests, so the registry must be ready.
    const promise = this.pending.awaitApproval(request);
    // Pre-attach a swallow handler so the cancel-path rejection below
    // doesn't surface as an unhandled rejection — when send fails, we
    // cancel the pending (which rejects this promise) AND throw our own
    // fresh error to the caller. Both can't be observed by one consumer.
    promise.catch(() => undefined);
    try {
      await this.sendToExtension(request.identifier, request);
    } catch (err) {
      // Couldn't deliver to the extension (socket closed, no active
      // connection, etc.). Cancel the pending and surface the failure.
      this.pending.cancel(request.delegation_id, "extension_reconnected");
      // Surface as ApprovalRejectedError-shape so the caller can map to
      // an HTTP-style error code.
      if (err instanceof ApprovalRejectedError) throw err;
      throw new ApprovalRejectedError("extension_reconnected");
    }
    return promise;
  }

  async setModeForWorkspace(
    identifier: string,
    mode: WorkspaceMode,
  ): Promise<void> {
    await this.store.setMode(identifier, mode);
  }

  resolveApproval(delegation_id: string, decision: ApprovalDecision): void {
    this.pending.resolve(delegation_id, decision);
  }

  cancelByWorkspace(
    identifier: string,
    reason: "extension_reconnected" | "workspace_deregistered",
  ): void {
    this.pending.cancelByWorkspace(identifier, reason);
    // T-P2-008.7: bypass keys are `<session>::<workspace>`; clear every
    // entry whose workspace component matches, across all sessions (the
    // extension for this workspace disconnected — drop its runtime trust).
    // Collect-then-delete to avoid mutating the Set mid-iteration. Suffix
    // must match bypassKey's `::` separator exactly.
    const suffix = `::${identifier}`;
    const toDelete: string[] = [];
    for (const key of this.sessionBypassed) {
      if (key.endsWith(suffix)) toDelete.push(key);
    }
    for (const key of toDelete) {
      this.sessionBypassed.delete(key);
    }
  }

  pendingSize(): number {
    return this.pending.size();
  }

  stop(): Promise<void> {
    return this.pending.stop();
  }
}

// Helper for the delegate handler. Returns when the delegation should
// proceed; throws ApprovalRejectedError when blocked.
//
// The gate's calling convention: caller pre-computes the workspace's mode
// (cheap: store lookup) and only calls this when the mode is not "auto".
/**
 * T-P3-005: resolve the granularity that governs THIS delegation.
 * Resolution order — operation overrides binding-default overrides fail-safe:
 *   1. the delegate call's explicit `granularity` (the per-operation choice);
 *   2. else, for an OAuth-bound token, its default granularity (or per_call
 *      if the token carries none — the fail-safe, NEVER the per-workspace mode);
 *   3. else (legacy global Bearer, or no binding info — e.g. internal/test
 *      callers) the per-workspace mode (auto|per_call; the deprecated
 *      `session_bypass` value normalizes to per_call). This is the only
 *      surviving use of `getModeForWorkspace` — the Bearer fallback.
 * Unspecified never means "unsupervised": the floor is always per_call.
 */
export function resolveOperationGranularity(
  callGranularity: OperationGranularity | undefined,
  binding: WorkspaceBinding | undefined,
  gate: ApprovalGate,
  identifier: string,
): OperationGranularity {
  if (callGranularity !== undefined) return callGranularity;
  if (binding !== undefined && binding.kind === "bound") {
    return binding.granularity ?? "per_call";
  }
  // Legacy Bearer (unconstrained) or no binding info: the per-workspace mode.
  const mode = gate.getModeForWorkspace(identifier);
  return mode === "session_bypass" ? "per_call" : mode;
}

export async function awaitApprovalForDelegation(
  gate: ApprovalGate,
  sessionId: string | undefined,
  identifier: string,
  request: ApprovalRequest,
  // T-P3-005: optional so existing internal/test callers (no binding) keep
  // compiling — they fall through to the per-workspace-mode (Bearer) path,
  // preserving pre-005 behavior exactly.
  callGranularity?: OperationGranularity,
  binding?: WorkspaceBinding,
): Promise<ApprovalDecision> {
  const granularity = resolveOperationGranularity(
    callGranularity,
    binding,
    gate,
    identifier,
  );

  // `auto` — no discretionary delegation prompt. NOTE: this is NOT "never
  // stops": the always-gate floor (sandbox-escape / irreversible / recursive)
  // that `auto` runs within arrives in T-P3-006. At this layer `auto` only
  // skips the existing delegation prompt.
  if (granularity === "auto") {
    return "approve";
  }
  // Honor a prior approve-once bypass (C-30 / T-P2-008.7), keyed by
  // (mcp_session_id + workspace_id). `task` is exactly this approve-once
  // mechanic; `per_call` also honors a bypass set by an explicit
  // "approve for this session" escalation.
  if (gate.isSessionBypassed(sessionId, identifier)) {
    return "approve";
  }
  const decision = await gate.requestApproval(request);
  const approved = decision === "approve" || decision === "approve_session";
  // `task`: ANY approve becomes approve-once for the operation/session.
  // `per_call`: only an explicit "approve for this session" sets the bypass
  // (the operator can still escalate mid-operation).
  if (approved && (granularity === "task" || decision === "approve_session")) {
    gate.markSessionBypassed(sessionId, identifier);
  }
  return decision;
}

export function truncateForApproval(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "…";
}

// Delegation IDs are independent of job IDs — approval may end up never
// producing a job. Short random suffix is sufficient since they're
// per-daemon-instance and short-lived.
let delegationCounter = 0;
export function generateDelegationId(): string {
  delegationCounter += 1;
  return `d_${Date.now().toString(36)}_${delegationCounter.toString(36)}`;
}
