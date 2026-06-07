// Per-daemon resource derivation (P3′ Phase 1b).
//
// The identity (1a) becomes PHYSICAL here: each daemon gets its own config-dir,
// IPC pipe, and TCP port derived from that identity, so two daemons for two
// workspaces never collide on disk, IPC channel, or port. This is Design B's
// physical isolation — separate processes writing separate files, not a token
// check guarding a shared store.
//
// DERIVATION CONTRACT (frozen — everything downstream consumes these):
//   identity  = workspaceIdentityKey(input)            (shared; case-folded key)
//   hash      = sha256(identity)[:16]                  (deterministic, fs-safe)
//   configDir = <root>/<hash>/                         (per-daemon state dir)
//   ipc       = win32 \\.\pipe\claude-bridge-<hash>    (per-daemon pipe)
//               posix <configDir>/daemon.sock          (per-daemon socket)
// Determinism is load-bearing: same workspace → same identity → same hash →
// same config-dir → tokens.json persists across restart (AC-1b-6).
//
// The hash uses node:crypto (a daemon dep); kept package-side, NOT in shared,
// so @claude-bridge/shared stays dependency-free. The CLI duplicates the tiny
// hash + pipe-name logic (util/paths.ts), per the established convention that
// the IPC channel — not a shared type graph — is the cli↔daemon boundary.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { connect } from "node:net";
import { computeDaemonIdentity, type DaemonIdentity } from "./identity.js";

// SHA-256 of the identity, first 16 hex chars (64 bits) — deterministic,
// collision-resistant at this scale, and filesystem-safe (hex only).
export function deriveResourceHash(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

// Per-daemon IPC pipe name (win32). Distinct per hash so two daemons never
// share a pipe. The legacy single-daemon name was "\\.\pipe\claude-bridge".
export function daemonPipeName(hash: string): string {
  return `\\\\.\\pipe\\claude-bridge-${hash}`;
}

// The actual IPC listen/connect address: a named pipe on win32 (the per-daemon
// sock file path is meaningless there), the per-daemon socket file on posix.
export function daemonIpcAddress(
  hash: string,
  sockPath: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32" ? daemonPipeName(hash) : sockPath;
}

export interface DaemonResources extends DaemonIdentity {
  hash: string;
  /** Per-daemon state dir: <root>/<hash>/. */
  configDir: string;
  /** Per-daemon unix socket path (under configDir). */
  ipcSocketPath: string;
  /** Actual IPC address used to listen/connect (pipe on win32, sock on posix). */
  ipcAddress: string;
}

// Compose the full per-daemon resource set from the operator's --workspace
// input + --name + the flat root config dir.
export function computeDaemonResources(
  workspaceInput: string,
  name: string,
  rootConfigDir: string,
  platform: NodeJS.Platform = process.platform,
): DaemonResources {
  const id = computeDaemonIdentity(workspaceInput, name, platform);
  const hash = deriveResourceHash(id.identity);
  const configDir = join(rootConfigDir, hash);
  const ipcSocketPath = join(configDir, "daemon.sock");
  const ipcAddress = daemonIpcAddress(hash, ipcSocketPath, platform);
  return { ...id, hash, configDir, ipcSocketPath, ipcAddress };
}

// ── Identity-keyed single-instance lock (P3′-1c, ITEM 1) ───────────────────
//
// The lock keys on the canonical identity by probing THIS daemon's per-daemon
// IPC pipe/socket: a LIVE same-identity incumbent is, by definition, listening
// on it. Liveness (not bare pid-file presence) decides refuse-vs-reclaim — a
// crashed daemon's pipe/socket is gone (OS-released), so a connect simply
// fails and the new start reclaims. This is uniform across win32 (named-pipe
// connect) and posix (unix-socket connect), sidestepping the win32 named-pipe
// multi-instance caveat (a second *listener* may be allowed, but a *connect*
// to a live one always succeeds — which is all the lock needs).
//
// connect succeeds  → a live incumbent owns this identity → REFUSE.
// ECONNREFUSED/ENOENT → stale socket file or nothing there → not live → reclaim.
export function isIpcAddressLive(
  address: string,
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(address);
    let settled = false;
    const done = (live: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

// ── Port allocation (P3′-1c, ITEM 2: bind-with-retry) ──────────────────────

export class ExplicitPortInUseError extends Error {
  constructor(public readonly port: number) {
    super(
      `--port ${port} is already in use; refusing to start (explicit port is ` +
        `not auto-incremented — pick a free port or omit --port for next-free)`,
    );
    this.name = "ExplicitPortInUseError";
  }
}

export class NoFreePortError extends Error {
  constructor(
    public readonly start: number,
    public readonly attempts: number,
  ) {
    super(`no free port found in ${attempts} attempts starting at ${start}`);
    this.name = "NoFreePortError";
  }
}

export const MAX_PORT_SCAN = 64;

// Atomic auto-allocation: the BIND is the claim (closes 1b's probe-then-bind
// TOCTOU race). `tryBind(port)` must actually attempt to bind and reject with
// an EADDRINUSE-coded error if the port is taken; bindWithRetry advances to the
// next port on EADDRINUSE and returns the first port that binds. Non-EADDRINUSE
// errors propagate. Bounded by MAX_PORT_SCAN → NoFreePortError (no infinite
// loop). `tryBind` is injected so the retry logic is unit-testable against a
// mocked EADDRINUSE without real sockets (the §5 deterministic proof).
export async function bindWithRetry(
  tryBind: (port: number) => Promise<void>,
  opts: { startPort: number; maxScan?: number },
): Promise<number> {
  const maxScan = opts.maxScan ?? MAX_PORT_SCAN;
  for (let i = 0; i < maxScan; i++) {
    const port = opts.startPort + i;
    if (port > 65535) break;
    try {
      await tryBind(port);
      return port;
    } catch (err) {
      if (isEaddrinuse(err)) continue;
      throw err;
    }
  }
  throw new NoFreePortError(opts.startPort, maxScan);
}

function isEaddrinuse(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}
