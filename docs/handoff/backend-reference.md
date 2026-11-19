# Backend reference

*Written 2026-11-16 from the code at `32436a7` (`tools/quiz-maker-v2/apps_script/`). Part of the
[handoff guide](README.md). Payload and answer fields of the Phase 2 actions: [../contract.md](../contract.md);
dashboards: [../specs/dashboards-data-contract.md](../specs/dashboards-data-contract.md).*

One endpoint: `POST <exec URL>` with a JSON body `{action, ...}`. One answer shape: `{ok:true, ...}` or
`{ok:false, error}` (+ `retryable:true` when the lock was busy, `disabled:true` when a feature switch is off,
`code` for attendance).

## 1. Actions

"Auth" column: **pub** = no identity; **stu** = student session (`student_id` + `session_token`); **adm** = staff
session or token, decided by `p4_gate` and the handler's own check; **own** = owner only; **tch** = teacher only;
**tok** = admin or teacher token only (desktop app); **wa** = the phone's token.

### Accounts and sessions (`Code.gs`)

| Action | Auth | What |
|---|---|---|
| `check_student` | pub | Is this phone registered (returns the first name only) |
| `register_student` | pub | Create the account, return a session |
| `login_student` | pub | Check the password hash, issue a session (10 wrong = 30 min pause) |
| `reset_password` | pub | New password if the parent's number matches (5 wrong per hour); never for the owner |
| `update_profile` | stu | Fill in year and parent phone |
| `check_session` | stu | Is this token still the active one (student / admin / stale) |
| `p3_session_role`, `p4_session_scope` | stu | Role, subjects and principal of the signed-in account |

### Student work

| Action | Auth | What |
|---|---|---|
| `get_quiz_state`, `get_quiz` | stu | Lock state; questions (answers stripped when `FF_DEFERRED_ANSWERS` is on) |
| `upload_quiz_result` | stu (legacy: no token while `P4_LEGACY_UPLOADS` is not `0`) | Save an attempt; idempotent on `client_id` |
| `upload_submission` | stu (same legacy rule) | Save homework (text, link, file) |
| `upload_written_image` | stu | One handwritten-answer photo (max 2.5 MB, rate limited); `FF_CAMERA` |
| `report_photos` | stu | Count the photos the server holds for an attempt, tell Telegram |
| `get_quiz_review` | stu | Right / wrong per question, only after submitting |
| `get_my_results` | stu | Own quiz and homework rows |
| `get_written_image` | stu (own) or adm | Photo bytes |
| `get_video` | pub / stu | Embed URL when the lesson is open or the student has access; otherwise why not |
| `record_watch` | stu | Watch percentage (max-merged) |
| `request_access` | stu | "I paid" for one lesson |
| `get_subscription_options`, `request_subscription` | stu | Chapter / term subscriptions |

### Staff: results, access, payments, groups

| Action | Auth | What |
|---|---|---|
| `admin_get_all` | adm (filtered) | All results and submissions |
| `admin_access_overview` | adm (filtered) | Entitlements, quiz access, groups in one read |
| `admin_list_payments`, `admin_decide_payment` | adm (payment in scope) | Payment requests and decisions |
| `admin_grant_access`, `admin_revoke_access` | adm | Manual video access |
| `admin_grant_quiz_access`, `admin_revoke_quiz_access` | adm | Open a locked quiz for one student |
| `admin_list_groups`, `admin_group_add`, `admin_group_remove` | adm (own groups) | Groups and members |
| `admin_group_grant_access`, `admin_group_revoke_access`, `admin_group_grant_quiz_access`, `admin_group_revoke_quiz_access` | adm | Group grants (members who join later get them too) |
| `p3_admin_bulk_preview`, `p3_admin_bulk_grant`, `p3_admin_bulk_revoke` | adm | Bulk access with a preview |
| `admin_set_video`, `admin_list_videos` | adm | Video URLs per lesson and slot |
| `admin_set_lesson_lock`, `admin_set_quiz_lock` | adm | Locks |
| `admin_set_quiz_content`, `admin_get_quiz_content` | adm / tok | Quiz questions and answers (from the Quiz Maker) |
| `admin_set_written_models`, `admin_get_written_models` | adm / tok | Model answers for written questions |
| `admin_list_lessons` | adm (filtered) | Every lesson on the site (read from GitHub) |
| `admin_set_lesson_tags`, `admin_list_lesson_tags` | adm | Chapter / term tags |
| `upload_attachment`, `delete_attachment`, `ping` | tok | Desktop app: lesson files (delete only inside the attachments folder) |
| `admin_migrate_lesson_keys` | own | Rewrite old lesson keys (dry run by default) |

### Staff: follow-up, requirements, grading, summary

| Action | Auth | What |
|---|---|---|
| `admin_followup_overview` | adm (filtered) | Raw facts for every group in one round trip; the page computes the verdicts |
| `admin_followup_set_attendance` | adm | Center / online; center gives free access for that lesson |
| `admin_followup_save_group`, `admin_followup_save_templates` | adm | Group schedule and lessons; message templates |
| `admin_fu2_mark_done`, `admin_fu2_group_duplicates` | adm / own | Step done; students in two groups |
| `admin_fu2_notify_settings_get`, `admin_fu2_notify_settings_save`, `admin_fu2_notify_test` | owner team | Reminder settings per group |
| `admin_req_get`, `admin_req_save_global`, `admin_req_save_group`, `admin_req_check`, `admin_req_history`, `admin_req_month_get`, `admin_req_month_save` | owner team | Requirements and month lessons |
| `admin_set_requirement` | adm | Per-lesson quiz / homework required |
| `admin_student_summary` | adm (filtered) | One student |
| `admin_monthly_review` | adm (filtered) | Monthly report; `FF_MONTHLY` |
| `admin_log_parent_notification`, `admin_list_parent_notifications` | adm | Parent contact log; `FF_PARENT_LOG` |
| `admin_grading_queue`, `admin_grade_written` | adm (filtered) | Grading; `FF_GRADING` |
| `admin_fu2_wa_enqueue`, `admin_fu2_wa_status`, `admin_fu2_wa_cancel` | adm | WhatsApp outbox |
| `admin_fu2_wa_claim`, `admin_fu2_wa_report`, `admin_fu2_wa_heartbeat` | wa | The phone |

### Owner and teacher administration

| Action | Auth | What |
|---|---|---|
| `p4_admin_set_teacher`, `p4_admin_list_teachers`, `p4_admin_set_group_owner`, `p4_admin_tg_unlink`, `p4_admin_list_edit_log`, `p4_admin_teacher_stats` | own | Teachers, group owners, logs, stats |
| `p3_admin_set_role`, `p3_admin_list_staff`, `p3_admin_flag_status` | own | Assistants and switches |
| `p3_admin_diagnose_submissions`, `p3_admin_restore_submissions`, `p3_admin_backfill_submission` | own | Recovery |
| `admin_revenue_report`, `admin_revenue_set_price`, `admin_revenue_fill_old` | own | Revenue |
| `p4_teacher_update_student`, `p4_teacher_set_assistant`, `p4_teacher_list_assistants`, `p4_teacher_revoke_assistant` | tch / adm | A teacher's own students and assistants |
| `p4_tg_link_start`, `p4_tg_status`, `p4_tg_unlink` | tch | Link the teacher's Telegram |

### Attendance (`AttendanceAll.gs`, routed first by `att_route_`)

| Action | Auth | What |
|---|---|---|
| `att_ticket`, `att_signup`, `att_attend`, `att_change_device`, `att_status` | pub (QR token / ticket / device secret) | Student flow |
| `att_login` | pub | Teacher password to a 12 h token |
| `att_me`, `att_start_session`, `att_close_session`, `att_live`, `att_rooms`, `att_calibrate_room`, `att_requests`, `att_decide_request`, `att_flagged`, `att_review`, `att_review_bulk`, `att_manual_checkin`, `att_extend_session`, `att_roster`, `att_sessions`, `att_session_detail`, `att_export` | attendance token (own rows only) | Teacher dashboard. `att_extend_session` = "+2 minutes" (D15); `att_review_bulk` = decide many flagged check-ins at once. A check-in can have status `blocked` (suspected cheating saved for review, D22-D25) |
| `att_user_create`, `att_users`, `att_user_update`, `att_user_reset`, `att_overview` | attendance admin | Accounts and the all-teachers view |
| `att_installBackup`, `att_checkDevices`, `att_repairDevices(apply)`, `att_repairLeadingZeros(apply)`, `att_recoverRefused(sessionId, apply)` | run by the owner in the Apps Script editor (not actions) | Nightly backup trigger; check and repair phone and device records. The repairs only report unless `apply` is true |

Error codes: `BUSY`, `UNAUTHORIZED`, `FORBIDDEN`, `USER_DISABLED`, `LOCKED`, `BAD_PASSWORD`, `BAD_REQUEST`,
`TICKET_EXPIRED`, `ID_TAKEN`, `UNKNOWN_ACTION`, `SERVER_ERROR` and others in the file. Pages map codes to wording.

### Webhooks (not actions)

| Entry | Check |
|---|---|
| Telegram, main bot: a body with `update_id` | `?tg=<secret>` in the URL, and the tapper's id on the allow-list; each `update_id` handled once |
| Telegram, attendance bot | `?att_tg=<secret>`, own allow-list |

## 2. Where authorization is decided

| Layer | Function | Role |
|---|---|---|
| Gate | `p4_gate` > `p4_decide_` with the `P4_ACTIONS` table | For teachers and scoped assistants: deny by default, check the lesson / student / group / payment in the request against the caller's scope |
| Handler | `_requireAdmin` (token), `_requireAdminSession` / `_requireAdminAny` (session, with the `p3_assistantAllows` and `p4_teacherAllows` hooks), `_requireStudentSession` | Every handler starts with one of these |
| Response | `p4_filter` + a `p4f_*` function per action | Removes rows outside the caller's scope; a missing filter fails closed |
| Assistants | `P3_STAFF_ALLOW`, `P4_ASSISTANT_DENY` | Allow-list and deny-list of actions |
| Attendance | `att_auth_`, then `att_scopeSession_` / `att_canSee_` | The caller is passed to the handler as an argument, never read from the payload |

**Adding an action:** a `case` in `doPost` (or a route in `FollowupRouter.gs`), a row in `P4_ACTIONS` (otherwise
teachers are refused), a `p4f_*` filter if it returns lists, an entry in `P3_STAFF_ALLOW` only if assistants may call
it, and tests for each role (the P4 matrix test covers the table).

## 3. Sheet tabs

| Spreadsheet | Tabs |
|---|---|
| Students (`STUDENTS_SHEET_ID`) | `Students`, `Videos`, `Lessons`, `Entitlements`, `Payments`, `Groups`, `GroupGrants`, `GroupOwners`, `GroupSettings`, `GroupRequirements`, `Quizzes`, `QuizContent`, `QuizAccess`, `LessonTags`, `LessonRequirements`, `MonthLessons`, `RequirementChecks`, `Attendance`, `WatchProgress`, `FollowupTemplates`, `ParentNotifications`, `MonthlyReviews`, `StudentEditLog`, `TeacherTelegram`, `WaOutbox` |
| Data (`DATA_SHEET_ID`, falls back to the Students spreadsheet) | `QuizResults`, `Submissions`, `WrittenAnswers`, `WrittenModels`, `AuditLog` |
| Attendance (`ATT_SHEET_ID`) | `AttStudents`, `AttDevices`, `AttRequests`, `AttRooms`, `AttSessions`, `AttCheckins`, `AttFlagLog`, `AttUsers` |

The exact spreadsheet of a few follow-up tabs is decided in code (`_ss()` or `_dataSs()` at each call site); check the
call before moving a tab. Rules: row 1 is the header; columns are found by header name; new columns are appended;
text columns are written as plain text (`PLAIN_TEXT_HEADERS`) so phones keep their leading zero and nothing becomes a
formula; timestamps are Cairo-time strings; booleans are `TRUE` / `FALSE`.

## 4. Script Properties

Names only. Values live in the Apps Script project (Project Settings) and nowhere else.

| Group | Properties |
|---|---|
| Secrets | `ADMIN_TOKEN`, `P4_TEACHER_TOKENS` (hashes), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ATT_MASTER_SECRET`, `ATT_TG_BOT_TOKEN`, `ATT_TG_SECRET`, `WA_SENDER_TOKEN`, `GITHUB_TOKEN` (read-only, optional) |
| Ids | `STUDENTS_SHEET_ID`, `DATA_SHEET_ID`, `ATT_SHEET_ID`, `ATTACHMENTS_FOLDER_ID`, `SUBMISSIONS_FOLDER_ID`, `WRITTEN_FOLDER_ID`, `BACKUPS_FOLDER_ID`, `STUDENTS_TAB_PIN`, `TELEGRAM_ADMIN_CHAT_ID`, `ATT_TG_ADMIN_IDS`, `P4_TG_BOT_USERNAME`, `GITHUB_REPO`, `GITHUB_BRANCH`, `ATT_WEBAPP_URL`, `ATT_LOADTEST_URL` |
| Switches | `FF_CAMERA`, `FF_DEFERRED_ANSWERS`, `FF_GRADING`, `FF_PARENT_LOG`, `FF_MONTHLY` (`1` / `true` = on), `P4_LEGACY_UPLOADS` (`0` = token required), `P4_TEACHER_PHONE_EDIT`, `WA_MODE` (off / test / live) |
| Settings | `DEFAULT_ACCESS_DAYS`, `P4_MAX_ASSISTANTS`, `REV_LESSON_PRICE_EGP`, `WA_TEST_TO`, `WA_DAILY_CAP`, `WA_HOURS`, `WA_MIN_GAP_SEC`, `WA_MAX_GAP_SEC` |
| State written by code | `WA_LAST_SEEN`, `WA_SILENT_NAG` |

## 5. Time triggers

| Function | Schedule | Installed by |
|---|---|---|
| `weeklyBackup` | Sunday 3 AM | `Code.gs` installer near `weeklyBackup` |
| `fu2_notify_tick` | hourly | `fu2_notify_installTrigger` |
| `fu2_wa_watchdog` | hourly | `fu2_wa_installTrigger` |
| attendance flag digest (`ATTT_TRIGGER_FN`) | every minute | `att_installTrigger` |

## 6. Platform limits to design around

| Limit | Effect |
|---|---|
| About 30 concurrent executions per project, one script lock | A class finishing a quiz while a lecture checks in share both. Keep locked sections to a few sheet calls. |
| 6 minutes per execution | Long admin reads (`admin_followup_overview`, `admin_get_all`) grow with the data |
| Whole-tab reads | `getDataRange().getValues()` is the query engine: cost grows with rows. Archive or cache before tens of thousands of rows |
| No request headers, no client IP | No header auth, no IP rate limiting; secrets travel in the body or the URL query |
| POST answers through a redirect | Telegram counts it as a failure and retries: every webhook update is de-duplicated |
| `CacheService` (6 h max, best effort) | Used for throttles and short caches only, never as the record |
