// Workspace registry for P1 delegation. P1 ships a single-entry stub
// backed by `config.workspace`. The `WorkspaceRegistry` interface is the
// contract Phase 4's tool surface depends on; P2 will replace the stub
// implementation with an extension-backed multi-workspace registry
// without changing the interface or any caller.

import type { Workspace, WorkspaceConfig } from "@claude-bridge/shared";

export interface WorkspaceRegistry {
  /** Returns the workspace matching `id` if supplied, or the default
   * workspace if `id` is undefined. Returns null when no workspace is
   * configured, or when `id` is supplied but doesn't match. */
  resolve(id?: string): Workspace | null;
  /** All registered workspaces. P1: 0 or 1 entries. */
  list(): Workspace[];
  /** The default workspace, or null if none configured. */
  default(): Workspace | null;
}

export class StubWorkspaceRegistry implements WorkspaceRegistry {
  private readonly workspace: Workspace | null;

  constructor(workspaceConfig: WorkspaceConfig | undefined) {
    this.workspace = workspaceConfig
      ? {
          id: workspaceConfig.id,
          abs_path: workspaceConfig.abs_path,
          default_mode: workspaceConfig.default_mode,
        }
      : null;
  }

  resolve(id?: string): Workspace | null {
    if (this.workspace === null) return null;
    if (id !== undefined && id !== this.workspace.id) return null;
    return this.workspace;
  }

  list(): Workspace[] {
    return this.workspace !== null ? [this.workspace] : [];
  }

  default(): Workspace | null {
    return this.workspace;
  }
}
