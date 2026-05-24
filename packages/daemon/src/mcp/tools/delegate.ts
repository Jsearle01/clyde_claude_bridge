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
import type { JobQueue } from "../../jobs/queue.js";
import type { JobRunner } from "../../jobs/runner.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";

const MAX_EXHIBITS = 100;
const MAX_INLINE_BYTES = 256 * 1024;
// No prompt size cap in P1; SDK and Anthropic API enforce real limits.
// Add a cap here if pathological input surfaces in practice. The 32KB
// figure in 02-p1-delegation.md validation rules was speculative
// architecture without empirical grounding; cap-removal noted as P1-close
// doc-debt against that design doc.

export interface DelegateDeps {
  registry: WorkspaceRegistry;
  queue: JobQueue;
  runner: JobRunner;
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
    // async so synchronous throws (ToolHandlerError) become rejected
    // promises — vitest's expect(...).rejects requires a Promise.
    // eslint-disable-next-line @typescript-eslint/require-await
    async handler(input, ctx) {
      // Workspace resolution
      const workspace = deps.registry.resolve(input.workspace);
      if (workspace === null) {
        if (deps.registry.list().length === 0) {
          throw new ToolHandlerError(
            503,
            "no_workspace_configured",
            "no workspace configured in config.json",
          );
        }
        throw new ToolHandlerError(
          404,
          "workspace_not_found",
          `workspace not found: ${String(input.workspace)}`,
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
