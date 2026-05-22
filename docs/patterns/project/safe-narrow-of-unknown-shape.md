# Pattern: Safe narrow of unknown-shape values

## Type
architectural (TypeScript discipline)

## Scope
project-specific

## Applies to
Values whose static type is a union including arrays (e.g.
`string | string[] | undefined`) or that arrive from third-party typings
where `Array.isArray` narrowing is needed under `recommendedTypeChecked`.

## Description

`Array.isArray`'s built-in type predicate is `arg is any[]`. Under
`recommendedTypeChecked`, narrowing collapses to `any`, which then
cascades through downstream uses and produces `no-unsafe-*` errors.
Explicit source-type annotations DO NOT prevent this — the
predicate's any-effect dominates whatever else the type system
tries to assert.

The safe shape: type the source as `unknown`, use `typeof` checks
for non-array branches, and re-cast array elements to `unknown`
before further narrowing.

## Example

```typescript
function readAuthHeader(req: IncomingMessage): string | undefined {
  const raw: unknown = req.headers.authorization;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first: unknown = raw[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}
```

## Anti-example

```typescript
// WRONG — Array.isArray narrows raw[0] to any, cascades downstream:
const raw = req.headers.authorization;
const header = Array.isArray(raw) ? raw[0] : raw;
// ...subsequent uses of `header` fire no-unsafe-* errors

// ALSO WRONG — explicit source type doesn't help:
const raw: string | string[] | undefined = req.headers.authorization;
const header = Array.isArray(raw) ? raw[0] : raw;
// ...same cascade
```

## Caveats

- Only applies under `recommendedTypeChecked` (or rule packs that
  include `no-unsafe-*`). For projects without these rules, the
  simple `Array.isArray` shape works fine.
- The `unknown` + `typeof` approach is more verbose; the verbosity
  is the cost of the rule pack's preventive value.
- For non-array unions (e.g. `string | number | undefined`), the
  problem doesn't arise — typeof-narrowing works directly on the
  source.

## References

- `packages/daemon/src/mcp/auth.ts` `readAuthHeader` — first
  instance (T-0010)

## Status
draft (one confirmed instance; promotes to active when a second
instance lands in T-0011 or later)

## History
- 2026-05-22: created at status draft at T-0011 closure, codifying
  the lesson from T-0010's reactive lint fix. The Array.isArray
  pitfall surfaced during T-0010's `readAuthHeader` implementation;
  the workaround pattern is concrete enough to record now.
