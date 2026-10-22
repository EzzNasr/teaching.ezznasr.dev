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
  if (q && q.qid !== undefined && q.qid !== null && q.qid !== "") return String(q.qid);
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
    else cache.put(rk, String(used + 1), 3600);
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
        graded: String(w[wc.graded_at - 1] || "") !== ""
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
      else if (q.pending) { it.status = "pending"; it.is_correct = null; }
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
