import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log/logger.js";

interface LogLine {
  ts: string;
  level: string;
  msg: string;
  [key: string]: unknown;
}

function readLogLines(content: string): LogLine[] {
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

describe("Logger", () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-logger-"));
    logPath = join(tempDir, "test.log");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes a basic info line with ts, level, msg, and extras (4.a)", async () => {
    const log = createLogger(logPath, "info");
    log.info("hello", { request_id: "req_1" });
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.level).toBe("info");
    expect(entry?.msg).toBe("hello");
    expect(entry?.request_id).toBe("req_1");
    expect(entry?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("filters entries below the configured level (4.b)", async () => {
    const log = createLogger(logPath, "warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("serializes concurrent writes in submission order (4.c)", async () => {
    const log = createLogger(logPath, "debug");
    for (let i = 0; i < 10; i++) log.info(`line ${i}`);
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(10);
    expect(entries.map((e) => e.msg)).toEqual(
      Array.from({ length: 10 }, (_, i) => `line ${i}`),
    );
  });

  it("merges extra fields at the top level (4.d)", async () => {
    const log = createLogger(logPath, "info");
    log.info("hello", { request_id: "abc", remote_addr: "tunnel" });
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.request_id).toBe("abc");
    expect(entries[0]?.remote_addr).toBe("tunnel");
  });

  it("close() drains all in-flight writes before resolving (4.e)", async () => {
    const log = createLogger(logPath, "info");
    log.info("0");
    log.info("1");
    log.info("2");
    log.info("3");
    log.info("4");
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(5);
  });

  it("extra fields override ts/level/msg on collision — caller wins (4.f)", async () => {
    const log = createLogger(logPath, "info");
    log.info("real-msg", { msg: "override", ts: "fake" });
    await log.close();

    const entries = readLogLines(await readFile(logPath, "utf8"));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.msg).toBe("override");
    expect(entries[0]?.ts).toBe("fake");
  });
});
