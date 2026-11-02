// Tests for assets/followup-events.js (pure: no Sheets / Apps Script involved).  Follow-up v2, session S3.
//   node tests/test_followup_events.js [repo-root]       (run from tools/quiz-maker-v2/; default root = ../..)
// The file re-runs itself under TZ=America/Los_Angeles: Alex time is explicit, so the result must be identical.
const path = require('path');
const cp = require('child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const L = require(path.join(root, 'assets', 'followup-logic.js'));
const E = require(path.join(root, 'assets', 'followup-events.js'));
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e === undefined ? '' : (typeof e === 'string' ? e : JSON.stringify(e))))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
const clone = o => JSON.parse(JSON.stringify(o));

/* ----------------------------------------------------------------- fixtures */
const B = 'programming/baccalaureate/grade-1-secondary/';
const L1 = B + 'chapter-2-lesson-1-variables', L2 = B + 'chapter-2-lesson-2-functions', L3 = B + 'chapter-2-lesson-3-loops';
const phone = i => '01000000' + String(100 + i);          // 01000000101 ...
const pk = i => L.phoneKey(phone(i));
const LESSONS = {};
[L1, L2, L3].forEach(p => { LESSONS[p] = { path: p, has_video: true, has_quiz: true, has_assignment: true, lesson_locked: false, video_locked: false, quiz_locked: false }; });

// spec: {att, pct, hw, quiz} per lesson. quiz: true = taken, false = absent
function mkFacts(map) {
  const out = {};
  Object.keys(map).forEach(i => {
    out[pk(+i)] = {};
    Object.keys(map[i]).forEach(lesson => {
      const s = map[i][lesson];
      out[pk(+i)][lesson] = {
        can_watch: true, attendance: s.att === undefined ? null : s.att, watch_pct: s.pct === undefined ? null : s.pct,
        quiz: s.quiz ? { taken: true, score: 8, total: 10, at: '2026-10-30', attempts: 1 } : { taken: false },
        quiz_open: true, homework: { submitted: !!s.hw }
      };
    });
  });
  return out;
}
function mkGroup(name, n, over) {
  return {
    group: name, key: name.toLowerCase(),
    settings: Object.assign({ weekday: 6, time: '18:00', current_lesson: L2, review_lessons: [L1], hw_lessons: null, quiz_lessons: null, note: '', parents_contacted: false, watch_deadline_override: '', hw_deadline_override: '' }, over || {}),
    members: Array.from({ length: n }, (_, i) => ({ phone: phone(i + 1), name: 'Student ' + (i + 1) }))
  };
}
function mkOverview(groups, facts, extra) {
  return Object.assign({
    ok: true, now: '2026-11-06T16:30:00+02:00', settings: { watch_done_pct: 80, praise_quiz_pct: 90, watch_days_before: 3, hw_days_before: 1 },
    groups, unclassified: [], students: {}, lessons: clone(LESSONS), facts: facts || {}, parent_log: {}
  }, extra || {});
}
const ev = (r, k) => r.events.find(e => e.key === k);
const brief = (r) => r.events.map(e => e.key + ':' + e.state + ':' + e.count).join(' ');

/* -------------------------------------------------- golden example 1 (contract 3.2) */
{
  const f = {};
  for (let i = 1; i <= 8; i++) f[i] = { [L2]: { att: 'online', pct: 100 }, [L1]: { hw: i >= 4, quiz: true } };
  const g = mkGroup('Sat 18:00', 8); g.done = ['advance|2026-10-31'];
  const ov = mkOverview([g], mkFacts(f));
  const r = E.eventsFor(ov, 'sat 18:00', '2026-11-06T16:30:00+02:00');
  eq('golden 1: phase', r.phase, 'remind_hw');
  eq('golden 1: tz_label / group_key', [r.tz_label, r.group_key], ['Alex', 'sat 18:00']);
  eq('golden 1: sessions', [r.prev_session, r.next_session], [{ date: '2026-10-31', at_iso: '2026-10-31T18:00:00+02:00' }, { date: '2026-11-07', at_iso: '2026-11-07T18:00:00+02:00' }]);
  const rh = ev(r, 'remind_hw');
  t('golden 1: remind_hw due, count 3, fire 16:00+02:00', rh.state === 'due' && rh.count === 3 && rh.fire_at_iso === '2026-11-06T16:00:00+02:00' && rh.session_date === '2026-11-07', rh);
  eq('golden 1: remind_hw expires at the end of the deadline day', rh.expires_at_iso, '2026-11-06T23:59:59+02:00');
  eq('golden 1: remind_hw student keys', rh.student_keys, [pk(1), pk(2), pk(3)]);
  eq('golden 1: remind_hw lesson', rh.lesson, L1);
  const ph = ev(r, 'parents_hw');
  t('golden 1: parents_hw upcoming 11-07 16:00, count 3', ph.state === 'upcoming' && ph.count === 3 && ph.fire_at_iso === '2026-11-07T16:00:00+02:00' && ph.session_date === '2026-11-07', ph);
  t('golden 1: parents_watch done, 0', ev(r, 'parents_watch').state === 'done' && ev(r, 'parents_watch').count === 0);
  t('golden 1: remind_watch expired, 0', ev(r, 'remind_watch').state === 'expired' && ev(r, 'remind_watch').count === 0);
  t('golden 1: attendance done, 0', ev(r, 'attendance').state === 'done' && ev(r, 'attendance').count === 0);
  t('golden 1: advance_lessons done', ev(r, 'advance_lessons').state === 'done');
  eq('golden 1: no setup_missing when the group is set up', r.events.some(e => e.key === 'setup_missing'), false);
  eq('golden 1: next_event_at_iso = earliest upcoming', r.next_event_at_iso, '2026-11-07T16:00:00+02:00');
  eq('golden 1: events are in priority order', r.events.map(e => e.key), ['attendance', 'parents_watch', 'parents_hw', 'remind_watch', 'remind_hw', 'advance_lessons']);
  eq('golden 1: dueNow = only remind_hw', E.dueNow(ov, '2026-11-06T16:30:00+02:00').map(d => d.key), ['remind_hw']);
}

/* -------------------------------------------------- golden example 2 */
{
  const f = {};
  for (let i = 1; i <= 12; i++) f[i] = { [L2]: {}, [L1]: { hw: i % 2 === 0, quiz: true } };    // current lesson attendance unmarked for all 12
  const g = mkGroup('Sat 18:00', 12); g.done = ['hw|2026-11-07'];
  const ov = mkOverview([g], mkFacts(f));
  const now = '2026-11-07T20:30:00+02:00';
  const r = E.eventsFor(ov, 'sat 18:00', now);
  eq('golden 2: phase', r.phase, 'attendance');
  eq('golden 2: sessions (the session just held is "prev")', [r.prev_session.date, r.next_session.date], ['2026-11-07', '2026-11-14']);
  const a = ev(r, 'attendance');
  t('golden 2: attendance due, 12, fire 19:00, session_date 11-07', a.state === 'due' && a.count === 12 && a.fire_at_iso === '2026-11-07T19:00:00+02:00' && a.session_date === '2026-11-07', a);
  const ad = ev(r, 'advance_lessons');
  t('golden 2: advance upcoming 21:00, count 1', ad.state === 'upcoming' && ad.count === 1 && ad.fire_at_iso === '2026-11-07T21:00:00+02:00', ad);
  eq('golden 2: the hw reminder mark belongs to the finished session; the new session\'s remind_hw is upcoming', [ev(r, 'remind_hw').state, ev(r, 'remind_hw').session_date], ['upcoming', '2026-11-14']);
  const ph = ev(r, 'parents_hw');
  t('golden 2: parents_hw: all 12 are blocked by the unmarked attendance (count 0, blocked > 0)', ph.count === 0 && ph.blocked_count === 6 && ph.state !== 'due', ph);
  eq('golden 2: dueNow = only attendance, with the 12 keys', E.dueNow(ov, now).map(d => [d.key, d.count, d.session_date, d.lesson, d.blocked_count, d.student_keys.length]), [['attendance', 12, '2026-11-07', L2, 0, 12]]);
  eq('golden 2: next_event_at_iso = advance at 21:00 (count 1 upcoming)', r.next_event_at_iso, '2026-11-07T21:00:00+02:00');
}

/* -------------------------------------------------- the whole week of one group */
// s1 unmarked + hw missing | s2 all good | s3 online 40% + hw missing | s4 center + quiz absent
const WEEK_FACTS = mkFacts({
  1: { [L2]: { att: null, pct: null }, [L1]: { hw: false, quiz: true } },
  2: { [L2]: { att: 'online', pct: 100 }, [L1]: { hw: true, quiz: true } },
  3: { [L2]: { att: 'online', pct: 40 }, [L1]: { hw: false, quiz: true } },
  4: { [L2]: { att: 'center', pct: null }, [L1]: { hw: true, quiz: false } }
});
const week = (mut) => { const g = mkGroup('Sat 18:00', 4); if (mut) mut(g); return mkOverview([g], clone(WEEK_FACTS)); };
const at = (ov, now, k) => { const r = E.eventsFor(ov, 'sat 18:00', now); return k ? ev(r, k) : r; };
const st = (ov, now, k) => { const e = at(ov, now, k); return e.state + ':' + e.count; };
{
  const ov = week();
  const r = at(ov, '2026-11-04T16:00:00+02:00');
  eq('week: remind_watch students = unmarked + under 80% online (center and 100% excluded)', ev(r, 'remind_watch').student_keys, [pk(1), pk(3)]);
  eq('week: parents_watch = same minus the unmarked one, who is blocked', [ev(r, 'parents_watch').student_keys, ev(r, 'parents_watch').blocked_count], [[pk(3)], 1]);
  eq('week: remind_hw students', ev(r, 'remind_hw').student_keys, [pk(1), pk(3)]);
  eq('week: parents_hw = hw missing or quiz absent, minus blocked', [ev(r, 'parents_hw').student_keys, ev(r, 'parents_hw').blocked_count], [[pk(3), pk(4)], 1]);
  eq('week: attendance students', ev(r, 'attendance').student_keys, [pk(1)]);

  // attendance P+1h .. P+3d  (P = Sat 2026-10-31 18:00)
  eq('attendance: before P+1h = upcoming', st(ov, '2026-10-31T18:59:59+02:00', 'attendance'), 'upcoming:1');
  eq('attendance: at P+1h = due', st(ov, '2026-10-31T19:00:00+02:00', 'attendance'), 'due:1');
  eq('attendance: last second of the window = still due', st(ov, '2026-11-03T18:00:00+02:00', 'attendance'), 'due:1');
  eq('attendance: after P+3d = expired', st(ov, '2026-11-03T18:00:01+02:00', 'attendance'), 'expired:1');
  eq('attendance: phase while due', at(ov, '2026-10-31T19:30:00+02:00').phase, 'attendance');
  // advance_lessons P+3h .. P+5d
  eq('advance: before P+3h = upcoming', st(ov, '2026-10-31T20:59:59+02:00', 'advance_lessons'), 'upcoming:1');
  eq('advance: at P+3h = due', st(ov, '2026-10-31T21:00:00+02:00', 'advance_lessons'), 'due:1');
  eq('advance: P+5d = still due', st(ov, '2026-11-05T18:00:00+02:00', 'advance_lessons'), 'due:1');
  eq('advance: after P+5d = expired', st(ov, '2026-11-05T18:00:01+02:00', 'advance_lessons'), 'expired:1');
  const dn = week(g => { g.done = ['advance|2026-10-31']; });
  eq('advance: done mark wins', st(dn, '2026-11-01T10:00:00+02:00', 'advance_lessons'), 'done:1');
  eq('advance: the mark is per session (another date does not count)', st(week(g => { g.done = ['advance|2026-10-24']; }), '2026-11-01T10:00:00+02:00', 'advance_lessons'), 'due:1');
  // remind_watch: watch deadline day (S-3 = Wed 11-04)
  eq('remind_watch: before 16:00 on the deadline day = upcoming', st(ov, '2026-11-04T15:59:59+02:00', 'remind_watch'), 'upcoming:2');
  eq('remind_watch: 16:00 = due', st(ov, '2026-11-04T16:00:00+02:00', 'remind_watch'), 'due:2');
  eq('remind_watch: 23:59:59 = due', st(ov, '2026-11-04T23:59:59+02:00', 'remind_watch'), 'due:2');
  eq('remind_watch: next midnight = expired', st(ov, '2026-11-05T00:00:01+02:00', 'remind_watch'), 'expired:2');
  eq('remind_watch: manual done', st(week(g => { g.done = ['watch|2026-11-07']; }), '2026-11-04T17:00:00+02:00', 'remind_watch'), 'done:2');
  eq('remind_watch: expires_at_iso reported', at(ov, '2026-11-04T17:00:00+02:00', 'remind_watch').expires_at_iso, '2026-11-04T23:59:59+02:00');
  // parents_watch: day after the deadline .. S
  eq('parents_watch: before the day after the deadline = upcoming', st(ov, '2026-11-05T15:59:00+02:00', 'parents_watch'), 'upcoming:1');
  eq('parents_watch: 16:00 the day after = due', st(ov, '2026-11-05T16:00:00+02:00', 'parents_watch'), 'due:1');
  eq('parents_watch: right up to S = due', st(ov, '2026-11-07T17:59:00+02:00', 'parents_watch'), 'due:1');
  eq('parents_watch: once the session has started the window is over (next week = upcoming)', st(ov, '2026-11-07T18:00:01+02:00', 'parents_watch'), 'upcoming:1');
  eq('parents_watch: expires_at_iso is not reported (decision D4)', at(ov, '2026-11-05T17:00:00+02:00', 'parents_watch').expires_at_iso, null);
  // remind_hw: hw deadline day (S-1 = Fri 11-06)
  eq('remind_hw: before = upcoming', st(ov, '2026-11-06T15:59:00+02:00', 'remind_hw'), 'upcoming:2');
  eq('remind_hw: 16:00 = due', st(ov, '2026-11-06T16:00:00+02:00', 'remind_hw'), 'due:2');
  eq('remind_hw: end of day = due', st(ov, '2026-11-06T23:59:59+02:00', 'remind_hw'), 'due:2');
  eq('remind_hw: after = expired', st(ov, '2026-11-07T00:00:01+02:00', 'remind_hw'), 'expired:2');
  eq('remind_hw: manual done', st(week(g => { g.done = ['hw|2026-11-07']; }), '2026-11-06T17:00:00+02:00', 'remind_hw'), 'done:2');
  // parents_hw: S.date 16:00 .. S+3d, and it survives the session itself
  eq('parents_hw: before = upcoming', st(ov, '2026-11-07T15:59:00+02:00', 'parents_hw'), 'upcoming:2');
  eq('parents_hw: S.date 16:00 = due', st(ov, '2026-11-07T16:00:00+02:00', 'parents_hw'), 'due:2');
  let r2 = at(ov, '2026-11-07T18:30:00+02:00');
  t('parents_hw: after the session starts it is still due for THAT session', ev(r2, 'parents_hw').state === 'due' && ev(r2, 'parents_hw').session_date === '2026-11-07', ev(r2, 'parents_hw'));
  eq('parents_hw: S+3d = due', st(ov, '2026-11-10T18:00:00+02:00', 'parents_hw'), 'due:2');
  r2 = at(ov, '2026-11-10T18:00:01+02:00');
  t('parents_hw: after S+3d the next week is shown (upcoming, new session_date)', ev(r2, 'parents_hw').state === 'upcoming' && ev(r2, 'parents_hw').session_date === '2026-11-14', ev(r2, 'parents_hw'));
  // advance already done -> the previous-session parents_hw is over (D2)
  const adv = week(g => { g.done = ['advance|2026-11-07']; });
  r2 = at(adv, '2026-11-08T10:00:00+02:00');
  t('D2: advance done -> parents_hw of the finished session is over, next week shown', ev(r2, 'parents_hw').state === 'upcoming' && ev(r2, 'parents_hw').session_date === '2026-11-14', ev(r2, 'parents_hw'));
  // phase = top priority due
  eq('phase: attendance beats parents_hw', at(ov, '2026-11-07T20:00:00+02:00').phase, 'attendance');
  eq('phase: all_clear when nothing is due (attendance window over, lessons advanced)', at(week(g => { g.done = ['advance|2026-10-31']; }), '2026-11-03T19:00:00+02:00').phase, 'all_clear');
  eq('phase: attendance is still due inside its window', at(ov, '2026-11-02T10:00:00+02:00').phase, 'attendance');
  eq('phase: remind_watch alone', at(week(g => { g.done = ['advance|2026-10-31']; }), '2026-11-04T17:00:00+02:00').phase, 'remind_watch');
  eq('priority list is frozen', E.EVENT_KEYS, ['attendance', 'parents_watch', 'parents_hw', 'remind_watch', 'remind_hw', 'advance_lessons', 'setup_missing']);
}

/* -------------------------------------------------- setup_missing, empty and odd groups */
{
  const noTime = mkOverview([mkGroup('Loose', 3, { weekday: null, time: '', current_lesson: '' })]);
  let r = E.eventsFor(noTime, 'loose', '2026-11-04T10:00:00+02:00');      // Wednesday
  eq('setup_missing: only event, no sessions', [r.events.map(e => e.key), r.prev_session, r.next_session], [['setup_missing'], null, null]);
  const s = ev(r, 'setup_missing');
  t('setup_missing: due, count 1, fires last Sunday 16:00', s.state === 'due' && s.count === 1 && s.fire_at_iso === '2026-11-01T16:00:00+02:00' && s.session_date === '2026-11-01' && s.lesson === null, s);
  eq('setup_missing: phase', r.phase, 'setup_missing');
  r = E.eventsFor(noTime, 'loose', '2026-11-01T10:00:00+02:00');           // Sunday before 16:00 -> the previous Sunday (and its DST offset)
  eq('setup_missing: Sunday morning belongs to the previous Sunday (+03:00 then)', [ev(r, 'setup_missing').session_date, ev(r, 'setup_missing').fire_at_iso], ['2026-10-25', '2026-10-25T16:00:00+03:00']);
  r = E.eventsFor(noTime, 'loose', '2026-11-01T16:00:00+02:00');
  eq('setup_missing: Sunday 16:00 starts the new week', ev(r, 'setup_missing').session_date, '2026-11-01');
  eq('setup_missing: dueNow carries it', E.dueNow(noTime, '2026-11-04T10:00:00+02:00').map(d => [d.key, d.count, d.session_date]), [['setup_missing', 1, '2026-11-01']]);
  const noMembers = mkOverview([mkGroup('Empty', 0, { weekday: null, time: '', current_lesson: '' })]);
  r = E.eventsFor(noMembers, 'empty', '2026-11-04T10:00:00+02:00');
  eq('0 students, nothing set: no events, all_clear', [r.events, r.phase, r.next_event_at_iso], [[], 'all_clear', null]);
  const emptySched = mkOverview([mkGroup('Sat 18:00', 0)]);
  r = E.eventsFor(emptySched, 'sat 18:00', '2026-11-06T16:30:00+02:00');
  eq('0 students with a schedule: every count is 0, nothing due', [r.events.every(e => e.count === 0 || e.key === 'advance_lessons'), r.events.filter(e => e.state === 'due').map(e => e.key)], [true, []]);
  const noLesson = mkOverview([mkGroup('Sat 18:00', 3, { current_lesson: '' })], {});
  r = E.eventsFor(noLesson, 'sat 18:00', '2026-11-04T17:00:00+02:00');
  t('no current lesson: setup_missing due, attendance/watch counts 0', ev(r, 'setup_missing').count === 1 && ev(r, 'attendance').count === 0 && ev(r, 'remind_watch').count === 0, brief(r));
  const noTimeButDay = mkOverview([mkGroup('Half', 2, { time: '' })]);
  eq('weekday set but time unset: setup_missing only', E.eventsFor(noTimeButDay, 'half', '2026-11-04T10:00:00+02:00').events.map(e => e.key), ['setup_missing']);
  eq('unknown group = null', E.eventsFor(week(), 'nope', '2026-11-04T10:00:00+02:00'), null);
  eq('group lookup is case-insensitive and also accepts the display name', [E.eventsFor(week(), 'SAT 18:00', '2026-11-04T10:00:00+02:00').group_key, E.eventsFor(week(), 'Sat 18:00', '2026-11-04T10:00:00+02:00').group], ['sat 18:00', 'Sat 18:00']);
  const dup = week(g => { g.members.push(clone(g.members[0])); });
  eq('a member listed twice counts once', at(dup, '2026-11-04T16:00:00+02:00', 'remind_watch').count, 2);
  // student with no parent phone is still counted (the page shows the warning)
  const np = week(); np.students = { [pk(3)]: { phone: phone(3), name: 'Student 3', parent_phone: '' } };
  eq('a student with no parent phone is still counted', at(np, '2026-11-05T17:00:00+02:00', 'parents_watch').count, 1);
}

/* -------------------------------------------------- requirements */
{
  const NOW = '2026-11-07T16:30:00+02:00';
  const base = at(week(), NOW);
  eq('requirements: missing = today\'s behaviour (watch 80)', [ev(base, 'remind_watch').count, ev(base, 'parents_hw').count], [2, 2]);
  const R = (o) => week(g => { g.requirements = o; });
  const off = (...ks) => R(Object.fromEntries(ks.map(k => [k, { enabled: false }])));
  eq('watch off: no remind_watch / parents_watch students', [at(off('watch'), NOW, 'remind_watch').count, at(off('watch'), NOW, 'parents_watch').count], [0, 0]);
  eq('homework off: remind_hw 0, parents_hw keeps the quiz-absent student only', [at(off('homework'), NOW, 'remind_hw').count, at(off('homework'), NOW, 'parents_hw').student_keys], [0, [pk(4)]]);
  eq('quiz off: parents_hw loses the quiz-absent student', at(off('quiz'), NOW, 'parents_hw').student_keys, [pk(3)]);
  eq('attendance off: no attendance students and no blocking', [at(off('attendance'), NOW, 'attendance').count, at(off('attendance'), NOW, 'parents_hw').blocked_count, at(off('attendance'), NOW, 'parents_watch').student_keys], [0, 0, [pk(1), pk(3)]]);
  eq('watch rule pct replaces watch_done_pct (30: the 40% student is fine)', at(R({ watch: { enabled: true, rule: { pct: 30 } } }), NOW, 'remind_watch').student_keys, [pk(1)]);
  eq('watch rule pct 100: a student at exactly 100% is done', at(R({ watch: { enabled: true, rule: { pct: 100 } } }), NOW, 'remind_watch').student_keys, [pk(1), pk(3)]);
  eq('watch rule pct junk is ignored (falls back to 80)', at(R({ watch: { enabled: true, rule: { pct: 'abc' } } }), NOW, 'remind_watch').count, 2);
  eq('written_answers has no event (ignored)', at(off('written_answers'), NOW, 'remind_watch').count, 2);
  eq('D3 parent_message=false keeps quiz out of parents_hw but not remind_*', [at(R({ quiz: { enabled: true, parent_message: false } }), NOW, 'parents_hw').student_keys, at(R({ homework: { enabled: true, parent_message: false } }), NOW, 'remind_hw').count], [[pk(3)], 2]);
  eq('requirement flags with no rule object do not crash', at(R({ watch: { enabled: true } }), NOW, 'remind_watch').count, 2);
  eq('watch off and the group has done nothing: phase has no watch event', at(off('watch'), '2026-11-04T17:00:00+02:00').phase === 'remind_watch', false);
}

/* -------------------------------------------------- parent_log, notify, done */
{
  const NOW = '2026-11-05T17:00:00+02:00';
  const lg = week(); lg.parent_log = { [pk(3)]: [{ kind: 'custom', ref: ('watch:' + L2).toUpperCase(), sent_at: '2026-11-05 12:00:00', note: '' }] };
  const r = at(lg, NOW);
  eq('parent_log: a logged watch message (any case) removes the student from parents_watch', [ev(r, 'parents_watch').count, ev(r, 'parents_watch').state], [0, 'done']);
  eq('parent_log: remind_watch is not affected by it', ev(r, 'remind_watch').count, 2);
  const hw = week(); hw.parent_log = { [pk(3)]: [{ kind: 'homework', ref: L1, sent_at: '2026-11-07 10:00:00' }], [pk(4)]: [{ kind: 'quiz', ref: L1, sent_at: '2026-11-07 10:00:00' }] };
  eq('parent_log: homework / quiz messages remove the students from parents_hw', at(hw, '2026-11-07T17:00:00+02:00', 'parents_hw').count, 0);
  const part = week(); part.parent_log = { [pk(3)]: [{ kind: 'homework', ref: L1, sent_at: '2026-11-07 10:00:00' }] };
  eq('parent_log: a logged homework does not hide a different open issue (here none left for s3)', at(part, '2026-11-07T17:00:00+02:00', 'parents_hw').student_keys, [pk(4)]);
  const wrongKind = week(); wrongKind.parent_log = { [pk(3)]: [{ kind: 'quiz', ref: L1, sent_at: 'x' }] };
  eq('parent_log: a message of another kind does not count', at(wrongKind, '2026-11-07T17:00:00+02:00', 'parents_hw').student_keys, [pk(3), pk(4)]);

  const n = (o) => week(g => { g.notify = o; g.done = ['advance|2026-10-31']; });   // advance done: only remind_watch is due at T
  const T = '2026-11-04T16:30:00+02:00';
  eq('notify: missing = enabled, 16:00 (advance_lessons is due too until it is marked)', E.dueNow(week(), T).map(d => d.key), ['remind_watch', 'advance_lessons']);
  eq('notify: missing object = same as the defaults', E.dueNow(n(undefined), T).map(d => d.key), ['remind_watch']);
  eq('notify: enabled=false -> dueNow empty', E.dueNow(n({ enabled: false, hour: 16, snooze_until: '' }), T), []);
  eq('notify: enabled=false -> the page still sees the due event', at(n({ enabled: false }), T, 'remind_watch').state, 'due');
  eq('notify: snoozed until tomorrow -> dueNow empty today', E.dueNow(n({ enabled: true, hour: 16, snooze_until: '2026-11-05' }), T), []);
  eq('notify: snooze_until = today -> already over', E.dueNow(n({ enabled: true, hour: 16, snooze_until: '2026-11-04' }), T).length, 1);
  const gSnz = { notify: { snooze_until: '2026-11-05' } };
  eq('notify: snooze ends when that date starts (Alex), not at UTC midnight', [E._h.muted(gSnz, new Date('2026-11-04T23:59:59+02:00')), E._h.muted(gSnz, new Date('2026-11-05T00:00:00+02:00')), E._h.muted(gSnz, new Date('2026-11-04T22:30:00Z'))], [true, false, false]);
  eq('notify: after the snooze the next due event is delivered again', E.dueNow(n({ snooze_until: '2026-11-05' }), '2026-11-05T16:00:00+02:00').map(d => d.key), ['parents_watch']);
  eq('notify: snoozed group still reports events', at(n({ snooze_until: '2026-11-05' }), T, 'remind_watch').state, 'due');
  eq('notify: junk snooze value is ignored', E.dueNow(n({ snooze_until: 'tomorrow' }), T).length, 1);
  eq('notify: hour moves the fire time', at(n({ hour: 9 }), '2026-11-04T08:59:00+02:00', 'remind_watch').fire_at_iso, '2026-11-04T09:00:00+02:00');
  eq('notify: hour 9 is due at 09:00', at(n({ hour: 9 }), '2026-11-04T09:00:00+02:00', 'remind_watch').state, 'due');
  eq('notify: hour out of range falls back to 16', at(n({ hour: 25 }), T, 'remind_watch').fire_at_iso, '2026-11-04T16:00:00+02:00');
  eq('notify: hour 0 is valid (midnight)', at(n({ hour: 0 }), T, 'remind_watch').fire_at_iso, '2026-11-04T00:00:00+02:00');
  eq('notify: parents_hw also follows the hour', at(n({ hour: 10 }), T, 'parents_hw').fire_at_iso, '2026-11-07T10:00:00+02:00');
  eq('notify: attendance / advance ignore the hour (P+1h, P+3h)', [at(n({ hour: 10 }), T, 'attendance').fire_at_iso, at(n({ hour: 10 }), T, 'advance_lessons').fire_at_iso], ['2026-10-31T19:00:00+02:00', '2026-10-31T21:00:00+02:00']);

  // dueNow across groups: order = groups, then priority; muted group skipped
  const f = {}; for (let i = 1; i <= 4; i++) f[i] = { [L2]: { att: 'online', pct: 10 }, [L1]: { hw: true, quiz: true } };
  const g1 = mkGroup('Sat 18:00', 4), g2 = mkGroup('Sat 18:00 B', 4), g3 = mkGroup('Sat 18:00 C', 4);
  [g1, g2, g3].forEach(g => { g.done = ['advance|2026-10-31']; });
  g2.notify = { enabled: false };
  const ov = mkOverview([g1, g2, g3], mkFacts(f));
  eq('dueNow: several groups, muted one skipped', E.dueNow(ov, '2026-11-05T17:00:00+02:00').map(d => d.group_key + '/' + d.key + '/' + d.count), ['sat 18:00/parents_watch/4', 'sat 18:00 c/parents_watch/4']);
  eq('dueNow: shape', Object.keys(E.dueNow(ov, '2026-11-05T17:00:00+02:00')[0]), ['group_key', 'group', 'key', 'session_date', 'count', 'student_keys', 'lesson', 'blocked_count']);
  eq('dueNow: never returns count 0', E.dueNow(week(g => { g.requirements = { watch: { enabled: false } }; g.done = ['advance|2026-10-31']; }), '2026-11-04T17:00:00+02:00').length, 0);
  // student_keys are capped at 200, count is not
  const big = mkGroup('Big', 250, { weekday: 6, time: '18:00' }); const bigO = mkOverview([big], {});
  const rb = E.eventsFor(bigO, 'big', '2026-11-04T17:00:00+02:00');
  eq('student_keys capped at 200 but count is the real number', [ev(rb, 'remind_watch').student_keys.length, ev(rb, 'remind_watch').count], [200, 250]);
  // overview.now is the fallback clock
  eq('nowIso omitted -> overview.now', E.eventsFor(week(), 'sat 18:00').phase, E.eventsFor(week(), 'sat 18:00', week().now).phase);
  eq('a Date and an epoch are accepted as "now"', [E.eventsFor(week(), 'sat 18:00', new Date('2026-11-04T17:00:00+02:00')).phase, E.eventsFor(week(), 'sat 18:00', Date.parse('2026-11-04T17:00:00+02:00')).phase], ['remind_watch', 'remind_watch']);
}

/* -------------------------------------------------- DST (Egypt 2026: forward Fri 04-24 00:00 -> 01:00, back Thu 10-29 24:00 -> 23:00) */
{
  const H = E._h;
  // 1. Alex time maths agrees with followup-logic.js everywhere
  let bad = 0, n = 0;
  const probes = ['2026-03-20', '2026-04-10', '2026-04-20', '2026-04-23', '2026-04-24', '2026-04-27', '2026-10-24', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2027-04-27', '2027-10-27'];
  probes.forEach(d => { for (let hr = 0; hr < 24; hr += 3) for (const wd of [0, 1, 4, 5, 6]) for (const tm of ['00:30', '09:00', '18:00', '23:30']) {
    const now = new Date(Date.parse(d + 'T00:00:00Z') + hr * 3600000), ns = L.nextSession(now, wd, tm);
    if (!ns) continue; n++;
    const [hh, mm] = tm.split(':').map(Number);
    if (H.cairoInstant(ns.date, hh, mm).getTime() !== ns.at.getTime()) bad++;
  } });
  t('cairoInstant == the instant followup-logic.js computes (' + n + ' DST-week probes)', bad === 0 && n > 500, { bad, n });
  // 2. iso strings round-trip and carry the real offset
  let rt = 0;
  for (let ms = Date.parse('2026-04-23T18:00:00Z'); ms < Date.parse('2026-04-24T06:00:00Z'); ms += 900000) if (new Date(H.isoAlex(new Date(ms))).getTime() !== ms) rt++;
  for (let ms = Date.parse('2026-10-29T18:00:00Z'); ms < Date.parse('2026-10-30T06:00:00Z'); ms += 900000) if (new Date(H.isoAlex(new Date(ms))).getTime() !== ms) rt++;
  eq('isoAlex round-trips every 15 min around both 2026 transitions', rt, 0);
  eq('isoAlex offsets on both sides of the autumn change', [H.isoAlex(new Date('2026-10-29T20:59:59Z')), H.isoAlex(new Date('2026-10-29T21:00:00Z'))], ['2026-10-29T23:59:59+03:00', '2026-10-29T23:00:00+02:00']);
  eq('isoAlex offsets on both sides of the spring change', [H.isoAlex(new Date('2026-04-23T21:59:59Z')), H.isoAlex(new Date('2026-04-23T22:00:00Z'))], ['2026-04-23T23:59:59+02:00', '2026-04-24T01:00:00+03:00']);

  // 3. The owner's 2026 weeks. Autumn: session Sat 10-31 is after the change, Sat 10-24 before it.
  const f = {}; for (let i = 1; i <= 3; i++) f[i] = { [L2]: { att: null, pct: 10 }, [L1]: { hw: false, quiz: true } };
  const ov = mkOverview([mkGroup('Sat 18:00', 3)], mkFacts(f));
  let r = E.eventsFor(ov, 'sat 18:00', '2026-10-28T10:00:00+03:00');
  eq('autumn week: sessions carry their own offsets', [r.prev_session, r.next_session], [{ date: '2026-10-24', at_iso: '2026-10-24T18:00:00+03:00' }, { date: '2026-10-31', at_iso: '2026-10-31T18:00:00+02:00' }]);
  eq('autumn week: remind_watch Wed 10-28 16:00 (+03:00), to the end of that day', [ev(r, 'remind_watch').fire_at_iso, ev(r, 'remind_watch').expires_at_iso], ['2026-10-28T16:00:00+03:00', '2026-10-28T23:59:59+03:00']);
  eq('autumn week: parents_watch Thu 10-29 16:00 (+03:00, the change comes at midnight)', ev(r, 'parents_watch').fire_at_iso, '2026-10-29T16:00:00+03:00');
  eq('autumn week: remind_hw Fri 10-30 16:00 (+02:00)', [ev(r, 'remind_hw').fire_at_iso, ev(r, 'remind_hw').expires_at_iso], ['2026-10-30T16:00:00+02:00', '2026-10-30T23:59:59+02:00']);
  eq('autumn week: parents_hw Sat 10-31 16:00 (+02:00)', ev(r, 'parents_hw').fire_at_iso, '2026-10-31T16:00:00+02:00');
  const fm = {}; for (let i = 1; i <= 3; i++) fm[i] = { [L2]: { att: 'online', pct: 10 }, [L1]: { hw: false, quiz: true } };
  const ovM = mkOverview([mkGroup('Sat 18:00', 3)], mkFacts(fm));
  eq('autumn week: the previous session\'s parents_hw (Oct 24) is open until Tue 10-27 18:00 (+03:00), then next week\'s shows', [E.eventsFor(ovM, 'sat 18:00', '2026-10-27T10:00:00+03:00').events.find(e => e.key === 'parents_hw').fire_at_iso, E.eventsFor(ovM, 'sat 18:00', '2026-10-27T18:00:01+03:00').events.find(e => e.key === 'parents_hw').fire_at_iso], ['2026-10-24T16:00:00+03:00', '2026-10-31T16:00:00+02:00']);
  eq('autumn week: attendance / advance of the 10-24 session (+03:00)', [ev(r, 'attendance').fire_at_iso, ev(r, 'advance_lessons').fire_at_iso], ['2026-10-24T19:00:00+03:00', '2026-10-24T21:00:00+03:00']);
  eq('autumn week: the 3-day windows keep the 18:00 wall time across the change (attendance ends Tue 10-27 18:00 +03:00)', [st(ov, '2026-10-27T18:00:00+03:00', 'attendance'), st(ov, '2026-10-27T18:00:01+03:00', 'attendance')], ['due:3', 'expired:3']);
  eq('autumn week: advance ends Thu 10-29 18:00 (+03:00) = P+5d wall time', [st(ov, '2026-10-29T18:00:00+03:00', 'advance_lessons'), st(ov, '2026-10-29T18:00:01+03:00', 'advance_lessons')], ['due:1', 'expired:1']);
  eq('autumn week after the change: weekly Sunday setup uses the new offset', ev(E.eventsFor(mkOverview([mkGroup('X', 2, { weekday: null, time: '' })]), 'x', '2026-11-03T10:00:00+02:00'), 'setup_missing').fire_at_iso, '2026-11-01T16:00:00+02:00');
  // spring: session Sat 04-25 is after the change, Sat 04-18 before it
  r = E.eventsFor(ov, 'sat 18:00', '2026-04-22T10:00:00+02:00');
  eq('spring week: sessions', [r.prev_session.at_iso, r.next_session.at_iso], ['2026-04-18T18:00:00+02:00', '2026-04-25T18:00:00+03:00']);
  eq('spring week: reminders before the change keep +02:00, after it +03:00', [ev(r, 'remind_watch').fire_at_iso, ev(r, 'parents_watch').fire_at_iso, ev(r, 'remind_hw').fire_at_iso, ev(r, 'parents_hw').fire_at_iso], ['2026-04-22T16:00:00+02:00', '2026-04-23T16:00:00+02:00', '2026-04-24T16:00:00+03:00', '2026-04-25T16:00:00+03:00']);
  eq('spring week: hw deadline day ends 23:59:59 +03:00', ev(r, 'remind_hw').expires_at_iso, '2026-04-24T23:59:59+03:00');
  // a session time that does not exist (spring gap Fri 04-24 00:00-01:00) or happens twice (autumn Thu 10-29 23:00-24:00) must not break anything
  const gap = mkOverview([mkGroup('Gap', 2, { weekday: 5, time: '00:30' })], {});
  r = E.eventsFor(gap, 'gap', '2026-04-20T10:00:00+02:00');
  const nsGap = L.nextSession(new Date('2026-04-20T10:00:00+02:00'), 5, '00:30');
  t('spring gap: session at 00:30 on 04-24 resolves to a real instant, same as followup-logic', new Date(r.next_session.at_iso).getTime() === nsGap.at.getTime() && r.events.length === 6, r.next_session);
  const dbl = mkOverview([mkGroup('Dbl', 2, { weekday: 4, time: '23:30' })], {});
  r = E.eventsFor(dbl, 'dbl', '2026-10-25T12:00:00+03:00');
  const nsD = L.nextSession(new Date('2026-10-25T12:00:00+03:00'), 4, '23:30');
  t('autumn double hour: session at 23:30 on 10-29 resolves like followup-logic', new Date(r.next_session.at_iso).getTime() === nsD.at.getTime() && r.next_session.date === '2026-10-29', r.next_session);
  const fall2 = E.eventsFor(dbl, 'dbl', '2026-10-30T10:00:00+02:00');
  eq('autumn double hour: the week after (prev = 10-29, next = 11-05)', [fall2.prev_session.date, fall2.next_session.date, fall2.next_session.at_iso], ['2026-10-29', '2026-11-05', '2026-11-05T23:30:00+02:00']);
  // every event of every state is a valid ISO instant over a whole year of hourly "now"s (no NaN, no throw)
  let badIso = 0, thrown = 0;
  const ovY = mkOverview([mkGroup('Sat 18:00', 3), mkGroup('Fri 00:30', 3, { weekday: 5, time: '00:30' })], mkFacts(f));
  for (let ms = Date.parse('2026-04-15T00:00:00Z'); ms < Date.parse('2026-05-05T00:00:00Z'); ms += 3600000 * 5) {
    try { E.dueNow(ovY, new Date(ms)); ['sat 18:00', 'fri 00:30'].forEach(k => E.eventsFor(ovY, k, new Date(ms)).events.forEach(e => { if (isNaN(Date.parse(e.fire_at_iso))) badIso++; })); } catch (e) { thrown++; }
  }
  for (let ms = Date.parse('2026-10-20T00:00:00Z'); ms < Date.parse('2026-11-10T00:00:00Z'); ms += 3600000 * 5) {
    try { E.dueNow(ovY, new Date(ms)); ['sat 18:00', 'fri 00:30'].forEach(k => E.eventsFor(ovY, k, new Date(ms)).events.forEach(e => { if (isNaN(Date.parse(e.fire_at_iso))) badIso++; })); } catch (e) { thrown++; }
  }
  eq('two DST months of "now" values: no invalid ISO, no exception', [badIso, thrown], [0, 0]);
}

/* -------------------------------------------------- module surface */
{
  eq('constants', [E.TZ_LABEL, E.NOTIFY_HOUR_DEFAULT], ['Alex', 16]);
  const s = JSON.stringify(E.eventsFor(week(), 'sat 18:00', '2026-11-04T17:00:00+02:00'));
  t('the word "Cairo" never appears in the output', !/cairo/i.test(s), s.slice(0, 200));
  t('output is plain JSON (no Dates, no undefined)', JSON.stringify(JSON.parse(s)) === s);
  const ov = week(), snap = JSON.stringify(ov);
  E.eventsFor(ov, 'sat 18:00', '2026-11-04T17:00:00+02:00'); E.dueNow(ov, '2026-11-04T17:00:00+02:00');
  eq('the overview is never modified', JSON.stringify(ov), snap);
  const ovR = week(g => { g.requirements = { watch: { enabled: true, rule: { pct: 50 } } }; }), snap2 = JSON.stringify(ovR);
  E.eventsFor(ovR, 'sat 18:00', '2026-11-04T17:00:00+02:00');
  eq('the overview is never modified (watch pct override path)', JSON.stringify(ovR), snap2);
}

/* -------------------------------------------------- same answers under another machine time zone */
if (!process.env.FU_TZ_CHILD) {
  const r = cp.spawnSync(process.execPath, [__filename, root], { env: Object.assign({}, process.env, { TZ: 'America/Los_Angeles', FU_TZ_CHILD: '1' }), encoding: 'utf8' });
  const fails = ((r.stdout || '').match(/^FAIL /gm) || []).length, passes = ((r.stdout || '').match(/^PASS /gm) || []).length;
  t('same result with TZ=America/Los_Angeles (' + passes + ' checks)', r.status === 0 && fails === 0 && passes > 100, (r.stdout || '').split('\n').filter(l => /^FAIL/.test(l)).slice(0, 5).join(' | ') + (r.stderr || '').slice(0, 300));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
