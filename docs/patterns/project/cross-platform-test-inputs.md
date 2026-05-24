# Pattern: Cross-platform test inputs (filesystem paths)

## Type
convention

## Scope
project-specific

## Applies to
Test fixtures involving filesystem paths — whether the path is the
subject under test (e.g., a path-resolution helper) or just an input
to some other assertion. Includes both expected-input and
expected-output sides of an assertion.

## Description

`path.join` (and `path.resolve`, `path.normalize`, etc.) produce
platform-native separators: `/` on Unix, `\` on Windows. When tests
hardcode the slash style of an input or an expected output, they
fail on the wrong platform — sometimes loudly (assertion mismatch),
sometimes silently (a path that looks reasonable but doesn't
actually exist or doesn't match what the code under test will see).

The fix is mechanical: **build path inputs via `path.join` and assert
output shapes against `path.join`-built expectations.** Don't write
literal `/`-separated or `\`-separated paths in test source unless
you're specifically testing the path-canonicalization layer.

When the code under test produces canonical-form paths (e.g., always
forward-slash for cross-platform consistency in a snapshot map), the
EXPECTATION still uses canonical form — but the INPUTS used to drive
the production path should be platform-native via `path.join`.

## Rules

1. Test inputs that name filesystem paths use `path.join`,
   `path.resolve`, or string-built-from-`path.sep` — not literal
   slash characters.
2. When asserting on a path string that's been through
   `path.join`/`path.resolve` in the code under test, build the
   expected string the same way.
3. When the code under test canonicalizes (e.g., normalizes to
   forward-slash for storage), assert the canonicalized form
   literally; only the production-path inputs use `path.join`.
4. `path.sep` is available for places where you need the platform
   separator as a string token.

## Example

```typescript
// GOOD — input built via join, expectation built the same way
it("transcriptPath uses platform separators", () => {
  const baseDir = join("home", "user", ".claude-bridge");
  const p = transcriptPath("j_AAAAAAAAAAAA", baseDir);
  expect(p).toBe(`${baseDir}${sep}transcripts${sep}j_AAAAAAAAAAAA.jsonl`);
});

// GOOD — input via join, output asserted as canonical (forward-slash)
it("snapshot files use forward slashes in map keys", async () => {
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "nested.txt"), "n");
  const snap = await takeSnapshot("w", dir);
  expect(snap.files.has("sub/nested.txt")).toBe(true);  // canonical
});
```

## Anti-example

```typescript
// BAD — hardcoded forward-slash input mixes with join-produced output
it("transcriptPath uses platform separators", () => {
  const p = transcriptPath("j_AAAAAAAAAAAA", "/home/user/.claude-bridge");
  expect(p).toBe(`/home/user/.claude-bridge${sep}transcripts${sep}j_AAAAAAAAAAAA.jsonl`);
  // On Windows, p will be \home\user\.claude-bridge\transcripts\...
  // The expected string mixes / and \ — assertion fails.
});
```

## References

- `packages/daemon/tests/workspace/config.test.ts` — T-P1-002, first use
  (filesystem-validating tests building absolute-path inputs)
- `scripts/acceptance-p1.mjs` — T-P1-005, harness reusing the pattern in
  temp-env config-path building
- `packages/daemon/tests/jobs/transcript.test.ts` — T-P1-006, the
  `transcriptPath` cross-platform test (was the establishing
  catch-it-in-the-act case)
- `packages/daemon/tests/jobs/snapshot.test.ts` — T-P1-007, snapshot
  walker tests + canonical-path assertions
- `packages/daemon/tests/jobs/report.test.ts` — T-P1-008, transcript
  fixture tests building temp paths via `join`
- `docs/conventions.md` §CC-2 (Cross-platform paths and IPC) — the
  underlying cross-cutting concern

## Caveats

- This is a TEST-side pattern. Production code already uses
  `path.join` etc. exclusively per CC-2; the pattern just makes
  sure tests don't accidentally violate the same discipline.
- When the test is SPECIFICALLY exercising slash-canonicalization
  (e.g., a function that takes a Windows-style input and produces
  a forward-slash-canonical output), hardcoded literals are correct
  — that's the slot the test is fitting.
- POSIX-style paths in source code references (e.g.,
  `"docs/design/01-p0-bus.md"` in comments or docs) don't fall
  under this pattern; those are documentation strings, not
  filesystem inputs.

## Status
active (five confirmed use sites at promotion time: T-P1-002,
T-P1-005, T-P1-006, T-P1-007, T-P1-008)

## History
- 2026-05-24: created at T-P1-008 closure with status active, codifying
  the rule observed across five P1 tasks.
