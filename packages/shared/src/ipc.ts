// CLI ↔ daemon IPC contracts. Schemas (not interfaces) because IPC traffic
// crosses a process boundary (CC-6): the daemon validates each incoming
// request and the CLI validates each incoming response.

import { z } from "zod";

// CB-DAEMON-LIFECYCLE-FIX: one connected (registered) extension session, as
// surfaced by `claude-bridge status`. Mirrors the daemon's activeRegistry
// entries so an operator can see WHICH window (pid + workspace) is bound to
// THIS daemon — the diagnostic lens for the doubled-daemon split.
export const ConnectedExtensionSchema = z
  .object({
    identifier: z.string(),
    pid: z.number().int().nonnegative(),
    abs_path: z.string(),
  })
  .strict();
export type ConnectedExtension = z.infer<typeof ConnectedExtensionSchema>;

// CB-SMOKE-READINESS-BATCH: one active OAuth binding, as surfaced by
// `claude-bridge status` and resolved by `claude-bridge unbind`. Sourced from
// the durable token store (tokens.json) — distinct from the daemon Bearer
// token. `bound_workspace` is null for a non-binding approve (acts on nothing).
export const OAuthBindingSummarySchema = z
  .object({
    client_id: z.string(),
    bound_workspace: z.string().nullable(),
    issued_at: z.string(),
    expires_at: z.number().int(),
  })
  .strict();
export type OAuthBindingSummary = z.infer<typeof OAuthBindingSummarySchema>;

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
    // CB-DAEMON-LIFECYCLE-FIX: count of active registered extension sessions
    // (was hardcoded 0; now activeRegistry.size).
    attached_workspaces: z.number().int().nonnegative(),
    // CB-DAEMON-LIFECYCLE-FIX: the active registered sessions themselves.
    // Optional for wire compat (a pre-fix daemon won't send it; the CLI
    // degrades to "unknown"), matching the `mode`-optional precedent below.
    connected_extensions: z.array(ConnectedExtensionSchema).optional(),
    // CB-SMOKE-READINESS-BATCH: the active OAuth bindings from tokens.json, so
    // a real bind is VISIBLE in `status` (it wasn't). Optional for wire compat
    // (a pre-fix daemon won't send it; the CLI prints "not reported"). Distinct
    // from `token_suffix` (the daemon Bearer token, not an OAuth binding).
    oauth_bindings: z.array(OAuthBindingSummarySchema).optional(),
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
  // T-P3-004b: extension asks the daemon to UNBIND this workspace (tear
  // down its OAuth binding/token). Response-expected (mirrors
  // set_workspace_mode) — the daemon replies unbind_workspace_ok.
  z
    .object({
      kind: z.literal("unbind_workspace"),
      identifier: z.string(),
    })
    .strict(),
  // CB-SMOKE-READINESS-BATCH: CLI-initiated unbind. Unlike unbind_workspace
  // (extension-only, socket-scoped to the window that HOLDS the registration),
  // this is the operator's `claude-bridge unbind` path — it resolves a target
  // (a bound_workspace identifier or a client_id / client_id prefix) against
  // the durable token store and tears down the matching binding(s) via the
  // same 004b revoke capability. `all: true` clears every binding; `target` is
  // the explicit single-binding selector. The no-args footgun (clear-all by
  // omission) is refused CLI-side before this is ever sent.
  z
    .object({
      kind: z.literal("unbind_binding"),
      target: z.string().nullable(),
      all: z.boolean(),
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
  // T-P3-002: extension acknowledges receipt of an auth_consent_request.
  // Asymmetric (no daemon ack). Daemon's 3s ack window closes either on
  // arrival or on timeout. Used to distinguish "extension is offline" from
  // "user is taking time to decide" — the former returns an offline page
  // BEFORE the consent record is created (guardrail order); the latter
  // shows the pending meta-refresh page.
  z
    .object({
      kind: z.literal("auth_consent_ack"),
      request_id: z.string(),
    })
    .strict(),
  // T-P3-002: extension reports the user's consent decision. Asymmetric.
  // Late arrivals (after the 30s decision timeout fired) are silently
  // discarded by the daemon (daemon-authoritative race resolution per
  // design §3.4).
  z
    .object({
      kind: z.literal("auth_consent_response"),
      request_id: z.string(),
      decision: z.enum(["approve", "deny", "dismiss"]),
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
      // CB-DAEMON-LIFECYCLE-FIX: the daemon's own pid, so the extension can
      // display "connected to daemon pid N" and a doubled-daemon split is
      // visible from the VS Code side. Optional for wire compat (a pre-fix
      // daemon won't send it; the extension shows pid unknown).
      daemon_pid: z.number().int().nonnegative().optional(),
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
  // T-P3-004b: ack for unbind_workspace. `revoked_count` = tokens torn down.
  z
    .object({
      kind: z.literal("unbind_workspace_ok"),
      revoked_count: z.number().int(),
    })
    .strict(),
  // CB-SMOKE-READINESS-BATCH: ack for unbind_binding (CLI). `unbound` lists
  // each binding torn down (empty = the target matched nothing → the CLI
  // prints "no such binding").
  z
    .object({
      kind: z.literal("unbind_binding_ok"),
      unbound: z.array(
        z
          .object({
            client_id: z.string(),
            bound_workspace: z.string().nullable(),
            tokens_revoked: z.number().int(),
          })
          .strict(),
      ),
    })
    .strict(),
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
  // T-P3-002: daemon asks the extension to surface the OAuth consent
  // modal. `client_id` + `client_name` are shown in the modal copy;
  // `redirect_uri` is the registered destination the auth code will be
  // bound to. Extension responds with auth_consent_ack within 3s and
  // auth_consent_response within 30s of ack.
  z
    .object({
      kind: z.literal("auth_consent_request"),
      request_id: z.string(),
      client_id: z.string(),
      client_name: z.string(),
      redirect_uri: z.string(),
    })
    .strict(),
  // T-P3-002: daemon notifies the extension that the 30s decision timer
  // fired (best-effort modal-close signal). The state machine has already
  // transitioned to "timeout" daemon-side; the extension closes its modal.
  z
    .object({
      kind: z.literal("auth_consent_timeout"),
      request_id: z.string(),
    })
    .strict(),
  // T-P3-002R: daemon notifies the extensions that a consent resolved by
  // approve OR deny (a window answered). Best-effort dismiss-siblings
  // signal so stale broadcast modals close immediately rather than
  // hanging (the recon-#2 zombie-modal gap — the 30s timer is cleared on
  // first resolution, so the timeout close-path never fires on approve/
  // deny). Broadcast to all active connections; dismissal is keyed by
  // request_id and idempotent, so the responder receiving its own
  // resolved signal is a harmless no-op. Distinct from
  // auth_consent_timeout: timeout = "nobody answered in time"; resolved =
  // "a decision was recorded". Extension-side handling lands in T-P3-003.
  z
    .object({
      kind: z.literal("auth_consent_resolved"),
      request_id: z.string(),
    })
    .strict(),
  // T-P3-003: daemon tells the WINNING window (the one whose workspace the
  // grant bound to) that a binding was established, so its status bar can
  // surface it. Targeted (sent only to the bound workspace's connection
  // via sendServerMessage) — only the bound window should display the
  // binding. Distinct from auth_consent_resolved (broadcast, dismiss-only):
  // under the broadcast race only the daemon knows which window won, so the
  // bound window cannot self-determine its binding — the daemon must tell
  // it. `client_id`/`client_name` name the bound claude.ai client for
  // display; `bound_workspace` is the workspace identifier it bound to.
  z
    .object({
      kind: z.literal("binding_established"),
      client_id: z.string(),
      client_name: z.string(),
      bound_workspace: z.string(),
    })
    .strict(),
  // T-P3-004b: inverse of binding_established — the daemon tells the
  // (formerly) bound window its binding was torn down (unbind/revoke), so
  // the extension clears currentBinding + refreshes the status bar. Targeted
  // to the bound workspace's connection (mirror sendServerMessage).
  z
    .object({
      kind: z.literal("binding_cleared"),
      bound_workspace: z.string(),
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
// T-P3-003: extension-side consent flow message types.
export type AuthConsentRequest = Extract<
  IpcServerMessage,
  { kind: "auth_consent_request" }
>;
export type AuthConsentTimeout = Extract<
  IpcServerMessage,
  { kind: "auth_consent_timeout" }
>;
export type AuthConsentResolved = Extract<
  IpcServerMessage,
  { kind: "auth_consent_resolved" }
>;
export type BindingEstablished = Extract<
  IpcServerMessage,
  { kind: "binding_established" }
>;
export type BindingCleared = Extract<
  IpcServerMessage,
  { kind: "binding_cleared" }
>;
