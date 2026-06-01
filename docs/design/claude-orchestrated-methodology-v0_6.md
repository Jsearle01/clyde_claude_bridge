# Claude-Orchestrated Development Methodology v0.6

**Version:** 0.6
**Author:** Co-developed by user and orchestrator-Claude during the claude-bridge project
**Predecessor:** v0.5 (full replacement; v0.5 superseded by this document)
**Date:** 2026-05-30
**Evidence base:** 12 P1 tasks + 22 P2 tasks = 34 dispatched tasks in the claude-bridge project, 9 promoted patterns, 5 mid-task scope reshapes, 47 consecutive zero-fire async-discipline runs, dual-band calibration data across multiple task shapes, scope-lock-driven codification of 8 numbered conventions + 3-rule verdict-time evidence sub-protocol.

---

## Preamble

v0.6 is a full replacement document for v0.5. It is informed by 22 additional dispatched tasks from the claude-bridge project's P2 phase. The structure follows v0.5's organization; new and revised sections are explicit, and a Changelog (§15) lists every substantive delta with empirical basis.

The substance of v0.5 — three-role architecture, pre-task scope conversation, single-prompt dispatch, dual-band calibration, harness-brittleness defense, cross-platform discipline — is preserved verbatim where this document does not mark it as changed. Where it is marked as changed, the change is annotated inline AND summarized in §15.

This methodology assumes a three-role architecture:

- **Orchestrator-Claude** (this role): runs in a long-lived chat with the user; drafts dispatches, issues verdicts, maintains the calibration log and pattern inventory.
- **Executor-Claude / Clyde** (Claude Code in a local repo): receives dispatches, implements, commits, reports.
- **User**: the human gate at every decision point. Confirms scope, sets API keys when needed, makes reshape decisions.

The orchestrator never directly modifies code. The executor never makes scope decisions alone. The user is always in the loop for non-trivial choices.

---

## 1. Operating principles

### 1.1 Pre-task scope-decision conversation is the dominant cost reducer

The single most impactful operating change observed in P1 (and reconfirmed across 22 P2 tasks): resolving scope decisions *before* the dispatch is drafted, in conversation with the user. This collapses what was previously a multi-prompt cycle (dispatch → executor surfaces decision → orchestrator escalates to user → user decides → executor proceeds) into a single round-trip.

**Pattern:**
1. Orchestrator surfaces 2-5 scope decisions with leans stated.
2. User confirms or reshapes.
3. Orchestrator drafts dispatch with decisions baked in as "Scope decisions confirmed (orchestrator pre-conversation, DATE)" section.
4. Executor proceeds against fully-resolved scope.

**Result across 34 dispatched tasks (P1 + P2):** zero scope-decision §22.5 escalations during execution on tasks with pre-conversation. Several mid-task reshapes occurred (see §3.2), but those were orchestrator-initiated, not executor-driven.

**When to use:** every dispatch with more than trivial scope. Skip only for purely mechanical tasks (e.g., a renames-only refactor).

**Anti-pattern:** sending a dispatch with open decisions ("Clyde, decide between X and Y") forces executor escalation and burns orchestrator-handoff cycles.

### 1.2 Single-prompt dispatch format

A dispatch is a single document containing everything the executor needs:

- Task ID + phase reference
- Bucket prediction (dual-band per §5.1)
- Pre-dispatch grep (C-13 per §10.1) section enumerating verification targets
- Scope decisions confirmed inline
- File targets and acceptance criteria
- Patterns to follow
- Reactive-fix consultation triggers
- Reporting requirements (including mandatory elapsed-time block per C-35 / §10.8)
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
4. **Pre-dispatch grep (C-13):** verification targets per §10.1, with hard-stop conditions per §10.7 named explicitly where appropriate.
5. **Scope decisions confirmed:** the pre-conversation outcomes, decision-by-decision.
6. **Files to produce:** with descriptions of contents.
7. **Acceptance criteria:** numbered list, testable.
8. **Patterns to follow:** by reference to project pattern docs.
9. **Reactive-fix consultation triggers:** explicit §22.5 conditions.
10. **User interaction during task (mandatory):** template requiring "None" if no interaction occurred.
11. **Reporting:** Form A or Form B template structure, **including mandatory elapsed-time block per C-35 / §10.8**.
12. **Commit message:** template with placeholders for elapsed time and variance.
13. **Doc-edit deltas:** which docs the task updates.
14. **Out of scope:** explicit list to prevent scope creep.

### 2.3 Execution

Executor implements per the dispatch. §22.5 consultations fire only on items the dispatch explicitly flagged or on genuinely unforeseen surfaces. Trivial at-site decisions (variable naming, log line wording) are made without consultation.

### 2.4 Reporting

Executor reports in Form A or Form B (see §3.5). Every report — regardless of form — includes the mandatory elapsed-time block per C-35 / §10.8.

### 2.5 Verdict

Orchestrator issues a verdict that:

1. Confirms or rejects the task (typically confirms; rejection is rare and means real defects).
2. Calls out notable items with reasoning.
3. Records pattern decisions (promote / wait for more uses / no-action).
4. Computes calibration data **explicitly with arithmetic**, not paraphrased.
5. Cites verdict-time evidence per §11 (sub-rules 25.1, 25.2, 25.3 applied as task shape warrants).
6. Updates the open-items list for the phase-close pass.
7. Acknowledges next-task readiness.

---

## 3. Operating protocols

### 3.1 §22.5 — Reactive-fix consultation

Inherited from v0.4 and v0.5. The executor pauses and consults the orchestrator (via AskUserQuestion or equivalent) when implementing the dispatch surfaces:

- A scope question the dispatch didn't anticipate.
- A reshape-worthy choice (e.g., new runtime dependency, architectural deviation).
- A test that exposes a real defect in production code.
- A platform-specific issue requiring more than ~20 lines of new branching code.

§22.5 should NOT fire for trivial at-site decisions. The dispatch's "reactive-fix consultation triggers" section names what's in-scope for §22.5; everything else is trivial.

**Distinction from hard-stop guards (C-34 / §10.7):** §22.5 reshapes scope on the fly; a hard-stop guard halts the task and returns control to the orchestrator. Use hard-stop guards when the alternative is implementation drift from spec; use §22.5 when a small in-scope reshape is reasonable.

### 3.2 Mid-task scope reshape protocol

Sometimes the orchestrator realizes after dispatch that a scope decision should be revisited. Observed cases in P1 and P2:

- **T-P1-007:** `diff` package addition pre-approved in dispatch, orchestrator decided post-dispatch to make it a real §22.5 consultation point. Executor was paused before reaching the relevant implementation; user confirmed during AskUserQuestion.
- **T-P1-009:** 32KB prompt cap inclusion was a soft "if it lands cleanly" in the dispatch; orchestrator decided post-dispatch to defer entirely. Follow-up arrived after executor had already implemented; required revert commit.
- **T-P2-004 → 004.5 → 004.6:** orchestrator's initial fix narrowing dismissed `shell: true` (the actual CVE-2024-27980 workaround) on incorrect grounds; required a third dispatch to land the right fix. Logged as C-22 (the orchestrator-narrowing-audit pattern).

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

In P1, this rule produced 8 promoted patterns. P2 added a 9th (`settable-single-subscriber-callback`, promoted at T-P2-006-followup with 5 instances at promotion time).

Several candidates at single or double use remain in the queue:

- Fire-and-forget `send()` vs `request<R>()` shape on IPC clients.
- Layered shutdown with new layers inserted between existing layers.
- Forward-declaration thunk for circular construction dependencies.
- Pre-fix regression-test verification (write the test against the broken code first; confirm it fails; then apply the fix; confirm it passes).
- Logger as optional constructor parameter for testability.

Wait for third use before promotion. Resist the urge to promote early.

### 3.4 Calibration log maintenance

Every task's actual elapsed time and variance gets recorded in a calibration log at the end of the dispatch cycle. The log includes:

- Task ID.
- Bucket-empirical prediction (range + midpoint).
- Bucket-legacy prediction (range + midpoint).
- Actual elapsed (from C-35 / §10.8 block in the executor's report).
- Variance vs empirical (low edge / midpoint / high edge percentages).
- Variance vs legacy midpoint.
- Brief commentary on shape (in-band, sub-band, at-band-edge; what shape of work this was).
- C-14 classification per §10.2.

This data drives the empirical band table refinement (§5.2). Without explicit arithmetic in verdicts, the data is unreliable.

### 3.5 Report formats

**Form B (standard):** the structure described in §2.4 above. Used for all non-trivial tasks. Required for empirical-band-feeding tasks.

A Form B report includes:

- Timing block with dual-band variance computed explicitly — **and the mandatory C-35 elapsed-time block per §10.8 (this is non-negotiable for any v0.6 report)**.
- Summary paragraph.
- Files modified with delta nature.
- Reasoning paragraph addressing dispatch-named questions.
- Verification AC-by-AC.
- Verdict-time evidence per §11 (sub-rules 25.1, 25.2, 25.3 applied as task shape warrants).
- Reactive deviations.
- Uncertainty flags.
- Follow-up candidates.
- **User interaction during task** (mandatory, "None" or itemized).
- Commit hash.

**Form A (light):** for tasks under 5 minutes (e.g., README typo fixes, single-line config changes). Drops the "Reasoning" paragraph and "Follow-up candidates"; keeps verification, timing, **and the mandatory C-35 elapsed-time block (no form is exempt from C-35)**.

**Mandatory in both forms:** "User interaction during task" section. If no interaction occurred, the executor writes "None." explicitly. This section helps the orchestrator interpret reports correctly — silent assumptions in implementation are caught by reading what conversation (if any) happened during execution.

**Future forms (Form C, Form D, ...) inherit the elapsed-time mandate by default** unless the future form's specification explicitly overrides it (no override has been observed warranted as of v0.6).

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
- §22.5 consultations when triggered; hard-stop reports per C-34 (§10.7) when a precondition fails.
- Reports (Form A or Form B, both with mandatory C-35 elapsed-time block per §10.8).

**Does NOT:**
- Make scope decisions independently (only at-site trivial choices).
- Modify the dispatch.
- Issue verdicts.

### 4.3 User

**Owns:**
- Scope-decision confirmations.
- Mid-task reshape decisions.
- API key handling (never on disk).
- Operator-performed runtime smoke per §11 (sub-rule 25.3) when the task affects build/packaging pipelines.
- Final gate on all phase transitions.

---

## 5. Calibration

### 5.1 Dual-band reporting

Every prediction is stated as two bands:

- **Empirical band:** derived from this project's history. Reflects the actual cost profile observed for similar tasks.
- **Legacy band:** the older size-bucket framework (Trivial / Small / Small-medium / Medium-fresh / Large). Kept as reference annotation.

Both predictions go in the dispatch's header. Both variances go in the verdict.

**Why dual-band:**

The empirical bands have evolved through P1 and P2 evidence. The legacy bands are pre-empirical guesses from v0.4. Dual reporting:

1. Provides historical continuity (legacy bands tell us what we thought a task would take in the v0.4 framework).
2. Tracks empirical band refinement (variance vs empirical tells us if the band needs adjustment).
3. Lets reviewers see both perspectives without forcing a single number.

### 5.2 Empirical band table (refined from P1 + P2 evidence)

P1 yielded 12 datapoints; P2 added 22 more, for a combined evidence base of 34 tasks. The refined table is organized by **task shape** rather than by phase, since shape is the dominant variance driver and bands now transfer across phases.

| Task shape | Empirical band | Notes / source datapoints |
|---|---|---|
| Bounded fix, characterized defect, all decisions pre-resolved | 5-15 min | T-P2-004.5, T-P2-004.6, T-P2-006.5, T-P2-007.5, T-P2-008.5 — consistently sub-band-low or at low edge |
| Pure-code with discovery-deferred (target shape documented; no real-time discovery) | 6-12 min | T-P1-001, T-P1-002, T-P1-006, T-P1-008, T-P2-001 — strong floor |
| Pure-code with real discovery (orchestrator + executor pair through new design surface) | 14-25 min | T-P1-003, T-P1-009, T-P2-002, T-P2-003 |
| Medium-shape pre-resolved (~5 files, multiple subsystems, novel persistence/protocol) | 30-50 min | T-P2-005, T-P2-006, T-P2-007 |
| Large multi-subsystem (8+ files, novel protocol, schema + handler + UX) | 70-100 min | T-P2-008 (98 min, in-band high) |
| Live-cycle harness (StubJobRunner; real daemon spawn/stop; debug-fix-rerun cycles) | 15-30 min | T-P1-004, T-P1-005, T-P2-011 |
| Live-API unit-test (live SDK in test suite; reactive-debug headroom) | 12-30 min | T-P1-010 (24 min) |
| Live-API wire-path harness (live SDK + MCP roundtrip; harness production + reactive fix) | 20-35 min | T-P1-011 (30 min, high edge) |
| Cross-platform validation (execution-only; platform fixes possible) | 15-30 min when fixes needed; 8-15 min when not | T-P1-012, T-P2-012 |
| Doc rewrite + cross-references (≤4 files, decisions pre-resolved) | 15-25 min | T-P1-013, T-P2-013 |
| Methodology codification (this task class) | 25-45 min | T-P2-014 (this task) |
| Diagnostic-add separate task (env-gated instrumentation, no behavior change) | 10-20 min | T-P2-008.6 (per C-33 / §10.6) |

**Caveats:**

- Bands are project-local; transfer to other projects requires fresh calibration.
- Discovery surface is the dominant variance driver within a shape. "Discovery-deferred via documented assumption" tasks land at the floor; "real discovery during execution" tasks land at the upper edge.
- Live-runtime tasks consume 5-10 min of upper-band headroom when defects surface. Floor and ceiling should both account for this.
- See §10.2 (C-14) for the within-band landing position protocol.

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

## 6. The docs-describe-happy-path runtime-reveals-edges pattern

### 6.1 The pattern

Pre-dispatch discovery via documentation resolves Q-items at design-conviction level. But documentation describes the happy path. Runtime exercise reveals edge cases that documentation doesn't capture.

P1 evidence (three instances):

- **T-P1-008 transcript shape:** orchestrator-side docs read concluded that messages have `type: "user" | "assistant" | "system"` with `content` field. Reality: assistant messages nest content under `.message.content` (full Anthropic BetaMessage). Executor-side .d.ts inspection revealed.
- **T-P1-009 cancellation primitives:** orchestrator-side docs identified `query.interrupt()` and `query.close()` as cancellation primitives. Reality: `interrupt()` is streaming-input-only; `close()` doesn't exist on the Query interface. Executor-side .d.ts inspection revealed; `AbortController` is the actual primitive for non-streaming.
- **T-P1-010 read_only enforcement:** orchestrator-side docs confidently mapped `read_only → "plan"` based on "planning mode — read-only tools only." Reality: `ExitPlanMode` tool flips `permissionMode` to `"default"`, undoing read-only. Live SMOKE run revealed; fixed via `READ_ONLY_DISALLOWED_TOOLS` belt-and-suspenders.

P2 reconfirmation: T-P2-008.7 (session_bypass mode-guard) and T-P2-008.8 (registration-intent-survives-state-reset) both exposed documented happy-path assumptions that runtime exercise disproved. See C-31 (§10.4) for the codified protocol response.

### 6.2 Protocol

When orchestrator-side discovery is documentation-only, the dispatch should explicitly note this and instruct the executor to verify against actual type definitions or runtime behavior before commit:

> **Pre-dispatch discovery (orchestrator side, DATE):** [Findings from docs.] Lower-confidence resolutions flagged; executor verifies against actual .d.ts / runtime before committing implementation.

Live SMOKE/integration tests are the strongest reveal mechanism for runtime edges. Where possible, dispatch should include at least one live-exercise AC that fires the documented behavior end-to-end.

### 6.3 Implication for v0.6 dispatches

The "Pre-dispatch discovery" section in dispatches (when present) is not a substitute for executor verification. It is a **prior**, not a **fact**. Executor surfaces deviations as either §22.5 consultations or in-scope at-site adjustments depending on materiality.

---

## 7. Harness brittleness defense

### 7.1 The pattern

Test infrastructure can produce false-PASS results when the framework's error envelope is not unwrapped before assertion. P1 evidence:

- **T-P1-011 AC-6 first-run:** harness used `wait_ms: 90000`. The shared `PollInputSchema` capped `wait_ms` at 60000. MCP boundary rejected the request with `isError: true`. Harness's `extractResult` returned bare result object (no `structuredContent`). Assertion `p.status === "cancelled"` evaluated `undefined === "cancelled"` → false. **Test "passed" in 38 milliseconds.**

A delegation that took milliseconds to "pass" was the red flag. The actual SDK delegation takes 6-40 seconds.

P2 reinforcement: T-P2-004.5 surfaced a related but distinct shape — `locateCliBinary` unit test injected a `spawnSync` mock that did not model Windows PATHEXT semantics. Test passed against mock; production broke against reality. Codified as C-21 (§10.3): mock-vs-production contract drift.

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

### 8.1 CC-1 (inherited from v0.4)

Path-handling discipline (forward-slashes in canonical paths; use `path.join` and `path.sep`; use `pathToFileURL` for file URIs).

### 8.2 CC-2 — Process and signal handling differences (inherited from v0.4; elaborated in v0.6)

Windows vs Unix; SIGTERM/SIGKILL/taskkill; subprocess cleanup; spawn-shell behavior.

**Elaboration C.1 — cross-platform path conventions verification (added v0.6 per scope-lock):**

> When a helper's output is platform-shape-sensitive (e.g., path separators, config-dir resolution), verify actual output on each target platform via test or smoke before specifying behavior in subsequent code. Don't trust documentation alone.

Surfaced at T-P2-003 (Unix-shaped `~/.claude-bridge/` memory vs Windows-correct `%APPDATA%\claude-bridge\`). Logged as C-17.

**Elaboration C.2 — Windows `.cmd` shim resolution per CVE-2024-27980 (added v0.6 per scope-lock):**

> Windows `.cmd` shim resolution requires `shell: true` in spawn options (per CVE-2024-27980 — Node's `spawn` does not invoke `.cmd` resolvers without an explicit shell context, leading to NoExec failures on Git-Bash-on-Windows and similar shells).

Affects Node ≥ 18.20.0, 20.12.0, 21.7.0. Pattern: `shell: process.platform === "win32"` PLUS (optional, defensive) explicit-candidate iteration. Surfaced at T-P2-004 manual verification → T-P2-004.5 → T-P2-004.6. Logged as C-20.

### 8.3 CC-3 (inherited from v0.4)

File permissions (Unix mode bits set-but-ignored on Windows; platform-skip tests with explanation).

### 8.4 CC-4 — Defensive clean-install for cross-platform validation

Before validating on a new platform, defensively clean and reinstall:

```
rm -rf node_modules packages/*/node_modules
npm install
npm run build
```

Reasoning: stale state from prior platform's installs can mask real issues OR introduce confusing failure modes. T-P1-010 hit orphaned `.d.ts.map` files; T-P1-012 had a different undici-loading failure that the clean install didn't fix but made reproducible. Defensive clean install is not always *necessary*; it is always **defensible**.

### 8.5 CC-5 — Lazy-load with graceful degradation for rare-case dependencies

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

### 8.6 CC-6 — Node engine pinning matrix

Document minimum supported Node version per host:

- Daemon runtime: Node 20.10+ (P0).
- SDK runtime: Node 20.19+ recommended, 20.18+ works with degradation.
- WSL guest: matches the WSL distro's available Node packages; user-local installs may lag.

A clearer pinned floor prevents the late-binding surprise that surfaced in T-P1-010 (Node 20.18 vs SDK 20.19 warning) and T-P1-012 (undici crash on 20.18).

---

## 9. Pattern doc structure

Patterns live in `docs/patterns/project/<name>.md`. Structure (template, codified going-forward in v0.6):

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

**The existing 9 pattern docs in this project are NOT normalized to this template.** P0-era patterns and the T-P1-008 pattern use slightly different earlier templates. The inconsistency is tolerated; going-forward pattern docs follow the template above. Wholesale normalization remains a candidate for a future codification pass if it becomes a navigation problem.

---

## 10. Numbered conventions (C-N rules) — new in v0.6

This section codifies eight conventions that accumulated across P1 and P2 with sufficient evidence to graduate from v0.6-candidate to first-class methodology rule. Each is referenced by ID elsewhere in this document and in dispatches.

### 10.1 C-13 — Pre-dispatch grep dimensions

Every dispatch includes a "Pre-dispatch grep (C-13)" section that enumerates specific code or doc locations the executor must verify before implementation. The grep targets serve three roles: (1) verify scope assumptions (file exists, function has expected shape, schema field is present); (2) catch shape drift since the orchestrator's last context refresh; (3) surface adjacent-invariant concerns the dispatch may not have anticipated. Grep findings are reported verbatim at the top of the executor's report block. If any finding contradicts a scope assumption, the executor stops and reports rather than proceeding.

**Three grep dimensions** (per T-P2-002 retrospective): file locations, schema shape, and function shape. Skipping any one risks the misframing this rule exists to catch.

### 10.2 C-14 — Empirical band landing position

Empirical band landing position correlates with two factors:

1. **Shape size.** Bounded-fix tasks (single file, single function, characterized defect) land sub-band-low. Medium tasks (~5 files, multiple subsystems, novel persistence/protocol) land lower-half to midpoint. Large tasks (multi-package architectural changes) land midpoint to upper-half.
2. **Consumed headroom.** §22.5 fires shift landing toward mid-band by ~30%. At-site refactors shift by ~10–15%. Audit-discovered-extra-defects shift by ~20% per additional defect found.

Pre-resolution depth + thorough C-13 grep keeps tasks in the lower half of the expected range.

The executor's C-35 elapsed-time block (§10.8) cites the classification: `sub-band-low` / `lower-half` / `midpoint` / `upper-half` / `over-band`.

### 10.3 C-21 — Mock-vs-production contract drift

Tests that pass against mock implementations may not pass against production behavior. When introducing a mock for a production component, the mock and production must share a contract definition (interface, schema, or behavioral spec). Tests assert against the contract, not against either implementation directly. When the mock and production behavior diverge in a way the contract didn't capture, the contract has a gap — not the test, not the production code. Refine the contract first; then the test.

Source: T-P2-004.5 (Form-of-Test-Bug — `spawnSync` mock didn't model Windows PATHEXT semantics; test passed against mock; production broke against reality).

### 10.4 C-31 — Diag-before-fix for race/retry symptoms

When a defect surfaces as "something is stuck" or "eventually works but slowly", the symptom shape (race, retry exhaustion, timing) often differs from the defect shape (state machine give-up, decoupled retry loops, missing event subscriptions, dropped events). Before specifying a fix to the symptom (e.g., "longer retry budget"), capture diagnostic trace of the actual sequence; the trace often reveals a more fundamental defect that a symptom-fix would mask. This principle generalizes beyond race/retry: any defect class where "what looks broken" is downstream of "what is broken" benefits from instrumentation before fix specification.

Source: T-P2-008.8 scope refinement (would have shipped "longer retry budget + UX" symptom-fix without the diag trace that revealed registration-intent-doesn't-survive-state-reset as the actual defect).

### 10.5 C-32 — Adjacent-invariant scoping

When dispatching a fix, the orchestrator surveys adjacent invariants and call sites that may share root cause or symptom shape with the defect under fix, and includes them in scope explicitly. The dispatch states the adjacent surface in either the Constraints section ("while implementing X, ensure Y holds") or the Acceptance Criteria ("verify Z at all N call sites"). This discipline prevents the same root cause from surfacing as a separate defect later, and concentrates context-load into a single task rather than spreading it across follow-ups.

**Counter-discipline:** do not expand scope beyond what shares root cause; "this file also has unrelated tech debt" is not adjacent-invariant scoping.

### 10.6 C-33 — Diagnostic-add as separate task from fix

When a defect's surface is observable but its root cause cannot be localized from current evidence, the next dispatch adds diagnostic instrumentation (logging, debug toggles, trace capture). The fix is dispatched AFTER capturing diagnostic output, not before. Scoping the diagnostic task separately prevents the orchestrator from prematurely specifying a fix to the symptom, and lets the executor focus on observation-quality rather than guess-driven implementation. The diagnostic task may be small (env-gated log statements) or substantial (new metrics surface); either way, it is dispatched and verdicted on its own terms.

Source: T-P2-008.6 (CLAUDE_BRIDGE_DEBUG instrumentation dispatched as its own task; produced the trace that informed T-P2-008.8's actual fix scope).

### 10.7 C-34 — Hard-stop guard in dispatch verification

When a dispatch's implementation depends on a verifiable pre-condition (a function has expected shape, a handler is idempotent, a schema field exists), the dispatch states the precondition explicitly AND directs the executor to halt and report rather than improvise if the precondition fails. This is distinct from general C-13 grep reporting: the executor reports findings either way, but with a hard-stop guard the executor stops the task and surfaces the contradiction rather than reshaping implementation on the fly. Hard-stops are appropriate when the alternative is implementation drift from spec; ordinary scope reshapes can still flow through §22.5.

### 10.8 C-35 — Elapsed time mandatory in all report forms

Every executor report — regardless of report form (Form A trivial fast-path, Form B standard, or any future form) — must include an explicit elapsed-time block. The block reports three values:

1. **Wall-clock duration** of the task in minutes, measured from dispatch receipt to commit-and-push completion.
2. **The dispatch's predicted band(s)**, copied verbatim from the dispatch.
3. **The C-14 classification** of where the actual landed within the predicted band — one of: `sub-band-low` (below low edge), `lower-half`, `midpoint`, `upper-half`, `over-band` (above high edge).

**Example block:**

```
Elapsed: 37 min.
Predicted: 30–60 min empirical / 30–90 min legacy.
Classification: midpoint (empirical band).
```

The block is mandatory; "approximately" or "within band" without the explicit number is insufficient. The block feeds C-14 calibration arithmetic in the orchestrator's verdict. If the executor cannot measure wall-clock time precisely (e.g., the task spanned an interruption), the executor reports a best estimate plus the source of imprecision (e.g., "≈40 min; clock paused ~10 min mid-task for orchestrator round-trip").

---

## 11. Verdict-time evidence — new in v0.6

The orchestrator's verdict establishes that the executor's claims about a task's completion are reliable. Three sub-protocols, applied in combination per task shape, provide that reliability.

### 11.1 Sub-rule 25.1 — Fresh tool output

The orchestrator's verdict must cite verbatim output from tooling invoked fresh at verdict time, not paraphrase or summary. "Fresh" means invoked within the same dispatch's report-generation phase, not reused from earlier in the task. At minimum: `npm run lint` (or project equivalent) verbatim.

**Source:** T-P2-007's verdict claimed "Lint clean across 4 workspaces" but a fresh `npm run lint` actually emitted 10 errors in extension + CLI test files; these were latent at the commit. Codified during T-P2-007.5 retrospective.

### 11.2 Sub-rule 25.2 — Bundled-artifact verification

When a task produces a bundled or packaged artifact (`.vsix`, `.tgz`, executable, container image), the verdict must include grep-evidence that the artifact does not externally import workspace siblings or otherwise leak unbundled references. Memory-asserted "the bundle looks right" is not sufficient.

**Example:** `unzip -p <pkg> <bundled-file> | grep -c "<sibling-package-prefix>"` returning `0`.

**Tasks that do not produce a bundled artifact must explicitly state "25.2: N/A"** in the verdict with one-line rationale (e.g., "daemon-only change, no artifact rebuilt").

**Source:** T-P2-008.5 (extension `.vsix` previously shipped with package-name imports of `@claude-bridge/shared` that Node's ESM loader couldn't resolve at runtime; bundle verification at verdict time would have caught it pre-operator-smoke).

### 11.3 Sub-rule 25.3 — Operator-runtime-smoke for build/packaging

For any task affecting build pipelines, packaging output, extension installation, or operator-launched runtime, the dispatch must specify an operator-performed runtime smoke procedure that closes the runtime-evidence gap left by agent-side ACs. The smoke is the operator's responsibility, performed in the same session as the agent's verdict. Verdict may commit on agent-verifiable ACs alone; follow-up tasks may not proceed until operator smoke is captured.

**Smoke procedures involving environment variables, process inheritance, or extension reload MUST explicitly direct the operator to kill all instances of the affected process tree before relaunching** ("Get-Process X | Stop-Process -Force; confirm zero remain; then relaunch"). "Close all windows" alone is insufficient on Windows/Electron, where launcher processes persist with stale environment.

**Source:** T-P2-008.6 (prompted by C-29 surfacing during T-P2-008.5 operator smoke; C-25.2 catches packaging defects but not runtime regressions where bundled code executes differently than per-module emit).

---

## 12. Open methodology questions (v0.7 candidates)

These were raised through P1 or P2 but not codified in v0.6. Tracked in `docs/project-state.md` v0.7-candidates section; promoted on second/third instance or when v0.7 codification pass opens.

- **C-11** — §22.5 trigger clarification: find-target-absent-but-substantive-intent-applies-elsewhere (at-site) vs find-target-exists-with-different-wording (consult). Boundary working in practice; codify with examples in v0.7.
- **C-12** — Empirical band for multi-file doc-edit with all decisions pre-resolved (15-22 min over 2 datapoints; legacy Medium-consolidation 5-15 min under-predicts). Single-shape datapoint; revisit at 3+ instances.
- **C-15** — Structured error-discrimination fields on the error variant (regex-parseable fields embedded in message vs first-class discriminated `error_data`). Project pattern candidate; defer until 2+ instances.
- **C-19** — VS Code SecretStorage returns `Thenable<T>` not `Promise<T>`; library-style interfaces consuming it must type with `PromiseLike<T>`. Project pattern candidate.
- **C-22** — Orchestrator narrowing audit: when an initial fix doesn't resolve the defect, re-examine the original rejection reasoning before drafting another fix. Captured in §3.2 informally; formal codification deferred to v0.7.
- **Provisional methodology candidates (M-* series)** — tracked in `docs/project-state.md`; promoted to C-N on third-instance evidence. Current entries include M-A (fork-in-the-road dispatch), M-E (accessor-read C-26 test subgenre), M-F (verify-mechanism-before-describing-mechanism), and additional candidates accumulated post-scope-lock.

---

## 13. What v0.6 explicitly does NOT change from v0.5

- Three-role architecture.
- §22.5 reactive-fix consultation protocol.
- Acceptance-harness-first discipline for phases with cross-process behavior.
- Pattern doc location and naming convention (`docs/patterns/project/<name>.md`).
- Doc-debt deferral to phase-close sweeps.
- "User is the gate" principle.
- Dual-band reporting requirement.
- Variance arithmetic discipline (§5.3).
- Mandatory "User interaction during task" section in Form A and Form B.
- Pattern promotion third-use rule.
- Mid-task scope reshape protocol (§3.2).
- Streak counter tracking — remains a project-state concern; methodology says nothing about it (per scope-lock A.7).

These were validated through P1 + P2 without modification needed.

---

## 14. Migration notes (v0.5 → v0.6)

For projects mid-flight on v0.5:

1. Add a "Pre-dispatch grep (C-13)" section to every new dispatch (§10.1).
2. Add the mandatory C-35 elapsed-time block to every executor report, regardless of form (§10.8).
3. Apply hard-stop guards (C-34, §10.7) at every dispatch precondition that, if violated, would cause implementation drift.
4. Adopt the verdict-time evidence sub-rules (§11): cite verbatim fresh tool output (25.1); grep-verify bundled artifacts (25.2); specify operator runtime smoke for build/packaging tasks (25.3).
5. Refresh the empirical band table (§5.2) with this project's own evidence; the claude-bridge bands are project-local.
6. Carry forward existing pattern inventory; new pattern docs follow §9 template; existing docs are not normalized (tolerated).
7. Track post-v0.6 candidates in a v0.7-candidates section of project-state.md.

No retroactive doc updates required. v0.6 takes effect at the next dispatch.

---

## 15. Changelog from v0.5

### Differential-review statement (per scope-lock A.3)

v0.6 preserves v0.5 substance verbatim in Sections 1, 2 (lightly extended for new C-N references in dispatch shape), 4, 5.1, 5.3, 5.4, 6, 7, 9 (with added tolerance note for existing pattern docs), and 13 (extended list of unchanged items).

v0.6 revises v0.5 substance in:
- **§3.5 (Report formats):** Form A and Form B specs now require the mandatory C-35 elapsed-time block.
- **§5.2 (Empirical band table):** combined P1 + P2 matrix; organized by task-shape rather than phase; 12 P2 datapoints add coverage of bounded-fix, medium-shape pre-resolved, large multi-subsystem, doc rewrite, methodology codification, and diagnostic-add task shapes.
- **§8.2 (CC-2):** elaborations C.1 (cross-platform path verification, from C-17) and C.2 (Windows .cmd shim CVE-2024-27980 citation, from C-20).

v0.6 adds three new top-level sections:
- **§10 Numbered conventions:** codifies C-13, C-14, C-21, C-31, C-32, C-33, C-34, C-35 as first-class methodology rules.
- **§11 Verdict-time evidence:** houses the C-25 family as sub-rules 25.1, 25.2, 25.3.
- **§15 Changelog from v0.5:** this section.

v0.6 revises but preserves the role of v0.5's §10 (open methodology questions) as §12 (v0.7 candidates) — same purpose, refreshed list.

v0.6 adds §14 (Migration notes v0.5 → v0.6) following the v0.4→v0.5 migration-notes pattern.

### Closed-item changelog acknowledgments (per scope-lock D)

The following v0.6-candidates were closed by P2 tasks before v0.6 codification; each is acknowledged here for traceability:

- **C-23** (closed by T-P2-007): fresh-state-assumption tests antipattern closed via startup-population logic + AC-12 integration test.
- **C-24** (closed by T-P2-007.5): Windows path case-insensitivity closed via `normalizeAbsPath` + `dedupeOnLoad`.
- **C-26** (closed by T-P2-006.5 + T-P2-006-followup): field-precedes-setState invariant codified in `docs/patterns/project/settable-single-subscriber-callback.md` Caveats section.
- **C-28** (closed by T-P2-008.5): extension `.vsix` bundling closed via esbuild bundle step (`@claude-bridge/*` inlined; `vscode` kept external).
- **C-29** (closed by T-P2-008.8): registration intent persistence closed via event-driven re-attempt model.
- **C-30** (closed by T-P2-008.7): `session_bypass` mode-guard closed via gate refactor + `(mcp_session_id + workspace_id)` keying.

### Empirical basis for v0.6 changes

| Change | Empirical basis |
|---|---|
| C-13 (pre-dispatch grep) codification | Applied in ~20 P2 dispatches; surfaced shape drift in 4 of them pre-implementation, avoiding later rework |
| C-14 (band landing) codification | 22 P2 datapoints reproducibly match the shape-size + consumed-headroom predictors |
| C-21 (mock-vs-production drift) | T-P2-004.5 + T-P2-006.5 instances; pattern recurs across mock-injection sites |
| C-31 (diag-before-fix) | T-P2-008.6 → T-P2-008.8 sequence (diag-then-fix saved a guess-fix) |
| C-32 (adjacent-invariant scoping) | T-P2-006.5 (3 setState sites fixed in one task) and T-P2-008.7 (gate guard + session-keyed bypass in one task) |
| C-33 (diag separate task) | T-P2-008.6 dispatched as standalone diag task; informed T-P2-008.8 fix scope |
| C-34 (hard-stop guard) | Applied at T-P2-013 and T-P2-014 dispatches; surfaced no actual stops but proved the protocol |
| C-35 (mandatory elapsed time) | C-14 calibration arithmetic was being approximated in reports pre-codification; explicit block enables precise calibration |
| C-25.1 (fresh tool output) | T-P2-007 verdict's "lint clean" claim was wrong; latent errors at the commit |
| C-25.2 (bundled-artifact) | T-P2-008.5 .vsix had unbundled `@claude-bridge/*` imports; would have shipped without grep verification |
| C-25.3 (operator runtime smoke) | T-P2-008.5 → C-29 → T-P2-008.6 sequence: bundle verification (25.2) did not catch the runtime regression; runtime smoke would have |
| CC-2 C.1 (path verification) | T-P2-003 Unix-shaped path memory vs Windows-correct path reality |
| CC-2 C.2 (CVE-2024-27980 citation) | T-P2-004 → 004.5 → 004.6 sequence; CVE citation upstreams the explanation so subsequent projects don't rediscover |

### Items explicitly deferred to v0.7 (per scope-lock E)

- C-11 (§22.5 trigger boundary), C-12 (multi-file doc-edit band), C-15 (structured error discrimination), C-19 (`PromiseLike<T>` for VS Code APIs), C-22 (orchestrator narrowing audit formal codification).
- C-16 (Windows extension reinstall idiom) and C-18 (VS Code window-coalescing) moved to runbook scope at T-P2-013, not methodology.
- M-A, M-E, M-F (provisional methodology candidates from P2): tracked in project-state.md; promoted on third-instance evidence.

---

## End of v0.6

**Status:** Active.
**Next review:** end of claude-bridge P3, or when 10+ tasks of additional evidence accumulate.
**Author signature:** Co-developed during the claude-bridge P1 + P2 phases (T-P1-001 through T-P2-014). Evidence base: 34 dispatched tasks, 9 promoted patterns, 5 mid-task reshapes, 47 consecutive zero-fire async-discipline runs at codification time.
