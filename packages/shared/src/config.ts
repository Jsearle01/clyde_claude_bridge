// Config contract for claude-bridge. Consumed by the daemon at startup.
// See docs/design/01-p0-bus.md §"Config file" for the file-format spec.
// `.strict()` makes typos in user config (e.g. "bnd_host") fail loud instead of
// silently falling back to defaults.

import { z } from "zod";

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    daemon: z.object({
      bind_host: z.string().default("127.0.0.1"),
      bind_port: z.number().int().min(1).max(65535).default(7423),
      ipc_socket: z.string(),
    }),
    auth: z.object({
      token: z.string().regex(/^cb_live_[A-Z2-7]{32}$/),
    }),
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
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
