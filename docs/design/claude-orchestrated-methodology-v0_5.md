# Claude-Orchestrated Development Methodology v0.5

**Version:** 0.5
**Author:** Co-developed by user and orchestrator-Claude during the claude-bridge project
**Predecessor:** v0.4 (full replacement; v0.4 superseded by this document)
**Date:** 2026-05-24
**Evidence base:** 12 dispatched tasks in P1 of the claude-bridge project, 8 patterns produced, 3 mid-task scope reshapes, 29 consecutive zero-fire async-discipline runs, dual-band calibration data across multiple task shapes.

---

## Preamble

v0.5 is a full replacement document for v0.4. It is informed by an additional ~12 tasks of evidence from the claude-bridge project's P1 phase (post-P0). The structure follows v0.4's organization but reframes several concepts that the empirical record exposed as needing refinement.

This methodology assumes a three-role architecture:

- **Orchestrator-Claude** (this role): runs in a long-lived chat with the user; drafts dispatches, issues verdicts, maintains the calibration log and pattern inventory.
- **Executor-Claude / Clyde** (Claude Code in a local repo): receives dispatches, implements, commits, reports.
- **User**: the human gate at every decision point. Confirms scope, sets API keys when needed, makes reshape decisions.

The orchestrator never directly modifies code. The executor never makes scope decisions alone. The user is always in the loop for non-trivial choices.

---

## 1. Operating principles

### 1.1 Pre-task scope-decision conversation is the dominant cost reducer

The single most impactful operating change observed in P1: resolving scope decisions *before* the dispatch is drafted, in conversation with the user. This collapses what was previously a multi-prompt cycle (dispatch → executor surfaces decision → orchestrator escalates to user → user decides → executor proceeds) into a single round-trip.

**Pattern:**
1. Orchestrator surfaces 2-5 scope decisions with leans stated.
2. User confirms or reshapes.
3. Orchestrator drafts dispatch with decisions baked in as "Scope decisions confirmed (orchestrator pre-conversation, DATE)" section.
4. Executor proceeds against fully-resolved scope.

**Result across 12 P1 tasks:** zero scope-decision §22.5 escalations during execution. Several mid-task reshapes occurred (see §3.2), but those were orchestrator-initiated, not executor-driven.

**When to use:** every dispatch with more than trivial scope. Skip only for purely mechanical tasks (e.g., a renames-only refactor).

**Anti-pattern:** sending a dispatch with open decisions ("Clyde, decide between X and Y") forces executor escalation and burns orchestrator-handoff cycles.

### 1.2 Single-prompt dispatch format

A dispatch is a single document containing everything the executor needs:

- Task ID + phase reference
- Bucket prediction (dual-band per §5.1)
- Scope decisions confirmed inline
- File targets and acceptance criteria
- Patterns to follow
- Reactive-fix consultation triggers
- Reporting requirements
- Commit message template
- Doc-edit deltas
- Out-of-scope items explicit

The executor performs the work, commits, pushes, and reports — all in one prompt cycle. No separate "now commit" instruction.

**Result:** verification sections of reports map AC-by-AC to the dispatch's AC list with no negotiation about what counts as evidence. Calibration data lives in the same commit as the work it measures.

**Cost:** dispatches are long (typically 200-400 lines for non-trivial tasks). The alternative — splitting across prompts — front-loads less but ends up costing more total context across the cycle. Worth the verbosity.

### 1.3 The user is the gate, not a reviewer

Every non-trivial decision goes through the user. Orchestrator drafts and recommends; user confirms or reshapes; only then does the dispatch go out.

This is different from a model where the user reviews orchestrator output after the fact. By the time the user sees a dispatch, they have already participated in shaping it. Verdicts are issued against pre-confirmed scope, not against work the user has to interpret post-hoc.

---

## 2. Task lifecycle

### 2.1 Scope-decision pre-conversation

Format:

> **Orchestrator:** [N scope decisions for T-X. Each labeled, lean stated, alternatives noted, one thing flagged for explicit user read where applicable.]
>
> **User:** confirm | reshape decision K to [...] | discuss item J

Decisions land in one of three categories:

- **Confirmed at lean** — orchestrator's recommendation accepted, baked into dispatch.
- **Reshaped** — user adjusts; orchestrator updates lean and proceeds.
- **Flagged for executor consultation** — used when neither orchestrator nor user has enough information to decide pre-dispatch; the dispatch contains an explicit `§22.5` consultation trigger at the relevant implementation point.

### 2.2 Dispatch drafting

The dispatch contains, in order:

1. **Header:** task ID, phase, predictions (dual-band per §5), report form reference.
2. **Calibration note:** what task shape this is; why the prediction has the shape it does.
3. **Scope:** what the task delivers.
4. **Scope decisions confirmed:** the pre-conversation outcomes, decision-by-decision.
5. **Files to produce:** with descriptions of contents.
6. **Acceptance criteria:** numbered list, testable.
7. **Patterns to follow:** by reference to project pattern docs.
8. **Reactive-fix consultation triggers:** explicit §22.5 conditions.
9. **User interaction during task (mandatory):** template requiring "None" if no interaction occurred.
10. **Reporting:** Form B template structure.
11. **Commit message:** template with placeholders for elapsed time and variance.
12. **Doc-edit deltas:** which docs the task updates.
13. **Out of scope:** explicit list to prevent scope creep.

### 2.3 Execution

Executor implements per the dispatch. §22.5 consultations fire only on items the dispatch explicitly flagged or on genuinely unforeseen surfaces. Trivial at-site decisions (variable naming, log line wording) are made without consultation.

### 2.4 Reporting

Executor reports in Form B (see §3.5). The report includes:

- Timing block with dual-band variance computed explicitly.
- Summary paragraph.
- Files modified with delta nature.
- Reasoning paragraph addressing dispatch-named questions.
- Verification AC-by-AC.
- Reactive deviations.
- Uncertainty flags.
- Follow-up candidates.
- **User interaction during task** (mandatory, "None" or itemized).
- Commit hash.

### 2.5 Verdict

Orchestrator issues a verdict that:

1. Confirms or rejects the task (typically confirms; rejection is rare and means real defects).
2. Calls out notable items with reasoning.
3. Records pattern decisions (promote / wait for more uses / no-action).
4. Computes calibration data **explicitly with arithmetic**, not paraphrased.
5. Updates the open-items list for the phase-close pass.
6. Acknowledges next-task readiness.

---

## 3. Operating protocols

### 3.1 §22.5 — Reactive-fix consultation

Inherited from v0.4. The executor pauses and consults the orchestrator (via AskUserQuestion or equivalent) when implementing the dispatch surfaces:

- A scope question the dispatch didn't anticipate.
- A reshape-worthy choice (e.g., new runtime dependency, architectural deviation).
- A test that exposes a real defect in production code.
- A platform-specific issue requiring more than ~20 lines of new branching code.

§22.5 should NOT fire for trivial at-site decisions. The dispatch's "reactive-fix consultation triggers" section names what's in-scope for §22.5; everything else is trivial.

### 3.2 Mid-task scope reshape protocol (new in v0.5)

Sometimes the orchestrator realizes after dispatch that a scope decision should be revisited. Three observed cases in P1:

- **T-P1-007:** `diff` package addition pre-approved in dispatch, orchestrator decided post-dispatch to make it a real §22.5 consultation point. Executor was paused before reaching the relevant implementation; user confirmed during AskUserQuestion.
- **T-P1-009:** 32KB prompt cap inclusion was a soft "if it lands cleanly" in the dispatch; orchestrator decided post-dispatch to defer entirely. Follow-up arrived after executor had already implemented; required revert commit.
- (Hypothetical worst case:) reshape arrives after verdict. Not observed in P1.

**Protocol for mid-task reshape:**

1. Orchestrator drafts a short follow-up message (< 1 page) that:
   - Identifies the specific dispatch item being changed.
   - States the new scope explicitly.
   - Acknowledges that the executor may have already done some of the work.
   - Provides recovery instructions for the "already implemented" case (revert vs keep with note).
   - Tells the executor to continue with everything else in the dispatch as written.
2. Orchestrator sends the follow-up to the executor.
3. Executor implements or reverts; reports the state in the next message.
4. Orchestrator's verdict acknowledges the reshape sequence.

**Cost classification:**

| Timing | Cost shape |
|---|---|
| Before implementation reaches the affected item | Cheap — single AskUserQuestion round-trip |
| After implementation but before commit | Revert at desk; ~5-10 min |
| After commit but before report | Revert commit; ~10-15 min |
| After report/verdict | Withdraw verdict, revert commit, new verdict; ~15-30 min |

The cost grows fast. Orchestrator should reshape only when the new scope materially changes outcomes; reshape-because-better-on-reflection is often worse than accepting the original implementation.

**Decision heuristic for "reshape or accept":**

- Is the original implementation harmless? → strong default to "accept and note for next cycle."
- Does the reshape introduce lock-in that the original doesn't? → strong default to "reshape now."
- Is the cost difference between revert and rewrite-as-followup-task negligible? → discuss with user.

### 3.3 Pattern promotion (third-use rule)

A pattern is promoted to a project pattern doc (`docs/patterns/project/<name>.md`) when used in three or more distinct contexts. Single-use is not pattern material; double-use is a candidate; triple-use is promotion.

In P1, this rule produced 8 promoted patterns. Several candidates at single or double use remain in the queue:

- `unwrapOrThrow` harness pattern (1 use; strong candidate).
- `requireCli(name)` helper (1 use; CLI gating).
- `lazy-load-with-graceful-degradation` (1 use; T-P1-012 undici).

Wait for third use before promotion. Resist the urge to promote early.

### 3.4 Calibration log maintenance

Every task's actual elapsed time and variance gets recorded in a calibration log at the end of the dispatch cycle. The log includes:

- Task ID.
- Bucket-empirical prediction (range + midpoint).
- Bucket-legacy prediction (range + midpoint).
- Actual elapsed.
- Variance vs empirical (low edge / midpoint / high edge percentages).
- Variance vs legacy midpoint.
- Brief commentary on shape (in-band, sub-band, at-band-edge; what shape of work this was).

This data drives the empirical band table refinement (§5.2). Without explicit arithmetic in verdicts, the data is unreliable.

### 3.5 Report formats

**Form B (standard):** the structure described in §2.4 above. Used for all non-trivial tasks. Required for P1's empirical-band-feeding tasks.

**Form A (light):** for tasks under 5 minutes (e.g., README typo fixes, single-line config changes). Drops the "Reasoning" paragraph and "Follow-up candidates"; keeps verification and timing.

**Mandatory in both forms (new in v0.5):** "User interaction during task" section. If no interaction occurred, the executor writes "None." explicitly. This section helps the orchestrator interpret reports correctly — silent assumptions in implementation are caught by reading what conversation (if any) happened during execution.

---

## 4. Roles and responsibilities

### 4.1 Orchestrator

**Owns:**
- Drafting dispatches.
- Scope-decision conversations with the user.
- Verdicts and pattern decisions.
- Calibration log.
- Open-items list for phase-close.
- Methodology evolution.

**Does NOT:**
- Modify code directly.
- Run tests or execute commands.
- Make scope decisions without user confirmation.
- Issue verdicts on its own draft (executor work only).

### 4.2 Executor (Clyde / Claude Code)

**Owns:**
- Implementation per dispatch.
- Test creation and execution.
- Commits and pushes.
- §22.5 consultations when triggered.
- Reports.

**Does NOT:**
- Make scope decisions independently (only at-site trivial choices).
- Modify the dispatch.
- Issue verdicts.

### 4.3 User

**Owns:**
- Scope-decision confirmations.
- Mid-task reshape decisions.
- API key handling (never on disk).
- Final gate on all phase transitions.

---

## 5. Calibration

### 5.1 Dual-band reporting (new standard in v0.5)

Every prediction is stated as two bands:

- **Empirical band:** derived from this project's history. Reflects the actual cost profile observed for similar tasks.
- **Legacy band:** the older size-bucket framework (Trivial / Small / Small-medium / Medium-fresh / Large). Kept as reference annotation.

Both predictions go in the dispatch's header. Both variances go in the verdict.

**Why dual-band:**

The empirical bands have evolved through P1 evidence. The legacy bands are pre-empirical guesses from v0.4. Dual reporting:

1. Provides historical continuity (legacy bands tell us what we thought a task would take in the v0.4 framework).
2. Tracks empirical band refinement (variance vs empirical tells us if the band needs adjustment).
3. Lets reviewers see both perspectives without forcing a single number.

### 5.2 Empirical band table (refined from P1 evidence)

P1 yielded 12 datapoints. The refined band table:

| Task shape | Empirical band | Notes |
|---|---|---|
| Pure-code, discovery-deferred (target shape documented; no real-time discovery) | 6-10 min | Strong floor; 5 datapoints |
| Pure-code, real discovery (orchestrator + executor pair through new design surface) | 14-18 min | 2 datapoints (T-P1-003, T-P1-009) |
| Live-cycle harness (StubJobRunner; real daemon spawn/stop; debug-fix-rerun cycles possible) | 15-25 min | 2 datapoints (T-P1-004, T-P1-005) |
| Live-API unit-test (live SDK calls in test suite; reactive-debug headroom possible) | 12-25 min | 1 datapoint (T-P1-010 at 24) |
| Live-API wire-path harness (live SDK + MCP roundtrip; harness production + reactive fix) | 20-30 min | 1 datapoint (T-P1-011 at 30, high edge) |
| Cross-platform validation (execution-only; platform fixes possible) | 15-25 min when fixes needed; 8-15 min when not | 1 datapoint (T-P1-012 at 20, midpoint, with two fixes) |

**Caveats:**

- Bands are project-local; transfer to other projects requires fresh calibration.
- Discovery surface is the dominant variance driver. "Discovery-deferred via documented assumption" tasks land at the floor; "real discovery during execution" tasks land at the upper edge.
- Live-runtime tasks consume 5-10 min of upper-band headroom when defects surface. Floor and ceiling should both account for this.

### 5.3 Variance arithmetic discipline

Verdicts compute variance explicitly with arithmetic, not paraphrased from the executor's report. Examples:

✅ "Empirical band 25-45 min, midpoint 35; actual 24. Variance: -4% below low edge, -31% below midpoint. **Below band by one minute** — close enough that the band shape is approximately right, with the floor needing adjustment."

❌ "Within empirical band (low-mid)." [Echoing the executor without recomputing.]

The discipline catches the orchestrator's narrative-fitting tendency. If the prediction and actual disagree, the data wins; the band needs adjustment.

### 5.4 Prediction reasoning in dispatches

Predictions are stated with explicit reasoning, not just numbers:

> Bucket prediction (empirical): ~25-40 min. Empirical base: T-P1-005 (live-cycle harness, 16 min) + T-P1-010 (~5 min reactive-debug headroom) = ~20 min floor. Upper edge captures another debug cycle if surfaced. If T-P1-009 lands sub-band, the live-API overhead is smaller than estimated; if in-band, the estimate was right.

This makes predictions auditable. The user (and the orchestrator on review) can see what assumptions drove the band shape and push back on bad anchors.

---

## 6. The docs-describe-happy-path runtime-reveals-edges pattern (new in v0.5)

### 6.1 The pattern

Pre-dispatch discovery via documentation resolves Q-items at design-conviction level. But documentation describes the happy path. Runtime exercise reveals edge cases that documentation doesn't capture.

P1 evidence (three instances):

- **T-P1-008 transcript shape:** orchestrator-side docs read concluded that messages have `type: "user" | "assistant" | "system"` with `content` field. Reality: assistant messages nest content under `.message.content` (full Anthropic BetaMessage). Executor-side .d.ts inspection revealed.
- **T-P1-009 cancellation primitives:** orchestrator-side docs identified `query.interrupt()` and `query.close()` as cancellation primitives. Reality: `interrupt()` is streaming-input-only; `close()` doesn't exist on the Query interface. Executor-side .d.ts inspection revealed; `AbortController` is the actual primitive for non-streaming.
- **T-P1-010 read_only enforcement:** orchestrator-side docs confidently mapped `read_only → "plan"` based on "planning mode — read-only tools only." Reality: `ExitPlanMode` tool flips `permissionMode` to `"default"`, undoing read-only. Live SMOKE run revealed; fixed via `READ_ONLY_DISALLOWED_TOOLS` belt-and-suspenders.

### 6.2 Protocol

When orchestrator-side discovery is documentation-only, the dispatch should explicitly note this and instruct the executor to verify against actual type definitions or runtime behavior before commit:

> **Pre-dispatch discovery (orchestrator side, DATE):** [Findings from docs.] Lower-confidence resolutions flagged; executor verifies against actual .d.ts / runtime before committing implementation.

Live SMOKE/integration tests are the strongest reveal mechanism for runtime edges. Where possible, dispatch should include at least one live-exercise AC that fires the documented behavior end-to-end.

### 6.3 Implication for v0.5 dispatches

The "Pre-dispatch discovery" section in dispatches (when present) is not a substitute for executor verification. It is a **prior**, not a **fact**. Executor surfaces deviations as either §22.5 consultations or in-scope at-site adjustments depending on materiality.

---

## 7. Harness brittleness defense (new in v0.5)

### 7.1 The pattern

Test infrastructure can produce false-PASS results when the framework's error envelope is not unwrapped before assertion. P1 evidence:

- **T-P1-011 AC-6 first-run:** harness used `wait_ms: 90000`. The shared `PollInputSchema` capped `wait_ms` at 60000. MCP boundary rejected the request with `isError: true`. Harness's `extractResult` returned bare result object (no `structuredContent`). Assertion `p.status === "cancelled"` evaluated `undefined === "cancelled"` → false. **Test "passed" in 38 milliseconds.**

A delegation that took milliseconds to "pass" was the red flag. The actual SDK delegation takes 6-40 seconds.

### 7.2 Defense: unwrap-or-throw discipline

Harness layers between MCP/RPC and assertion must unwrap error envelopes before returning results. Pattern:

```javascript
function unwrapOrThrow(callResult, where) {
  if (callResult.isError) {
    throw new Error(`MCP error at ${where}: ${callResult.content?.[0]?.text ?? "unknown"}`);
  }
  return callResult;
}
```

Used as:

```javascript
const polled = unwrapOrThrow(await callTool(client, "poll_delegation", {...}), "poll AC-6");
```

Any schema-rejection or error-envelope returned by the MCP boundary surfaces as a loud test failure, not a silent-undefined pass.

### 7.3 Heuristic: tests that pass too fast are red flags

If a test claims to verify behavior that takes seconds-to-minutes (live API, cross-process, network round-trips) and passes in milliseconds, **stop and inspect**. Likely an assertion-on-undefined or error-envelope-not-unwrapped condition.

Apply this heuristic during code review, during execution debug cycles, and during calibration analysis.

### 7.4 Generalization

Beyond unwrap-or-throw, defend assertions against unexpected falsy/undefined values:

- ✅ `expect(result.status).toBe("cancelled")` if you know status will be defined.
- ✅ `expect(result.status).toBeOneOf(["complete", "failed"]) && expect(file).not.toExist()` for semantic contracts.
- ❌ `expect(result.status !== "cancelled" && !fileExists)` — `undefined !== "cancelled"` evaluates true; passes when status is undefined.

Tighten assertions to require defined values that match positive semantic contracts, not negative anti-conditions that pass on undefined.

---

## 8. Cross-platform discipline (CC-N artifacts)

### 8.1 CC-1 through CC-3 (inherited from v0.4)

- **CC-1:** Path-handling discipline (forward-slashes in canonical paths; use `path.join` and `path.sep`; use `pathToFileURL` for file URIs).
- **CC-2:** Process and signal handling differences (Windows vs Unix; SIGTERM/SIGKILL/taskkill; subprocess cleanup).
- **CC-3:** File permissions (Unix mode bits set-but-ignored on Windows; platform-skip tests with explanation).

### 8.2 CC-4 (new in v0.5): Defensive clean-install for cross-platform validation

Before validating on a new platform, defensively clean and reinstall:

```
rm -rf node_modules packages/*/node_modules
npm install
npm run build
```

Reasoning: stale state from prior platform's installs can mask real issues OR introduce confusing failure modes. T-P1-010 hit orphaned `.d.ts.map` files; T-P1-012 had a different undici-loading failure that the clean install didn't fix but made reproducible. Defensive clean install is not always *necessary*; it is always **defensible**.

### 8.3 CC-5 (new in v0.5): Lazy-load with graceful degradation for rare-case dependencies

Dependencies that are load-bearing only for rare cases (e.g., specific URL patterns, specific platforms) should be lazy-loaded with a stderr warning on failure:

```javascript
let undici;
try {
  undici = await import("undici");
} catch (err) {
  console.warn(`undici unavailable (${err.message}); falling back to default fetch behavior`);
}
```

Reasoning: T-P1-012's MCP-client undici workaround was only load-bearing for `*.trycloudflare.com` URLs. Localhost paths didn't need it. Static import broke on Node 20.18; lazy import with degradation preserved the workaround when available and didn't crash when not.

### 8.4 CC-6 (new in v0.5): Node engine pinning matrix

Document minimum supported Node version per host:

- Daemon runtime: Node 20.10+ (P0).
- SDK runtime: Node 20.19+ recommended, 20.18+ works with degradation.
- WSL guest: matches the WSL distro's available Node packages; user-local installs may lag.

A clearer pinned floor prevents the late-binding surprise that surfaced in T-P1-010 (Node 20.18 vs SDK 20.19 warning) and T-P1-012 (undici crash on 20.18).

---

## 9. Pattern doc structure

Patterns live in `docs/patterns/project/<name>.md`. Structure (template, normalized in v0.5):

```markdown
# Pattern: <name>

**Type:** [Code / Test / Infrastructure / Process]
**Scope:** [Project / Cross-project]
**Applies to:** [What problem this solves]
**Status:** [Active / Deprecated]
**History:** [First use; promotion date; substantive revisions]

## Description

[1-3 paragraphs explaining what the pattern is and what problem it solves.]

## Rules

[Explicit rules — what to do, what not to do.]

## Example

[Code or text showing the pattern applied.]

## Anti-example

[Code or text showing what the pattern prevents.]

## Caveats

[Known limitations, conditions where the pattern doesn't apply, edge cases.]

## References

[Use sites — task IDs and brief notes.]
```

P0 patterns (1-6) and the T-P1-008 pattern (8) use slightly different earlier templates. Normalization is a P2 candidate; not blocking.

---

## 10. Open methodology questions (v0.6 candidates)

These were raised in P1 but not resolved:

- **"Pure-code-no-discovery vs pure-code-with-discovery"** as a formal task-shape classification axis for empirical bands.
- **"Deferred-discovery-via-documented-assumption"** as an orthogonal axis (a task can be pure-code AND have discovery surface AND defer the discovery).
- **"Reshape-cost-vs-stay-cost"** as a structured decision framework for mid-task reshapes (when is reshape worth the cost vs accepting the original implementation).
- **Pattern doc template normalization** for the existing 8 patterns.
- **Live-API task variance characterization** — model nondeterminism can produce 5x wall-time variance for the same semantic test outcome (T-P1-012 AC-6: 38s Windows vs 7s WSL). Methodology should distinguish "infrastructure variance" from "model variance" in calibration.

---

## 11. What v0.5 explicitly does NOT change from v0.4

- Three-role architecture.
- §22.5 reactive-fix consultation protocol.
- Acceptance-harness-first discipline for phases with cross-process behavior.
- Pattern doc location and naming convention (`docs/patterns/project/<name>.md`).
- Doc-debt deferral to phase-close sweeps.
- "User is the gate" principle.

These were validated through P1 without modification needed.

---

## 12. Migration notes (v0.4 → v0.5)

For projects mid-flight on v0.4:

1. Adopt dual-band reporting at next dispatch boundary.
2. Add "User interaction during task" section to next dispatch's Form B template.
3. Compute variance arithmetic in next verdict.
4. Surface any docs-only Q-item resolutions with an explicit "verify before committing" note in next dispatch.
5. Carry forward existing pattern inventory; promote per §3.3 rules.
6. Empirical bands for the new project will need fresh calibration; the P1 band table from claude-bridge is project-local.

No retroactive doc updates required. v0.5 takes effect at the next dispatch.

---

## End of v0.5

**Status:** Active.
**Next review:** end of claude-bridge P2, or when 5+ tasks of additional evidence accumulate.
**Author signature:** Co-developed during the claude-bridge P1 phase (T-P1-001 through T-P1-012). Evidence base: 12 dispatched tasks, 8 patterns, 3 mid-task reshapes, 29 consecutive zero-fire async-discipline runs.
