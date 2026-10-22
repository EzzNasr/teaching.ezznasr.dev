// S4 grading backend. The harness loads Code.gs plus every Phase2_*.gs next to it, and the router
// cases are the real ones in Code.gs (integration, S5: the old scratch-copy injection is gone). Run:
//   node tests/test_grading.js apps_script/Code.gs
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { load } = require('./harness');
const [codePath] = process.argv.slice(2);
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const env = load(codePath, { props: { FF_GRADING: '1' } });
const { post, getSS, ctx } = env;
ctx.DriveApp.getFileById = id => ({ makeCopy() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => Buffer.from('IMG-' + id) }) });
ctx.Utilities.base64Encode = b => Buffer.from(b).toString('base64');

const reg = (ph, nm, year) => post({ action: 'register_student', phone: ph, password_hash: H('x'), display_name: nm, year, parent_phone: '01100000009' });
const adm = reg('01000000001', 'Teacher', 'Senior 2');
const A = reg('01000000002', 'Sara', 'Senior 2');
const B = reg('01000000003', 'Omar', 'Senior 1');
const stu = getSS('STU').getSheetByName('Students');
let ac = 0; for (let c = 1; c <= 14; c++) if (stu.get(1, c) === 'is_admin') ac = c;
stu.set(2, ac, true);
const TOK = { token: 'tok' };
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const LES = G2 + 'chapter-1-lesson-2-how-ai-works';
const OLD = G2 + 'lesson-2-how-ai-works';
const LES1 = 'programming/baccalaureate/grade-1-secondary/chapter-1-lesson-1-information-and-media';

// groups
const ss = getSS('STU'); const gs = ss.insertSheet('Groups');
['group', 'phone', 'name', 'added_at'].forEach((h, i) => gs.set(1, i + 1, h));
[['Sat 5pm', '01000000002', 'Sara'], ['Sun 3pm', '01000000003', 'Omar']].forEach((r, i) => r.forEach((v, j) => gs.set(i + 2, j + 1, v)));

// 1. models
let r = post({ action: 'admin_set_written_models', lesson: OLD, models: [{ question_id: 'w1', max_marks: 3, model_answer: 'Because X', prompt: 'Why?' }, { question_id: 'w2', max_marks: 5, model_answer: 'Steps', prompt: 'List' }], ...TOK });
t('models: added via OLD key', r.ok && r.added === 2 && r.lesson === LES, JSON.stringify(r));
r = post({ action: 'admin_set_written_models', lesson: LES, models: [{ question_id: 'w1', max_marks: 3, model_answer: 'Because Y', prompt: 'Why?' }], ...TOK });
t('models: upsert updates, no duplicate', r.ok && r.added === 0 && r.updated === 1, JSON.stringify(r));
t('models: max_marks 0 rejected', !post({ action: 'admin_set_written_models', lesson: LES, models: [{ question_id: 'w3', max_marks: 0, model_answer: '' }], ...TOK }).ok);
t('models: bad question_id rejected', !post({ action: 'admin_set_written_models', lesson: LES, models: [{ question_id: 'a b', max_marks: 1 }], ...TOK }).ok);
t('models: student cannot set', !post({ action: 'admin_set_written_models', lesson: LES, models: [], student_id: A.student_id, session_token: A.session_token }).ok);
post({ action: 'admin_set_written_models', lesson: LES1, models: [{ question_id: 'w1', max_marks: 2, model_answer: 'M', prompt: 'P' }], ...TOK });

r = post({ action: 'admin_get_written_models', lesson: OLD, ...TOK });
t('models: read back by OLD key, with answers', r.ok && r.models.length === 2 && r.models.find(m => m.question_id === 'w1').model_answer === 'Because Y', JSON.stringify(r));
t('models: student cannot read answers', !post({ action: 'admin_get_written_models', lesson: LES, student_id: A.student_id, session_token: A.session_token }).ok);

// 2. seed an attempt (auto part 3/5) and written answers
post({ action: 'upload_quiz_result', student_id: A.student_id, lesson: 'chapter-1-lesson-2-how-ai-works', lesson_path: LES, subject: 'programming', quiz_title: 'Q', start_time: '2026-10-01 10:00:00', end_time: '2026-10-01 10:05:00', score: 3, total: 5, questions: [{ id: 'm1', correct: true }, { id: 'w1', type: 'written', pending: true }], client_id: 'att1' });
const qr = ss.getSheetByName('DATA') || getSS('DATA').getSheetByName('QuizResults');
const qsh = getSS('DATA').getSheetByName('QuizResults');
let dk = 0; for (let c = 1; c <= 20; c++) if (qsh.get(1, c) === 'dedupe_key') dk = c;
const SID = qsh.get(2, dk);
t('seed: attempt row exists', !!SID, 'no dedupe_key');
const wa = ctx.eval ? null : null;
const WA = getSS('DATA').insertSheet('WrittenAnswers');
['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at'].forEach((h, i) => WA.set(1, i + 1, h));
const addWA = (n, sid, stu_, les, q, f) => [sid, stu_, les, q, f, '', '', '', ''].forEach((v, j) => WA.set(n, j + 1, v));
addWA(2, SID, A.student_id, OLD, 'w1', 'fA1');      // stored under the OLD key on purpose
addWA(3, SID, A.student_id, LES, 'w2', 'fA2');
addWA(4, 'other-attempt', B.student_id, LES1, 'w1', 'fB1');

// 3. queue + filters
const Q = (o) => post({ action: 'admin_grading_queue', ...o, ...TOK });
r = Q({});
t('queue: 3 pending', r.ok && r.items.length === 3 && r.counts.pending === 3, JSON.stringify(r.counts));
t('queue: model answer + max joined (old-key row too)', r.items.some(i => i.question_id === 'w1' && i.lesson === LES && i.model_answer === 'Because Y' && i.max === 3), JSON.stringify(r.items[0]));
t('queue: filter year Senior 1', Q({ year: 'Senior 1' }).items.length === 1);
t('queue: filter lesson by OLD key', Q({ lesson: OLD }).items.length === 2);
t('queue: filter student', Q({ student: B.student_id }).items.length === 1);
t('queue: filter group', Q({ group: 'Sat 5pm' }).items.length === 2);
t('queue: unknown status rejected', !Q({ status: 'zzz' }).ok);
t('queue: student cannot read', !post({ action: 'admin_grading_queue', student_id: A.student_id, session_token: A.session_token }).ok);

// 4. grading + score recompute
const G = (q, a, extra) => post({ action: 'admin_grade_written', submission_id: SID, question_id: q, awarded: a, ...extra, ...TOK });
t('grade: above max rejected', !G('w1', 4).ok);
t('grade: negative rejected', !G('w1', -1).ok);
t('grade: unknown answer rejected', !post({ action: 'admin_grade_written', submission_id: 'nope', question_id: 'w1', awarded: 1, ...TOK }).ok);
const sc = () => ({ s: +qsh.get(2, 9), t: +qsh.get(2, 10) });
r = G('w1', 2, { note: 'ok' });
t('grade w1=2/3 -> attempt 5/8', r.ok && sc().s === 5 && sc().t === 8, JSON.stringify(sc()));
G('w1', 2, { note: 'ok' });
t('same grade twice is idempotent', sc().s === 5 && sc().t === 8, JSON.stringify(sc()));
G('w1', 3);
t('regrade w1=3/3 -> 6/8', sc().s === 6 && sc().t === 8, JSON.stringify(sc()));
G('w2', 4);
t('grade w2=4/5 -> 10/13', sc().s === 10 && sc().t === 13, JSON.stringify(sc()));
G('w2', 4); G('w1', 3);
t('repeat all -> still 10/13', sc().s === 10 && sc().t === 13, JSON.stringify(sc()));
let qj = ''; for (let c = 1; c <= 20; c++) if (qsh.get(1, c) === 'questions_json') qj = qsh.get(2, c);
const arr = JSON.parse(qj);
t('questions_json: w1 correct, w2 partial, mcq entry kept, no duplicates', arr.length === 3 && arr.find(q => q.id === 'w1').correct === true && arr.find(q => q.id === 'w2').partial === true && arr.find(q => q.id === 'm1'), qj);
t('queue: graded filter', Q({ status: 'graded' }).items.length === 2 && Q({}).items.length === 1);
t('queue: awarded/note returned for graded', Q({ status: 'graded', student: A.student_id }).items.find(i => i.question_id === 'w2').awarded === 4);

// 5. image access
const IMG = o => post({ action: 'get_written_image', submission_id: SID, question_id: 'w2', ...o });
r = IMG(TOK);
t('image: admin token ok', r.ok && Buffer.from(r.data_base64, 'base64').toString() === 'IMG-fA2' && r.content_type === 'image/jpeg', JSON.stringify(r));
t('image: owner ok', IMG({ student_id: A.student_id, session_token: A.session_token }).ok);
t('image: other student refused', !IMG({ student_id: B.student_id, session_token: B.session_token }).ok);
t('image: no credentials refused', !IMG({}).ok);
t('image: wrong session token refused', !IMG({ student_id: A.student_id, session_token: 'bad' }).ok);
t('image: missing answer = same refusal text as not-yours', IMG({ student_id: B.student_id, session_token: B.session_token }).error === post({ action: 'get_written_image', submission_id: 'zzz', question_id: 'q', student_id: B.student_id, session_token: B.session_token }).error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
