// Workspace registry for P2 delegation (T-P2-007). Multi-workspace
// implementation backed by `workspaces.json` (the WorkspacesStore from
// T-P2-003). The P1 `StubWorkspaceRegistry` class is gone; the
// `WorkspaceRegistry` interface and `Workspace` shape are preserved
// verbatim so SdkJobRunner and delegate.ts continue working without
// modification.
//
// Semantics shifted in P2:
//   - resolve(undefined) returns null (P1 returned the default workspace).
//   - default() returns null always (P2 has no default workspace concept;
//     callers must supply an identifier).
//   - list() returns trusted workspaces from the persistent store, not
//     just currently-active ones. Trust persists across daemon restarts;
//     activeness (extension connection) is ephemeral.
//
// Connection state (which extension currently holds a path) lives on
// IpcServer's activeRegistry Map (keyed by abs_path). T-P2-007 takes a
// read-only getter for that Map at construction time per Decision 7,
// even though the public Workspace shape doesn't currently surface
// connection info — future accessors (P2-008+) may use it.

import type { Workspace } from "@claude-bridge/shared";
import type { WorkspacesStore } from "./store.js";
import type { ActiveRegistration } from "../ipc/server.js";

export interface WorkspaceRegistry {
  /** Returns the workspace matching `id`. P2: `id === undefined` returns
   * null (no default workspace); P2 callers should always supply an
   * identifier (the wire schema enforces this). */
  resolve(id?: string): Workspace | null;
  /** All trusted workspaces from the persistent store. */
  list(): Workspace[];
  /** Always null in P2 — no default workspace concept. */
  default(): Workspace | null;
}

const DEFAULT_MODE: "read_only" | "agentic" = "agentic";

export class WorkspaceRegistryImpl implements WorkspaceRegistry {
  constructor(
    private readonly store: WorkspacesStore,
    // T-P2-007 Decision 7: read-only getter for the IPC server's
    // activeRegistry. The Workspace return shape doesn't surface
    // connection info today, so this dependency is forward-looking
    // (P2-008+ may add active/offline distinctions). Held but not read
    // by resolve()/list() at this phase.
    private readonly getActiveRegistry: () => ReadonlyMap<string, ActiveRegistration>,
  ) {
    // Touch the field so TS doesn't flag it as unused under noUnused*
    // until the first reader lands at P2-008+.
    void this.getActiveRegistry;
  }

  resolve(id?: string): Workspace | null {
    if (id === undefined) return null;
    const entry = this.store.findByIdentifier(id);
    if (entry === null) return null;
    return {
      id: entry.identifier,
      abs_path: entry.abs_path,
      default_mode: DEFAULT_MODE,
    };
  }

  list(): Workspace[] {
    return this.store.list().map((entry) => ({
      id: entry.identifier,
      abs_path: entry.abs_path,
      default_mode: DEFAULT_MODE,
    }));
  }

  default(): Workspace | null {
    return null;
  }
}
