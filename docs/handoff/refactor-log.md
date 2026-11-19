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
| Live backend | Version 67 = commit `3b21e9d` at the start (per `docs/attendance/decisions.md`). Checked with clasp on 2026-11-16 (step 2.1): live was Version 69, file for file equal to `32436a7` |

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

## Phase 2: scripted deploy (slimmed, 2026-11-16)

Agreed with the owner: the staging project (old step 2.2) moves to the start of Phase 3. Phase 2 is clasp against the
production project, one endpoint config, the `version` action and a deploy script. **Rule: `clasp push` only as part of
a deploy**, because time-driven and installable triggers run the latest saved code, not the deployed version: a push
between deploys would change the live reminders and the message queue at once. Demo data in the live sheet
(`att_seedDemo` / `att_clearDemo`) stays the way to look at screens after a deploy.

| Step | What | Why | Commit |
|---|---|---|---|
| 2.0 | `@google/clasp` 3.4.1 pinned as a dev dependency (`npx clasp ...`); `.clasprc.json` git-ignored | One known clasp version for everyone. Its sign-in token lives in the home folder, never in the repo. `npm audit` lists 8 advisories (6 moderate, 2 high) in clasp's own dependencies: a local developer tool, not shipped and not run in CI (installed with `--ignore-scripts`); revisit on the next clasp release | see `git log` |
| 2.1 | **Live code compared with the repo**, read only: `clasp clone` of the TeachingSite project into a scratch folder outside the repo, `clasp pull --versionNumber 69` for the live web-app version, each file compared with line endings normalised | The proof the paste deploys never gave. Result on 2026-11-16: the web-app deployment the site calls is at **Version 69**; its 8 files equal the repo at `32436a7` file for file, and the editor's saved code equals Version 69 (so the triggers run the same code). `main` is **ahead of live**: the attendance commits `6288a32`, `752efb2`, `43880ad` change `AttendanceAll.gs` and are not deployed yet. A second project, "Attendance", has only a HEAD deployment and no web app (not used by the site). No `.clasp.json` committed yet: it comes with the deploy script | (no code change; recorded with the merge below) |
| 2.3 | **Deferred to Phase 3** (with the staging project). One `assets/config.js` mattered for pointing pages at staging; with one fixed deployment id the URL never changes. Checked: the shared engines already get the URL from one place (`{{DRIVE_ENDPOINT}}` in `assets_templates/`, filled by "Sync site assets"); the other copies are `contract/att_config.js` and `ATT_DEFAULT_WEBAPP_URL` (attendance, left to that session). R-DEP-1 checks that `deploy.json`'s deployment id is the one the site calls | No value until staging exists | (none) |
| 2.4 | **Version in the health check:** `doGet` returns `version` = `APP_VERSION` from a `Version.gs` that only the deploy script generates (commit, time, branch; `null` for a hand-pasted deploy). A GET field, not a new action: no router or permission-table change. `smoke_live.js` prints the live commit and, with `--expect-commit <sha>`, fails unless it matches; the GET is tried 3 times (the first connection timed out once on this network) | Proves which commit is live. R-REF-1 snapshot rewritten for the one changed function (`doGet`) | see `git log` |
| 2.5 | **Deploy script** `scripts/deploy_backend.js` (`npm run deploy:backend`, dry run unless `--yes`) with `apps_script/deploy.json` (script id, the web-app deployment id, the editor's file names and order) and `apps_script/appsscript.json` (the live manifest, copied as is). Steps and stop rules in `docs/runbooks/backend-deploy.md`; each deploy appends a row to `docs/runbooks/backend-deploys.md`. Test R-DEP-1 (34 checks, every command faked) proved it can fail: two deliberate breaks (drift not stopping, rollback to the wrong version) were caught | Replaces copy and paste: one command, live compared first, same URL, smoke after, automatic rollback. **Not yet run for real**: the first deploy is the pending attendance release, done with the owner | see `git log` |
| 2.5b | **Quiz Maker "Deploy backend" menu** next to "Run tests": *Check only* (dry run) and *Deploy backend to live* (asks in the app, then the terminal window needs `DEPLOY` typed). `modules/deploy_runner.py` opens a terminal running the deploy script, like `test_runner.py`. Test R-DEP-2 (12 checks, nothing really runs) | The owner deploys from the app he already uses | see `git log` |
| fix | Removed `programming/baccalaureate/grade-2-secondary/chapter-2-general-exam/` (only `base.css` and `forms.css`, no lesson page, nothing linked to it; came in with `87f3f6d` on `main`). It failed R-G01 on `main` and on this branch. The owner will create that lesson properly with the Quiz Maker. Fast strict gate ALL GREEN after | Owner decision, 2026-11-16 | see `git log` |
| 2.6 | **First scripted deploy: Version 70 = `1b53af0`** (2026-11-16 13:33 Cairo, with the owner). It ships the attendance work D15-D21 (`6288a32`, `752efb2`, `43880ad`) and the version stamp. The first try stopped twice, live safe both times: (1) the Apps Script API was off on the account (push refused; the owner switched it on); (2) after a successful push, `clasp create-version` ran from the repo root and failed ("Project settings not found"), leaving the saved code new and the web app on Version 69 for about two minutes. Fixed in `1b53af0`: those steps run in the push folder and any failure after the push rolls back; R-DEP-1 now fakes that clasp rule (proven: the old script fails it). The re-run used `--allow-drift` for its own half-finished push. Checked after: every live file of Version 70 equals the repo, saved code = Version 70, smoke 14 of 14 incl. "health check names 1b53af0", probes `check_session`, `report_photos`, `att_login`, `att_extend_session` answer as expected. Deployed from this branch (`--allow-branch`, `--skip-gate`: the only red test is R-G01, a site lesson list from `main`) | Rollback: Version 69 (`32436a7`): `git checkout 32436a7`, then the deploy script with `--allow-branch` | `docs/runbooks/backend-deploys.md` |
| merge | `main` merged into this branch (brings in the attendance work above and two page commits). R-REF-1 flagged only attendance names (8 added, 21 changed, all `att_*` / `ATT_*`): recorded with `node scripts/gs_inventory.js --write` (now 1,035 names). R-REF-2 floor raised to 133 actions (27 attendance) for the new attendance action. Full gate after the merge: 151 pass, 2 fail. **R-G01 is inherited from `main`** (red there since `87f3f6d`/`e5057bb`): `programming/baccalaureate/grade-2-secondary/chapter-2-general-exam/` holds only `base.css` and `forms.css`, no lesson page, so the grade page does not list it; the owner decides (finish the lesson or remove the folder). R-REQ4 timed out once under load and passed 3 of 3 alone (a race after an async save; noted below) | Keeps the pull request current. The backend files on this branch now equal `main` exactly | see `git log` |

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
- R-REQ4 (`e2e_requirements.py`) timed out once in the full gate (2026-11-16, after the merge) waiting for the new manual requirement card; it already blocks outside requests and passed 3 of 3 alone. Likely a re-render from the previous async save landing mid-step. Watch it; if it recurs, wait for the save to finish before the next step.
