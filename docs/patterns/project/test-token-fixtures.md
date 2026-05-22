# Pattern: Inert conforming token strings in test fixtures

## Type
convention / anti-pattern guard

## Scope
project-specific

## Applies to
Any test fixture that must satisfy a token-format regex (currently
`/^cb_live_[A-Z2-7]{32}$/`). Future tokens, API keys, or any
secret-shaped values follow the same rule.

## Description

Tests that exercise schema or auth code need data that conforms to the
expected format. The naive choices have problems:

- **Random conforming string.** Looks like a real secret; could be
  confused for one in a screenshot, log, or commit-diff search.
- **Hardcoded plausible-looking string** (e.g.
  `cb_live_a7f3f20d4e8b6c9a1d219abcd...`). Worse: looks intentional,
  looks real, and a casual reader might treat it as something to
  redact rather than as fixture data.

The fix is to use a **visibly-inert** string that conforms to the
regex. Repetition is the strongest signal: a token made of one
character repeated to fill the regex's length cannot be mistaken
for a real secret.

## Rules

1. Test data for token-format validation matches the regex but is
   obviously a placeholder.
2. The canonical inert form for `cb_live_` tokens is:
   `cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (32 `A`s).
3. Never hand-craft a realistic-looking conforming string, even
   with the intent that it's "obviously fake."
4. Per CC-4, never log or echo token values in test output — but the
   inert form is safe to appear in test source verbatim since it
   could not be mistaken for a real secret.

## Example

```typescript
const TOKEN = "cb_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

it("rejects a config with malformed auth.token", () => {
  const input = { ...fullConfig, auth: { token: "wrong-format" } };
  expect(ConfigSchema.safeParse(input).success).toBe(false);
});

it("parses a fully-populated config", () => {
  const result = ConfigSchema.parse({ ...fullConfig, auth: { token: TOKEN } });
  expect(result.auth.token).toBe(TOKEN);
});
```

## Anti-example

```typescript
// WRONG — looks like a real secret
const TOKEN = "cb_live_a7f3f20d4e8b6c9a1d219abcdef1234567";

// WRONG — random-feel
const TOKEN = "cb_live_K9P3M2X7T4N8Q5R6Y2H9F4L7W3V1B6Z4";
```

## Caveats

- Inert forms only apply to fixtures inside tests. The token in a
  real running config or audit log entry is a real secret.
- If a test needs MULTIPLE distinct conforming tokens (e.g.
  "old token" vs "new token" in a rotation test), use distinct
  inert forms: `cb_live_AAAAAA...` and `cb_live_BBBBBB...` — still
  obviously placeholders, but distinguishable.

## References

- `packages/shared/tests/config.test.ts` — T-0003, first use
- `packages/shared/tests/ipc.test.ts` — T-0004, second use
  (FAKE_TOKEN in token_rotate_ok variant fixture)
- `docs/conventions.md` §CC-4 (Secret handling) — the underlying rule

## Status
active (two confirmed instances at promotion time; third anticipated at T-0006)

## History
- 2026-05-21: created at T-0005 closure with status active, codifying the
  rule observed in T-0003 and T-0004.
