import { describe, it, expect } from "vitest";
import {
  ExhibitSchema,
  ShellCommandSchema,
  DiagnosticSchema,
  ErrorDetailSchema,
  DelegationReportSchema,
  DelegateInputSchema,
  DelegateOutputSchema,
  PollInputSchema,
  PollOutputSchema,
  CancelInputSchema,
  CancelOutputSchema,
  type DelegationReport,
  type DelegateInput,
} from "../src/index.js";

const validReport: DelegationReport = {
  job_id: "j_AAAAAAAAAAAA",
  workspace_id: "local#default",
  status: "complete",
  summary: "did the thing",
  files_created: ["new.txt"],
  files_modified: [],
  files_deleted: [],
  diff: "",
  diff_truncated: false,
  diagnostics_before: [],
  diagnostics_after: [],
  diagnostics_delta: { added: [], resolved: [] },
  shell_commands: [{ cmd: "ls", exit_code: 0 }],
  tool_calls_made: 2,
  turns: 4,
  duration_ms: 12345,
  truncated: false,
  truncation_reason: null,
  transcript_uri: "file:///tmp/transcripts/j_AAAAAAAAAAAA.jsonl",
  error: null,
};

describe("ExhibitSchema", () => {
  it("accepts path-only", () => {
    expect(ExhibitSchema.safeParse({ path: "a/b.txt" }).success).toBe(true);
  });
  it("accepts path + inline content", () => {
    expect(
      ExhibitSchema.safeParse({ path: "a/b.txt", content: "hi" }).success,
    ).toBe(true);
  });
  it("rejects empty path", () => {
    expect(ExhibitSchema.safeParse({ path: "" }).success).toBe(false);
  });
  it("rejects extra fields", () => {
    expect(
      ExhibitSchema.safeParse({ path: "a", bonus: 1 }).success,
    ).toBe(false);
  });
});

describe("ShellCommandSchema", () => {
  it("accepts non-null exit code", () => {
    expect(
      ShellCommandSchema.safeParse({ cmd: "ls", exit_code: 0 }).success,
    ).toBe(true);
  });
  it("accepts null exit code", () => {
    expect(
      ShellCommandSchema.safeParse({ cmd: "ls", exit_code: null }).success,
    ).toBe(true);
  });
  it("rejects non-integer exit code", () => {
    expect(
      ShellCommandSchema.safeParse({ cmd: "ls", exit_code: 1.5 }).success,
    ).toBe(false);
  });
});

describe("DiagnosticSchema", () => {
  it("accepts a valid diagnostic", () => {
    expect(
      DiagnosticSchema.safeParse({
        path: "src/a.ts",
        line: 3,
        column: 1,
        severity: "warning",
        message: "unused",
        source: "typescript",
      }).success,
    ).toBe(true);
  });
  it("rejects unknown severity", () => {
    expect(
      DiagnosticSchema.safeParse({
        path: "src/a.ts",
        line: 0,
        column: 0,
        severity: "critical",
        message: "x",
        source: "x",
      }).success,
    ).toBe(false);
  });
});

describe("ErrorDetailSchema", () => {
  it("accepts each valid category", () => {
    for (const c of [
      "auth",
      "permission",
      "sdk_runtime",
      "timeout",
      "cancelled",
      "internal",
    ]) {
      expect(
        ErrorDetailSchema.safeParse({
          category: c,
          message: "m",
          details: null,
        }).success,
      ).toBe(true);
    }
  });
  it("rejects unknown category", () => {
    expect(
      ErrorDetailSchema.safeParse({
        category: "nope",
        message: "m",
        details: null,
      }).success,
    ).toBe(false);
  });
});

describe("DelegationReportSchema", () => {
  it("parses a fully-populated complete report", () => {
    const result = DelegationReportSchema.parse(validReport);
    expect(result.job_id).toBe("j_AAAAAAAAAAAA");
    expect(result.status).toBe("complete");
  });

  it("accepts status=cancelled with error populated", () => {
    expect(
      DelegationReportSchema.safeParse({
        ...validReport,
        status: "cancelled",
        error: {
          category: "cancelled",
          message: "user requested",
          details: null,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects non-terminal status in a report (queued/running)", () => {
    expect(
      DelegationReportSchema.safeParse({ ...validReport, status: "running" })
        .success,
    ).toBe(false);
  });

  it("rejects extra top-level fields (.strict())", () => {
    expect(
      DelegationReportSchema.safeParse({ ...validReport, bonus: 1 }).success,
    ).toBe(false);
  });
});

describe("DelegateInputSchema", () => {
  it("accepts minimal input (prompt + workspace; T-P2-007 made workspace required)", () => {
    const ok: DelegateInput = DelegateInputSchema.parse({
      prompt: "hi",
      workspace: "local#default",
    });
    expect(ok.prompt).toBe("hi");
    expect(ok.workspace).toBe("local#default");
  });

  it("rejects input missing workspace field (T-P2-007)", () => {
    expect(DelegateInputSchema.safeParse({ prompt: "hi" }).success).toBe(false);
  });

  it("accepts full input", () => {
    expect(
      DelegateInputSchema.safeParse({
        workspace: "w",
        prompt: "hi",
        exhibits: [{ path: "a", content: "b" }],
        mode: "read_only",
        model: "claude-sonnet-4-6",
        max_turns: 5,
        working_directory: "sub",
      }).success,
    ).toBe(true);
  });

  it("rejects empty prompt", () => {
    expect(
      DelegateInputSchema.safeParse({ prompt: "", workspace: "w" }).success,
    ).toBe(false);
  });

  it("rejects max_turns out of [1, 200]", () => {
    expect(
      DelegateInputSchema.safeParse({
        prompt: "hi",
        workspace: "w",
        max_turns: 0,
      }).success,
    ).toBe(false);
    expect(
      DelegateInputSchema.safeParse({
        prompt: "hi",
        workspace: "w",
        max_turns: 201,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (.strict())", () => {
    expect(
      DelegateInputSchema.safeParse({
        prompt: "hi",
        workspace: "w",
        bonus: 1,
      }).success,
    ).toBe(false);
  });

  it("does NOT enforce a 32KB prompt cap (size policy at handler)", () => {
    const big = "x".repeat(64 * 1024);
    expect(
      DelegateInputSchema.safeParse({ prompt: big, workspace: "w" }).success,
    ).toBe(true);
  });
});

describe("DelegateOutputSchema", () => {
  it("accepts queued response", () => {
    expect(
      DelegateOutputSchema.safeParse({
        job_id: "j_x",
        status: "queued",
        workspace_id: "w",
        queued_position: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects negative queued_position", () => {
    expect(
      DelegateOutputSchema.safeParse({
        job_id: "j_x",
        status: "running",
        workspace_id: "w",
        queued_position: -1,
      }).success,
    ).toBe(false);
  });
});

describe("PollInputSchema", () => {
  it("accepts job_id only", () => {
    expect(PollInputSchema.safeParse({ job_id: "j_x" }).success).toBe(true);
  });
  it("accepts wait_ms within bounds", () => {
    expect(
      PollInputSchema.safeParse({ job_id: "j_x", wait_ms: 30000 }).success,
    ).toBe(true);
  });
  it("rejects wait_ms over 60000", () => {
    expect(
      PollInputSchema.safeParse({ job_id: "j_x", wait_ms: 60001 }).success,
    ).toBe(false);
  });
  it("rejects negative wait_ms", () => {
    expect(
      PollInputSchema.safeParse({ job_id: "j_x", wait_ms: -1 }).success,
    ).toBe(false);
  });
});

describe("PollOutputSchema", () => {
  it("accepts running response with partial + null report", () => {
    expect(
      PollOutputSchema.safeParse({
        job_id: "j_x",
        status: "running",
        queued_position: null,
        report: null,
        partial: { turns_so_far: 1, last_tool: "Bash", elapsed_ms: 100 },
      }).success,
    ).toBe(true);
  });

  it("accepts terminal response with report + null partial", () => {
    expect(
      PollOutputSchema.safeParse({
        job_id: "j_x",
        status: "complete",
        queued_position: null,
        report: validReport,
        partial: null,
      }).success,
    ).toBe(true);
  });
});

describe("CancelInputSchema / CancelOutputSchema", () => {
  it("accepts cancel input", () => {
    expect(CancelInputSchema.safeParse({ job_id: "j_x" }).success).toBe(true);
  });

  it("accepts each cancel result", () => {
    for (const status of ["cancelled", "already_terminal", "not_found"]) {
      expect(
        CancelOutputSchema.safeParse({
          job_id: "j_x",
          status,
          prior_status: status === "not_found" ? null : "running",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown cancel result", () => {
    expect(
      CancelOutputSchema.safeParse({
        job_id: "j_x",
        status: "maybe",
        prior_status: null,
      }).success,
    ).toBe(false);
  });
});
