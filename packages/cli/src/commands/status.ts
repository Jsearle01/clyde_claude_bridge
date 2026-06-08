// `claude-bridge status` — prints the formatted status block per
// `01-p0-bus.md` §"claude-bridge status". Refuses to call IPC if the PID
// file shows the daemon isn't running (prints a single-line "down" instead
// of waiting for a connection refused).

import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DaemonAdvertSchema,
  type DaemonAdvert,
  type StatusPayload,
} from "@claude-bridge/shared";
import { sendIpc } from "../ipc-client.js";
import { resolveCliTarget, getCliConfigDir } from "../util/paths.js";
import { checkStalePid, readPidFromFile } from "../util/pidfile.js";

const STATUS_TIMEOUT_MS = 10000;

export interface StatusOpts {
  /** P3′-3-fix: target a specific per-daemon (P3′) daemon by its workspace. */
  workspace?: string;
  /** Test-only overrides. */
  addressOverride?: string;
  pidPath?: string;
  homeDir?: string;
  /** Test-only: the adverts dir bare `status` enumerates. */
  daemonsDir?: string;
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
  // CB-SMOKE-READINESS-BATCH: label this clearly as the daemon BEARER token —
  // it is NOT an OAuth binding. The old `Token:` line misled the smoke into
  // reading a stale Bearer line as evidence of a binding. OAuth bindings are
  // listed separately below (from tokens.json).
  lines.push(
    `Bearer:    cb_live_…${payload.token_suffix} (daemon Bearer token — not an OAuth binding)`,
  );
  lines.push(
    `Audit:     ${collapsePath(payload.audit_path, home)} (current size: ${formatBytes(payload.audit_size_bytes)})`,
  );
  // CB-DAEMON-LIFECYCLE-FIX: list the connected (registered) extension
  // sessions so a doubled-daemon split is visible (which window+pid is bound
  // to THIS daemon). `connected_extensions` is optional on the wire (a pre-fix
  // daemon won't send it) — distinguish "0 sessions" from "not reported".
  const sessions = payload.connected_extensions;
  if (sessions === undefined) {
    lines.push(`Sessions:  (not reported by this daemon)`);
  } else if (sessions.length === 0) {
    lines.push(`Sessions:  0 connected`);
  } else {
    lines.push(`Sessions:  ${sessions.length} connected`);
    for (const s of sessions) {
      lines.push(
        `           - ${s.identifier} (pid ${s.pid}) ${collapsePath(s.abs_path, home)}`,
      );
    }
  }
  // CB-SMOKE-READINESS-BATCH: surface the ACTIVE OAuth bindings from the token
  // store (tokens.json) so a real bind is visible here (it wasn't). Optional on
  // the wire — a pre-fix daemon won't send it (distinguish "not reported" from
  // "0 bindings"); an empty array prints a clear "none" so status never implies
  // a binding exists when the store is empty.
  const bindings = payload.oauth_bindings;
  if (bindings === undefined) {
    lines.push(`Bindings:  (not reported by this daemon)`);
  } else if (bindings.length === 0) {
    lines.push(`Bindings:  none (no active OAuth bindings)`);
  } else {
    lines.push(`Bindings:  ${bindings.length} active`);
    for (const b of bindings) {
      const ws = b.bound_workspace ?? "(no workspace — non-binding)";
      lines.push(
        `           - ${formatBindingClient(b.client_id)} → ${ws}`,
      );
      lines.push(
        `             issued ${b.issued_at}, expires ${new Date(b.expires_at).toISOString()}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

// Truncate a client_id for display (the full id is long). Mirrors the
// extension's formatClientLabel prefix length so the operator can copy the
// shown prefix straight into `claude-bridge unbind`.
const CLIENT_ID_DISPLAY_LEN = 18;
export function formatBindingClient(client_id: string): string {
  if (client_id.length <= CLIENT_ID_DISPLAY_LEN) return client_id;
  return `${client_id.slice(0, CLIENT_ID_DISPLAY_LEN)}…`;
}

export async function statusCommand(opts: StatusOpts = {}): Promise<void> {
  // Targeted: an explicit `--workspace`, or test overrides → the single-daemon
  // path. Bare `status` (no target) ENUMERATES every per-daemon daemon via the
  // adverts dir — because the legacy flat layout is empty in the P3′ world
  // (every daemon is per-daemon since 1b), so a flat-pid check would always
  // misreport "down" while daemons are actually running.
  if (
    (opts.workspace !== undefined && opts.workspace !== "") ||
    opts.addressOverride !== undefined ||
    opts.pidPath !== undefined
  ) {
    return statusTargeted(opts);
  }
  return statusEnumerate(opts);
}

// Single-daemon status: --workspace target, or legacy flat (test overrides).
async function statusTargeted(opts: StatusOpts): Promise<void> {
  const target = resolveCliTarget(opts.workspace);
  const pidPath = opts.pidPath ?? target.pidPath;
  const addressOverride = opts.addressOverride ?? target.addressOverride;
  const state = await checkStalePid(pidPath);
  if (state === "absent" || state === "stale") {
    process.stdout.write("Daemon:    down\n");
    return;
  }
  const pid = await readPidFromFile(pidPath);
  const response = await sendIpc(
    { kind: "status" },
    { addressOverride, timeoutMs: STATUS_TIMEOUT_MS },
  );
  if (response.kind !== "status_ok") {
    throw new Error(`Unexpected IPC response kind: ${response.kind}`);
  }
  const home = opts.homeDir ?? (process.env.HOME ?? homedir());
  process.stdout.write(formatStatusPayload(response.payload, pid, home));
}

// P3′-3-fix: enumerate every per-daemon daemon from the shared adverts dir and
// print a status block for each. A reachable advert handshakes + reports full
// status; an unreachable one (stale advert, daemon gone) is flagged, not hidden.
async function statusEnumerate(opts: StatusOpts): Promise<void> {
  const daemonsDir = opts.daemonsDir ?? join(getCliConfigDir(), "daemons");
  const home = opts.homeDir ?? (process.env.HOME ?? homedir());

  let files: string[] = [];
  try {
    files = await readdir(daemonsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const adverts: DaemonAdvert[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      adverts.push(
        DaemonAdvertSchema.parse(
          JSON.parse(await readFile(join(daemonsDir, file), "utf8")),
        ),
      );
    } catch {
      // Unparseable / partial advert — skip.
    }
  }

  if (adverts.length === 0) {
    process.stdout.write("No daemons running.\n");
    return;
  }

  adverts.sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < adverts.length; i++) {
    const a = adverts[i];
    if (a === undefined) continue;
    if (i > 0) process.stdout.write("\n");
    process.stdout.write(`Daemon '${a.name}' — ${a.canonical_workspace}\n`);
    try {
      const response = await sendIpc(
        { kind: "status" },
        { addressOverride: a.pipe, timeoutMs: STATUS_TIMEOUT_MS },
      );
      if (response.kind === "status_ok") {
        process.stdout.write(formatStatusPayload(response.payload, a.pid, home));
      } else {
        process.stdout.write(`  unexpected response: ${response.kind}\n`);
      }
    } catch {
      process.stdout.write(
        `  advertised (pid ${a.pid}) but unreachable — stale advert; ` +
          `the daemon is gone and it'll be swept on the next daemon start.\n`,
      );
    }
  }
}
