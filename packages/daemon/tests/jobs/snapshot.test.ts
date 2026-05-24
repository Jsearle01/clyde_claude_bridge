import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  takeSnapshot,
  _resetGitAvailableCache,
  _setGitAvailableCache,
} from "../../src/jobs/snapshot.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = gitAvailable();

function expectedHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("takeSnapshot — non-git workspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-snap-"));
    // Force the non-git path even when git is available so tests are
    // deterministic across hosts.
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty workspace: zero files", async () => {
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.size).toBe(0);
    expect(snap.is_git_repo).toBe(false);
    expect(snap.git_head).toBeNull();
    expect(snap.truncated).toBe(false);
  });

  it("text files: correct hashes and sizes", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    writeFileSync(join(dir, "b.txt"), "world\n");
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.size).toBe(2);
    expect(snap.files.get("a.txt")?.hash).toBe(expectedHash("hello\n"));
    expect(snap.files.get("a.txt")?.is_binary).toBe(false);
    expect(snap.files.get("a.txt")?.size).toBe(6);
    expect(snap.files.get("b.txt")?.hash).toBe(expectedHash("world\n"));
  });

  it("binary file (null byte in first 8KB): marked is_binary, empty hash", async () => {
    const buf = Buffer.concat([
      Buffer.from("text-prefix"),
      Buffer.from([0]),
      Buffer.from("after-null"),
    ]);
    writeFileSync(join(dir, "bin.dat"), buf);
    const snap = await takeSnapshot("w", dir);
    const entry = snap.files.get("bin.dat");
    expect(entry?.is_binary).toBe(true);
    expect(entry?.hash).toBe("");
    expect(entry?.size).toBe(buf.length);
  });

  it(".gitignore patterns respected", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n*.log\n");
    writeFileSync(join(dir, "kept.txt"), "k");
    writeFileSync(join(dir, "ignored.txt"), "i");
    writeFileSync(join(dir, "debug.log"), "l");
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.has("kept.txt")).toBe(true);
    expect(snap.files.has("ignored.txt")).toBe(false);
    expect(snap.files.has("debug.log")).toBe(false);
  });

  it("default-skip dirs (node_modules) excluded regardless of .gitignore", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(dir, "src.js"), "y");
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.has("src.js")).toBe(true);
    expect(snap.files.has("node_modules/pkg/index.js")).toBe(false);
  });

  it("file cap: walk stops, truncated flag set", async () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `f${i}.txt`), "x");
    }
    const snap = await takeSnapshot("w", dir, { fileCap: 5 });
    expect(snap.files.size).toBeLessThanOrEqual(5);
    expect(snap.truncated).toBe(true);
  });

  it("paths in files Map use forward slashes (cross-platform canonical)", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "nested.txt"), "n");
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.has("sub/nested.txt")).toBe(true);
  });
});

describe.skipIf(!GIT_AVAILABLE)("takeSnapshot — git workspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-snap-git-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    _resetGitAvailableCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses git ls-files; populates git_head and git_status", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    writeFileSync(join(dir, "b.txt"), "untracked\n");
    const snap = await takeSnapshot("w", dir);
    expect(snap.is_git_repo).toBe(true);
    expect(snap.files.has("a.txt")).toBe(true);
    expect(snap.files.has("b.txt")).toBe(true); // --others includes untracked
    expect(snap.git_head).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof snap.git_status).toBe("string");
  });

  it("ignored files (via .gitignore) excluded automatically", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "kept.txt"), "k");
    writeFileSync(join(dir, "ignored.txt"), "i");
    const snap = await takeSnapshot("w", dir);
    expect(snap.files.has("kept.txt")).toBe(true);
    expect(snap.files.has("ignored.txt")).toBe(false);
  });
});

describe("takeSnapshot — git unavailable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-snap-nogit-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("even with .git dir present, falls back to non-git path", async () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "file.txt"), "x");
    const snap = await takeSnapshot("w", dir);
    expect(snap.is_git_repo).toBe(false);
    expect(snap.git_head).toBeNull();
    expect(snap.files.has("file.txt")).toBe(true);
  });
});
