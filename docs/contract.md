# Phase 2 shared contract (v1, published by Session 5)

Everything here is binding for S1-S4. If you need something that is not here, write
`handoff/Sx-to-Sy.md` (see 9); do not edit another session's files.
Changes to this file are made only by S5, and each one gets a line in section 10.

## 1. Files and ownership

| Session | Owns (edits freely) | Backend file |
|---|---|---|
| S1 | the 6 grade-2 lesson folders, grade-2 index, sitemap, lesson-titles.json, generator names, `dashboard/access.html`, `migrations/001_*` | `Phase2_Keys.gs` |
| S2 | `assets/followup-*.js`, `followup.css`, `dashboard/followup.html`, `dashboard/student-summary.html` | `Phase2_Followup.gs` |
| S3 | `assets_templates/quiz.js, assign.js, common.js` (+ synced `assets/*.js`); the one-line `capture.js` entries in `check_asset_drift.py` and `modules/common.py`, `templates/quiz.html, assignment.html`, `forms.css`, `capture.js`, `dashboard/student.html`, `assets/dash-review.js` | `Phase2_Capture.gs` |
| S4 | `app_main.py` grading tab, `modules/quiz_tab.py`, `dashboard/grading.html` | `Phase2_Grading.gs` |
| S5 | `tests/**` (new files only), `tests/harness.js`, `docs/**`, `scripts/**`, `Phase2_Core.gs`, the `doPost` Phase 2 `case` lines | `Phase2_Core.gs` |

`Code.gs` (4,800+ lines, the biggest merge-collision risk) has two kinds of edits and no others:
- **S5** edits only the block of Phase 2 `case` lines in `doPost` and the one `err.disabled` line in its
  `catch`. Already done in v1, so S1-S4 never touch the router.
- **S1** may edit the bodies of exactly the functions that compare lesson keys, so that they resolve aliases
  through `p2k_*`: `_scopeCovers`, `_lockIndex`, `_entitlementCovers`, and the quiz/homework join
  (`slugOfCell` and its callers) plus the matching of QuizAccess, Attendance and WatchProgress rows.
  Keep each change to a call into `p2k_*` (no new logic inline) so the diff stays small and reviewable.
  This follows the rollout plan, S1 item 2.
S2, S3 and S4 never edit `Code.gs`. If one of them needs something inside it, write
`handoff/Sx-to-S5.md` with the exact patch and S5 applies it during integration.

Backend rules for every `Phase2_*.gs` file:
- Only function declarations and `var P2_* = ...` constants at top level. No top-level code
  that runs, no dependence on file load order (Apps Script orders files by the editor).
- Every global name starts with `p2_`, `_p2` or `P2_`, plus the file's own tag
  (`p2k_` keys, `p2f_` follow-up, `p2c_` capture, `p2g_` grading). A test fails the build on a
  duplicate global name across `.gs` files.
- No edits to existing sheet tabs' column order. New columns are appended at the right, and
  readers find columns by header name.

## 2. Canonical lesson key

The key is the folder path relative to the site root, no leading or trailing slash:
`programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry`.
Pages derive it from their own folder, never from a hand-typed copy. The bare slug is the last
path segment.

Provider: S1, in `Phase2_Keys.gs`:
- `p2k_canon(key)` returns the canonical full key for any full key or bare slug that is in
  the alias map; any other string is returned unchanged (trimmed, lower-case not applied).
- `p2k_aliases(key)` returns an array of every spelling that means this lesson, canonical first.
- `p2k_same(a, b)` is `p2k_canon(a) === p2k_canon(b)`.
- Alias data lives in `assets/lesson-aliases.json` and is mirrored in `Phase2_Keys.gs` as
  `P2_LESSON_ALIASES`. A test (R-001b) fails if the two differ.
All other sessions call these and never keep a private alias list. History in `QuizResults`
and `Submissions` is read through `p2k_*`, never rewritten.

## 3. Sheets (Google Sheets tabs)

Existing tabs are listed in the rollout plan 3.2. New tabs, created lazily by the owning
session's code on first write (a missing tab reads as empty). Row 1 is the header, in this
exact order, so tests can seed them:

| Tab | Owner | Columns |
|---|---|---|
| `LessonRequirements` | S2 | `lesson, quiz_required, homework_required, due_override, updated_at, updated_by` |
| `WrittenAnswers` | S3 writes, S4 grades | `submission_id, student_id, lesson, question_id, drive_file_id, awarded, max, note, graded_at, kind, graded_by, uploaded_at` (S4 creates the first nine, adds `kind` and `graded_by`; S3 appends `uploaded_at`. `student_id` is the existing sheet convention, same as QuizResults. `kind` is `quiz` or `homework`, blank = quiz. `submission_id` is the attempt's `dedupe_key`.) |
| `ParentNotifications` | S2 | `student, kind, ref, sent_at, by, note` (no `id`: one row per `(student, kind, ref)`; logging the same triple again edits it) |
| `MonthlyReviews` | S2 | `student, month, status, sent_at, note` |
| `AuditLog` | S5 helper, all sessions write | `at, who, action, target, before, after` |

Rules: `student` is the normalized phone number used everywhere else. `lesson` is always a
canonical key. Booleans are `TRUE`/`FALSE`. Timestamps are ISO strings with the Cairo offset
produced by the existing `_cairoIso`. `month` is `YYYY-MM`. `kind` is one of `quiz`,
`homework`, `monthly`, `custom`. `status` (MonthlyReviews) is `draft`, `sent`, `closed`.

## 4. Backend actions

The router in `Code.gs` has one `case` per action below. Each calls
`_p2Call("<handler>", payload)` (in `Phase2_Core.gs`), which finds a global function and
calls it. If the owning file is not pasted yet the answer is
`{ok:false, error:"Not implemented yet: <action>", not_implemented:true}`. Handler names are
`p2_<action>`:

| Action | Handler (owner) | Auth | Flag |
|---|---|---|---|
| `admin_followup_overview` (existing action) | `p2_admin_followup_overview` (S2) | admin | none; routed with `_p2CallOr`, so the old handler answers until the file is pasted |
| `admin_followup_set_attendance` (existing action) | `p2_admin_followup_set_attendance` (S2) | admin | none; same fallback. Adds the weekly center rule: center access lapses on that Cairo week's Friday; a request with 2+ center students needs `week_confirm` = that week's Saturday (`YYYY-MM-DD`) |
| `admin_student_summary` | `p2_admin_student_summary` (S2) | admin | none |
| `admin_monthly_review` | `p2_admin_monthly_review` (S2) | admin | `FF_MONTHLY` |
| `admin_set_requirement` | `p2_admin_set_requirement` (S2) | admin | none |
| `admin_log_parent_notification` | `p2_admin_log_parent_notification` (S2) | admin | `FF_PARENT_LOG` |
| `admin_list_parent_notifications` | `p2_admin_list_parent_notifications` (S2) | admin | `FF_PARENT_LOG` |
| `upload_written_image` | `p2_upload_written_image` (S3) | student session | `FF_CAMERA` |
| `get_quiz_review` | `p2_get_quiz_review` (S3) | student session | `FF_DEFERRED_ANSWERS` |
| `admin_grading_queue` | `p2_admin_grading_queue` (S4) | admin | `FF_GRADING` |
| `admin_grade_written` | `p2_admin_grade_written` (S4) | admin | `FF_GRADING` |
| `admin_migrate_lesson_keys` | `p2_admin_migrate_lesson_keys` (S1) | admin | none (dry-run default) |
| `admin_set_written_models` | `p2_admin_set_written_models` (S4) | admin | none (authoring) |
| `admin_get_written_models` | `p2_admin_get_written_models` (S4) | admin | none (authoring) |
| `get_written_image` | `p2_get_written_image` (S4) | admin, or the owning student session | none |

Auth: admin handlers start with `_requireAdminAny(payload)`; student handlers start with
`_requireStudentSession(payload)` and use `payload.student_id` as the identity, never a
client-supplied student field. A student handler must refuse any request about another student.

**Identity fields (v1.3).** With a session, `student_id` and `session_token` are the CALLER, and the
site's `AuthEngine.adminCall` overwrites `student_id` with the signed-in admin on every admin call. An admin
action that is ABOUT a student therefore must name that student in a different field, `student`
(a phone). No admin handler may read `student_id` as its target or filter. Student handlers do the
opposite: `student_id` is the caller and the only student they may act for. (S4's first cut filtered the
grading queue on `student_id`, which showed an empty queue under a real login; test
`test_integration_s1_s4.js` guards it.)

Flags: `p2_flag(name)` in `Phase2_Core.gs`. Script Property `FF_X` set to `1` or `true` turns
it on, anything else (or absent) is off. A handler whose flag is off answers
`{ok:false, error:"Feature disabled: FF_X", disabled:true}` by calling
`p2_requireFlag("FF_X")` first. Client code must treat `disabled:true` as "feature absent",
not as an error to show.

Response shape for every Phase 2 action: `{ok:true, ...fields}` or `{ok:false, error:"..."}`.
Never throw a bare string; throw `new Error(msg)`. Lock-busy errors set `retryable:true`
(the existing `_withLock` already does).
Field names are snake_case. Lists are arrays, never objects keyed by id.

Request/response fields (the minimum; owners may add optional fields, never rename these):

- `admin_student_summary` in `{student, from?, to?}` (dates `YYYY-MM-DD`, Cairo) out
  `{ok, student, name, year, quizzes:[{lesson, score, total, at}], quiz_average, homework:{submitted, missed, items:[{lesson, status, at}]}, written:{pending, graded}, attendance:[{lesson, mode, at}], video_access:[{lesson, can_watch}], parent_notifications:[...]}`
- `admin_monthly_review` in `{student?, group?, month}` out `{ok, month, reviews:[{student, name, totals, text_ar, status}]}` where `totals` equals the summary totals for the month (R-012).
- `admin_set_requirement` in `{lesson, quiz_required?, homework_required?, due_override?}` out `{ok, requirement}`
- `admin_log_parent_notification` in `{student, kind, ref?, note?, sent_at?}` out `{ok, created, notification}`; the same `(student, kind, ref)` again edits the row and keeps its `sent_at`. `kind` is `quiz`, `homework` (ref = lesson key), `monthly` (ref = `YYYY-MM`) or `custom`.
- `admin_list_parent_notifications` in `{student?, kind?, not_notified?:true}` out `{ok, items:[...]}`
- `upload_written_image` in `{lesson, question_id, image_base64, mime, submission_id?}` out `{ok, drive_file_id, uploaded_at}`; max decoded size 3 MB; at most 20 uploads per student per hour (`{ok:false, error:"Too many uploads", retryable:true}`).
- `get_quiz_review` in `{lesson}` out `{ok, submitted:true, items:[{id, type, correct:true|false|null, pending:true|false, your_answer, correct_answer?}]}`. Before the student has submitted: `{ok:false, error:"Submit the quiz first.", submitted:false}`, and no answer data at all.
- `admin_grading_queue` in `{year?, group?, lesson?, student?, status?:"pending"|"graded"|"all"}` out `{ok, items:[{submission_id, student, student_id, name, year, kind, prompt, model_answer, has_image, lesson, question_id, drive_file_id, max, awarded, note}]}`
- `admin_grade_written` in `{submission_id, question_id, awarded, note?, student?}` (`student` only disambiguates) out `{ok, awarded, max}`; `0 <= awarded <= max`, calling it twice with the same values changes nothing and writes one audit row.
- `admin_migrate_lesson_keys` in `{dry_run?:true}` (default true; S1's native `apply:true` is also accepted) out `{ok, dry_run, backup_tab, changes:[{tab, row, field, before, after}]}`; a real run requires `dry_run:false`, writes a backup tab copy first, and is idempotent.

Photo access (R-018): image bytes are returned only through a handler that checks the caller is
an admin or the student named in the `WrittenAnswers` row. No public Drive sharing.

## 5. The one video-state function

`can_watch` is decided only by the existing `_lockIndex` + `_entitlementCovers` path (and
`p2k_*` alias resolution inside it). S2 reads it, never re-derives it. A new "center"
state must be expressed as an Entitlements row with `expires_at`, not as a new boolean.

## 6. Time

All "today", "this week" and "this month" are Cairo time (`Africa/Cairo`), the week starts
on Saturday and ends Friday 23:59:59. Use `_cairoDate` / `_cairoIso`. The harness lets tests
set the clock (`env.setNow("2026-10-24T10:00:00+03:00")`), so no handler may call a second
time source.

## 7. Client conventions

- Arabic RTL stays intact: every new element is logical-property CSS (`margin-inline-start`,
  not `margin-left`) and carries `dir="auto"` where mixed text can appear.
- A client call for a feature that answers `disabled:true` hides the feature silently.
- Any file edited in `tools/quiz-maker-v2/assets_templates/` is the source; the copy in `assets/`
  is made by the Quiz Maker's "Sync site assets" action (there is no command-line sync). Ship both
  files, and `python tools/quiz-maker-v2/check_asset_drift.py` must say "In sync." (R-021).
  The drift check ignores CRLF vs LF.
- A NEW shared script (S3's `capture.js`) must be added to the `SCRIPTS` tuple in
  `check_asset_drift.py` and to the Sync list in `modules/common.py`, one line each, as was done
  for `video.js`. S3 may edit those two lines only; nothing else in those files.

## 8. Audit log

`p2_audit(who, action, target, before, after)` in `Phase2_Core.gs` appends to `AuditLog`
(creating the tab on first use) and never throws. Call it for: grants, revokes, center
decisions, key migrations, parent-log edits and every grade change (R-022). `who` is the
admin's normalized phone, or `"token"` for the desktop app.

## 9. Handoffs

`handoff/Sx-to-Sy.md`, one file per direction. Content: what you need, the exact function or
field, and the date. The receiving session replies by appending an `ANSWER:` block to the
same file. S5 reads all handoffs before each integration build.

## 10. Change log

- v1.5 (integration of S3): `WrittenAnswers` is in `_dataSs()` with extra columns `uploaded_at`, `image_ids`; `submission_id` is `c:<client_id>`; submit score/total are the auto part only; S3 handlers `p2_upload_written_image`, `p2_get_quiz_review`; hooks `p2c_decorate_quiz`, `p2c_prepare_quiz_payload` (see INTEGRATION-LOG 19-26).
- v1.4 (integration of S2): S2's handlers renamed to `p2_*` and its globals to `_p2fu*` / `P2_FU_*`; its flags and audit now go through `p2_flag`, `p2_requireFlag` and `p2_audit` (one `AuditLog`, DATA spreadsheet, `who` = admin phone or `token`); S2's own tabs (`LessonRequirements`, `ParentNotifications`, `MonthlyReviews`) live in the Students spreadsheet (`_ss()`); `ParentNotifications` has no `id` column (see section 3); the two existing follow-up actions gained `p2_*` handlers behind `_p2CallOr`.

- v1.3 (integration of S1, S4, S5-hour0): WrittenAnswers columns follow S4 (`student_id`, plus `kind`, `graded_by`); S4's
  three extra actions added to the table; identity-field rule added to section 4; lesson aliases: a bare slug now maps to the
  FULL canonical key (Code.gs, `Phase2_Keys.gs`, JSON agree); the Phase 2 global-name prefix rule is waived for S1 and
  S4's already-shipped names (no collisions, tested), and still binds S2 and S3.
- v1: first publication.
- v1.2: `Code.gs` rule corrected to match plan S1 item 2 (S1 edits the key-comparing functions; S5 the router).
- v1.1: removed a reference to a non-existent `scripts/sync_assets.py`; S3 may add `capture.js` to the two sync lists.
