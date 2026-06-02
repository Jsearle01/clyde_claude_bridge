// `delegate_to_claude_code` tool handler. Resolves the workspace,
// validates working_directory (textual + realpath both strict per
// Decision 1, T-P1-004), enforces handler-level caps not in the schema
// (exhibits count ≤100, total inline content ≤256KB), enqueues, and
// tickles the runner.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve as pathResolve, sep as pathSep } from "node:path";
import {
  DelegateInputSchema,
  type DelegateInput,
  type DelegateOutput,
} from "@claude-bridge/shared";
import { ToolHandlerError, type ToolDef } from "../dispatch.js";
import { enforceBoundWorkspace } from "./extension-router.js";
import type { JobQueue } from "../../jobs/queue.js";
import type { JobRunner } from "../../jobs/runner.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import type { ApprovalGate } from "../../approval/gate.js";
import {
  awaitApprovalForDelegation,
  generateDelegationId,
  truncateForApproval,
} from "../../approval/gate.js";
import { ApprovalRejectedError } from "../../approval/pending.js";

const MAX_EXHIBITS = 100;
const MAX_INLINE_BYTES = 256 * 1024;
const APPROVAL_PROMPT_TRUNCATION = 500;
// No prompt size cap in P1; SDK and Anthropic API enforce real limits.
// Add a cap here if pathological input surfaces in practice. The 32KB
// figure in 02-p1-delegation.md validation rules was speculative
// architecture without empirical grounding; cap-removal noted as P1-close
// doc-debt against that design doc.

export interface DelegateDeps {
  registry: WorkspaceRegistry;
  queue: JobQueue;
  runner: JobRunner;
  approvalGate: ApprovalGate;
}

/** Strict cwd resolution per Decision 1, T-P1-004. Returns the resolved
 * absolute path inside the workspace, or throws ToolHandlerError(400, ...)
 * on any escape (absolute path, textual ../-escape, or realpath escape). */
export function resolveCwd(
  workspaceRoot: string,
  workingDirectory: string | null | undefined,
): string {
  if (workingDirectory === undefined || workingDirectory === null || workingDirectory === "") {
    return workspaceRoot;
  }
  if (isAbsolute(workingDirectory)) {
    throw new ToolHandlerError(
      400,
      "working_directory_absolute",
      `working_directory must be relative: ${workingDirectory}`,
    );
  }
  const resolved = pathResolve(workspaceRoot, workingDirectory);
  const root = pathResolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(root + pathSep)) {
    throw new ToolHandlerError(
      400,
      "working_directory_escapes_workspace",
      `working_directory resolves outside workspace: ${workingDirectory}`,
    );
  }
  // Realpath check: a symlink inside the workspace pointing outside is
  // still an escape. Best-effort — if realpath fails (e.g. the resolved
  // path doesn't exist yet because the delegation will create it), allow
  // textual check alone; the SDK will surface a real error if needed.
  try {
    const realResolved = realpathSync(resolved);
    const realRoot = realpathSync(root);
    if (
      realResolved !== realRoot &&
      !realResolved.startsWith(realRoot + pathSep)
    ) {
      throw new ToolHandlerError(
        400,
        "working_directory_escapes_workspace",
        `working_directory's realpath escapes workspace: ${workingDirectory}`,
      );
    }
  } catch (err) {
    if (err instanceof ToolHandlerError) throw err;
    // realpath failed (likely ENOENT for path not yet created); textual
    // check already passed; allow.
  }
  return resolved;
}

export function makeDelegateTool(
  deps: DelegateDeps,
): ToolDef<DelegateInput, DelegateOutput> {
  return {
    name: "delegate_to_claude_code",
    description:
      "Delegate a task to Claude Code running against a registered workspace. Returns a job id for polling.",
    inputSchema: DelegateInputSchema,
    async handler(input, ctx) {
      // T-P3-004a: constrain the target to the token's binding before
      // resolution. For a bound OAuth token, input.workspace must equal the
      // bound workspace (else 403 binding violation); for the legacy unbound
      // Bearer this is a no-op pass-through.
      const requested = enforceBoundWorkspace(
        ctx.workspaceBinding,
        input.workspace,
        ctx.logger,
      );
      // Workspace resolution (T-P2-007: strict rejection on unknown
      // identifier; the wire schema now requires the workspace field, so
      // input.workspace is always defined here).
      const workspace = deps.registry.resolve(requested);
      if (workspace === null) {
        throw new ToolHandlerError(
          503,
          "no_workspace_registered",
          `no workspace registered with identifier '${requested ?? input.workspace}'`,
        );
      }

      // Exhibits caps (not in schema)
      const exhibits = input.exhibits ?? [];
      if (exhibits.length > MAX_EXHIBITS) {
        throw new ToolHandlerError(
          400,
          "exhibits_count_exceeded",
          `exhibits count ${exhibits.length} exceeds cap ${MAX_EXHIBITS}`,
        );
      }
      let totalInlineBytes = 0;
      for (const e of exhibits) {
        if (e.content !== undefined) {
          totalInlineBytes += Buffer.byteLength(e.content, "utf8");
        }
      }
      if (totalInlineBytes > MAX_INLINE_BYTES) {
        throw new ToolHandlerError(
          400,
          "exhibits_inline_bytes_exceeded",
          `exhibits inline content ${totalInlineBytes}B exceeds cap ${MAX_INLINE_BYTES}B`,
        );
      }

      // Mode + cwd resolution
      const mode = input.mode ?? workspace.default_mode;
      const cwd = resolveCwd(workspace.abs_path, input.working_directory);

      // T-P2-008: approval gate. Inserts after all validation, before
      // enqueue. The gate decides whether to skip (auto mode), prompt
      // the user, or pass-through (session-bypassed). Decision flows back
      // into the gate; only "deny"/error short-circuits this handler.
      try {
        const decision = await awaitApprovalForDelegation(
          deps.approvalGate,
          ctx.mcp_session_id,
          workspace.id,
          {
            kind: "approval_request",
            delegation_id: generateDelegationId(),
            identifier: workspace.id,
            prompt: truncateForApproval(input.prompt, APPROVAL_PROMPT_TRUNCATION),
            mode_requested: mode,
            estimated_size: {
              exhibits_count: exhibits.length,
              total_inline_bytes: totalInlineBytes,
            },
            timestamp: new Date().toISOString(),
          },
        );
        if (decision === "deny") {
          throw new ToolHandlerError(
            403,
            "delegation_denied",
            "user denied the delegation",
          );
        }
        // "approve" or "approve_session" — proceed. (markSessionBypassed
        // for the latter is handled inside awaitApprovalForDelegation.)
      } catch (err) {
        if (err instanceof ToolHandlerError) throw err;
        if (err instanceof ApprovalRejectedError) {
          if (err.reason === "timeout") {
            throw new ToolHandlerError(
              408,
              "approval_timeout",
              "user did not approve within 5 minutes",
            );
          }
          if (err.reason === "shutdown") {
            throw new ToolHandlerError(
              503,
              "daemon_shutting_down",
              "daemon is shutting down; approval cancelled",
            );
          }
          if (err.reason === "extension_reconnected") {
            throw new ToolHandlerError(
              408,
              "approval_extension_reconnected",
              "extension reconnected mid-approval; please retry",
            );
          }
          if (err.reason === "workspace_deregistered") {
            throw new ToolHandlerError(
              503,
              "workspace_no_longer_registered",
              "workspace deregistered mid-approval",
            );
          }
        }
        throw err;
      }

      // Enqueue
      const { job, queued_position } = deps.queue.enqueue({
        workspace_id: workspace.id,
        prompt: input.prompt,
        exhibits,
        mode,
        model: input.model ?? null,
        max_turns: input.max_turns ?? 30,
        working_directory: cwd === workspace.abs_path ? null : cwd,
      });

      // Audit metadata side-channel (optional-chained: invoke() always
      // wraps a real setAuditMetadata in, but the interface is optional
      // so older ctx-construction sites stay compatible).
      ctx.setAuditMetadata?.({
        job_id: job.id,
        workspace_id: workspace.id,
      });

      // Kick the runner
      deps.runner.tickle();

      return {
        job_id: job.id,
        status: job.status,
        workspace_id: workspace.id,
        queued_position,
      };
    },
  };
}
