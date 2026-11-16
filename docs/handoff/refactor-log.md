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
| Gate | ALL GREEN: 149 active cases pass, 2 retired, nothing skipped |
| Live backend | Version 67 = commit `3b21e9d` (per `docs/attendance/decisions.md`; not re-checked) |

## Phase 0: safety net

| Step | What | Why | Commit |
|---|---|---|---|
| 0.1 | Browser tests R-E17 and R-019 no longer reach the real internet (`tests/_hermetic.py`, `seal(ctx, allow)`) | The first baseline run failed both: the page "load" event waited on Google Fonts / outside hosts and timed out. Each passed on a rerun, so they were flaky, not broken. A refactor guard cannot rest on a flaky test. After the fix: 3 of 3 runs green each, then the full gate green | see `git log` |

## Notes and follow-ups found along the way

- Running the browser tests rewrites 15 tracked screenshots in `tools/quiz-maker-v2/tests/_shots/` and adds 3 new
  ones, so every run leaves the tree dirty. Undo after a run with
  `git checkout -- tools/quiz-maker-v2/tests/_shots && git clean -f tools/quiz-maker-v2/tests/_shots`. Fix planned
  in Phase 1 (write screenshots to an ignored folder).
- Nine more browser tests (`e2e_R004_access_order.py`, `e2e_followup_walk.py`, `e2e_groups.py`,
  `e2e_lesson_video_lock.py`, `e2e_month_lessons.py`, `e2e_one_group.py`, `e2e_p3_bulk_access.py`,
  `e2e_p3_followup.py`, `e2e_student_summary_requirements.py`) have no catch-all route either. They were stable in the
  baseline; seal them if one ever times out on a page load.
