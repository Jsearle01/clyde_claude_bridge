# v0.6 Methodology — Scope Lock

**Locked:** 2026-05-28
**Status:** Scope locked; doc drafting deferred to T-P2-014 (after T-P2-009 through T-P2-013).
**Input to:** T-P2-014 dispatch.
**Derived from:** v0.5 active practice + P2 candidate accumulation through T-P2-006-followup.

This document is the canonical scope spec for v0.6. T-P2-014's dispatch should reference it directly; no further scope conversation should be needed when T-P2-014 opens.

---

## A. Format and structure

**A.1 Format:** v0.6 is a **full standalone replacement** for v0.5, not a delta. v0.5 substance is preserved verbatim where unchanged; new and revised sections are explicit.

**A.2 Changelog section:** v0.6 includes a Part IX-equivalent "Changelog from v0.5" section listing what's different and the empirical basis for each change. Mirrors v0.4's Part IX format.

**A.3 Differential-review requirement:** T-P2-014's verdict requires verbatim diff or close-reading evidence that v0.5's substance survived the rewrite where the changelog says it should have. Substantive meaning drift in supposedly-preserved sections is a verdict-blocker.

**A.4 New top-level section:** "Verdict-time evidence" — houses the C-25 family (see C below).

**A.5 Pattern doc template:** v0.5's §9 template is formally codified in v0.6. Going-forward only — the 9 existing pattern docs are NOT normalized. v0.6 §9 includes one sentence noting the inconsistency is tolerated.

**A.6 Empirical band table:** combined P1 + P2 matrix. If width becomes a readability problem at drafting, split by task-shape (bounded/medium/large) rather than by phase.

**A.7 Streak counter:** stays out of methodology. Project-state.md tracks it; v0.6 says nothing.

**A.8 Report-form impact from C-35:** v0.5 §3.5's Form A and Form B specifications must be edited to include the mandatory elapsed-time block per C-35. This is a revised-section change, not a new section. Apply to both Form A (trivial fast-path) and Form B (standard) — neither form is exempt. Any future Form C or beyond inherits the requirement by default unless explicitly overridden in that form's spec.

---

## B. Numbered rules codified in v0.6 (9 entries)

Each entry lists: ID, short title, wording. Wording is binding for T-P2-014; minor copy-editing is fine; substantive deviation requires reopening this scope lock.

### B.1 — C-13: Pre-dispatch grep dimensions

> Every dispatch includes a "Pre-dispatch grep (C-13)" section that enumerates specific code or doc locations the executor must verify before implementation. The grep targets serve three roles: (1) verify scope assumptions (file exists, function has expected shape, schema field is present); (2) catch shape drift since the orchestrator's last context refresh; (3) surface adjacent-invariant concerns the dispatch may not have anticipated. Grep findings are reported verbatim at the top of the executor's report block. If any finding contradicts a scope assumption, the executor stops and reports rather than proceeding.

### B.2 — C-14: Empirical band landing position (v5 wording)

> Empirical band landing position correlates with two factors:
> 1. **Shape size.** Bounded-fix tasks (single file, single function, characterized defect) land sub-band-low. Medium tasks (~5 files, multiple subsystems, novel persistence/protocol) land lower-half to midpoint. Large tasks (multi-package architectural changes) land midpoint to upper-half.
> 2. **Consumed headroom.** §22.5 fires shift landing toward mid-band by ~30%. At-site refactors shift by ~10–15%. Audit-discovered-extra-defects shift by ~20% per additional defect found.
>
> Pre-resolution depth + thorough C-13 grep keeps tasks in the lower half of the expected range.

### B.3 — C-21: Mock-vs-production contract drift

> Tests that pass against mock implementations may not pass against production behavior. When introducing a mock for a production component, the mock and production must share a contract definition (interface, schema, or behavioral spec). Tests assert against the contract, not against either implementation directly. When the mock and production behavior diverge in a way the contract didn't capture, the contract has a gap — not the test, not the production code. Refine the contract first; then the test.

### B.4 — C-31: Diag-before-fix for race/retry symptoms

> When a defect surfaces as "something is stuck" or "eventually works but slowly", the symptom shape (race, retry exhaustion, timing) often differs from the defect shape (state machine give-up, decoupled retry loops, missing event subscriptions, dropped events). Before specifying a fix to the symptom (e.g., "longer retry budget"), capture diagnostic trace of the actual sequence; the trace often reveals a more fundamental defect that a symptom-fix would mask. This principle generalizes beyond race/retry: any defect class where "what looks broken" is downstream of "what is broken" benefits from instrumentation before fix specification.

### B.5 — C-32: Adjacent-invariant scoping

> When dispatching a fix, the orchestrator surveys adjacent invariants and call sites that may share root cause or symptom shape with the defect under fix, and includes them in scope explicitly. The dispatch states the adjacent surface in either the Constraints section ("while implementing X, ensure Y holds") or the Acceptance Criteria ("verify Z at all N call sites"). This discipline prevents the same root cause from surfacing as a separate defect later, and concentrates context-load into a single task rather than spreading it across follow-ups. Counter-discipline: do not expand scope beyond what shares root cause; "this file also has unrelated tech debt" is not adjacent-invariant scoping.

### B.6 — C-33: Diagnostic-add as separate task from fix

> When a defect's surface is observable but its root cause cannot be localized from current evidence, the next dispatch adds diagnostic instrumentation (logging, debug toggles, trace capture). The fix is dispatched AFTER capturing diagnostic output, not before. Scoping the diagnostic task separately prevents the orchestrator from prematurely specifying a fix to the symptom, and lets the executor focus on observation-quality rather than guess-driven implementation. The diagnostic task may be small (env-gated log statements) or substantial (new metrics surface); either way, it is dispatched and verdicted on its own terms.

### B.7 — C-34: Hard-stop guard in dispatch verification

> When a dispatch's implementation depends on a verifiable pre-condition (a function has expected shape, a handler is idempotent, a schema field exists), the dispatch states the precondition explicitly AND directs the executor to halt and report rather than improvise if the precondition fails. This is distinct from general C-13 grep reporting: the executor reports findings either way, but with a hard-stop guard the executor stops the task and surfaces the contradiction rather than reshaping implementation on the fly. Hard-stops are appropriate when the alternative is implementation drift from spec; ordinary scope reshapes can still flow through §22.5.

### B.8 — C-35: Elapsed time mandatory in all report forms

> Every executor report — regardless of report form (Form A trivial fast-path, Form B standard, or any future form) — must include an explicit elapsed-time block. The block reports three values: (1) wall-clock duration of the task in minutes, measured from dispatch receipt to commit-and-push completion; (2) the dispatch's predicted band(s), copied verbatim from the dispatch; (3) the C-14 classification of where the actual landed within the predicted band — one of: sub-band-low (below low edge), lower-half, midpoint, upper-half, over-band (above high edge).
>
> Example block: "Elapsed: 37 min. Predicted: 30–60 min empirical / 30–90 min legacy. Classification: midpoint (empirical band)."
>
> The block is mandatory; "approximately" or "within band" without the explicit number is insufficient. The block feeds C-14 calibration arithmetic in the orchestrator's verdict. If the executor cannot measure wall-clock time precisely (e.g., the task spanned an interruption), the executor reports a best estimate plus the source of imprecision (e.g., "≈40 min; clock paused ~10 min mid-task for orchestrator round-trip").

### B.9 — Verdict-time evidence section (houses C-25 family)

**Section title:** "Verdict-time evidence"

**Section intro:**

> The orchestrator's verdict establishes that the executor's claims about a task's completion are reliable. Three sub-protocols, applied in combination per task shape, provide that reliability.

**Sub-rule 25.1 — Fresh tool output:**

> The orchestrator's verdict must cite verbatim output from tooling invoked fresh at verdict time, not paraphrase or summary. "Fresh" means invoked within the same dispatch's report-generation phase, not reused from earlier in the task. At minimum: `npm run lint` (or project equivalent) verbatim.

**Sub-rule 25.2 — Bundled-artifact verification:**

> When a task produces a bundled or packaged artifact (.vsix, .tgz, executable, container image), the verdict must include grep-evidence that the artifact does not externally import workspace siblings or otherwise leak unbundled references. Memory-asserted "the bundle looks right" is not sufficient. Example: `unzip -p <pkg> <bundled-file> | grep -c "<sibling-package-prefix>"` returning 0. Tasks that do not produce a bundled artifact must explicitly state "25.2: N/A" in the verdict with one-line rationale (e.g., "daemon-only change, no artifact rebuilt").

**Sub-rule 25.3 — Operator-runtime-smoke for build/packaging:**

> For any task affecting build pipelines, packaging output, extension installation, or operator-launched runtime, the dispatch must specify an operator-performed runtime smoke procedure that closes the runtime-evidence gap left by agent-side ACs. The smoke is the operator's responsibility, performed in the same session as the agent's verdict. Verdict may commit on agent-verifiable ACs alone; follow-up tasks may not proceed until operator smoke is captured.
>
> Smoke procedures involving environment variables, process inheritance, or extension reload MUST explicitly direct the operator to kill all instances of the affected process tree before relaunching ("Get-Process X | Stop-Process -Force; confirm zero remain; then relaunch"). "Close all windows" alone is insufficient on Windows/Electron, where launcher processes persist with stale environment.

---

## C. CC-2 elaborations (light touch, in-place edits)

### C.1 — C-17: Cross-platform path conventions verification

Add one sentence to CC-2's existing prose:

> When a helper's output is platform-shape-sensitive (e.g., path separators, config-dir resolution), verify actual output on each target platform via test or smoke before specifying behavior in subsequent code. Don't trust documentation alone.

### C.2 — C-20: Windows `.cmd` shim resolution CVE-2024-27980

Add CVE citation to CC-2's existing Windows-detached-subprocess discipline:

> Windows `.cmd` shim resolution requires `shell: true` in spawn options (per CVE-2024-27980 — Node's `spawn` does not invoke `.cmd` resolvers without an explicit shell context, leading to NoExec failures on Git-Bash-on-Windows and similar shells).

---

## D. Closed-item changelog acknowledgments

Each gets one line in the changelog section:

- **C-23** (T-P2-007): Fresh-state-assumption tests antipattern closed via startup-population logic + AC-12 integration test.
- **C-24** (T-P2-007.5): Windows path case-insensitivity closed via normalizeAbsPath + dedupeOnLoad.
- **C-26** (T-P2-006.5 + T-P2-006-followup): Field-precedes-setState invariant codified in `docs/patterns/project/settable-single-subscriber-callback.md` Caveats section.
- **C-28** (T-P2-008.5): Extension .vsix bundling closed via esbuild bundle step.
- **C-29** (T-P2-008.8): Registration intent persistence closed via event-driven re-attempt model.
- **C-30** (T-P2-008.7): session_bypass mode-guard closed via gate refactor + (mcp_session_id + workspace_id) keying.

---

## E. Deferred to v0.7 / runbook / project pattern docs

These are NOT in v0.6 scope. Listed here so T-P2-014 doesn't accidentally codify them.

| ID | Treatment |
|----|-----------|
| C-11 | Defer to v0.7 (boundary working in practice) |
| C-12 | Defer to v0.7 (single instance) |
| C-15 | Reshape as project pattern; defer until 2+ instances |
| C-16 | Move to T-P2-013 runbook refresh scope |
| C-18 | Move to T-P2-013 runbook refresh scope |
| C-19 | Defer as project pattern; watch |
| C-22 | TBD — text recovery during T-P2-014 dispatch drafting (read fresh `docs/project-state.md`) |

---

## F. Log-and-watch (this session's M-* observations)

NOT promoted; tracked in project-state.md for future-instance promotion.

| Provisional | Description | Instance count |
|-------------|-------------|----------------|
| M-A | Fork-in-the-road dispatch pattern | 1 (T-P2-008.7) |
| M-E | Accessor-read C-26 test subgenre | 1–2 (T-P2-006.5, T-P2-006-followup) |
| M-F | "Verify mechanism before describing mechanism" | 1 (T-P2-008.8 scope refinement) |

Plus pre-existing project-pattern candidates (not methodology-level):

| Pattern | Instances |
|---------|-----------|
| Fire-and-forget `send()` vs `request<R>()` | 1 (T-P2-008) |
| Layered shutdown with new layers inserted | 1 (T-P2-008) |
| Forward-declaration thunk | 1 (T-P2-007) |
| Pre-fix regression-test verification | 1 (T-P2-006.5) |
| Logger as optional constructor param | 1 (T-P2-007.5) |

---

## G. T-P2-014 dispatch shape (preview, not yet drafted)

When T-P2-014 opens (after T-P2-013 closes), its dispatch references this scope-lock and reduces to:

1. **C-13 grep:** verify v0.5 doc structure unchanged; verify project-state.md candidate list matches this lock's accounting; verify pattern docs count (9).
2. **Implement:** draft `docs/claude-orchestrated-methodology-v0_6.md` per sections A–F above. Include changelog section per A.2. Full replacement format per A.1.
3. **Verify:** AC-by-AC includes "B-rules B.1 through B.9 wording matches spec exactly OR has documented copy-edit." Differential review per A.3.
4. **Update cross-references:** walkthrough, runbook, README, p2-build-plan reference v0.5 → v0.6 where applicable.
5. **Empirical band table:** combined matrix per A.6. Built from `docs/calibration-log.md` (18 P2 datapoints expected by T-P2-014's time; possibly more if T-P2-009-013 add more).

Timing prediction at T-P2-014 drafting time: 25–40 min (per p2-build-plan estimate; scope pre-resolution reduces uncertainty significantly).

---

## H. Open during P3+ window (informational)

These are placeholders so T-P2-014 doesn't forget about them:

- C-27 (open, P3+ scope): claude.ai OAuth provider for daemon. Not a methodology question.
- Pattern doc normalization for P0 docs: not blocking; could become a P3 task if anyone complains.

---

## End of scope lock

This document is canonical input to T-P2-014's dispatch. When T-P2-014 opens, the dispatch can cite this file and skip most of the pre-conversation that would otherwise be needed.

**Status:** scope locked 2026-05-28; await T-P2-009 → T-P2-013 progress; T-P2-014 dispatch when build-plan reaches it.
