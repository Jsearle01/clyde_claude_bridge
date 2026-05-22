// Daemon-wide state shared with tool handlers via ToolContext.
//
// Deliberately minimal for T-0011 — only what ping needs plus the tunnel
// placeholder. T-0013 (main wiring) will extend with the Config, the
// TunnelManager handle, and anything else `01-p0-bus.md` requires.

export interface DaemonState {
  version: string;
  startedAt: number;
  // Tunnel state — populated by T-0012's TunnelManager. For T-0011, the
  // tunnel doesn't exist yet, so the initial state honestly reports "down".
  tunnelStatus: "up" | "degraded" | "down";
  tunnelUrl: string | null;
}

export function makeInitialState(version: string): DaemonState {
  return {
    version,
    startedAt: Date.now(),
    tunnelStatus: "down",
    tunnelUrl: null,
  };
}
