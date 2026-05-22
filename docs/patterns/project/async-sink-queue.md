# Pattern: Async sink queue discipline

## Type
architectural

## Scope
project-specific

## Applies to
Daemon components that need to write a stream of records to a file (or
any append-only sink) where:
- Writes must be serialized (no interleaving)
- The file handle is opened lazily and held open across writes
- Internal write failures must not crash the daemon (CC-1)
- Shutdown must drain in-flight writes before closing the file

Current instances:
- `packages/daemon/src/log/logger.ts` (T-0005) — operational log
- `packages/daemon/src/audit/log.ts` (T-0007) — audit trail

## Description

The shape is a Promise-chain queue with lazy resource open and an
idempotent drain-on-close.

**Core fields:**

```typescript
let queue: Promise<void> = Promise.resolve();
let handlePromise: Promise<FileHandle> | null = null;
let closed = false;
```

**The queue.** `queue` is mutated by reassignment: each new write
appends to the chain via `queue = queue.then(work).catch(stderr-fallback)`.
The `.catch` is the load-bearing CC-1 enforcement: it converts
queue-chain errors into a stderr write so the daemon doesn't see an
unhandled rejection. The chain holds the serialization invariant.

**Lazy open.** `handlePromise` materializes on first write, not at
construction. A sink that never receives a write doesn't touch the
filesystem. The promise (not the resolved handle) is stored so that
concurrent first-writes share the in-flight open rather than racing.

**Idempotent close.** `close()` / `stop()` sets `closed = true`
(guarded against re-entry), awaits `queue`, then closes the handle.
New writes after close are silently dropped (callers shouldn't be
writing post-close; the silent drop avoids spurious errors during
shutdown races).

## Departure point: per-call return type

Different sinks need different per-call semantics:

- **Logger** (`packages/daemon/src/log/logger.ts`): level methods are
  `void`. Callers don't await individual log lines. The queue is
  invisible to call sites; only `close()` is awaited at shutdown.

- **Audit log** (`packages/daemon/src/audit/log.ts`): `append` returns
  `Promise<void>` that resolves when **that specific entry** has been
  flushed. Callers can `await audit.append(entry)` before responding
  to a client. The queue is still chained internally, but `append`
  returns a per-write Promise rather than the queue tail.

The decision rests on whether the caller cares about flush-confirmed
write semantics. Operational logging: usually no. Audit trail (or
anything that's a request precondition): usually yes.

For the flushed-Promise shape, capture the per-write resolve/reject
out of a fresh `new Promise(...)` and have the queue handler call
them on success/failure. The handler still rethrows after rejecting
so the queue's outer `.catch` reaches stderr — the per-write rejection
and the stderr surface are not redundant: callers may swallow their
own write's rejection, but the daemon should still see the failure.

## Example

See `packages/daemon/src/log/logger.ts` for the void-return shape
and `packages/daemon/src/audit/log.ts` for the per-write-Promise
shape. The queue/handle/close machinery is structurally identical;
the per-call return type differs.

## Anti-example

```typescript
// WRONG — short-circuit on close, no drain:
async close() {
  this.closed = true;
  await this.handle?.close();  // queue may still have pending writes
}

// WRONG — naked .catch with no error surfacing:
this.queue = this.queue.then(work).catch(() => {});
// The error is gone; the daemon never learns the sink is failing.

// WRONG — propagating the rejection past the queue's catch:
this.queue = this.queue.then(async () => {
  await write();  // throws
});  // No .catch — becomes an unhandled rejection.

// WRONG — running rotate/state-mutation outside the queue:
async append(entry) {
  if (this.currentDate !== today()) await this.rotate();  // RACES with queued writes
  this.queue = this.queue.then(...);
}
// Do the state check INSIDE the queue handler so it's serialized.
```

## Caveats

- **The queue only serializes writes against itself.** Multiple sinks
  (logger AND audit log) have independent queues; their writes can
  interleave at the OS level (different files). This is fine — the
  serialization invariant is per-file, which is what callers expect.
- **The lazy open's error path** routes through the queue's catch
  (the first write fails). For sinks where open-failure should
  surface differently to the caller, the per-call return type
  needs to carry that distinction.
- **Backpressure is implicit:** an `await audit.append(...)` will
  block the caller if previous writes haven't drained. For typical
  request handlers writing one audit entry per request, this is fine.
  For burst writers, evaluate whether the queue depth needs an
  explicit bound.
- **State mutations that must respect write ordering belong inside
  the queue handler.** AuditLog's per-append date guardrail (Q003)
  calls `rotateInline` from inside the queue chain rather than
  before the queue assignment — otherwise concurrent appends could
  trigger multiple rotates against the same file.

## References

- `packages/daemon/src/log/logger.ts` — first instance (T-0005)
- `packages/daemon/src/audit/log.ts` — second instance (T-0007)
- `docs/conventions.md` §CC-1 (Async error handling)

## Status
active (two confirmed instances at promotion time)

## History
- 2026-05-21: created at T-0007 closure with status active, codifying
  the shape observed in T-0005 (logger) and re-confirmed in T-0007
  (audit log). Both files independently arrived at structurally
  identical queue/handle/close machinery with the departure point
  being the per-call return type.
