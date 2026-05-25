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
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type HelloRequest = Extract<IpcRequest, { kind: "hello" }>;
export type RegisterWorkspaceRequest = Extract<IpcRequest, { kind: "register_workspace" }>;
export type ConfirmTrustRequest = Extract<IpcRequest, { kind: "confirm_trust" }>;
export type DeregisterWorkspaceRequest = Extract<IpcRequest, { kind: "deregister_workspace" }>;

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
    })
    .strict(),
  z
    .object({
      kind: z.literal("register_workspace_needs_trust"),
      abs_path: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("deregister_workspace_ok") }).strict(),
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
