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
