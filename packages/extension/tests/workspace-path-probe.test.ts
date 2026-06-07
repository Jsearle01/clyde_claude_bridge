import { describe, it, expect } from "vitest";
import { formatProbeOutput } from "../src/workspace-path-probe.js";

describe("formatProbeOutput (T-P3'-0)", () => {
  it("emits the three URI fields verbatim and untransformed", () => {
    // The exact strings VS Code returned in the live capture (2026-06-07).
    const uri = {
      fsPath: "c:\\Projects\\clyde_claude_bridge",
      path: "/c:/Projects/clyde_claude_bridge",
      toString: () => "file:///c%3A/Projects/clyde_claude_bridge",
    };
    const out = formatProbeOutput(uri);
    // No transformation: each value appears exactly as given, wrapped in <>.
    expect(out).toContain("fsPath      = <c:\\Projects\\clyde_claude_bridge>");
    expect(out).toContain("path        = </c:/Projects/clyde_claude_bridge>");
    expect(out).toContain(
      "toString()  = <file:///c%3A/Projects/clyde_claude_bridge>",
    );
  });

  it("preserves a trailing separator inside the delimiters (diagnosability)", () => {
    const uri = {
      fsPath: "c:\\Projects\\x\\",
      path: "/c:/Projects/x/",
      toString: () => "file:///c%3A/Projects/x/",
    };
    expect(formatProbeOutput(uri)).toContain("fsPath      = <c:\\Projects\\x\\>");
  });

  it("reports 'no workspace folder open' when uri is undefined", () => {
    expect(formatProbeOutput(undefined)).toBe(
      "[cb-path-probe] no workspace folder open",
    );
  });
});
