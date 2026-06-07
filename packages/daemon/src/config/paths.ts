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

// The FLAT root config dir (%APPDATA%\claude-bridge or ~/.claude-bridge).
// P3′-1b: this is the ROOT under which per-daemon dirs live (<root>/<hash>/);
// it also remains the home of the legacy single-daemon layout (no --workspace)
// and, later, the top-level `daemons/` advert dir (Phase 2a).
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

// P3′-1b: every state path now takes the resolved config dir. It defaults to
// the flat root (behavior-preserving for the legacy/no-`--workspace` and
// acceptance-harness paths); main.ts passes the per-daemon `<root>/<hash>/`
// dir when started with `--workspace`.
export function getConfigPath(configDir: string = getConfigDir()): string {
  return join(configDir, "config.json");
}

export function getPidPath(configDir: string = getConfigDir()): string {
  return join(configDir, "daemon.pid");
}

export function getWorkspacesStorePath(configDir: string = getConfigDir()): string {
  return join(configDir, "workspaces.json");
}

export function getClientsStorePath(configDir: string = getConfigDir()): string {
  return join(configDir, "clients.json");
}

// T-P3-004a: durable OAuth access-token store (the binding's persistent
// home). Separate file from clients.json (which holds DCR registrations) —
// tokens have their own lifecycle (30-day TTL, single-use mint, unbind).
export function getTokensStorePath(configDir: string = getConfigDir()): string {
  return join(configDir, "tokens.json");
}

export function expandTilde(p: string): string {
  if (p === "~") return getHome();
  if (p.startsWith("~/")) {
    return join(getHome(), p.slice(2));
  }
  return p;
}
