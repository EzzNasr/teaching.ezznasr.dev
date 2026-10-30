// Phase 3 / S1: parent-contact logic, flag helpers, flag-off messaging.
//   node tests/test_p3_followup.js [apps_script dir]      (run from tools/quiz-maker-v2)
// Pure logic: assets/followup-logic.js. Server: Phase3_Flags.gs against the real Code.gs through the Apps Script mock.
const fs = require('fs'), path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const root = path.resolve(__dirname, '..', '..', '..');
const L = require(path.join(root, 'assets', 'followup-logic.js'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));

/* ---------------------------------------------------------- week / month derivation */
// Today = Fri 2026-10-16. The week runs Saturday .. Friday (same rule as the server's _p2fuWeek).
const TODAY = '2026-10-16';
const S = (d, kind, ref) => ({ kind: kind || 'custom', ref: ref || 'x', sent_at: d, note: '' });
eq('weekRange: Friday 16 Oct -> Sat 10 .. Fri 16', L.weekRange(TODAY), { start: '2026-10-10', end: '2026-10-16' });
eq('weekRange: Saturday starts a new week', L.weekRange('2026-10-17'), { start: '2026-10-17', end: '2026-10-23' });
eq('weekRange: month rollover (Sun 1 Nov 2026 -> Sat 31 Oct .. Fri 6 Nov)', L.weekRange('2026-11-01'), { start: '2026-10-31', end: '2026-11-06' });
{
  const env = load(path.join(dir, 'Code.gs'));
  let same = true, bad = '';
  for (let i = 0; i < 21; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
    const a = JSON.stringify(L.weekRange(d)), b = JSON.stringify(env.ctx._p2fuWeek(d));
    if (a !== b) { same = false; bad = d + ' ' + a + ' vs ' + b; }
  }
  t('weekRange agrees with the server _p2fuWeek on 21 consecutive days', same, bad);
}

let s = L.contactSummary([S('2026-10-09 23:59:59')], TODAY);
t('Friday 23:59 BEFORE the week start is not this week, but is this month', !s.contacted_week && s.contacted_month, s);
s = L.contactSummary([S('2026-10-10 00:00:00')], TODAY);
t('Saturday 00:00 is the first moment of the week', s.contacted_week && s.count_week === 1, s);
s = L.contactSummary([S('2026-10-16 23:59:59')], TODAY);
t('Friday 23:59 is the last moment of the week', s.contacted_week, s);
s = L.contactSummary([S('2026-10-17 00:00:01')], TODAY);
t('a (future) Saturday entry is not this week', !s.contacted_week, s);
// month boundary: today Sun 1 Nov. Sat 31 Oct is in the same WEEK but the previous MONTH.
s = L.contactSummary([S('2026-10-31 20:00:00')], '2026-11-01');
t('month boundary: 31 Oct is this week but NOT this month when today is 1 Nov', s.contacted_week === true && s.contacted_month === false, s);
s = L.contactSummary([S('2026-11-01 08:00:00'), S('2026-10-31 20:00:00')], '2026-11-01');
t('month boundary: 1 Nov entry counts for the month; counts are 2 week / 1 month', s.contacted_month && s.count_week === 2 && s.count_month === 1, s);
s = L.contactSummary([S('2026-10-14 18:30:00', 'quiz', 'a'), S('2026-10-15 09:00:00', 'homework', 'b'), S('2026-10-02 09:00:00', 'monthly', '2026-10')], TODAY);
t('last_sent_at / last_kind / last_ref come from the newest entry whatever the order', s.last_sent_at === '2026-10-15 09:00:00' && s.last_kind === 'homework' && s.last_ref === 'b' && s.count === 3, s);
eq('an explicit week from the server wins over the derived one', L.contactSummary([S('2026-10-01 10:00:00')], TODAY, { start: '2026-10-01', end: '2026-10-07' }).contacted_week, true);
s = L.contactSummary(undefined, TODAY);
t('no log -> nothing contacted, empty last_*', !s.contacted_week && !s.contacted_month && s.count === 0 && s.last_sent_at === '', s);
s = L.contactSummary([null, {}, { kind: 'x', sent_at: 'garbage' }, S('2026-10-12')], TODAY);
t('junk entries are ignored, a date-only sent_at works', s.count === 1 && s.contacted_week, s);

/* ---------------------------------------------------------- issue-relative state */
const HW = { kind: 'homework', ref: 'programming/x/lesson-1' }, QZ = { kind: 'quiz', ref: 'programming/x/lesson-1' };
const logHw = [{ kind: 'homework', ref: 'PROGRAMMING/x/Lesson-1', sent_at: '2026-10-14 10:00:00', note: '' }];
t('isLogged: case-insensitive on ref', L.isLogged(logHw, HW) === true);
t('isLogged: same lesson, other kind is NOT logged', L.isLogged(logHw, QZ) === false);
eq('unloggedIssues keeps only what has no entry', L.unloggedIssues([HW, QZ], logHw), [QZ]);
const sum0 = L.contactSummary([], TODAY), sumWk = L.contactSummary([S('2026-10-14 10:00:00')], TODAY);
eq('state: a due issue with no log -> pending', L.contactState([HW], [], sum0), 'pending');
eq('state: two issues, one logged -> still pending', L.contactState([HW, QZ], logHw, L.contactSummary(logHw, TODAY)), 'pending');
eq('state: all due issues logged -> contacted', L.contactState([HW], logHw, L.contactSummary(logHw, TODAY)), 'contacted');
eq('state: issue logged long ago (other week) still counts as contacted for THAT issue', L.contactState([HW], [{ kind: 'homework', ref: HW.ref, sent_at: '2026-08-01 10:00:00' }], sum0), 'contacted');
eq('state: nothing due, nobody contacted this week -> none', L.contactState([], [], sum0), 'none');
eq('state: nothing due, contacted this week -> contacted', L.contactState([], [S('2026-10-14 10:00:00')], sumWk), 'contacted');
eq('state: nothing due, contacted only last month -> none', L.contactState([], [S('2026-09-14 10:00:00')], L.contactSummary([S('2026-09-14 10:00:00')], TODAY)), 'none');
eq('state: an unrelated old entry does not clear a due issue', L.contactState([HW], [{ kind: 'homework', ref: 'other', sent_at: '2026-10-15 10:00:00' }], sumWk), 'pending');

/* ---------------------------------------------------------- sort + counts */
const it = (id, state, severity, name) => ({ id, state, severity, name });
eq('sort: not contacted first, then none, then contacted',
  L.contactSort([it('c', 'contacted', 0, 'C'), it('n', 'none', 0, 'N'), it('p', 'pending', 1, 'P')]), ['p', 'n', 'c']);
eq('sort: inside pending, more problems first', L.contactSort([it('a', 'pending', 1, 'A'), it('b', 'pending', 3, 'B'), it('c', 'pending', 2, 'C')]), ['b', 'c', 'a']);
eq('sort: equal severity -> by name', L.contactSort([it('z', 'pending', 1, 'Zed'), it('a', 'pending', 1, 'Amr')]), ['a', 'z']);
eq('sort: fully equal -> original order (stable)', L.contactSort([it('1', 'pending', 1, 'Same'), it('2', 'pending', 1, 'Same'), it('3', 'pending', 1, 'Same')]), ['1', '2', '3']);
eq('sort: unknown state is treated like none', L.contactSort([it('c', 'contacted', 0, 'C'), it('u', 'weird', 0, 'U'), it('p', 'pending', 0, 'P')]), ['p', 'u', 'c']);
eq('sort: empty / undefined', [L.contactSort([]), L.contactSort()], [[], []]);
{
  const input = [it('c', 'contacted', 0, 'C'), it('p', 'pending', 1, 'P')], before = JSON.stringify(input);
  L.contactSort(input); t('sort does not mutate its input', JSON.stringify(input) === before);
}
eq('counts: pending 3, contacted 1, none 1 -> total 4 (the "1 of 4")', L.contactCounts(['pending', 'contacted', 'pending', 'none', 'pending']), { pending: 3, contacted: 1, none: 1, total: 4 });
eq('counts: unknown strings are ignored', L.contactCounts(['x', 'pending']), { pending: 1, contacted: 0, none: 0, total: 1 });
eq('monthlySent: only kind monthly for that exact month', [L.monthlySent([{ kind: 'monthly', ref: '2026-10' }], '2026-10'), L.monthlySent([{ kind: 'monthly', ref: '2026-10' }], '2026-09'), L.monthlySent([{ kind: 'custom', ref: '2026-10' }], '2026-10'), L.monthlySent(undefined, '2026-10')], [true, false, false, false]);

/* ---------------------------------------------------------- flag notices (what the banner shows) */
eq('notices: both on -> none', L.flagNotices({ FF_PARENT_LOG: true, FF_MONTHLY: true }), []);
eq('notices: both off -> both named, with the property to set', L.flagNotices({ FF_PARENT_LOG: false, FF_MONTHLY: false }).map(n => n.property), ['FF_PARENT_LOG', 'FF_MONTHLY']);
eq('notices: only monthly off', L.flagNotices({ FF_PARENT_LOG: true, FF_MONTHLY: false }).map(n => n.flag), ['FF_MONTHLY']);
eq('notices: the live page never invents a notice when the server sent no flags', [L.flagNotices(undefined), L.flagNotices(null), L.flagNotices({})], [[], [], []]);
t('notices: each one has an Arabic feature name', L.flagNotices({ FF_PARENT_LOG: false, FF_MONTHLY: false }).every(n => /[\u0600-\u06FF]/.test(n.feature)));

/* ---------------------------------------------------------- the real fixture */
{
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'dashboard', '_fixtures', 'followup-overview.json'), 'utf8'));
  const sara = L.contactSummary(fx.parent_log['1012345002'], fx.today, { start: '2026-10-10', end: '2026-10-16' });
  t('fixture: Sara was contacted this week', sara.contacted_week && sara.last_kind === 'custom', sara);
  const adham = L.contactSummary(fx.parent_log['1112345006'], fx.today);
  t('fixture: Adham has only an old (September) contact', !adham.contacted_week && !adham.contacted_month && adham.count === 1, adham);
  t('fixture: Hana keeps the original 14/10 quiz entry', fx.parent_log['1012345005'].length === 1);
}

/* ---------------------------------------------------------- source guards */
{
  const app = fs.readFileSync(path.join(root, 'assets', 'followup-app.js'), 'utf8');
  const hits = app.split(/\r?\n/).filter(l => /FF_PARENT_LOG:\s*true/.test(l));
  t('the only hard-coded "flag: true" in the page is the MOCK overview (live path never assumes)', hits.length === 1 && /MOCK ONLY/.test(hits[0]) && /d\.flags = d\.flags \|\|/.test(hits[0]), hits);
  t('errText turns "Feature disabled: FF_X" into an instruction', /Feature disabled: \(FF_\[A-Z_\]\+\)/.test(app) && /Script Properties/.test(app));
  t('followup-app.js and followup-logic.js use consistent line endings (all CRLF or all LF, never mixed)', !(/\r\n/.test(app) && /[^\r]\n/.test(app)));
}

/* ---------------------------------------------------------- Phase3_Flags.gs against the real Code.gs */
{
  const CODE = path.join(dir, 'Code.gs');
  // Phase3_Flags.gs may sit next to Code.gs or in chunks/ (repo layout)
  const P3 = [path.join(dir, 'Phase3_Flags.gs'), path.join(dir, 'chunks', 'Phase3_Flags.gs')].find(f => fs.existsSync(f));
  const names = ['FF_PARENT_LOG', 'FF_MONTHLY', 'FF_DEFERRED_ANSWERS', 'FF_CAMERA', 'FF_GRADING'];
  const logs = [];
  let env = load(P3 ? [CODE, P3] : [CODE], { log: (...a) => logs.push(a.join(' ')) });
  eq('P3_FOLLOWUP_FLAGS is exactly the five Phase 2 flag names, unchanged', Array.from(env.ctx.P3_FOLLOWUP_FLAGS), names);
  let st = env.ctx.p3_flag_status();
  t('status: with nothing set every flag is OFF and raw is null', st.ok && names.every(n => st.flags[n].on === false && st.flags[n].raw === null), st);
  t('status: read-only (no property was written)', names.every(n => !(n in env.props)));
  t('status is logged, one line per flag', logs.filter(l => /^FF_/.test(l)).length === 5, logs);
  env.props.FF_CAMERA = 'true'; env.props.FF_GRADING = '0';
  st = env.ctx.p3_flag_status();
  t('status agrees with p2_flag for "true" / "0" / unset', names.every(n => st.flags[n].on === env.ctx.p2_flag(n)), st);

  env = load(P3 ? [CODE, P3] : [CODE], { log: (...a) => logs.push(a.join(' ')) });
  env.props.FF_MONTHLY = '1';
  const r = env.ctx.p3_setup_enable_followup_flags();
  t('setup: turns the four that were off to "1" and reports them', r.ok && JSON.stringify(Array.from(r.changed)) === JSON.stringify(['FF_PARENT_LOG', 'FF_DEFERRED_ANSWERS', 'FF_CAMERA', 'FF_GRADING']), r.changed);
  t('setup: all five are now on by the SAME rule the router uses (p2_flag), stored as "1"', names.every(n => env.ctx.p2_flag(n) === true && env.props[n] === '1'));
  t('setup: before/after are returned and logged', r.before.FF_PARENT_LOG.on === false && r.after.FF_PARENT_LOG.on === true && logs.some(l => /^BEFORE:/.test(l)) && logs.some(l => /^AFTER:/.test(l)));
  t('setup: repeats the FF_CAMERA rollout-checklist reminder', logs.some(l => /rollout-checklist/.test(l)));
  const sh = env.getSS('DATA').getSheetByName('AuditLog');
  t('setup: one AuditLog row (who "editor", action p3_enable_followup_flags, before and after as JSON)', r.audited === true && sh && sh.get(2, 2) === 'editor' && sh.get(2, 3) === 'p3_enable_followup_flags' && /"FF_CAMERA"/.test(sh.get(2, 5)) && /"on":true/.test(sh.get(2, 6)), sh && [sh.get(2, 2), sh.get(2, 3)]);
  const r2 = env.ctx.p3_setup_enable_followup_flags();
  t('setup: running it again changes nothing (idempotent)', r2.ok && r2.changed.length === 0);
  // the flag really unblocks the features
  env = load(P3 ? [CODE, P3] : [CODE]);
  let rr = env.post({ action: 'admin_log_parent_notification', token: 'tok', student: '01012345678', kind: 'custom', ref: 'a' });
  t('before setup the real router refuses with the contract shape {ok:false, disabled:true, "Feature disabled: FF_PARENT_LOG"}', rr.ok === false && rr.disabled === true && /Feature disabled: FF_PARENT_LOG/.test(rr.error), rr);
  env.ctx.p3_setup_enable_followup_flags();
  rr = env.post({ action: 'admin_log_parent_notification', token: 'tok', student: '01012345678', kind: 'custom', ref: 'a' });
  t('after setup the same call is accepted', rr.ok === true && rr.created === true, rr);
  rr = env.post({ action: 'admin_monthly_review', token: 'tok', month: '2026-10', group: 'nope' });
  t('after setup the monthly report is no longer "Feature disabled"', !rr.disabled && !/Feature disabled/.test(rr.error || ''), rr);

  env = load(P3 ? [CODE, P3] : [CODE]);
  let threw = ''; try { env.ctx.p3_admin_flag_status({}); } catch (e) { threw = e.message; }
  t('p3_admin_flag_status refuses a caller without admin rights (existing guard, any refusal message)', threw !== '', threw);
  t('p3_admin_flag_status with the admin token returns the status', env.ctx.p3_admin_flag_status({ token: 'tok' }).ok === true);
  t('Phase3_Flags.gs uses only p3_/_p3 names plus the P3_ constant (prefix rule)', Array.from(fs.readFileSync(P3 || path.join(dir, 'Code.gs'), 'utf8').matchAll(/^function (\w+)/gm)).filter(m => !!P3 || /p3/i.test(m[1])).every(m => /^_?p3_/i.test(m[1]) || /^_p3/.test(m[1])));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
