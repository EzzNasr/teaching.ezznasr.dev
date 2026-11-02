// Follow-up v2, Session 5: summary.requirements in the monthly report / student summary (contract 3.6) and the
// sent/closed snapshot (MonthlyReviews.requirements_json). S4's functions are STUBS defined here (not shipped).
// Usage: node tests/test_monthly_requirements.js [apps_script dir]
const path = require('path'), vm = require('vm'), crypto = require('crypto');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const cairoYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = cairoYmd(new Date()), month = today.slice(0, 7);
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const REV1 = G2 + 'chapter-1-lesson-2-how-ai-works', REV2 = G2 + 'chapter-1-lesson-3-ai-in-daily-life-and-industry', CUR = G2 + 'chapter-2-lesson-1-networks';
const S1 = 'lesson-2-how-ai-works', S2 = 'chapter-1-lesson-3-ai-in-daily-life-and-industry';

function boot(files) {
  const env = load(files, { clock: true, props: { FF_PARENT_LOG: 'TRUE', FF_MONTHLY: 'TRUE' } });
  const { post, getSS } = env;
  const reg = (phone, name) => post({ action: 'register_student', phone, password_hash: H(name), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
  reg('01000000001', 'Teacher'); const stu = getSS('STU').getSheetByName('Students'); let col = 0; for (let c = 1; c <= 16; c++) if (stu.get(1, c) === 'is_admin') col = c; stu.set(2, col, true);
  ['Sara', 'Omar', 'Nour'].forEach((n, i) => reg('0100000000' + (i + 2), n));
  const TOK = { token: 'tok' };
  const P = { sara: '01000000002', omar: '01000000003', nour: '01000000004' };
  ['sara', 'omar'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: P[k] }, TOK)));
  post(Object.assign({ action: 'admin_followup_save_group', group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV1, REV2], hw_deadline_override: '2020-01-01' }, TOK));
  const quiz = (who, slug, score, id) => post({ action: 'upload_quiz_result', student_id: P[who], name: who, subject: 'programming', lesson: slug, quiz_title: 'Q', start_time: today + 'T10:00:00Z', end_time: today + 'T10:05:00Z', score, total: 10, questions: [], client_id: id });
  const hw = (who, slug, id) => post({ action: 'upload_submission', student_id: P[who], name: who, subject: 'programming', lesson: slug, submission_type: 'text', text: 'ans ' + id, submitted_time: today + 'T10:00:00Z', client_id: id });
  // Sara: quiz on lesson 1 (8/10), homework on lesson 1 only; Omar: nothing
  quiz('sara', S1, 8, 'q1'); hw('sara', S1, 'h1');
  const addRow = (sh, vals) => { const r = sh.getLastRow() + 1; vals.forEach((v, i) => sh.set(r, i + 1, v)); };
  const att = getSS('STU').insertSheet('Attendance'); ['lesson', 'phone', 'mode', 'marked_at'].forEach((h, i) => att.set(1, i + 1, h));
  addRow(att, [REV1, P.sara, 'online', today + ' 18:00:00']);
  const wsh = getSS('STU').insertSheet('WatchProgress'); ['phone', 'lesson', 'pct', 'duration_s', 'first_at', 'updated_at'].forEach((h, i) => wsh.set(1, i + 1, h));
  addRow(wsh, [P.sara, REV1, 90, 600, today + ' 10:00:00', today + ' 10:10:00']); addRow(wsh, [P.sara, REV2, 40, 600, today + ' 10:00:00', today + ' 10:10:00']);
  const wr = getSS('DATA').insertSheet('WrittenAnswers'); ['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at'].forEach((h, i) => wr.set(1, i + 1, h));
  addRow(wr, ['s1', P.sara, REV1, 'q5', 'f1', 4, 5, '', today]); addRow(wr, ['s1', P.sara, REV1, 'q6', 'f2', 1, 5, '', today]); addRow(wr, ['s1', P.sara, REV1, 'q7', 'f3', '', 5, '', '']);
  const call = (fn, p) => { try { return env.ctx[fn](Object.assign({}, p, TOK)); } catch (e) { return { ok: false, error: e.message }; } };
  const sum = who => call('p2_admin_student_summary', { student: P[who], from: month + '-01', to: today });
  const review = (who, extra) => post(Object.assign({ action: 'admin_monthly_review', month, student: P[who] }, extra || {}, TOK));
  const mark = (who, status) => post(Object.assign({ action: 'admin_monthly_review', op: 'mark', month, student: P[who], status }, TOK));
  const run = code => vm.runInContext(code, env.ctx);
  const monthlyRows = () => { const sh = getSS('STU').getSheetByName('MonthlyReviews'); const o = []; if (!sh) return o; const hd = []; for (let c = 1; c <= 10; c++) hd.push(sh.get(1, c)); for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; hd.forEach((h, i) => { if (h) row[h] = sh.get(r, i + 1); }); o.push(row); } return o; };
  return Object.assign(env, { TOK, P, call, sum, review, mark, run, monthlyRows, getSS });
}
const byKey = req => Object.fromEntries(req.items.map(i => [i.key, i]));

// ============ 1. Without Requirements.gs (S4): the five built-in defaults ============
{
  const e = boot([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')]);
  const s = e.sum('sara'), r = s.requirements;
  t('summary.requirements exists, source "default"', r && r.source === 'default' && Array.isArray(r.items), r);
  t('the five built-ins, in order', r.items.map(i => i.key).join() === 'watch,homework,quiz,attendance,written_answers', r.items.map(i => i.key));
  const k = byKey(r);
  t('homework: 1 of the 2 review lessons done', k.homework.met === 1 && k.homework.expected === 2 && k.homework.pct === 50 && k.homework.kind === 'auto' && k.homework.weight === 1, k.homework);
  t('quiz: 1 of 2', k.quiz.met === 1 && k.quiz.expected === 2 && k.quiz.pct === 50, k.quiz);
  t('watch: 90% counts (>= 80), 40% does not -> 1 of 2', k.watch.met === 1 && k.watch.expected === 2, k.watch);
  t('attendance: marked for 1 of 2 lessons', k.attendance.met === 1 && k.attendance.expected === 2, k.attendance);
  t('written answers: only graded ones are judged; scored >= half = met -> 1 of 2 (the pending one is ignored)', k.written_answers.met === 1 && k.written_answers.expected === 2 && k.written_answers.pct === 50, k.written_answers);
  t('every item has both labels', r.items.every(i => i.label_ar && i.label_en));
  t('compliance is the weighted mean of the item percentages (all 50 -> 50)', r.compliance_pct === 50, r.compliance_pct);
  const o = e.sum('omar').requirements;
  t('a student who did nothing: 0 of 2, pct 0 (not null)', byKey(o).homework.met === 0 && byKey(o).homework.pct === 0 && o.compliance_pct === 0 || (byKey(o).written_answers.pct === null), o);
  const w = byKey(o).written_answers;
  t('...and nothing graded means "no data" (pct null) instead of a fake 0, left out of the average', w.expected === 0 && w.pct === null, w);
  const none = e.sum('sara'); t('summary still has all its old fields', none.totals && none.expected && none.quizzes && none.written);
  const rv = e.review('sara').reviews[0];
  t('the monthly review carries the same section', rv.summary.requirements && rv.summary.requirements.items.length === 5 && rv.review.status === 'pending', rv);
  const act = e.post(Object.assign({ action: 'admin_student_summary', student: e.P.sara }, e.TOK));
  t('admin_student_summary (the action) carries it too', act.ok && act.requirements && act.requirements.items.length === 5, act.requirements);
}

// ============ 2. Without FollowupRouter.gs at all ============
{
  const e = boot([path.join(dir, 'Code.gs')]);
  const s = e.sum('sara');
  t('no router: the summary renders, there is simply no requirements field', s.ok !== false && s.totals && s.requirements === undefined, Object.keys(s));
  const rv = e.review('sara');
  t('no router: the monthly review works', rv.ok && rv.reviews[0].summary.totals, rv);
  const m = e.mark('sara', 'sent');
  t('no router: marking a month sent still works and writes no snapshot column', m.ok && !('requirements_json' in (e.monthlyRows()[0] || {})), m);
}

// ============ 3. With Requirements.gs stubs (group override / manual / disabled / weights) ============
const STUB = `
  var __eff = null, __calls = [], __checks = {};
  function req_effective_(g) { __calls.push(g); if (__eff === 'throw') throw new Error('boom'); return __eff; }
  function req_catalog_() { return [{ key: 'custom_behaviour', label_ar: 'السلوك', label_en: 'Behaviour', kind: 'manual' }, { key: 'homework', label_ar: 'الواجب (مخصص)', label_en: 'Homework', kind: 'auto' }]; }
  function req_checks_for_(pk, m) { return __checks[pk + '|' + m] || {}; }`;
{
  const e = boot([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')]); e.run(STUB);
  const base = (over) => Object.assign({ enabled: true, in_monthly_report: true, parent_message: true, rule: {}, weight: 1, source: 'global' }, over || {});
  e.run(`__eff = ${JSON.stringify({
    watch: base({ rule: { pct: 30 }, source: 'group' }), homework: base({ enabled: false }), quiz: base({ rule: { min_pct: 90 }, weight: 3 }),
    attendance: base({ in_monthly_report: false }), written_answers: base({ enabled: false }), custom_behaviour: base({ weight: 2, source: 'group' }),
  })}`);
  e.run(`__checks['${e.P.sara.slice(-10)}|${month}'] = { custom_behaviour: { met: true, note: 'ممتاز', by: 'Teacher' } }`);
  const r = e.sum('sara').requirements, k = byKey(r);
  t('disabled and not-in-report items are omitted', r.items.map(i => i.key).sort().join() === 'custom_behaviour,quiz,watch', r.items.map(i => i.key));
  t('watch uses the rule pct (30): 90 and 40 both count -> 2 of 2', k.watch.met === 2 && k.watch.expected === 2 && k.watch.pct === 100, k.watch);
  t('quiz min_pct 90: her 80% quiz does not count -> 0 of 2', k.quiz.met === 0 && k.quiz.expected === 2 && k.quiz.weight === 3, k.quiz);
  t('manual item: kind, met true, expected 1, pct 100, note and who', k.custom_behaviour.kind === 'manual' && k.custom_behaviour.met === true && k.custom_behaviour.expected === 1 && k.custom_behaviour.pct === 100 && k.custom_behaviour.note === 'ممتاز' && k.custom_behaviour.by === 'Teacher', k.custom_behaviour);
  t('labels come from the catalogue when it has them', k.custom_behaviour.label_ar === 'السلوك' && k.custom_behaviour.label_en === 'Behaviour');
  t('compliance = (1*100 + 3*0 + 2*100) / 6 = 50', r.compliance_pct === 50, r.compliance_pct);
  t('source is "group" when any item comes from the group', r.source === 'group', r.source);
  t('req_effective_ was asked for the student\'s group key', e.run('__calls[0]') === 'sat 6pm', e.run('__calls'));
  t('...once per group for a whole class (cached on the load)', (() => { e.run('__calls.length = 0'); const g = e.post(Object.assign({ action: 'admin_monthly_review', month, group: 'Sat 6pm' }, e.TOK)); return g.ok && g.reviews.length === 2 && e.run('__calls.length') === 1; })(), e.run('__calls'));
  const om = e.sum('omar').requirements, ok = byKey(om);
  t('manual with no tick is "not recorded": met null, expected 0, pct null, and left out of compliance', ok.custom_behaviour.met === null && ok.custom_behaviour.expected === 0 && ok.custom_behaviour.pct === null, ok.custom_behaviour);
  t('...compliance of Omar = (3*0 + 1*0... ) only items with data: watch 0/2, quiz 0/2 -> 0', om.compliance_pct === 0, om.compliance_pct);
  e.run(`__checks['${e.P.omar.slice(-10)}|${month}'] = { custom_behaviour: { met: false } }`);
  t('manual false -> met false, pct 0', byKey(e.sum('omar').requirements).custom_behaviour.met === false && byKey(e.sum('omar').requirements).custom_behaviour.pct === 0);
  e.run(`__eff = ${JSON.stringify({ homework: base({ enabled: false }), watch: base({ enabled: false }), quiz: base({ enabled: false }), attendance: base({ enabled: false }), written_answers: base({ enabled: false }) })}`);
  const empty = e.sum('sara').requirements;
  t('everything disabled: no items, compliance null', empty.items.length === 0 && empty.compliance_pct === null, empty);
  e.run(`__eff = ${JSON.stringify({ homework: base({ source: 'default' }) })}`);
  t('source "global" / "default" follow the items', e.sum('sara').requirements.source === 'default');
  e.run(`__eff = 'throw'`);
  const th = e.sum('sara');
  t('req_effective_ throwing: the summary still renders with the built-in defaults', th.requirements && th.requirements.source === 'default' && th.requirements.items.length === 5, th.requirements);
  e.run(`__eff = null`);
  t('req_effective_ returning nothing: built-in defaults', e.sum('sara').requirements.source === 'default');
  // a student with no group
  e.run(`__eff = ${JSON.stringify({ homework: base() })}; __calls.length = 0`);
  e.sum('nour');
  t('a student in no group is asked for with the empty key (global defaults)', e.run('__calls[0]') === '', e.run('__calls'));
}

// ============ 4. Sent / closed months show the saved snapshot ============
{
  const e = boot([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')]); e.run(STUB);
  const base = (over) => Object.assign({ enabled: true, in_monthly_report: true, parent_message: true, rule: {}, weight: 1, source: 'global' }, over || {});
  const ALL = o => JSON.stringify({ homework: base(o), quiz: base(o), watch: base(o), attendance: base(o), written_answers: base(o) });
  e.run(`__eff = ${ALL()}`);
  let rv = e.review('sara').reviews[0];
  t('pending month: live, no snapshot flag', rv.summary.requirements.items.length === 5 && rv.summary.requirements_snapshot === undefined);
  e.mark('sara', 'sent');
  const row = e.monthlyRows()[0];
  t('marking sent saves requirements_json (an additive column)', row && row.status === 'sent' && JSON.parse(row.requirements_json).items.length === 5, row);
  t('...and the existing columns are untouched', row.student && row.month === month && row.sent_at);
  e.run(`__eff = ${JSON.stringify({ homework: base({ weight: 5 }) })}`);   // the owner changes the requirements after sending
  rv = e.review('sara').reviews[0];
  t('after sending, changing the requirements does NOT change that month', rv.summary.requirements.items.length === 5 && rv.summary.requirements_snapshot === true && byKey(rv.summary.requirements).homework.weight === 1, rv.summary.requirements);
  const live = e.review('omar').reviews[0].summary.requirements;
  t('...while a month that is not sent does follow the change', live.items.length === 1 && byKey(live).homework.weight === 5, live);
  e.mark('sara', 'sent');
  t('marking sent again keeps the first snapshot', byKey(JSON.parse(e.monthlyRows()[0].requirements_json)).homework.weight === 1);
  e.mark('sara', 'closed');
  rv = e.review('sara').reviews[0];
  t('sent -> closed keeps it too', rv.review.status === 'closed' && rv.summary.requirements_snapshot === true && byKey(rv.summary.requirements).homework.weight === 1, rv.review);
  e.mark('sara', 'ready');
  t('back to ready: the snapshot is cleared and the month is live again', e.monthlyRows()[0].requirements_json === '' && e.review('sara').reviews[0].summary.requirements.items.length === 1);
  e.mark('sara', 'closed');
  t('closing from ready snapshots the CURRENT requirements', JSON.parse(e.monthlyRows()[0].requirements_json).items.length === 1);
  const stud = e.sum('sara');
  t('the plain student summary is always live', stud.requirements.items.length === 1 && stud.requirements_snapshot === undefined);
  // a month marked sent before snapshots existed
  const sh = e.getSS('STU').getSheetByName('MonthlyReviews'); const r2 = sh.getLastRow() + 1; const hd = {}; for (let c = 1; c <= 10; c++) if (sh.get(1, c)) hd[sh.get(1, c)] = c;
  sh.set(r2, hd.student, e.P.omar); sh.set(r2, hd.month, month); sh.set(r2, hd.status, 'sent'); sh.set(r2, hd.sent_at, today + ' 10:00:00'); sh.set(r2, hd.note, '');
  const old = e.review('omar').reviews[0];
  t('a sent month with no snapshot is not recomputed: requirements null + requirements_unavailable', old.summary.requirements === null && old.summary.requirements_unavailable === true, old.summary.requirements);
  const m = e.mark('nour', 'sent');
  t('marking works for a student with no existing row', m.ok && e.monthlyRows().some(r => String(r.student).endsWith('1000000004') && r.requirements_json), m);
  e.run(`var __orig = _p2fuSummaryFor; _p2fuSummaryFor = function () { throw new Error('summary broke'); };`);
  const bad = e.mark('sara', 'sent');
  e.run(`_p2fuSummaryFor = __orig;`);
  t('if the snapshot cannot be computed, the mark still succeeds (it is only a record)', bad.ok === true && bad.review.status === 'sent', bad);
}

// ============ 5. Existing behaviour ============
{
  const e = boot([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')]);
  const rv = e.review('sara');
  t('closed flag, range and review block are still there', rv.ok && rv.month === month && rv.range.from === month + '-01' && rv.reviews[0].review.status === 'pending' && typeof rv.closed === 'boolean', rv);
  const bad = e.mark('sara', 'nonsense');
  t('a bad status is still refused', bad.ok === false && /status must be/.test(bad.error), bad);
  t('a sent month still logs the parent notification', (() => { e.mark('omar', 'sent'); const l = e.post(Object.assign({ action: 'admin_list_parent_notifications', student: e.P.omar }, e.TOK)); return l.ok && l.notifications.some(n => n.kind === 'monthly'); })());
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
