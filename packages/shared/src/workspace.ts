// Workspace contracts for P1 delegation. A Workspace identifies a local
// directory the daemon can drive Claude Code against. In P1 the registry
// is a single-entry stub backed by config; P2's VS Code extension replaces
// it with multi-workspace real-time tracking.
//
// ID format is intentionally NOT enforced in this schema (Decision A,
// T-P1-001 dispatch). The wire contract just requires a non-empty string;
// registry and generator code own the format invariants so internal
// representations can evolve without breaking the schema.

import { z } from "zod";

export interface Workspace {
  id: string;
  abs_path: string;
  default_mode: "read_only" | "agentic";
}

export const WorkspaceConfigSchema = z
  .object({
    id: z.string().min(1),
    abs_path: z.string().min(1),
    default_mode: z.enum(["read_only", "agentic"]).default("agentic"),
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
