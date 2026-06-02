// T-P3-004a: durable OAuth access-token store — the persistent home for
// the workspace binding. Minted by the /token endpoint on auth-code
// redemption; read by the MCP auth layer on every request to resolve a
// presented token to its bound workspace.
//
// SECURITY: the plaintext token is NEVER stored. We persist `token_hash`
// = SHA-256(token). Lookup hashes the presented token and matches. SHA-256
// (not bcrypt) is deliberate: tokens are high-entropy 32-byte randoms with
// no brute-force exposure, and auth runs per-request so a slow KDF would be
// a latency/DoS problem. (Contrast clients.json's client_secret, which uses
// bcrypt because a secret may be lower-entropy and is verified rarely.)
//
// File: tokens.json (0o600 on Unix), whole-file replacement per write —
// same pattern as workspaces.json / clients.json. Expired tokens are swept
// lazily on load and on lookup.

import { readFile, writeFile, chmod, mkdir, stat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  OAuthTokensStoreSchema,
  type OAuthTokenRecord,
  type OAuthTokensStore,
} from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";

// Access-token prefix — greppable + self-identifying, matching the
// `cb_live_` Bearer and `cb_client_` DCR conventions.
const TOKEN_PREFIX = "cb_tok_";
const TOKEN_RANDOM_BYTES = 32; // 64 hex chars after the prefix

// 30-day TTL per design § (re-auth on expiry; no refresh tokens shipped).
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateAccessToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class TokensStoreVersionUnsupportedError extends Error {
  constructor(
    public readonly path: string,
    public readonly foundVersion: unknown,
  ) {
    super(
      `tokens.json at ${path} has unsupported version ${String(foundVersion)}; daemon refusing to start to avoid data corruption`,
    );
    this.name = "TokensStoreVersionUnsupportedError";
  }
}

/** Resolved binding for an authenticated OAuth token. */
export interface TokenBinding {
  client_id: string;
  bound_workspace: string | null;
  granularity: string | null;
}

export class TokenStore {
  private store: OAuthTokensStore = { version: "1", tokens: [] };
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.store = { version: "1", tokens: [] };
        this.loaded = true;
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    const versionField = (parsed as { version?: unknown }).version;
    if (versionField !== "1") {
      throw new TokensStoreVersionUnsupportedError(this.path, versionField);
    }
    this.store = OAuthTokensStoreSchema.parse(parsed);
    this.loaded = true;
    // Sweep any tokens that expired while the daemon was down.
    await this.sweepExpired();
  }

  /**
   * Mint a fresh access token bound to `bound_workspace`. Returns the
   * plaintext token (returned to the client ONCE in the /token response) and
   * its TTL in seconds. Only the SHA-256 hash is persisted.
   */
  async mint(args: {
    client_id: string;
    bound_workspace: string | null;
    granularity?: string | null;
  }): Promise<{ access_token: string; expires_in_s: number }> {
    this.assertLoaded();
    const token = generateAccessToken();
    const nowMs = this.now();
    const record: OAuthTokenRecord = {
      token_hash: hashToken(token),
      client_id: args.client_id,
      bound_workspace: args.bound_workspace,
      granularity: args.granularity ?? null,
      issued_at: new Date(nowMs).toISOString(),
      expires_at: nowMs + ACCESS_TOKEN_TTL_MS,
    };
    this.store.tokens.push(record);
    await this.writeFile();
    return {
      access_token: token,
      expires_in_s: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    };
  }

  /**
   * Resolve a presented plaintext token to its binding, or null if unknown
   * or expired. Pure read — no side effects on the hot auth path (expiry
   * sweep is lazy at load + on a dedicated sweep call, not per-lookup).
   */
  lookup(token: string): TokenBinding | null {
    this.assertLoaded();
    const hash = hashToken(token);
    const rec = this.store.tokens.find((t) => t.token_hash === hash);
    if (rec === undefined) return null;
    if (this.now() >= rec.expires_at) return null;
    return {
      client_id: rec.client_id,
      bound_workspace: rec.bound_workspace,
      granularity: rec.granularity,
    };
  }

  /**
   * T-P3-004b (unbind): delete every token bound to `workspace`. Tears down
   * the durable binding so the revoked token authenticates as invalid (the
   * auth-layer lookup returns null → invalid_token, never unconstrained).
   * Returns the count removed. Other tokens + the DCR registration are
   * untouched (lighter unbind — the client can re-bind with the same id).
   */
  async revokeByWorkspace(workspace: string): Promise<number> {
    this.assertLoaded();
    const before = this.store.tokens.length;
    this.store.tokens = this.store.tokens.filter(
      (t) => t.bound_workspace !== workspace,
    );
    const removed = before - this.store.tokens.length;
    if (removed > 0) await this.writeFile();
    return removed;
  }

  /**
   * T-P3-004b (broadcast filter): is there a live (non-expired) token bound
   * to `workspace`? Used to exclude already-bound windows from the consent
   * broadcast. "Bound" = an active token names the workspace, read live.
   */
  hasActiveBindingFor(workspace: string): boolean {
    this.assertLoaded();
    const nowMs = this.now();
    return this.store.tokens.some(
      (t) => t.bound_workspace === workspace && nowMs < t.expires_at,
    );
  }

  /** Diagnostic — token count (used in tests/verdict evidence). */
  size(): number {
    this.assertLoaded();
    return this.store.tokens.length;
  }

  private async sweepExpired(): Promise<void> {
    const nowMs = this.now();
    const before = this.store.tokens.length;
    this.store.tokens = this.store.tokens.filter((t) => nowMs < t.expires_at);
    if (this.store.tokens.length !== before) {
      this.logger?.info("oauth tokens: swept expired", {
        removed: before - this.store.tokens.length,
      });
      await this.writeFile();
    }
  }

  private async writeFile(): Promise<void> {
    const dir = dirname(this.path);
    let dirExists = true;
    try {
      await stat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        dirExists = false;
      } else {
        throw err;
      }
    }
    if (!dirExists) {
      await mkdir(dir, { recursive: true });
    }
    const json = JSON.stringify(this.store, null, 2);
    await writeFile(this.path, json, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(this.path, 0o600);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("TokenStore: load() must be called before use");
    }
  }
}
