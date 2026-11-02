// Parity: the generated apps_script/FollowupLogic.gs (what the server runs) must answer exactly like the
// browser module assets/followup-events.js (what the page runs).  Follow-up v2, session S3.
//   node tests/test_followup_parity.js [repo-root]      (run from tools/quiz-maker-v2/; default root = ../..)
// The .gs is loaded in a bare vm context that only has what Apps Script has (Utilities.formatDate, Logger, JSON ...),
// with the global Intl made unusable, so the Utilities-based time shim is what is really being tested.
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const E = require(path.join(root, 'assets', 'followup-events.js'));
const GS = path.join(root, 'tools', 'quiz-maker-v2', 'apps_script', 'FollowupLogic.gs');
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e === undefined ? '' : (typeof e === 'string' ? e : JSON.stringify(e))))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
const clone = o => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------ the Apps Script sandbox */
let formatCalls = 0;
const fmtCache = {};
function formatDate(d, tz, pat) {                       // what Utilities.formatDate does for the one pattern the shim uses
  formatCalls++;
  if (pat !== 'yyyy-MM-dd HH:mm:ss') throw new Error('unexpected pattern ' + pat);
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const ctx = { Utilities: { formatDate }, Logger: { log() {} }, console };
vm.createContext(ctx);
vm.runInContext('Object.defineProperty(globalThis, "Intl", { get: function () { throw new Error("the server code must not use the global Intl"); }, configurable: true });', ctx);
let loadErr = null;
try { vm.runInContext(fs.readFileSync(GS, 'utf8'), ctx, { filename: 'FollowupLogic.gs' }); } catch (e) { loadErr = e; }
t('FollowupLogic.gs loads in a bare Apps Script-like context', !loadErr, loadErr && String(loadErr.stack || loadErr));
if (loadErr) { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
const S = { eventsFor: ctx.fu2_logic_eventsFor_, dueNow: ctx.fu2_logic_dueNow_ };
t('public functions exist', ['fu2_logic_eventsFor_', 'fu2_logic_dueNow_', 'fu2_logic_version_', 'fu2_logic_selfCheck'].every(n => typeof ctx[n] === 'function'));
t('only the four public functions plus namespaced vars are global (no leaks)', Object.keys(ctx).filter(k => !['Utilities', 'Logger', 'console'].includes(k)).every(k => /^(fu2_logic_|FU2_LOGIC_)/.test(k)), Object.keys(ctx));
t('version = module version + source hash', /^\d+\.\d+\.\d+\+[0-9a-f]{12}$/.test(ctx.fu2_logic_version_()) && ctx.fu2_logic_version_().startsWith(E.VERSION + '+'), ctx.fu2_logic_version_());
const sc = ctx.fu2_logic_selfCheck();
t('fu2_logic_selfCheck() passes (Egypt DST data + a tiny engine run)', sc.ok === true && sc.failures.length === 0, sc);
t('the Utilities.formatDate shim is what computes time', formatCalls > 0, formatCalls);

/* ------------------------------------------------ fixtures (same builders as test_followup_events.js, kept local) */
const B = 'programming/baccalaureate/grade-1-secondary/';
const L1 = B + 'chapter-2-lesson-1-variables', L2 = B + 'chapter-2-lesson-2-functions';
const phone = i => '01000000' + String(100 + i);
const pk = i => String(phone(i)).slice(-10);
const LESSONS = {}; [L1, L2].forEach(p => { LESSONS[p] = { path: p, has_video: true, has_quiz: true, has_assignment: true, lesson_locked: false, video_locked: false, quiz_locked: false }; });
function facts(map) {
  const out = {};
  Object.keys(map).forEach(i => { out[pk(+i)] = {}; Object.keys(map[i]).forEach(lesson => { const s = map[i][lesson];
    out[pk(+i)][lesson] = { can_watch: true, attendance: s.att === undefined ? null : s.att, watch_pct: s.pct === undefined ? null : s.pct,
      quiz: s.quiz ? { taken: true, score: 8, total: 10 } : { taken: false }, quiz_open: true, homework: { submitted: !!s.hw } }; }); });
  return out;
}
function grp(name, n, over, extra) {
  return Object.assign({ group: name, key: name.toLowerCase(),
    settings: Object.assign({ weekday: 6, time: '18:00', current_lesson: L2, review_lessons: [L1], hw_lessons: null, quiz_lessons: null, watch_deadline_override: '', hw_deadline_override: '' }, over || {}),
    members: Array.from({ length: n }, (_, i) => ({ phone: phone(i + 1), name: 'Student ' + (i + 1) })) }, extra || {});
}
function overview(groups, f, extra) {
  return Object.assign({ ok: true, now: '2026-11-06T16:30:00+02:00', settings: { watch_done_pct: 80, praise_quiz_pct: 90, watch_days_before: 3, hw_days_before: 1 },
    groups, unclassified: [], students: {}, lessons: clone(LESSONS), facts: f || {}, parent_log: {} }, extra || {});
}
const MIX = facts({
  1: { [L2]: { att: null }, [L1]: { hw: false, quiz: true } },
  2: { [L2]: { att: 'online', pct: 100 }, [L1]: { hw: true, quiz: true } },
  3: { [L2]: { att: 'online', pct: 40 }, [L1]: { hw: false, quiz: true } },
  4: { [L2]: { att: 'center' }, [L1]: { hw: true, quiz: false } }
});

// compare both implementations on one (overview, now): eventsFor for every group + dueNow
let compared = 0, mismatches = [];
function same(label, ov, nowIso) {
  const keys = ov.groups.map(g => g.key).concat(['no-such-group']);
  keys.forEach(k => {
    const a = JSON.stringify(E.eventsFor(ov, k, nowIso)), b = JSON.stringify(S.eventsFor(clone(ov), k, nowIso));
    compared++; if (a !== b) mismatches.push(label + ' ' + k + ' @ ' + nowIso + '\n  browser ' + a.slice(0, 300) + '\n  server  ' + b.slice(0, 300));
  });
  const a2 = JSON.stringify(E.dueNow(ov, nowIso)), b2 = JSON.stringify(S.dueNow(clone(ov), nowIso));
  compared++; if (a2 !== b2) mismatches.push(label + ' dueNow @ ' + nowIso);
}

/* ------------------------------------------------ golden examples */
{
  const f1 = {}; for (let i = 1; i <= 8; i++) f1[i] = { [L2]: { att: 'online', pct: 100 }, [L1]: { hw: i >= 4, quiz: true } };
  const g1 = grp('Sat 18:00', 8, {}, { done: ['advance|2026-10-31'] }), ov1 = overview([g1], facts(f1));
  const f2 = {}; for (let i = 1; i <= 12; i++) f2[i] = { [L2]: {}, [L1]: { hw: i % 2 === 0, quiz: true } };
  const g2 = grp('Sat 18:00', 12, {}, { done: ['hw|2026-11-07'] }), ov2 = overview([g2], facts(f2));
  same('golden 1', ov1, '2026-11-06T16:30:00+02:00'); same('golden 2', ov2, '2026-11-07T20:30:00+02:00');
  const s1 = S.eventsFor(clone(ov1), 'sat 18:00', '2026-11-06T16:30:00+02:00'), s2 = S.eventsFor(clone(ov2), 'sat 18:00', '2026-11-07T20:30:00+02:00');
  eq('server, golden 1: phase and the due reminder', [s1.phase, s1.events.find(e => e.key === 'remind_hw').count, s1.events.find(e => e.key === 'remind_hw').fire_at_iso], ['remind_hw', 3, '2026-11-06T16:00:00+02:00']);
  eq('server, golden 2: phase and attendance fire time', [s2.phase, s2.events.find(e => e.key === 'attendance').fire_at_iso], ['attendance', '2026-11-07T19:00:00+02:00']);
}

/* ------------------------------------------------ six DST-boundary fixtures (named, with known answers) */
{
  const f = {}; for (let i = 1; i <= 3; i++) f[i] = { [L2]: { att: 'online', pct: 10 }, [L1]: { hw: false, quiz: true } };
  const sat = grp('Sat 18:00', 3), fri = grp('Fri 00:30', 3, { weekday: 5, time: '00:30' }), thu = grp('Thu 23:30', 3, { weekday: 4, time: '23:30' });
  const ov = overview([sat, fri, thu], facts(f));
  const DST = [
    ['dst-1 spring, the last Alex minutes before the jump', '2026-04-23T23:30:00+02:00'],
    ['dst-2 spring, the first minutes after the jump', '2026-04-24T01:30:00+03:00'],
    ['dst-3 spring, the week before the jump (Sat 18:00 straddles it)', '2026-04-21T10:00:00+02:00'],
    ['dst-4 autumn, before the repeated hour', '2026-10-29T23:30:00+03:00'],
    ['dst-5 autumn, the repeated hour (second pass)', '2026-10-29T23:30:00+02:00'],
    ['dst-6 autumn, the week of the change', '2026-10-27T10:00:00+03:00']
  ];
  DST.forEach(([label, now]) => {
    const before = mismatches.length; same(label, ov, now);
    t(label + ': browser and server agree', mismatches.length === before, mismatches.slice(before)[0]);
  });
  const s = S.eventsFor(clone(ov), 'sat 18:00', '2026-10-27T10:00:00+03:00');
  eq('server, autumn week: offsets are right on both sides of the change', [s.events.find(e => e.key === 'remind_watch').fire_at_iso, s.events.find(e => e.key === 'remind_hw').fire_at_iso, s.next_session.at_iso],
    ['2026-10-28T16:00:00+03:00', '2026-10-30T16:00:00+02:00', '2026-10-31T18:00:00+02:00']);
  const sp = S.eventsFor(clone(ov), 'sat 18:00', '2026-04-21T10:00:00+02:00');
  eq('server, spring week: offsets are right on both sides of the change', [sp.events.find(e => e.key === 'parents_watch').fire_at_iso, sp.events.find(e => e.key === 'remind_hw').fire_at_iso, sp.next_session.at_iso],
    ['2026-04-23T16:00:00+02:00', '2026-04-24T16:00:00+03:00', '2026-04-25T18:00:00+03:00']);
}

/* ------------------------------------------------ sweeps */
{
  const groups = [grp('Sat 18:00', 4), grp('Thu 23:30', 4, { weekday: 4, time: '23:30' }), grp('Fri 00:30', 4, { weekday: 5, time: '00:30' }), grp('Sun 00:00', 4, { weekday: 0, time: '00:00' }),
    grp('Loose', 2, { weekday: null, time: '', current_lesson: '' }), grp('Empty', 0)];
  groups[0].done = ['advance|2026-10-24']; groups[1].notify = { enabled: true, hour: 9, snooze_until: '' };
  groups[3].requirements = { watch: { enabled: true, rule: { pct: 50 } }, homework: { enabled: false } };
  const ov = overview(groups, MIX); ov.parent_log = { [pk(3)]: [{ kind: 'custom', ref: 'watch:' + L2, sent_at: '2026-10-30 10:00:00' }] };
  const before = mismatches.length; let runs = 0;
  const sweep = (from, to, step) => { for (let ms = Date.parse(from); ms < Date.parse(to); ms += step) { same('sweep', ov, new Date(ms).toISOString()); runs++; } };
  sweep('2026-04-17T00:00:00Z', '2026-05-01T00:00:00Z', 97 * 60000 + 13000);       // spring change, odd steps so minutes vary
  sweep('2026-10-21T00:00:00Z', '2026-11-10T00:00:00Z', 97 * 60000 + 13000);       // autumn change
  sweep('2027-04-23T00:00:00Z', '2027-05-03T00:00:00Z', 11 * 3600000 + 7 * 60000);       // next year's spring
  sweep('2026-12-01T00:00:00Z', '2026-12-15T00:00:00Z', 5 * 3600000);                    // plain winter
  t('sweeps: ' + runs + ' instants x ' + groups.length + ' groups, browser == server', mismatches.length === before && runs > 300, mismatches.slice(before, before + 2).join('\n'));
}

t('all ' + compared + ' comparisons identical', mismatches.length === 0, mismatches.slice(0, 2).join('\n'));

/* ------------------------------------------------ the generated file is current */
{
  const py = ['python3', 'python', 'py'].find(c => { const r = cp.spawnSync(c, ['--version']); return !r.error && r.status === 0; });
  if (!py) t('build_server_logic.py --check (python not found: SKIPPED)', true);
  else {
    const r = cp.spawnSync(py, [path.join(root, 'scripts', 'build_server_logic.py'), '--check', '--root', root], { encoding: 'utf8' });
    t('build_server_logic.py --check: FollowupLogic.gs matches its two sources', r.status === 0, (r.stdout || '') + (r.stderr || ''));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
