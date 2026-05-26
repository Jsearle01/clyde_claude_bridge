import { describe, it, expect, afterEach } from "vitest";
import { normalizeAbsPath } from "../src/path.js";

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
});

describe("normalizeAbsPath (T-P2-007.5)", () => {
  it("returns identity on Unix (linux)", () => {
    setPlatform("linux");
    expect(normalizeAbsPath("/Foo/Bar")).toBe("/Foo/Bar");
    expect(normalizeAbsPath("/foo/bar")).toBe("/foo/bar");
  });

  it("returns identity on Unix (darwin)", () => {
    setPlatform("darwin");
    expect(normalizeAbsPath("/Users/Name/Project")).toBe(
      "/Users/Name/Project",
    );
  });

  it("returns lowercase on Windows", () => {
    setPlatform("win32");
    expect(normalizeAbsPath("C:\\Projects\\Clyde")).toBe(
      "c:\\projects\\clyde",
    );
    expect(normalizeAbsPath("c:\\projects\\clyde")).toBe(
      "c:\\projects\\clyde",
    );
  });

  it("is idempotent on Windows and Unix", () => {
    setPlatform("win32");
    const w = "C:\\X\\Y";
    expect(normalizeAbsPath(normalizeAbsPath(w))).toBe(normalizeAbsPath(w));
    setPlatform("linux");
    const u = "/X/Y";
    expect(normalizeAbsPath(normalizeAbsPath(u))).toBe(normalizeAbsPath(u));
  });

  it("handles UNC-style paths on Windows (full-string lowercase)", () => {
    setPlatform("win32");
    expect(normalizeAbsPath("\\\\Server\\Share\\Path")).toBe(
      "\\\\server\\share\\path",
    );
  });

  it("UNC-style paths on Unix return identity", () => {
    setPlatform("linux");
    expect(normalizeAbsPath("\\\\Server\\Share\\Path")).toBe(
      "\\\\Server\\Share\\Path",
    );
  });
});
