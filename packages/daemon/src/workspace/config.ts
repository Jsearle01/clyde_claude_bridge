// Workspace-level config validation for P1 delegation. Performs four
// root-level checks on a `WorkspaceConfig` (Decision A, T-P1-002):
//
//   1. abs_path is absolute
//   2. abs_path exists on disk
//   3. abs_path resolves to a directory (not a regular file)
//   4. abs_path's realpath resolves (catches dangling symlink chains)
//
// Throws a descriptive Error on the first failing check. main.ts calls
// this at startup if `config.workspace` is present; failure refuses start
// in the same shape as P0's loose-permissions refusal.
//
// Symlinks-as-workspace-roots are LEGITIMATE. We do NOT canonicalize
// abs_path via realpath here — that happens only at Phase 4's resolveCwd
// time when validating `working_directory` against the workspace root for
// escape attempts. The realpath check below is liveness-only.
//
// P2 will layer per-workspace deny-list policy here (workspace .claude-bridge.json).
// P1 trusts user-configured paths at this layer.

import { statSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WorkspaceConfig } from "@claude-bridge/shared";

export class WorkspaceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConfigError";
  }
}

export function validateWorkspaceConfig(cfg: WorkspaceConfig): void {
  const p = cfg.abs_path;

  // 1. Absolute path
  if (!isAbsolute(p)) {
    throw new WorkspaceConfigError(
      `workspace.abs_path must be absolute; got ${JSON.stringify(p)}`,
    );
  }

  // 2 + 3. Exists on disk AND is a directory
  let stats;
  try {
    stats = statSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new WorkspaceConfigError(
        `workspace.abs_path does not exist: ${p}`,
      );
    }
    throw new WorkspaceConfigError(
      `workspace.abs_path stat failed (${code ?? "unknown"}): ${p}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceConfigError(
      `workspace.abs_path is not a directory: ${p}`,
    );
  }

  // 4. Realpath resolves (catches dangling-symlink chains where statSync
  // would still follow but the ultimate target is gone).
  try {
    realpathSync(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new WorkspaceConfigError(
      `workspace.abs_path realpath failed (${code ?? "unknown"}): ${p}`,
    );
  }
}
