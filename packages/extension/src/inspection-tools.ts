// T-P2-009 / T-P2-010: extension-side handlers for the daemon's
// inspection-tool requests (get_open_editors, get_diagnostics).
//
// Each handler:
//   - reads VS Code state via the `vscode` namespace
//   - sends the matching response shape back over IPC
//   - on handler failure, sends an extension_tool_error envelope so the
//     daemon-side tool surfaces 502 to the MCP caller (rather than
//     letting the 5s timeout fire)
//
// The handlers are decoupled from IpcClient and vscode so tests can
// inject minimal stubs.

import * as vscode from "vscode";
import type {
  GetOpenEditorsRequest,
  GetDiagnosticsRequest,
  OpenEditor,
  DiagnosticItem,
  DiagnosticSeverityName,
} from "@claude-bridge/shared";

// Minimal IPC sender surface — IpcClient.send fits this shape.
export interface InspectionIpcSender {
  send(message: unknown): void;
}

// VS Code API surface used by the open-editors handler. Defaults to the
// real namespace; tests inject a stub. Only the fields we read are
// modeled so the mock surface stays small.
export interface VsCodeTabsApi {
  tabGroups: {
    all: readonly {
      tabs: readonly {
        input: unknown;
        isActive: boolean;
        isDirty: boolean;
      }[];
    }[];
    activeTabGroup: unknown;
  };
}

// Used to detect "is this tab a real text editor" without depending on
// the runtime `vscode.TabInputText` constructor (which doesn't exist in
// the test mock). The handler checks `input?.uri instanceof vscode.Uri`
// via a duck-typed guard.
function isTextTabInput(
  input: unknown,
): input is { uri: { toString(): string; fsPath: string } } {
  if (input === null || typeof input !== "object") return false;
  const maybeUri = (input as { uri?: unknown }).uri;
  if (maybeUri === null || typeof maybeUri !== "object") return false;
  const u = maybeUri as { toString?: unknown; fsPath?: unknown };
  return typeof u.toString === "function" && typeof u.fsPath === "string";
}

export interface OpenEditorsHandlerDeps {
  tabsApi?: VsCodeTabsApi;
}

export function makeGetOpenEditorsHandler(
  ipcClient: InspectionIpcSender,
  deps: OpenEditorsHandlerDeps = {},
): (request: GetOpenEditorsRequest) => Promise<void> {
  const tabsApi: VsCodeTabsApi = deps.tabsApi ?? vscode.window;
  return (request: GetOpenEditorsRequest): Promise<void> => {
    try {
      const editors: OpenEditor[] = [];
      for (const group of tabsApi.tabGroups.all) {
        const isActiveGroup = group === tabsApi.tabGroups.activeTabGroup;
        for (const tab of group.tabs) {
          if (!isTextTabInput(tab.input)) continue;
          const uri = tab.input.uri;
          editors.push({
            uri: uri.toString(),
            fs_path: uri.fsPath,
            is_active: isActiveGroup && tab.isActive,
            is_dirty: tab.isDirty,
          });
        }
      }
      ipcClient.send({
        kind: "get_open_editors_response",
        request_id: request.request_id,
        editors,
      });
    } catch (err) {
      sendExtensionToolError(ipcClient, request.request_id, err);
    }
    return Promise.resolve();
  };
}

// VS Code API surface used by the diagnostics handler. Returns the
// shape that vscode.languages.getDiagnostics() produces: an array of
// [Uri, Diagnostic[]] tuples.
export interface VsCodeDiagnosticsApi {
  getDiagnostics(): Array<
    [
      { toString(): string; fsPath: string },
      Array<{
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        severity: number; // 0=Error 1=Warning 2=Information 3=Hint
        message: string;
        source?: string;
      }>,
    ]
  >;
}

export function mapVsCodeSeverity(n: number): DiagnosticSeverityName {
  // vscode.DiagnosticSeverity enum values: 0=Error, 1=Warning,
  // 2=Information, 3=Hint. Unknown values fall back to "info" rather
  // than throwing — the wire format only carries the four named values.
  switch (n) {
    case 0:
      return "error";
    case 1:
      return "warning";
    case 2:
      return "info";
    case 3:
      return "hint";
    default:
      return "info";
  }
}

export interface DiagnosticsHandlerDeps {
  diagnosticsApi?: VsCodeDiagnosticsApi;
}

export function makeGetDiagnosticsHandler(
  ipcClient: InspectionIpcSender,
  deps: DiagnosticsHandlerDeps = {},
): (request: GetDiagnosticsRequest) => Promise<void> {
  const diagnosticsApi: VsCodeDiagnosticsApi =
    deps.diagnosticsApi ?? vscode.languages;
  return (request: GetDiagnosticsRequest): Promise<void> => {
    try {
      const requested = new Set<DiagnosticSeverityName>(request.severities);
      const items: DiagnosticItem[] = [];
      for (const [uri, diagList] of diagnosticsApi.getDiagnostics()) {
        for (const d of diagList) {
          const sev = mapVsCodeSeverity(d.severity);
          if (!requested.has(sev)) continue;
          const item: DiagnosticItem = {
            uri: uri.toString(),
            fs_path: uri.fsPath,
            range: {
              start: {
                line: d.range.start.line,
                character: d.range.start.character,
              },
              end: {
                line: d.range.end.line,
                character: d.range.end.character,
              },
            },
            severity: sev,
            message: d.message,
          };
          if (d.source !== undefined) item.source = d.source;
          items.push(item);
        }
      }
      ipcClient.send({
        kind: "get_diagnostics_response",
        request_id: request.request_id,
        diagnostics: items,
      });
    } catch (err) {
      sendExtensionToolError(ipcClient, request.request_id, err);
    }
    return Promise.resolve();
  };
}

function sendExtensionToolError(
  ipcClient: InspectionIpcSender,
  request_id: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    ipcClient.send({
      kind: "extension_tool_error",
      request_id,
      message,
    });
  } catch {
    // Socket closed between request and error response. The daemon's
    // disconnect handler will cancel the pending entry with 503.
  }
}
