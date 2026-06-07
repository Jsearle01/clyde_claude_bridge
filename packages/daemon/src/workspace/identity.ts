// Daemon canonical identity (P3′ Phase 1a).
//
// The identity is the value everything downstream keys on: 1b derives
// config-dir/port/pipe from it, 2a advertises it, 2b matches the extension's
// workspace against it. Because the operator types `--workspace` independently
// of how VS Code reports the same folder, and Windows is case-insensitive
// (`c:\projects\x` and `c:\Projects\x` are the same folder), the T-P3′-0
// verdict made it a HARD CONTRACT that matching is on the CASE-FOLDED key.
//
// Composition (the load-bearing decision, recorded here and in the recon note):
//   display_path = canonicalizeWorkspacePath(input, platform)   // case-PRESERVING
//   identity     = normalizeAbsPath(display_path, platform)      // case-FOLDED key
// i.e. identity = normalizeAbsPath(canonicalizeWorkspacePath(input)).
//
// The DISPLAY label (logs, human-facing) uses the case-preserving form; the
// IDENTITY/key (derivation + matching) uses the case-folded one. Both arms
// take `platform` injected (defaulting to the host) so the identity-stability
// table runs deterministically on any CI host.

import { canonicalizeWorkspacePath, normalizeAbsPath } from "@claude-bridge/shared";

export interface DaemonIdentity {
  /** Case-folded canonical key — the value 1b/2a/2b key on. */
  identity: string;
  /** Case-preserving canonical path — the human-readable display form. */
  display_path: string;
  /** Operator-supplied display label (`--name`). */
  name: string;
}

export function computeDaemonIdentity(
  workspaceInput: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): DaemonIdentity {
  // canonicalizeWorkspacePath's platform arg is the 'win32'|'posix' literal;
  // everything non-win32 takes the posix branch.
  const canonPlatform = platform === "win32" ? "win32" : "posix";
  const display_path = canonicalizeWorkspacePath(workspaceInput, canonPlatform);
  const identity = normalizeAbsPath(display_path, platform);
  return { identity, display_path, name };
}
