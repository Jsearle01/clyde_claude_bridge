import { describe, it, expect } from "vitest";
import { makeGetDiagnosticsTool } from "../../../src/mcp/tools/get_diagnostics.js";
import { ExtensionToolRouter } from "../../../src/mcp/tools/extension-router.js";
import type { ToolContext } from "../../../src/mcp/dispatch.js";
import { expandSeverityThreshold } from "@claude-bridge/shared";
import type { AuditLog } from "../../../src/audit/log.js";
import type { Logger } from "../../../src/log/logger.js";
import type { DaemonState } from "../../../src/state.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  close: () => Promise.resolve(),
};
const stubState: DaemonState = {
  version: "0.1.0",
  startedAt: 0,
  tunnelStatus: "up",
  tunnelUrl: null,
  config: {} as never,
};
function makeCtx(): ToolContext {
  return {
    request_id: "req_gd0000",
    remote_addr: "tunnel",
    auditLog: {} as AuditLog,
    logger: silentLogger,
    state: stubState,
    setAuditMetadata: () => undefined,
  };
}
function singleWorkspace() {
  return {
    list: () => [{ id: "only", abs_path: "/p", default_mode: "agentic" as const }],
    resolve: (id?: string) =>
      id === "only" || id === undefined
        ? { id: "only", abs_path: "/p", default_mode: "agentic" as const }
        : null,
    default: () => null,
  };
}

describe("expandSeverityThreshold", () => {
  it("expands 'error' to a single-element set", () => {
    expect(expandSeverityThreshold("error")).toEqual(["error"]);
  });
  it("expands 'warning' to error+warning", () => {
    expect(expandSeverityThreshold("warning")).toEqual(["error", "warning"]);
  });
  it("expands 'all' to the full four-element set", () => {
    expect(expandSeverityThreshold("all")).toEqual([
      "error",
      "warning",
      "info",
      "hint",
    ]);
  });
});

describe("get_diagnostics tool (T-P2-010)", () => {
  it("default severity is 'all' — sends the full set to the extension", async () => {
    let sentSeverities: string[] | null = null;
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as {
        kind: string;
        request_id: string;
        severities: string[];
      };
      sentSeverities = req.severities;
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_diagnostics_response",
          request_id: req.request_id,
          diagnostics: [],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetDiagnosticsTool({
      registry: singleWorkspace(),
      extensionRouter: router,
    });
    await tool.handler({}, makeCtx());
    expect(sentSeverities).toEqual(["error", "warning", "info", "hint"]);
  });

  it("severity='warning' sends error+warning to the extension", async () => {
    let sentSeverities: string[] | null = null;
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as { request_id: string; severities: string[] };
      sentSeverities = req.severities;
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_diagnostics_response",
          request_id: req.request_id,
          diagnostics: [],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetDiagnosticsTool({
      registry: singleWorkspace(),
      extensionRouter: router,
    });
    await tool.handler({ severity: "warning" }, makeCtx());
    expect(sentSeverities).toEqual(["error", "warning"]);
  });

  it("returns diagnostics list returned by the extension verbatim", async () => {
    const router = new ExtensionToolRouter((_, request) => {
      const req = request as { request_id: string };
      setImmediate(() => {
        router.resolveResponse({
          kind: "get_diagnostics_response",
          request_id: req.request_id,
          diagnostics: [
            {
              uri: "file:///c:/projects/foo.ts",
              fs_path: "c:\\projects\\foo.ts",
              range: {
                start: { line: 1, character: 2 },
                end: { line: 1, character: 5 },
              },
              severity: "error",
              message: "boom",
              source: "typescript",
            },
          ],
        });
      });
      return Promise.resolve();
    });
    const tool = makeGetDiagnosticsTool({
      registry: singleWorkspace(),
      extensionRouter: router,
    });
    const out = await tool.handler({ severity: "error" }, makeCtx());
    expect(out.diagnostics).toHaveLength(1);
    expect(out.diagnostics[0]?.message).toBe("boom");
    expect(out.diagnostics[0]?.source).toBe("typescript");
    expect(out.diagnostics[0]?.severity).toBe("error");
  });

  it("503 extension_offline when extension is unreachable", async () => {
    const router = new ExtensionToolRouter(() =>
      Promise.reject(new Error("no active connection")),
    );
    const tool = makeGetDiagnosticsTool({
      registry: singleWorkspace(),
      extensionRouter: router,
    });
    await expect(tool.handler({}, makeCtx())).rejects.toMatchObject({
      code: 503,
      reason: "extension_offline",
    });
  });

  it("does NOT invoke the approval gate (call-stack bypass — C-13 grep #6)", async () => {
    const src = await import("node:fs/promises").then((f) =>
      f.readFile(
        new URL(
          "../../../src/mcp/tools/get_diagnostics.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/from\s+["'][^"']*approval[^"']*["']/);
    expect(codeOnly).not.toMatch(/ApprovalGate|awaitApprovalForDelegation/);
  });
});
