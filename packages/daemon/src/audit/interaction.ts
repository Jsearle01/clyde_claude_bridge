// T-P3-007: the daemon interaction event log — the authoritative,
// Clyde-untamperable accountability spine for autonomous delegations. A
// delegation-grained append-only event stream at
// `~/.claude-bridge/interaction.jsonl`, reusing the AuditLog mechanism (queue/
// rotation/retention/0600, in the 006-self-protected dir). Operator-read: NOT
// exposed over MCP. The per-transaction REPORT that narrates these events is
// orchestrator discipline (methodology), not daemon-generated.
//
// Three interception sites emit (per CB-INTERACTION-LOG-RECON, they are single
// coherent points, not scattered): the delegate handler (dispatched +
// gate_decision — binding/granularity live in the MCP ctx, not the Job),
// the runner's terminal path (completed/aborted/cancelled), and canUseTool
// (floor_denied + push_observed).

import { join } from "node:path";
import { AuditLog } from "./log.js";
import type { OperationGranularity } from "@claude-bridge/shared";

/** Discriminated interaction event union. Distinct from `AuditEntry` (which is
 *  per-tool-call shaped). `ts` is stamped by the recorder. */
export type InteractionEvent =
  | {
      kind: "delegation_dispatched";
      ts: string;
      job_id: string;
      workspace_id: string;
      // prompt-HASH, never the raw prompt (privacy; the transcript holds the
      // full text if an operator needs it).
      prompt_hash: string;
      bound_workspace: string | null;
      granularity: OperationGranularity;
    }
  | {
      kind: "delegation_completed";
      ts: string;
      job_id: string;
      workspace_id: string;
      duration_ms: number;
      // Mechanical evidence from the daemon-assembled DelegationReport
      // (independent of Clyde's word — the diff says what changed).
      report_summary: ReportSummary;
    }
  | {
      kind: "delegation_aborted";
      ts: string;
      job_id: string;
      workspace_id: string;
      duration_ms: number;
      error_category: string;
      report_summary: ReportSummary;
    }
  | {
      kind: "delegation_cancelled";
      ts: string;
      job_id: string;
      workspace_id: string;
      duration_ms: number;
      report_summary: ReportSummary;
    }
  | {
      kind: "floor_denied";
      ts: string;
      job_id: string;
      workspace_id: string;
      tool: string;
      reason: string;
    }
  | {
      kind: "push_observed";
      ts: string;
      job_id: string;
      workspace_id: string;
      // hash of the git-push command (privacy; not the raw command).
      command_hash: string;
    }
  | {
      kind: "gate_decision";
      ts: string;
      // null when the decision was a deny (no job is created — nothing ran).
      job_id: string | null;
      workspace_id: string;
      decision: "approve" | "deny" | "approve_session";
      granularity: OperationGranularity;
    };

/** A compact, mechanical summary of a DelegationReport (counts + diff facts). */
export interface ReportSummary {
  status: string;
  files_created: number;
  files_modified: number;
  files_deleted: number;
  shell_commands: number;
  turns: number;
}

export type InteractionLog = AuditLog<InteractionEvent>;

export function makeInteractionLog(
  configDir: string,
  retentionDays: number,
): InteractionLog {
  return new AuditLog<InteractionEvent>(
    join(configDir, "interaction.jsonl"),
    retentionDays,
  );
}

// The event body callers pass (everything except the recorder-stamped `ts`).
type EventBody = DistributiveOmit<InteractionEvent, "ts">;
type DistributiveOmit<T, K extends keyof InteractionEvent> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Thin recorder over the interaction log. Stamps `ts` and is FIRE-AND-FORGET:
 * the accountability log must never block or break a delegation, so append
 * errors are swallowed (the daemon's stderr already surfaces write failures).
 */
export class InteractionRecorder {
  constructor(
    private readonly log: InteractionLog,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  record(body: EventBody): void {
    const event: InteractionEvent = { ...body, ts: this.clock().toISOString() };
    void this.log.append(event).catch(() => {
      // best-effort — must not break the run; AuditLog already logs to stderr.
    });
  }

  stop(): Promise<void> {
    return this.log.stop();
  }
}
