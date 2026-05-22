import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde, getConfigDir } from "../../src/config/paths.js";

function home(): string {
  if (process.platform !== "win32") {
    return process.env.HOME ?? homedir();
  }
  return homedir();
}

describe("expandTilde", () => {
  it("expands leading '~/' to the home directory (12.a)", () => {
    expect(expandTilde("~/foo")).toBe(join(home(), "foo"));
  });

  it("leaves absolute paths unchanged (12.a)", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });

  it("leaves relative paths unchanged (12.a)", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  it("expands bare '~' to the home directory (12.a)", () => {
    expect(expandTilde("~")).toBe(home());
  });

  it("does not expand '~' embedded mid-path (12.a)", () => {
    expect(expandTilde("/path/with/~/in/middle")).toBe(
      "/path/with/~/in/middle",
    );
  });
});

describe("getConfigDir", () => {
  it.skipIf(process.platform === "win32")(
    "respects HOME env var on Unix (12.b)",
    () => {
      const original = process.env.HOME;
      try {
        process.env.HOME = "/tmp/fake-home";
        expect(getConfigDir()).toBe("/tmp/fake-home/.claude-bridge");
      } finally {
        if (original === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = original;
        }
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "respects APPDATA env var on Windows (12.b)",
    () => {
      const original = process.env.APPDATA;
      try {
        process.env.APPDATA = "C:\\fake-appdata";
        expect(getConfigDir()).toBe(join("C:\\fake-appdata", "claude-bridge"));
      } finally {
        if (original === undefined) {
          delete process.env.APPDATA;
        } else {
          process.env.APPDATA = original;
        }
      }
    },
  );
});
