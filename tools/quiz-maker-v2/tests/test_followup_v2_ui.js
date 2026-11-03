// Follow-up v2 / S1: page-side checks that need no browser.
//   node tests/test_followup_v2_ui.js          (run from tools/quiz-maker-v2)
// - the 12-hour formatter in followup-app.js (contract 3.12), lifted out of the page source and run as-is
// - user-facing text never says "Cairo", no new <input type="time">, script order in followup.html
// - the mock fixture carries the 3.4 additions on every group and the requirement defaults of 3.5
// - the S1 stub of FollowupEvents answers in the contract shape (3.2)
// - when S3's assets/followup-events.js exists: every mock scenario gives the phase the page is built for
//   (cross-session check; skipped with a NOTE before S3 merges)
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));

const APP = fs.readFileSync(path.join(root, 'assets', 'followup-app.js'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF; the regexes below expect LF
const HTML = fs.readFileSync(path.join(root, 'dashboard', 'followup.html'), 'utf8');
const FIX = JSON.parse(fs.readFileSync(path.join(root, 'dashboard', '_fixtures', 'followup-overview.json'), 'utf8'));

/* ---------------------------------------------------------------- fmtTime12 (3.12) */
{
  const m = /function fmtTime12\(t, lang\) \{[\s\S]*?\n  \}\n/.exec(APP);
  t('fmtTime12 is defined in followup-app.js', !!m);
  const f = vm.runInNewContext('(' + (m ? m[0].replace(/^function fmtTime12/, 'function') : 'function(){return "";}') + ')');
  eq('16:00 en -> 4:00 PM', f('16:00', 'en'), '4:00 PM');
  eq('16:00 ar -> 4:00 م', f('16:00', 'ar'), '4:00 م');
  eq('09:30 ar -> 9:30 ص', f('09:30', 'ar'), '9:30 ص');
  eq('midnight -> 12:00 AM', f('00:00', 'en'), '12:00 AM');
  eq('noon -> 12:00 PM', f('12:00', 'en'), '12:00 PM');
  eq('23:59 ar -> 11:59 م', f('23:59', 'ar'), '11:59 م');
  eq('one-digit hour accepted (7:05)', f('7:05', 'en'), '7:05 AM');
  eq('invalid -> ""', [f('', 'ar'), f('24:00', 'ar'), f('12:60', 'en'), f('abc', 'en'), f(null, 'ar')], ['', '', '', '', '']);
  // same behaviour as the page's existing timeAr() reference for every minute of the day
  const r = /function timeAr\(t\) \{[\s\S]*?\n  \}\n/.exec(APP);
  const ta = vm.runInNewContext('(' + r[0].replace(/^function timeAr/, 'function') + ')');
  let same = true, bad = '';
  for (let h = 0; h < 24; h++) for (let mi = 0; mi < 60; mi += 1) {
    const s = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
    if (f(s, 'ar') !== ta(s)) { same = false; bad = s + ' ' + f(s, 'ar') + ' vs ' + ta(s); break; }
  }
  t('fmtTime12(…, "ar") equals the reference timeAr() for all 1440 minutes', same, bad);
}

/* ------------------------------------------------------------- text rules (owner decisions) */
{
  // strip comments, then look at string literals only
  const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
  const strs = code.match(/"(?:[^"\\\n]|\\.)*"/g) || [];
  const cairo = strs.filter(s => /cairo|القاهرة/i.test(s) && s !== '"Africa/Cairo"');
  t('no user-facing string in followup-app.js says Cairo / القاهرة (only the "Africa/Cairo" zone id)', !cairo.length, cairo);
  t('TZ_LABEL = "Alex" is defined once', (APP.match(/var TZ_LABEL = "Alex"/g) || []).length === 1);
  t('"Alex" is not typed anywhere else in strings', strs.filter(s => s === '"Alex"').length === 1, strs.filter(s => /Alex/.test(s)));
  t('no <input type="time"> left in the page code', !/type:\s*"time"/.test(code));
  t('"last updated" line goes through fmtTime12', /آخر تحديث " \+ fmtTime12\(hhmm\(/.test(APP));
}

/* ----------------------------------------------------------------------- followup.html */
{
  const idx = s => HTML.indexOf(s);
  t('followup-events.js and followup-walk.js load before followup-app.js',
    idx('/assets/followup-events.js') > 0 && idx('/assets/followup-walk.js') > idx('/assets/followup-events.js') && idx('/assets/followup-app.js') > idx('/assets/followup-walk.js'));
  t('followup-events.js loads after followup-logic.js (it needs FollowupLogic)', idx('/assets/followup-events.js') > idx('/assets/followup-logic.js'));
  t('both S3 scripts are loaded defensively (onerror)', /followup-events\.js" onerror=/.test(HTML) && /followup-walk\.js" onerror=/.test(HTML));
  t('followup-walk.css is linked', idx('/assets/followup-walk.css') > 0);
  t('the stub is never referenced by the page', idx('__stubs__') < 0);
}

/* --------------------------------------------------------------------- fixture (3.4 / 3.5) */
{
  t('fixture: tz_label is "Alex"', FIX.tz_label === 'Alex');
  const KEYS = ['watch', 'homework', 'quiz', 'attendance', 'written_answers'];
  t('fixture: every group has done[], notify{enabled,hour,snooze_until} and requirements',
    FIX.groups.every(g => Array.isArray(g.done) && g.notify && g.notify.enabled === true && g.notify.hour === 16 && g.notify.snooze_until === '' && g.requirements));
  const r = FIX.groups[0].requirements;
  eq('fixture: requirement keys = the five built-ins', Object.keys(r).sort(), KEYS.slice().sort());
  t('fixture: defaults reproduce today (all enabled, all in report, watch pct 80)', KEYS.every(k => r[k].enabled && r[k].in_monthly_report) && r.watch.rule.pct === 80);
  eq('fixture: parent_message true for watch/homework/quiz only', KEYS.filter(k => r[k].parent_message), ['watch', 'homework', 'quiz']);
  t('fixture: unclassified_requirements present', !!FIX.unclassified_requirements && !!FIX.unclassified_requirements.homework);
  const sc = FIX._v2_scenarios || {};
  ['golden1', 'golden2', 'advance', 'parents', 'reqoff', 'setup'].forEach(n => t('fixture: scenario ' + n + ' exists with now/today', !!(sc[n] && sc[n].now && sc[n].today)));
  t('fixture: golden1 is Fri 2026-11-06 4:30 PM Alex', sc.golden1.now === '2026-11-06T16:30:00+02:00');
  t('fixture: golden2 is Sat 2026-11-07 8:30 PM Alex', sc.golden2.now === '2026-11-07T20:30:00+02:00');
}

/* ------------------------------------------------------- scenario -> overview (as mock mode does) */
function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const o = (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
  Object.keys(b).forEach(k => { o[k] = deepMerge(o[k], b[k]); });
  return o;
}
function overviewFor(name) {
  const j = JSON.parse(JSON.stringify(FIX)), sc = JSON.parse(JSON.stringify(j._v2_scenarios[name]));
  const groups = sc.groups; delete sc.groups; deepMerge(j, sc);
  Object.keys(groups || {}).forEach(k => { const g = j.groups.find(x => x.key === k); if (g) deepMerge(g, groups[k]); });
  delete j._v2_scenarios;
  return j;
}

/* ------------------------------------------------------------------ the S1 stub (3.2 shape) */
const ORDER = ['attendance', 'parents_watch', 'parents_hw', 'remind_watch', 'remind_hw', 'advance_lessons', 'setup_missing'];
const STATES = ['upcoming', 'due', 'expired', 'done'];
function shapeOk(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  for (const k of ['group_key', 'tz_label', 'phase', 'next_event_at_iso', 'events']) if (!(k in r)) return 'missing ' + k;
  if (r.tz_label !== 'Alex') return 'tz_label';
  if (r.phase !== 'all_clear' && ORDER.indexOf(r.phase) < 0) return 'phase ' + r.phase;
  let last = -1;
  for (const e of r.events) {
    if (ORDER.indexOf(e.key) < 0) return 'event key ' + e.key;
    if (STATES.indexOf(e.state) < 0) return 'state ' + e.state;
    if (ORDER.indexOf(e.key) < last) return 'priority order';
    last = ORDER.indexOf(e.key);
  }
  const due = r.events.filter(e => e.state === 'due');
  if ((due[0] ? due[0].key : 'all_clear') !== r.phase) return 'phase is not the top due event';
  return '';
}
{
  const STUB = require(path.join(root, 'assets', '__stubs__', 'followup-events.stub.js'));
  const want = { golden1: 'remind_hw', golden2: 'attendance', advance: 'advance_lessons', parents: 'parents_hw', reqoff: 'all_clear' };
  Object.keys(want).forEach(n => {
    const ov = overviewFor(n), r = STUB.eventsFor(ov, 'sat 6pm', ov.now);
    t('stub ' + n + ': contract shape', shapeOk(r) === '', shapeOk(r));
    eq('stub ' + n + ': phase', r.phase, want[n]);
  });
  const ov = overviewFor('golden1'); ov.groups[0].done.push('hw|2026-11-07');
  eq('stub honours done for remind_hw', STUB.eventsFor(ov, 'sat 6pm', ov.now).phase, 'all_clear');
  eq('stub: unknown group -> null', STUB.eventsFor(ov, 'nope', ov.now), null);
  t('stub: dueNow lists only due events with count > 0', STUB.dueNow(overviewFor('golden1')).every(x => x.count > 0));
}

/* -------------------------------------------- the real engine (S3) on the page's scenarios */
const EVJS = path.join(root, 'assets', 'followup-events.js');
if (!fs.existsSync(EVJS)) {
  console.log('NOTE assets/followup-events.js not merged yet: the cross-session scenario checks are skipped');
} else {
  const E = require(EVJS);
  const cases = [
    ['golden1', 'sat 6pm', 'remind_hw', r => (r.events.find(e => e.key === 'remind_hw') || {}).count === 3],
    ['golden2', 'sat 6pm', 'attendance', r => (r.events.find(e => e.key === 'attendance') || {}).count === 5 && r.next_event_at_iso === '2026-11-07T21:00:00+02:00'],
    ['advance', 'sat 6pm', 'advance_lessons', r => (r.events.find(e => e.key === 'advance_lessons') || {}).session_date === '2026-11-07'],
    ['parents', 'sat 6pm', 'parents_hw', r => (r.events.find(e => e.key === 'parents_hw') || {}).count === 3],
    ['reqoff', 'sat 6pm', 'all_clear', r => !r.events.some(e => e.key === 'remind_hw' && e.state === 'due')],
    ['setup', 'tue 4pm', 'setup_missing', r => r.next_session === null],
  ];
  cases.forEach(([n, gk, ph, extra]) => {
    const ov = overviewFor(n), r = E.eventsFor(ov, gk, ov.now);
    t('engine ' + n + ' (' + gk + '): contract shape', shapeOk(r) === '', shapeOk(r));
    eq('engine ' + n + ' (' + gk + '): phase', r && r.phase, ph);
    t('engine ' + n + ' (' + gk + '): counts / times the page relies on', !!(r && extra(r)), r && r.events);
  });
  // the stub and the engine agree on the phase for every Sat 6pm scenario the e2e test uses in stub mode
  const STUB = require(path.join(root, 'assets', '__stubs__', 'followup-events.stub.js'));
  ['golden1', 'golden2', 'advance', 'parents', 'reqoff'].forEach(n => {
    const ov = overviewFor(n);
    eq('stub == engine phase for ' + n, STUB.eventsFor(ov, 'sat 6pm', ov.now).phase, E.eventsFor(ov, 'sat 6pm', ov.now).phase);
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
