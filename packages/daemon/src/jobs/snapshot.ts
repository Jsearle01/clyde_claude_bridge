// Workspace snapshot: point-in-time file enumeration + content hashing
// for diff computation at job completion (Phase 8).
//
// Two enumeration paths per Decision 2, T-P1-007:
//   - Git workspace: `git ls-files --cached --others --exclude-standard`
//     enumerates tracked + untracked-not-ignored files. Cheap; respects
//     .gitignore + .git/info/exclude + global gitignore automatically.
//   - Non-git workspace: filesystem walk with the `ignore` package
//     consuming .gitignore patterns. Plus a hardcoded default-skip set
//     (node_modules, .git, target, dist, build, .next, __pycache__,
//     .venv, .vscode, .idea) that applies regardless of .gitignore.
//
// Git availability is probed once per daemon lifetime (cached via a
// module-level state). Daemon restart re-probes. Tests can clear via
// the `_resetGitAvailableCache()` export.
//
// Binary detection: read first 8KB, search for null byte. Hits report
// is_binary=true with empty hash; misses get streaming sha256 over the
// full file. UTF-16 text files contain regular null bytes — they'll
// report as binary; accepted limitation per Decision 3.
//
// File-count cap: 50000 (Decision 4). Walks stop early; `truncated`
// flag set on the snapshot. Downstream diff propagates the flag.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  createReadStream,
  promises as fsp,
} from "node:fs";
import { join, relative, sep } from "node:path";
// `ignore` is a CJS module whose default export is the factory function.
// Under our TypeScript ESM-interop config the type-side namespace import
// isn't callable; reach through `.default` (with a fallback if a future
// version exposes it directly).
import ignoreNs, { type Ignore } from "ignore";
const ignoreFactory: () => Ignore =
  (ignoreNs as unknown as { default?: () => Ignore }).default ??
  (ignoreNs as unknown as () => Ignore);

const execFileAsync = promisify(execFile);

const DEFAULT_FILE_CAP = 50_000;
const DEFAULT_BINARY_SNIFF_BYTES = 8192;
const GIT_LS_FILES_BUFFER = 32 * 1024 * 1024; // 32MB for very large repos

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  ".vscode",
  ".idea",
]);

export interface FileEntry {
  hash: string;
  size: number;
  is_binary: boolean;
}

export interface WorkspaceSnapshot {
  workspace_id: string;
  taken_at: number;
  files: Map<string, FileEntry>;
  is_git_repo: boolean;
  git_head: string | null;
  git_status: string | null;
  truncated: boolean;
}

export interface SnapshotOptions {
  fileCap?: number;
  binarySniffBytes?: number;
  now?: () => number;
}

// ---- git availability cache ----

let gitAvailableCache: boolean | null = null;

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailableCache !== null) return gitAvailableCache;
  try {
    await execFileAsync("git", ["--version"], { timeout: 5000 });
    gitAvailableCache = true;
  } catch {
    gitAvailableCache = false;
  }
  return gitAvailableCache;
}

/** Test-only escape hatch. Resets the daemon-wide git-availability cache
 * so the next snapshot re-probes. Underscore-prefixed by convention. */
export function _resetGitAvailableCache(): void {
  gitAvailableCache = null;
}

/** Test-only escape hatch. Forces the cached value for deterministic
 * tests that don't want to depend on the host having git installed. */
export function _setGitAvailableCache(value: boolean): void {
  gitAvailableCache = value;
}

// ---- git operations ----

async function isGitRepo(workspaceRoot: string): Promise<boolean> {
  try {
    const s = await fsp.stat(join(workspaceRoot, ".git"));
    return s.isDirectory() || s.isFile(); // submodule .git files also count
  } catch {
    return false;
  }
}

async function getGitFiles(workspaceRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: workspaceRoot, maxBuffer: GIT_LS_FILES_BUFFER },
  );
  // -z gives NUL-separated paths so we don't have to deal with git's
  // quoting of special-char filenames.
  return stdout.split("\0").filter((p) => p.length > 0);
}

async function getGitHead(workspaceRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workspaceRoot, timeout: 5000 },
    );
    return stdout.trim();
  } catch {
    return null; // empty repo, no commits, etc.
  }
}

async function getGitStatus(workspaceRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain"],
      { cwd: workspaceRoot, timeout: 5000 },
    );
    return stdout;
  } catch {
    return null;
  }
}

// ---- non-git walker ----

async function loadGitignoreFor(dir: string): Promise<string[]> {
  try {
    const content = await fsp.readFile(join(dir, ".gitignore"), "utf8");
    return content.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

async function walkNonGit(
  workspaceRoot: string,
  fileCap: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const ig: Ignore = ignoreFactory();
  // Root-level .gitignore loaded upfront; nested ones merged in as walker
  // descends so deeper rules can override.
  ig.add(await loadGitignoreFor(workspaceRoot));

  const files: string[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Merge in this directory's .gitignore (if any) for descendants.
    if (dir !== workspaceRoot) {
      const local = await loadGitignoreFor(dir);
      if (local.length > 0) {
        const relDir = relative(workspaceRoot, dir).split(sep).join("/");
        // Prefix patterns with the relative dir so they apply at the
        // correct scope (ignore package treats them as relative-to-add).
        ig.add(local.map((p) => `${relDir}/${p}`));
      }
    }

    for (const ent of entries) {
      if (truncated) return;
      const name = ent.name;
      const full = join(dir, name);
      const relFromRoot = relative(workspaceRoot, full).split(sep).join("/");
      if (ent.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(name)) continue;
        if (ig.ignores(`${relFromRoot}/`)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        if (ig.ignores(relFromRoot)) continue;
        files.push(relFromRoot);
        if (files.length >= fileCap) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(workspaceRoot);
  return { files, truncated };
}

// ---- per-file ops ----

async function sniffBinary(
  fullPath: string,
  sniffBytes: number,
): Promise<{ is_binary: boolean }> {
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    fh = await fsp.open(fullPath, "r");
    const buf = Buffer.alloc(sniffBytes);
    const { bytesRead } = await fh.read(buf, 0, sniffBytes, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return { is_binary: true };
    }
    return { is_binary: false };
  } finally {
    if (fh !== null) await fh.close();
  }
}

function hashFile(fullPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(fullPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---- public entry point ----

export async function takeSnapshot(
  workspaceId: string,
  workspaceRoot: string,
  opts: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const fileCap = opts.fileCap ?? DEFAULT_FILE_CAP;
  const sniffBytes = opts.binarySniffBytes ?? DEFAULT_BINARY_SNIFF_BYTES;
  const now = opts.now ?? ((): number => Date.now());

  const gitOk = await isGitAvailable();
  const repoIsGit = gitOk && (await isGitRepo(workspaceRoot));

  let relPaths: string[];
  let truncated = false;
  let git_head: string | null = null;
  let git_status: string | null = null;

  if (repoIsGit) {
    relPaths = (await getGitFiles(workspaceRoot)).map((p) =>
      p.split(sep).join("/"),
    );
    if (relPaths.length > fileCap) {
      relPaths = relPaths.slice(0, fileCap);
      truncated = true;
    }
    git_head = await getGitHead(workspaceRoot);
    git_status = await getGitStatus(workspaceRoot);
  } else {
    const r = await walkNonGit(workspaceRoot, fileCap);
    relPaths = r.files;
    truncated = r.truncated;
  }

  const files = new Map<string, FileEntry>();
  for (const relPath of relPaths) {
    const fullPath = join(workspaceRoot, relPath);
    let stats;
    try {
      stats = await fsp.stat(fullPath);
    } catch {
      continue; // file vanished between enum and stat; skip
    }
    if (!stats.isFile()) continue;
    const { is_binary } = await sniffBinary(fullPath, sniffBytes);
    const hash = is_binary ? "" : await hashFile(fullPath);
    files.set(relPath, {
      hash,
      size: stats.size,
      is_binary,
    });
  }

  return {
    workspace_id: workspaceId,
    taken_at: now(),
    files,
    is_git_repo: repoIsGit,
    git_head,
    git_status,
    truncated,
  };
}
