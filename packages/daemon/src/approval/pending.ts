// T-P2-008: pending-approval state machine. Holds in-flight approvals
// awaiting user decision via the extension's modal. Each entry has a
// 5-minute timer; shutdown rejects all pending entries.
//
// Internally tracks Map<delegation_id, PendingApproval>. The
// `awaitApproval` returns a Promise that resolves on decision or rejects
// on timeout/shutdown/extension_reconnected.

import type { ApprovalRequest } from "@claude-bridge/shared";

export type ApprovalDecision = "approve" | "deny" | "approve_session";
export type ApprovalRejectionReason =
  | "timeout"
  | "shutdown"
  | "extension_reconnected"
  | "workspace_deregistered";

export class ApprovalRejectedError extends Error {
  constructor(public readonly reason: ApprovalRejectionReason) {
    super(`approval rejected: ${reason}`);
    this.name = "ApprovalRejectedError";
  }
}

interface PendingEntry {
  delegation_id: string;
  identifier: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: ApprovalRejectedError) => void;
  timer: NodeJS.Timeout;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export class PendingApprovalRegistry {
  private readonly pending = new Map<string, PendingEntry>();
  private stopped = false;

  /** Register a new pending approval and return a promise that resolves
   *  to the user's decision (or rejects with ApprovalRejectedError). */
  awaitApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.stopped) {
      return Promise.reject(new ApprovalRejectedError("shutdown"));
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(request.delegation_id);
        if (entry === undefined) return;
        this.pending.delete(request.delegation_id);
        entry.reject(new ApprovalRejectedError("timeout"));
      }, APPROVAL_TIMEOUT_MS);
      // Allow Node to exit even while a timer is pending; shutdown path
      // also clears it.
      timer.unref?.();
      this.pending.set(request.delegation_id, {
        delegation_id: request.delegation_id,
        identifier: request.identifier,
        resolve,
        reject,
        timer,
      });
    });
  }

  /** Resolve a pending approval with the user's decision. No-op if the
   *  delegation_id is unknown (stale response after timeout). */
  resolve(delegation_id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(delegation_id);
    if (entry === undefined) return;
    this.pending.delete(delegation_id);
    clearTimeout(entry.timer);
    entry.resolve(decision);
  }

  /** Cancel a pending approval (extension disconnect, workspace dereg).
   *  No-op if the id is unknown. */
  cancel(
    delegation_id: string,
    reason: "extension_reconnected" | "workspace_deregistered",
  ): void {
    const entry = this.pending.get(delegation_id);
    if (entry === undefined) return;
    this.pending.delete(delegation_id);
    clearTimeout(entry.timer);
    entry.reject(new ApprovalRejectedError(reason));
  }

  /** Cancel all pending approvals for a given workspace identifier (used
   *  on extension disconnect; iterates the map and matches by stored
   *  identifier). */
  cancelByWorkspace(
    identifier: string,
    reason: "extension_reconnected" | "workspace_deregistered",
  ): void {
    const ids: string[] = [];
    for (const [id, entry] of this.pending) {
      if (entry.identifier === identifier) ids.push(id);
    }
    for (const id of ids) {
      this.cancel(id, reason);
    }
  }

  /** Shutdown — reject all pending approvals as "shutdown". Idempotent. */
  stop(): Promise<void> {
    this.stopped = true;
    const ids = Array.from(this.pending.keys());
    for (const id of ids) {
      const entry = this.pending.get(id);
      if (entry === undefined) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new ApprovalRejectedError("shutdown"));
    }
    return Promise.resolve();
  }

  size(): number {
    return this.pending.size;
  }
}
