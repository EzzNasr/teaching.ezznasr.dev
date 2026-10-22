# Regression registry

Permanent, append-only. Machine-readable source: `tools/quiz-maker-v2/tests/registry.json`
(this table is generated from it; edit the JSON, not the table). Runner: `scripts/run_registry.js`.

## Rules

1. **Every change must pass the whole registry plus its own new cases.** Run `node scripts/run_registry.js`
   (add `--e2e` for the Playwright ones). A release uses `--strict`, which refuses any pending or
   TODO entry.
2. **IDs are never reused or renumbered.** A case is retired only by setting `"status": "retired"` with a
   written reason in `note` (and a line in the change log below). Never delete an entry.
3. **Statuses.** `active` must pass. `pending` is expected to fail until its owning session ships
   (the runner prints XFAIL); when it unexpectedly passes the runner prints XPASS and tells you to flip
   it to `active` so it becomes protected. An entry with no command yet is `TODO` and names the file
   that will hold it.
4. **A fix for a bug that reached students gets a new `R-` entry first**, written to fail, then the fix.
   That is how R-001 to R-006 came about (the Oct 18 folder rename).
5. Tests run the real `Code.gs` and every `Phase2_*.gs` in `tests/harness.js`, with a frozen clock
   (`load(path, {clock:true})`, `env.setNow(iso)`). They cannot measure real Google timings or Drive quotas.
6. Existing tests keep their files and arguments. They are listed as **R-E01 to R-E22**, one per file.

Count note: the rollout plan said 19 Node + 7 e2e. The repo at `d2bef69` has **16** `test_*.js` and
**6** `e2e_*.py` (plus `e2e_backend.js`, which is the stand-in server, not a test). The registry follows the
repo, so R-E23 to R-E26 are reserved and unused.

## Baseline recorded by Session 5 (HEAD `d2bef69`, before any Phase 2 code)

- All 16 Node tests pass (22 / 24 / 14 / 63 / 97 / 80 / 28 / 56 / 16 / 25 / 112 / 133 / 17 / 123 / 132 / 38 checks).
- `check_asset_drift.py`: In sync.
- e2e: `e2e_groups`, `e2e_lesson_video_lock`, `e2e_followup` pass. `e2e_video`, `e2e_dashboard` (1 check) and
  `e2e_step4b` time out waiting for page elements in the offline delivery sandbox, and do so identically on
  the untouched HEAD, so they are **not** caused by Phase 2. Please run them once on your own machine and
  tell Session 5 the result.
- The static lesson-page check finds exactly the 3 renamed lessons (18 failing checks over 9 pages) and nothing
  else, which confirms plan 1.1.

## The registry

| ID | Case | Status | Test |
|---|---|---|---|
| R-E01 | login, reset, lockouts, full-grid writes | active | `tests/test_accounts_and_sheets.js` |
| R-E02 | uploads: lock scope, races, busy lock, clean-up | active | `tests/test_item6.js` |
| R-E03 | quiz.js / assign.js retry behaviour | active | `tests/test_client_post.js` |
| R-E04 | video lock: who sees a URL, toggle, fail-closed, cache | active | `tests/test_videos.js` |
| R-E05 | payments: I-paid requests, approvals, entitlements, expiry, scopes | active | `tests/test_access.js` |
| R-E06 | revoking access, cancelled payments, access-dashboard overview | active | `tests/test_revoke.js` |
| R-E07 | locking/unlocking a quiz itself | active | `tests/test_quiz_gate.js` |
| R-E08 | student groups: membership, bulk grant/revoke | active | `tests/test_groups.js` |
| R-E09 | one active session per account | active | `tests/test_single_session.js` |
| R-E10 | quiz access override rows | active | `tests/test_quiz_access_override.js` |
| R-E11 | chapter/term subscriptions and the paywall | active | `tests/test_subscriptions.js` |
| R-E12 | follow-up backend: overview facts, attendance, group + template saves, record_watch | active | `tests/test_followup.js` |
| R-E13 | real overview output vs followup-logic.js data shape | active | `tests/test_followup_contract.js` |
| R-E14 | follow-up status rules + Cairo deadlines (pure) | active | `tests/test_followup_logic.js` |
| R-E15 | message rendering: placeholders, bidi, WhatsApp, 1200-char cap | active | `tests/test_followup_templates.js` |
| R-E16 | video.js watch-coverage tracker | active | `tests/test_watch_tracker.js` |
| R-E17 | locked-video box on a lesson page | active | `tests/e2e_video.py` |
| R-E18 | roster picker on the Groups tab | active | `tests/e2e_groups.py` |
| R-E19 | video-access admin dashboard | active | `tests/e2e_dashboard.py` |
| R-E20 | quiz gate on the quiz page + Quiz-gate/Groups tabs | active | `tests/e2e_step4b.py` |
| R-E21 | Lessons tab per-video open/lock | active | `tests/e2e_lesson_video_lock.py` |
| R-E22 | follow-up page: layouts, verdicts, message sheet, dark mode | active | `tests/e2e_followup.py` |
| R-001 | Every lesson folder: canonical, og:url, JSON-LD url, data-lesson, quiz lesson equal the folder's own name | active | `tests/test_lesson_pages.js` |
| R-001b | lesson-aliases.json and Phase2_Keys.gs agree; the 3 renames are mapped | active | `tests/test_R001b_alias_sync.js` |
| R-002 | Quiz and homework pages of every lesson load (static: all internal links resolve) | active | `tests/test_lesson_pages.js` |
| R-003 | Old-key and typo'd-key grants still unlock the lesson under the new key | active | `tests/test_R003_R005_R006_rename_incident.js` |
| R-004 | access.html order is year, chapter, lesson number; no duplicate group per lesson | active | `tests/e2e_R004_access_order.py` |
| R-005 | Quiz/homework under an old bare slug show as done on the follow-up page | active | `tests/test_R003_R005_R006_rename_incident.js` |
| R-006 | Entitled student for the current lesson never shows video locked | active | `tests/test_R003_R005_R006_rename_incident.js` |
| R-007 | Senior 1 with zero groups: empty state + assign action, never a blank select | active | `tests/e2e_p2_followup.py` |
| R-008 | Switching year clears or confirms a current lesson from the other year | active | (runs with R-007) |
| R-009 | Quiz-required and homework-required are independent; optional never counts as missed | active | `tests/test_p2_followup.js` |
| R-010 | Center attendance: current lesson only; expires at week end; undo removes only its rows | active | `tests/test_R010_center_week.js` |
| R-011 | Student summary equals raw QuizResults and Submissions for the range | active | (runs with R-009) |
| R-012 | Monthly review totals equal the summary for the same range | active | (runs with R-009) |
| R-013 | Parent notification log: create, edit, filter not-notified, persists | active | (runs with R-009) |
| R-014 | Camera capture, file fallback, upload retry, draft survives reload | active | `tests/test_capture.js` (backend), R-014b `tests/test_capture_client.js`, R-014e `tests/e2e_capture.py` (browser) |
| R-015 | Server never returns correct answers before submission (direct call) | active | `tests/test_R015_R016_review.js` |
| R-016 | After submit: all questions correct vs wrong; written ones pending grading | active | (runs with R-015) |
| R-017 | Grading updates score, correct/wrong list and average; regrade idempotent | active | `tests/test_grading.js` |
| R-018 | A student cannot fetch another student's image | active | `tests/test_grading.js` |
| R-019 | Arabic RTL intact on follow-up, summary, review, grading pages (screenshots) | pending S5 | (to write) `tests/e2e_R019_rtl.py` |
| R-020 | Migrations: dry-run changes nothing; twice equals once; backup tab exists | active | `tests/test_keys.js` |
| R-021 | check_asset_drift.py reports In sync | active | `check_asset_drift.py` |
| R-022 | Audit log records grants, revokes, center decisions, grading changes | pending S5 | (to write) `tests/test_R022_audit_coverage.js` |
| R-P01 | Phase 2 plumbing: router hook, flags, audit helper, test clock, .gs hygiene | active | `tests/test_phase2_core.js` |
| R-P02 | Phase 2 contract conformance (auth, flags, shapes) for every handler that exists | active | `tests/test_phase2_contract.js` |
| R-001c | check_lesson_paths.py: every lesson folder is self-consistent (S1 generator-side guard) | active | `check_lesson_paths.py` |
| R-I01 | Integration seams S1+S4+S5: contract migrate shape, one AuditLog header, session-auth grading queue, flags, header contract | active | `tests/test_integration_s1_s4.js` |
| R-S4a | Quiz Maker: model answers never reach the public quiz JSON; merge restores them on reopen | active | `tests/test_written_authoring.py` |
| R-F01 | S2 follow-up status logic (required vs optional, deadlines, year, center week) | active | `tests/test_p2_followup_logic.js` |
| R-F02 | S2 message templates (monthly review text, parent log wording, RTL, WhatsApp limits) | active | `tests/test_p2_followup_templates.js` |
| R-I02 | Integration seams S2: router wiring, fallback if not pasted, flags, shared AuditLog, admin-session identity, canonical keys | active | `tests/test_integration_s2.js` |

## Change log

- v1.1 (integration 1, 2026-10-21): R-001..R-006, R-001b, R-017, R-018, R-020 now active; R-001c, R-I01, R-S4a added. R-E17/E19/E20 fail identically on the original repo in the sandbox (known, not Phase 2).
- v1 (Session 5): first publication; R-E01..R-E22 imported unchanged; R-001..R-022 from rollout plan v2; R-001b, R-P01, R-P02 added.
- Integration 2 (S2): R-007..R-013 and R-010 active; R-F01, R-F02 (S2 logic and templates) and R-I02 (S2 seams) added. R-014..R-016 (S3), R-019 (grading + review pages) and R-022 (cross-feature audit) are still to write.
