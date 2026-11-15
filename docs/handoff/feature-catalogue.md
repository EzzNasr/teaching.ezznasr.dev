# Feature catalogue

*Written 2026-11-16 from the code at `32436a7`. Part of the [handoff guide](README.md). Screenshots of each feature
are in the root [README.md](../../README.md). Action details: [backend-reference.md](backend-reference.md).*

Status words: **Live** = in the code and deployed (per the deploy record up to Version 67); **Built, off** = in the
code behind a switch; **Partial** = works with a stated limit. Whether a Script Property switch is on in production
can only be read in the Apps Script project, so "switch" columns name the switch, not its live value.
The Tests column names the registry group; the exact cases and what each checks are in
[../REGRESSION.md](../REGRESSION.md) ("core group" = `R-001` to `R-025`, `R-E*` = the browser tests).

## A. Students

| # | Feature | Page / script | Backend | Switch | Tests |
|---|---|---|---|---|---|
| A1 | Subject, track and lesson pages | `index.html`, `programming/`, `math/`, `english/`, `style.css` | none (static) | | R-G01, R-001c |
| A2 | Account: register, sign in, forgot password (checked by the parent's number), profile completion | `assets/auth.js` (gate + corner widget) | `check_student`, `register_student`, `login_student`, `reset_password`, `update_profile` | | core group `R-001`..`R-025` |
| A3 | One active sign-in per account (a second device signs the first out) | `auth.js`, `quiz.js`, `assign.js`, `video.js` | `login_student`, `check_session` | | R-RESTORE-1 |
| A4 | Locked videos, several video slots per lesson, watch progress | `assets/video.js` | `get_video`, `record_watch` | per-lesson lock (Videos / lesson lock) | core group, `R-E*` |
| A5 | Pay for one lesson ("I paid" + transfer reference) | `video.js` | `request_access` | `DEFAULT_ACCESS_DAYS` | core group |
| A6 | Chapter and term subscriptions with fixed prices | `assets/subscribe.js` | `get_subscription_options`, `request_subscription` | baccalaureate programming folders only | core group |
| A7 | Quizzes: MCQ, match, written (photo) questions, instant auto-marking, review after submit | `assets/quiz.js`, `quiz.html` per lesson | `get_quiz_state`, `get_quiz`, `upload_quiz_result`, `get_quiz_review` | quiz lock; `FF_DEFERRED_ANSWERS` (answers stay on the server) | core group, `R-E*` |
| A8 | Homework: text, link, file and written (photo) answers | `assets/assign.js`, `assignment.html` per lesson | `upload_submission` | | core group, `R-E*` |
| A9 | Camera capture for handwritten answers, with an upload check | `assets/capture.js`, `assets/upload-guard.js` | `upload_written_image`, `report_photos` | `FF_CAMERA` | `R-UG1`, core group |
| A10 | Lesson attachments (files from Drive) | `assets/attachments.js` | (uploaded by the Quiz Maker) | | |
| A11 | Math typesetting | `assets/math-render.js`, `assets/vendor/katex/` | | | `R-P4-S1-*` |
| A12 | Student dashboard: results, what is due, wrong questions to review | `dashboard/student.html`, `assets/dash-review.js` | `get_my_results`, `get_quiz_review`, `get_written_image` | | `R-E*` |
| A13 | Dark mode, Arabic + English wording | `assets/theme.js`, `theme.css` | | | |
| A14 | SEO: sitemap, meta tags, 404 page | `tools/seo/`, `sitemap.xml`, `robots.txt`, `404.html` | | | |

## B. Staff pages (`dashboard/`)

Every staff page: `auth.js` gate, then `assets/staff-guard.js` (role check for the page), a shared Arabic menu, an
Arabic / English button (`assets/i18n.js` + `assets/i18n/<page>.js`), and `?mock=1` sample-data mode.

| # | Feature | Page / script | Backend | Who | Tests |
|---|---|---|---|---|---|
| B1 | Staff home | `staff.html` | `p4_session_scope` | all staff | R-I18N-1 |
| B2 | Results: all quiz and homework results, filters, per-question analysis | `master.html`, `wrong-questions.html` | `admin_get_all` | owner; teacher (own subjects) | `R-E*`, `R-P4-S7-*` |
| B3 | Lesson access: who can open what, payment requests, payment history, manual and group grants, quiz locks, groups | `access.html`, `assets/lesson-combobox.js` | `admin_access_overview`, `admin_list_payments`, `admin_decide_payment`, `admin_grant_access`, `admin_revoke_access`, `admin_group_*`, `admin_grant_quiz_access`, `admin_set_quiz_lock`, `admin_set_lesson_lock`, `admin_list_lessons`, `admin_set_lesson_tags`, `p3_admin_bulk_*` | owner; teacher (own subjects, own groups) | R-007, R-008, R-E18, R-E21, R-E22, `R-P3-B*` |
| B4 | Follow-up v2: Today tab, next-step card per group, attendance (center / online), missing homework and quizzes, parent messages (one tap to WhatsApp), walk-through, editable templates, deep links | `followup.html`, `assets/followup-app.js`, `followup-logic.js`, `followup-events.js`, `followup-templates.js`, `followup-walk.js` | `admin_followup_overview`, `admin_followup_set_attendance`, `admin_followup_save_group`, `admin_followup_save_templates`, `admin_fu2_mark_done`, `admin_log_parent_notification`, `admin_list_parent_notifications` | all staff (own students) | `R-F*`, `R-FU2-*` |
| B5 | Monthly report and monthly send to parents | `assets/followup-month.js` | `admin_monthly_review`, `admin_req_month_get`, `admin_req_month_save` | all staff (switch `FF_MONTHLY`) | `R-MONTH-*`, `R-FU2-MONTHLY` |
| B6 | Requirements: what counts (video, homework, quiz, attendance, written, custom), global and per group, lessons required each month | `requirements.html`, `assets/requirements.js`, `requirements-logic.js` | `admin_req_get`, `admin_req_save_global`, `admin_req_save_group`, `admin_req_check`, `admin_req_history`, `admin_set_requirement` | owner, owner's assistants | `R-REQ1`..`R-REQ4` |
| B7 | Student summary: one student on one screen; staff can correct name and parent phone | `student-summary.html`, `assets/student-summary.js` | `admin_student_summary`, `p4_teacher_update_student` | all staff (own students; phone edits need `P4_TEACHER_PHONE_EDIT`) | `R-FU2-E2E-SUMMARY`, `R-P4-S5-*` |
| B8 | Grading: handwritten answers next to the model answer, staged marks saved together | `grading.html`, `assets/draft-store.js` | `admin_grading_queue`, `admin_grade_written`, `get_written_image`, `admin_get_written_models` | all staff (own students; switch `FF_GRADING`) | `R-GRADE-ROT-1`, `R-P4-S7-*` |
| B9 | Team: everyone who can sign in as staff, add teacher / assistant, change log | `team.html` | `p4_admin_list_teachers`, `p4_admin_set_teacher`, `p3_admin_set_role`, `p3_admin_list_staff`, `p4_admin_list_edit_log`, `p4_admin_set_group_owner`, `p4_admin_tg_unlink` | owner | `R-TEAM-LOG-1`, `R-TEAM-UX-1` |
| B10 | My team: a teacher appoints assistants and links Telegram | `my-team.html` | `p4_teacher_set_assistant`, `p4_teacher_list_assistants`, `p4_teacher_revoke_assistant`, `p4_tg_link_start`, `p4_tg_status`, `p4_tg_unlink` | teacher (limit `P4_MAX_ASSISTANTS`) | `R-P4-S5-*`, `R-P4-S6-01` |
| B11 | Revenue: this month vs last, waiting, all-time, by lesson / chapter / term, by month, by group; lesson price | `revenue.html` | `admin_revenue_report`, `admin_revenue_set_price`, `admin_revenue_fill_old` | owner | `R-REV-1`, `R-REV-2` |
| B12 | Teacher stats | `teacher-stats.html` | `p4_admin_teacher_stats` | owner | `R-P4-S8-*` |
| B13 | Save bar: edits are staged and saved together, with undo | `assets/draft-store.js` | (page-side) | | R-E18, R-E21, R-E22 |
| B14 | Recovery tools: find and restore submissions that exist in Drive but not in the sheet | (called from the access page) | `p3_admin_diagnose_submissions`, `p3_admin_restore_submissions`, `p3_admin_backfill_submission` | owner | `R-P3-R1` |

## C. Notifications (Telegram)

| # | Feature | Backend | Notes |
|---|---|---|---|
| C1 | New student, payment request (with Approve / Reject), quiz completed, photo report | `_notifyAdmin`, `handleTelegramUpdate` in `Code.gs` | Bot token and chat ids in Script Properties |
| C2 | Teacher's own Telegram: payment requests for his subjects | merged `Phase4_Telegram` section, `TeacherTelegram` tab | Owner still gets every message |
| C3 | Hourly follow-up reminders with Open / Snooze / Done | `FollowupNotify.gs` (`fu2_notify_tick`) | Needs `fu2_notify_installTrigger` once |
| C4 | Attendance bot: device-change approvals, flag digest, session summary | `AttendanceAll.gs` (`attt_*`) | Separate bot and properties (`ATT_TG_*`) |
| C5 | WhatsApp sender alerts: failed, unknown, logged out, silent phone | `FollowupWhatsApp.gs` (`fu2_wa_watchdog`) | Problems only |

## D. Attendance (`attend/`)

Docs: [../attendance/](../attendance/README.md). One backend file, error **codes**, its own tabs and teacher accounts.

| # | Feature | Page / script | Backend actions |
|---|---|---|---|
| D1 | Rotating QR on the room screen (new code every 10 s), live counters and arrival cards | `attend/admin/` (`admin.js`, `qr.js`) | `att_start_session`, `att_close_session`, `att_live` |
| D2 | Student check-in: scan, sign up once (ID + name, device bound), location and device checks, automatic retry, resume after reload, 120 s late grace | `attend/index.html`, `attend.js`, `contract/att_api.js`, `contract/att_config.js` | `att_ticket`, `att_signup`, `att_attend`, `att_status` |
| D3 | Device change with approval (dashboard or Telegram) | both pages | `att_change_device`, `att_requests`, `att_decide_request` |
| D4 | Flags and review: outside the hall, same phone as another student, repeats; Accept / Reject | dashboard "Needs review" | `att_flagged`, `att_review` |
| D5 | Mark present by hand, with a reason | dashboard | `att_manual_checkin` |
| D6 | Rooms: calibrate a room's location | dashboard | `att_rooms`, `att_calibrate_room` |
| D7 | Roster, past lectures, CSV export | dashboard | `att_roster`, `att_sessions`, `att_session_detail`, `att_export` |
| D8 | Teacher accounts (generated passwords, 12 h signed tokens), all-teachers overview | dashboard (admin tabs) | `att_login`, `att_me`, `att_user_create`, `att_users`, `att_user_update`, `att_user_reset`, `att_overview` |
| D9 | Demo data, self-test, scripted run, load test (run from the editor) | | `att_seedDemo`, `att_demoLive`, `att_clearDemo`, `att_selfTest`, `att_scriptedRun`, `att_loadTest`, `att_cleanupTest` |

## E. WhatsApp sender (`tools/wa-sender/`)

Docs: [../whatsapp/](../whatsapp/README.md). **Phase 1 built; test mode works end to end; modes off / test / live.**

| # | Feature | Where |
|---|---|---|
| E1 | "Send all from the WhatsApp phone" on the walk-through and the monthly report | `assets/followup-walk.js`, `followup-month.js` |
| E2 | Outbox with modes, sending hours, daily cap, random gaps, each message handed out once | `FollowupWhatsApp.gs`, `WaOutbox` tab |
| E3 | Phone loop with an on-disk journal (never sends twice), auto-restart scripts | `sender.js`, `lib/loop.js`, `lib/journal.js`, `lib/wa.js`, `termux/` |
| E4 | Phase 2 (zero taps: the server composes and queues by itself) | **not built** |

## F. Quiz Maker (`tools/quiz-maker-v2/`)

Python desktop app (`app_main.py`, `modules/`). Not published.

| # | Feature | Module |
|---|---|---|
| F1 | Build a lesson's quiz from a bulk-paste format (MCQ, match, `WRITTEN:` with marks and model answer) | `modules/quiz_tab.py` |
| F2 | Build the assignment page | `modules/assignment_tab.py` |
| F3 | Upload attachments, quiz content and model answers to the backend | `modules/attachment_tab.py`, `modules/drive_bridge.py` |
| F4 | Lesson tags (chapter / term) | `modules/tags_tab.py` |
| F5 | Generate lesson and index pages from `templates/`, keep lesson order, sync shared scripts to `assets/` | `modules/common.py` |
| F6 | Teacher mode (a teacher's scoped token) | `modules/teacher_mode.py` |
| F7 | "Run tests" button | `modules/test_runner.py` |
| F8 | Maintenance scripts | `check_asset_drift.py`, `check_lesson_paths.py`, `normalize_lesson_order.py`, `migrate_video_slots.py`, `strip_embedded_answers.py` |

## G. Operations built into the backend

| # | Feature | Function | How it runs |
|---|---|---|---|
| G1 | Weekly backup of the spreadsheets to Drive | `weeklyBackup` | time trigger, Sunday 3 AM |
| G2 | Sheet setup, audit and repair (plain-text columns, duplicate headers, phone collisions) | `setupSheets`, `auditSheets`, `repairSheets`, `repairLayout`, `findPhoneCollisions` | from the editor |
| G3 | Audit log of grants, revokes, grades, edits | `p2_audit`, `AuditLog` tab | automatic |
| G4 | Feature switches | `p2_flag` (`FF_*`), `p3_admin_flag_status` | Script Properties |
| G5 | Lesson key migration (dry run by default, backup tab first) | `admin_migrate_lesson_keys` | action |
| G6 | Live smoke test | `scripts/smoke_live.js` | `test_all.sh --live` |

## H. Not built or partial (from the code and the owner's status notes)

| Item | State |
|---|---|
| Session expiry and "sign out everywhere" | not built |
| Math chapter / term subscriptions | not built (subscriptions exist only for the two baccalaureate folders) |
| A teacher's own follow-up reminders and requirements editing | refused by design for now |
| Daily digest and weekly "all clear" Telegram line | not built |
| WhatsApp phase 2 (zero taps) | not built |
| Attendance tiers / limits per teacher, nightly attendance backup, privacy note | not built (attendance F2, F7, F8) |
| Attendance in its own Apps Script project | planned (attendance F1) |
| Video watermarking and `get_video` rate limit | not built |
| `wrong-questions.html` | near copy of `access.html`; delete or split is an open decision |
| Staging backend | does not exist |
