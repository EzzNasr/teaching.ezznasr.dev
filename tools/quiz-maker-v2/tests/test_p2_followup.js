// Session 2 backend (Phase2_Followup.gs) against the REAL Code.gs:
//   node tests/test_p2_followup.js apps_script/Code.gs apps_script/Phase2_Followup.gs
// Covers R-009 R-010 R-011 R-012 R-013 (+ R-022 for center decisions) and the guards (admin only, feature flags).
const { load } = require('./harness');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const [codePath, p2Path] = process.argv.slice(2);
// Integration: the harness loads Code.gs plus every Phase2_*.gs next to it (one shared scope, like Apps Script),
// so S2's code now runs with the real p2_* helpers, p2k_canon and the shared AuditLog.
const joined = codePath;
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra === undefined ? '' : (typeof extra === 'string' ? extra : JSON.stringify(extra)))) ); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const cairoYmd = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const today = cairoYmd(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekStart = ymd => { const [y, m, d] = ymd.split('-').map(Number); const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return addDays(ymd, -((dow + 1) % 7)); };
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const CUR = G2 + 'chapter-2-lesson-1-networks';
const REV = G2 + 'chapter-1-lesson-2-how-ai-works';          // renamed folder; old results hold the BARE old slug
const OLD_SLUG = 'lesson-2-how-ai-works';
const thisMonth = today.slice(0, 7), prevMonth = (() => { const [y, m] = thisMonth.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); })();
const prevDay = prevMonth + '-10';

function boot(props) {
  const env = load(joined, { props: props || {} });
  const { post, getSS } = env;
  const tab = n => getSS('STU').getSheetByName(n);
  const rowsOf = n => { const sh = tab(n); if (!sh) return []; const hd = []; for (let c = 1; c <= 12; c++) hd.push(sh.get(1, c)); const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; hd.forEach((h, i) => { if (h) row[h] = sh.get(r, i + 1); }); o.push(row); } return o; };
  // AuditLog is the ONE shared log (contract section 8): DATA spreadsheet, header at/who/action/target/before/after.
  const auditRows = () => { const sh = getSS('DATA').getSheetByName('AuditLog'); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) o.push({ at: sh.get(r, 1), who: sh.get(r, 2), action: sh.get(r, 3), target: sh.get(r, 4), before: sh.get(r, 5), after: sh.get(r, 6) }); return o; };
  const reg = (phone, pw, name, parent) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 2', parent_phone: parent || '01100000009' });
  const adm = reg('01000000001', 'a', 'Teacher');
  const stuSheet = getSS('STU').getSheetByName('Students');
  let col = 0; for (let c = 1; c <= 16; c++) if (stuSheet.get(1, c) === 'is_admin') col = c;
  stuSheet.set(2, col, true);
  const people = {};
  [['sara', '01000000002', 'Sara Mahmoud'], ['omar', '01000000003', 'Omar Ali'], ['nour', '01000000004', 'Nour Hassan'], ['paid', '01000000005', 'Paid Student']].forEach(([k, ph, nm]) => {
    const r = reg(ph, k, nm, '0123456789' + people.length); people[k] = { phone: ph, creds: { student_id: r.student_id, session_token: r.session_token } };
  });
  const TOK = { token: 'tok' }, ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
  const call = (fn, payload) => { try { return env.ctx[fn](payload); } catch (e) { return { ok: false, error: e.message }; } };
  const P = k => people[k].phone;
  ['sara', 'omar', 'nour'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: P(k) }, TOK)));
  post(Object.assign({ action: 'admin_followup_save_group', group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV], hw_deadline_override: '2020-01-01' }, TOK));
  const quiz = (who, slug, score, ymd, id) => post({ action: 'upload_quiz_result', student_id: P(who), name: who, subject: 'programming', lesson: slug, quiz_title: 'Q', start_time: ymd + 'T10:00:00Z', end_time: ymd + 'T10:05:00Z', score, total: 10, questions: [], client_id: id });
  const hw = (who, slug, ymd, id) => post({ action: 'upload_submission', student_id: P(who), name: who, subject: 'programming', lesson: slug, submission_type: 'text', text: 'ans ' + id, submitted_time: ymd + 'T10:00:00Z', client_id: id });
  return Object.assign(env, { tab, rowsOf, auditRows, call, TOK, ADMIN, P, people, quiz, hw });
}

const E = boot({ FF_PARENT_LOG: 'TRUE', FF_MONTHLY: 'TRUE' });
const { call, TOK, ADMIN, P, tab, rowsOf, auditRows, post, people } = E;

// 1. guards ------------------------------------------------------------------------------------------------------
{
  const S = people.sara.creds;
  ['p2_admin_set_requirement', 'p2_admin_log_parent_notification', 'p2_admin_list_parent_notifications', 'p2_admin_student_summary', 'p2_admin_monthly_review',
   'p2_admin_followup_overview', 'p2_admin_followup_set_attendance'].forEach(fn => {
    const r = call(fn, Object.assign({ lesson: REV, student: P('sara'), kind: 'quiz', month: thisMonth, items: [{ phone: P('sara'), mode: 'center' }] }, S));
    t(fn + ': a student session is refused', r.ok === false && /Not authorized/.test(r.error), r);
  });
  t('the admin session and the desktop token both work', call('p2_admin_followup_overview', ADMIN).ok === true && call('p2_admin_followup_overview', TOK).ok === true);
  const off = boot({});
  const r1 = off.call('p2_admin_log_parent_notification', Object.assign({ student: off.P('sara'), kind: 'quiz' }, off.TOK));
  const r2 = off.call('p2_admin_monthly_review', Object.assign({ month: thisMonth, student: off.P('sara') }, off.TOK));
  const r3 = off.call('p2_admin_list_parent_notifications', off.TOK);
  t('FF_PARENT_LOG off: log and list are refused', r1.ok === false && /FF_PARENT_LOG/.test(r1.error) && r3.ok === false && /FF_PARENT_LOG/.test(r3.error), [r1, r3]);
  t('FF_MONTHLY off: the monthly review is refused', r2.ok === false && /FF_MONTHLY/.test(r2.error), r2);
  const ov = off.call('p2_admin_followup_overview', off.TOK);
  t('flags default off and are reported to the page', ov.flags && ov.flags.FF_PARENT_LOG === false && ov.flags.FF_MONTHLY === false && Object.keys(ov.parent_log).length === 0, ov.flags);
  t('student summary has no flag (always available)', off.call('p2_admin_student_summary', Object.assign({ student: off.P('sara') }, off.TOK)).ok === true);
}

// 2. requirements (R-009) -------------------------------------------------------------------------------------------
{
  let o = call('p2_admin_followup_overview', TOK);
  t('no requirement row: quiz and homework are both required', o.lessons[REV].quiz_required === true && o.lessons[REV].homework_required === true, o.lessons[REV]);
  t('week is Saturday to Friday and contains today', o.week.start === weekStart(today) && o.week.end === addDays(o.week.start, 6) && o.week.start <= today && today <= o.week.end, o.week);
  const r = call('p2_admin_set_requirement', Object.assign({ lesson: REV, quiz_required: false }, TOK));
  t('set_requirement: quiz off leaves homework required', r.ok && r.requirement.quiz_required === false && r.requirement.homework_required === true, r);
  o = call('p2_admin_followup_overview', TOK);
  t('overview: the lesson carries the two flags independently', o.lessons[REV].quiz_required === false && o.lessons[REV].homework_required === true, o.lessons[REV]);
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, homework_required: false, due_override: '2030-05-01' }, TOK));
  const rq = rowsOf('LessonRequirements');
  t('set_requirement upserts one row per lesson', rq.length === 1 && rq[0].due_override === '2030-05-01', rq);
  o = call('p2_admin_followup_overview', TOK);
  t('overview: both off + due override reach the page', o.lessons[REV].quiz_required === false && o.lessons[REV].homework_required === false && o.lessons[REV].due_override === '2030-05-01');
  t('set_requirement: a bad date is refused', call('p2_admin_set_requirement', Object.assign({ lesson: REV, due_override: '1/2/2030' }, TOK)).ok === false);
  t('set_requirement: a bad lesson is refused', call('p2_admin_set_requirement', Object.assign({ lesson: '../x' }, TOK)).ok === false);
  t('set_requirement: an old-key lesson is stored under its canonical key', (() => { call('p2_admin_set_requirement', Object.assign({ lesson: G2 + 'lesson-2-how-ai-works', quiz_required: true, homework_required: true, due_override: '' }, TOK)); return rowsOf('LessonRequirements').length === 1; })());
  t('AuditLog records requirement changes', auditRows().filter(a => a.action === 'set_requirement').length >= 3);
}

// 3. parent log (R-013) ---------------------------------------------------------------------------------------------
{
  const log = b => call('p2_admin_log_parent_notification', Object.assign({}, b, TOK));
  const a = log({ student: P('sara'), kind: 'homework', ref: REV, note: 'اتصلت بيها' });
  t('log: creates an entry', a.ok && a.created === true && a.notification.kind === 'homework' && a.notification.note === 'اتصلت بيها', a);
  const b = log({ student: P('sara'), kind: 'homework', ref: REV, note: 'ردّت وقالت هتسلّم' });
  const list = call('p2_admin_list_parent_notifications', Object.assign({ student: P('sara') }, TOK));
  t('log: the same (student, kind, ref) edits the entry instead of duplicating', b.ok && b.created === false && list.notifications.length === 1 && list.notifications[0].note === 'ردّت وقالت هتسلّم', list);
  log({ student: P('omar'), kind: 'quiz', ref: REV });
  log({ student: P('omar'), kind: 'custom', note: 'مكالمة عامة' });
  log({ student: P('omar'), kind: 'custom', note: 'مكالمة تانية' });
  t('two custom entries logged in the same second never merge', call('p2_admin_list_parent_notifications', Object.assign({ student: P('omar'), kind: 'custom' }, TOK)).notifications.length === 2);
  t('list: filter by kind', call('p2_admin_list_parent_notifications', Object.assign({ kind: 'quiz' }, TOK)).notifications.length === 1);
  const nn = call('p2_admin_list_parent_notifications', Object.assign({ kind: 'homework', ref: REV, not_notified_students: [P('sara'), P('omar'), P('nour')] }, TOK));
  t('«not yet notified» keeps only students with no entry for that item', JSON.stringify(nn.not_notified) === JSON.stringify([P('omar'), P('nour')]), nn);
  t('log: a wrong kind is refused', log({ student: P('sara'), kind: 'sms' }).ok === false);
  t('log: a missing phone is refused', log({ kind: 'quiz' }).ok === false);
  t('log: a malformed sent_at is refused', log({ student: P('sara'), kind: 'quiz', sent_at: 'yesterday' }).ok === false);
  const reload = call('p2_admin_followup_overview', TOK);
  const k = P('sara').slice(-10);
  t('the log persists and reaches the overview (parent_log)', reload.parent_log[k] && reload.parent_log[k][0].kind === 'homework' && reload.parent_log[k][0].ref === REV.toLowerCase(), reload.parent_log);
  t('stored students are full phone numbers, not keys', rowsOf('ParentNotifications')[0].student === P('sara'), rowsOf('ParentNotifications')[0]);
}

// 4. student summary (R-011) ----------------------------------------------------------------------------------------
{
  const S1 = E.quiz('sara', OLD_SLUG, 7, prevDay, 'q1');       // last month, under the OLD bare slug
  E.quiz('sara', OLD_SLUG, 9, today, 'q2');                     // this month, same lesson
  E.quiz('sara', OLD_SLUG, 6, today, 'q3');                     // a second attempt later today
  E.hw('sara', OLD_SLUG, today, 'h1');
  E.quiz('omar', 'chapter-1-lesson-9-other', 5, today, 'q4');   // another lesson, never in the group
  const sum = (who, from, to) => call('p2_admin_student_summary', Object.assign({ student: P(who), from, to }, TOK));
  const prev = sum('sara', prevMonth + '-01', prevMonth + '-28');
  const cur = sum('sara', thisMonth + '-01', today);
  const rawQ = ['q1', 'q2', 'q3'].length;
  t('summary: last month holds exactly the one last-month attempt (7/10 = 70)', prev.ok && prev.quizzes.length === 1 && prev.quizzes[0].score === 7 && prev.totals.quiz_avg_pct === 70, prev.quizzes);
  t('summary: an old bare slug resolves to the renamed lesson', prev.quizzes[0].lesson === 'chapter-1-lesson-2-how-ai-works', prev.quizzes[0]);
  t('summary: this month counts the lesson once, with its 2 attempts and the LATEST score', cur.quizzes.length === 1 && cur.quizzes[0].attempts === 2 && cur.quizzes[0].score === 6 && cur.totals.quiz_avg_pct === 60, cur.quizzes);
  t('summary: ranges do not leak into each other', !cur.quizzes.some(q => q.date === prevDay) && !prev.quizzes.some(q => q.date === today));
  t('summary: homework counted from raw Submissions in range', cur.homework.length === 1 && cur.totals.homework_count === 1 && prev.homework.length === 0, cur.homework);
  const raw = rowsOf('x'); // (placeholder to keep the style of other tests)
  const dsh = E.getSS('DATA').getSheetByName('QuizResults');
  let rawRows = 0; for (let r = 2; r <= dsh.getLastRow(); r++) if (String(dsh.get(r, 1)).slice(-10) === P('sara').slice(-10) && String(dsh.get(r, 6)).slice(0, 7) === thisMonth) rawRows++;
  t('summary agrees with the raw QuizResults rows for the month (attempts)', cur.quizzes.reduce((a, q) => a + q.attempts, 0) === rawRows && rawRows === 2, rawRows);
  t('summary: the student record, groups and parent phone', cur.student.name === 'Sara Mahmoud' && cur.groups[0].group === 'Sat 6pm' && /^0123456789/.test(cur.student.parent_phone), cur.student);
  t('summary: unknown student is refused', sum('sara', thisMonth + '-01', today).ok && call('p2_admin_student_summary', Object.assign({ student: '01999999999' }, TOK)).ok === false);
  t('summary: from after to is refused', sum('sara', today, prevDay).ok === false);

  // expected items: REV is the group's homework & quiz lesson; hw due override is long past (set in boot)
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, quiz_required: true, homework_required: true, due_override: '' }, TOK));
  let om = sum('omar', thisMonth + '-01', today);
  t('R-009 both required, nothing done, past due: a quiz AND a homework are missed', om.totals.quiz_missed === 1 && om.totals.homework_missed === 1, om.totals);
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, quiz_required: false }, TOK));
  om = sum('omar', thisMonth + '-01', today);
  t('R-009 quiz optional: the quiz is not missed, the homework still is', om.totals.quiz_missed === 0 && om.totals.homework_missed === 1 && om.totals.quiz_required === 0 && om.totals.homework_required === 1, om.totals);
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, quiz_required: true, homework_required: false }, TOK));
  om = sum('omar', thisMonth + '-01', today);
  t('R-009 homework optional: the homework is not missed, the quiz still is', om.totals.quiz_missed === 1 && om.totals.homework_missed === 0, om.totals);
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, quiz_required: true, homework_required: true, due_override: '2099-01-01' }, TOK));
  om = sum('omar', thisMonth + '-01', today);
  t('a due date in the future applies to both items: neither is missed yet', om.totals.homework_missed === 0 && om.totals.quiz_missed === 0 && om.totals.quiz_required === 1 && om.totals.homework_required === 1, om.totals);
  const sa = sum('sara', thisMonth + '-01', today);
  t('done items are never missed', sa.totals.quiz_missed === 0 && sa.totals.homework_missed === 0 && sa.expected[0].quiz.done && sa.expected[0].homework.done, sa.expected);
  call('p2_admin_set_requirement', Object.assign({ lesson: REV, due_override: '' }, TOK));
}

// 5. attendance / watch / video access / written answers in the summary ------------------------------------------------
{
  const att = tab('Attendance') || E.getSS('STU').insertSheet('Attendance');
  if (!att.get(1, 1)) ['lesson', 'phone', 'mode', 'marked_at'].forEach((h, i) => att.set(1, i + 1, h));
  const addRow = (sh, vals) => { const r = sh.getLastRow() + 1; vals.forEach((v, i) => sh.set(r, i + 1, v)); };
  addRow(att, [CUR, P('sara'), 'center', today + ' 18:00:00']);
  addRow(att, [REV, P('sara'), 'online', today + ' 18:00:00']);
  const wsh = tab('WatchProgress') || E.getSS('STU').insertSheet('WatchProgress'); if (!wsh.get(1, 1)) ['phone', 'lesson', 'pct', 'duration_s', 'first_at', 'updated_at'].forEach((h, i) => wsh.set(1, i + 1, h));
  addRow(wsh, [P('sara'), REV, 80, 600, today + ' 10:00:00', today + ' 10:10:00']);
  addRow(wsh, [P('sara'), CUR, 40, 600, today + ' 10:00:00', today + ' 10:10:00']);
  const wr = E.getSS('DATA').insertSheet('WrittenAnswers'); ['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at'].forEach((h, i) => wr.set(1, i + 1, h));
  addRow(wr, ['s1', P('sara'), REV, 'q5', 'f1', 3, 5, '', today]);
  addRow(wr, ['s1', P('sara'), REV, 'q6', 'f2', '', 5, '', '']);
  const s = call('p2_admin_student_summary', Object.assign({ student: P('sara'), from: thisMonth + '-01', to: today }, TOK));
  t('summary: attendance counts (1 center, 1 online)', s.totals.attendance_center === 1 && s.totals.attendance_online === 1, s.attendance);
  t('summary: watch average from WatchProgress', s.totals.watch_avg_pct === 60 && s.watch.length === 2, s.watch);
  t('summary: video access per lesson comes from the one can_watch rule', s.video_access.length >= 2 && s.video_access.every(v => v.can_watch === true), s.video_access);
  t('summary: written answers pending vs graded', s.written.pending === 1 && s.written.graded === 1 && s.written.awarded === 3 && s.written.max === 5 && s.totals.written_pending === 1, s.written);
  t('summary: parent notifications in the range', s.notifications.length === 1 && s.notifications[0].kind === 'homework', s.notifications);
}

// 6. monthly review (R-012) -------------------------------------------------------------------------------------------
{
  const mr = (b) => call('p2_admin_monthly_review', Object.assign({}, b, TOK));
  const one = mr({ month: thisMonth, student: P('sara') });
  const direct = call('p2_admin_student_summary', Object.assign({ student: P('sara'), from: one.range.from, to: one.range.to }, TOK));
  t('R-012 the monthly totals equal the summary for the same range', one.ok && JSON.stringify(one.reviews[0].summary.totals) === JSON.stringify(direct.totals), [one.reviews && one.reviews[0] && one.reviews[0].summary.totals, direct.totals]);
  t('monthly: the range of the running month ends today, a past month ends on its last day', one.range.to === today && mr({ month: prevMonth, student: P('sara') }).range.to.slice(0, 7) === prevMonth && mr({ month: prevMonth, student: P('sara') }).closed === true && one.closed === false, one.range);
  const grp = mr({ month: thisMonth, group: 'sat 6pm' });
  t('monthly: a group returns one review per member', grp.ok && grp.reviews.length === 3 && grp.reviews.every(r => r.review.status === 'pending'), grp.reviews && grp.reviews.length);
  const m = mr({ op: 'mark', month: thisMonth, student: P('sara'), status: 'ready', note: 'جاهزة' });
  t('monthly mark: ready is stored', m.ok && m.review.status === 'ready', m);
  const sent = mr({ op: 'mark', month: thisMonth, student: P('sara'), status: 'sent' });
  t('monthly mark: sent stamps sent_at and keeps the note', sent.ok && sent.review.status === 'sent' && sent.review.sent_at !== '' && sent.review.note === 'جاهزة', sent);
  t('monthly mark: one row per student and month', rowsOf('MonthlyReviews').filter(r => r.month === thisMonth).length === 1);
  t('monthly mark: «sent» logs a parent notification (kind monthly)', call('p2_admin_list_parent_notifications', Object.assign({ student: P('sara'), kind: 'monthly', ref: thisMonth }, TOK)).notifications.length === 1);
  t('monthly get now shows the stored status', mr({ month: thisMonth, student: P('sara') }).reviews[0].review.status === 'sent');
  t('monthly: bad month / status / missing target are refused', mr({ month: '2026-13', student: P('sara') }).ok === false && mr({ op: 'mark', month: thisMonth, student: P('sara'), status: 'x' }).ok === false && mr({ month: thisMonth }).ok === false);
}

// 7. center week rule (R-010, R-022) ------------------------------------------------------------------------------------
{
  const week = { start: weekStart(today), end: addDays(weekStart(today), 6) };
  const setAtt = (items, extra) => call('p2_admin_followup_set_attendance', Object.assign({ lesson: CUR, items }, extra || {}, TOK));
  // a student who already has a MANUAL grant for CUR must keep it untouched
  const ent = E.getSS('STU').getSheetByName('Entitlements') || E.getSS('STU').insertSheet('Entitlements');
  if (!ent.get(1, 1)) ['phone', 'scope', 'expires_at', 'granted_at', 'source'].forEach((h, i) => ent.set(1, i + 1, h));
  ent.appendRow([P('paid'), CUR, '', '2026-01-01 00:00:00', 'manual']);
  const one = setAtt([{ phone: P('omar'), mode: 'center' }]);
  t('one center student needs no week confirm', one.ok === true && one.expires_at === week.end, one);
  const entRows = () => rowsOf('Entitlements'), qaRows = () => rowsOf('QuizAccess');
  const omarEnt = entRows().filter(r => String(r.phone).slice(-10) === P('omar').slice(-10) && r.scope === CUR);
  const omarQa = qaRows().filter(r => String(r.phone).slice(-10) === P('omar').slice(-10) && r.lesson === CUR);
  t('R-010 center grants only the current lesson, expiring on this week\'s Friday', omarEnt.length === 1 && omarEnt[0].expires_at === week.end && omarEnt[0].source === 'attendance' && omarQa.length === 1 && omarQa[0].expires_at === week.end, [omarEnt, omarQa]);
  t('R-010 no other lesson was granted', entRows().filter(r => r.source === 'attendance').every(r => r.scope === CUR));
  const bulk = [{ phone: P('sara'), mode: 'center' }, { phone: P('nour'), mode: 'center' }];
  const refused = setAtt(bulk);
  t('bulk center without a week confirm is refused (and writes nothing)', refused.ok === false && /week/i.test(refused.error) && entRows().filter(r => r.source === 'attendance').length === 1, refused);
  t('bulk center with the wrong week is refused', setAtt(bulk, { week_confirm: addDays(week.start, -7) }).ok === false);
  const okBulk = setAtt(bulk, { week_confirm: week.start });
  t('bulk center with this week\'s confirm works', okBulk.ok === true && okBulk.results.length === 2, okBulk);
  t('every bulk row expires on Friday', entRows().filter(r => r.source === 'attendance').every(r => r.expires_at === week.end) && qaRows().filter(r => r.source === 'attendance').every(r => r.expires_at === week.end));
  const withManual = setAtt([{ phone: P('paid'), mode: 'center' }, { phone: P('omar'), mode: 'center' }], { week_confirm: week.start });
  t('a student with a manual grant keeps it (no expiry added to it)', withManual.ok && entRows().filter(r => String(r.phone).slice(-10) === P('paid').slice(-10) && r.scope === CUR).length === 1 && entRows().filter(r => String(r.phone).slice(-10) === P('paid').slice(-10))[0].source === 'manual' && entRows().filter(r => String(r.phone).slice(-10) === P('paid').slice(-10))[0].expires_at === '', entRows());
  const before = entRows().length;
  const undo = setAtt([{ phone: P('sara'), mode: 'online' }, { phone: P('omar'), mode: '' }, { phone: P('paid'), mode: 'online' }]);
  const left = entRows().filter(r => r.source === 'attendance');
  t('R-010 undo removes only the attendance rows of those students; others and manual rows stay', undo.ok && left.length === 1 && String(left[0].phone).slice(-10) === P('nour').slice(-10) && entRows().some(r => r.source === 'manual' && String(r.phone).slice(-10) === P('paid').slice(-10)), left);
  t('guest grant=false center does not grant or expire anything', (() => { const n = rowsOf('Entitlements').length; const r = setAtt([{ phone: P('omar'), mode: 'center' }, { phone: P('sara'), mode: 'center' }], { grant: false }); return r.ok && rowsOf('Entitlements').length === n && r.expires_at === ''; })());
  const audit = auditRows().filter(a => /^attendance_/.test(a.action));
  t('R-022 every center decision is in the AuditLog with who, at, before -> after', audit.length >= 8 && audit.every(a => a.who === 'token' && /^\d{4}-\d{2}-\d{2}/.test(a.at) && a.after !== ''), audit.slice(0, 2));
  t('R-022 the audit keeps the previous mode', audit.some(a => /"mode":"center"/.test(a.before) && a.action === 'attendance_online'));
  t('attendance still validates input (bad mode refused)', setAtt([{ phone: P('omar'), mode: 'maybe' }]).ok === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
// (S2 used to delete its temp joined file here; it now loads Code.gs directly, so nothing to clean up)
process.exit(fail ? 1 : 0);
