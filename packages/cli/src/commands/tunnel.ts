// `claude-bridge tunnel restart` — asks the daemon to stop the existing
// cloudflared process, spawn a new one, and report the new URL. This is the
// manual recovery path from `tunnel_status: "degraded"` (the sliding-window
// restart policy from T-0012 gives up after 5-in-5; the user reaches for
// this command to try again).

import {
  sendIpc,
  IpcClientConnectionError,
  IpcClientTimeoutError,
} from "../ipc-client.js";
import { selectDaemonTarget } from "../util/selector.js";
import { checkStalePid } from "../util/pidfile.js";
import { DaemonNotRunningError } from "./token.js";

const TUNNEL_RESTART_TIMEOUT_MS = 20000;

export class TunnelRestartConnectionLostError extends Error {
  constructor() {
    super("Daemon connection lost during restart.");
    this.name = "TunnelRestartConnectionLostError";
  }
}

export class TunnelRestartTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(
      `Tunnel restart did not complete within ${Math.round(timeoutMs / 1000)}s. Check status.`,
    );
    this.name = "TunnelRestartTimeoutError";
  }
}

export class TunnelRestartFailedError extends Error {
  constructor(public readonly daemonMessage: string) {
    super(`Tunnel restart failed: ${daemonMessage}`);
    this.name = "TunnelRestartFailedError";
  }
}

export interface TunnelRestartOpts {
  /** T-CLI-1: selectors. */
  workspace?: string;
  name?: string;
  daemonsDir?: string;
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
}

export function formatTunnelRestartOutput(newUrl: string): string {
  return (
    "Tunnel restarted.\n" +
    `New URL: ${newUrl}\n` +
    "\n" +
    "Update any MCP clients with the new URL.\n"
  );
}

export async function tunnelRestartCommand(
  opts: TunnelRestartOpts = {},
): Promise<void> {
  // T-CLI-1: target via the unified selector instead of the flat pid path.
  const target = await selectDaemonTarget({
    workspace: opts.workspace,
    name: opts.name,
    daemonsDir: opts.daemonsDir,
    addressOverride: opts.addressOverride,
    pidPath: opts.pidPath,
  });
  const state = await checkStalePid(target.pidPath);
  if (state === "absent" || state === "stale") {
    throw new DaemonNotRunningError();
  }

  try {
    const response = await sendIpc(
      { kind: "tunnel_restart" },
      {
        addressOverride: target.addressOverride,
        timeoutMs: TUNNEL_RESTART_TIMEOUT_MS,
      },
    );
    if (response.kind !== "tunnel_restart_ok") {
      throw new Error(`Unexpected IPC response kind: ${response.kind}`);
    }
    process.stdout.write(formatTunnelRestartOutput(response.new_url));
  } catch (err) {
    if (err instanceof IpcClientConnectionError) {
      throw new TunnelRestartConnectionLostError();
    }
    if (err instanceof IpcClientTimeoutError) {
      throw new TunnelRestartTimeoutError(TUNNEL_RESTART_TIMEOUT_MS);
    }
    if (err instanceof Error) {
      // sendIpc surfaces { kind: "error", message } as plain Error.
      throw new TunnelRestartFailedError(err.message);
    }
    throw err;
  }
}
