# Calibration log

Per methodology v0.4 §3.5.1 timing block and Appendix D. Captures predicted-bucket vs actual-Clyde-time for each task. Bands evolve as data accumulates; refinements get noted inline.

P0 timing data lives in `project-state.md` § "Final P0 calibration summary" and Appendix D of `claude-orchestrated-methodology-v0_4.md`. This log starts at P1.

## P1

| Task | Phase | Predicted bucket | Predicted range | Actual | Variance vs midpoint | Notes |
|---|---|---|---|---|---|---|
| T-P1-001 | Phase 1 — shared types | Small | 30-60 min | 0:07 | -84% | Came in well under band. Five files: 3 new schema modules + config extension + index re-exports. 50 new tests. Established Zod-schema + test pattern from P0 carried over cleanly; no discovery surface. Confirms a "Small-consolidation" sub-bucket may exist — Small tasks that purely apply existing patterns without new design surface run closer to trivial speeds (parallel to v0.4's "Medium-consolidation" finding from T-0020). Flag for repeat-observation before codifying. |
| T-P1-001.5 | Infrastructure (insert) | Small | 30-60 min | TBD (filled at end) | TBD | Doc placement + git push to github.com. Bucket revised upward from original Trivial+setup after T-P1-001 verdict added file-placement scope. Doc-only; no async-discipline streak impact. Bundles T-P1-001's uncommitted source work per §14.7 user-decision. |
