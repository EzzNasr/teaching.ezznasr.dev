# Phase 2 rollout checklist (Session 5)

Ship order from the plan: **S1 alone first**, then S4, S3, S2 in parallel, S5 throughout.
Integration merge order: S1, S4, S3, S2 (section 4).

Commands run from the repo root (`teaching.ezznasr.dev/`) unless stated.

## 0. Before any session starts
- [ ] `docs/contract.md` read by S1-S4 (it is the only shared spec).
- [ ] Baseline green: `node scripts/run_registry.js` shows no FAIL (XFAIL on R-001..R-006, R-010 is expected).
- [ ] On your own machine: `node scripts/run_registry.js --e2e --only R-E` and report `R-E17`, `R-E19`, `R-E20`
      (they time out in the offline sandbox on the untouched repo, see REGRESSION.md).
- [ ] Take a copy of the live Google Sheet (File > Make a copy). Migration S1 also makes its own backup tabs.

## 1. Per session, before handing the zip over
- [ ] The session's own tests exist and pass; its registry entries are flipped `pending` -> `active` in `tests/registry.json`.
- [ ] `node scripts/run_registry.js` shows no FAIL and no XPASS.
- [ ] Only files the session owns are changed (contract section 1): `git status` and compare.
- [ ] Backend code is in its own `Phase2_<name>.gs` and has no top-level code (`test_phase2_core.js` checks this).
- [ ] If an `assets_templates/*.js` changed: synced copy in `assets/` shipped, drift check says "In sync."

## 2. Session 1 (hotfix) - deploy alone, same day
- [ ] Unzip, `node scripts/run_registry.js --strict --only R-00` (R-001, R-001b, R-002..R-006 pass).
- [ ] Apps Script: paste `Code.gs` and the new `Phase2_Core.gs` and `Phase2_Keys.gs`; **Deploy > Manage deployments > New version**.
- [ ] Commit + push; hard-refresh.
- [ ] Open the 3 lessons (L1, L2, L3), their quiz and assignment pages: no 404.
- [ ] Run `admin_migrate_lesson_keys` as a dry run, read the diff, then `dry_run:false`. Check the backup tabs exist.
- [ ] Open `access.html`: order is year, chapter, lesson.
- [ ] Redirect stubs at the 3 old URLs (plan 6) respond.

## 3. Feature flags (all default OFF; Script Properties)
| Flag | Turn on when |
|---|---|
| `FF_PARENT_LOG` | S2 shipped and the parent-log tab looks right |
| `FF_MONTHLY` | S2 shipped, one monthly review checked by hand against the summary |
| `FF_CAMERA` | S3 shipped, tested on a low-end Android and iOS Safari |
| `FF_DEFERRED_ANSWERS` | S3 shipped and `R-015` is active and green |
| `FF_GRADING` | S4 shipped and one photo graded end to end |
Turn one on, test, leave it on. Turning a flag off is the instant rollback for that feature.

## 4. Integration (S5)
1. Branch `phase2-integration` from the current `main`.
2. Merge S1, then S4, then S3, then S2. After each: `node scripts/run_registry.js --e2e`.
3. Read every `handoff/*.md`; each question has an `ANSWER:` or is closed.
4. `python tools/quiz-maker-v2/check_asset_drift.py` -> "In sync."
5. Only now write the two late registry entries: R-019 (RTL screenshots) and R-022 (audit coverage).
6. `python scripts/build_zip.py` (strict gate). If any session is not ready: `--interim`.

## 5. After deploy
- [ ] The three problem cases from the screenshots: one student with an old-key grant, Lamis's Ch2 row, a Senior 1 student: each shows what the teacher expects.
- [ ] The grant diagnostics panel (plan 6) answers "why is this locked" for Lamis in one look.
- [ ] Nothing in the Apps Script execution log with `Not implemented yet` (it means a `Phase2_*.gs` was not pasted).

## 6. Rollback
- Code.gs / Phase2: Apps Script > Deploy > Manage deployments > pick the previous version.
- Site files: `git revert` the merge commit.
- A feature: flip its flag off. Data: restore from the backup tab (`<tab>_backup_<date>`) written before the migration.

## 7. Open items still needing you (plan section 7)
1. Sheet export (Entitlements, Lessons, Videos, QuizAccess, Attendance, Groups, GroupSettings), phones masked: settles R-006 for Lamis.
2. Which lesson was Lamis's group's current lesson.
3. Grading tab: own page linked from `master.html` (default) or inside `followup.html`.
4. Senior 1 group assignment: screen (default) or mapping from you.
5. Photos in a Drive folder under your account, retention 6 months after the month closes (default yes).
6. Stray `grade-1-secondary/lesson-1-development-...` folder: keep until S1's audit says nothing references it (default).
