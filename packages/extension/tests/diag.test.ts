import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// diag.ts reads CLAUDE_BRIDGE_DEBUG at module-load time into a const, so each
// case must re-import the module after mutating the env var. resetModules()
// clears the module cache; dynamic import re-evaluates the file under the new
// env state.

describe("diag", () => {
  const originalEnv = process.env.CLAUDE_BRIDGE_DEBUG;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_BRIDGE_DEBUG;
    } else {
      process.env.CLAUDE_BRIDGE_DEBUG = originalEnv;
    }
  });

  it("does not call console.log when env var is unset", async () => {
    delete process.env.CLAUDE_BRIDGE_DEBUG;
    const { diag } = await import("../src/diag.js");
    diag("test message");
    diag("test with payload", { foo: "bar" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not call console.log when env var is empty string", async () => {
    process.env.CLAUDE_BRIDGE_DEBUG = "";
    const { diag } = await import("../src/diag.js");
    diag("test message");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not call console.log when env var is 'false'", async () => {
    process.env.CLAUDE_BRIDGE_DEBUG = "false";
    const { diag } = await import("../src/diag.js");
    diag("test message");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("calls console.log with [cb-diag] prefix when env var is '1'", async () => {
    process.env.CLAUDE_BRIDGE_DEBUG = "1";
    const { diag } = await import("../src/diag.js");
    diag("hello");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[cb-diag] hello");
  });

  it("calls console.log with [cb-diag] prefix and payload when env var is '1' and data passed", async () => {
    process.env.CLAUDE_BRIDGE_DEBUG = "1";
    const { diag } = await import("../src/diag.js");
    const payload = { foo: "bar", n: 1 };
    diag("with-payload", payload);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[cb-diag] with-payload", payload);
  });

  it("calls console.log when env var is 'true'", async () => {
    process.env.CLAUDE_BRIDGE_DEBUG = "true";
    const { diag } = await import("../src/diag.js");
    diag("true-case");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("[cb-diag] true-case");
  });
});
