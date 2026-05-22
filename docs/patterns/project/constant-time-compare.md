# Pattern: Constant-time comparison for tokens and secrets

## Type
convention / anti-pattern guard

## Scope
project-specific (universal in any code touching tokens, API keys, HMACs, signatures)

## Applies to
Any equality check between two secret values where one side is attacker-controlled. The bearer token check is the primary case in this project.

## Description

A naive string equality (`a === b`) short-circuits on the first differing byte. An attacker who can time the comparison can recover the secret one byte at a time. Constant-time comparison removes the timing signal by always doing the full work regardless of where the difference is.

Rules:

1. **Compare lengths first, then constant-time iterate.** Length difference is not itself secret; bailing on length mismatch is fine.

2. **Use bitwise OR accumulation, not boolean short-circuit.** XOR each pair of bytes, OR into an accumulator, compare accumulator to zero at the end.

3. **Reject early on any path that includes the secret in an error message or log line.** Constant-time compare protects against timing leaks; logging the input protects against everything else. Both rules apply.

4. **Prefer Node's `crypto.timingSafeEqual` when both operands are `Buffer`.** It does the right thing. The hand-rolled version below is for the string case.

## Example

```typescript
// packages/daemon/src/config/token.ts

/**
 * Constant-time string comparison. Returns true iff a === b.
 * Length comparison is non-secret; iteration is constant in
 * the length of the inputs (after the early length check).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// packages/daemon/src/mcp/auth.ts
import { constantTimeEqual } from "../config/token.js";

export function checkBearer(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const presented = authHeader.slice("Bearer ".length);
  return constantTimeEqual(presented, expected);
}
```

For Buffer inputs:

```typescript
import { timingSafeEqual } from "node:crypto";

// Both buffers MUST be the same length, or timingSafeEqual throws.
// Pad or length-check before calling.
function bufferEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

## Anti-example

```typescript
// WRONG — naive comparison; timing leak
if (presentedToken === expectedToken) { /* ... */ }

// WRONG — `.localeCompare` or `==`; same issue plus other footguns
if (presentedToken.localeCompare(expectedToken) === 0) { /* ... */ }

// WRONG — short-circuit accumulation
let equal = true;
for (let i = 0; i < a.length; i++) {
  if (a.charCodeAt(i) !== b.charCodeAt(i)) { equal = false; break; }
}
// The break creates a timing channel.

// WRONG — logging the presented token on rejection
if (!constantTimeEqual(presented, expected)) {
  logger.warn(`Rejected token: ${presented}`);   // leaks the guess to logs
  return 401;
}
```

## Caveats

- Constant-time compare is necessary, not sufficient. The full auth path has other timing-leak surfaces: schema validation cost, lookup time, error message construction. Keep the path simple and don't branch on secret values.
- For very long inputs, the constant-time work scales linearly with length. This is acceptable for tokens (~40 chars). For multi-megabyte HMACs, use `timingSafeEqual` on Buffers.
- The accumulator `diff` accumulates into a number; for very long strings the bitwise operations stay 32-bit safe up to any practical token length.

## References

- `packages/daemon/src/config/token.ts` — canonical implementation
- `packages/daemon/src/mcp/auth.ts` — bearer token check site
- Node `crypto.timingSafeEqual`: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
- `01-p0-bus.md` §Auth — "constant-time compare against the canonical token in config"

## Status
active (promoted 2026-05-21 at T-0006 closure — `constantTimeEqual` implementation in `packages/daemon/src/config/token.ts` follows the pattern's example verbatim; tests 11.d, 11.e, 11.f, 11.g verify behavior)

## History
- 2026-05-21: pre-populated during day-zero setup, based on `p0-build-plan.md` §3.3 auth requirements and `01-p0-bus.md` §Auth.
- 2026-05-21: promoted from draft to active at T-0006 closure. First real use in `packages/daemon/src/config/token.ts`'s `constantTimeEqual`. Token-comparison call site (MCP auth) lands at T-0010.
