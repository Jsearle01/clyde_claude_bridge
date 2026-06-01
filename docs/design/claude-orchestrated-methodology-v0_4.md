# Claude-Orchestrated Development Methodology

**Version:** v0.4
**Date:** May 23, 2026
**Status:** Empirically refined from v0.3 based on lived experience executing the full P0 gate of the claude-bridge project (22 tasks across ~2.5 weeks calendar time; 24 commits; 10/10 acceptance criteria VERIFIED; 0 reverts, 0 escalations).

**Relationship to v0.3:** This document is a **delta over v0.3, not a rewrite.** All sections of v0.3 remain in effect unless specifically updated here. v0.4's substance is in Part IX (Changes from v0.3) and in the new and revised sections that follow. Read v0.3 first; then read v0.4 for what changed and why.

**Methodology principle this version embodies:** A methodology should be evidence-based. v0.3 was the synthesis of prior thinking; v0.4 is the first version refined by actual execution data.

---

## How to read this document

1. **First-time readers:** read v0.3 in full, then read v0.4 from Part IX onward. v0.4's table of contents below shows only the changed sections.

2. **Resuming after v0.3 experience:** read this document directly; the changelog in Part IX summarizes what's different.

3. **Methodology refinement contributors:** Part IX explains the empirical basis for each change. The patterns codified here all have at least one project of evidence; future versions should hold the same standard.

---

## Table of contents (changes from v0.3)

**Revised sections:**
- §3.5.1 Reporting format — restructured into three forms scaled to task size
- §7.4 Verdict structure — calibration-phase form vs steady-state form codified
- §8 Prompt generation — scope-decision pre-conversation pattern elevated to required practice
- §11 Pattern library — test-conventions and runtime-helpers added to day-zero pre-population
- §22.1 Commit messages — body conventions codified beyond subject line
- §25 Calibration phase — closure criteria refined; v0.3 wording was right but undercodified

**New sections:**
- §3.5.2 Reporting fast-paths for trivial-bucket tasks
- §8.6 Scope-decision pre-conversation protocol
- §9.5 Acceptance harness as discovery instrument
- §14.7 Working-tree-state-mid-dispatch protocol
- §15.6 Reactive-deviation boundary list
- §17.7 Context snapshot artifacts
- §22.5 Reactive-fix consultation triggers
- §29.4 Three forms of verification

**New part:**
- **Part IX — Changes from v0.3 (changelog and empirical basis)**

---

# Revised sections

## §3.5.1 Reporting format (revised)

v0.3 specified a single reporting format for executor task reports. P0 lived experience showed the format is well-calibrated for small-to-medium tasks but produces high overhead for trivial tasks (5-min work generating a full report).

**v0.4 specifies three report forms scaled to task size:**

### Form A — Trivial fast-path (predicted ≤15 min)

Three sections only:
1. **Summary** — one paragraph; what was done and what changed
2. **Files modified** — bullet list; one line per file with delta nature
3. **Verification** — build/lint/test status; one line per outcome

Plus **Timing block** at top (start / end / elapsed / vs predicted band).

Total target: <100 lines, often <50.

Use when: prompt predicts trivial bucket; task touches existing patterns only; no new design surface.

### Form B — Standard (predicted 30-90 min)

Full §3.5.1 as specified in v0.3, with these adjustments:
- Pattern observations section removed as a standalone heading; fold into Reactive deviations or Uncertainty flags
- Add a Follow-up candidates section: items noted in passing that warrant later work but aren't blocking
- Verbatim discipline applies as specified, with one clarification (see below)

### Form C — Deep (predicted >90 min, or any task with new external surface)

Form B plus:
- Reasoning section as full prose (not bullet)
- Verbatim code listings for safety-relevant files
- Explicit alternatives-considered notes for non-obvious design choices

### Verbatim discipline clarification (v0.4)

**Verbatim code in the report is required only when the file is NOT the canonical record.** If the file is committed and the report's verbatim is a duplicate of what `git show <commit>:<path>` would return, reference the path + commit instead of pasting. Saves tokens; doesn't lose audit trail. Verbatim still required for:
- New files in their first commit (the report IS contemporaneous with the canonical record)
- Files where subtle correctness matters (auth, state machines, concurrency primitives)
- Cases the orchestrator specifically names in the prompt's reporting-format section

### Timing block (all forms)

```
Timing
  Start:     YYYY-MM-DD HH:MM (local time of executor host)
  End:       YYYY-MM-DD HH:MM (LAST moment of work — after final verification)
  Elapsed:   HH:MM
  Predicted: <bucket name> (NN-NN min)
  Variance:  +X% / -X% from predicted midpoint (or "within band")
```

The end timestamp is the **last moment of actual work** — after final test runs, doc edits, and `git status` verification, before composing the report itself. Composing the report does not count as work time.

The predicted vs actual comparison accumulates calibration data automatically; the orchestrator should ingest these into the project's calibration record.

---

## §3.5.2 Reporting fast-paths (new)

When a prompt specifies "Form A acceptable" or "trivial fast-path acceptable," the executor may use Form A regardless of actual time taken — predicted-trivial that turns out non-trivial gets the standard Form B report instead, AND a UNCERTAINTY FLAGS note explaining the prediction miss.

Form A reports must still include:
- Timing block (mandatory across all forms)
- Verification (build/lint/test outcomes)
- Files modified (the minimum audit trail)

Form A reports may omit:
- Reasoning section
- Pattern observations
- Reactive deviations heading (fold inline if any deviations occurred; flag prominently)

The orchestrator's verdict on a Form A report is similarly compressed: one or two sentences confirming closure; no calibration-data extraction unless something notable surfaced.

---

## §7.4 Verdict structure (revised)

v0.3 specified verdict vocabulary (CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED) but left the verdict's structure under-codified. P0 lived experience produced two verdict shapes corresponding to calibration phase and steady-state.

**Calibration-phase verdict form (full):**
- Verdict statement with vocabulary
- Per-AC table (every AC explicit; status; evidence reference)
- Confidence statement (per §7.4 of v0.3)
- Reactive-deviation review
- Pattern decisions
- Calibration findings
- Action items

**Steady-state verdict form (light):**
- Verdict statement
- "Notable items" paragraph(s) — only what's worth recording, not exhaustive
- Pattern decisions if anything changed
- Action items

Both forms maintain verdict-vocabulary discipline. "Notable items" replaces the per-AC table when the executor's report already enumerated AC outcomes verifiably; the verdict no longer needs to restate them.

**Verdict's job (clarified):** A verdict is NOT just "did the executor do the work." A verdict captures:
1. Gate-close status (verdict vocabulary)
2. Calibration deltas (what this task taught us)
3. Forward-pointing decisions (pattern promotions, AC closures, follow-up implications)

The verdict is part of the project's institutional memory, not a closure-only ceremony.

---

## §8 Prompt generation (revised)

v0.3 §8 specifies prompt structure. v0.4 refinements:

**§8.3 AC list structure (clarified):** Use flat numbered lists with optional one-level sub-bullets. Avoid nesting beyond two levels (1 → 1.a, not 1 → 1.a → 1.a.i). Lived experience: deep nesting reduced execution reliability.

**§8.4 Doc-edit deltas (codified):** When the prompt instructs doc edits, provide either:
- Verbatim find/replace pairs (exact strings to locate and replace) — preferred for milestones.md, project-state.md, conventions.md
- Or: high-level instruction with explicit field/section name (acceptable for prose-heavy edits to README, runbook, etc.)

The find/replace pattern from T-0019.7 reduced doc-edit error to ~0. Codify as default for status-field-flip edits.

**§8.5 "Three scope decisions confirmed" pattern (elevated to required):** For any non-trivial task, the orchestrator surfaces 2-4 plain-prose scope decisions BEFORE drafting the full prompt. Pattern:

> "Three (or N) scope decisions before I draft:
> 1. [Decision A] — orchestrator's lean: X
> 2. [Decision B] — orchestrator's lean: Y
> 3. [Decision C] — orchestrator's lean: Z
> Confirm or reshape any."

The user confirms in one word ("confirm") or reshapes one or more. The decisions land in the dispatched prompt as a "Scope decisions confirmed" section.

This pattern compresses what would otherwise be 3-4 rounds of mid-execution clarification into a single round before drafting. Token cost: 100-200 words of orchestrator prose; user response: 1-3 words. Massive savings vs the alternative.

When NOT to use: trivial tasks with no scope ambiguity (single-line fixes; verification-only tasks). When in doubt, use it — the cost is negligible.

---

## §8.6 Scope-decision pre-conversation protocol (new)

Formalization of the pattern in §8.5.

**Trigger:** Orchestrator is about to draft a non-trivial prompt and identifies ≥2 places where the executor would otherwise need to make a design choice.

**Protocol:**

1. Orchestrator surfaces decisions in plain prose, with orchestrator's lean for each. Format above.
2. User confirms ("confirm" or equivalent) or reshapes specific decisions.
3. Orchestrator drafts prompt with decisions incorporated as a "Scope decisions confirmed" section near the top.
4. Drafted prompt goes to executor with decisions resolved.

**Anti-pattern:** Surfacing decisions in the prompt itself ("you decide whether X or Y"). The executor then makes a unilateral call which may or may not match user intent. The pre-conversation captures user intent before drafting begins.

**When this fails:** If the user's reshape introduces new dependencies or downstream decisions, iterate the pre-conversation rather than rushing to draft. One additional round of pre-conversation is cheap; back-and-forth during execution is expensive.

---

## §9.5 Acceptance harness as discovery instrument (new)

P0 lived experience: the acceptance harness at T-0019 (task 20 of 22) surfaced three real source bugs that unit tests had missed:
- A timeout race between the CLI and the daemon's tunnel manager
- Sub-millisecond timing that rounded to zero, violating an AC's "non-zero" wording
- DNS resolution chain dependencies that fetch couldn't satisfy

These bugs lived undetected for ~9 tasks. Earlier acceptance harness construction would have caught them at the introducing tasks.

**Methodology principle (v0.4):** Build the acceptance harness as soon as the first end-to-end happy path is technically possible. Treat the harness as a **discovery instrument**, not a verification ceremony.

**Operationalization:**
- For projects with a clear "first end-to-end" milestone, schedule acceptance-harness construction within the first 1/3 of tasks
- The harness need not cover all ACs initially; start with the happy path and extend as ACs land
- Reactive source-bugs surfaced by the harness are HIGH-VALUE calibration data; the methodology should celebrate, not minimize, these finds

**Mechanically verifiable vs smoke-verifiable vs inferable distinction (v0.4):**

Three categories of AC verification:
1. **Mechanically verifiable.** Assert in code; run in CI. Example: timing assertions, audit-log shape assertions.
2. **Smoke-verifiable.** Needs a human in front of a UI, or a fresh manual run on a real environment. Example: AC requiring observation of a UX behavior.
3. **Inferable from mechanical + reasoning.** Proven by unit test + architectural review; accepted at gate. Example: time-based behaviors that would require unreasonable wait or clock-fake to verify live.

Prompts and AC lists should explicitly tag each AC with its verification category. Smoke-only items must not be treated as gate-blocking by mechanical-only verification.

---

## §11 Pattern library (revised)

v0.3 specifies pre-populated pattern library at day zero. v0.4 adds two patterns to the default day-zero list based on P0 experience:

**Added to default day-zero pre-population:**
- `test-conventions.md` — mock vs real-service-with-stubs; addressOverride/test-only options for parallel-safe testing; microtask flush via setImmediate for async state machines
- `runtime-helpers.md` — cross-platform helpers (path normalization, address transforms, OS-detection); extract-on-third-use vs inline-duplicate-with-comment-pointing-to-source

**Refinement to extract-on-third-use guideline (§11.4):** The third use is a strong signal AND a reasonable laziness budget. Earlier extraction (at second use) risks designing the abstraction before all three concrete cases are visible; waiting for the third forces concrete-first thinking. Codify as: "Inline-duplicate with comment naming the source location for first two uses; extract on the third use, even if extraction looks obvious at use #2."

---

## §17.7 Context snapshot artifacts (new)

P0 lived experience: a single orchestrator conversation handled 22 tasks across 2.5 weeks. This required two intermediate context snapshots (at natural breaks in execution) plus a final close snapshot for the gate transition.

**Methodology principle:** Long orchestrator conversations require active context management. The orchestrator should produce a context snapshot artifact:
- At any pause longer than ~24 hours
- When context window approaches ~75% capacity (heuristic; varies by model)
- At gate boundaries (always; the snapshot becomes the handoff artifact for the next gate's conversation)

**Snapshot structure:**
- Date
- Phase / gate status
- Commits to date (one-liner each)
- Open AC status table
- Open questions status
- Pattern library status
- Calibration findings (rolling)
- Cross-cutting concerns status
- Next actions
- Resume protocol (specific to where the project is)

Store snapshots in `docs/snapshot/` (or equivalent project-specific location).

**Resume protocol:** When opening a new conversation after a snapshot was taken, the user pastes the snapshot file as the first message. The new orchestrator instance has full context immediately.

This pattern made the 22-task P0 viable in a single conversation. Without it, each task's context-rebuild would have consumed tokens that scale linearly with project history.

---

## §22.1 Commit messages (revised)

v0.3 specifies `type: scope — description` for subject lines. v0.4 codifies body conventions:

**Subject line:** Unchanged from v0.3.

**Body (when used):**
- Blank line after subject
- First paragraph: what shipped + verdict reference (e.g. "T-NNNN CLOSED — verdict CONFIRMED")
- Second paragraph: bulleted list of substantive changes (files/scope/behavior)
- Third paragraph: calibration data point (timing-vs-prediction, deviation count, streak counters)
- Fourth paragraph (optional): forward-pointing implications (next-task setup, follow-up flags)

**Length discipline:** Body paragraphs are 2-5 lines each. Bullets are one line where possible. Total body target: 15-30 lines for substantive commits; shorter is fine for trivial commits.

**Single-line commits are acceptable for trivial commits.** Documentation-only commits, status-field flips, or single-line fixes don't need a body if the subject is self-explanatory.

---

## §22.5 Reactive-fix consultation triggers (new)

v0.3 §15 discusses executor errors and reactive deviations broadly. v0.4 codifies which categories of reactive fix require orchestrator consultation BEFORE acting (vs the default "fix at site, document in REASONING"):

**Always consult orchestrator first:**
- Adding a new runtime dependency (production code)
- Modifying code from a prior closed task (cross-task carry beyond what the current task scope explicitly authorizes)
- Anything touching CI / lockfile / .gitignore beyond auto-updates
- Architectural changes that affect more than one file beyond the task's stated deliverables

**Default to reactive fix at site, document in REASONING:**
- Lint deviations (config-level adjustments justified by encountered patterns)
- Test infrastructure (test-only deps, harness adjustments, fake/mock patterns)
- One-line fixes to issues discovered during current task's scope
- Local refactors within the current task's modified files

**When uncertain, default to consult.** A 30-second orchestrator round-trip is cheaper than a 30-minute scope-drift conversation later.

---

## §25 Calibration phase (revised)

v0.3 §25 specifies the calibration phase concept. v0.4 refines:

**§25.3 Calibration closure criteria (refined):**
v0.3 lists multiple criteria. v0.4 adds an empirical test: ask "Do I need to stop and think about which way this is going to fail?" If the answer is consistently "no, I just write the code," calibration is over for the toolchain/pattern in question.

**§25.4 Steady-state token discipline (new sub-section):**
After calibration closes:
- Prompts: target 1-3K words for non-trivial tasks; 500-1500 for trivial
- Reports: paragraph form per §3.5.1's revised forms
- Verdicts: paragraph form per §7.4's steady-state form
- Doc-edit deltas: verbatim find/replace (no narrative)
- Verbatim discipline: only files NOT in the canonical commit

**§25.5 Calibration phase artifacts (new):**
During calibration, maintain a calibration log section in project-state.md. Each calibration-phase task should produce 1-3 findings. The log becomes the basis for steady-state mode transition (review the log; if findings are stable and patterns are populated, declare steady-state).

---

# New parts

## Part IX — Changes from v0.3 (changelog and empirical basis)

### Summary of changes

| Section | Change type | Empirical basis |
|---------|-------------|-----------------|
| §3.5.1 | Restructured into three forms | Trivial tasks (5-min, 2-min) producing full reports = report-to-work ratio too high |
| §3.5.2 | New: fast-path forms | Same |
| §7.4 | Calibration vs steady-state verdict forms | Per-AC tables during calibration; paragraph form after |
| §8 | Doc-edit deltas codified; AC nesting capped at 2 levels | Find/replace pairs had ~0 error rate; deep nesting reduced reliability |
| §8.5, §8.6 | Scope-decision pre-conversation elevated to required | Used 2× in P0; compressed 3-4 rounds into 1 |
| §9.5 | Acceptance harness as discovery instrument | T-0019 surfaced 3 real bugs that unit tests missed |
| §11 | Day-zero patterns extended | Test-conventions and runtime-helpers patterns emerged organically; could have shipped pre-populated |
| §14.7 | Working-tree-mid-dispatch protocol | T-0017→T-0018 and T-0019.6→T-0019.7 incidents |
| §15.6 | Reactive-deviation boundary list | T-0019's READY_TIMEOUT_MS bump and undici devDep raised "should I consult?" questions |
| §17.7 | Context snapshot artifacts | 22-task conversation required 3 snapshots to stay viable |
| §22.1 | Commit message body conventions | P0 commit bodies converged on a stable form; codify |
| §22.5 | Reactive-fix consultation triggers | Two real cases warranted consultation; methodology didn't specify when |
| §25 | Calibration closure criteria refined | "Do I need to stop and think which way it will fail?" was the actual signal |
| §29.4 | Three forms of verification | SMOKE-2 finding showed mechanical-only verification has gaps |

### Findings NOT codified in v0.4 (but worth tracking)

These showed up in P0 but the methodology should hold open the possibility that they're claude-bridge-specific rather than general:

- **`recommendedTypeChecked` for TypeScript projects:** 17 consecutive zero-fire streak suggests the rule pack delivers two value streams (preventive on async; reactive on type safety). v0.4 does not mandate this for all TypeScript projects — sample size of one. Future projects should try it and report.
- **PowerShell-as-primary-shell findings:** the file-handle inheritance trap, the `$Args` reserved-name conflict — these are real but Windows-PowerShell-specific. v0.4 does not codify them as cross-cutting concerns. Project-level patterns/conventions handle them.
- **Cloudflared as tunnel choice:** environmental DNS resolution issues with newly-issued subdomains — claude-bridge-specific.

The methodology should hold open that v0.4's empirical findings may not all generalize. Three or four projects under v0.4 would tell us more about which patterns are durable vs claude-bridge-shaped.

### Self-discipline for v0.5

v0.4 emerged from one project. v0.5 should require evidence from at least one additional project, and should refine v0.4 sections based on cross-project comparison. The methodology benefits from the same calibration discipline the projects do.

---

# New sections (referenced in TOC above)

## §14.7 Working-tree-state-mid-dispatch protocol (new)

**Scenario:** Orchestrator dispatches task T-(N+1) before issuing closure verdict on task T-N. Executor's working tree may have uncommitted changes from T-N.

**Protocol:**

1. Executor identifies the situation: "I have uncommitted work from T-N; the dispatch for T-(N+1) has arrived."
2. Executor checks `git status` to confirm what's uncommitted.
3. Executor consults user (NOT orchestrator) on resolution:
   - Single bundled commit (T-N + T-(N+1) together)
   - Two commits (commit T-N first; dispatch T-(N+1) verdict-pending)
   - Pause and request orchestrator's T-N verdict first
4. User chooses; executor proceeds.

**Anti-pattern:** Silent bundling without user awareness. Even if outcome is identical, the audit trail loses the explicit decision.

---

## §29.4 Three forms of verification (new)

See §9.5 for the categorical distinction. This section formalizes the convention.

**When writing AC lists:**
- Each AC is tagged with its verification category: `[MECH]`, `[SMOKE]`, or `[INFER]`
- The acceptance harness implements `[MECH]` ACs
- The runbook documents the procedure for `[SMOKE]` ACs
- `[INFER]` ACs are accepted at gate with documented rationale (typically unit-test reference + architectural argument)

**Gate close decision:** All `[MECH]` ACs must be verified by the acceptance harness. All `[SMOKE]` ACs must have a documented verification procedure (executed at least once, or accepted at gate). All `[INFER]` ACs require explicit gate-close acceptance with rationale.

**Anti-pattern:** Marking `[SMOKE]` or `[INFER]` ACs as "VERIFIED" without the corresponding ceremony. The category determines what "verified" means.

---

# Appendices (unchanged from v0.3)

A, B, and C from v0.3 carry forward. New Appendix D added:

## Appendix D — Calibration data examples (new)

Real timing data from claude-bridge P0 (for reference; future projects' calibration data goes here too):

| Task | Predicted bucket | Actual | Notes |
|------|------------------|--------|-------|
| T-0017 | Small | (not timed) | Pre-timing-requirement |
| T-0018 | Trivial (5-15) | 5 min | First trivial baseline |
| T-0019 | Medium-fresh (60-120) | 60 min | Acceptance harness; surfaced 3 source bugs |
| T-0019.5 | Trivial (5-15) | 5 min | Single-line + conventions |
| T-0019.6 | Trivial+setup (10-20) | 17 min | WSL env install overhead |
| T-0019.7 | Trivial (2-5) | 2 min | Smallest task; cell edits only |
| T-0020 | Medium-consolidation (5-15) | 6 min | New bucket; consolidating known material |

**Bucket definitions (calibrated by claude-bridge P0):**
- **Trivial:** 2-5 min — single-cell edits, status flips, doc-only verbatim
- **Trivial+code:** 5-15 min — single-line code change + verification
- **Trivial+setup:** 10-20 min — verification requiring fresh environment install
- **Small:** 30-60 min — one new module + tests; following established patterns
- **Medium-consolidation:** 5-15 min — doc tasks consolidating already-known material (no discovery)
- **Medium-fresh:** 60-120 min — new functionality with discovery component
- **Large:** 2h+ — architectural; multiple subsystems

Future projects should record their own calibration data and refine these bands.

---

# Document history (Appendix C extension)

- v0.1 (April 2026): Initial draft based on POP-coco3 experience
- v0.2 (May 11 2026): Refinement; mostly POP-coco3-specific bindings
- v0.3 (May 21 2026): Synthesis with Three-Role Collaboration seed; broadly applicable
- **v0.4 (May 23 2026):** Empirical refinement from claude-bridge P0 (22 tasks). Delta document over v0.3. First version with cross-project empirical basis.

End of v0.4.
