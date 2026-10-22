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
    (g.settings.review_lessons || []).forEach(function (l) {
      var c = _p2fuCanon(l); if (!c) return;
      var e = expected[c] = expected[c] || { lesson: c, group_due: "" };
      if (due && (!e.group_due || due < e.group_due)) e.group_due = due;
    });
  });
  Object.keys(X.req).forEach(function (l) {
    var r = X.req[l]; if (r.due_override && r.due_override <= to && !expected[l]) expected[l] = { lesson: l, group_due: "" };
  });
  function everDone(rowsByKey, subject, slug) { return !!(rowsByKey || []).some(function (r) { return r.slug === slug && (r.subject === "" || r.subject === subject) && (!r.date || r.date <= to); }); }
  var exp = Object.keys(expected).sort().map(function (l) {
    var rq = _p2fuReq(X.req, l), subject = _firstSegment(l), slug = _p2fuSlug(l);
    var due = rq.due_override || expected[l].group_due || "";
    var quizDone = everDone(X.quiz[key], subject, slug), hwDone = everDone(X.hw[key], subject, slug);
    var duePassed = !due || X.today > due;
    return { lesson: l, quiz: { required: rq.quiz_required, done: quizDone, missed: rq.quiz_required && !quizDone && duePassed },
             homework: { required: rq.homework_required, done: hwDone, due: due, missed: rq.homework_required && !hwDone && duePassed } };
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
  return { student: { phone: st.phone, name: st.name, year: st.year, parent_phone: st.parent_phone }, groups: gOut, range: { from: from, to: to },
           totals: totals, quizzes: quizzes, homework: homework, expected: exp, attendance: att, watch: watchList, video_access: access, written: w, notifications: notifs };
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
  return _withLock(function () {
    var ss = _ss();
    var sh = _followupSheet(ss, "MonthlyReviews", P2_FU_MONTHLY_HEADERS);
    _ensureColumns(sh, P2_FU_MONTHLY_HEADERS);
    var c = _needCols(sh, "MonthlyReviews", P2_FU_MONTHLY_HEADERS);
    var hit = null;
    _p2fuRows(sh).forEach(function (m) { if (!hit && _phoneKey(m.student) === key && String(m.month).trim() === r.month) hit = m; });
    var now = _p2fuNow(), sent = status === "sent" ? now : (hit ? String(hit.sent_at || "") : "");
    if (hit) {
      sh.getRange(hit._row, c.status).setValue(status);
      sh.getRange(hit._row, c.sent_at).setNumberFormat("@").setValue(sent);
      if (payload.note !== undefined) sh.getRange(hit._row, c.note).setNumberFormat("@").setValue(note);
    } else {
      _appendByHeader(sh, { student: _canonicalPhone(digits) || digits, month: r.month, status: status, sent_at: sent, note: note });
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
  return o;
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
