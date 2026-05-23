// `claude-bridge status` — prints the formatted status block per
// `01-p0-bus.md` §"claude-bridge status". Refuses to call IPC if the PID
// file shows the daemon isn't running (prints a single-line "down" instead
// of waiting for a connection refused).

import { homedir } from "node:os";
import type { StatusPayload } from "@claude-bridge/shared";
import { sendIpc } from "../ipc-client.js";
import { getCliPidPath } from "../util/paths.js";
import { checkStalePid, readPidFromFile } from "../util/pidfile.js";

const STATUS_TIMEOUT_MS = 10000;

export interface StatusOpts {
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
  homeDir?: string;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h${mm}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function collapsePath(p: string, home: string): string {
  if (home === "") return p;
  if (p === home) return "~";
  // Match either separator so this works for posix paths (tests, Unix
  // daemons) and Windows paths (where the daemon emits backslashes).
  const next = p[home.length];
  if (p.startsWith(home) && (next === "/" || next === "\\")) {
    return "~/" + p.slice(home.length + 1).replace(/\\/g, "/");
  }
  return p;
}

export function formatStatusPayload(
  payload: StatusPayload,
  pid: number | null,
  home: string,
): string {
  const lines: string[] = [];
  const pidPart = pid !== null ? `pid ${pid}, ` : "";
  lines.push(
    `Daemon:    up (${pidPart}uptime ${formatUptime(payload.daemon_uptime_s)})`,
  );
  lines.push(`Endpoint:  ${payload.endpoint}`);
  lines.push(`Tunnel:    ${payload.tunnel_status}`);
  if (payload.tunnel_url !== null) {
    lines.push(`URL:       ${payload.tunnel_url}`);
  } else {
    lines.push(`URL:       (not assigned)`);
  }
  lines.push(`Token:     cb_live_…${payload.token_suffix} (last 4)`);
  lines.push(
    `Audit:     ${collapsePath(payload.audit_path, home)} (current size: ${formatBytes(payload.audit_size_bytes)})`,
  );
  return lines.join("\n") + "\n";
}

export async function statusCommand(opts: StatusOpts = {}): Promise<void> {
  const pidPath = opts.pidPath ?? getCliPidPath();
  const state = await checkStalePid(pidPath);
  if (state === "absent" || state === "stale") {
    process.stdout.write("Daemon:    down\n");
    return;
  }

  const pid = await readPidFromFile(pidPath);
  const response = await sendIpc(
    { kind: "status" },
    {
      addressOverride: opts.addressOverride,
      timeoutMs: STATUS_TIMEOUT_MS,
    },
  );
  if (response.kind !== "status_ok") {
    throw new Error(`Unexpected IPC response kind: ${response.kind}`);
  }
  const home = opts.homeDir ?? (process.env.HOME ?? homedir());
  process.stdout.write(formatStatusPayload(response.payload, pid, home));
}
