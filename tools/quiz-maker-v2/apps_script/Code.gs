/**
 * Code.gs — Drive bridge for teaching.ezznasr.dev
 *
 * One Apps Script Web App handles:
 *   1. Admin attachment uploads    (action: "upload_attachment", token required)
 *   2. Student assignment uploads  (action: "upload_submission", no token)
 *   3. Student quiz results        (action: "upload_quiz_result", no token)
 *   4. Student login/register      (check_student / register_student / login_student)
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
// same attempt can't both pass the duplicate check.
function _withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
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

// Writes one row by header NAME (so column order never matters), with the
// TEXT_COLS cells forced to Plain Text first.
function _appendByHeader(sheet, rec) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var seenH = {};
  var row = headers.map(function (h) {
    if (h === "" || seenH[h]) return "";       // a repeated header name is never filled twice
    seenH[h] = true;
    return rec.hasOwnProperty(h) && rec[h] !== null && rec[h] !== undefined ? rec[h] : "";
  });
  var r = sheet.getLastRow() + 1;
  var fmtSeen = {};
  headers.forEach(function (h, i) {
    if (TEXT_COLS[h] && !fmtSeen[h]) { fmtSeen[h] = true; sheet.getRange(r, i + 1).setNumberFormat("@"); }
  });
  sheet.getRange(r, 1, 1, headers.length).setValues([row]);
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
// timestamp; ISO strings in time columns get the same treatment.
function _cellOut(header, v, sheetTz) {
  if (v instanceof Date) {
    if (header === "date") return _fmt(v, sheetTz, false);
    if (header === "created_at") return _fmt(v, sheetTz, true);
    return _fmt(v, TZ, true);
  }
  if (typeof v === "string" && TIME_COLS[header]) return _cairoTime(v);
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

function _students() {
  var sheet = _ss().getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["phone", "password_hash", "display_name", "created_at", "session_token", "is_admin", "year", "parent_phone"]);
  } else {
    _ensureStudentColumns(sheet);
  }
  // Force the phone column to Plain Text. Without this, Sheets treats a
  // typed number like "01275001758" as numeric and silently drops the
  // leading zero, which then permanently mismatches every future
  // check_student/login_student lookup for that student. This only
  // prevents it going forward — a phone already stored numeric needs a
  // one-time manual fix (reformat the column, then retype that cell).
  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 2), 1).setNumberFormat("@");
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

// Lenient match key: strips everything but digits so "010 123 4567",
// "010-123-4567", and "0101234567" all land on the same student — the
// stored phone column keeps whatever the student actually typed.
function _normalizePhone(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}

// Two phone-derived digit strings are considered the same number if
// they're identical, OR if the shorter is a trailing suffix of the
// longer (7+ digits shared) — this is what actually makes a lookup
// survive a leading-zero drop (a known Sheets auto-formatting bug, see
// _students() below), a country-code prefix ("+20..." vs "0..."), or a
// phone number hand-corrected in the Sheet after some QuizResults/
// Submissions rows were already written with the old digits baked in.
// Comparing with strict equality (the old behavior) meant any of those
// permanently orphaned a student's own historical rows from every
// lookup that mattered — their own dashboard, the roster's per-student
// counts, everything. The 7-digit floor keeps this from ever matching
// two genuinely different, unrelated numbers on a short coincidental
// trailing fragment.
function _phonesMatch(a, b) {
  var da = _normalizePhone(a), db = _normalizePhone(b);
  if (!da || !db) return false;
  if (da === db) return true;
  var shorter = da.length <= db.length ? da : db;
  var longer = da.length <= db.length ? db : da;
  return shorter.length >= 7 && longer.slice(-shorter.length) === shorter;
}

// Returns {row, phone, password_hash, display_name, created_at,
// session_token, is_admin} for the first matching row (1-indexed, header
// is row 1), or null.
function _findStudentRow(sheet, phone) {
  var target = _normalizePhone(phone);
  if (!target) return null;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][0], target)) {
      return {
        row: i + 1,
        phone: values[i][0],
        password_hash: values[i][1],
        display_name: values[i][2],
        created_at: values[i][3],
        session_token: values[i][4] || null,
        is_admin: values[i][5] === true || String(values[i][5]).toUpperCase() === "TRUE",
        year: values[i][6] || null,
        parent_phone: values[i][7] || null,
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
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][0], target)) {
      if (String(values[i][4]) === String(payload.session_token)) return true;
      throw new Error("Session expired or invalid — please log in again.");
    }
  }
  throw new Error("No matching student.");
}

function _requireAdminSession(payload) {
  if (!payload.student_id || !payload.session_token) throw new Error("Missing session.");
  var values = _students().getDataRange().getValues();
  var target = _normalizePhone(payload.student_id);
  for (var i = 1; i < values.length; i++) {
    if (_phonesMatch(values[i][0], target)) {
      var isAdmin = values[i][5] === true || String(values[i][5]).toUpperCase() === "TRUE";
      if (String(values[i][4]) === String(payload.session_token) && isAdmin) return true;
      throw new Error("Not authorized.");
    }
  }
  throw new Error("Not authorized.");
}

function handleCheckStudent(payload) {
  if (!payload.phone) throw new Error("Missing phone number.");
  var sheet = _students();
  var found = _findStudentRow(sheet, payload.phone);
  return { ok: true, known: !!found, display_name: found ? found.display_name : null };
}

function handleRegisterStudent(payload) {
  if (!payload.phone || !payload.password_hash) throw new Error("Missing phone or password.");
  var sheet = _students();
  var existing = _findStudentRow(sheet, payload.phone);
  if (existing) throw new Error("An account with that phone number already exists — log in instead.");
  var phone = String(payload.phone).trim();
  var displayName = String(payload.display_name || phone).trim();
  // Cairo local time, not UTC — new Date().toISOString() is always UTC.
  var createdAt = Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss");
  var token = Utilities.getUuid();
  // year ("Senior 1" / "Senior 2") and parent_phone are both asked at
  // registration only, never at login — neither required here so a stale
  // cached auth.js mid-rollout can still register students, just without
  // these on file yet.
  var year = payload.year || "";
  var parentPhone = payload.parent_phone || "";
  sheet.appendRow([phone, payload.password_hash, displayName, createdAt, token, "", year, parentPhone]);
  // is_admin is always false on a fresh registration — the flag can only
  // ever be set by hand, directly in the Sheet (see the setup comment at
  // the top of this file), never through any web-facing action.
  return { ok: true, student_id: _normalizePhone(phone), student_name: displayName, session_token: token, year: year, parent_phone: parentPhone, is_admin: false };
}

function handleLoginStudent(payload) {
  if (!payload.phone || !payload.password_hash) throw new Error("Missing phone or password.");
  var sheet = _students();
  var found = _findStudentRow(sheet, payload.phone);
  if (!found) throw new Error("No account found for that phone number — register first.");
  if (String(found.password_hash) !== String(payload.password_hash)) {
    throw new Error("Incorrect password.");
  }
  // Accounts registered before the session_token column existed won't
  // have one yet — issue it on this login instead of forcing a
  // re-registration.
  var token = found.session_token;
  if (!token) {
    token = Utilities.getUuid();
    sheet.getRange(found.row, 5).setValue(token);
  }
  return { ok: true, student_id: _normalizePhone(found.phone), student_name: found.display_name, session_token: token, year: found.year || "", parent_phone: found.parent_phone || "", is_admin: !!found.is_admin };
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
  sheet.getRange(found.row, 7).setValue(payload.year);
  sheet.getRange(found.row, 8).setValue(payload.parent_phone);
  return { ok: true, year: payload.year, parent_phone: payload.parent_phone };
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

      case "update_profile":
        return _json(handleUpdateProfile(payload));

      case "get_my_results":
        return _json(handleGetMyResults(payload));

      case "admin_get_all":
        return _json(handleAdminGetAll(payload));

      default:
        return _json({ ok: false, error: "Unknown action: " + payload.action });
    }
  } catch (err) {
    return _json({ ok: false, error: String(err.message || err) });
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

function handleUploadSubmission(payload) {
  // No admin token required — this is the public "hand in your work" path.
  // student_id IS required (confirmed assign.js always sends it as of the
  // login rollout) — rejecting outright here beats silently accepting an
  // orphaned row nothing can ever match back to a student.
  if (!payload.student_id) throw new Error("Missing student_id — please sign in and try again.");

  return _withLock(function () {
    var sheet = _submissionsSheet();
    var keys = _submissionKeys(payload);
    // Checked BEFORE any Drive file is created, so a re-sent copy leaves
    // no orphan files behind either.
    if (_anySeen(_existingKeys(sheet), keys)) return { ok: true, duplicate: true };

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
    folder.createFile(metaBlob);

    // Mirror into the Submissions sheet — this is what the dashboards
    // actually query. The Drive JSON above stays as the durable per-attempt
    // record with the full, untruncated text.
    var fullText = meta.text || "";
    var truncated = fullText.length > TEXT_CELL_LIMIT;
    var cellText = truncated ? fullText.slice(0, TEXT_CELL_LIMIT) : fullText;

    _appendByHeader(sheet, {
      student_id: meta.student_id, name: meta.name, subject: meta.subject, lesson: meta.lesson,
      submission_type: meta.submission_type, text: cellText, text_truncated: truncated,
      url: meta.url, note: meta.note, file_id: meta.file_id, file_name: meta.file_name,
      date: meta.date, submitted_time: meta.submitted_time, score: meta.score, total: meta.total,
      answers_json: JSON.stringify(meta.answers || []), dedupe_key: keys[0],
    });

    return { ok: true, file_id: fileId };
  });
}

function handleUploadQuizResult(payload) {
  // No admin token required — same trust model as assignment submissions,
  // this is just "record my score", not a privileged action. student_id
  // IS required though (confirmed quiz.js always sends it as of the login
  // rollout) — same reasoning as handleUploadSubmission above.
  if (!payload.student_id) throw new Error("Missing student_id — please sign in and try again.");

  return _withLock(function () {
    var sheet = _quizResultsSheet();
    var keys = _quizKeys(payload);
    if (_anySeen(_existingKeys(sheet), keys)) return { ok: true, duplicate: true };

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
    folder.createFile(blob);

    // Mirror into the QuizResults sheet — this is what the dashboards
    // query; the Drive JSON above stays as the durable per-attempt record.
    _appendByHeader(sheet, {
      student_id: record.student_id, name: record.name, subject: record.subject, lesson: record.lesson,
      quiz_title: record.quiz_title, date: record.date, start_time: record.start_time, end_time: record.end_time,
      score: record.score, total: record.total,
      questions_json: JSON.stringify(record.questions || record.wrong_questions || []),
      dedupe_key: keys[0],
    });

    return { ok: true };
  });
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