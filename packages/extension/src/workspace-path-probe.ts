// T-P3'-0 ground-truth probe (SPIKE — no production wiring).
//
// The entire daemon<->workspace auto-pairing mechanism (Phases 2a/2b) rests
// on the daemon's canonical form of a workspace path being byte-identical to
// the extension's workspaceFolders[0].uri.fsPath for the SAME folder. Before
// anything depends on that, capture VS Code's ACTUAL output — don't assume it.
//
// This command logs, verbatim and untransformed, three fields for the open
// folder: uri.fsPath, uri.path, and uri.toString(). Three fields (not just
// fsPath) so a surprising fsPath is diagnosable against its source URI.
//
// Output goes to an always-visible OutputChannel (NOT the debug-gated diag
// console) so the operator can read and copy the strings without launching
// DevTools or setting CLAUDE_BRIDGE_DEBUG.

import * as vscode from "vscode";

// Pure formatter — given the open folder's URI (or undefined when no folder
// is open), produce the verbatim capture block. Separated from the vscode
// plumbing so the exact-string formatting is unit-testable.
export function formatProbeOutput(
  uri: { fsPath: string; path: string; toString: () => string } | undefined,
): string {
  if (uri === undefined) {
    return "[cb-path-probe] no workspace folder open";
  }
  // Wrap each value in explicit delimiters so trailing whitespace or a
  // trailing separator survives copy/paste and is visible to the operator.
  return [
    "[cb-path-probe] workspaceFolders[0].uri — verbatim, untransformed:",
    `  fsPath      = <${uri.fsPath}>`,
    `  path        = <${uri.path}>`,
    `  toString()  = <${uri.toString()}>`,
  ].join("\n");
}

// Builds the command handler. The OutputChannel is created once and reused;
// it is registered for disposal by the caller via context.subscriptions.
export function makeWorkspacePathProbe(
  context: vscode.ExtensionContext,
): () => void {
  const channel = vscode.window.createOutputChannel("Claude Bridge: Path Probe");
  context.subscriptions.push(channel);
  return (): void => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const block = formatProbeOutput(folder?.uri);
    channel.appendLine(block);
    channel.appendLine("");
    channel.show(true);
    void vscode.window.showInformationMessage(
      "Claude Bridge: path probe written to the 'Claude Bridge: Path Probe' output channel.",
    );
  };
}
