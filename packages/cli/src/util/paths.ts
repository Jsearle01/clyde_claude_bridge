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
