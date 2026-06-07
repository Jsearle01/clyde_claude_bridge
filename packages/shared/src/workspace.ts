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

// ----------------------------------------------------------------------
// P3′-2a daemon advert. The per-daemon "I'm here" beacon written to the
// TOP-LEVEL shared dir `<root>/daemons/<hash>.json`, where <hash> is the
// identity-hash (1b). 2b's extension discovery scans that dir to find the
// daemon serving its workspace and connect to `pipe`.
//
// Schema is LOCAL-PAIRING fields only (ADR-002): NO tunnel URL — a rotating
// URL is noise; that decision defers to the stable-tunnel work. `.strict()`
// so a future field addition is a deliberate, validated change.
export const DaemonAdvertSchema = z
  .object({
    // The case-folded canonical identity (1a/1b key) — 2b's match key: the
    // extension canonicalizes+case-folds its workspaceFolders[0].uri.fsPath and
    // compares to this.
    canonical_workspace: z.string().min(1),
    name: z.string().min(1), // operator --name label
    pipe: z.string().min(1), // the IPC address 2b connects to
    port: z.number().int().min(1).max(65535), // TCP bind port (status/diagnostics)
    pid: z.number().int().nonnegative(),
    started_at: z.string(), // ISO-8601
  })
  .strict();
export type DaemonAdvert = z.infer<typeof DaemonAdvertSchema>;
