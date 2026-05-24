// Diff computation between two workspace snapshots. Per Decision 2,
// T-P1-007: when both snapshots come from the same git HEAD, shell out
// to `git diff HEAD -- <text-paths>`. Otherwise fall back to per-file
// unified diffs via the `diff` npm package.
//
// Binary files appear in files_created/_modified/_deleted but are excluded
// from the textual diff. `binary_files_changed` counts how many changed.
//
// 256KB total diff cap. Truncation flag set. If either input snapshot was
// truncated, the result inherits `truncated: true` with
// `truncation_reason: "workspace_size"`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { createPatch } from "diff";
import type { WorkspaceSnapshot, FileEntry } from "./snapshot.js";

const execFileAsync = promisify(execFile);

const DEFAULT_DIFF_CAP_BYTES = 256 * 1024;
const GIT_DIFF_BUFFER = 16 * 1024 * 1024;
// Approximate cap on combined path-argument length per `git diff` invocation.
// Conservative — Windows command line is ~32K, Unix typically 128K. Chunking
// keeps us well under either.
const GIT_DIFF_PATHS_CHUNK_BYTES = 8 * 1024;

export interface DiffResult {
  files_created: string[];
  files_modified: string[];
  files_deleted: string[];
  diff: string;
  diff_truncated: boolean;
  binary_files_changed: number;
  truncated: boolean;
  truncation_reason: string | null;
}

export interface DiffOptions {
  diffCapBytes?: number;
}

interface Categorized {
  created_text: string[];
  modified_text: string[];
  deleted_text: string[];
  created_bin: string[];
  modified_bin: string[];
  deleted_bin: string[];
}

function categorize(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): Categorized {
  const created_text: string[] = [];
  const modified_text: string[] = [];
  const deleted_text: string[] = [];
  const created_bin: string[] = [];
  const modified_bin: string[] = [];
  const deleted_bin: string[] = [];

  for (const [path, afterEntry] of after.files) {
    const beforeEntry = before.files.get(path);
    if (beforeEntry === undefined) {
      (afterEntry.is_binary ? created_bin : created_text).push(path);
    } else if (changed(beforeEntry, afterEntry)) {
      (afterEntry.is_binary || beforeEntry.is_binary ? modified_bin : modified_text).push(path);
    }
  }
  for (const [path, beforeEntry] of before.files) {
    if (!after.files.has(path)) {
      (beforeEntry.is_binary ? deleted_bin : deleted_text).push(path);
    }
  }
  return { created_text, modified_text, deleted_text, created_bin, modified_bin, deleted_bin };
}

function changed(a: FileEntry, b: FileEntry): boolean {
  if (a.is_binary !== b.is_binary) return true;
  if (a.is_binary) return a.size !== b.size; // hash empty for binaries; size proxy
  return a.hash !== b.hash;
}

async function readFileSafe(fullPath: string): Promise<string> {
  try {
    return await fsp.readFile(fullPath, "utf8");
  } catch {
    return "";
  }
}

async function gitDiffSubset(
  workspaceRoot: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) return "";
  // Chunk paths to avoid command-line length limits.
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const p of paths) {
    const pBytes = Buffer.byteLength(p) + 1;
    if (currentBytes + pBytes > GIT_DIFF_PATHS_CHUNK_BYTES && current.length > 0) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(p);
    currentBytes += pBytes;
  }
  if (current.length > 0) chunks.push(current);

  let out = "";
  for (const chunk of chunks) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "HEAD", "--", ...chunk],
        { cwd: workspaceRoot, maxBuffer: GIT_DIFF_BUFFER },
      );
      out += stdout;
    } catch {
      // git failed for this chunk; skip and continue.
    }
  }
  return out;
}

async function fallbackDiff(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  workspaceRoot: string,
  textPaths: { created: string[]; modified: string[]; deleted: string[] },
): Promise<string> {
  // Use `diff` package's createPatch for unified diffs. For deleted files,
  // we have no after-content; for created, no before-content. The before
  // contents for modified/deleted are NOT recoverable from the snapshot
  // (we only stored hashes); use git if it's a git repo, else show
  // creation/deletion markers without diff bodies.
  // P1 limitation: full content of pre-modification files isn't kept in
  // the snapshot. Phase 8 readers should understand that the fallback
  // diff path produces less-precise output than the git path.
  let out = "";
  for (const path of textPaths.created) {
    const full = join(workspaceRoot, path);
    const content = await readFileSafe(full);
    out += createPatch(path, "", content, "(deleted)", "(after)") + "\n";
  }
  for (const path of textPaths.modified) {
    const full = join(workspaceRoot, path);
    const content = await readFileSafe(full);
    // We only have post-state. Render as a creation-style diff so the
    // file shows up in the output; before-content is unknown.
    out += createPatch(path, "", content, "(before unavailable)", "(after)") + "\n";
  }
  for (const path of textPaths.deleted) {
    out += `--- a/${path}\n+++ /dev/null\n@@ deleted @@\n`;
  }
  // Reference unused params for lint
  void before;
  void after;
  return out;
}

export async function computeDiff(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  workspaceRoot: string,
  opts: DiffOptions = {},
): Promise<DiffResult> {
  const cap = opts.diffCapBytes ?? DEFAULT_DIFF_CAP_BYTES;
  const cat = categorize(before, after);

  const files_created = [...cat.created_text, ...cat.created_bin].sort();
  const files_modified = [...cat.modified_text, ...cat.modified_bin].sort();
  const files_deleted = [...cat.deleted_text, ...cat.deleted_bin].sort();
  const binary_files_changed =
    cat.created_bin.length + cat.modified_bin.length + cat.deleted_bin.length;

  // Choose diff path. Git path requires both snapshots to be from the
  // same git repo + same HEAD (so the diff is well-defined as
  // `git diff HEAD`).
  const useGitPath =
    before.is_git_repo &&
    after.is_git_repo &&
    before.git_head !== null &&
    before.git_head === after.git_head;

  const textPathsForDiff = {
    created: cat.created_text,
    modified: cat.modified_text,
    deleted: cat.deleted_text,
  };

  let diff = useGitPath
    ? await gitDiffSubset(workspaceRoot, [
        ...textPathsForDiff.created,
        ...textPathsForDiff.modified,
        ...textPathsForDiff.deleted,
      ])
    : await fallbackDiff(before, after, workspaceRoot, textPathsForDiff);

  let diff_truncated = false;
  if (Buffer.byteLength(diff, "utf8") > cap) {
    // Truncate by byte length; final character may be mid-codepoint but
    // the JSONL transcript is byte-oriented anyway.
    const buf = Buffer.from(diff, "utf8");
    diff = buf.subarray(0, cap).toString("utf8");
    diff_truncated = true;
  }

  // Normalize line endings to LF (canonical for cross-platform).
  diff = diff.replace(/\r\n/g, "\n");

  const truncated = before.truncated || after.truncated;
  const truncation_reason = truncated ? "workspace_size" : null;

  return {
    files_created,
    files_modified,
    files_deleted,
    diff,
    diff_truncated,
    binary_files_changed,
    truncated,
    truncation_reason,
  };
}
