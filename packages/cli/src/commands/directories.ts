// `claude-bridge directories` — T-CLI-4c: print each daemon's config-dir absolute
// PATH (+ minimal identity + live/dead). The measure-twice companion to the
// destructive `delete-dir`: print the path → go look on disk (the workspaces.json
// / logs / transcripts) → confirm it's the dir you meant → `delete-dir`.
//
// A SEPARATE command from `list` on purpose: `list` is the busy "what's running /
// which is which" scan (name + workspace + live/dead + hash + mtime via the shared
// renderDaemonList); `directories` answers the distinct "WHERE on disk is this" and
// gets its own spare formatter — path + which-daemon + live/dead, nothing else.
//
// Shares CLI-4a's unified enumeration (the SAME source list + the selector use,
// orphans included); read-only — the handshake-for-liveness is the only daemon
// contact.

import {
  enumerateConfigDirs,
  type ConfigDirEntry,
  type EnumerateConfigDirsOpts,
} from "../util/config-dirs.js";

export type DirectoriesOpts = EnumerateConfigDirsOpts;

// The OWN spare formatter (deliberately NOT renderDaemonList — that's the dense
// one). One line per dir: identity (name, or hash when unnamed/orphan) + live/dead
// + the absolute path. No workspace, no mtime, no block.
export function formatDirectories(entries: readonly ConfigDirEntry[]): string {
  if (entries.length === 0) {
    return "No daemon config directories.\n";
  }
  const lines: string[] = [];
  for (const e of entries) {
    const id = e.name ?? e.hash; // orphan (no workspaces.json) → its hash
    const status = e.live ? "live" : "dead";
    lines.push(`${id}  [${status}]  ${e.configDir}`);
  }
  return lines.join("\n") + "\n";
}

export async function directoriesCommand(
  opts: DirectoriesOpts = {},
): Promise<void> {
  const entries = await enumerateConfigDirs(opts);
  process.stdout.write(formatDirectories(entries));
}
