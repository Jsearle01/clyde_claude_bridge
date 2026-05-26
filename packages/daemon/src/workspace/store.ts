// File-backed workspaces store. Holds the daemon's persistent record of
// which workspace abs_paths the user has explicitly trusted, with the
// stable per-path identifier and metadata. Daemon is the single writer;
// extensions ask for changes via IPC, and the daemon serializes writes.
//
// File location: ~/.claude-bridge/workspaces.json (Unix) or
// %APPDATA%/claude-bridge/workspaces.json (Windows), via paths.ts.
// File mode: 0o600 on Unix; no-op on Windows (matches config/init.ts).
// Whole-file replacement on every write — matches config/init.ts pattern
// (no atomic-via-tmp-rename in the existing codebase; P3 candidate if
// concurrent-write semantics become relevant).
//
// Schema lives at `@claude-bridge/shared` so the wire and the file share
// validators. Version-mismatch on the file format throws a typed error
// rather than corrupting data; the daemon refuses to start in that case.

import { readFile, writeFile, chmod, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  WorkspaceStoreSchema,
  normalizeAbsPath,
  type WorkspaceEntry,
  type WorkspaceStore,
} from "@claude-bridge/shared";
import type { Logger } from "../log/logger.js";

export class WorkspacesStoreVersionUnsupportedError extends Error {
  constructor(
    public readonly path: string,
    public readonly foundVersion: unknown,
  ) {
    super(
      `workspaces.json at ${path} has unsupported version ${String(foundVersion)}; daemon refusing to start to avoid data corruption`,
    );
    this.name = "WorkspacesStoreVersionUnsupportedError";
  }
}

export class WorkspacesStore {
  private store: WorkspaceStore = { version: "1", entries: [] };
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
        // addTrustedEntry.
        this.store = { version: "1", entries: [] };
        this.loaded = true;
        return;
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    const versionField = (parsed as { version?: unknown }).version;
    if (versionField !== "1") {
      throw new WorkspacesStoreVersionUnsupportedError(this.path, versionField);
    }
    // Zod parse (not safeParse) — surface validation errors loud.
    this.store = WorkspaceStoreSchema.parse(parsed);
    this.loaded = true;
    // T-P2-007.5: dedupe case-variant abs_path entries that pre-date the
    // normalization fix. Keeps the earliest-trusted record; rewrites disk.
    await this.dedupeOnLoad();
  }

  findByPath(abs_path: string): WorkspaceEntry | null {
    this.assertLoaded();
    const key = normalizeAbsPath(abs_path);
    return (
      this.store.entries.find((e) => normalizeAbsPath(e.abs_path) === key) ??
      null
    );
  }

  findByIdentifier(identifier: string): WorkspaceEntry | null {
    this.assertLoaded();
    return this.store.entries.find((e) => e.identifier === identifier) ?? null;
  }

  async addTrustedEntry(
    entry: Omit<WorkspaceEntry, "trust_state" | "trusted_at">,
  ): Promise<WorkspaceEntry> {
    this.assertLoaded();
    const trusted_at = new Date().toISOString();
    const full: WorkspaceEntry = {
      ...entry,
      trust_state: "trusted",
      trusted_at,
    };
    this.store.entries.push(full);
    await this.writeFile();
    return full;
  }

  list(): WorkspaceEntry[] {
    this.assertLoaded();
    return [...this.store.entries];
  }

  private async dedupeOnLoad(): Promise<void> {
    const byKey = new Map<string, WorkspaceEntry>();
    const removed: WorkspaceEntry[] = [];

    // Sort ascending by trusted_at so the earliest record claims the key
    // and later duplicates are removed.
    const sorted = [...this.store.entries].sort((a, b) =>
      a.trusted_at.localeCompare(b.trusted_at),
    );

    for (const entry of sorted) {
      const key = normalizeAbsPath(entry.abs_path);
      if (byKey.has(key)) {
        removed.push(entry);
      } else {
        byKey.set(key, entry);
      }
    }

    if (removed.length === 0) {
      return;
    }

    for (const dup of removed) {
      const retained = byKey.get(normalizeAbsPath(dup.abs_path));
      this.logger?.warn("workspaces.json dedupe: removed duplicate entry", {
        abs_path: dup.abs_path,
        identifier: dup.identifier,
        trusted_at: dup.trusted_at,
        retained_identifier: retained?.identifier,
      });
    }

    this.store.entries = Array.from(byKey.values());
    await this.writeFile();
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
      // writeFile's mode is honored only on file creation; explicit chmod
      // removes any dependence on file-existence state. Matches
      // config/init.ts idiom.
      await chmod(this.path, 0o600);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("WorkspacesStore: load() must be called before use");
    }
  }
}
