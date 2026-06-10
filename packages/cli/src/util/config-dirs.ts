// T-CLI-2: enumerate the per-daemon CONFIG-DIR layer — the durable state that
// does NOT self-heal (adverts self-clean via daemon sweeps; config-dirs +
// bindings persist by design and accumulate forever). This is what `list` shows
// and `delete-dir` prunes — distinct from `enumerateAdverts` (the live-advert
// scan), which would MISS a dead daemon's persisting config-dir.
//
// For each config-dir (`<getCliConfigDir()>/<16-hex hash>/`):
//   - hash + dir       — the config-dir itself.
//   - workspace + name — read from the per-dir workspaces.json (the trust store,
//                        which persists even when the daemon is dead; config.json
//                        carries no identity). null if unreadable.
//   - live             — a real HANDSHAKE to the daemon's pipe (not file/pid
//                        presence — a list showing a dead daemon as live is the
//                        stale trap this layer exists to avoid).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCliConfigDir, ipcAddressForHash } from "./paths.js";
import { sendIpc } from "../ipc-client.js";

const HASH_RE = /^[0-9a-f]{16}$/;
const PROBE_TIMEOUT_MS = 3000;

export interface ConfigDirEntry {
  hash: string;
  configDir: string;
  workspace: string | null;
  name: string | null;
  live: boolean;
}

export interface EnumerateConfigDirsOpts {
  /** Test-only: the config root to scan (defaults to getCliConfigDir()). */
  configRoot?: string;
  /** Test-only: liveness probe override (default = real IPC handshake). */
  probe?: (entry: { hash: string; configDir: string }) => Promise<boolean>;
}

export async function enumerateConfigDirs(
  opts: EnumerateConfigDirsOpts = {},
): Promise<ConfigDirEntry[]> {
  const root = opts.configRoot ?? getCliConfigDir();
  const probe = opts.probe ?? realProbe;

  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const result: ConfigDirEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !HASH_RE.test(e.name)) continue; // skip daemons/, flat files
    const configDir = join(root, e.name);
    const id = await readIdentity(configDir);
    const live = await probe({ hash: e.name, configDir });
    result.push({ hash: e.name, configDir, workspace: id.workspace, name: id.name, live });
  }
  result.sort((a, b) =>
    (a.name ?? a.hash).localeCompare(b.name ?? b.hash),
  );
  return result;
}

async function readIdentity(
  configDir: string,
): Promise<{ workspace: string | null; name: string | null }> {
  try {
    const raw = JSON.parse(
      await readFile(join(configDir, "workspaces.json"), "utf8"),
    ) as { workspaces?: unknown };
    const list: unknown[] = Array.isArray(raw.workspaces) ? raw.workspaces : [];
    const entry = (list[0] ?? {}) as { abs_path?: unknown; name?: unknown };
    return {
      workspace: typeof entry.abs_path === "string" ? entry.abs_path : null,
      name: typeof entry.name === "string" ? entry.name : null,
    };
  } catch {
    return { workspace: null, name: null };
  }
}

async function realProbe(entry: {
  hash: string;
  configDir: string;
}): Promise<boolean> {
  try {
    const response = await sendIpc(
      { kind: "status" },
      {
        addressOverride: ipcAddressForHash(entry.hash, entry.configDir),
        timeoutMs: PROBE_TIMEOUT_MS,
      },
    );
    return response.kind === "status_ok";
  } catch {
    // Connection refused / ENOENT / timeout → the daemon is not live.
    return false;
  }
}
