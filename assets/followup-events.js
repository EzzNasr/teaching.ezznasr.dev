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
