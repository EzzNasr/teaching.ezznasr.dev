/**
 * Code.gs — Drive bridge for teaching.ezznasr.dev
 *
 * One Apps Script Web App handles:
 *   1. Admin attachment uploads    (action: "upload_attachment", token required)
 *   2. Student assignment uploads  (action: "upload_submission", no token)
 *   3. Student quiz results        (action: "upload_quiz_result", no token)
 *   4. Student login/register      (check_student / register_student / login_student
 *                                   / reset_password)
 *   5. Dashboards                  (get_my_results / admin_get_all)
 *
 * Files are no longer served back out through this script. Uploaded
 * attachments are set to "anyone with the link can view" and the site
 * links straight to drive.google.com's own preview/view/download URLs
 * (see assets/attachments.js). That's what Drive is built for — it
 * avoids the Apps Script HTML sandbox, which blocks downloads
 * (missing `allow-downloads`) and made the old base64 data-URI
 * approach unreliable.
 *
 * ---- One-time setup ----------------------------------------------------
 *
 * 1. Create three folders in your own Drive:
 *      - one for lesson attachments (e.g. "Teaching / Attachments")
 *      - one for student submissions (e.g. "Teaching / Submissions")
 *      - one for quiz results (e.g. "Teaching / Quiz Results")
 *    Open each folder and copy its ID from the URL
 *    (drive.google.com/drive/folders/<THIS PART>).
 *
 * 1b. Login + dashboards — create ONE Google Sheet (e.g. "Teaching /
 *    Students"), copy its ID from the URL the same way. Leave it empty —
 *    the first call to _students() writes the Students header row itself,
 *    and _sheetByName() below creates the QuizResults and Submissions
 *    tabs automatically the first time each is needed. No separate
 *    spreadsheets or extra Script Properties required for those — though
 *    see the optional DATA_SHEET_ID note below once that data grows.
 *
 * 2. In script.google.com, create a new project, paste this file in as
 *    Code.gs, then go to Project Settings → Script Properties and add:
 *      ATTACHMENTS_FOLDER_ID   = <folder id from step 1>
 *      SUBMISSIONS_FOLDER_ID   = <folder id from step 1>
 *      QUIZ_RESULTS_FOLDER_ID  = <folder id from step 1>
 *      STUDENTS_SHEET_ID       = <sheet id from step 1b>
 *      ADMIN_TOKEN             = <any long random string you make up>
 *
 * 2b. Optional, once QuizResults/Submissions have grown a lot — every
 *    action opens the whole Students spreadsheet (SpreadsheetApp.openById
 *    loads the entire workbook), so once those two tabs pile up rows with
 *    large questions_json/answers_json blobs, even a plain login gets
 *    slower. To split them out:
 *      - Create a second Google Sheet (e.g. "Teaching / Quiz Data").
 *      - Right-click the QuizResults tab in the Students spreadsheet →
 *        Copy to → Existing spreadsheet → pick the new one. Same for
 *        Submissions. Then delete both tabs from the Students spreadsheet
 *        (Students keeps just its own one tab).
 *      - Add Script Property DATA_SHEET_ID = <new sheet's id>.
 *    Skipping this is fine — QuizResults/Submissions just stay in the
 *    Students spreadsheet, same as today.
 *
 * 3. Deploy → New deployment → type "Web app".
 *      Execute as:      Me
 *      Who has access:  Anyone
 *    Copy the deployment URL (ends in /exec) — that's your Web App URL.
 *
 * 4. Existing attachments uploaded before the sharing change were NOT
 *    auto-shared — that only applies to new uploads going forward. For
 *    older files, share them manually once: right-click the file in
 *    Drive → Share → change to "Anyone with the link" → Viewer.
 *
 * 5. Mark yourself as admin for the master dashboard: open the Students
 *    tab, find your own row, put TRUE in the is_admin column. Nothing
 *    web-facing ever writes that column — it's a manual, one-time step.
 *
 * ---- Duplicates & timestamps (added) -----------------------------------
 * - Every quiz attempt / submission now carries a client_id from the
 *   browser. A second POST with the same id (double-click, auto-retry
 *   after a dropped connection, "Retry sending") is acknowledged but NOT
 *   written again. Stored in a new "dedupe_key" column (added
 *   automatically to QuizResults and Submissions).
 * - Times are written as plain Cairo text ("2026-09-17 21:42:10") and the
 *   time columns are forced to Plain Text so Sheets can't turn them into
 *   Date cells any more (that's what produced 2026-09-17T21:00:00.000Z).
 *   Old rows that were already converted are formatted back to Cairo
 *   text on the way out.
 * - Clean up rows that were duplicated BEFORE this fix: in the Apps Script
 *   editor pick previewDuplicates (logs only) or removeDuplicates
 *   (makes a Drive backup copy of the data spreadsheet first) from the
 *   function dropdown and press Run. cleanEverything = removeDuplicates +
 *   tidySheets (converts old date cells to text, restores dropped leading
 *   zeros on phone numbers, freezes/bolds the header, clips the big JSON
 *   columns, hides dedupe_key, trims empty rows).
 * - Lost rows? Quiz results and submissions are ALSO saved as JSON files in
 *   your Drive folders. fixEverything() repairs the sheet layout, puts back
 *   every attempt/submission that has a Drive file but no sheet row, then
 *   removes duplicates and tidies (with a backup first). Run it twice if
 *   the log says it stopped early.
 *
 * ---- Class-sized bursts (added) ------------------------------------------
 * - Quiz / submission uploads no longer hold the script lock while Drive files
 *   are created. Order: quick duplicate look (no lock) -> create Drive files
 *   (no lock) -> lock only to re-check and write the row. Files made by a
 *   request that then turns out to be a duplicate, or fails, are trashed again.
 * - If the lock can't be had within 20 s (30 s for register / reset) the answer
 *   is {ok:false, retryable:true, error:"The server is busy right now ..."};
 *   quiz.js / assign.js wait 2 / 5 / 10 / 20 s (randomised) and resend the SAME
 *   record, showing "Still saving ..." instead of an error.
 *
 * ---- Password reset (added) ---------------------------------------------
 * - "Forgot password?" on the login step calls action "reset_password" with
 *   the student's phone, their parent's phone number, and the NEW password's
 *   hash. If the parent number matches the one on file (last 10 digits), the
 *   password_hash cell is replaced — that and the session_token (rotated, so
 *   old sessions are signed out) are the only cells touched. QuizResults,
 *   Submissions, name, year, parent_phone, everything else stays as it was.
 * - 5 wrong parent numbers per student locks resets for that student for an
 *   hour (CacheService), so the number can't be guessed by trial and error.
 * - Login has its own limit: 10 wrong passwords for one account pauses login
 *   for that account for 30 minutes (CacheService). "Forgot password?" still
 *   works while login is paused. An admin account that gets locked simply
 *   waits out the 30 minutes.
 * - Never available for is_admin accounts (fix those by hand in the Sheet),
 *   and not for accounts with no parent_phone on file, or one that's the
 *   student's own number — type the parent's number into the parent_phone
 *   column of that row and the link works for them.
 *
 * ---- Sheet safety, phone numbers, weekly backup (added) -------------------
 * - Text columns are stored EXACTLY as typed. Sheets used to reinterpret what
 *   was written (a name "123" became a number, a parent phone lost its leading
 *   0, a note starting with "=" became a formula). Every text-like column is
 *   now forced to Plain Text on write (PLAIN_TEXT_HEADERS), and everything sent
 *   back out to the site is coerced to text (_cellOut), so old rows that were
 *   already converted still reach the pages as text.
 * - The Students tab is found by a remembered tab id (falls back to a tab named
 *   "Students", then the first tab) — adding or re-ordering tabs no longer
 *   changes which tab is "Students". Its columns are found by HEADER NAME, so
 *   inserting or re-ordering columns is safe. A missing core header gives a
 *   readable error instead of writing into the wrong cell.
 * - Phone numbers: Arabic-Indic digits are converted, +20 / 0020 / a missing
 *   leading 0 all mean the same number, and two numbers are "the same person"
 *   only when their last 10 digits are equal (was: also whenever one number
 *   was the 7+ digit tail of another, so a short or partial number could
 *   match a stranger). check_student now returns only the first name.
 * - weeklyBackup() copies the spreadsheet(s) into a Drive folder and keeps the
 *   last 4. Run installWeeklyBackupTrigger() once to schedule it.
 *
 *   ONE-TIME STEPS after pasting this version (editor -> function dropdown ->
 *   Run; Apps Script will ask you to authorise the new "triggers" permission):
 *     1. findPhoneCollisions()        read-only. Run it BEFORE deploying the new
 *                                     version — it compares the old and new
 *                                     phone-matching rules on your real data.
 *     2. auditSheets()                read-only. Lists cells Sheets already
 *                                     converted (numbers in names, formulas,
 *                                     phones missing their 0).
 *     3. setupSheets()                formats the text columns. Safe to re-run.
 *     4. repairSheets()               backs the spreadsheet up first, then turns
 *                                     numbers back into text and restores dropped
 *                                     phone zeros. Formulas / dates are only
 *                                     listed — fix those by hand.
 *     5. installWeeklyBackupTrigger() schedules weeklyBackup() (Sundays, ~3am).
 *   Then Deploy -> Manage deployments -> pencil -> New version.
 *
 * ---- Video lock (added) ---------------------------------------------------
 * - Lesson videos no longer live in the page HTML. Each one is a row in a
 *   "Videos" tab (created on first use, in the Students spreadsheet): lesson
 *   (path, e.g. programming/other/functions), slot (lesson | quiz | assignment
 *   = index.html | quiz.html | assignment.html), embed_url, locked, updated_at.
 * - get_video {lesson, slot, student_id?, session_token?} is what a page calls.
 *   Unlocked video: anyone gets embed_url. Locked video: the URL is only sent to
 *   an admin session (the teacher previewing); everyone else gets
 *   {locked:true, need:"login"|"payment"} and NO url (a student with an active
 *   entitlement, see "Access" below, gets it too). The lock FAILS CLOSED: only
 *   an explicit FALSE in the locked cell opens a video; blank/typo stays locked.
 * - admin_set_video {lesson, slot, video_url?, locked?} adds/updates/clears a
 *   slot (video_url "" clears it). New videos start LOCKED. admin_list_videos
 *   lists them all. Both take EITHER the desktop app's ADMIN_TOKEN ("token")
 *   OR an admin session (student_id + session_token).
 * - Looked-up rows are cached for VIDEO_CACHE_SECONDS; admin_set_video clears the
 *   cache entry at once, but flipping the locked cell by hand in the Sheet can
 *   take up to that long to show.
 *
 * ---- Access: who has paid for what (added) --------------------------------
 * - "Entitlements" tab (Students spreadsheet): phone | scope | expires_at |
 *   granted_at | source. scope is ONE lesson path (covers that lesson's three
 *   videos), or "some/folder/*" (everything under it, e.g. a whole grade), or "*"
 *   (everything). expires_at is a Cairo date "2026-12-31" (access lasts through
 *   that whole day); BLANK = never expires; anything unreadable = no access.
 *   You can add/edit/delete rows by hand in the Sheet: that is a valid way to
 *   unlock someone (e.g. after a cash payment).
 * - "Payments" tab: payment_id | phone | name | scope | reference | note | status |
 *   created_at | decided_at. status: pending / approved / rejected.
 * - request_access {student_id, session_token, lesson, reference, note?} is the
 *   student's "I paid" button. It only adds a PENDING row (nothing unlocks yet),
 *   is idempotent while one is pending, and a student may have at most
 *   MAX_PENDING_REQUESTS waiting.
 * - admin_list_payments {status?}, admin_decide_payment {payment_id, decision:
 *   "approve"|"reject", scope?, expires_at?, days?}, admin_grant_access {phone,
 *   scope, expires_at?, days?}: desktop token OR admin session, like the video
 *   actions. Approving writes the entitlement; a grant NEVER shortens access the
 *   student already has (renewals add to the later of today / current expiry).
 * - How long a grant lasts: expires_at, else days, else the DEFAULT_ACCESS_DAYS
 *   Script Property, else it never expires.
 * - A grant made by approving a payment remembers that payment (source =
 *   "payment:<id>"). If that payment's status is later changed to ANYTHING but
 *   "approved" — by hand in the Payments tab (approved -> rejected), or by
 *   admin_revoke_access, which writes "revoked" — the access stops at once.
 *   (Deleting the Payments row does NOT revoke it; a grant whose source is
 *   "manual" is only ended by deleting its row or by admin_revoke_access.)
 * - admin_revoke_access {phone, scope} (or {payment_id}) deletes that student's
 *   entitlement row(s) and marks the payment behind it "revoked". It never
 *   touches other scopes: a student who also holds "folder/*" keeps that.
 * - admin_access_overview returns everything the access dashboard
 *   (dashboard/access.html) shows in one call: counts, videos, every payment
 *   request, and every entitlement with its student's name and a plain state
 *   (active / expired / cancelled / invalid) and days left.
 * - Approve / grant take {never:true} to force "never expires" (otherwise the
 *   DEFAULT_ACCESS_DAYS property would apply when no term is given).
 * - What the lock box tells people about paying ("Send 200 EGP to 010… then tap
 *   I paid") is the PAY_INSTRUCTIONS Script Property (plain text, max 1000
 *   characters). get_video returns it as pay_info with every locked answer that
 *   has no URL, so you can change it any time without touching the site.
 *
 * ---- Quiz gate (added) -----------------------------------------------------
 * - Separate from the video lock: a "Quizzes" tab (lesson | locked | updated_at)
 *   controls whether a lesson's QUIZ ITSELF can be opened and submitted, for
 *   locking it until the actual test time. A lesson with NO row here behaves
 *   exactly as before (open) — this only applies once you explicitly gate a
 *   lesson, and a newly-gated lesson starts LOCKED.
 * - get_quiz_state {lesson} (public) -> {locked}. admin_set_quiz_lock
 *   {lesson, locked} creates/updates the row (desktop token or admin session).
 * - upload_quiz_result is refused server-side while locked ("retryable" is NOT
 *   set — resending the same attempt would just fail again), so a page left
 *   open from before the lock can't sneak a submission through. get_quiz_state
 *   is what quiz.js checks before showing the quiz at all. Cached briefly like
 *   the video lock; admin_set_quiz_lock clears the cache at once.
 *
 * ---- Lesson lock (added) -----------------------------------------------------
 * - A "Lessons" tab (lesson | locked | updated_at), same shape/convention as the
 *   Quizzes tab: no row = open, a newly-gated lesson starts LOCKED, fails closed
 *   on a damaged tab. Locks the WHOLE lesson without needing a video to exist
 *   first — admin_set_lesson_lock {lesson, locked}.
 * - Only ADDS restriction: get_video's effective lock is
 *   (that video's own "locked" cell) OR (its lesson locked here). Unlocking the
 *   lesson never opens a video that was locked on its own; locking the lesson
 *   locks every video under it even if none has been toggled individually, and
 *   a video added afterward is born locked (it already starts locked by
 *   default, and this makes locking-the-lesson-first the normal way to gate a
 *   lesson before its video even exists).
 * - get_video now answers found:true (with need:"login"/"payment", no_video:true)
 *   for a lesson locked this way even when it has NO video row at all, so
 *   video.js shows a lock box instead of silently showing nothing. Admin
 *   preview is the one exception: with no video row, an admin gets found:false
 *   (nothing to preview, and they already see the lock state on the dashboard).
 * - Deliberately separate from the Quiz gate above: locking/unlocking a lesson
 *   never touches its Quizzes row. A locked quiz stays locked even when its
 *   lesson is unlocked, and an open quiz stays open even when its lesson is
 *   locked — the quiz gate always overrides the lesson-wide setting for the quiz
 *   specifically. Use the lesson lock for "can they get into this lesson at
 *   all" and the quiz gate for "can the quiz be submitted right now."
 *
 * ---- Student groups (added) ------------------------------------------------
 * - A "Groups" tab (group | phone | name | added_at): one row per membership,
 *   so a student can be in several groups. admin_group_add / admin_group_remove
 *   manage membership; admin_list_groups lists every group with its members
 *   (name/known_student joined from Students, same as the access overview).
 * - admin_group_grant_access / admin_group_revoke_access apply
 *   admin_grant_access / admin_revoke_access to every member of a group in one
 *   call. Revoking is quiet about members who don't hold that access — it
 *   skips them rather than failing the whole batch.
 * - Groups are RETROACTIVE: a grant made to a group is also remembered in a
 *   "GroupGrants" tab (group_key | group | kind | target | expires_at | granted_at;
 *   kind = access (target = scope) or quiz (target = lesson)). Adding a student to
 *   the group later applies every live group grant to them, ending on the SAME date
 *   the group's grant ends (an already-ended grant is skipped). Revoking from the
 *   group deletes the remembered grant too. Removing a student does NOT take their
 *   access away (revoke it by hand if you want that). A group that loses its last
 *   member forgets its grants.
 * - Group names are matched without regard to case/spacing ("Grade 2" and
 *   "grade  2" are the same group); the first spelling used is kept for
 *   display so every row of one group reads the same way.
 *
 * ---- Follow-up dashboard (added; dashboard/followup.html) ---------------------
 * Four tabs, all created lazily by _sheetByName the first time they're needed:
 *   "Attendance"        lesson | phone | mode | marked_at
 *                       One row per (lesson path, student). mode = center | online.
 *                       No row = unmarked.
 *   "WatchProgress"     phone | lesson | pct | duration_s | first_at | updated_at
 *                       One row per (student, lesson path). pct = the most the
 *                       player ever reported (0-100); it only goes up.
 *   "GroupSettings"     group_key | group | weekday | time | current_lesson |
 *                       review_lessons | note | parents_contacted |
 *                       watch_deadline_override | hw_deadline_override | updated_at
 *                       One row per WhatsApp group (= a Groups tab group). weekday
 *                       0=Sun..6=Sat, time "HH:MM" Cairo, current_lesson = one full
 *                       lesson path (attendance + watch + free center unlock),
 *                       review_lessons = JSON array of lesson paths (union of homework + quiz). hw_lessons / quiz_lessons = optional JSON arrays (blank = follow review_lessons).
 *   "FollowupTemplates" key | body | updated_at   (saved overrides only; a missing
 *                       row = the built-in default wording kept in the page)
 * - admin_followup_overview {} -> raw facts for every group's lessons in ONE round
 *   trip (no verdicts: the rules live in assets/followup-logic.js). Each sheet is
 *   read once and access is worked out in memory — it never calls _accessState in a
 *   loop. Quiz/homework rows join on student phone + the lesson's last path segment
 *   (the "slug"), and on subject too when the row has one.
 * - admin_followup_set_attendance {lesson, items:[{phone, mode}], grant?} saves the
 *   attendance radio. "center" also gives that student free video + quiz access for
 *   the lesson (rows with source "attendance", never expiring) UNLESS they already
 *   hold live access that covers it; "online" or "" removes ONLY source "attendance"
 *   rows, never a paid, manual or group grant.
 * - admin_followup_save_group / admin_followup_save_templates edit the two settings
 *   tabs. record_watch {lesson, pct, duration_s} is the STUDENT's player reporting
 *   progress (max-merged, throttled, ignored while the video is locked for them).
 *
 * ---- Redeploying after editing this file --------------------------------
 * Apps Script Web Apps don't auto-update on save. After changing this
 * file: Deploy → Manage deployments → pencil (edit) → Version: "New
 * version" → Deploy. Picking "New deployment" instead mints a brand new
 * URL and breaks every page still pointing at the old one.
 * ------------------------------------------------------------------------
 */

function _props() {
  return PropertiesService.getScriptProperties();
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Telegram ping to the admin. Needs Script Properties TELEGRAM_BOT_TOKEN and
// TELEGRAM_ADMIN_CHAT_ID (one id, or several separated by commas); silently does
// nothing if either is missing. Never throws, so a Telegram outage can't fail a
// student's request. Call it OUTSIDE _withLock.
// paymentId (optional) adds Approve / Reject buttons under the message.
function _notifyAdmin(text, paymentId) {
  try {
    var p = _props();
    var token = p.getProperty("TELEGRAM_BOT_TOKEN");
    var chat = p.getProperty("TELEGRAM_ADMIN_CHAT_ID");
    if (!token || !chat) return;
    var body = { text: String(text).slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true };
    if (paymentId) {
      body.reply_markup = { inline_keyboard: [[
        { text: "\u2705 Approve", callback_data: "ap:" + paymentId },
        { text: "\u274c Reject", callback_data: "rj:" + paymentId },
      ]] };
    }
    _tgAdminIds().forEach(function (id) {
      try {
        body.chat_id = id;
        _tgCall("sendMessage", body);
      } catch (err) {
        console.error("notifyAdmin failed for " + id + ": " + err);
      }
    });
    if (paymentId) {   // P4/S6: also ping linked teachers whose subject covers this payment (never throws)
      try { if (typeof p4_tg_notifyPayment === "function") p4_tg_notifyPayment(paymentId); } catch (e) {}
    }
  } catch (err) {
    console.error("notifyAdmin failed: " + err);
  }
}

// Text goes to Telegram as HTML, so anything a student typed must be escaped.
function _esc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// "programming/baccalaureate/grade-1-secondary/loops-intro" -> "Grade 1 Secondary \u203a Loops Intro"
function _prettyLesson(path) {
  var parts = String(path || "").split("/").filter(function (x) {
    return x && x !== "programming" && x !== "baccalaureate";
  });
  return parts.map(function (x) {
    return x.replace(/[-_]+/g, " ").replace(/\b\w/g, function (ch) { return ch.toUpperCase(); });
  }).join(" \u203a ") || String(path || "");
}

// Telegram pings for a finished homework / quiz. Called OUTSIDE the lock, only for a
// freshly saved attempt (never a duplicate). _notifyAdmin never throws.
function _notifySubmission(payload, res) {
  try {
    if (!res || !res.ok || res.duplicate) return;
    var lesson = _prettyLesson(payload.lesson_path || payload.lesson);
    var score = typeof payload.score === "number" && typeof payload.total === "number"
      ? "\n\ud83c\udfaf " + payload.score + "/" + payload.total : "";
    var kind = "\ud83d\udcdd <b>Homework submitted</b>";
    var how = payload.submission_type ? "\n\ud83d\udce6 " + _esc(payload.submission_type) : "";
    _notifyAdmin(kind + "\n\n\ud83d\udc64 " + _esc(payload.name || payload.student_id) +
      "\n\ud83d\udcd8 " + _esc(lesson) + score + how);
  } catch (err) {
    console.error("notifySubmission failed: " + err);
  }
}

function _notifyQuiz(payload, res) {
  try {
    if (!res || !res.ok || res.duplicate) return;
    var lesson = _prettyLesson(payload.lesson_path || payload.lesson);
    var score = typeof payload.score === "number" && typeof payload.total === "number"
      ? "\n\ud83c\udfaf " + payload.score + "/" + payload.total : "";
    _notifyAdmin("\ud83e\udde0 <b>Quiz completed</b>\n\n\ud83d\udc64 " + _esc(payload.name || payload.student_id) +
      "\n\ud83d\udcd8 " + _esc(lesson) + (payload.quiz_title ? " \u2014 " + _esc(payload.quiz_title) : "") + score);
  } catch (err) {
    console.error("notifyQuiz failed: " + err);
  }
}

function _tgAdminIds() {
  return String(_props().getProperty("TELEGRAM_ADMIN_CHAT_ID") || "")
    .split(",").map(function (x) { return x.trim(); }).filter(Boolean);
}

function _tgCall(method, body) {
  var token = _props().getProperty("TELEGRAM_BOT_TOKEN");
  return UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
}

// Telegram webhook entry: a tap on Approve / Reject. Two checks before anything
// happens: the webhook URL must carry ?tg=<TELEGRAM_WEBHOOK_SECRET>, and the tapper
// must be one of the ids in TELEGRAM_ADMIN_CHAT_ID. Always returns ok so Telegram
// doesn't retry.
function handleTelegramUpdate(e, update) {
  try {
    var secret = _props().getProperty("TELEGRAM_WEBHOOK_SECRET");
    if (!secret || !e || !e.parameter || e.parameter.tg !== secret) return _json({ ok: true });
    if (typeof p4_tg_handleUpdate === "function" && p4_tg_handleUpdate(update)) return _json({ ok: true });   // P4/S6: teacher /start links and teacher-chat taps
    var cq = update && update.callback_query;
    if (!cq || !cq.from || !cq.data) return _json({ ok: true });

    // ap:/rj: = payment approve/reject (payments bot); ad:/dd: = attendance device approve/deny (attendance bot, AttTelegram.gs).
    // FU2: fu: = follow-up notification buttons (snooze / done), handled by fu2_notify_telegramCallback_ (FollowupNotify.gs).
    var m = /^(ap|rj|ad|dd|fu):(\S+)$/.exec(String(cq.data));
    if (!m) return _json({ ok: true });
    var isAtt = m[1] === "ad" || m[1] === "dd";
    var isFu = m[1] === "fu";   // FU2:
    var adminIds = isAtt ? attt_adminIds_() : _tgAdminIds();
    var call = isAtt ? attt_call_ : _tgCall;
    if (adminIds.indexOf(String(cq.from.id)) === -1) return _json({ ok: true });

    // Apps Script answers a POST with a redirect, which Telegram counts as a failure and
    // RETRIES. Each update_id is handled once; retries are ignored.
    var seenKey = "tgu:" + update.update_id, cache = CacheService.getScriptCache();
    if (cache.get(seenKey)) return _json({ ok: true });
    cache.put(seenKey, "1", 21600);
    var approve = m[1] === "ap" || m[1] === "ad";
    console.log("telegram tap: " + m[1] + " " + m[2] + " from " + cq.from.id);
    // Clear the button spinner FIRST — the sheet work below can take several seconds
    // and Telegram drops the spinner-clearing call if it comes too late.
    call("answerCallbackQuery", { callback_query_id: cq.id });
    var chatId = cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id;
    try {
      var verdict;
      if (isFu) {   // FU2: returns the verdict line itself, never throws
        verdict = typeof fu2_notify_telegramCallback_ === "function" ? fu2_notify_telegramCallback_(cq) : "Not available.";
      } else if (isAtt) {
        verdict = att_decideFromTelegram_(m[2], approve);   // returns the verdict line itself, never throws
      } else {
        handleAdminDecidePayment({
          token: _props().getProperty("ADMIN_TOKEN"),
          payment_id: m[2],
          decision: approve ? "approve" : "reject",
        });
        verdict = approve ? "\u2705 Approved" : "\u274c Rejected";
      }
      if (cq.message) {
        call("editMessageText", {
          chat_id: chatId, message_id: cq.message.message_id,
          text: String(cq.message.text || "") + "\n\n" + verdict,
          entities: cq.message.entities || [],
        });
      } else {
        call("sendMessage", { chat_id: chatId, text: verdict });
      }
    } catch (err) {
      console.error("telegram decision failed: " + err);
      var msg = String(err.message || err);
      if (!/already (approved|rejected|revoked)/i.test(msg)) {   // a stale tap is not worth a message
        call("sendMessage", { chat_id: chatId, text: "\u26a0\ufe0f " + msg.slice(0, 300) });
      }
    }
  } catch (err) {
    console.error("telegram update failed: " + err);
  }
  return _json({ ok: true });
}

function _requireAdmin(payload) {
  if (typeof p4_tokenAllows === "function" && p4_tokenAllows(payload)) return;
  var expected = _props().getProperty("ADMIN_TOKEN");
  if (!expected || payload.token !== expected) {
    throw new Error("Not authorized.");
  }
}

function _folder(propName) {
  var id = _props().getProperty(propName);
  if (!id) throw new Error(propName + " isn't set in Script Properties.");
  return DriveApp.getFolderById(id);
}

// Right under a Sheets cell's ~50,000-character cap — used to decide
// whether a text submission fits inline in the Submissions sheet or needs
// a truncated preview (full text always still lives in the Drive JSON).
var TEXT_CELL_LIMIT = 49000;

var TZ = "Africa/Cairo";

// Columns written as Plain Text so Sheets never reinterprets them
// (dates -> Date cells, phone digits -> numbers with the leading 0 lost).
var TEXT_COLS = { student_id: 1, date: 1, start_time: 1, end_time: 1, submitted_time: 1 };
var TIME_COLS = { start_time: 1, end_time: 1, submitted_time: 1 };

// Every column whose content must be stored EXACTLY as typed. When a row is
// written these cells are set to Plain Text first, so Sheets can't turn "123"
// into a number, "01111111111" into 1111111111, "1/2" into a date, or a note
// that starts with "=" / "+" / "-" / "@" into a formula. Numeric columns
// (score, total) and the JSON columns are deliberately NOT listed.
var PLAIN_TEXT_HEADERS = {
  // Students
  phone: 1, password_hash: 1, display_name: 1, created_at: 1, session_token: 1, year: 1, parent_phone: 1,
  // QuizResults + Submissions
  student_id: 1, name: 1, subject: 1, lesson: 1, quiz_title: 1, submission_type: 1,
  text: 1, url: 1, note: 1, file_id: 1, file_name: 1,
  date: 1, start_time: 1, end_time: 1, submitted_time: 1, dedupe_key: 1,
  // Videos ("locked" is deliberately NOT here: it is a TRUE/FALSE cell)
  slot: 1, embed_url: 1, updated_at: 1,
  // Entitlements + Payments (phone/name/scope-like text must never be reinterpreted)
  scope: 1, expires_at: 1, granted_at: 1, source: 1,
  payment_id: 1, reference: 1, status: 1, decided_at: 1,
  // Groups
  group: 1, added_at: 1,
  // GroupGrants
  group_key: 1, kind: 1, target: 1,
  // Attendance + WatchProgress + GroupSettings + FollowupTemplates ("18:00" must not become a time cell)
  mode: 1, marked_at: 1, first_at: 1, time: 1,
  current_lesson: 1, review_lessons: 1, hw_lessons: 1, quiz_lessons: 1, watch_deadline_override: 1, hw_deadline_override: 1,
  key: 1, body: 1,
};
// Of those, the ones that hold phone numbers (a leading 0 is easily lost).
var PHONE_HEADERS = { phone: 1, parent_phone: 1, student_id: 1 };

function _fmt(d, tz, withTime) {
  return Utilities.formatDate(d, tz, withTime ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd");
}

// Any timestamp (browser ISO string, Date cell, or already-formatted text)
// -> "yyyy-MM-dd HH:mm:ss" in Cairo time. Anything unparseable is returned
// as-is rather than guessed at.
function _cairoTime(v) {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date) return _fmt(v, TZ, true);
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return _fmt(d, TZ, true);
  }
  return s;
}

function _cairoDate(v) {
  var t = _cairoTime(v);
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : "";
}

// Last 10 digits — survives a dropped leading 0 or a +20 prefix, so the same
// student always lands on the same duplicate key.
function _phoneKey(s) {
  return _normalizePhone(s).slice(-10);
}

function _md5(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join("");
}

// Serialises the check-then-write so two near-simultaneous requests for the
// same attempt can't both pass the duplicate check. Keep whatever runs inside
// `fn` SHORT (sheet reads/writes only — never Drive file creation), because
// everyone else who needs the lock waits for it.
//
// If the lock can't be had in time the error is marked `retryable`: doPost
// turns that into {ok:false, retryable:true}, and quiz.js / assign.js wait a
// moment and send the SAME record again (safe — the server dedupes on
// client_id). Errors thrown by `fn` itself are never marked retryable.
var LOCK_WAIT_MS = 30000;
var UPLOAD_LOCK_WAIT_MS = 20000;   // quiz/submission uploads: give up sooner so the
                                   // request stops occupying one of Apps Script's
                                   // ~30 concurrent execution slots, and let the
                                   // browser retry with a short random back-off

function _withLock(fn, waitMs) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(waitMs || LOCK_WAIT_MS);
  } catch (e) {
    var busy = new Error("The server is busy right now \u2014 please try again in a moment.");
    busy.retryable = true;
    throw busy;
  }
  try { return fn(); } finally { lock.releaseLock(); }
}

// -- Students / QuizResults / Submissions sheets -----------------------------
// One spreadsheet (STUDENTS_SHEET_ID) holds three tabs: the original
// Students tab (first tab, whatever it's named — untouched reference so
// existing rows are never orphaned), plus QuizResults and Submissions
// (created automatically on first use). Dashboards read QuizResults/
// Submissions directly — Code.gs never needs to open individual Drive
// JSON files to answer a dashboard query.

function _ss() {
  var id = _props().getProperty("STUDENTS_SHEET_ID");
  if (!id) throw new Error("STUDENTS_SHEET_ID isn't set in Script Properties.");
  return SpreadsheetApp.openById(id);
}

// QuizResults/Submissions grow every time a student takes a quiz or
// submits homework — each row can carry a sizeable questions_json/
// answers_json blob. SpreadsheetApp.openById() has to load the whole
// workbook, so once that data piles up, EVERY action gets slower —
// including a plain login/check_student that only ever touches the
// Students tab. DATA_SHEET_ID lets those two tabs live in their own
// spreadsheet instead, so opening the (small, fast) Students file for
// login never drags the (large, ever-growing) quiz data along with it.
//
// This is optional and backward-compatible: if DATA_SHEET_ID isn't set
// in Script Properties, QuizResults/Submissions just stay in the
// Students spreadsheet, exactly like before — nothing breaks if you
// don't migrate. See DEPLOY.md for the one-time migration steps.
function _dataSs() {
  var id = _props().getProperty("DATA_SHEET_ID");
  return id ? SpreadsheetApp.openById(id) : _ss();
}

// Creates the tab (with header row) on first use if it doesn't exist yet.
function _sheetByName(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  return sheet;
}

function _quizResultsSheet() {
  var sheet = _sheetByName(_dataSs(), "QuizResults", [
    "student_id", "name", "subject", "lesson", "quiz_title",
    "date", "start_time", "end_time", "score", "total", "questions_json",
    "dedupe_key",
  ]);
  _ensureColumns(sheet, ["dedupe_key"]);
  return sheet;
}

function _submissionsSheet() {
  var sheet = _sheetByName(_dataSs(), "Submissions", [
    "student_id", "name", "subject", "lesson", "submission_type",
    "text", "text_truncated", "url", "note", "file_id", "file_name",
    "date", "submitted_time", "score", "total", "answers_json", "dedupe_key",
  ]);
  _ensureColumns(sheet, ["score", "total", "answers_json", "dedupe_key"]);
  return sheet;
}

// Appends any missing header to a sheet that predates it, without touching
// already-written rows — same additive pattern as _ensureStudentColumns.
function _ensureColumns(sheet, cols) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  cols.forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });
}

function _headerIndex(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idx = {};
  headers.forEach(function (h, i) { if (h !== "" && !idx.hasOwnProperty(h)) idx[h] = i + 1; }); // 1-based, FIRST occurrence
  return idx;
}

// Writes one row by header NAME (so column order never matters), with every
// PLAIN_TEXT_HEADERS cell forced to Plain Text first (one API call, whatever
// the column count). Returns the 1-based row number it wrote.
function _appendByHeader(sheet, rec) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var seenH = {};
  var row = headers.map(function (h) {
    if (h === "" || seenH[h]) return "";       // a repeated header name is never filled twice
    seenH[h] = true;
    return rec.hasOwnProperty(h) && rec[h] !== null && rec[h] !== undefined ? rec[h] : "";
  });
  var r = sheet.getLastRow() + 1;
  // appendRow() used to add rows on demand; writing straight to getLastRow()+1
  // does not — it throws once the row is past the sheet's grid (tidySheets()
  // trims the grid to data + 20 spare rows, and a new sheet only has 1000).
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, r - sheet.getMaxRows()));
  _setPlainTextFormats(sheet, r, headers);
  sheet.getRange(r, 1, 1, headers.length).setValues([row]);
  return r;
}

// Forces the PLAIN_TEXT_HEADERS cells of one row to Plain Text ("@") in a
// single call, BEFORE a value is written into them.
function _setPlainTextFormats(sheet, row, headers) {
  var cells = [], seen = {};
  headers.forEach(function (h, i) {
    if (PLAIN_TEXT_HEADERS[h] && !seen[h]) { seen[h] = true; cells.push(_colLetter(i + 1) + row); }
  });
  if (cells.length) sheet.getRangeList(cells).setNumberFormat("@");
}

function _colLetter(n) {
  var s = "";
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Keys already stored in the sheet's dedupe_key column, as a lookup set.
function _existingKeys(sheet) {
  var col = _headerIndex(sheet)["dedupe_key"];
  var last = sheet.getLastRow();
  var set = {};
  if (!col || last < 2) return set;
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (r) {
    if (r[0]) set[String(r[0])] = true;
  });
  return set;
}

// Candidate keys for "have we already stored this?". The FIRST one is what
// gets stored. With a client_id it's exact. Without one (a page still
// running the old cached JS) a quiz falls back to student+lesson+start time
// (identical on any re-send of the same attempt), and a submission to
// student+lesson+type+content hash inside a ~2-4 minute window.
function _quizKeys(p) {
  if (p.client_id) return ["c:" + String(p.client_id).slice(0, 100)];
  return ["q:" + [_phoneKey(p.student_id), p.subject, p.lesson, p.start_time].join("|")];
}

function _submissionKeys(p) {
  if (p.client_id) return ["c:" + String(p.client_id).slice(0, 100)];
  var content = p.submission_type === "graded" ? JSON.stringify(p.answers || [])
    : p.submission_type === "url" ? (p.url || "")
    : p.submission_type === "file" ? ((p.filename || "") + ":" + String((p.data_base64 || "").length))
    : (p.text || "");
  var base = ["s", _phoneKey(p.student_id), p.subject, p.lesson, p.submission_type, _md5(content)].join("|");
  var t = new Date(p.submitted_time).getTime();
  if (isNaN(t)) return [base];
  var bucket = Math.floor(t / 120000);
  return [base + "|" + bucket, base + "|" + (bucket - 1)];
}

function _anySeen(seen, keys) {
  return keys.some(function (k) { return seen[k]; });
}

// One cell coming OUT to the dashboards. Date cells (Sheets auto-converted
// them at some point) become readable Cairo text instead of a JSON ISO
// timestamp; ISO strings in time columns get the same treatment. Text columns
// always leave as TEXT, even if Sheets turned the value into a number: a name
// typed as "123" reaches the site as "123", not the number 123 (which used to
// crash the sign-in widget), and a phone that lost its leading 0 gets it back.
function _cellOut(header, v, sheetTz) {
  if (v instanceof Date) {
    if (header === "date") return _fmt(v, sheetTz, false);
    if (header === "created_at") return _fmt(v, sheetTz, true);
    return _fmt(v, TZ, true);
  }
  if (typeof v === "string" && TIME_COLS[header]) return _cairoTime(v);
  if (PLAIN_TEXT_HEADERS[header] && (typeof v === "number" || typeof v === "boolean")) {
    return PHONE_HEADERS[header] ? _restoreLeadingZero(String(v)) : String(v);
  }
  if (PHONE_HEADERS[header] && typeof v === "string") return _restoreLeadingZero(v.trim());
  return v;
}

// Shared by both dashboard-facing actions: turns a sheet's rows into
// [{header: value}, ...] using row 1 as keys.
function _sheetValuesAsObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var sheetTz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  return values.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) {
      if (h === "") return;
      var v = _cellOut(h, row[i], sheetTz);
      if (!obj.hasOwnProperty(h) || obj[h] === "" || obj[h] === null) obj[h] = v;
    });
    return obj;
  });
}

// The Students tab. Found by a remembered tab id, NOT by position, so adding or
// re-ordering tabs in the spreadsheet can't change which tab is "Students".
// First use pins it: the tab named "Students" if there is one, otherwise the
// first tab (what older versions always used). If the pinned tab has been
// deleted we stop with a clear message rather than silently guess another tab.
function _studentsSheet() {
  var ss = _ss();
  var sheets = ss.getSheets();
  var props = _props();
  var pin = props.getProperty("STUDENTS_TAB_PIN") || "";   // "<spreadsheet id>|<tab id>"
  var parts = pin.split("|");
  if (parts.length === 2 && parts[0] === ss.getId()) {
    for (var i = 0; i < sheets.length; i++) {
      if (String(sheets[i].getSheetId()) === parts[1]) return sheets[i];
    }
    throw new Error("The Students tab is missing from the spreadsheet (it may have been deleted or moved). " +
      "Restore it from a backup, or clear the STUDENTS_TAB_PIN script property to pick a tab again.");
  }
  var sheet = ss.getSheetByName("Students") || sheets[0];
  props.setProperty("STUDENTS_TAB_PIN", ss.getId() + "|" + sheet.getSheetId());
  return sheet;
}

// Reading/writing the Students tab. The header row is created on first use,
// and any of the later-added columns are appended if the tab predates them.
// Nothing here formats cells any more — that used to re-format the ENTIRE
// phone column on every request. Formatting is done by setupSheets() (once)
// and per row by _appendByHeader() when a row is written.
function _students() {
  var sheet = _studentsSheet();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["phone", "password_hash", "display_name", "created_at", "session_token", "is_admin", "year", "parent_phone"]);
  } else {
    _ensureStudentColumns(sheet);
  }
  return sheet;
}

// Adds session_token/is_admin headers to a Students sheet that predates
// this change, without touching any already-registered rows. Set
// is_admin to TRUE on your own row by hand in the Sheet UI — nothing
// web-facing ever writes that column.
function _ensureStudentColumns(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  // "year" and "parent_phone" added later than session_token/is_admin —
  // same additive pattern: each appends as a new column, never touches
  // existing rows. Blank for anyone who registered before the field
  // existed; the dashboard treats a blank value as "unknown", not a guess.
  ["session_token", "is_admin", "year", "parent_phone"].forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
    }
  });
}

// Header name -> 1-based column number for the Students tab, so nothing depends
// on column ORDER (you can insert a "Notes" column, or drag columns around).
// A missing core header is a readable error, never a silent write to the wrong cell.
var STUDENT_CORE_COLS = ["phone", "password_hash", "display_name", "session_token"];

function _studentCols(headers) {
  var c = {};
  headers.forEach(function (h, i) {
    h = String(h).trim();
    if (h !== "" && !c.hasOwnProperty(h)) c[h] = i + 1;     // first occurrence wins
  });
  STUDENT_CORE_COLS.forEach(function (n) {
    if (!c[n]) {
      throw new Error('The Students sheet is missing the "' + n + '" column (renamed or deleted?). ' +
        "Restore it from a backup or put the header back.");
    }
  });
  return c;
}

function _isTruthyFlag(v) {
  return v === true || String(v).toUpperCase() === "TRUE";
}

// -- Phone numbers -------------------------------------------------------------
// Digits only. Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits are
// converted to 0-9 first: a student on an Arabic keyboard types the former, and
// stripping "everything that isn't 0-9" used to leave them with no number at all.
// The stored phone column keeps whatever the student typed, so this is only
// the lenient match key. Mirrored by normalizeDigits() in auth.js.
function _normalizePhone(s) {
  return String(s == null ? "" : s)
    .replace(/[\u0660-\u0669]/g, function (d) { return d.charCodeAt(0) - 0x0660; })
    .replace(/[\u06F0-\u06F9]/g, function (d) { return d.charCodeAt(0) - 0x06F0; })
    .replace(/[^0-9]/g, "");
}

// The one canonical form we STORE for an Egyptian mobile: 01XXXXXXXXX.
// "+20 101 234 5678", "0020 1012345678", "201012345678", "+2001012345678" and
// "1012345678" (leading 0 lost) all become "01012345678". Anything that doesn't
// look like an Egyptian mobile (a landline, a foreign number) is returned as
// plain digits, unchanged. Mirrored by canonicalPhone() in auth.js.
function _canonicalPhone(s) {
  var d = _normalizePhone(s);
  var m = /^(?:0020|20)(0?1\d{9})$/.exec(d);
  if (m) d = m[1];
  if (/^1[0125]\d{8}$/.test(d)) d = "0" + d;
  return d;
}

// An Egyptian mobile stored as a number loses its leading 0 (1012345678).
function _restoreLeadingZero(s) {
  var t = String(s);
  return /^1[0125]\d{8}$/.test(t) ? "0" + t : t;
}

function _firstName(n) {
  return String(n == null ? "" : n).trim().split(/\s+/)[0] || "";
}

// Two phone numbers are the same student when they are identical, or — for
// numbers of 10+ digits — when their LAST 10 digits are equal. That still
// survives the leading-0 drop ("1012345678" vs "01012345678") and a country
// code ("+20…" vs "0…"). A short or partial number (7-9 digits) that merely
// happens to be the tail of someone else's number is no longer treated as
// that person (the old rule did, so a typo could open a stranger's account
// page). Shorter numbers from older accounts must match exactly.
function _phonesMatch(a, b) {
  var da = _normalizePhone(a), db = _normalizePhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length < 10 || db.length < 10) return false;
  return da.slice(-10) === db.slice(-10);
}

// The OLD rule (identical, or one number is the 7+ digit tail of the other). Kept ONLY so
// findPhoneCollisions() can show what changes on your real data.
function _phonesMatchLegacy(a, b) {
  var da = _normalizePhone(a), db = _normalizePhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  var shorter = da.length <= db.length ? da : db;
  var longer = da.length <= db.length ? db : da;
  return shorter.length >= 7 && longer.slice(-shorter.length) === shorter;
}

// Returns {row, cols, phone, password_hash, display_name, created_at,
// session_token, is_admin, year, parent_phone} for the first matching row
// (1-indexed, header is row 1), or null. `cols` is the header -> column map, so
// callers write with found.cols.password_hash, never a hard-coded number.
function _findStudentRow(sheet, phone) {
  var target = _normalizePhone(phone);
  if (!target) return null;
  var values = sheet.getDataRange().getValues();
  if (!values.length) return null;
  var c = _studentCols(values[0]);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      var row = values[i];
      var get = function (name) { return c[name] ? row[c[name] - 1] : ""; };
      return {
        row: i + 1,
        cols: c,
        phone: get("phone"),
        password_hash: get("password_hash"),
        display_name: get("display_name"),
        created_at: get("created_at"),
        session_token: get("session_token") || null,
        is_admin: _isTruthyFlag(get("is_admin")),
        year: get("year") || null,
        parent_phone: get("parent_phone") || null,
      };
    }
  }
  return null;
}

// -- Session/admin checks (dashboards) --------------------------------------
// Neither of these is the ADMIN_TOKEN scheme used by upload_attachment
// below — that stays exactly as-is, gating only the desktop app's uploads.
// Dashboards authenticate the same way every student does: phone+password
// via login_student, which hands back a session_token. is_admin is a flag
// only ever set by hand in the Sheet, never by any web-facing action.

function _requireStudentSession(payload) {
  if (!payload.student_id || !payload.session_token) throw new Error("Missing session.");
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      if (String(values[i][c.session_token - 1]) === String(payload.session_token)) return true;
      throw new Error("Session expired or invalid — please log in again.");
    }
  }
  throw new Error("No matching student.");
}

function _requireAdminSession(payload) {
  if (!payload.student_id || !payload.session_token) throw new Error("Missing session.");
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      var isAdmin = c.is_admin ? _isTruthyFlag(values[i][c.is_admin - 1]) : false;
      var tokenOk = String(values[i][c.session_token - 1]) === String(payload.session_token);
      if (tokenOk && isAdmin) return true;
      // Phase 3 (Phase3_Roles.gs): a valid, non-stale ASSISTANT passes ONLY for an action on P3_STAFF_ALLOW.
      // is_admin stays blank for them, so every other check (and every non-listed action) still refuses.
      if (tokenOk && !isAdmin && typeof p3_assistantAllows === "function" && p3_assistantAllows(values[i], c, payload)) return true;
      if (tokenOk && !isAdmin && typeof p4_teacherAllows === "function" && p4_teacherAllows(values[i], c, payload)) return true;
      throw new Error("Not authorized.");
    }
  }
  throw new Error("Not authorized.");
}

// Returns only the FIRST name: a mistyped digit that lands on a real classmate
// then shows "Welcome back, Sara" (easy to notice: "Not you?") instead of
// handing the full name of a stranger to anyone who types a number.
function handleCheckStudent(payload) {
  if (!payload.phone) throw new Error("Missing phone number.");
  var sheet = _students();
  var found = _findStudentRow(sheet, payload.phone);
  return { ok: true, known: !!found, display_name: found ? _firstName(found.display_name) : null };
}

function handleRegisterStudent(payload) {
  if (!payload.phone || !payload.password_hash) throw new Error("Missing phone or password.");
  // Locked: the row is written by header name at "last row + 1", so two
  // registrations arriving together must not pick the same row (and a
  // double-tap must not create two accounts).
  var res = _withLock(function () {
    var sheet = _students();
    var existing = _findStudentRow(sheet, payload.phone);
    if (existing) throw new Error("An account with that phone number already exists — log in instead.");
    var phone = _canonicalPhone(payload.phone) || String(payload.phone).trim();
    var displayName = String(payload.display_name || phone).trim();
    // Cairo local time, not UTC — new Date().toISOString() is always UTC.
    var createdAt = Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss");
    var token = Utilities.getUuid();
    // year ("Senior 1" / "Senior 2") and parent_phone are both asked at
    // registration only, never at login — neither required here so a stale
    // cached auth.js mid-rollout can still register students, just without
    // these on file yet.
    var year = String(payload.year || "");
    var parentPhone = payload.parent_phone ? (_canonicalPhone(payload.parent_phone) || String(payload.parent_phone).trim()) : "";
    // Written by header name with text formatting applied first, so a name
    // like "123" or a phone with a leading 0 is stored exactly as typed.
    // is_admin is always blank on a fresh registration — the flag can only
    // ever be set by hand, directly in the Sheet (see the setup comment at
    // the top of this file), never through any web-facing action.
    _appendByHeader(sheet, {
      phone: phone, password_hash: payload.password_hash, display_name: displayName,
      created_at: createdAt, session_token: token, is_admin: "", year: year, parent_phone: parentPhone,
    });
    return { ok: true, student_id: _normalizePhone(phone), student_name: displayName, session_token: token, year: year, parent_phone: parentPhone, is_admin: false };
  });
  if (res && res.ok) {
    _notifyAdmin("\ud83c\udd95 <b>New student</b>\n\n\ud83d\udc64 " + _esc(res.student_name) + "\n\ud83d\udcf1 " + _esc(res.student_id) +
      (res.year ? "\n\ud83c\udf93 " + _esc(res.year) : ""));
  }
  return res;
}

// Wrong-password limit per account. Without it anyone could script thousands of
// guesses a minute against a phone number (passwords can be as short as 4
// characters). The attempt is counted BEFORE the password is checked, under a
// lock, so a burst of parallel guesses can't all slip through on the same
// count; a correct password clears the counter. "Forgot password?" is not
// affected, so a locked-out student can still get back in.
var LOGIN_MAX_FAILS = 10;
var LOGIN_LOCK_SECONDS = 1800;   // 30 minutes

function _reserveLoginAttempt(phone) {
  var cache = CacheService.getScriptCache();
  var key = "lg:" + _phoneKey(phone);
  _withLock(function () {
    var fails = parseInt(cache.get(key) || "0", 10);
    if (fails >= LOGIN_MAX_FAILS) {
      throw new Error("Too many wrong passwords. Try again in 30 minutes, or tap \"Forgot password?\".");
    }
    cache.put(key, String(fails + 1), LOGIN_LOCK_SECONDS);
  });
  return key;
}

function handleLoginStudent(payload) {
  if (!payload.phone || !payload.password_hash) throw new Error("Missing phone or password.");
  var sheet = _students();
  var found = _findStudentRow(sheet, payload.phone);
  if (!found) throw new Error("No account found for that phone number — register first.");
  var attemptKey = _reserveLoginAttempt(found.phone);
  if (String(found.password_hash) !== String(payload.password_hash)) {
    throw new Error("Incorrect password.");
  }
  CacheService.getScriptCache().remove(attemptKey);
  // ONE ACTIVE SESSION PER ACCOUNT: every student login issues a fresh token, which
  // signs out whatever device held the old one (its next call fails the token check
  // and video.js shows "signed in on another device"). This is what stops one paid
  // account being shared across a group. Admin accounts keep their existing token so
  // the teacher can use the dashboards on several devices. Accounts registered before
  // the session_token column existed have no token yet, so they get one here either way.
  var token = found.session_token;
  if (!token || !_isTruthyFlag(found.is_admin)) {
    token = Utilities.getUuid();
    sheet.getRange(found.row, found.cols.session_token).setValue(token);
  }
  // student_name is ALWAYS text — a name Sheets had turned into a number
  // ("123") used to reach the browser as a number and crash the widget.
  return { ok: true, student_id: _normalizePhone(found.phone), student_name: String(found.display_name == null ? "" : found.display_name), session_token: token, year: String(found.year || ""), parent_phone: _restoreLeadingZero(found.parent_phone || ""), is_admin: !!found.is_admin };
}

// Backfills year/parent_phone for accounts that predate those columns (or
// only ever registered through the corner-widget flow before it collected
// them). Token-gated the same way the dashboards are — the client already
// holds a valid session_token from login, no password re-entry needed just
// to fill in two fields.
function handleUpdateProfile(payload) {
  _requireStudentSession(payload);
  if (!payload.year || !payload.parent_phone) throw new Error("Missing year or parent phone number.");
  var sheet = _students();
  var found = _findStudentRow(sheet, payload.student_id);
  if (!found) throw new Error("No matching student.");
  var parentPhone = _canonicalPhone(payload.parent_phone) || String(payload.parent_phone).trim();
  sheet.getRange(found.row, found.cols.year).setNumberFormat("@").setValue(String(payload.year));
  sheet.getRange(found.row, found.cols.parent_phone).setNumberFormat("@").setValue(parentPhone);
  return { ok: true, year: String(payload.year), parent_phone: parentPhone };
}

// -- Password reset, verified by the parent's phone number -------------------
// Interim "forgot password" flow (no email/SMS to pay for): the student
// re-types the parent number they registered with, plus a new password
// (hashed in the browser, same as register/login). Changes ONLY the
// password_hash cell and rotates session_token so any old signed-in session
// is dropped. Nothing else on the row, and nothing in QuizResults/Submissions,
// is touched.
var RESET_MAX_FAILS = 5;        // wrong parent numbers allowed per student...
var RESET_LOCK_SECONDS = 3600;  // ...before resets for that student pause for an hour

function handleResetPassword(payload) {
  if (!payload.phone || !payload.parent_phone || !payload.new_password_hash) {
    throw new Error("Missing phone, parent phone, or new password.");
  }
  if (_normalizePhone(payload.parent_phone).length < 10) {
    throw new Error("Enter the full parent phone number.");
  }

  return _withLock(function () {
    var cache = CacheService.getScriptCache();
    var cacheKey = "rp:" + _phoneKey(payload.phone);
    var fails = parseInt(cache.get(cacheKey) || "0", 10);
    if (fails >= RESET_MAX_FAILS) {
      throw new Error("Too many attempts. Try again in an hour, or ask your teacher.");
    }

    var sheet = _students();
    var found = _findStudentRow(sheet, payload.phone);

    // Admin accounts are never resettable this way: the dashboard exposes
    // every student's data, so it needs a stronger check than a phone number.
    if (found && found.is_admin) throw new Error("This account can't be reset here.");

    var stored = found ? _phoneKey(found.parent_phone) : "";
    var hasParent = stored.length === 10 && stored !== _phoneKey(found.phone);
    if (found && !hasParent) {
      throw new Error("No parent number on file for this account — ask your teacher to reset it.");
    }

    if (!found || stored !== _phoneKey(payload.parent_phone)) {
      cache.put(cacheKey, String(fails + 1), RESET_LOCK_SECONDS);
      throw new Error("Phone number and parent number don't match.");
    }

    sheet.getRange(found.row, found.cols.password_hash).setNumberFormat("@").setValue(String(payload.new_password_hash));
    var token = Utilities.getUuid();                 // signs out any old sessions
    sheet.getRange(found.row, found.cols.session_token).setValue(token);
    cache.remove(cacheKey);
    cache.remove("lg:" + _phoneKey(found.phone));  // a successful reset also lifts a login pause

    return { ok: true, student_id: _normalizePhone(found.phone), student_name: String(found.display_name == null ? "" : found.display_name),
             session_token: token, year: String(found.year || ""), parent_phone: _restoreLeadingZero(found.parent_phone || ""), is_admin: false };
  });
}

function _safeName(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

// Same idea as _safeName but for free-text student names specifically:
// lowercased and trimmed so "Ahmed", "ahmed ", "AHMED" all land next to
// each other in Drive's alphabetical listing instead of scattering by
// literal casing/spacing. Doesn't (and can't, without accounts) tell two
// different students with the same name apart — that's what the email
// field already captured in the metadata is for.
function _slugName(s) {
  return String(s || "unnamed")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .slice(0, 40) || "unnamed";
}

// -- doGet: no longer serves files, just a health check --------------------

function doGet(e) {
  return _json({ ok: true, message: "Drive bridge is running. POST an action to use it." });
}

// -- doPost: uploads --------------------------------------------------------

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json({ ok: false, error: "Invalid JSON body." });
  }

  _lessonTagsCache = null;   // per-request cache — see _lessonTagsMap

  var attOut = att_route_(e, payload);   // AttendanceAll.gs: att_* actions + the attendance bot webhook (?att_tg=); null for everything else
  if (attOut) return attOut;
  if (payload && payload.update_id !== undefined) return handleTelegramUpdate(e, payload);   // Telegram webhook

  try {
    var __g = (typeof p4_gate === "function") ? p4_gate(payload) : null; if (__g && __g.deny) return _json(__g.deny);
    switch (payload.action) {
      case "p4_session_scope":
        return _json(p4_session_scope(payload));

      case "p4_admin_set_teacher":
        return _json(p4_admin_set_teacher(payload));

      case "p4_admin_list_teachers":
        return _json(p4_admin_list_teachers(payload));

      case "p4_admin_set_group_owner":
        return _json(p4_admin_set_group_owner(payload));

      case "p4_admin_tg_unlink":
        return _json(p4_admin_tg_unlink(payload));

      case "p4_admin_list_edit_log":
        return _json(p4_admin_list_edit_log(payload));

      case "p4_teacher_update_student":
        return _json(p4_teacher_update_student(payload));

      case "p4_teacher_set_assistant":
        return _json(p4_teacher_set_assistant(payload));

      case "p4_teacher_list_assistants":
        return _json(p4_teacher_list_assistants(payload));

      case "p4_teacher_revoke_assistant":
        return _json(p4_teacher_revoke_assistant(payload));

      case "p4_tg_link_start":
        return _json(p4_tg_link_start(payload));

      case "p4_tg_status":
        return _json(p4_tg_status(payload));

      case "p4_tg_unlink":
        return _json(p4_tg_unlink(payload));

      case "p4_admin_teacher_stats":
        return _json(p4_admin_teacher_stats(payload));

      case "ping":
        _requireAdmin(payload);
        return _json(_p2Post("p4_pingDecorate", { ok: true, message: "pong" }, payload));

      case "upload_attachment":
        return _json(handleUploadAttachment(payload));

      case "delete_attachment":
        return _json(handleDeleteAttachment(payload));

      case "upload_submission":
        return _json(handleUploadSubmission(payload));

      case "upload_quiz_result":
        return _json(handleUploadQuizResult(_p2Pre("p2c_prepare_quiz_payload", payload)));   // S3: server-side grading when FF_DEFERRED_ANSWERS

      case "check_student":
        return _json(handleCheckStudent(payload));

      case "register_student":
        return _json(_p2Post("p3_withRole", handleRegisterStudent(payload), payload));

      case "login_student":
        return _json(_p2Post("p3_withRole", handleLoginStudent(payload), payload));

      case "reset_password":
        return _json(_p2Post("p3_withRole", handleResetPassword(payload), payload));

      case "update_profile":
        return _json(handleUpdateProfile(payload));

      case "get_my_results":
        return _json(handleGetMyResults(payload));

      case "admin_get_all":
        return _json(_p2Post("p4_filter", handleAdminGetAll(payload), payload));

      case "get_video":
        return _json(handleGetVideo(payload));

      case "admin_set_video":
        return _json(_p2AuditWrap("admin_set_video", payload, handleAdminSetVideo(payload)));

      case "admin_list_videos":
        return _json(_p2Post("p4_filter", handleAdminListVideos(payload), payload));

      case "admin_set_lesson_lock":
        return _json(handleAdminSetLessonLock(payload));

      case "request_access":
        return _json(handleRequestAccess(payload));

      case "admin_list_payments":
        return _json(_p2Post("p4_filter", handleAdminListPayments(payload), payload));

      case "admin_decide_payment":
        return _json(handleAdminDecidePayment(payload));

      case "admin_grant_access":
        return _json(_p2Post("p4_filter", _p2AuditWrap("admin_grant_access", payload, handleAdminGrantAccess(payload)), payload));

      case "admin_revoke_access":
        return _json(_p2AuditWrap("admin_revoke_access", payload, handleAdminRevokeAccess(payload)));

      case "admin_access_overview":
        return _json(_p2Post("p4_filter", handleAdminAccessOverview(payload), payload));

      case "get_quiz_state":
        return _json(handleGetQuizState(payload));

      case "admin_set_quiz_lock":
        return _json(_p2AuditWrap("admin_set_quiz_lock", payload, handleAdminSetQuizLock(payload)));

      case "get_quiz":
        return _json(_p2Post("p2c_decorate_quiz", handleGetQuiz(payload), payload));   // S3: strips answers when FF_DEFERRED_ANSWERS

      case "admin_set_quiz_content":
        return _json(handleAdminSetQuizContent(payload));

      case "admin_get_quiz_content":
        return _json(handleAdminGetQuizContent(payload));

      case "admin_list_groups":
        return _json(_p2Post("p4_filter", handleAdminListGroups(payload), payload));

      case "admin_group_add":
        return _json(_p2Post("p4_filter", handleAdminGroupAdd(payload), payload));

      case "admin_group_remove":
        return _json(handleAdminGroupRemove(payload));

      case "admin_group_grant_access":
        return _json(_p2AuditWrap("admin_group_grant_access", payload, handleAdminGroupGrantAccess(payload)));

      case "admin_group_revoke_access":
        return _json(_p2AuditWrap("admin_group_revoke_access", payload, handleAdminGroupRevokeAccess(payload)));

      case "admin_list_lessons":
        return _json(_p2Post("p4_filter", handleAdminListLessons(payload), payload));

      case "admin_grant_quiz_access":
        return _json(_p2Post("p4_filter", _p2AuditWrap("admin_grant_quiz_access", payload, handleAdminGrantQuizAccess(payload)), payload));

      case "admin_revoke_quiz_access":
        return _json(_p2AuditWrap("admin_revoke_quiz_access", payload, handleAdminRevokeQuizAccess(payload)));

      case "admin_group_grant_quiz_access":
        return _json(_p2AuditWrap("admin_group_grant_quiz_access", payload, handleAdminGroupGrantQuizAccess(payload)));

      case "admin_group_revoke_quiz_access":
        return _json(_p2AuditWrap("admin_group_revoke_quiz_access", payload, handleAdminGroupRevokeQuizAccess(payload)));

      case "admin_set_lesson_tags":
        return _json(handleAdminSetLessonTags(payload));

      case "admin_list_lesson_tags":
        return _json(_p2Post("p4_filter", handleAdminListLessonTags(payload), payload));

      case "get_subscription_options":
        return _json(handleGetSubscriptionOptions(payload));

      case "request_subscription":
        return _json(handleRequestSubscription(payload));

      case "admin_followup_overview":
        return _json(_p2Post("p4_filter", _p2CallOr("p2_admin_followup_overview", handleAdminFollowupOverview, payload), payload));   // S2 wraps it (requirements, parent log, week)

      case "admin_followup_set_attendance":
        return _json(_p2CallOr("p2_admin_followup_set_attendance", handleAdminFollowupSetAttendance, payload));   // S2: weekly center rule

      case "admin_followup_save_group":
        return _json(handleAdminFollowupSaveGroup(payload));

      case "admin_followup_save_templates":
        return _json(handleAdminFollowupSaveTemplates(payload));

      case "record_watch":
        return _json(handleRecordWatch(payload));

      // ---- Phase 2 (see docs/contract.md). Handlers live in Phase2_*.gs; Phase2_Core.gs owns _p2Call.
      case "admin_student_summary":   // S2
        return _json(_p2Post("p4_filter", _p2Call("p2_admin_student_summary", payload), payload));

      case "admin_monthly_review":   // S2
        return _json(_p2Post("p4_filter", _p2Call("p2_admin_monthly_review", payload), payload));

      case "admin_set_requirement":   // S2
        return _json(_p2Call("p2_admin_set_requirement", payload));

      case "admin_log_parent_notification":   // S2
        return _json(_p2Call("p2_admin_log_parent_notification", payload));

      case "admin_list_parent_notifications":   // S2
        return _json(_p2Post("p4_filter", _p2Call("p2_admin_list_parent_notifications", payload), payload));

      case "upload_written_image":   // S3
        return _json(_p2Call("p2_upload_written_image", payload));

      case "get_quiz_review":   // S3
        return _json(_p2Call("p2_get_quiz_review", payload));

      case "admin_grading_queue":   // S4
        return _json(_p2Post("p4_filter", _p2Call("p2_admin_grading_queue", payload), payload));

      case "admin_grade_written":   // S4
        return _json(_p2Call("p2_admin_grade_written", payload));

      case "admin_set_written_models":   // S4 (added at integration; Quiz Maker authoring)
        return _json(_p2Call("p2_admin_set_written_models", payload));

      case "admin_get_written_models":   // S4 (added at integration)
        return _json(_p2Call("p2_admin_get_written_models", payload));

      case "get_written_image":   // S4 (added at integration; admin or the owning student)
        return _json(_p2Call("p2_get_written_image", payload));

      case "admin_migrate_lesson_keys":   // S1
        return _json(_p2Call("p2_admin_migrate_lesson_keys", payload));

      // ---- Phase 3 (Phase3_*.gs). Each handler lives in its own file; see HANDOFF-S1/S3/S4.
      case "p3_session_role":                                                // S3
        return _json(_p2Call("p3_action_session_role", payload));
      case "p3_admin_set_role":                                              // S3
        return _json(_p2Call("p3_admin_set_role", payload));
      case "p3_admin_list_staff":                                            // S3
        return _json(_p2Call("p3_admin_list_staff", payload));
      case "p3_admin_bulk_preview": return _json(p3_admin_bulk_preview(payload));   // S4 (audits itself)
      case "p3_admin_bulk_grant":   return _json(p3_admin_bulk_grant(payload));     // S4
      case "p3_admin_bulk_revoke":  return _json(p3_admin_bulk_revoke(payload));    // S4
      case "p3_admin_diagnose_submissions":                                  // S2 (admin only: keep OFF P3_STAFF_ALLOW)
        return _json(_p2Call("p3_admin_diagnose_submissions", payload));
      case "p3_admin_restore_submissions":                                   // S2
        return _json(_p2Call("p3_admin_restore_submissions", payload));
      case "p3_admin_backfill_submission":                                   // S2
        return _json(_p2Call("p3_admin_backfill_submission", payload));
      case "p3_admin_flag_status":                                           // S1 (optional, admin only)
        return _json(p3_admin_flag_status(payload));

      default:
        // FU2: follow-up v2 actions (admin_fu2_* / admin_req_*) -> FollowupRouter.gs (merges FollowupNotify.gs, Requirements.gs and its own).
        if (/^admin_(fu2|req)_/.test(String(payload.action || "")) && typeof fu2_dispatch_ === "function") return _json(fu2_dispatch_(payload));
        // Attendance system (Attendance.gs): every action is prefixed att_ and answers its own {ok, code} shape.
        if (String(payload.action || "").indexOf("att_") === 0) return _json(att_dispatch_(payload));
        return _json({ ok: false, error: "Unknown action: " + payload.action });
    }
  } catch (err) {
    var out = { ok: false, error: String(err.message || err) };
    if (err && err.retryable) out.retryable = true;   // lock was busy — the browser may resend the same record
    if (err && err.disabled) out.disabled = true;     // Phase 2 feature flag is off (p2_requireFlag)
    return _json(out);
  }
}

function handleUploadAttachment(payload) {
  _requireAdmin(payload);
  if (!payload.data_base64 || !payload.filename) {
    throw new Error("Missing file data.");
  }
  var folder = _folder("ATTACHMENTS_FOLDER_ID");
  var bytes = Utilities.base64Decode(payload.data_base64);
  var blob = Utilities.newBlob(bytes, payload.mime_type || "application/octet-stream", payload.filename);
  var stamped = _safeName(payload.subject) + "--" + _safeName(payload.lesson) + "--" + Utilities.getUuid().slice(0, 8) + "--" + payload.filename;
  blob.setName(stamped);
  var file = folder.createFile(blob);

  // The site links straight to drive.google.com URLs for preview/open/
  // download, so the file needs to be link-viewable.
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return { ok: true, file_id: file.getId() };
}

function handleDeleteAttachment(payload) {
  _requireAdmin(payload);
  if (!payload.file_id) throw new Error("Missing file_id.");
  // P4-S1 (plan 0.2): the admin token alone no longer trashes ANY Drive file it is handed. The file
  // must sit inside the attachments folder (ATTACHMENTS_FOLDER_ID, the folder handleUploadAttachment
  // writes to), checked up the parent chain. Anything else, or anything that cannot be resolved,
  // is refused and nothing is trashed (fails closed).
  var rootId = _props().getProperty("ATTACHMENTS_FOLDER_ID");
  var file = null, inside = false;
  try {
    if (rootId) {
      file = DriveApp.getFileById(payload.file_id);
      var level = [], seenIds = {}, it = file.getParents();
      while (it.hasNext()) level.push(it.next());
      for (var depth = 0; depth < 8 && level.length && !inside; depth++) {
        var up = [];
        for (var k = 0; k < level.length && !inside; k++) {
          var fid = level[k].getId();
          if (fid === rootId) { inside = true; break; }
          if (seenIds[fid]) continue;
          seenIds[fid] = true;
          var ps = level[k].getParents();
          while (ps.hasNext()) up.push(ps.next());
        }
        level = up;
      }
    }
  } catch (e) { inside = false; }
  if (!inside) throw new Error("Not authorized.");
  file.setTrashed(true);
  return { ok: true };
}

// ---- Upload handlers: slow work OUTSIDE the lock ----------------------------
// Order for both uploads (a class finishing together used to queue behind one
// lock that also covered Drive file creation, and the last students timed out):
//   1. quick duplicate look, NO lock  -> a re-sent copy stops here, no Drive files
//   2. create the Drive file(s)       -> slow, many students at once, NO lock
//   3. lock: check again, write row   -> a few sheet calls, then released
// If step 3 finds the attempt was saved in the meantime, or fails (lock busy),
// the Drive files just made are trashed so retries never leave stray copies.
// Step 1 and the sheet handle are read-only: a missing tab or column is only
// ever created inside the lock (two requests adding the same header column at
// once is what produced the repeated-column sheets repairLayout() fixes).

// The tab if it already exists — never creates or edits anything.
function _peekSheet(name) {
  try { return _dataSs().getSheetByName(name); } catch (e) { return null; }
}

function _seenBeforeLock(peeked, keys) {
  try { return !!peeked && _anySeen(_existingKeys(peeked), keys); } catch (e) { return false; }
}

// Inside the lock: reuse the tab handle found earlier when it already has the
// columns we write (saves re-opening the whole spreadsheet while everyone waits);
// otherwise take the full path, which creates/repairs the tab.
function _writableSheet(peeked, cols, fullFn) {
  if (peeked) {
    try {
      var idx = _headerIndex(peeked);
      if (cols.every(function (c) { return idx[c]; })) return peeked;
    } catch (e) { /* empty tab etc. — use the full path */ }
  }
  return fullFn();
}

function _trashQuietly(files) {
  files.forEach(function (f) { try { f.setTrashed(true); } catch (e) { /* best effort */ } });
}

function handleUploadSubmission(payload) {
  // No admin token required — this is the public "hand in your work" path.
  // student_id IS required (confirmed assign.js always sends it as of the
  // login rollout) — rejecting outright here beats silently accepting an
  // orphaned row nothing can ever match back to a student.
  if (!payload.student_id) throw new Error("Missing student_id — please sign in and try again.");
  // P4-S1 (plan 0.3): a session_token, when sent, must belong to student_id. A payload with NO token
  // is a record queued in a student's browser before this change; it keeps working until the Script
  // Property P4_LEGACY_UPLOADS is set to "0" (about 14 days after deploy).
  if (payload.session_token || _props().getProperty("P4_LEGACY_UPLOADS") === "0") _requireStudentSession(payload);

  var keys = _submissionKeys(payload);
  var peeked = _peekSheet("Submissions");
  // Checked BEFORE any Drive file is created, so a re-sent copy leaves
  // no orphan files behind either.
  if (_seenBeforeLock(peeked, keys)) return { ok: true, duplicate: true };

  var made = [];   // Drive files created by THIS request (trashed again if the row isn't written)
  try {
    var folder = _folder("SUBMISSIONS_FOLDER_ID");
    var now = new Date();
    var timestamp = Utilities.formatDate(now, "UTC", "yyyyMMdd'T'HHmmss'Z'");
    // subject/lesson/name first so Drive's own alphabetical listing groups
    // one lesson's submissions together, then by student, then chronologically
    // for repeats — timestamp-first was fighting Drive's "date modified"
    // column, which already sorts by time for free.
    var stem = _safeName(payload.subject) + "--" + _safeName(payload.lesson) + "--" +
      _slugName(payload.name) + "--" + timestamp;

    var fileId = null;
    if (payload.submission_type === "file") {
      if (!payload.data_base64 || !payload.filename) throw new Error("Missing file data.");
      var bytes = Utilities.base64Decode(payload.data_base64);
      var blob = Utilities.newBlob(bytes, payload.mime_type || "application/octet-stream", payload.filename);
      blob.setName(stem + "--" + payload.filename);
      var file = folder.createFile(blob);
      made.push(file);
      fileId = file.getId();
    }

    // Cairo wall-clock text. Falls back to "now" if the browser sent no
    // usable time.
    var submittedAt = _cairoTime(payload.submitted_time) || _fmt(now, TZ, true);
    var dateStr = _cairoDate(submittedAt) || _fmt(now, TZ, false);

    var meta = {
      subject: payload.subject || null,
      lesson: payload.lesson || null,
      // student_id (v2 login) — required, checked above.
      student_id: payload.student_id,
      name: payload.name || null,
      email: payload.email || null,
      date: dateStr,
      submitted_time: submittedAt,
      submission_type: payload.submission_type || null,
      text: payload.text || null,
      url: payload.url || null,
      note: payload.note || null,
      file_id: fileId,
      file_name: payload.filename || null,
      // Graded assignments (submission_type: "graded") only — deterministic
      // score computed client-side in assign.js at submit time.
      score: typeof payload.score === "number" ? payload.score : null,
      total: typeof payload.total === "number" ? payload.total : null,
      answers: Array.isArray(payload.answers) ? payload.answers : null,
    };
    var metaBlob = Utilities.newBlob(JSON.stringify(meta, null, 2), "application/json", stem + "--meta.json");
    made.push(folder.createFile(metaBlob));

    // Mirror into the Submissions sheet — this is what the dashboards
    // actually query. The Drive JSON above stays as the durable per-attempt
    // record with the full, untruncated text.
    var fullText = meta.text || "";
    var truncated = fullText.length > TEXT_CELL_LIMIT;
    var cellText = truncated ? fullText.slice(0, TEXT_CELL_LIMIT) : fullText;

    var result = _withLock(function () {
      var sheet = _writableSheet(peeked, ["score", "total", "answers_json", "dedupe_key"], _submissionsSheet);
      if (_anySeen(_existingKeys(sheet), keys)) return { ok: true, duplicate: true };
      _appendByHeader(sheet, {
        student_id: meta.student_id, name: meta.name, subject: meta.subject, lesson: meta.lesson,
        submission_type: meta.submission_type, text: cellText, text_truncated: truncated,
        url: meta.url, note: meta.note, file_id: meta.file_id, file_name: meta.file_name,
        date: meta.date, submitted_time: meta.submitted_time, score: meta.score, total: meta.total,
        answers_json: JSON.stringify(meta.answers || []), dedupe_key: keys[0],
      });
      return { ok: true, file_id: fileId };
    }, UPLOAD_LOCK_WAIT_MS);

    if (result.duplicate) _trashQuietly(made);   // saved by a parallel request while we worked
    _notifySubmission(payload, result);
    return result;
  } catch (err) {
    _trashQuietly(made);                          // no row was written — don't leave the files behind
    throw err;
  }
}

function handleUploadQuizResult(payload) {
  // No admin token required — same trust model as assignment submissions,
  // this is just "record my score", not a privileged action. student_id
  // IS required though (confirmed quiz.js always sends it as of the login
  // rollout) — same reasoning as handleUploadSubmission above.
  if (!payload.student_id) throw new Error("Missing student_id — please sign in and try again.");
  // P4-S1 (plan 0.3): same rule as handleUploadSubmission. A session_token, when sent, must validate;
  // no token is accepted only while P4_LEGACY_UPLOADS is not "0".
  if (payload.session_token || _props().getProperty("P4_LEGACY_UPLOADS") === "0") _requireStudentSession(payload);
  // Bug fix (found alongside the video-lock pipeline fix): quiz.js's embedded
  // quiz data only ever carried the bare lesson SLUG (e.g. "functions"), never
  // the full subject/[group/]slug path the Quizzes sheet is actually keyed by
  // (the same convention as admin_set_quiz_lock, admin_set_lesson_lock,
  // admin_set_video, and admin_list_lessons — see _lessonPath). That meant
  // this check NEVER matched a real Quizzes row for ANY lesson, so a locked
  // quiz always looked open at submission time too. quiz.js now also sends
  // lesson_path (derived from the page URL, same way video.js already does)
  // specifically for this check; lesson_path is a payload field, kept
  // separate from payload.lesson (the bare slug) since QuizResults/dashboards
  // already store/read that field as the slug — changing its meaning would
  // break existing rows. Falls back to payload.lesson for any client that
  // hasn't picked up the quiz.js fix yet (fails toward the OLD, broken-open
  // behavior in that case, not toward newly locking out a stale client).
  var gateLesson = payload.lesson_path || payload.lesson;
  if (_quizLockedForStudent(_lessonPath(gateLesson), payload.student_id)) throw new Error("This quiz is locked.");

  var keys = _quizKeys(payload);
  var peeked = _peekSheet("QuizResults");
  if (_seenBeforeLock(peeked, keys)) return { ok: true, duplicate: true };

  var made = [];
  try {
    var folder = _folder("QUIZ_RESULTS_FOLDER_ID");
    var now = new Date();
    var timestamp = Utilities.formatDate(now, "UTC", "yyyyMMdd'T'HHmmss'Z'");
    var stem = _safeName(payload.subject) + "--" + _safeName(payload.lesson) + "--" +
      _slugName(payload.name) + "--" + timestamp;

    var startAt = _cairoTime(payload.start_time);
    var endAt = _cairoTime(payload.end_time);

    var record = {
      subject: payload.subject || null,
      lesson: payload.lesson || null,
      quiz_title: payload.quiz_title || null,
      // student_id (v2 login) — required, checked above.
      student_id: payload.student_id,
      name: payload.name || null,
      email: payload.email || null,
      date: _cairoDate(startAt) || payload.date || _fmt(now, TZ, false),
      start_time: startAt || null,
      end_time: endAt || null,
      score: typeof payload.score === "number" ? payload.score : null,
      total: typeof payload.total === "number" ? payload.total : null,
      // v2 record shape: every question answered (with per-question
      // "chapter"), not just the misses — lets grading aggregate by chapter.
      // Falls back to the old wrong-only array if an un-migrated quiz.js is
      // still live somewhere mid-rollout.
      questions: Array.isArray(payload.questions) ? payload.questions : null,
      // Kept for backward compatibility with pre-v2 quiz.js during rollout;
      // not populated going forward once every page is on the new engine.
      wrong_questions: Array.isArray(payload.wrong_questions) ? payload.wrong_questions : [],
    };

    var blob = Utilities.newBlob(JSON.stringify(record, null, 2), "application/json", stem + "--quiz-result.json");
    made.push(folder.createFile(blob));

    // Mirror into the QuizResults sheet — this is what the dashboards
    // query; the Drive JSON above stays as the durable per-attempt record.
    var result = _withLock(function () {
      var sheet = _writableSheet(peeked, ["dedupe_key"], _quizResultsSheet);
      if (_anySeen(_existingKeys(sheet), keys)) return { ok: true, duplicate: true };
      _appendByHeader(sheet, {
        student_id: record.student_id, name: record.name, subject: record.subject, lesson: record.lesson,
        quiz_title: record.quiz_title, date: record.date, start_time: record.start_time, end_time: record.end_time,
        score: record.score, total: record.total,
        questions_json: JSON.stringify(record.questions || record.wrong_questions || []),
        dedupe_key: keys[0],
      });
      return { ok: true };
    }, UPLOAD_LOCK_WAIT_MS);

    if (result.duplicate) _trashQuietly(made);
    _notifyQuiz(payload, result);
    return result;
  } catch (err) {
    _trashQuietly(made);
    throw err;
  }
}

// -- Dashboards ---------------------------------------------------------

function handleGetMyResults(payload) {
  _requireStudentSession(payload);
  var target = _normalizePhone(payload.student_id);

  var quizRows = _sheetValuesAsObjects(_quizResultsSheet())
    .filter(function (r) { return _phonesMatch(r.student_id, target); });
  var subRows = _sheetValuesAsObjects(_submissionsSheet())
    .filter(function (r) { return _phonesMatch(r.student_id, target); });

  return { ok: true, quiz_results: quizRows, submissions: subRows };
}

function handleAdminGetAll(payload) {
  _requireAdminSession(payload);

  var studentRows = _sheetValuesAsObjects(_students()).map(function (r) {
    return { phone: r.phone, display_name: r.display_name, created_at: r.created_at, year: r.year || "", parent_phone: r.parent_phone || "" };
  });

  return {
    ok: true,
    students: studentRows,
    quiz_results: _sheetValuesAsObjects(_quizResultsSheet()),
    submissions: _sheetValuesAsObjects(_submissionsSheet()),
  };
}

// -- Videos: locked / unlocked lesson videos ---------------------------------
// One row per (lesson, slot). See the "Video lock" note at the top of this file.
// Reads (get_video) never create or edit anything; the tab and its columns are
// only ever created inside admin_set_video's lock.

var VIDEO_SLOTS = { lesson: 1, quiz: 1, assignment: 1 };
var VIDEO_HEADERS = ["lesson", "slot", "embed_url", "locked", "updated_at"];
var VIDEO_CACHE_SECONDS = 60;

// Same-origin key for a slot: "Programming/Other/Functions/" -> "programming/other/functions".
function _lessonPath(raw) {
  var l = String(raw == null ? "" : raw).trim().toLowerCase()
    .replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9][a-z0-9._\/-]{0,199}$/.test(l) || l.indexOf("..") !== -1) throw new Error("Missing or invalid lesson.");
  return _canonKey(l);
}

// ---- lesson key aliases -----------------------------------------------------------------------
// Commit f58d9b7 renamed three Senior 2 folders. Grants, locks and results written under the old
// keys must keep working, so every key read from a sheet or a request goes through _canonKey.
// Mirror of assets/lesson-aliases.json. Full-path keys and bare slugs.
var _G2 = "programming/baccalaureate/grade-2-secondary/";
var LESSON_ALIASES = (function () {
  var pairs = [
    ["lesson-1-development-of-information-technology-and-social-transformation", "chapter-1-lesson-1-development-of-information-technology-and-social-transformation"],
    ["lesson-2-how-ai-works", "chapter-1-lesson-2-how-ai-works"],
    ["chaper-1-lesson-3-ai-in-daily-life-and-industry", "chapter-1-lesson-3-ai-in-daily-life-and-industry"]
  ];
  var m = {};
  pairs.forEach(function (p) { m[_G2 + p[0]] = _G2 + p[1]; m[p[0]] = _G2 + p[1]; });
  return m;
})();

// Old/typo'd key -> current key. Anything else (wildcards, "#ch1" scopes, "*", unknown keys) is unchanged.
function _canonKey(k) {
  return Object.prototype.hasOwnProperty.call(LESSON_ALIASES, k) ? LESSON_ALIASES[k] : k;
}

function _videoKey(lesson, slot) {
  var l = _lessonPath(lesson);
  var s = String(slot == null ? "" : slot).trim().toLowerCase();
  if (!VIDEO_SLOTS.hasOwnProperty(s)) throw new Error('Slot must be "lesson", "quiz" or "assignment".');
  return { lesson: l, slot: s };
}

// Whatever the teacher pastes -> a clean embed URL, or "" for blank (= clear the
// slot). Only YouTube and Vimeo player URLs are accepted, so nothing else can
// ever be put in front of students. Mirrors normalize_video_url() in common.py.
function _normalizeEmbedUrl(raw) {
  var url = String(raw == null ? "" : raw).trim();
  if (!url) return "";
  if (/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{11}(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(url)) return url;
  if (/^https:\/\/player\.vimeo\.com\/video\/\d+(?:\?[A-Za-z0-9_=&%.-]*)?$/.test(url)) return url;
  if (/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) {
    var m = /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(url) ||
            /youtube\.com\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/.exec(url) ||
            /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
    if (m) return "https://www.youtube.com/embed/" + m[1];
  }
  throw new Error("That doesn't look like a YouTube or Vimeo video link.");
}

// FAILS CLOSED: only an explicit FALSE (a real boolean or the text) opens a video.
function _isLockedCell(v) {
  return !(v === false || String(v).trim().toUpperCase() === "FALSE");
}

function _videoCacheKey(lesson, slot) {
  return "vid:" + _md5(lesson + "|" + slot);
}

// Header name -> column, or a readable error if a needed header is gone. Never
// guesses a column: a damaged tab means "no access", not a write/read in the wrong place.
function _needCols(sheet, tab, names) {
  var idx = _headerIndex(sheet);
  names.forEach(function (n) {
    if (!idx[n]) throw new Error('The ' + tab + ' sheet is missing the "' + n + '" column (renamed or deleted?).');
  });
  return idx;
}

function _videoCols(sheet) {
  return _needCols(sheet, "Videos", ["lesson", "slot", "embed_url", "locked"]);
}

function _findVideoRow(sheet, lesson, slot) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var c = _videoCols(sheet);
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson &&
        String(values[i][c.slot - 1]).trim().toLowerCase() === slot) {
      return { row: i + 2, cols: c, embed_url: String(values[i][c.embed_url - 1]).trim(),
               locked: _isLockedCell(values[i][c.locked - 1]) };
    }
  }
  return null;
}

// {embed_url, locked} or null. Cached briefly so a class opening the same lesson
// at once costs one sheet read, not one per student.
function _lookupVideo(lesson, slot) {
  var cache = CacheService.getScriptCache();
  var ck = _videoCacheKey(lesson, slot);
  var hit = cache.get(ck);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through and re-read */ } }
  var sheet = _ss().getSheetByName("Videos");
  var found = sheet ? _findVideoRow(sheet, lesson, slot) : null;
  var rec = found && found.embed_url ? { embed_url: found.embed_url, locked: found.locked } : null;
  cache.put(ck, JSON.stringify(rec), VIDEO_CACHE_SECONDS);
  return rec;
}

// "none" (not signed in), "stale" (a real account, but this token was replaced — the
// account was signed in somewhere else, or its password was reset), "student" or
// "admin". Never throws for a bad session — get_video is public, so a bad session
// just means "not signed in". Every caller treats "stale" like "none".
function _sessionState(payload) {
  if (!payload.student_id || !payload.session_token) return "none";
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      if (String(values[i][c.session_token - 1]) !== String(payload.session_token)) return "stale";
      return (c.is_admin && _isTruthyFlag(values[i][c.is_admin - 1])) ? "admin" : "student";
    }
  }
  return "none";
}

// The desktop app authenticates with ADMIN_TOKEN ("token"); the web dashboards
// with an admin session. Either one is enough.
// Phase 3: the assistant role is decided inside _requireAdminSession (allow-list by payload.action), so
// this function needs no change; the token path never consults roles.
function _requireAdminAny(payload) {
  if (payload.token) { _requireAdmin(payload); return; }
  _requireAdminSession(payload);
}

// -- Lesson lock: lock a whole lesson, with or without a video ---------------------
// A lesson with no row here is OPEN (same convention as the Quizzes gate below).
// Once explicitly gated, a new row starts LOCKED. Locking a lesson forces every one
// of its videos locked too, on top of whatever that video's own "locked" cell says
// (it only ever ADDS restriction — unlocking the lesson does not open a video that
// was locked on its own). This exists so a lesson can be locked before any video
// has been added to it: handleAdminSetVideo's "new videos start locked" rule and
// this combine to mean a freshly-added video to a locked lesson is born locked.
var LESSON_HEADERS = ["lesson", "locked", "updated_at"];
var LESSON_CACHE_SECONDS = 30;
function _lessonCacheKey(lesson) { return "llk:" + _md5(lesson); }

function _findLessonRow(sheet, lesson) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var c = _needCols(sheet, "Lessons", ["lesson", "locked"]);
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) {
      return { row: i + 2, cols: c, locked: _isLockedCell(values[i][c.locked - 1]) };
    }
  }
  return null;
}

// Fails closed, same as the video lock and quiz gate: a damaged Lessons tab is
// treated as locked until fixed, rather than quietly opening every lesson.
function _lessonLockedNow(lesson) {
  var sheet = _ss().getSheetByName("Lessons");
  if (!sheet) return false;
  try {
    var found = _findLessonRow(sheet, lesson);
    return !!(found && found.locked);
  } catch (e) {
    return true;
  }
}

function _isLessonLocked(rawLesson) {
  var lesson;
  try { lesson = _lessonPath(rawLesson); } catch (e) { return false; }
  var cache = CacheService.getScriptCache();
  var ck = _lessonCacheKey(lesson);
  var hit = cache.get(ck);
  if (hit !== null) return hit === "1";
  var locked = _lessonLockedNow(lesson);
  cache.put(ck, locked ? "1" : "0", LESSON_CACHE_SECONDS);
  return locked;
}

// locked is REQUIRED, same shape as admin_set_quiz_lock.
function handleAdminSetLessonLock(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  if (payload.locked === undefined || payload.locked === null) throw new Error("Missing locked (true or false).");
  var wantLocked = _isLockedCell(payload.locked);

  var result = _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Lessons");
    var found = sheet ? _findLessonRow(sheet, lesson) : null;
    var now = _fmt(new Date(), TZ, true);
    if (found) {
      sheet.getRange(found.row, found.cols.locked).setValue(wantLocked);
      if (found.cols.updated_at) sheet.getRange(found.row, found.cols.updated_at).setNumberFormat("@").setValue(now);
      return { ok: true, lesson: lesson, locked: wantLocked };
    }
    sheet = _sheetByName(ss, "Lessons", LESSON_HEADERS);
    _ensureColumns(sheet, LESSON_HEADERS);
    _appendByHeader(sheet, { lesson: lesson, locked: wantLocked, updated_at: now });
    return { ok: true, lesson: lesson, locked: wantLocked };
  });
  CacheService.getScriptCache().remove(_lessonCacheKey(lesson));
  // Clear every video slot's cache for this lesson too, since their effective
  // locked state (rec.locked || lesson-locked) may have just changed.
  var cache = CacheService.getScriptCache();
  Object.keys(VIDEO_SLOTS).forEach(function (slot) { cache.remove(_videoCacheKey(lesson, slot)); });
  return result;
}

// Public. The URL is only in the answer when the viewer may actually watch.
// found:false means "nothing here, don't show a box at all" — the only case for
// that now is an unlocked lesson with no video row. Everything else that's
// locked (a locked video row, OR a lesson-wide lock even with no video row yet)
// answers found:true so the page shows a lock box; no_video:true marks the case
// where there's genuinely no video behind it, so the page can soften the
// wording instead of implying a video is waiting once they get access.
function handleGetVideo(payload) {
  var key = _videoKey(payload.lesson, payload.slot);
  var rec = _lookupVideo(key.lesson, key.slot);
  var locked = (rec && rec.locked) || _isLessonLocked(key.lesson);
  if (!rec && !locked) return { ok: true, found: false };
  if (!locked) return { ok: true, found: true, locked: false, embed_url: rec.embed_url };

  var who = _sessionState(payload);
  if (who === "admin") {
    if (rec) return { ok: true, found: true, locked: true, embed_url: rec.embed_url };
    return { ok: true, found: false };   // admin already knows it's locked, from the dashboard
  }
  var info = _payInfo();
  if (who === "student") {
    var ss = _ss();
    var acc = _accessState(ss, payload.student_id, key.lesson);
    if (acc.active) {
      if (rec) return { ok: true, found: true, locked: true, embed_url: rec.embed_url };
      return { ok: true, found: true, locked: true, no_video: true };
    }
    var out = { ok: true, found: true, locked: true, need: "payment" };
    if (!rec) out.no_video = true;
    var req = _latestRequest(ss, payload.student_id, key.lesson);
    if (req) out.request = req;                    // "pending" (waiting for you) or "rejected"
    if (acc.expired) out.expired = acc.expired;    // their access ended on this date
    if (info) out.pay_info = info;
    return out;
  }
  var login = { ok: true, found: true, locked: true, need: "login" };
  if (who === "stale") login.session_replaced = true;   // the page says "signed in on another device"
  if (!rec) login.no_video = true;
  if (info) login.pay_info = info;
  return login;
}

// The public "how to pay" text shown in the lock box (Script Property PAY_INSTRUCTIONS).
function _payInfo() {
  return _payInfoProp("PAY_INSTRUCTIONS");
}

// Same, for any property. Subscriptions use their own texts (PAY_INSTRUCTIONS_CHAPTER /
// PAY_INSTRUCTIONS_TERM) so a chapter or term never shows the per-lesson price; unset = "".
function _payInfoProp(name) {
  return String(_props().getProperty(name) || "").trim().slice(0, 1000);
}

// video_url: a link (adds/replaces), "" (clears the slot), or leave it out.
// locked:    true / false, or leave it out (a NEW slot then starts locked).
function handleAdminSetVideo(payload) {
  _requireAdminAny(payload);
  var key = _videoKey(payload.lesson, payload.slot);
  var hasUrl = payload.video_url !== undefined && payload.video_url !== null;
  var hasLocked = payload.locked !== undefined && payload.locked !== null;
  if (!hasUrl && !hasLocked) throw new Error("Nothing to change — send video_url and/or locked.");
  var embed = hasUrl ? _normalizeEmbedUrl(payload.video_url) : null;   // "" = clear
  var wantLocked = hasLocked ? _isLockedCell(payload.locked) : null;

  var result = _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Videos");
    var found = sheet ? _findVideoRow(sheet, key.lesson, key.slot) : null;
    var now = _fmt(new Date(), TZ, true);

    if (embed === "") {                                   // clear the slot
      if (found) sheet.deleteRows(found.row, 1);
      return { ok: true, lesson: key.lesson, slot: key.slot, cleared: !!found };
    }
    if (found) {                                          // update in place
      var c = found.cols;
      if (hasUrl) sheet.getRange(found.row, c.embed_url).setNumberFormat("@").setValue(embed);
      if (hasLocked) sheet.getRange(found.row, c.locked).setValue(wantLocked);
      if (c.updated_at) sheet.getRange(found.row, c.updated_at).setNumberFormat("@").setValue(now);
      return { ok: true, lesson: key.lesson, slot: key.slot,
               embed_url: hasUrl ? embed : found.embed_url, locked: hasLocked ? wantLocked : found.locked };
    }
    if (!hasUrl) throw new Error("No video is set for this slot yet — send video_url first.");
    sheet = _sheetByName(ss, "Videos", VIDEO_HEADERS);    // created only here, inside the lock
    _ensureColumns(sheet, VIDEO_HEADERS);
    var locked = hasLocked ? wantLocked : true;           // new videos start locked
    _appendByHeader(sheet, { lesson: key.lesson, slot: key.slot, embed_url: embed, locked: locked, updated_at: now });
    return { ok: true, lesson: key.lesson, slot: key.slot, embed_url: embed, locked: locked };
  });
  CacheService.getScriptCache().remove(_videoCacheKey(key.lesson, key.slot));
  return result;
}

function handleAdminListVideos(payload) {
  _requireAdminAny(payload);
  var sheet = _ss().getSheetByName("Videos");
  var rows = sheet && sheet.getLastRow() >= 2 ? _sheetValuesAsObjects(sheet) : [];
  return {
    ok: true,
    videos: rows.map(function (r) {
      return { lesson: String(r.lesson || ""), slot: String(r.slot || ""), embed_url: String(r.embed_url || ""),
               locked: _isLockedCell(r.locked), updated_at: String(r.updated_at || "") };
    }),
  };
}

// -- Access: entitlements, "I paid" requests, approvals ------------------------
// See the "Access" note at the top of this file. Reads never create a tab; tabs
// and columns are only created inside the lock of an action that writes.

var ENT_HEADERS = ["phone", "scope", "expires_at", "granted_at", "source"];
var PAYMENT_HEADERS = ["payment_id", "phone", "name", "scope", "reference", "note", "status", "created_at", "decided_at"];
var MAX_PENDING_REQUESTS = 5;

// -- Grade subscriptions: chapter/term scopes for programming/baccalaureate ---------
// See subscription-plan.md. A subscription scope is one of the two grade folders below
// plus a "#chN" or "#tN" tag (e.g. ".../grade-1-secondary#ch3"). Coverage is decided at
// check time by looking up the lesson's tags in the LessonTags tab (below), so retagging
// a lesson, or adding a new lesson to a chapter, changes coverage for every existing
// holder automatically — nothing needs to be re-granted.

var GRADE_SCOPE_FOLDERS = {
  "programming/baccalaureate/grade-1-secondary": "G1",
  "programming/baccalaureate/grade-2-secondary": "G2",
};
var SUB_SCOPE_TAG_RE = /^(ch|t)([1-9][0-9]*)$/;
var DEFAULT_YEAR_END = "2027-08-01";
var DEFAULT_CURRENT_TERM = 1;

// "G1"/"G2" if this lesson is under one of the two grade folders, else "".
function _gradeSuffixForLesson(lesson) {
  for (var base in GRADE_SCOPE_FOLDERS) {
    if (lesson === base || lesson.indexOf(base + "/") === 0) return GRADE_SCOPE_FOLDERS[base];
  }
  return "";
}

// "G1"/"G2" if `scope` is a "#ch"/"#t" scope for one of the two grade folders, else "".
function _subscriptionGradeSuffix(scope) {
  var hashAt = String(scope == null ? "" : scope).indexOf("#");
  if (hashAt === -1) return "";
  return GRADE_SCOPE_FOLDERS[scope.slice(0, hashAt)] || "";
}

// Script Property YEAR_END_<suffix>, else the shared default. Both fall back the
// same way, so an unset property never blocks anything.
function _gradeYearEnd(suffix) {
  var v = _props().getProperty("YEAR_END_" + suffix);
  return v ? _cleanYmd(v) : DEFAULT_YEAR_END;
}

// Script Property CURRENT_TERM_<suffix> as a whole number, else the default (1).
function _gradeCurrentTerm(suffix) {
  var n = parseInt(_props().getProperty("CURRENT_TERM_" + suffix), 10);
  return n > 0 ? n : DEFAULT_CURRENT_TERM;
}

// A whole number >= 1, from a form field that may arrive as a number or a string.
function _wholePositiveInt(v, label) {
  var n = Number(v);
  if (v === "" || v === null || v === undefined || !isFinite(n) || n !== Math.floor(n) || n < 1) {
    throw new Error(label + " must be a whole number of 1 or more.");
  }
  return n;
}

// -- LessonTags: chapter/term tags for lessons under the two grade folders -----------
// A NEW tab, deliberately separate from the Lessons tab (where a row means "explicitly
// gated", and a new row starts LOCKED) — writing tags there could accidentally change
// lock state. Reads never create this tab; it is only ever created inside the lock of
// admin_set_lesson_tags.

var LESSONTAGS_HEADERS = ["lesson", "chapter", "term", "updated_at"];
var _lessonTagsCache = null;   // reset at the top of every doPost — see doPost

// {lesson -> {chapter, term}} for every tagged lesson. Cached for the lifetime of one
// request so a loop over entitlement rows (in _accessState) doesn't re-read the sheet
// once per row.
function _lessonTagsMap(ss) {
  if (_lessonTagsCache) return _lessonTagsCache;
  var map = {};
  var sheet = ss.getSheetByName("LessonTags");
  if (sheet && sheet.getLastRow() >= 2) {
    var c = _needCols(sheet, "LessonTags", ["lesson", "chapter", "term"]);
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
      var lesson = _canonKey(String(r[c.lesson - 1]).trim().toLowerCase());
      var chapter = parseInt(r[c.chapter - 1], 10);
      var term = parseInt(r[c.term - 1], 10);
      if (lesson && chapter > 0 && term > 0) map[lesson] = { chapter: chapter, term: term };
    });
  }
  _lessonTagsCache = map;
  return map;
}

// Admin (Tkinter "Lesson Tags" tab): set, edit, or clear one lesson's chapter/term.
// Blank BOTH fields to clear. All lessons of one chapter (within one grade) must share
// the same term — a conflicting tag is rejected rather than silently applied.
function handleAdminSetLessonTags(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  var suffix = _gradeSuffixForLesson(lesson);
  if (!suffix) throw new Error("Tags can only be set on grade 1 or grade 2 baccalaureate lessons.");

  var chapterBlank = payload.chapter === "" || payload.chapter === null || payload.chapter === undefined;
  var termBlank = payload.term === "" || payload.term === null || payload.term === undefined;
  if (chapterBlank !== termBlank) throw new Error("Provide both chapter and term, or leave both blank to clear.");
  var clearing = chapterBlank && termBlank;
  var chapter = 0, term = 0;
  if (!clearing) {
    chapter = _wholePositiveInt(payload.chapter, "chapter");
    term = _wholePositiveInt(payload.term, "term");
  }

  return _withLock(function () {
    var ss = _ss();
    var sheet = _sheetByName(ss, "LessonTags", LESSONTAGS_HEADERS);
    _ensureColumns(sheet, LESSONTAGS_HEADERS);
    var c = _needCols(sheet, "LessonTags", LESSONTAGS_HEADERS);
    var last = sheet.getLastRow();
    var values = last >= 2 ? sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues() : [];
    var at = -1;
    for (var i = 0; i < values.length; i++) {
      if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) { at = i; break; }
    }

    if (!clearing) {
      for (var j = 0; j < values.length; j++) {
        if (j === at) continue;
        var otherLesson = _canonKey(String(values[j][c.lesson - 1]).trim().toLowerCase());
        if (_gradeSuffixForLesson(otherLesson) !== suffix) continue;
        if (parseInt(values[j][c.chapter - 1], 10) !== chapter) continue;
        var otherTerm = parseInt(values[j][c.term - 1], 10);
        if (otherTerm !== term) {
          throw new Error("Chapter " + chapter + " is already tagged term " + otherTerm + " for this grade \u2014 every lesson in a chapter must share the same term.");
        }
      }
    }

    var now = _fmt(new Date(), TZ, true);
    if (clearing) {
      if (at >= 0) sheet.deleteRows(at + 2, 1);
    } else if (at >= 0) {
      sheet.getRange(at + 2, c.chapter).setNumberFormat("@").setValue(chapter);
      sheet.getRange(at + 2, c.term).setNumberFormat("@").setValue(term);
      sheet.getRange(at + 2, c.updated_at).setNumberFormat("@").setValue(now);
    } else {
      _appendByHeader(sheet, { lesson: lesson, chapter: chapter, term: term, updated_at: now });
    }
    _lessonTagsCache = null;   // this request's cache is stale now
    return { ok: true, lesson: lesson, chapter: clearing ? "" : chapter, term: clearing ? "" : term };
  });
}

// Admin (Tkinter "Lesson Tags" tab): every tagged lesson, so the tab can show its current chapter/term.
function handleAdminListLessonTags(payload) {
  _requireAdminAny(payload);
  var map = _lessonTagsMap(_ss());
  return {
    ok: true,
    tags: Object.keys(map).sort().map(function (l) { return { lesson: l, chapter: map[l].chapter, term: map[l].term }; }),
  };
}

// One lesson path, "some/folder/*" (everything under it), "*" (everything), or a
// subscription scope ("<grade folder>#chN" / "<grade folder>#tN").
function _normalizeScope(raw) {
  var s = String(raw == null ? "" : raw).trim().toLowerCase()
    .replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "");
  if (s === "*") return "*";
  var hashAt = s.indexOf("#");
  if (hashAt !== -1) {
    var base = s.slice(0, hashAt), tag = s.slice(hashAt + 1);
    if (!GRADE_SCOPE_FOLDERS.hasOwnProperty(base)) {
      throw new Error("Subscription scopes are only valid for the grade 1 or grade 2 baccalaureate folders.");
    }
    var m = SUB_SCOPE_TAG_RE.exec(tag);
    if (!m) throw new Error('Subscription scope must end in "#ch<N>" or "#t<N>".');
    return base + "#" + m[1] + Number(m[2]);   // drops any leading zeros
  }
  if (/\/\*$/.test(s)) return _lessonPath(s.replace(/\/\*$/, "")) + "/*";
  return _lessonPath(s);
}

// Does a stored scope cover this lesson? "a/b/*" covers "a/b/x" but NOT "a/bx" or "a/b"
// itself. A "#ch"/"#t" scope covers a lesson under its grade folder only if the
// lesson's tags (from LessonTags, via `ss`) match — untagged lessons never match.
function _scopeCovers(scope, lesson, ss) {
  if (!scope) return false;
  scope = _canonKey(scope); lesson = _canonKey(lesson);
  if (scope === "*") return true;
  if (scope === lesson) return true;
  if (scope.slice(-2) === "/*") return lesson.indexOf(scope.slice(0, -1)) === 0;
  var hashAt = scope.indexOf("#");
  if (hashAt !== -1 && ss) {
    var base = scope.slice(0, hashAt);
    if (lesson.indexOf(base + "/") !== 0) return false;
    var tags = _lessonTagsMap(ss)[lesson];
    if (!tags) return false;
    var m = SUB_SCOPE_TAG_RE.exec(scope.slice(hashAt + 1));
    if (!m) return false;
    return m[1] === "ch" ? tags.chapter === Number(m[2]) : tags.term === Number(m[2]);
  }
  return false;
}

function _todayCairo() { return _fmt(new Date(), TZ, false); }

// Pure string/UTC arithmetic on "yyyy-MM-dd" — no time-zone surprises.
function _addDays(ymd, n) {
  var p = ymd.split("-");
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2);
}

function _cleanYmd(v) {
  var s = String(v == null ? "" : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || _addDays(s, 0) !== s) throw new Error('Dates must look like 2026-12-31.');
  return s;
}

// A sheet cell -> "yyyy-MM-dd", "" (blank), or null (unreadable). Sheets turns a date typed
// by hand into a Date cell, so both are understood.
function _ymdOf(v, tz) {
  if (v instanceof Date) return _fmt(v, tz || TZ, false);
  var s = String(v == null ? "" : v).trim();
  if (s === "") return "";
  var m = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(s);
  return m ? m[1] : null;
}

// days from the request, else the DEFAULT_ACCESS_DAYS Script Property, else 0 (= never expires).
function _accessDays(payload) {
  if (payload.days !== undefined && payload.days !== null && payload.days !== "") {
    var n = Number(payload.days);
    if (!isFinite(n) || n !== Math.floor(n) || n < 1 || n > 3650) throw new Error("days must be a whole number from 1 to 3650.");
    return n;
  }
  var d = parseInt(_props().getProperty("DEFAULT_ACCESS_DAYS") || "", 10);
  return d > 0 ? d : 0;
}

// The payment id behind an entitlement made by approving a request ("payment:p3fa91c2d"), else "".
function _sourcePayment(source) {
  var m = /^payment:(\S+)$/.exec(String(source == null ? "" : source).trim());
  return m ? m[1] : "";
}

// {payment_id: "approved" | "rejected" | ...} for every row of the Payments tab.
function _paymentStatuses(ss) {
  var map = {};
  var sheet = ss.getSheetByName("Payments");
  if (!sheet || sheet.getLastRow() < 2) return map;
  var c = _needCols(sheet, "Payments", ["payment_id", "status"]);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var id = String(r[c.payment_id - 1]).trim();
    if (id) map[id] = String(r[c.status - 1]).trim().toLowerCase();
  });
  return map;
}

// {active, expired}: does this phone hold a current entitlement covering the lesson?
// `expired` = the latest end date among covering entitlements that have run out.
// An entitlement that came from a payment only counts while that payment is still
// "approved" (a missing Payments row does not switch it off — only an explicit other status does).
function _accessState(ss, phone, lesson) {
  var out = { active: false, expired: null };
  var sheet = ss.getSheetByName("Entitlements");
  if (!sheet || sheet.getLastRow() < 2) return out;
  var c = _needCols(sheet, "Entitlements", ["phone", "scope", "expires_at"]);
  var srcCol = _headerIndex(sheet)["source"] || 0;
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo();
  var statuses = null;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (!_phonesMatch(values[i][c.phone - 1], phone)) continue;
    if (!_scopeCovers(_canonKey(String(values[i][c.scope - 1]).trim().toLowerCase()), lesson, ss)) continue;
    var ymd = _ymdOf(values[i][c.expires_at - 1], tz);
    if (ymd === null) continue;                       // unreadable date: fail closed
    if (ymd === "" || today <= ymd) {
      var pid = srcCol ? _sourcePayment(values[i][srcCol - 1]) : "";
      if (pid) {
        if (statuses === null) statuses = _paymentStatuses(ss);
        if (statuses.hasOwnProperty(pid) && statuses[pid] !== "approved") continue;   // payment cancelled
      }
      out.active = true;
      return out;
    }
    if (!out.expired || ymd > out.expired) out.expired = ymd;
  }
  return out;
}

// "pending" / "rejected" / "revoked" for this student's most recent request for exactly this lesson.
function _latestRequest(ss, phone, lesson) {
  var sheet = ss.getSheetByName("Payments");
  if (!sheet || sheet.getLastRow() < 2) return null;
  var c = _needCols(sheet, "Payments", ["phone", "scope", "status"]);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (!_phonesMatch(values[i][c.phone - 1], phone)) continue;
    if (_canonKey(String(values[i][c.scope - 1]).trim().toLowerCase()) !== lesson) continue;
    var st = String(values[i][c.status - 1]).trim().toLowerCase();
    return st === "pending" || st === "rejected" || st === "revoked" ? st : null;
  }
  return null;
}

// INSIDE the lock. Adds or extends one (phone, scope) entitlement and NEVER shortens it.
// explicitYmd wins; else `days` counts from the later of today / the current end date;
// else it never expires. Returns {scope, expires_at, extended}.
function _grantRaw(ss, phone, scope, explicitYmd, days, source) {
  var sheet = _sheetByName(ss, "Entitlements", ENT_HEADERS);
  _ensureColumns(sheet, ENT_HEADERS);
  var c = _needCols(sheet, "Entitlements", ENT_HEADERS);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo();
  var now = _fmt(new Date(), TZ, true);

  var found = null;
  if (sheet.getLastRow() >= 2) {
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < values.length; i++) {
      if (_phonesMatch(values[i][c.phone - 1], phone) && _canonKey(String(values[i][c.scope - 1]).trim().toLowerCase()) === scope) {
        found = { row: i + 2, ymd: _ymdOf(values[i][c.expires_at - 1], tz),      // null = unreadable
                  source: String(values[i][c.source - 1] == null ? "" : values[i][c.source - 1]).trim() };
        break;
      }
    }
  }
  var existing = found ? found.ymd : null;

  var target;
  if (explicitYmd) target = explicitYmd;
  else if (days) target = _addDays(existing && existing > today ? existing : today, days);
  else target = "";
  if (found && existing === "") target = "";                                  // already forever: keep it
  else if (found && existing && target !== "" && existing > target) target = existing;   // never shorten

  if (found) {
    // Extending by hand keeps the link to the payment behind the access (so cancelling that payment
    // still switches it off) — unless that payment was already cancelled: then the teacher is
    // deliberately switching it back on, and it becomes a manual grant. A hand-typed source stays as typed.
    var newSource = source;
    if (source === "manual" && found.source) {
      var oldPid = _sourcePayment(found.source);
      if (!oldPid) newSource = found.source;
      else {
        var st = _paymentStatuses(ss);
        if (!st.hasOwnProperty(oldPid) || st[oldPid] === "approved") newSource = found.source;
      }
    }
    sheet.getRange(found.row, c.expires_at).setNumberFormat("@").setValue(target);
    sheet.getRange(found.row, c.granted_at).setNumberFormat("@").setValue(now);
    sheet.getRange(found.row, c.source).setNumberFormat("@").setValue(newSource);
  } else {
    _appendByHeader(sheet, { phone: phone, scope: scope, expires_at: target, granted_at: now, source: source });
  }
  return { scope: scope, expires_at: target, extended: !!found };
}

// The student's "I paid" button. Adds a PENDING row only — nothing unlocks until
// an admin approves it.
function handleRequestAccess(payload) {
  _requireStudentSession(payload);
  var lesson = _lessonPath(payload.lesson);
  var reference = String(payload.reference == null ? "" : payload.reference).trim().slice(0, 200);
  if (!reference) throw new Error("Enter the payment reference (or the phone number you paid from).");
  var note = String(payload.note == null ? "" : payload.note).trim().slice(0, 500);
  var found = _findStudentRow(_students(), payload.student_id);
  if (!found) throw new Error("No matching student.");
  var phone = _canonicalPhone(found.phone) || String(found.phone);

  var ss = _ss();
  if (_accessState(ss, phone, lesson).active) return { ok: true, status: "active" };

  var res = _withLock(function () {
    var sheet = _sheetByName(ss, "Payments", PAYMENT_HEADERS);
    _ensureColumns(sheet, PAYMENT_HEADERS);
    var pending = 0, dup = null;
    if (sheet.getLastRow() >= 2) {
      var c = _needCols(sheet, "Payments", PAYMENT_HEADERS);
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
        if (String(r[c.status - 1]).trim().toLowerCase() !== "pending" || !_phonesMatch(r[c.phone - 1], phone)) return;
        pending++;
        if (!dup && _canonKey(String(r[c.scope - 1]).trim().toLowerCase()) === lesson) dup = String(r[c.payment_id - 1]);
      });
    }
    if (dup) return { ok: true, status: "pending", duplicate: true, payment_id: dup };   // double-tap / resend
    if (pending >= MAX_PENDING_REQUESTS) {
      throw new Error("You already have " + pending + " requests waiting for approval — please wait until they are reviewed.");
    }
    var id = "p" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    _appendByHeader(sheet, {
      payment_id: id, phone: phone, name: String(found.display_name == null ? "" : found.display_name),
      scope: lesson, reference: reference, note: note, status: "pending",
      created_at: _fmt(new Date(), TZ, true), decided_at: "",
    });
    return { ok: true, status: "pending", payment_id: id };
  });
  if (res && res.ok && res.status === "pending" && !res.duplicate) {
    _notifyAdmin("\ud83d\udcb3 <b>Payment request</b>\n\n\ud83d\udc64 " + _esc(found.display_name) + "\n\ud83d\udcf1 " + _esc(phone) +
      "\n\ud83d\udcd8 " + _esc(_prettyLesson(lesson)) + "\n\ud83e\uddfe Ref: " + _esc(reference), res.payment_id);
  }
  return res;
}

// -- Grade subscriptions: buying a chapter or the current term ----------------------
// Students use get_subscription_options (what can I buy, and what is my state for each?)
// and request_subscription (the "I paid" for one chapter/term). The scope string, the
// label and the price are all built HERE — nothing but the item and the reference comes
// from the client. Approval is unchanged from chunk 1 (handleAdminDecidePayment).

var CHAPTER_PRICE_EGP = 250;
var TERM_PRICE_EGP = 1000;
var MAX_PENDING_SUBSCRIPTIONS = 20;   // its own cap; MAX_PENDING_REQUESTS only guards request_access

// "grade-1-secondary" / "1" / "g1" / the full folder -> the full grade folder, else an error.
function _gradeFolder(raw) {
  var s = String(raw == null ? "" : raw).trim().toLowerCase()
    .replace(/^programming\/baccalaureate\//, "").replace(/^\/+|\/+$/g, "");
  var m = /^(?:g|grade-)?([12])(?:-secondary)?$/.exec(s);
  if (!m) throw new Error("Unknown grade.");
  return "programming/baccalaureate/grade-" + m[1] + "-secondary";
}

// "Grade 1 \u00b7 Chapter 3 \u00b7 250 EGP" — goes in the Payments `note`, so the dashboard needs no new column.
function _subscriptionLabel(suffix, kind, n) {
  return "Grade " + suffix.slice(1) + " \u00b7 " + (kind === "ch" ? "Chapter " : "Term ") + n +
         " \u00b7 " + (kind === "ch" ? CHAPTER_PRICE_EGP : TERM_PRICE_EGP) + " EGP";
}

// Chapters that have at least one tagged lesson under this grade: [{chapter, term, lessons}], by chapter.
function _gradeChapters(ss, base) {
  var tags = _lessonTagsMap(ss), by = {};
  for (var lesson in tags) {
    if (lesson.indexOf(base + "/") !== 0) continue;
    var tg = tags[lesson];
    var e = by[tg.chapter] || (by[tg.chapter] = { chapter: tg.chapter, term: tg.term, lessons: 0 });
    e.lessons++;
  }
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.chapter - b.chapter; });
}

// The signed-in student's canonical phone, or "" (no/stale session, or an admin session).
function _subscriberPhone(payload) {
  if (_sessionState(payload) !== "student") return "";
  var found = _findStudentRow(_students(), payload.student_id);
  return found ? (_canonicalPhone(found.phone) || String(found.phone)) : "";
}

// {scope: true} for every "#" scope this phone holds RIGHT NOW: not expired, and (if it came
// from a payment) that payment still approved — the same rules _accessState applies.
function _heldSubscriptionScopes(ss, phone) {
  var held = {};
  var sheet = ss.getSheetByName("Entitlements");
  if (!sheet || sheet.getLastRow() < 2) return held;
  var c = _needCols(sheet, "Entitlements", ["phone", "scope", "expires_at"]);
  var srcCol = _headerIndex(sheet)["source"] || 0;
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo(), statuses = null;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var scope = _canonKey(String(r[c.scope - 1]).trim().toLowerCase());
    if (scope.indexOf("#") === -1 || !_phonesMatch(r[c.phone - 1], phone)) return;
    var ymd = _ymdOf(r[c.expires_at - 1], tz);
    if (ymd === null || (ymd !== "" && today > ymd)) return;
    var pid = srcCol ? _sourcePayment(r[srcCol - 1]) : "";
    if (pid) {
      if (statuses === null) statuses = _paymentStatuses(ss);
      if (statuses.hasOwnProperty(pid) && statuses[pid] !== "approved") return;
    }
    held[scope] = true;
  });
  return held;
}

// {scope: payment_id} for this phone's PENDING "#" requests (the newest wins per scope).
function _pendingSubscriptionScopes(ss, phone) {
  var out = {};
  var sheet = ss.getSheetByName("Payments");
  if (!sheet || sheet.getLastRow() < 2) return out;
  var c = _needCols(sheet, "Payments", ["payment_id", "phone", "scope", "status"]);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var scope = _canonKey(String(r[c.scope - 1]).trim().toLowerCase());
    if (scope.indexOf("#") === -1 || String(r[c.status - 1]).trim().toLowerCase() !== "pending") return;
    if (_phonesMatch(r[c.phone - 1], phone)) out[scope] = String(r[c.payment_id - 1]);
  });
  return out;
}

// Public read (like get_video): a missing/stale session just means "not signed in", and every
// item then shows "available". Never creates a tab.
function handleGetSubscriptionOptions(payload) {
  var base = _gradeFolder(payload.grade), suffix = GRADE_SCOPE_FOLDERS[base];
  var ss = _ss();
  var phone = _subscriberPhone(payload);
  var held = phone ? _heldSubscriptionScopes(ss, phone) : {};
  var pending = phone ? _pendingSubscriptionScopes(ss, phone) : {};
  var current = _gradeCurrentTerm(suffix);

  var chapters = _gradeChapters(ss, base);
  var termLessons = 0;
  var list = chapters.map(function (ch) {
    var state = "available";
    if (held[base + "#ch" + ch.chapter]) state = "owned";
    else if (held[base + "#t" + ch.term]) state = "covered_by_term";
    else if (pending[base + "#ch" + ch.chapter]) state = "pending";
    if (ch.term === current) termLessons += ch.lessons;
    return { chapter: ch.chapter, term: ch.term, lessons: ch.lessons, price: CHAPTER_PRICE_EGP, state: state };
  });
  var term = null;
  if (termLessons > 0) {
    var tState = held[base + "#t" + current] ? "owned" : (pending[base + "#t" + current] ? "pending" : "available");
    term = { term: current, lessons: termLessons, price: TERM_PRICE_EGP, state: tState };
  }
  return { ok: true, grade: base.split("/").pop(), signed_in: !!phone, year_end: _gradeYearEnd(suffix),
           pay_info_chapter: _payInfoProp("PAY_INSTRUCTIONS_CHAPTER"),
           pay_info_term: _payInfoProp("PAY_INSTRUCTIONS_TERM"),
           current_term: current, prices: { chapter: CHAPTER_PRICE_EGP, term: TERM_PRICE_EGP },
           chapters: list, term: term };
}

// The student's "I paid" for ONE chapter or the current term. Adds a PENDING row only.
function handleRequestSubscription(payload) {
  _requireStudentSession(payload);
  var base = _gradeFolder(payload.grade), suffix = GRADE_SCOPE_FOLDERS[base];
  var type = String(payload.item_type == null ? "" : payload.item_type).trim().toLowerCase();
  var kind, n;
  if (type === "chapter") { kind = "ch"; n = _wholePositiveInt(payload.chapter, "chapter"); }
  else if (type === "term") { kind = "t"; n = _wholePositiveInt(payload.term, "term"); }
  else throw new Error('item_type must be "chapter" or "term".');
  var reference = String(payload.reference == null ? "" : payload.reference).trim().slice(0, 200);
  if (!reference) throw new Error("Enter the payment reference (or the phone number you paid from).");
  var found = _findStudentRow(_students(), payload.student_id);
  if (!found) throw new Error("No matching student.");
  var phone = _canonicalPhone(found.phone) || String(found.phone);
  var scope = base + "#" + kind + n;

  var res = _withLock(function () {
    var ss = _ss();
    var chapters = _gradeChapters(ss, base);
    var held = _heldSubscriptionScopes(ss, phone);
    if (kind === "ch") {
      var ch = chapters.filter(function (x) { return x.chapter === n; })[0];
      if (!ch) throw new Error("That chapter isn't available yet.");
      if (held[scope]) throw new Error("You already own this chapter.");
      if (held[base + "#t" + ch.term]) throw new Error("Your term subscription already covers this chapter.");
    } else {
      var current = _gradeCurrentTerm(suffix);
      if (n !== current) throw new Error("Only the current term (term " + current + ") can be bought.");
      if (!chapters.some(function (x) { return x.term === n; })) throw new Error("That term isn't available yet.");
      if (held[scope]) throw new Error("You already own this term.");
    }

    var sheet = _sheetByName(ss, "Payments", PAYMENT_HEADERS);
    _ensureColumns(sheet, PAYMENT_HEADERS);
    var pendingSubs = 0, dup = null;
    if (sheet.getLastRow() >= 2) {
      var c = _needCols(sheet, "Payments", PAYMENT_HEADERS);
      sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
        var rs = _canonKey(String(r[c.scope - 1]).trim().toLowerCase());
        if (rs.indexOf("#") === -1 || String(r[c.status - 1]).trim().toLowerCase() !== "pending" || !_phonesMatch(r[c.phone - 1], phone)) return;
        pendingSubs++;
        if (!dup && rs === scope) dup = String(r[c.payment_id - 1]);
      });
    }
    if (dup) return { ok: true, status: "pending", duplicate: true, payment_id: dup };   // double-tap / resend
    if (pendingSubs >= MAX_PENDING_SUBSCRIPTIONS) {
      throw new Error("You already have " + pendingSubs + " subscription requests waiting for approval — please wait until they are reviewed.");
    }
    var id = "p" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    var note = _subscriptionLabel(suffix, kind, n);
    _appendByHeader(sheet, {
      payment_id: id, phone: phone, name: String(found.display_name == null ? "" : found.display_name),
      scope: scope, reference: reference, note: note, status: "pending",
      created_at: _fmt(new Date(), TZ, true), decided_at: "",
    });
    return { ok: true, status: "pending", payment_id: id, scope: scope, note: note,
             price: kind === "ch" ? CHAPTER_PRICE_EGP : TERM_PRICE_EGP };
  });
  if (res && res.ok && res.status === "pending" && !res.duplicate) {
    _notifyAdmin("\ud83d\udd14 <b>Subscription request</b>\n\n\ud83d\udc64 " + _esc(found.display_name) + "\n\ud83d\udcf1 " + _esc(phone) +
      "\n\ud83d\udce6 " + _esc(res.note) + "\n\ud83e\uddfe Ref: " + _esc(reference), res.payment_id);
  }
  return res;
}

// status: pending (default) | approved | rejected | all. Newest first, at most 300.
function handleAdminListPayments(payload) {
  _requireAdminAny(payload);
  var want = String(payload.status || "pending").trim().toLowerCase();
  if (["pending", "approved", "rejected", "all"].indexOf(want) === -1) {
    throw new Error('status must be "pending", "approved", "rejected" or "all".');
  }
  var sheet = _ss().getSheetByName("Payments");
  var rows = sheet && sheet.getLastRow() >= 2 ? _sheetValuesAsObjects(sheet) : [];
  var list = rows.map(function (r) {
    return { payment_id: String(r.payment_id || ""), phone: String(r.phone || ""), name: String(r.name || ""),
             scope: String(r.scope || ""), reference: String(r.reference || ""), note: String(r.note || ""),
             status: String(r.status || "").trim().toLowerCase(), created_at: String(r.created_at || ""),
             decided_at: String(r.decided_at || "") };
  }).filter(function (p) { return want === "all" || p.status === want; }).reverse();
  return { ok: true, payments: list.slice(0, 300) };
}

// Approve (writes the entitlement) or reject a PENDING request. scope may widen what
// the student asked for (e.g. their whole grade); expires_at / days / DEFAULT_ACCESS_DAYS
// set how long it lasts.
function handleAdminDecidePayment(payload) {
  _requireAdminAny(payload);
  var id = String(payload.payment_id == null ? "" : payload.payment_id).trim();
  var decision = String(payload.decision == null ? "" : payload.decision).trim().toLowerCase();
  if (!id) throw new Error("Missing payment_id.");
  if (decision !== "approve" && decision !== "reject") throw new Error('decision must be "approve" or "reject".');
  var scopeOverride = payload.scope ? _normalizeScope(payload.scope) : "";
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = decision === "approve" && !explicit && payload.never !== true ? _accessDays(payload) : 0;

  return _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Payments");
    if (!sheet || sheet.getLastRow() < 2) throw new Error("No such payment.");
    var c = _needCols(sheet, "Payments", PAYMENT_HEADERS);
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var at = -1;
    for (var i = 0; i < values.length; i++) if (String(values[i][c.payment_id - 1]).trim() === id) { at = i; break; }
    if (at < 0) throw new Error("No such payment.");
    var row = at + 2, r = values[at];
    var status = String(r[c.status - 1]).trim().toLowerCase();
    if (status !== "pending") throw new Error("This request was already " + status + ".");

    var out = { ok: true, payment_id: id, phone: String(r[c.phone - 1]), name: String(r[c.name - 1]) };
    if (decision === "approve") {
      var scope = scopeOverride || _normalizeScope(r[c.scope - 1]);
      var g;
      var subSuffix = _subscriptionGradeSuffix(scope);
      if (subSuffix) {
        // Subscription scopes: the manual scope/duration inputs are ignored — access
        // always runs to the grade's year-end.
        var yearEnd = _gradeYearEnd(subSuffix);
        if (_todayCairo() > yearEnd) {
          throw new Error("This grade's year has already ended (" + yearEnd + ") \u2014 update YEAR_END_" + subSuffix + " first.");
        }
        g = _grantRaw(ss, _canonicalPhone(r[c.phone - 1]) || String(r[c.phone - 1]), scope, yearEnd, 0, "payment:" + id);
      } else {
        g = _grantRaw(ss, _canonicalPhone(r[c.phone - 1]) || String(r[c.phone - 1]), scope, explicit, days, "payment:" + id);
      }
      out.scope = g.scope; out.expires_at = g.expires_at; out.extended = g.extended;
    }
    out.status = decision === "approve" ? "approved" : "rejected";
    sheet.getRange(row, c.status).setNumberFormat("@").setValue(out.status);
    sheet.getRange(row, c.decided_at).setNumberFormat("@").setValue(_fmt(new Date(), TZ, true));
    return out;
  });
}

// Unlock by hand with no request (cash in person, a mistake to fix). The phone may be
// typed any way (+20…, 0020…, missing leading 0). Works even for someone who has not
// registered yet — `known_student` tells you whether that number has an account.
function handleAdminGrantAccess(payload) {
  _requireAdminAny(payload);
  if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
  var phone = _canonicalPhone(payload.phone);
  var scope = _normalizeScope(payload.scope);
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);
  var g = _withLock(function () { return _grantRaw(_ss(), phone, scope, explicit, days, "manual"); });
  var stu = _findStudentRow(_students(), phone);
  return { ok: true, phone: phone, scope: g.scope, expires_at: g.expires_at, extended: g.extended,
           known_student: !!stu, name: stu ? String(stu.display_name == null ? "" : stu.display_name) : "" };
}

// Ends access: deletes the matching entitlement row(s) and marks the payment behind
// each one "revoked". By {phone, scope} (exactly that grant — other scopes the student
// holds are untouched) or by {payment_id} (whatever that payment granted).
function handleAdminRevokeAccess(payload) {
  _requireAdminAny(payload);
  var pid = String(payload.payment_id == null ? "" : payload.payment_id).trim();
  var phone = "", scope = "";
  if (!pid) {
    if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
    phone = _canonicalPhone(payload.phone);
    scope = _normalizeScope(payload.scope);
  }
  return _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Entitlements");
    if (!sheet || sheet.getLastRow() < 2) throw new Error("No matching access to revoke.");
    var c = _needCols(sheet, "Entitlements", ["phone", "scope"]);
    var srcCol = _headerIndex(sheet)["source"] || 0;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var rows = [], pays = [], seenScope = "", seenPhone = "";
    for (var i = 0; i < values.length; i++) {
      var src = srcCol ? _sourcePayment(values[i][srcCol - 1]) : "";
      var rowScope = _canonKey(String(values[i][c.scope - 1]).trim().toLowerCase());
      var hit = pid ? src === pid : (_phonesMatch(values[i][c.phone - 1], phone) && rowScope === scope);
      if (!hit) continue;
      rows.push(i + 2);
      if (src) pays.push(src);
      seenScope = rowScope; seenPhone = String(values[i][c.phone - 1]);
    }
    if (!rows.length) throw new Error("No matching access to revoke.");
    rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });

    var marked = [];
    var pSheet = pays.length ? ss.getSheetByName("Payments") : null;
    if (pSheet && pSheet.getLastRow() >= 2) {
      var pc = _needCols(pSheet, "Payments", ["payment_id", "status", "decided_at"]);
      var pv = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, pSheet.getLastColumn()).getValues();
      var now = _fmt(new Date(), TZ, true);
      for (var k = 0; k < pv.length; k++) {
        var id = String(pv[k][pc.payment_id - 1]).trim();
        if (pays.indexOf(id) === -1 || String(pv[k][pc.status - 1]).trim().toLowerCase() !== "approved") continue;
        pSheet.getRange(k + 2, pc.status).setNumberFormat("@").setValue("revoked");
        pSheet.getRange(k + 2, pc.decided_at).setNumberFormat("@").setValue(now);
        marked.push(id);
      }
    }
    return { ok: true, removed: rows.length, phone: _canonicalPhone(seenPhone) || seenPhone, scope: seenScope, payments_revoked: marked };
  });
}

function _daysBetween(fromYmd, toYmd) {
  var a = fromYmd.split("-"), b = toYmd.split("-");
  return Math.round((Date.UTC(+b[0], +b[1] - 1, +b[2]) - Date.UTC(+a[0], +a[1] - 1, +a[2])) / 86400000);
}

// -- All lessons on the site, straight from GitHub -----------------------------------
// The Videos/Quizzes sheets only know about a lesson once something toggles its lock,
// so they're useless for "let me pick ANY lesson to gate." This reads the real lesson
// list from the site's GitHub repo instead: one recursive tree call, cached for
// LESSON_LIST_CACHE_SECONDS so repeat dashboard loads don't re-hit GitHub or add
// noticeable delay. Needs Script Properties: GITHUB_REPO ("owner/repo"), optionally
// GITHUB_BRANCH (default "main") and GITHUB_TOKEN (raises the 60/hr anonymous rate
// limit to 5000/hr — recommended, but not required for a public repo).
var LESSON_LIST_CACHE_SECONDS = 600;
var LESSON_EXCLUDE_PREFIXES = ["dashboard/", "tools/", "assets/", "_deleted-lessons/", "icons/", ".git/", "Docs/", "packaged/"];

function _allLessonsFromGithub() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("all_lessons_v2");
  if (hit !== null) return JSON.parse(hit);

  var props = _props();
  var repo = props.getProperty("GITHUB_REPO");
  if (!repo) throw new Error('Set the GITHUB_REPO Script Property (e.g. "yourname/teaching.ezznasr.dev") to list lessons.');
  var branch = props.getProperty("GITHUB_BRANCH") || "main";
  var token = props.getProperty("GITHUB_TOKEN");

  var headers = { "Accept": "application/vnd.github+json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  var url = "https://api.github.com/repos/" + repo + "/git/trees/" + branch + "?recursive=1";
  var resp = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error("Couldn't list lessons from GitHub (HTTP " + resp.getResponseCode() + "). Check GITHUB_REPO/GITHUB_BRANCH/GITHUB_TOKEN.");
  }
  var body = JSON.parse(resp.getContentText());
  if (body.truncated) {
    // Repo tree too large for one call — still usable, just possibly incomplete.
  }
  var blobPaths = {};
  (body.tree || []).forEach(function (item) { if (item.type === "blob") blobPaths[item.path] = 1; });

  var lessons = [];
  Object.keys(blobPaths).forEach(function (p) {
    if (!/\/index\.html$/.test(p)) return;
    var dir = p.slice(0, -"/index.html".length);
    if (!dir || dir.indexOf("/") === -1) return;   // top-level index / a track's own landing page
    if (LESSON_EXCLUDE_PREFIXES.some(function (pre) { return dir.indexOf(pre) === 0; })) return;
    // A real lesson folder has a quiz or an assignment page next to its index.
    if (!blobPaths[dir + "/quiz.html"] && !blobPaths[dir + "/assignment.html"]) return;
    lessons.push({ lesson: dir.toLowerCase(), track: dir.split("/")[0].toLowerCase(),
                   has_quiz: !!blobPaths[dir + "/quiz.html"], has_assignment: !!blobPaths[dir + "/assignment.html"] });
  });
  lessons.sort(function (a, b) { return a.lesson < b.lesson ? -1 : 1; });

  var tracks = Object.keys(lessons.reduce(function (acc, l) { acc[l.track] = 1; return acc; }, {})).sort();
  var result = { lessons: lessons, tracks: tracks };
  cache.put("all_lessons_v2", JSON.stringify(result), LESSON_LIST_CACHE_SECONDS);
  return result;
}

// Public: the dashboard calls this to refresh its lesson picker on demand (e.g. a
// "Refresh list" button), bypassing nothing — it shares the same cache as the
// overview call, it just lets the admin force a wait for a fresh GitHub read isn't
// needed since the cache already expires on its own after LESSON_LIST_CACHE_SECONDS.
function handleAdminListLessons(payload) {
  _requireAdminAny(payload);
  var got = _allLessonsFromGithub();
  return { ok: true, lessons: got.lessons, tracks: got.tracks };
}

// Everything the access dashboard shows, in one round trip. Read-only.
function handleAdminAccessOverview(payload) {
  _requireAdminAny(payload);
  var ss = _ss();
  var today = _todayCairo();
  var tz = TZ;

  var nameByKey = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) {
    var k = _phoneKey(r.phone);
    if (k && !nameByKey.hasOwnProperty(k)) nameByKey[k] = String(r.display_name == null ? "" : r.display_name);
  });
  function who(phone) {
    var k = _phoneKey(phone);
    return { known: nameByKey.hasOwnProperty(k), name: nameByKey.hasOwnProperty(k) ? nameByKey[k] : "" };
  }

  // Roster for the group picker: every registered student (admin-only endpoint).
  var roster = _sheetValuesAsObjects(_students()).map(function (r) {
    return { phone: String(r.phone == null ? "" : r.phone), name: String(r.display_name == null ? "" : r.display_name),
             year: String(r.year == null ? "" : r.year) };
  }).filter(function (r) { return _phoneKey(r.phone); })
    .sort(function (a, b) { return (a.name || a.phone).toLowerCase() < (b.name || b.phone).toLowerCase() ? -1 : 1; });

  var vSheet = ss.getSheetByName("Videos");
  var videos = (vSheet && vSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(vSheet) : []).map(function (r) {
    return { lesson: String(r.lesson || ""), slot: String(r.slot || ""), embed_url: String(r.embed_url || ""),
             locked: _isLockedCell(r.locked), updated_at: String(r.updated_at || "") };
  });

  var qSheet = ss.getSheetByName("Quizzes");
  var quizzes = (qSheet && qSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(qSheet) : []).map(function (r) {
    return { lesson: String(r.lesson || ""), locked: _isLockedCell(r.locked), updated_at: String(r.updated_at || "") };
  });

  var lSheet = ss.getSheetByName("Lessons");
  var lessonLocks = (lSheet && lSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(lSheet) : []).map(function (r) {
    return { lesson: String(r.lesson || ""), locked: _isLockedCell(r.locked), updated_at: String(r.updated_at || "") };
  });

  var gSheet = ss.getSheetByName("Groups");
  var groupsByKey = {};
  _groupMembers(gSheet, "", who).forEach(function (m) {
    var k = _groupKey(m.group);
    if (!groupsByKey[k]) groupsByKey[k] = { group: m.group, members: [] };
    groupsByKey[k].members.push({ phone: m.phone, name: m.name, known_student: m.known_student });
  });
  var groupSpellings = _groupSpellings(gSheet);
  var groups = Object.keys(groupsByKey).map(function (k) {
    var g = groupsByKey[k]; g.group = groupSpellings[k] || g.group; g.grants = _groupGrantsForApi(ss, k); return g;
  }).sort(function (a, b) { return a.group.toLowerCase() < b.group.toLowerCase() ? -1 : 1; });

  var pSheet = ss.getSheetByName("Payments");
  var payRows = (pSheet && pSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(pSheet) : []).map(function (r) {
    return { payment_id: String(r.payment_id || "").trim(), phone: String(r.phone || ""), name: String(r.name || ""),
             scope: String(r.scope || "").trim().toLowerCase(), reference: String(r.reference || ""), note: String(r.note || ""),
             status: String(r.status || "").trim().toLowerCase(), created_at: String(r.created_at || ""),
             decided_at: String(r.decided_at || "") };
  });
  var statusById = {};
  payRows.forEach(function (p) { if (p.payment_id) statusById[p.payment_id] = p.status; });

  var eSheet = ss.getSheetByName("Entitlements");
  var access = (eSheet && eSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(eSheet) : []).map(function (r) {
    var scope = String(r.scope || "").trim().toLowerCase();
    var ymd = _ymdOf(r.expires_at, tz);
    var pid = _sourcePayment(r.source);
    var pst = pid && statusById.hasOwnProperty(pid) ? statusById[pid] : "";
    var state, left = null;
    if (pid && pst && pst !== "approved") state = "cancelled";
    else if (ymd === null) state = "invalid";
    else if (ymd === "") state = "active";
    else { left = _daysBetween(today, ymd); state = left >= 0 ? "active" : "expired"; }
    var w = who(r.phone);
    return { phone: String(r.phone || ""), name: w.name, known_student: w.known, scope: scope,
             expires_at: ymd === null ? String(r.expires_at || "") : ymd, granted_at: String(r.granted_at || ""),
             source: String(r.source || ""), payment_id: pid, payment_status: pst, state: state, days_left: left };
  });

  var accessByPayment = {};
  access.forEach(function (a) { if (a.payment_id) accessByPayment[a.payment_id] = a; });
  var payments = payRows.map(function (p) {
    var a = accessByPayment[p.payment_id];
    var w = who(p.phone);
    p.known_student = w.known;
    if (!p.name && w.name) p.name = w.name;
    if (a) { p.access_until = a.expires_at === "" ? "never" : a.expires_at; p.access_state = a.state; }
    return p;
  });

  var counts = { pending: 0, active: 0, ending_soon: 0, expired: 0, cancelled: 0, invalid: 0, videos_locked: 0, videos_open: 0, quizzes_locked: 0, lessons_locked: 0, groups: 0 };
  payments.forEach(function (p) { if (p.status === "pending") counts.pending++; });
  access.forEach(function (a) {
    counts[a.state]++;
    if (a.state === "active" && a.days_left !== null && a.days_left <= 7) counts.ending_soon++;
  });
  videos.forEach(function (v) { if (v.locked) counts.videos_locked++; else counts.videos_open++; });
  quizzes.forEach(function (q) { if (q.locked) counts.quizzes_locked++; });
  lessonLocks.forEach(function (l) { if (l.locked) counts.lessons_locked++; });
  counts.groups = groups.length;

  // Soft-fail: a GitHub hiccup or a missing GITHUB_REPO property shouldn't take down
  // the whole dashboard. The lesson pickers fall back to whatever Videos/Quizzes
  // already know about when this comes back empty.
  var allLessons = [], tracks = [], lessonsError = "";
  try {
    var got = _allLessonsFromGithub();
    allLessons = got.lessons; tracks = got.tracks;
  } catch (e) {
    lessonsError = String(e.message || e);
  }

  var qaSheet = ss.getSheetByName("QuizAccess");
  var quizAccess = (qaSheet && qaSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(qaSheet) : []).map(function (r) {
    var ymd = _ymdOf(r.expires_at, tz);
    var state;
    if (ymd === null) state = "invalid";
    else if (ymd === "") state = "active";
    else state = _daysBetween(today, ymd) >= 0 ? "active" : "expired";
    var w = who(r.phone);
    return { phone: String(r.phone || ""), name: w.name, lesson: String(r.lesson || ""),
             expires_at: ymd === null ? String(r.expires_at || "") : ymd, granted_at: String(r.granted_at || ""),
             source: String(r.source || ""), state: state };
  });

  var yearEnds = {};
  Object.keys(GRADE_SCOPE_FOLDERS).forEach(function (base) {
    try { yearEnds[base] = _gradeYearEnd(GRADE_SCOPE_FOLDERS[base]); } catch (e) { yearEnds[base] = ""; }
  });

  return { ok: true, today: today, counts: counts, videos: videos, quizzes: quizzes, groups: groups, roster: roster,
           payments: payments.reverse().slice(0, 500), access: access.reverse().slice(0, 1000),
           all_lessons: allLessons, tracks: tracks, lessons_error: lessonsError,
           quiz_access: quizAccess.reverse().slice(0, 1000), lesson_locks: lessonLocks, year_ends: yearEnds };
}

// -- Follow-up dashboard -----------------------------------------------------------
// See the "Follow-up dashboard" note at the top of this file. The overview returns RAW
// FACTS; every verdict ("hasn't watched", "homework missing"...) is decided in the page's
// followup-logic.js so the rules can change without redeploying this file.
var ATTENDANCE_HEADERS = ["lesson", "phone", "mode", "marked_at"];
var WATCH_HEADERS = ["phone", "lesson", "pct", "duration_s", "first_at", "updated_at"];
var GROUPSETTINGS_HEADERS = ["group_key", "group", "weekday", "time", "current_lesson", "review_lessons", "note",
                             "parents_contacted", "watch_deadline_override", "hw_deadline_override", "updated_at",
                             "hw_lessons", "quiz_lessons"];   // Oct 22: homework and quiz lessons chosen separately; blank cell = follow review_lessons
var FOLLOWUP_TEMPLATE_HEADERS = ["key", "body", "updated_at"];
var ATTENDANCE_MODES = { center: 1, online: 1 };
var ATTENDANCE_SOURCE = "attendance";
var MAX_ATTENDANCE_ITEMS = 500;
var MAX_REVIEW_LESSONS = 5;
var MAX_TEMPLATE_KEYS = 30;
var MAX_TEMPLATE_BODY = 4000;
var MAX_GROUP_NOTE = 2000;
var WATCH_THROTTLE_SECONDS = 10;
var FOLLOWUP_TEMPLATE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Script Properties FOLLOWUP_WATCH_DONE_PCT / FOLLOWUP_PRAISE_QUIZ_PCT / FOLLOWUP_WATCH_DAYS_BEFORE /
// FOLLOWUP_HW_DAYS_BEFORE override these defaults; anything unreadable falls back to the default.
function _followupSettings() {
  function num(prop, dflt, lo, hi) {
    var n = parseFloat(_props().getProperty(prop));
    return isFinite(n) && n >= lo && n <= hi ? n : dflt;
  }
  return {
    watch_done_pct: num("FOLLOWUP_WATCH_DONE_PCT", 80, 1, 100),
    praise_quiz_pct: num("FOLLOWUP_PRAISE_QUIZ_PCT", 90, 1, 100),
    watch_days_before: num("FOLLOWUP_WATCH_DAYS_BEFORE", 3, 0, 30),
    hw_days_before: num("FOLLOWUP_HW_DAYS_BEFORE", 1, 0, 30),
  };
}

// The tab, created on first use. A second request creating it at the same moment is harmless.
function _followupSheet(ss, name, headers) {
  try { return _sheetByName(ss, name, headers); }
  catch (e) {
    var again = ss.getSheetByName(name);
    if (again) return again;
    throw e;
  }
}

// Reads a few COLUMNS of a sheet (one range call each) instead of the whole grid —
// QuizResults/Submissions rows carry big JSON blobs that the overview never needs.
// Returns {n: rowCount, col: {name: [values]}}; an optional column that is missing reads as "".
function _readColumns(sheet, required, optional, tabName) {
  var out = { n: 0, col: {} };
  if (!sheet || sheet.getLastRow() < 2) return out;
  var idx = _needCols(sheet, tabName, required);
  var n = sheet.getLastRow() - 1;
  out.n = n;
  required.concat(optional || []).forEach(function (name) {
    if (!idx[name]) {
      var blanks = [];
      for (var i = 0; i < n; i++) blanks.push("");
      out.col[name] = blanks;
      return;
    }
    out.col[name] = sheet.getRange(2, idx[name], n, 1).getValues().map(function (r) { return r[0]; });
  });
  return out;
}

function _lastSegment(path) {
  var parts = String(path).split("/");
  return parts[parts.length - 1];
}

function _firstSegment(path) {
  return String(path).split("/")[0];
}

// "yyyy-MM-ddTHH:mm:ss+03:00" for a moment, using Cairo's real offset (+02:00 / +03:00).
function _cairoIso(d) {
  var local = _fmt(d, TZ, true);                       // "yyyy-MM-dd HH:mm:ss" in Cairo
  var p = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(local);
  var asUtc = Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]);
  var mins = Math.round((asUtc - d.getTime()) / 60000 / 15) * 15;
  var sign = mins < 0 ? "-" : "+";
  mins = Math.abs(mins);
  return local.replace(" ", "T") + sign + ("0" + Math.floor(mins / 60)).slice(-2) + ":" + ("0" + (mins % 60)).slice(-2);
}

// "HH:MM" from a GroupSettings cell (Sheets may have turned it into a time cell), else "".
function _hhmmOf(v) {
  if (v instanceof Date) return _fmt(v, TZ, true).slice(11, 16);
  var s = String(v == null ? "" : v).trim();
  var m = /^(?:\d{4}-\d{2}-\d{2}[ T])?(\d{1,2}):(\d{2})/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59) return "";
  return ("0" + m[1]).slice(-2) + ":" + m[2];
}

function _jsonArrayOfPaths(v) {
  var arr;
  try { arr = JSON.parse(String(v == null ? "" : v) || "[]"); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  var out = [];
  arr.forEach(function (x) {
    try { var p = _lessonPath(x); if (out.indexOf(p) === -1) out.push(p); } catch (e) { /* skip a damaged entry */ }
  });
  return out;
}

// {group_key: settings} from the GroupSettings tab. Missing = defaults (weekday null = not set yet).
function _emptyGroupSettings() {
  return { weekday: null, time: "", current_lesson: "", review_lessons: [], hw_lessons: null, quiz_lessons: null, note: "", parents_contacted: false,
           watch_deadline_override: "", hw_deadline_override: "" };
}

function _groupSettingsFromRow(r) {
  var s = _emptyGroupSettings();
  var wd = String(r.weekday == null ? "" : r.weekday).trim();
  if (/^[0-6]$/.test(wd)) s.weekday = +wd;
  s.time = _hhmmOf(r.time);
  try { s.current_lesson = r.current_lesson ? _lessonPath(r.current_lesson) : ""; } catch (e) { s.current_lesson = ""; }
  s.review_lessons = _jsonArrayOfPaths(r.review_lessons);
  // blank cell = never split = follows review_lessons (null); "[]" = explicitly none
  s.hw_lessons = String(r.hw_lessons == null ? "" : r.hw_lessons).trim() === "" ? null : _jsonArrayOfPaths(r.hw_lessons);
  s.quiz_lessons = String(r.quiz_lessons == null ? "" : r.quiz_lessons).trim() === "" ? null : _jsonArrayOfPaths(r.quiz_lessons);
  s.note = String(r.note == null ? "" : r.note);
  s.parents_contacted = _isTruthyFlag(r.parents_contacted);
  var wo = _ymdOf(r.watch_deadline_override), ho = _ymdOf(r.hw_deadline_override);
  s.watch_deadline_override = wo || "";
  s.hw_deadline_override = ho || "";
  return s;
}

// ---- access, evaluated in memory (mirrors _accessState / _hasActiveQuizAccess) ------------------
// {byPhone: {phoneKey: [{scope, ymd, pid, source}]}}. A damaged tab reads as "no access" (fails closed).
function _entitlementIndex(ss) {
  var idx = { byPhone: {} };
  var sheet = ss.getSheetByName("Entitlements");
  if (!sheet || sheet.getLastRow() < 2) return idx;
  var c;
  try { c = _needCols(sheet, "Entitlements", ["phone", "scope", "expires_at"]); } catch (e) { return idx; }
  var srcCol = _headerIndex(sheet)["source"] || 0;
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var k = _phoneKey(r[c.phone - 1]);
    if (!k) return;
    var src = srcCol ? String(r[srcCol - 1] == null ? "" : r[srcCol - 1]).trim() : "";
    (idx.byPhone[k] = idx.byPhone[k] || []).push({
      scope: _canonKey(String(r[c.scope - 1]).trim().toLowerCase()), ymd: _ymdOf(r[c.expires_at - 1], tz),
      pid: _sourcePayment(src), source: src });
  });
  return idx;
}

function _entitlementCovers(idx, statuses, key, lesson, ss, today) {
  var rows = idx.byPhone[key] || [];
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i];
    if (e.ymd === null) continue;                                   // unreadable date: fail closed
    if (!(e.ymd === "" || today <= e.ymd)) continue;
    if (!_scopeCovers(e.scope, lesson, ss)) continue;
    if (e.pid && statuses.hasOwnProperty(e.pid) && statuses[e.pid] !== "approved") continue;   // payment cancelled
    return true;
  }
  return false;
}

// {phoneKey: {lesson: true}} of live QuizAccess rows (exact lesson, like _hasActiveQuizAccess).
function _quizAccessIndex(ss) {
  var map = {};
  var sheet = ss.getSheetByName("QuizAccess");
  if (!sheet || sheet.getLastRow() < 2) return map;
  var c;
  try { c = _needCols(sheet, "QuizAccess", ["phone", "lesson", "expires_at"]); } catch (e) { return map; }
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo();
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var k = _phoneKey(r[c.phone - 1]);
    if (!k) return;
    var ymd = _ymdOf(r[c.expires_at - 1], tz);
    if (ymd === null || !(ymd === "" || ymd >= today)) return;
    (map[k] = map[k] || {})[_canonKey(String(r[c.lesson - 1]).trim().toLowerCase())] = true;
  });
  return map;
}

// Locks as the student sees them: {lessons: {path: bool}, videos: {path: {locked}}, quizzes: {path: bool}}
// plus "damaged" flags (a broken tab locks everything, same as _lessonLockedNow / _quizLockedNow).
function _lockIndex(ss) {
  var out = { lessons: {}, lessonsDamaged: false, videos: {}, videosDamaged: false, quizzes: {}, quizzesDamaged: false };
  function eachRow(tab, need, fn, flag) {
    var sheet = ss.getSheetByName(tab);
    if (!sheet || sheet.getLastRow() < 2) return;
    var c;
    try { c = _needCols(sheet, tab, need); } catch (e) { out[flag] = true; return; }
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) { fn(r, c); });
  }
  eachRow("Lessons", ["lesson", "locked"], function (r, c) {
    var l = _canonKey(String(r[c.lesson - 1]).trim().toLowerCase());
    if (l && !out.lessons.hasOwnProperty(l)) out.lessons[l] = _isLockedCell(r[c.locked - 1]);
  }, "lessonsDamaged");
  eachRow("Videos", ["lesson", "slot", "embed_url", "locked"], function (r, c) {
    if (String(r[c.slot - 1]).trim().toLowerCase() !== "lesson") return;
    var l = _canonKey(String(r[c.lesson - 1]).trim().toLowerCase());
    if (l && !out.videos.hasOwnProperty(l)) out.videos[l] = { has: !!String(r[c.embed_url - 1]).trim(), locked: _isLockedCell(r[c.locked - 1]) };
  }, "videosDamaged");
  eachRow("Quizzes", ["lesson", "locked"], function (r, c) {
    var l = _canonKey(String(r[c.lesson - 1]).trim().toLowerCase());
    if (l && !out.quizzes.hasOwnProperty(l)) out.quizzes[l] = _isLockedCell(r[c.locked - 1]);
  }, "quizzesDamaged");
  return out;
}

function _lessonLockState(locks, path) {
  var lessonLocked = locks.lessonsDamaged || (locks.lessons.hasOwnProperty(path) && locks.lessons[path]);
  var v = locks.videos[path];
  var videoRec = v && v.has ? v : null;                               // like _lookupVideo: no URL = no video
  var videoLocked = locks.videosDamaged || !!(videoRec && videoRec.locked) || !!lessonLocked;
  var quizLocked = locks.quizzesDamaged || (locks.quizzes.hasOwnProperty(path) && locks.quizzes[path]);
  return { has_video: !!videoRec, lesson_locked: !!lessonLocked, video_locked: videoLocked, quiz_locked: !!quizLocked };
}

// ---- admin_followup_overview ----------------------------------------------------------------------
function handleAdminFollowupOverview(payload) {
  _requireAdminAny(payload);
  var ss = _ss();
  var dataSs = _dataSs();
  var now = new Date();
  var today = _fmt(now, TZ, false);
  var settings = _followupSettings();

  // The four tabs appear in the spreadsheet the first time the page is opened.
  var gsSheet = _followupSheet(ss, "GroupSettings", GROUPSETTINGS_HEADERS);
  var attSheet = _followupSheet(ss, "Attendance", ATTENDANCE_HEADERS);
  var watchSheet = _followupSheet(ss, "WatchProgress", WATCH_HEADERS);
  var tplSheet = _followupSheet(ss, "FollowupTemplates", FOLLOWUP_TEMPLATE_HEADERS);

  // Students (registered), keyed by phone key. Admin accounts are not "students".
  var students = {}, registeredOrder = [];
  _sheetValuesAsObjects(_students()).forEach(function (r) {
    var k = _phoneKey(r.phone);
    if (!k || students.hasOwnProperty(k)) return;
    students[k] = { phone: _restoreLeadingZero(String(r.phone == null ? "" : r.phone).trim()),
                    name: String(r.display_name == null ? "" : r.display_name).trim(),
                    year: String(r.year == null ? "" : r.year).trim(),
                    parent_phone: _restoreLeadingZero(String(r.parent_phone == null ? "" : r.parent_phone).trim()),
                    _admin: _isTruthyFlag(r.is_admin) };
    registeredOrder.push(k);
  });

  // Groups + their settings.
  var gSheet = ss.getSheetByName("Groups");
  var spellings = _groupSpellings(gSheet);
  var byKey = {}, inGroup = {};
  (gSheet && gSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(gSheet) : []).forEach(function (m) {
    var gk = _groupKey(m.group), pk = _phoneKey(m.phone);
    if (!gk || !pk) return;
    var g = byKey[gk] = byKey[gk] || { group: spellings[gk] || String(m.group), key: gk, members: [], seen: {} };
    if (g.seen[pk]) return;
    g.seen[pk] = true;
    inGroup[pk] = true;
    var gName = String(m.name == null ? "" : m.name).trim();
    if (!students.hasOwnProperty(pk)) {
      students[pk] = { phone: _restoreLeadingZero(String(m.phone).trim()), name: gName, year: "", parent_phone: "", _admin: false };
    }
    g.members.push({ phone: students[pk].phone, name: students[pk].name || gName });
  });
  var settingsByKey = {};
  _sheetValuesAsObjects(gsSheet).forEach(function (r) {
    var k = _groupKey(r.group_key || r.group);
    if (k && !settingsByKey.hasOwnProperty(k)) settingsByKey[k] = _groupSettingsFromRow(r);
  });
  var groups = Object.keys(byKey).sort(function (a, b) {
    return byKey[a].group.toLowerCase() < byKey[b].group.toLowerCase() ? -1 : 1;
  }).map(function (k) {
    var g = byKey[k];
    return { group: g.group, key: k, settings: settingsByKey[k] || _emptyGroupSettings(), members: g.members };
  });

  var unclassified = [];
  registeredOrder.forEach(function (k) {
    if (inGroup[k] || students[k]._admin) return;
    unclassified.push({ phone: students[k].phone, name: students[k].name });
  });
  unclassified.sort(function (a, b) { return (a.name || a.phone).toLowerCase() < (b.name || b.phone).toLowerCase() ? -1 : 1; });

  // Which students get facts: every group member and every unclassified student.
  var factKeys = [];
  groups.forEach(function (g) { g.members.forEach(function (m) { var k = _phoneKey(m.phone); if (factKeys.indexOf(k) === -1) factKeys.push(k); }); });
  unclassified.forEach(function (u) { var k = _phoneKey(u.phone); if (factKeys.indexOf(k) === -1) factKeys.push(k); });
  var studentsOut = {};
  factKeys.forEach(function (k) {
    var s = students[k];
    studentsOut[k] = { phone: s.phone, name: s.name, year: s.year, parent_phone: s.parent_phone };
  });

  // Lessons in use, and the whole lesson list (soft-fails when GitHub is down).
  var used = [];
  groups.forEach(function (g) {
    var s = g.settings;
    [s.current_lesson].concat(s.review_lessons, s.hw_lessons || [], s.quiz_lessons || []).forEach(function (l) { if (l && used.indexOf(l) === -1) used.push(l); });
  });
  var allLessons = [], lessonsError = "", ghFlags = {};
  try {
    allLessons = _allLessonsFromGithub().lessons;
    allLessons.forEach(function (l) { ghFlags[l.lesson] = l; });
  } catch (e) {
    lessonsError = String(e.message || e);
  }

  var locks = _lockIndex(ss);
  var lessonsOut = {};
  var subjectSlugPaths = {};
  function noteSlug(path) {
    var k = _firstSegment(path) + "|" + _lastSegment(path);
    var arr = subjectSlugPaths[k] = subjectSlugPaths[k] || [];
    if (arr.indexOf(path) === -1) arr.push(path);
  }
  allLessons.forEach(function (l) { noteSlug(l.lesson); });
  used.forEach(function (path) {
    noteSlug(path);
    var st = _lessonLockState(locks, path);
    var gh = ghFlags[path];
    lessonsOut[path] = { path: path, subject: _firstSegment(path), slug: _lastSegment(path),
                         has_video: st.has_video,
                         has_quiz: gh ? gh.has_quiz : true,           // unknown (GitHub down / brand-new lesson): assume yes
                         has_assignment: gh ? gh.has_assignment : true,
                         lesson_locked: st.lesson_locked, video_locked: st.video_locked, quiz_locked: st.quiz_locked };
  });
  var slugCollisions = [];
  used.forEach(function (path) {
    var arr = subjectSlugPaths[_firstSegment(path) + "|" + _lastSegment(path)];
    if (arr.length > 1) {
      lessonsOut[path].slug_collision = true;
      if (!slugCollisions.some(function (c) { return c.slug === _lastSegment(path) && c.subject === _firstSegment(path); })) {
        slugCollisions.push({ subject: _firstSegment(path), slug: _lastSegment(path), paths: arr.slice() });
      }
    }
  });
  var allLessonsOut = allLessons.map(function (l) {
    var st = _lessonLockState(locks, l.lesson);
    return { path: l.lesson, lesson_locked: st.lesson_locked, video_locked: st.video_locked, quiz_locked: st.quiz_locked };
  });

  // Per-student facts. Everything below is loaded once and looked up in memory.
  var facts = {};
  if (used.length && factKeys.length) {
    var ent = _entitlementIndex(ss);
    var statuses = _paymentStatuses(ss);
    var qaccess = _quizAccessIndex(ss);

    var att = {};     // phoneKey|lesson -> mode
    var aCols = _readColumns(attSheet, ["lesson", "phone", "mode"], [], "Attendance");
    for (var i = 0; i < aCols.n; i++) {
      var am = String(aCols.col.mode[i]).trim().toLowerCase();
      if (ATTENDANCE_MODES.hasOwnProperty(am)) att[_phoneKey(aCols.col.phone[i]) + "|" + _canonKey(String(aCols.col.lesson[i]).trim().toLowerCase())] = am;
    }
    var wp = {};      // phoneKey|lesson -> pct
    var wCols = _readColumns(watchSheet, ["phone", "lesson", "pct"], [], "WatchProgress");
    for (i = 0; i < wCols.n; i++) {
      var pct = parseFloat(wCols.col.pct[i]);
      if (!isFinite(pct)) continue;
      var wk = _phoneKey(wCols.col.phone[i]) + "|" + _canonKey(String(wCols.col.lesson[i]).trim().toLowerCase());
      if (!wp.hasOwnProperty(wk) || pct > wp[wk]) wp[wk] = pct;
    }

    var usedSlugs = {};
    used.forEach(function (p) { usedSlugs[_lastSegment(p)] = true; });
    var mismatch = {};
    var quizBy = {}, hwBy = {};      // phoneKey|slug -> [{subject, ...}]
    function slugOfCell(v) { return _lastSegment(_canonKey(String(v == null ? "" : v).trim().toLowerCase().replace(/\/+$/, ""))); }

    var qrSheet = dataSs.getSheetByName("QuizResults");
    var qCols = _readColumns(qrSheet, ["student_id", "lesson"], ["subject", "date", "start_time", "score", "total"], "QuizResults");
    for (i = 0; i < qCols.n; i++) {
      var qs = slugOfCell(qCols.col.lesson[i]);
      if (!usedSlugs[qs]) continue;
      var qk = _phoneKey(qCols.col.student_id[i]) + "|" + qs;
      (quizBy[qk] = quizBy[qk] || []).push({ idx: i, subject: String(qCols.col.subject[i] || "").trim().toLowerCase(),
        at: _cairoDate(qCols.col.date[i]), time: _cairoTime(qCols.col.start_time[i]),
        score: qCols.col.score[i], total: qCols.col.total[i] });
    }
    var sbSheet = dataSs.getSheetByName("Submissions");
    var sCols = _readColumns(sbSheet, ["student_id", "lesson"], ["subject", "date", "score", "total"], "Submissions");
    for (i = 0; i < sCols.n; i++) {
      var hSlug = slugOfCell(sCols.col.lesson[i]);
      if (!usedSlugs[hSlug]) continue;
      var sk = _phoneKey(sCols.col.student_id[i]) + "|" + hSlug;
      (hwBy[sk] = hwBy[sk] || []).push({ idx: i, subject: String(sCols.col.subject[i] || "").trim().toLowerCase(),
        at: _cairoDate(sCols.col.date[i]), score: sCols.col.score[i], total: sCols.col.total[i] });
    }
    function matching(rows, lessonPath, source) {
      var subj = _firstSegment(lessonPath), out = [];
      (rows || []).forEach(function (r) {
        if (r.subject === "" || r.subject === subj) { out.push(r); return; }
        var mk = source + "|" + lessonPath + "|" + r.subject;
        mismatch[mk] = (mismatch[mk] || 0) + 1;
      });
      return out;
    }
    function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

    factKeys.forEach(function (k) {
      var perLesson = facts[k] = {};
      used.forEach(function (path) {
        var st = _lessonLockState(locks, path), slug = _lastSegment(path);
        var canWatch = !st.video_locked || _entitlementCovers(ent, statuses, k, path, ss, today);
        var quizOpen = !st.quiz_locked || !!(qaccess[k] && qaccess[k][path]);
        var mode = att.hasOwnProperty(k + "|" + path) ? att[k + "|" + path] : null;
        var watch = wp.hasOwnProperty(k + "|" + path) ? wp[k + "|" + path] : null;

        var qrows = matching(quizBy[k + "|" + slug], path, "quiz");
        var quiz = { taken: false };
        if (qrows.length) {
          var best = qrows[0];
          qrows.forEach(function (r) {
            var a = (r.at + " " + r.time), b = (best.at + " " + best.time);
            if (a > b || (a === b && r.idx > best.idx)) best = r;
          });
          quiz = { taken: true, score: num(best.score), total: num(best.total), at: best.at, attempts: qrows.length };
        }
        var hrows = matching(hwBy[k + "|" + slug], path, "homework");
        var hw = { submitted: false };
        if (hrows.length) {
          var hb = hrows[0];
          hrows.forEach(function (r) {
            if (r.at > hb.at || (r.at === hb.at && r.idx > hb.idx)) hb = r;
          });
          hw = { submitted: true, at: hb.at, score: num(hb.score), total: num(hb.total) };
        }
        perLesson[path] = { can_watch: canWatch, attendance: mode, watch_pct: watch, quiz: quiz, quiz_open: quizOpen, homework: hw };
      });
    });

    var joinMismatches = Object.keys(mismatch).map(function (mk) {
      var p = mk.split("|");
      return { source: p[0], lesson: p[1], subject_expected: _firstSegment(p[1]), subject_seen: p[2], rows: mismatch[mk] };
    }).slice(0, 30);
  }

  var templates = {};
  if (typeof p4_tplView_ === "function") {
    // Phase 4: a teacher sees their own templates over the owner's; the owner sees exactly what they saw before.
    templates = p4_tplView_(_sheetValuesAsObjects(tplSheet), (typeof p4_tplSuffix_ === "function") ? p4_tplSuffix_(payload) : "");
  } else {
    _sheetValuesAsObjects(tplSheet).forEach(function (r) {
      var key = String(r.key || "").trim();
      var body = String(r.body == null ? "" : r.body);
      if (key && body.trim() !== "" && !templates.hasOwnProperty(key)) templates[key] = body;
    });
  }

  return { ok: true, today: today, now: _cairoIso(now), settings: settings, groups: groups, unclassified: unclassified,
           students: studentsOut, lessons: lessonsOut, all_lessons: allLessonsOut, lessons_error: lessonsError,
           slug_collisions: slugCollisions, join_mismatches: joinMismatches || [], facts: facts, templates: templates };
}

// ---- admin_followup_set_attendance --------------------------------------------------------------
// One upsert into Attendance per student, plus (center) the free video + quiz rows, or (online / clear)
// the removal of ONLY the rows this feature made. Rows from payments, manual grants, group grants
// ("a/b/*") and "*" are never touched: _grantRaw (overwrites a row's source) and
// handleAdminRevokeAccess (deletes every row for phone+scope) are deliberately not used here.
function handleAdminFollowupSetAttendance(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error("items must be a non-empty list.");
  if (payload.items.length > MAX_ATTENDANCE_ITEMS) throw new Error("Too many students in one request (max " + MAX_ATTENDANCE_ITEMS + ").");
  var grant = payload.grant !== false;
  var wanted = {}, order = [];
  payload.items.forEach(function (it) {
    var mode = String(it && it.mode != null ? it.mode : "").trim().toLowerCase();
    if (mode !== "" && !ATTENDANCE_MODES.hasOwnProperty(mode)) throw new Error('mode must be "center", "online" or "".');
    var digits = _normalizePhone(it && it.phone);
    if (digits.length < 10) throw new Error("Every item needs a full phone number.");
    var k = _phoneKey(digits);
    if (!wanted.hasOwnProperty(k)) order.push(k);
    wanted[k] = { phone: _canonicalPhone(digits) || digits, mode: mode };
  });

  return _withLock(function () {
    var ss = _ss();
    var now = _fmt(new Date(), TZ, true);

    // 1. Attendance rows.
    var aSheet = _followupSheet(ss, "Attendance", ATTENDANCE_HEADERS);
    _ensureColumns(aSheet, ATTENDANCE_HEADERS);
    var ac = _needCols(aSheet, "Attendance", ATTENDANCE_HEADERS);
    var rowOf = {}, deleteAtt = [];
    if (aSheet.getLastRow() >= 2) {
      aSheet.getRange(2, 1, aSheet.getLastRow() - 1, aSheet.getLastColumn()).getValues().forEach(function (r, i) {
        if (_canonKey(String(r[ac.lesson - 1]).trim().toLowerCase()) !== lesson) return;
        var k = _phoneKey(r[ac.phone - 1]);
        if (!wanted.hasOwnProperty(k)) return;
        if (rowOf.hasOwnProperty(k)) deleteAtt.push(i + 2);        // a duplicate row from a hand edit
        else rowOf[k] = i + 2;
      });
    }
    var clearRows = [];
    order.forEach(function (k) {
      var w = wanted[k];
      if (w.mode === "") { if (rowOf.hasOwnProperty(k)) clearRows.push(rowOf[k]); return; }
      if (rowOf.hasOwnProperty(k)) {
        aSheet.getRange(rowOf[k], ac.mode).setNumberFormat("@").setValue(w.mode);
        aSheet.getRange(rowOf[k], ac.marked_at).setNumberFormat("@").setValue(now);
      } else {
        _appendByHeader(aSheet, { lesson: lesson, phone: w.phone, mode: w.mode, marked_at: now });
      }
    });
    deleteAtt.concat(clearRows).sort(function (a, b) { return b - a; }).forEach(function (r) { aSheet.deleteRows(r, 1); });

    // 2. Free access for center students; take it back for online / cleared ones.
    var today = _todayCairo();
    var eSheet = _sheetByName(ss, "Entitlements", ENT_HEADERS);
    _ensureColumns(eSheet, ENT_HEADERS);
    var qSheet = _sheetByName(ss, "QuizAccess", QUIZ_ACCESS_HEADERS);
    _ensureColumns(qSheet, QUIZ_ACCESS_HEADERS);
    var ec = _needCols(eSheet, "Entitlements", ENT_HEADERS), qc = _needCols(qSheet, "QuizAccess", QUIZ_ACCESS_HEADERS);

    var undo = {};     // phoneKeys whose attendance rows go
    var give = {};     // phoneKeys that should get the free access
    order.forEach(function (k) {
      if (wanted[k].mode === "center") { if (grant) give[k] = true; }
      else undo[k] = true;
    });

    var delEnt = [], delQuiz = [];
    if (Object.keys(undo).length) {
      if (eSheet.getLastRow() >= 2) {
        eSheet.getRange(2, 1, eSheet.getLastRow() - 1, eSheet.getLastColumn()).getValues().forEach(function (r, i) {
          if (String(r[ec.source - 1]).trim() !== ATTENDANCE_SOURCE) return;
          if (_canonKey(String(r[ec.scope - 1]).trim().toLowerCase()) !== lesson) return;
          if (undo[_phoneKey(r[ec.phone - 1])]) delEnt.push(i + 2);
        });
      }
      if (qSheet.getLastRow() >= 2) {
        qSheet.getRange(2, 1, qSheet.getLastRow() - 1, qSheet.getLastColumn()).getValues().forEach(function (r, i) {
          if (String(r[qc.source - 1]).trim() !== ATTENDANCE_SOURCE) return;
          if (_canonKey(String(r[qc.lesson - 1]).trim().toLowerCase()) !== lesson) return;
          if (undo[_phoneKey(r[qc.phone - 1])]) delQuiz.push(i + 2);
        });
      }
      delEnt.sort(function (a, b) { return b - a; }).forEach(function (r) { eSheet.deleteRows(r, 1); });
      delQuiz.sort(function (a, b) { return b - a; }).forEach(function (r) { qSheet.deleteRows(r, 1); });
    }

    if (Object.keys(give).length) {
      var ent = _entitlementIndex(ss), statuses = _paymentStatuses(ss), qidx = _quizAccessIndex(ss);
      order.forEach(function (k) {
        if (!give[k]) return;
        if (!_entitlementCovers(ent, statuses, k, lesson, ss, today)) {
          _appendByHeader(eSheet, { phone: wanted[k].phone, scope: lesson, expires_at: "", granted_at: now, source: ATTENDANCE_SOURCE });
        }
        if (!(qidx[k] && qidx[k][lesson])) {
          _appendByHeader(qSheet, { phone: wanted[k].phone, lesson: lesson, expires_at: "", granted_at: now, source: ATTENDANCE_SOURCE });
        }
      });
    }

    // 3. Fresh values for the students just touched.
    var ent2 = _entitlementIndex(ss), statuses2 = _paymentStatuses(ss), qidx2 = _quizAccessIndex(ss);
    var locks = _lockIndex(ss), st = _lessonLockState(locks, lesson);
    var results = order.map(function (k) {
      return { phone: wanted[k].phone, mode: wanted[k].mode,
               can_watch: !st.video_locked || _entitlementCovers(ent2, statuses2, k, lesson, ss, today),
               quiz_open: !st.quiz_locked || !!(qidx2[k] && qidx2[k][lesson]) };
    });
    return { ok: true, results: results };
  });
}

// ---- admin_followup_save_group -----------------------------------------------------------------
function _checkOverrideYmd(v, label) {
  var s = String(v == null ? "" : v).trim();
  if (s === "") return "";
  try { return _cleanYmd(s); } catch (e) { throw new Error(label + " must be empty or look like 2026-12-31."); }
}

function handleAdminFollowupSaveGroup(payload) {
  _requireAdminAny(payload);
  var gkey = _groupKey(payload.group);
  if (!gkey) throw new Error("Missing group.");

  var weekday = null;
  var wd = payload.weekday;
  if (wd !== undefined && wd !== null && String(wd).trim() !== "") {
    if (!/^[0-6]$/.test(String(wd).trim())) throw new Error("weekday must be a whole number from 0 (Sunday) to 6 (Saturday).");
    weekday = +String(wd).trim();
  }
  var time = String(payload.time == null ? "" : payload.time).trim();
  if (time !== "") {
    if (!/^\d{2}:\d{2}$/.test(time) || +time.slice(0, 2) > 23 || +time.slice(3) > 59) throw new Error('time must look like "18:00".');
  }
  var current = String(payload.current_lesson == null ? "" : payload.current_lesson).trim() === "" ? "" : _lessonPath(payload.current_lesson);
  var review = [];
  if (payload.review_lessons !== undefined && payload.review_lessons !== null && payload.review_lessons !== "") {
    if (!Array.isArray(payload.review_lessons)) throw new Error("review_lessons must be a list of lesson paths.");
    if (payload.review_lessons.length > MAX_REVIEW_LESSONS) throw new Error("At most " + MAX_REVIEW_LESSONS + " homework & quiz lessons per group.");
    payload.review_lessons.forEach(function (l) { var p = _lessonPath(l); if (review.indexOf(p) === -1) review.push(p); });
  }
  // hw_lessons / quiz_lessons: absent or null = follow review_lessons (stored blank); an array (even empty) = that exact list.
  function _splitList(v, label) {
    if (v === undefined || v === null || v === "") return null;
    if (!Array.isArray(v)) throw new Error(label + " must be a list of lesson paths.");
    if (v.length > MAX_REVIEW_LESSONS) throw new Error("At most " + MAX_REVIEW_LESSONS + " " + label + " per group.");
    var o = []; v.forEach(function (l) { var p = _lessonPath(l); if (o.indexOf(p) === -1) o.push(p); }); return o;
  }
  var hwLessons = _splitList(payload.hw_lessons, "homework lessons"), quizLessons = _splitList(payload.quiz_lessons, "quiz lessons");
  if (hwLessons || quizLessons) {   // a split group: review_lessons is always the union, so older readers still see every lesson
    (hwLessons || review).concat(quizLessons || review).forEach(function (p) { if (review.indexOf(p) === -1) review.push(p); });
    if (review.length > MAX_REVIEW_LESSONS * 2) throw new Error("Too many lessons for one group.");
  }
  var note = String(payload.note == null ? "" : payload.note);
  if (note.length > MAX_GROUP_NOTE) throw new Error("The group note is too long (max " + MAX_GROUP_NOTE + " characters).");
  var contacted = payload.parents_contacted === true || String(payload.parents_contacted).toUpperCase() === "TRUE";
  var watchOverride = _checkOverrideYmd(payload.watch_deadline_override, "The watch deadline override");
  var hwOverride = _checkOverrideYmd(payload.hw_deadline_override, "The homework deadline override");

  // Soft check against the real lesson list: a typo should be noticed, but GitHub being down must not block saving.
  var warnings = [];
  var wanted = (current ? [current] : []).concat(review, hwLessons || [], quizLessons || []);
  if (wanted.length) {
    try {
      var known = {};
      _allLessonsFromGithub().lessons.forEach(function (l) { known[l.lesson] = true; });
      wanted.forEach(function (l) { if (!known[l]) warnings.push("Lesson not found on the site: " + l); });
    } catch (e) {
      warnings.push("Couldn't check the lessons against GitHub: " + String(e.message || e));
    }
  }

  return _withLock(function () {
    var ss = _ss();
    var spellings = _groupSpellings(ss.getSheetByName("Groups"));
    if (!spellings.hasOwnProperty(gkey)) throw new Error("No such group.");
    var sheet = _followupSheet(ss, "GroupSettings", GROUPSETTINGS_HEADERS);
    _ensureColumns(sheet, GROUPSETTINGS_HEADERS);
    var c = _needCols(sheet, "GroupSettings", GROUPSETTINGS_HEADERS);
    var rec = { group_key: gkey, group: spellings[gkey], weekday: weekday === null ? "" : weekday, time: time,
                current_lesson: current, review_lessons: JSON.stringify(review), hw_lessons: hwLessons === null ? "" : JSON.stringify(hwLessons), quiz_lessons: quizLessons === null ? "" : JSON.stringify(quizLessons), note: note, parents_contacted: contacted,
                watch_deadline_override: watchOverride, hw_deadline_override: hwOverride, updated_at: _fmt(new Date(), TZ, true) };
    var row = 0;
    if (sheet.getLastRow() >= 2) {
      var keys = sheet.getRange(2, c.group_key, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) if (_groupKey(keys[i][0]) === gkey) { row = i + 2; break; }
    }
    if (row) {
      GROUPSETTINGS_HEADERS.forEach(function (h) {
        sheet.getRange(row, c[h]).setNumberFormat(PLAIN_TEXT_HEADERS[h] ? "@" : "General").setValue(rec[h]);
      });
    } else {
      _appendByHeader(sheet, rec);
    }
    var out = { ok: true, settings: { weekday: weekday, time: time, current_lesson: current, review_lessons: review, hw_lessons: hwLessons, quiz_lessons: quizLessons, note: note,
                parents_contacted: contacted, watch_deadline_override: watchOverride, hw_deadline_override: hwOverride } };
    if (warnings.length) out.warnings = warnings;
    return out;
  });
}

// ---- admin_followup_save_templates -------------------------------------------------------------
function handleAdminFollowupSaveTemplates(payload) {
  _requireAdminAny(payload);
  // Phase 4: a teacher's templates are stored under their own key suffix (":<id>"); the owner's stay as they were.
  var sfx = (typeof p4_tplSuffix_ === "function") ? p4_tplSuffix_(payload) : "";
  if (sfx === null) throw new Error("Not authorized.");
  var t = payload.templates;
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("templates must be an object of {key: body}.");
  var keys = Object.keys(t);
  if (keys.length > MAX_TEMPLATE_KEYS) throw new Error("Too many templates in one save (max " + MAX_TEMPLATE_KEYS + ").");
  keys.forEach(function (k) {
    if (!FOLLOWUP_TEMPLATE_KEY_RE.test(k)) throw new Error('Template key "' + k + '" is not valid (lower-case letters, digits and _).');
    var b = t[k];
    if (b !== null && typeof b !== "string") throw new Error('Template "' + k + '" must be text (or null to reset it).');
    if (b && b.length > MAX_TEMPLATE_BODY) throw new Error('Template "' + k + '" is too long (max ' + MAX_TEMPLATE_BODY + " characters).");
  });

  return _withLock(function () {
    var ss = _ss();
    var sheet = _followupSheet(ss, "FollowupTemplates", FOLLOWUP_TEMPLATE_HEADERS);
    _ensureColumns(sheet, FOLLOWUP_TEMPLATE_HEADERS);
    var c = _needCols(sheet, "FollowupTemplates", FOLLOWUP_TEMPLATE_HEADERS);
    var now = _fmt(new Date(), TZ, true);
    var rowOf = {};
    if (sheet.getLastRow() >= 2) {
      sheet.getRange(2, c.key, sheet.getLastRow() - 1, 1).getValues().forEach(function (r, i) {
        var k = String(r[0]).trim();
        if (k && !rowOf.hasOwnProperty(k)) rowOf[k] = i + 2;
      });
    }
    var toDelete = [];
    keys.forEach(function (k) {
      var body = t[k];
      var sk = k + sfx;   // Phase 4: "" for the owner (unchanged), ":<id>" for a teacher
      if (body === null || String(body).trim() === "") { if (rowOf.hasOwnProperty(sk)) toDelete.push(rowOf[sk]); return; }
      if (rowOf.hasOwnProperty(sk)) {
        sheet.getRange(rowOf[sk], c.body).setNumberFormat("@").setValue(body);
        sheet.getRange(rowOf[sk], c.updated_at).setNumberFormat("@").setValue(now);
      } else {
        _appendByHeader(sheet, { key: sk, body: body, updated_at: now });
      }
    });
    toDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });

    var saved = {};
    if (typeof p4_tplView_ === "function") {
      saved = p4_tplView_(_sheetValuesAsObjects(sheet), sfx);
    } else {
      _sheetValuesAsObjects(sheet).forEach(function (r) {
        var k = String(r.key || "").trim(), b = String(r.body == null ? "" : r.body);
        if (k && b.trim() !== "" && !saved.hasOwnProperty(k)) saved[k] = b;
      });
    }
    return { ok: true, templates: saved };
  });
}

// ---- record_watch (a STUDENT's session, not an admin's) ---------------------------------------
// The player reports how much of the lesson video has really been watched. Keeps the highest
// value ever reported; ignores admins, locked videos, nonsense, and anything more often than
// every WATCH_THROTTLE_SECONDS per (student, lesson).
function handleRecordWatch(payload) {
  _requireStudentSession(payload);
  var lesson = _lessonPath(payload.lesson);
  var pct = typeof payload.pct === "number" ? payload.pct : parseFloat(payload.pct);
  if (!isFinite(pct)) return { ok: true, ignored: true };
  pct = Math.round(Math.max(0, Math.min(100, pct)) * 10) / 10;
  var dur = parseFloat(payload.duration_s);
  dur = isFinite(dur) && dur > 0 ? Math.round(dur) : 0;

  if (_sessionState(payload) !== "student") return { ok: true, ignored: true };   // an admin previewing the page

  var key = _phoneKey(payload.student_id);
  var cache = CacheService.getScriptCache();
  var tk = "wpt:" + _md5(key + "|" + lesson);
  if (cache.get(tk) !== null) return { ok: true, ignored: true };

  var ss = _ss();
  var rec = _lookupVideo(lesson, "lesson");
  if (!rec) return { ok: true, ignored: true };                                   // no video here to watch
  if ((rec.locked || _isLessonLocked(lesson)) && !_accessState(ss, payload.student_id, lesson).active) {
    return { ok: true, ignored: true };
  }
  cache.put(tk, "1", WATCH_THROTTLE_SECONDS);

  return _withLock(function () {
    var sheet = _followupSheet(ss, "WatchProgress", WATCH_HEADERS);
    _ensureColumns(sheet, WATCH_HEADERS);
    var c = _needCols(sheet, "WatchProgress", WATCH_HEADERS);
    var now = _fmt(new Date(), TZ, true);
    var rk = "wpr:" + _md5(key + "|" + lesson);
    var row = 0;

    var hinted = parseInt(cache.get(rk) || "", 10);                               // remembered row: one cheap check, no scan
    if (hinted >= 2 && hinted <= sheet.getLastRow()) {
      var chk = sheet.getRange(hinted, 1, 1, sheet.getLastColumn()).getValues()[0];
      if (_phoneKey(chk[c.phone - 1]) === key && _canonKey(String(chk[c.lesson - 1]).trim().toLowerCase()) === lesson) row = hinted;
    }
    if (!row && sheet.getLastRow() >= 2) {
      var n = sheet.getLastRow() - 1;
      var phones = sheet.getRange(2, c.phone, n, 1).getValues(), lessons = sheet.getRange(2, c.lesson, n, 1).getValues();
      for (var i = 0; i < n; i++) {
        if (_phoneKey(phones[i][0]) === key && String(lessons[i][0]).trim().toLowerCase() === lesson) { row = i + 2; break; }
      }
    }
    if (!row) {
      row = _appendByHeader(sheet, { phone: _canonicalPhone(payload.student_id) || _normalizePhone(payload.student_id), lesson: lesson,
                                     pct: pct, duration_s: dur || "", first_at: now, updated_at: now });
      cache.put(rk, String(row), 21600);
      return { ok: true, pct: pct };
    }
    cache.put(rk, String(row), 21600);
    var old = parseFloat(sheet.getRange(row, c.pct).getValues()[0][0]);
    var best = isFinite(old) && old > pct ? old : pct;
    if (!isFinite(old) || pct > old) {
      sheet.getRange(row, c.pct).setValue(pct);
      if (dur) sheet.getRange(row, c.duration_s).setValue(dur);
      sheet.getRange(row, c.updated_at).setNumberFormat("@").setValue(now);
    }
    return { ok: true, pct: best };
  });
}

// -- Quiz gate: lock/unlock a lesson's quiz, separate from its video ---------------
// A lesson with no row here is OPEN (unchanged behaviour). Once explicitly gated,
// a new row starts LOCKED. See the "Quiz gate" note at the top of this file.

var QUIZ_HEADERS = ["lesson", "locked", "updated_at"];
var QUIZ_CACHE_SECONDS = 30;
function _quizCacheKey(lesson) { return "qlk:" + _md5(lesson); }

function _findQuizRow(sheet, lesson) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var c = _needCols(sheet, "Quizzes", ["lesson", "locked"]);
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) {
      return { row: i + 2, cols: c, locked: _isLockedCell(values[i][c.locked - 1]) };
    }
  }
  return null;
}

// True/false, straight from the sheet — used by admin_set_quiz_lock and the dashboard,
// where a fresh answer matters more than saving a read. A damaged Quizzes tab (a
// renamed/deleted column) FAILS CLOSED, same as the video lock and entitlements: the
// quiz is treated as locked until the sheet is fixed, rather than quietly opening it.
function _quizLockedNow(lesson) {
  var sheet = _ss().getSheetByName("Quizzes");
  if (!sheet) return false;
  try {
    var found = _findQuizRow(sheet, lesson);
    return !!(found && found.locked);
  } catch (e) {
    return true;
  }
}

// Cached briefly — this is called on every quiz SUBMISSION, so a class finishing
// together shouldn't cost one sheet read each. admin_set_quiz_lock clears the entry
// at once; a lock flipped by hand in the Sheet can take up to this long to apply.
function _isQuizLocked(rawLesson) {
  var lesson;
  try { lesson = _lessonPath(rawLesson); } catch (e) { return false; }   // an unrecognisable lesson can't be "locked"
  var cache = CacheService.getScriptCache();
  var ck = _quizCacheKey(lesson);
  var hit = cache.get(ck);
  if (hit !== null) return hit === "1";
  var locked = _quizLockedNow(lesson);
  cache.put(ck, locked ? "1" : "0", QUIZ_CACHE_SECONDS);
  return locked;
}

// Public. What quiz.js checks before showing the quiz at all. student_id is optional
// (an anonymous check just sees the global lock); passing it also picks up a group's
// or student's timed override, so a student in an "open early" group sees it as open.
function handleGetQuizState(payload) {
  var lesson = _lessonPath(payload.lesson);
  var lockedGlobally = _isQuizLocked(lesson);
  var locked = payload.student_id ? _quizLockedForStudent(lesson, payload.student_id) : lockedGlobally;
  return { ok: true, lesson: lesson, locked: locked, locked_globally: lockedGlobally };
}

// locked is REQUIRED (this toggles one thing, unlike admin_set_video's partial updates).
function handleAdminSetQuizLock(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  if (payload.locked === undefined || payload.locked === null) throw new Error("Missing locked (true or false).");
  var wantLocked = _isLockedCell(payload.locked);

  var result = _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Quizzes");
    var found = sheet ? _findQuizRow(sheet, lesson) : null;
    var now = _fmt(new Date(), TZ, true);
    if (found) {
      sheet.getRange(found.row, found.cols.locked).setValue(wantLocked);
      if (found.cols.updated_at) sheet.getRange(found.row, found.cols.updated_at).setNumberFormat("@").setValue(now);
      return { ok: true, lesson: lesson, locked: wantLocked };
    }
    sheet = _sheetByName(ss, "Quizzes", QUIZ_HEADERS);
    _ensureColumns(sheet, QUIZ_HEADERS);
    _appendByHeader(sheet, { lesson: lesson, locked: wantLocked, updated_at: now });
    return { ok: true, lesson: lesson, locked: wantLocked };
  });
  CacheService.getScriptCache().remove(_quizCacheKey(lesson));
  return result;
}

// -- Quiz content: the actual questions/answers, served only when unlocked --------
// Historically the quiz's full question+answer JSON was baked straight into
// quiz.html by the desktop Quiz Maker, so the quiz-lock above only ever hid the
// UI — the real content sat in the page source for anyone to read regardless of
// lock state. This mirrors what get_video already does for videos: the content
// lives here instead, and get_quiz only puts it in a response when this viewer
// is actually allowed to see it. A locked (or not-yet-synced) quiz never has its
// questions leave the server.
var QUIZ_CONTENT_HEADERS = ["lesson", "content_json", "updated_at"];
var QUIZ_CONTENT_CACHE_SECONDS = 30;
function _quizContentCacheKey(lesson) { return "qct:" + _md5(lesson); }

function _findQuizContentRow(sheet, lesson) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var c = _needCols(sheet, "QuizContent", ["lesson", "content_json"]);
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) {
      return { row: i + 2, cols: c, content_json: String(values[i][c.content_json - 1] || "") };
    }
  }
  return null;
}

function _lookupQuizContent(lesson) {
  var cache = CacheService.getScriptCache();
  var ck = _quizContentCacheKey(lesson);
  var hit = cache.get(ck);
  if (hit !== null) return hit === "" ? null : hit;
  var sheet = _ss().getSheetByName("QuizContent");
  var found = sheet ? _findQuizContentRow(sheet, lesson) : null;
  var json = found ? found.content_json : null;
  // Cache stores "" for "nothing synced yet" so that case doesn't re-read every time either.
  cache.put(ck, json || "", QUIZ_CONTENT_CACHE_SECONDS);
  return json;
}

// Public. What quiz.js now actually loads the quiz from — replaces reading the
// questions out of the page's own embedded JSON. locked:true means exactly what
// get_quiz_state's locked meant, computed the same way (global lock plus any
// per-student QuizAccess override), except this also withholds the questions
// themselves rather than just telling the page to show a "locked" screen.
function handleGetQuiz(payload) {
  var gateLesson = payload.lesson_path || payload.lesson;   // same convention as handleUploadQuizResult above
  var lesson = _lessonPath(gateLesson);
  var locked = payload.student_id
    ? _quizLockedForStudent(lesson, payload.student_id)
    : _isQuizLocked(lesson);
  if (locked) return { ok: true, locked: true };
  var json = _lookupQuizContent(lesson);
  if (!json) return { ok: true, locked: false, quiz: null }; // this lesson hasn't been synced to the server yet
  try {
    return { ok: true, locked: false, quiz: JSON.parse(json) };
  } catch (e) {
    return { ok: true, locked: false, quiz: null };
  }
}

// content_json: the full quiz object (subject/lesson/title/questions, with
// correct answers) as a JSON string. Kept in sync by the desktop Quiz Maker the
// same way admin_set_video keeps a video's URL in sync — called every time a
// lesson's quiz is generated or edited, so this is always what get_quiz reads.
function handleAdminSetQuizContent(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  if (!payload.content_json) throw new Error("Missing content_json.");
  var json = String(payload.content_json);
  JSON.parse(json); // throws on malformed input, before anything is written

  var result = _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("QuizContent");
    var found = sheet ? _findQuizContentRow(sheet, lesson) : null;
    var now = _fmt(new Date(), TZ, true);
    if (found) {
      sheet.getRange(found.row, found.cols.content_json).setValue(json);
      if (found.cols.updated_at) sheet.getRange(found.row, found.cols.updated_at).setNumberFormat("@").setValue(now);
      return { ok: true, lesson: lesson };
    }
    sheet = _sheetByName(ss, "QuizContent", QUIZ_CONTENT_HEADERS);
    _ensureColumns(sheet, QUIZ_CONTENT_HEADERS);
    _appendByHeader(sheet, { lesson: lesson, content_json: json, updated_at: now });
    return { ok: true, lesson: lesson };
  });
  CacheService.getScriptCache().remove(_quizContentCacheKey(lesson));
  return result;
}

// Admin-only: read a lesson's stored quiz content regardless of lock state,
// so the desktop Quiz Maker can reload it for editing even while the quiz is
// currently locked (the public get_quiz withholds content whenever locked —
// that's the whole point of it, but an admin reopening their own lesson to
// edit it needs the real thing either way).
function handleAdminGetQuizContent(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  var json = _lookupQuizContent(lesson);
  if (!json) return { ok: true, quiz: null };
  try {
    return { ok: true, quiz: JSON.parse(json) };
  } catch (e) {
    return { ok: true, quiz: null };
  }
}

// -- Quiz access overrides: open a locked quiz for one phone/group, for a while ------
// Layers on top of the global Quizzes lock, the same way Entitlements layer on top of
// the video lock. A quiz that is OPEN globally ignores this entirely. A quiz that is
// LOCKED globally is opened only for a phone holding a live row here. Expiry works
// exactly like video access (blank = never expires; past the date = expired = locked
// again automatically, no manual re-lock needed).
var QUIZ_ACCESS_HEADERS = ["phone", "lesson", "expires_at", "granted_at", "source"];

function _grantQuizRaw(ss, phone, lesson, explicitYmd, days, source) {
  var sheet = _sheetByName(ss, "QuizAccess", QUIZ_ACCESS_HEADERS);
  _ensureColumns(sheet, QUIZ_ACCESS_HEADERS);
  var c = _needCols(sheet, "QuizAccess", QUIZ_ACCESS_HEADERS);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo();
  var now = _fmt(new Date(), TZ, true);

  var found = null;
  if (sheet.getLastRow() >= 2) {
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    for (var i = 0; i < values.length; i++) {
      if (_phonesMatch(values[i][c.phone - 1], phone) && _canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) {
        found = { row: i + 2, ymd: _ymdOf(values[i][c.expires_at - 1], tz) };
        break;
      }
    }
  }
  var existing = found ? found.ymd : null;
  var target;
  if (explicitYmd) target = explicitYmd;
  else if (days) target = _addDays(existing && existing > today ? existing : today, days);
  else target = "";
  if (found && existing === "") target = "";
  else if (found && existing && target !== "" && existing > target) target = existing;

  if (found) {
    sheet.getRange(found.row, c.expires_at).setNumberFormat("@").setValue(target);
    sheet.getRange(found.row, c.granted_at).setNumberFormat("@").setValue(now);
    sheet.getRange(found.row, c.source).setNumberFormat("@").setValue(source);
  } else {
    _appendByHeader(sheet, { phone: phone, lesson: lesson, expires_at: target, granted_at: now, source: source });
  }
  return { lesson: lesson, expires_at: target, extended: !!found };
}

// Does this phone currently hold a live QuizAccess row for this exact lesson?
function _hasActiveQuizAccess(lesson, phone) {
  var sheet = _ss().getSheetByName("QuizAccess");
  if (!sheet || sheet.getLastRow() < 2) return false;
  var c = _needCols(sheet, "QuizAccess", ["phone", "lesson", "expires_at"]);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var today = _todayCairo();
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (!_phonesMatch(values[i][c.phone - 1], phone)) continue;
    if (_canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) !== lesson) continue;
    var ymd = _ymdOf(values[i][c.expires_at - 1], tz);
    if (ymd === null) continue;               // unreadable date -> doesn't count as access
    if (ymd === "" || ymd >= today) return true;
  }
  return false;
}

// What quiz.js / handleUploadQuizResult actually enforce: locked globally AND (no
// phone given, or that phone has no live override) = locked for this request.
function _quizLockedForStudent(lesson, phone) {
  if (!_isQuizLocked(lesson)) return false;
  if (!phone) return true;
  return !_hasActiveQuizAccess(lesson, phone);
}

function handleAdminGrantQuizAccess(payload) {
  _requireAdminAny(payload);
  if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
  var phone = _canonicalPhone(payload.phone);
  var lesson = _lessonPath(payload.lesson);
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);
  var g = _withLock(function () { return _grantQuizRaw(_ss(), phone, lesson, explicit, days, "manual"); });
  var stu = _findStudentRow(_students(), phone);
  return { ok: true, phone: phone, lesson: g.lesson, expires_at: g.expires_at, extended: g.extended,
           known_student: !!stu, name: stu ? String(stu.display_name == null ? "" : stu.display_name) : "" };
}

function handleAdminRevokeQuizAccess(payload) {
  _requireAdminAny(payload);
  if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
  var phone = _canonicalPhone(payload.phone);
  var lesson = _lessonPath(payload.lesson);
  return _withLock(function () {
    var sheet = _ss().getSheetByName("QuizAccess");
    if (!sheet || sheet.getLastRow() < 2) throw new Error("No matching quiz access to revoke.");
    var c = _needCols(sheet, "QuizAccess", ["phone", "lesson"]);
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var rows = [];
    for (var i = 0; i < values.length; i++) {
      if (_phonesMatch(values[i][c.phone - 1], phone) && _canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) rows.push(i + 2);
    }
    if (!rows.length) throw new Error("No matching quiz access to revoke.");
    rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
    return { ok: true, phone: phone, lesson: lesson, removed: rows.length };
  });
}

// Applies admin_grant_quiz_access to every current member of a group, in one lock.
function handleAdminGroupGrantQuizAccess(payload) {
  _requireAdminAny(payload);
  var key = _groupKey(payload.group);
  var lesson = _lessonPath(payload.lesson);
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);

  return _withLock(function () {
    var ss = _ss();
    var gsheet = ss.getSheetByName("Groups");
    var spelling = _groupSpellings(gsheet)[key];
    var members = _groupMembers(gsheet, key);
    if (!members.length) throw new Error("That group has no members yet.");
    var who = _nameLookup(ss);
    var expiresAt = "";
    var granted = members.map(function (m) {
      var g = _grantQuizRaw(ss, m.phone, lesson, explicit, days, "group:" + (spelling || payload.group));
      expiresAt = g.expires_at;
      return { phone: m.phone, name: who(m.phone).name };
    });
    var groupEndsQ = _rememberGroupGrant(ss, key, spelling || payload.group, "quiz", lesson, explicit, days);
    return { ok: true, group: spelling || payload.group, lesson: lesson,
             expires_at: groupEndsQ, granted: granted, count: granted.length };
  });
}

// Applies admin_revoke_quiz_access to every member; a member who doesn't hold this
// override is skipped rather than failing the whole batch.
function handleAdminGroupRevokeQuizAccess(payload) {
  _requireAdminAny(payload);
  var key = _groupKey(payload.group);
  var lesson = _lessonPath(payload.lesson);

  return _withLock(function () {
    var ss = _ss();
    var gsheet = ss.getSheetByName("Groups");
    var spelling = _groupSpellings(gsheet)[key];
    var members = _groupMembers(gsheet, key);
    if (!members.length) throw new Error("That group has no members yet.");
    var qaSheet = ss.getSheetByName("QuizAccess");
    var removed = 0;
    members.forEach(function (m) {
      if (!qaSheet || qaSheet.getLastRow() < 2) return;
      var c = _needCols(qaSheet, "QuizAccess", ["phone", "lesson"]);
      var values = qaSheet.getRange(2, 1, qaSheet.getLastRow() - 1, qaSheet.getLastColumn()).getValues();
      var rows = [];
      for (var i = 0; i < values.length; i++) {
        if (_phonesMatch(values[i][c.phone - 1], m.phone) && _canonKey(String(values[i][c.lesson - 1]).trim().toLowerCase()) === lesson) rows.push(i + 2);
      }
      if (!rows.length) return;
      rows.sort(function (a, b) { return b - a; }).forEach(function (r) { qaSheet.deleteRows(r, 1); });
      removed++;
    });
    var forgotQ = _forgetGroupGrants(ss, key, "quiz", lesson);
    return { ok: true, group: spelling || payload.group, lesson: lesson, removed_students: removed, group_rule_removed: forgotQ > 0 };
  });
}

// -- Student groups -----------------------------------------------------------------
// One row per (group, phone) membership in a "Groups" tab. See the "Student groups"
// note at the top of this file.

var GROUP_HEADERS = ["group", "phone", "name", "added_at"];
var GROUP_NAME_RE = /^[\w][\w .-]{0,59}$/;   // letters/digits/underscore, space, dot, hyphen — 1-60 chars

function _groupKey(name) {
  return String(name == null ? "" : name).trim().replace(/\s+/g, " ").toLowerCase();
}

function _cleanGroupName(raw) {
  var name = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
  if (!GROUP_NAME_RE.test(name)) throw new Error("Group names can use letters, numbers, spaces, \".\" and \"-\" (1-60 characters).");
  return name;
}

// -- Group grants: what a group has been given, so a student who joins later gets it too ----
var GROUP_GRANT_HEADERS = ["group_key", "group", "kind", "target", "expires_at", "granted_at"];

// Rows of the GroupGrants tab for one group key ("" = every group). Each row:
// {row, key, group, kind, target, ymd}  (ymd: "yyyy-MM-dd", "" = never ends, null = unreadable).
function _groupGrantRows(ss, key) {
  var sheet = ss.getSheetByName("GroupGrants");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var c = _needCols(sheet, "GroupGrants", GROUP_GRANT_HEADERS);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var k = String(values[i][c.group_key - 1] || "").trim();
    if (!k || (key && k !== key)) continue;
    out.push({ row: i + 2, key: k, group: String(values[i][c.group - 1] || ""),
               kind: String(values[i][c.kind - 1] || "").trim().toLowerCase(),
               target: String(values[i][c.target - 1] || "").trim().toLowerCase(),
               ymd: _ymdOf(values[i][c.expires_at - 1], tz),
               granted_at: String(values[i][c.granted_at - 1] || "") });
  }
  return out;
}

// INSIDE the lock. Remember (or extend, never shorten) one group grant.
function _rememberGroupGrant(ss, key, spelling, kind, target, explicitYmd, days) {
  var sheet = _sheetByName(ss, "GroupGrants", GROUP_GRANT_HEADERS);
  _ensureColumns(sheet, GROUP_GRANT_HEADERS);
  var c = _needCols(sheet, "GroupGrants", GROUP_GRANT_HEADERS);
  var today = _todayCairo();
  var now = _fmt(new Date(), TZ, true);
  var found = _groupGrantRows(ss, key).filter(function (r) { return r.kind === kind && r.target === target; })[0];
  var t = explicitYmd ? explicitYmd : (days ? _addDays(today, days) : "");
  if (found) {
    if (found.ymd === "") t = "";
    else if (found.ymd && t !== "" && found.ymd > t) t = found.ymd;
    sheet.getRange(found.row, c.expires_at).setNumberFormat("@").setValue(t);
    sheet.getRange(found.row, c.granted_at).setNumberFormat("@").setValue(now);
  } else {
    _appendByHeader(sheet, { group_key: key, group: spelling, kind: kind, target: target, expires_at: t, granted_at: now });
  }
  return t;
}

// INSIDE the lock. Forget one remembered group grant (or all of a group's, when kind is "").
function _forgetGroupGrants(ss, key, kind, target) {
  var sheet = ss.getSheetByName("GroupGrants");
  if (!sheet) return 0;
  var rows = _groupGrantRows(ss, key).filter(function (r) { return !kind || (r.kind === kind && r.target === target); })
    .map(function (r) { return r.row; });
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
  return rows.length;
}

// INSIDE the lock. Give newly-added phones everything the group currently gives.
// Returns [{kind, target, expires_at}] that were applied.
function _applyGroupGrantsTo(ss, key, spelling, phones) {
  var today = _todayCairo();
  var live = _groupGrantRows(ss, key).filter(function (r) {
    return r.ymd !== null && (r.ymd === "" || r.ymd >= today);
  });
  live.forEach(function (r) {
    phones.forEach(function (phone) {
      if (r.kind === "quiz") _grantQuizRaw(ss, phone, r.target, r.ymd, 0, "group:" + spelling);
      else _grantRaw(ss, phone, r.target, r.ymd, 0, "group:" + spelling);
    });
  });
  return live.map(function (r) { return { kind: r.kind, target: r.target, expires_at: r.ymd }; });
}

// Every existing group's key -> the exact spelling first used for it, so every
// membership row of one group displays identically however it was typed later.
function _groupSpellings(sheet) {
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var c = _needCols(sheet, "Groups", ["group"]);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
    var g = String(r[c.group - 1] || "").trim();
    var k = _groupKey(g);
    if (g && !map.hasOwnProperty(k)) map[k] = g;
  });
  return map;
}

function _nameLookup() {
  var byKey = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) {
    var k = _phoneKey(r.phone);
    if (k && !byKey.hasOwnProperty(k)) byKey[k] = String(r.display_name == null ? "" : r.display_name);
  });
  return function (phone) {
    var k = _phoneKey(phone);
    return { known: byKey.hasOwnProperty(k), name: byKey.hasOwnProperty(k) ? byKey[k] : "" };
  };
}

// {group, phone} rows for one group (canonical key), or every row grouped by
// group when groupKey is "". `who` is an optional _nameLookup() result.
function _groupMembers(sheet, groupKey, who) {
  var out = [];
  if (!sheet || sheet.getLastRow() < 2) return out;
  var c = _needCols(sheet, "Groups", ["group", "phone"]);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    var g = String(values[i][c.group - 1] || "");
    if (groupKey && _groupKey(g) !== groupKey) continue;
    var phone = String(values[i][c.phone - 1] || "");
    var w = who ? who(phone) : { known: null, name: "" };
    out.push({ row: i + 2, group: g, phone: phone, name: w.name, known_student: w.known });
  }
  return out;
}

// What a group currently gives new members: live grants only (an ended one gives nothing).
function _groupGrantsForApi(ss, key) {
  var today = _todayCairo();
  return _groupGrantRows(ss, key).filter(function (r) { return r.ymd !== null && (r.ymd === "" || r.ymd >= today); })
    .map(function (r) { return { kind: r.kind, target: r.target, expires_at: r.ymd, granted_at: r.granted_at }; });
}

function handleAdminListGroups(payload) {
  _requireAdminAny(payload);
  var ss = _ss();
  var sheet = ss.getSheetByName("Groups");
  var who = _nameLookup(ss);
  var all = _groupMembers(sheet, "", who);
  var spellings = _groupSpellings(sheet);
  var byKey = {};
  all.forEach(function (m) {
    var k = _groupKey(m.group);
    if (!byKey[k]) byKey[k] = { group: spellings[k] || m.group, members: [] };
    byKey[k].members.push({ phone: m.phone, name: m.name, known_student: m.known_student });
  });
  var groups = Object.keys(byKey).map(function (k) { byKey[k].grants = _groupGrantsForApi(ss, k); return byKey[k]; })
    .sort(function (a, b) { return a.group.toLowerCase() < b.group.toLowerCase() ? -1 : 1; });
  return { ok: true, groups: groups };
}

function handleAdminGroupAdd(payload) {
  _requireAdminAny(payload);
  var group = _cleanGroupName(payload.group);
  var key = _groupKey(group);

  // Bulk form: { phones: [...] } adds several students in one lock (the roster picker
  // on the access dashboard uses this). Single form { phone } is unchanged.
  if (payload.phones !== undefined && payload.phones !== null) {
    if (!Array.isArray(payload.phones) || !payload.phones.length) throw new Error("Choose at least one student.");
    if (payload.phones.length > 500) throw new Error("Too many students at once (500 max).");
    var wanted = [];
    payload.phones.forEach(function (p) {
      if (_normalizePhone(p).length < 10) throw new Error("Enter the student's full phone number.");
      var cp = _canonicalPhone(p);
      if (!wanted.some(function (w) { return _phonesMatch(w, cp); })) wanted.push(cp);
    });
    return _withLock(function () {
      var ss = _ss();
      var sheet = _sheetByName(ss, "Groups", GROUP_HEADERS);
      _ensureColumns(sheet, GROUP_HEADERS);
      var spelling = _groupSpellings(sheet)[key] || group;
      var members = _groupMembers(sheet, key);
      var who = _nameLookup();
      // FU2: one group per student. Nothing is written until the whole request is allowed (all or nothing, under this lock).
      var move = _fu2Move(payload);
      var conflicts = _fu2Conflicts(sheet, wanted, key, who, move);
      var foreign = _fu2ScopedRefusal(conflicts); if (foreign) return foreign;   // FU2 x P4: a teacher never moves a student out of a group that is not theirs
      if (conflicts.length && !move) return _fu2InOtherGroup(conflicts);
      var moved = conflicts.length ? _fu2MoveOut(ss, sheet, conflicts, spelling, payload) : [];
      var added = [], already = [];
      wanted.forEach(function (phone) {
        var w = who(phone);
        if (members.some(function (m) { return _phonesMatch(m.phone, phone); })) {
          already.push({ phone: phone, name: w.name });
          return;
        }
        _appendByHeader(sheet, { group: spelling, phone: phone, name: w.name, added_at: _fmt(new Date(), TZ, true) });
        added.push({ phone: phone, name: w.name, known_student: w.known });
      });
      var inherited = added.length ? _applyGroupGrantsTo(ss, key, spelling, added.map(function (a) { return a.phone; })) : [];
      var res = { ok: true, group: spelling, added: added, already: already, count: added.length, inherited: inherited };
      if (moved.length) res.moved = moved;   // FU2
      return res;
    });
  }

  if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
  var phone = _canonicalPhone(payload.phone);

  return _withLock(function () {
    var ss = _ss();
    var sheet = _sheetByName(ss, "Groups", GROUP_HEADERS);
    _ensureColumns(sheet, GROUP_HEADERS);
    var spelling = _groupSpellings(sheet)[key] || group;   // keep the group's existing spelling if it has one
    var existing = _groupMembers(sheet, key).filter(function (m) { return _phonesMatch(m.phone, phone); });
    var stu = _findStudentRow(_students(), phone);
    var name = stu ? String(stu.display_name == null ? "" : stu.display_name) : "";
    // FU2: one group per student (see _fu2Conflicts). A student already in THIS group is just "already"; with move:true
    // any second membership they happen to have is cleaned up too.
    var move1 = _fu2Move(payload), who1 = function () { return { known: !!stu, name: name }; };
    var conflicts1 = _fu2Conflicts(sheet, [phone], key, who1, move1);
    var foreign1 = _fu2ScopedRefusal(conflicts1); if (foreign1) return foreign1;   // FU2 x P4 (see _fu2ScopedRefusal)
    if (existing.length && !move1) return { ok: true, group: spelling, phone: phone, name: name, known_student: !!stu, already: true };
    if (conflicts1.length && !move1) return _fu2InOtherGroup(conflicts1);
    var moved1 = conflicts1.length ? _fu2MoveOut(ss, sheet, conflicts1, spelling, payload) : [];
    if (existing.length) return { ok: true, group: spelling, phone: phone, name: name, known_student: !!stu, already: true, moved: moved1 };
    _appendByHeader(sheet, { group: spelling, phone: phone, name: name, added_at: _fmt(new Date(), TZ, true) });
    var inheritedOne = _applyGroupGrantsTo(ss, key, spelling, [phone]);
    var res1 = { ok: true, group: spelling, phone: phone, name: name, known_student: !!stu, already: false, inherited: inheritedOne };
    if (moved1.length) res1.moved = moved1;   // FU2
    return res1;
  });
}

// ---- FU2: one group per student -------------------------------------------------------------------
// A student belongs to at most one group. admin_group_add keeps its request shape; the optional field move:true means
// "if they are in a different group, take them out of it first". Without it the answer is
// {ok:false, code:"in_other_group", from, conflicts:[{phone,name,from}], error} and NOTHING is changed (a bulk request is
// all or nothing). Everything runs inside the caller's _withLock, so two concurrent requests cannot both pass the check.
function _fu2Move(payload) { return payload.move === true || String(payload.move).toLowerCase() === "true"; }

// Students in `phones` (not already in group `key`, unless move) who sit in some other group.
// -> [{phone, name, from, from_groups:[spelling], rows:[sheet rows], keys:[group key]}]
// FU2 x P4 (integration): with several teachers the rule is ONE GROUP PER STUDENT PER TEACHER. A student taking
// Programming with the owner and Math with a teacher is in two groups on purpose; only groups with the SAME owner as the
// target group conflict (and only those are ever moved out of). Owner of a group = its GroupOwners row (Phase 4), "" for
// the owner's own groups. The target of a scoped caller (teacher / teacher-appointed assistant) is theirs: P4's gate only
// lets them add to their own group or to a free name that becomes theirs right after this handler.
function _fu2GroupOwners_() {
  var m = {};
  try {
    var sh = _ss().getSheetByName("GroupOwners");
    if (sh && sh.getLastRow() >= 2) _sheetValuesAsObjects(sh).forEach(function (r) {
      var k = _groupKey(r.group);
      if (k && !m.hasOwnProperty(k)) m[k] = typeof p4_idKey_ === "function" ? p4_idKey_(r.owner_id) : String(r.owner_id || "");
    });
  } catch (e) { /* no Phase 4 sheet: everything belongs to the owner */ }
  return m;
}
function _fu2TargetOwner_(key, owners) {
  var ctx = (typeof P4_GATE_RAN_ !== "undefined" && P4_GATE_RAN_ && typeof P4_CTX_ !== "undefined") ? P4_CTX_ : null;
  if (ctx && typeof p4_isScoped_ === "function" && p4_isScoped_(ctx) && typeof p4_principalKey_ === "function") return p4_principalKey_(ctx);
  return owners.hasOwnProperty(key) ? owners[key] : "";
}
function _fu2Conflicts(sheet, phones, key, who, includeAlreadyIn) {
  var all = _groupMembers(sheet, "", null), spellings = _groupSpellings(sheet), out = [];
  var owners = _fu2GroupOwners_(), target = _fu2TargetOwner_(key, owners);
  var sameOwner = function (g) { var k = _groupKey(g); return (owners.hasOwnProperty(k) ? owners[k] : "") === target; };
  phones.forEach(function (phone) {
    var mine = all.filter(function (m) { return _phonesMatch(m.phone, phone) && (_groupKey(m.group) === key || sameOwner(m.group)); });
    var others = mine.filter(function (m) { return _groupKey(m.group) !== key; });
    if (!others.length) return;
    if (!includeAlreadyIn && mine.some(function (m) { return _groupKey(m.group) === key; })) return;   // already in the target group: nothing to move
    var keys = [], names = [];
    others.forEach(function (m) { var k = _groupKey(m.group); if (keys.indexOf(k) < 0) { keys.push(k); names.push(spellings[k] || m.group); } });
    out.push({ phone: phone, name: who(phone).name, from: names[0], from_groups: names, rows: others.map(function (m) { return m.row; }), keys: keys });
  });
  return out;
}

// FU2 x P4 (integration): P4's gate only checks the TARGET group for a teacher / teacher-appointed assistant. A move takes
// the student OUT of their current group, so for those callers every group the student is in must be theirs too; otherwise
// nothing changes and the answer names neither the student nor the other group (it may belong to the owner or another
// teacher). The owner and the owner's own assistants are unaffected. null = allowed.
function _fu2ScopedRefusal(conflicts) {
  if (!conflicts || !conflicts.length) return null;
  var ctx = (typeof P4_GATE_RAN_ !== "undefined" && P4_GATE_RAN_ && typeof P4_CTX_ !== "undefined") ? P4_CTX_ : null;
  if (!ctx || typeof p4_isScoped_ !== "function" || !p4_isScoped_(ctx) || typeof p4_ownsGroup !== "function") return null;
  var bad = conflicts.filter(function (c) { return (c.from_groups || [c.from]).some(function (g) { return !p4_ownsGroup(ctx, g); }); });
  if (!bad.length) return null;
  return { ok: false, code: "in_other_group", foreign: true,
    error: "in_other_group: " + (bad.length === 1 ? "this student is" : bad.length + " of these students are") + " already in a group you do not manage. Ask the owner to move them." };
}

function _fu2InOtherGroup(conflicts) {
  var first = conflicts[0], label = first.name || first.phone;
  var msg = conflicts.length === 1
    ? "in_other_group: " + label + " is already in \u201c" + first.from + "\u201d. A student can be in one group only; move them instead."
    : "in_other_group: " + conflicts.length + " of these students are already in another group (for example " + label + " in \u201c" + first.from + "\u201d). A student can be in one group only; move them instead.";
  return { ok: false, code: "in_other_group", from: first.from, conflicts: conflicts.map(function (c) { return { phone: c.phone, name: c.name, from: c.from }; }), error: msg };
}

// Deletes the old membership rows (bottom first), audits each move, and forgets a group's remembered grants when it ends up empty,
// exactly like admin_group_remove does. Returns [{phone, name, from}].
function _fu2MoveOut(ss, sheet, conflicts, toSpelling, payload) {
  var rows = [], touched = {};
  conflicts.forEach(function (c) { c.rows.forEach(function (r) { rows.push(r); }); c.keys.forEach(function (k) { touched[k] = true; }); });
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
  Object.keys(touched).forEach(function (k) {
    if (!_groupMembers(sheet, k).length) _forgetGroupGrants(ss, k, "", "");
  });
  var who = payload.student_id && !payload.token ? payload.student_id : "token";
  return conflicts.map(function (c) {
    try { p2_audit(who, "group_move", c.phone, { groups: c.from_groups }, { group: toSpelling }); } catch (e) { /* audit never blocks */ }
    return { phone: c.phone, name: c.name, from: c.from };
  });
}

// Students currently in 2+ groups. Never changes data. -> [{phone, name, groups:[spelling]}]
function _fu2Duplicates() {
  var sheet = _ss().getSheetByName("Groups");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var spellings = _groupSpellings(sheet), who = _nameLookup(), by = {}, order = [], owners = _fu2GroupOwners_();
  _groupMembers(sheet, "", null).forEach(function (m) {
    var gk0 = _groupKey(m.group), ow = owners.hasOwnProperty(gk0) ? owners[gk0] : "";
    var pk = _phoneKey(m.phone); if (!pk) return;
    pk = pk + "|" + ow;   // FU2 x P4: one group per student PER TEACHER (see _fu2GroupOwners_)
    if (!by[pk]) { by[pk] = { phone: m.phone, keys: [], groups: [] }; order.push(pk); }
    var gk = _groupKey(m.group);
    if (by[pk].keys.indexOf(gk) < 0) { by[pk].keys.push(gk); by[pk].groups.push(spellings[gk] || m.group); }
  });
  return order.filter(function (pk) { return by[pk].groups.length > 1; }).map(function (pk) {
    return { phone: by[pk].phone, name: who(by[pk].phone).name, groups: by[pk].groups };
  });
}

function handleAdminGroupRemove(payload) {
  _requireAdminAny(payload);
  var key = _groupKey(payload.group);

  // Bulk form: { phones: [...] } removes several members in one lock. Members who
  // aren't in the group are skipped. Single form { phone } is unchanged (errors if absent).
  if (payload.phones !== undefined && payload.phones !== null) {
    if (!Array.isArray(payload.phones) || !payload.phones.length) throw new Error("Choose at least one student.");
    var list = payload.phones.map(function (p) {
      if (_normalizePhone(p).length < 10) throw new Error("Enter the student's full phone number.");
      return _canonicalPhone(p);
    });
    return _withLock(function () {
      var sheet = _ss().getSheetByName("Groups");
      var members = sheet ? _groupMembers(sheet, key) : [];
      var rows = members.filter(function (m) {
        return list.some(function (p) { return _phonesMatch(m.phone, p); });
      }).map(function (m) { return m.row; });
      if (!rows.length) throw new Error("None of those students are in that group.");
      rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
      if (members.length === rows.length) _forgetGroupGrants(_ss(), key, "", "");   // group is gone: forget what it gave
      return { ok: true, removed: rows.length };
    });
  }

  if (_normalizePhone(payload.phone).length < 10) throw new Error("Enter the student's full phone number.");
  var phone = _canonicalPhone(payload.phone);

  return _withLock(function () {
    var sheet = _ss().getSheetByName("Groups");
    var members = sheet ? _groupMembers(sheet, key) : [];
    var rows = members.filter(function (m) { return _phonesMatch(m.phone, phone); }).map(function (m) { return m.row; });
    if (!rows.length) throw new Error("That student isn't in that group.");
    rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
    if (members.length === rows.length) _forgetGroupGrants(_ss(), key, "", "");
    return { ok: true, removed: rows.length };
  });
}

// Applies admin_grant_access to every member of a group, in one lock.
function handleAdminGroupGrantAccess(payload) {
  _requireAdminAny(payload);
  var key = _groupKey(payload.group);
  var scope = _normalizeScope(payload.scope);
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);

  return _withLock(function () {
    var ss = _ss();
    var sheet = ss.getSheetByName("Groups");
    var spelling = _groupSpellings(sheet)[key];
    var members = _groupMembers(sheet, key);
    if (!members.length) throw new Error("That group has no members yet.");
    var who = _nameLookup();
    var expiresAt = "";
    var granted = members.map(function (m) {
      var g = _grantRaw(ss, m.phone, scope, explicit, days, "group:" + (spelling || payload.group));
      expiresAt = g.expires_at;
      return { phone: m.phone, name: who(m.phone).name };
    });
    // Remember it, so students added to the group later get the same access.
    var groupEnds = _rememberGroupGrant(ss, key, spelling || payload.group, "access", scope, explicit, days);
    return { ok: true, group: spelling || payload.group, scope: scope,
             expires_at: groupEnds, granted: granted, count: granted.length };
  });
}

// Applies admin_revoke_access to every member of a group; members who don't hold
// that access are skipped rather than failing the whole batch.
function handleAdminGroupRevokeAccess(payload) {
  _requireAdminAny(payload);
  var key = _groupKey(payload.group);
  var scope = _normalizeScope(payload.scope);

  return _withLock(function () {
    var ss = _ss();
    var gsheet = ss.getSheetByName("Groups");
    var spelling = _groupSpellings(gsheet)[key];
    var members = _groupMembers(gsheet, key);
    if (!members.length) throw new Error("That group has no members yet.");
    var eSheet = ss.getSheetByName("Entitlements");
    var pSheet = null, pIdx = null;
    var removedStudents = 0, paymentsRevoked = [];
    members.forEach(function (m) {
      if (!eSheet || eSheet.getLastRow() < 2) return;
      var c = _needCols(eSheet, "Entitlements", ["phone", "scope"]);
      var srcCol = _headerIndex(eSheet)["source"] || 0;
      var values = eSheet.getRange(2, 1, eSheet.getLastRow() - 1, eSheet.getLastColumn()).getValues();
      var rows = [], pays = [];
      for (var i = 0; i < values.length; i++) {
        if (!_phonesMatch(values[i][c.phone - 1], m.phone)) continue;
        if (_canonKey(String(values[i][c.scope - 1]).trim().toLowerCase()) !== scope) continue;
        rows.push(i + 2);
        var src = srcCol ? _sourcePayment(values[i][srcCol - 1]) : "";
        if (src) pays.push(src);
      }
      if (!rows.length) return;
      rows.sort(function (a, b) { return b - a; }).forEach(function (r) { eSheet.deleteRows(r, 1); });
      removedStudents++;
      if (!pays.length) return;
      if (!pSheet) {
        pSheet = ss.getSheetByName("Payments");
        if (pSheet && pSheet.getLastRow() >= 2) pIdx = _needCols(pSheet, "Payments", ["payment_id", "status", "decided_at"]);
      }
      if (!pSheet || !pIdx) return;
      var pv = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, pSheet.getLastColumn()).getValues();
      var now = _fmt(new Date(), TZ, true);
      for (var k = 0; k < pv.length; k++) {
        var id = String(pv[k][pIdx.payment_id - 1]).trim();
        if (pays.indexOf(id) === -1 || String(pv[k][pIdx.status - 1]).trim().toLowerCase() !== "approved") continue;
        pSheet.getRange(k + 2, pIdx.status).setNumberFormat("@").setValue("revoked");
        pSheet.getRange(k + 2, pIdx.decided_at).setNumberFormat("@").setValue(now);
        paymentsRevoked.push(id);
      }
    });
    var forgot = _forgetGroupGrants(ss, key, "access", scope);   // later joiners no longer get it
    return { ok: true, group: spelling || payload.group, scope: scope, removed_students: removedStudents, payments_revoked: paymentsRevoked, group_rule_removed: forgot > 0 };
  });
}

// -- One-off cleanup of duplicates written BEFORE the fix -------------------
// Run from the Apps Script editor (function dropdown -> Run), then read
// View -> Logs / Execution log.
//   previewDuplicates()  — only reports; changes nothing.
//   removeDuplicates()   — copies the data spreadsheet in Drive first, then
//                          deletes duplicate + blank rows (keeps the first
//                          of each). Drive files are left alone.
// A quiz duplicate = same student + subject + lesson + start_time (one
// attempt saved twice). A submission duplicate = same student + lesson +
// type + identical content within 2 minutes of the kept one.

function previewDuplicates() { _cleanSheets(false); }
function removeDuplicates() { _cleanSheets(true); }

function _cleanSheets(apply, skipBackup) {
  var ss = _dataSs();
  if (apply && !skipBackup) {
    var name = "Backup before dedupe " + _fmt(new Date(), TZ, true);
    DriveApp.getFileById(ss.getId()).makeCopy(name);
    Logger.log("Backup created: " + name);
  }
  var q = ss.getSheetByName("QuizResults");
  var s = ss.getSheetByName("Submissions");
  if (q) _cleanOne(q, "quiz", apply);
  if (s) _cleanOne(s, "submission", apply);
}

function _cleanOne(sheet, kind, apply) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) { Logger.log(sheet.getName() + ": no data rows."); return; }
  var headers = values[0];
  var cols = {};   // header -> every column index carrying that name
  headers.forEach(function (h, i) { if (h !== "") (cols[h] = cols[h] || []).push(i); });
  var sheetTz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  // First NON-EMPTY value among same-named columns, so a row is never judged
  // "blank" just because one copy of a repeated column is empty.
  function cell(row, h) {
    var idxs = cols[h] || [];
    for (var k = 0; k < idxs.length; k++) {
      var v = _cellOut(h, row[idxs[k]], sheetTz);
      if (v !== "" && v !== null && v !== undefined) return v;
    }
    return "";
  }
  function isEmptyRow(row) { return row.every(function (v) { return String(v).trim() === ""; }); }

  var seen = {};      // key -> last kept time (ms), or true
  var doomed = [];    // 1-based sheet rows to delete
  var blank = 0, dup = 0, noScore = 0;

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var sid = _phoneKey(cell(row, "student_id"));
    if (isEmptyRow(row) || String(cell(row, "student_id")) === "student_id" || (!sid && !cell(row, "lesson"))) {
      doomed.push(i + 1); blank++; continue;   // empty, a repeated header row, or an orphan with no student/lesson
    }
    if (kind === "quiz" && (cell(row, "score") === "" || cell(row, "total") === "")) noScore++;

    if (kind === "quiz") {
      var st = String(cell(row, "start_time"));
      if (!st) continue; // nothing reliable to compare — keep
      var qk = [sid, cell(row, "subject"), cell(row, "lesson"), st].join("|");
      if (seen[qk]) { doomed.push(i + 1); dup++; } else seen[qk] = true;
    } else {
      var type = cell(row, "submission_type");
      var sig = type === "graded" ? cell(row, "answers_json")
        : type === "url" ? cell(row, "url")
        : type === "file" ? cell(row, "file_name")
        : cell(row, "text");
      var sk = [sid, cell(row, "subject"), cell(row, "lesson"), type, _md5(sig)].join("|");
      var tt = String(cell(row, "submitted_time"));
      var ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(tt) ? Date.parse(tt.replace(" ", "T") + "Z") : NaN;
      if (isNaN(ms)) continue; // no usable time — keep
      if (seen[sk] !== undefined && Math.abs(ms - seen[sk]) <= 120000) { doomed.push(i + 1); dup++; }
      else seen[sk] = ms;
    }
  }

  Logger.log(sheet.getName() + ": " + (values.length - 1) + " data rows | " + dup + " duplicates | " +
    blank + " blank rows | " + (kind === "quiz" ? noScore + " rows without a score | " : "") +
    "would keep " + (values.length - 1 - doomed.length));

  if (!apply || !doomed.length) return;

  // Delete bottom-up in contiguous runs (deleteRows is slow one row at a time).
  doomed.sort(function (a, b) { return b - a; });
  var runStart = doomed[0], runLen = 1;
  for (var k = 1; k <= doomed.length; k++) {
    if (k < doomed.length && doomed[k] === runStart - 1) { runStart = doomed[k]; runLen++; continue; }
    sheet.deleteRows(runStart, runLen);
    if (k < doomed.length) { runStart = doomed[k]; runLen = 1; }
  }
  Logger.log(sheet.getName() + ": deleted " + doomed.length + " rows.");
}

// -- Make the data sheets tidy to look at -----------------------------------
function cleanEverything() { _cleanSheets(true); tidySheets(); }

function tidySheets() {
  var ss = _dataSs();
  ["QuizResults", "Submissions"].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) _tidyOne(sh);
  });
  Logger.log("Tidy done.");
}

function _tidyOne(sheet) {
  var last = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var sheetTz = sheet.getParent().getSpreadsheetTimeZone() || TZ;

  // 1. Old rows: Date cells -> readable Cairo text; phone numbers that lost
  //    their leading 0 (10 digits starting with 1) get it back. Columns are
  //    set to Plain Text so Sheets can't change them again.
  if (last >= 2) {
    headers.forEach(function (h, i) {
      if (!TEXT_COLS[h] || headers.indexOf(h) !== i) return;
      var rng = sheet.getRange(2, i + 1, last - 1, 1);
      var vals = rng.getValues().map(function (r) {
        var v = r[0];
        if (h === "student_id") {
          var d = String(v).replace(/\D/g, "");
          return [(d.length === 10 && d.charAt(0) === "1") ? "0" + d : (v === "" ? "" : String(v))];
        }
        if (h === "date") {
          if (v instanceof Date) return [_fmt(v, sheetTz, false)];
          if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return [_cairoDate(v)];
          return [v];
        }
        return [_cellOut(h, v, sheetTz)];
      });
      rng.setNumberFormat("@");
      rng.setValues(vals);
    });
  }

  // 2. Look: bold frozen header, big JSON/text columns clipped to one line.
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastCol).setFontWeight("bold").setBackground("#efeafc");
  headers.forEach(function (h, i) {
    var c = i + 1;
    if (h === "questions_json" || h === "answers_json" || h === "text") {
      sheet.getRange(1, c, Math.max(last, 2), 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
      sheet.setColumnWidth(c, 170);
    } else if (h === "dedupe_key") {
      sheet.hideColumns(c);
    } else {
      sheet.autoResizeColumn(c);
    }
  });

  // 3. Trim the empty rows below the data (keep a little room).
  var max = sheet.getMaxRows();
  if (max > last + 20) sheet.deleteRows(last + 21, max - last - 20);
}

// -- Repair a sheet whose header row has the same column name twice -----------
// Symptom: QuizResults with 22 columns (student_id ... questions_json twice).
// Rows written by appendRow only fill the FIRST copy, so anything that read
// the second copy saw those rows as empty — they vanished from the dashboard
// and were treated as blank by the cleanup. This folds each repeated column
// into its first copy (moving values across where the first copy is empty)
// and deletes the repeat. It refuses to touch a sheet where the two copies
// disagree on a non-empty cell.
function repairLayout() {
  var ss = _dataSs();
  ["QuizResults", "Submissions"].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh) _repairOne(sh);
  });
}

function _repairOne(sheet) {
  var lastCol = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  var name = sheet.getName();
  if (lastCol < 2 || lastRow < 1) return;
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var headers = values[0], first = {}, dups = [];
  headers.forEach(function (h, j) {
    if (h === "") return;
    if (first.hasOwnProperty(h)) dups.push(j); else first[h] = j;
  });
  if (!dups.length) { Logger.log(name + ": layout OK (no repeated columns)."); return; }

  var conflicts = 0, moves = [];
  for (var r = 1; r < values.length; r++) {
    dups.forEach(function (j) {
      var i = first[headers[j]];
      var L = values[r][i], R = values[r][j];
      var Ls = String(L).trim(), Rs = String(R).trim();
      if (Rs === "") return;
      if (Ls === "") { moves.push([r + 1, i + 1, R]); return; }
      if (Ls !== Rs) conflicts++;
    });
  }
  if (conflicts) {
    Logger.log(name + ": " + conflicts + " cells differ between repeated columns — NOT changed. Check the backup and tell Claude.");
    return;
  }
  moves.forEach(function (m) { sheet.getRange(m[0], m[1]).setValue(m[2]); });
  dups.slice().sort(function (a, b) { return b - a; }).forEach(function (j) { sheet.deleteColumn(j + 1); });
  Logger.log(name + ": folded " + dups.length + " repeated columns (" + moves.length + " values moved into the first copy).");
}

// -- Put back rows that exist as Drive JSON files but not in the sheet --------
// Every quiz attempt and submission is saved to Drive BEFORE the sheet row is
// written, so Drive is the source of truth. Safe to run repeatedly: a row is
// only added when no matching row is already in the sheet.
function restoreAllFromDrive() { _restoreFromDrive(0); }
function restoreLast30Days() { _restoreFromDrive(30); }

function _restoreFromDrive(days) {
  var started = Date.now();
  var LIMIT = 4.5 * 60 * 1000;   // Apps Script stops at 6 minutes
  var since = days ? Utilities.formatDate(new Date(Date.now() - days * 86400000), "UTC", "yyyy-MM-dd'T'HH:mm:ss") : "";
  var timedOut = false;

  var qSheet = _quizResultsSheet();
  var sSheet = _submissionsSheet();

  // What the sheet already has.
  var haveQ = {};
  _sheetValuesAsObjects(qSheet).forEach(function (r) {
    haveQ[[_phoneKey(r.student_id), r.subject, r.lesson, _cairoTime(r.start_time)].join("|")] = true;
  });
  var haveS = {};   // key -> [ms, ...]
  _sheetValuesAsObjects(sSheet).forEach(function (r) {
    var k = [_phoneKey(r.student_id), r.subject, r.lesson, r.submission_type, _md5(_subContent(r.submission_type, r.answers_json, r.url, r.file_name, r.text))].join("|");
    (haveS[k] = haveS[k] || []).push(_msOf(r.submitted_time));
  });

  var addedQ = 0, addedS = 0, scanned = 0;

  function eachFile(folderProp, suffix, fn) {
    var folder = _folder(folderProp);
    var it = since ? folder.searchFiles('modifiedDate > "' + since + '"') : folder.getFiles();
    while (it.hasNext()) {
      if (Date.now() - started > LIMIT) { timedOut = true; return; }
      var f = it.next();
      if (f.getName().slice(-suffix.length) !== suffix) continue;
      scanned++;
      var data;
      try { data = JSON.parse(f.getBlob().getDataAsString()); } catch (e) { continue; }
      fn(data);
    }
  }

  eachFile("QUIZ_RESULTS_FOLDER_ID", "--quiz-result.json", function (d) {
    if (!d.student_id) return;
    var start = _cairoTime(d.start_time);
    var key = [_phoneKey(d.student_id), d.subject, d.lesson, start].join("|");
    if (haveQ[key]) return;
    _appendByHeader(qSheet, {
      student_id: d.student_id, name: d.name, subject: d.subject, lesson: d.lesson, quiz_title: d.quiz_title,
      date: _cairoDate(start) || d.date, start_time: start, end_time: _cairoTime(d.end_time),
      score: d.score, total: d.total,
      questions_json: JSON.stringify(d.questions || d.wrong_questions || []),
      dedupe_key: "q:" + key,
    });
    haveQ[key] = true; addedQ++;
  });

  eachFile("SUBMISSIONS_FOLDER_ID", "--meta.json", function (d) {
    if (!d.student_id) return;
    var when = _cairoTime(d.submitted_time), ms = _msOf(when);
    var content = _subContent(d.submission_type, JSON.stringify(d.answers || []), d.url, d.file_name, d.text);
    var key = [_phoneKey(d.student_id), d.subject, d.lesson, d.submission_type, _md5(content)].join("|");
    var seen = haveS[key] || [];
    if (seen.some(function (t) { return !isNaN(ms) && !isNaN(t) && Math.abs(t - ms) <= 120000; })) return;
    var fullText = d.text || "", truncated = fullText.length > TEXT_CELL_LIMIT;
    _appendByHeader(sSheet, {
      student_id: d.student_id, name: d.name, subject: d.subject, lesson: d.lesson,
      submission_type: d.submission_type, text: truncated ? fullText.slice(0, TEXT_CELL_LIMIT) : fullText,
      text_truncated: truncated, url: d.url, note: d.note, file_id: d.file_id, file_name: d.file_name,
      date: _cairoDate(when) || d.date, submitted_time: when, score: d.score, total: d.total,
      answers_json: JSON.stringify(d.answers || []), dedupe_key: "r:" + key + "|" + ms,
    });
    (haveS[key] = haveS[key] || []).push(ms); addedS++;
  });

  Logger.log("Restore: scanned " + scanned + " Drive files | added " + addedQ + " quiz rows, " + addedS + " submissions" +
    (timedOut ? " | STOPPED EARLY (time limit) — run it again to continue" : " | finished"));
}

function _subContent(type, answersJson, url, fileName, text) {
  return type === "graded" ? String(answersJson || "[]")
    : type === "url" ? String(url || "")
    : type === "file" ? String(fileName || "")
    : String(text || "");
}

function _msOf(v) {
  var t = String(v || "");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t) ? Date.parse(t.replace(" ", "T") + "Z") : NaN;
}

// One button: backup -> repair layout -> restore from Drive -> remove
// duplicates -> tidy.
function fixEverything() {
  var ss = _dataSs();
  var name = "Backup before fixEverything " + _fmt(new Date(), TZ, true);
  DriveApp.getFileById(ss.getId()).makeCopy(name);
  Logger.log("Backup created: " + name);
  repairLayout();
  restoreLast30Days();
  _cleanSheets(true, true);
  tidySheets();
}

// ============================================================================
// Sheet safety tools — run from the editor (function dropdown -> Run).
// ============================================================================

// Formats every text-like column of the three tabs as Plain Text (whole column,
// including future rows). Safe to run again any time. Existing cell VALUES are
// not changed — use auditSheets() then repairSheets() for those.
function setupSheets() {
  var done = [];
  [["Students", _students()], ["QuizResults", _quizResultsSheet()], ["Submissions", _submissionsSheet()]].forEach(function (p) {
    done.push(p[0] + ": " + _formatTextColumns(p[1]) + " text columns");
  });
  Logger.log("setupSheets: " + done.join(" | "));
}

function _formatTextColumns(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var n = 0, seen = {};
  headers.forEach(function (h, i) {
    if (PLAIN_TEXT_HEADERS[h] && !seen[h]) {
      seen[h] = true;
      sheet.getRange(2, i + 1, rows, 1).setNumberFormat("@");
      n++;
    }
  });
  return n;
}

// Visits every data cell of every text column that should hold plain text.
// (Date/time columns are skipped — those legitimately hold Date cells in old
// rows and _cellOut already turns them into text on the way out.)
function _scanTextColumns(sheet, visit) {
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var seen = {};
  headers.forEach(function (h, i) {
    if (!PLAIN_TEXT_HEADERS[h] || TIME_COLS[h] || h === "date" || h === "created_at" || seen[h]) return;
    seen[h] = true;
    var rng = sheet.getRange(2, i + 1, lastRow - 1, 1);
    var vals = rng.getValues(), forms = rng.getFormulas();
    for (var r = 0; r < vals.length; r++) visit(r + 2, i + 1, h, vals[r][0], forms[r][0]);
  });
}

// What (if anything) is wrong with one cell, and — when it can be fixed safely
// — what text it should hold.
function _classifyCell(header, v, formula) {
  if (formula) return { kind: "formula", value: formula };
  if (v instanceof Date) return { kind: "date", value: _fmt(v, TZ, true) };
  if (typeof v === "number") {
    var t = PHONE_HEADERS[header] ? _restoreLeadingZero(String(v)) : String(v);
    return { kind: "number", value: v, fix: t };
  }
  if (PHONE_HEADERS[header] && typeof v === "string" && /^1[0125]\d{8}$/.test(v.trim())) {
    return { kind: "phone-missing-0", value: v, fix: "0" + v.trim() };
  }
  return null;
}

function _auditAll() {
  var found = [];
  [["Students", _students()], ["QuizResults", _quizResultsSheet()], ["Submissions", _submissionsSheet()]].forEach(function (p) {
    _scanTextColumns(p[1], function (row, col, header, v, f) {
      var bad = _classifyCell(header, v, f);
      if (bad) found.push({ tab: p[0], sheet: p[1], row: row, col: col, header: header, kind: bad.kind, value: bad.value, fix: bad.fix });
    });
  });
  return found;
}

// READ-ONLY. Lists text cells Sheets already converted: numbers where text
// should be (a name "123"), phones missing their leading 0, formulas (a note
// that started with "="), dates (a name like "1/2").
function auditSheets() {
  var found = _auditAll();
  var counts = {};
  found.forEach(function (x) { counts[x.kind] = (counts[x.kind] || 0) + 1; });
  var lines = found.slice(0, 150).map(function (x) {
    return x.tab + " row " + x.row + " [" + x.header + "] " + x.kind + ": " + String(x.value).slice(0, 60) +
      (x.fix !== undefined ? "   -> repairSheets() will make it \"" + x.fix + "\"" : "   -> fix by hand");
  });
  Logger.log("auditSheets: " + found.length + " suspicious cell(s) " + JSON.stringify(counts) + "\n" + lines.join("\n") +
    (found.length > 150 ? "\n… and " + (found.length - 150) + " more" : ""));
  return found.length;
}

// Copies the spreadsheet(s) to Drive first, formats the text columns, then turns
// numbers back into text and restores dropped phone zeros. Formulas and dates
// are NOT touched (their original text can't be recovered) — auditSheets()
// lists them so you can retype them by hand. Note a number that lost leading
// zeros of its own (a name "007" stored as 7) can't be recovered either.
function repairSheets() {
  var ids = {};
  ids[_ss().getId()] = "Students";
  var dataId = _props().getProperty("DATA_SHEET_ID");
  if (dataId) ids[dataId] = "Quiz data";
  Object.keys(ids).forEach(function (id) {
    var name = "Backup before repairSheets - " + ids[id] + " - " + _fmt(new Date(), TZ, true);
    DriveApp.getFileById(id).makeCopy(name);
    Logger.log("Backup created: " + name);
  });
  setupSheets();
  var fixed = 0, manual = 0;
  _auditAll().forEach(function (x) {
    if (x.fix === undefined) { manual++; return; }
    x.sheet.getRange(x.row, x.col).setNumberFormat("@").setValue(x.fix);
    fixed++;
  });
  Logger.log("repairSheets: repaired " + fixed + " cell(s); " + manual + " formula/date cell(s) need fixing by hand (see auditSheets).");
}

// READ-ONLY. Shows what the new phone-matching rule (same last 10 digits)
// changes on your real data compared with the old one (any shared 7-digit
// tail). Run it BEFORE deploying the new version:
//   - DUPLICATE ACCOUNT      two Students rows are the same number under both rules.
//   - SHARED TAIL ONLY       a shorter number that is the tail of another student's
//                            number — the OLD rule treated them as one person.
//   - WOULD BECOME ORPHANED  quiz/submission rows whose student_id matched a
//                            student before but would match nobody now. Fix the
//                            student_id or the Students phone by hand first.
function findPhoneCollisions() {
  var sheet = _students();
  var values = sheet.getDataRange().getValues();
  var c = _studentCols(values[0]);
  var studs = [];
  for (var i = 1; i < values.length; i++) {
    var p = values[i][c.phone - 1];
    if (_normalizePhone(p)) studs.push({ row: i + 1, phone: String(p), name: String(values[i][c.display_name - 1]) });
  }
  var out = [], dup = 0, tail = 0, orphan = 0, unmatched = 0;

  for (var a = 0; a < studs.length; a++) {
    for (var b = a + 1; b < studs.length; b++) {
      var nowM = _phonesMatch(studs[a].phone, studs[b].phone);
      var oldM = _phonesMatchLegacy(studs[a].phone, studs[b].phone);
      if (nowM) { dup++; out.push("DUPLICATE ACCOUNT: rows " + studs[a].row + " (" + studs[a].name + ") and " + studs[b].row + " (" + studs[b].name + ") — " + studs[a].phone + " / " + studs[b].phone); }
      else if (oldM) { tail++; out.push("SHARED TAIL ONLY: rows " + studs[a].row + " (" + studs[a].name + ") and " + studs[b].row + " (" + studs[b].name + ") — " + studs[a].phone + " / " + studs[b].phone + " (now kept apart)"); }
    }
  }

  var ids = {};
  _sheetValuesAsObjects(_quizResultsSheet()).forEach(function (r) { if (r.student_id) ids[String(r.student_id)] = "QuizResults"; });
  _sheetValuesAsObjects(_submissionsSheet()).forEach(function (r) { if (r.student_id) ids[String(r.student_id)] = (ids[String(r.student_id)] ? ids[String(r.student_id)] + "+" : "") + "Submissions"; });
  Object.keys(ids).forEach(function (id) {
    var before = studs.filter(function (s) { return _phonesMatchLegacy(s.phone, id); });
    var after = studs.filter(function (s) { return _phonesMatch(s.phone, id); });
    if (before.length && !after.length) { orphan++; out.push("WOULD BECOME ORPHANED: student_id " + id + " (" + ids[id] + ") matched " + before[0].name + " (row " + before[0].row + ") before, matches nobody now"); }
    else if (!before.length && !after.length) { unmatched++; }
  });

  Logger.log("findPhoneCollisions: " + studs.length + " students | " + dup + " duplicate account(s) | " + tail +
    " shared-tail pair(s) | " + orphan + " would-be orphan id(s) | " + unmatched + " id(s) with no student at all (already orphaned)\n" +
    (out.length ? out.join("\n") : "Nothing to fix — the new rule is safe for your data."));
}

// ---- Weekly backup ----------------------------------------------------------
// weeklyBackup() copies the Students spreadsheet (and the separate quiz-data
// spreadsheet, if DATA_SHEET_ID is set) into one Drive folder and keeps the
// newest BACKUP_KEEP copies of each. installWeeklyBackupTrigger() schedules it.
var BACKUP_KEEP = 4;

function _backupFolder() {
  var id = _props().getProperty("BACKUPS_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* folder was deleted — make a new one */ }
  }
  var folder = DriveApp.createFolder("Teaching / Backups (automatic)");
  _props().setProperty("BACKUPS_FOLDER_ID", folder.getId());
  return folder;
}

function weeklyBackup() {
  var folder = _backupFolder();
  var stamp = _fmt(new Date(), TZ, false);
  var sources = [["Students", _props().getProperty("STUDENTS_SHEET_ID")], ["Quiz data", _props().getProperty("DATA_SHEET_ID")]];
  sources.forEach(function (s) {
    if (!s[1]) return;
    var prefix = "Weekly backup - " + s[0] + " - ";
    DriveApp.getFileById(s[1]).makeCopy(prefix + stamp, folder);
    _pruneBackups(folder, prefix, BACKUP_KEEP);
  });
  Logger.log("weeklyBackup: done (" + stamp + ")");
}

// Trashes all but the newest `keep` files whose name starts with `prefix` —
// only files THIS function makes (by name), never anything else in the folder.
function _pruneBackups(folder, prefix, keep) {
  var files = [], it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getName().indexOf(prefix) === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
  files.slice(keep).forEach(function (f) { f.setTrashed(true); });
}

function installWeeklyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "weeklyBackup") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("weeklyBackup").timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  Logger.log("Weekly backup scheduled: Sundays around 03:00 (script time zone). Keeps the last " + BACKUP_KEEP + " copies.");
}

// ============================================================================
// ===== MERGED FROM Phase2_Core.gs =====
// ============================================================================

// Phase 2 core helpers (owned by Session 5). Paste into Apps Script as its own file.
// Contract: docs/contract.md. Only declarations here - nothing runs at load time.

// Router hook: doPost's Phase 2 `case` lines call this with the handler's name.
function _p2Call(handlerName, payload) {
  var fn = (typeof globalThis !== "undefined" ? globalThis : this)[handlerName];
  if (typeof fn !== "function") {
    return { ok: false, error: "Not implemented yet: " + handlerName.replace(/^p2_/, ""), not_implemented: true };
  }
  return fn(payload);
}

// Like _p2Call, but when the Phase 2 handler is not pasted yet the OLD handler answers, so an
// action that worked before Phase 2 (the two follow-up actions) never regresses to "not implemented".
function _p2CallOr(handlerName, fallback, payload) {
  var fn = (typeof globalThis !== "undefined" ? globalThis : this)[handlerName];
  return typeof fn === "function" ? fn(payload) : fallback(payload);
}

// Feature flags are Script Properties (FF_CAMERA, FF_DEFERRED_ANSWERS, FF_GRADING,
// FF_PARENT_LOG, FF_MONTHLY). "1" or "true" means on; anything else, or missing, is off.
function p2_flag(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  return v === "1" || String(v).toLowerCase() === "true";
}

// Throws a marked error when the flag is off. The router turns it into
// {ok:false, error:"Feature disabled: FF_X", disabled:true}.
function p2_requireFlag(name) {
  if (!p2_flag(name)) {
    var e = new Error("Feature disabled: " + name);
    e.disabled = true;
    throw e;
  }
}

var P2_AUDIT_HEADERS = ["at", "who", "action", "target", "before", "after"];

// Appends one audit row. Never throws (a logging problem must not fail the real action).
function p2_audit(who, action, target, before, after) {
  try {
    var ss = _dataSs();
    var sh = ss.getSheetByName("AuditLog");
    if (!sh) {
      sh = ss.insertSheet("AuditLog");
      sh.appendRow(P2_AUDIT_HEADERS);
    }
    var s = function (v) { return v === undefined || v === null ? "" : (typeof v === "string" ? v : JSON.stringify(v)); };
    sh.appendRow([_cairoIso(new Date()), s(who), s(action), s(target), s(before), s(after)]);
    return true;
  } catch (err) {
    return false;
  }
}

// Optional S3 hooks around two existing actions: when Phase2_Capture.gs is not pasted they are no-ops.
function _p2Pre(name, payload) { var f = (typeof globalThis !== "undefined" ? globalThis : this)[name]; return typeof f === "function" ? f(payload) : payload; }
function _p2Post(name, resp, payload) { var f = (typeof globalThis !== "undefined" ? globalThis : this)[name]; return typeof f === "function" ? f(resp, payload) : resp; }


// Audit coverage (R-022): every access-changing admin action leaves one AuditLog row (contract section 8).
// Wraps the response only: never changes it, never throws. Failed actions (ok:false) are not logged.
function _p2AuditWrap(action, payload, resp) {
  try {
    if (resp && resp.ok !== false) {
      var p = payload || {};
      var target = p.phone || p.student || p.group || p.lesson || p.scope || "";
      var detail = { scope: p.scope || p.lesson || p.slot || "", group: p.group || "", never: p.never === true, expires: p.expires_at || p.expires || "", locked: p.locked };
      p2_audit(p.student_id && !p.token ? p.student_id : "token", action, target, "", detail);
    }
  } catch (e) { /* logging must never fail the action */ }
  return resp;
}


// ============================================================================
// ===== MERGED FROM Phase2_Keys.gs =====
// ============================================================================

/**
 * Phase2_Keys.gs  (S1)  — paste into Apps Script as its own file, next to Code.gs.
 *
 * admin_migrate_lesson_keys
 *   Rewrites old/typo'd lesson keys (see LESSON_ALIASES in Code.gs) to the current ones in the
 *   access tabs. DRY RUN BY DEFAULT: nothing changes unless the request has  apply: true.
 *   Safe to run twice (second run finds nothing). QuizResults / Submissions are never touched:
 *   they keep their history under the old bare slug and are matched through the alias map.
 *
 *   Before changing a tab it copies it to "bak_<Tab>_<yyyymmdd>_<n>".
 *   A Lessons / Videos / Quizzes row whose current key already has a row is NOT renamed (that
 *   would create a duplicate); it is listed under "conflicts" for you to resolve by hand.
 *
 *   Request:  { action: "admin_migrate_lesson_keys", token | session, apply?: true }
 *   Reply:    { ok, dry_run, changes: [{tab, column, row, from, to}], conflicts: [...],
 *               tabs_changed: [...], backups: [...] }
 */

var MIGRATE_TARGETS = [
  { tab: "Entitlements", column: "scope" },
  { tab: "QuizAccess", column: "lesson" },
  { tab: "Attendance", column: "lesson" },
  { tab: "WatchProgress", column: "lesson" },
  { tab: "Lessons", column: "lesson", unique: true },
  { tab: "Videos", column: "lesson", unique: true, alsoKey: "slot" },
  { tab: "Quizzes", column: "lesson", unique: true },
  { tab: "GroupSettings", column: "current_lesson" },
  { tab: "GroupSettings", column: "review_lessons", json: true },
  { tab: "GroupSettings", column: "hw_lessons", json: true },
  { tab: "GroupSettings", column: "quiz_lessons", json: true }
];

function handleAdminMigrateLessonKeys(payload) {
  _requireAdminAny(payload);
  var apply = payload.apply === true;
  return _withLock(function () {
    var ss = _ss();
    var changes = [], conflicts = [], plans = {};   // plans[tab] = [{col, row, to}]

    MIGRATE_TARGETS.forEach(function (t) {
      var sheet = ss.getSheetByName(t.tab);
      if (!sheet || sheet.getLastRow() < 2) return;
      var idx = _headerIndex(sheet);
      if (!idx[t.column]) return;
      var n = sheet.getLastRow() - 1;
      var col = sheet.getRange(2, idx[t.column], n, 1).getValues().map(function (r) { return r[0]; });
      var keyCol = t.alsoKey && idx[t.alsoKey]
        ? sheet.getRange(2, idx[t.alsoKey], n, 1).getValues().map(function (r) { return String(r[0]).trim().toLowerCase(); })
        : null;

      // rows already holding a current key (for the duplicate check)
      var have = {};
      if (t.unique) col.forEach(function (v, i) {
        have[String(v).trim().toLowerCase() + "|" + (keyCol ? keyCol[i] : "")] = true;
      });

      col.forEach(function (raw, i) {
        var from = String(raw == null ? "" : raw), to;
        if (t.json) {
          var arr; try { arr = JSON.parse(from || "[]"); } catch (e) { return; }
          if (!Array.isArray(arr)) return;
          var seen = {}, out = [], moved = false;
          arr.forEach(function (x) {
            var c = _canonKey(String(x).trim().toLowerCase());
            if (c !== String(x).trim().toLowerCase()) moved = true;
            if (!seen[c]) { seen[c] = 1; out.push(c); }
          });
          if (!moved) return;
          to = JSON.stringify(out);
        } else {
          var low = from.trim().toLowerCase();
          to = _canonKey(low);
          if (to === low) return;
          if (t.unique && have[to + "|" + (keyCol ? keyCol[i] : "")]) {
            conflicts.push({ tab: t.tab, column: t.column, row: i + 2, from: from, to: to,
                             why: "a row for the current key already exists" });
            return;
          }
        }
        changes.push({ tab: t.tab, column: t.column, row: i + 2, from: from, to: to });
        (plans[t.tab] = plans[t.tab] || []).push({ col: idx[t.column], row: i + 2, to: to });
      });
    });

    var backups = [], tabsChanged = Object.keys(plans);
    if (apply && tabsChanged.length) {
      var stamp = _todayCairo().replace(/-/g, "") + "_" + (Date.now() % 100000);
      tabsChanged.forEach(function (tab) {
        var src = ss.getSheetByName(tab);
        var bak = ss.insertSheet("bak_" + tab + "_" + stamp);
        var vals = src.getDataRange().getValues();
        bak.getRange(1, 1, vals.length, vals[0].length).setValues(vals);
        backups.push(bak.getName());
      });
      tabsChanged.forEach(function (tab) {
        var sheet = ss.getSheetByName(tab);
        plans[tab].forEach(function (p) { sheet.getRange(p.row, p.col).setValue(p.to); });
      });
    }
    return { ok: true, dry_run: !apply, changes: changes, conflicts: conflicts,
             tabs_changed: apply ? tabsChanged : [], backups: backups };
  });
}


// =====================================================================================
// Integration glue (S5, Oct 21): the contract surface from docs/contract.md section 2 and 4.
// S1 built the resolver inside Code.gs (_canonKey / LESSON_ALIASES). The contract wants it here
// too, with no load-order dependence, so this is a literal MIRROR of that map. tests R-001b and
// test_keys.js fail if the three copies (this, Code.gs, assets/lesson-aliases.json) differ.
// =====================================================================================
var P2_LESSON_ALIASES = {
  "programming/baccalaureate/grade-2-secondary/lesson-1-development-of-information-technology-and-social-transformation": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-1-development-of-information-technology-and-social-transformation",
  "programming/baccalaureate/grade-2-secondary/lesson-2-how-ai-works": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works",
  "programming/baccalaureate/grade-2-secondary/chaper-1-lesson-3-ai-in-daily-life-and-industry": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry",
  "lesson-1-development-of-information-technology-and-social-transformation": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-1-development-of-information-technology-and-social-transformation",
  "lesson-2-how-ai-works": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works",
  "chaper-1-lesson-3-ai-in-daily-life-and-industry": "programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry"
};

// Canonical full key for a full key or bare slug in the alias map; anything else comes back unchanged.
function p2k_canon(key) {
  var s = key == null ? "" : String(key);
  return Object.prototype.hasOwnProperty.call(P2_LESSON_ALIASES, s) ? P2_LESSON_ALIASES[s] : s;
}
// Every spelling that means this lesson, canonical first.
function p2k_aliases(key) {
  var c = p2k_canon(key), out = [c];
  Object.keys(P2_LESSON_ALIASES).forEach(function (a) { if (P2_LESSON_ALIASES[a] === c && out.indexOf(a) === -1) out.push(a); });
  return out;
}
function p2k_same(a, b) { return p2k_canon(a) === p2k_canon(b); }

// Contract wrapper: {dry_run?:true} (default true; dry_run:false applies). S1's native {apply:true} still works.
// Adds the contract field names next to S1's, and writes one AuditLog row per applied run.
function p2_admin_migrate_lesson_keys(payload) {
  payload = payload || {};
  var apply = payload.dry_run === false || payload.apply === true;
  var res = handleAdminMigrateLessonKeys(Object.assign({}, payload, { apply: apply }));
  (res.changes || []).forEach(function (c) { c.field = c.column; c.before = c.from; c.after = c.to; });
  res.backup_tab = (res.backups && res.backups[0]) || "";
  if (apply && res.changes && res.changes.length) {
    p2_audit(payload.student_id || "token", "migrate_lesson_keys", { tabs: res.tabs_changed },
             { changes: res.changes.length }, { backups: res.backups });
  }
  return res;
}


// ============================================================================
// ===== MERGED FROM Phase2_Capture.gs =====
// ============================================================================
// Phase2_Capture.gs  (Session 3: student capture + deferred answers)
//
// Paste into the same Apps Script project as Code.gs (File > New > Script).
// Does NOT edit Code.gs. Needs four lines in doPost's router (S5 owns that),
// see handoff/S3-to-S5.md:
//
//   case "get_quiz":            return _json(p2c_decorate_quiz(handleGetQuiz(payload), payload));
//   case "upload_quiz_result":  return _json(handleUploadQuizResult(p2c_prepare_quiz_payload(payload)));
//   case "upload_written_image":return _json(p2_upload_written_image(payload));
//   case "get_quiz_review":     return _json(p2_get_quiz_review(payload));
//
// Flags (Script Properties, default OFF; "1"/"true"/"on"):
//   FF_DEFERRED_ANSWERS  quiz answers are NOT sent to the browser; the server grades.
//   FF_CAMERA            "written" questions (photo of handwritten work). Quizzes
//                        need FF_DEFERRED_ANSWERS too (the server binds photos to
//                        the attempt); homework only needs FF_CAMERA.
// Optional property WRITTEN_FOLDER_ID (Drive folder for photos); falls back to
// SUBMISSIONS_FOLDER_ID.
//
// WrittenAnswers tab (in _dataSs(), created on first upload). One row per
// (submission_id, question_id). submission_id = the attempt's client_id.
//   submission_id, student_id, lesson, question_id, drive_file_id (comma list),
//   awarded, max, note, graded_at, image_ids (comma list), uploaded_at
// S4 owns awarded/max/note/graded_at; this file never writes them. Layout: _gAnswersSheet().
// ============================================================================

var P2_C_MAX_IMAGES = 3;
var P2_C_MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;   // client sends ~1600px JPEG, normally 200-600 KB
var P2_C_UPLOADS_PER_HOUR = 60;                  // per student

function _p2cWrittenSheet() { return _gAnswersSheet(); }   // S4 owns the tab layout (Phase2_Grading.gs)

// Stable id for a question: its own "id" if it has one, else its position.
function _p2cQid(q, i) {
  if (q && q.id !== undefined && q.id !== null && q.id !== "") return String(q.id);
  if (q && q.qid !== undefined && q.qid !== null && q.qid !== "") return String(q.qid);   // written questions carry qid, not id
  return String(i);
}

function _p2cMaxMarks(q) {
  var m = Number(q && q.max_marks);
  return isFinite(m) && m >= 1 ? Math.min(100, Math.floor(m)) : 1;
}

// ---- get_quiz: tag / strip ------------------------------------------------

// What a student's browser may see while FF_DEFERRED_ANSWERS is on: prompts and
// choices only. Never correct answers, explanations, model answers.
function _p2cStripQuestion(q, i) {
  var out = { _i: i, qid: _p2cQid(q, i) };
  var type = q.type || "";
  if (q.chapter !== undefined) out.chapter = q.chapter;
  if (!type) {                                   // legacy: {q, options, correct:int}
    out.type = "mcq"; out.prompt = q.q; out.options = q.options || []; out.multi = false;
  } else if (type === "truefalse") {
    out.type = "truefalse"; out.prompt = q.prompt; out.options = ["True", "False"]; out.multi = false;
  } else if (type === "match") {
    out.type = "match"; out.prompt = q.prompt; out.options = q.options || [];
    out.rows = (q.rows || []).map(function (r) { return { label: r.label }; });
  } else if (type === "written") {
    out.type = "written"; out.prompt = q.prompt; out.max_marks = _p2cMaxMarks(q);
    out.max_images = P2_C_MAX_IMAGES;
  } else {                                       // mcq
    out.type = "mcq"; out.prompt = q.prompt; out.options = q.options || [];
    out.multi = Array.isArray(q.correct) && q.correct.length > 1;
  }
  return out;
}

function p2c_decorate_quiz(resp, payload) {
  var deferred = p2_flag("FF_DEFERRED_ANSWERS");
  var camera = deferred && p2_flag("FF_CAMERA");
  resp.features = { deferred: deferred, camera: camera };
  if (!resp || resp.locked || !resp.quiz || !Array.isArray(resp.quiz.questions)) return resp;
  var served = [];
  resp.quiz.questions.forEach(function (q, i) {
    if (q && q.type === "written" && !camera) return;      // can't be answered without the camera path
    if (deferred) served.push(_p2cStripQuestion(q, i));
    else { var c = Object.assign({}, q); c._i = i; c.qid = _p2cQid(q, i); served.push(c); }
  });
  resp.quiz.questions = served;
  resp.quiz.deferred = deferred;
  return resp;
}

// ---- upload_quiz_result: server-side grading -------------------------------

function _p2cIntIn(v, n) { return typeof v === "number" && v === Math.floor(v) && v >= 0 && v < n; }

// Grades ONE question from the student's raw answer. Returns the same entry
// shape quiz.js always posted (question/type/your_answer/correct_answer/
// is_correct/chapter) plus explain + qid so the review page can show them.
function _p2cGradeOne(q, i, v, imageCount) {
  var type = q.type || "";
  var e = { i: i, qid: _p2cQid(q, i), question: type ? q.prompt : q.q, type: type || "mcq",
            chapter: q.chapter !== undefined ? q.chapter : null, explain: q.explain || "" };
  var opts = q.options || [];
  if (type === "written") {
    e.type = "written"; e.max = _p2cMaxMarks(q); e.correct_answer = "";
    e.your_answer = imageCount ? "[" + imageCount + " photo" + (imageCount > 1 ? "s" : "") + "]" : "";
    e.is_correct = false; e.pending = imageCount > 0; e.image_count = imageCount;
    return e;
  }
  if (type === "match") {
    var rows = q.rows || [], got = Array.isArray(v) ? v : [], ok = rows.length > 0, yours = [], right = [];
    rows.forEach(function (row, k) {
      var c = typeof got[k] === "string" ? got[k] : "";
      if (opts.indexOf(c) === -1) c = "";
      if (c !== row.correct) ok = false;
      yours.push(row.label + ": " + c); right.push(row.label + ": " + row.correct);
    });
    e.your_answer = yours.join("; "); e.correct_answer = right.join("; "); e.is_correct = ok;
    return e;
  }
  var correctIdx, optList;
  if (!type) { correctIdx = [q.correct]; optList = opts; }
  else if (type === "truefalse") { correctIdx = [q.correct ? 0 : 1]; optList = ["True", "False"]; }
  else { correctIdx = Array.isArray(q.correct) ? q.correct : [q.correct]; optList = opts; }
  var chosen = (Array.isArray(v) ? v : [v]).filter(function (x) { return _p2cIntIn(x, optList.length); });
  chosen = chosen.filter(function (x, k) { return chosen.indexOf(x) === k; }).sort();
  var want = correctIdx.slice().sort();
  e.is_correct = chosen.length > 0 && chosen.length === want.length && chosen.every(function (x, k) { return x === want[k]; });
  e.your_answer = chosen.map(function (x) { return optList[x]; }).join(", ");
  e.correct_answer = want.map(function (x) { return optList[x]; }).join(", ");
  return e;
}

// Pure: quiz content + the student's raw answers -> record fields.
function _p2cGradeQuiz(quiz, answers, imageCounts) {
  var byI = {};
  (answers || []).forEach(function (a) { if (a && typeof a.i === "number") byI[a.i] = a.v; });
  var entries = [], score = 0, total = 0;
  quiz.questions.forEach(function (q, i) {
    var e = _p2cGradeOne(q, i, byI[i], (imageCounts && imageCounts[_p2cQid(q, i)]) || 0);
    if (e.type === "written") { if (!e.pending) total += e.max; }
    else { total += 1; if (e.is_correct) score += 1; }
    entries.push(e);
  });
  return { score: score, total: total, questions: entries };
}

function _p2cImageCounts(studentId, attemptId) {
  var counts = {};
  var sheet = _peekSheet("WrittenAnswers");
  if (!sheet || sheet.getLastRow() < 2) return counts;
  var c = _headerIndex(sheet);
  if (!c.submission_id || !c.student_id || !c.question_id || !c.image_ids) return counts;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  values.forEach(function (row) {
    if (String(row[c.submission_id - 1]) !== "c:" + attemptId) return;
    if (!_phonesMatch(row[c.student_id - 1], studentId)) return;
    var n = String(row[c.image_ids - 1]).split(",").filter(function (s) { return s; }).length;
    counts[String(row[c.question_id - 1])] = n;
  });
  return counts;
}

function p2c_prepare_quiz_payload(payload) {
  if (!p2_flag("FF_DEFERRED_ANSWERS")) return payload;
  if (!payload || !payload.student_id) return payload;          // handler gives its usual error
  var lesson = _lessonPath(payload.lesson_path || payload.lesson);
  var json = _lookupQuizContent(lesson);
  if (!json) return payload;                                    // never synced: the client-graded legacy path
  var quiz;
  try { quiz = JSON.parse(json); } catch (e) { return payload; }
  if (!quiz || !Array.isArray(quiz.questions)) return payload;
  // A synced quiz is ALWAYS graded here while the flag is on. A client that
  // posts its own score (stale cached page, or someone calling the API directly)
  // is refused instead of being trusted.
  if (!Array.isArray(payload.answers) || !payload.client_id) {
    throw new Error("This page is out of date \u2014 please refresh it and submit again.");
  }
  var graded = _p2cGradeQuiz(quiz, payload.answers, _p2cImageCounts(payload.student_id, String(payload.client_id)));
  var out = Object.assign({}, payload);
  out.score = graded.score;
  out.total = graded.total;
  out.questions = graded.questions;
  out.wrong_questions = graded.questions.filter(function (q) { return !q.is_correct && !q.pending; })
    .map(function (q) { return { question: q.question, your_answer: q.your_answer, correct_answer: q.correct_answer }; });
  delete out.answers;
  return out;
}

// ---- upload_written_image ---------------------------------------------------

function _p2cImageKind(bytes) {
  function b(i) { return bytes[i] & 0xFF; }
  if (bytes.length > 3 && b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return "jpg";
  if (bytes.length > 8 && b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return "png";
  if (bytes.length > 12 && b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
      b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return "webp";
  return null;
}

function _p2cFindWrittenRow(sheet, attemptId, studentId, qid) {
  if (sheet.getLastRow() < 2) return null;
  var c = _headerIndex(sheet);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][c.submission_id - 1]) === "c:" + attemptId && String(values[i][c.question_id - 1]) === qid &&
        _phonesMatch(values[i][c.student_id - 1], studentId)) {
      return { row: i + 2, cols: c,
               files: String(values[i][c.drive_file_id - 1]).split(",").filter(String),
               ids: String(values[i][c.image_ids - 1]).split(",").filter(String) };
    }
  }
  return null;
}

// Phase 3 / S2: the student page now posts the answers FIRST and the photos afterwards, so a written answer can
// arrive with no photo at submit time (stored as a non-pending "wrong" entry whose max is already in the total).
// When its photo lands later, flip it to pending and take its max back out of the total, exactly the state a
// submit-with-photo would have produced. Never touches a graded entry. Best effort: a failure here must not
// fail the upload (the review still shows the photo as pending via has_photo).
function _p2cLatePhotoFlip(student, attempt, qid) {
  try {
    _withLock(function () {
      var sheet = _quizResultsSheet();
      if (!sheet || sheet.getLastRow() < 2) return;
      var c = _headerIndex(sheet);
      if (!c.dedupe_key || !c.student_id || !c.questions_json || !c.total) return;
      var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
      for (var i = values.length - 1; i >= 0; i--) {
        if (String(values[i][c.dedupe_key - 1]) !== "c:" + attempt || !_phonesMatch(values[i][c.student_id - 1], student)) continue;
        var arr = _p2cParse(String(values[i][c.questions_json - 1])), hit = false, give = 0;
        if (!Array.isArray(arr)) return;
        arr.forEach(function (q) {
          if (q && q.type === "written" && String(q.qid) === String(qid) && !q.pending && q.awarded === undefined) {
            give = Number(q.max) || 0; q.pending = true; q.image_count = 1; q.your_answer = "[1 photo]"; hit = true;
          }
        });
        if (!hit) return;
        sheet.getRange(i + 2, c.questions_json).setValue(JSON.stringify(arr));
        sheet.getRange(i + 2, c.total).setValue(Math.max(0, (Number(values[i][c.total - 1]) || 0) - give));
        return;
      }
    }, UPLOAD_LOCK_WAIT_MS);
  } catch (e) { /* best effort */ }
}

function p2_upload_written_image(payload) {
  p2_requireFlag("FF_CAMERA");
  _requireStudentSession(payload);
  var student = _normalizePhone(payload.student_id);
  var attempt = String(payload.attempt_id || ""), imageId = String(payload.image_id || "");
  var qid = String(payload.question_id == null ? "" : payload.question_id);
  var kind = payload.kind === "assignment" ? "assignment" : "quiz";
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(attempt)) throw new Error("Missing or invalid attempt_id.");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(imageId)) throw new Error("Missing or invalid image_id.");
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(qid)) throw new Error("Missing or invalid question_id.");
  var lesson = _lessonPath(payload.lesson_path || payload.lesson);

  if (kind === "quiz") {
    p2_requireFlag("FF_DEFERRED_ANSWERS");
    if (_quizLockedForStudent(lesson, student)) throw new Error("This quiz is locked.");
    var json = _lookupQuizContent(lesson), quiz = null;
    try { quiz = json ? JSON.parse(json) : null; } catch (e) { quiz = null; }
    var ok = false;
    if (quiz && Array.isArray(quiz.questions)) {
      quiz.questions.forEach(function (q, i) { if (q && q.type === "written" && _p2cQid(q, i) === qid) ok = true; });
    }
    if (!ok) throw new Error("That question doesn't take a photo answer.");
  }

  // Rate limit (per student, per hour) - stops a loop or a shared phone from filling Drive.
  var cache = CacheService.getScriptCache(), rk = "p2up:" + _md5(student);
  var used = parseInt(cache.get(rk) || "0", 10) || 0;
  if (used >= P2_C_UPLOADS_PER_HOUR) throw new Error("Too many photos in a short time. Please wait a while and try again.");

  var bytes;
  try { bytes = Utilities.base64Decode(String(payload.data_base64 || "")); } catch (e) { throw new Error("The photo could not be read."); }
  if (!bytes || !bytes.length) throw new Error("The photo is empty.");
  if (bytes.length > P2_C_MAX_IMAGE_BYTES) throw new Error("The photo is too large. Retake it a little further away.");
  var ext = _p2cImageKind(bytes);
  if (!ext) throw new Error("Only JPEG, PNG or WebP photos are accepted.");

  // Resend of an upload that already landed: no new file.
  var peeked = _peekSheet("WrittenAnswers");
  if (peeked) {
    var hit = _p2cFindWrittenRow(peeked, attempt, student, qid);
    if (hit && hit.ids.indexOf(imageId) !== -1) return { ok: true, duplicate: true, image_id: imageId, count: hit.ids.length };
  }

  var folder = _folder(_props().getProperty("WRITTEN_FOLDER_ID") ? "WRITTEN_FOLDER_ID" : "SUBMISSIONS_FOLDER_ID");
  var name = "written--" + _safeName(lesson.split("/").pop()) + "--" + _safeName(student) + "--" +
             attempt.slice(0, 8) + "--q" + _safeName(qid) + "--" + imageId.slice(0, 8) + "." + ext;
  var mime = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp";
  var made = [];
  try {
    made.push(folder.createFile(Utilities.newBlob(bytes, mime, name)));
    var result = _withLock(function () {
      var sheet = _p2cWrittenSheet();
      var found = _p2cFindWrittenRow(sheet, attempt, student, qid);
      var now = _fmt(new Date(), TZ, true);
      if (found) {
        if (found.ids.indexOf(imageId) !== -1) return { ok: true, duplicate: true, image_id: imageId, count: found.ids.length };
        if (found.ids.length >= P2_C_MAX_IMAGES) throw new Error("You can attach up to " + P2_C_MAX_IMAGES + " photos to one answer.");
        found.ids.push(imageId); found.files.push(made[0].getId());
        sheet.getRange(found.row, found.cols.image_ids).setNumberFormat("@").setValue(found.ids.join(","));
        sheet.getRange(found.row, found.cols.drive_file_id).setNumberFormat("@").setValue(found.files.join(","));
        sheet.getRange(found.row, found.cols.uploaded_at).setNumberFormat("@").setValue(now);
        return { ok: true, image_id: imageId, count: found.ids.length };
      }
      _appendByHeader(sheet, { submission_id: "c:" + attempt, kind: kind === "assignment" ? "homework" : "quiz", student_id: student, lesson: lesson, question_id: qid,
        drive_file_id: made[0].getId(), image_ids: imageId, uploaded_at: now });
      return { ok: true, image_id: imageId, count: 1 };
    }, UPLOAD_LOCK_WAIT_MS);
    if (result.duplicate) _trashQuietly(made);
    else { cache.put(rk, String(used + 1), 3600); if (kind === "quiz") _p2cLatePhotoFlip(student, attempt, qid); }
    return result;
  } catch (err) {
    _trashQuietly(made);
    throw err;
  }
}

// ---- get_quiz_review ---------------------------------------------------------

function _p2cParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// Bare-slug spellings a QuizResults row for this lesson may carry. If Session 1's
// alias resolver is loaded (p2AliasSlugs), old spellings are included too.
function _p2cSlugCandidates(lessonPath) {
  var out = [lessonPath.split("/").pop()];
  if (typeof p2k_aliases === "function") {
    try { (p2k_aliases(lessonPath) || []).forEach(function (k) { var s = String(k).split("/").pop(); if (out.indexOf(s) === -1) out.push(s); }); } catch (e) { /* optional */ }
  }
  return out;
}

// The student's own latest attempt, with answers. Nothing is returned until
// they have submitted: with no matching row the answer is an error with no data.
function p2_get_quiz_review(payload) {
  p2_requireFlag("FF_DEFERRED_ANSWERS");
  _requireStudentSession(payload);
  var student = _normalizePhone(payload.student_id);
  var lesson = _lessonPath(payload.lesson_path || payload.lesson);
  var attempt = payload.client_id ? String(payload.client_id) : "";
  var slugs = _p2cSlugCandidates(lesson);

  var sheet = _quizResultsSheet();
  if (sheet.getLastRow() < 2) throw new Error("Submit the quiz first to see the answers.");
  var c = _headerIndex(sheet);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var row = null;
  for (var i = values.length - 1; i >= 0; i--) {
    var r = values[i];
    if (!_phonesMatch(r[c.student_id - 1], student)) continue;
    if (attempt) { if (String(r[c.dedupe_key - 1]) !== "c:" + attempt) continue; }
    else if (slugs.indexOf(String(r[c.lesson - 1])) === -1) continue;
    row = r; break;
  }
  if (!row) throw new Error("Submit the quiz first to see the answers.");

  var attemptId = String(row[c.dedupe_key - 1]).replace(/^c:/, "");
  var written = {};
  var wsheet = _peekSheet("WrittenAnswers");
  if (wsheet && wsheet.getLastRow() >= 2) {
    var wc = _headerIndex(wsheet);
    wsheet.getRange(2, 1, wsheet.getLastRow() - 1, wsheet.getLastColumn()).getValues().forEach(function (w) {
      if (String(w[wc.submission_id - 1]) !== "c:" + attemptId || !_phonesMatch(w[wc.student_id - 1], student)) return;
      written[String(w[wc.question_id - 1])] = {
        awarded: w[wc.awarded - 1], max: w[wc.max - 1], note: String(w[wc.note - 1] || ""),
        graded: String(w[wc.graded_at - 1] || "") !== "",
        has_photo: wc.image_ids ? String(w[wc.image_ids - 1] || "") !== "" : false   // Phase 3: a photo that arrived AFTER the submit
      };
    });
  }

  var entries = _p2cParse(String(row[c.questions_json - 1])) || [];
  var items = entries.map(function (q, k) {
    var it = { i: q.i !== undefined ? q.i : k, question: q.question, type: q.type || "mcq", chapter: q.chapter === undefined ? null : q.chapter,
               your_answer: q.your_answer, correct_answer: q.correct_answer, explain: q.explain || "" };
    if (q.type === "written") {
      var w = written[String(q.qid)];
      it.max = w && w.max !== "" && w.max != null ? Number(w.max) : (q.max || 1);
      it.correct_answer = "";
      if (w && w.graded) { it.status = "graded"; it.awarded = Number(w.awarded) || 0; it.note = w.note; it.is_correct = it.awarded >= it.max; }
      else if (q.pending || (w && w.has_photo)) { it.status = "pending"; it.is_correct = null; }   // Phase 3: late photos (S2 posts answers first) still count as awaiting grading
      else { it.status = "wrong"; it.is_correct = false; }
    } else {
      it.is_correct = !!q.is_correct; it.status = q.is_correct ? "correct" : "wrong";
    }
    return it;
  });
  return { ok: true, review: { lesson: lesson, quiz_title: String(row[c.quiz_title - 1] || ""), client_id: attemptId,
           score: Number(row[c.score - 1]), total: Number(row[c.total - 1]), items: items,
           pending: items.filter(function (x) { return x.status === "pending"; }).length } };
}

// ===== MERGED FROM Phase2_Grading.gs =====
// ============================================================================

// =====================================================================================
// Phase2_Grading.gs  (Session 4: grading mode)
//
// Owned by S4. Lives next to Code.gs in the same Apps Script project (globals are shared).
// Nothing here is routed until S5 adds the four `case` lines listed in handoff/S4-to-S5.md.
//
// Actions:
//   admin_set_written_models  Quiz Maker -> server: model answer + max marks per written question
//   admin_get_written_models  server -> Quiz Maker: read them back so editing a lesson keeps them
//   admin_grading_queue       filtered list of written answers (pending / graded / all)
//   admin_grade_written       set marks + note for one written answer (idempotent regrade)
//   get_written_image         photo bytes (base64), ONLY for an admin or the owning student
//
// Why model answers are in their own tab: the public get_quiz action returns the quiz JSON
// (with correct answers) to every student, so a model answer inside it would leak.
// "WrittenModels" is only ever read by the admin actions in this file.
//
// Tabs (created on first use, headers added without touching existing rows):
//   WrittenModels  lesson | question_id | max_marks | model_answer | prompt | updated_at
//   WrittenAnswers submission_id | student_id | lesson | question_id | drive_file_id |
//                  awarded | max | note | graded_at   (+ kind | graded_by added by this file)
//     S3 creates the rows at submit time; awarded is blank until graded.
//     submission_id = the attempt's dedupe_key (QuizResults for kind "quiz", Submissions for
//     kind "homework"); blank kind means "quiz".
//
// Score rule: QuizResults.score/total as submitted by the page cover the AUTO-graded questions
// only. Grading stores that once in base_score/base_total, then always sets
//   score = base_score + sum(awarded of graded written answers)
//   total = base_total + sum(max     of graded written answers)
// so grading the same answer twice, or regrading, always lands on the same number.
// =====================================================================================

var WM_HEADERS = ["lesson", "question_id", "max_marks", "model_answer", "prompt", "updated_at"];
var WA_HEADERS = ["submission_id", "student_id", "lesson", "question_id", "drive_file_id",
                  "awarded", "max", "note", "graded_at"];
var WA_EXTRA_HEADERS = ["kind", "graded_by", "uploaded_at", "image_ids"];
var GRADING_QUEUE_LIMIT = 500;
var GRADING_MAX_MODEL_CHARS = 5000;

function _gCanon(l) { var s = String(l == null ? "" : l).trim().toLowerCase(); return typeof p2k_canon === "function" ? p2k_canon(s) : s; }
function _gKind(v) { return String(v || "").trim().toLowerCase() === "homework" ? "homework" : "quiz"; }

function _gModelsSheet() {
  var sh = _sheetByName(_ss(), "WrittenModels", WM_HEADERS);
  _ensureColumns(sh, WM_HEADERS);
  return sh;
}

function _gAnswersSheet() {
  var sh = _sheetByName(_dataSs(), "WrittenAnswers", WA_HEADERS);
  _ensureColumns(sh, WA_HEADERS.concat(WA_EXTRA_HEADERS));
  return sh;
}

function _gNum(v) {
  if (v === "" || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

// ---- admin_set_written_models ---------------------------------------------------------
// payload: {lesson, models: [{question_id, max_marks, model_answer, prompt}]}
// Upsert by (lesson, question_id). Never deletes: a question removed from the quiz simply
// stops being referenced, and old grades keep their max.
function handleAdminSetWrittenModels(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson);
  var models = payload.models;
  if (!Array.isArray(models)) throw new Error("models must be a list.");
  var clean = models.map(function (m) {
    var qid = String(m && m.question_id != null ? m.question_id : "").trim();
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(qid)) throw new Error("Invalid question_id.");
    var max = _gNum(m.max_marks);
    if (max === null || max <= 0 || max > 100) throw new Error("max_marks must be between 0 and 100.");
    var ans = String(m.model_answer == null ? "" : m.model_answer);
    if (ans.length > GRADING_MAX_MODEL_CHARS) throw new Error("Model answer is too long.");
    return { question_id: qid, max_marks: max, model_answer: ans, prompt: String(m.prompt == null ? "" : m.prompt).slice(0, 2000) };
  });
  return _withLock(function () {
    var sh = _gModelsSheet();
    var c = _needCols(sh, "WrittenModels", WM_HEADERS);
    var existing = {};
    if (sh.getLastRow() >= 2) {
      sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r, i) {
        existing[_gCanon(r[c.lesson - 1]) + "|" + String(r[c.question_id - 1]).trim()] = i + 2;
      });
    }
    var now = _fmt(new Date(), TZ, true), added = 0, updated = 0;
    clean.forEach(function (m) {
      var row = existing[lesson + "|" + m.question_id];
      if (row) {
        sh.getRange(row, c.max_marks).setValue(m.max_marks);
        sh.getRange(row, c.model_answer).setValue(m.model_answer);
        sh.getRange(row, c.prompt).setValue(m.prompt);
        sh.getRange(row, c.updated_at).setNumberFormat("@").setValue(now);
        updated++;
      } else {
        _appendByHeader(sh, { lesson: lesson, question_id: m.question_id, max_marks: m.max_marks,
                              model_answer: m.model_answer, prompt: m.prompt, updated_at: now });
        existing[lesson + "|" + m.question_id] = sh.getLastRow();
        added++;
      }
    });
    return { ok: true, lesson: lesson, added: added, updated: updated };
  });
}

// ---- admin_get_written_models ---------------------------------------------------------
function handleAdminGetWrittenModels(payload) {
  _requireAdminAny(payload);
  var lesson = _lessonPath(payload.lesson), out = [];
  var sh = _ss().getSheetByName("WrittenModels");
  if (sh && sh.getLastRow() >= 2) {
    _sheetValuesAsObjects(sh).forEach(function (r) {
      if (_gCanon(r.lesson) === lesson) out.push({ question_id: String(r.question_id), max_marks: _gNum(r.max_marks), model_answer: String(r.model_answer || ""), prompt: String(r.prompt || "") });
    });
  }
  return { ok: true, lesson: lesson, models: out };
}

function _gModelMap() {
  var sh = _ss().getSheetByName("WrittenModels");
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  _sheetValuesAsObjects(sh).forEach(function (r) {
    out[_gCanon(r.lesson) + "|" + String(r.question_id).trim()] = {
      max: _gNum(r.max_marks), model_answer: String(r.model_answer || ""), prompt: String(r.prompt || "") };
  });
  return out;
}

// ---- admin_grading_queue --------------------------------------------------------------
// payload filters (all optional): year "Senior 1"|"Senior 2", group, lesson, student (a phone),
// status "pending" (default) | "graded" | "all".
function handleAdminGradingQueue(payload) {
  _requireAdminAny(payload);
  var status = String(payload.status || "pending").toLowerCase();
  if (["pending", "graded", "all"].indexOf(status) === -1) throw new Error("Unknown status.");
  var lessonF = payload.lesson ? _gCanon(payload.lesson) : "";
  var yearF = String(payload.year || "").trim();
  var studentF = payload.student ? _normalizePhone(payload.student) : "";   // NOT student_id: with a session, student_id is the ADMIN (adminCall overwrites it)

  var allowed = null;                      // set of phone keys when filtering by group
  if (payload.group) {
    allowed = {};
    var gk = _groupKey(String(payload.group));
    _groupMembers(_ss().getSheetByName("Groups"), gk, null).forEach(function (m) { allowed[_phoneKey(m.phone)] = true; });
  }

  var people = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) {
    var k = _phoneKey(r.phone);
    if (k && !people.hasOwnProperty(k)) people[k] = { name: String(r.display_name || ""), year: String(r.year || "") };
  });

  var models = _gModelMap();
  var sh = _dataSs().getSheetByName("WrittenAnswers");
  var items = [], pending = 0, graded = 0;
  if (sh && sh.getLastRow() >= 2) {
    _sheetValuesAsObjects(sh).forEach(function (r) {
      if (!r.submission_id || !r.question_id) return;
      var pk = _phoneKey(r.student_id), p = people[pk] || { name: "", year: "" };
      var lesson = _gCanon(r.lesson);
      if (lessonF && lesson !== lessonF) return;
      if (yearF && p.year !== yearF) return;
      if (studentF && !_phonesMatch(r.student_id, studentF)) return;
      if (allowed && !allowed[pk]) return;
      var awarded = _gNum(r.awarded);
      var isGraded = awarded !== null;
      if (isGraded) graded++; else pending++;
      if (status === "pending" && isGraded) return;
      if (status === "graded" && !isGraded) return;
      var m = models[lesson + "|" + String(r.question_id).trim()] || {};
      items.push({
        submission_id: String(r.submission_id), kind: _gKind(r.kind),
        student_id: String(r.student_id), name: p.name, year: p.year,
        lesson: lesson, question_id: String(r.question_id),
        prompt: m.prompt || "", model_answer: m.model_answer || "",
        max: m.max != null ? m.max : _gNum(r.max),
        awarded: awarded, note: String(r.note || ""), graded_at: String(r.graded_at || ""),
        has_image: !!String(r.drive_file_id || "").trim(),
        image_count: String(r.drive_file_id || "").split(",").filter(String).length
      });
    });
  }
  items.sort(function (a, b) {
    return a.lesson < b.lesson ? -1 : a.lesson > b.lesson ? 1 :
      a.name < b.name ? -1 : a.name > b.name ? 1 :
      a.submission_id < b.submission_id ? -1 : a.submission_id > b.submission_id ? 1 :
      a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0;
  });
  var truncated = items.length > GRADING_QUEUE_LIMIT;
  return { ok: true, items: items.slice(0, GRADING_QUEUE_LIMIT), truncated: truncated,
           counts: { pending: pending, graded: graded } };
}

// ---- admin_grade_written --------------------------------------------------------------
// payload: {submission_id, question_id, awarded, note?, student?}   (student = the answer's owner, only to disambiguate)
function handleAdminGradeWritten(payload) {
  _requireAdminAny(payload);
  var sid = String(payload.submission_id || "").trim();
  var qid = String(payload.question_id || "").trim();
  if (!sid || !qid) throw new Error("Missing submission_id or question_id.");
  var awarded = _gNum(payload.awarded);
  if (awarded === null || awarded < 0) throw new Error("Marks must be a number, 0 or more.");
  awarded = Math.round(awarded * 100) / 100;
  var note = String(payload.note == null ? "" : payload.note).slice(0, 1000);

  return _withLock(function () {
    var sh = _gAnswersSheet();
    var c = _needCols(sh, "WrittenAnswers", WA_HEADERS.concat(WA_EXTRA_HEADERS));
    var values = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : [];
    var rowIdx = -1;
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][c.submission_id - 1]).trim() === sid && String(values[i][c.question_id - 1]).trim() === qid &&
          (!payload.student || _phonesMatch(values[i][c.student_id - 1], payload.student))) { rowIdx = i; break; }
    }
    if (rowIdx < 0) throw new Error("Written answer not found.");
    var row = values[rowIdx], r = rowIdx + 2;
    var lesson = _gCanon(row[c.lesson - 1]);
    var kind = _gKind(row[c.kind - 1]);
    var model = _gModelMap()[lesson + "|" + qid];
    var max = model && model.max != null ? model.max : _gNum(row[c.max - 1]);
    if (max === null) throw new Error("No max marks set for this question. Sync the quiz from Quiz Maker first.");
    if (awarded > max) throw new Error("Marks can't be more than " + max + ".");

    var before = { awarded: _gNum(row[c.awarded - 1]), note: String(row[c.note - 1] || "") };
    var now = _fmt(new Date(), TZ, true);
    sh.getRange(r, c.awarded).setValue(awarded);
    sh.getRange(r, c.max).setValue(max);
    sh.getRange(r, c.note).setValue(note);
    sh.getRange(r, c.graded_at).setNumberFormat("@").setValue(now);
    sh.getRange(r, c.graded_by).setValue("admin");

    var totals = _gRecomputeAttempt(sh, c, sid, kind);
    _gAudit("grade_written", { submission_id: sid, question_id: qid }, before, { awarded: awarded, note: note });
    return { ok: true, submission_id: sid, question_id: qid, awarded: awarded, max: max, attempt: totals };
  });
}

// Recompute one attempt's score from base + graded written answers. Idempotent.
function _gRecomputeAttempt(waSheet, wc, sid, kind) {
  var sumA = 0, sumM = 0, n = 0, perQ = {};
  if (waSheet.getLastRow() >= 2) {
    waSheet.getRange(2, 1, waSheet.getLastRow() - 1, waSheet.getLastColumn()).getValues().forEach(function (r) {
      if (String(r[wc.submission_id - 1]).trim() !== sid || _gKind(r[wc.kind - 1]) !== kind) return;
      var a = _gNum(r[wc.awarded - 1]), m = _gNum(r[wc.max - 1]);
      if (a === null || m === null) return;
      sumA += a; sumM += m; n++;
      perQ[String(r[wc.question_id - 1]).trim()] = { awarded: a, max: m, note: String(r[wc.note - 1] || "") };
    });
  }
  var sheet, jsonCol;
  if (kind === "homework") { sheet = _submissionsSheet(); jsonCol = "answers_json"; }
  else { sheet = _quizResultsSheet(); jsonCol = "questions_json"; }
  _ensureColumns(sheet, ["base_score", "base_total", "written_awarded", "written_max"]);
  var c = _needCols(sheet, kind === "homework" ? "Submissions" : "QuizResults", ["dedupe_key", "score", "total", jsonCol, "base_score", "base_total", "written_awarded", "written_max"]);
  if (sheet.getLastRow() < 2) return null;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][c.dedupe_key - 1]).trim() !== sid) continue;
    var r = i + 2;
    var baseS = _gNum(vals[i][c.base_score - 1]), baseT = _gNum(vals[i][c.base_total - 1]);
    if (baseS === null) {                                   // first grading of this attempt: remember the auto part
      baseS = _gNum(vals[i][c.score - 1]) || 0; baseT = _gNum(vals[i][c.total - 1]) || 0;
      sheet.getRange(r, c.base_score).setValue(baseS);
      sheet.getRange(r, c.base_total).setValue(baseT);
    }
    sheet.getRange(r, c.score).setValue(Math.round((baseS + sumA) * 100) / 100);
    sheet.getRange(r, c.total).setValue(Math.round((baseT + sumM) * 100) / 100);
    sheet.getRange(r, c.written_awarded).setValue(sumA);
    sheet.getRange(r, c.written_max).setValue(sumM);
    // Correct/wrong list: update or append the written entries inside the stored JSON array.
    var arr;
    try { arr = JSON.parse(String(vals[i][c[jsonCol] - 1] || "[]")); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    Object.keys(perQ).forEach(function (qid) {
      var g = perQ[qid], found = false;
      arr.forEach(function (q) {
        if (q && String(q.id != null ? q.id : q.qid) === qid) {
          q.type = "written"; q.awarded = g.awarded; q.max = g.max; q.note = g.note;
          q.correct = g.awarded >= g.max; q.is_correct = q.correct; q.partial = g.awarded > 0 && g.awarded < g.max; q.pending = false; found = true;
        }
      });
      if (!found) arr.push({ id: qid, type: "written", awarded: g.awarded, max: g.max, note: g.note,
                             correct: g.awarded >= g.max, partial: g.awarded > 0 && g.awarded < g.max, pending: false });
    });
    sheet.getRange(r, c[jsonCol]).setValue(JSON.stringify(arr));
    return { score: baseS + sumA, total: baseT + sumM, graded_written: n };
  }
  return null;   // attempt row not found (written answer exists without an attempt row)
}

// ---- get_written_image ----------------------------------------------------------------
// payload: {submission_id, question_id} plus EITHER admin credentials (token, or an admin's
// student_id+session_token) OR the owning student's student_id+session_token.
function handleGetWrittenImage(payload) {
  var sid = String(payload.submission_id || "").trim(), qid = String(payload.question_id || "").trim();
  if (!sid || !qid) throw new Error("Missing submission_id or question_id.");
  var isAdmin = false;
  try { _requireAdminAny(payload); isAdmin = true; } catch (e) { isAdmin = false; }
  var sh = _dataSs().getSheetByName("WrittenAnswers");
  if (!sh || sh.getLastRow() < 2) throw new Error("Not allowed.");
  var hit = null;
  _sheetValuesAsObjects(sh).forEach(function (r) {
    if (!hit && String(r.submission_id).trim() === sid && String(r.question_id).trim() === qid) hit = r;
  });
  if (!hit) throw new Error("Not allowed.");                 // same message for "missing" and "not yours"
  if (!isAdmin) {
    _requireStudentSession(payload);
    if (!_phonesMatch(hit.student_id, payload.student_id)) throw new Error("Not allowed.");
  }
  var files = String(hit.drive_file_id || "").split(",").map(function (s) { return s.trim(); }).filter(String);
  var fid = files[Math.max(0, Math.min(files.length - 1, Math.floor(Number(payload.index) || 0)))];   // up to 3 photos per answer
  if (!fid) throw new Error("No photo for this answer.");
  var blob = DriveApp.getFileById(fid).getBlob();
  return { ok: true, content_type: blob.getContentType(), data_base64: Utilities.base64Encode(blob.getBytes()) };
}

// Best-effort audit trail. Writes through S5's p2_audit so AuditLog keeps ONE header row
// (at | who | action | target | before | after, docs/contract.md section 8).
function _gAudit(action, ref, before, after) {
  try {
    if (typeof p2_audit === "function") p2_audit("admin", action, ref, before, after);
  } catch (e) { /* auditing must never block grading */ }
}

// =====================================================================================
// Integration glue (S5, Oct 21): contract-named entry points the router calls (_p2Call).
// Grading and the queue sit behind FF_GRADING. Authoring (models) and the image fetch do not:
// the Quiz Maker must be able to save model answers before the feature is switched on, and an
// image row only exists once capture (FF_CAMERA) has been on.
// =====================================================================================
function p2_admin_grading_queue(payload) {
  p2_requireFlag("FF_GRADING");
  var res = handleAdminGradingQueue(payload || {});
  (res.items || []).forEach(function (it) { it.student = it.student_id; });   // contract field name
  return res;
}
function p2_admin_grade_written(payload) {
  p2_requireFlag("FF_GRADING");
  return handleAdminGradeWritten(payload || {});
}
function p2_admin_set_written_models(payload) { return handleAdminSetWrittenModels(payload || {}); }
function p2_admin_get_written_models(payload) { return handleAdminGetWrittenModels(payload || {}); }
function p2_get_written_image(payload) { return handleGetWrittenImage(payload || {}); }


// ============================================================================
// ===== MERGED FROM Phase2_Followup.gs =====
// ============================================================================

/* ==========================================================================
   Phase2_Followup.gs — Session 2 (follow-up, student summary, parent log, monthly review)

   Loaded next to Code.gs (Apps Script shares one global scope across .gs files), so this file
   uses Code.gs helpers (_ss, _dataSs, _requireAdminAny, _withLock, _sheetByName, _appendByHeader,
   _needCols, _phoneKey, _lessonPath, _cairoDate, _fmt, TZ ...). Every name defined HERE starts
   with _p2fu / P2_FU_ or is one of the action handlers fixed by the contract (rollout-plan-v2 §3.3),
   so it cannot collide with Code.gs or with the other Phase2_*.gs files.

   Nothing here is routed yet: Session 5 owns the doPost router. The case lines to add are in
   handoff/S2-to-S5.md. Handlers:

     p2_admin_set_requirement             admin_set_requirement
     p2_admin_log_parent_notification      admin_log_parent_notification        (FF_PARENT_LOG)
     p2_admin_list_parent_notifications    admin_list_parent_notifications      (FF_PARENT_LOG)
     p2_admin_student_summary             admin_student_summary
     p2_admin_monthly_review              admin_monthly_review                 (FF_MONTHLY)
   Wrappers that REPLACE two existing router cases (same action names, extra fields):
     p2_admin_followup_overview         admin_followup_overview
     p2_admin_followup_set_attendance    admin_followup_set_attendance

   Sheets (created on first use): LessonRequirements, ParentNotifications, MonthlyReviews, AuditLog.
   Reads WrittenAnswers (Session 4's tab) when it exists.
   ========================================================================== */

var P2_FU_REQ_HEADERS = ["lesson", "quiz_required", "homework_required", "due_override", "updated_at"];
var P2_FU_NOTIF_HEADERS = ["student", "kind", "ref", "sent_at", "by", "note"];
var P2_FU_MONTHLY_HEADERS = ["student", "month", "status", "sent_at", "note"];
var FU2_REQ_SNAPSHOT_COL_ = "requirements_json";   // FU2: MonthlyReviews column added with _ensureColumns (same name as FU2_REQ_SNAPSHOT_COL in FollowupRouter.gs)
var P2_FU_AUDIT_HEADERS = ["who", "when", "action", "before", "after"];
var P2_FU_KINDS = { quiz: 1, homework: 1, monthly: 1, custom: 1 };
var P2_FU_MONTH_STATUS = { pending: 1, ready: 1, sent: 1, closed: 1 };
var P2_FU_MAX_BATCH = 60;

// Contract §3.1 alias map (full-path and bare-slug form). Used only when Session 1 has not published
// its own resolver as a global function _resolveLessonKey(raw) (see handoff/S2-to-S1.md).
var P2_FU_G2 = "programming/baccalaureate/grade-2-secondary/";
var P2_FU_ALIAS_FALLBACK = (function () {
  var m = {};
  var pairs = [
    ["lesson-1-development-of-information-technology-and-social-transformation", "chapter-1-lesson-1-development-of-information-technology-and-social-transformation"],
    ["lesson-2-how-ai-works", "chapter-1-lesson-2-how-ai-works"],
    ["chaper-1-lesson-3-ai-in-daily-life-and-industry", "chapter-1-lesson-3-ai-in-daily-life-and-industry"]
  ];
  pairs.forEach(function (p) { m[P2_FU_G2 + p[0]] = P2_FU_G2 + p[1]; m[p[0]] = p[1]; });
  return m;
})();

// ---- small helpers -------------------------------------------------------------------------
function _p2fuClean(raw) { return String(raw == null ? "" : raw).trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, ""); }
function _p2fuCanon(raw) {
  var s = _p2fuClean(raw);
  if (typeof p2k_canon === "function") { try { var k = p2k_canon(s); if (k) return _p2fuClean(k); } catch (e) {} }
  if (typeof _resolveLessonKey === "function") { try { var r = _resolveLessonKey(s); if (r) return _p2fuClean(r); } catch (e) {} }
  return P2_FU_ALIAS_FALLBACK.hasOwnProperty(s) ? P2_FU_ALIAS_FALLBACK[s] : s;
}
function _p2fuSlug(raw) { var s = _p2fuCanon(raw); return s.indexOf("/") < 0 ? s : s.slice(s.lastIndexOf("/") + 1); }
function _p2fuNorm(h) { return String(h == null ? "" : h).trim().toLowerCase().replace(/[\s-]+/g, "_"); }
function _p2fuRows(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var vals = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var hd = vals[0].map(_p2fuNorm), out = [];
  for (var i = 1; i < vals.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < hd.length; j++) if (hd[j]) o[hd[j]] = vals[i][j];
    out.push(o);
  }
  return out;
}
function _p2fuFlag(name) { return p2_flag(name); }
function _p2fuNeedFlag(name) { p2_requireFlag(name); }
function _p2fuWho(payload) { return payload.token ? "token" : String(payload.student_id || ""); }
function _p2fuNow() { return _fmt(new Date(), TZ, true); }
function _p2fuToday() { return _fmt(new Date(), TZ, false); }
function _p2fuYmd(y, m, d) { return y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d; }
function _p2fuAddDays(ymd, n) {
  var p = ymd.split("-").map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return _p2fuYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function _p2fuDow(ymd) { var p = ymd.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
// Weeks run Saturday -> Friday (contract §3.4).
function _p2fuWeek(ymd) {
  var back = (_p2fuDow(ymd) + 1) % 7, start = _p2fuAddDays(ymd, -back);
  return { start: start, end: _p2fuAddDays(start, 6) };
}
function _p2fuMonthRange(month) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(month || "").trim());
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error('month must look like "2026-10".');
  var y = +m[1], mo = +m[2], last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: _p2fuYmd(y, mo, 1), to: _p2fuYmd(y, mo, last), month: m[1] + "-" + m[2] };
}
function _p2fuCheckYmd(v, label) {
  var s = String(v == null ? "" : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(label + " must look like 2026-12-31.");
  return s;
}
function _p2fuBool(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

function _p2fuAudit(ss, payload, action, before, after, target) {
  // One shared AuditLog (p2_audit, contract section 8). Never breaks the action it records.
  try { p2_audit(_p2fuWho(payload), action, target || "", before, after); } catch (e) { /* ignore */ }
}

// ---- LessonRequirements -------------------------------------------------------------------
// lesson -> {quiz_required, homework_required, due_override}. A lesson with no row: both required.
function _p2fuRequirements(ss) {
  var out = {};
  var sh = ss.getSheetByName("LessonRequirements");
  _p2fuRows(sh).forEach(function (r) {
    var k = _p2fuCanon(r.lesson);
    if (!k || out.hasOwnProperty(k)) return;
    out[k] = { lesson: k, quiz_required: _p2fuBool(r.quiz_required, true), homework_required: _p2fuBool(r.homework_required, true),
               due_override: String(r.due_override == null ? "" : r.due_override).trim() };
  });
  return out;
}
function _p2fuReq(map, lesson) {
  var r = map[_p2fuCanon(lesson)];
  return r || { quiz_required: true, homework_required: true, due_override: "" };
}

function p2_admin_set_requirement(payload) {
  _requireAdminAny(payload);
  var lesson = _p2fuCanon(_lessonPath(payload.lesson));
  var due = payload.due_override === undefined ? undefined : String(payload.due_override == null ? "" : payload.due_override).trim();
  if (due !== undefined && due !== "") due = _p2fuCheckYmd(due, "due_override");
  return _withLock(function () {
    var ss = _ss();
    var sh = _followupSheet(ss, "LessonRequirements", P2_FU_REQ_HEADERS);
    _ensureColumns(sh, P2_FU_REQ_HEADERS);
    var c = _needCols(sh, "LessonRequirements", P2_FU_REQ_HEADERS);
    var existing = null;
    _p2fuRows(sh).forEach(function (r) { if (!existing && _p2fuCanon(r.lesson) === lesson) existing = r; });
    var before = existing ? { quiz_required: _p2fuBool(existing.quiz_required, true), homework_required: _p2fuBool(existing.homework_required, true), due_override: String(existing.due_override || "") } : null;
    var rec = {
      quiz_required: _p2fuBool(payload.quiz_required, before ? before.quiz_required : true),
      homework_required: _p2fuBool(payload.homework_required, before ? before.homework_required : true),
      due_override: due === undefined ? (before ? before.due_override : "") : due
    };
    var now = _p2fuNow();
    if (existing) {
      sh.getRange(existing._row, c.quiz_required).setValue(rec.quiz_required);
      sh.getRange(existing._row, c.homework_required).setValue(rec.homework_required);
      sh.getRange(existing._row, c.due_override).setNumberFormat("@").setValue(rec.due_override);
      sh.getRange(existing._row, c.updated_at).setNumberFormat("@").setValue(now);
    } else {
      _appendByHeader(sh, { lesson: lesson, quiz_required: rec.quiz_required, homework_required: rec.homework_required, due_override: rec.due_override, updated_at: now });
    }
    _p2fuAudit(ss, payload, "set_requirement", before, Object.assign({ lesson: lesson }, rec));
    return { ok: true, requirement: Object.assign({ lesson: lesson }, rec) };
  });
}

// ---- ParentNotifications ------------------------------------------------------------------
function _p2fuNotifOut(r) {
  return { student: String(r.student == null ? "" : r.student), kind: String(r.kind || ""), ref: String(r.ref == null ? "" : r.ref),
           sent_at: String(r.sent_at == null ? "" : r.sent_at), by: String(r.by || ""), note: String(r.note == null ? "" : r.note) };
}
function _p2fuNotifications(ss) {
  return _p2fuRows(ss.getSheetByName("ParentNotifications")).map(function (r) { var o = _p2fuNotifOut(r); o._row = r._row; return o; });
}

// Create or edit: one entry per (student, kind, ref). A repeat call with the same triple edits it.
function p2_admin_log_parent_notification(payload) {
  _requireAdminAny(payload);
  _p2fuNeedFlag("FF_PARENT_LOG");
  var digits = _normalizePhone(payload.student);
  if (digits.length < 10) throw new Error("Missing student phone.");
  var key = _phoneKey(digits);
  var kind = String(payload.kind == null ? "" : payload.kind).trim().toLowerCase();
  if (!P2_FU_KINDS.hasOwnProperty(kind)) throw new Error('kind must be "quiz", "homework", "monthly" or "custom".');
  var note = String(payload.note == null ? "" : payload.note).slice(0, 500);
  var ref = String(payload.ref == null ? "" : payload.ref).trim().toLowerCase();
  if (ref.length > 200) throw new Error("ref is too long.");
  // A custom entry has no natural key, so each one gets its own (time + random) — two in the same second must not merge.
  if (!ref) ref = kind === "custom" ? "custom-" + _p2fuNow() + "-" + String(Utilities.getUuid()).slice(0, 6) : "";
  var sentAt = String(payload.sent_at == null ? "" : payload.sent_at).trim();
  if (sentAt && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(sentAt)) throw new Error("sent_at must look like 2026-10-21 or 2026-10-21 18:30:00.");
  return _withLock(function () {
    var ss = _ss();
    var sh = _followupSheet(ss, "ParentNotifications", P2_FU_NOTIF_HEADERS);
    _ensureColumns(sh, P2_FU_NOTIF_HEADERS);
    var c = _needCols(sh, "ParentNotifications", P2_FU_NOTIF_HEADERS);
    var hit = null;
    _p2fuRows(sh).forEach(function (r) {
      if (!hit && _phoneKey(r.student) === key && String(r.kind).trim().toLowerCase() === kind && String(r.ref == null ? "" : r.ref).trim().toLowerCase() === ref) hit = r;
    });
    var when = sentAt || _p2fuNow();
    if (hit) {
      if (sentAt || payload.sent_at === undefined) sh.getRange(hit._row, c.sent_at).setNumberFormat("@").setValue(sentAt || String(hit.sent_at));
      sh.getRange(hit._row, c.by).setValue(_p2fuWho(payload));
      if (payload.note !== undefined) sh.getRange(hit._row, c.note).setNumberFormat("@").setValue(note);
      var edited = _p2fuNotifOut(_p2fuRows(sh).filter(function (r) { return r._row === hit._row; })[0]);
      return { ok: true, created: false, notification: edited };
    }
    var rec = { student: _canonicalPhone(digits) || digits, kind: kind, ref: ref, sent_at: when, by: _p2fuWho(payload), note: note };
    _appendByHeader(sh, rec);
    return { ok: true, created: true, notification: rec };
  });
}

// Filters: student, kind, ref, from/to (sent_at date). not_notified_students: [phones] -> the subset with
// NO entry for (kind, ref) — the page's «لم يُبلَّغ بعد» filter.
function p2_admin_list_parent_notifications(payload) {
  _requireAdminAny(payload);
  _p2fuNeedFlag("FF_PARENT_LOG");
  var ss = _ss(), rows = _p2fuNotifications(ss);
  var key = payload.student ? _phoneKey(_normalizePhone(payload.student)) : "";
  var kind = String(payload.kind || "").trim().toLowerCase(), ref = String(payload.ref || "").trim().toLowerCase();
  var from = payload.from ? _p2fuCheckYmd(payload.from, "from") : "", to = payload.to ? _p2fuCheckYmd(payload.to, "to") : "";
  var list = rows.filter(function (r) {
    if (key && _phoneKey(r.student) !== key) return false;
    if (kind && r.kind !== kind) return false;
    if (ref && r.ref.toLowerCase() !== ref) return false;
    var d = r.sent_at.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
  list.sort(function (a, b) { return a.sent_at < b.sent_at ? 1 : (a.sent_at > b.sent_at ? -1 : b._row - a._row); });
  var limit = Math.min(Math.max(parseInt(payload.limit, 10) || 500, 1), 2000);
  var out = { ok: true, notifications: list.slice(0, limit).map(function (r) { var o = Object.assign({}, r); delete o._row; return o; }) };
  if (Array.isArray(payload.not_notified_students)) {
    var have = {};
    rows.forEach(function (r) { if ((!kind || r.kind === kind) && (!ref || r.ref.toLowerCase() === ref)) have[_phoneKey(r.student)] = true; });
    out.not_notified = payload.not_notified_students.filter(function (p) { return !have[_phoneKey(_normalizePhone(p))]; });
  }
  return out;
}

// ---- schedule helpers (the same rules as followup-logic.js, needed to decide "past due" on the server) ----
function _p2fuNextSessionYmd(today, hm, weekday, time) {
  if (weekday === null || weekday === undefined || weekday === "") return "";
  for (var i = 0; i < 8; i++) {
    var d = _p2fuAddDays(today, i);
    if (_p2fuDow(d) !== +weekday) continue;
    if (i === 0 && time && String(time) <= hm) continue;       // today's session already started
    return d;
  }
  return "";
}
function _p2fuHwDue(settings, today, hm, cfg) {
  var o = String(settings.hw_deadline_override || "").trim();
  if (o) return o;
  var next = _p2fuNextSessionYmd(today, hm, settings.weekday, settings.time);
  return next ? _p2fuAddDays(next, -(+cfg.hw_days_before || 1)) : "";
}

// ---- Student summary ----------------------------------------------------------------------
// Everything is loaded once into `X`, so a batch (monthly review of a group) costs one pass over the sheets.
function _p2fuLoad(ss, dataSs) {
  var X = { ss: ss, today: _p2fuToday(), hm: _fmt(new Date(), TZ, true).slice(11, 16) };
  X.cfg = _followupSettings();
  X.students = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) {
    var k = _phoneKey(r.phone);
    if (!k || X.students.hasOwnProperty(k)) return;
    X.students[k] = { phone: _restoreLeadingZero(String(r.phone == null ? "" : r.phone).trim()), name: String(r.display_name == null ? "" : r.display_name).trim(),
                      year: String(r.year == null ? "" : r.year).trim(), parent_phone: _restoreLeadingZero(String(r.parent_phone == null ? "" : r.parent_phone).trim()),
                      admin: _isTruthyFlag(r.is_admin) };
  });
  // groups + settings
  var gSheet = ss.getSheetByName("Groups"), spellings = _groupSpellings(gSheet), byKey = {};
  (gSheet && gSheet.getLastRow() >= 2 ? _sheetValuesAsObjects(gSheet) : []).forEach(function (m) {
    var gk = _groupKey(m.group), pk = _phoneKey(m.phone);
    if (!gk || !pk) return;
    var g = byKey[gk] = byKey[gk] || { group: spellings[gk] || String(m.group), key: gk, members: [], seen: {} };
    if (g.seen[pk]) return; g.seen[pk] = true; g.members.push(pk);
    if (!X.students.hasOwnProperty(pk)) X.students[pk] = { phone: _restoreLeadingZero(String(m.phone).trim()), name: String(m.name == null ? "" : m.name).trim(), year: "", parent_phone: "", admin: false };
  });
  var gs = ss.getSheetByName("GroupSettings"), settingsByKey = {};
  (gs && gs.getLastRow() >= 2 ? _sheetValuesAsObjects(gs) : []).forEach(function (r) {
    var k = _groupKey(r.group_key || r.group); if (k && !settingsByKey.hasOwnProperty(k)) settingsByKey[k] = _groupSettingsFromRow(r);
  });
  X.groups = Object.keys(byKey).map(function (k) { return { group: byKey[k].group, key: k, members: byKey[k].members, settings: settingsByKey[k] || _emptyGroupSettings() }; });
  X.req = _p2fuRequirements(ss);
  X.notifs = _p2fuNotifications(ss);
  X.monthly = _p2fuRows(ss.getSheetByName("MonthlyReviews"));
  X.written = _p2fuRows(dataSs.getSheetByName("WrittenAnswers"));   // lives next to QuizResults (contract v1.5)

  // raw results (columns only, like the overview)
  X.quiz = {}; X.hw = {};      // phoneKey -> [{slug, subject, date, time, score, total, idx}]
  var qc = _readColumns(dataSs.getSheetByName("QuizResults"), ["student_id", "lesson"], ["subject", "date", "start_time", "score", "total"], "QuizResults");
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  for (var i = 0; i < qc.n; i++) {
    var qk = _phoneKey(qc.col.student_id[i]); if (!qk) continue;
    (X.quiz[qk] = X.quiz[qk] || []).push({ slug: _p2fuSlug(qc.col.lesson[i]), subject: String(qc.col.subject[i] || "").trim().toLowerCase(),
      date: _cairoDate(qc.col.date[i]), time: String(_cairoTime(qc.col.start_time[i]) || ""), score: num(qc.col.score[i]), total: num(qc.col.total[i]), idx: i });
  }
  var sc = _readColumns(dataSs.getSheetByName("Submissions"), ["student_id", "lesson"], ["subject", "date", "score", "total"], "Submissions");
  for (i = 0; i < sc.n; i++) {
    var sk = _phoneKey(sc.col.student_id[i]); if (!sk) continue;
    (X.hw[sk] = X.hw[sk] || []).push({ slug: _p2fuSlug(sc.col.lesson[i]), subject: String(sc.col.subject[i] || "").trim().toLowerCase(),
      date: _cairoDate(sc.col.date[i]), score: num(sc.col.score[i]), total: num(sc.col.total[i]), idx: i });
  }
  // attendance + watch
  X.att = {}; X.watch = {};
  _p2fuRows(ss.getSheetByName("Attendance")).forEach(function (r) {
    var k = _phoneKey(r.phone), m = String(r.mode || "").trim().toLowerCase(); if (!k || (m !== "center" && m !== "online")) return;
    (X.att[k] = X.att[k] || []).push({ lesson: _p2fuCanon(r.lesson), mode: m, date: String(r.marked_at || "").slice(0, 10) });
  });
  _p2fuRows(ss.getSheetByName("WatchProgress")).forEach(function (r) {
    var k = _phoneKey(r.phone), p = parseFloat(r.pct); if (!k || !isFinite(p)) return;
    (X.watch[k] = X.watch[k] || []).push({ lesson: _p2fuCanon(r.lesson), pct: p, date: String(r.updated_at || "").slice(0, 10) });
  });
  // lesson-path lookup for bare slugs (soft-fails when GitHub is down)
  X.pathBySlug = {};
  try {
    _allLessonsFromGithub().lessons.forEach(function (l) {
      var kk = _firstSegment(l.lesson) + "|" + _p2fuSlug(l.lesson);
      (X.pathBySlug[kk] = X.pathBySlug[kk] || []).push(_p2fuCanon(l.lesson));
    });
  } catch (e) { X.lessonsError = String(e.message || e); }
  X.locks = _lockIndex(ss); X.ent = _entitlementIndex(ss); X.statuses = _paymentStatuses(ss);
  return X;
}
function _p2fuPathOf(X, subject, slug) {
  var arr = X.pathBySlug[subject + "|" + slug];
  return arr && arr.length === 1 ? arr[0] : "";
}
function _p2fuInRange(d, from, to) { return d && d >= from && d <= to; }
function _p2fuRound(n) { return n === null ? null : Math.round(n * 100) / 100; }

function _p2fuSummaryFor(X, key, from, to) {
  var st = X.students[key];
  if (!st) throw new Error("Student not found.");
  // quizzes: every attempt in the range, grouped by lesson; the latest attempt counts (same rule as the overview)
  var qBy = {};
  (X.quiz[key] || []).forEach(function (r) {
    if (!_p2fuInRange(r.date, from, to)) return;
    var k = r.subject + "|" + r.slug; (qBy[k] = qBy[k] || []).push(r);
  });
  var quizzes = Object.keys(qBy).sort().map(function (k) {
    var rows = qBy[k], last = rows[0];
    rows.forEach(function (r) { if ((r.date + " " + r.time) > (last.date + " " + last.time) || ((r.date + " " + r.time) === (last.date + " " + last.time) && r.idx > last.idx)) last = r; });
    var pct = last.total ? last.score / last.total * 100 : null;
    return { lesson: last.slug, subject: last.subject, path: _p2fuPathOf(X, last.subject, last.slug), date: last.date, score: last.score, total: last.total,
             pct: _p2fuRound(pct), attempts: rows.length };
  });
  var pcts = quizzes.filter(function (q) { return q.pct !== null; }).map(function (q) { return q.pct; });
  var quizAvg = pcts.length ? _p2fuRound(pcts.reduce(function (a, b) { return a + b; }, 0) / pcts.length) : null;

  var hBy = {};
  (X.hw[key] || []).forEach(function (r) {
    if (!_p2fuInRange(r.date, from, to)) return;
    var k = r.subject + "|" + r.slug; (hBy[k] = hBy[k] || []).push(r);
  });
  var homework = Object.keys(hBy).sort().map(function (k) {
    var rows = hBy[k], last = rows[0];
    rows.forEach(function (r) { if (r.date > last.date || (r.date === last.date && r.idx > last.idx)) last = r; });
    return { lesson: last.slug, subject: last.subject, path: _p2fuPathOf(X, last.subject, last.slug), date: last.date, score: last.score, total: last.total, submissions: rows.length };
  });

  // required items that are missing: only lessons the student is EXPECTED to have done
  // = the homework & quiz lessons of the student's groups + any lesson with a due date up to `to`.
  var expected = {};
  X.groups.forEach(function (g) {
    if (g.members.indexOf(key) < 0) return;
    var due = _p2fuHwDue(g.settings, X.today, X.hm, X.cfg);
    // Oct 22: homework and quiz lessons are chosen separately (null = follows review_lessons).
    var rv = g.settings.review_lessons || [], hwL = g.settings.hw_lessons || rv, qzL = g.settings.quiz_lessons || rv;
    hwL.concat(qzL).forEach(function (l) {
      var c = _p2fuCanon(l); if (!c) return;
      var e = expected[c] = expected[c] || { lesson: c, group_due: "", hw: false, quiz: false };
      if (due && (!e.group_due || due < e.group_due)) e.group_due = due;
    });
    hwL.forEach(function (l) { var c = _p2fuCanon(l); if (c && expected[c]) expected[c].hw = true; });
    qzL.forEach(function (l) { var c = _p2fuCanon(l); if (c && expected[c]) expected[c].quiz = true; });
  });
  Object.keys(X.req).forEach(function (l) {
    var r = X.req[l]; if (r.due_override && r.due_override <= to && !expected[l]) expected[l] = { lesson: l, group_due: "", hw: true, quiz: true };
  });
  function everDone(rowsByKey, subject, slug) { return !!(rowsByKey || []).some(function (r) { return r.slug === slug && (r.subject === "" || r.subject === subject) && (!r.date || r.date <= to); }); }
  var exp = Object.keys(expected).sort().map(function (l) {
    var rq = _p2fuReq(X.req, l), subject = _firstSegment(l), slug = _p2fuSlug(l);
    var due = rq.due_override || expected[l].group_due || "";
    var quizDone = everDone(X.quiz[key], subject, slug), hwDone = everDone(X.hw[key], subject, slug);
    var duePassed = !due || X.today > due;
    var needQ = rq.quiz_required && expected[l].quiz !== false, needH = rq.homework_required && expected[l].hw !== false;   // not in that group's list = not expected
    return { lesson: l, quiz: { required: needQ, done: quizDone, missed: needQ && !quizDone && duePassed },
             homework: { required: needH, done: hwDone, due: due, missed: needH && !hwDone && duePassed } };
  });

  // attendance, watch, video access
  var att = (X.att[key] || []).filter(function (a) { return !a.date || _p2fuInRange(a.date, from, to); });
  var watch = (X.watch[key] || []).filter(function (w) { return !w.date || _p2fuInRange(w.date, from, to); });
  var watchBest = {};
  watch.forEach(function (w) { if (!watchBest.hasOwnProperty(w.lesson) || w.pct > watchBest[w.lesson]) watchBest[w.lesson] = w.pct; });
  var watchList = Object.keys(watchBest).sort().map(function (l) { return { lesson: l, pct: _p2fuRound(watchBest[l]) }; });
  var watchAvg = watchList.length ? _p2fuRound(watchList.reduce(function (a, w) { return a + w.pct; }, 0) / watchList.length) : null;
  var accessLessons = {};
  att.forEach(function (a) { accessLessons[a.lesson] = 1; });
  watchList.forEach(function (w) { accessLessons[w.lesson] = 1; });
  exp.forEach(function (e) { accessLessons[e.lesson] = 1; });
  var access = Object.keys(accessLessons).sort().map(function (l) {
    var s = _lessonLockState(X.locks, l);
    return { lesson: l, can_watch: !s.video_locked || _entitlementCovers(X.ent, X.statuses, key, l, X.ss, X.today) };
  });

  // written answers (Session 4's tab; absent => zeros)
  var w = { pending: 0, graded: 0, awarded: 0, max: 0, items: [] };
  X.written.forEach(function (r) {
    if (_phoneKey((r.student_id || r.student)) !== key) return;
    var graded = !(r.awarded === "" || r.awarded == null), aw = parseFloat(r.awarded), mx = parseFloat(r.max);
    if (graded) { w.graded++; if (isFinite(aw)) w.awarded += aw; if (isFinite(mx)) w.max += mx; } else w.pending++;
    w.items.push({ lesson: _p2fuCanon(r.lesson), question: String(r.question_id == null ? "" : r.question_id), graded: graded, awarded: graded && isFinite(aw) ? aw : null, max: isFinite(mx) ? mx : null });
  });

  var notifs = X.notifs.filter(function (n) { return _phoneKey(n.student) === key && _p2fuInRange(n.sent_at.slice(0, 10), from, to); })
    .map(function (n) { var o = Object.assign({}, n); delete o._row; return o; });
  var center = att.filter(function (a) { return a.mode === "center"; }).length;
  var totals = {
    quiz_count: quizzes.length, quiz_avg_pct: quizAvg,
    quiz_required: exp.filter(function (e) { return e.quiz.required; }).length, quiz_missed: exp.filter(function (e) { return e.quiz.missed; }).length,
    homework_count: homework.length,
    homework_required: exp.filter(function (e) { return e.homework.required; }).length, homework_missed: exp.filter(function (e) { return e.homework.missed; }).length,
    attendance_center: center, attendance_online: att.length - center, watch_avg_pct: watchAvg,
    written_pending: w.pending, written_graded: w.graded
  };
  var gOut = X.groups.filter(function (g) { return g.members.indexOf(key) >= 0; }).map(function (g) { return { group: g.group, key: g.key }; });
  var res = { student: { phone: st.phone, name: st.name, year: st.year, parent_phone: st.parent_phone }, groups: gOut, range: { from: from, to: to },
           totals: totals, quizzes: quizzes, homework: homework, expected: exp, attendance: att, watch: watchList, video_access: access, written: w, notifications: notifs };
  // FU2: summary.requirements (FollowupRouter.gs). A failure here must never break the summary itself.
  try { if (typeof fu2_core_requirements_ === "function") res.requirements = fu2_core_requirements_(X, key, res, from.slice(0, 7)); }
  catch (e) { console.error("FU2 requirements failed: " + e); }
  return res;
}

function p2_admin_student_summary(payload) {
  _requireAdminAny(payload);
  var digits = _normalizePhone(payload.student);
  if (digits.length < 10) throw new Error("Missing student phone.");
  var today = _p2fuToday();
  var from = payload.from ? _p2fuCheckYmd(payload.from, "from") : today.slice(0, 8) + "01";
  var to = payload.to ? _p2fuCheckYmd(payload.to, "to") : today;
  if (from > to) throw new Error("from must not be after to.");
  var X = _p2fuLoad(_ss(), _dataSs());
  var out = _p2fuSummaryFor(X, _phoneKey(digits), from, to);
  out.ok = true;
  if (X.lessonsError) out.lessons_error = X.lessonsError;
  return out;
}

// ---- Monthly review -----------------------------------------------------------------------
// op "get" (default): {month, student | group} -> one summary per student for that month + the review status.
// op "mark": {student, month, status, note} -> upsert MonthlyReviews (status "sent" also logs a parent notification).
function p2_admin_monthly_review(payload) {
  _requireAdminAny(payload);
  _p2fuNeedFlag("FF_MONTHLY");
  var r = _p2fuMonthRange(payload.month);
  var today = _p2fuToday(), to = r.to > today ? today : r.to;
  var op = String(payload.op || "get").trim().toLowerCase();
  if (op === "mark") return _p2fuMonthlyMark(payload, r);
  if (op !== "get") throw new Error('op must be "get" or "mark".');
  var ss = _ss(), X = _p2fuLoad(ss, _dataSs()), keys = [];
  if (payload.student) keys = [_phoneKey(_normalizePhone(payload.student))];
  else if (payload.group) {
    var gk = _groupKey(payload.group), hit = X.groups.filter(function (g) { return g.key === gk; })[0];
    if (!hit) throw new Error("Group not found.");
    keys = hit.members.slice();
  } else throw new Error("Give a student or a group.");
  if (keys.length > P2_FU_MAX_BATCH) throw new Error("Too many students in one request (max " + P2_FU_MAX_BATCH + ").");
  var out = keys.map(function (k) {
    var s = _p2fuSummaryFor(X, k, r.from, to);
    var row = X.monthly.filter(function (m) { return _phoneKey(m.student) === k && String(m.month).trim() === r.month; })[0];
    var rev = { status: row ? String(row.status || "pending") : "pending", sent_at: row ? String(row.sent_at || "") : "", note: row ? String(row.note || "") : "" };
    // FU2: a month marked sent or closed shows the requirements as they were THEN (saved when it was marked); it is never recomputed.
    if (rev.status === "sent" || rev.status === "closed") {
      var snap = typeof fu2_core_snapshotParse_ === "function" ? fu2_core_snapshotParse_(row[FU2_REQ_SNAPSHOT_COL_]) : null;
      if (snap) { s.requirements = snap; s.requirements_snapshot = true; }
      else if (typeof fu2_core_requirements_ === "function") { s.requirements = null; s.requirements_unavailable = true; }   // marked before snapshots existed
    }
    return { student: s.student, summary: s, review: rev };
  });
  return { ok: true, month: r.month, range: { from: r.from, to: to }, closed: to < r.to ? false : true, reviews: out };
}
function _p2fuMonthlyMark(payload, r) {
  var digits = _normalizePhone(payload.student);
  if (digits.length < 10) throw new Error("Missing student phone.");
  var status = String(payload.status == null ? "" : payload.status).trim().toLowerCase();
  if (!P2_FU_MONTH_STATUS.hasOwnProperty(status)) throw new Error('status must be "pending", "ready", "sent" or "closed".');
  var note = String(payload.note == null ? "" : payload.note).slice(0, 500), key = _phoneKey(digits);
  // FU2: when a month becomes sent/closed, save the requirements as they are now (outside the lock: loading the data is slow).
  // Already sent/closed with a snapshot: keep it. Back to pending/ready: clear it, the month is open again.
  var snapJson = null;   // null = leave the cell alone, "" = clear, text = write
  if (typeof fu2_core_requirements_ === "function") {
    if (status === "sent" || status === "closed") {
      var prev = null;
      _p2fuRows(_ss().getSheetByName("MonthlyReviews")).forEach(function (m) { if (!prev && _phoneKey(m.student) === key && String(m.month).trim() === r.month) prev = m; });
      var prevDone = prev && (String(prev.status) === "sent" || String(prev.status) === "closed");
      if (!(prevDone && fu2_core_snapshotParse_(prev[FU2_REQ_SNAPSHOT_COL_]))) {
        try {
          var today0 = _p2fuToday(), to0 = r.to > today0 ? today0 : r.to;
          var sum0 = _p2fuSummaryFor(_p2fuLoad(_ss(), _dataSs()), key, r.from, to0);
          if (sum0.requirements) snapJson = JSON.stringify(sum0.requirements);
        } catch (e) { console.error("FU2 snapshot failed: " + e); }
      }
    } else snapJson = "";
  }
  return _withLock(function () {
    var ss = _ss();
    var sh = _followupSheet(ss, "MonthlyReviews", P2_FU_MONTHLY_HEADERS);
    _ensureColumns(sh, P2_FU_MONTHLY_HEADERS);
    if (snapJson !== null) _ensureColumns(sh, [FU2_REQ_SNAPSHOT_COL_]);   // FU2: additive column
    var c = _needCols(sh, "MonthlyReviews", P2_FU_MONTHLY_HEADERS);
    var snapCol = snapJson !== null ? _headerIndex(sh)[FU2_REQ_SNAPSHOT_COL_] : 0;
    var hit = null;
    _p2fuRows(sh).forEach(function (m) { if (!hit && _phoneKey(m.student) === key && String(m.month).trim() === r.month) hit = m; });
    var now = _p2fuNow(), sent = status === "sent" ? now : (hit ? String(hit.sent_at || "") : "");
    if (hit) {
      sh.getRange(hit._row, c.status).setValue(status);
      sh.getRange(hit._row, c.sent_at).setNumberFormat("@").setValue(sent);
      if (payload.note !== undefined) sh.getRange(hit._row, c.note).setNumberFormat("@").setValue(note);
      if (snapCol) sh.getRange(hit._row, snapCol).setNumberFormat("@").setValue(snapJson);
    } else {
      var rec = { student: _canonicalPhone(digits) || digits, month: r.month, status: status, sent_at: sent, note: note };
      if (snapCol && snapJson) rec[FU2_REQ_SNAPSHOT_COL_] = snapJson;
      _appendByHeader(sh, rec);
    }
    if (status === "sent" && _p2fuFlag("FF_PARENT_LOG")) {
      p2_admin_log_parent_notification({ token: payload.token, student_id: payload.student_id, session_token: payload.session_token,
                                         student: digits, kind: "monthly", ref: r.month, note: note });
    }
    return { ok: true, review: { student: digits, month: r.month, status: status, sent_at: sent, note: payload.note !== undefined ? note : (hit ? String(hit.note || "") : "") } };
  });
}

// ---- admin_followup_overview, plus what Session 2 needs on the page -----------------------------
// Adds: flags, week (Sat..Fri), requirements (also merged into lessons[path].quiz_required / homework_required /
// due_override, default true), parent_log (phoneKey -> [{kind, ref, sent_at, note}], newest first).
function p2_admin_followup_overview(payload) {
  var o = handleAdminFollowupOverview(payload);     // does its own admin check
  var ss = _ss();
  o.flags = { FF_PARENT_LOG: _p2fuFlag("FF_PARENT_LOG"), FF_MONTHLY: _p2fuFlag("FF_MONTHLY") };
  o.week = _p2fuWeek(o.today);
  var req = _p2fuRequirements(ss);
  o.requirements = req;
  Object.keys(o.lessons || {}).forEach(function (p) {
    var r = _p2fuReq(req, p);
    o.lessons[p].quiz_required = r.quiz_required; o.lessons[p].homework_required = r.homework_required; o.lessons[p].due_override = r.due_override;
  });
  o.parent_log = {};
  if (o.flags.FF_PARENT_LOG) {
    var wanted = {};
    Object.keys(o.students || {}).forEach(function (k) { wanted[k] = true; });
    _p2fuNotifications(ss).sort(function (a, b) { return a.sent_at < b.sent_at ? 1 : -1; }).forEach(function (n) {
      var k = _phoneKey(n.student); if (!wanted[k]) return;
      (o.parent_log[k] = o.parent_log[k] || []).push({ kind: n.kind, ref: n.ref, sent_at: n.sent_at, note: n.note });
    });
  }
  // FU2: optional hooks from FollowupNotify.gs (done, notify, tz_label) then Requirements.gs (requirements). Each one is isolated:
  // a missing function changes nothing, a throwing one is logged and skipped.
  ["fu2_notify_overviewHook_", "req_overviewHook_"].forEach(function (name) { _fu2Hook(name, o); });
  return o;
}
// FU2: calls a global function by name if it exists; never throws.
function _fu2Hook(name, arg) {
  try {
    var g = typeof globalThis !== "undefined" ? globalThis : this;
    if (g && typeof g[name] === "function") return g[name](arg);
  } catch (e) { console.error("FU2 hook " + name + " failed: " + e); }
  return undefined;
}

// ---- admin_followup_set_attendance with the weekly center rule -------------------------------
// 1. More than one center student in a request is a "bulk center": it needs payload.week_confirm equal to this
//    week's start date (Saturday) — the page makes the teacher confirm the week explicitly.
// 2. Center rows created by this feature expire on the Friday of that week (Entitlements + QuizAccess, source
//    "attendance", only rows with an empty expires_at, so an existing end date is never changed).
// 3. Every decision is written to AuditLog (who, when, before -> after).
function p2_admin_followup_set_attendance(payload) {
  _requireAdminAny(payload);
  var items = Array.isArray(payload.items) ? payload.items : [];
  var week = _p2fuWeek(_p2fuToday());
  var centers = items.filter(function (it) { return String(it && it.mode != null ? it.mode : "").trim().toLowerCase() === "center"; });
  var grant = payload.grant !== false;
  if (grant && centers.length > 1 && String(payload.week_confirm || "") !== week.start) {
    throw new Error("Bulk center needs this week's confirmation (week_confirm = " + week.start + ", the week " + week.start + " to " + week.end + ").");
  }
  var lesson = _lessonPath(payload.lesson), ss = _ss();
  var before = {};
  _p2fuRows(ss.getSheetByName("Attendance")).forEach(function (r) {
    if (String(r.lesson || "").trim().toLowerCase() === lesson) before[_phoneKey(r.phone)] = String(r.mode || "");
  });
  var res = handleAdminFollowupSetAttendance(payload);
  var keys = {};
  centers.forEach(function (it) { keys[_phoneKey(_normalizePhone(it.phone))] = true; });
  if (grant && Object.keys(keys).length) _withLock(function () { _p2fuExpireCenterRows(ss, lesson, keys, week.end); });
  items.forEach(function (it) {
    var k = _phoneKey(_normalizePhone(it && it.phone)), mode = String(it && it.mode != null ? it.mode : "").trim().toLowerCase();
    _p2fuAudit(ss, payload, mode === "" ? "attendance_clear" : "attendance_" + mode, { lesson: lesson, phone: k, mode: before[k] || "" },
               { lesson: lesson, phone: k, mode: mode, expires_at: mode === "center" && grant ? week.end : "" });
  });
  res.week = week; res.expires_at = grant && centers.length ? week.end : "";
  return res;
}
function _p2fuExpireCenterRows(ss, lesson, keys, endYmd) {
  [["Entitlements", ENT_HEADERS, "scope"], ["QuizAccess", QUIZ_ACCESS_HEADERS, "lesson"]].forEach(function (t) {
    var sh = ss.getSheetByName(t[0]);
    if (!sh || sh.getLastRow() < 2) return;
    var c = _needCols(sh, t[0], t[1]);
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r, i) {
      if (String(r[c.source - 1]).trim() !== ATTENDANCE_SOURCE) return;
      if (String(r[c[t[2]] - 1]).trim().toLowerCase() !== lesson) return;
      if (!keys[_phoneKey(r[c.phone - 1])]) return;
      if (String(r[c.expires_at - 1]).trim() !== "") return;
      sh.getRange(i + 2, c.expires_at).setNumberFormat("@").setValue(endYmd);
    });
  });
}

// ============================================================================
// ===== MERGED FROM Phase3_Flags.gs =====
// ============================================================================

// Phase3_Flags.gs  (Session S1, Phase 3)
// Makes the Phase 2 feature switches visible and one-click fixable. Nothing here changes a flag's name or meaning
// (contract: Follow-up V3 section 2.3-1). Flags are Script Properties; "1" or "true" = on, anything else = off.
//
//   p3_setup_enable_followup_flags()   run ONCE from the Apps Script editor: turns the five flags on, logs before/after.
//   p3_flag_status()                   read-only: what each flag is right now (also logged).
//   p3_admin_flag_status(payload)      same, as an admin-only action (router line goes in HANDOFF-S1.md).
//
// FF_CAMERA note: docs/rollout-checklist.md holds it back until a low-end Android and iOS Safari test passes. Turning it on
// here is the owner's decision; the log line below repeats the reminder.

var P3_FOLLOWUP_FLAGS = ["FF_PARENT_LOG", "FF_MONTHLY", "FF_DEFERRED_ANSWERS", "FF_CAMERA", "FF_GRADING"];

function _p3FlagOn(raw) { return raw === "1" || String(raw).toLowerCase() === "true"; }

function _p3FlagSnapshot() {
  var props = PropertiesService.getScriptProperties(), out = {};
  P3_FOLLOWUP_FLAGS.forEach(function (n) {
    var raw = props.getProperty(n);
    out[n] = { raw: raw === null || raw === undefined ? null : String(raw), on: _p3FlagOn(raw) };
  });
  return out;
}

function p3_flag_status() {
  var snap = _p3FlagSnapshot();
  P3_FOLLOWUP_FLAGS.forEach(function (n) { Logger.log(n + " = " + (snap[n].raw === null ? "(not set)" : snap[n].raw) + "  ->  " + (snap[n].on ? "ON" : "OFF")); });
  return { ok: true, flags: snap };
}

function p3_admin_flag_status(payload) {
  _requireAdminAny(payload);
  return p3_flag_status();
}

function p3_setup_enable_followup_flags() {
  var before = _p3FlagSnapshot(), props = PropertiesService.getScriptProperties(), changed = [];
  P3_FOLLOWUP_FLAGS.forEach(function (n) {
    if (!before[n].on) { props.setProperty(n, "1"); changed.push(n); }
  });
  var after = _p3FlagSnapshot();
  Logger.log("BEFORE: " + JSON.stringify(before));
  Logger.log("AFTER:  " + JSON.stringify(after));
  Logger.log(changed.length ? "Turned ON: " + changed.join(", ") : "Nothing to change: all five flags were already on.");
  if (changed.indexOf("FF_CAMERA") >= 0) Logger.log("Reminder: FF_CAMERA was held back on purpose (docs/rollout-checklist.md: test on a low-end Android and iOS Safari).");
  var audited = false;
  if (typeof p2_audit === "function") audited = p2_audit("editor", "p3_enable_followup_flags", "script-properties", before, after) === true;
  return { ok: true, changed: changed, before: before, after: after, audited: audited };
}


// ============================================================================
// ===== MERGED FROM Phase3_Roles.gs =====
// ============================================================================

// Phase 3 / S3 - Assistant role. Paste into Apps Script as its own file (any order).
// Contract: docs/followup-v3 plan, section 2.3.  Only declarations here - nothing runs at load time.
//
// An ASSISTANT is a normal student account whose Students-sheet `role` cell says "assistant".
//   - is_admin is NEVER touched: it stays blank, so every admin-only check keeps refusing them.
//   - The ONLY way in is Code.gs's _requireAdminSession (reached by _requireAdminAny), which calls
//     p3_assistantAllows() below. It lets a valid, non-stale assistant session through ONLY when
//     payload.action is in P3_STAFF_ALLOW. Everything else stays admin-only (deny by default).
//   - The ADMIN_TOKEN (desktop app) path is untouched: _requireAdmin is never consulted for roles.
//   - The role is re-read from the sheet on every call, so removing it takes effect on the next call.

// The actions an assistant may call. S3 owns this list; nobody else edits it.
var P3_STAFF_ALLOW = [
  "admin_followup_overview",
  "admin_followup_set_attendance",
  "admin_followup_save_group",
  "admin_followup_save_templates",
  "admin_student_summary",
  "admin_monthly_review",
  "admin_set_requirement",
  "admin_log_parent_notification",
  "admin_list_parent_notifications",
  "admin_grading_queue",
  "admin_grade_written",
  "admin_get_written_models",
  "get_written_image",
  // FU2: follow-up v2. NOT listed on purpose (admin only): admin_fu2_notify_test, admin_fu2_group_duplicates.
  "admin_fu2_mark_done",
  "admin_fu2_notify_settings_get",
  "admin_fu2_notify_settings_save",
  "admin_req_get",
  "admin_req_save_global",
  "admin_req_save_group",
  "admin_req_check",
  "admin_req_history"
];

var P3_ROLE_ASSISTANT = "assistant";

function _p3IsStaffAction(action) {
  return typeof action === "string" && P3_STAFF_ALLOW.indexOf(action) !== -1;
}

// "admin" | "assistant" | "student" for one Students-sheet row. c = the _studentCols map.
// A sheet without a `role` column simply has no assistants.
function _p3RoleOfRow(row, c) {
  if (c.is_admin && _isTruthyFlag(row[c.is_admin - 1])) return "admin";
  if (c.role && String(row[c.role - 1] == null ? "" : row[c.role - 1]).trim().toLowerCase() === P3_ROLE_ASSISTANT) return "assistant";
  return "student";
}

// Called from _requireAdminSession AFTER the session token has matched. True only for a real
// assistant (never an admin - admins already passed) asking for an allow-listed action.
function p3_assistantAllows(row, c, payload) {
  return _p3RoleOfRow(row, c) === "assistant" && _p3IsStaffAction(payload && payload.action);
}

// "admin" | "assistant" | "student" | "none" | "stale". Never throws for a bad session.
function p3_session_role(payload) {
  if (!payload || !payload.student_id || !payload.session_token) return "none";
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      if (String(values[i][c.session_token - 1]) !== String(payload.session_token)) return "stale";
      return _p3RoleOfRow(values[i], c);
    }
  }
  return "none";
}

// Router action `p3_session_role`: the page asks "what am I?" so a cached session can't go stale.
function p3_action_session_role(payload) {
  return { ok: true, role: p3_session_role(payload) };
}

// Decorates a login / register / reset / profile reply with `role` (admin|assistant|student).
// Signature matches the router hook _p2Post(name, resp, payload). Never throws, never fails a login.
function p3_withRole(resp, payload) {
  try {
    if (!resp || resp.ok === false || !resp.student_id) return resp;
    var values = _students().getDataRange().getValues();
    var c = _studentCols(values[0]);
    var target = _normalizePhone(resp.student_id);
    for (var i = 1; i < values.length; i++) {
      if (_phonesMatch(values[i][c.phone - 1], target)) { resp.role = _p3RoleOfRow(values[i], c); return resp; }
    }
    resp.role = resp.is_admin ? "admin" : "student";
  } catch (err) {
    if (resp && typeof resp === "object") resp.role = resp.is_admin ? "admin" : "student";
  }
  return resp;
}

// Adds the `role` header if missing (same additive, self-healing pattern as session_token / is_admin).
// Returns the 1-based column number. Never touches existing rows.
function _p3EnsureRoleColumn(sheet) {
  var last = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, last).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === "role") return i + 1;
  }
  if (typeof sheet.getMaxColumns === "function" && last >= sheet.getMaxColumns()) sheet.insertColumnAfter(last);
  sheet.getRange(1, last + 1).setValue("role");
  return last + 1;
}

function _p3Who(payload) {
  return payload && payload.student_id ? String(payload.student_id) : "admin-token";
}

// admin_only. payload: {phone, role}  role: "assistant" | "" (or "student") to remove.
// The target must already be a student account. Admins can't be changed here, and "admin" can
// never be granted through the web: is_admin stays a by-hand flag in the Sheet.
function p3_admin_set_role(payload) {
  _requireAdminAny(payload);
  payload = payload || {};
  var phone = _normalizePhone(payload.phone);
  if (!phone) throw new Error("Missing phone number.");
  var role = String(payload.role == null ? "" : payload.role).trim().toLowerCase();
  if (role === "student") role = "";
  if (role === "admin") throw new Error("Admin can only be set by hand in the Students sheet.");
  if (role !== "" && role !== P3_ROLE_ASSISTANT) throw new Error("Unknown role.");
  var res = _withLock(function () {
    var sheet = _students();
    var roleCol = _p3EnsureRoleColumn(sheet);
    var found = _findStudentRow(sheet, phone);
    if (!found) throw new Error("No student account with that phone number.");
    if (found.is_admin) throw new Error("This account is an admin; its role can't be changed here.");
    var cur = sheet.getRange(found.row, roleCol, 1, 1).getValues()[0][0];
    var before = String(cur == null ? "" : cur).trim().toLowerCase();
    if (before !== P3_ROLE_ASSISTANT) before = "";
    sheet.getRange(found.row, roleCol).setValue(role);
    return {
      ok: true, phone: _restoreLeadingZero(String(found.phone)), name: String(found.display_name == null ? "" : found.display_name),
      role: role === "" ? "student" : role, changed: before !== role
    };
  });
  if (res.changed) p2_audit(_p3Who(payload), "p3_admin_set_role", res.phone, { role: res.role === "student" ? P3_ROLE_ASSISTANT : "" }, { role: res.role === "student" ? "" : res.role });
  return res;
}

// admin_only. Lists staff (admins read-only + assistants) and the allow-list the role grants.
function p3_admin_list_staff(payload) {
  _requireAdminAny(payload);
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var staff = [];
  for (var i = 1; i < values.length; i++) {
    var role = _p3RoleOfRow(values[i], c);
    if (role === "student") continue;
    staff.push({
      phone: _restoreLeadingZero(String(values[i][c.phone - 1])),
      name: String(values[i][c.display_name - 1] == null ? "" : values[i][c.display_name - 1]),
      role: role,
      year: c.year ? String(values[i][c.year - 1] || "") : ""
    });
  }
  return { ok: true, staff: staff, allow: P3_STAFF_ALLOW.slice() };
}


// ============================================================================
// ===== MERGED FROM Phase3_Recovery.gs =====
// ============================================================================

// ============================================================================
// Phase3_Recovery.gs  (Phase 3, Session 2)
//
// Finds homework that students handed in but that never reached the Submissions
// sheet, and gets it back where that is possible.
//
//   p3_diagnose_submissions()        READ-ONLY (except the report tab it writes). Run from the editor.
//   p3_restore_submissions(opts)     dry-run by default. Wraps the existing _restoreFromDrive.
//   p3_admin_backfill_submission(p)  admin-only manual row for a student who shows you their result.
//
// Router actions (paste into Code.gs doPost with the other Phase 3 cases, see HANDOFF-S2.md):
//   p3_admin_diagnose_submissions / p3_admin_restore_submissions / p3_admin_backfill_submission
//
// The three failure cases (plan section 1.4):
//   A  the submission reached the server: a "--meta.json" is in the Drive SUBMISSIONS folder but the
//      Submissions sheet has no row.                          -> p3_restore_submissions
//   B  photos landed (WrittenAnswers rows) but the submission itself was never posted.
//                                                              -> p3_admin_backfill_submission
//   C  nothing reached the server. Only the student's browser has it.
//                                                              -> the page re-sends it on the next visit
//                                                                 (assign.js), or p3_admin_backfill_submission
//
// Also reports H2 (a group lesson key that matches no lesson folder) and H3 (which spreadsheet the
// dashboards are reading Submissions / QuizResults from).
//
// Uses only helpers that already exist in Code.gs. New names carry the p3_ prefix.
// ============================================================================

var P3_REC_TAB = "RecoveryReport";
var P3_REC_HEADERS = ["checked_at", "kind", "student", "name", "group", "lesson", "case", "due", "due_passed", "detail"];
var P3_REC_DRIVE_LIMIT_MS = 4 * 60 * 1000;   // Apps Script stops at 6 minutes

// ---- small helpers --------------------------------------------------------------------------------

function _p3rSlug(raw) { return _p2fuSlug(raw); }
function _p3rSubject(raw) { return String(raw == null ? "" : raw).trim().toLowerCase(); }

// Every "--meta.json" in the submissions folder, indexed by phoneKey|subject|slug.
function _p3rIndexDriveMeta() {
  var out = { byKey: {}, scanned: 0, files: 0, timedOut: false, error: "" };
  var started = Date.now();
  try {
    var it = _folder("SUBMISSIONS_FOLDER_ID").getFiles();
    while (it.hasNext()) {
      if (Date.now() - started > P3_REC_DRIVE_LIMIT_MS) { out.timedOut = true; break; }
      var f = it.next();
      out.files++;
      var name = String(f.getName() || "");
      if (name.slice(-"--meta.json".length) !== "--meta.json") continue;
      out.scanned++;
      var d;
      try { d = JSON.parse(f.getBlob().getDataAsString()); } catch (e) { continue; }
      if (!d || !d.student_id) continue;
      var k = [_phoneKey(d.student_id), _p3rSubject(d.subject), _p3rSlug(d.lesson)].join("|");
      (out.byKey[k] = out.byKey[k] || []).push({ file: name, submitted_time: d.submitted_time || "", type: d.submission_type || "" });
    }
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return out;
}

// ---- 1. diagnosis ----------------------------------------------------------------------------------

// Core: returns the report object, touches nothing.
function p3_diagnose_core() {
  var ss = _ss(), dataSs = _dataSs();
  var X = _p2fuLoad(ss, dataSs);
  var drive = _p3rIndexDriveMeta();

  // photos that landed: phoneKey|slug -> count of WrittenAnswers rows
  var photos = {};
  X.written.forEach(function (r) {
    var pk = _phoneKey(r.student_id || r.student);
    if (!pk) return;
    var k = pk + "|" + _p3rSlug(r.lesson);
    photos[k] = (photos[k] || 0) + 1;
  });

  var items = [], seen = {};
  var counts = { A: 0, B: 0, C: 0, expected: 0, done: 0, due_passed_missing: 0 };

  X.groups.forEach(function (g) {
    var rv = g.settings.review_lessons || [];
    var hwL = g.settings.hw_lessons || rv;
    var groupDue = _p2fuHwDue(g.settings, X.today, X.hm, X.cfg);
    hwL.forEach(function (raw) {
      var lesson = _p2fuCanon(raw); if (!lesson) return;
      var rq = _p2fuReq(X.req, lesson);
      if (!rq.homework_required) return;                        // an optional homework cannot be "missing"
      var subject = _firstSegment(lesson), slug = _p3rSlug(lesson);
      var due = rq.due_override || groupDue || "";
      var duePassed = !due || X.today > due;
      g.members.forEach(function (pk) {
        var st = X.students[pk]; if (!st || st.admin) return;
        var once = pk + "|" + lesson; if (seen[once]) return; seen[once] = true;
        counts.expected++;
        var done = (X.hw[pk] || []).some(function (r) { return r.slug === slug && (r.subject === "" || r.subject === subject); });
        if (done) { counts.done++; return; }
        var dk = pk + "|" + subject + "|" + slug;
        var metas = drive.byKey[dk] || drive.byKey[pk + "||" + slug] || [];
        var nPhotos = photos[pk + "|" + slug] || 0;
        var kase, detail;
        if (metas.length) {
          kase = "A";
          detail = metas.length + " file(s) in Drive (" + metas[metas.length - 1].file + "), no Sheet row. Run p3_restore_submissions." +
                   (nPhotos ? " Photos also found (" + nPhotos + ")." : "");
        } else if (nPhotos) {
          kase = "B";
          detail = nPhotos + " photo answer(s) in WrittenAnswers but no submission. Ask the student for the score, then p3_admin_backfill_submission.";
        } else {
          kase = "C";
          detail = "Nothing on the server. Only the student's own browser may still hold it: ask them to open the lesson page on the same device, or back-fill it by hand.";
        }
        counts[kase]++;
        if (duePassed) counts.due_passed_missing++;
        items.push({ student: st.phone, name: st.name, group: g.group, lesson: lesson, "case": kase, due: due, due_passed: duePassed, detail: detail });
      });
    });
  });

  // H2: a group lesson key that matches no lesson folder (a rename nobody aliased)
  var h2 = [];
  if (X.lessonsError) {
    h2.push({ lesson: "", detail: "H2 skipped: the lesson list could not be read from GitHub (" + X.lessonsError + ")." });
  } else {
    var checked = {};
    X.groups.forEach(function (g) {
      (g.settings.review_lessons || []).concat(g.settings.hw_lessons || [], g.settings.quiz_lessons || []).forEach(function (raw) {
        var lesson = _p2fuCanon(raw); if (!lesson || checked[lesson]) return; checked[lesson] = true;
        var hit = X.pathBySlug[_firstSegment(lesson) + "|" + _p3rSlug(lesson)];
        if (!hit || !hit.length) h2.push({ lesson: lesson, group: g.group, detail: "No lesson folder has this slug. Students' submissions are filed under the real folder name, so this lesson will always look missing. Fix the key or add an alias." });
      });
    });
  }

  // H3: which spreadsheet are Submissions / QuizResults being read from
  function tabInfo(book, name) { var sh = book.getSheetByName(name); return { exists: !!sh, rows: sh ? Math.max(0, sh.getLastRow() - 1) : 0 }; }
  var h3 = {
    data_sheet_id: String(_props().getProperty("DATA_SHEET_ID") || ""),
    students_sheet_id: String(_props().getProperty("STUDENTS_SHEET_ID") || ""),
    dashboards_read_from: dataSs.getId(),
    separate_data_sheet: !!_props().getProperty("DATA_SHEET_ID") && dataSs.getId() !== ss.getId(),
    data: { Submissions: tabInfo(dataSs, "Submissions"), QuizResults: tabInfo(dataSs, "QuizResults"), WrittenAnswers: tabInfo(dataSs, "WrittenAnswers") },
    students_book: { Submissions: tabInfo(ss, "Submissions"), QuizResults: tabInfo(ss, "QuizResults") },
    note: ""
  };
  if (h3.separate_data_sheet && (h3.students_book.Submissions.rows || h3.students_book.QuizResults.rows)) {
    h3.note = "Submissions/QuizResults rows also exist in the STUDENTS spreadsheet. If recent work went there, the dashboards (which read DATA_SHEET_ID) cannot see it.";
  } else if (!h3.data.Submissions.rows) {
    h3.note = "The Submissions tab the dashboards read is empty. Check DATA_SHEET_ID.";
  }

  return {
    ok: true, checked_at: _fmt(new Date(), TZ, true), today: X.today,
    summary: {
      expected: counts.expected, done: counts.done,
      missing: counts.A + counts.B + counts.C, missing_due_passed: counts.due_passed_missing,
      case_A: counts.A, case_B: counts.B, case_C: counts.C,
      drive_files: drive.files, drive_meta_scanned: drive.scanned, drive_timed_out: drive.timedOut, drive_error: drive.error
    },
    items: items, h2: h2, h3: h3
  };
}

// Writes the report to the RecoveryReport tab (replaced every run) and to the log.
function _p3rWriteReport(rep) {
  var sh = _sheetByName(_dataSs(), P3_REC_TAB, P3_REC_HEADERS);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  var rows = [];
  var at = rep.checked_at;
  rows.push([at, "summary", "", "", "", "", "", "", "", JSON.stringify(rep.summary)]);
  rows.push([at, "h3", "", "", "", "", "", "", "", JSON.stringify(rep.h3)]);
  rep.h2.forEach(function (h) { rows.push([at, "h2", "", "", h.group || "", h.lesson || "", "H2", "", "", h.detail]); });
  rep.items.forEach(function (i) { rows.push([at, "missing", "'" + i.student, i.name, i.group, i.lesson, i["case"], i.due, i.due_passed ? "yes" : "no", i.detail]); });
  var need = 1 + rows.length;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  sh.getRange(2, 1, rows.length, P3_REC_HEADERS.length).setValues(rows);
  return rows.length;
}

// Run from the Apps Script editor. Logs a short summary; the details are in the RecoveryReport tab.
function p3_diagnose_submissions() {
  var rep = p3_diagnose_core();
  var n = _p3rWriteReport(rep);
  var s = rep.summary;
  Logger.log("Diagnosis: " + s.expected + " expected homework | " + s.done + " found | " + s.missing + " missing (" + s.missing_due_passed + " past due)" +
    " -> A (restorable from Drive): " + s.case_A + " | B (photos only): " + s.case_B + " | C (nothing on the server): " + s.case_C);
  Logger.log("Drive: " + s.drive_meta_scanned + " submission files read" + (s.drive_timed_out ? " (STOPPED EARLY, run again)" : "") + (s.drive_error ? " | Drive error: " + s.drive_error : ""));
  rep.h2.forEach(function (h) { Logger.log("H2: " + (h.lesson ? h.lesson + " - " : "") + h.detail); });
  Logger.log("H3: dashboards read from " + rep.h3.dashboards_read_from + " | Submissions rows " + rep.h3.data.Submissions.rows + ", QuizResults rows " + rep.h3.data.QuizResults.rows + (rep.h3.note ? " | " + rep.h3.note : ""));
  Logger.log("Wrote " + n + " rows to the " + P3_REC_TAB + " tab.");
  return rep;
}

function p3_admin_diagnose_submissions(payload) {
  _requireAdminAny(payload);
  var rep = p3_diagnose_core();
  if (payload && payload.write_report) _p3rWriteReport(rep);
  return rep;
}

// ---- 2. restore (dry run by default) ----------------------------------------------------------------

// opts: {days: 30 (0 = everything), dry_run: true, who?: audit name}. Returns {ok, dry_run, days, scanned, quiz_rows, submission_rows, stopped_early}.
// dry_run:true runs the real _restoreFromDrive logic with row-writing switched off, so the counts are exactly
// what a real run would add.
function p3_restore_submissions(opts) {
  opts = opts || {};
  var days = opts.days === undefined || opts.days === null ? 30 : Math.max(0, parseInt(opts.days, 10) || 0);
  var dry = opts.dry_run !== false;                     // anything but an explicit false is a dry run

  var g = (typeof globalThis !== "undefined") ? globalThis : this;
  var realAppend = g._appendByHeader, realLog = Logger.log;
  var added = { QuizResults: 0, Submissions: 0 }, logged = "";
  g._appendByHeader = function (sheet, rec) {
    var name = ""; try { name = sheet.getName(); } catch (e) { /* ignore */ }
    if (added.hasOwnProperty(name)) added[name]++;
    return dry ? 0 : realAppend(sheet, rec);
  };
  Logger.log = function (m) { logged += String(m) + "\n"; };
  try {
    _restoreFromDrive(days);
  } finally {
    g._appendByHeader = realAppend;
    Logger.log = realLog;
  }
  var scanned = /scanned (\d+)/.exec(logged);
  var res = {
    ok: true, dry_run: dry, days: days, scanned: scanned ? +scanned[1] : null,
    quiz_rows: added.QuizResults, submission_rows: added.Submissions, stopped_early: /STOPPED EARLY/.test(logged)
  };
  Logger.log("Restore " + (dry ? "(DRY RUN - nothing written)" : "(APPLIED)") + ": " + res.quiz_rows + " quiz row(s), " + res.submission_rows + " submission row(s)" +
    (res.stopped_early ? " | STOPPED EARLY (time limit) - run it again" : ""));
  if (!dry) p2_audit(opts.who || "editor", "p3_restore_submissions", "days=" + days, "", res);
  return res;
}

function p3_admin_restore_submissions(payload) {
  _requireAdminAny(payload);
  return p3_restore_submissions({ days: payload.days, dry_run: payload.dry_run, who: _p2fuWho(payload) });
}

// ---- 3. manual back-fill ---------------------------------------------------------------------------

// payload: {student (phone), lesson (path or slug), score, total, note?, subject?, force?}
// Writes ONE Submissions row, submission_type "graded", source "manual-backfill". Safe to repeat (same student/lesson/score).
function p3_admin_backfill_submission(payload) {
  _requireAdminAny(payload);
  var digits = _normalizePhone(payload.student);
  if (digits.length < 10) throw new Error("Missing student phone.");
  var pk = _phoneKey(digits);
  var student = null;
  _sheetValuesAsObjects(_students()).forEach(function (r) { if (!student && _phoneKey(r.phone) === pk) student = r; });
  if (!student) throw new Error("No student account has that phone.");

  var lessonRaw = String(payload.lesson == null ? "" : payload.lesson).trim();
  if (!lessonRaw) throw new Error("Missing lesson.");
  var lesson = _p2fuCanon(lessonRaw.indexOf("/") >= 0 ? _lessonPath(lessonRaw) : lessonRaw);
  var slug = _p3rSlug(lesson);
  var subject = _p3rSubject(payload.subject) || (lesson.indexOf("/") >= 0 ? _firstSegment(lesson) : "");
  if (!subject) throw new Error("Give the lesson as a full path (programming/...) or pass subject.");

  var score = parseFloat(payload.score), total = parseFloat(payload.total);
  if (!isFinite(score) || !isFinite(total) || score < 0 || total <= 0 || score > total) throw new Error("score must be between 0 and total (total above 0).");
  var note = String(payload.note == null ? "" : payload.note).slice(0, 500);

  var key = ["manual", pk, subject, slug, score, total].join("|");
  return _withLock(function () {
    var sheet = _submissionsSheet();
    _ensureColumns(sheet, ["source"]);
    var rows = _sheetValuesAsObjects(sheet);
    var existing = rows.filter(function (r) { return _phoneKey(r.student_id) === pk && _p3rSubject(r.subject) === subject && _p3rSlug(r.lesson) === slug; });
    if (existing.some(function (r) { return String(r.dedupe_key) === key; })) return { ok: true, duplicate: true };
    if (existing.length && !payload.force) throw new Error("This student already has a submission for that lesson. Pass force:true to add another row.");
    var now = new Date(), when = _fmt(now, TZ, true);
    _appendByHeader(sheet, {
      student_id: _restoreLeadingZero(String(student.phone == null ? "" : student.phone).trim()), name: String(student.display_name || ""), subject: subject, lesson: slug,
      submission_type: "graded", text: "", text_truncated: false, url: "", note: "manual-backfill" + (note ? ": " + note : ""),
      date: _fmt(now, TZ, false), submitted_time: when, score: score, total: total, answers_json: "[]",
      dedupe_key: key, source: "manual-backfill"
    });
    p2_audit(_p2fuWho(payload), "p3_admin_backfill_submission", pk + "|" + subject + "|" + slug, "", { score: score, total: total, note: note });
    return { ok: true, student: pk, subject: subject, lesson: slug, score: score, total: total };
  }, UPLOAD_LOCK_WAIT_MS);
}


// ============================================================================
// ===== MERGED FROM Phase3_BulkAccess.gs =====
// ============================================================================

/**
 * Phase3_BulkAccess.gs  (Phase 3, session S4) — bulk lesson / quiz access.
 *
 * Paste next to Code.gs. Everything here is prefixed p3_ / _p3 / P3_ (frozen contract §2.3.6).
 * Router lines are NOT in this file; they are listed in HANDOFF-S4.md ("Shared-file edits"):
 *
 *   case "p3_admin_bulk_preview": return _json(p3_admin_bulk_preview(payload));
 *   case "p3_admin_bulk_grant":   return _json(p3_admin_bulk_grant(payload));
 *   case "p3_admin_bulk_revoke":  return _json(p3_admin_bulk_revoke(payload));
 *
 * Request shape (all three actions):
 *   { kind: "lesson" | "quiz",
 *     lessons: [scope|lesson path, ...],        // lesson kind: same scopes admin_grant_access takes ("*", "a/b/*", "a/b/lesson")
 *     groups:  [group name, ...],               // every current member is a target
 *     members: [phone, ...],                    // individual students (any phone spelling)
 *     expires_at? | days? | never?,             // grant only; same fields as the single grant
 *     mode?: "grant" | "revoke" }               // preview only (default "grant")
 *
 * Reply: { ok, applied, skipped, failed:[{target,lesson,error}], ... }.
 *
 * Rules are NOT re-implemented for grants: every write goes through the existing single-grant
 * internals _grantRaw (lessons) and _grantQuizRaw (quizzes), and group targets also call
 * _rememberGroupGrant so students added to the group later inherit the access, exactly like
 * admin_group_grant_access / admin_group_grant_quiz_access. The ONLY logic copied from Code.gs is the
 * revoke row-deletion (the single revoke handlers take the lock themselves, so they cannot be called
 * from inside our one lock) and the tiny "would this grant change anything" predictor used to skip no-ops.
 */

var P3_BULK_CAP = 400;   // max (distinct student x lesson) pairs per request

// ---- input ------------------------------------------------------------------------------------

function _p3bArr(v) {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

function _p3bKind(payload) {
  var k = String(payload.kind == null ? "" : payload.kind).trim().toLowerCase();
  if (k !== "lesson" && k !== "quiz") throw new Error('kind must be "lesson" or "quiz".');
  return k;
}

// Lessons -> canonical keys (deduped, order kept). Invalid input rejects the whole request: a typo
// should never silently shrink the batch.
function _p3bLessons(payload, kind) {
  var seen = {}, out = [];
  _p3bArr(payload.lessons).forEach(function (raw) {
    var s = kind === "quiz" ? _lessonPath(raw) : _normalizeScope(raw);
    if (!seen[s]) { seen[s] = 1; out.push(s); }
  });
  if (!out.length) throw new Error("Pick at least one " + (kind === "quiz" ? "quiz" : "lesson") + ".");
  return out;
}

// Term fields, exactly as the single grant reads them.
function _p3bTerm(payload) {
  var explicit = payload.expires_at ? _cleanYmd(payload.expires_at) : "";
  var days = explicit || payload.never === true ? 0 : _accessDays(payload);
  return { explicit: explicit, days: days };
}

// Resolve targets to distinct phones. Returns
//   { phones: [{phone, source, label}], groups: [{key, spelling, members:[phone]}], failed: [{target, lesson:"", error}] }
// A phone reached through a group AND listed in members is ONE target (source = first group, so the
// access stays tied to the group rule).
function _p3bTargets(ss, payload) {
  var failed = [], byPhone = {}, order = [], groups = [];
  var gnames = _p3bArr(payload.groups), mphones = _p3bArr(payload.members);
  if (!gnames.length && !mphones.length) throw new Error("Pick at least one group or student.");

  if (gnames.length) {
    var gsheet = ss.getSheetByName("Groups");
    var spellings = _groupSpellings(gsheet);
    var seenG = {};
    gnames.forEach(function (name) {
      var key = _groupKey(name);
      if (!key || seenG[key]) return;
      seenG[key] = 1;
      var members = _groupMembers(gsheet, key);
      if (!members.length) { failed.push({ target: String(name), lesson: "", error: "That group has no members yet." }); return; }
      var spelling = spellings[key] || String(name);
      var g = { key: key, spelling: spelling, members: [] };
      members.forEach(function (m) {
        var ph = _canonicalPhone(m.phone) || String(m.phone);
        g.members.push(ph);
        if (!byPhone[ph]) { byPhone[ph] = { phone: ph, source: "group:" + spelling, label: spelling }; order.push(ph); }
      });
      groups.push(g);
    });
  }
  var seenM = {};
  mphones.forEach(function (raw) {
    if (_normalizePhone(raw).length < 10) { failed.push({ target: String(raw), lesson: "", error: "Enter the student's full phone number." }); return; }
    var ph = _canonicalPhone(raw);
    if (seenM[ph]) return;
    seenM[ph] = 1;
    if (!byPhone[ph]) { byPhone[ph] = { phone: ph, source: "manual", label: ph }; order.push(ph); }
  });
  return { phones: order.map(function (p) { return byPhone[p]; }), groups: groups, failed: failed };
}

function _p3bCapCheck(nPhones, nLessons) {
  var pairs = nPhones * nLessons;
  if (pairs > P3_BULK_CAP) {
    throw new Error("Too many changes in one go (" + pairs + " = " + nPhones + " students × " + nLessons +
      " items; the limit is " + P3_BULK_CAP + "). Split it into smaller batches.");
  }
  return pairs;
}

// ---- reading current state (one pass per sheet) -------------------------------------------------

// Index of existing rows: list of {phone, key, ymd, row} for Entitlements (scope) or QuizAccess (lesson).
function _p3bIndex(ss, kind) {
  var name = kind === "quiz" ? "QuizAccess" : "Entitlements";
  var keyCol = kind === "quiz" ? "lesson" : "scope";
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var c = _needCols(sheet, name, ["phone", keyCol, "expires_at"]);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    out.push({ phone: values[i][c.phone - 1], key: _canonKey(String(values[i][c[keyCol] - 1]).trim().toLowerCase()),
               ymd: _ymdOf(values[i][c.expires_at - 1], tz), row: i + 2 });
  }
  return out;
}

function _p3bFind(index, phone, key) {
  for (var i = 0; i < index.length; i++) if (index[i].key === key && _phonesMatch(index[i].phone, phone)) return index[i];
  return null;
}

// Mirrors the expiry arithmetic at the top of _grantRaw/_grantQuizRaw, ONLY to decide "would this change anything?".
// The real write is always done by those functions.
function _p3bTarget(found, explicit, days) {
  var today = _todayCairo();
  var existing = found ? found.ymd : null;
  var target;
  if (explicit) target = explicit;
  else if (days) target = _addDays(existing && existing > today ? existing : today, days);
  else target = "";
  if (found && existing === "") target = "";
  else if (found && existing && target !== "" && existing > target) target = existing;
  return target;
}

// ---- preview ------------------------------------------------------------------------------------

function _p3bBuildPlan(ss, payload, mode) {
  var kind = _p3bKind(payload);
  var lessons = _p3bLessons(payload, kind);
  var term = mode === "revoke" ? { explicit: "", days: 0 } : _p3bTerm(payload);
  var tg = _p3bTargets(ss, payload);
  var pairs = _p3bCapCheck(tg.phones.length, lessons.length);
  var index = _p3bIndex(ss, kind);
  var items = [];
  tg.phones.forEach(function (p) {
    lessons.forEach(function (l) {
      var found = _p3bFind(index, p.phone, l);
      var change, expires = "";
      if (mode === "revoke") {
        change = found ? "revoke" : "skip";
        expires = found ? found.ymd : "";
      } else {
        var target = _p3bTarget(found, term.explicit, term.days);
        if (found && found.ymd === target) change = "skip";
        else change = found ? "extend" : "create";
        expires = target;
      }
      items.push({ phone: p.phone, lesson: l, change: change, expires_at: expires, source: p.source });
    });
  });
  return { kind: kind, lessons: lessons, term: term, targets: tg, pairs: pairs, items: items };
}

function _p3bCounts(items) {
  var n = { create: 0, extend: 0, revoke: 0, skip: 0 };
  items.forEach(function (i) { n[i.change]++; });
  return n;
}

// Read-only. Tells the UI exactly what apply would do.
function p3_admin_bulk_preview(payload) {
  _requireAdminAny(payload);
  var mode = String(payload.mode || "grant").toLowerCase() === "revoke" ? "revoke" : "grant";
  var plan = _p3bBuildPlan(_ss(), payload, mode);
  var n = _p3bCounts(plan.items);
  return { ok: true, mode: mode, kind: plan.kind, lessons: plan.lessons.length, students: plan.targets.phones.length,
           total: plan.items.length, would_apply: n.create + n.extend + n.revoke, would_create: n.create, would_extend: n.extend,
           would_revoke: n.revoke, would_skip: n.skip, failed: plan.targets.failed, cap: P3_BULK_CAP };
}

// ---- grant --------------------------------------------------------------------------------------

function p3_admin_bulk_grant(payload) {
  _requireAdminAny(payload);
  var res = _withLock(function () {
    var ss = _ss();
    var plan = _p3bBuildPlan(ss, payload, "grant");
    var failed = plan.targets.failed.slice();
    var applied = 0, skipped = 0, created = 0, extended = 0;
    var sourceOf = {};
    plan.targets.phones.forEach(function (p) { sourceOf[p.phone] = p.source; });

    plan.items.forEach(function (it) {
      if (it.change === "skip") { skipped++; return; }
      try {
        if (plan.kind === "quiz") _grantQuizRaw(ss, it.phone, it.lesson, plan.term.explicit, plan.term.days, sourceOf[it.phone]);
        else _grantRaw(ss, it.phone, it.lesson, plan.term.explicit, plan.term.days, sourceOf[it.phone]);
        applied++;
        if (it.change === "create") created++; else extended++;
      } catch (e) {
        failed.push({ target: it.phone, lesson: it.lesson, error: String(e && e.message || e) });
      }
    });

    // Remember group rules (so later joiners inherit the access) — same call the group handlers make.
    var rules = 0;
    plan.targets.groups.forEach(function (g) {
      plan.lessons.forEach(function (l) {
        try {
          _rememberGroupGrant(ss, g.key, g.spelling, plan.kind === "quiz" ? "quiz" : "access", l, plan.term.explicit, plan.term.days);
          rules++;
        } catch (e) {
          failed.push({ target: g.spelling, lesson: l, error: "Group rule not saved: " + String(e && e.message || e) });
        }
      });
    });
    return { ok: true, kind: plan.kind, applied: applied, created: created, extended: extended, skipped: skipped,
             failed: failed, group_rules: rules, students: plan.targets.phones.length, lessons: plan.lessons.length,
             groups: plan.targets.groups.map(function (g) { return g.spelling; }) };
  });
  _p3bAudit(payload, "p3_admin_bulk_grant", res);
  return res;
}

// ---- revoke -------------------------------------------------------------------------------------

// INSIDE the lock. Deletes the matching rows for (phone, key); returns the removed rows' details
// {removed, expires_at, pays}. Lesson kind also reports the payments behind them, so the caller can mark them revoked
// (same bookkeeping as handleAdminRevokeAccess).
function _p3bRevokeOne(ss, kind, phone, key) {
  var name = kind === "quiz" ? "QuizAccess" : "Entitlements";
  var keyCol = kind === "quiz" ? "lesson" : "scope";
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return { removed: 0, expires_at: "", pays: [] };
  var c = _needCols(sheet, name, ["phone", keyCol, "expires_at"]);
  var tz = sheet.getParent().getSpreadsheetTimeZone() || TZ;
  var srcCol = kind === "quiz" ? 0 : (_headerIndex(sheet)["source"] || 0);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  var rows = [], pays = [], ymd = "";
  for (var i = 0; i < values.length; i++) {
    if (!_phonesMatch(values[i][c.phone - 1], phone)) continue;
    if (_canonKey(String(values[i][c[keyCol] - 1]).trim().toLowerCase()) !== key) continue;
    rows.push(i + 2);
    ymd = _ymdOf(values[i][c.expires_at - 1], tz) || "";
    var src = srcCol ? _sourcePayment(values[i][srcCol - 1]) : "";
    if (src) pays.push(src);
  }
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sheet.deleteRows(r, 1); });
  return { removed: rows.length, expires_at: ymd, pays: pays };
}

function _p3bMarkPaymentsRevoked(ss, pays) {
  var marked = [];
  var pSheet = pays.length ? ss.getSheetByName("Payments") : null;
  if (!pSheet || pSheet.getLastRow() < 2) return marked;
  var pc = _needCols(pSheet, "Payments", ["payment_id", "status", "decided_at"]);
  var pv = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, pSheet.getLastColumn()).getValues();
  var now = _fmt(new Date(), TZ, true);
  for (var k = 0; k < pv.length; k++) {
    var id = String(pv[k][pc.payment_id - 1]).trim();
    if (pays.indexOf(id) === -1 || String(pv[k][pc.status - 1]).trim().toLowerCase() !== "approved") continue;
    pSheet.getRange(k + 2, pc.status).setNumberFormat("@").setValue("revoked");
    pSheet.getRange(k + 2, pc.decided_at).setNumberFormat("@").setValue(now);
    marked.push(id);
  }
  return marked;
}

function p3_admin_bulk_revoke(payload) {
  _requireAdminAny(payload);
  var res = _withLock(function () {
    var ss = _ss();
    var plan = _p3bBuildPlan(ss, payload, "revoke");
    var failed = plan.targets.failed.slice();
    var applied = 0, skipped = 0, allPays = [];
    var revoked = [];   // for the undo hint: what to re-grant

    plan.items.forEach(function (it) {
      if (it.change === "skip") { skipped++; return; }
      try {
        var r = _p3bRevokeOne(ss, plan.kind, it.phone, it.lesson);
        if (!r.removed) { skipped++; return; }
        applied++;
        allPays = allPays.concat(r.pays);
        revoked.push({ phone: it.phone, lesson: it.lesson, expires_at: r.expires_at });
      } catch (e) {
        failed.push({ target: it.phone, lesson: it.lesson, error: String(e && e.message || e) });
      }
    });
    var paymentsRevoked = [];
    try { paymentsRevoked = _p3bMarkPaymentsRevoked(ss, allPays); }
    catch (e) { failed.push({ target: "payments", lesson: "", error: "Payment rows not marked revoked: " + String(e && e.message || e) }); }

    // A group target also drops the group's standing rule for that item, like the group revoke handlers.
    var rules = 0;
    plan.targets.groups.forEach(function (g) {
      plan.lessons.forEach(function (l) {
        try { rules += _forgetGroupGrants(ss, g.key, plan.kind === "quiz" ? "quiz" : "access", l) > 0 ? 1 : 0; }
        catch (e) { failed.push({ target: g.spelling, lesson: l, error: "Group rule not removed: " + String(e && e.message || e) }); }
      });
    });
    return { ok: true, kind: plan.kind, applied: applied, skipped: skipped, failed: failed, revoked: revoked,
             payments_revoked: paymentsRevoked, group_rules_removed: rules,
             students: plan.targets.phones.length, lessons: plan.lessons.length };
  });
  _p3bAudit(payload, "p3_admin_bulk_revoke", res);
  return res;
}

// ---- audit --------------------------------------------------------------------------------------

function _p3bAudit(payload, action, res) {
  try {
    var who = payload.student_id && !payload.token ? payload.student_id : "token";
    var target = _p3bArr(payload.groups).concat(_p3bArr(payload.members)).join(",").slice(0, 200);
    p2_audit(who, action, target, "", {
      kind: res.kind, lessons: _p3bArr(payload.lessons).slice(0, 50), applied: res.applied, skipped: res.skipped,
      failed: (res.failed || []).length, never: payload.never === true, expires: payload.expires_at || "", days: payload.days || ""
    });
  } catch (e) { /* logging must never fail the action */ }
}

// ============================================================================
// ===== MERGED FROM Phase4_Scope.gs =====
// ============================================================================
// Phase4_Scope.gs  (P4 / S2: authorization core)
//
// Paste into the same Apps Script project as Code.gs (File > New > Script). Does NOT edit Code.gs;
// scripts/p4_wire.py inserts the four hooks (H1 to H4) at assembly.
//
// What it does: works out WHO is calling (owner, teacher, scoped assistant, legacy assistant, student,
// anon), decides per action from the P4_ACTIONS table, and filters lesson-based lists. Deny by default,
// fail closed. Every refusal is exactly {ok:false, error:"Not authorized."}.
// Identity comes ONLY from payload.token, or payload.student_id + payload.session_token. Nothing else.
// Every function here starts with p4_ / p4f_ or is a P4_ global, so nothing can collide with Code.gs.
//
// Order of this file: 1 subjects, 2 token verification, 3 ctx, 4 ctxForPhone, 5 action table,
// 6 gate, 7 covers/filter/hooks, 8 attachment resolution, 9 lesson filters, 10 session scope + ping,
// 11 self test.

// ============================================================================
// 1. Subjects
// ============================================================================
var P4_SUBJECTS = ["programming", "english", "math"];

// Per-request globals (Apps Script starts every request with a fresh global scope; p4_gate resets them anyway).
var P4_CTX_ = null;
var P4_GATE_RAN_ = false;

function p4_deny_() { return { ok: false, error: "Not authorized." }; }

function p4_log_(msg) {
  try { if (typeof Logger !== "undefined" && Logger && Logger.log) Logger.log("[p4] " + msg); } catch (e) { /* never fails a request */ }
}

function p4_global_(name) {
  var g = (typeof globalThis !== "undefined") ? globalThis : this;
  return g[name];
}

// "math/sat/x", "math/sat/x#ch2", a grade scope, an old alias -> "math" | "programming" | "english" | "".
// Only strings count. Normalised like _lessonPath (lowercase, "\" -> "/", no leading slash); any ".." is refused.
function p4_subjectOf(keyOrScope) {
  if (typeof keyOrScope !== "string") return "";
  var s = keyOrScope.split("#")[0].trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!s || s.indexOf("..") !== -1) return "";
  try { if (typeof p2k_canon === "function") s = String(p2k_canon(s)).toLowerCase(); } catch (e) { /* keep s */ }
  var seg = s.split("/")[0];
  return P4_SUBJECTS.indexOf(seg) !== -1 ? seg : "";
}

// "Math, programming ,x" -> ["math","programming"]. "*" is NOT a teacher scope (only the owner has it).
function p4_parseScope_(s) {
  var out = [];
  String(s == null ? "" : s).split(",").forEach(function (p) {
    p = p.trim().toLowerCase();
    if (P4_SUBJECTS.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p);
  });
  return out;
}

// ============================================================================
// 2. Teacher token verification (minting, revoking, listing: S5)
// ============================================================================
// SHA-256 hex of a string. Apps Script digest bytes are signed: (b + 256) % 256.
function p4_hashToken_(raw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(raw), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { b = (b + 256) % 256; return ("0" + b.toString(16)).slice(-2); }).join("");
}

// Constant-time string equality (no early exit).
function p4_safeEq_(a, b) {
  a = String(a); b = String(b);
  var n = Math.max(a.length, b.length), d = a.length ^ b.length;
  for (var i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// raw token -> {name, scope:[subjects], created} or null. Looks at EVERY stored hash (no early exit).
function p4_findTeacherToken_(raw) {
  if (typeof raw !== "string" || !raw) return null;
  var map;
  try { map = JSON.parse(_props().getProperty("P4_TEACHER_TOKENS") || "{}"); } catch (e) { return null; }
  if (!map || typeof map !== "object") return null;
  var h = p4_hashToken_(raw), hit = null;
  Object.keys(map).forEach(function (k) {
    if (p4_safeEq_(k, h) && !hit) {
      var e = map[k] || {}, scope = p4_parseScope_(e.scope);
      if (scope.length) hit = { name: String(e.name == null ? "" : e.name), scope: scope, created: String(e.created || "") };
    }
  });
  return hit;
}

// ============================================================================
// 3. Who is calling
// ============================================================================
function p4_anon_() { return { kind: "anon", via: "none", id: "", subjects: [], principal: "" }; }

function p4_readStudents_() {
  var values = _students().getDataRange().getValues();
  return { values: values, c: _studentCols(values[0]) };
}

function p4_cell_(S, i, name) {
  var col = S.c[name];
  return col ? S.values[i][col - 1] : "";
}

function p4_findRow_(S, phone) {
  var target = _normalizePhone(phone);
  if (!target) return -1;
  for (var i = 1; i < S.values.length; i++) {
    if (_phonesMatch(S.values[i][S.c.phone - 1], target)) return i;
  }
  return -1;
}

function p4_idOf_(S, i) {
  var cell = S.values[i][S.c.phone - 1];
  return _canonicalPhone(cell) || _normalizePhone(cell);
}

function p4_roleOf_(S, i) { return String(p4_cell_(S, i, "role") == null ? "" : p4_cell_(S, i, "role")).trim().toLowerCase(); }
function p4_scopeOf_(S, i) { return p4_parseScope_(p4_cell_(S, i, "teacher_scope")); }

// A teacher row: role "teacher" and a non-empty scope. Returns {i, id, scope} or null.
function p4_teacherRow_(S, phone) {
  var i = p4_findRow_(S, phone);
  if (i < 0) return null;
  if (p4_roleOf_(S, i) !== "teacher") return null;
  var scope = p4_scopeOf_(S, i);
  return scope.length ? { i: i, id: p4_idOf_(S, i), scope: scope } : null;
}

// Computes the caller's context (may throw; p4_ctx catches). Token beats session, like _requireAdminAny.
function p4_ctxCompute_(payload) {
  var hasToken = payload.token !== undefined && payload.token !== null && payload.token !== "";
  if (hasToken) {
    if (typeof payload.token !== "string") return p4_anon_();
    var expected = _props().getProperty("ADMIN_TOKEN");
    if (expected && p4_safeEq_(payload.token, expected)) return { kind: "owner", via: "token", id: "owner", subjects: ["*"], principal: "" };
    var t = p4_findTeacherToken_(payload.token);
    if (!t) return p4_anon_();
    var principal = t.name;
    try {
      var S0 = p4_readStudents_(), want = t.name.trim().toLowerCase();
      for (var j = 1; j < S0.values.length; j++) {
        if (String(p4_cell_(S0, j, "display_name")).trim().toLowerCase() === want && p4_roleOf_(S0, j) === "teacher" && p4_scopeOf_(S0, j).length) {
          principal = p4_idOf_(S0, j); break;
        }
      }
    } catch (e) { /* no matching row: the name stands in */ }
    return { kind: "teacher", via: "token", id: t.name, subjects: t.scope.slice(), principal: principal };
  }

  if (!payload.student_id || !payload.session_token) return p4_anon_();
  var S = p4_readStudents_();
  var i = p4_findRow_(S, payload.student_id);
  if (i < 0) return p4_anon_();
  var stored = String(p4_cell_(S, i, "session_token"));
  if (!stored || stored !== String(payload.session_token)) return p4_anon_();
  var id = p4_idOf_(S, i);
  if (S.c.is_admin && _isTruthyFlag(p4_cell_(S, i, "is_admin"))) return { kind: "owner", via: "session", id: id, subjects: ["*"], principal: "" };

  var role = p4_roleOf_(S, i);
  if (role === "teacher") {
    var scope = p4_scopeOf_(S, i);
    if (scope.length) return { kind: "teacher", via: "session", id: id, subjects: scope, principal: id };
  } else if (role === "assistant") {
    var of = String(p4_cell_(S, i, "assistant_of") == null ? "" : p4_cell_(S, i, "assistant_of")).trim();
    if (!of) return { kind: "assistant", via: "session", id: id, subjects: [], principal: "" };       // legacy owner assistant
    var tr = p4_teacherRow_(S, of);
    if (tr) return { kind: "assistant", via: "session", id: id, subjects: tr.scope.slice(), principal: tr.id };   // scoped
  }
  return { kind: "student", via: "session", id: id, subjects: [], principal: "" };
}

function p4_ctx(payload) {
  var ctx;
  try { ctx = p4_ctxCompute_(payload || {}); } catch (e) { ctx = p4_anon_(); }
  P4_CTX_ = ctx;
  return ctx;
}

// ============================================================================
// 4. Telegram identity
// ============================================================================
// Fresh read of that Students row. A teacher ctx (via "telegram") only for role teacher + non-empty scope, else null.
function p4_ctxForPhone(phone) {
  try {
    var S = p4_readStudents_();
    var tr = p4_teacherRow_(S, phone);
    if (!tr) return null;
    return { kind: "teacher", via: "telegram", id: tr.id, subjects: tr.scope.slice(), principal: tr.id };
  } catch (e) { return null; }
}

// ============================================================================
// 5. The action table (contract section 5)
// ============================================================================
// Row: {rule, needs, link, tok, ses, filter, L, Lsoft, St, G, opt, any, res, payIf}
//   rule   PUB pass-through | O owner only | T teacher only | LW LF SP GP GC PAY SF LINK ALLOW (teacher or scoped assistant, via needs)
//   needs  checks that must all hold: LW lesson in scope, SP student owned, GP group owned, GC group own/free, PAY payment in scope
//   L / St / G  payload fields the checks read ("items[].phone" = field of every list item)
//   Lsoft  extra lesson fields, checked only when they name a known subject (a bare slug is accepted)
//   opt    needs whose fields may be absent (then skipped); any: at least one of the optional needs must have a value
//   res    "attachment" | "written": the file or the stored answer decides lesson (and student), not the request
//   payIf  when payload.payment_id is present the handler ignores the other fields, so only PAY is checked
//   link   a student by phone is being added to the teacher's scope (that student need not be owned yet)
//   tok / ses  allowed callers: desktop token, dashboard session
var P4_ACTIONS = (function () {
  var t = {};
  function add(names, row) {
    String(names).split(/\s+/).forEach(function (n) {
      if (!n) return;
      var r = {};
      Object.keys(row).forEach(function (k) { r[k] = row[k]; });
      t[n] = r;
    });
  }
  // Attachments (desktop token only)
  add("upload_attachment", { rule: "LW", needs: ["LW"], L: ["subject"], Lsoft: ["lesson"], tok: true });
  add("delete_attachment", { rule: "LW", needs: ["LW"], res: "attachment", tok: true });
  // Videos
  add("admin_set_video", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true, ses: true });
  add("admin_list_videos", { rule: "LF", needs: [], tok: true, ses: true, filter: "p4f_admin_list_videos" });
  // Quiz content and written models
  add("admin_set_quiz_content admin_get_quiz_content admin_set_written_models", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true });
  add("admin_get_written_models", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true, ses: true });
  // Locks and tags (dashboard)
  add("admin_set_lesson_lock admin_set_quiz_lock admin_set_lesson_tags", { rule: "LW", needs: ["LW"], L: ["lesson"], ses: true });
  add("admin_list_lesson_tags", { rule: "LF", needs: [], ses: true, filter: "p4f_admin_list_lesson_tags" });
  add("admin_list_lessons", { rule: "LF", needs: [], ses: true, filter: "p4f_admin_list_lessons" });
  add("admin_set_requirement", { rule: "LW", needs: ["LW", "GP"], L: ["lesson"], G: ["group"], opt: ["GP"], ses: true });
  // Access grants. The student being added need not be owned yet (LINK); the response is cut to {ok, registered} by S3.
  add("admin_grant_access", { rule: "LW", needs: ["LW"], L: ["scope"], link: true, ses: true, filter: "p4f_admin_grant_access" });
  add("admin_grant_quiz_access", { rule: "LW", needs: ["LW"], L: ["lesson"], link: true, ses: true, filter: "p4f_admin_grant_quiz_access" });
  add("admin_revoke_access", { rule: "LW", needs: ["LW", "SP"], L: ["scope"], St: ["phone"], payIf: true, ses: true });
  add("admin_revoke_quiz_access", { rule: "LW", needs: ["LW", "SP"], L: ["lesson"], St: ["phone"], ses: true });
  // Groups
  add("admin_group_add", { rule: "GC", needs: ["GC"], G: ["group"], link: true, ses: true, filter: "p4f_admin_group_add" });
  add("admin_group_remove", { rule: "GP", needs: ["GP"], G: ["group"], ses: true });
  add("admin_group_grant_access admin_group_revoke_access", { rule: "LW", needs: ["LW", "GP"], L: ["scope"], G: ["group"], ses: true });
  add("admin_group_grant_quiz_access admin_group_revoke_quiz_access", { rule: "LW", needs: ["LW", "GP"], L: ["lesson"], G: ["group"], ses: true });
  // Lists filtered by student ownership (S3)
  add("admin_list_groups", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_groups" });
  add("admin_get_all", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_get_all" });
  add("admin_access_overview", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_access_overview" });
  add("admin_list_payments", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_payments" });
  add("admin_followup_overview", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_followup_overview" });
  add("admin_list_parent_notifications", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_parent_notifications" });
  add("admin_grading_queue", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_grading_queue" });
  // Payments
  add("admin_decide_payment", { rule: "PAY", needs: ["PAY"], ses: true });
  // Follow-up
  add("admin_followup_set_attendance", { rule: "SP", needs: ["SP", "GP"], St: ["items[].phone"], G: ["group"], opt: ["GP"], ses: true });
  add("admin_followup_save_group", { rule: "GP", needs: ["GP"], G: ["group"], ses: true });
  // FU2 (integration): "reminder sent" / "advance done" on the follow-up page, same scope as saving that group. The other
  // admin_fu2_* and admin_req_* actions are deliberately NOT listed: they stay owner + owner-assistant only (deny by default).
  add("admin_fu2_mark_done", { rule: "GP", needs: ["GP"], G: ["group"], ses: true });
  add("admin_followup_save_templates", { rule: "ALLOW", needs: [], ses: true });
  add("admin_student_summary", { rule: "SP", needs: ["SP"], St: ["student"], ses: true, filter: "p4f_admin_student_summary" });
  add("admin_monthly_review", { rule: "SP", needs: ["SP", "GP"], St: ["student"], G: ["group"], opt: ["SP", "GP"], any: true, ses: true, filter: "p4f_admin_monthly_review" });
  add("admin_log_parent_notification", { rule: "SP", needs: ["SP"], St: ["student"], ses: true });
  // Written answers: the stored answer decides the student and the lesson
  add("admin_grade_written get_written_image", { rule: "SP", needs: ["SP", "LW"], res: "written", ses: true });
  // Owner only
  add("admin_migrate_lesson_keys p3_admin_set_role p3_admin_backfill_submission", { rule: "O", needs: [] });
  add("p3_admin_bulk_preview p3_admin_bulk_grant p3_admin_bulk_revoke", { rule: "O", needs: [] });
  // Not in the contract table, but in the router and under the p3_admin_ prefix: owner only (see handoff).
  add("p3_admin_list_staff p3_admin_diagnose_submissions p3_admin_restore_submissions p3_admin_flag_status", { rule: "O", needs: [] });
  add("p4_admin_set_teacher p4_admin_list_teachers p4_admin_set_group_owner p4_admin_tg_unlink p4_admin_list_edit_log p4_admin_teacher_stats", { rule: "O", needs: [] });
  // New teacher-side actions
  add("p4_teacher_update_student", { rule: "T", needs: ["SP"], St: ["student"], ses: true });
  add("p4_teacher_set_assistant p4_teacher_list_assistants p4_teacher_revoke_assistant", { rule: "T", needs: [], ses: true });
  add("p4_tg_link_start p4_tg_status p4_tg_unlink", { rule: "T", needs: [], ses: true });
  // Public (student or open) actions, listed explicitly
  add("ping", { rule: "PUB", needs: [], tok: true });
  add("p4_session_scope", { rule: "PUB", needs: [] });
  add("check_student register_student login_student reset_password update_profile get_my_results get_video get_quiz get_quiz_review get_quiz_state " +
      "get_subscription_options record_watch request_access request_subscription upload_submission upload_quiz_result upload_written_image p3_session_role",
      { rule: "PUB", needs: [] });
  return t;
})();

// A16: a scoped assistant is never allowed these, plus every p4_ action.
var P4_ASSISTANT_DENY = ["admin_decide_payment", "admin_list_payments", "admin_followup_save_templates"].concat(
  Object.keys(P4_ACTIONS).filter(function (a) { return a.indexOf("p4_") === 0; }));

function p4_rowFor_(action) {
  action = String(action == null ? "" : action);
  return Object.prototype.hasOwnProperty.call(P4_ACTIONS, action) ? P4_ACTIONS[action] : null;
}

function p4_adminish_(action) {
  return /^(admin_|p3_admin_|p4_admin_)/.test(action) || action === "upload_attachment" || action === "delete_attachment";
}

function p4_isScoped_(ctx) {
  return !!ctx && (ctx.kind === "teacher" || (ctx.kind === "assistant" && !!ctx.principal));
}

// ============================================================================
// 6. The gate
// ============================================================================
// Reads a payload value as text. Only strings and finite numbers are usable; anything else is null (= deny).
function p4_str_(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}

// Collects the values behind field specs. {vals:[text], bad:bool}. A scalar field that is absent or blank adds nothing;
// "list[].field": every item must be an object carrying the field (otherwise bad).
function p4_gather_(payload, specs) {
  var out = { vals: [], bad: false };
  (specs || []).forEach(function (spec) {
    var at = spec.indexOf("[].");
    if (at === -1) {
      var v = payload[spec];
      if (v === undefined || v === null || v === "") return;
      var s = p4_str_(v);
      if (s === null) { out.bad = true; return; }
      if (s !== "") out.vals.push(s);
      return;
    }
    var listName = spec.slice(0, at), field = spec.slice(at + 3), list = payload[listName];
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) { out.bad = true; return; }
    list.forEach(function (it) {
      var s2 = (it && typeof it === "object") ? p4_str_(it[field]) : null;
      if (s2 === null || s2 === "") out.bad = true; else out.vals.push(s2);
    });
  });
  return out;
}

// The stored written answer behind {submission_id, question_id}: {students:[phone], lessons:[lesson]} or null.
function p4_resolveWritten_(payload, matchStudent) {
  var sid = String(payload.submission_id == null ? "" : payload.submission_id).trim();
  var qid = String(payload.question_id == null ? "" : payload.question_id).trim();
  if (!sid || !qid) return null;
  var sh = _dataSs().getSheetByName("WrittenAnswers");
  if (!sh || sh.getLastRow() < 2) return null;
  var hit = null;
  _sheetValuesAsObjects(sh).forEach(function (r) {
    if (hit) return;
    if (String(r.submission_id).trim() !== sid || String(r.question_id).trim() !== qid) return;
    if (matchStudent && payload.student && !_phonesMatch(r.student_id, payload.student)) return;
    hit = r;
  });
  if (!hit || !String(hit.student_id == null ? "" : hit.student_id).trim() || !String(hit.lesson == null ? "" : hit.lesson).trim()) return null;
  return { students: [String(hit.student_id).trim()], lessons: [String(hit.lesson).trim()] };
}

// One need against the caller. Returns true, false, or "skip" (optional and absent).
function p4_needHolds_(need, ctx, payload, row, res) {
  if (need === "PAY") {
    var pay = p4_global_("p4_paymentInScope");
    return typeof pay === "function" ? !!pay(ctx, payload) : false;
  }
  var specs = need === "LW" ? row.L : need === "SP" ? row.St : (need === "GP" || need === "GC") ? row.G : null;
  if (!specs && !res) return false;
  var g = p4_gather_(payload, specs);
  if (res) {
    var extra = need === "LW" ? res.lessons : need === "SP" ? res.students : null;
    (extra || []).forEach(function (x) { g.vals.push(x); });
  }
  if (g.bad) return false;
  var optional = (row.opt || []).indexOf(need) !== -1;
  if (!g.vals.length) return optional ? "skip" : false;

  var fn;
  for (var i = 0; i < g.vals.length; i++) {
    var v = g.vals[i];
    if (need === "LW") {
      if (!p4_teacherCovers(ctx, v)) return false;
    } else if (need === "SP") {
      fn = p4_global_("p4_ownsStudent");
      if (typeof fn !== "function" || !fn(ctx, v)) return false;
    } else if (need === "GP") {
      fn = p4_global_("p4_ownsGroup");
      if (typeof fn !== "function" || !fn(ctx, v)) return false;
    } else if (need === "GC") {
      fn = p4_global_("p4_groupState");
      if (typeof fn !== "function") return false;
      var st = fn(ctx, v);
      if (st !== "own" && st !== "free") return false;
    } else {
      return false;
    }
  }
  if (need === "LW" && row.Lsoft) {
    var soft = p4_gather_(payload, row.Lsoft);
    if (soft.bad) return false;
    for (var k = 0; k < soft.vals.length; k++) {
      var sj = p4_subjectOf(soft.vals[k]);
      if (sj && !p4_teacherCovers(ctx, soft.vals[k])) return false;
    }
  }
  return true;
}

// The decision for an already-resolved ctx. {} = continue, {deny} = refuse. Throws are caught by p4_gate.
function p4_decide_(ctx, payload) {
  var action = String(payload.action == null ? "" : payload.action);
  var row = p4_rowFor_(action);
  if (!row && !p4_adminish_(action)) return {};            // unknown, not admin-ish: the router decides
  if (row && row.rule === "PUB") return {};
  if (ctx.kind === "owner") return {};
  if (!p4_isScoped_(ctx)) return {};                        // legacy assistants, students, anon: existing checks, unchanged
  var DENY = { deny: p4_deny_() };
  if (!row) return DENY;                                    // admin-ish and not in the table
  if (row.rule === "O") return DENY;
  if (row.rule === "T" && ctx.kind !== "teacher") return DENY;
  if (ctx.kind === "assistant") {
    var allow = p4_global_("P3_STAFF_ALLOW");
    if (!Array.isArray(allow) || allow.indexOf(action) === -1) return DENY;
    if (P4_ASSISTANT_DENY.indexOf(action) !== -1) return DENY;
  }
  if (ctx.via === "token" && !row.tok) return DENY;
  if (ctx.via === "session" && !row.ses) return DENY;
  if (ctx.via !== "token" && ctx.via !== "session") return DENY;

  var needs = row.needs || [];
  if (row.payIf && String(payload.payment_id == null ? "" : payload.payment_id).trim()) needs = ["PAY"];
  var res = null;
  if (row.res === "attachment") res = p4_resolveAttachment_(payload);
  else if (row.res === "written") res = p4_resolveWritten_(payload, action === "admin_grade_written");
  if (row.res && !res) return DENY;

  var sawValue = false;
  for (var i = 0; i < needs.length; i++) {
    if (row.link && needs[i] === "SP") continue;            // the student being added need not be owned yet
    var ok = p4_needHolds_(needs[i], ctx, payload, row, res);
    if (ok === false) return DENY;
    if (ok === true) sawValue = true;
  }
  if (row.any && !sawValue) return DENY;
  return {};
}

function p4_gate(payload) {
  P4_GATE_RAN_ = false;
  P4_CTX_ = null;
  payload = payload || {};
  var ctx = p4_ctx(payload), out;
  try {
    out = p4_decide_(ctx, payload);
  } catch (e) {
    p4_log_("gate error on " + payload.action + ": " + (e && e.message));
    out = p4_isScoped_(ctx) || ctx.kind === "owner" ? { deny: p4_deny_() } : {};   // anyone else has no extra rights to protect
    if (out.deny) return out;
  }
  P4_GATE_RAN_ = !out.deny;
  return out;
}

// ============================================================================
// 7. Coverage, response filters and the two hooks
// ============================================================================
function p4_teacherCovers(ctx, keyOrSubject) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_isScoped_(ctx)) return false;
  var s = p4_subjectOf(keyOrSubject);
  return !!s && (ctx.subjects || []).indexOf(s) !== -1;
}

// Called by the router for every action with a filter (H4). Teachers and scoped assistants only; a missing filter fails closed.
function p4_filter(resp, payload) {
  var ctx = (P4_GATE_RAN_ && P4_CTX_) ? P4_CTX_ : p4_ctx(payload);
  if (!p4_isScoped_(ctx)) return resp;
  if (!resp || typeof resp !== "object" || resp.ok === false) return resp;
  var row = p4_rowFor_(payload && payload.action);
  if (!row || !row.filter) return resp;
  var fn = p4_global_(row.filter);
  if (typeof fn !== "function") { p4_log_("missing filter " + row.filter); return p4_deny_(); }
  try { return fn(resp, ctx, payload); } catch (e) { p4_log_("filter error " + row.filter + ": " + (e && e.message)); return p4_deny_(); }
}

// H1: a valid teacher token on an action whose row allows tokens. Never before the gate ran in this request.
function p4_tokenAllows(payload) {
  if (!P4_GATE_RAN_ || !P4_CTX_ || !payload) return false;
  if (P4_CTX_.kind !== "teacher" || P4_CTX_.via !== "token") return false;
  var t = p4_findTeacherToken_(payload.token);
  if (!t || t.name !== P4_CTX_.id) return false;
  var row = p4_rowFor_(payload.action);
  return !!row && !!row.tok && row.rule !== "O" && row.rule !== "T";
}

// H2: `row` is the caller's Students row (already matched on phone and session token), `c` the column map.
function p4_teacherAllows(row, c, payload) {
  if (!P4_GATE_RAN_ || !P4_CTX_ || !payload || !row || !c) return false;
  var ctx = P4_CTX_;
  if (ctx.kind !== "teacher" || ctx.via !== "session") return false;
  if (!_phonesMatch(row[c.phone - 1], ctx.id)) return false;
  if (String(row[c.session_token - 1]) !== String(payload.session_token)) return false;
  if (!c.role || String(row[c.role - 1] == null ? "" : row[c.role - 1]).trim().toLowerCase() !== "teacher") return false;
  var r = p4_rowFor_(payload.action);
  return !!r && !!r.ses && r.rule !== "O";
}

// ============================================================================
// 8. delete_attachment: resolve the file to its subject
// ============================================================================
// Files are stored as <subject>--<lesson>--<id>--<name> inside ATTACHMENTS_FOLDER_ID. The file must really sit in that folder,
// and its name must start with a subject slug. Anything else cannot be resolved.
function p4_resolveAttachment_(payload) {
  var id = payload.file_id;
  if (typeof id !== "string" || !id.trim()) return null;
  try {
    var folderId = _props().getProperty("ATTACHMENTS_FOLDER_ID");
    if (!folderId) return null;
    var f = DriveApp.getFileById(id.trim()), inFolder = false, parents = f.getParents();
    while (parents.hasNext()) { if (parents.next().getId() === folderId) inFolder = true; }
    if (!inFolder) return null;
    var parts = String(f.getName()).split("--");
    if (parts.length < 4 || !p4_subjectOf(parts[0])) return null;
    var lessons = [parts[0]];
    var lead = parts[1].split("-")[0];
    if (p4_subjectOf(lead)) lessons.push(lead);              // the lesson part names a subject too: it must be covered as well
    return { lessons: lessons, students: [] };
  } catch (e) { return null; }
}

// ============================================================================
// 9. Lesson filters (teachers and scoped assistants keep only rows of their subjects; unrecognised rows are dropped)
// ============================================================================
function p4_keepLessonRow_(ctx, it) {
  if (typeof it === "string") return p4_teacherCovers(ctx, it);
  if (!it || typeof it !== "object") return false;
  var keys = ["lesson", "lesson_key", "scope", "track"];
  for (var i = 0; i < keys.length; i++) {
    if (typeof it[keys[i]] === "string") return p4_teacherCovers(ctx, it[keys[i]]);
  }
  return false;
}

function p4_filterLessonLists_(resp, ctx) {
  var out = {};
  Object.keys(resp).forEach(function (k) {
    var v = resp[k];
    if (Array.isArray(v)) {
      var kept = v.filter(function (it) { return p4_keepLessonRow_(ctx, it); });
      if (kept.length !== v.length) p4_log_("filter dropped " + (v.length - kept.length) + " of " + v.length + " in " + k);
      out[k] = kept;
    } else out[k] = v;
  });
  return out;
}

function p4f_admin_list_videos(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }
function p4f_admin_list_lessons(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }
function p4f_admin_list_lesson_tags(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }

// ============================================================================
// 10. Session scope and ping
// ============================================================================
// Router action p4_session_scope: the dashboard asks "what am I?". Never throws, never reveals more than the caller's own role.
function p4_session_scope(payload) {
  var ctx = p4_ctx(payload);
  var role = ctx.kind === "owner" ? "admin" : ctx.kind === "anon" ? "none" : ctx.kind;
  var out = { ok: true, role: role, kind: ctx.kind, scope: ctx.kind === "owner" ? ["*"] : (ctx.subjects || []).slice() };
  if (ctx.kind === "assistant" && ctx.principal) {
    try {
      var S = p4_readStudents_(), i = p4_findRow_(S, ctx.principal);
      out.principal_name = i < 0 ? "" : String(p4_cell_(S, i, "display_name") == null ? "" : p4_cell_(S, i, "display_name"));
    } catch (e) { out.principal_name = ""; }
  }
  return out;
}

// Decorates the token ping with who the token belongs to. Signature fits _p2Post(name, resp, payload).
function p4_pingDecorate(resp, payload) {
  try {
    if (!resp || typeof resp !== "object") return resp;
    var ctx = p4_ctx(payload);                               // ping carries only a token: no sheet read unless a teacher name is looked up
    resp.kind = ctx.kind;
    resp.subjects = (ctx.subjects || []).slice();
    resp.name = ctx.kind === "teacher" ? ctx.id : (ctx.kind === "owner" ? "owner" : "");
  } catch (e) { /* the ping itself still works */ }
  return resp;
}

// ============================================================================
// 11. Self test (editor only): Run > p4_selfTest, then read the log. Pure checks, then the other P4 files' own tests.
// ============================================================================
function p4_selfTest() {
  var fails = [], n = 0;
  function t(name, cond) { n++; if (!cond) fails.push(name); }
  function owner() { return { kind: "owner", via: "session", id: "o", subjects: ["*"], principal: "" }; }
  function teacher(via) { return { kind: "teacher", via: via || "session", id: "t", subjects: ["math"], principal: "t" }; }
  function assistant() { return { kind: "assistant", via: "session", id: "a", subjects: ["math"], principal: "t" }; }
  function legacy() { return { kind: "assistant", via: "session", id: "l", subjects: [], principal: "" }; }
  function denied(ctx, payload) { var r = p4_decide_(ctx, payload); return !!(r && r.deny && r.deny.ok === false && r.deny.error === "Not authorized."); }

  t("subjectOf math key", p4_subjectOf("math/sat/lesson-1") === "math");
  t("subjectOf scope #ch2", p4_subjectOf("programming/baccalaureate/grade-2-secondary#ch2") === "programming");
  t("subjectOf junk", p4_subjectOf("") === "" && p4_subjectOf(null) === "" && p4_subjectOf(["math"]) === "" && p4_subjectOf("art/x") === "" && p4_subjectOf("math/../programming/x") === "");
  t("subjectOf backslash and leading slash", p4_subjectOf("/Math\\sat") === "math");
  t("parseScope", JSON.stringify(p4_parseScope_(" Math, programming,x,*,math")) === JSON.stringify(["math", "programming"]));
  t("sha256 abc", p4_hashToken_("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  t("safeEq", p4_safeEq_("abc", "abc") && !p4_safeEq_("abc", "abd") && !p4_safeEq_("abc", "abcd"));
  Object.keys(P4_ACTIONS).forEach(function (a) {
    var r = P4_ACTIONS[a];
    t("row valid " + a, ["PUB", "O", "T", "ALLOW", "LW", "LF", "SP", "GP", "GC", "PAY", "SF"].indexOf(r.rule) !== -1 && Array.isArray(r.needs));
    if (r.rule === "O") t("O row has no via " + a, !r.tok && !r.ses);
  });
  t("assistant deny list has p4_ rows", P4_ASSISTANT_DENY.indexOf("p4_tg_status") !== -1 && P4_ASSISTANT_DENY.indexOf("admin_decide_payment") !== -1);
  t("owner passes O", !denied(owner(), { action: "p3_admin_set_role" }));
  t("teacher denied O", denied(teacher(), { action: "p3_admin_set_role" }));
  t("assistant denied T", denied(assistant(), { action: "p4_tg_status" }));
  t("PUB passes teacher", !denied(teacher(), { action: "check_student" }));
  t("unknown admin_x denied for teacher", denied(teacher(), { action: "admin_nope" }));
  t("unknown plain action passes", !denied(teacher(), { action: "something_new" }));
  t("student and legacy assistant fall through", !denied({ kind: "student", via: "session", id: "s", subjects: [], principal: "" }, { action: "admin_get_all" }) && !denied(legacy(), { action: "admin_get_all" }));
  t("token on a session-only row denied", denied(teacher("token"), { action: "admin_set_lesson_lock", lesson: "math/x" }));
  t("session on a token-only row denied", denied(teacher("session"), { action: "upload_attachment", subject: "math", lesson: "x" }));
  t("covered lesson passes", !denied(teacher(), { action: "admin_set_lesson_lock", lesson: "math/sat/x" }));
  t("foreign lesson denied", denied(teacher(), { action: "admin_set_lesson_lock", lesson: "programming/x/y" }));
  t("missing lesson denied", denied(teacher(), { action: "admin_set_lesson_lock" }));
  t("array lesson denied", denied(teacher(), { action: "admin_set_lesson_lock", lesson: ["math/x"] }));
  t("covers: owner/teacher/legacy", p4_teacherCovers(owner(), "programming/x") && p4_teacherCovers(teacher(), "math/x") && !p4_teacherCovers(teacher(), "english/x") && !p4_teacherCovers(legacy(), "math/x"));
  P4_GATE_RAN_ = false;
  t("fail closed without gate", p4_tokenAllows({ token: "x", action: "ping" }) === false && p4_teacherAllows([], {}, { action: "admin_set_video" }) === false);

  var msg = fails.length ? "FAIL (" + fails.length + " of " + n + "): " + fails.join("; ") : "ALL PASS (" + n + " checks)";
  p4_log_(msg);
  var ok = !fails.length;
  ["p4_selfTest_people", "p4_selfTest_team", "p4_selfTest_tg"].forEach(function (name) {
    var f = p4_global_(name);
    if (typeof f !== "function") return;
    var r;
    try { r = f(); } catch (e) { r = "FAIL: threw " + (e && e.message); }
    var good = r === true || (typeof r === "string" && r.indexOf("ALL PASS") !== -1);
    p4_log_(name + ": " + (good ? "ALL PASS" : String(r)));
    if (!good) { ok = false; msg += " | " + name + " failed"; }
  });
  p4_log_(ok ? "ALL PASS" : "NOT ALL PASS: " + msg);
  return ok ? "ALL PASS" : msg;
}
// ===== END MERGED FROM Phase4_Scope.gs =====

// ============================================================================
// ===== MERGED FROM Phase4_People.gs =====
// ============================================================================
// =====================================================================================
// Phase 4 / S3 - people and money: student ownership, response filters, group ownership,
// payment scope, per-owner follow-up templates, add-by-phone rules.
//
// Contract: Docs/02-plans/math-teacher-sessions/00-MASTER-CONTRACT.md (v2), sections 2, 4, 5, 6.
// Paste into Apps Script as its own file, or let scripts/p4_wire.py --merge append it to Code.gs.
// Depends on Phase4_Scope.gs only through: p4_subjectOf(keyOrScope), and (optionally) p4_ctx(payload).
// Every p4f_* filter is a no-op unless the caller is a teacher or a SCOPED assistant, so the owner
// and the owner's own (unscoped) assistants see exactly what they saw before.
// Refusal text is always: {ok:false, error:"Not authorized."}.
// =====================================================================================

var P4_LOOKUPS_PER_HOUR = 30;                                   // contract A4 / A17 (one bucket per principal)
var P4_GROUPOWNER_HEADERS = ["group", "owner_id", "created_at"];
var P4_PC_ = { key: "", set: null, owners: null };               // per-request cache, keyed by principal + subjects (an assistant shares his teacher's)
var P4_GSTATE_ = {};                                             // "<principalKey>|<groupKey>" -> own|free|foreign (state at gate time)

function p4_resetCache_() { P4_PC_ = { key: "", set: null, owners: null }; P4_GSTATE_ = {}; }

// ---- small helpers --------------------------------------------------------------------

// Canonical comparison key for an id: a phone becomes its last 10 digits, anything else is lower-cased text.
function p4_idKey_(id) {
  var s = String(id == null ? "" : id).trim();
  var d = _normalizePhone(s);
  return d.length >= 10 ? d.slice(-10) : s.toLowerCase();
}

// A teacher, or an assistant who works for a teacher. Owner and the owner's own assistants are NOT scoped.
function p4_scoped_(ctx) {
  return !!ctx && (ctx.kind === "teacher" || (ctx.kind === "assistant" && !!ctx.principal));
}

function p4_principalKey_(ctx) { return p4_idKey_(ctx.principal || ctx.id); }

// Is this lesson key / scope inside the caller's subjects? Unknown subject never matches.
function p4_inSubjects_(ctx, v) {
  var subs = ctx && ctx.subjects ? ctx.subjects : [];
  if (subs.indexOf("*") >= 0) return true;
  var s = p4_subjectOf(String(v == null ? "" : v));
  return !!s && subs.indexOf(s) >= 0;
}

function p4_rows_(ss, name) {
  var sh = ss.getSheetByName(name);
  return sh && sh.getLastRow() >= 2 ? _sheetValuesAsObjects(sh) : [];
}

function p4_cacheKey_(ctx) {
  return ctx.kind === "owner" ? "owner" : p4_principalKey_(ctx) + "|" + (ctx.subjects || []).join(",");
}

// One Apps Script execution serves one request, so this lives exactly one request. Tests call p4_resetCache_().
function p4_cache_(ctx) {
  var k = p4_cacheKey_(ctx);
  if (P4_PC_.key !== k) P4_PC_ = { key: k, set: null, owners: null };
  return P4_PC_;
}

// The ctx for the request being served. Prefers the one the gate stored; falls back to p4_ctx(payload).
function p4_ctxFor_(payload) {
  try {
    if (typeof P4_GATE_RAN_ !== "undefined" && P4_GATE_RAN_ && typeof P4_CTX_ !== "undefined" && P4_CTX_) return P4_CTX_;
    return typeof p4_ctx === "function" ? p4_ctx(payload) : null;
  } catch (e) { return null; }
}

// ---- group ownership --------------------------------------------------------------------

// groupKey -> owner id key, from the GroupOwners tab. No tab / no row: the group belongs to the owner.
function p4_ownersMap_(ctx) {
  var c = p4_cache_(ctx);
  if (c.owners) return c.owners;
  var m = {};
  p4_rows_(_ss(), "GroupOwners").forEach(function (r) {
    var k = _groupKey(r.group);
    if (k && !m.hasOwnProperty(k)) m[k] = p4_idKey_(r.owner_id);
  });
  c.owners = m;
  return m;
}

function p4_ownsGroup(ctx, groupName) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var key = _groupKey(groupName);
  if (!key) return false;
  var owners = p4_ownersMap_(ctx);
  return owners.hasOwnProperty(key) && owners[key] === p4_principalKey_(ctx);
}

// own: the caller owns it. free: nobody owns it and it has no members (so it will be created for the caller).
// foreign: anything else. The answer given at gate time is remembered so the response filter can create the owner row.
function p4_groupState(ctx, groupName) {
  if (!ctx) return "foreign";
  if (ctx.kind === "owner") return "own";
  if (!p4_scoped_(ctx)) return "foreign";
  var key = _groupKey(groupName);
  if (!key) return "foreign";
  var owners = p4_ownersMap_(ctx), me = p4_principalKey_(ctx), st;
  if (owners.hasOwnProperty(key)) {
    st = owners[key] === me ? "own" : "foreign";
  } else {
    var has = false;
    p4_rows_(_ss(), "Groups").forEach(function (r) { if (!has && _groupKey(r.group) === key) has = true; });
    st = has ? "foreign" : "free";
  }
  P4_GSTATE_[me + "|" + key] = st;
  return st;
}

// ---- student linkage ("his students") ------------------------------------------------------

function p4_mark_(set, phone) { var k = _phoneKey(phone); if (k) set[k] = true; }

// phoneKey -> true for every student linked to this caller (contract section 2, four rules).
function p4_linkedSet_(ctx) {
  var c = p4_cache_(ctx);
  if (c.set) return c.set;
  var set = {};
  if (ctx.kind === "owner") {
    _sheetValuesAsObjects(_students()).forEach(function (r) { p4_mark_(set, r.phone); });
  } else if (p4_scoped_(ctx)) {
    var ss = _ss(), ds = _dataSs();
    var me = p4_principalKey_(ctx), owners = p4_ownersMap_(ctx), mine = {};
    Object.keys(owners).forEach(function (k) { if (owners[k] === me) mine[k] = true; });
    // 1. member of a group the teacher owns
    p4_rows_(ss, "Groups").forEach(function (r) { if (mine[_groupKey(r.group)]) p4_mark_(set, r.phone); });
    // 2. entitlement or quiz access for a lesson in scope
    p4_rows_(ss, "Entitlements").forEach(function (r) { if (p4_inSubjects_(ctx, r.scope)) p4_mark_(set, r.phone); });
    p4_rows_(ss, "QuizAccess").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.phone); });
    // 3. quiz result or submission for a lesson in scope
    p4_rows_(ds, "QuizResults").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.student_id); });
    p4_rows_(ds, "Submissions").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.student_id); });
    // 4. payment or subscription request for a scope in scope
    p4_rows_(ss, "Payments").forEach(function (r) { if (p4_inSubjects_(ctx, r.scope)) p4_mark_(set, r.phone); });
  }
  c.set = set;
  return set;
}

// Array of phone keys (last 10 digits) linked to the caller. Used by S8 (stats) through typeof p4_linked_.
function p4_linked_(ctx) { return ctx ? Object.keys(p4_linkedSet_(ctx)) : []; }

function p4_ownsStudent(ctx, phoneOrRow) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var ph = phoneOrRow && typeof phoneOrRow === "object"
    ? (phoneOrRow.phone || phoneOrRow.student_id || phoneOrRow.student || "") : phoneOrRow;
  var k = _phoneKey(ph);
  return !!k && p4_linkedSet_(ctx).hasOwnProperty(k);
}

// ---- payments ----------------------------------------------------------------------------

// The payment's OWN stored scope decides. A `scope` override in the request must be in the caller's subjects too.
function p4_paymentInScope(ctx, payload) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var id = String(payload && payload.payment_id != null ? payload.payment_id : "").trim();
  if (!id) return false;
  var row = null;
  p4_rows_(_ss(), "Payments").forEach(function (r) { if (!row && String(r.payment_id).trim() === id) row = r; });
  if (!row) return false;
  if (!p4_inSubjects_(ctx, row.scope)) return false;
  if (payload.scope && !p4_inSubjects_(ctx, payload.scope)) return false;
  return true;
}

// ---- generic row filtering (fail closed) ------------------------------------------------------

function p4_pick_(row, names) {
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// 1 keep, 0 drop, -1 drop because no recognised key was present.
function p4_judge_(ctx, row, rule) {
  if (!row || typeof row !== "object") return -1;
  var v;
  if (rule.student) { v = p4_pick_(row, rule.student); if (v === undefined) return -1; if (!p4_ownsStudent(ctx, v)) return 0; }
  if (rule.lesson) { v = p4_pick_(row, rule.lesson); if (v === undefined) return -1; if (!p4_inSubjects_(ctx, v)) return 0; }
  if (rule.group) { v = p4_pick_(row, rule.group); if (v === undefined) return -1; if (!p4_ownsGroup(ctx, v)) return 0; }
  return 1;
}

function p4_filterRows_(arr, ctx, rule, tag) {
  if (!Array.isArray(arr)) return [];
  var unrec = 0;
  var out = arr.filter(function (row) {
    var j = p4_judge_(ctx, row, rule);
    if (j < 0) unrec++;
    return j === 1;
  });
  if (unrec) { try { Logger.log("p4: dropped " + unrec + " unrecognised row(s) in " + tag); } catch (e) {} }
  return out;
}

// Rows that are bare lesson strings or objects (all_lessons, tracks).
function p4_filterLessonList_(arr, ctx, names, tag) {
  if (!Array.isArray(arr)) return [];
  var unrec = 0;
  var out = arr.filter(function (x) {
    if (typeof x === "string") return p4_inSubjects_(ctx, x);
    var j = p4_judge_(ctx, x, { lesson: names });
    if (j < 0) unrec++;
    return j === 1;
  });
  if (unrec) { try { Logger.log("p4: dropped " + unrec + " unrecognised row(s) in " + tag); } catch (e) {} }
  return out;
}

function p4_filterMap_(obj, keep) {
  var out = {};
  if (!obj || typeof obj !== "object") return out;
  Object.keys(obj).forEach(function (k) { if (keep(k, obj[k])) out[k] = obj[k]; });
  return out;
}

// Row belongs to the caller's subjects by the FIRST candidate field that is present (path, then subject, then lesson).
function p4_rowOk_(ctx, row, names) {
  if (!row || typeof row !== "object") return false;
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return p4_inSubjects_(ctx, v);
  }
  return false;
}

// Parent-notification entries: lesson refs in scope are kept; monthly markers are kept with the note blanked
// (a month is not tied to one subject, so its free-text note could describe another subject); the rest are dropped.
function p4_notifKeep_(ctx, n) {
  if (!n || typeof n !== "object") return false;
  var ref = String(n.ref == null ? "" : n.ref).trim();
  if (/^\d{4}-\d{2}$/.test(ref)) { n.note = ""; return true; }
  if (ref && p4_subjectOf(ref)) return p4_inSubjects_(ctx, ref);
  return false;
}

// Fail closed on shape drift: a scoped caller only receives the top-level keys listed here. A key a handler adds
// later is removed (and logged) until it has been reviewed and added to the list.
function p4_allowKeys_(resp, keys, tag) {
  if (!resp || typeof resp !== "object") return resp;
  Object.keys(resp).forEach(function (k) {
    if (keys.indexOf(k) < 0) {
      delete resp[k];
      try { Logger.log("p4: removed unexpected key '" + k + "' from " + tag); } catch (e) {}
    }
  });
  return resp;
}

// ---- filters (names fixed by the contract table) ---------------------------------------------

function p4f_admin_get_all(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "students", "quiz_results", "submissions"], "get_all");
  resp.students = p4_filterRows_(resp.students, ctx, { student: ["phone"] }, "get_all.students");
  resp.quiz_results = p4_filterRows_(resp.quiz_results, ctx, { student: ["student_id"], lesson: ["lesson"] }, "get_all.quiz_results");
  resp.submissions = p4_filterRows_(resp.submissions, ctx, { student: ["student_id"], lesson: ["lesson"] }, "get_all.submissions");
  return resp;
}

function p4f_admin_access_overview(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "today", "counts", "videos", "quizzes", "groups", "roster", "payments", "access", "all_lessons", "tracks", "lessons_error", "quiz_access", "lesson_locks", "year_ends"], "access_overview");
  resp.roster = p4_filterRows_(resp.roster, ctx, { student: ["phone"] }, "overview.roster");
  resp.videos = p4_filterRows_(resp.videos, ctx, { lesson: ["lesson"] }, "overview.videos");
  resp.quizzes = p4_filterRows_(resp.quizzes, ctx, { lesson: ["lesson"] }, "overview.quizzes");
  resp.lesson_locks = p4_filterRows_(resp.lesson_locks, ctx, { lesson: ["lesson"] }, "overview.lesson_locks");
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "overview.groups");
  resp.payments = p4_filterRows_(resp.payments, ctx, { lesson: ["scope"] }, "overview.payments");
  resp.access = p4_filterRows_(resp.access, ctx, { student: ["phone"], lesson: ["scope"] }, "overview.access");
  resp.quiz_access = p4_filterRows_(resp.quiz_access, ctx, { student: ["phone"], lesson: ["lesson"] }, "overview.quiz_access");
  resp.all_lessons = p4_filterLessonList_(resp.all_lessons, ctx, ["lesson", "path"], "overview.all_lessons");
  resp.tracks = p4_filterLessonList_(resp.tracks, ctx, ["path", "track", "folder", "name"], "overview.tracks");
  // Recompute the counts from what is left; any count that cannot be recomputed is removed.
  var old = resp.counts || {}, n = {};
  var has = function (k) { return Object.prototype.hasOwnProperty.call(old, k); };
  ["pending", "active", "ending_soon", "expired", "cancelled", "invalid", "videos_locked", "videos_open", "quizzes_locked", "lessons_locked", "groups"]
    .forEach(function (k) { if (has(k)) n[k] = 0; });
  var inc = function (k) { if (n.hasOwnProperty(k)) n[k]++; };
  resp.payments.forEach(function (p) { if (p.status === "pending") inc("pending"); });
  resp.access.forEach(function (a) {
    if (n.hasOwnProperty(a.state)) n[a.state]++;
    if (a.state === "active" && a.days_left !== null && a.days_left !== undefined && a.days_left <= 7) inc("ending_soon");
  });
  resp.videos.forEach(function (v) { inc(v.locked ? "videos_locked" : "videos_open"); });
  resp.quizzes.forEach(function (q) { if (q.locked) inc("quizzes_locked"); });
  resp.lesson_locks.forEach(function (l) { if (l.locked) inc("lessons_locked"); });
  if (n.hasOwnProperty("groups")) n.groups = resp.groups.length;
  resp.counts = n;
  return resp;
}

function p4f_admin_list_payments(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "payments"], "list_payments");
  resp.payments = p4_filterRows_(resp.payments, ctx, { lesson: ["scope"] }, "list_payments");
  return resp;
}

function p4f_admin_list_groups(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "groups"], "list_groups");
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "list_groups");
  return resp;
}

function p4f_admin_followup_overview(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "today", "now", "settings", "groups", "unclassified", "students", "lessons", "all_lessons", "lessons_error", "slug_collisions", "join_mismatches", "facts", "templates", "flags", "week", "requirements", "parent_log", "tz_label", "unclassified_requirements"], "followup_overview");   // FU2: tz_label = "Alex"; unclassified_requirements = global policy, no student data
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "followup.groups");
  resp.unclassified = p4_filterRows_(resp.unclassified, ctx, { student: ["phone"] }, "followup.unclassified");
  resp.students = p4_filterMap_(resp.students, function (k, v) { return p4_ownsStudent(ctx, v && v.phone ? v.phone : k); });
  resp.facts = p4_filterMap_(resp.facts, function (k) { return p4_ownsStudent(ctx, k); });
  Object.keys(resp.facts).forEach(function (k) {
    resp.facts[k] = p4_filterMap_(resp.facts[k], function (lesson) { return p4_inSubjects_(ctx, lesson); });
  });
  resp.lessons = p4_filterMap_(resp.lessons, function (k) { return p4_inSubjects_(ctx, k); });
  resp.all_lessons = p4_filterRows_(resp.all_lessons, ctx, { lesson: ["path"] }, "followup.all_lessons");
  resp.requirements = p4_filterMap_(resp.requirements, function (k) { return p4_inSubjects_(ctx, k); });
  resp.parent_log = p4_filterMap_(resp.parent_log, function (k) { return p4_ownsStudent(ctx, k); });
  Object.keys(resp.parent_log).forEach(function (k) {
    resp.parent_log[k] = (resp.parent_log[k] || []).filter(function (n) { return p4_notifKeep_(ctx, n); });
  });
  resp.slug_collisions = [];     // lists lessons and rows across all subjects; not filterable safely
  resp.join_mismatches = [];     // carries student rows across all subjects
  return resp;
}

// Shared by the summary and the monthly review. Filters every list to the caller's subjects and recomputes the totals.
function p4_summaryFilter_(s, ctx) {
  if (!s || typeof s !== "object") return s;
  // FU2 x P4 (integration): summary.requirements (FollowupRouter.gs) counts lessons of EVERY subject and cannot be recomputed
  // from the filtered lists here, so a scoped caller gets none (fail closed, like p4f_admin_student_summary's key list).
  if (s.requirements !== undefined) { delete s.requirements; s.requirements_unavailable = true; }
  delete s.requirements_snapshot;
  var lk = ["path", "subject", "lesson"];
  var okL = function (names) { return function (r) { return p4_rowOk_(ctx, r, names); }; };
  var arr = function (x) { return Array.isArray(x) ? x : []; };
  s.quizzes = arr(s.quizzes).filter(okL(lk));
  s.homework = arr(s.homework).filter(okL(lk));
  s.expected = arr(s.expected).filter(okL(["lesson"]));
  s.attendance = arr(s.attendance).filter(okL(["lesson"]));
  s.watch = arr(s.watch).filter(okL(["lesson"]));
  s.video_access = arr(s.video_access).filter(okL(["lesson"]));
  s.groups = arr(s.groups).filter(function (g) { return p4_ownsGroup(ctx, g && g.group); });
  s.notifications = arr(s.notifications).filter(function (n) { return p4_notifKeep_(ctx, n); });
  var items = arr(s.written && s.written.items).filter(okL(["lesson"]));
  var w = { pending: 0, graded: 0, awarded: 0, max: 0, items: items };
  items.forEach(function (i) {
    if (i.graded) {
      w.graded++;
      if (i.awarded !== null && i.awarded !== undefined) w.awarded += i.awarded;
      if (i.max !== null && i.max !== undefined) w.max += i.max;
    } else w.pending++;
  });
  s.written = w;
  var rnd = typeof _p2fuRound === "function" ? _p2fuRound : function (n) { return n === null ? null : Math.round(n * 100) / 100; };
  var avg = function (xs) { return xs.length ? rnd(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length) : null; };
  var pcts = s.quizzes.filter(function (q) { return q.pct !== null && q.pct !== undefined; }).map(function (q) { return q.pct; });
  var center = s.attendance.filter(function (a) { return a.mode === "center"; }).length;
  var req = function (list, kind) { return list.filter(function (e) { return e[kind] && e[kind].required; }).length; };
  var missed = function (list, kind) { return list.filter(function (e) { return e[kind] && e[kind].missed; }).length; };
  s.totals = {
    quiz_count: s.quizzes.length, quiz_avg_pct: avg(pcts),
    quiz_required: req(s.expected, "quiz"), quiz_missed: missed(s.expected, "quiz"),
    homework_count: s.homework.length,
    homework_required: req(s.expected, "homework"), homework_missed: missed(s.expected, "homework"),
    attendance_center: center, attendance_online: s.attendance.length - center,
    watch_avg_pct: avg(s.watch.map(function (x) { return x.pct; }).filter(function (x) { return x !== null && x !== undefined; })),
    written_pending: w.pending, written_graded: w.graded
  };
  return s;
}

var P4_NOT_AUTH_ = { ok: false, error: "Not authorized." };
function p4_notAuth_() { return { ok: P4_NOT_AUTH_.ok, error: P4_NOT_AUTH_.error }; }

function p4f_admin_student_summary(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  if (!resp.student || !p4_ownsStudent(ctx, resp.student.phone)) return p4_notAuth_();
  p4_allowKeys_(resp, ["ok", "student", "groups", "range", "totals", "quizzes", "homework", "expected", "attendance", "watch", "video_access", "written", "notifications", "lessons_error"], "student_summary");
  return p4_summaryFilter_(resp, ctx);
}

function p4f_admin_monthly_review(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "month", "range", "closed", "reviews", "review"], "monthly_review");
  if (Array.isArray(resp.reviews)) {
    resp.reviews = resp.reviews.filter(function (rv) { return rv && p4_ownsStudent(ctx, rv.student); }).map(function (rv) {
      if (rv.summary) rv.summary = p4_summaryFilter_(rv.summary, ctx);
      if (rv.review && typeof rv.review === "object") rv.review.note = "";
      return rv;
    });
  }
  return resp;
}

function p4f_admin_list_parent_notifications(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "notifications", "not_notified"], "parent_notifications");
  resp.notifications = (Array.isArray(resp.notifications) ? resp.notifications : []).filter(function (n) {
    return n && p4_ownsStudent(ctx, n.student) && p4_notifKeep_(ctx, n);
  });
  if (Array.isArray(resp.not_notified)) {
    resp.not_notified = resp.not_notified.filter(function (p) { return p4_ownsStudent(ctx, p); });
  }
  return resp;
}

function p4_gradingCounts_(ctx) {
  try {
    var sh = _gAnswersSheet(), pending = 0, graded = 0;
    if (sh && sh.getLastRow() >= 2) {
      _sheetValuesAsObjects(sh).forEach(function (r) {
        if (!r.submission_id || !r.question_id) return;
        if (!p4_ownsStudent(ctx, r.student_id) || !p4_inSubjects_(ctx, _gCanon(r.lesson))) return;
        if (_gNum(r.awarded) !== null) graded++; else pending++;
      });
    }
    return { pending: pending, graded: graded };
  } catch (e) { return null; }
}

function p4f_admin_grading_queue(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "items", "truncated", "counts"], "grading_queue");
  resp.items = p4_filterRows_(resp.items, ctx, { student: ["student_id", "student"], lesson: ["lesson"] }, "grading_queue");
  resp.counts = p4_gradingCounts_(ctx);
  return resp;
}

// ---- add-by-phone (LINK) and group creation -------------------------------------------------------

// The A17 bucket: 30 lookups per hour per principal, shared with S5 (appointments, phone-collision checks).
// p4_lookupAllowed_(ctx[, n=1]) -> true if n more lookups fit in this hour (and counts them), false otherwise (also on any error).
// CacheService key: p4lk:<principal key>:<yyyymmddhh>
function p4_lookupAllowed_(ctx, n) {
  try {
    n = n > 0 ? n : 1;
    var cache = CacheService.getScriptCache();
    var hour = String(_fmt(new Date(), TZ, true)).slice(0, 13).replace(/[^0-9]/g, "");
    var key = "p4lk:" + p4_principalKey_(ctx) + ":" + hour;
    var cur = parseInt(cache.get(key) || "0", 10) || 0;
    if (cur + n > P4_LOOKUPS_PER_HOUR) return false;
    cache.put(key, String(cur + n), 3600);
    return true;
  } catch (e) { return false; }      // fail closed
}

function p4_registeredSet_() {
  var set = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) { p4_mark_(set, r.phone); });
  return set;
}

function p4_linkReply_(resp, ctx, phones) {
  if (!resp || resp.ok !== true) return p4_notAuth_();
  var list = phones.filter(function (p) { return _phoneKey(p) !== ""; });
  if (!p4_lookupAllowed_(ctx, Math.max(1, list.length))) return { ok: false, error: "Too many requests." };
  var reg = p4_registeredSet_(), all = list.length > 0;
  list.forEach(function (p) { if (!reg[_phoneKey(p)]) all = false; });
  return { ok: true, registered: all };
}

function p4_groupOwnerId_(ctx) {
  var id = ctx.principal || ctx.id;
  return _normalizePhone(id).length >= 10 ? _canonicalPhone(id) : String(id);
}

function p4_createGroupOwner_(ctx, groupName) {
  return _withLock(function () {
    var ss = _ss();
    var sh = _sheetByName(ss, "GroupOwners", P4_GROUPOWNER_HEADERS);
    _ensureColumns(sh, P4_GROUPOWNER_HEADERS);
    var key = _groupKey(groupName), exists = false;
    p4_rows_(ss, "GroupOwners").forEach(function (r) { if (_groupKey(r.group) === key) exists = true; });
    if (exists) return false;
    var row = _appendByHeader(sh, { group: String(groupName), owner_id: p4_groupOwnerId_(ctx), created_at: _fmt(new Date(), TZ, true) });
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var col = hdr.indexOf("owner_id") + 1;
    if (col > 0) sh.getRange(row, col).setNumberFormat("@").setValue(p4_groupOwnerId_(ctx));
    return true;
  });
}

function p4f_admin_group_add(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  var phones = Array.isArray(payload.phones) ? payload.phones : [payload.phone];
  if (resp && resp.ok === true) {
    var name = String(resp.group || payload.group || ""), key = _groupKey(name);
    var slot = p4_principalKey_(ctx) + "|" + key;
    if (key && P4_GSTATE_[slot] === "free") {            // state at gate time: nobody owned it and it had no members
      p4_createGroupOwner_(ctx, name);
      P4_GSTATE_[slot] = "own";
      p4_resetOwners_();
    }
  }
  return p4_linkReply_(resp, ctx, phones);
}

function p4_resetOwners_() { P4_PC_.owners = null; }

function p4f_admin_grant_access(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  return p4_linkReply_(resp, ctx, [payload.phone]);
}

function p4f_admin_grant_quiz_access(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  return p4_linkReply_(resp, ctx, [payload.phone]);
}

// ---- owner action: set or reset a group's owner -------------------------------------------------------

function p4_admin_set_group_owner(payload) {
  var ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null;
  if (!ctx || ctx.kind !== "owner") return p4_notAuth_();
  var group = String(payload.group == null ? "" : payload.group).trim();
  var key = _groupKey(group);
  if (!key) return { ok: false, error: "Missing group." };
  var ownerPhone = String(payload.owner_phone == null ? "" : payload.owner_phone).trim();
  return _withLock(function () {
    var ss = _ss();
    var members = p4_rows_(ss, "Groups").some(function (r) { return _groupKey(r.group) === key; });
    var sh = ss.getSheetByName("GroupOwners");
    var existingRow = 0;
    if (sh && sh.getLastRow() >= 2) {
      var vals = sh.getDataRange().getValues(), h = vals[0], gi = h.indexOf("group");
      for (var i = 1; i < vals.length; i++) if (_groupKey(vals[i][gi]) === key) { existingRow = i + 1; break; }
    }
    if (!members && !existingRow) return { ok: false, error: "No such group." };
    if (ownerPhone === "") {
      if (existingRow) sh.deleteRows(existingRow, 1);
      p4_resetCache_();
      return { ok: true };
    }
    var stu = _students(), sv = stu.getDataRange().getValues(), c = _studentCols(sv[0]), isTeacher = false;
    for (var j = 1; j < sv.length; j++) {
      if (_phonesMatch(sv[j][c.phone - 1], ownerPhone)) {
        var role = c.role ? String(sv[j][c.role - 1]).trim().toLowerCase() : "";
        var scope = c.teacher_scope ? String(sv[j][c.teacher_scope - 1]).trim() : "";
        isTeacher = role === "teacher" && scope !== "";
        break;
      }
    }
    if (!isTeacher) return { ok: false, error: "That person is not a teacher." };
    var id = _canonicalPhone(ownerPhone);
    var tab = _sheetByName(ss, "GroupOwners", P4_GROUPOWNER_HEADERS);
    _ensureColumns(tab, P4_GROUPOWNER_HEADERS);
    var hdr = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
    var oc = hdr.indexOf("owner_id") + 1;
    if (existingRow) {
      tab.getRange(existingRow, oc).setNumberFormat("@").setValue(id);
    } else {
      var r = _appendByHeader(tab, { group: group, owner_id: id, created_at: _fmt(new Date(), TZ, true) });
      tab.getRange(r, oc).setNumberFormat("@").setValue(id);
    }
    p4_resetCache_();
    return { ok: true };
  });
}

// ---- per-owner follow-up templates (used by the small Code.gs diff, patches/S3-templates.diff) -------------

// "" = the owner's own templates (unchanged behavior). ":<id>" = a teacher's own set. null = scoped caller with no id (refuse).
function p4_tplSuffix_(payload) {
  var ctx = p4_ctxFor_(payload);
  if (!ctx || !p4_scoped_(ctx)) return "";
  var id = ctx.principal || ctx.id;
  return id ? ":" + p4_idKey_(id) : null;
}

// rows of the FollowupTemplates tab -> {key: body}. Owner (sfx falsy): plain keys only, exactly as before.
// Teacher: his own rows override the owner's plain ones, which remain visible as read-only defaults.
function p4_tplView_(rows, sfx) {
  var out = {}, mine = {};
  (rows || []).forEach(function (r) {
    var k = String(r.key || "").trim(), b = String(r.body == null ? "" : r.body);
    if (!k || b.trim() === "") return;
    var at = k.indexOf(":");
    if (at < 0) { if (!out.hasOwnProperty(k)) out[k] = b; return; }
    if (sfx && k.slice(at) === sfx) { var base = k.slice(0, at); if (!mine.hasOwnProperty(base)) mine[base] = b; }
  });
  Object.keys(mine).forEach(function (k) { out[k] = mine[k]; });
  return out;
}

// ---- self test (S2's p4_selfTest calls this when it exists) -------------------------------------------------

function p4_selfTest_people() {
  var bad = [];
  var chk = function (name, ok) { if (!ok) bad.push(name); };
  chk("idKey phone", p4_idKey_("+20 100 000 0009") === "1000000009" && p4_idKey_("01000000009") === "1000000009");
  chk("idKey name", p4_idKey_(" Mo ") === "mo");
  var t = { kind: "teacher", via: "session", id: "01000000009", subjects: ["math"], principal: "01000000009" };
  var a = { kind: "assistant", via: "session", id: "01000000010", subjects: ["math"], principal: "01000000009" };
  var la = { kind: "assistant", via: "session", id: "01000000011", subjects: [], principal: "" };
  chk("scoped teacher", p4_scoped_(t) && p4_scoped_(a) && !p4_scoped_(la) && !p4_scoped_({ kind: "owner" }));
  chk("inSubjects", p4_inSubjects_(t, "math/x/y") && !p4_inSubjects_(t, "programming/x") && !p4_inSubjects_(t, ""));
  var v = p4_tplView_([{ key: "a", body: "own" }, { key: "a:1000000009", body: "mine" }, { key: "b:2", body: "other" }], ":1000000009");
  chk("tplView teacher", v.a === "mine" && !v.hasOwnProperty("b"));
  var o = p4_tplView_([{ key: "a", body: "own" }, { key: "a:1000000009", body: "mine" }], "");
  chk("tplView owner", o.a === "own" && Object.keys(o).length === 1);
  return bad.length ? "FAIL: " + bad.join(", ") : "ALL PASS";
}
// ===== END MERGED FROM Phase4_People.gs =====

// ============================================================================
// ===== MERGED FROM Phase4_Team.gs =====
// ============================================================================
// ============================================================================
// Phase4_Team.gs  (P4 / S5)  Teacher accounts, teacher-appointed assistants, student record edits.
//
// Contract: 00-MASTER-CONTRACT.md v2 sections 2, 3, 6, 6c. Nothing here runs at load time.
// Depends on Code.gs helpers only (+ Phase3 role helpers when present). Every call into another
// P4 session is guarded with typeof and fails CLOSED:
//   S2: p4_ctx(payload)            (who is calling; kind "owner" | "teacher" | "assistant" ...)
//   S3: p4_ownsStudent(ctx, phone), p4_lookupAllowed_(ctx)  (shared A17 bucket)
//   S6: p4_ownerPing_(text)
// Private helpers are prefixed p4t_ (or P4T_) and never collide with S2/S3/S6/S8 names.
//
// Editor functions: p4_setup, p4_mint_teacher_token, p4_revoke_teacher_token, p4_selfTest_team.
// Router actions:   p4_admin_set_teacher, p4_admin_list_teachers, p4_admin_list_edit_log,
//                   p4_teacher_set_assistant, p4_teacher_list_assistants, p4_teacher_revoke_assistant,
//                   p4_teacher_update_student.
// ============================================================================

var P4T_SUBJECTS = ["programming", "english", "math"];
var P4T_STU_COLS = ["teacher_scope", "assistant_of"];
var P4T_GROUPOWNERS_HEADERS = ["group", "owner_id", "created_at"];
var P4T_TELEGRAM_HEADERS = ["teacher_id", "chat_id", "linked_at"];
var P4T_EDITLOG_HEADERS = ["ts", "actor_kind", "actor_id", "student_old", "student_new", "field", "old_value", "new_value"];
var P4T_GENERIC = "Could not apply that change.";
var P4T_LOCK_MS = 20000;
var P4T_LOOKUP_LIMIT = 30;
var P4T_LOOKUP_WINDOW_S = 3600;
// Ships OFF: Drive meta files and written-image file names still carry the old phone and cannot
// be rewritten (see HANDOFF section 7). An explicit "1" in Script Properties turns it on.
var P4T_PHONE_EDIT_DEFAULT = "0";

// Every store that keys data by a student's phone. book: "ss" = _ss(), "data" = _dataSs().
var P4T_PHONE_STORES = [
  { book: "ss", tab: "Entitlements", col: "phone" },
  { book: "ss", tab: "Payments", col: "phone" },
  { book: "ss", tab: "QuizAccess", col: "phone" },
  { book: "ss", tab: "Groups", col: "phone" },
  { book: "ss", tab: "Attendance", col: "phone" },
  { book: "ss", tab: "WatchProgress", col: "phone" },
  { book: "ss", tab: "ParentNotifications", col: "student" },
  { book: "ss", tab: "MonthlyReviews", col: "student" },
  { book: "data", tab: "QuizResults", col: "student_id" },
  { book: "data", tab: "Submissions", col: "student_id" },
  { book: "data", tab: "WrittenAnswers", col: "student_id" }
];

// ---------------------------------------------------------------- small pure helpers

function p4t_denied_() { return { ok: false, error: "Not authorized." }; }
function p4t_generic_() { return { ok: false, error: P4T_GENERIC }; }
function p4t_lc_(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

function p4t_hash_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join("");
}

// "math, Programming" -> "math,programming". Returns null for anything unknown, "*" included.
// "" -> "" (meaning: no scope).
function p4t_scope_(raw) {
  var parts = String(raw == null ? "" : raw).split(",").map(p4t_lc_).filter(function (x) { return x !== ""; });
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (P4T_SUBJECTS.indexOf(parts[i]) === -1) return null;
    if (out.indexOf(parts[i]) === -1) out.push(parts[i]);
  }
  return out.join(",");
}

// Trim, strip control characters, 2 to 80 characters. Returns "" when not acceptable.
function p4t_cleanName_(v) {
  if (typeof v !== "string") return "";
  var s = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  var n = Array.from(s).length;
  return n >= 2 && n <= 80 ? s : "";
}

// Egyptian mobile in canonical form (same rule as auth.js isEgyptMobile), else "".
function p4t_cleanPhone_(v) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  var d = _canonicalPhone(v);
  return /^01[0125]\d{8}$/.test(d) ? d : "";
}

function p4t_maxAssistants_() {
  var n = parseInt(_props().getProperty("P4_MAX_ASSISTANTS") || "5", 10);
  return isNaN(n) || n < 0 ? 5 : n;
}

function p4t_phoneEditOn_() {
  var v = _props().getProperty("P4_TEACHER_PHONE_EDIT");
  if (v === null || v === undefined || String(v).trim() === "") v = P4T_PHONE_EDIT_DEFAULT;
  return String(v).trim() !== "0";
}

function p4t_ctx_(payload) {
  try { return typeof p4_ctx === "function" ? p4_ctx(payload) : null; } catch (e) { return null; }
}
function p4t_isOwner_(payload) { var c = p4t_ctx_(payload); return !!c && c.kind === "owner"; }

function p4t_who_(payload) {
  try { return typeof _p3Who === "function" ? _p3Who(payload) : String((payload && payload.student_id) || "admin-token"); } catch (e) { return "admin"; }
}
function p4t_audit_(payload, action, target, before, after) {
  try { if (typeof p2_audit === "function") p2_audit(p4t_who_(payload), action, target, before, after); } catch (e) { /* best effort */ }
}

// A17: one lookup bucket per principal. S3's helper when present, otherwise the same idea on
// CacheService (key p4lk:<principal or id>, 30 per rolling window). true = allowed.
function p4t_lookup_(ctx) {
  try {
    if (typeof p4_lookupAllowed_ === "function") {
      var r = p4_lookupAllowed_(ctx);
      return !(r === false || r === null || r === undefined || (typeof r === "object" && r.ok === false));
    }
  } catch (e) { return false; }
  try {
    var id = String((ctx && (ctx.principal || ctx.id)) || "");
    if (!id) return false;
    var cache = CacheService.getScriptCache(), key = "p4lk:" + id;
    var now = Math.floor(Date.now() / 1000), n = 0, t0 = now;
    var raw = cache.get(key);
    if (raw) { var p = String(raw).split("|"); n = parseInt(p[0], 10) || 0; t0 = parseInt(p[1], 10) || now; }
    if (now - t0 >= P4T_LOOKUP_WINDOW_S) { n = 0; t0 = now; }
    if (n >= P4T_LOOKUP_LIMIT) return false;
    cache.put(key, (n + 1) + "|" + t0, Math.max(1, P4T_LOOKUP_WINDOW_S - (now - t0)));
    return true;
  } catch (e2) { return false; }
}

// ---------------------------------------------------------------- Students-sheet access

function p4t_headers_(sheet) {
  var last = sheet.getLastColumn();
  return last < 1 ? [] : sheet.getRange(1, 1, 1, last).getValues()[0];
}

function p4t_ensureCol_(sheet, name) {
  var headers = p4t_headers_(sheet);
  for (var i = 0; i < headers.length; i++) if (String(headers[i]).trim() === name) return i + 1;
  var last = sheet.getLastColumn();
  if (typeof sheet.getMaxColumns === "function" && last >= sheet.getMaxColumns()) sheet.insertColumnAfter(last);
  sheet.getRange(1, last + 1).setValue(name);
  return last + 1;
}

// Write path: makes sure role / teacher_scope / assistant_of exist, returns {sheet, c}.
function p4t_studentsForWrite_() {
  var sheet = _students();
  if (typeof _p3EnsureRoleColumn === "function") _p3EnsureRoleColumn(sheet); else p4t_ensureCol_(sheet, "role");
  P4T_STU_COLS.forEach(function (n) { p4t_ensureCol_(sheet, n); });
  return { sheet: sheet, c: _studentCols(p4t_headers_(sheet)) };
}

// Read path: never creates columns; a missing column reads as blank.
function p4t_studentsRead_() {
  var values = _students().getDataRange().getValues();
  return { values: values, c: _studentCols(values[0]) };
}

function p4t_get_(values, c, i, name) {
  return c[name] ? values[i][c[name] - 1] : "";
}

function p4t_findIdx_(values, c, phone) {
  var target = _normalizePhone(phone);
  if (!target) return -1;
  for (var i = 1; i < values.length; i++) if (_phonesMatch(values[i][c.phone - 1], target)) return i;
  return -1;
}

function p4t_roleOf_(values, c, i) { return p4t_lc_(p4t_get_(values, c, i, "role")); }
function p4t_isAdminRow_(values, c, i) { return c.is_admin ? _isTruthyFlag(values[i][c.is_admin - 1]) : false; }
function p4t_phoneOut_(v) { return _restoreLeadingZero(String(v == null ? "" : v)); }
function p4t_nameOut_(v) { return String(v == null ? "" : v); }

function p4t_setCell_(sheet, row, col, value) {
  sheet.getRange(row, col).setNumberFormat("@").setValue(value);
}

// Appends one row as plain text (phones keep their leading 0, "=..." stays text).
function p4t_appendText_(sheet, headers, rec) {
  var hs = p4t_headers_(sheet);
  var row = hs.map(function (h) { return rec.hasOwnProperty(h) && rec[h] !== null && rec[h] !== undefined ? String(rec[h]) : ""; });
  var r = sheet.getLastRow() + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, r - sheet.getMaxRows()));
  sheet.getRange(r, 1, 1, hs.length).setNumberFormat("@").setValues([row]);
  return r;
}

function p4t_now_() { return Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss"); }

// ---------------------------------------------------------------- editor functions

// Idempotent. Run once from the editor after pasting.
function p4_setup() {
  var done = [];
  var S = p4t_studentsForWrite_();
  done.push("Students columns: role, teacher_scope, assistant_of");
  var rows = Math.max(S.sheet.getMaxRows() - 1, 1);
  P4T_STU_COLS.forEach(function (n) { S.sheet.getRange(2, S.c[n], rows, 1).setNumberFormat("@"); });
  var ss = _ss();
  [["GroupOwners", P4T_GROUPOWNERS_HEADERS], ["TeacherTelegram", P4T_TELEGRAM_HEADERS], ["StudentEditLog", P4T_EDITLOG_HEADERS]].forEach(function (p) {
    var sh = _followupSheet(ss, p[0], p[1]);
    _ensureColumns(sh, p[1]);
    var hs = p4t_headers_(sh), n = Math.max(sh.getMaxRows() - 1, 1);
    hs.forEach(function (h, i) { if (p[1].indexOf(h) !== -1) sh.getRange(2, i + 1, n, 1).setNumberFormat("@"); });
    done.push("tab " + p[0]);
  });
  var props = _props();
  if (!props.getProperty("P4_TEACHER_TOKENS")) props.setProperty("P4_TEACHER_TOKENS", "{}");
  if (!props.getProperty("P4_MAX_ASSISTANTS")) props.setProperty("P4_MAX_ASSISTANTS", "5");
  if (props.getProperty("P4_TEACHER_PHONE_EDIT") === null || props.getProperty("P4_TEACHER_PHONE_EDIT") === undefined) props.setProperty("P4_TEACHER_PHONE_EDIT", P4T_PHONE_EDIT_DEFAULT);
  Logger.log("p4_setup OK | " + done.join(" | ") + " | P4_TEACHER_PHONE_EDIT=" + (props.getProperty("P4_TEACHER_PHONE_EDIT")));
  return "OK";
}

function p4t_tokens_() {
  try {
    var o = JSON.parse(_props().getProperty("P4_TEACHER_TOKENS") || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

// Logs the raw token ONCE (Executions log). Only its SHA-256 hex is stored.
function p4_mint_teacher_token(name, scope) {
  var nm = String(name == null ? "" : name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$/.test(nm)) throw new Error("Token name: 1 to 40 letters, digits, space, dot, dash or underscore.");
  var sc = p4t_scope_(scope);
  if (sc === null || sc === "") throw new Error("Scope must be one or more of: " + P4T_SUBJECTS.join(", ") + ".");
  var raw = "p4t_" + Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  _withLock(function () {
    var all = p4t_tokens_();
    Object.keys(all).forEach(function (h) { if (all[h] && p4t_lc_(all[h].name) === p4t_lc_(nm)) throw new Error('A token named "' + nm + '" already exists. Revoke it first.'); });
    all[p4t_hash_(raw)] = { name: nm, scope: sc, created: p4t_now_().replace(" ", "T") };
    _props().setProperty("P4_TEACHER_TOKENS", JSON.stringify(all));
  });
  Logger.log("TEACHER TOKEN for \"" + nm + "\" (scope " + sc + "). Copy it now; it is never shown again:\n" + raw);
  return raw;
}

function p4_revoke_teacher_token(name) {
  var nm = p4t_lc_(name), removed = 0;
  _withLock(function () {
    var all = p4t_tokens_();
    Object.keys(all).forEach(function (h) { if (all[h] && p4t_lc_(all[h].name) === nm) { delete all[h]; removed++; } });
    _props().setProperty("P4_TEACHER_TOKENS", JSON.stringify(all));
  });
  Logger.log("p4_revoke_teacher_token: removed " + removed + " token(s) named \"" + name + "\".");
  return removed;
}

// ---------------------------------------------------------------- owner: accounts

// {phone, scope}: scope "math" (or "math,english") makes a teacher; "" removes him.
function p4_admin_set_teacher(payload) {
  payload = payload || {};
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var phone = _normalizePhone(payload.phone);
  if (!phone) return { ok: false, error: "Missing phone number." };
  var scope = p4t_scope_(payload.scope);
  if (scope === null) return { ok: false, error: "Unknown subject. Use: " + P4T_SUBJECTS.join(", ") + "." };
  var res = _withLock(function () {
    var S = p4t_studentsForWrite_();
    var values = S.sheet.getDataRange().getValues(), c = S.c;
    var i = p4t_findIdx_(values, c, phone);
    if (i < 0) return { ok: false, error: "No student account with that phone number." };
    if (p4t_isAdminRow_(values, c, i)) return { ok: false, error: "This account is the owner; its role can't be changed here." };
    var row = i + 1, tPhone = _normalizePhone(values[i][c.phone - 1]);
    var beforeRole = p4t_roleOf_(values, c, i), beforeScope = p4t_lc_(p4t_get_(values, c, i, "teacher_scope"));
    var out = { ok: true, phone: p4t_phoneOut_(values[i][c.phone - 1]) };
    if (scope !== "") {
      p4t_setCell_(S.sheet, row, c.role, "teacher");
      p4t_setCell_(S.sheet, row, c.teacher_scope, scope);
      p4t_setCell_(S.sheet, row, c.assistant_of, "");
      out.role = "teacher"; out.scope = scope;
      out._before = { role: beforeRole, scope: beforeScope }; out._after = { role: "teacher", scope: scope };
      return out;
    }
    // Removal. Only a teacher is demoted; any other role is left alone.
    if (beforeRole !== "teacher") { out.role = beforeRole === "assistant" ? "assistant" : "student"; out.scope = ""; out._noop = true; return out; }
    p4t_setCell_(S.sheet, row, c.role, "");
    p4t_setCell_(S.sheet, row, c.teacher_scope, "");
    var reset = 0;
    for (var k = 1; k < values.length; k++) {
      if (k === i) continue;
      if (p4t_roleOf_(values, c, k) === "assistant" && String(p4t_get_(values, c, k, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(values, c, k, "assistant_of"), tPhone)) {
        p4t_setCell_(S.sheet, k + 1, c.role, "");
        p4t_setCell_(S.sheet, k + 1, c.assistant_of, "");
        reset++;
      }
    }
    out.role = "student"; out.scope = ""; out._reset = reset;
    out._before = { role: "teacher", scope: beforeScope }; out._after = { role: "student", scope: "" };
    return out;
  });
  if (res && res.ok && !res._noop && res._before) p4t_audit_(payload, "p4_admin_set_teacher", res.phone, res._before, res._after);
  if (res) { delete res._before; delete res._after; delete res._noop; delete res._reset; }
  return res;
}

// {} -> {ok, teachers:[{phone,name,scope,telegram,assistants:[{phone,name}]}], tokens:[{name,scope,created}]}
function p4_admin_list_teachers(payload) {
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var R = p4t_studentsRead_(), values = R.values, c = R.c;
  var linked = [];
  try {
    var tg = _ss().getSheetByName("TeacherTelegram");
    if (tg && tg.getLastRow() >= 2) {
      var h = _headerIndex(tg);
      if (h.teacher_id) tg.getRange(2, h.teacher_id, tg.getLastRow() - 1, 1).getValues().forEach(function (r) { if (String(r[0]).trim() !== "") linked.push(r[0]); });
    }
  } catch (e) { /* tab missing: nobody linked */ }
  var teachers = [], byPhone = {};
  for (var i = 1; i < values.length; i++) {
    if (p4t_roleOf_(values, c, i) !== "teacher" || p4t_isAdminRow_(values, c, i)) continue;
    var ph = _normalizePhone(values[i][c.phone - 1]);
    var t = { phone: p4t_phoneOut_(values[i][c.phone - 1]), name: p4t_nameOut_(values[i][c.display_name - 1]), scope: p4t_lc_(p4t_get_(values, c, i, "teacher_scope")),
              telegram: linked.some(function (l) { return _phonesMatch(l, ph); }), assistants: [] };
    teachers.push(t); byPhone[ph] = t;
  }
  for (var k = 1; k < values.length; k++) {
    if (p4t_roleOf_(values, c, k) !== "assistant") continue;
    var of = p4t_get_(values, c, k, "assistant_of");
    if (String(of).trim() === "") continue;
    teachers.forEach(function (t2) {
      if (_phonesMatch(of, t2.phone)) t2.assistants.push({ phone: p4t_phoneOut_(values[k][c.phone - 1]), name: p4t_nameOut_(values[k][c.display_name - 1]) });
    });
  }
  var toks = p4t_tokens_(), tokens = Object.keys(toks).map(function (h2) {
    return { name: String(toks[h2] && toks[h2].name || ""), scope: String(toks[h2] && toks[h2].scope || ""), created: String(toks[h2] && toks[h2].created || "") };
  });
  return { ok: true, teachers: teachers, tokens: tokens };
}

// {limit?} newest first, default 200.
function p4_admin_list_edit_log(payload) {
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var limit = parseInt(payload && payload.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 1000);
  var sh = _ss().getSheetByName("StudentEditLog");
  if (!sh || sh.getLastRow() < 2) return { ok: true, rows: [] };
  var hs = p4t_headers_(sh);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, hs.length).getValues(), rows = [];
  for (var r = vals.length - 1; r >= 0 && rows.length < limit; r--) {
    var o = {};
    hs.forEach(function (h, j) { if (h !== "") o[h] = String(vals[r][j] == null ? "" : vals[r][j]); });
    rows.push(o);
  }
  return { ok: true, rows: rows };
}

// ---------------------------------------------------------------- teacher identity

// The calling teacher, re-read from the sheet: {ctx, phone, name, scope} or null.
// kind "teacher" is required HERE too; a scoped assistant is kind "assistant" and never passes.
function p4t_teacher_(payload) {
  var ctx = p4t_ctx_(payload);
  if (!ctx || ctx.kind !== "teacher") return null;
  var phone = _normalizePhone(ctx.principal || ctx.id);
  if (!phone) return null;
  var R = p4t_studentsRead_(), i = p4t_findIdx_(R.values, R.c, phone);
  if (i < 0 || p4t_isAdminRow_(R.values, R.c, i) || p4t_roleOf_(R.values, R.c, i) !== "teacher") return null;
  var scope = p4t_lc_(p4t_get_(R.values, R.c, i, "teacher_scope"));
  if (scope === "") return null;
  return { ctx: ctx, phone: _normalizePhone(R.values[i][R.c.phone - 1]), name: p4t_nameOut_(R.values[i][R.c.display_name - 1]), scope: scope };
}

// ---------------------------------------------------------------- teacher: assistants

function p4t_countAssistants_(values, c, tPhone) {
  var n = 0;
  for (var i = 1; i < values.length; i++) {
    if (p4t_roleOf_(values, c, i) === "assistant" && String(p4t_get_(values, c, i, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(values, c, i, "assistant_of"), tPhone)) n++;
  }
  return n;
}

// {phone}. Always {ok:true, registered:bool}; only a plain student actually changes.
function p4_teacher_set_assistant(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  if (!p4t_lookup_(T.ctx)) return { ok: false, error: "Too many requests." };
  var phone = _normalizePhone(payload.phone);
  var registered = false;
  try {
    var R0 = p4t_studentsRead_();
    registered = !!phone && p4t_findIdx_(R0.values, R0.c, phone) >= 0;
    if (registered) {
      _withLock(function () {
        var S = p4t_studentsForWrite_();
        var values = S.sheet.getDataRange().getValues(), c = S.c;
        var i = p4t_findIdx_(values, c, phone);
        if (i < 0) return;
        var role = p4t_roleOf_(values, c, i);
        var plain = (role === "" || role === "student") && !p4t_isAdminRow_(values, c, i) &&
          p4t_lc_(p4t_get_(values, c, i, "teacher_scope")) === "" && String(p4t_get_(values, c, i, "assistant_of")).trim() === "";
        if (!plain || _phonesMatch(values[i][c.phone - 1], T.phone)) return;
        if (p4t_countAssistants_(values, c, T.phone) >= p4t_maxAssistants_()) return;
        p4t_setCell_(S.sheet, i + 1, c.role, "assistant");
        p4t_setCell_(S.sheet, i + 1, c.assistant_of, T.phone);
        p4t_audit_(payload, "p4_teacher_set_assistant", p4t_phoneOut_(values[i][c.phone - 1]), { role: "", assistant_of: "" }, { role: "assistant", assistant_of: T.phone });
      }, P4T_LOCK_MS);
    }
  } catch (e) { /* the answer must not depend on what happened */ }
  return { ok: true, registered: registered };
}

function p4_teacher_list_assistants(payload) {
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var R = p4t_studentsRead_(), out = [];
  for (var i = 1; i < R.values.length; i++) {
    if (p4t_roleOf_(R.values, R.c, i) === "assistant" && String(p4t_get_(R.values, R.c, i, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(R.values, R.c, i, "assistant_of"), T.phone)) {
      out.push({ phone: p4t_phoneOut_(R.values[i][R.c.phone - 1]), name: p4t_nameOut_(R.values[i][R.c.display_name - 1]) });
    }
  }
  return { ok: true, assistants: out, max: p4t_maxAssistants_() };
}

// {phone}. Only an assistant whose assistant_of is this teacher; anything else is "Not authorized.".
function p4_teacher_revoke_assistant(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var phone = _normalizePhone(payload.phone);
  if (!phone) return p4t_denied_();
  var done = false;
  try {
    done = _withLock(function () {
      var S = p4t_studentsForWrite_();
      var values = S.sheet.getDataRange().getValues(), c = S.c;
      var i = p4t_findIdx_(values, c, phone);
      if (i < 0 || p4t_roleOf_(values, c, i) !== "assistant") return false;
      var of = p4t_get_(values, c, i, "assistant_of");
      if (String(of).trim() === "" || !_phonesMatch(of, T.phone)) return false;
      p4t_setCell_(S.sheet, i + 1, c.role, "");
      p4t_setCell_(S.sheet, i + 1, c.assistant_of, "");
      p4t_audit_(payload, "p4_teacher_revoke_assistant", p4t_phoneOut_(values[i][c.phone - 1]), { role: "assistant", assistant_of: T.phone }, { role: "", assistant_of: "" });
      return true;
    }, P4T_LOCK_MS);
  } catch (e) { done = false; }
  return done ? { ok: true } : p4t_denied_();
}

// ---------------------------------------------------------------- teacher: student record edits

// Plans one store: every cell in `col` that matches oldPhone gets newPhone. Reads the column once.
// Returns null when the tab does not exist or is empty (nothing to rewrite); throws when the tab
// exists but lacks the column (cannot rewrite -> the whole edit is refused before any write).
function p4t_planStore_(store, oldPhone, newPhone) {
  var book = store.book === "data" ? _dataSs() : _ss();
  var sh = book.getSheetByName(store.tab);
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return null;
  var idx = _headerIndex(sh);
  if (!idx[store.col]) throw new Error("The " + store.tab + ' sheet is missing the "' + store.col + '" column.');
  var n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var oldVals = sh.getRange(2, idx[store.col], n, 1).getValues(), newVals = [], hits = 0;
  for (var i = 0; i < n; i++) {
    var cell = oldVals[i][0];
    if (cell !== "" && cell !== null && _phonesMatch(cell, oldPhone)) { newVals.push([newPhone]); hits++; } else newVals.push([cell]);
  }
  return hits ? { store: store, sheet: sh, col: idx[store.col], n: n, oldVals: oldVals, newVals: newVals, hits: hits } : null;
}

// Rewrites the phone everywhere or nowhere. Throws (after restoring what it had changed) on any failure.
function p4t_cascade_(oldPhone, newPhone, studentsWrites) {
  var plans = [];
  P4T_PHONE_STORES.forEach(function (st) { var p = p4t_planStore_(st, oldPhone, newPhone); if (p) plans.push(p); });
  var applied = [];
  try {
    plans.forEach(function (p) {
      var rng = p.sheet.getRange(2, p.col, p.n, 1);
      applied.push(p);
      rng.setNumberFormat("@");
      rng.setValues(p.newVals);
    });
    studentsWrites(applied);
  } catch (e) {
    for (var k = applied.length - 1; k >= 0; k--) {
      try { applied[k].sheet.getRange(2, applied[k].col, applied[k].n, 1).setValues(applied[k].oldVals); } catch (e2) { Logger.log("p4 cascade rollback failed on " + applied[k].store.tab + ": " + e2); }
    }
    throw e;
  }
  var counts = {};
  plans.forEach(function (p) { counts[p.store.tab] = p.hits; });
  return counts;
}

// {student_id, session_token, student, changes:{name?, phone?, parent_phone?}}
function p4_teacher_update_student(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var ownsFn = typeof p4_ownsStudent === "function" ? p4_ownsStudent : null;
  var target = String(payload.student == null ? "" : payload.student);

  // Ownership and "plain student" check against the CURRENT stored phone. Same answer for
  // "does not exist", "not yours" and "not a plain student".
  function resolve(values, c) {
    var i = p4t_findIdx_(values, c, target);
    if (i < 0 || !ownsFn) return -1;
    var role = p4t_roleOf_(values, c, i);
    if ((role !== "" && role !== "student") || p4t_isAdminRow_(values, c, i)) return -1;
    var cur = p4t_phoneOut_(values[i][c.phone - 1]);
    try { if (!ownsFn(T.ctx, cur)) return -1; } catch (e) { return -1; }
    return i;
  }
  var R0 = p4t_studentsRead_();
  if (resolve(R0.values, R0.c) < 0) return p4t_denied_();

  // Whitelist + validation.
  var ch = payload.changes;
  if (!ch || typeof ch !== "object" || Array.isArray(ch)) return p4t_generic_();
  var keys = Object.keys(ch);
  if (!keys.length) return p4t_generic_();
  for (var k = 0; k < keys.length; k++) if (keys[k] !== "name" && keys[k] !== "phone" && keys[k] !== "parent_phone") return p4t_generic_();
  var want = {};
  if (ch.hasOwnProperty("name")) { want.name = p4t_cleanName_(ch.name); if (want.name === "") return p4t_generic_(); }
  if (ch.hasOwnProperty("phone")) { want.phone = p4t_cleanPhone_(ch.phone); if (want.phone === "") return p4t_generic_(); }
  if (ch.hasOwnProperty("parent_phone")) { want.parent_phone = p4t_cleanPhone_(ch.parent_phone); if (want.parent_phone === "") return p4t_generic_(); }

  var result = null, logRows = [], pingText = "";
  try {
    result = _withLock(function () {
      var S = p4t_studentsForWrite_();
      var values = S.sheet.getDataRange().getValues(), c = S.c;
      var i = resolve(values, c);                              // re-check inside the lock
      if (i < 0) return p4t_denied_();
      var row = i + 1;
      var curName = p4t_nameOut_(values[i][c.display_name - 1]);
      var curPhone = p4t_phoneOut_(values[i][c.phone - 1]);
      var curParent = c.parent_phone ? p4t_phoneOut_(values[i][c.parent_phone - 1]) : "";
      var eff = {};
      if (want.hasOwnProperty("name") && want.name !== curName) eff.name = want.name;
      if (want.hasOwnProperty("phone") && _normalizePhone(want.phone) !== _normalizePhone(curPhone)) eff.phone = want.phone;
      if (want.hasOwnProperty("parent_phone") && _normalizePhone(want.parent_phone) !== _normalizePhone(curParent)) eff.parent_phone = want.parent_phone;
      var student = function (n, p, pp) { return { name: n, phone: p, parent_phone: pp }; };
      if (!Object.keys(eff).length) return { ok: true, student: student(curName, curPhone, curParent) };

      if (eff.hasOwnProperty("phone")) {
        if (!p4t_phoneEditOn_()) return p4t_generic_();
        for (var j = 1; j < values.length; j++) {
          if (j !== i && _phonesMatch(values[j][c.phone - 1], eff.phone)) { p4t_lookup_(T.ctx); return p4t_generic_(); }
        }
      }
      var newName = eff.hasOwnProperty("name") ? eff.name : curName;
      var newPhone = eff.hasOwnProperty("phone") ? eff.phone : curPhone;
      var newParent = eff.hasOwnProperty("parent_phone") ? eff.parent_phone : curParent;
      var old = { name: values[i][c.display_name - 1], phone: values[i][c.phone - 1], parent: c.parent_phone ? values[i][c.parent_phone - 1] : "" };

      var writeStudents = function (applied) {
        var done = [];
        try {
          if (eff.hasOwnProperty("phone")) { p4t_setCell_(S.sheet, row, c.phone, newPhone); done.push(["phone", c.phone, old.phone]); }
          if (eff.hasOwnProperty("name")) { p4t_setCell_(S.sheet, row, c.display_name, newName); done.push(["name", c.display_name, old.name]); }
          if (eff.hasOwnProperty("parent_phone")) {
            if (!c.parent_phone) throw new Error("The Students sheet has no parent_phone column.");
            p4t_setCell_(S.sheet, row, c.parent_phone, newParent); done.push(["parent", c.parent_phone, old.parent]);
          }
        } catch (e) {
          done.forEach(function (d) { try { S.sheet.getRange(row, d[1]).setValue(d[2]); } catch (e2) { /* best effort */ } });
          throw e;
        }
      };
      if (eff.hasOwnProperty("phone")) p4t_cascade_(curPhone, newPhone, writeStudents); else writeStudents([]);

      var ts = p4t_now_();
      ["name", "phone", "parent_phone"].forEach(function (f) {
        if (!eff.hasOwnProperty(f)) return;
        logRows.push({ ts: ts, actor_kind: "teacher", actor_id: T.phone, student_old: curPhone, student_new: newPhone, field: f,
                       old_value: f === "name" ? curName : f === "phone" ? curPhone : curParent, new_value: eff[f] });
      });
      if (eff.hasOwnProperty("phone")) pingText = "Teacher " + T.name + " changed a student's phone.\nStudent: " + newName + "\nOld: " + curPhone + "\nNew: " + newPhone;
      return { ok: true, student: student(newName, newPhone, newParent) };
    }, P4T_LOCK_MS);
  } catch (e) {
    Logger.log("p4_teacher_update_student refused: " + (e && e.message));
    return p4t_generic_();
  }
  if (result && result.ok && logRows.length) {
    try {
      var logSheet = _followupSheet(_ss(), "StudentEditLog", P4T_EDITLOG_HEADERS);
      _ensureColumns(logSheet, P4T_EDITLOG_HEADERS);
      logRows.forEach(function (r) { p4t_appendText_(logSheet, P4T_EDITLOG_HEADERS, r); });
    } catch (e3) { Logger.log("StudentEditLog write failed: " + (e3 && e3.message)); }
    if (pingText) { try { if (typeof p4_ownerPing_ === "function") p4_ownerPing_(pingText); } catch (e4) { /* best effort */ } }
  }
  return result;
}

// ---------------------------------------------------------------- self test (pure: no sheet access)

function p4_selfTest_team() {
  var bad = [];
  var eq = function (n, a, b) { if (a !== b) bad.push(n + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };
  eq("sha256(abc)", p4t_hash_("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  eq("scope math", p4t_scope_("Math"), "math");
  eq("scope dedupe", p4t_scope_("math, math,english"), "math,english");
  eq("scope blank", p4t_scope_(""), "");
  eq("scope star refused", p4t_scope_("*"), null);
  eq("scope unknown refused", p4t_scope_("math,art"), null);
  eq("name trims and strips", p4t_cleanName_("  Sara\u0000 Ali \n"), "Sara Ali");
  eq("name too short", p4t_cleanName_("A"), "");
  eq("name too long", p4t_cleanName_(new Array(82).join("x")), "");
  eq("name not a string", p4t_cleanName_(12345), "");
  eq("name html kept as text", p4t_cleanName_("<b>Ann</b>"), "<b>Ann</b>");
  eq("phone ok", p4t_cleanPhone_("+20 101 234 5678"), "01012345678");
  eq("phone lost zero", p4t_cleanPhone_("1012345678"), "01012345678");
  eq("phone landline refused", p4t_cleanPhone_("034567890"), "");
  eq("phone short refused", p4t_cleanPhone_("0101234"), "");
  eq("phone object refused", p4t_cleanPhone_({}), "");
  eq("stores listed", P4T_PHONE_STORES.length, 11);
  var out = bad.length ? "FAIL: " + bad.join(" | ") : "ALL PASS";
  Logger.log("p4_selfTest_team: " + out);
  return out;
}
// ===== END MERGED FROM Phase4_Team.gs =====

// ============================================================================
// ===== MERGED FROM Phase4_Telegram.gs =====
// ============================================================================
/* Phase4_Telegram.gs - P4 / S6: Telegram per teacher (contract section 6b).
 * A teacher links his OWN private Telegram chat to the existing payments bot. He then gets payment requests for his own
 * subject(s) and can Approve / Reject them from there, exactly like the owner. Dashboard approval keeps working.
 *
 * Depends on (frozen signatures, other sessions): p4_ctxForPhone, p4_ctx, p4_teacherCovers, p4_paymentInScope (Phase4_Scope / People).
 * Depends on Code.gs: _props, _ss, _tgCall, _tgAdminIds, _withLock, _sheetValuesAsObjects, _prettyLesson, _normalizePhone,
 *   _phonesMatch, handleAdminDecidePayment (the SAME internal function the owner's Telegram tap calls).
 * Security model: identity comes ONLY from the TeacherTelegram sheet (chat id -> teacher id). Nothing in callback_data or message
 * text is trusted except the payment id, and every decision is re-checked against a FRESH read of the teacher's role and scope.
 * Needs Script Property P4_TG_BOT_USERNAME (bot username without @). The bot token is never logged or stored here.
 * Script Properties used: P4_TG_BOT_USERNAME, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, ADMIN_TOKEN (all pre-existing except the first).
 */

var P4TG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 symbols, no 0/O/1/I
var P4TG_CODE_LEN = 8;
var P4TG_CODE_TTL_SEC = 900;
var P4TG_STARTS_PER_HOUR = 5;
var P4TG_TAB = "TeacherTelegram";
var P4TG_HEADERS = ["teacher_id", "chat_id", "linked_at"];
var P4TG_NOT_AUTH = { ok: false, error: "Not authorized." };

/* ---------------------------------------------------------------- small helpers (private) */

function p4tg_log_(msg) { try { console.log("p4tg: " + msg); } catch (e) {} }

function p4tg_esc_(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function p4tg_sha_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return d.map(function (b) { return ("0" + ((b < 0 ? b + 256 : b)).toString(16)).slice(-2); }).join("");
}

// 8 symbols from a 32-symbol alphabet = 40 bits. Bytes come from UUID v4 (secure random); 256 % 32 == 0, so no modulo bias.
function p4tg_newCode_() {
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^0-9a-f]/gi, "");
  var out = "";
  for (var i = 0; i < P4TG_CODE_LEN; i++) out += P4TG_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) % 32);
  return out;
}

function p4tg_same_(a, b) {
  if (typeof _phonesMatch === "function") return _phonesMatch(a, b);
  return String(a) === String(b);
}

function p4tg_cache_() { return CacheService.getScriptCache(); }

function p4tg_adminIds_() { try { return _tgAdminIds(); } catch (e) { return []; } }

// One Telegram call. NEVER throws, never logs the token (it is scrubbed from any error text). Returns the parsed JSON or null.
function p4tg_call_(method, body) {
  var token = "";
  try {
    token = String(_props().getProperty("TELEGRAM_BOT_TOKEN") || "");
    if (!token) return null;
    var res = _tgCall(method, body);
    var txt = res && typeof res.getContentText === "function" ? res.getContentText() : "";
    try { return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; }
  } catch (err) {
    var m = String(err && err.message || err);
    if (token) m = m.split(token).join("***");
    p4tg_log_("telegram call " + method + " failed: " + m.slice(0, 200));
    return null;
  }
}

// The caller must be a TEACHER using a dashboard SESSION. Assistants and token callers get null. Fresh read through p4_ctx.
function p4tg_callerTeacher_(payload) {
  try {
    if (typeof p4_ctx !== "function") return null;
    var ctx = p4_ctx(payload);
    if (!ctx || ctx.kind !== "teacher" || ctx.via !== "session" || !ctx.id) return null;
    return ctx;
  } catch (e) { return null; }
}

// Fresh teacher context for a stored teacher id (role + scope re-read from the sheet by S2). null = no longer a teacher.
function p4tg_ctxFor_(teacherId) {
  try {
    if (typeof p4_ctxForPhone !== "function") return null;
    var ctx = p4_ctxForPhone(teacherId);
    if (!ctx || ctx.kind !== "teacher" || !ctx.subjects || !ctx.subjects.length) return null;
    return ctx;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- TeacherTelegram sheet */

function p4tg_sheet_(create) {
  var ss = _ss();
  var sh = ss.getSheetByName(P4TG_TAB);
  if (!sh && create) {
    sh = ss.insertSheet(P4TG_TAB);   // S5's p4_setup creates the same tab with the same headers; this is the idempotent fallback
    sh.appendRow(P4TG_HEADERS);
  }
  return sh || null;
}

// [{row, teacher_id, chat_id, linked_at}] (row = 1-based sheet row). Empty when the tab does not exist yet.
function p4tg_rows_() {
  var sh = p4tg_sheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var t = String(vals[i][0] == null ? "" : vals[i][0]).trim(), c = String(vals[i][1] == null ? "" : vals[i][1]).trim();
    if (t && c) out.push({ row: i + 1, teacher_id: t, chat_id: c, linked_at: String(vals[i][2] == null ? "" : vals[i][2]) });
  }
  return out;
}

// chat id -> teacher id, or "" when unknown OR ambiguous (a chat listed under two teachers is refused).
function p4tg_teacherOfChat_(chatId) {
  var found = "", n = 0;
  p4tg_rows_().forEach(function (r) { if (r.chat_id === String(chatId)) { found = r.teacher_id; n++; } });
  return n === 1 ? found : "";
}

function p4tg_deleteRows_(sh, rows) {
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRows(r, 1); });
}

// One row per teacher AND one teacher per chat: a new link replaces both kinds of older row. Caller holds the lock.
function p4tg_upsert_(teacherId, chatId) {
  var sh = p4tg_sheet_(true);
  var drop = [];
  p4tg_rows_().forEach(function (r) { if (p4tg_same_(r.teacher_id, teacherId) || r.chat_id === String(chatId)) drop.push(r.row); });
  if (drop.length) p4tg_deleteRows_(sh, drop);
  var at = sh.getLastRow() + 1;
  sh.getRange(at, 1, 1, 3).setNumberFormat("@");
  sh.getRange(at, 1, 1, 3).setValues([[String(teacherId), String(chatId), new Date().toISOString()]]);
}

function p4tg_unlinkPhone_(phone) {
  var sh = p4tg_sheet_(false);
  if (!sh) return 0;
  var drop = [];
  p4tg_rows_().forEach(function (r) { if (p4tg_same_(r.teacher_id, phone)) drop.push(r.row); });
  if (drop.length) p4tg_deleteRows_(sh, drop);
  return drop.length;
}

/* ---------------------------------------------------------------- payments (read only) */

// The payment row by id, built ONLY from the Payments sheet. null if missing.
function p4tg_payment_(id) {
  var sh = _ss().getSheetByName("Payments");
  if (!sh || sh.getLastRow() < 2) return null;
  var rows = _sheetValuesAsObjects(sh);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].payment_id || "").trim() === String(id)) {
      var r = rows[i];
      return { payment_id: String(r.payment_id), phone: String(r.phone || ""), name: String(r.name || ""), scope: String(r.scope || ""),
               reference: String(r.reference || ""), note: String(r.note || ""), status: String(r.status || "").trim().toLowerCase() };
    }
  }
  return null;
}

function p4tg_paymentText_(p) {
  var label = typeof _prettyLesson === "function" ? _prettyLesson(p.scope) : p.scope;
  return "💳 <b>Payment request</b>\n\n👤 " + p4tg_esc_(p.name) + "\n📱 " + p4tg_esc_(p.phone) +
    "\n📘 " + p4tg_esc_(label) + (p.note ? "\n📦 " + p4tg_esc_(p.note) : "") + "\n🧾 Ref: " + p4tg_esc_(p.reference);
}

/* ---------------------------------------------------------------- owner ping */

/** Plain-text message to the owner's chat(s). Never throws. */
function p4_ownerPing_(text) {
  try {
    var ids = p4tg_adminIds_();
    for (var i = 0; i < ids.length; i++) p4tg_call_("sendMessage", { chat_id: ids[i], text: String(text == null ? "" : text).slice(0, 3500), disable_web_page_preview: true });
  } catch (e) { p4tg_log_("ownerPing failed"); }
}

/* ---------------------------------------------------------------- teacher-facing actions (session, teacher only) */

function p4tg_startAllowed_(teacherId) {
  var cache = p4tg_cache_(), key = "p4tgr:" + p4tg_sha_(teacherId), now = Date.now();
  var n = 0, t0 = now, raw = cache.get(key);
  if (raw) { var p = String(raw).split("|"); n = Number(p[0]) || 0; t0 = Number(p[1]) || now; if (now - t0 >= 3600000) { n = 0; t0 = now; } }
  if (n >= P4TG_STARTS_PER_HOUR) return false;
  cache.put(key, (n + 1) + "|" + t0, 3600);
  return true;
}

/** {student_id, session_token} -> {ok, link, expires_in:900}. Teacher only (assistants and tokens are refused). */
function p4_tg_link_start(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    var bot = String(_props().getProperty("P4_TG_BOT_USERNAME") || "").replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{3,64}$/.test(bot)) return { ok: false, error: "Telegram is not set up yet." };
    var allowed = _withLock(function () { return p4tg_startAllowed_(ctx.id); }, 10000);
    if (!allowed) return { ok: false, error: "Too many attempts. Try again in an hour." };
    var code = p4tg_newCode_();
    p4tg_cache_().put("p4tg:" + p4tg_sha_(code), String(ctx.id), P4TG_CODE_TTL_SEC);   // only the HASH of the code is stored
    p4tg_log_("link code issued");
    return { ok: true, link: "https://t.me/" + bot + "?start=" + code, expires_in: P4TG_CODE_TTL_SEC };
  } catch (err) {
    p4tg_log_("link_start failed: " + String(err && err.message || err).slice(0, 120));
    return { ok: false, error: "Could not create the link. Try again." };
  }
}

function p4_tg_status(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    var mine = p4tg_rows_().filter(function (r) { return p4tg_same_(r.teacher_id, ctx.id); })[0];
    return { ok: true, linked: !!mine, since: mine ? mine.linked_at : "" };
  } catch (err) { return { ok: false, error: "Could not read the status." }; }
}

function p4_tg_unlink(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    _withLock(function () { p4tg_unlinkPhone_(ctx.id); }, 10000);
    p4tg_log_("teacher unlinked");
    return { ok: true };
  } catch (err) { return { ok: false, error: "Could not unlink. Try again." }; }
}

/** Owner only: {phone} -> {ok}. Always ok, whether or not that teacher was linked. */
function p4_admin_tg_unlink(payload) {
  try {
    var ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null;
    if (!ctx || ctx.kind !== "owner") return P4TG_NOT_AUTH;
    _withLock(function () { p4tg_unlinkPhone_(payload && payload.phone); }, 10000);
    p4tg_log_("owner unlinked a teacher");
    return { ok: true };
  } catch (err) { return { ok: false, error: "Could not unlink. Try again." }; }
}

/* ---------------------------------------------------------------- notify teachers of a new payment request */

/** Called from _notifyAdmin after the owner message. `arg` = a payment id (what _notifyAdmin has) or an object with payment_id.
 *  Re-reads the payment from the sheet; sends to every linked teacher whose subjects cover the payment's own scope. Never throws. */
function p4_tg_notifyPayment(arg) {
  try {
    var pid = String(arg && typeof arg === "object" ? arg.payment_id : arg == null ? "" : arg).trim();
    if (!pid) return;
    var rows = p4tg_rows_();
    if (!rows.length) return;
    var pay = p4tg_payment_(pid);
    if (!pay || pay.status !== "pending" || typeof p4_teacherCovers !== "function") return;
    var admin = p4tg_adminIds_(), seen = {}, sent = [];
    var kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: "ap:" + pid }, { text: "❌ Reject", callback_data: "rj:" + pid }]] };
    var text = p4tg_paymentText_(pay);
    rows.forEach(function (r) {
      try {
        if (seen[r.chat_id] || admin.indexOf(r.chat_id) !== -1) return;   // owner already got it; one message per chat
        seen[r.chat_id] = true;
        var ctx = p4tg_ctxFor_(r.teacher_id);
        if (!ctx || !p4_teacherCovers(ctx, pay.scope)) return;
        var res = p4tg_call_("sendMessage", { chat_id: r.chat_id, text: text.slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
        var mid = res && res.result && res.result.message_id;
        if (mid) sent.push({ c: r.chat_id, m: mid });
      } catch (e) { p4tg_log_("notify one failed"); }
    });
    if (sent.length) p4tg_cache_().put("p4tgm:" + pid, JSON.stringify(sent), 21600);
    p4tg_log_("payment ping to " + sent.length + " teacher chat(s)");
  } catch (err) { p4tg_log_("notifyPayment failed: " + String(err && err.message || err).slice(0, 120)); }
}

/* ---------------------------------------------------------------- webhook updates */

/** Returns true ONLY when this update was fully handled here (a /start link, or an ap:/rj: tap from a chat registered in
 *  TeacherTelegram). false for everything else so the existing owner path runs unchanged. Never throws. */
function p4_tg_handleUpdate(update) {
  try {
    if (!update || typeof update !== "object") return false;
    if (update.message) return p4tg_onMessage_(update);
    if (update.callback_query) return p4tg_onCallback_(update);
    return false;
  } catch (err) {
    p4tg_log_("handleUpdate failed: " + String(err && err.message || err).slice(0, 120));
    return false;
  }
}

function p4tg_seen_(update) {
  var key = "p4tgu:" + update.update_id, cache = p4tg_cache_();
  if (update.update_id === undefined || update.update_id === null) return false;
  if (cache.get(key)) return true;
  cache.put(key, "1", 21600);
  return false;
}

// "/start <code>" in a PRIVATE chat. Every failure is a silent no-op: no reply tells a valid code from an invalid or expired one.
function p4tg_onMessage_(update) {
  var msg = update.message, chat = msg && msg.chat;
  if (!chat || chat.type !== "private") return false;
  var m = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.exec(String(msg.text || ""));
  if (!m) return false;
  if (p4tg_seen_(update)) return true;
  if (!msg.from || String(msg.from.id) !== String(chat.id)) return true;
  var hash = p4tg_sha_(String(m[1]).toUpperCase());
  var outcome = _withLock(function () {
    var cache = p4tg_cache_(), key = "p4tg:" + hash;
    var teacherId = cache.get(key);
    if (!teacherId) return null;
    cache.remove(key);                                  // single use, even if the checks below fail
    var ctx = p4tg_ctxFor_(teacherId);
    if (!ctx) return null;                              // no longer a teacher
    p4tg_upsert_(teacherId, chat.id);
    return ctx.subjects.join(", ");
  }, 10000);
  if (outcome === null) { p4tg_log_("link refused"); return true; }
  p4tg_call_("sendMessage", { chat_id: chat.id, text: "Connected. You will receive payment requests for: " + outcome + "." });
  p4tg_log_("teacher chat linked");
  return true;
}

function p4tg_edit_(chatId, messageId, text, entities) {
  var body = { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000) };
  if (entities && entities.length) body.entities = entities;
  p4tg_call_("editMessageText", body);   // no reply_markup = buttons removed
}

// After a decision, take the buttons off every teacher message we sent for this payment (errors ignored).
function p4tg_stripOthers_(pid, exceptChat, exceptMsg) {
  try {
    var raw = p4tg_cache_().get("p4tgm:" + pid);
    if (!raw) return;
    JSON.parse(raw).forEach(function (x) {
      if (String(x.c) === String(exceptChat) && String(x.m) === String(exceptMsg)) return;
      p4tg_call_("editMessageReplyMarkup", { chat_id: x.c, message_id: x.m, reply_markup: { inline_keyboard: [] } });
    });
  } catch (e) {}
}

function p4tg_onCallback_(update) {
  var cq = update.callback_query;
  var m = /^(ap|rj):(\S+)$/.exec(String(cq && cq.data || ""));
  if (!m) return false;
  var chat = cq.message && cq.message.chat;
  if (!chat || chat.type !== "private" || !cq.from || String(chat.id) !== String(cq.from.id)) return false;
  if (p4tg_adminIds_().indexOf(String(chat.id)) !== -1) return false;     // the owner's own chats stay on the existing path
  var teacherId = p4tg_teacherOfChat_(chat.id);                           // identity from the sheet, never from callback text
  if (!teacherId) return false;                                           // not a registered teacher chat
  if (p4tg_seen_(update)) return true;                                    // Telegram retries; each update is handled once
  p4tg_call_("answerCallbackQuery", { callback_query_id: cq.id });         // clear the spinner first
  var pid = m[2], approve = m[1] === "ap";

  var ctx = p4tg_ctxFor_(teacherId);                                      // FRESH role + scope
  if (!ctx) { p4tg_log_("refused: not a teacher any more"); return true; }
  var inScope = false;
  try { inScope = typeof p4_paymentInScope === "function" && p4_paymentInScope(ctx, { payment_id: pid }) === true; } catch (e) { inScope = false; }
  if (!inScope) { p4tg_log_("refused: payment outside scope"); return true; }   // no reply, no detail

  var out;
  try {
    out = handleAdminDecidePayment({ token: _props().getProperty("ADMIN_TOKEN"), payment_id: pid, decision: approve ? "approve" : "reject" });
  } catch (err) {
    var emsg = String(err && err.message || err);
    if (/already (approved|rejected|revoked)/i.test(emsg)) {
      p4tg_log_("already decided");
      p4tg_edit_(chat.id, cq.message.message_id, String(cq.message.text || "") + "\n\nAlready decided", cq.message.entities);
      p4tg_stripOthers_(pid, chat.id, cq.message.message_id);
    } else {
      p4tg_log_("decision failed: " + emsg.slice(0, 120));
    }
    return true;
  }
  var verdict = approve ? "✅ Approved" : "❌ Rejected";
  p4tg_log_("decided " + (approve ? "approve" : "reject") + " by teacher");
  p4tg_edit_(chat.id, cq.message.message_id, String(cq.message.text || "") + "\n\n" + verdict, cq.message.entities);
  p4tg_stripOthers_(pid, chat.id, cq.message.message_id);
  p4_ownerPing_(verdict + " by teacher " + teacherId + ": " + String(out && out.name || "") + " (payment " + pid + ")");
  return true;
}

/* ---------------------------------------------------------------- editor self-test (no Telegram, no sheet writes) */

function p4_selfTest_tg() {
  var fails = [];
  var ck = function (name, ok) { if (!ok) fails.push(name); };
  ck("sha256 vector", p4tg_sha_("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  var seen = {}, okAlpha = true, okLen = true;
  for (var i = 0; i < 200; i++) {
    var c = p4tg_newCode_();
    seen[c] = true;
    if (c.length !== P4TG_CODE_LEN) okLen = false;
    if (!new RegExp("^[" + P4TG_ALPHABET + "]+$").test(c)) okAlpha = false;
  }
  ck("code length", okLen); ck("code alphabet", okAlpha); ck("codes differ", Object.keys(seen).length > 190);
  ck("esc", p4tg_esc_("<b>&") === "&lt;b&gt;&amp;");
  ck("start parse", /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.test("/start ABCD2345"));
  ck("start parse rejects short", !/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.test("/start ABC"));
  var res = fails.length ? "FAIL: " + fails.join(", ") : "ALL PASS";
  Logger.log("p4_selfTest_tg: " + res);
  return res;
}
// ===== END MERGED FROM Phase4_Telegram.gs =====

// ============================================================================
// ===== MERGED FROM Phase4_Stats.gs =====
// ============================================================================
// ============================================================================
// Phase4_Stats.gs  (P4 / S8)  Owner-only, read-only view of every teacher and subject.
//
// Contract: 00-MASTER-CONTRACT.md v2 section 6e. One router action: p4_admin_teacher_stats.
// Counts and sums only. No student name, phone, payment reference, note text or file id is ever
// copied into the response: phone / student_id columns are read only to count distinct people.
// Sheets are read in bulk (one column read per needed column), never one read per row.
// Depends on Code.gs helpers; S2 / S3 helpers are used only through typeof guards:
//   p4_ctx(payload), p4_subjectOf(x), p4_linked_(ctx)   (a missing one gives null, never a guess)
// Nothing runs at load time.
// ============================================================================

var P4S_SUBJECTS = ["programming", "english", "math"];
var P4S_CACHE_KEY = "p4stats:v1";
var P4S_CACHE_SECONDS = 300;
// Only the exact label Code.gs writes into Payments.note for chapter / term subscriptions
// ("Grade 1 · Chapter 3 · 250 EGP") counts as a price. Free text typed by a student never does.
var P4S_PRICE_RE = /^Grade \d+ · (?:Chapter|Term) \d+ · (\d+(?:\.\d+)?) ([A-Z]{3})$/;

// ---------------------------------------------------------------- helpers

function p4s_denied_() { return { ok: false, error: "Not authorized." }; }

function p4s_subject_(key) {
  try {
    if (typeof p4_subjectOf === "function") return String(p4_subjectOf(key) || "");
  } catch (e) { /* fall through */ }
  var s = String(key == null ? "" : key).split("#")[0].trim().toLowerCase();
  try { if (typeof p2k_canon === "function") s = String(p2k_canon(s)).toLowerCase(); } catch (e2) { /* keep s */ }
  var first = s.split("/")[0];
  return P4S_SUBJECTS.indexOf(first) === -1 ? "" : first;
}

function p4s_block_() {
  return {
    revenue: { all_time: {}, this_month: {}, last_month: {}, pending: {} },
    payments: { approved: 0, pending: 0, rejected: 0, unpriced: 0 },
    videos: 0,
    lessons: { total: 0, locked: 0 },
    quizzes: { locked: 0 },
    students: { linked: 0, active_30d: 0 },
    written: { awaiting: 0, oldest_days: null },
    quiz_results_30d: 0,
    groups: 0
  };
}

// Sums two blocks (or parts of them). null on either side stays null. oldest_days takes the maximum.
function p4s_merge_(a, b, key) {
  if (key === "oldest_days") { if (a === null || a === undefined) return b === undefined ? null : b; if (b === null || b === undefined) return a; }
  if (a === null || b === null) return null;
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof a === "number" && typeof b === "number") return key === "oldest_days" ? Math.max(a, b) : a + b;
  if (typeof a === "object" && typeof b === "object") {
    var out = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) { if (!out.hasOwnProperty(k)) out[k] = p4s_merge_(a[k], b[k], k); });
    return out;
  }
  return a;
}
function p4s_clone_(o) { return JSON.parse(JSON.stringify(o)); }
function p4s_add_(map, cur, amt) { map[cur] = Math.round(((map[cur] || 0) + amt) * 100) / 100; }

function p4s_dayDiff_(laterYmd, earlierYmd) {
  var a = /^(\d{4})-(\d{2})-(\d{2})/.exec(laterYmd), b = /^(\d{4})-(\d{2})-(\d{2})/.exec(earlierYmd);
  if (!a || !b) return null;
  return Math.round((Date.UTC(+a[1], +a[2] - 1, +a[3]) - Date.UTC(+b[1], +b[2] - 1, +b[3])) / 86400000);
}

function p4s_prevMonth_(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
  if (m < 1) { y--; m = 12; }
  return y + "-" + ("0" + m).slice(-2);
}

// {n, col:{name:[...]}} for a tab. A missing tab is "no rows" (zeros); a tab with a required column
// missing, or any read error, is null (the metrics that need it become null).
function p4s_read_(book, tab, required, optional) {
  try {
    var sh = book.getSheetByName(tab);
    return _readColumns(sh, required, optional || [], tab);
  } catch (e) {
    Logger.log("p4_admin_teacher_stats: could not read " + tab + ": " + (e && e.message));
    return null;
  }
}

function p4s_date_(v) { try { return String(_cairoDate(v) || ""); } catch (e) { return ""; } }
function p4s_pk_(v) { try { return _phoneKey(v); } catch (e) { return ""; } }

// ---------------------------------------------------------------- the action

// {refresh?: bool}
function p4_admin_teacher_stats(payload) {
  payload = payload || {};
  var ctx = null;
  try { ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null; } catch (e) { ctx = null; }
  if (!ctx || ctx.kind !== "owner") return p4s_denied_();

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e0) { cache = null; }
  if (cache && payload.refresh !== true) {
    try {
      var hit = cache.get(P4S_CACHE_KEY);
      if (hit) { var o = JSON.parse(hit); o.cached = true; return o; }
    } catch (e1) { /* recompute */ }
  }
  var res = p4s_compute_();
  if (cache) { try { cache.put(P4S_CACHE_KEY, JSON.stringify(res), P4S_CACHE_SECONDS); } catch (e2) { /* too big or unavailable: fine */ } }
  return res;
}

function p4s_compute_() {
  var ss = _ss(), dataSs = _dataSs();
  var today = _todayCairo(), thisMonth = today.slice(0, 7), lastMonth = p4s_prevMonth_(thisMonth), since30 = _addDays(today, -30);

  // ---- one bulk read per sheet (null = unreadable)
  var S = {
    payments: p4s_read_(ss, "Payments", ["status", "scope"], ["note", "created_at", "decided_at", "phone"]),
    videos: p4s_read_(ss, "Videos", ["lesson", "embed_url"]),
    lessons: p4s_read_(ss, "Lessons", ["lesson", "locked"]),
    quizzes: p4s_read_(ss, "Quizzes", ["lesson", "locked"]),
    results: p4s_read_(dataSs, "QuizResults", ["student_id", "lesson"], ["date"]),
    subs: p4s_read_(dataSs, "Submissions", ["student_id", "lesson"], ["date"]),
    written: p4s_read_(dataSs, "WrittenAnswers", ["lesson", "awarded"], ["uploaded_at"]),
    ent: p4s_read_(ss, "Entitlements", ["phone", "scope"]),
    qa: p4s_read_(ss, "QuizAccess", ["phone", "lesson"]),
    groups: p4s_read_(ss, "Groups", ["group"]),
    owners: p4s_read_(ss, "GroupOwners", ["group", "owner_id"]),
    tg: p4s_read_(ss, "TeacherTelegram", ["teacher_id"])
  };
  var students = null;
  try { var sv = _students().getDataRange().getValues(); students = { values: sv, c: _studentCols(sv[0]) }; } catch (e) { students = null; }
  var lessonList = null;
  try { if (typeof _allLessonsFromGithub === "function") lessonList = _allLessonsFromGithub().lessons || []; } catch (e3) { lessonList = null; }

  var subjects = P4S_SUBJECTS.concat([""]);          // "" = rows whose subject is unknown (owner block only)
  var acc = {}; subjects.forEach(function (s) { acc[s] = p4s_block_(); });
  var people = {}, active = {};                      // subject -> {phoneKey: true}
  subjects.forEach(function (s) { people[s] = {}; active[s] = {}; });

  // ---- payments (subject = the payment row's own scope; amount = the system price label only)
  if (S.payments) {
    var P = S.payments.col;
    for (var i = 0; i < S.payments.n; i++) {
      var subj = p4s_subject_(P.scope[i]), b = acc[subj], st = String(P.status[i]).trim().toLowerCase();
      var m = P4S_PRICE_RE.exec(String(P.note[i] || "").trim());
      var amount = m ? parseFloat(m[1]) : null, cur = m ? m[2] : "";
      if (st === "approved") {
        b.payments.approved++;
        if (amount === null) b.payments.unpriced++;
        else {
          p4s_add_(b.revenue.all_time, cur, amount);
          var ym = (p4s_date_(P.decided_at[i]) || p4s_date_(P.created_at[i])).slice(0, 7);
          if (ym === thisMonth) p4s_add_(b.revenue.this_month, cur, amount);
          else if (ym === lastMonth) p4s_add_(b.revenue.last_month, cur, amount);
        }
        var pk = p4s_pk_(P.phone[i]); if (pk) people[subj][pk] = true;
      } else if (st === "pending") {
        b.payments.pending++;
        if (amount !== null) p4s_add_(b.revenue.pending, cur, amount);
        var pk2 = p4s_pk_(P.phone[i]); if (pk2) people[subj][pk2] = true;
      } else if (st === "rejected") b.payments.rejected++;
    }
  }
  // ---- videos, locks
  if (S.videos) for (var v = 0; v < S.videos.n; v++) if (String(S.videos.col.embed_url[v]).trim() !== "") acc[p4s_subject_(S.videos.col.lesson[v])].videos++;
  if (S.lessons) for (var l = 0; l < S.lessons.n; l++) if (_isLockedCell(S.lessons.col.locked[l]) && String(S.lessons.col.lesson[l]).trim() !== "") acc[p4s_subject_(S.lessons.col.lesson[l])].lessons.locked++;
  if (S.quizzes) for (var q = 0; q < S.quizzes.n; q++) if (_isLockedCell(S.quizzes.col.locked[q]) && String(S.quizzes.col.lesson[q]).trim() !== "") acc[p4s_subject_(S.quizzes.col.lesson[q])].quizzes.locked++;
  if (lessonList) lessonList.forEach(function (x) { acc[p4s_subject_(x.lesson)].lessons.total++; });

  // ---- quiz results / submissions: activity and linkage
  [["results", true], ["subs", false]].forEach(function (pair) {
    var src = S[pair[0]]; if (!src) return;
    for (var r = 0; r < src.n; r++) {
      var sj = p4s_subject_(src.col.lesson[r]), k = p4s_pk_(src.col.student_id[r]);
      if (k) people[sj][k] = true;
      var d = p4s_date_(src.col.date[r]), recent = d !== "" && d >= since30;
      if (recent && k) active[sj][k] = true;
      if (recent && pair[1]) acc[sj].quiz_results_30d++;
    }
  });
  if (S.ent) for (var e1 = 0; e1 < S.ent.n; e1++) { var k1 = p4s_pk_(S.ent.col.phone[e1]); if (k1) people[p4s_subject_(S.ent.col.scope[e1])][k1] = true; }
  if (S.qa) for (var e2 = 0; e2 < S.qa.n; e2++) { var k2 = p4s_pk_(S.qa.col.phone[e2]); if (k2) people[p4s_subject_(S.qa.col.lesson[e2])][k2] = true; }

  // ---- written answers waiting for a grade
  if (S.written) {
    for (var w = 0; w < S.written.n; w++) {
      if (String(S.written.col.awarded[w]).trim() !== "") continue;
      var wb = acc[p4s_subject_(S.written.col.lesson[w])];
      wb.written.awaiting++;
      var age = p4s_dayDiff_(today, p4s_date_(S.written.col.uploaded_at[w]));
      if (age !== null && age >= 0 && (wb.written.oldest_days === null || age > wb.written.oldest_days)) wb.written.oldest_days = age;
    }
  }

  // ---- null out what could not be read
  function nullIf(src, fn) { if (!src) subjects.forEach(function (s) { fn(acc[s]); }); }
  nullIf(S.payments, function (b) { b.revenue = null; b.payments = null; });
  nullIf(S.videos, function (b) { b.videos = null; });
  nullIf(S.lessons, function (b) { b.lessons.locked = null; });
  nullIf(S.quizzes, function (b) { b.quizzes.locked = null; });
  nullIf(S.results, function (b) { b.quiz_results_30d = null; });
  nullIf(S.written, function (b) { b.written = null; });
  if (!lessonList) subjects.forEach(function (s) { acc[s].lessons.total = null; });
  if (!S.results || !S.subs || !S.ent || !S.qa || !S.payments) subjects.forEach(function (s) { acc[s].students = null; });
  subjects.forEach(function (s) { acc[s].groups = null; });   // a group has no subject: only per teacher and for the owner

  // subject-level people counts
  if (S.results && S.subs && S.ent && S.qa && S.payments) {
    subjects.forEach(function (s) { acc[s].students = { linked: Object.keys(people[s]).length, active_30d: Object.keys(active[s]).length }; });
  }

  // ---- teachers
  var teachers = [], assistantsOf = {}, ownerRows = 0;
  var sc = students ? students.c : null;
  if (students && sc) {
    var V = students.values;
    var get = function (i, n) { return sc[n] ? V[i][sc[n] - 1] : ""; };
    var lc = function (x) { return String(x == null ? "" : x).trim().toLowerCase(); };
    for (var t = 1; t < V.length; t++) {
      var role = lc(get(t, "role"));
      if (role === "assistant" && String(get(t, "assistant_of")).trim() !== "") {
        var key = p4s_pk_(get(t, "assistant_of")); assistantsOf[key] = (assistantsOf[key] || 0) + 1;
      }
    }
    for (var t2 = 1; t2 < V.length; t2++) {
      if (lc(get(t2, "role")) !== "teacher" || (sc.is_admin && _isTruthyFlag(V[t2][sc.is_admin - 1]))) continue;
      var scope = lc(get(t2, "teacher_scope")).split(",").map(function (x) { return x.trim(); }).filter(function (x) { return P4S_SUBJECTS.indexOf(x) !== -1; });
      if (!scope.length) continue;
      teachers.push({ phone: _restoreLeadingZero(String(V[t2][sc.phone - 1])), name: String(get(t2, "display_name")), scope: scope });
    }
  }
  var coverage = {}; teachers.forEach(function (tc) { tc.scope.forEach(function (s) { coverage[s] = (coverage[s] || 0) + 1; }); });

  var ownerGroupsByTeacher = {};
  if (S.owners) for (var g = 0; g < S.owners.n; g++) {
    var ok = p4s_pk_(S.owners.col.owner_id[g]), gk = String(S.owners.col.group[g]).trim().toLowerCase();
    if (ok && gk) { (ownerGroupsByTeacher[ok] = ownerGroupsByTeacher[ok] || {})[gk] = true; }
  }
  var tgKeys = {};
  if (S.tg) for (var h = 0; h < S.tg.n; h++) { var tk = p4s_pk_(S.tg.col.teacher_id[h]); if (tk) tgKeys[tk] = true; }

  var tBlocks = teachers.map(function (tc) {
    var merged = null;
    tc.scope.forEach(function (s) { var c = p4s_clone_(acc[s]); merged = merged === null ? c : p4s_merge_(merged, c); });
    var tkey = p4s_pk_(tc.phone), block = { phone: tc.phone, name: tc.name, scope: tc.scope };
    Object.keys(merged).forEach(function (k) { block[k] = merged[k]; });
    // people-based metrics come from S3's linkage; without it they are null
    block.students = null;
    try {
      if (typeof p4_linked_ === "function") {
        var linked = p4_linked_({ kind: "teacher", via: "session", id: tc.phone, subjects: tc.scope, principal: tc.phone }) || [];
        var set = {}; linked.forEach(function (x) { var kk = p4s_pk_(x && typeof x === "object" ? (x.phone || x.student_id) : x); if (kk) set[kk] = true; });
        var act = {}; tc.scope.forEach(function (s) { Object.keys(active[s]).forEach(function (kk) { if (set[kk]) act[kk] = true; }); });
        block.students = (S.results && S.subs) ? { linked: Object.keys(set).length, active_30d: Object.keys(act).length } : null;
      }
    } catch (e4) { block.students = null; }
    block.groups = S.owners ? Object.keys(ownerGroupsByTeacher[tkey] || {}).length : null;
    block.assistants = students ? (assistantsOf[tkey] || 0) : null;
    block.telegram = !!tgKeys[tkey];
    if (tc.scope.some(function (s) { return coverage[s] > 1; })) block.shared_subject = true;
    return block;
  });

  // ---- owner (everything, unknown-subject rows included) and totals (sum of the three subjects)
  var owner = null, totals = null;
  subjects.forEach(function (s) { var c = p4s_clone_(acc[s]); owner = owner === null ? c : p4s_merge_(owner, c); });
  P4S_SUBJECTS.forEach(function (s) { var c = p4s_clone_(acc[s]); totals = totals === null ? c : p4s_merge_(totals, c); });
  var allPeople = {}, allActive = {};
  subjects.forEach(function (s) { Object.keys(people[s]).forEach(function (k) { allPeople[k] = true; }); Object.keys(active[s]).forEach(function (k) { allActive[k] = true; }); });
  owner.students = (S.results && S.subs && S.ent && S.qa && S.payments) ? { linked: Object.keys(allPeople).length, active_30d: Object.keys(allActive).length } : null;
  var allGroups = {};
  if (S.groups) { for (var gi = 0; gi < S.groups.n; gi++) { var gg = String(S.groups.col.group[gi]).trim().toLowerCase(); if (gg) allGroups[gg] = true; } owner.groups = Object.keys(allGroups).length; } else owner.groups = null;
  owner.assistants = students ? Object.keys(assistantsOf).reduce(function (n, k) { return n + assistantsOf[k]; }, 0) : null;
  totals.groups = null;
  if (owner.students) { totals.students = { linked: P4S_SUBJECTS.reduce(function (n, s) { return n + (acc[s].students ? acc[s].students.linked : 0); }, 0), active_30d: P4S_SUBJECTS.reduce(function (n, s) { return n + (acc[s].students ? acc[s].students.active_30d : 0); }, 0) }; }
  else totals.students = null;

  var subjectBlocks = P4S_SUBJECTS.map(function (s) {
    var b = p4s_clone_(acc[s]); var out = { subject: s };
    Object.keys(b).forEach(function (k) { out[k] = b[k]; });
    if (coverage[s] > 1) out.shared_subject = true;
    return out;
  });

  return {
    ok: true,
    generated_at: _cairoIso(new Date()),
    cached: false,
    currency_note: "Revenue counts only approved payments whose stored note carries a system price (chapter and term subscriptions, in the currency printed there). Per-lesson payments have no stored amount: they are counted under payments.unpriced and are NOT in revenue. Figures are per currency, never converted.",
    subjects: subjectBlocks,
    teachers: tBlocks,
    owner: owner,
    totals: totals
  };
}
// ===== END MERGED FROM Phase4_Stats.gs =====
