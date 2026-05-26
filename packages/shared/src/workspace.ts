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

// ----------------------------------------------------------------------
// P2 workspace store. Backs the daemon's `workspaces.json` file at
// `~/.claude-bridge/workspaces.json` (created at T-P2-003). Holds the
// persistent trust + identifier records keyed by abs_path. P2 only writes
// `trust_state: "trusted"` — denial doesn't write; revocation is P3+ which
// would add `"revoked"` to the enum.

export const WorkspaceTrustStateSchema = z.enum(["trusted"]);
export type WorkspaceTrustState = z.infer<typeof WorkspaceTrustStateSchema>;

// T-P2-008: per-workspace approval mode. Optional in the schema so older
// workspaces.json files load unchanged; reader logic in the daemon's
// WorkspacesStore defaults missing values to "per_call".
export const WorkspaceModeSchema = z.enum([
  "auto",
  "per_call",
  "session_bypass",
]);
export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;

export const WorkspaceEntrySchema = z
  .object({
    abs_path: z.string().min(1),
    identifier: z.string().min(1),
    name: z.string().min(1),
    trust_state: WorkspaceTrustStateSchema,
    trusted_at: z.string(),
    mode: WorkspaceModeSchema.optional(),
  })
  .strict();
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WorkspaceStoreSchema = z
  .object({
    version: z.literal("1"),
    entries: z.array(WorkspaceEntrySchema),
  })
  .strict();
export type WorkspaceStore = z.infer<typeof WorkspaceStoreSchema>;
