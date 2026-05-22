// Audit log entry shape. Written by the daemon's audit module to
// `~/.claude-bridge/audit.jsonl`; consumed by humans tailing/grepping the log.
// Pure interface — the daemon constructs entries internally; no parse boundary.

export interface AuditEntry {
  ts: string;             // ISO 8601 UTC
  tool: string;
  input_hash: string;     // "sha256:..."
  allowed: boolean;
  reason?: string;        // present when allowed === false (e.g. "invalid_token")
  duration_ms: number;
  result_bytes: number;
  request_id: string;
  remote_addr: string;
}
