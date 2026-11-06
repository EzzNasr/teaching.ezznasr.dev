// The month's required lessons (Nov 2026) and the monthly mass send.
//  1. pure rules, client (RequirementsLogic) = server (Requirements.gs req_month_*): cleaning, general vs group, excluded parts
//  2. the page helpers (assets/followup-month.js): ticking, excluding homework / quiz, the send preview counts, the payloads
//  3. the server for real (Code.gs + FollowupRouter.gs + Requirements.gs): save / clear, who may, and the monthly review
//     counting exactly the ticked lessons (general list, a group's own list replacing it, homework / quiz switched off)
//  4. the WhatsApp outbox (FollowupWhatsApp.gs): a monthly batch is TEST unless "parents" is picked while live;
//     test rows still go to WA_TEST_TO while live; a live monthly success marks the month "sent" with its snapshot
// Usage: node tests/test_month_lessons.js [apps_script dir]
const path = require('path'), fs = require('fs'), vm = require('vm'), crypto = require('crypto');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const ROOT = path.join(__dirname, '..', '..', '..');
const { load } = require('./harness');
const RL = require(path.join(ROOT, 'assets', 'requirements-logic.js'));
const FM = require(path.join(ROOT, 'assets', 'followup-month.js'));
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const J = o => JSON.parse(JSON.stringify(o));
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const G2 = 'programming/baccalaureate/grade-2-secondary/';
const REV1 = G2 + 'chapter-1-lesson-2-how-ai-works', REV2 = G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry', CUR = G2 + 'chapter-2-lesson-1-networks';

// ============ 1. pure rules + parity ============
{
  const n = RL.normalizeMonthLessons([{ lesson: ' Programming/X/Lesson-1 ' }, { lesson: 'programming/x/lesson-1', quiz: false }, 'programming/x/lesson-2', { lesson: 'programming/x/lesson-3', homework: false }]);
  t('normalize: lower-case paths, one entry per lesson (the first wins), both parts on by default', n.ok && JSON.stringify(n.lessons) === JSON.stringify([
    { lesson: 'programming/x/lesson-1', homework: true, quiz: true }, { lesson: 'programming/x/lesson-2', homework: true, quiz: true }, { lesson: 'programming/x/lesson-3', homework: false, quiz: true }]), n);
  t('normalize: a non-boolean part is refused', RL.normalizeMonthLessons([{ lesson: 'a/b', quiz: 'no' }]).ok === false);
  t('normalize: a bad path is refused', RL.normalizeMonthLessons([{ lesson: '../x y' }]).ok === false && RL.normalizeMonthLessons([{ lesson: '' }]).ok === false);
  t('normalize: more than 60 lessons is refused', RL.normalizeMonthLessons(Array.from({ length: 61 }, (_, i) => 'p/l-' + i)).ok === false && RL.normalizeMonthLessons(Array.from({ length: 60 }, (_, i) => 'p/l-' + i)).ok);
  t('normalize: an empty list is valid (nothing required this month)', RL.normalizeMonthLessons([]).ok && RL.normalizeMonthLessons([]).lessons.length === 0);

  const GEN = { lessons: [{ lesson: 'a/1', homework: true, quiz: true }, { lesson: 'a/2', homework: true, quiz: false }] };
  const OWN = { lessons: [{ lesson: 'a/3', homework: false, quiz: true }] };
  const plans = { general: GEN, groups: { 'sat 6pm': OWN, 'empty group': { lessons: [] } } };
  let r = RL.resolveMonthLessons(plans, 'Mon 5pm');
  t('resolve: a group without its own list follows the general list', r.source === 'general' && r.lessons.length === 2 && r.lessons[1].quiz === false, r);
  r = RL.resolveMonthLessons(plans, '  SAT   6pm ');
  t('resolve: a group with its own list gets ONLY that list (it replaces the general one, not merged)', r.source === 'group' && r.lessons.length === 1 && r.lessons[0].lesson === 'a/3' && r.lessons[0].homework === false, r);
  r = RL.resolveMonthLessons(plans, 'Empty Group');
  t('resolve: a group\'s own EMPTY list still replaces the general one (nothing required for that group)', r.source === 'group' && r.lessons.length === 0, r);
  r = RL.resolveMonthLessons({ general: null, groups: { 'sat 6pm': OWN } }, 'Mon 5pm');
  t('resolve: no general list and no own list -> "none" (old weekly behaviour)', r.source === 'none' && r.lessons.length === 0, r);
  t('resolve: no group (unclassified student) -> general', RL.resolveMonthLessons(plans, '').source === 'general');
  t('resolve: nothing at all -> none', RL.resolveMonthLessons(null, 'x').source === 'none');
  const c = RL.monthLessonCounts(GEN.lessons);
  t('counts: 2 lessons, 2 homework, 1 quiz', c.lessons === 2 && c.homework === 2 && c.quiz === 1, c);

  // parity with Requirements.gs (a bare context; _groupKey comes from Code.gs, so it is given here exactly as Code.gs has it)
  const ctx = vm.createContext({});
  vm.runInContext('function _groupKey(name) { return String(name == null ? "" : name).trim().replace(/\\s+/g, " ").toLowerCase(); }', ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'Requirements.gs'), 'utf8'), ctx, { filename: 'Requirements.gs' });
  const LISTS = [undefined, null, [], 'x', [{ lesson: 'A/B' }, 'a/b', { lesson: 'a/c', homework: false, quiz: false }], [{ lesson: 'a b' }], [{ lesson: 'a/b', homework: 1 }], [5], Array.from({ length: 61 }, (_, i) => 'p/' + i)];
  LISTS.forEach((l, i) => { const a = J(ctx.req_month_normalize_(l)), b = J(RL.normalizeMonthLessons(l)); t('parity normalize #' + i, JSON.stringify(a) === JSON.stringify(b), { a, b }); });
  [plans, { general: null, groups: {} }, { general: GEN, groups: {} }, null, { groups: { 'sat 6pm': OWN } }].forEach((p, i) => {
    ['Sat 6pm', 'mon 5pm', '', 'empty group'].forEach(g => { const a = J(ctx.req_month_resolve_(p, g)), b = J(RL.resolveMonthLessons(p, g)); t('parity resolve #' + i + ' "' + g + '"', JSON.stringify(a) === JSON.stringify(b), { a, b }); });
  });
  t('parity: same cap', ctx.REQ_MAX_MONTH_LESSONS === RL.MAX_MONTH_LESSONS);
}

// ============ 2. page helpers ============
{
  let d = FM.draftFrom([]);
  d = FM.toggle(d, 'P/A/L1', true, { has_quiz: true, has_assignment: true });
  d = FM.toggle(d, 'p/a/l2', true, { has_quiz: false });            // a lesson with no quiz: ticked with the quiz off
  t('tick: homework and quiz both required', JSON.stringify(FM.entry(d, 'p/a/l1')) === JSON.stringify({ lesson: 'p/a/l1', homework: true, quiz: true }), d);
  t('tick: a lesson without a quiz starts with the quiz off', FM.entry(d, 'p/a/l2').quiz === false && FM.entry(d, 'p/a/l2').homework === true, d);
  const d2 = FM.setPart(d, 'p/a/l1', 'quiz', false);
  t('exclude the quiz only', FM.entry(d2, 'p/a/l1').quiz === false && FM.entry(d2, 'p/a/l1').homework === true && FM.entry(d, 'p/a/l1').quiz === true, d2);
  const d3 = FM.setPart(d2, 'p/a/l1', 'homework', false);
  t('exclude the homework too: the lesson stays ticked with nothing required', FM.isOn(d3, 'p/a/l1') && !FM.entry(d3, 'p/a/l1').homework && !FM.entry(d3, 'p/a/l1').quiz);
  t('untick removes it; ticking twice does not duplicate', !FM.isOn(FM.toggle(d, 'p/a/l1', false), 'p/a/l1') && FM.toggle(d, 'p/a/l1', true).length === 2);
  t('sameLessons ignores order, sees a changed part', FM.sameLessons(d, d.slice().reverse()) && !FM.sameLessons(d, d2));
  let thrown = false; try { FM.setPart(d, 'p/a/l1', 'watch', true); } catch (e) { thrown = true; }
  t('setPart only knows homework and quiz', thrown);
  const f = FM.byFolder([{ path: 'b/g2/l2' }, { path: 'b/g2/l1' }, { path: 'a/g1/l9' }, { path: 'b/g2/l1' }], '', null);
  t('byFolder: folders sorted, lessons sorted, no duplicates', JSON.stringify(f) === JSON.stringify([{ folder: 'a/g1', lessons: ['a/g1/l9'] }, { folder: 'b/g2', lessons: ['b/g2/l1', 'b/g2/l2'] }]), f);
  t('byFolder: the search matches path or label', FM.byFolder([{ path: 'b/g2/l1' }, { path: 'b/g2/l2' }], 'loops', p => p === 'b/g2/l2' ? 'Ch 2 · L2 — Loops' : 'x').map(x => x.lessons).join() === 'b/g2/l2');

  const R = (ph, name, o) => Object.assign({ student: { phone: ph, name, parent_phone: '' }, group: { group: 'Sat 6pm', key: 'sat 6pm' }, summary: { totals: { quiz_missed: 0, homework_missed: 0 } } }, o || {});
  const revs = [
    R('01000000001', 'A'),                                                              // ready, complete
    R('01000000002', 'B', { summary: { totals: { quiz_missed: 1, homework_missed: 1 } } }),   // ready, missing
    R('01000000003', 'C'),                                                              // no parent number
    R('01000000004', 'D'),                                                              // parent number needs checking
    R('01000000005', 'E'),                                                              // already sent
    R('01000000006', 'F'),                                                              // empty text
    R('01000000001', 'A again', { group: { group: 'Mon 5pm', key: 'mon 5pm' } }),         // the same student in a 2nd group
  ];
  const P = FM.sendPlan(revs, {
    contacted: r => r.student.name === 'E',
    check: r => r.student.name === 'C' ? { level: 'missing', wa: '' } : r.student.name === 'D' ? { level: 'warn', wa: '201000' } : { level: 'ok', wa: '2011' + r.student.phone.slice(-8) },
    text: r => r.student.name === 'F' ? '  ' : 'report ' + r.student.name,
  });
  t('preview counts: 6 students (the duplicate once), 2 ready (1 complete, 1 missing), 3 held, 1 already sent',
    JSON.stringify(P.counts) === JSON.stringify({ students: 6, ready: 2, complete: 1, missing: 1, held: 3, already: 1 }), P.counts);
  t('held reasons are plain words', P.held.map(h => h.reason).join('|') === [FM.REASONS.missing, FM.REASONS.warn, FM.REASONS.text].join('|'), P.held.map(h => h.reason));
  const pl = FM.enqueuePayloads(P.ready, '2026-11');
  t('payloads: one per group, event monthly, send_to TEST by default, log item monthly/<month>', pl.length === 1 && pl[0].event === 'monthly' && pl[0].send_to === 'test' &&
    pl[0].items.length === 2 && JSON.stringify(pl[0].items[0].log_items) === JSON.stringify([{ kind: 'monthly', ref: '2026-11' }]) && pl[0].items[0].to === '201100000001', pl);
  t('payloads: "parents" only when asked for', FM.enqueuePayloads(P.ready, '2026-11', 'parents')[0].send_to === 'parents' && FM.enqueuePayloads(P.ready, '2026-11', 'anything')[0].send_to === 'test');
}

// ============ 3. the server ============
const cairoYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function boot(extraFiles, props, now) {
  const files = [path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs'), path.join(dir, 'Requirements.gs')].concat(extraFiles || []);
  const env = load(files, { clock: true, props: Object.assign({ FF_PARENT_LOG: 'TRUE', FF_MONTHLY: 'TRUE' }, props || {}) });
  if (now) env.setNow(now);
  env.ctx.UrlFetchApp = { fetch() { return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' }; } };   // Telegram: no network
  const { post, getSS } = env;
  const today = now ? cairoYmd(new Date(now)) : cairoYmd(new Date()), month = today.slice(0, 7);
  const reg = (phone, name) => post({ action: 'register_student', phone, password_hash: H(name), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
  reg('01000000001', 'Teacher'); const stu = getSS('STU').getSheetByName('Students'); let col = 0; for (let c = 1; c <= 16; c++) if (stu.get(1, c) === 'is_admin') col = c; stu.set(2, col, true);
  const creds = {};
  ['Sara', 'Omar', 'Nour', 'Kid'].forEach((n, i) => { const r = reg('0100000000' + (i + 2), n); creds[n.toLowerCase()] = { student_id: r.student_id, session_token: r.session_token }; });
  const TOK = { token: 'tok' };
  const P = { sara: '01000000002', omar: '01000000003', nour: '01000000004', kid: '01000000005' };
  ['sara', 'omar'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: P[k] }, TOK)));
  post(Object.assign({ action: 'admin_group_add', group: 'Mon 5pm', phone: P.nour }, TOK));
  post(Object.assign({ action: 'admin_followup_save_group', group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV1, REV2], hw_deadline_override: '2020-01-01' }, TOK));
  post(Object.assign({ action: 'admin_followup_save_group', group: 'Mon 5pm', weekday: 1, time: '17:00', current_lesson: CUR, review_lessons: [REV1], hw_deadline_override: '2020-01-01' }, TOK));
  const quiz = (who, slug, id) => post({ action: 'upload_quiz_result', student_id: P[who], name: who, subject: 'programming', lesson: slug, quiz_title: 'Q', start_time: today + 'T10:00:00Z', end_time: today + 'T10:05:00Z', score: 8, total: 10, questions: [], client_id: id });
  const hw = (who, slug, id) => post({ action: 'upload_submission', student_id: P[who], name: who, subject: 'programming', lesson: slug, submission_type: 'text', text: 'ans ' + id, submitted_time: today + 'T10:00:00Z', client_id: id });
  // Sara: quiz + homework on REV1; homework on CUR. Nour: quiz on REV1.
  quiz('sara', 'lesson-2-how-ai-works', 'q1'); hw('sara', 'lesson-2-how-ai-works', 'h1'); hw('sara', 'chapter-2-lesson-1-networks', 'h2'); quiz('nour', 'lesson-2-how-ai-works', 'q2');
  const save = (o, who) => post(Object.assign({ action: 'admin_req_month_save', month }, o, who || TOK));
  const get = (o, who) => post(Object.assign({ action: 'admin_req_month_get', month }, o || {}, who || TOK));
  const review = (group, m) => post(Object.assign({ action: 'admin_monthly_review', month: m || month, group }, TOK));
  const of = (rv, who) => rv.reviews.filter(r => r.student.phone === P[who])[0].summary;
  const exp = s => Object.fromEntries(s.expected.map(e => [e.lesson, [e.homework.required, e.quiz.required, e.homework.missed, e.quiz.missed].map(Number).join('')]).sort((a, b) => a[0] < b[0] ? -1 : 1));
  return Object.assign(env, { TOK, P, creds, today, month, save, get, review, of, exp });
}

{
  const E = boot();
  const { P, creds, month, save, get, review, of, exp, getSS, ctx } = E;
  ctx.p3_admin_set_role(Object.assign({ phone: P.omar, role: 'assistant' }, E.TOK));
  let s = of(review('Sat 6pm'), 'sara');
  t('no list for the month: month_plan "none", the weekly review lessons as before (REV1 + REV2)', s.month_plan && s.month_plan.source === 'none' && Object.keys(exp(s)).sort().join() === [REV1, REV2].sort().join() && s.totals.homework_required === 2, { mp: s.month_plan, e: exp(s) });
  t('a read never creates the MonthLessons tab', get().ok && !getSS('DATA').getSheetByName('MonthLessons'));

  // general list: REV1 (both), CUR (homework only)
  let r = save({ lessons: [{ lesson: REV1 }, { lesson: CUR, quiz: false }] });
  t('save the general list', r.ok && r.general && r.general.lessons.length === 2 && getSS('DATA').getSheetByName('MonthLessons'), r);
  s = of(review('Sat 6pm'), 'sara');
  // exp code: homework required, quiz required, homework missed, quiz missed
  t('Sat 6pm follows the general list: exactly REV1 + CUR (REV2 is no longer expected)', s.month_plan.source === 'general' && JSON.stringify(exp(s)) === JSON.stringify({ [REV1]: '1100', [CUR]: '1000' }), { mp: s.month_plan, e: exp(s) });
  t('excluded quiz is not required and not counted: homework 2 required / 0 missed, quiz 1 required / 0 missed', s.totals.homework_required === 2 && s.totals.homework_missed === 0 && s.totals.quiz_required === 1 && s.totals.quiz_missed === 0, s.totals);
  const omar = of(review('Sat 6pm'), 'omar');
  t('Omar (nothing done) misses 2 homework + 1 quiz', omar.totals.homework_missed === 2 && omar.totals.quiz_missed === 1, omar.totals);
  const nour = of(review('Mon 5pm'), 'nour');
  t('Mon 5pm also follows the general list', nour.month_plan.source === 'general' && JSON.stringify(exp(nour)) === JSON.stringify({ [REV1]: '1110', [CUR]: '1010' }), exp(nour));
  t('summary.requirements uses the same lessons (homework 2 expected for Sara, 2 met)', (() => { const h = s.requirements.items.filter(i => i.key === 'homework')[0]; return h.expected === 2 && h.met === 2; })(), s.requirements);

  // Sat 6pm gets its own list: REV2 quiz only
  r = save({ group: 'sat 6PM', lessons: [{ lesson: REV2, homework: false }] });
  t('save a list for one group', r.ok && r.groups['sat 6pm'] && r.groups['sat 6pm'].lessons[0].homework === false, r);
  s = of(review('Sat 6pm'), 'sara');
  t('Sat 6pm now uses ONLY its own list (the general REV1 / CUR are gone)', s.month_plan.source === 'group' && JSON.stringify(exp(s)) === JSON.stringify({ [REV2]: '0101' }), { mp: s.month_plan, e: exp(s) });
  t('excluded homework: 0 homework required, the quiz is required and missed', s.totals.homework_required === 0 && s.totals.quiz_required === 1 && s.totals.quiz_missed === 1, s.totals);
  t('Mon 5pm is not touched by the Sat 6pm list', of(review('Mon 5pm'), 'nour').month_plan.source === 'general');
  const g = get();
  t('get: effective per group says who follows what', g.ok && g.effective['sat 6pm'].source === 'group' && g.effective['mon 5pm'].source === 'general' && g.general.lessons.length === 2 && g.group_names['sat 6pm'] === 'Sat 6pm', g);
  t('another month is untouched (none)', of(review('Sat 6pm', '2025-01'), 'sara').month_plan.source === 'none');

  // saving the same list again changes nothing in the audit; clearing goes back to general
  const audits = () => { const sh = getSS('DATA').getSheetByName('AuditLog'); let n = 0; for (let i = 2; i <= sh.getLastRow(); i++) if (sh.get(i, 3) === 'req_month_save') n++; return n; };
  const a0 = audits();
  save({ group: 'Sat 6pm', lessons: [{ lesson: REV2, homework: false }] });
  t('saving the same list again writes no audit row', audits() === a0, a0 + ' -> ' + audits());
  r = save({ group: 'Sat 6pm', clear: true });
  t('clear a group\'s list -> it follows the general list again', r.ok && !r.groups['sat 6pm'] && of(review('Sat 6pm'), 'sara').month_plan.source === 'general', r);
  t('one MonthLessons row left (the general one)', getSS('DATA').getSheetByName('MonthLessons').getLastRow() === 2);
  const h = E.post(Object.assign({ action: 'admin_req_history' }, E.TOK));
  t('history shows the month-lessons changes in plain words', h.ok && h.items.some(i => /^month lessons \d{4}-\d{2}\|sat 6pm: 1 lessons -> removed$/.test(i.what)) && h.items.some(i => /\|general: 2 lessons$/.test(i.what)), h.items.map(i => i.what));
  // an empty own list = nothing required for that group
  save({ group: 'Mon 5pm', lessons: [] });
  const n2 = of(review('Mon 5pm'), 'nour');
  t('a group\'s empty list: nothing expected, nothing missed', n2.month_plan.source === 'group' && n2.expected.length === 0 && n2.totals.homework_missed === 0 && n2.totals.quiz_missed === 0, n2.expected);

  // validation and who may
  t('bad month refused', /yyyy-MM/.test(save({ month: '2026-13', lessons: [] }).error || ''));
  t('unknown group refused', /Unknown group/.test(save({ group: 'Nope', lessons: [] }).error || ''));
  t('bad lesson refused', /valid lesson path/.test(save({ lessons: [{ lesson: 'no spaces allowed' }] }).error || ''));
  t('bad part refused', /homework must be/.test(save({ lessons: [{ lesson: REV1, homework: 'yes' }] }).error || ''));
  t('a student cannot read or save', /Not authorized/.test(E.post(Object.assign({ action: 'admin_req_month_get', month }, creds.kid)).error || '') && /Not authorized/.test(save({ lessons: [] }, creds.kid).error || ''));
  const asst = save({ lessons: [{ lesson: CUR }] }, creds.omar);
  t('the owner\'s assistant may save (same as the other requirement settings)', asst.ok, asst);
  t('the month lesson list must not be readable without a session', E.post({ action: 'admin_req_month_get', month }).ok === false);

  // marking the month sent keeps a snapshot computed with the list (homework expected = the general CUR only)
  const mk = E.post(Object.assign({ action: 'admin_monthly_review', op: 'mark', month, student: P.sara, group: 'Sat 6pm', status: 'sent' }, E.TOK));
  const sn = of(review('Sat 6pm'), 'sara');
  t('a sent month keeps its snapshot, made from the month\'s list', mk.ok && sn.requirements_snapshot === true && sn.requirements.items.filter(i => i.key === 'homework')[0].expected === 1, sn.requirements);
}

// ============ 4. WhatsApp: the monthly batch defaults to TEST ============
function waEnv(mode) {
  const E = boot([path.join(dir, 'FollowupWhatsApp.gs')], { WA_TEST_TO: '201000000099', TELEGRAM_BOT_TOKEN: 'BOT', TELEGRAM_ADMIN_CHAT_ID: '111' }, '2026-11-07T12:00:00+02:00');
  E.ctx.fu2_wa_setup();
  E.props.WA_MODE = mode;
  E.WT = E.props.WA_SENDER_TOKEN;
  E.enq = (o) => E.post(Object.assign({ action: 'admin_fu2_wa_enqueue', token: 'tok', event: 'monthly', group: 'Sat 6pm', group_key: 'sat 6pm',
    items: [{ student_key: '1000000002', student_phone: E.P.sara, name: 'Sara', to: '201100000009', text: 'تقرير نوفمبر', log_items: [{ kind: 'monthly', ref: '2026-11' }] }] }, o || {}));
  E.claim = () => E.post({ action: 'admin_fu2_wa_claim', wa_token: E.WT });
  E.report = (id) => E.post({ action: 'admin_fu2_wa_report', wa_token: E.WT, results: [{ id, ok: true, wa_id: 'w1' }] });
  E.monthRow = () => E.ctx._p2fuRows(E.getSS('STU').getSheetByName('MonthlyReviews')).filter(m => String(m.month) === '2026-11')[0] || null;
  E.notifs = () => E.ctx._p2fuNotifications(E.getSS('STU')).filter(n => n.kind === 'monthly');
  return E;
}
{
  const E = waEnv('live');
  let q = E.enq();
  t('live phone, monthly batch with no send_to -> queued as TEST', q.ok && q.mode === 'test' && q.queued === 1, q);
  let c = E.claim();
  t('live phone hands out the test row, to MY number with the [TEST] header', c.ok && c.items.length === 1 && c.items[0].to === '201000000099' && /^\[TEST\] → Sara · 201100000009/.test(c.items[0].text), c);
  E.report(c.items[0].id);
  t('a test success logs nothing and does not mark the month', E.notifs().length === 0 && !E.monthRow(), { n: E.notifs(), m: E.monthRow() });
  t('the same test can be sent again (a sent test does not block)', E.enq().queued === 1);
  E.claim();   // hand the second test out so it does not sit in front of the next case
  q = E.enq({ send_to: 'parents' });
  t('live + "parents" -> queued live', q.ok && q.mode === 'live' && q.queued === 1, q);
  c = E.claim();
  t('the live row goes to the parent', c.items.length === 1 && c.items[0].to === '201100000009' && !/TEST/.test(c.items[0].text), c);
  E.report(c.items[0].id);
  const m = E.monthRow();
  t('a live monthly success marks the month "sent" and writes the contact log once', m && m.status === 'sent' && E.notifs().length === 1 && /WhatsApp \(phone\)/.test(String(m.note)), { m, n: E.notifs() });
  t('...with the requirements snapshot', m && String(m.requirements_json || '').indexOf('"items"') >= 0, m && m.requirements_json);
  t('a second live send of the same month is skipped (already sent / contacted)', E.enq({ send_to: 'parents' }).queued === 0);
  t('send_to must be test or parents', /send_to/.test(E.enq({ send_to: 'everyone' }).error || ''));
  const other = E.post({ action: 'admin_fu2_wa_enqueue', token: 'tok', event: 'parents_hw', group: 'Sat 6pm', group_key: 'sat 6pm',
    items: [{ student_key: '1000000003', student_phone: E.P.omar, name: 'Omar', to: '201100000008', text: 'hw', log_items: [{ kind: 'homework', ref: REV1 }] }] });
  t('other events keep the phone\'s mode (live) when send_to is not given', other.ok && other.mode === 'live', other);
}
{
  const E = waEnv('test');
  const q = E.enq({ send_to: 'parents' });
  t('test phone: even "parents" stays test', q.ok && q.mode === 'test', q);
  const c = E.claim();
  t('test phone: the row goes to my number', c.items.length === 1 && c.items[0].to === '201000000099', c);
}
{
  const E = waEnv('live');
  delete E.props.WA_TEST_TO;
  t('live phone without WA_TEST_TO: a monthly TEST batch is refused (it would have nowhere to go)', /WA_TEST_TO/.test(E.enq().error || ''));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
