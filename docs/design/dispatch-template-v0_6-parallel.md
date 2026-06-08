> MIRROR — canonical lives in Cluade_methodology_store/templates/dispatch-template.md.
> Do NOT edit here. Edit canonical (operator-gated), then re-sync this copy.
> Re-sync lazily: whenever you next touch the template, pull canonical first.

# Dispatch Template (v0.6) — always-present additions + conditional parallelism annotations

**What this is:** the standard dispatch skeleton (§0–§10) we already use, plus **two always-present additions** (the §0 `(0)` C-35 receipt-stamp, and the candidate self-capture clause + its §8 report line / §7 presence check) and the **four conditional parallelism annotations**. The parallelism annotations are **conditional** — each fires only when a task has genuinely independent work, and is **absent** otherwise. The two always-present additions appear on **every** dispatch, serial or parallel; on a serial task they are the only delta from the pre-parallelism skeleton (the (a)/(b)/(c)/(d) annotations are absent).

**Design rule:** the orchestrator *marks* independence; **Clyde still decides whether to fan out** (M-L wording preserved — T-P2-015 showed the executor is the one who can see the real coupling). No new convention number. v0.6-compatible; use immediately.

---

## The marker legend (used in §3 only)

- `[leaf]` — this target's correct content does **not** depend on another target's final state. Parallelizable.
- `[join]` — consumes one or more `[leaf]` outputs; **runs after** them. Serial.
- `[contract]` — shared signature/type/constant/file that ≥2 leaves depend on. **Frozen before fan-out.**

Untagged = serial, reads exactly as today.

---

## Skeleton with the insertion points

```
§0  (0) C-35 RECEIPT STAMP — the LITERAL first command, ALWAYS present (serial or parallel).
      Requirement: the first thing Clyde runs emits a verbatim `t0=<ISO8601-UTC>` line to the
      terminal, paired with git-status, BEFORE reading code, grep, or anything else. t0 is then
      a captured artifact, not a remembered instant.
        bash / git-bash / WSL:  echo "t0=$(date -u +%FT%TZ)"; git status
        PowerShell:             Write-Output "t0=$((Get-Date).ToUniversalTime().ToString('o'))"; git status
      (Use whichever matches your shell — the deliverable is the `t0=` line, not the exact syntax.)
      The §8 C-35 block MUST quote this `t0=` line verbatim and compute elapsed as commit-time − t0.
      Rationale: a "stamp t0 at receipt" instruction placed later than the first command is
      structurally impossible to honor — binding it to the first action makes compliance visible.

      (a) C-13 pre-dispatch grep
      … existing grep targets …
      « (b) CONTRACT-FREEZE GATE — present ONLY when a [contract] has ≥2 [leaf] consumers: »
      « "Freeze the [contract] signatures/types/constants and the file-ownership map  »
      «  BEFORE fan-out. Parallel branches consume frozen contracts; they never redefine »
      «  them. Two branches inventing the same type is the silent-divergence failure mode." »

§1  Scope                              — unchanged
§2  Scope decisions confirmed (a/b/c)  — unchanged

§3  Deliverables (file targets)
      « (a) TAG each existing target line with [leaf] / [join] / [contract]. »
      « One token per line you're already writing — no graph, no prose. »
      e.g.
        - shared/src/oauth.ts                 [contract]   — schemas the branches consume
        - daemon/src/oauth/metadata.ts        [leaf]
        - daemon/src/oauth/register.ts        [leaf]
        - daemon/src/oauth/clients-store.ts   [leaf]
        - daemon/src/oauth/router.ts          [join]       — wires the leaves; runs after
        - daemon/src/main.ts                  [join]

§4  Acceptance criteria               — unchanged
§5  Verification steps                — unchanged
§6  Out of scope                      — unchanged

§7  Verdict-time evidence (C-25.1)
      … existing per-task fresh-evidence requirement …
      « C-35 PRESENCE CHECK: the verdict confirms the report quotes BOTH anchors — the `t0=` »
      « line from §0 AND the commit `%cI` — and that elapsed = %cI − t0 (not a hand-read stop). »
      « Both present ⇒ measured, feeds the band table. Either missing (or a separately-captured »
      « stop time used instead of %cI) ⇒ estimate-grade; log it flagged, do not promote. This »
      « turns a verdict-time reconstruction surprise into a binary report-time check. »
      « CAPTURE PRESENCE CHECK (habit, NOT a gate): the verdict confirms the §8 "Candidate(s) »
      « captured this task" line is PRESENT (slugs or "None"). Presence keeps the habit visible; »
      « a missing line is the signal the feeder may have silently gone quiet (the P3′ pattern). »
      « It is NOT gated — capture is fire-and-forget; "None" is valid; the verdict never blocks »
      « on capture count or push success. The check is presence-of-line, not exhaustiveness. »
      « (c) JOIN-VERIFICATION — present only when §3 has parallel leaves: »
      « "Per-branch fresh evidence per C-25.1, PLUS one serial post-join integration run. »
      «  The joins are where parallelism introduces bugs no single branch's evidence covers." »

§8  Reporting (Form B)
      … existing C-35 block (3 values) …
      « C-35 ANCHORING (always): elapsed is computed from TWO machine-stamped artifacts — »
      « never a hand-read stop. »
      «   START = the verbatim `t0=<ISO8601-UTC>` line QUOTED from §0's first command. »
      «   END   = the commit time `git show -s --format=%cI HEAD` — the authoritative »
      «          last-work moment. NEVER a separately-read/hand-captured stop time: a »
      «          hand-read stop is taken before the final steps (commit, log-write, push) »
      «          and systematically biases elapsed LOW. The commit time can't be read too »
      «          early — it doesn't exist until the commit. »
      «   elapsed = `%cI` − t0; the block reports both anchors + elapsed + C-14 class. »
      « An elapsed figure NOT anchored to BOTH (quoted `t0=` and the commit `%cI`) is »
      « ESTIMATE-GRADE: flag it, state the basis, and it does NOT harden the §5.2 band table »
      « (the 6/3 posture — honest estimate over fabricated number, never promoted as measured). »
      « (Chicken-and-egg note: the calibration-log row lands in the same commit, so compute »
      «  elapsed = %cI − t0 at commit time and write it; the sub-second compute→stamp gap is »
      «  noise. The fix is anchor-on-%cI, NOT 'stop the clock when I reach the log step'.) »
      « CANDIDATE(S) CAPTURED THIS TASK (always present): list the slug(s) written to »
      « seeds/<project>/live/ this task, with their filenames — or "None." This is the »
      « visibility surface that makes a capture omission catchable at verdict (it is exactly »
      « what the P3′ recon used to detect the paused feeder). Capture is fire-and-forget, so »
      « this line is REPORTED, never a gate. »
      … existing "User interaction" section …
      « (d) C-35 UNDER PARALLELISM — present only when Clyde fanned out: »
      « "elapsed = max-branch + join (NOT sum); add a one-line per-branch breakdown." »

CANDIDATE SELF-CAPTURE (always present, serial or parallel) — per convention-clause.md / v0.7 §3.6
      During the task, whenever a methodology candidate is identified (a recurring practice,
      convention, correction, or observation that might generalize), capture it IN THE SAME MOTION
      as noting it locally:
        1. Write a FRESH single-instance row: seeds/<this-project>/live/<iso8601>-<slug>.md,
           conforming to the pool SCHEMA (source: live, status: open, instance_count: 1, one
           instance_history element, initiator set faithfully — never guessed).
        2. Commit + push FIRE-AND-FORGET — non-blocking. A failed push does NOT block the task or
           gate the verdict; the local row is the durable record, the pool catches up next push.
        3. NEVER read/edit existing pool entries during a task — always a new live/ row (folding is
           the reconciler's read-time job).
      Capture at the FIRST instance, not the third (losslessness over cleanliness). "None" is a valid
      honest answer for a task that surfaced nothing.

§9  Commit (verdict-and-commit)       — unchanged
§10 Invariants & cautions             — unchanged
      (shared deps like deriveBaseUrl already live here; a [contract] tag in §3
       just makes that dependency explicit for the freeze gate)
```

---

## Serial vs parallel — the whole diff

**Always-present (independent of the (a)/(b)/(c)/(d) parallelism annotations):**
  (1) the §0 `(0)` C-35 receipt-stamp first command (~2 lines), and
  (2) the candidate self-capture clause + the §8 "Candidate(s) captured this task" report line
      + the §7 capture presence check.
Both appear on **every** dispatch, serial or parallel.

**Serial task** (most tasks; T-P3-002): none of the (a)/(b)/(c)/(d) parallelism annotations fires — no tags in §3, no §0 freeze-gate line, no §7 join line, no §8 parallel clause. The two always-present blocks above still appear. The "**zero added bytes**" claim applies to the (a)/(b)/(c)/(d) annotations **ONLY** — they are what's absent on a serial task.

**Parallel task** (T-P3-005-shaped): adds
- §3 — one `[leaf]`/`[join]`/`[contract]` token per target line (lines that already exist);
- §0 — one freeze-gate sentence (only if a `[contract]` has ≥2 consumers);
- §7 — one join-verification sentence;
- §8 — one C-35-under-parallelism clause.

**Total added on a parallel task: ~6 lines, every one load-bearing** (atop the two always-present blocks).

---

## What we deliberately did NOT add (honoring "not too much")

- No dependency-graph diagrams — the §3 tags *are* the graph.
- No separate "Parallelism" section — annotations layer onto sections that already exist.
- No new C-NN — (c) reuses C-25.1 and adds a serial-integration clause; nothing gets a number yet.
- No change to M-L's "executor decides shape" — orchestrator marks independence, Clyde chooses whether to actually fan out.

---

## Posture (v0.7)

The **dispatch mechanics** above are v0.6-compatible and in effect now. The **underlying principle** — parallel-sub-agent leverage for independent-file work (M-L) — stays a **v0.7 candidate** until a third real datapoint:

- M-L instances so far: T-P2-013, T-P2-014 (2). T-P2-015 non-use is itself data (coupled gate-close work).
- These annotations are the structural elaboration of M-L; they earn the 3rd datapoint by being *used*, not by being written.
- **T-P3-002 is not the pilot** — consent state machine / status / templates are too coupled (the state machine is the `[contract]` everything else consumes; it's mostly `[join]`).
- **T-P3-005 is the natural first fan-out** — its ~11 harness cases are largely independent `[leaf]`s over a frozen mock-extension `[contract]`. That's where this template gets its real test, and where the M-Q-style "did the hypothesis hold?" read on parallelism gets logged.

---

## Net effect

The dispatch got *smarter*, not *bigger*. Two always-present additions (C-35 receipt-stamp + candidate self-capture) carry the measurement-honesty and live-feeder discipline on every task; a serial dispatch adds nothing beyond those; a parallel one carries exactly the independence map, contract freeze, join check, and timing clause that parallelism actually requires — and nothing it doesn't.
