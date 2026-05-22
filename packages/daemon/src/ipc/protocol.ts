// Newline-delimited JSON IPC protocol. Each message is a single JSON-encoded
// line ending in '\n'. Schema validation (IpcRequest/IpcResponse) is the
// caller's responsibility — this module only handles encode/decode and
// surface-level shape errors.

export const NEWLINE = "\n";

export class IpcProtocolError extends Error {
  constructor(public readonly reason: string) {
    super(`IPC protocol error: ${reason}`);
    this.name = "IpcProtocolError";
  }
}

export function encodeMessage(msg: unknown): string {
  const json = JSON.stringify(msg);
  if (json === undefined) {
    // JSON.stringify returns undefined for `undefined`, functions, and symbols.
    throw new IpcProtocolError("cannot encode value as JSON");
  }
  return json + NEWLINE;
}

export function decodeMessage(line: string): unknown {
  const trimmed = line.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new IpcProtocolError(`invalid JSON: ${reason}`);
  }
}
