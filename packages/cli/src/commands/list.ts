// `claude-bridge list` — T-CLI-2: read-only inventory of the per-daemon
// config-dir layer (the durable state that doesn't self-heal). Shows, per
// config-dir: the workspace + name it belongs to (recognise by workspace, not by
// decoding a hash), the hash/dir, and LIVE/DEAD via a real handshake (not file
// presence). Pure read — no start, no connect-and-act. "Am I running what I
// think I'm running?"

import {
  enumerateConfigDirs,
  renderDaemonList,
  type ConfigDirEntry,
  type EnumerateConfigDirsOpts,
} from "../util/config-dirs.js";

export type ListOpts = EnumerateConfigDirsOpts;

// T-CLI-4a: route through the single shared renderDaemonList (was an ad-hoc
// formatter). Empty-case message stays here.
export function formatConfigDirList(entries: ConfigDirEntry[]): string {
  if (entries.length === 0) {
    return "No daemon config directories.\n";
  }
  return renderDaemonList(entries);
}

export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const entries = await enumerateConfigDirs(opts);
  process.stdout.write(formatConfigDirList(entries));
}
