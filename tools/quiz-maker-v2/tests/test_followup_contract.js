// Usage: node tests/test_followup_contract.js [site root]
// Feeds a REAL admin_followup_overview (from the delivered Code.gs, run in the repo's harness)
// into the delivered followup-logic.js, and checks the two agree on the data shape.
const path = require('path');
const repo = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const { load } = require(repo + '/tools/quiz-maker-v2/tests/harness');
const L = require(repo + '/assets/followup-logic.js');
const crypto = require('crypto');
const H = s => crypto.createHash('sha256').update(s).digest('hex');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const env = load(repo + '/tools/quiz-maker-v2/apps_script/Code.gs');
const { post, getSS } = env;
const TOK = { token: 'tok' };
const G1 = 'programming/baccalaureate/grade-1-secondary/';
const CUR = G1 + 'chapter-2-lesson-2-functions', REV = G1 + 'chapter-2-lesson-1-variables';
const reg = (ph, n, par) => post({ action: 'register_student', phone: ph, password_hash: H(n), display_name: n, year: 'Senior 1', parent_phone: par });
reg('01000000001', 'Teacher', '01100000009');
const ppl = { sara: ['01000000002', '01234567890'], omar: ['01000000003', '01234567891'], nour: ['01000000004', '01000000004'], hana: ['01000000005', ''], adham: ['01000000006', '01234567894'] };
const creds = {};
Object.keys(ppl).forEach(k => { const r = reg(ppl[k][0], k, ppl[k][1]); creds[k] = { student_id: r.student_id, session_token: r.session_token }; });
const stu = getSS('STU').getSheetByName('Students'); stu.set(2, 6, true);
['sara', 'omar', 'nour', 'hana'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: ppl[k][0] }, TOK)));
post({ action: 'admin_set_video', token: 'tok', lesson: CUR, slot: 'lesson', video_url: 'https://www.youtube.com/embed/AAAAAAAAAAA', locked: true });
post(Object.assign({ action: 'admin_followup_save_group', group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: CUR, review_lessons: [REV] }, TOK));
// sara: center; omar: online + paid access + 90% watched; nour: online, locked, no access; hana: unmarked
post(Object.assign({ action: 'admin_followup_set_attendance', lesson: CUR, items: [{ phone: ppl.sara[0], mode: 'center' }, { phone: ppl.omar[0], mode: 'online' }, { phone: ppl.nour[0], mode: 'online' }] }, TOK));
const q = post(Object.assign({ action: 'request_access', lesson: CUR, reference: 'r1' }, creds.omar));
post(Object.assign({ action: 'admin_decide_payment', payment_id: q.payment_id, decision: 'approve', days: 30 }, TOK));
post(Object.assign({ action: 'record_watch', lesson: CUR, pct: 90, duration_s: 600 }, creds.omar));
post({ action: 'upload_submission', student_id: ppl.omar[0], name: 'omar', subject: 'programming', lesson: 'chapter-2-lesson-1-variables', submission_type: 'text', text: 'x', client_id: 'h1' });
post({ action: 'upload_quiz_result', student_id: ppl.omar[0], name: 'omar', subject: 'programming', lesson: 'chapter-2-lesson-1-variables', quiz_title: 'Q', start_time: '2026-10-14T10:00:00Z', end_time: '2026-10-14T10:05:00Z', score: 9, total: 10, questions: [], client_id: 'q1' });

const ov = JSON.parse(JSON.stringify(post(Object.assign({ action: 'admin_followup_overview' }, TOK))));
t('overview ok', ov.ok === true, ov.error);
const g = ov.groups[0];
const sum = k => L.studentSummary(g.members.find(m => m.phone === ppl[k][0]), g, ov);
const now = new Date(ov.now);

const sara = sum('sara'), omar = sum('omar'), nour = sum('nour'), hana = sum('hana');
t('center student: watching optional, no session message', sara.verdicts.session.state === 'optional' && !sara.issues.some(i => i.kind === 'session'), sara.verdicts.session.state);
t('center student: homework + quiz missing are issues on the review lesson', sara.issues.filter(i => i.lesson === REV).length === 2, JSON.stringify(sara.issues.map(i => i.key)));
t('online + paid + 90 %: session_done and a praise', omar.verdicts.session.state === 'session_done' && omar.praises.some(p => p.key === 'session_done'));
t('omar: homework done + quiz 9/10 praise on the review lesson', omar.verdicts.homework[0].state === 'homework_done' && omar.verdicts.quiz[0].praise === true && omar.issues.length === 0, JSON.stringify(omar.verdicts.quiz));
t('online + locked video, no access: session_locked, message is the "unwatched" template', nour.verdicts.session.state === 'session_locked' && nour.issues.some(i => i.key === 'session_unwatched' && i.locked), nour.verdicts.session.state);
t('parent number equal to the student\'s own is flagged', nour.parent.level === 'warn' && nour.microChips.some(c => c.key === 'parent'), JSON.stringify(nour.parent));
t('blank parent phone is "missing" and disables the buttons', hana.parent.level === 'missing' && hana.primaryAction.disabled === true);
t('unmarked student: needs attendance, session message blocked', hana.needsAttendance === true && hana.sessionBlocked === 'حدد الحضور أولًا' && hana.verdicts.session.state === 'needs_attendance');
t('a student with 2+ issues gets the combined message as primary action', sara.primaryAction.kind === 'combined' && sara.primaryAction.key === 'combined', JSON.stringify(sara.primaryAction));
t('4 micro-chips in the guide\'s order (+ parent warning when needed)', sara.microChips.slice(0, 4).map(c => c.key).join() === 'attendance,watch,homework,quiz' && nour.microChips.length === 5);

const gs = L.groupSummary(g, ov, now);
t('group counts: 1 unmarked, hw missing for sara/nour/hana, quiz absent for the same three', gs.unmarked === 1 && gs.hwMissing === 3 && gs.quizAbsent === 3, JSON.stringify({ u: gs.unmarked, h: gs.hwMissing, q: gs.quizAbsent }));
t('group counts: nour counts as unwatched + locked', gs.unwatched === 1 && gs.locked === 1, JSON.stringify({ w: gs.unwatched, l: gs.locked }));
t('deadlines come from the saved schedule (watch 3 days / homework 1 day before the next Saturday 18:00)', (() => {
  const d = gs.deadlines, ns = d.nextSession; if (!ns || ns.weekday !== 6) return false;
  const back = (s, n) => { const [y, m, dd] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10); };
  return d.watch.date === back(ns.date, 3) && d.hw.date === back(ns.date, 1);
})(), JSON.stringify(gs.deadlines));
t('noWatchData is false because omar has a tracking row', gs.noWatchData === false);
t('the unclassified student (adham) can be summarised too', (() => { const u = ov.unclassified[0]; const s = L.studentSummary(u, { settings: g.settings, members: [u] }, ov); return !!s && s.verdicts.session.lesson === CUR; })());
t('phoneKey agrees between Code.gs keys and the logic library', Object.keys(ov.students).every(k => L.phoneKey(ov.students[k].phone) === k));
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
