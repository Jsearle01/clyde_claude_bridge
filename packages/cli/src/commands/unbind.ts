// CB-SMOKE-READINESS-BATCH: `claude-bridge unbind <target>` (and `--all`).
// Tears down an OAuth binding via the daemon's 004b revoke capability — the
// same path the extension uses. Until this command there was NO CLI unbind
// (`token` only has `rotate`; unbind was extension-only).
//
// FOOTGUN GUARD (operator decision): clearing all bindings must be DELIBERATE.
//   - `unbind` (no args) → LIST the daemon's bindings (sight — never clears).
//   - `unbind <target>`  → unbind that one binding (a typed workspace/client id).
//   - `unbind --all`     → unbind every binding (opt-in). Never a silent clear-all.
// T-CLI-4b: bare unbind LISTS (was a "specify a target" error) — the binding
// analog of `list`, so the operator can SEE what to revoke instead of detouring
// through `status`. The list shows the typeable target ids; NO numbered pick (a
// mis-picked number revokes the wrong binding — mirrors delete-dir). The binding
// data comes from the existing `status` IPC (oauth_bindings) — no daemon change.

import { createInterface } from "node:readline";
import type { OAuthBindingSummary } from "@claude-bridge/shared";
import {
  sendIpc,
  IpcClientConnectionError,
  IpcClientTimeoutError,
} from "../ipc-client.js";
import {
  selectDaemonTarget,
  DaemonNotRunningError,
  InvalidDaemonPickError,
} from "../util/selector.js";
import {
  enumerateConfigDirs,
  type ConfigDirEntry,
} from "../util/config-dirs.js";
import { ipcAddressForHash } from "../util/paths.js";
import { checkStalePid } from "../util/pidfile.js";

const UNBIND_TIMEOUT_MS = 10000;

export class UnbindTargetAndAllError extends Error {
  constructor() {
    super("unbind: pass either a target or --all, not both.");
    this.name = "UnbindTargetAndAllError";
  }
}

// T-CLI-5: bare unbind, non-interactive, with several daemons carrying bindings —
// error-and-list (no menu to read on a piped/CI stdin). Mirrors the selector's
// AmbiguousDaemonError, but scoped to daemons that actually HAVE bindings.
export class AmbiguousBindingDaemonError extends Error {
  constructor(public readonly bearing: readonly DaemonBindings[]) {
    super(
      `${bearing.length} daemons have active bindings — name one with ` +
        `--name <name> (or --workspace <path>):\n` +
        renderBindingBearingDaemons(bearing, false),
    );
    this.name = "AmbiguousBindingDaemonError";
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
  /** T-CLI-1: selectors — which daemon's binding to tear down. */
  workspace?: string;
  name?: string;
  configRoot?: string;
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
  // T-CLI-5: the binding-presence-driven fan-out (bare invocation). Test-only
  // injections; production uses the real enumeration + status IPC.
  probe?: (entry: { hash: string; configDir: string }) => Promise<boolean>;
  fetchBindingsFor?: (entry: ConfigDirEntry) => Promise<OAuthBindingSummary[]>;
  interactive?: boolean;
  pickNumber?: (bearing: readonly DaemonBindings[]) => Promise<number>;
}

// T-CLI-5: a live daemon paired with its active bindings (the fan-out unit).
export interface DaemonBindings {
  entry: ConfigDirEntry;
  bindings: OAuthBindingSummary[];
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

// T-CLI-4b: the binding-list (the daemon→bindings enumeration). Shows each
// binding's workspace + client_id (both are typeable `unbind` targets) + the
// issued/expires dates. NO numbered pick — the operator types the workspace or
// client id (a mis-picked number revokes the wrong binding; mirrors delete-dir).
export function formatBindingList(
  bindings: readonly OAuthBindingSummary[],
): string {
  if (bindings.length === 0) {
    return "No active bindings.\n";
  }
  const lines: string[] = [];
  lines.push(
    `${bindings.length} active binding${bindings.length === 1 ? "" : "s"} — ` +
      "type a workspace or client id below to unbind it (or --all):",
  );
  for (const b of bindings) {
    const ws = b.bound_workspace ?? "(no workspace — non-binding)";
    lines.push(`  - ${ws}`);
    lines.push(
      `      client ${b.client_id}  ·  issued ${b.issued_at}, ` +
        `expires ${new Date(b.expires_at).toISOString()}`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function unbindCommand(opts: UnbindOpts = {}): Promise<void> {
  const all = opts.all ?? false;
  const target = opts.target;

  // Arg validation BEFORE any IPC — a target AND --all is ambiguous.
  if (all && target !== undefined) {
    throw new UnbindTargetAndAllError();
  }

  const bare = !all && (target === undefined || target === "");
  const explicitDaemon =
    (opts.name !== undefined && opts.name !== "") ||
    (opts.workspace !== undefined && opts.workspace !== "") ||
    opts.addressOverride !== undefined ||
    opts.pidPath !== undefined;

  // T-CLI-5: a truly-bare `unbind` (no target, no --all, no explicit daemon) →
  // binding-presence-driven fan-out: present by WHERE bindings are, not by how
  // many daemons exist (fixes "pick a daemon → it's empty"). An explicit daemon
  // (--name/--workspace/override) skips the fan-out and lists that daemon below.
  if (bare && !explicitDaemon) {
    return bareUnbindFanout(opts);
  }

  // T-CLI-1/4b: resolve WHICH daemon via the unified selector (picking the daemon
  // is non-destructive — the numbered pick is fine here; the destructive REVOKE
  // below requires a typed target).
  const sel = await selectDaemonTarget({
    workspace: opts.workspace,
    name: opts.name,
    configRoot: opts.configRoot,
    addressOverride: opts.addressOverride,
    pidPath: opts.pidPath,
  });
  const state = await checkStalePid(sel.pidPath);
  if (state === "absent" || state === "stale") {
    throw new DaemonNotRunningError();
  }

  // T-CLI-4b: bare (no target, no --all) → LIST the bindings (sight, never
  // clears — the footgun "no silent clear-all" holds because listing ≠ clearing).
  if (!all && (target === undefined || target === "")) {
    const bindings = await fetchBindings(sel.addressOverride);
    process.stdout.write(formatBindingList(bindings));
    return;
  }

  try {
    const response = await sendIpc(
      { kind: "unbind_binding", target: target ?? null, all },
      {
        addressOverride: sel.addressOverride,
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

// T-CLI-4b: fetch the daemon's bindings via the existing `status` IPC — the
// oauth_bindings array is already on the status payload, so listing needs NO
// daemon change (CLI-only). Empty/absent → no bindings.
async function fetchBindings(
  addressOverride: string | undefined,
): Promise<OAuthBindingSummary[]> {
  const response = await sendIpc(
    { kind: "status" },
    { addressOverride, timeoutMs: UNBIND_TIMEOUT_MS },
  );
  if (response.kind !== "status_ok") {
    throw new Error(`Unexpected IPC response kind: ${response.kind}`);
  }
  return response.payload.oauth_bindings ?? [];
}

// T-CLI-5: the binding-presence-driven bare flow. Fan the binding query out
// across all live daemons UP FRONT (reusing the status IPC — no daemon change),
// then present by WHERE bindings are rather than by how many daemons exist.
async function bareUnbindFanout(opts: UnbindOpts): Promise<void> {
  const all = await enumerateConfigDirs({
    configRoot: opts.configRoot,
    probe: opts.probe,
  });
  const live = all.filter((e) => e.live);
  const fetchFor =
    opts.fetchBindingsFor ??
    ((e: ConfigDirEntry) => fetchBindings(ipcAddressForHash(e.hash, e.configDir)));

  const bearing: DaemonBindings[] = [];
  for (const e of live) {
    let bindings: OAuthBindingSummary[] = [];
    try {
      bindings = await fetchFor(e);
    } catch {
      // A daemon that went unreachable mid-scan contributes no bindings.
    }
    if (bindings.length > 0) bearing.push({ entry: e, bindings });
  }

  // 0 bindings anywhere → say so, NO menu (the operator's reported bug fixed).
  if (bearing.length === 0) {
    process.stdout.write("No active bindings on any daemon.\n");
    return;
  }
  // Exactly ONE daemon has bindings → skip the daemon-pick, list it directly.
  if (bearing.length === 1) {
    const only = bearing[0];
    if (only !== undefined) process.stdout.write(formatBindingList(only.bindings));
    return;
  }
  // SEVERAL daemons have bindings → pick among ONLY those (numbered pick is
  // non-destructive); non-interactive → error-and-list (no menu to read).
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
  if (!interactive) {
    throw new AmbiguousBindingDaemonError(bearing);
  }
  const pick = opts.pickNumber ?? defaultDaemonPick;
  const choice = await pick(bearing);
  const chosen = bearing[choice - 1];
  if (chosen === undefined) {
    throw new InvalidDaemonPickError(String(choice), bearing.length);
  }
  process.stdout.write(formatBindingList(chosen.bindings));
}

// T-CLI-5: render the binding-bearing daemons (name/workspace + binding COUNT).
// `numbered` for the interactive pick; un-numbered for the non-TTY error list.
function renderBindingBearingDaemons(
  bearing: readonly DaemonBindings[],
  numbered: boolean,
): string {
  const lines: string[] = [];
  bearing.forEach((d, i) => {
    const prefix = numbered ? `  [${i + 1}] ` : "  - ";
    const name = d.entry.name ?? d.entry.hash;
    const ws = d.entry.workspace ?? "(unknown workspace)";
    const n = d.bindings.length;
    lines.push(`${prefix}${name}  (${ws})  — ${n} binding${n === 1 ? "" : "s"}`);
  });
  return lines.join("\n") + "\n";
}

async function defaultDaemonPick(
  bearing: readonly DaemonBindings[],
): Promise<number> {
  process.stdout.write(
    `${bearing.length} daemons have active bindings — pick which to unbind from:\n`,
  );
  process.stdout.write(renderBindingBearingDaemons(bearing, true));
  process.stdout.write(`Pick a number (1-${bearing.length}): `);
  const rl = createInterface({ input: process.stdin });
  try {
    const line = await new Promise<string>((resolve) => {
      rl.once("line", (l) => resolve(l));
    });
    return Number.parseInt(line.trim(), 10);
  } finally {
    rl.close();
  }
}
