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

// ── Port allocation ───────────────────────────────────────────────────────

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

const MAX_PORT_SCAN = 64;

// Resolve the TCP bind port.
//   - explicit !== undefined → use it; if taken, ExplicitPortInUseError
//     (never silently increment past the operator's explicit choice).
//   - else → first free port from `start`, scanning up to MAX_PORT_SCAN.
// `isListening` is injected (production: isDaemonPortListening) so allocation
// is unit-testable without real sockets.
export async function allocatePort(
  opts: {
    explicit: number | undefined;
    start: number;
    host: string;
  },
  isListening: (host: string, port: number) => Promise<boolean>,
): Promise<number> {
  const { explicit, start, host } = opts;
  if (explicit !== undefined) {
    if (await isListening(host, explicit)) throw new ExplicitPortInUseError(explicit);
    return explicit;
  }
  for (let i = 0; i < MAX_PORT_SCAN; i++) {
    const candidate = start + i;
    if (candidate > 65535) break;
    if (!(await isListening(host, candidate))) return candidate;
  }
  throw new NoFreePortError(start, MAX_PORT_SCAN);
}
