// CLI ↔ daemon IPC contracts. Schemas (not interfaces) because IPC traffic
// crosses a process boundary (CC-6): the daemon validates each incoming
// request and the CLI validates each incoming response.

import { z } from "zod";

export const StatusPayloadSchema = z
  .object({
    daemon_pid: z.number().int().nonnegative(),
    daemon_uptime_s: z.number().int().nonnegative(),
    endpoint: z.string(),                       // e.g. "127.0.0.1:7423"
    tunnel_status: z.enum(["up", "degraded", "down"]),
    tunnel_url: z.string().nullable(),
    token_suffix: z.string().length(4),         // last 4 chars only
    audit_path: z.string(),
    audit_size_bytes: z.number().int().nonnegative(),
    attached_workspaces: z.number().int().nonnegative(),  // always 0 in P0
  })
  .strict();
export type StatusPayload = z.infer<typeof StatusPayloadSchema>;

export const IpcRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
  z.object({ kind: z.literal("token_rotate") }).strict(),
  z.object({ kind: z.literal("tunnel_restart") }).strict(),
  z
    .object({
      kind: z.literal("hello"),
      version: z.string(),
      role: z.enum(["cli", "extension"]),
      pid: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_workspace"),
      abs_path: z.string(),
      name: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm_trust"),
      abs_path: z.string(),
      name: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deregister_workspace"),
      identifier: z.string(),
    })
    .strict(),
  // T-P2-008: per-workspace approval mode setter
  z
    .object({
      kind: z.literal("set_workspace_mode"),
      identifier: z.string(),
      mode: z.enum(["auto", "per_call", "session_bypass"]),
    })
    .strict(),
  // T-P2-008: extension's response to a daemon-initiated approval_request.
  // Carries no IpcResponse — daemon doesn't ack this one (asymmetric).
  z
    .object({
      kind: z.literal("approval_response"),
      delegation_id: z.string(),
      decision: z.enum(["approve", "deny", "approve_session"]),
    })
    .strict(),
  // T-P2-009 / T-P2-010: extension's responses to daemon-initiated
  // inspection-tool requests. Asymmetric (no daemon ack); request_id
  // correlates back to the pending entry in the daemon's extension
  // router. The third variant — extension_tool_error — is the catch-all
  // failure path (handler threw inside the extension); the daemon maps
  // it to 502 extension_error.
  z
    .object({
      kind: z.literal("get_open_editors_response"),
      request_id: z.string(),
      editors: z.array(
        z
          .object({
            uri: z.string(),
            fs_path: z.string(),
            is_active: z.boolean(),
            is_dirty: z.boolean(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("get_diagnostics_response"),
      request_id: z.string(),
      diagnostics: z.array(
        z
          .object({
            uri: z.string(),
            fs_path: z.string(),
            range: z
              .object({
                start: z
                  .object({
                    line: z.number().int().nonnegative(),
                    character: z.number().int().nonnegative(),
                  })
                  .strict(),
                end: z
                  .object({
                    line: z.number().int().nonnegative(),
                    character: z.number().int().nonnegative(),
                  })
                  .strict(),
              })
              .strict(),
            severity: z.enum(["error", "warning", "info", "hint"]),
            message: z.string(),
            source: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extension_tool_error"),
      request_id: z.string(),
      message: z.string(),
    })
    .strict(),
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type HelloRequest = Extract<IpcRequest, { kind: "hello" }>;
export type RegisterWorkspaceRequest = Extract<IpcRequest, { kind: "register_workspace" }>;
export type ConfirmTrustRequest = Extract<IpcRequest, { kind: "confirm_trust" }>;
export type DeregisterWorkspaceRequest = Extract<IpcRequest, { kind: "deregister_workspace" }>;
export type SetWorkspaceModeRequest = Extract<IpcRequest, { kind: "set_workspace_mode" }>;
export type ApprovalResponseRequest = Extract<IpcRequest, { kind: "approval_response" }>;
// T-P2-009 / T-P2-010: extension-initiated tool responses + the failure
// envelope. Daemon's extension router correlates by request_id.
export type GetOpenEditorsResponseMessage = Extract<
  IpcRequest,
  { kind: "get_open_editors_response" }
>;
export type GetDiagnosticsResponseMessage = Extract<
  IpcRequest,
  { kind: "get_diagnostics_response" }
>;
export type ExtensionToolErrorMessage = Extract<
  IpcRequest,
  { kind: "extension_tool_error" }
>;
// Item shapes (named for use in IpcServerMessage types and downstream
// consumers).
export type OpenEditor = GetOpenEditorsResponseMessage["editors"][number];
export type DiagnosticSeverityName = GetDiagnosticsResponseMessage["diagnostics"][number]["severity"];
export type DiagnosticItem = GetDiagnosticsResponseMessage["diagnostics"][number];

export const IpcResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("status_ok"),
      payload: StatusPayloadSchema,
    })
    .strict(),
  z.object({ kind: z.literal("stop_ok") }).strict(),
  z
    .object({
      kind: z.literal("token_rotate_ok"),
      new_token: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tunnel_restart_ok"),
      new_url: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hello_ok"),
      daemon_version: z.string(),
      min_supported: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_workspace_ok"),
      identifier: z.string(),
      name: z.string(),
      abs_path: z.string(),
      trusted_at: z.string(),
      was_already_trusted: z.boolean(),
      // T-P2-008: optional approval mode. Older daemons won't send it;
      // the extension defaults to "per_call" when absent.
      mode: z.enum(["auto", "per_call", "session_bypass"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_workspace_needs_trust"),
      abs_path: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("deregister_workspace_ok") }).strict(),
  // T-P2-008: ack for the set_workspace_mode IPC request
  z.object({ kind: z.literal("set_workspace_mode_ok") }).strict(),
  z
    .object({
      kind: z.literal("error"),
      message: z.string(),
      // Optional machine-readable reason. Added at T-P2-002 for the hello-
      // gate paths in daemon/src/ipc/server.ts. Existing callers that only
      // set `message` continue to work unchanged.
      //
      // Known reason values (informal vocabulary; promote to z.enum in P3+
      // if stabilized):
      //   "version_mismatch"        - hello-gate version check failed
      //   "protocol_error"          - protocol-level violation (e.g.,
      //                               non-hello first message before hello
      //                               completes; deregister of unknown id)
      //   "path_already_registered" - register_workspace against a path
      //                               held by another active extension
      //                               session (pid embedded in message)
      reason: z.string().optional(),
    })
    .strict(),
]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
export type HelloOkResponse = Extract<IpcResponse, { kind: "hello_ok" }>;
export type RegisterWorkspaceOkResponse = Extract<
  IpcResponse,
  { kind: "register_workspace_ok" }
>;
export type RegisterWorkspaceNeedsTrustResponse = Extract<
  IpcResponse,
  { kind: "register_workspace_needs_trust" }
>;
export type DeregisterWorkspaceOkResponse = Extract<
  IpcResponse,
  { kind: "deregister_workspace_ok" }
>;
export type ErrorResponse = Extract<IpcResponse, { kind: "error" }>;
export type SetWorkspaceModeOkResponse = Extract<
  IpcResponse,
  { kind: "set_workspace_mode_ok" }
>;

// T-P2-008: daemon-initiated messages. Distinct discriminated union from
// IpcRequest/IpcResponse because daemon→extension push has no
// request/response correlation — the daemon-side push wakes a pending
// approval-await, and the extension's eventual `approval_response` is an
// independent IpcRequest with the matching `delegation_id`.
//
// The extension's data-handler routing distinguishes IpcServerMessage from
// IpcResponse by attempting IpcServerMessageSchema parse first (smaller
// union); on parse failure, falls through to IpcResponse parsing. All
// schemas use `.strict()`, so the parse-or-fail discrimination is reliable.
export const IpcServerMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approval_request"),
      delegation_id: z.string(),
      identifier: z.string(),
      prompt: z.string(),
      mode_requested: z.enum(["read_only", "agentic"]),
      estimated_size: z
        .object({
          exhibits_count: z.number().int().nonnegative(),
          total_inline_bytes: z.number().int().nonnegative(),
        })
        .optional(),
      timestamp: z.string(),
    })
    .strict(),
  // T-P2-009: daemon-initiated request asking the extension to enumerate
  // its open editor tabs. Extension responds with
  // get_open_editors_response carrying the same request_id.
  z
    .object({
      kind: z.literal("get_open_editors_request"),
      request_id: z.string(),
    })
    .strict(),
  // T-P2-010: daemon-initiated request asking the extension for the
  // current diagnostics. The severities set is the explicit expansion of
  // the MCP-tool boundary's `severity` threshold (handled daemon-side);
  // extension never sees the abstraction.
  z
    .object({
      kind: z.literal("get_diagnostics_request"),
      request_id: z.string(),
      severities: z.array(z.enum(["error", "warning", "info", "hint"])),
    })
    .strict(),
]);
export type IpcServerMessage = z.infer<typeof IpcServerMessageSchema>;
export type ApprovalRequest = Extract<
  IpcServerMessage,
  { kind: "approval_request" }
>;
export type GetOpenEditorsRequest = Extract<
  IpcServerMessage,
  { kind: "get_open_editors_request" }
>;
export type GetDiagnosticsRequest = Extract<
  IpcServerMessage,
  { kind: "get_diagnostics_request" }
>;
