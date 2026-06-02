// T-P2-009 / T-P2-010: shared extension-routing abstraction for the
// inspection-tool family (get_open_editors, get_diagnostics, and any
// future read-only daemon→extension round-trip).
//
// Each call:
//   1. Generates a fresh request_id.
//   2. Registers a pending entry with a timeout timer.
//   3. Calls `sendToExtension(identifier, request)` — typically wired to
//      IpcServer.sendServerMessage.
//   4. Awaits either the matching response (resolveResponse) or the
//      timer / cancel signal.
//
// Failure mapping (matches the spec's discriminated 503/504/502 codes):
//   - send throws / no active connection         → ToolHandlerError(503, "extension_offline")
//   - timeout elapsed before response            → ToolHandlerError(504, "extension_timeout")
//   - extension responded with extension_tool_error → ToolHandlerError(502, "extension_error")
//
// The IPC server resolves incoming response messages by request_id via
// resolveResponse(); resolveError() handles the extension_tool_error
// envelope. Both are idempotent — a late response for a timed-out
// request is dropped silently.

import { randomBytes } from "node:crypto";
import type {
  GetOpenEditorsRequest,
  GetDiagnosticsRequest,
  GetOpenEditorsResponseMessage,
  GetDiagnosticsResponseMessage,
} from "@claude-bridge/shared";
import { ToolHandlerError } from "../dispatch.js";
import type { WorkspaceBinding } from "../auth.js";
import type { Logger } from "../../log/logger.js";

// The extension router only sends inspection-tool requests today; if the
// surface grows past these two, the union widens here.
export type ExtensionToolRequest =
  | GetOpenEditorsRequest
  | GetDiagnosticsRequest;

export type ExtensionToolResponse =
  | GetOpenEditorsResponseMessage
  | GetDiagnosticsResponseMessage;

// Kind-indexed lookup so callers receive the specific variant matching
// the expectedKind they passed in. Without this, TS would only know the
// union and downstream `.editors` / `.diagnostics` access would fail
// the discriminator check.
export type ExtensionToolResponseByKind<
  K extends ExtensionToolResponse["kind"],
> = Extract<ExtensionToolResponse, { kind: K }>;

export const EXTENSION_TOOL_TIMEOUT_MS = 5000;

export type SendToExtension = (
  identifier: string,
  request: ExtensionToolRequest,
) => Promise<void>;

interface PendingEntry {
  resolve: (response: ExtensionToolResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function generateRequestId(): string {
  return "etr_" + randomBytes(6).toString("hex");
}

export class ExtensionToolRouter {
  private readonly pending = new Map<string, PendingEntry>();
  private closed = false;

  constructor(
    private readonly sendToExtension: SendToExtension,
    private readonly timeoutMs: number = EXTENSION_TOOL_TIMEOUT_MS,
  ) {}

  // Send an inspection request to the extension owning `identifier` and
  // await its response. `requestBuilder` receives the freshly-generated
  // request_id and returns the fully-formed request shape; the caller
  // doesn't see request_id directly because correlation is internal.
  async send<K extends ExtensionToolResponse["kind"]>(
    identifier: string,
    expectedKind: K,
    requestBuilder: (request_id: string) => ExtensionToolRequest,
  ): Promise<ExtensionToolResponseByKind<K>> {
    if (this.closed) {
      throw new ToolHandlerError(
        503,
        "extension_offline",
        "extension router is shutting down",
      );
    }
    const request_id = generateRequestId();
    const request = requestBuilder(request_id);
    const responsePromise = new Promise<ExtensionToolResponse>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          // Timer-fired path: drop the entry and reject. If a response
          // arrives later, resolveResponse will look it up, find nothing,
          // and silently no-op.
          this.pending.delete(request_id);
          reject(
            new ToolHandlerError(
              504,
              "extension_timeout",
              `extension did not respond within ${this.timeoutMs}ms`,
            ),
          );
        }, this.timeoutMs);
        // unref() so a stuck pending entry doesn't block daemon shutdown
        // by holding the event loop open.
        timer.unref?.();
        this.pending.set(request_id, {
          resolve,
          reject,
          timer,
        });
      },
    );
    try {
      await this.sendToExtension(identifier, request);
    } catch (err) {
      // Failed to deliver the request — clear the pending entry and map
      // to 503. The send failure modes are: no active connection, socket
      // write error, or no extension registered for the identifier.
      const entry = this.pending.get(request_id);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(request_id);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ToolHandlerError(
        503,
        "extension_offline",
        `extension is not reachable: ${message}`,
      );
    }
    const response = await responsePromise;
    // Sanity check: the IpcServer routes by kind already (only matching
    // response kinds reach resolveResponse), but a stray same-kind
    // response for the wrong request_id would have failed to find a
    // pending entry. The expectedKind check here is defensive against
    // future widening of the response union.
    if (response.kind !== expectedKind) {
      throw new ToolHandlerError(
        502,
        "extension_error",
        `extension returned unexpected response kind: ${response.kind}`,
      );
    }
    return response as ExtensionToolResponseByKind<K>;
  }

  // Called by IpcServer when an inspection response arrives over IPC.
  // Late responses (entry already timed out and deleted) are dropped.
  resolveResponse(response: ExtensionToolResponse): void {
    const entry = this.pending.get(response.request_id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(response.request_id);
    entry.resolve(response);
  }

  // Called by IpcServer when an extension_tool_error envelope arrives.
  // The extension threw inside its handler (e.g., VS Code API error);
  // surface as 502 to the MCP caller.
  resolveError(request_id: string, message: string): void {
    const entry = this.pending.get(request_id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(request_id);
    entry.reject(
      new ToolHandlerError(
        502,
        "extension_error",
        `extension handler failed: ${message}`,
      ),
    );
  }

  // Called by IpcServer when an extension connection drops. All pending
  // calls awaiting that identifier should fail fast rather than waiting
  // for the timeout. We don't track identifier per-entry today (one
  // workspace per daemon is the common case); a more granular hook can
  // land if multi-workspace racing demands it.
  cancelAll(reason: string): void {
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.reject(
        new ToolHandlerError(503, "extension_offline", reason),
      );
    }
  }

  // Test seam — counts in-flight requests.
  pendingSize(): number {
    return this.pending.size;
  }

  stop(): void {
    this.closed = true;
    this.cancelAll("daemon shutting down");
  }
}

// Workspace resolution shared by both inspection tools. Returns the
// workspace identifier (the `id` field on the Workspace shape). Throws
// ToolHandlerError on ambiguity / not-found.
export interface WorkspaceListReader {
  list(): Array<{ id: string }>;
  resolve(id?: string): { id: string } | null;
}

/**
 * T-P3-004a: the auth-layer isolation guarantee. Constrains a tool call's
 * target workspace to the authenticated token's binding BEFORE registry
 * resolution. This is the load-bearing enforcement point — every
 * workspace-targeting tool routes its requested workspace through here.
 *
 *  - unconstrained (legacy global Bearer) / no binding → pass `requested`
 *    through unchanged (pre-P3 behavior).
 *  - bound to workspace W → the call may target only W: a `requested` that
 *    differs is a binding violation (403, logged + surfaced); an omitted
 *    `requested` resolves to W (the binding implies it — no ambiguity).
 *  - bound to null (a non-binding approve, T-P3-002R) → acts on nothing;
 *    every workspace-targeting tool is rejected.
 *
 * Returns the workspace identifier the call is permitted to target (or
 * `requested` unchanged when unconstrained). Throws ToolHandlerError(403)
 * on a binding violation.
 */
export function enforceBoundWorkspace(
  binding: WorkspaceBinding | undefined,
  requested: string | undefined,
  logger?: Logger,
): string | undefined {
  if (binding === undefined || binding.kind === "unconstrained") {
    return requested;
  }
  // Bound OAuth token.
  if (binding.workspace === null) {
    logger?.warn(
      "auth: binding violation — bound token has no workspace; rejecting workspace-targeting tool",
      { requested: requested ?? null },
    );
    throw new ToolHandlerError(
      403,
      "workspace_not_bound",
      "this token is not bound to any workspace and may not act on a workspace",
    );
  }
  if (requested !== undefined && requested !== binding.workspace) {
    logger?.warn(
      "auth: binding violation — token attempted cross-workspace access",
      { bound_workspace: binding.workspace, requested },
    );
    throw new ToolHandlerError(
      403,
      "workspace_not_bound",
      `this token is bound to workspace '${binding.workspace}' and may not act on '${requested}'`,
    );
  }
  return binding.workspace;
}

export function resolveInspectionWorkspace(
  registry: WorkspaceListReader,
  requested: string | undefined,
): string {
  if (requested !== undefined) {
    const resolved = registry.resolve(requested);
    if (resolved === null) {
      throw new ToolHandlerError(
        404,
        "workspace_not_found",
        `no workspace registered with identifier '${requested}'`,
      );
    }
    return resolved.id;
  }
  const all = registry.list();
  if (all.length === 0) {
    throw new ToolHandlerError(
      503,
      "no_workspace_registered",
      "no workspaces are registered with the daemon",
    );
  }
  if (all.length > 1) {
    throw new ToolHandlerError(
      400,
      "ambiguous_workspace",
      `multiple workspaces registered (${all.length}); pass 'workspace' explicitly`,
    );
  }
  const only = all[0];
  // Defensive — length === 1 guarantees only !== undefined at runtime.
  if (only === undefined) {
    throw new ToolHandlerError(
      503,
      "no_workspace_registered",
      "workspace list reported one entry but resolved to undefined",
    );
  }
  return only.id;
}
