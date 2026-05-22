// Daemon-wide state shared with tool handlers via ToolContext.
//
// Extended at T-0013 to carry the loaded Config (needed by main.ts shutdown
// and by future tool handlers that read config values). The version field
// is read from this package's own package.json so it stays in sync with
// what npm shows.

import { createRequire } from "node:module";
import type { Config } from "@claude-bridge/shared";

const localRequire = createRequire(import.meta.url);
const pkg = localRequire("../package.json") as { version: string };

export interface DaemonState {
  version: string;
  startedAt: number;
  tunnelStatus: "up" | "degraded" | "down";
  tunnelUrl: string | null;
  config: Config;
}

export function makeInitialState(config: Config): DaemonState {
  return {
    version: pkg.version,
    startedAt: Date.now(),
    tunnelStatus: "down",
    tunnelUrl: null,
    config,
  };
}
