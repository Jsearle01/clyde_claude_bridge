// T-P3-001: OAuth DCR clients store. Holds the daemon's persistent record
// of dynamically-registered OAuth clients with bcryptjs-hashed secrets
// (Decision a). Daemon is the single writer.
//
// File location: ~/.claude-bridge/clients.json (Unix) or
// %APPDATA%/claude-bridge/clients.json (Windows), via paths.ts.
// File mode: 0o600 on Unix; no-op on Windows (CC-3).
// Whole-file replacement per write — matches the workspace store pattern.
//
// Schema lives at `@claude-bridge/shared` so the wire and the file share
// validators. Version-mismatch on the file format throws a typed error
// rather than corrupting data; the daemon refuses to start in that case.
//
// SECURITY INVARIANT: plaintext `client_secret` is NEVER stored, logged,
// or echoed anywhere except the one-time DCR response body. `addClient`
// accepts the plaintext, hashes it via bcryptjs, persists the hash, and
// the caller is responsible for never persisting the plaintext.

import { readFile, writeFile, chmod, mkdir, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import {
  OAuthClientsStoreSchema,
  type OAuthClientRecord,
  type OAuthClientsStore,
} from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";

// bcryptjs cost factor. 10 is the library default and a reasonable
// balance between hash time (~70-100ms on a modern laptop) and security.
// Adjust upward when consumer-hardware speed catches up.
const BCRYPT_COST = 10;

// `client_id` prefix per Decision b. Greppable; self-identifying; matches
// the `cb_live_` Bearer-token convention used elsewhere in the codebase.
const CLIENT_ID_PREFIX = "cb_client_";
const CLIENT_ID_RANDOM_BYTES = 16; // 32 hex chars after prefix

// `client_secret` size per Decision b. 32 random bytes = 64 hex chars,
// stored only as a bcryptjs hash on disk.
const CLIENT_SECRET_RANDOM_BYTES = 32;

export class ClientsStoreVersionUnsupportedError extends Error {
  constructor(
    public readonly path: string,
    public readonly foundVersion: unknown,
  ) {
    super(
      `clients.json at ${path} has unsupported version ${String(foundVersion)}; daemon refusing to start to avoid data corruption`,
    );
    this.name = "ClientsStoreVersionUnsupportedError";
  }
}

export function generateClientId(): string {
  return CLIENT_ID_PREFIX + randomBytes(CLIENT_ID_RANDOM_BYTES).toString("hex");
}

export function generateClientSecret(): string {
  return randomBytes(CLIENT_SECRET_RANDOM_BYTES).toString("hex");
}

export class ClientsStore {
  private store: OAuthClientsStore = { version: "1", clients: [] };
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First start: empty in-memory store. File is created on first
        // addClient.
        this.store = { version: "1", clients: [] };
        this.loaded = true;
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    const versionField = (parsed as { version?: unknown }).version;
    if (versionField !== "1") {
      throw new ClientsStoreVersionUnsupportedError(this.path, versionField);
    }
    this.store = OAuthClientsStoreSchema.parse(parsed);
    this.loaded = true;
  }

  findByClientId(client_id: string): OAuthClientRecord | null {
    this.assertLoaded();
    return (
      this.store.clients.find((c) => c.client_id === client_id) ?? null
    );
  }

  list(): OAuthClientRecord[] {
    this.assertLoaded();
    return [...this.store.clients];
  }

  /**
   * Register a new client. Generates a fresh `client_id` + plaintext
   * `client_secret`, hashes the secret via bcryptjs, persists the hash,
   * and returns the plaintext secret to the caller for one-time return
   * in the DCR response body. The plaintext is NOT stored.
   *
   * Callers must NOT log the returned plaintext or persist it anywhere
   * else.
   */
  async addClient(args: {
    client_name: string;
    redirect_uris: string[];
  }): Promise<{ record: OAuthClientRecord; client_secret_plaintext: string }> {
    this.assertLoaded();
    const client_id = generateClientId();
    const client_secret_plaintext = generateClientSecret();
    const client_secret_hash = await bcrypt.hash(
      client_secret_plaintext,
      BCRYPT_COST,
    );
    const record: OAuthClientRecord = {
      client_id,
      client_secret_hash,
      client_name: args.client_name,
      redirect_uris: args.redirect_uris,
      created_at: new Date().toISOString(),
    };
    this.store.clients.push(record);
    await this.writeFile();
    return { record, client_secret_plaintext };
  }

  /**
   * Verify a plaintext secret against the stored hash for the given
   * client_id. Returns false on unknown client or hash mismatch. Used by
   * the token endpoint (T-P3-004) — not by this task's DCR or metadata
   * paths.
   */
  async verifyClientSecret(
    client_id: string,
    client_secret_plaintext: string,
  ): Promise<boolean> {
    this.assertLoaded();
    const record = this.findByClientId(client_id);
    if (record === null) return false;
    return bcrypt.compare(client_secret_plaintext, record.client_secret_hash);
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
      throw new Error("ClientsStore: load() must be called before use");
    }
  }
}
