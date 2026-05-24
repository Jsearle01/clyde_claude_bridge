import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  takeSnapshot,
  _setGitAvailableCache,
  _resetGitAvailableCache,
  type WorkspaceSnapshot,
} from "../../src/jobs/snapshot.js";
import { computeDiff } from "../../src/jobs/diff.js";

describe("computeDiff — basic categorization", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-diff-"));
    _setGitAvailableCache(false); // force fallback path for determinism
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("identical snapshots → all arrays empty, diff empty", async () => {
    writeFileSync(join(dir, "a.txt"), "stable");
    const before = await takeSnapshot("w", dir);
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    expect(r.files_created).toEqual([]);
    expect(r.files_modified).toEqual([]);
    expect(r.files_deleted).toEqual([]);
    expect(r.diff).toBe("");
    expect(r.binary_files_changed).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("created file → files_created + diff contains it", async () => {
    const before = await takeSnapshot("w", dir);
    writeFileSync(join(dir, "new.txt"), "hello\n");
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    expect(r.files_created).toContain("new.txt");
    expect(r.diff).toContain("new.txt");
  });

  it("deleted file → files_deleted + diff contains deletion marker", async () => {
    writeFileSync(join(dir, "gone.txt"), "x");
    const before = await takeSnapshot("w", dir);
    unlinkSync(join(dir, "gone.txt"));
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    expect(r.files_deleted).toContain("gone.txt");
    expect(r.diff).toContain("gone.txt");
  });

  it("modified file → files_modified populated", async () => {
    writeFileSync(join(dir, "mod.txt"), "v1");
    const before = await takeSnapshot("w", dir);
    writeFileSync(join(dir, "mod.txt"), "v2");
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    expect(r.files_modified).toContain("mod.txt");
  });
});

describe("computeDiff — binary handling", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-diff-bin-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("binary file added → counted in binary_files_changed + files_created; not in diff text", async () => {
    const before = await takeSnapshot("w", dir);
    const buf = Buffer.from([0x01, 0x00, 0x02, 0x00, 0x03]); // null bytes → binary
    writeFileSync(join(dir, "img.bin"), buf);
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    expect(r.files_created).toContain("img.bin");
    expect(r.binary_files_changed).toBe(1);
    expect(r.diff).not.toContain("img.bin"); // binaries excluded from diff text
  });
});

describe("computeDiff — cap behavior", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-diff-cap-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("diff exceeds cap → truncated to cap bytes; diff_truncated true", async () => {
    const before = await takeSnapshot("w", dir);
    // Create a moderately large text file so the fallback diff exceeds 512.
    writeFileSync(join(dir, "big.txt"), "x".repeat(5000) + "\n");
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir, { diffCapBytes: 512 });
    expect(r.diff_truncated).toBe(true);
    expect(Buffer.byteLength(r.diff, "utf8")).toBeLessThanOrEqual(512);
  });
});

describe("computeDiff — truncation propagation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-diff-trunc-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("if either snapshot is truncated, result inherits truncated + workspace_size reason", async () => {
    writeFileSync(join(dir, "a.txt"), "x");
    const after = await takeSnapshot("w", dir);
    // Synthesize a truncated before snapshot.
    const before: WorkspaceSnapshot = {
      workspace_id: "w",
      taken_at: 0,
      files: new Map(),
      is_git_repo: false,
      git_head: null,
      git_status: null,
      truncated: true,
    };
    const r = await computeDiff(before, after, dir);
    expect(r.truncated).toBe(true);
    expect(r.truncation_reason).toBe("workspace_size");
  });
});

describe("computeDiff — line ending normalization", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-diff-le-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("output uses LF even if source contains CRLF", async () => {
    const before = await takeSnapshot("w", dir);
    writeFileSync(join(dir, "crlf.txt"), "line1\r\nline2\r\n");
    const after = await takeSnapshot("w", dir);
    const r = await computeDiff(before, after, dir);
    // Diff output should be LF-normalized.
    expect(r.diff).not.toContain("\r\n");
  });
});
