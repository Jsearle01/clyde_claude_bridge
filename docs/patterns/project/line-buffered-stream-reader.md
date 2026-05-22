# Pattern: Line-buffered stream reader

## Type
architectural

## Scope
project-specific

## Applies to
Readable streams that deliver newline-delimited text records where:
- Chunks may contain partial lines, multiple complete lines, or both
- Each complete line must be dispatched as a discrete event
- Trailing partial lines persist across chunk boundaries

Current instances:
- `packages/daemon/src/ipc/server.ts` (T-0008) — IPC newline-delimited JSON
- `packages/daemon/src/tunnel/cloudflared.ts` (T-0012) — cloudflared stdout/stderr

## Description

Accumulate chunks in a string buffer. Repeatedly find the next newline
via `indexOf("\n")`; if found, slice off the complete line for dispatch
and advance the buffer past the newline. Stop when no newline remains;
retain the partial line for the next chunk.

The function takes a current buffer and a chunk; returns the new buffer
(carrying any trailing partial line). Dispatch is via a per-line side
effect — typically emitting an event with the line as payload.

## Example

```typescript
// packages/daemon/src/tunnel/cloudflared.ts (T-0012)

private handleStream(buffer: string, chunk: string): string {
  let buf = buffer + chunk;
  let newlineIdx = buf.indexOf("\n");
  while (newlineIdx !== -1) {
    const line = buf.slice(0, newlineIdx);
    buf = buf.slice(newlineIdx + 1);
    this.processLine(line);
    newlineIdx = buf.indexOf("\n");
  }
  return buf;
}
```

```typescript
// packages/daemon/src/ipc/server.ts (T-0008) — same shape on Socket events

socket.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIdx = buffer.indexOf(NEWLINE);
  while (newlineIdx !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    void this.dispatchLine(socket, line);
    newlineIdx = buffer.indexOf(NEWLINE);
  }
});
```

## Anti-example

```typescript
// WRONG — split on arrival; lines spanning chunks are lost.
socket.on("data", (chunk: string) => {
  for (const line of chunk.split("\n")) {
    processLine(line);  // mid-chunk partial line dispatched as if complete
  }
});

// WRONG — using `readline.createInterface` for streams whose lifecycle
// we manage explicitly. Adds an Interface object per stream with its own
// teardown. Acceptable in isolation but mixing with explicit child-process
// lifecycle creates dual-cleanup obligations.
```

## Caveats

- **Unbounded buffer growth**: streams that emit very long lines without
  newlines (e.g. a multi-MB log dump from a misbehaving subprocess) cause
  the buffer to grow unboundedly until the line completes. For sources
  where this is a risk, cap the buffer at the application's max line size
  and truncate or error.
- **Encoding**: set the stream to `"utf8"` via `setEncoding("utf8")` before
  attaching the data handler, OR use raw `Buffer` and decode at split-time.
  Mixing encoded/raw chunks in the same buffer leads to silent corruption.
- **CRLF vs LF**: this pattern handles LF-only delimiters. If sources may
  emit `\r\n`, either strip the trailing `\r` from each dispatched line
  or split on `\r\n` explicitly. Cloudflared and our IPC use LF; no CRLF
  handling needed in current instances.

## References

- `packages/daemon/src/ipc/server.ts` — first instance (T-0008)
- `packages/daemon/src/tunnel/cloudflared.ts` — second instance (T-0012)

## Status
active (two confirmed instances at promotion time)

## History
- 2026-05-22: created at T-0012 closure with status active. The candidate
  pattern was flagged at T-0008 (IPC server) and confirmed when T-0012
  (cloudflared subprocess) arrived at the same shape independently.
  Both instances accumulate-and-split with no shared abstraction; the
  pattern is recorded as a project-wide shape rather than as a utility
  to extract, since the per-call context (event emission, dispatch
  semantics) differs.
