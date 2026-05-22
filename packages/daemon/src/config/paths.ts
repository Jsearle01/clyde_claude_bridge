// Path resolution — single source of truth for daemon config locations and
// `~` expansion. Everything else in the daemon that needs a config-related
// path goes through this file (CC-2).

import { homedir } from "node:os";
import { join } from "node:path";

function getHome(): string {
  // On Unix prefer $HOME so test overrides work; fall back to homedir().
  // On Windows, $HOME isn't standard; use homedir() which handles it.
  if (process.platform !== "win32") {
    return process.env.HOME ?? homedir();
  }
  return homedir();
}

export function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData === undefined || appData === "") {
      throw new Error("APPDATA environment variable is not set");
    }
    return join(appData, "claude-bridge");
  }
  return join(getHome(), ".claude-bridge");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getPidPath(): string {
  return join(getConfigDir(), "daemon.pid");
}

export function expandTilde(p: string): string {
  if (p === "~") return getHome();
  if (p.startsWith("~/")) {
    return join(getHome(), p.slice(2));
  }
  return p;
}
