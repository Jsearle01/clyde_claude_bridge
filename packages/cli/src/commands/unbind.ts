// CB-SMOKE-READINESS-BATCH: `claude-bridge unbind <target>` (and `--all`).
// Tears down an OAuth binding via the daemon's 004b revoke capability — the
// same path the extension uses. Until this command there was NO CLI unbind
// (`token` only has `rotate`; unbind was extension-only).
//
// FOOTGUN GUARD (operator decision): clearing all bindings must be DELIBERATE.
//   - `unbind <target>`  → unbind that one binding.
//   - `unbind --all`     → unbind every binding (opt-in).
//   - `unbind` (no args) → ERROR. Never a silent clear-all.

import {
  sendIpc,
  IpcClientConnectionError,
  IpcClientTimeoutError,
} from "../ipc-client.js";
import { getCliPidPath } from "../util/paths.js";
import { checkStalePid } from "../util/pidfile.js";
import { DaemonNotRunningError } from "./token.js";

const UNBIND_TIMEOUT_MS = 10000;

export class UnbindTargetRequiredError extends Error {
  constructor() {
    super(
      "unbind: specify a target binding (a workspace identifier or client id), " +
        "or pass --all to clear ALL bindings.",
    );
    this.name = "UnbindTargetRequiredError";
  }
}

export class UnbindTargetAndAllError extends Error {
  constructor() {
    super("unbind: pass either a target or --all, not both.");
    this.name = "UnbindTargetAndAllError";
  }
}

export class UnbindConnectionLostError extends Error {
  constructor() {
    super(
      "Daemon connection lost; the binding may or may not have been removed. Check `claude-bridge status`.",
    );
    this.name = "UnbindConnectionLostError";
  }
}

export class UnbindTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Daemon did not respond within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "UnbindTimeoutError";
  }
}

export interface UnbindResultEntry {
  client_id: string;
  bound_workspace: string | null;
  tokens_revoked: number;
}

export interface UnbindOpts {
  target?: string;
  all?: boolean;
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
}

/** The user-facing block. Empty `unbound` → a clear "no match" line so the
 *  operator isn't left guessing whether anything happened. */
export function formatUnbindOutput(
  unbound: UnbindResultEntry[],
  target: string | null,
  all: boolean,
): string {
  if (unbound.length === 0) {
    if (all) return "No active bindings to clear.\n";
    return `No binding matched '${target ?? ""}'. Run \`claude-bridge status\` to list active bindings.\n`;
  }
  const lines: string[] = [];
  lines.push(all ? "Unbound all bindings:" : "Unbound:");
  for (const u of unbound) {
    const ws = u.bound_workspace ?? "(no workspace)";
    lines.push(
      `  - ${u.client_id} → ${ws} (${u.tokens_revoked} token${u.tokens_revoked === 1 ? "" : "s"} revoked)`,
    );
  }
  lines.push("");
  lines.push(
    "The client must re-authorize from Claude.ai to bind again. The daemon is fail-closed in the meantime.",
  );
  return lines.join("\n") + "\n";
}

export async function unbindCommand(opts: UnbindOpts = {}): Promise<void> {
  const all = opts.all ?? false;
  const target = opts.target;

  // Footgun guard + arg validation BEFORE any IPC — a no-args clear-all must
  // never happen by omission.
  if (all && target !== undefined) {
    throw new UnbindTargetAndAllError();
  }
  if (!all && (target === undefined || target === "")) {
    throw new UnbindTargetRequiredError();
  }

  const pidPath = opts.pidPath ?? getCliPidPath();
  const state = await checkStalePid(pidPath);
  if (state === "absent" || state === "stale") {
    throw new DaemonNotRunningError();
  }

  try {
    const response = await sendIpc(
      { kind: "unbind_binding", target: target ?? null, all },
      {
        addressOverride: opts.addressOverride,
        timeoutMs: UNBIND_TIMEOUT_MS,
      },
    );
    if (response.kind !== "unbind_binding_ok") {
      throw new Error(`Unexpected IPC response kind: ${response.kind}`);
    }
    process.stdout.write(
      formatUnbindOutput(response.unbound, target ?? null, all),
    );
  } catch (err) {
    if (err instanceof IpcClientConnectionError) {
      throw new UnbindConnectionLostError();
    }
    if (err instanceof IpcClientTimeoutError) {
      throw new UnbindTimeoutError(UNBIND_TIMEOUT_MS);
    }
    throw err;
  }
}
