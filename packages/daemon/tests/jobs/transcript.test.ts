import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TranscriptWriter,
  transcriptPath,
  transcriptUri,
} from "../../src/jobs/transcript.js";

const SKIP_UNIX_MODE = process.platform === "win32";

describe("TranscriptWriter — basic ops", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-transcript-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates parent directory on construction (mkdir -p)", async () => {
    // Multi-level subdir that doesn't exist; verify mkdir -p runs.
    // File creation is lazy on some platforms (createWriteStream with
    // flags:"a" doesn't always touch the FS until first write), so we
    // exercise an append to confirm the file path resolves.
    const path = join(dir, "ts", "nested", "j_AAAAAAAAAAAA.jsonl");
    const w = new TranscriptWriter(path);
    expect(existsSync(dirname(path))).toBe(true);
    w.append({ probe: true });
    await w.close();
    expect(existsSync(path)).toBe(true);
  });

  it("append writes one line of JSONL terminated by newline", async () => {
    const path = join(dir, "t.jsonl");
    const w = new TranscriptWriter(path);
    const r = w.append({ hello: "world" });
    await w.close();
    expect(r.written).toBe(true);
    expect(r.truncated).toBe(false);
    const content = readFileSync(path, "utf8");
    expect(content).toBe('{"hello":"world"}\n');
  });

  it("bytesWritten reflects accumulated line bytes", async () => {
    const path = join(dir, "t.jsonl");
    const w = new TranscriptWriter(path);
    w.append({ a: 1 }); // {"a":1}\n = 8 bytes
    w.append({ b: 2 }); // 8 more = 16
    expect(w.bytesWritten).toBe(16);
    await w.close();
  });

  it.skipIf(SKIP_UNIX_MODE)(
    "creates file with mode 0600 (Unix)",
    () => {
      const path = join(dir, "t.jsonl");
      const w = new TranscriptWriter(path);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
      return w.close();
    },
  );

  it.skipIf(SKIP_UNIX_MODE)(
    "creates parent directory with mode 0700 (Unix)",
    () => {
      const path = join(dir, "ts-subdir", "t.jsonl");
      const w = new TranscriptWriter(path);
      const mode = statSync(dirname(path)).mode & 0o777;
      expect(mode).toBe(0o700);
      return w.close();
    },
  );
});

describe("TranscriptWriter — cap behavior", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-tcap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("under cap: append returns written=true", async () => {
    const w = new TranscriptWriter(join(dir, "t.jsonl"), { cap_bytes: 1024 });
    const r = w.append({ msg: "small" });
    expect(r).toEqual({ written: true, truncated: false });
    await w.close();
  });

  it("first exceeding append writes marker, refuses; sets truncated", async () => {
    const path = join(dir, "t.jsonl");
    const w = new TranscriptWriter(path, { cap_bytes: 100 });
    // First append should succeed (it's small)
    w.append({ a: "first" });
    // Second append crafted to exceed
    const big = "x".repeat(200);
    const r = w.append({ big });
    expect(r).toEqual({ written: false, truncated: true });
    expect(w.truncated).toBe(true);
    await w.close();
    // File contains the first line + a marker line
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const marker = JSON.parse(lines[1] ?? "{}") as {
      type: string;
      reason: string;
      bytes_at_cap: number;
    };
    expect(marker.type).toBe("_truncated");
    expect(marker.reason).toBe("transcript_size");
    expect(typeof marker.bytes_at_cap).toBe("number");
  });

  it("subsequent appends after truncation return written=false without writing", async () => {
    const path = join(dir, "t.jsonl");
    const w = new TranscriptWriter(path, { cap_bytes: 50 });
    w.append({ a: "x".repeat(80) }); // forces truncation
    const before = w.bytesWritten;
    const r = w.append({ b: "more" });
    expect(r).toEqual({ written: false, truncated: true });
    expect(w.bytesWritten).toBe(before); // no growth
    await w.close();
  });

  it("truncated getter reflects state", async () => {
    const w = new TranscriptWriter(join(dir, "t.jsonl"), { cap_bytes: 50 });
    expect(w.truncated).toBe(false);
    w.append({ a: "x".repeat(80) });
    expect(w.truncated).toBe(true);
    await w.close();
  });
});

describe("TranscriptWriter — close semantics", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-tclose-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("close() flushes; post-close file reads see all writes", async () => {
    const path = join(dir, "t.jsonl");
    const w = new TranscriptWriter(path);
    w.append({ i: 1 });
    w.append({ i: 2 });
    w.append({ i: 3 });
    await w.close();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[0] ?? "{}") as { i: number }).i).toBe(1);
    expect((JSON.parse(lines[2] ?? "{}") as { i: number }).i).toBe(3);
  });

  it("close() is idempotent (second call resolves without error)", async () => {
    const w = new TranscriptWriter(join(dir, "t.jsonl"));
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
  });
});

describe("transcriptPath / transcriptUri", () => {
  it("transcriptPath uses platform separators", () => {
    const baseDir = join("home", "user", ".claude-bridge");
    const p = transcriptPath("j_AAAAAAAAAAAA", baseDir);
    expect(p).toBe(`${baseDir}${sep}transcripts${sep}j_AAAAAAAAAAAA.jsonl`);
  });

  it("transcriptUri produces a valid file:// URI (round-trip)", () => {
    const p = transcriptPath("j_AAAAAAAAAAAA", tmpdir());
    const uri = transcriptUri(p);
    expect(uri.startsWith("file://")).toBe(true);
    // Round-trip via fileURLToPath gives back the same on-disk path.
    expect(fileURLToPath(uri)).toBe(p);
  });

  it("transcriptUri uses forward slashes (RFC 8089) even on Windows", () => {
    const p = transcriptPath("j_AAAAAAAAAAAA", "C:\\Users\\u\\.claude-bridge");
    const uri = transcriptUri(p);
    // pathToFileURL normalizes: file:///C:/... on Windows; file:///... on Unix
    expect(uri.startsWith("file:///")).toBe(true);
    expect(uri).not.toContain("\\");
  });
});
