// =============================================================================================
//  FollowupLogic.gs  --  GENERATED FILE.  DO NOT EDIT BY HAND.
//
//  Built by:  python scripts/build_server_logic.py        (CI / pre-deploy:  --check)
//  Sources (sha256, line endings normalised):
//    assets/followup-logic.js    43565edc38ea34c93b3b065055c892015404710f555b950ea99928094d2fbbbb
//    assets/followup-events.js   98db77ff8dcabf44016c9aaaa1cd2e99c56853f2ea0188bf0337711475547b42
//
//  What it is: the browser modules FollowupLogic and FollowupEvents, copied unchanged and wrapped so
//  that the Telegram tick and the follow-up page decide "what is due" with the SAME code.
//  Public functions:
//    fu2_logic_eventsFor_(overview, groupKey, nowIso)
//    fu2_logic_dueNow_(overview, nowIso)
//    fu2_logic_version_()
//    fu2_logic_selfCheck()      <- run this once from the Apps Script editor after every deploy
//
//  Time zone: every date is computed in Africa/Cairo through Utilities.formatDate; any text a person
//  reads says "Alex".
// =============================================================================================

var FU2_LOGIC_VERSION = "1.0.0+a080412b8b59";

// Intl stand-in (only DateTimeFormat#formatToParts is used by the two modules).
var FU2_LOGIC_INTL_ = {
  DateTimeFormat: function (locale, opts) {
    var tz = (opts && opts.timeZone) || "Africa/Cairo";
    return {
      formatToParts: function (date) {
        var s = Utilities.formatDate(date, tz, "yyyy-MM-dd HH:mm:ss");
        var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
        if (!m) throw new Error("fu2_logic: unexpected Utilities.formatDate output: " + s);
        return [
          { type: "year", value: m[1] }, { type: "literal", value: "-" },
          { type: "month", value: m[2] }, { type: "literal", value: "-" },
          { type: "day", value: m[3] }, { type: "literal", value: " " },
          { type: "hour", value: m[4] }, { type: "literal", value: ":" },
          { type: "minute", value: m[5] }, { type: "literal", value: ":" },
          { type: "second", value: m[6] }
        ];
      }
    };
  }
};

// ---- assets/followup-logic.js (verbatim) ----
var FU2_LOGIC_LOGIC_ = (function () {
  var module = { exports: {} };
  var Intl = FU2_LOGIC_INTL_;
/* followup-logic.js — pure status logic for dashboard/followup.html (Chunk 3).
 *
 * No DOM, no network, no globals read except Intl. UMD: window.FollowupLogic in
 * browsers, module.exports in Node. Implements §4.1 (time/deadlines, Cairo) and §4.2
 * (lesson roles, verdicts, summaries, parent-phone check) of the follow-up build guide.
 *
 * Conventions
 *  - `now` is always optional: Date | ISO string | ms. Default = overview.now, else new Date().
 *  - Lesson ids are the full lowercase paths used as keys in overview.lessons / overview.facts.
 *  - Students are keyed by phoneKey (last 10 digits).
 *  - Missing facts are treated as "nothing recorded" (attendance null, no watch row, quiz not
 *    taken, homework not submitted). Missing lesson metadata is treated as "has everything".
 *  - A deadline is the END of its Cairo date (23:59:59.999). "Due" = deadline state "overdue".
 *    A group with no known schedule (e.g. the unclassified tab before a lesson set is chosen)
 *    has no deadlines, so nothing session/homework-related is "due" there (buttons muted).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FollowupLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'Africa/Cairo';
  var DEFAULT_SETTINGS = { watch_done_pct: 80, praise_quiz_pct: 90, watch_days_before: 3, hw_days_before: 1 };
  var WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  /* ---------------------------------------------------------------- small helpers */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }

  function mergeSettings(s) {
    var o = {};
    for (var k in DEFAULT_SETTINGS) {
      var v = s && num(s[k]);
      o[k] = (v === null || v === undefined || (s && (s[k] === '' || s[k] === null))) ? DEFAULT_SETTINGS[k] : v;
    }
    return o;
  }

  function toDate(v, overview) {
    if (v instanceof Date) return v;
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string' && v) { var d = new Date(v); if (!isNaN(d)) return d; }
    if (overview && overview.now) { var d2 = new Date(overview.now); if (!isNaN(d2)) return d2; }
    return new Date();
  }

  /* ------------------------------------------------------------------- phones */
  function toAsciiDigits(s) {
    return String(s == null ? '' : s)
      .replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x660); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x6F0); });
  }

  /** Last 10 digits of a phone (handles Arabic-Indic digits, spaces, +20, leading 0). */
  function phoneKey(p) {
    var d = toAsciiDigits(p).replace(/\D/g, '');
    return d.length > 10 ? d.slice(-10) : d;
  }

  var EG_MOBILE = /^(?:20|0)?1[0125]\d{8}$/;   // digits only (the "+" is stripped first)

  function parsePhone(raw) {
    var s = toAsciiDigits(raw == null ? '' : raw).trim();
    var out = { blank: false, digits: '', short: false, egyptian: false, international: false, wa: '' };
    if (!s || !/\d/.test(s)) { out.blank = true; return out; }
    var intl = /^(\+|00)/.test(s);
    var digits = s.replace(/\D/g, '');
    if (/^00/.test(s)) digits = digits.replace(/^00/, '');
    out.digits = digits;
    out.egyptian = EG_MOBILE.test(digits);
    if (out.egyptian) out.wa = '20' + digits.slice(-10);
    else if (intl && !/^20/.test(digits) && digits.length >= 8 && digits.length <= 15) { out.international = true; out.wa = digits; }
    out.short = digits.length < 10;
    return out;
  }

  /** Digits for https://wa.me/<digits>; '' when the number can't be turned into one. */
  function waDigits(p) { var r = parsePhone(p); return r.short ? '' : r.wa; }

  /**
   * §4.2 parent check → {ok, level:"ok"|"warn"|"missing", reason, note, wa, canSend, fallbackWa}.
   *  - missing: blank. wa = '' (UI disables the buttons). fallbackWa = the student's own number
   *    for the §0 "fall back to the student's number" option; the UI decides whether to use it.
   *  - warn: < 10 digits, equals the student's own number, or isn't an Egyptian mobile.
   *    `wa` is still filled when the number is usable so the owner may send after reading the warning
   *    (canSend). Too-short numbers have wa = ''.
   *  - ok: Egyptian mobile; or a non-Egyptian number with a country code (ok + a "check" note).
   */
  function checkParentPhone(parent, studentPhone) {
    var p = parsePhone(parent);
    var res = { ok: false, level: 'missing', reason: '', note: '', wa: '', canSend: false, fallbackWa: waDigits(studentPhone) };
    if (p.blank) { res.reason = 'لا يوجد رقم ولي أمر'; return res; }
    res.wa = p.short ? '' : p.wa;
    var own = phoneKey(studentPhone);
    if (p.short) { res.level = 'warn'; res.reason = 'رقم ولي الأمر أقصر من ١٠ أرقام'; }
    else if (own && phoneKey(p.digits) === own) { res.level = 'warn'; res.reason = 'رقم ولي الأمر هو نفس رقم الطالب'; }
    else if (!p.egyptian && !p.international) { res.level = 'warn'; res.reason = 'الرقم لا يبدو رقم موبايل مصري صحيح'; }
    else { res.level = 'ok'; res.ok = true; if (p.international) res.note = 'رقم دولي — راجع الرقم قبل الإرسال'; }
    res.canSend = !!res.wa;
    return res;
  }

  /* ------------------------------------------------------- Cairo calendar helpers */
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  function cairoParts(date) {
    var o = {};
    fmt.formatToParts(date).forEach(function (p) { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
    if (o.hour === 24) o.hour = 0;
    return o;
  }
  function ymd(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d };
  }
  function addDays(s, n) {
    var p = parseYmd(s), dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function weekdayOf(s) { var p = parseYmd(s); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
  function cairoToday(now) { var p = cairoParts(now); return ymd(p.year, p.month, p.day); }

  /** The real instant of a Cairo wall-clock time (works across DST changes). */
  function cairoInstant(dateStr, hh, mm) {
    var p = parseYmd(dateStr), wall = Date.UTC(p.y, p.m - 1, p.d, hh, mm, 0), guess = wall;
    for (var i = 0; i < 4; i++) {
      var c = cairoParts(new Date(guess));
      var shown = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
      var diff = wall - shown;
      if (!diff) break;
      guess += diff;
    }
    return new Date(guess);
  }

  /* --------------------------------------------------------------- §4.1 deadlines */
  /**
   * First occurrence at or after `now` of weekday (0=Sun…6=Sat) at "HH:MM" Cairo time.
   * → {date:'yyyy-mm-dd', weekday, time:'HH:MM', at:Date} or null when weekday/time are unset/invalid.
   */
  function nextSession(now, weekday, time) {
    now = toDate(now);
    if (weekday === '' || weekday == null) return null;
    var wd = Number(weekday), tm = /^(\d{1,2}):(\d{2})$/.exec(String(time == null ? '' : time).trim());
    if (!isFinite(wd) || wd < 0 || wd > 6 || wd !== Math.floor(wd) || !tm) return null;
    var hh = +tm[1], mm = +tm[2];
    if (hh > 23 || mm > 59) return null;
    var today = cairoToday(now);
    for (var k = 0; k <= 7; k++) {
      var d = addDays(today, k);
      if (weekdayOf(d) !== wd) continue;
      var at = cairoInstant(d, hh, mm);
      if (at.getTime() >= now.getTime()) return { date: d, weekday: wd, time: pad(hh) + ':' + pad(mm), at: at };
    }
    return null;
  }

  function dlParts(dl) {
    if (!dl) return null;
    if (dl instanceof Date) { var d0 = cairoToday(dl); return { date: d0, end: endOf(d0) }; }
    if (typeof dl === 'string') { return parseYmd(dl) ? { date: dl.trim(), end: endOf(dl.trim()) } : null; }
    if (dl.date && parseYmd(dl.date)) return { date: dl.date, end: dl.end instanceof Date ? dl.end : endOf(dl.date) };
    return null;
  }
  function endOf(date) { return new Date(cairoInstant(date, 23, 59).getTime() + 59999); }

  /** "upcoming" | "today" | "overdue" (null when there's no deadline). `dl` = {date,end} | 'yyyy-mm-dd' | Date. */
  function deadlineState(now, dl) {
    var p = dlParts(dl);
    if (!p) return null;
    now = toDate(now);
    if (now.getTime() > p.end.getTime()) return 'overdue';
    return cairoToday(now) === p.date ? 'today' : 'upcoming';
  }

  /**
   * Deadlines of a group (settings = group.settings; app = overview.settings, optional).
   * → { nextSession, watch:{date,end,overridden,state}|null, hw:{…}|null }
   * watch = 3 days before the next session (applies to the CURRENT lesson),
   * hw = 1 day before (applies to the homework & quiz lessons). A valid yyyy-MM-dd override replaces it.
   * With `overview` (optional) and no group hw override, a homework/quiz lesson's own due date
   * (lessons[path].due_override) counts too: hw is the earliest of those lessons' dates.
   */
  function groupDeadlines(settings, now, app, overview) {
    settings = settings || {};
    now = toDate(now);
    var cfg = mergeSettings(app), ns = nextSession(now, settings.weekday, settings.time);
    function mk(override, before) {
      var ov = String(override == null ? '' : override).trim(), date = null, overridden = false;
      if (ov && parseYmd(ov)) { date = ov; overridden = true; }
      else if (ns) date = addDays(ns.date, -before);
      if (!date) return null;
      var o = { date: date, end: endOf(date), overridden: overridden };
      o.state = deadlineState(now, o);
      return o;
    }
    var hw = mk(settings.hw_deadline_override, cfg.hw_days_before);
    if (overview && !(hw && hw.overridden)) {
      var dates = [];
      pathList(hwList(settings).concat(quizList(settings))).forEach(function (p) {
        var m = lessonMeta(overview, p), ov = String((m && m.due_override) || '').trim();
        dates.push(ov && parseYmd(ov) ? ov : (hw ? hw.date : ''));
      });
      var own = dates.filter(function (d) { return d && (!hw || d !== hw.date); }).length > 0;
      var first = own ? dates.filter(Boolean).sort()[0] : '';
      if (first && (!hw || first !== hw.date)) hw = mk(first, 0);
    }
    return { nextSession: ns, watch: mk(settings.watch_deadline_override, cfg.watch_days_before), hw: hw };
  }

  /** Arabic phrase: النهارده / بكرة / يوم {weekday} {d/m}. */
  function deadlineWhen(now, dl) {
    var p = dlParts(dl);
    if (!p) return '';
    now = toDate(now);
    var today = cairoToday(now);
    if (p.date === today) return 'النهارده';
    if (p.date === addDays(today, 1)) return 'بكرة';
    var q = parseYmd(p.date);
    return 'يوم ' + WEEKDAYS_AR[weekdayOf(p.date)] + ' ' + q.d + '/' + q.m;
  }

  /* ------------------------------------------------------------- fact look-ups */
  function lessonMeta(overview, path) {
    var L = overview && overview.lessons;
    return (L && path && (L[path] || L[String(path).toLowerCase()])) || null;
  }
  function factsFor(overview, student, path) {
    var f = overview && overview.facts, k = phoneKey(student && student.phone);
    var byStudent = f && f[k];
    return (byStudent && path && (byStudent[path] || byStudent[String(path).toLowerCase()])) || {};
  }
  function pathList(r) {
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = r ? [r] : []; } }
    if (!Array.isArray(r)) r = [];
    var seen = {}, out = [];
    r.forEach(function (x) { x = String(x || '').trim(); if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }
  // The group's shared "previous lessons" list, and (Oct 22) the separate homework / quiz lists.
  // hw_lessons / quiz_lessons: null, undefined or "" = never split = follow review_lessons; an array (even []) = exactly that.
  function reviewList(gs) { return pathList(gs && gs.review_lessons); }
  function kindList(gs, key) {
    var v = gs && gs[key];
    return (v === null || v === undefined || v === '') ? reviewList(gs) : pathList(v);
  }
  function hwList(gs) { return kindList(gs, 'hw_lessons'); }
  function quizList(gs) { return kindList(gs, 'quiz_lessons'); }
  function allReviewLessons(gs) { return pathList(reviewList(gs).concat(hwList(gs), quizList(gs))); }
  function mergeOverride(gs, ymd) { var o = {}; for (var k in gs) o[k] = gs[k]; o.hw_deadline_override = ymd; return o; }
  function hasFlag(meta, key) { return !meta || meta[key] !== false; }   // unknown meta → assume present

  /* --------------------------------------------------------------- §4.2 verdicts */
  /**
   * Per-student verdicts for the two lesson roles.
   * → { session:{lesson,state,attendance,can_watch,watch_pct,due,deadline_state,praise},
   *     homework:[{lesson,state,due,deadline_state,at,…}], quiz:[{lesson,state,score,total,pct,praise,due,…}],
   *     needsAttendance, deadlines }
   * session.state ∈ no_lesson | no_video | needs_attendance | optional | session_locked |
   *                 session_unwatched | session_unfinished | session_done
   * homework.state ∈ homework_done | homework_missing | homework_optional   (only lessons that have an assignment)
   * quiz.state ∈ quiz_taken | quiz_absent | quiz_optional               (only lessons that have a quiz; absent is due unless the lesson has a later due date)
   *   optional = the lesson's quiz_required / homework_required is false (Phase 2, LessonRequirements); never counted as missed
   */
  function studentVerdicts(student, groupSettings, overview, now) {
    now = toDate(now, overview);
    var gs = groupSettings || {}, cfg = mergeSettings(overview && overview.settings);
    var dl = groupDeadlines(gs, now, overview && overview.settings);
    var C = String(gs.current_lesson || '').trim();

    var session = { lesson: C, state: 'no_lesson', attendance: null, can_watch: null, watch_pct: null, due: false, deadline_state: dl.watch ? dl.watch.state : null, praise: false };
    var needsAttendance = false;
    if (C) {
      var f = factsFor(overview, student, C), meta = lessonMeta(overview, C);
      var att = String(f.attendance || '').toLowerCase();
      session.attendance = (att === 'center' || att === 'online') ? att : null;
      session.watch_pct = (f.watch_pct === null || f.watch_pct === undefined) ? null : num(f.watch_pct);
      session.can_watch = (f.can_watch === null || f.can_watch === undefined)
        ? (meta ? !(meta.video_locked || meta.lesson_locked) : true) : !!f.can_watch;
      session.due = !!(dl.watch && dl.watch.state === 'overdue');
      needsAttendance = session.attendance === null;
      var pct = session.watch_pct;
      if (!hasFlag(meta, 'has_video')) session.state = 'no_video';
      else if (needsAttendance) session.state = 'needs_attendance';
      else if (session.attendance === 'center') { session.state = 'optional'; session.praise = pct !== null && pct >= cfg.watch_done_pct; }
      else if (!session.can_watch) session.state = 'session_locked';
      else if (!pct) session.state = 'session_unwatched';
      else if (pct < cfg.watch_done_pct) session.state = 'session_unfinished';
      else { session.state = 'session_done'; session.praise = true; }
    }

    var homework = [], quiz = [];
    var hwSet = {}, quizSet = {};
    hwList(gs).forEach(function (x) { hwSet[x] = 1; }); quizList(gs).forEach(function (x) { quizSet[x] = 1; });
    allReviewLessons(gs).forEach(function (R) {
      var f = factsFor(overview, student, R), meta = lessonMeta(overview, R);
      // Phase 2: a lesson can carry its own due date (meta.due_override) and can make the quiz and/or the
      // homework optional (meta.quiz_required / meta.homework_required === false). Optional items are never
      // "missing"/"absent"; a missing flag means required (the old behaviour).
      var dlR = (meta && meta.due_override) ? groupDeadlines(mergeOverride(gs, meta.due_override), now, overview && overview.settings) : dl;
      var hwOver = !!(dlR.hw && dlR.hw.state === 'overdue');
      if (hwSet[R] && hasFlag(meta, 'has_assignment')) {
        var hw = f.homework || {}, done = !!hw.submitted, hwReq = !(meta && meta.homework_required === false);
        homework.push({
          lesson: R, state: done ? 'homework_done' : (hwReq ? 'homework_missing' : 'homework_optional'), submitted: done, at: hw.at || null,
          required: hwReq, due: !done && hwReq && hwOver, deadline_state: dlR.hw ? dlR.hw.state : null
        });
      }
      if (quizSet[R] && hasFlag(meta, 'has_quiz')) {
        var q = f.quiz || {}, taken = !!q.taken, qReq = !(meta && meta.quiz_required === false);
        var score = taken ? num(q.score) : null, total = taken ? num(q.total) : null;
        var p = (taken && total) ? (score / total) * 100 : null;
        quiz.push({
          lesson: R, state: taken ? 'quiz_taken' : (qReq ? 'quiz_absent' : 'quiz_optional'), taken: taken, score: score, total: total, pct: p,
          at: q.at || null, attempts: q.attempts || 0, quiz_open: f.quiz_open !== false, required: qReq,
          praise: p !== null && p >= cfg.praise_quiz_pct, due: !taken && qReq && (!(meta && meta.due_override) || hwOver)
        });
      }
    });
    return { session: session, homework: homework, quiz: quiz, needsAttendance: needsAttendance, deadlines: dl };
  }

  /* ------------------------------------------------------------------ summaries */
  var ISSUE_LABEL = {
    session_unwatched: 'لم يشاهد الحصة',
    session_unfinished: 'لم يُكمل المشاهدة',
    homework_missing: 'واجب ناقص',
    quiz_absent: 'غائب عن الكويز – تعويض'
  };
  var PRAISE_LABEL = { session_done: '✅ أنهى المشاهدة', homework_done: '🌟 شكر على الواجب', quiz_praise: '👏 كويز ممتاز' };

  function chip(key, label, tone) { return { key: key, label: label, tone: tone }; }

  function buildChips(v, cfg, parent) {
    var s = v.session, chips = [];
    // 1. attendance
    if (s.state === 'no_lesson') chips.push(chip('attendance', '—', 'grey'));
    else if (s.attendance === 'center') chips.push(chip('attendance', 'سنتر', 'green'));
    else if (s.attendance === 'online') chips.push(chip('attendance', 'أونلاين', 'grey'));
    else chips.push(chip('attendance', 'الحضور غير محدد', 'amber'));
    // 2. watch
    var pct = s.watch_pct === null ? null : Math.round(s.watch_pct), w;
    if (s.state === 'no_lesson' || s.state === 'no_video') w = chip('watch', '▶ —', 'grey');
    else if (s.state === 'optional') w = chip('watch', '▶ اختياري', 'grey');
    else if (s.state === 'session_locked') w = chip('watch', '🔒 الفيديو مقفول', 'red');
    else if (s.state === 'session_done') w = chip('watch', '▶ ' + pct + '%', 'green');
    else if (s.state === 'session_unwatched') w = chip('watch', '▶ 0%', s.due ? 'red' : 'amber');
    else if (s.state === 'session_unfinished') w = chip('watch', '▶ ' + pct + '%', s.due ? 'red' : 'amber');
    else w = pct ? chip('watch', '▶ ' + pct + '%', pct >= cfg.watch_done_pct ? 'green' : 'amber') : chip('watch', '▶ —', 'grey');
    chips.push(w);
    // 3. homework
    if (!v.homework.length) chips.push(chip('homework', '📝 —', 'grey'));
    else {
      var done = v.homework.filter(function (h) { return h.submitted; }).length, miss = v.homework.filter(function (h) { return h.state === 'homework_missing'; }).length;
      var sfx = v.homework.length > 1 ? ' ' + done + '/' + v.homework.length : '';
      if (!miss && !done) chips.push(chip('homework', '📝 اختياري', 'grey'));
      else if (!miss) chips.push(chip('homework', '📝 ✓' + sfx, 'green'));
      else chips.push(chip('homework', '📝 ✕' + sfx, v.homework.some(function (h) { return h.state === 'homework_missing' && h.due; }) ? 'red' : 'amber'));
    }
    // 4. quiz
    if (!v.quiz.length) chips.push(chip('quiz', '❓ —', 'grey'));
    else if (v.quiz.some(function (q) { return q.state === 'quiz_absent'; })) chips.push(chip('quiz', '❓ غائب', 'red'));
    else if (v.quiz.every(function (q) { return !q.taken; })) chips.push(chip('quiz', '❓ اختياري', 'grey'));
    else {
      var sc = 0, tt = 0;
      v.quiz.forEach(function (q) { sc += q.score || 0; tt += q.total || 0; });
      var p = tt ? (sc / tt) * 100 : null, r = function (n) { return Math.round(n * 100) / 100; };
      chips.push(chip('quiz', '❓ ' + r(sc) + '/' + r(tt), p === null ? 'grey' : p >= cfg.praise_quiz_pct ? 'green' : p >= 50 ? 'amber' : 'red'));
    }
    if (parent.level === 'missing') chips.push(chip('parent', '⚠️ لا رقم ولي أمر', 'red'));
    else if (parent.level === 'warn') chips.push(chip('parent', '⚠️ رقم ولي الأمر غير صحيح', 'red'));
    return chips;
  }

  /**
   * Everything the UI needs for one student row/card.
   * `student` = {phone,name?}; missing parent_phone/year/name are filled from overview.students.
   * → { student, verdicts, parent, issues[], praises[], needsAttendance, sessionBlocked,
   *     microChips[4 (+ parent warning chip)], primaryAction, flags }
   *   issue   = {key (template key), kind:'session'|'homework'|'quiz', lesson, label, due, muted, locked?, disabled, reason}
   *   praise  = {key:'session_done'|'homework_done'|'quiz_praise', lesson, label}
   *   primaryAction = {kind:'combined'|'single'|'none', key, count, lesson?, due, muted, disabled, reason}
   *   sessionBlocked = «حدد الحضور أولًا» while current-lesson attendance is unmarked (session messages only)
   */
  function studentSummary(student, group, overview, now) {
    now = toDate(now, overview);
    var gs = (group && group.settings) || {}, cfg = mergeSettings(overview && overview.settings);
    var rec = (overview && overview.students && overview.students[phoneKey(student && student.phone)]) || {};
    var st = {};
    for (var k in rec) st[k] = rec[k];
    for (var k2 in (student || {})) if (student[k2] !== undefined && student[k2] !== null && student[k2] !== '') st[k2] = student[k2];
    if (!('parent_phone' in st) && student && 'parent_phone' in student) st.parent_phone = student.parent_phone;

    var v = studentVerdicts(st, gs, overview, now);
    var parent = checkParentPhone(st.parent_phone, st.phone);
    var offReason = parent.canSend ? '' : 'لا يوجد رقم ولي أمر صالح';

    var issues = [];
    function addIssue(key, kind, lesson, due, locked) {
      var i = { key: key, kind: kind, lesson: lesson, label: ISSUE_LABEL[key], due: due, muted: !due, disabled: !parent.canSend, reason: offReason };
      if (locked) i.locked = true;
      issues.push(i);
    }
    var s = v.session;
    if (s.state === 'session_locked' || s.state === 'session_unwatched') addIssue('session_unwatched', 'session', s.lesson, s.due, s.state === 'session_locked');
    else if (s.state === 'session_unfinished') addIssue('session_unfinished', 'session', s.lesson, s.due, false);
    v.homework.forEach(function (h) { if (h.state === 'homework_missing') addIssue('homework_missing', 'homework', h.lesson, h.due, false); });
    v.quiz.forEach(function (q) { if (q.state === 'quiz_absent') addIssue('quiz_absent', 'quiz', q.lesson, true, false); });

    var praises = [];
    if (s.praise) praises.push({ key: 'session_done', lesson: s.lesson, label: PRAISE_LABEL.session_done });
    v.homework.forEach(function (h) { if (h.submitted) praises.push({ key: 'homework_done', lesson: h.lesson, label: PRAISE_LABEL.homework_done }); });
    v.quiz.forEach(function (q) { if (q.praise) praises.push({ key: 'quiz_praise', lesson: q.lesson, label: PRAISE_LABEL.quiz_praise }); });

    var anyDue = issues.some(function (i) { return i.due; });
    var primary = { kind: 'none', key: null, count: 0, due: false, muted: true, disabled: !parent.canSend, reason: offReason };
    if (issues.length >= 2) primary = { kind: 'combined', key: 'combined', count: issues.length, due: anyDue, muted: !anyDue, disabled: !parent.canSend, reason: offReason };
    else if (issues.length === 1) primary = { kind: 'single', key: issues[0].key, lesson: issues[0].lesson, count: 1, due: issues[0].due, muted: !issues[0].due, disabled: !parent.canSend, reason: offReason };

    return {
      student: st, verdicts: v, parent: parent, issues: issues, praises: praises,
      needsAttendance: v.needsAttendance,
      sessionBlocked: v.needsAttendance ? 'حدد الحضور أولًا' : null,
      microChips: buildChips(v, cfg, parent),
      primaryAction: primary,
      flags: { late: anyDue, noParent: parent.level !== 'ok', unmarked: v.needsAttendance }
    };
  }

  /**
   * Group-level counts for the banner, the stat tiles and the group actions.
   * `group` = {group, settings, members:[{phone,name}]} (the unclassified tab passes a pseudo-group with the
   * locally chosen lesson roles). Student-count rules:
   *  unmarked  = current-lesson attendance not set (banner «X طلاب لم يتم تحديد حضورهم»)
   *  unwatched = online with no watch progress, incl. locked video (tile «لم يشاهدوا»); `locked` ⊂ unwatched
   *  unfinished= started but < 80 %
   *  hwMissing / quizAbsent = students with ≥ 1 missing homework / absent quiz in any homework & quiz lesson
   * Lists (…Students) hold {phone,name} for the copy-names / filter actions. `noWatchData` = nobody has a tracking row
   * for the current lesson (UI hint «لا توجد بيانات مشاهدة لهذه الحصة بعد»).
   */
  function groupSummary(group, overview, now) {
    now = toDate(now, overview);
    var members = (group && group.members) || [];
    var out = {
      total: members.length, unmarked: 0, unwatched: 0, locked: 0, unfinished: 0, hwMissing: 0, quizAbsent: 0,
      noParent: 0, late: 0, noWatchData: false,
      unmarkedStudents: [], unwatchedStudents: [], hwMissingStudents: [], quizAbsentStudents: [],
      deadlines: groupDeadlines(group && group.settings, now, overview && overview.settings, overview), rows: []
    };
    var anyTracking = false;
    members.forEach(function (m) {
      var sum = studentSummary(m, group, overview, now), who = { phone: sum.student.phone || m.phone, name: sum.student.name || m.name || '' };
      var s = sum.verdicts.session;
      out.rows.push({ phone: who.phone, name: who.name, summary: sum });
      if (sum.needsAttendance) { out.unmarked++; out.unmarkedStudents.push(who); }
      if (s.state === 'session_unwatched' || s.state === 'session_locked') { out.unwatched++; out.unwatchedStudents.push(who); }
      if (s.state === 'session_locked') out.locked++;
      if (s.state === 'session_unfinished') out.unfinished++;
      if (sum.verdicts.homework.some(function (h) { return h.state === 'homework_missing'; })) { out.hwMissing++; out.hwMissingStudents.push(who); }
      if (sum.verdicts.quiz.some(function (q) { return q.state === 'quiz_absent'; })) { out.quizAbsent++; out.quizAbsentStudents.push(who); }
      if (sum.flags.noParent) out.noParent++;
      if (sum.flags.late) out.late++;
      if (s.watch_pct !== null) anyTracking = true;
    });
    out.noWatchData = !!(group && group.settings && group.settings.current_lesson) && members.length > 0 && !anyTracking;
    return out;
  }

  /* ---------------------------------------------------------------- parent contact (Phase 3 / S1)
   * Everything here is derived from overview.parent_log[phoneKey] = [{kind, ref, sent_at, note}]
   * (sent_at = "YYYY-MM-DD HH:MM:SS", Cairo). Pure: no DOM, no network.
   *
   * Three states per student, issue-relative:
   *   pending   - has at least one DUE problem (missing homework, absent quiz, ...) with no log entry for it
   *   contacted - nothing pending AND (all its due problems are logged, or any contact was logged this week)
   *   none      - nothing pending and nobody contacted: no reason to call, not counted
   */
  function ymdOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v)); return m ? m[1] : ''; }
  function weekRange(today) {          // Saturday..Friday, same rule as the server's _p2fuWeek
    var back = (weekdayOf(today) + 1) % 7, start = addDays(today, -back);
    return { start: start, end: addDays(start, 6) };
  }
  function contactSummary(log, today, week) {
    var wk = (week && week.start && week.end) ? week : weekRange(today), month = String(today || '').slice(0, 7);
    var out = { contacted_week: false, contacted_month: false, count_week: 0, count_month: 0, count: 0, last_sent_at: '', last_kind: '', last_ref: '' };
    (log || []).forEach(function (n) {
      var d = ymdOf(n && n.sent_at); if (!d) return;
      out.count++;
      if (d >= wk.start && d <= wk.end) out.count_week++;
      if (d.slice(0, 7) === month) out.count_month++;
      if (String(n.sent_at) >= out.last_sent_at) { out.last_sent_at = String(n.sent_at); out.last_kind = n.kind || ''; out.last_ref = n.ref || ''; }
    });
    out.contacted_week = out.count_week > 0; out.contacted_month = out.count_month > 0;
    return out;
  }
  function isLogged(log, item) {
    var ref = String(item && item.ref != null ? item.ref : '').toLowerCase(), kind = item && item.kind;
    return (log || []).some(function (n) { return n.kind === kind && String(n.ref == null ? '' : n.ref).toLowerCase() === ref; });
  }
  function unloggedIssues(issues, log) { return (issues || []).filter(function (it) { return !isLogged(log, it); }); }
  function contactState(issues, log, summary) {
    var iss = issues || [];
    if (unloggedIssues(iss, log).length) return 'pending';
    if (iss.length) return 'contacted';
    return (summary && summary.contacted_week) ? 'contacted' : 'none';
  }
  var CONTACT_RANK = { pending: 0, none: 1, contacted: 2 };
  // items: [{id, state, severity, name}] -> ids, "not contacted first", then more problems first, then name (stable, no ICU).
  function contactSort(items) {
    return (items || []).map(function (x, i) { return { x: x, i: i }; }).sort(function (a, b) {
      var ra = CONTACT_RANK[a.x.state] == null ? 1 : CONTACT_RANK[a.x.state], rb = CONTACT_RANK[b.x.state] == null ? 1 : CONTACT_RANK[b.x.state];
      if (ra !== rb) return ra - rb;
      var sa = a.x.severity || 0, sb = b.x.severity || 0; if (sa !== sb) return sb - sa;
      var na = String(a.x.name || ''), nb = String(b.x.name || ''); if (na !== nb) return na < nb ? -1 : 1;
      return a.i - b.i;
    }).map(function (o) { return o.x.id; });
  }
  function contactCounts(states) {
    var c = { pending: 0, contacted: 0, none: 0, total: 0 };
    (states || []).forEach(function (s) { if (c[s] !== undefined) c[s]++; });
    c.total = c.pending + c.contacted;   // "6 of 12 contacted": students who needed (or got) a contact
    return c;
  }
  function monthlySent(log, month) { return (log || []).some(function (n) { return n.kind === 'monthly' && String(n.ref) === String(month); }); }
  // Which Phase 2 switches are off on the server? -> [{flag, property, feature}]  (overview.flags; undefined = unknown = nothing to say)
  var FLAG_FEATURES = { FF_PARENT_LOG: 'تسجيل التواصل مع ولي الأمر', FF_MONTHLY: 'المراجعة الشهرية' };
  function flagNotices(flags) {
    if (!flags || typeof flags !== 'object') return [];
    return Object.keys(FLAG_FEATURES).filter(function (k) { return flags[k] === false || flags[k] === 0; })
      .map(function (k) { return { flag: k, property: k, feature: FLAG_FEATURES[k] }; });
  }


  return {
    TZ: TZ, DEFAULT_SETTINGS: DEFAULT_SETTINGS, WEEKDAYS_AR: WEEKDAYS_AR,
    phoneKey: phoneKey, waDigits: waDigits, checkParentPhone: checkParentPhone,
    cairoToday: cairoToday, nextSession: nextSession, groupDeadlines: groupDeadlines,
    deadlineState: deadlineState, deadlineWhen: deadlineWhen,
    studentVerdicts: studentVerdicts, studentSummary: studentSummary, groupSummary: groupSummary,
    mergeSettings: mergeSettings,
    hwList: hwList, quizList: quizList, allReviewLessons: allReviewLessons,
    weekRange: weekRange, contactSummary: contactSummary, isLogged: isLogged, unloggedIssues: unloggedIssues,
    contactState: contactState, contactSort: contactSort, contactCounts: contactCounts, monthlySent: monthlySent, flagNotices: flagNotices
  };
}));
  return module.exports;
})();

// ---- assets/followup-events.js (verbatim) ----
var FU2_LOGIC_EVENTS_ = (function () {
  var module = { exports: {} };
  var Intl = FU2_LOGIC_INTL_;
  var require = function (name) {
    if (/followup-logic/.test(String(name))) return FU2_LOGIC_LOGIC_;
    throw new Error("fu2_logic: unexpected require(" + name + ")");
  };
/* followup-events.js — the "what is due" engine of the Follow-up dashboard (Follow-up v2, session S3).
 *
 * One source of truth for "what should the owner / assistant do next", used by BOTH the page
 * (window.FollowupEvents) and the server (generated into apps_script/FollowupLogic.gs by
 * scripts/build_server_logic.py). Pure: no DOM, no network, no Sheets, no globals except Intl
 * (the generated .gs swaps Intl for a Utilities.formatDate shim). UMD: window.FollowupEvents in
 * browsers, module.exports in Node. Needs followup-logic.js (window.FollowupLogic) loaded first;
 * when it is missing, window.FollowupEvents is null so the page can fall back to the old layout.
 *
 * Contract: Docs "Parallel Build Guide: Follow-up v2", section 3.2.
 *
 *   FollowupEvents.eventsFor(overview, groupKey, nowIso) -> {group_key, group, tz_label, prev_session,
 *       next_session, phase, next_event_at_iso, events[]}  (null when the group does not exist)
 *   FollowupEvents.dueNow(overview, nowIso) -> [{group_key, group, key, session_date, count, student_keys, lesson, blocked_count}]
 *
 * Time zone: computed in Africa/Cairo (DST-safe, same helpers as followup-logic.js); every label a person
 * reads says "Alex" (TZ_LABEL). All fire times are wall-clock times in that zone, written with their real
 * UTC offset ("2026-11-06T16:00:00+02:00").
 *
 * Reading guide (S = next session start, P = previous session start, both in Alex time)
 *   attendance        P+1h .. P+3d       students with the current lesson's attendance unmarked (count -> 0 = done)
 *   parents_watch     day after the watch deadline, notify hour .. S   online students who did not watch, not yet messaged
 *   parents_hw        S.date at notify hour .. S+3d                      students with homework missing / quiz absent, not yet messaged
 *   remind_watch      watch deadline day at notify hour .. end of that day   (manual "done")
 *   remind_hw         homework deadline day at notify hour .. end of that day (manual "done")
 *   advance_lessons   P+3h .. P+5d       move the group on to the next lesson (manual "done")
 *   setup_missing     every Sunday at notify hour, until fixed
 * Interpretations that go beyond the literal table are listed in "Decisions" at the bottom of this header:
 *   D1  attendance is counted for whichever lesson is `current_lesson` at the moment of evaluation.
 *   D2  when `done` holds "advance|<P.date>" the homework / quiz lists were already rotated, so the
 *       previous-session instance of parents_hw is finished (it would count the wrong lesson).
 *   D3  `requirements.<key>.parent_message === false` keeps that requirement out of parents_* counts
 *       (it still counts in remind_*). `requirements.attendance.enabled === false` also switches off blocking.
 *   D4  expires_at_iso is only filled for remind_*, as the contract's shape comment says; the other windows
 *       still end internally (they decide "expired"), they are just not reported.
 *   D5  events[] is sorted by the written priority order (the golden example listing is not).
 *   D6  a count-0 event that has not reached its fire time stays "upcoming" but never sets next_event_at_iso.
 *   D7  student logging marks use the page's mapping: homework -> {homework, lesson}, quiz -> {quiz, lesson},
 *       watch -> {custom, "watch:<lesson>"} (followup-app.js logKind). If the page changes that, change KIND_* here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./followup-logic.js'));
  else root.FollowupEvents = factory(root.FollowupLogic);
}(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';
  if (!L || typeof L.studentVerdicts !== 'function') return null;

  var VERSION = '1.0.0';
  var TZ = L.TZ || 'Africa/Cairo';
  var TZ_LABEL = 'Alex';
  var NOTIFY_HOUR_DEFAULT = 16;
  var HOUR_MS = 3600000;
  var MAX_KEYS = 200;
  // Priority, top first (also the order of events[]).
  var EVENT_KEYS = ['attendance', 'parents_watch', 'parents_hw', 'remind_watch', 'remind_hw', 'advance_lessons', 'setup_missing'];
  var MANUAL_DONE = { remind_watch: 'watch', remind_hw: 'hw', advance_lessons: 'advance' };
  var KIND_HW = 'homework', KIND_QUIZ = 'quiz', KIND_WATCH = 'custom', REF_WATCH = 'watch:';

  /* ------------------------------------------------------------ calendar helpers
   * Same maths as followup-logic.js (which does not export these). test_followup_events.js pins them to
   * L.nextSession so they cannot drift apart. */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  function cairoParts(date) {
    var o = {};
    fmt.formatToParts(date).forEach(function (p) { if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10); });
    if (o.hour === 24) o.hour = 0;
    return o;
  }
  function ymd(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function parseYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d };
  }
  function addDays(s, n) {
    var p = parseYmd(s), dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function weekdayOf(s) { var p = parseYmd(s); return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
  function todayOf(date) { var p = cairoParts(date); return ymd(p.year, p.month, p.day); }
  /** The real instant of an Alex wall-clock time (works across DST changes; a time inside the spring gap lands just after it). */
  function cairoInstant(dateStr, hh, mm) {
    var p = parseYmd(dateStr), wall = Date.UTC(p.y, p.m - 1, p.d, hh, mm, 0), guess = wall;
    for (var i = 0; i < 4; i++) {
      var c = cairoParts(new Date(guess));
      var shown = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
      var diff = wall - shown;
      if (!diff) break;
      guess += diff;
    }
    return new Date(guess);
  }
  /** "2026-11-06T16:00:00+02:00": the instant written in Alex wall time with its real offset (seconds, no ms). */
  function isoAlex(date) {
    var secs = Math.floor(date.getTime() / 1000), p = cairoParts(new Date(secs * 1000));
    var off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - secs * 1000) / 60000);
    var sign = off < 0 ? '-' : '+'; off = Math.abs(off);
    return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute) + ':' + pad(p.second) +
      sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
  }
  function toNow(v, overview) {
    if (v instanceof Date && !isNaN(v)) return v;
    if (typeof v === 'number' && isFinite(v)) return new Date(v);
    if (typeof v === 'string' && v) { var d = new Date(v); if (!isNaN(d)) return d; }
    if (overview && overview.now) { var d2 = new Date(overview.now); if (!isNaN(d2)) return d2; }
    return new Date();
  }

  /* ------------------------------------------------------------ small data helpers */
  function lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function lessonMeta(overview, path) {
    var M = overview && overview.lessons;
    return (M && path && (M[path] || M[String(path).toLowerCase()])) || null;
  }
  function logged(log, pk, kind, ref) {
    var arr = (log && log[pk]) || [], r = lc(ref);
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].kind === kind && lc(arr[i].ref) === r) return true;
    return false;
  }
  function reqOf(g, key) { var r = g && g.requirements && g.requirements[key]; return (r && typeof r === 'object') ? r : null; }
  function reqOn(g, key) { var r = reqOf(g, key); return !(r && r.enabled === false); }
  function reqParentOk(g, key) { var r = reqOf(g, key); return !(r && r.parent_message === false); }
  function watchPctOverride(g) {
    var r = reqOf(g, 'watch'), p = r && r.rule && r.rule.pct;
    if (p === '' || p === null || p === undefined) return null;
    p = Number(p);
    return (isFinite(p) && p > 0 && p <= 100) ? p : null;
  }
  function notifyOf(g) {
    var n = (g && g.notify) || {}, h = Number(n.hour);
    return {
      enabled: n.enabled !== false,
      hour: (n.hour !== '' && n.hour !== null && n.hour !== undefined && isFinite(h) && h >= 0 && h <= 23 && h === Math.floor(h)) ? h : NOTIFY_HOUR_DEFAULT,
      snooze_until: String(n.snooze_until == null ? '' : n.snooze_until).trim()
    };
  }
  function muted(g, now) {
    var n = notifyOf(g);
    if (!n.enabled) return true;
    return !!(n.snooze_until && parseYmd(n.snooze_until) && todayOf(now) < n.snooze_until);   // snoozed until that date starts
  }
  function doneHas(g, kind, date) {
    var d = g && g.done;
    if (!d || !d.length) return false;
    return d.indexOf(kind + '|' + date) >= 0;
  }

  /* ------------------------------------------------------------ the students behind each event */
  function analyse(g, overview, now) {
    var gs = g.settings || {}, C = String(gs.current_lesson || '').trim();
    var log = (overview && overview.parent_log) || {};
    var attOn = reqOn(g, 'attendance'), watchOn = reqOn(g, 'watch'), hwOn = reqOn(g, 'homework'), quizOn = reqOn(g, 'quiz');
    var watchParent = reqParentOk(g, 'watch'), hwParent = reqParentOk(g, 'homework'), quizParent = reqParentOk(g, 'quiz');
    var thr = watchPctOverride(g), ov = overview;
    if (thr !== null) {                       // the requirement's pct replaces watch_done_pct everywhere (verdicts included)
      var st = {}, base = (overview && overview.settings) || {};
      for (var k in base) st[k] = base[k];
      st.watch_done_pct = thr;
      ov = {}; for (var k2 in overview) ov[k2] = overview[k2];
      ov.settings = st;
    } else thr = L.mergeSettings(overview && overview.settings).watch_done_pct;
    var meta = C ? lessonMeta(overview, C) : null;
    var hasVideo = !!C && (!meta || meta.has_video !== false);

    var A = {
      lesson: C || null, hwLesson: (L.hwList(gs)[0] || L.quizList(gs)[0] || null),
      unmarked: [], watchPending: [], parentsWatch: [], parentsWatchBlocked: 0,
      hwMissing: [], parentsHw: [], parentsHwBlocked: 0, total: 0
    };
    var members = g.members || [], seen = {};
    for (var i = 0; i < members.length; i++) {
      var m = members[i], pk = L.phoneKey(m && m.phone);
      if (!pk || seen[pk]) continue;
      seen[pk] = 1; A.total++;
      var v = L.studentVerdicts({ phone: m.phone }, gs, ov, now), s = v.session;
      var unmarked = attOn && !!C && s.attendance === null;
      var watchPending = watchOn && hasVideo && s.attendance !== 'center' && s.can_watch !== false &&
        ((s.watch_pct === null || s.watch_pct === undefined ? 0 : s.watch_pct) < thr);
      var hwMiss = hwOn && v.homework.some(function (h) { return h.state === 'homework_missing'; });
      if (unmarked) A.unmarked.push(pk);
      if (watchPending) {
        A.watchPending.push(pk);
        if (watchParent && !logged(log, pk, KIND_WATCH, REF_WATCH + C)) {
          if (unmarked) A.parentsWatchBlocked++; else A.parentsWatch.push(pk);
        }
      }
      if (hwMiss) A.hwMissing.push(pk);
      var open = [];
      if (hwOn && hwParent) v.homework.forEach(function (h) { if (h.state === 'homework_missing' && !logged(log, pk, KIND_HW, h.lesson)) open.push(1); });
      if (quizOn && quizParent) v.quiz.forEach(function (q) { if (q.state === 'quiz_absent' && !logged(log, pk, KIND_QUIZ, q.lesson)) open.push(1); });
      if (open.length) { if (unmarked) A.parentsHwBlocked++; else A.parentsHw.push(pk); }
    }
    return A;
  }

  /* ------------------------------------------------------------ states */
  // manual events: finished by a "done" mark; the others finish when their student count reaches 0.
  function stateOf(now, fire, expires, count, manual, isDone) {
    if (isDone) return 'done';
    if (now.getTime() < fire.getTime()) return 'upcoming';
    if (expires && now.getTime() > expires.getTime()) return (manual || count > 0) ? 'expired' : 'done';
    return count > 0 ? 'due' : 'done';
  }
  function inst(key, fire, expires, sessionDate, count, keys, blocked, lesson, state, showExpiry) {
    return {
      key: key, state: state, fire: fire, expires: expires, session_date: sessionDate, count: count,
      student_keys: keys.slice(0, MAX_KEYS), blocked_count: blocked, lesson: lesson || null, showExpiry: !!showExpiry
    };
  }
  function outEvent(e) {
    return {
      key: e.key, state: e.state, fire_at_iso: isoAlex(e.fire),
      expires_at_iso: (e.showExpiry && e.expires) ? isoAlex(e.expires) : null,
      session_date: e.session_date, count: e.count, student_keys: e.student_keys,
      blocked_count: e.blocked_count, lesson: e.lesson
    };
  }
  var RANK = { due: 0, upcoming: 1, done: 2, expired: 3 };
  function pickParentsHw(cands) {
    var best = null;
    cands.forEach(function (c) {
      if (!best) { best = c; return; }
      var rc = RANK[c.state], rb = RANK[best.state];
      if (c.state === 'upcoming' && best.state === 'upcoming') { if (c.fire.getTime() < best.fire.getTime()) best = c; return; }
      if (rc < rb && (c.state === 'due' || c.state === 'upcoming')) best = c;
      else if (rc === rb && rc >= 2 && c.fire.getTime() > best.fire.getTime()) best = c;   // both finished: the most recent
    });
    return best;
  }

  /* ------------------------------------------------------------ one group */
  function groupEvents(overview, g, now) {
    var gs = g.settings || {}, H = notifyOf(g).hour;
    var ns = L.nextSession(now, gs.weekday, gs.time);
    var hasMembers = (g.members || []).some(function (m) { return !!L.phoneKey(m && m.phone); });
    var res = { prev: null, next: null, byKey: {} };

    var cur = String(gs.current_lesson || '').trim();
    var missingSetup = ns === null || !cur;
    var setupCount = (missingSetup && hasMembers) ? 1 : 0;
    var wantSetup = function () {
      var today = todayOf(now), sunday = addDays(today, -weekdayOf(today)), fire = cairoInstant(sunday, H, 0);
      if (now.getTime() < fire.getTime()) { sunday = addDays(sunday, -7); fire = cairoInstant(sunday, H, 0); }
      return inst('setup_missing', fire, null, sunday, setupCount, [], 0, null, setupCount > 0 ? 'due' : 'done', false);
    };

    if (!ns) { if (setupCount) res.byKey.setup_missing = wantSetup(); return res; }

    var A = analyse(g, overview, now);
    var tm = /^(\d{2}):(\d{2})$/.exec(ns.time), hh = +tm[1], mm = +tm[2];
    var Sdate = ns.date, Sat = ns.at;
    var Pdate = addDays(Sdate, -7), Pat = cairoInstant(Pdate, hh, mm);
    res.next = { date: Sdate, at_iso: isoAlex(Sat) };
    res.prev = { date: Pdate, at_iso: isoAlex(Pat) };
    var dl = L.groupDeadlines(gs, now, overview && overview.settings, overview);

    // attendance: P+1h .. P+3d
    var aFire = new Date(Pat.getTime() + HOUR_MS), aExp = cairoInstant(addDays(Pdate, 3), hh, mm);
    res.byKey.attendance = inst('attendance', aFire, aExp, Pdate, A.unmarked.length, A.unmarked, 0, A.lesson,
      stateOf(now, aFire, aExp, A.unmarked.length, false, false), false);

    // watch: reminder on the deadline day, parents the day after, until the session
    var wDate = dl.watch.date;
    var rwFire = cairoInstant(wDate, H, 0), rwExp = dl.watch.end;
    res.byKey.remind_watch = inst('remind_watch', rwFire, rwExp, Sdate, A.watchPending.length, A.watchPending, 0, A.lesson,
      stateOf(now, rwFire, rwExp, A.watchPending.length, true, doneHas(g, 'watch', Sdate)), true);
    var pwFire = cairoInstant(addDays(wDate, 1), H, 0), pwExp = Sat;
    res.byKey.parents_watch = inst('parents_watch', pwFire, pwExp, Sdate, A.parentsWatch.length, A.parentsWatch, A.parentsWatchBlocked, A.lesson,
      stateOf(now, pwFire, pwExp, A.parentsWatch.length, false, false), false);

    // homework
    var hDate = dl.hw.date;
    var rhFire = cairoInstant(hDate, H, 0), rhExp = dl.hw.end;
    res.byKey.remind_hw = inst('remind_hw', rhFire, rhExp, Sdate, A.hwMissing.length, A.hwMissing, 0, A.hwLesson,
      stateOf(now, rhFire, rhExp, A.hwMissing.length, true, doneHas(g, 'hw', Sdate)), true);
    var phS = cairoInstant(Sdate, H, 0), phSe = cairoInstant(addDays(Sdate, 3), hh, mm);
    var cs = inst('parents_hw', phS, phSe, Sdate, A.parentsHw.length, A.parentsHw, A.parentsHwBlocked, A.hwLesson,
      stateOf(now, phS, phSe, A.parentsHw.length, false, false), false);
    var phP = cairoInstant(Pdate, H, 0), phPe = cairoInstant(addDays(Pdate, 3), hh, mm);
    var rotated = doneHas(g, 'advance', Pdate);                                                    // D2
    var cp = rotated
      ? inst('parents_hw', phP, phPe, Pdate, 0, [], 0, A.hwLesson, 'done', false)
      : inst('parents_hw', phP, phPe, Pdate, A.parentsHw.length, A.parentsHw, A.parentsHwBlocked, A.hwLesson,
        stateOf(now, phP, phPe, A.parentsHw.length, false, false), false);
    res.byKey.parents_hw = pickParentsHw([cp, cs]);

    // advance lessons: P+3h .. P+5d
    var adFire = new Date(Pat.getTime() + 3 * HOUR_MS), adExp = cairoInstant(addDays(Pdate, 5), hh, mm);
    res.byKey.advance_lessons = inst('advance_lessons', adFire, adExp, Pdate, 1, [], 0, A.lesson,
      stateOf(now, adFire, adExp, 1, true, doneHas(g, 'advance', Pdate)), false);

    if (setupCount) res.byKey.setup_missing = wantSetup();
    return res;
  }

  function findGroup(overview, groupKey) {
    var gl = (overview && overview.groups) || [], want = lc(groupKey);
    for (var i = 0; i < gl.length; i++) if (lc(gl[i].key) === want) return gl[i];
    for (var j = 0; j < gl.length; j++) if (lc(gl[j].group) === want) return gl[j];
    return null;
  }
  function groupKeyOf(g) { return String(g.key != null && g.key !== '' ? g.key : lc(g.group)); }

  /* ------------------------------------------------------------ public API */
  function eventsFor(overview, groupKey, nowIso) {
    var g = findGroup(overview, groupKey);
    if (!g) return null;
    var now = toNow(nowIso, overview), r = groupEvents(overview, g, now);
    var evs = [], phase = 'all_clear', nextAt = null;
    EVENT_KEYS.forEach(function (k) {
      var e = r.byKey[k];
      if (!e) return;
      evs.push(e);
      if (phase === 'all_clear' && e.state === 'due') phase = k;
      if (e.state === 'upcoming' && e.count > 0 && (nextAt === null || e.fire.getTime() < nextAt.getTime())) nextAt = e.fire;   // D6
    });
    return {
      group_key: groupKeyOf(g), group: g.group != null ? String(g.group) : groupKeyOf(g), tz_label: TZ_LABEL,
      prev_session: r.prev, next_session: r.next,
      phase: phase, next_event_at_iso: nextAt ? isoAlex(nextAt) : null,
      events: evs.map(outEvent)
    };
  }

  function dueNow(overview, nowIso) {
    var now = toNow(nowIso, overview), out = [], gl = (overview && overview.groups) || [];
    gl.forEach(function (g) {
      if (muted(g, now)) return;
      var r = eventsFor(overview, groupKeyOf(g), now);
      if (!r) return;
      r.events.forEach(function (e) {
        if (e.state !== 'due' || !(e.count > 0)) return;
        out.push({ group_key: r.group_key, group: r.group, key: e.key, session_date: e.session_date, count: e.count,
          student_keys: e.student_keys, lesson: e.lesson, blocked_count: e.blocked_count });
      });
    });
    return out;
  }

  return {
    VERSION: VERSION, TZ_LABEL: TZ_LABEL, NOTIFY_HOUR_DEFAULT: NOTIFY_HOUR_DEFAULT, EVENT_KEYS: EVENT_KEYS.slice(),
    eventsFor: eventsFor, dueNow: dueNow,
    _h: { cairoInstant: cairoInstant, addDays: addDays, isoAlex: isoAlex, muted: muted }   // for tests only
  };
}));
  return module.exports;
})();

function fu2_logic_eventsFor_(overview, groupKey, nowIso) {
  return FU2_LOGIC_EVENTS_.eventsFor(overview, groupKey, nowIso);
}

function fu2_logic_dueNow_(overview, nowIso) {
  return FU2_LOGIC_EVENTS_.dueNow(overview, nowIso);
}

function fu2_logic_version_() {
  return FU2_LOGIC_VERSION;
}

/**
 * Run from the Apps Script editor (pick fu2_logic_selfCheck, press Run, read the log).
 * 1. Checks that Apps Script's own time-zone data knows Egypt's 2026 clock changes
 *    (forward Fri 24 Apr 00:00 -> 01:00, back Thu 29 Oct 24:00 -> 23:00). If this fails, the
 *    server would compute reminder times an hour off in the weeks around those dates.
 * 2. Runs the engine on a tiny made-up group.
 * Returns {ok, version, failures[]} and logs it.
 */
function fu2_logic_selfCheck() {
  var failures = [];
  var cases = [
    ["2026-04-23T21:59:59Z", "2026-04-23 23:59:59"],
    ["2026-04-23T22:00:00Z", "2026-04-24 01:00:00"],
    ["2026-10-29T20:59:59Z", "2026-10-29 23:59:59"],
    ["2026-10-29T21:00:00Z", "2026-10-29 23:00:00"],
    ["2026-11-06T14:30:00Z", "2026-11-06 16:30:00"]
  ];
  cases.forEach(function (c) {
    var got = Utilities.formatDate(new Date(c[0]), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss");
    if (got !== c[1]) failures.push("time zone: " + c[0] + " shows " + got + ", expected " + c[1]);
  });
  try {
    var lesson = "programming/x/lesson-1";
    var ov = {
      now: "2026-11-04T17:00:00+02:00", settings: {}, lessons: {}, parent_log: {},
      facts: { "1000000101": {} },
      groups: [{ group: "Check", key: "check", settings: { weekday: 6, time: "18:00", current_lesson: lesson, review_lessons: [] },
                 members: [{ phone: "01000000101", name: "A" }], done: ["advance|2026-10-31"] }]
    };
    ov.facts["1000000101"][lesson] = { attendance: "online", watch_pct: 10, can_watch: true };
    var r = fu2_logic_eventsFor_(ov, "check", ov.now);
    if (!r || r.phase !== "remind_watch") failures.push("engine: expected phase remind_watch, got " + (r && r.phase));
    var d = fu2_logic_dueNow_(ov, ov.now);
    if (!d || d.length !== 1 || d[0].key !== "remind_watch") failures.push("engine: dueNow returned " + JSON.stringify(d));
    else if (r.events[0].fire_at_iso === undefined) failures.push("engine: no fire_at_iso");
  } catch (e) {
    failures.push("engine threw: " + e);
  }
  var res = { ok: failures.length === 0, version: FU2_LOGIC_VERSION, failures: failures };
  Logger.log(JSON.stringify(res));
  return res;
}
