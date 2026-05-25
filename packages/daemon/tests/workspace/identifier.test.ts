import { describe, it, expect } from "vitest";
import {
  slugify,
  generateIdentifier,
  IdentifierCollisionError,
} from "../../src/workspace/identifier.js";

describe("slugify (T-P2-003)", () => {
  it("lowercases ASCII folder names", () => {
    expect(slugify("MyProject")).toBe("myproject");
  });

  it("replaces special chars with hyphens and collapses runs", () => {
    expect(slugify("My Project!@#  Name")).toBe("my-project-name");
  });

  it("falls back to 'workspace' for non-ASCII names", () => {
    expect(slugify("プロジェクト")).toBe("workspace");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---abc---")).toBe("abc");
  });

  it("truncates to 32 chars", () => {
    const long = "a".repeat(50);
    const result = slugify(long);
    expect(result.length).toBe(32);
    expect(result).toBe("a".repeat(32));
  });

  it("trims dangling hyphens after truncation", () => {
    const result = slugify("a".repeat(31) + "-extra");
    // Truncates at 32, then strips trailing -.
    expect(result.endsWith("-")).toBe(false);
  });

  it("falls back to 'workspace' for empty input", () => {
    expect(slugify("")).toBe("workspace");
  });
});

describe("generateIdentifier (T-P2-003)", () => {
  it("returns slug-XXXXXX shape on first try when not used", () => {
    const id = generateIdentifier("MyProject", () => false);
    expect(id).toMatch(/^myproject-[0-9a-f]{6}$/);
  });

  it("retries on collision and returns a different suffix", () => {
    let calls = 0;
    const id = generateIdentifier("MyProject", () => {
      calls += 1;
      return calls === 1; // collide once, then accept
    });
    expect(id).toMatch(/^myproject-[0-9a-f]{6}$/);
    expect(calls).toBeGreaterThan(1);
  });

  it("throws IdentifierCollisionError after 4 failed attempts", () => {
    expect(() => generateIdentifier("MyProject", () => true)).toThrow(
      IdentifierCollisionError,
    );
  });

  it("uses 'workspace' fallback slug for non-ASCII folder names", () => {
    const id = generateIdentifier("プロジェクト", () => false);
    expect(id).toMatch(/^workspace-[0-9a-f]{6}$/);
  });
});
