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
   */
  function groupDeadlines(settings, now, app) {
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
    return { nextSession: ns, watch: mk(settings.watch_deadline_override, cfg.watch_days_before), hw: mk(settings.hw_deadline_override, cfg.hw_days_before) };
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
      deadlines: groupDeadlines(group && group.settings, now, overview && overview.settings), rows: []
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

  return {
    TZ: TZ, DEFAULT_SETTINGS: DEFAULT_SETTINGS, WEEKDAYS_AR: WEEKDAYS_AR,
    phoneKey: phoneKey, waDigits: waDigits, checkParentPhone: checkParentPhone,
    cairoToday: cairoToday, nextSession: nextSession, groupDeadlines: groupDeadlines,
    deadlineState: deadlineState, deadlineWhen: deadlineWhen,
    studentVerdicts: studentVerdicts, studentSummary: studentSummary, groupSummary: groupSummary,
    mergeSettings: mergeSettings,
    hwList: hwList, quizList: quizList, allReviewLessons: allReviewLessons
  };
}));
