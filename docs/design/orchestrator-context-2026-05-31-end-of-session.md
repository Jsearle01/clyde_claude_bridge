# Orchestrator Context Snapshot — 2026-05-31 (end of session)

**Status:** Candidate-pool methodology-evolution system BUILT, PROVEN on a real v0.7 bump, and VERIFIED live across both high-value feeders. claude-bridge repo hygiene cleaned. P3 (OAuth) is mid-phase; T-P3-003 is the next feature task.

**Date work performed:** 2026-05-31 (snapshot labeled accordingly; some commits/pushes carry 2026-06-01 timestamps due to clock rollover near session end — the *work* was 5/31).

---

## Async-discipline streak: 70 consecutive zero-fires.

(Progression this session: 55 → 70. Every dispatch this session landed green with no async-discipline fire.)

---

## THE TWO TRACKS THIS SESSION

This session ran two parallel tracks. Keep them distinct — conflating them is exactly the error that produced a stale-snapshot confusion late in the session.

1. **Methodology-evolution infrastructure** (the candidate-pool system) — built/proven/verified end-to-end. This is methodology *tooling*, not claude-bridge feature work.
2. **claude-bridge P3 (OAuth)** — the actual product. Mid-phase (2 of 6 tasks). The pool work happened *alongside* P3, not as part of it.

---

## TRACK 1 — CANDIDATE-POOL SYSTEM (complete, proven, live)

### The three repos (all live on GitHub, structural firewall intact)
- **Pool (inbox):** `github.com/Jsearle01/methodology-candidate-pool`, local clone `C:\Projects\methodology-candidate-pool`. Pool-scoped fine-grained PAT (Contents R/W, that repo only) baked into clone via Option-B set-url for non-interactive push. **Head: `56f4042`.**
- **Methodology store (book):** `github.com/Jsearle01/Cluade_methodology_store` (note the "Cluade" typo IS the real remote name; local folder `C:\Projects\clude_methodogoly_store` has a different typo — harmless, only the remote matters). Holds canonical v0.6 AND v0.7. **Only Jay pushes here** (interactive account auth via browser; no automated write credential by design — the publish gate is a capability boundary, not a rule). **Head: `562b93a`.**
- **Feeders:** claude-bridge (verified live feeder), karateka (verified live feeder), attn-6309 + gimeai (halted at seed — no curated sets; optional future feeders).

### Architecture (all locked, all real — no stubs)
- **SCHEMA.md** — frozen entry format. Within-project identity = `project+slug` (NOT global; cross-project matching is the reconciler's semantic job). Per-instance `initiator` (executor/orchestrator/n-a/unknown) — load-bearing, separates same-observable candidates. `scope_judgment` (methodology/project-pattern/unsure, advisory). `parked_at_version` (project-local). **Four-folder lifecycle:** `seed/`+`live/` (ACTIVE) vs `incorporated/`+`closed/` (ARCHIVE, settled_in/settled_note). Faithful-never-fabricate (gaps=unknown, provenance_complete:false).
- **Firewall (structural, not conventional):** pool=inbox never book; pool credential structurally can't reach the methodology repo. Reconciler reads active pool folders + verbatim current methodology as base, drafts diff-with-rationale ([POOL] evidence-backed + [COHERENCE] clarity-only, NEVER new doctrine), STOPS, publishes nothing. Human publishes manually. Finalize moves settled candidates POST-publish, driven by what was ACTUALLY published. Doctrine brainstorming happens outside the reconciler, routes back as pool candidates.
- **Artifacts (all in pool repo, all real):** SCHEMA.md, README.md, seed-prompt.md, reconciler-prompt.md, finalize-prompt.md, convention-clause.md, ONBOARDING.md.

### What ran this session (all GREEN; pool head progression)
`9a9bafc`(setup) → `0c7069b`(CB-CAND-RECONCILE) → `1360600`/`f8f7b4d`(CB-SEED) → `088b1bc`/`1e0cd65`(CB-RESEED) → `de3e8ce`(KARATEKA-SEED) → `f05f048`(CB-CAND-ADD M-Y) → `c5ae663`(RECONCILE-V07 pass1 + 4 pool files) → `5906020`(FINALIZE-V07) → `abae8cd`(POOL-COMMIT clause+ONBOARDING) → `6ddf861`+`56f4042`(CB capture smoke test).

- **Seeded:** claude-bridge (21 entries incl. M-Y) + karateka (19). attn-6309 + gimeai HALTED (no curated candidate sets — correct M-J halts).
- **Schema** validated across two domains; revised once (added `scope_judgment` + `parked_at_version`) before other projects ran.
- **RECONCILE-V07 pass 1:** read 40 active entries, recommended honest NO-BUMP, but SURFACED 4 cross-project corroboration clusters (A: ground-truth validation; B: dynamic-evidence-when-static-stalls; C: structural-vs-human-gated claims; D: specify-report-format) and filed the re-scope as a Jay-level decision (refused to promote = would need new doctrine, above mandate).
- **Re-scope decision (Jay):** the methodology IS general ("that was the whole idea"). Chose LIGHT re-scope.
- **v0.7 base authored** (human doctrine, NOT reconciler): identity→general/claude-bridge-origin/karateka-corroborating-not-co-equal; preamble scope statement; §12.1 (pool/reconciler evolution mechanism, count-to-3 demoted to advisory, "pool is authoritative candidate record, no divergent local file, promotion uniform because all land in SCHEMA shape"); §14#7 updated; §15.7 changelog w/ labeled placeholder for reconciler promotions. §1–§11 rule bodies BYTE-IDENTICAL to v0.6 (verified). Methodology doc deliberately does NOT include the pool URL (couples general doc to deployment; URL lives at config layer + ONBOARDING).
- **RECONCILE-V07-PROMOTE pass 2:** promoted the 4 clusters as FORM (i) — corroboration annotations on existing rules (§3.5/§7/§10.4/§11.3) + §15.7 promotion entries. NO rule-content edits. Caught the asymmetry: only `verify-mechanism-before-describing-mechanism` is a pool candidate; A/C/D claude-bridge sides are already-codified doc rules.
- **v0.7 PUBLISHED** (Jay, manual push, `562b93a`): full publish + close c35. Both v0.6 and v0.7 canonical on disk; v0.7 current.
- **FINALIZE-V07** (`5906020`): moved 9 → incorporated/ (1 claude-bridge + 8 karateka, settled_in:v0.7) + `c35-estimate-grade-elapsed` → closed/. Active pool now: claude-bridge 19 + karateka 11 open.
- **Adoption:** convention-clause + ONBOARDING committed real (`abae8cd`). claude-bridge wired (CB-WIRE-CLAUSE, claude-bridge `d81f981`→ now `e6d747a`) + capture smoke test PROVEN (`6ddf861`+`56f4042`). karateka wired (KAR-WIRE-CLAUSE, karateka `7112b29`) + capture smoke test PROVEN (pool `0d04443`+`faafb1b`).

### THE FULL LOOP RAN END-TO-END: seed → reconcile → re-scope → promote → publish → finalize, and steady-state capture is wired + verified on both real feeders.

### M-Y (Form B self-assessment accuracy) — the system improved itself
The candidate the pool surfaced (numeric tallies must equal their lists; C-35 must classify honestly vs band) was applied across the session. **C-35 classified honestly NINE consecutive runs**, including the executor invoking M-Y BY NAME on a boundary case (CB-WIRE-CLAUSE, 22 vs 10-20 → over-band, refused to round). The fix demonstrably works.

---

## TRACK 2 — CLAUDE-BRIDGE P3 (OAuth) — mid-phase, the actual product

**Repo:** `github.com/Jsearle01/clyde_claude_bridge`, branch main. **HEAD: `e6d747a`** (after CB-HYGIENE).

**Phase progress:**
- P0 GATE-CLOSED (2026-05-23), P1 (2026-05-24), P2 (2026-05-30, snapshot `docs/snapshot/orchestrator-context-p2-close.md`).
- **P3 (OAuth) — MID-PHASE, 2 of 6:**
  - ✅ T-P3-001 — DCR + metadata endpoints (`0a23299`). `packages/daemon/src/oauth/` (clients-store, metadata, register, router) + `packages/shared/src/oauth.ts` + tests.
  - ✅ T-P3-002 — `/authorize` + consent state machine, pre-modal, extension auto-approve stub (`bd040a1`). +4 IPC consent messages in `packages/shared/src/ipc.ts`.
  - ⬜ **T-P3-003 — VS Code extension modal + real consent IPC handlers (request/ack/response/timeout). NEXT TASK.**
  - ⬜ T-P3-004 — `/token` + PKCE + dual-mode auth (Bearer + OAuth coexist; C-32 adjacent-invariant applies to any auth-layer touch).
  - ⬜ T-P3-005 — acceptance-harness OAuth extension + Windows/WSL parity (→ AC-P3-13).
  - ⬜ T-P3-006 — gate close + AC-P3-12 live-claude.ai smoke + close snapshot.

**AC-P3 status:** 13 ACs (11 HARNESS, 1 SMOKE=AC-P3-12, 1 X-PLAT=AC-P3-13). None formally verified yet — verification back-loaded into T-P3-005 (harness) and T-P3-006 (smoke+cross-platform). **Both gate-blocking ACs (12 live-smoke, 13 cross-platform) open.** Live smoke expected to surface 1-2 T-P3-006-followups (design-anticipated, not drift).

**Methodology in effect: v0.7.** `docs/design/claude-orchestrated-methodology-v0_7.md` present + committed; §3.6 convention clause wired (CB-WIRE-CLAUSE); §12.1 evolution mechanism in place. **claude-bridge is now a live feeder** but `seeds/claude-bridge/live/` is not yet created — no task has surfaced a live candidate yet (the seed transcription is in `seeds/claude-bridge/seed/`, ~19 entries). T-P3-003 (a substantive feature task) is a candidate to produce the first genuine live/ capture.

**Open candidates (project-state v0.7-candidates):** deferred-from-v0.6 (C-11, C-12, C-15, C-19, C-22) + M-series: M-Q (bootstrap-subsystem overhead, 2, hold), M-R (orchestrator-marked parallel split, 1, hold), M-X (mock-extension JSDoc, 1, likely project-level), M-Y (Form B self-assessment, 4 cross-project, hold). NOTE: these are now POOL-managed (in seeds/claude-bridge/seed/), not project-local count-to-3.

**Open defects / residuals:**
- C-27 (claude.ai connector UI OAuth-only) — the reason P3 exists; closes in T-P3-006 sweep.
- AC-24 residual operator smoke (R1/R2/R3a/R3b) for T-P2-008.7 session_bypass + T-P2-008.8 registration-retry — carried into P3, not yet captured/run.
- P4 backlog (deferred): per-workspace `.claude-bridge.json` policy schema; tool-surface expansion (`get_selection`, `get_git_state`, `get_terminal_output`, `get_search_results`, `show_diff`); `/revoke` wiring + trust-revocation UI; production deployment; multi-user; macOS; approval-timeout configurability; discriminated 403 workspace_untrusted.

**CB-HYGIENE this session (`e6d747a`):** committed the previously-untracked P3 design docs (`docs/design/04-p3-oauth.md` + `p3-build-plan.md`), relocated v0.3–v0.6 methodology files `docs/`→`docs/design/` as history-preserving renames, refreshed the stale project-state header (was "v0.6 / P1 closed / P2 design pending" → now v0.7 / P2-closed / P3-mid / T-P3-003-next). Body untouched.
- **Open micro-item:** `.vscode/settings.json` is untracked (excluded from CB-HYGIENE by explicit-path staging). Decide later: gitignore (if local-only) or commit (if team-shared). Not urgent.

---

## RESUME MECHANIC (next session)

1. **Read this snapshot** + the project files in `/mnt/project/` for architecture context. NOTE: the `/mnt/project/` files may still be the 2026-05-30 snapshot (stale: "P3 not yet opened"). **Repo HEAD `e6d747a` is ground truth, not the project-file snapshot.** If in doubt about claude-bridge state, ask Clyde for a read-only status report (the CB-STATUS-QUERY pattern worked well).
2. **Decide the track:** product work (P3) or more methodology tooling. They're separate.
3. **For P3 (the likely next move): open T-P3-003** — the VS Code extension consent modal + real consent IPC handlers. Per §1.1, open with a SCOPE CONVERSATION resolving: modal UX shape; ack/response/timeout IPC handler behavior; how the consent modal relates to the existing P2 approval-flow surface; timeout values (design mentions ~30s consent, ~2-3s ack). Then dispatch against resolved scope.
4. T-P3-003 is a substantive feature task → likely the FIRST live pool capture. Expect a real "Candidate(s) captured" line and the creation of `seeds/claude-bridge/live/`.

## CONVENTIONS IN EFFECT (carry forward)
- Single-prompt-with-everything dispatches; verdict-and-commit same cycle.
- C-13 pre-dispatch grep; C-35 mandatory elapsed block (3 values: estimate/predicted-band/C-14 classification, honest per M-Y); C-25.1 fresh tool-output evidence.
- Form B includes "User interaction during task" AND (now, v0.7) "Candidate(s) captured this task" line.
- Structured deliverables (dispatches/verdicts/design docs) as whole standalone files via present_files, NOT inline prose.
- M-J hard-stop guards: halt on scope CONTRADICTIONS, resolve minor discrepancies at-site (the `.vscode/` exclude was a correct application).
- No Greek-letter sub-labels (use a/b/c); "all confirm" or per-item override for batch decisions; read current date fresh each turn.
- Methodology store is CANONICAL; project copies (claude-bridge's docs/design/ v0.7) follow. Future methodology edits go through the pool→reconciler→publish loop, not authored directly in project copies.

## OPTIONAL / NON-BLOCKING (open across both tracks)
- attn-6309 / gimeai as live feeders (wire clause even without seed backlog — captures NEW candidates) — only if wanted.
- Conflated `d81f981` commit (v0.7 baseline + clause edits in one commit) — optional `git reset --soft` split for cleaner history. (Superseded somewhat by `e6d747a` hygiene; low value now.)
- Lightweight karateka report-template stub (it has no formal Form A/B template; inherits from v0.7 doc) — optional.
- `.vscode/settings.json` gitignore-or-commit decision.

---

**End of orchestrator context snapshot — 2026-05-31 (end of session).**
**Streak: 70. Pool head `56f4042`. Methodology store `562b93a` (v0.6+v0.7). claude-bridge `e6d747a` (P3 mid-phase, T-P3-003 next).**
