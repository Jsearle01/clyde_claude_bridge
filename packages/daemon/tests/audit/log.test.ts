import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "@claude-bridge/shared";
import { AuditLog } from "../../src/audit/log.js";

function makeEntry(tool: string): AuditEntry {
  return {
    ts: "2026-01-15T12:00:00.000Z",
    tool,
    input_hash: "sha256:abc",
    allowed: true,
    duration_ms: 1,
    result_bytes: 10,
    request_id: "req_1",
    remote_addr: "tunnel",
  };
}

describe("AuditLog", () => {
  let tempDir: string;
  let auditPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "claude-bridge-audit-"));
    auditPath = join(tempDir, "audit.jsonl");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("appends a single entry as a JSON line (11.a)", async () => {
    const log = new AuditLog(auditPath, 30);
    await log.append(makeEntry("ping"));
    await log.stop();
    const content = await readFile(auditPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as AuditEntry;
    expect(parsed.tool).toBe("ping");
    expect(parsed.allowed).toBe(true);
  });

  it("preserves submission order across concurrent appends (11.b)", async () => {
    const log = new AuditLog(auditPath, 30);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(log.append(makeEntry(`tool${i}`)));
    }
    await Promise.all(promises);
    await log.stop();
    const content = await readFile(auditPath, "utf8");
    const tools = content
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as AuditEntry).tool);
    expect(tools).toEqual(Array.from({ length: 10 }, (_, i) => `tool${i}`));
  });

  it("append's promise resolves only after the entry is flushed (11.c)", async () => {
    const log = new AuditLog(auditPath, 30);
    await log.append(makeEntry("ping"));
    // Read before close() to verify the write is on disk by the time
    // append's promise resolved.
    const content = await readFile(auditPath, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
    await log.stop();
  });

  it("rotates the file when date crosses midnight UTC (11.d)", async () => {
    let stubClock = new Date("2026-01-15T12:00:00Z");
    const log = new AuditLog(auditPath, 30, () => stubClock);
    await log.append(makeEntry("ping1"));
    await log.append(makeEntry("ping2"));
    stubClock = new Date("2026-01-16T00:00:01Z");
    await log.rotate();
    await log.append(makeEntry("ping3"));
    await log.stop();

    const files = await readdir(tempDir);
    expect(files).toContain("audit-2026-01-15.jsonl");
    expect(files).toContain("audit.jsonl");

    const archived = await readFile(
      join(tempDir, "audit-2026-01-15.jsonl"),
      "utf8",
    );
    expect(archived.trim().split("\n")).toHaveLength(2);

    const active = await readFile(auditPath, "utf8");
    const activeLines = active.trim().split("\n");
    expect(activeLines).toHaveLength(1);
    const lastEntry = JSON.parse(activeLines[0] ?? "{}") as AuditEntry;
    expect(lastEntry.tool).toBe("ping3");
  });

  it("pruneOld deletes archives past retention; keeps recent (11.e)", async () => {
    await writeFile(join(tempDir, "audit-2025-12-01.jsonl"), "", {
      mode: 0o600,
    });
    await writeFile(join(tempDir, "audit-2026-01-10.jsonl"), "", {
      mode: 0o600,
    });
    await writeFile(join(tempDir, "audit-2026-01-15.jsonl"), "", {
      mode: 0o600,
    });
    const log = new AuditLog(
      auditPath,
      30,
      () => new Date("2026-01-20T00:00:00Z"),
    );
    await log.pruneOld();
    const files = await readdir(tempDir);
    expect(files).not.toContain("audit-2025-12-01.jsonl"); // ~50 days
    expect(files).toContain("audit-2026-01-10.jsonl"); // 10 days
    expect(files).toContain("audit-2026-01-15.jsonl"); // 5 days
    await log.stop();
  });

  it("pruneOld ignores non-archive files (11.f)", async () => {
    await writeFile(join(tempDir, "daemon.log"), "log content", {
      mode: 0o600,
    });
    await writeFile(join(tempDir, "config.json"), "{}", { mode: 0o600 });
    await writeFile(join(tempDir, "audit-2025-12-01.jsonl"), "", {
      mode: 0o600,
    });
    const log = new AuditLog(
      auditPath,
      30,
      () => new Date("2026-01-20T00:00:00Z"),
    );
    await log.pruneOld();
    const files = await readdir(tempDir);
    expect(files).toContain("daemon.log");
    expect(files).toContain("config.json");
    expect(files).not.toContain("audit-2025-12-01.jsonl");
    await log.stop();
  });

  it("per-append date guardrail triggers inline rotate (11.g)", async () => {
    let stubClock = new Date("2026-01-15T12:00:00Z");
    const log = new AuditLog(auditPath, 30, () => stubClock);
    await log.append(makeEntry("ping1"));
    stubClock = new Date("2026-01-16T01:00:00Z");
    await log.append(makeEntry("ping2"));
    await log.stop();

    const files = await readdir(tempDir);
    expect(files).toContain("audit-2026-01-15.jsonl");
    expect(files).toContain("audit.jsonl");

    const archived = await readFile(
      join(tempDir, "audit-2026-01-15.jsonl"),
      "utf8",
    );
    const archivedLine = archived.trim();
    expect((JSON.parse(archivedLine) as AuditEntry).tool).toBe("ping1");

    const active = await readFile(auditPath, "utf8");
    const activeLine = active.trim();
    expect((JSON.parse(activeLine) as AuditEntry).tool).toBe("ping2");
  });

  it("stop is idempotent (11.h)", async () => {
    const log = new AuditLog(auditPath, 30);
    await log.append(makeEntry("ping"));
    await log.stop();
    await expect(log.stop()).resolves.toBeUndefined();
  });

  it("stop cancels the midnight timer (11.i)", async () => {
    vi.useFakeTimers();
    try {
      const log = new AuditLog(auditPath, 30);
      log.startMidnightTimer();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await log.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
