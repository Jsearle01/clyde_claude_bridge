// MCP tool contracts. Input has a Zod schema — input arrives from external
// clients via the MCP transport, so it crosses a trust boundary (CC-6).
// Output is an interface — the daemon constructs it; the MCP SDK serializes;
// no parse boundary on the daemon side.

import { z } from "zod";

export const PingInputSchema = z
  .object({
    message: z.string().max(1024).optional(),
  })
  .strict();
export type PingInput = z.infer<typeof PingInputSchema>;

export interface PingOutput {
  echo: string | null;
  daemon_version: string;
  uptime_s: number;
  attached_workspaces: number;        // always 0 in P0
  tunnel_status: "up" | "degraded";   // "down" implies daemon not responding
  server_time: string;                // ISO 8601 UTC
}
