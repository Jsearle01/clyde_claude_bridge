// T-P2-009: `get_open_editors` MCP tool. Read-only; resolves a workspace
// identifier (or returns 400 ambiguous_workspace when multiple are
// registered and the caller omits the arg) then asks the workspace's
// extension to enumerate its open editor tabs.
//
// The tool does NOT invoke the approval gate — it bypasses the modal
// gate by traversing a code path that never imports or constructs
// awaitApprovalForDelegation. See C-13 grep #6 in the dispatch report.

import {
  GetOpenEditorsInputSchema,
  type GetOpenEditorsInput,
  type GetOpenEditorsOutput,
} from "@claude-bridge/shared";
import { type ToolDef } from "../dispatch.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import {
  ExtensionToolRouter,
  resolveInspectionWorkspace,
  enforceBoundWorkspace,
} from "./extension-router.js";

export interface GetOpenEditorsDeps {
  registry: WorkspaceRegistry;
  extensionRouter: ExtensionToolRouter;
}

export function makeGetOpenEditorsTool(
  deps: GetOpenEditorsDeps,
): ToolDef<GetOpenEditorsInput, GetOpenEditorsOutput> {
  return {
    name: "get_open_editors",
    description:
      "Return the list of currently-open editor tabs in the registered VS Code workspace, with active/dirty metadata. Read-only.",
    inputSchema: GetOpenEditorsInputSchema,
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
      const response = await deps.extensionRouter.send(
        identifier,
        "get_open_editors_response",
        (request_id) => ({
          kind: "get_open_editors_request",
          request_id,
        }),
      );
      return { editors: response.editors };
    },
  };
}
