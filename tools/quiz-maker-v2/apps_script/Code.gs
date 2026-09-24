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
 *   {locked:true, need:"login"|"payment"} and NO url. The lock FAILS CLOSED: only
 *   an explicit FALSE in the locked cell opens a video; blank/typo stays locked.
 * - admin_set_video {lesson, slot, video_url?, locked?} adds/updates/clears a
 *   slot (video_url "" clears it). New videos start LOCKED. admin_list_videos
 *   lists them all. Both take EITHER the desktop app's ADMIN_TOKEN ("token")
 *   OR an admin session (student_id + session_token).
 * - Looked-up rows are cached for VIDEO_CACHE_SECONDS; admin_set_video clears the
 *   cache entry at once, but flipping the locked cell by hand in the Sheet can
 *   take up to that long to show.
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

function _requireAdmin(payload) {
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
      if (String(values[i][c.session_token - 1]) === String(payload.session_token) && isAdmin) return true;
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
  return _withLock(function () {
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
  // Accounts registered before the session_token column existed won't
  // have one yet — issue it on this login instead of forcing a
  // re-registration.
  var token = found.session_token;
  if (!token) {
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

  try {
    switch (payload.action) {
      case "ping":
        _requireAdmin(payload);
        return _json({ ok: true, message: "pong" });

      case "upload_attachment":
        return _json(handleUploadAttachment(payload));

      case "delete_attachment":
        return _json(handleDeleteAttachment(payload));

      case "upload_submission":
        return _json(handleUploadSubmission(payload));

      case "upload_quiz_result":
        return _json(handleUploadQuizResult(payload));

      case "check_student":
        return _json(handleCheckStudent(payload));

      case "register_student":
        return _json(handleRegisterStudent(payload));

      case "login_student":
        return _json(handleLoginStudent(payload));

      case "reset_password":
        return _json(handleResetPassword(payload));

      case "update_profile":
        return _json(handleUpdateProfile(payload));

      case "get_my_results":
        return _json(handleGetMyResults(payload));

      case "admin_get_all":
        return _json(handleAdminGetAll(payload));

      case "get_video":
        return _json(handleGetVideo(payload));

      case "admin_set_video":
        return _json(handleAdminSetVideo(payload));

      case "admin_list_videos":
        return _json(handleAdminListVideos(payload));

      default:
        return _json({ ok: false, error: "Unknown action: " + payload.action });
    }
  } catch (err) {
    var out = { ok: false, error: String(err.message || err) };
    if (err && err.retryable) out.retryable = true;   // lock was busy — the browser may resend the same record
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
  DriveApp.getFileById(payload.file_id).setTrashed(true);
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
function _videoKey(lesson, slot) {
  var l = String(lesson == null ? "" : lesson).trim().toLowerCase()
    .replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  var s = String(slot == null ? "" : slot).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._\/-]{0,199}$/.test(l) || l.indexOf("..") !== -1) throw new Error("Missing or invalid lesson.");
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

function _videoCols(sheet) {
  var idx = _headerIndex(sheet);
  ["lesson", "slot", "embed_url", "locked"].forEach(function (n) {
    if (!idx[n]) throw new Error('The Videos sheet is missing the "' + n + '" column (renamed or deleted?).');
  });
  return idx;
}

function _findVideoRow(sheet, lesson, slot) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var c = _videoCols(sheet);
  var values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][c.lesson - 1]).trim().toLowerCase() === lesson &&
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

// "none" (not signed in / stale token), "student" or "admin". Never throws for a
// bad session — get_video is public, so a bad session just means "not signed in".
function _sessionState(payload) {
  if (!payload.student_id || !payload.session_token) return "none";
  var values = _students().getDataRange().getValues();
  var c = _studentCols(values[0]);
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][c.phone - 1], target)) {
      if (String(values[i][c.session_token - 1]) !== String(payload.session_token)) return "none";
      return (c.is_admin && _isTruthyFlag(values[i][c.is_admin - 1])) ? "admin" : "student";
    }
  }
  return "none";
}

// The desktop app authenticates with ADMIN_TOKEN ("token"); the web dashboards
// with an admin session. Either one is enough.
function _requireAdminAny(payload) {
  if (payload.token) { _requireAdmin(payload); return; }
  _requireAdminSession(payload);
}

// Public. The URL is only in the answer when the viewer may actually watch.
function handleGetVideo(payload) {
  var key = _videoKey(payload.lesson, payload.slot);
  var rec = _lookupVideo(key.lesson, key.slot);
  if (!rec) return { ok: true, found: false };
  if (!rec.locked) return { ok: true, found: true, locked: false, embed_url: rec.embed_url };
  var who = _sessionState(payload);
  if (who === "admin") return { ok: true, found: true, locked: true, embed_url: rec.embed_url };
  return { ok: true, found: true, locked: true, need: who === "student" ? "payment" : "login" };
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