// R-P25-F: the teacher's read-only revenue report (teacher_revenue_report in Revenue.gs, Phase 2.5 step F).
//   node tests/test_p25_revenue.js        (run from tools/quiz-maker-v2)
// A math teacher sees only math: cards (students, courses, lessons, purchases, total sales), courses > lessons
// (price, videos, visible, quiz, sales), and every approved math purchase (student name, item, method, date) with no
// phone and no payment reference. Another subject's payments, lessons and students never show. The owner's
// admin_revenue_report is unchanged and stays owner only; the owner may open the teacher report (every subject).
// Assistants, students, desktop tokens and anonymous callers are refused. Nothing is written.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeWorld, setStudent, colEnsure, S1PHONE, S2PHONE, TOKEN } = require('./test_p4_s4_support');
let fails = 0, passes = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 500))); ok ? passes++ : fails++; };
const J = o => JSON.stringify(o);
const NA = r => !!r && r.ok === false && r.error === 'Not authorized.';

const W = makeWorld();
const { api, post } = W;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Revenue.gs'), 'utf8'), api.env.ctx, { filename: 'Revenue.gs' });
api.env.setNow('2026-11-23T10:00:00Z');
api.env.props.REV_LESSON_PRICE_EGP = '60';
const as = (who, p) => post(Object.assign({}, p, who));

const M1 = 'math/test-course/lesson-1', M2 = 'math/test-course/lesson-2', M3 = 'math/other-course/lesson-1', PR = 'programming/test-course/lesson-1';
// Content: videos (one paid), quiz, a hidden lesson.
post({ action: 'admin_set_video', token: TOKEN, lesson: M1, slot: 'lesson', video_url: 'https://www.youtube.com/embed/aaaaaaaaaaa', locked: true });
post({ action: 'admin_set_video', token: TOKEN, lesson: M1, slot: 'quiz', video_url: 'https://www.youtube.com/embed/bbbbbbbbbbb', locked: false });
post({ action: 'admin_set_video', token: TOKEN, lesson: M2, slot: 'lesson', video_url: 'https://www.youtube.com/embed/ccccccccccc' });
post({ action: 'admin_set_quiz_content', token: TOKEN, lesson: M1, content_json: J({ title: 'Q', questions: [] }) });
as(W.T, { action: 'admin_set_lesson_lock', lesson: M2, locked: true });
post({ action: 'admin_set_video', token: 'tok', lesson: PR, slot: 'lesson', video_url: 'https://www.youtube.com/embed/ddddddddddd' });
// Payments: replace the world's rows with a known set.
const pay = api.tab('Payments');
for (let r = pay.getLastRow(); r >= 2; r--) for (let c = 1; c <= 12; c++) pay.set(r, c, '');
const row = (id, phone, name, scope, status, created, decided, amount) => {
  const r = pay.getLastRow() + 1;
  [id, phone, name, scope, 'REF-' + id, 'note ' + id, status, created, decided || ''].forEach((v, i) => pay.set(r, i + 1, v));
  if (amount !== undefined) pay.set(r, colEnsure(pay, 'amount'), amount);
};
row('A1', S1PHONE, 'Owned Student', M1, 'approved', '2026-11-01 10:00:00', '2026-11-01 12:00:00', 60);
row('A2', S1PHONE, 'Owned Student', M2, 'approved', '2026-11-10 10:00:00', '2026-11-10 11:00:00', 50);
row('A3', S1PHONE, 'Owned Student', M3, 'pending', '2026-11-20 10:00:00', '', 60);
row('A4', S1PHONE, 'Owned Student', M1, 'rejected', '2026-11-05 10:00:00', '2026-11-05 11:00:00', 60);
row('B1', S2PHONE, 'Foreign Student', PR, 'approved', '2026-11-02 10:00:00', '2026-11-02 11:00:00', 99);
row('B2', S2PHONE, 'Foreign Student', 'programming/baccalaureate/grade-1-secondary#ch3', 'approved', '2026-11-03 10:00:00', '2026-11-03 11:00:00', 250);

// ---------------------------------------------------------------- who may call it
const before = J(api.rows('Payments'));
let r = as(W.T, { action: 'teacher_revenue_report' });
t('the math teacher (session) gets a report', r.ok === true, J(r));
t('refused: his scoped assistant', NA(as(W.A, { action: 'teacher_revenue_report' })));
t('refused: the legacy assistant', NA(as(W.L, { action: 'teacher_revenue_report' })) || (x => x.ok === false)(as(W.L, { action: 'teacher_revenue_report' })));
t('refused: a student', (x => x.ok === false)(as(W.S1, { action: 'teacher_revenue_report' })));
t('refused: the desktop teacher token', NA(post({ action: 'teacher_revenue_report', token: TOKEN })));
t('refused: no credentials', (x => x.ok === false)(post({ action: 'teacher_revenue_report' })));
t('the owner\'s report is still owner only', NA(as(W.T, { action: 'admin_revenue_report' })));

// ---------------------------------------------------------------- what the math teacher sees
const s = J(r);
t('cards: 2 purchases, 110 EGP, 1 pending', r.cards.purchases === 2 && r.cards.total_sales === 110 && r.cards.pending === 1, J(r.cards));
t('cards: courses and lessons are his (2 courses, 3 lessons)', r.cards.courses === 2 && r.cards.lessons === 3, J(r.cards) + J(r.lessons.map(l => l.key)));
t('cards: students = his linked students', r.cards.students >= 1 && r.cards.students <= 2, r.cards.students);
t('subjects: math only', J(r.subjects) === '["math"]');
const L1 = r.lessons.find(l => l.key === M1), L2 = r.lessons.find(l => l.key === M2), L3 = r.lessons.find(l => l.key === M3);
t('lesson 1: 2 videos (1 paid), quiz, visible, price 60, 1 sale of 60', L1 && L1.videos === 2 && L1.paid_videos === 1 && L1.quiz && L1.visible && L1.price === 60 && L1.sales.count === 1 && L1.sales.amount === 60, J(L1));
t('lesson 2: hidden, 1 sale of 50 (the stored amount wins)', L2 && L2.visible === false && L2.sales.amount === 50, J(L2));
t('lesson 3: known only from a pending payment, no sale yet', L3 && L3.sales.count === 0 && L3.pending === 1, J(L3));
const C1 = r.courses.find(c => c.key === 'math/test-course');
t('course: 2 lessons, 3 videos, 110 EGP', C1 && C1.lessons === 2 && C1.videos === 3 && C1.total.amount === 110, J(C1));
t('purchases: the 2 approved math rows, newest first', r.purchases.length === 2 && r.purchases[0].date === '2026-11-10' && r.purchases[1].date === '2026-11-01', J(r.purchases));
t('purchases: student, item, method, date and amount', r.purchases.every(p => p.student === 'Owned Student' && p.method === 'website' && /^math\//.test(p.item) && typeof p.amount === 'number'));
t('no phone number and no payment reference anywhere', !s.includes(S1PHONE.slice(-9)) && !s.includes('REF-') && !s.includes('note A'), s.slice(0, 300));
t('nothing of programming: no lesson, payment, student or subscription', !/programming/.test(s) && !s.includes('Foreign Student') && !s.includes('99'), s.slice(0, 300));
t('rejected payments are not counted', !r.purchases.some(p => p.date === '2026-11-05'));
t('nothing was written', J(api.rows('Payments')) === before);

// ---------------------------------------------------------------- a second teacher sees only his own
const BPHONE = '01000000121';
const breg = post({ action: 'register_student', phone: BPHONE, password_hash: api.H('pw12345678'), display_name: 'Ms Mona', year: 'Senior 1', parent_phone: '01234567891' });
setStudent(api, BPHONE, { role: 'teacher', teacher_scope: 'programming' });
const rb = post({ action: 'teacher_revenue_report', student_id: breg.student_id, session_token: breg.session_token });
t('the programming teacher sees programming only (lesson sale + chapter subscription)', rb.ok && rb.cards.purchases === 2 && rb.cards.total_sales === 349 && !/math\//.test(J(rb)), J(rb.cards));
const PC = rb.courses && rb.courses.find(c => c.key === 'programming/baccalaureate/grade-1-secondary');
t('a chapter subscription counts under its grade as a course sale', PC && PC.subscriptions.count === 1 && PC.subscriptions.amount === 250, J(rb.courses));

// ---------------------------------------------------------------- the owner
const ro = as(W.owner, { action: 'teacher_revenue_report' });
t('the owner may open it and sees every subject', ro.ok && J(ro.subjects) === '["*"]' && ro.cards.purchases === 4 && /programming/.test(J(ro)) && /math\//.test(J(ro)), J(ro.cards));
const own = as(W.owner, { action: 'admin_revenue_report' });
t('the owner\'s own report still works and keeps its shape', own.ok && own.totals && Array.isArray(own.rows) && own.totals.all_time.count === 4 && !J(own).includes('Owned Student'), J(own.totals));

// ---------------------------------------------------------------- static
const code = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
t('Code.gs routes teacher_revenue_report', code.includes('case "teacher_revenue_report":'));
t('P4_ACTIONS: teacher only, session only', (row => row && row.rule === 'T' && row.ses && !row.tok)(api.env.ctx.P4_ACTIONS.teacher_revenue_report));

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
