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
]);
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

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
      kind: z.literal("error"),
      message: z.string(),
    })
    .strict(),
]);
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
