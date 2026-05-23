// `claude-bridge token rotate` — asks the daemon to mint a fresh token,
// persist it to config.json, and invalidate the previous one in memory.
// Requires the daemon to be running (the in-memory token is owned by the
// daemon process; a config-only rewrite while down would leave a confusing
// "rotated but not actually active" state).

import {
  sendIpc,
  IpcClientConnectionError,
  IpcClientTimeoutError,
} from "../ipc-client.js";
import { getCliPidPath } from "../util/paths.js";
import { checkStalePid } from "../util/pidfile.js";

const TOKEN_ROTATE_TIMEOUT_MS = 10000;

export class DaemonNotRunningError extends Error {
  constructor() {
    super("Daemon not running. Start it with `claude-bridge start` first.");
    this.name = "DaemonNotRunningError";
  }
}

export class TokenRotateConnectionLostError extends Error {
  constructor() {
    super(
      "Daemon connection lost; the token may or may not have been rotated. Check status.",
    );
    this.name = "TokenRotateConnectionLostError";
  }
}

export class TokenRotateTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Daemon did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "TokenRotateTimeoutError";
  }
}

export interface TokenRotateOpts {
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
}

export function formatTokenRotateOutput(newToken: string): string {
  return (
    "Token rotated.\n" +
    `New token: ${newToken}\n` +
    "\n" +
    "Update any MCP clients with the new token. The previous token is no longer valid.\n"
  );
}

export async function tokenRotateCommand(
  opts: TokenRotateOpts = {},
): Promise<void> {
  const pidPath = opts.pidPath ?? getCliPidPath();
  const state = await checkStalePid(pidPath);
  if (state === "absent" || state === "stale") {
    throw new DaemonNotRunningError();
  }

  try {
    const response = await sendIpc(
      { kind: "token_rotate" },
      {
        addressOverride: opts.addressOverride,
        timeoutMs: TOKEN_ROTATE_TIMEOUT_MS,
      },
    );
    if (response.kind !== "token_rotate_ok") {
      throw new Error(`Unexpected IPC response kind: ${response.kind}`);
    }
    process.stdout.write(formatTokenRotateOutput(response.new_token));
  } catch (err) {
    if (err instanceof IpcClientConnectionError) {
      throw new TokenRotateConnectionLostError();
    }
    if (err instanceof IpcClientTimeoutError) {
      throw new TokenRotateTimeoutError(TOKEN_ROTATE_TIMEOUT_MS);
    }
    throw err;
  }
}
