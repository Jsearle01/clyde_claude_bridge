import { describe, it, expect } from "vitest";
import type { WorkspaceConfig } from "@claude-bridge/shared";
import { StubWorkspaceRegistry } from "../../src/workspace/registry.js";

const cfg: WorkspaceConfig = {
  id: "local#default",
  abs_path: "/home/user/projects/repo",
  default_mode: "agentic",
};

describe("StubWorkspaceRegistry — no workspace configured", () => {
  const r = new StubWorkspaceRegistry(undefined);

  it("resolve() returns null", () => {
    expect(r.resolve()).toBeNull();
  });

  it("resolve(any id) returns null", () => {
    expect(r.resolve("anything")).toBeNull();
  });

  it("list() returns empty array", () => {
    expect(r.list()).toEqual([]);
  });

  it("default() returns null", () => {
    expect(r.default()).toBeNull();
  });
});

describe("StubWorkspaceRegistry — workspace configured", () => {
  const r = new StubWorkspaceRegistry(cfg);

  it("resolve() with no id returns the workspace", () => {
    expect(r.resolve()).toEqual({
      id: cfg.id,
      abs_path: cfg.abs_path,
      default_mode: cfg.default_mode,
    });
  });

  it("resolve(matching id) returns the workspace", () => {
    expect(r.resolve(cfg.id)?.id).toBe(cfg.id);
  });

  it("resolve(non-matching id) returns null", () => {
    expect(r.resolve("other#workspace")).toBeNull();
  });

  it("list() returns single-element array", () => {
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]?.id).toBe(cfg.id);
  });

  it("default() returns the workspace", () => {
    expect(r.default()?.id).toBe(cfg.id);
  });
});
