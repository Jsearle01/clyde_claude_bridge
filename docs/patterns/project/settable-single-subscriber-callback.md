# Pattern: Settable single-subscriber callback

## Type
code

## Scope
project-specific

## Applies to
Components that need to notify exactly one consumer of internal state
transitions or events, where the consumer is wired at extension
activation (or daemon construction) and never replaced during the
component's lifetime.

## Description

A class exposes a public callback field of type `((arg) => void) | undefined`,
initialized to `undefined`, set exactly once at activation time, and
invoked from inside the class via optional-chaining (`this.onX?.(arg)`).
The consumer's wiring code installs the callback; the producer fires it
at well-defined transition or event sites.

This shape is preferred over EventEmitter / observable patterns in this
codebase because:

1. **Single consumer is invariant, not coincidence.** Every site has
   exactly one upstream owner (the extension activation code or the
   daemon main.ts wiring step). There is no requirement to support
   multi-fanout, listener removal, or dynamic subscription.
2. **No async multi-fanout.** Callbacks run synchronously at the
   transition site; the consumer is responsible for deferring any
   long-running follow-up work itself.
3. **Lifecycle is tied to the class instance.** The consumer never
   needs to unsubscribe — when the class is disposed, the callback
   reference goes with it.
4. **Trivial to test.** A test sets `instance.onX = (arg) => spy(arg)`
   and reads the spy after triggering the transition.

The codebase has five confirmed instances of this shape (see References).

## Rules

1. The field is declared as `public onX?: (arg: T) => Ret;` — optional,
   no initializer. Default is `undefined`.
2. The field is set exactly once, at activation / wiring time, via
   assignment: `instance.onX = (arg) => { ... };`. Subsequent reassignment
   is not the codebase convention and tests should not rely on it.
3. The field is invoked via the `if (this.onX !== undefined) { try { this.onX(arg); } catch { /* swallow */ } }` shape
   (or equivalent optional-chain) at the transition site. Subscriber
   errors must be swallowed — the state machine cannot be corrupted by
   a buggy subscriber.
4. **C-26 invariant (field-precedes-setState):** any class field that the
   callback closure may read MUST be assigned its post-transition value
   BEFORE the transition call (or equivalent state-change trigger) that
   fires the callback. See [Caveats](#caveats) for the canonical violation
   shape and the regression-test pattern that catches it.
5. The callback is synchronous and side-effect bounded. Long-running
   work, awaitable returns, and unhandled rejections should be dispatched
   from the callback to other infrastructure (a queue, a separate async
   task), not performed in the callback body.
6. The producer is not responsible for re-firing missed events. If the
   consumer wires the callback after a transition has already happened,
   the consumer either polls a getter for the current state or the
   producer is structured to be idempotent on the next transition.

## Example

`IpcClient.onStateChange` — the canonical instance.

```typescript
// packages/extension/src/ipc/client.ts (excerpt)
export class IpcClient {
  private state: ConnectionStateKind = "disconnected";
  // ... other fields ...

  // T-P2-006: fires on each ConnectionStateKind transition. Subscriber
  // receives the new state value. Idempotent assigns are no-ops; errors
  // swallowed.
  public onStateChange?: (state: ConnectionStateKind) => void;

  // Producer-side: single source of state mutation.
  private setState(next: ConnectionStateKind): void {
    if (this.state === next) return;
    this.state = next;
    if (this.onStateChange !== undefined) {
      try {
        this.onStateChange(next);
      } catch {
        // intentional swallow — subscriber failures must not break state machine
      }
    }
  }
}
```

Consumer-side wiring at activation:

```typescript
// packages/extension/src/extension.ts (excerpt)
ipcClient.onStateChange = (s): void => {
  statusBar.refresh();
  registration?.onConnectionStateChanged(s);
};
```

The consumer installs exactly one callback. If two subscribers are
needed (as here: status bar and registration), the consumer composes
them inside the callback body rather than asking the producer for a
multi-subscriber API.

## Anti-example: field assigned after setState (closes C-26)

This is the violation shape that T-P2-006.5 surfaced and fixed.

```typescript
// WRONG — closes C-26 because the synchronous callback fires while
// `this.identifier` is still the pre-transition value (null).
if (response.kind === "register_workspace_ok") {
  this.setState("registered");       // fires onStateChange("registered")
  this.identifier = response.identifier ?? null;
  // ^ subscriber that called reg.getIdentifier() inside the callback
  //   saw null, not the new identifier — status bar rendered
  //   "(no identifier)" instead of the workspace's identifier.
}

// CORRECT — assign the field BEFORE the transition that fires the
// callback. Subscriber sees the post-transition value.
if (response.kind === "register_workspace_ok") {
  this.identifier = response.identifier ?? null;
  this.setState("registered");       // subscriber sees this.identifier = response.identifier
}
```

The defect is invisible from local reading of the producer side — the
callback's arguments are correct. It only manifests when a subscriber
reads class state via a getter inside the callback. The
[Caveats](#caveats) section gives the regression-test shape that pins
the invariant.

## Anti-example: multi-subscriber via array push

This is the shape this pattern deliberately avoids.

```typescript
// NOT THIS CODEBASE'S CONVENTION
export class IpcClient {
  private subscribers: Array<(s: ConnectionStateKind) => void> = [];

  public addStateChangeSubscriber(fn: (s: ConnectionStateKind) => void): void {
    this.subscribers.push(fn);
  }

  private setState(next: ConnectionStateKind): void {
    if (this.state === next) return;
    this.state = next;
    for (const fn of this.subscribers) {
      try { fn(next); } catch { /* swallow */ }
    }
  }
}
```

The producer-side complexity (array, add/remove, fanout loop, removal
semantics) is not justified by the single-consumer invariant we already
have. If the consumer genuinely needs to multiplex to two destinations,
the consumer composes inline — see the `extension.ts` wiring in
[Example](#example) above.

## Related but distinct: method-form listener (NOT this pattern)

T-P2-008.8 introduced two method-form listeners on `WorkspaceRegistration`:

```typescript
// packages/extension/src/registration.ts (excerpt)
export class WorkspaceRegistration {
  // T-P2-008.8 — method-form listener, NOT a settable callback field.
  onConnectionStateChanged(s: ConnectionStateKind): void {
    if (s !== "connected") return;
    if (this.state !== "registering") return;
    this.setRetryCount(0);
    void this.attemptRegisterIfConnected();
  }

  onReconnectAttempt(attempt: number): void {
    if (this.state !== "registering") return;
    this.setRetryCount(attempt);
  }
}
```

These are **inbound** methods that external orchestration (the wiring
in `extension.ts`) calls ON the component to drive state changes
inward. The settable-callback fields, in contrast, are **outbound**
notification hooks the component invokes itself to notify its consumer
outward.

Distinguishing characteristics:

| Aspect | Settable-callback field | Method-form listener |
|--------|-------------------------|----------------------|
| Direction | Outbound (producer notifies consumer) | Inbound (orchestrator drives component) |
| Declaration | `public onX?: (a) => R;` | `onX(a: T): R { ... }` |
| Invocation | `this.onX?.(arg)` from inside the class | `instance.onX(arg)` from outside |
| Lifetime | Set once at activation, lives with the producer | Always-present method |
| Reentrancy | Subscriber-side concern | Producer-side concern |

The names happen to start with `on…` in both cases — that's a
Javascript-ecosystem coincidence, not a unified pattern. When reading
the code, the declaration shape (`public onX?: <signature>` vs.
`onX(...) { ... }`) is the dispositive cue.

## Caveats

### C-26 invariant (REQUIRED precondition)

When this pattern is used AND the callback closure may read class
fields whose values depend on the same transition that fires the
callback, those field assignments MUST precede the transition call:

```typescript
// CORRECT
this.foo = newValue;          // assign field first
this.setState("registered");  // then trigger transition; callback sees correct foo

// WRONG (closes C-26)
this.setState("registered");  // triggers callback; callback reads this.foo
this.foo = newValue;          // too late; callback already saw stale value
```

The invariant exists because the callback is invoked synchronously from
inside `setState` (or the equivalent transition-trigger method). The
subscriber's closure has live access to `this` via the producer's
getters. If a relevant field is still in its pre-transition state when
the synchronous callback fires, the subscriber notification carries
stale data.

**Regression-test shape** that pins the invariant (from T-P2-006.5):

```typescript
it("identifier is set when onStateChange('registered') fires", async () => {
  const client = makeConnectedClient([{ kind: "register_workspace_ok", identifier: "x-aaaaaa", ... }]);
  const reg = new WorkspaceRegistration(client, makeFolder("/x", "X"));
  let identifierAtRegistered: string | null | undefined = undefined;
  reg.onStateChange = (state) => {
    if (state === "registered") {
      // Read the accessor from inside the callback — this is the
      // load-bearing check. With the pre-fix code (setState before
      // identifier assignment), getIdentifier() returned null.
      identifierAtRegistered = reg.getIdentifier();
    }
  };
  await reg.register();
  expect(identifierAtRegistered).toBe("x-aaaaaa");
});
```

The test sets the callback to read the relevant accessor and asserts
the post-transition value. A producer that fires the callback before
assigning the field fails this test.

### Wiring once, not re-wiring

If the producer is re-instantiated (e.g., the activation code creates a
new IpcClient on a reconnect storm), the consumer must re-install the
callback. The producer holds no registry of past subscribers.

### Synchronous-only by design

If the callback needs to do async work, the subscriber should kick off
a `void promise.catch(handle)` from inside the callback rather than
returning a promise. The producer is not structured to await the
callback's resolution before continuing its own state machine.

## References

Five confirmed instances at promotion time (2026-05-28):

- `IpcClient.onReconnectAttempt` —
  [packages/extension/src/ipc/client.ts:88](../../../packages/extension/src/ipc/client.ts#L88).
  Introduced T-P2-005. Test:
  [packages/extension/tests/ipc-client.test.ts:162](../../../packages/extension/tests/ipc-client.test.ts#L162)
  ("fires with the incremented attempt count on each reconnect schedule").
- `IpcClient.onStateChange` —
  [packages/extension/src/ipc/client.ts:97](../../../packages/extension/src/ipc/client.ts#L97).
  Introduced T-P2-006. Test:
  [packages/extension/tests/ipc-client.test.ts:263](../../../packages/extension/tests/ipc-client.test.ts#L263)
  ("fires on each state transition with the new state value") +
  T-P2-006-followup-added accessor-read C-26 test.
- `IpcClient.onApprovalRequest` —
  [packages/extension/src/ipc/client.ts:107](../../../packages/extension/src/ipc/client.ts#L107).
  Introduced T-P2-008. Test:
  [packages/extension/tests/approval-modal.test.ts](../../../packages/extension/tests/approval-modal.test.ts)
  (full describe block on the modal handler that consumes this callback;
  callback receives the parsed `ApprovalRequest` payload as its argument,
  so structurally no field-vs-setState ordering concern applies on this site).
- `WorkspaceRegistration.onStateChange` —
  [packages/extension/src/registration.ts:81](../../../packages/extension/src/registration.ts#L81).
  Introduced T-P2-006; C-26 invariant codified at T-P2-006.5. Tests:
  [packages/extension/tests/registration.test.ts:244](../../../packages/extension/tests/registration.test.ts#L244)
  (identifier-set-on-ok), 269 (identifier-set-on-confirm_trust),
  299 (existingPid-set-on-duplicate). These are the gold-standard
  regression tests for the pattern.
- `WorkspaceRegistration.onRetryCountChange` —
  [packages/extension/src/registration.ts:85](../../../packages/extension/src/registration.ts#L85).
  Introduced T-P2-008.8. Test:
  [packages/extension/tests/registration.test.ts:406](../../../packages/extension/tests/registration.test.ts#L406)
  ("retry counter increments on each onReconnectAttempt and fires
  onRetryCountChange") + T-P2-006-followup-added accessor-read C-26 test.

Related but distinct (method-form listeners — not this pattern):

- `WorkspaceRegistration.onConnectionStateChanged` and
  `WorkspaceRegistration.onReconnectAttempt` — both at
  [packages/extension/src/registration.ts:150, :163](../../../packages/extension/src/registration.ts#L150).
  Introduced T-P2-008.8 as the inbound side of the same composed-callback
  routing that drives the outbound notifications.

Sources of record:

- `docs/project-state.md` — C-26 v0.6 candidate (the field-precedes-setState
  invariant; closed-by-T-P2-006.5).
- `docs/claude-orchestrated-methodology-v0_5.md` §9 — pattern doc template
  this file follows.

## Status
active (five confirmed use sites at promotion time)

## History
- 2026-05-25: First use, T-P2-005 — `IpcClient.onReconnectAttempt`.
- 2026-05-25: Second + third use, T-P2-006 — `IpcClient.onStateChange`
  and `WorkspaceRegistration.onStateChange`.
- 2026-05-25: C-26 invariant surfaced via T-P2-006.5 (field-precedes-setState
  ordering defect on `WorkspaceRegistration.onStateChange`); three fixes
  applied plus three regression tests added.
- 2026-05-25: Fourth use, T-P2-008 — `IpcClient.onApprovalRequest`.
- 2026-05-28: Fifth use, T-P2-008.8 — `WorkspaceRegistration.onRetryCountChange`.
- 2026-05-28: Promoted to pattern library via T-P2-006-followup; C-26
  invariant inlined as required precondition; two accessor-read regression
  tests added to strengthen coverage on the two callbacks that previously
  only exercised parameter-based assertions.
