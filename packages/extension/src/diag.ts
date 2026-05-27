// Diagnostic logging gated on CLAUDE_BRIDGE_DEBUG env var.
// Set env var before launching VS Code; check renderer DevTools console
// (Help → Toggle Developer Tools → Console) for output prefixed [cb-diag].
// No-op when unset; safe to leave in production.
const DEBUG =
  process.env.CLAUDE_BRIDGE_DEBUG === "1" ||
  process.env.CLAUDE_BRIDGE_DEBUG === "true";

export function diag(msg: string, data?: unknown): void {
  if (!DEBUG) return;
  if (data !== undefined) {
    console.log(`[cb-diag] ${msg}`, data);
  } else {
    console.log(`[cb-diag] ${msg}`);
  }
}
