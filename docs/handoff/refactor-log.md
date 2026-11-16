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
| 0.3 | `ASSEMBLY-FIXES.md` moved from the repo root to `docs/history/P4-ASSEMBLY-FIXES.md` | A finished session note; nothing links to it. Docs-only, so the fast strict gate was run (green); the next full gate covers it too. Deleting `attend/admin/e2e.test.js` (attendance F9) is postponed: the attendance session asked that `attend/` stay untouched until its branch is merged | see `git log` |

## Phase 1: tooling

| Step | What | Why | Commit |
|---|---|---|---|
| 1.1 | `tools/quiz-maker-v2/tests/_shots/` is git-ignored and its 20 committed screenshots untracked (still on disk, still in history) | The browser tests rewrite them on every run, so every gate run left 15-18 changed files. Nothing reads or embeds them (`build_zip.py` already excluded the folder). Full gate green and the tree stays clean after a run | see `git log` |
| 1.2 | Pinned test dependencies: root `package.json` (private, dev only: jsdom 24.1.3) + `package-lock.json`; `requirements-dev.txt` (Playwright 1.64.1, Pillow 13.0.0). CI installs with `npm ci` and `pip install -r requirements-dev.txt`. `npm test` / `npm run test:all` wrap the gate. The new files are excluded from the published site (`_config.yml`); `node_modules/` is ignored | CI used to install whatever version was newest that day, so a dependency release could turn the gate red (or a compromised one could run in CI) with no code change. `npm ci` from the lockfile was proven in a clean folder, then the full gate ran green on an `npm ci` install. **Not yet run on GitHub Actions** (nothing is pushed) | see `git log` |
| 1.3 | `.editorconfig` (UTF-8, 2-space indent, 4 for Python: what the code already uses) and `.nvmrc` (Node 22, as in CI) | A new developer's editor and Node version match the project without asking. No whitespace rules, so no editor rewrites lines on save. Config only: fast strict gate green | see `git log` |

## Where it stands (2026-11-16, morning)

Phase 0 and the first part of Phase 1 are done: 7 commits after the handoff docs, all local, nothing pushed or
deployed, no change to backend or page behaviour. Next in the frozen order:

| Next | Needs |
|---|---|
| Push the branch and let GitHub Actions run once (first run of the pinned installs in CI) | the owner |
| Branch protection on `main` (the CI plan, stage 1) | the owner, GitHub settings |
| Phase 2: clasp, a staging Apps Script project with demo sheets, the `version` action | the owner signs in to Google for clasp and creates the staging project |
| Phase 1 remainder: ESLint with a baseline file, type checks through JSDoc | can be done unattended; deferred because a lint config for 8 `.gs` files sharing one global scope needs a reviewed list of globals first |
| Merge the attendance branch `claude/gracious-hertz-419012`, then `node scripts/gs_inventory.js --write` and update `backend-reference.md` | the owner decides the merge order |

## Notes and follow-ups found along the way

- Do not run anything else heavy while the gate runs on Windows: a polling loop made Git Bash run out of processes and
  one browser test (R-A08) failed with no checks run; alone it passed twice.
- ~~Browser tests dirty the tree with screenshots~~: fixed in step 1.1.
- Nine more browser tests (`e2e_R004_access_order.py`, `e2e_followup_walk.py`, `e2e_groups.py`,
  `e2e_lesson_video_lock.py`, `e2e_month_lessons.py`, `e2e_one_group.py`, `e2e_p3_bulk_access.py`,
  `e2e_p3_followup.py`, `e2e_student_summary_requirements.py`) have no catch-all route either. They were stable in the
  baseline; seal them if one ever times out on a page load.
