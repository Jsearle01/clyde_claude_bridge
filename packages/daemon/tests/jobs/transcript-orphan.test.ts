import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTranscriptOrphans } from "../../src/jobs/transcript-orphan.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 4, 23, 12, 0, 0); // arbitrary fake "now"

function touchFile(path: string, ageMs: number): void {
  writeFileSync(path, "stub");
  const sec = (NOW - ageMs) / 1000;
  utimesSync(path, sec, sec);
}

describe("scanTranscriptOrphans", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-orphan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = { now: (): number => NOW };

  it("non-existent dir returns zero result, no error", async () => {
    const r = await scanTranscriptOrphans(join(dir, "nope"), opts);
    expect(r).toEqual({
      scanned: 0,
      left_alone: 0,
      renamed: 0,
      deleted: 0,
      errors: 0,
    });
  });

  it("empty dir returns zero result", async () => {
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.scanned).toBe(0);
  });

  it("file <24h: left alone", async () => {
    const path = join(dir, "j_AAAAAAAAAAAA.jsonl");
    touchFile(path, 1 * HOUR);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.left_alone).toBe(1);
    expect(r.renamed).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("file 24h-30d: renamed to .orphan.jsonl", async () => {
    const path = join(dir, "j_BBBBBBBBBBBB.jsonl");
    touchFile(path, 5 * DAY);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.renamed).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, "j_BBBBBBBBBBBB.orphan.jsonl"))).toBe(true);
  });

  it("file >30d: deleted", async () => {
    const path = join(dir, "j_CCCCCCCCCCCC.jsonl");
    touchFile(path, 31 * DAY);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.deleted).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it(".orphan.jsonl <30d: left alone", async () => {
    const path = join(dir, "j_DDDDDDDDDDDD.orphan.jsonl");
    touchFile(path, 5 * DAY);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.left_alone).toBe(1);
    expect(existsSync(path)).toBe(true);
  });

  it(".orphan.jsonl >30d: deleted", async () => {
    const path = join(dir, "j_EEEEEEEEEEEE.orphan.jsonl");
    touchFile(path, 31 * DAY);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.deleted).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("non-conforming filename: left alone, counted in left_alone", async () => {
    const path = join(dir, "some-user-file.txt");
    touchFile(path, 100 * DAY); // even very old
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.left_alone).toBe(1);
    expect(r.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("mixed: each tier handled correctly in one scan", async () => {
    touchFile(join(dir, "j_RECENTAAAAAA.jsonl"), 1 * HOUR); // left
    touchFile(join(dir, "j_OLDXXXXXXXXX.jsonl"), 5 * DAY); // renamed
    touchFile(join(dir, "j_ANCIENTAAAAA.jsonl"), 60 * DAY); // deleted
    touchFile(join(dir, "j_KEEPABCDEFGH.orphan.jsonl"), 5 * DAY); // left
    touchFile(join(dir, "j_DROPABCDEFGH.orphan.jsonl"), 60 * DAY); // deleted
    touchFile(join(dir, "README.txt"), 100 * DAY); // left (non-conforming)
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.scanned).toBe(6);
    expect(r.left_alone).toBe(3); // recent legit + recent orphan + non-conforming
    expect(r.renamed).toBe(1);
    expect(r.deleted).toBe(2);
    expect(r.errors).toBe(0);
  });

  it("rename failure (target dir is a regular file collision) → errors increments, scan continues", async () => {
    // Set up: a legitimate-name file aged into rename territory, AND a
    // pre-existing file with the orphan target name — rename will fail.
    touchFile(join(dir, "j_ZZZZZZZZZZZZ.jsonl"), 5 * DAY);
    // Pre-existing collision target (different platforms react differently
    // to rename onto existing; we just need rename to fail).
    mkdirSync(join(dir, "j_ZZZZZZZZZZZZ.orphan.jsonl"));
    // Plus a normal file that should still scan fine.
    touchFile(join(dir, "j_AAAAAAAAAAAA.jsonl"), 1 * HOUR);
    const r = await scanTranscriptOrphans(dir, opts);
    expect(r.scanned).toBeGreaterThanOrEqual(2);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    // The healthy file is still left alone
    expect(r.left_alone).toBeGreaterThanOrEqual(1);
  });
});
