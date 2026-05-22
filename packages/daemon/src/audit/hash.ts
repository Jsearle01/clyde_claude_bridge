// SHA-256 hash of canonicalized input. Used by the audit log to record
// `input_hash` per AuditEntry — never the raw input, which may contain
// secrets (CC-4).
//
// Canonicalization sorts object keys recursively so that semantically
// equivalent objects produce the same hash (`{a:1,b:2}` == `{b:2,a:1}`).
// Array order is preserved — array position is semantic.
//
// ASSUMPTION: input values are JSON-native (string/number/boolean/null/
// arrays/plain objects). Date, Map, Set, BigInt, NaN/Infinity, and other
// non-JSON values are normalized by JSON.stringify in ways that may
// collapse semantically distinct values into the same hash. For P0's
// MCP-tool-input use case this is fine; revisit if a tool ever takes
// structured non-JSON-native values.

import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

export function hashInput(input: unknown): string {
  // JSON.stringify(undefined) returns the JavaScript value `undefined`
  // (not a string), so we substitute a literal sentinel to keep the hash
  // stable for top-level `undefined` inputs.
  const canonical =
    input === undefined
      ? "undefined"
      : JSON.stringify(canonicalize(input));
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}
