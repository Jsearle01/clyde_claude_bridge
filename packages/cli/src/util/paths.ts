// Cross-platform path/address helpers shared by CLI subcommands.
//
// Duplicated from `packages/daemon/src/config/paths.ts` and
// `packages/daemon/src/ipc/server.ts`. T-0002 deliberately avoided a
// cli→daemon TS project reference (the IPC channel IS the boundary;
// static helpers shouldn't pull daemon into cli's type graph). The
// duplication is small and the platform-detection logic is the canonical
// shape; if it ever needs to change, both sides update.
//
// Extraction note: these helpers were inlined in `ipc-client.ts` (T-0014)
// and `commands/start.ts` (T-0015); T-0016's third+ use site (stop +
// status commands) triggered the extraction.

import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { workspaceIdentityKey } from "@claude-bridge/shared";

const WINDOWS_PIPE_PATH = "\\\\.\\pipe\\claude-bridge";

export function getCliConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new Error("APPDATA environment variable is not set");
    }
    return join(appData, "claude-bridge");
  }
  const home = process.env.HOME ?? homedir();
  return join(home, ".claude-bridge");
}

export function getCliConfigPath(): string {
  return join(getCliConfigDir(), "config.json");
}

export function getCliPidPath(): string {
  return join(getCliConfigDir(), "daemon.pid");
}

export function addressFor(socketPath: string): string {
  if (process.platform === "win32") {
    return WINDOWS_PIPE_PATH;
  }
  return socketPath;
}

// ── P3′-1b: per-daemon resource derivation ──────────────────────────────────
// DUPLICATED from packages/daemon/src/workspace/resources.ts (the same
// rationale as the path/address helpers above: the IPC channel — not a shared
// TS graph — is the cli↔daemon boundary). MUST stay byte-identical to the
// daemon's derivation: same identity key (shared workspaceIdentityKey), same
// sha256[:16] hash, same pipe-name format — else the CLI connects to the wrong
// address. The shared identity key keeps the most error-prone half in one
// place; only the small hash + pipe-name format are duplicated.

export function deriveResourceHash(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function daemonPipeName(hash: string): string {
  return `\\\\.\\pipe\\claude-bridge-${hash}`;
}

// Resolve the per-daemon config-dir + IPC address for a given --workspace
// input, matching the daemon's computeDaemonResources exactly so `start` can
// read the spawned daemon's config + connect to its pipe.
export function perDaemonResources(
  workspaceInput: string,
  platform: NodeJS.Platform = process.platform,
): {
  hash: string;
  configDir: string;
  configPath: string;
  pidPath: string;
  ipcAddress: string;
} {
  const identity = workspaceIdentityKey(workspaceInput, platform);
  const hash = deriveResourceHash(identity);
  const configDir = join(getCliConfigDir(), hash);
  const sockPath = join(configDir, "daemon.sock");
  return {
    hash,
    configDir,
    configPath: join(configDir, "config.json"),
    pidPath: join(configDir, "daemon.pid"),
    ipcAddress: platform === "win32" ? daemonPipeName(hash) : sockPath,
  };
}
