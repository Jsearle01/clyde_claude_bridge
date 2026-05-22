// Ping tool — first registered tool. Roundtrip liveness probe per
// `01-p0-bus.md` §"The ping tool". Imports the canonical schema and
// types from `@claude-bridge/shared` rather than re-defining them
// (per `zod-schema-validation.md` rule 1: one schema per shape).

import {
  PingInputSchema,
  type PingInput,
  type PingOutput,
} from "@claude-bridge/shared";
import type { ToolDef } from "../dispatch.js";

export const pingTool: ToolDef<PingInput, PingOutput> = {
  name: "ping",
  description: "Roundtrip test. Returns daemon liveness info.",
  inputSchema: PingInputSchema,
  // Not `async` — the handler is synchronous in body, returning a resolved
  // Promise satisfies the ToolDef contract without firing require-await.
  handler(input, ctx) {
    const uptime_s = Math.floor((Date.now() - ctx.state.startedAt) / 1000);
    // Wire contract from 01-p0-bus.md is "up" | "degraded" (two values).
    // Internal DaemonState may also be "down"; collapse to "degraded" for
    // the wire since "down" is unobservable when the daemon is answering.
    const ts = ctx.state.tunnelStatus;
    const tunnel_status: "up" | "degraded" = ts === "up" ? "up" : "degraded";
    return Promise.resolve({
      echo: input.message ?? null,
      daemon_version: ctx.state.version,
      uptime_s,
      attached_workspaces: 0,
      tunnel_status,
      server_time: new Date().toISOString(),
    });
  },
};
