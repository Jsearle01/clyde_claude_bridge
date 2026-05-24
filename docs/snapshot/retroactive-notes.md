# Retroactive notes on prior verdicts

This file collects post-hoc annotations on prior task verdicts where a later
task revealed something that the original verdict missed. Each entry preserves
the original verdict's standing but adds context the orchestrator would have
included had the information been available at verdict time.

Conventions:

- Created at T-P1-014 during the P1-close design-doc-debt sweep.
- Entries are append-only; do not edit prior entries except to add follow-up
  notes (clearly marked as additions).
- Each entry names the original task, the later task that surfaced the issue,
  and the impact on the original verdict's standing.

---

## T-P1-003 — DailyTimer shutdown layer coverage gap

**Surfaced at:** T-P1-005 (acceptance harness skeleton).

**Original verdict:** T-P1-003's report claimed all 14 ACs PASS. Verdict
confirmed at the time.

**What T-P1-005 revealed.** The daily-timer shutdown layer test in
`packages/daemon/tests/main.test.ts` was passing despite incomplete coverage.
The layer's call to `components.dailyTimer.stop()` threw on `undefined` access
(the test's mock components object did not include a `dailyTimer` stub).
The throw was swallowed by the existing try/catch around per-layer shutdown
calls, and the order-array assertion continued to pass because the failed
layer never pushed to it. Net effect: the test reported PASS but actually
verified nothing about the daily-timer layer's behavior.

**Fix in T-P1-005.** Added `makeStubDailyTimer` helper to the test scaffolding
and threaded it through to `main.test.ts`'s shutdown-order assertion. The
daily-timer shutdown layer is now correctly verified.

**Impact on T-P1-003 verdict.** Stands but annotated as
**"tests-passed-but-incomplete-coverage."** The implementation was correct;
the test simply did not exercise the layer. No production-code defect was
introduced or missed.

**Methodology lesson** (carried to v0.5 §6 and §7):
- v0.5 §7.3 ("tests that pass too fast are red flags") — applies analogously
  to "tests that pass on synthetic mocks lacking real surface."
- A try/catch wrapping `components.X.stop()` calls should either include
  positive evidence that each layer ran (e.g., per-layer order-array push
  reaching N entries) or use mocks that throw loudly on undefined access.
  The mocks used at T-P1-003 silently succeeded on the missing field; the
  swallowing try/catch silently absorbed the resulting throw. Two layers of
  silent-on-error compounded.

Recorded at T-P1-014.
