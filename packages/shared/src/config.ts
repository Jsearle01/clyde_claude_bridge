// Config contract for claude-bridge. Consumed by the daemon at startup.
// See docs/design/01-p0-bus.md §"Config file" for the file-format spec.
// `.strict()` makes typos in user config (e.g. "bnd_host") fail loud instead of
// silently falling back to defaults.

import { z } from "zod";
import { WorkspaceConfigSchema } from "./workspace.js";
import { PartialProgressSchema } from "./jobs.js";
import {
  DelegationReportSchema,
  ErrorDetailSchema,
} from "./delegation.js";

// Acceptance-harness-only; remove at P2 close (once the StubJobRunner path
// is retired). Original marker said "remove at Phase 9" but Phase 9's reduced
// scope didn't touch this; T-P1-005's acceptance harness still relies on it
// for mechanical AC coverage and will keep relying through P1 close.
// Stub-runner behavior payload for the acceptance harness. Daemon honors
// this only when started with --allow-stub-config (defense against
// accidental presence in production configs).
export const StubBehaviorSchema = z
  .object({
    outcome: z.enum(["complete", "failed", "cancelled"]),
    delay_ms: z.number().int().nonnegative().optional(),
    partial_updates: z.array(PartialProgressSchema).optional(),
    report: DelegationReportSchema.partial().optional(),
    error: ErrorDetailSchema.optional(),
  })
  .strict();
export type StubBehavior = z.infer<typeof StubBehaviorSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    daemon: z.object({
      bind_host: z.string().default("127.0.0.1"),
      bind_port: z.number().int().min(1).max(65535).default(7423),
      ipc_socket: z.string(),
    }),
    // T-BEARER-1: the static Bearer auth path was removed (OAuth-bound is the
    // only model). `auth.token` is RETAINED as an inert/deprecated field —
    // nothing mints, reads, or shows it — purely so existing on-disk configs
    // (the strict schema + `version: 1` with no migration mechanism) still
    // validate and start. New configs omit it. Truly removing it needs a config
    // migration mechanism (future work).
    auth: z
      .object({
        token: z
          .string()
          .regex(/^cb_live_[A-Z2-7]{32}$/)
          .optional(),
      })
      .optional(),
    tunnel: z.object({
      provider: z.enum(["cloudflared", "ngrok"]).default("cloudflared"),
      binary: z.string().default("cloudflared"),
      args_extra: z.array(z.string()).default([]),
    }),
    audit: z.object({
      path: z.string(),
      retention_days: z.number().int().min(1).default(30),
    }),
    log: z.object({
      path: z.string(),
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    }),
    // P1 addition: optional workspace block. Absent block is the daemon's
    // P0-equivalent mode — `ping` works; `delegate_to_claude_code` returns
    // 503 no_workspace_configured (AC-12).
    workspace: WorkspaceConfigSchema.optional(),
    // Acceptance-harness-only; remove at P2 close (see StubBehaviorSchema
    // header note). Stub-runner behavior for the acceptance harness. Daemon
    // refuses to start with this present unless --allow-stub-config is set.
    stub_behavior: StubBehaviorSchema.optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
