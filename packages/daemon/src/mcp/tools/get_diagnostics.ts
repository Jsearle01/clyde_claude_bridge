// T-P2-010: `get_diagnostics` MCP tool. Read-only; resolves a workspace
// identifier (or returns 400 ambiguous_workspace when multiple are
// registered and the caller omits the arg) then asks the workspace's
// extension for the current LSP/extension diagnostics, filtered by a
// severity threshold.
//
// Severity threshold ("error" | "warning" | "all") is expanded into an
// explicit set at this boundary — the extension only sees the set.
//
// The tool does NOT invoke the approval gate (C-13 grep #6).

import {
  GetDiagnosticsInputSchema,
  type GetDiagnosticsInput,
  type GetDiagnosticsOutput,
  expandSeverityThreshold,
} from "@claude-bridge/shared";
import { type ToolDef } from "../dispatch.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import {
  ExtensionToolRouter,
  resolveInspectionWorkspace,
  enforceBoundWorkspace,
} from "./extension-router.js";

export interface GetDiagnosticsDeps {
  registry: WorkspaceRegistry;
  extensionRouter: ExtensionToolRouter;
}

export function makeGetDiagnosticsTool(
  deps: GetDiagnosticsDeps,
): ToolDef<GetDiagnosticsInput, GetDiagnosticsOutput> {
  return {
    name: "get_diagnostics",
    description:
      "Return LSP/extension diagnostics for the registered VS Code workspace, filtered by severity threshold. Read-only.",
    inputSchema: GetDiagnosticsInputSchema,
    async handler(input, ctx) {
      // T-P3-004a: constrain the target to the token's binding before
      // registry resolution (no-op for the legacy unbound Bearer).
      const requested = enforceBoundWorkspace(
        ctx.workspaceBinding,
        input.workspace,
        ctx.logger,
      );
      const identifier = resolveInspectionWorkspace(deps.registry, requested);
      ctx.setAuditMetadata?.({ workspace_id: identifier });
      const threshold = input.severity ?? "all";
      const severities = expandSeverityThreshold(threshold);
      const response = await deps.extensionRouter.send(
        identifier,
        "get_diagnostics_response",
        (request_id) => ({
          kind: "get_diagnostics_request",
          request_id,
          severities,
        }),
      );
      return { diagnostics: response.diagnostics };
    },
  };
}
