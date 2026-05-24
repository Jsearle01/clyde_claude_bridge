import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscript,
  assembleReport,
} from "../../src/jobs/report.js";
import type { ReportAssemblyInput } from "../../src/jobs/report.js";
import type {
  Job,
  JobRunState,
} from "../../src/jobs/types.js";
import {
  _setGitAvailableCache,
  _resetGitAvailableCache,
} from "../../src/jobs/snapshot.js";

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "j_AAAAAAAAAAAA",
    workspace_id: "local#test",
    prompt: "do the thing",
    exhibits: [],
    mode: "agentic",
    model: null,
    max_turns: 30,
    working_directory: null,
    enqueued_at: 1000,
    ...overrides,
  };
}

function makeRunState(
  status: JobRunState["status"] = "complete",
): JobRunState {
  let resolveTerminal!: () => void;
  const terminal_promise = new Promise<void>((res) => {
    resolveTerminal = res;
  });
  return {
    status,
    prior_status: "running",
    started_at: 1000,
    terminal_at: 2000,
    partial: null,
    report: null,
    error: null,
    terminal_promise,
    resolve_terminal: resolveTerminal,
    cancel_requested: false,
  };
}

function makeInput(
  overrides: Partial<ReportAssemblyInput> = {},
): ReportAssemblyInput {
  return {
    job: makeJob(),
    run_state: makeRunState(),
    before_snapshot: null,
    after_snapshot: null,
    transcript_path: null,
    transcript_writer_truncated: false,
    error: null,
    duration_ms: 1000,
    turns_cap: 30,
    workspace_root: tmpdir(),
    ...overrides,
  };
}

// ---- parseTranscript ----

describe("parseTranscript — basic shapes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-report-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(content: string): string {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, content);
    return path;
  }

  it("empty file → zeros + empty summary", async () => {
    const d = await parseTranscript(writeTranscript(""));
    expect(d.turns).toBe(0);
    expect(d.tool_calls_made).toBe(0);
    expect(d.summary).toBe("");
    expect(d.shell_commands).toEqual([]);
    expect(d.parse_errors).toBe(0);
  });

  it("non-existent file → empty digest", async () => {
    const d = await parseTranscript(join(dir, "nope.jsonl"));
    expect(d.turns).toBe(0);
  });

  it("single user message: turns=0, summary empty", async () => {
    const d = await parseTranscript(
      writeTranscript(jsonl([{ type: "user", content: "hi" }])),
    );
    expect(d.turns).toBe(0);
    expect(d.summary).toBe("");
  });

  it("user → assistant text: turns=1, summary = text (content as array)", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          { type: "user", content: "hi" },
          {
            type: "assistant",
            content: [{ type: "text", text: "hello back" }],
          },
        ]),
      ),
    );
    expect(d.turns).toBe(1);
    expect(d.summary).toBe("hello back");
  });

  it("content as string (not array): handled", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          { type: "user", content: "hi" },
          { type: "assistant", content: "stringy response" },
        ]),
      ),
    );
    expect(d.summary).toBe("stringy response");
  });

  it("user → assistant tool_use → tool_result → assistant text: skips tool turn", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          { type: "user", content: "list" },
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
            ],
          },
          {
            type: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
          },
          {
            type: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ]),
      ),
    );
    expect(d.turns).toBe(2);
    expect(d.tool_calls_made).toBe(1);
    expect(d.summary).toBe("done");
    expect(d.shell_commands).toEqual([{ cmd: "ls", exit_code: null }]);
  });

  it("backward walk skips tool-use-only final assistant message", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          { type: "assistant", content: [{ type: "text", text: "earlier text" }] },
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "echo" } },
            ],
          },
        ]),
      ),
    );
    expect(d.summary).toBe("earlier text");
  });
});

describe("parseTranscript — shell_commands extraction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-report-sh-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(content: string): string {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, content);
    return path;
  }

  it("bash tool_use with exit_code in result text: extracted", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "ls /tmp" } },
            ],
          },
          {
            type: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "text", text: "file1\nfile2\nexit code: 0" }],
              },
            ],
          },
        ]),
      ),
    );
    expect(d.shell_commands).toEqual([{ cmd: "ls /tmp", exit_code: 0 }]);
  });

  it("bash tool_use without exit_code: null", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "pwd" } },
            ],
          },
          {
            type: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "/home" }],
          },
        ]),
      ),
    );
    expect(d.shell_commands[0]?.exit_code).toBeNull();
  });

  it("command > 512 chars: truncated", async () => {
    const long = "x".repeat(800);
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: long } },
            ],
          },
        ]),
      ),
    );
    expect(d.shell_commands[0]?.cmd.length).toBe(512);
  });

  it("case-variant name (Bash, BASH): matched", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          {
            type: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } },
              { type: "tool_use", id: "t2", name: "BASH", input: { command: "b" } },
            ],
          },
        ]),
      ),
    );
    expect(d.shell_commands).toHaveLength(2);
  });

  it("non-bash tool_use: counted but not in shell_commands", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          {
            type: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "WebSearch",
                input: { query: "foo" },
              },
            ],
          },
        ]),
      ),
    );
    expect(d.tool_calls_made).toBe(1);
    expect(d.shell_commands).toEqual([]);
  });
});

describe("parseTranscript — fail-soft", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-report-fs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(content: string): string {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, content);
    return path;
  }

  it("malformed JSON: parse_errors increments, surrounding lines parsed", async () => {
    const content =
      JSON.stringify({ type: "user", content: "hi" }) +
      "\n{ this is not valid json\n" +
      JSON.stringify({ type: "assistant", content: "ok" }) +
      "\n";
    const d = await parseTranscript(writeTranscript(content));
    expect(d.parse_errors).toBe(1);
    expect(d.turns).toBe(1);
    expect(d.summary).toBe("ok");
  });

  it("missing type field: parse_errors increments", async () => {
    const d = await parseTranscript(
      writeTranscript(jsonl([{ content: "no type" }])),
    );
    expect(d.parse_errors).toBe(1);
  });

  it("_truncated marker: sets transcript_truncation_reason", async () => {
    const d = await parseTranscript(
      writeTranscript(
        jsonl([
          { type: "assistant", content: "before" },
          { type: "_truncated", reason: "transcript_size", bytes_at_cap: 1024 },
        ]),
      ),
    );
    expect(d.transcript_truncation_reason).toBe("transcript_size");
    expect(d.summary).toBe("before");
  });
});

describe("parseTranscript — summary cap", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-report-cap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("summary > 2000 chars: truncated with marker", async () => {
    const long = "x".repeat(3000);
    const path = join(dir, "t.jsonl");
    writeFileSync(path, JSON.stringify({ type: "assistant", content: long }) + "\n");
    const d = await parseTranscript(path);
    expect(d.summary.length).toBeGreaterThan(2000); // 2000 + " ... <truncated>"
    expect(d.summary.endsWith("<truncated>")).toBe(true);
    expect(d.summary.slice(0, 2000)).toBe("x".repeat(2000));
  });
});

// ---- assembleReport ----

describe("assembleReport — integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-asm-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(content: object[]): string {
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, jsonl(content));
    return path;
  }

  it("complete + transcript + no snapshots: report has summary + empty files", async () => {
    const path = writeTranscript([
      { type: "assistant", content: "all done" },
    ]);
    const r = await assembleReport(
      makeInput({ transcript_path: path }),
    );
    expect(r.status).toBe("complete");
    expect(r.summary).toBe("all done");
    expect(r.files_created).toEqual([]);
    expect(r.transcript_uri.startsWith("file://")).toBe(true);
  });

  it("failed status + error: summary uses stub including error message", async () => {
    const r = await assembleReport(
      makeInput({
        run_state: makeRunState("failed"),
        error: {
          category: "sdk_runtime",
          message: "exploded",
          details: null,
        },
      }),
    );
    expect(r.status).toBe("failed");
    expect(r.summary).toContain("exploded");
    expect(r.error?.message).toBe("exploded");
  });

  it("cancelled + no transcript + no snapshots: stub summary, empty fields", async () => {
    const r = await assembleReport(
      makeInput({
        run_state: makeRunState("cancelled"),
        error: { category: "cancelled", message: "user", details: null },
      }),
    );
    expect(r.status).toBe("cancelled");
    expect(r.summary).toBe("<cancelled mid-turn>");
    expect(r.files_created).toEqual([]);
    expect(r.transcript_uri).toBe("");
  });
});

describe("assembleReport — truncation precedence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-asm-trunc-"));
    _setGitAvailableCache(false);
  });

  afterEach(() => {
    _resetGitAvailableCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscriptWithTurns(n: number): string {
    const lines: object[] = [];
    for (let i = 0; i < n; i++) {
      lines.push({ type: "assistant", content: `turn ${i}` });
    }
    const path = join(dir, "t.jsonl");
    writeFileSync(path, jsonl(lines));
    return path;
  }

  it("turns >= turns_cap → max_turns", async () => {
    const path = writeTranscriptWithTurns(5);
    const r = await assembleReport(
      makeInput({ transcript_path: path, turns_cap: 5 }),
    );
    expect(r.truncated).toBe(true);
    expect(r.truncation_reason).toBe("max_turns");
  });

  it("transcript_writer_truncated → transcript_size", async () => {
    const r = await assembleReport(
      makeInput({ transcript_writer_truncated: true }),
    );
    expect(r.truncation_reason).toBe("transcript_size");
  });

  it("timeout error overrides max_turns + transcript_size", async () => {
    const path = writeTranscriptWithTurns(10);
    const r = await assembleReport(
      makeInput({
        run_state: makeRunState("failed"),
        transcript_path: path,
        transcript_writer_truncated: true,
        error: { category: "timeout", message: "out", details: null },
        turns_cap: 5,
      }),
    );
    expect(r.truncation_reason).toBe("timeout");
  });

  it("max_turns overrides transcript_size + workspace_size", async () => {
    const path = writeTranscriptWithTurns(10);
    const r = await assembleReport(
      makeInput({
        transcript_path: path,
        transcript_writer_truncated: true,
        turns_cap: 5,
      }),
    );
    expect(r.truncation_reason).toBe("max_turns");
  });

  it("no truncation: flag false, reason null", async () => {
    const r = await assembleReport(makeInput());
    expect(r.truncated).toBe(false);
    expect(r.truncation_reason).toBeNull();
  });
});
