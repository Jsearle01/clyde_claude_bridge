import { describe, it, expect } from "vitest";
import {
  JobStatusSchema,
  PartialProgressSchema,
  TERMINAL_STATUSES,
  isTerminal,
  type PartialProgress,
} from "../src/index.js";

describe("JobStatusSchema", () => {
  it("accepts each defined value", () => {
    for (const s of ["queued", "running", "complete", "failed", "cancelled"]) {
      expect(JobStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown statuses", () => {
    expect(JobStatusSchema.safeParse("running ").success).toBe(false);
    expect(JobStatusSchema.safeParse("done").success).toBe(false);
  });
});

describe("isTerminal / TERMINAL_STATUSES", () => {
  it("treats complete/failed/cancelled as terminal", () => {
    expect(isTerminal("complete")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("treats queued/running as non-terminal", () => {
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });

  it("TERMINAL_STATUSES enumerates exactly the terminal states", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      ["cancelled", "complete", "failed"],
    );
  });
});

describe("PartialProgressSchema", () => {
  it("accepts a valid partial progress record", () => {
    const ok: PartialProgress = PartialProgressSchema.parse({
      turns_so_far: 3,
      last_tool: "Bash",
      elapsed_ms: 12345,
    });
    expect(ok.turns_so_far).toBe(3);
  });

  it("accepts null last_tool", () => {
    expect(
      PartialProgressSchema.safeParse({
        turns_so_far: 0,
        last_tool: null,
        elapsed_ms: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects negative turn counts", () => {
    expect(
      PartialProgressSchema.safeParse({
        turns_so_far: -1,
        last_tool: null,
        elapsed_ms: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields (.strict())", () => {
    expect(
      PartialProgressSchema.safeParse({
        turns_so_far: 0,
        last_tool: null,
        elapsed_ms: 0,
        bonus: 1,
      }).success,
    ).toBe(false);
  });
});
