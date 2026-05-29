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

// ----------------------------------------------------------------------
// T-P2-009: get_open_editors. Returns the list of open editor tabs in
// the registered workspace's VS Code window. Read-only; bypasses the
// approval gate (no delegate-path; the tool's call stack does not
// invoke gate.awaitApprovalForDelegation).
//
// `workspace` is optional: when the daemon has a single registered
// workspace it is implied; when multiple are registered the tool
// returns 400 ambiguous_workspace and the caller must supply one.

export const GetOpenEditorsInputSchema = z
  .object({
    workspace: z.string().min(1).optional(),
  })
  .strict();
export type GetOpenEditorsInput = z.infer<typeof GetOpenEditorsInputSchema>;

export interface GetOpenEditorsOutputEditor {
  uri: string;        // full URI: "file:///c:/projects/..."
  fs_path: string;    // OS-native path: "c:\\projects\\..."
  is_active: boolean;
  is_dirty: boolean;
}

export interface GetOpenEditorsOutput {
  editors: GetOpenEditorsOutputEditor[];
}

// ----------------------------------------------------------------------
// T-P2-010: get_diagnostics. Returns the LSP/extension diagnostics for
// the registered workspace, filtered by a severity threshold.
//
// `severity` semantics (boundary-only abstraction; expanded into an
// explicit `severities` set before IPC):
//   "error"   → only Error
//   "warning" → Error + Warning
//   "all"     → Error + Warning + Info + Hint  (default when omitted)

export const GetDiagnosticsInputSchema = z
  .object({
    workspace: z.string().min(1).optional(),
    severity: z.enum(["error", "warning", "all"]).optional(),
  })
  .strict();
export type GetDiagnosticsInput = z.infer<typeof GetDiagnosticsInputSchema>;

export type DiagnosticSeverityWire = "error" | "warning" | "info" | "hint";

export interface GetDiagnosticsOutputItem {
  uri: string;
  fs_path: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: DiagnosticSeverityWire;
  message: string;
  source?: string;
}

export interface GetDiagnosticsOutput {
  diagnostics: GetDiagnosticsOutputItem[];
}

// Threshold → explicit set expansion. Lives in shared so daemon-side
// tool and tests can both consume the canonical mapping.
export function expandSeverityThreshold(
  s: "error" | "warning" | "all",
): DiagnosticSeverityWire[] {
  switch (s) {
    case "error":
      return ["error"];
    case "warning":
      return ["error", "warning"];
    case "all":
      return ["error", "warning", "info", "hint"];
  }
}
