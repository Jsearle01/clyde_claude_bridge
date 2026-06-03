// DelegationReport + tool I/O contracts for P1. Mirrors
// `docs/design/02-p1-delegation.md` §"DelegationReport" exactly.
//
// Size caps (32 KB prompt, 256 KB inline exhibit total) are NOT enforced
// here — they live at the tool handler in P1's Phase 5. This file only
// encodes the wire shape so size-policy can evolve per-deployment without
// schema churn. ID format enforcement likewise lives in the registry and
// generator, not in these schemas (Decision A, T-P1-001 dispatch).

import { z } from "zod";
import { JobStatusSchema } from "./jobs.js";
import { PartialProgressSchema } from "./jobs.js";
import { OperationGranularitySchema } from "./oauth.js";

// ---------- nested record types ----------

export const ExhibitSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
  })
  .strict();
export type Exhibit = z.infer<typeof ExhibitSchema>;

export const ShellCommandSchema = z
  .object({
    cmd: z.string(),
    exit_code: z.number().int().nullable(),
  })
  .strict();
export type ShellCommand = z.infer<typeof ShellCommandSchema>;

export const DiagnosticSchema = z
  .object({
    path: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    severity: z.enum(["error", "warning", "info", "hint"]),
    message: z.string(),
    source: z.string(),
  })
  .strict();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const ErrorCategorySchema = z.enum([
  "auth",
  "permission",
  "sdk_runtime",
  "timeout",
  "cancelled",
  "internal",
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ErrorDetailSchema = z
  .object({
    category: ErrorCategorySchema,
    message: z.string(),
    details: z.string().nullable(),
  })
  .strict();
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

// ---------- DelegationReport ----------

// Terminal-only statuses; failed/cancelled/complete. The wider JobStatus
// is the runtime state; reports only ever carry terminal values.
export const ReportStatusSchema = z.enum(["complete", "failed", "cancelled"]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const DiagnosticsDeltaSchema = z
  .object({
    added: z.array(DiagnosticSchema),
    resolved: z.array(DiagnosticSchema),
  })
  .strict();
export type DiagnosticsDelta = z.infer<typeof DiagnosticsDeltaSchema>;

export const DelegationReportSchema = z
  .object({
    job_id: z.string().min(1),
    workspace_id: z.string().min(1),
    status: ReportStatusSchema,
    summary: z.string(),
    files_created: z.array(z.string()),
    files_modified: z.array(z.string()),
    files_deleted: z.array(z.string()),
    diff: z.string(),
    diff_truncated: z.boolean(),
    diagnostics_before: z.array(DiagnosticSchema),
    diagnostics_after: z.array(DiagnosticSchema),
    diagnostics_delta: DiagnosticsDeltaSchema,
    shell_commands: z.array(ShellCommandSchema),
    tool_calls_made: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncation_reason: z.string().nullable(),
    transcript_uri: z.string(),
    error: ErrorDetailSchema.nullable(),
  })
  .strict();
export type DelegationReport = z.infer<typeof DelegationReportSchema>;

// ---------- delegate_to_claude_code ----------

export const DelegateInputSchema = z
  .object({
    // P2 (T-P2-007): required. P1 made this optional and the daemon's
    // StubWorkspaceRegistry resolved undefined → the single configured
    // workspace; P2's multi-workspace registry has no default, so the
    // wire layer enforces an identifier. Clients that omit the field
    // get a 400 schema-validation error before reaching the handler.
    workspace: z.string().min(1),
    prompt: z.string().min(1),
    exhibits: z.array(ExhibitSchema).optional(),
    mode: z.enum(["read_only", "agentic"]).optional(),
    model: z.string().optional(),
    max_turns: z.number().int().min(1).max(200).optional(),
    working_directory: z.string().optional(),
    // T-P3-005: per-operation approval granularity (the operator's
    // handoff-time choice, relayed by claude.ai). Optional — when omitted,
    // the gate resolves binding-default → per_call fail-safe. Distinct from
    // `mode` (read_only/agentic = the SDK permission level, not approval).
    granularity: OperationGranularitySchema.optional(),
  })
  .strict();
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

// `status` on enqueue is queued or running only — the job is freshly
// minted, not yet terminal. Schema accepts the wider JobStatus to keep
// one source of truth; the tool handler narrows by construction.
export const DelegateOutputSchema = z
  .object({
    job_id: z.string().min(1),
    status: JobStatusSchema,
    workspace_id: z.string().min(1),
    queued_position: z.number().int().nonnegative(),
  })
  .strict();
export type DelegateOutput = z.infer<typeof DelegateOutputSchema>;

// ---------- poll_delegation ----------

export const PollInputSchema = z
  .object({
    job_id: z.string().min(1),
    wait_ms: z.number().int().min(0).max(60000).optional(),
  })
  .strict();
export type PollInput = z.infer<typeof PollInputSchema>;

export const PollOutputSchema = z
  .object({
    job_id: z.string().min(1),
    status: JobStatusSchema,
    queued_position: z.number().int().nonnegative().nullable(),
    report: DelegationReportSchema.nullable(),
    partial: PartialProgressSchema.nullable(),
  })
  .strict();
export type PollOutput = z.infer<typeof PollOutputSchema>;

// ---------- cancel_delegation ----------

export const CancelInputSchema = z
  .object({
    job_id: z.string().min(1),
  })
  .strict();
export type CancelInput = z.infer<typeof CancelInputSchema>;

export const CancelResultSchema = z.enum([
  "cancelled",
  "already_terminal",
  "not_found",
]);
export type CancelResult = z.infer<typeof CancelResultSchema>;

export const CancelOutputSchema = z
  .object({
    job_id: z.string().min(1),
    status: CancelResultSchema,
    prior_status: JobStatusSchema.nullable(),
  })
  .strict();
export type CancelOutput = z.infer<typeof CancelOutputSchema>;
