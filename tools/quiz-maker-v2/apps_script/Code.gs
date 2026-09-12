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
 *    spreadsheets or extra Script Properties required for those.
 *
 * 2. In script.google.com, create a new project, paste this file in as
 *    Code.gs, then go to Project Settings → Script Properties and add:
 *      ATTACHMENTS_FOLDER_ID   = <folder id from step 1>
 *      SUBMISSIONS_FOLDER_ID   = <folder id from step 1>
 *      QUIZ_RESULTS_FOLDER_ID  = <folder id from step 1>
 *      STUDENTS_SHEET_ID       = <sheet id from step 1b>
 *      ADMIN_TOKEN             = <any long random string you make up>
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

// Creates the tab (with header row) on first use if it doesn't exist yet.
function _sheetByName(name, headers) {
  var ss = _ss();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  return sheet;
}

function _quizResultsSheet() {
  return _sheetByName("QuizResults", [
    "student_id", "name", "subject", "lesson", "quiz_title",
    "date", "start_time", "end_time", "score", "total", "questions_json",
  ]);
}

function _submissionsSheet() {
  var sheet = _sheetByName("Submissions", [
    "student_id", "name", "subject", "lesson", "submission_type",
    "text", "text_truncated", "url", "note", "file_id", "file_name",
    "date", "submitted_time", "score", "total", "answers_json",
  ]);
  _ensureSubmissionsColumns(sheet);
  return sheet;
}

// Adds score/total/answers_json headers (graded assignments) to a
// Submissions sheet that predates them, without touching already-written
// rows — same additive pattern as _ensureStudentColumns.
function _ensureSubmissionsColumns(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ["score", "total", "answers_json"].forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(col);
    }
  });
}

// Shared by both dashboard-facing actions: turns a sheet's rows into
// [{header: value}, ...] using row 1 as keys.
function _sheetValuesAsObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
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

// Returns {row, phone, password_hash, display_name, created_at,
// session_token, is_admin} for the first matching row (1-indexed, header
// is row 1), or null.
function _findStudentRow(sheet, phone) {
  var target = _normalizePhone(phone);
  if (!target) return null;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (_normalizePhone(values[i][0]) === target) {
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
    if (_normalizePhone(values[i][0]) === target) {
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
    if (_normalizePhone(values[i][0]) === target) {
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
  return { ok: true, student_id: _normalizePhone(phone), student_name: displayName, session_token: token, year: year, parent_phone: parentPhone };
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
  return { ok: true, student_id: _normalizePhone(found.phone), student_name: found.display_name, session_token: token, year: found.year || "", parent_phone: found.parent_phone || "" };
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
  var folder = _folder("SUBMISSIONS_FOLDER_ID");
  var timestamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd'T'HHmmss'Z'");
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

  var meta = {
    subject: payload.subject || null,
    lesson: payload.lesson || null,
    // student_id (v2 login) — required, checked above.
    student_id: payload.student_id,
    name: payload.name || null,
    email: payload.email || null,
    date: payload.date || null,
    submitted_time: payload.submitted_time || null,
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

  _submissionsSheet().appendRow([
    meta.student_id, meta.name, meta.subject, meta.lesson, meta.submission_type,
    cellText, truncated, meta.url, meta.note, meta.file_id, meta.file_name,
    meta.date, meta.submitted_time, meta.score, meta.total,
    JSON.stringify(meta.answers || []),
  ]);

  return { ok: true, file_id: fileId };
}

function handleUploadQuizResult(payload) {
  // No admin token required — same trust model as assignment submissions,
  // this is just "record my score", not a privileged action. student_id
  // IS required though (confirmed quiz.js always sends it as of the login
  // rollout) — same reasoning as handleUploadSubmission above.
  if (!payload.student_id) throw new Error("Missing student_id — please sign in and try again.");
  var folder = _folder("QUIZ_RESULTS_FOLDER_ID");
  var timestamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd'T'HHmmss'Z'");
  var stem = _safeName(payload.subject) + "--" + _safeName(payload.lesson) + "--" +
    _slugName(payload.name) + "--" + timestamp;

  var record = {
    subject: payload.subject || null,
    lesson: payload.lesson || null,
    quiz_title: payload.quiz_title || null,
    // student_id (v2 login) — required, checked above.
    student_id: payload.student_id,
    name: payload.name || null,
    email: payload.email || null,
    date: payload.date || null,
    start_time: payload.start_time || null,
    end_time: payload.end_time || null,
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
  // actually query; the Drive JSON above stays as the durable per-attempt
  // record, unchanged.
  _quizResultsSheet().appendRow([
    record.student_id, record.name, record.subject, record.lesson, record.quiz_title,
    record.date, record.start_time, record.end_time, record.score, record.total,
    JSON.stringify(record.questions || record.wrong_questions || []),
  ]);

  return { ok: true };
}

// -- Dashboards ---------------------------------------------------------

function handleGetMyResults(payload) {
  _requireStudentSession(payload);
  var target = _normalizePhone(payload.student_id);

  var quizRows = _sheetValuesAsObjects(_quizResultsSheet())
    .filter(function (r) { return _normalizePhone(r.student_id) === target; });
  var subRows = _sheetValuesAsObjects(_submissionsSheet())
    .filter(function (r) { return _normalizePhone(r.student_id) === target; });

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
