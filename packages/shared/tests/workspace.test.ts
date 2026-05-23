import { describe, it, expect } from "vitest";
import { WorkspaceConfigSchema, type WorkspaceConfig } from "../src/index.js";

describe("WorkspaceConfigSchema", () => {
  it("parses a fully-populated workspace config", () => {
    const result: WorkspaceConfig = WorkspaceConfigSchema.parse({
      id: "local#default",
      abs_path: "/home/user/projects/repo",
      default_mode: "read_only",
    });
    expect(result.id).toBe("local#default");
    expect(result.abs_path).toBe("/home/user/projects/repo");
    expect(result.default_mode).toBe("read_only");
  });

  it("defaults default_mode to agentic when omitted", () => {
    const result = WorkspaceConfigSchema.parse({
      id: "w",
      abs_path: "/a",
    });
    expect(result.default_mode).toBe("agentic");
  });

  it("rejects empty id", () => {
    expect(
      WorkspaceConfigSchema.safeParse({ id: "", abs_path: "/a" }).success,
    ).toBe(false);
  });

  it("rejects missing abs_path", () => {
    expect(WorkspaceConfigSchema.safeParse({ id: "w" }).success).toBe(false);
  });

  it("rejects invalid default_mode", () => {
    expect(
      WorkspaceConfigSchema.safeParse({
        id: "w",
        abs_path: "/a",
        default_mode: "fancy",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown extra fields (.strict())", () => {
    expect(
      WorkspaceConfigSchema.safeParse({
        id: "w",
        abs_path: "/a",
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts ids that would not pass a strict format regex (boundary-only enforcement)", () => {
    // Decision A: format checks live in the registry, not the schema.
    expect(
      WorkspaceConfigSchema.safeParse({ id: "anything goes #", abs_path: "/a" })
        .success,
    ).toBe(true);
  });
});
