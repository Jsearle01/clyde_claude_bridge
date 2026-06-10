// `claude-bridge list` — T-CLI-2: read-only inventory of the per-daemon
// config-dir layer (the durable state that doesn't self-heal). Shows, per
// config-dir: the workspace + name it belongs to (recognise by workspace, not by
// decoding a hash), the hash/dir, and LIVE/DEAD via a real handshake (not file
// presence). Pure read — no start, no connect-and-act. "Am I running what I
// think I'm running?"

import {
  enumerateConfigDirs,
  type ConfigDirEntry,
  type EnumerateConfigDirsOpts,
} from "../util/config-dirs.js";

export type ListOpts = EnumerateConfigDirsOpts;

export function formatConfigDirList(entries: ConfigDirEntry[]): string {
  if (entries.length === 0) {
    return "No daemon config directories.\n";
  }
  const lines: string[] = [];
  for (const e of entries) {
    const name = e.name ?? "(unnamed)";
    const ws = e.workspace ?? "(unknown workspace)";
    const status = e.live ? "live" : "dead";
    lines.push(`${name}  [${status}]  ${ws}`);
    lines.push(`    hash ${e.hash}  ·  ${e.configDir}`);
  }
  return lines.join("\n") + "\n";
}

export async function listCommand(opts: ListOpts = {}): Promise<void> {
  const entries = await enumerateConfigDirs(opts);
  process.stdout.write(formatConfigDirList(entries));
}
