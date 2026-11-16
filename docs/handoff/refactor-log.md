# Refactor log

*The running record of the refactoring work. The plan itself (frozen 2026-11-16) is private:
`Docs/02-plans/active/engineering-handoff/REFACTORING-PLAN.md`. This page says what was done, in which commit, and how
to undo it. Newest step last. Every step is one commit; undo one with `git revert <commit>`.*

**Working agreement while unattended:** repo only (local commits on `claude/codebase-docs-refactor-5d2dea`, no push,
no Apps Script deploy); the full gate (`scripts/test_all.sh --strict --e2e --require-all`) green before and after each
step; no change to backend or student-facing behaviour.

## Baseline

| | |
|---|---|
| Tag | `pre-refactor` (the commit of step 0.1) |
| Gate | ALL GREEN at the tag: 149 active cases pass, 2 retired, nothing skipped. After step 0.2b: 151 active |
| Live backend | Version 67 = commit `3b21e9d` (per `docs/attendance/decisions.md`; not re-checked) |

## Phase 0: safety net

| Step | What | Why | Commit |
|---|---|---|---|
| 0.1 | Browser tests R-E17 and R-019 no longer reach the real internet (`tests/_hermetic.py`, `seal(ctx, allow)`) | The first baseline run failed both: the page "load" event waited on Google Fonts / outside hosts and timed out. Each passed on a rerun, so they were flaky, not broken. A refactor guard cannot rest on a flaky test. After the fix: 3 of 3 runs green each, then the full gate green | see `git log` |
| 0.2a | **Backend oracle** R-REF-1: `scripts/gs_inventory.js` records every top-level function and var of the 8 deployed `.gs` files (1,027 names, 849 functions) with a hash of each function's exact source text, in `tools/quiz-maker-v2/tests/fixtures/gs_inventory.json` | The guard for splitting `Code.gs` and every later backend step: a lost, added, changed or doubly-declared function fails the gate and is named; a pure move to another file passes. Proven both ways on the real files (a one-space edit was caught and named; a moved function passed). After a deliberate backend change: `node scripts/gs_inventory.js --write` | see `git log` |
| 0.2b | **Action guard** R-REF-2: `scripts/action_inventory.js` reads every routed action from the three routers (132: 88 in `Code.gs`, 18 follow-up, 26 attendance). The test fails if an action has no test at all, if a new action is tested only by the authorization lists (5 such actions today, recorded in `fixtures/action_baseline.json`; the list may only shrink), if `P4_ACTIONS` / `P3_STAFF_ALLOW` / `P4_ASSISTANT_DENY` name an action that does not exist, or if a new action is neither in `P4_ACTIONS` nor listed as teacher-denied on purpose | Guards the router and authorization refactor (Phase 4.1, 4.4): no action can be dropped, renamed or added silently. Proven: a fake untested action was caught by two checks and named | see `git log` |

## Notes and follow-ups found along the way

- Do not run anything else heavy while the gate runs on Windows: a polling loop made Git Bash run out of processes and
  one browser test (R-A08) failed with no checks run; alone it passed twice.
- Running the browser tests rewrites 15 tracked screenshots in `tools/quiz-maker-v2/tests/_shots/` and adds 3 new
  ones, so every run leaves the tree dirty. Undo after a run with
  `git checkout -- tools/quiz-maker-v2/tests/_shots && git clean -f tools/quiz-maker-v2/tests/_shots`. Fix planned
  in Phase 1 (write screenshots to an ignored folder).
- Nine more browser tests (`e2e_R004_access_order.py`, `e2e_followup_walk.py`, `e2e_groups.py`,
  `e2e_lesson_video_lock.py`, `e2e_month_lessons.py`, `e2e_one_group.py`, `e2e_p3_bulk_access.py`,
  `e2e_p3_followup.py`, `e2e_student_summary_requirements.py`) have no catch-all route either. They were stable in the
  baseline; seal them if one ever times out on a page load.
