/**
 * Code.gs — Drive bridge for teaching.ezznasr.dev
 *
 * One Apps Script Web App handles three things:
 *   1. Admin attachment uploads    (action: "upload_attachment", token required)
 *   2. Student assignment uploads  (action: "upload_submission", no token)
 *   3. Student quiz results        (action: "upload_quiz_result", no token)
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
 * 2. In script.google.com, create a new project, paste this file in as
 *    Code.gs, then go to Project Settings → Script Properties and add:
 *      ATTACHMENTS_FOLDER_ID   = <folder id from step 1>
 *      SUBMISSIONS_FOLDER_ID   = <folder id from step 1>
 *      QUIZ_RESULTS_FOLDER_ID  = <folder id from step 1>
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
  };
  var metaBlob = Utilities.newBlob(JSON.stringify(meta, null, 2), "application/json", stem + "--meta.json");
  folder.createFile(metaBlob);

  return { ok: true, file_id: fileId };
}

function handleUploadQuizResult(payload) {
  // No admin token required — same trust model as assignment submissions,
  // this is just "record my score", not a privileged action.
  var folder = _folder("QUIZ_RESULTS_FOLDER_ID");
  var timestamp = Utilities.formatDate(new Date(), "UTC", "yyyyMMdd'T'HHmmss'Z'");
  var stem = _safeName(payload.subject) + "--" + _safeName(payload.lesson) + "--" +
    _slugName(payload.name) + "--" + timestamp;

  var record = {
    subject: payload.subject || null,
    lesson: payload.lesson || null,
    quiz_title: payload.quiz_title || null,
    name: payload.name || null,
    email: payload.email || null,
    date: payload.date || null,
    start_time: payload.start_time || null,
    end_time: payload.end_time || null,
    score: typeof payload.score === "number" ? payload.score : null,
    total: typeof payload.total === "number" ? payload.total : null,
    // Array of { question, your_answer, correct_answer } — only the ones
    // they got wrong, so this file doubles as a quick "what to review" list.
    wrong_questions: Array.isArray(payload.wrong_questions) ? payload.wrong_questions : [],
  };

  var blob = Utilities.newBlob(JSON.stringify(record, null, 2), "application/json", stem + "--quiz-result.json");
  folder.createFile(blob);

  return { ok: true };
}