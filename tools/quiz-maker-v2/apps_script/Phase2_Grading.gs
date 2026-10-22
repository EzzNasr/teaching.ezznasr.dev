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
