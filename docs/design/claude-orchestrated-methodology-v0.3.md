# Claude-Orchestrated Development Methodology

**Version:** v0.3
**Date:** May 21, 2026
**Status:** Synthesis of v0.2 (Claude-orchestrated methodology, May 11 2026) and the Three-Role Collaboration seed document. Not yet validated end-to-end against a real project execution under this combined form.

**Changes from v0.2:** Absorbed the Three-Role Collaboration seed document in its entirety. The seed's discipline patterns — verdict vocabulary, prompt-generation shape, investigation methodology, orchestrator/executor error catalogues, repository/git/build conventions, day-zero checklist — are now codified as first-class sections (Parts III, V, VI, VII) rather than living in a separate document. Vocabulary unified: the seed's "Reviewer" role is one of the Orchestrator's disciplines, not a separate role; the term "Orchestrator" is canonical. The POP-coco3-specific bindings from v0.2 §10 are removed from this document; project-specific bindings live in each project's own design docs.

This is a working document. It evolves with use.

---

## Table of contents

**Part I — Foundations**
1. Purpose and scope
2. The three-role architecture

**Part II — Operating model**
3. The task lifecycle
4. Acceptance criteria taxonomy
5. Context packaging protocol
6. State persistence

**Part III — Orchestrator discipline**
7. Orchestrator verification methodology
8. Prompt generation
9. Investigation methodology
10. Task sequencing patterns

**Part IV — Knowledge management**
11. The pattern library
12. Documentation-first rule

**Part V — Failure recovery**
13. Failure modes and recovery
14. Orchestrator error patterns
15. Executor error patterns
16. Bug discovery discipline

**Part VI — Project infrastructure**
17. Repository and documentation conventions
18. Phase and milestone tracking
19. Question and decision tracking
20. Audit and scope
21. Verification infrastructure
22. Git workflow
23. Build infrastructure
24. File naming and artifacts

**Part VII — Process**
25. Calibration phase
26. Cross-cutting concerns
27. Starting a new project

**Part VIII — Meta**
28. Cross-project considerations
29. Methodology refinements catalogue
30. Open questions and review gates
31. Meta-notes

**Appendices**
- A. Document conventions
- B. Glossary
- C. Document history

---

# Part I — Foundations

## 1. Purpose and scope

### 1.1 What this document is

This document defines a methodology for executing substantial software projects with two AI agents and a human in coordination:

- **Claude.ai** acting as an **Orchestrator** — stateful project intelligence, planning, verification, knowledge management.
- **Claude Code** (or equivalent agent with repo access) acting as an **Executor** — stateless task performer with local filesystem and tool access.
- A **Human gate** — strategic authority, design decision-maker, and final acceptance gate.

The methodology is novel work. There is no established convention for long-running AI-orchestrated software projects. This document is an evolving design, expected to be refined as it is exercised against real projects.

### 1.2 What problem this solves

Substantial codebase projects (10,000+ lines, multi-month timelines, multi-subsystem architectures) face two failure modes:

**Execution drift.** The project's discipline degrades over time. Code style diverges between files. Architectural conventions get violated. Documentation stops getting updated. Quality declines as fatigue accumulates. These are universal problems in solo-developer projects, particularly hobby projects that lack external accountability.

**Cognitive bandwidth limits.** A human developer can hold a finite amount of project context in working memory. Large projects exceed this capacity, forcing the developer to context-switch through documentation, slowing progress and increasing error rates.

AI assistance can address both. An orchestrator that maintains stable project state across long timelines counteracts execution drift. AI-assisted code production amplifies bandwidth. But unstructured AI assistance has its own failure modes: drift in a different direction (toward AI-default patterns rather than project-specific patterns), hallucinated context, plausible-but-wrong output.

This methodology addresses those problems by imposing structure on how the AI agents collaborate, what they know, how they verify each other, and where the human's judgment is required.

### 1.3 What projects this applies to

**Primary target:** large software porting, conversion, and reverse-engineering projects where the structure of the work is well-defined but the volume is significant. Also applies to:

- Compiler backend implementation
- Operating system kernel development
- Hardware design verification
- Infrastructure development with significant per-component review-gate discipline
- Any project with significant per-routine or per-module work where review-gate discipline pays off

**Projects this methodology does not target:**

- Exploratory or research work where the structure is unclear
- One-off scripts or tooling where the project completes in a single session
- Projects driven by external requirements that change frequently
- UI design or user-facing creative work where iteration is intrinsic

### 1.4 Relationship to traditional methodologies

This methodology shares DNA with several traditional approaches but does not match any of them:

- Similar to waterfall in that it has explicit phases and review gates between phases
- Similar to agile in that iteration happens within phases at the task level
- Similar to documentation-first development in that documents (contracts, conventions, acceptance criteria) precede code
- Similar to test-driven development in that acceptance criteria precede implementation

The novel element is the role of the Orchestrator. Traditional methodologies assume a single human developer or a team of human developers. This methodology adds a stateful AI orchestrator as an additional actor with its own responsibilities, supported by a stateless executor.

### 1.5 Relationship to claude-bridge

The methodology is designed to operate manually (human copy-pasting between Claude.ai and Claude Code interfaces) and to operate automatically (when claude-bridge is production-ready). Same methodology, different substrate.

Manual operation involves overhead the human bears: ensuring state files get updated, transferring prompts between interfaces, integrating reported code. Automated operation via claude-bridge eliminates that overhead but does not change the methodology itself.

This document specifies the manual operation in detail. claude-bridge automation is treated as a future migration target, not a prerequisite. The methodology must work without it.

### 1.6 Non-goals

This document is not:

- A project management methodology (it does not address scheduling, resource allocation, prioritization across projects)
- A code review methodology (it does not specify how human review of code should happen — the human gate is assumed to apply their own judgment)
- A prompt engineering guide (specific prompt patterns are not specified at the level of "use this exact wording")
- A replacement for engineering judgment (the methodology supports human judgment, does not replace it)

---

## 2. The three-role architecture

### 2.1 Role definitions

**Orchestrator (Claude.ai instance, project context):** plans, reviews, writes verification plans and verdicts, drafts prompts for the executor, maintains project state across conversations, captures and curates the pattern library. Does NOT directly investigate the codebase. Does NOT execute commands in the repo. Holds the strategic discipline of the project.

**Executor (typically Claude Code or equivalent agent with repo access):** executes work, gathers information from the live codebase, runs tests, drafts diffs, commits and pushes code. Does NOT make design decisions without orchestrator authorization. Does NOT issue verdicts.

**Human gate (project owner):** final authority on decisions. Visual verifier for any human-perceptible output. Carries artifacts between orchestrator and executor in manual operation. Resolves ambiguous orchestrator-executor exchanges. Approves scope changes and gate transitions.

### 2.2 Why three roles, not two

An orchestrator-only or executor-only model has predictable failure modes:

- **Orchestrator-only without an executor** cannot ground plans in actual codebase state. Plans become disconnected from reality.
- **Executor-only without an orchestrator** optimizes for forward motion and skips verification gates. Quality drifts.
- **Human-as-authority** is what makes the verification gates meaningful. Without a human authority, the two AI roles will collude toward false closure — each accepting the other's framings without independent verification.

The three roles together are stable. Any two are not.

### 2.3 Information flow

**Orchestrator produces:** verification plans, review verdicts, prompts for executor, methodology observations, state file updates, pattern library entries. These are written documents the human reviews and forwards.

**Executor produces:** code changes, verbatim diffs, execution reports, build artifacts, commits. These are operational outputs the human inspects and (when warranted) forwards back to the orchestrator.

**Human produces:** decisions on options, scope authorizations, visual gate confirmations, direction changes, methodology revisions.

**Critical rule: no direct executor-to-orchestrator communication.** The human is always in the loop on transitions between roles. This is true even when claude-bridge automates much of the transit — the human-gate-required moments remain.

### 2.4 Authority and escalation

The authority hierarchy is strict:

```
Human gate
  └── overrides ──► Orchestrator
                    └── directs ──► Executor
```

Escalation flows upward. The executor surfaces uncertainties to the orchestrator. The orchestrator surfaces unresolvable issues to the human. The human's decisions are final.

The human can intervene at any level:

- During a task in progress, the human can pause, redirect, or abort
- After a task completes, the human can reject the work even if the orchestrator accepted it
- Between conversations, the human can edit project state directly

These intervention rights are not exceptional — they are part of normal operation. The methodology accommodates human override at every level without penalty.

### 2.5 The Orchestrator

**Responsibilities:**

1. **Project state maintenance.** Read project state at conversation start. Update project state at conversation end. Maintain task queue, completed work manifest, gate status, pattern library references.
2. **Task definition.** Given the current state of the project and the open work, define the next task: what file or routine, what acceptance criteria, what context the executor will need.
3. **Acceptance criteria definition.** For each task, define what success looks like before the task begins. The criteria are explicit, mechanical where possible, and human-judgmental where necessary.
4. **Context packaging.** Assemble the materials the executor will need (see §5).
5. **Execution prompt production.** Convert the task definition, acceptance criteria, and context into a concrete prompt for the executor.
6. **Result verification.** Receive the executor's report. Compare against acceptance criteria. Determine pass, fail, or ambiguous (see §7).
7. **Pattern capture.** When new idioms or architectural patterns are discovered during execution, capture them in the pattern library for future task contexts.
8. **Escalation.** When tasks fail in ways the orchestrator cannot resolve, escalate to the human gate with a specific question and recommended resolution options.
9. **Methodology stewardship.** Notice when the methodology itself is producing problems. Surface these to the human gate for potential methodology revision.

**Authority:** The orchestrator has authority to define tasks, draft prompts, verify mechanical acceptance criteria, and update project state. It does not have authority to:

- Approve gate boundaries (those go to the human gate)
- Override design decisions made by the human gate
- Modify the methodology itself (revisions go through human gate review)
- Commit code without human gate approval (during calibration phase; see §25)

**Limitations:** The orchestrator is a Claude.ai conversation. It has:

- Finite conversation length, requiring state to be externalized to project files
- No direct filesystem access (it cannot read or write files except those the human places in the project)
- No direct code execution (it depends on the executor's reports for runtime observations)
- Knowledge limited by its training data and the project state it can read

### 2.6 The Executor

**Responsibilities:**

1. **Task interpretation.** Read the orchestrator's prompt. Understand the task, acceptance criteria, and constraints.
2. **Context consumption.** Read the provided reference materials. Read additional materials as needed from the local filesystem.
3. **Code production.** Write the code that satisfies the task. Follow conventions, honor contracts, use the pattern library appropriately.
4. **Local verification.** Run tests on the produced code. Capture results.
5. **Self-assessment.** Identify aspects of the work where uncertainty exists. Flag these explicitly.
6. **Report production.** Produce a structured report (see §3.5.1).

**Authority:** The executor has authority to:

- Make local design decisions within the constraints of the task
- Read any file in the project
- Write code in the files specified by the task
- Run tests and tools available locally

The executor does not have authority to:

- Modify files outside the task's specified scope
- Modify the project state files (those are orchestrator's responsibility)
- Modify the pattern library directly (the executor's discoveries flow back through the orchestrator)
- Approve its own work as complete (the orchestrator verifies)

**Limitations:** The executor is stateless per task. It does not remember previous tasks. It depends on the orchestrator to provide context from previous work. It cannot reason about the project as a whole — only about the task at hand.

### 2.7 The Human gate

**Responsibilities:**

1. **Strategic direction.** What the project is, what version 1 ships, what's deferred.
2. **Design decisions.** When the orchestrator surfaces an ambiguity or design choice, the human resolves it.
3. **Gate approval.** Crossing review-gate boundaries requires human sign-off.
4. **Escalation target.** When the orchestrator cannot resolve a problem, the human decides.
5. **Methodology evolution.** Revisions to this document go through human review.
6. **Calibration oversight.** During the calibration phase (§25), the human reviews every task before integration.
7. **Visual gate.** For any project with human-perceptible output, the human is the final authority on whether the output is correct. See §9.7.

**Authority:** Absolute, on everything. The orchestrator and executor are tools the human uses to amplify their capacity, not autonomous agents that override human judgment.

---

# Part II — Operating model

## 3. The task lifecycle

A task is the smallest unit of orchestrated work. The lifecycle has eight stages.

### 3.1 Task definition

**Input:** Project state (current phase, open work, gate status).

**Output:** A task specification with:

- Task ID (sequential, e.g. `T-0042`)
- Task type (port-routine, design-document, implement-test, etc.)
- Scope (which file, which routine, which subsystem)
- Acceptance criteria (see §4)
- Estimated effort (rough — hours, days)
- Parent gate (which review gate this task contributes to)

**Responsible:** Orchestrator.

**Human gate:** Optional review during steady-state operation. Required review during calibration phase.

### 3.2 Acceptance criteria definition

**Input:** Task definition.

**Output:** Explicit acceptance criteria covering:

- Functional correctness (what does success behavior look like)
- Test verification (which tests must pass, what their outputs must be)
- Code quality (conventions honored, contracts respected)
- Documentation (what comments, what doc updates)

Criteria are distinguished as **gate-blocking** or **reviewable** (see §4).

**Responsible:** Orchestrator.

**Human gate:** Review required if the criteria involve design judgment. Skipped if criteria are purely mechanical.

### 3.3 Context packaging

**Input:** Task definition, acceptance criteria, current pattern library, project conventions.

**Output:** A context bundle (see §5).

**Responsible:** Orchestrator.

### 3.4 Execution

**Input:** Context bundle.

**Output:** Produced code, modified files, local test results.

**Responsible:** Executor.

The executor reads the context, plans the work, writes the code, runs the tests, captures results. It may read additional files from the local filesystem if needed (the context bundle is a starting point, not necessarily exhaustive).

The executor does not:

- Skip running the tests (no exceptions)
- Modify files outside the task's specified scope
- Modify project state files
- Mark its own work as complete

### 3.5 Report

**Input:** Completed task work.

**Output:** A structured report.

**Responsible:** Executor.

#### 3.5.1 Report format

```
TASK REPORT
===========
Task ID:    T-NNNN
Task type:  <type>
Status:     <complete | incomplete | blocked>

CODE CHANGES
------------
<files modified, with summary of each change>

TEST RESULTS
------------
<harness invocations and their outputs>

SUMMARY
-------
<plain prose: what was done, in 1-3 paragraphs>

REASONING
---------
<key design decisions made during execution, with rationale>

UNCERTAINTY FLAGS
-----------------
<explicit list of things the executor was unsure about,
 with specific questions for the orchestrator to consider>

PATTERN OBSERVATIONS
--------------------
<new patterns noticed, or existing patterns that didn't fit;
 these feed back into the pattern library>
```

The uncertainty flags section is structurally important. The executor is required to flag uncertainties; it is not a sign of weakness but of disciplined self-assessment. An empty uncertainty section on a complex task is a warning sign that the executor may have proceeded on assumptions.

**Self-assessment ≠ verdict.** The executor's self-assessment describes what happened. The verdict belongs to the orchestrator. See §8.6.

### 3.6 Verification

**Input:** Executor report, acceptance criteria.

**Output:** Verdict (pass / fail-recoverable / fail-design / ambiguous), with reasoning.

**Responsible:** Orchestrator.

The orchestrator compares the report against the acceptance criteria:

- **Mechanical criteria** (tests pass, files produced, scope respected): orchestrator verifies directly from the report.
- **Judgmental criteria** (code quality, design appropriateness, convention adherence): orchestrator forms an assessment but may surface to the human gate.

Verdicts follow the strict vocabulary defined in §7.3 (CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED). The four task-outcome categories above are the operational dispositions that flow from those verdicts:

- **Pass** (verdict CONFIRMED): Acceptance criteria met. Task proceeds to integration.
- **Fail-recoverable** (verdict NOT CONFIRMED with localized issues): Specific issues identified that the executor can fix. Orchestrator produces a revision prompt and the executor re-runs.
- **Fail-design** (verdict NOT CONFIRMED with design implications): The issues require design decisions the orchestrator cannot make. Escalate to human gate.
- **Ambiguous** (verdict PARTIALLY CONFIRMED, evidence insufficient): Acceptance criteria turn out to be unclear, or evidence is incomplete. Hold the verdict and gather more data, or escalate for criteria refinement.

### 3.7 Integration

**Input:** Verified task work.

**Output:** Code committed to the project repository, project state updated.

**Responsible:** Orchestrator (for state updates), human gate (for repository commits during calibration, automatable after).

During calibration phase: human reviews and commits manually. During steady state: orchestrator can stage commits with descriptive messages following §22 conventions; human reviews at gate boundaries rather than per task.

### 3.8 Pattern capture

**Input:** Executor's pattern observations, orchestrator's own observations during verification.

**Output:** Updates to the pattern library (new patterns added, existing patterns refined, anti-patterns documented).

**Responsible:** Orchestrator.

Patterns are captured continuously, not in batches. Each completed task is an opportunity to add to the library. See §11.

---

## 4. Acceptance criteria taxonomy

Acceptance criteria exist at five scopes. Each scope has different criteria, different verification mechanisms, and different gates.

**Two types of acceptance criteria:** every criterion is either **gate-blocking** or **reviewable**.

- **Gate-blocking criteria** must pass before the gate can close. No gate transitions until all gate-blocking criteria pass. Examples: tests pass, code compiles, real-hardware verification (when applicable).
- **Reviewable criteria** are inspected and noted but do not block gate transition. Examples: comment quality, naming consistency, documentation completeness for non-shipped material.

When in doubt, default to gate-blocking — easier to relax a criterion than to discover after release that something important was reviewable.

**Mapping of acceptance scopes to verification rigor:** each acceptance scope uses a default harness rigor level. This standardizes verification across scopes.

| Scope | Default rigor |
|-------|---------------|
| Routine-level | Per-routine test (smallest scope) |
| File-level | Smoke + per-routine for all routines in file |
| Subsystem-level | Demo-loop + scripted (subsystem-specific scenarios) |
| Gate-level | Full scripted-playback matrix |
| Release-level | Full scripted-playback matrix + real-hardware |

**Real-hardware verification:** some criteria require verification on actual hardware, not just emulation. Emulation is excellent but not bit-perfect. Detection routines, hardware-specific timing, and silicon-revision-sensitive code require real-hardware verification before gate close.

### 4.1 Routine-level acceptance

**Scope:** A single ported routine or implemented function. The smallest unit.

**Gate-blocking criteria:**

- Code compiles cleanly (no errors, expected warnings only)
- Code follows applicable contracts
- Code follows calling conventions
- Code uses the target CPU/runtime subset appropriately
- If independently testable: per-routine harness test passes
- If not independently testable: subsequent integration test passes

**Reviewable criteria:**

- Routine header comment present and accurate
- Routine name follows naming conventions
- Inline comments meaningful

**Verification mechanism:** Compile, run any applicable per-routine harness tests, run integration tests at next level up.

**Gate:** Orchestrator verifies. Human gate only if uncertainty flags or judgmental issues surface.

### 4.2 File-level acceptance

**Scope:** All routines in a single source file have been ported (or otherwise addressed — some routines may be intentionally stubbed).

**Gate-blocking criteria:**

- All routines in the file pass routine-level acceptance
- File assembles/compiles cleanly
- File integrates with the rest of the codebase (no unresolved symbols, no broken references)
- Smoke harness passes
- Demo-loop harness passes (where applicable)
- Linter reports zero violations

**Reviewable criteria:**

- File header comment present and accurate
- File size is within guideline range
- File organization follows project convention

**Verification mechanism:** Full project assembly, harness smoke + demo-loop runs, linter run.

**Gate:** Orchestrator verifies. Human gate reviews at end of file if calibration phase or if file is large.

### 4.3 Subsystem-level acceptance

**Scope:** A functional area (e.g. graphics, sound, level loader).

**Gate-blocking criteria:**

- All files in the subsystem pass file-level acceptance
- Subsystem-specific integration test passes
- Subsystem honors its interface contracts
- Scripted-playback harness passes for scenarios that exercise this subsystem

**Reviewable criteria:**

- Cross-file documentation consistent
- Subsystem-specific patterns documented in pattern library (if generalizable)

**Verification mechanism:** Full project assembly, scripted-playback harness runs, subsystem-specific tests.

**Gate:** Human gate review required. Subsystems are too large to advance without explicit approval.

### 4.4 Gate-level acceptance

**Scope:** A formal project review gate (e.g. completing P2 of the project plan).

**Gate-blocking criteria:**

- All work scheduled within the gate is complete
- Documentation updated to reflect current state
- Open issues catalogued and triaged
- Project state file updated to reflect gate transition
- Demonstrable artifact exists (build runs, harness passes, deliverable observable)
- Real-hardware verification, if specified for this gate

**Reviewable criteria:**

- Pattern library updated with any new patterns from the gate's work
- Cross-cutting design issues identified and recorded for future gates

**Verification mechanism:** Full demonstration. Live run. Human evaluation. Real hardware run when gate specifies.

**Gate:** Human gate decision. Cannot be advanced by orchestrator.

### 4.5 Release-level acceptance

**Scope:** A shippable artifact (v1.0, v1.1, etc.).

**Gate-blocking criteria:**

- Full content scope present
- All gates passed
- Full configuration matrix verified working (all target builds, all supported runtimes)
- Documentation complete for release
- Known issues documented
- Real-hardware verification across configuration matrix completed
- Diagnostic tools included in release artifacts

**Reviewable criteria:**

- Release notes drafted
- Community pre-release feedback collected (if testers available)
- Cross-platform community notified

**Verification mechanism:** Full release test matrix. Live runs. Real hardware verification.

**Gate:** Human gate decision with explicit release approval.

---

## 5. Context packaging protocol

This section specifies what goes into the context bundle the orchestrator produces for the executor.

### 5.0 The three-pillar context structure

Every porting or implementation task context for the executor includes three pillars that together provide the rules and examples needed to produce correct code:

**Pillar 1 — The contract.** The interface to platform (HAL contract for porting tasks, internal contract for engine-to-engine work, API spec for library work). Tells the executor "this is what's available and how to call it."

**Pillar 2 — The conventions.** The rules of the codebase — calling conventions, naming, file organization, error handling. Tells the executor "this is how code in this codebase is structured."

**Pillar 3 — The pattern library entries.** Concrete examples in the rules — idiom translations, architectural patterns, anti-patterns. Tells the executor "this is what good code looks like in these rules."

The three pillars are not redundant. The contract specifies the interface; the conventions specify the form; the patterns specify the substance. All three are necessary for the executor to produce idiomatic, correct code. Omit any pillar and the executor either produces wrong code (no contract), inconsistent code (no conventions), or non-idiomatic code (no patterns).

For non-porting tasks (build system work, tooling, harness), the three pillars adapt: pillar 1 becomes the relevant interface specification, pillar 2 becomes the relevant style conventions, pillar 3 becomes relevant tooling patterns. The structure is constant; the content shifts.

### 5.1 Every task context contains

The following are mandatory in every task context:

**Task header:**

- Task ID
- Task type
- Scope (file path, routine name, subsystem)
- Estimated effort
- Parent gate

**Acceptance criteria:**

- Explicit list of criteria for this specific task (gate-blocking vs reviewable distinguished)
- Test commands to run
- Expected outputs

**The three pillars (per §5.0):**

- Pillar 1 (Contract): relevant contract sections
- Pillar 2 (Conventions): calling conventions, naming rules, comment templates, applicable mode-flag rules
- Pillar 3 (Patterns): relevant pattern library entries (selection per §5.3)

**Deliverable specification:**

- Exact files to produce or modify
- Format expectations
- Naming conventions

**Scope statement:**

- What is in scope
- What is out of scope (see §8.3 — out-of-scope items are explicit, not implied)

**Reporting format:**

- Section structure of the response (see §8.4)

**Stop conditions:**

- Specific result conditions
- Volume limits where applicable
- "Wait for orchestrator next-step decision" gates

### 5.2 Task-type-specific contents

**For port-routine tasks (most common in porting projects):**

- The original source for the routine being ported, with surrounding context
- Any routines this one calls (so calling conventions are visible)
- Any routines that call this one (so caller expectations are visible)
- Relevant contract sections
- Pattern library entries for idioms relevant to this routine
- Constraints: target CPU/runtime subset

**For port-file tasks:**

- All source files this file references
- All source files that reference this file
- Subsystem contract this file participates in
- All relevant pattern library entries
- File-level acceptance criteria

**For contract-implementation tasks:**

- The contract document, full
- The platform-specific reference (e.g. register reference for graphics implementation)
- Existing implementations on other targets (so patterns can be matched)
- Test framework for verification

**For test-harness tasks:**

- Harness framework documentation references
- Existing harness code (if any)
- Test specifications

**For documentation tasks:**

- Existing documentation in the project
- The change being documented
- Format conventions

**For investigation tasks:**

- The verification plan (see §7.1) including predicted observations
- Existing investigation context (prior verdicts, prior reports)
- Stop conditions and falsification criteria

### 5.3 Pattern library inclusion

The pattern library is large. Including all of it in every task context is wasteful and dilutes attention. Each task gets only the relevant subset.

**Selection rules:**

- **Anti-patterns** are included in every task — universal rules.
- **Mode-flag patterns** (e.g. DEV_MODE) are included whenever the task is in a phase that uses those flags.
- **Instruction-level translation patterns** are included when the source uses the relevant instructions.
- **Idiom translation patterns** are included when the source has the relevant idiom.
- **Architectural patterns** are included when the task is in the relevant subsystem.
- **Contract-interaction patterns** are included when the task involves contract calls.
- **Methodology-tier patterns** are included when applicable to the task's category.

These category labels derive from any given project's pattern library structure. Other projects may have different categories; the principle is the same — selection by source-code inspection and task type, not by including everything.

**General relevance rule:**

A pattern is relevant to a task if:

- The pattern's source-platform idiom appears in the routine being ported, OR
- The pattern's target-platform idiom is needed in the produced code, OR
- The pattern's subsystem matches the task's subsystem, OR
- The pattern is project-level or universal (applies to all tasks)

The orchestrator determines relevance by examining the task's source materials. **During calibration, over-include rather than under-include** — extra patterns are cheap; missing patterns produce wrong code. Selection refines empirically.

**Pre-populated vs empirically-discovered patterns:** the pattern library mixes two kinds of patterns:

- **Pre-populated** — written before execution from known idioms, ISA documentation, project source analysis. Available from task #1.
- **Empirically-discovered** — emerge during execution when an idiom appears that the library didn't anticipate. Added to the library as part of pattern capture (per §3.8 and §11.4).

Both kinds are equally valid. Pre-populated patterns prevent ramp-up cost; empirically-discovered patterns capture genuine project-specific learning.

### 5.4 Token budget

**Target:** 30,000–50,000 tokens per task context.

- **Below 30,000:** Risk of insufficient context. Executor may produce wrong work due to missing information.
- **Above 50,000:** Risk of attention dilution. Executor may miss important details buried in long context.
- **Above 80,000:** Hard limit. If a task naturally requires more context than this, the task is probably too large and should be broken into smaller tasks.

These targets are starting points and will be revised based on observed effectiveness during calibration.

### 5.5 Constraint specification

Constraints are statements of "must do" or "must not do" that the executor must respect. Examples:

- "Engine routines must use only 6809-compatible instructions. Use of 6309 instructions outside the optimization layer is a failure."
- "All contract calls must respect the calling convention defined in `contract.inc`."
- "Do not modify files outside `<scope>` without explicit permission."
- "Do not introduce new contract functions; use only those defined in the current contract."

Constraints are project-level (apply to all tasks) or task-level (apply to this specific task). Project-level constraints are documented in a constraints reference; task-level constraints are explicit in the task context.

---

## 6. State persistence

### 6.1 The state file

The orchestrator maintains project state in a designated file. The state file is the persistent memory that survives across Claude.ai conversations.

**Filename convention:** `project-state.md` in the project's root or `docs/` directory.

**Format:** Structured markdown with explicit section headers. Markdown is chosen over JSON/YAML because:

- Human-readable and human-editable without tooling
- Renders well in editors and Claude.ai conversations
- Allows narrative content (open issues, handoff notes) alongside structured content (task queue, gate status)

### 6.2 State file contents

The state file contains:

**Project metadata:**

- Project name
- Current version
- Current phase (P0, P1, P2, …)
- Last conversation date
- Methodology version used

**Gate status:**

- List of all gates with status (open / closed / blocked)
- For closed gates: closure decision and date
- For open gates: current owner (orchestrator, human, executor)

**Task queue:**

- Pending tasks with task ID, type, scope, status, dependencies
- Tasks in progress
- Recently completed tasks (last ~20)
- Failed tasks awaiting resolution

**Completed work manifest:**

- File-by-file completion status
- Subsystem-by-subsystem completion status
- Test coverage status

**Pattern library cross-references:**

- Pointers to pattern library entries created or modified during this project
- Project-specific pattern overrides

**Open issues:**

- Unresolved questions (Q-items, see §19)
- Deferred decisions
- Technical debt items

**Handoff notes:**

- Free-form notes intended for the next conversation
- Recent context that may not be obvious from the structured sections
- Things the human gate has indicated should be remembered

### 6.3 Read/write protocol

**At conversation start:** The orchestrator reads the state file in full. If the state file is missing or empty (new project), the orchestrator notes this and proceeds to project initialization.

**During conversation:** The orchestrator updates an in-memory representation of the state. Updates are not immediately written to the file.

**At conversation end:** The orchestrator writes the updated state file. This is the responsibility of the human or claude-bridge (the orchestrator cannot write files directly in current Claude.ai). The orchestrator produces the complete updated state file content, and the human pastes it into the project file.

**Discipline requirement:** The state file must be updated at end of every conversation. Skipped updates produce drift between actual project state and recorded state, which compounds rapidly. See also §22.3 — every closing commit MUST include a docs update touching status fields.

### 6.4 Multi-conversation continuity

Claude.ai conversations have finite length. A long-running project will span many conversations. The state file is the continuity mechanism.

**At conversation N+1 start:**

1. Read state file
2. Confirm understanding of current state (the orchestrator may briefly summarize current state and ask the human to confirm)
3. Identify what was in progress when conversation N ended
4. Resume from there

**Conversation handoff quality:** The end-of-conversation state update should be detailed enough that conversation N+1 can pick up without needing to ask the human for context. If conversation N+1 frequently needs context that should have been in the state file, the state file format is inadequate and needs refinement.

### 6.5 State file integrity

The state file is critical infrastructure. Protect it:

- Commit to version control on every update
- Keep a backup of the previous version locally
- If state file becomes corrupted or inconsistent, halt the orchestrator and recover from version control

---

# Part III — Orchestrator discipline

This part codifies the discipline patterns the orchestrator must maintain when planning, prompting, verifying, and investigating. These are the patterns most prone to slow degradation if not enforced explicitly.

## 7. Orchestrator verification methodology

### 7.1 Verification plans precede work

Before any investigation begins, the orchestrator files a verification plan containing:

- **Hypothesis being tested** (one sentence, falsifiable)
- **Predicted observations if hypothesis is TRUE** (specific addresses, values, behaviors)
- **Predicted observations if hypothesis is FALSE**
- **Falsification criteria** — what evidence would force rejection
- **Out-of-scope items**
- **Confidence level required to call the hypothesis confirmed**

**Plans MUST commit to predicted observations in advance.** "Investigate whether X" is not a plan. "If X is true, value Y at location Z" is a plan.

### 7.2 Three artifact types

The orchestrator produces two of three artifact types; the executor produces the third:

1. **VERIFICATION PLAN** (orchestrator, before work)
2. **EXECUTION REPORT** (executor, during work)
3. **REVIEW VERDICT** (orchestrator, after evidence)

**Do not collapse these into one artifact.** Each has a different purpose and audience.

### 7.3 Verdict structure

Verdicts contain ONLY these three labels:

- **CONFIRMED** — all predictions matched
- **PARTIALLY CONFIRMED** — some matched, some didn't (list which failed)
- **NOT CONFIRMED** — predictions failed

**Do NOT soften NOT CONFIRMED into "mostly confirmed with caveats."** That is PARTIALLY CONFIRMED.

Verdicts contain:

- Verdict label
- Per-prediction match (list every prediction from the plan; whether evidence matched)
- Deviations (what executor observed that the plan didn't predict)
- Open questions (what remains unresolved)
- Confidence level (per §7.4)

### 7.4 Confidence vocabulary

Use these terms precisely. Not interchangeably:

- **Structurally plausible** — the shape of the claim is consistent with similar known patterns; not yet tested.
- **Inferred from inspection** — the static evidence supports the claim; runtime behavior not yet observed.
- **Observed in trace** — a debugger watch, breakpoint, or execution trace confirmed the behavior.
- **Verified** — observed in trace AND deviations accounted for AND alternative explanations ruled out.

**Never call something "verified" without all three.**

### 7.5 Independence checking before evaluation

Before evaluating any executor claim on a non-trivial technical question, the orchestrator generates at least one alternative explanation for the same evidence. State it explicitly before evaluating the executor's interpretation:

- (α) Executor's interpretation
- (β) Alternative explanation
- (γ) Another alternative

Walk through each. If agreement with the executor emerges without independent reasoning that would have led there, flag it:

> "I'm agreeing based on the executor's framing, not independent analysis. Recommend cold review."

### 7.6 Forbidden phrases without verification

The orchestrator does NOT use:

- "good catch"
- "you're right that..."
- "the executor correctly identified..."
- or similar endorsement phrases

...unless the verification step is complete and evidence has been reviewed.

### 7.7 Questions every technical claim must face

For every non-trivial technical claim made by the executor (or by the orchestrator itself):

- What is the falsification path? What would have to be observed for this to be wrong?
- What did the investigation NOT check?
- Is the load-bearing premise an observation or an inference?
- If a third party had made different choices, would this analysis still hold?
- What is the simplest alternative explanation for the same evidence?

### 7.8 Reviewing without a plan

If asked to evaluate executor analysis when no verification plan exists, the orchestrator's first response is:

> "No plan was filed for this hypothesis. I can either (a) write a retrospective plan and review against it, or (b) decline to review and recommend re-running the investigation plan-first. Which do you want?"

**Do not skip straight to evaluating.**

---

## 8. Prompt generation

### 8.1 Three-phase shape

Most orchestrator prompts for the executor follow a three-phase shape:

- **Phase 1: Design or audit.** Draft a diff or inventory. NO changes applied. Orchestrator reviews.
- **Phase 2: Apply approved diffs.** Run verifications. Report results.
- **Phase 3: Decide based on results** (commit, revise, escalate).

Each phase has an explicit gate. Skip gates only with explicit reason.

### 8.2 Verbatim diffs, not summaries

Phase 1 approval requires the verbatim diff content, not a description of what the diff will do. "Approach summary" is a useful prelude but is NOT diff approval. The orchestrator requests the diff itself before authorizing application.

This catches precision issues at design time, not after running. It has consistently caught issues every time it's been enforced.

### 8.3 Explicit scope statements

Every prompt includes:

- **Scope statement** at the top
- **Out-of-scope section** listing things that look reasonable but aren't part of this task

This bounds the executor's work without requiring the executor to infer scope.

### 8.4 Explicit reporting format

Every orchestrator prompt asking for information specifies the section structure of the response. Include a "Reporting format" section enumerating the section headings the executor produces. Without this, the response shape is loose and review needs another cycle to extract evidence.

This applies to ALL prompts requesting multi-part answers, not just to formal tasks. Even small clarification requests.

### 8.5 Stop conditions

Every investigation task includes explicit stop conditions:

- Specific result conditions (X reached, Y observed)
- Volume limits (N iterations, M log lines)
- Time limits where appropriate
- "Wait for orchestrator next-step decision" gates

Without stop conditions, the executor tends to investigate beyond the question.

### 8.6 Self-assessment ≠ verdict

The executor's self-assessment section describes what happened. The verdict belongs to the orchestrator. Prompts should explicitly say "self-assessment is NOT a verdict."

---

## 9. Investigation methodology

### 9.1 Static analysis first, then dynamic

Begin with the cheapest verification: read the source, check the binary, verify the bytes. If static analysis clears all suspects without finding the bug, escalate to dynamic observation: instruction-level trace, step-through debugger, runtime probe.

**Don't extend static analysis past the point of diminishing returns.** It will not find a bug that is fundamentally dynamic.

### 9.2 When static analysis is exhausted

After several rounds of hypothesis-test-eliminate without convergence, recognize this as a signal that the bug class is dynamic. Pivot to direct runtime observation rather than generating another static hypothesis.

A canonical example from prior project execution: a bug took nine rounds of static hypothesis-testing; the actual cause was visible in one instruction-level trace run. Static rounds 1–9 weren't wasted (they established what the bug WASN'T), but they weren't going to find a dynamic interrupt condition.

### 9.3 When evidence diverges from prior verdict

The FIRST question is always: **"what changed since the prior verdict?"**

Not: "how do we explain the divergence?"

The "explain the divergence" path runs through speculation. The "what changed" path runs through facts.

### 9.4 Per-frame sampling caveat

A per-frame sampler at frame-boundary times has sample bias toward whatever happens at those moments. The CPU being at instruction X at every frame boundary may NOT mean the CPU is stuck at X. It may mean X is where the CPU is at IRQ-entry time. Treat per-frame sample patterns with this awareness.

### 9.5 Architectural bypass paths

A common bug class: subsystem A appears to control subsystem B via register X, but subsystem C can also drive subsystem B via register Y, bypassing X. You configure X correctly and B doesn't behave.

Document these bypasses explicitly when discovered:

> "Subsystem C bypasses subsystem A's control; see §N."

### 9.6 Transitive inference for unobservable state

When a register or state is write-only (reads don't reflect writes), verify the write via observable downstream consequences (resulting behavior, rate, mode) rather than post-write read-back. Mark these verifications as "inferred from consequence" — they're not direct measurements (see §7.4 confidence vocabulary).

### 9.7 The visual gate is irreplaceable

For any project with human-perceptible output, there is NO substitute for the human watching it run. Automated verification can confirm structure, rates, and behavior up to the harness's observation level. Human visual inspection catches "this looks wrong" that no automated check can express.

The three-role workflow only works if the human gate is actually used at the right points.

---

## 10. Task sequencing patterns

### 10.1 Audit-before-execution (for broad tasks)

For any task with potentially-broad scope (documentation cleanup, refactoring, architectural changes), use a three-phase shape:

- **Phase 1: Audit.** Inventory current state. Classify items. Recommend scope.
- **Phase 2: Diff.** Verbatim diffs for scoped items. Orchestrator reviews.
- **Phase 3: Apply.** Single commit covering approved diffs.

The audit phase surfaces scope decisions that would otherwise get buried in diff implementation. This shape consistently produces better outcomes for broad tasks than direct "go make the changes."

### 10.2 Design-diff-execute (for investigations)

For investigations or implementations:

- **Phase 1: Design.** Approach choice + verbatim implementation diff.
- **Phase 2: Apply, run, report.**
- **Phase 3: Decide based on results.**

Each phase has explicit gates.

### 10.3 Don't bundle requests with feedback

When asking for information, ask directly. Don't bundle with methodology critique or general observations. The bundling creates ambiguity about what's load-bearing vs. contextual.

If methodology critique is needed, make it a separate artifact.

### 10.4 Decision-then-execution

When a decision is needed from the human, present options cleanly with trade-offs. Don't pre-commit to a choice and present it as "let me know if you want something else." That biases the response toward acceptance.

When the human answers "no preference," treat it as **"your framing is wrong; pivot,"** not as "I don't know."

---

# Part IV — Knowledge management

## 11. The pattern library

### 11.1 Purpose

The pattern library captures reusable knowledge about doing this kind of work. Patterns include:

- Source-to-target idiom translations
- Architectural patterns (contract design, dispatch tables, runtime detection)
- Error-handling conventions
- Anti-patterns (what to avoid and why)
- Calibration findings (what works well, what doesn't)

The pattern library is the project's institutional memory. New tasks consult it for guidance; completed tasks contribute to it.

### 11.2 Structure

The pattern library is organized in two tiers:

**Cross-project methodology patterns:** patterns that apply across multiple projects. Examples:

- "Use dispatch tables for runtime-selected implementations"
- "When porting 6502 to 6809, treat zero-page as direct-page"
- "Acceptance criteria should be defined before context packaging"

These live in a shared location and are accessible to all projects. Filename convention: `patterns/methodology/<pattern-name>.md`.

**Project-specific patterns:** patterns that apply to this project specifically. Examples:

- Project-specific data format encoding
- Project-specific subsystem rendering quirks

These live within the project. Filename convention: `patterns/project/<pattern-name>.md`.

### 11.3 Per-pattern format

Each pattern is a small markdown file with the following structure:

```markdown
# Pattern: <name>

## Type
<idiom-translation | architectural | convention | anti-pattern | calibration>

## Scope
<methodology | project-specific>

## Applies to
<what kind of task or situation this pattern applies to>

## Description
<plain prose explanation>

## Example
<concrete example showing the pattern in use>

## Anti-example (if relevant)
<what the pattern is preventing>

## Caveats
<when not to apply this pattern>

## References
<links to tasks, files, or sources>

## Status
<draft | active | deprecated>

## History
<dates and revisions>
```

### 11.4 Capture protocol

**During task execution:** The executor notices patterns and includes them in the "Pattern Observations" section of the task report.

**During task verification:** The orchestrator reviews the executor's observations. Patterns may be:

- Added to the library as new entries
- Folded into existing entries
- Deferred for later capture
- Rejected as not generally applicable

**During gate review:** The human gate may identify patterns the orchestrator missed. These get captured retroactively.

**Pre-population at project start:** Some patterns are predictable before execution begins — known ISA translations, documented project architectural patterns, known anti-patterns. These are pre-populated during project setup, not discovered during execution. The pattern library starts with content rather than empty.

Pre-population is bounded by what is predictable. Patterns that require execution experience to identify (specific edge cases, unanticipated source idioms, project-specific corner cases) emerge through normal capture during execution.

The methodology-tier pattern library (`patterns/methodology/`) starts empty regardless. Methodology patterns crystallize after multiple projects, not from a single project's introspection. Candidates may be noted in this methodology document but not added to the library until proven empirically (see §29).

### 11.5 Consultation protocol

**During context packaging:** The orchestrator selects patterns relevant to the task (per §5.3 selection rule) and includes their content in the task context.

**During execution:** The executor consults included patterns before designing solutions. Pattern conflicts (two patterns suggest different approaches) are flagged as uncertainties.

**During verification:** The orchestrator checks whether the executor followed relevant patterns. Departures from established patterns are not necessarily failures, but they require justification in the executor's reasoning section.

**Pattern status semantics:** Patterns have three status values:

- **draft** — pre-populated but not yet validated in execution; or candidate methodology-tier patterns. Used cautiously. May be wrong.
- **active** — validated by use. Reliable.
- **deprecated** — known wrong or superseded. Not included in new task contexts.

A pre-populated pattern starts as `draft` and transitions to `active` after first confirmed use in an actual task. The transition is the orchestrator's call during pattern review.

### 11.6 Maintenance and pruning

Patterns can be wrong. They can become obsolete as the project evolves. They can be superseded by better patterns. Maintenance is required.

**Triggers for pattern revision:**

- Repeated failures attributable to a pattern → revise or deprecate
- Pattern's anti-example becomes more common than its example → revisit
- New language features or tooling supersede the pattern → update
- Project evolution makes the pattern no longer relevant → deprecate

**Deprecation protocol:**

When a pattern is deprecated:

- Status changes from "active" to "deprecated"
- Replacement pattern (if any) is linked
- Pattern remains in the library for historical reference
- Pattern is not included in new task contexts

---

## 12. Documentation-first rule

When implementing anything that depends on platform-specific behavior, ISA-level semantics, or undocumented behavior, verify against authoritative reference before producing code.

**Concrete examples:**

- **ISA-level details.** Specific instruction encodings or postbyte semantics must be verified against the official datasheet, not guessed or pattern-matched from training data.
- **Hardware register definitions.** Register meanings, bit layouts, and side effects must be verified against the platform programming reference, not assumed.
- **Undocumented behavior.** Illegal-opcode handling, silicon-revision differences, MMU wrap-around behavior, OS system call semantics — all require verification against documentation or empirical testing, not guesses.
- **File format details.** Exact byte layouts must be decoded from authoritative source before writing conversion tool code.

The orchestrator enforces this rule by:

1. Requiring task contexts to cite authoritative references for any platform-specific work
2. Refusing to accept executor work that guesses at undocumented behavior
3. Adding pattern library entries when documented behavior gets confirmed (so future tasks benefit)

The documentation-first rule has cost — research time before coding — but pays for itself by avoiding catastrophic late-stage discoveries. A wrong assumption about hardware behavior discovered during a late gate is dramatically more expensive than a documentation lookup early on.

For tasks where authoritative documentation isn't available, the rule degrades to: use empirical testing as substitute, document findings explicitly, mark conclusions as provisional until validated.

---

# Part V — Failure recovery

The methodology accepts that failures will happen. Recovery procedures are part of the design.

## 13. Failure modes and recovery

### 13.1 Executor produces wrong code

**Detection:**

- Test failures in the executor's report
- Code review reveals issues
- Acceptance criteria not met

**Recovery:**

- Orchestrator produces a revision prompt with specific feedback
- Executor re-runs with revised context
- Up to 3 revision rounds before escalation
- After 3 rounds: escalate to human gate with full history

**Common causes:**

- Insufficient context (missing convention, missing related routine)
- Pattern misapplied
- Misunderstood task scope
- Edge cases not in original source not handled in target

**Prevention:** Better context packaging, better acceptance criteria, pattern library quality.

### 13.2 Tests fail

**Detection:** Harness reports failure; executor reports failure in test results section.

**Recovery:**

- Orchestrator analyzes failure mode
- If failure is in the executor's code: revision prompt
- If failure is in the test or harness: separate task to fix the harness
- If failure mode is unclear: escalate

**Distinction:**

- Failures in code under test → revise code
- Failures in test infrastructure → revise tests
- Failures in expectations → revise acceptance criteria (and escalate, because expectations are design)

### 13.3 Acceptance criteria turn out wrong

**Detection:**

- Executor produces work that meets the criteria but doesn't work
- Verification passes but the work obviously isn't right
- Human gate reviews and rejects work the orchestrator accepted

**Recovery:**

- Orchestrator revises acceptance criteria
- Human gate reviews revised criteria
- Task may be re-run with new criteria

**This is methodology-level signal:** Recurring acceptance criteria issues indicate the orchestrator's criteria design is weak. This warrants methodology revision attention.

### 13.4 Context insufficient

**Detection:**

- Executor flags missing context in uncertainty section
- Executor proceeds on assumptions that turn out wrong

**Recovery:**

- Orchestrator adds missing context to a revision prompt
- Executor re-runs with augmented context
- Pattern: this becomes a context-packaging improvement to remember

### 13.5 Pattern misleading

**Detection:**

- Following a pattern produces failure
- Multiple tasks following the same pattern hit similar issues

**Recovery:**

- Identify the pattern
- Determine whether it's wrong, incomplete, or being misapplied
- Revise, narrow scope, or deprecate
- Document the revision in the pattern's history

### 13.6 Orchestrator state out of sync

**Detection:**

- New conversation starts and the state file doesn't reflect reality
- Tasks are queued that have already been done
- Gate status doesn't match actual project state

**Recovery:**

- Halt task execution
- Reconstruct true state from project files (git history, code on disk)
- Update state file to match reality
- Identify root cause: missed update at end of previous conversation? Manual edit not synchronized?

**Prevention:** Discipline on end-of-conversation state updates. State file in version control (so divergence is detectable).

### 13.7 Escalation criteria

Some situations always escalate to the human gate immediately, without retry attempts:

- Design ambiguity (acceptance criteria require a design decision)
- Methodology questions (the methodology itself appears to be producing bad outcomes)
- Cross-project impact (changes that affect other projects)
- Gate boundary decisions (advancing through review gates)
- Release decisions (shipping artifacts)
- Conflicts between project state and human-provided direction

Other situations escalate after retry attempts:

- 3 revision rounds on the same task without resolution
- Repeated pattern failures
- Acceptance criteria that need refinement
- Context that turns out repeatedly insufficient

### 13.8 The "obviously wrong" detector

A specific failure mode worth naming: the orchestrator accepts work that's mechanically correct but obviously wrong by judgment.

Example: a ported routine that assembles cleanly, passes tests, but uses a completely inappropriate instruction in a context that violates a layer constraint.

The orchestrator's verification step must include a "smell test" — not just mechanical criteria, but a reasonableness check. If the work seems off, escalate even if criteria technically pass.

This is judgment work, harder to specify than mechanical verification. The orchestrator is expected to apply it. The human gate is the backstop when the orchestrator's judgment fails.

---

## 14. Orchestrator error patterns

These are recurring failure modes the orchestrator should self-monitor for.

### 14.1 Verdict cycling

**Failure mode:** a piece of evidence arrives, orchestrator rushes to integrate it, issues new verdict. Next piece arrives, orchestrator cycles again.

**Correct behavior:** ambiguous evidence calls for "more data," not a new verdict. Hold verdict status until evidence is unambiguous.

### 14.2 Accepting executor framings

**Failure mode:** executor produces a plausible interpretation, orchestrator accepts the framing and proceeds. Independent analysis would have caught issues.

**Correct behavior:** apply independence check (α/β/γ per §7.5) to every executor interpretation on non-trivial technical questions.

### 14.3 Speculation contamination

**Failure mode:** orchestrator publishes speculation chains in outputs. Executor then has to respond to the orchestrator's framings rather than investigate freshly.

**Correct behavior:** when about to publish a speculation chain, stop. Ask the clarifying question instead. Let the executor's answer drive the next round.

### 14.4 Reflexive method selection

**Failure mode:** orchestrator reaches for the most-recently-used investigation method (bisect, hypothesis-test, etc.) rather than considering what would localize the bug fastest.

**Correct behavior:** apply independence check to OWN proposed next steps, not just to executor outputs.

### 14.5 Drift from original question

**Failure mode:** long investigations drift. Closure addresses the symptom that surfaced during investigation, not the original question.

**Correct behavior:** periodically return to the original question. After closure, verify the original purpose was actually addressed.

### 14.6 Implicit confirmation

**Failure mode:** orchestrator interprets ambiguous human input as confirmation. "Looked good" treated as visual gate PASS.

**Correct behavior:** visual gate confirmation requires explicit details. "Scene visible for ~2.67 seconds, then blank" is confirmation. "Looked good" is not.

### 14.7 Optimizing for forward motion

**Meta-pattern:** most orchestrator errors share the shape of "ship a verdict / dispatch a prompt" prioritized over "verify accuracy." The discipline that prevents this is patience — specifically: pausing before verdicts, before prompts, before accepting framings.

The system rewards forward motion in the short term. Forward motion on a wrong path costs more than patience on the right path.

---

## 15. Executor error patterns

These are recurring failure modes the executor should self-monitor for, and that the orchestrator should watch for when reviewing executor output.

### 15.1 Directional approval vs. diff approval

**Failure mode:** executor treats "proceed with the approach" authorization as authorization to apply any specific diff.

**Correct behavior:** produce a verbatim diff for review before applying, even when the direction has been approved (see §8.2).

### 15.2 Inference vs. asking

**Failure mode (over-inferring):** executor silently infers what the orchestrator wants and proceeds. If wrong, work is misdirected.

**Failure mode (under-inferring):** executor stops to ask about every uncertainty.

**Correct behavior:** state inferences explicitly with "I'm proceeding on inference that X; if X is wrong, flag it" for low-stakes choices. Reserve explicit asks for inferences where cost-of-wrong is high (destructive operations, architectural decisions, scope changes).

### 15.3 Conflicting directives

**Failure mode:** executor proceeds on one directive while ignoring a conflicting later directive.

**Correct behavior:** last directive wins, with explicit acknowledgment:

> "Note: this supersedes the earlier constraint about X; proceeding with the more recent directive."

### 15.4 Execution overreach

**Failure mode:** executor adds cleanup, refactoring, or functionality alongside the requested change. Review surface expands, regression risk introduced.

**Correct behavior:** do exactly what was asked. Flag noticed-but-out-of-scope items. Wait for authorization.

### 15.5 Catching orchestrator errors

When an orchestrator prompt has an internal inconsistency or factual error about the codebase, the executor flags it before proceeding.

> "Your prompt says X but the source says Y — proceeding with Y unless you direct otherwise"

...is the correct behavior. Silently executing on the incorrect premise is worse.

---

## 16. Bug discovery discipline

### 16.1 Symptom location ≠ root cause location

The root cause of a bug is rarely where the symptom appears. Continue investigating past the symptom until you find why the behavior is wrong and what minimal change makes it right.

### 16.2 Test driver passing ≠ integration working

When a test driver passes but production integration fails at the same feature, the first question is "what's different?" Timing, initialization order, masked-state differences between standalone test and production integration are common culprits.

### 16.3 "Why wasn't this caught earlier?"

When a production bug is found that earlier tests missed, the root-cause record includes a paragraph explaining why the test suite didn't catch it. This prevents the gap from recurring and calibrates the test suite.

### 16.4 Four places to record root cause

When an architectural bug is fixed:

1. Source code comment citing the investigation
2. Commit message with root cause summary
3. Relevant doc with architectural explanation
4. `project-state.md` execution history entry

Sounds like overhead; each audience reads a different artifact.

### 16.5 Architectural fixes vs. narrow fixes

If a fix requires a 10-line comment explaining why a value was changed, the fix is architectural. That comment belongs in the docs as well, with reference back to the source.

If a fix is just "rename a variable" or "correct an off-by-one," it's narrow. Narrow fixes don't need architectural explanation.

---

# Part VI — Project infrastructure

## 17. Repository and documentation conventions

### 17.1 Repository organization

**Separate tests/ from src/.** Test harnesses, drivers, and verification infrastructure belong in a dedicated subtree, not alongside production source. When tests and production code share directories, boundaries erode and instrumentation state leaks into production.

**`build/` is ephemeral, `docs/` is durable.** Build artifacts never get committed. Docs are always committed alongside the code changes they describe.

**`tools/` is for long-lived utilities, not tests.** Conversion scripts, decoders, helper utilities belong here. Tests in `tests/`. Don't collapse them.

**Sibling-repo oracle pattern:** if the project is a port, reimplementation, or adaptation, keep the authoritative source as a sibling directory consumed by path reference (not as a submodule). The oracle is READ-ONLY. No writes, no modifications, only reference.

**Session notes vs. project docs:** keep a `session-notes/` directory for per-session records, but DO NOT commit them. Session notes are ephemeral. If something in a session note is load-bearing, promote it into `docs/` as part of that session's closing commit.

### 17.2 Required project documents

Every project needs at minimum these five docs:

- **`project-state.md`** (running execution log; current status; execution history)
- **`milestones.md`** (phase + integration milestone tracker; blocker lists)
- **`conventions.md`** (coding, naming, formatting decisions)
- **`open-questions.md`** (design questions with lifecycle states)
- **One or more domain-specific reference docs** (architectural contracts, API specs, hardware references — whatever the architectural boundary requires)

These five serve distinct roles. They do not merge.

### 17.3 Document lifecycle

**Status docs** (`project-state.md`, `milestones.md`) become stale the moment work closes if nobody updates them. **RULE: every closing commit MUST include a docs update touching status fields.** This is a commit discipline, not an afterthought.

**Reference docs are write-once, extend-forward.** A contract, API spec, or interface definition is not a status doc. Once written, it is extended with new sections, never overwritten. Decisions are additive.

**Open questions have three states:** OPEN, CLOSED, DEFERRED. Not "resolved" and "unresolved." DEFERRED means "answered in principle but not in practice." CLOSED means "answered AND implemented AND verified." Don't skip DEFERRED — it's the honest state for many questions.

### 17.4 Cross-reference convention

Cite specific sections, not doc names. `docs/interrupt-handling.md §11` is useful; "the interrupt docs" is not. Use a consistent pattern:

```
[ref: file §section — human-readable hook]
```

Apply this in source code comments, commit messages, doc cross-links, and orchestrator artifacts. Searching is fast when the pattern is consistent.

### 17.5 When to add new docs

Default to extending an existing doc. Only create a new doc when (a) the content is fundamentally different in audience or lifecycle, or (b) the target doc would double in size.

---

## 18. Phase and milestone tracking

### 18.1 Separate phases from integration milestones

**Phases (P1, P2, P3...)** track subsystem work: components built, layers implemented, infrastructure established.

**Integration milestones (INT-1, INT-2, INT-3...)** track convergence: when components combine into running, human-verifiable deliverables.

These answer different questions. A project with only phase tracking will close all phases and still not know when users can see anything working.

### 18.2 Blocker lists as operational unit

The question "what's left before INT-1?" should be answerable by a flat list of named blockers, each with status (OPEN / CLOSED / DEFERRED) and commit hash where applicable.

The list is the truth. The milestone status is derived from it. When the last blocker closes, the milestone closes — no separate milestone-closure step.

### 18.3 Status precision rules

**"NOT STARTED" is a lie once any blocker closes.** As soon as one requirement for a milestone is met, the milestone is IN PROGRESS. Keeping it NOT STARTED creates false pessimism.

**Deferred items need a named destination.** "Deferred to combat-path work" combined with the milestone name (P4, INT-4, etc.) is the minimum viable deferral record. An unanchored deferral is a ticket that will never be picked up.

**Phase status in `milestones.md` should be one line per phase.** Detailed execution history lives in `project-state.md §Execution history`. `milestones.md` is the index; `project-state.md` is the record.

---

## 19. Question and decision tracking

### 19.1 Numbered open questions

Number open questions Q001, Q002, ... Unnumbered questions get lost. A numbered question can be referenced from code comments, commits, and other docs. The number is stable even after the question closes.

### 19.2 Required lifecycle

Q entries have a required lifecycle: **opened** (context + question stated) → **tried** (attempts recorded) → **closed** (resolution recorded, implementation pointer added).

Skipping "tried" is acceptable for fast resolutions. Skipping "closed" is not — a question that closes without a recorded resolution is unauditable.

### 19.3 Decision points (D-items) are different from Q-items

**D-items** are in-task implementation choices that need orchestrator approval before proceeding. They appear in the execution report, get approved or rejected by the orchestrator, and are referenced in the commit. They do NOT go in `open-questions.md`.

**Q-items** are design-level questions. D-items are tactical choices.

### 19.4 Followup question pattern

When verification of a closed question reveals a new wrinkle, record it as Q-followup-N (or Q001.followup-1), not as a new top-level question. This preserves the causal chain.

### 19.5 "Closed" precision

**Closed means implemented AND verified, not just decided.** A question answered by design discussion is not closed until the implementation lands and is verified. Keep OPEN with a "tentative resolution" note until then.

---

## 20. Audit and scope

### 20.1 Pre-execution scope audit

Before executing a phase, explicitly enumerate what is in scope and what is not, with justification. An audit that explicitly says "these 3 items are OUT-OF-SCOPE because..." is more useful than just listing in-scope items.

### 20.2 Mutually exclusive classification buckets

A good classification scheme has categories for everything, with no overlap. Adapt to project type, but every item must land in exactly one bucket. Common buckets:

- **DIRECT-PORT / DIRECT-IMPLEMENT**
- **ABSORBED** (functionality provided via a different mechanism — a completion state, not a missing state)
- **OUT-OF-SCOPE** (genuinely doesn't apply)
- **DEFERRED** (will be addressed at a named future milestone)

### 20.3 Scope interpretation must be chosen explicitly

When two plausible scope interpretations give different audit results, name both, explain the difference, and record which was chosen and by whom. Silently picking one makes the audit untrustworthy.

---

## 21. Verification infrastructure

### 21.1 Three levels of verification

- **(a) Structural verification:** does the output have the expected shape?
- **(b) Behavioral verification:** does it behave at the expected rate / output / sequence?
- **(c) Human visual verification:** does it look correct to a human?

All three are necessary; none replaces the others. A project with only (a) will ship behavior that looks structurally correct but is wrong.

### 21.2 Test driver isolation

Each test driver should be a self-contained binary/artifact that builds independently and exercises one specific behavior. Test drivers should have their own inline copies of whatever they need rather than depending on the production build. This isolation ensures test results are attributable and regressions are meaningful.

### 21.3 Sampling resolution limits

Per-frame sampling has a resolution limit. A harness sampling state at 60 Hz cannot observe behavior completing within a single frame. For sub-frame verification, instruction-level tracing or higher-frequency capture is required. **Know which resolution level is required BEFORE choosing the harness strategy.**

### 21.4 Regression suites are a no-regression signal, NOT a positive verification

A regression suite that passes means "nothing that worked before is broken." It does not mean "the new thing works correctly." For new functionality, add a new test driver. Don't rely on existing tests to catch new behavior.

### 21.5 Necessary but not sufficient

A passing metric may be necessary without being sufficient. Example: a counter incrementing at 60 Hz proves counter advancement but does NOT prove that the intended mechanism is what's driving the advance. Verifications must match the specific claim being made. "The counter advances" is different from "the counter advances via mechanism X."

### 21.6 Commit the harness with the code

A verification script left uncommitted is a liability. Commit the harness in the same commit as the implementation. The harness must be runnable on the committed binary, not on a hypothetical "current working copy."

### 21.7 Evidence chain in verdicts

A verdict is not just "PASS." It's "PASS, with this specific output captured at this specific binary hash." Store the passing output (or summary) in the commit message or associated doc entry.

---

## 22. Git workflow

### 22.1 Commit message structure

```
type: scope — human description
```

Line 1 format. Examples:

```
impl: R-boot — Brøderbund splash
docs: post-R-boot cleanup
fix: HAL_gfx_init IEN preservation
```

The type field (`docs:`, `impl:`, `fix:`, `test:`, `refactor:`) makes `git log` scannable without reading bodies. The scope names a specific deliverable.

### 22.2 Prerequisite chain in body

For implementation commits, include a line citing the chain of prerequisites:

```
Prerequisite chain: X → Y → Z → this commit
```

Use commit hashes or named deliverables. A reader starting from any commit can reconstruct the path.

### 22.3 Closures must say so

Commits that close work say "CONFIRMED", "CLOSED", or "FIXED" in the body, with the verdict source. Auditable closures:

```
R-boot (CONFIRMED 2026-05-21; Jay's visual gate)
Q001 CLOSED — implemented in commit X
```

Vague closures fail audit:

```
Added Brøderbund scene  ← bad
Updated docs            ← bad
```

### 22.4 Working tree hygiene

Every untracked file is a decision. Either it belongs in the commit (stage it), belongs in `.gitignore` (add it), or is ephemeral (leave it untracked, don't commit). Before any commit, review untracked file list and make a conscious choice for each.

### 22.5 When to defer a commit

If you can't write a single coherent commit message that honestly describes the change, the work isn't done. Either loose ends remain, or multiple orthogonal changes got mixed. Split and finish before committing.

### 22.6 Don't amend pushed commits

Even for "just a typo." The audit trail is part of the truth. Add a followup commit instead.

---

## 23. Build infrastructure

### 23.1 Size and hash as verification

After every build, record the artifact size and hash (MD5 or SHA256) in the execution report. Unexpected growth deserves explanation. Unexpected shrinkage deserves more urgent explanation.

### 23.2 "Build clean" is a signal

If the source is unchanged, the build should produce no output. "Nothing to be done" is meaningful — it confirms the working copy matches the last build. Build systems that always rebuild hide information.

### 23.3 Separate production from test builds

The main build (e.g., `make` from repo root) builds only the production artifact. Test driver builds are explicit invocations in each test runner script. This keeps the production build clean and test driver dependencies visible.

### 23.4 Single build entry point

`make` from the repo root should always work with no environment setup beyond documented prerequisites. Build scripts requiring specific working directories, environment variables, or manual pre-steps create fragility.

---

## 24. File naming and artifacts

### 24.1 Artifact-type-distinct naming

Distinguish:

- **Plan docs** (what will happen)
- **Execution reports** (what happened)
- **Verdicts** (orchestrator judgment)
- **Prompts** (instructions for the executor)

These should be named and structured differently.

### 24.2 Execution reports are ephemeral

Execution reports stay in chat, not in the repo. Committing them creates diff noise. The durable record is what gets promoted into `project-state.md §Execution history` and the commit message.

### 24.3 Test name describes behavior, not chronology

`run_kernel_dispatch_test.sh` is better than `test_phase_2_3a.sh`. The former is searchable and self-describing.

### 24.4 Orchestrator-to-executor prompts are filed

When the orchestrator drafts a prompt for the executor (carried by the human), the prompt is a file artifact. Naming convention: `executor_prompt_<topic>.txt` (or equivalent). Orchestrator-only artifacts don't use the executor prefix.

---

# Part VII — Process

## 25. Calibration phase

The first 20–50 tasks of any project's use of this methodology are the calibration phase. During calibration, the methodology is being tuned to the specific project and the specific human's preferences.

### 25.1 What changes during calibration

- **Human gate involvement is higher.** Every task is human-reviewed before integration. The human is checking not just the work but the orchestrator's task design, context packaging, and verification.
- **Acceptance criteria are refined frequently.** The first attempts at criteria are likely to miss things. As criteria fail (either by missing real problems or by flagging false issues), they get revised.
- **Pattern library is populated rapidly.** Early tasks discover many patterns. The library grows quickly during calibration.
- **Methodology may itself be revised.** If the calibration reveals gaps in this document, the document gets updated.
- **Task granularity is being calibrated.** Initial guesses may turn out wrong for this project. Tasks may be smaller or larger than initially designed.

### 25.2 What to watch for

- **Token budgets actually used.** Are the target ranges (30K–50K) right? Are some task types systematically larger or smaller? Adjust budgets accordingly.
- **Common failure modes.** Which kinds of failures happen most often? These are signals for methodology refinement.
- **Time per task.** Are tasks completing in expected timeframes? Wildly variable times suggest task granularity is wrong.
- **Human gate workload.** Is the human spending too much time in the loop? Not enough? Calibrate the gate involvement level.
- **Pattern library effectiveness.** Are pattern library entries being consulted and helping? Or are they being ignored or proving wrong?

### 25.3 Transition criteria

The calibration phase ends when the human and orchestrator both judge that:

- Methodology is producing consistent outcomes
- Most tasks pass verification without escalation
- Pattern library is well-populated for the project's idioms
- The human can step back from per-task review
- Failure modes are well-understood

This typically happens around the 20–50 task mark. There's no fixed task count.

### 25.4 Steady state

After calibration, the methodology runs at lower human involvement:

- Task definition and context packaging by orchestrator without per-task review
- Human gate reviews at file boundaries, subsystem boundaries, and gate boundaries
- Pattern library updates by orchestrator without per-pattern review
- Methodology revisions only on significant signal

Steady state is the target. Calibration is the cost of getting there.

### 25.5 Calibration is when discipline forms

Apply all the discipline patterns in Parts III, V, and VI from the first day. Patterns formed late are harder to instill than patterns formed at the start.

---

## 26. Cross-cutting concerns

Some technical concerns affect every routine in a project rather than just specific subsystems. These cross-cutting concerns need explicit project-level rules, not just pattern library entries.

### 26.1 What makes a concern cross-cutting

A concern is cross-cutting if all three apply:

- It affects many routines, not just a few (most code in the project must respect it)
- The orchestrator cannot reliably catch violations through pattern matching alone (executor needs to know the rule, not just see examples)
- Getting it wrong produces subtle bugs that pass some tests and fail others (silent corruption rather than visible crash)

**Examples that meet this definition:**

- **Endianness** — when crossing CPU architectures (e.g. little-endian to big-endian). Every 16-bit value, every pointer, every byte-pair manipulation. Wrong handling produces values that work by coincidence in some cases and fail in others.
- **Calling conventions** — which registers are scratch vs preserved. Every routine. Wrong handling produces subtle corruption that surfaces in callers, not the wrong routine.
- **Alignment** — for platforms where it matters. Every data structure.
- **Direct page / zero-page allocation** — which slots belong to which subsystem. Every routine that uses direct page.
- **Interrupt discipline** — which code can touch interrupt state. Every routine, but most don't.

### 26.2 Project-level rule vs pattern library entry

The criterion for promoting a concern from pattern library entry to project-level rule:

**Pattern library entry sufficient when:**

- The concern arises only in specific recognizable contexts
- The pattern library entry's example is itself enough to teach correct handling
- Violations are visible (don't pass tests by accident)

**Project-level rule required when:**

- The concern arises everywhere
- Examples alone don't suffice — the executor needs to internalize the rule
- Violations can pass tests by coincidence and surface much later

Project-level rules live in the conventions document, are read at every task, and are independent of pattern library inclusion. They cannot be missed.

The orchestrator's job: identify cross-cutting concerns and codify them as project-level rules, not bury them in the pattern library where they might not be selected for inclusion.

### 26.3 Catalogue of cross-cutting concerns to consider per project

When designing a project that uses this methodology, the orchestrator should explicitly consider whether each of these is a cross-cutting concern that needs a project-level rule:

- Endianness (relevant when crossing CPU architectures)
- Alignment requirements
- Calling conventions
- Register preservation/clobber rules
- Direct page or zero-page allocation
- Interrupt discipline
- Stack discipline
- Error handling/propagation
- Memory ownership (who allocates, who frees)
- Threading/reentrancy model
- Naming conventions (when violated they impede searchability across files)
- Comment formats (when missing they impede orchestrator's verification)

Not every project has all of these as cross-cutting concerns. For each, the orchestrator decides: "is this universally relevant, or just specific to certain subsystems?"

### 26.4 Cross-cutting concerns and verification

Cross-cutting concerns are particularly important because they're poorly served by per-task verification. A single task's tests can pass while violating a cross-cutting concern in ways that surface later.

**Defensive measures:**

- **Linter coverage.** Where mechanical, linter checks every file for the rule. Catches violations at task-time.
- **Per-routine harness tests with asymmetric data.** Endianness bugs need asymmetric 16-bit values to surface. Use `$1234`, not `$1111`.
- **Periodic full-tree review.** During gate review, sample routines for cross-cutting concern compliance. Not every routine, but enough to catch systemic drift.

Cross-cutting concerns are second-order failure mode (something that fails because of accumulated small violations). The methodology's normal verification is first-order (does this task pass its own criteria). Both are needed.

---

## 27. Starting a new project

### 27.1 Day-zero checklist

Before any code:

1. Create `docs/` with five required docs (§17.2). Each is stub or sentinel.
2. Create `milestones.md` with phase plan and integration milestones (§18.1).
3. Decide on three-role workflow and document it (Part I).
4. Decide on test driver pattern (§21.2).
5. Decide on commit message convention (§22.1).
6. Decide on file naming conventions (§24).
7. Set up build with a single entry point (§23.4).
8. Identify cross-cutting concerns and codify as project-level rules (§26).
9. Pre-populate the project-specific pattern library with predictable entries (§11.4).
10. Specify project-specific bindings (acceptance criteria refinements, context defaults, harness invocations) in a project bindings document — these are not part of this methodology document.

### 27.2 First orchestrator task

The first orchestrator task on a new project is the project plan itself: phase decomposition, milestone targets, blocker lists, verification strategy. This follows the verification plan shape (§7.1) — predicted observations of what success looks like at each milestone.

### 27.3 First executor task

The first executor task is to **build the build.** Establish that the build works, produces an artifact of expected shape, and runs cleanly with no warnings.

### 27.4 First human gate

The first human gate is the project plan review. The human confirms the phase decomposition, milestone targets, and verification strategy make sense.

### 27.5 Iteration discipline from day one

Apply Parts III, V, and VI from the first day. Patterns formed late are harder to instill than patterns formed at the start.

---

# Part VIII — Meta

## 28. Cross-project considerations

### 28.1 Methodology evolution

This document is v0.3. Expected revisions during use:

- Refinements based on calibration findings
- Additional failure modes discovered
- Pattern library structural improvements
- Token budget revisions
- Task granularity adjustments

**Revision process:**

1. Significant issue identified during use
2. Human gate decides whether the issue is local (project-specific binding) or methodology-level
3. If methodology-level: revision drafted, reviewed, version incremented
4. Older versions retained for projects that started under them (no forced migration)

Projects are expected to specify which methodology version they use. Mid-project migration to a new methodology version is allowed but not required.

### 28.2 Patterns shared across projects

The cross-project patterns (§11.2 tier 1) are shared across all projects using this methodology. Examples expected to be useful:

- Dispatch table pattern for runtime selection
- Boot-time detection patterns
- Contract design patterns
- Cross-architecture instruction idiom translations
- Harness automation patterns
- Documentation-first discipline patterns

A central methodology pattern library is maintained. Each project may reference patterns; new patterns discovered may be promoted from project-local to cross-project.

### 28.3 Relationship to claude-bridge

The methodology is designed to work manually. When claude-bridge is production-ready, the following changes are anticipated:

- State file updates become automatic (claude-bridge captures conversation-end state)
- Prompt transmission becomes automatic (orchestrator-to-executor over MCP)
- Report return becomes automatic (executor-to-orchestrator over MCP)
- Test execution becomes automatic (orchestrator can invoke executor's local commands)

**The methodology itself does not change.** The substrate becomes more convenient.

**Migration path:**

When claude-bridge reaches P2 maturity, an active project may migrate. Migration involves:

1. Set up project workspace in claude-bridge VS Code extension
2. Configure orchestrator endpoint
3. Test on a small task to verify
4. Switch from manual to automated operation
5. Continue project work

The migration is not visible in the design doc structure — it changes execution, not design.

### 28.4 Methodology cross-pollination

This methodology informs and is informed by sibling projects in adjacent domains:

- **Compiler backend work.** Per-stage tasks align well with this methodology's task lifecycle. Cross-architecture pattern library entries are directly shared.
- **OS / kernel work.** Per-subsystem tasks fit. Pattern library entries about contract design, capability-based interfaces, and message-passing patterns may be useful.
- **Hardware design (HDL).** Different domain, but similar discipline. The methodology may need adaptation for HDL work but the core orchestrator/executor/gate pattern likely transfers.
- **Adoption mid-project** is more disruptive than starting under it. Decisions to adopt deferred to each project's implementation phase.

---

## 29. Methodology refinements catalogue

This section catalogues the refinements that have been incorporated, both from the prior v0.2 design and from the seed document absorption in v0.3. The catalogue serves as a reference for which changes are codified vs candidate.

### 29.1 From v0.2 (POP-coco3 design phase)

| # | Refinement | Status in v0.3 |
|---|------------|----------------|
| 1 | Six-component tooling pattern | Candidate methodology pattern |
| 2 | Spec-driven verification | Candidate methodology pattern |
| 3 | Three-pillar task context | Codified (§5.0) |
| 4 | Pattern selection logic | Codified (§5.3) |
| 5 | Always-on instrumentation principle | Candidate methodology pattern |
| 6 | Detection transparency principle | Candidate methodology pattern |
| 7 | Real-hardware verification as gate-blocking | Codified (§4) |
| 8 | Pre-population vs empirical discovery | Codified (§11.4) |
| 9 | Pre-populate-then-discover rhythm | Candidate methodology pattern |
| 10 | Cross-cutting concerns | Codified (§26) |
| 11 | User-visible diagnostic tools | Candidate methodology pattern |
| 12 | Documentation-first rule | Codified (§12) |
| 13 | Production + observability layer split | Candidate methodology pattern |
| 14 | Gate-blocking vs reviewable criteria | Codified (§4) |
| 15 | Acceptance-to-rigor mapping | Codified (§4) |

### 29.2 From v0.3 (seed document absorption)

| # | Refinement | Status in v0.3 |
|---|------------|----------------|
| 16 | Verdict vocabulary (CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED) | Codified (§7.3) |
| 17 | Confidence vocabulary (plausible / inferred / observed / verified) | Codified (§7.4) |
| 18 | Three-artifact-type discipline (plan, report, verdict) | Codified (§7.2) |
| 19 | Independence checking (α/β/γ) before evaluation | Codified (§7.5) |
| 20 | Forbidden phrases without verification | Codified (§7.6) |
| 21 | Verification plans precede work | Codified (§7.1) |
| 22 | Three-phase prompt shape (design / apply / decide) | Codified (§8.1, §10.2) |
| 23 | Audit-before-execution for broad tasks | Codified (§10.1) |
| 24 | Verbatim diffs, not summaries | Codified (§8.2) |
| 25 | Static analysis first, then dynamic | Codified (§9.1) |
| 26 | "What changed since the prior verdict?" pattern | Codified (§9.3) |
| 27 | Visual gate is irreplaceable | Codified (§9.7) |
| 28 | Orchestrator error patterns catalogue | Codified (§14) |
| 29 | Executor error patterns catalogue | Codified (§15) |
| 30 | Bug discovery discipline | Codified (§16) |
| 31 | Phase vs integration milestone separation | Codified (§18.1) |
| 32 | Blocker lists as operational unit | Codified (§18.2) |
| 33 | Numbered Q-items with OPEN/CLOSED/DEFERRED states | Codified (§19) |
| 34 | Mutually exclusive scope buckets | Codified (§20.2) |
| 35 | Three levels of verification (structural / behavioral / visual) | Codified (§21.1) |
| 36 | Commit message structure with type:scope | Codified (§22.1) |
| 37 | Closures must say so | Codified (§22.3) |
| 38 | "Build clean" as signal | Codified (§23.2) |
| 39 | Day-zero checklist | Codified (§27.1) |
| 40 | "When in doubt, slow down" meta-principle | Codified (§31.2) |

### 29.3 Candidate methodology patterns awaiting validation

The candidate methodology patterns from v0.2 (refinements 1, 2, 5, 6, 9, 11, 13) remain candidates. They will be validated during real project execution; those that prove useful in practice get promoted to active methodology patterns. Those that don't prove useful are either revised or dropped.

The methodology document and the methodology-tier pattern library evolve together.

---

## 30. Open questions and review gates

### 30.1 Open questions for v0.4

Questions that will be revisited after further project execution:

**Token budget calibration.** Are 30K–50K targets right? Should they vary by task type? Empirical data from calibration will inform.

**Task granularity.** Is per-file with per-routine checkpoints the right level? Should some subsystems use different granularity?

**Pattern library size.** When does meta-organization become necessary? How many entries before it becomes hard to navigate?

**Orchestrator autonomy after calibration.** The methodology specifies approve-by-task during calibration and approve-batched after. Is there a third level (approve-by-gate) for very stable projects?

**Cross-conversation state quality.** Is markdown state file sufficient? Should it be more structured?

**Methodology document size.** v0.3 is larger than v0.2. Is it too long for practical reference? Should there be a quick-reference companion?

**Candidate methodology pattern validation.** Six candidate patterns from v0.2 are noted. Which prove out during real execution? Which need revision?

**Cross-cutting concerns catalogue.** §26.3 lists concerns to consider per project. Is the catalogue complete? What's missing?

**Real-hardware verification scope.** §4 makes real-hardware verification gate-blocking when applicable. What's the full set of "when applicable"?

**Vocabulary unification check.** v0.3 merges two prior vocabularies (Orchestrator/Reviewer). Does any project's day-to-day usage reveal residual ambiguity?

**Seed-vs-v0.2 reconciliation review.** After first project execution under v0.3, audit whether any seed-specific or v0.2-specific discipline got lost in the merge.

### 30.2 Review gates for this methodology

- **Gate M.1 — First task complete.** Confirm the methodology works at the basic level: one task defined, executed, verified, integrated.
- **Gate M.2 — First file complete.** Confirm file-level acceptance works.
- **Gate M.3 — First subsystem complete.** Confirm subsystem-level acceptance works.
- **Gate M.4 — Calibration phase complete.** Transition to steady state. Methodology v0.4 may be drafted at this point.
- **Gate M.5 — First project complete.** Full retrospective on methodology effectiveness. Inputs to v0.4 (or later).

### 30.3 Methodology kill criteria

Conditions under which the methodology should be abandoned (in favor of unstructured work or a different methodology):

- Per-task overhead exceeds 30% of total task time consistently (the methodology costs more than it saves)
- Pattern library grows but isn't consulted (the institutional memory isn't being used)
- Failure modes that the methodology doesn't address become common
- Human gate involvement remains high after calibration (the methodology isn't reducing human load)
- Candidate methodology patterns don't validate (signals that the methodology's lessons aren't generalizable)

These are not expected to occur but should be monitored.

### 30.4 v0.4 candidate features

Features deferred from v0.3 that may appear in v0.4:

- Promoted methodology-tier patterns (those validated during real execution)
- Automated state file management (paired with claude-bridge maturity)
- Parallel task execution (orchestrator dispatches multiple tasks concurrently)
- Cross-project pattern library tooling
- Methodology metrics (time per task, pattern hit rates, escalation frequencies)
- Templates for common task types
- Integration with version control workflows
- Quick-reference companion document
- Structured state file (JSON or YAML rather than markdown)
- Worked-example appendices showing full task lifecycles end-to-end

---

## 31. Meta-notes

### 31.1 This document is itself a seed

Adapt it to project specifics. Add domain-specific reference docs (§17.2). Adjust phase counts and milestone definitions (§18). Refine test driver patterns to fit the platform (§21). The methodology (Parts III, V, VI) and conventions (Parts II, VI) are generic and apply as-is.

### 31.2 When in doubt, slow down

Most failures come from optimizing for forward motion at the expense of accuracy. The correct response to uncertainty is "more data," not "make a decision."

### 31.3 Audit your own outputs

Apply independence checks (§7.5) to your own outputs, not just to others'. The discipline is symmetric.

### 31.4 Patterns compound

The discipline patterns in this document compound over a project's lifecycle. A project that follows them from day one will move faster in the medium term, even at some cost in the very short term.

---

# Appendix A: Document conventions

This document follows the conventions used in other project design documents:

- Soft-wrapped markdown paragraphs (no hard wrap at 80 columns)
- Section numbers on all major divisions
- Numbered sub-sections within sections
- Code blocks for technical specifications, prompts, templates
- Explicit decision points and review gates
- "Documentation-first" discipline reflected in document structure

---

# Appendix B: Glossary

- **Orchestrator** — The Claude.ai conversation acting as project intelligence. Plans, verifies, packages context, drafts prompts, maintains state, curates pattern library. (Previously called "Reviewer" in the seed document — superseded.)
- **Executor** — The Claude Code (or equivalent) instance acting as task performer. Reads context, writes code, runs tests, reports.
- **Human gate** — The project owner, as final authority on the project.
- **Task** — The smallest unit of orchestrated work.
- **Acceptance criteria** — Explicit conditions for considering a task complete. Each criterion is either gate-blocking or reviewable.
- **Context bundle** — The materials provided to the executor for a specific task. Built on three pillars: contract, conventions, patterns.
- **Pattern library** — The collection of reusable patterns and idioms, organized in methodology-tier and project-specific tiers.
- **State file** — The persistent record of project state across conversations. `project-state.md`.
- **Calibration phase** — The initial period during which the methodology is tuned to the specific project.
- **Steady state** — Post-calibration operation with reduced human involvement.
- **Review gate** — A formal project milestone requiring human approval.
- **HAL contract** — The documented interface between application code and platform-specific code. One example of a contract; other contracts (API specs, internal interfaces) follow the same discipline.
- **DEV_MODE** — A build flag enabling development conveniences. One example of a mode flag.
- **Methodology version** — The version of this document a project is following.
- **Verification plan** — Pre-investigation document committing to predicted observations.
- **Verdict** — Post-investigation orchestrator judgment using vocabulary CONFIRMED / PARTIALLY CONFIRMED / NOT CONFIRMED.
- **Execution report** — Executor's structured output describing what was done.
- **Q-item** — A numbered open design question with lifecycle OPEN/CLOSED/DEFERRED.
- **D-item** — An in-task decision point requiring orchestrator approval; not the same as a Q-item.
- **Phase** (P1, P2, …) — Subsystem work tracker.
- **Integration milestone** (INT-1, INT-2, …) — Convergence-into-deliverable tracker.

---

# Appendix C: Document history

**v0.1** (May 10, 2026): Initial design of the Claude-Orchestrated Development Methodology. Not yet validated against real project execution.

**v0.2** (May 11, 2026): Incorporated 15 refinements derived from POP-coco3 architectural design phase. Added §5.0 (three-pillar task context structure), refined §4 (gate-blocking vs reviewable criteria, acceptance-to-rigor mapping, real-hardware verification), refined §5.3 (pattern selection logic with explicit rules), refined §7.4 and §7.5 (pre-population vs empirical discovery, pattern status semantics), added §9.5 (documentation-first rule), added §12 (cross-cutting concerns), added §13 (methodology refinements catalogue with six candidate methodology patterns awaiting empirical validation). v0.1 content preserved.

**v0.3** (May 21, 2026): Absorbed the Three-Role Collaboration seed document. The seed's discipline patterns — verdict vocabulary, prompt-generation shape, investigation methodology, orchestrator/executor error catalogues, repository/git/build conventions, day-zero checklist — are now codified as first-class sections (Parts III, V, VI, VII) rather than living in a separate document. Vocabulary unified: the seed's "Reviewer" role is one of the Orchestrator's disciplines, not a separate role; "Orchestrator" is canonical. POP-coco3-specific bindings from v0.2 §10 removed from this document; project-specific bindings live in each project's own design docs. Section numbering reorganized into eight Parts plus appendices. Refinements catalogue extended with 25 new entries from seed absorption.

End of methodology document v0.3.
