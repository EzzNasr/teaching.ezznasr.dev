// R-015, R-016 and the S3 -> S4 -> review chain on the integrated backend (Code.gs + every Phase2_*.gs).
//   node tests/test_R015_R016_review.js apps_script/Code.gs
const { load } = require('./harness');
const crypto = require('crypto');
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const env = load(process.argv[2]);
const { post, getSS, props } = env;
props.FF_DEFERRED_ANSWERS = '1'; props.FF_CAMERA = '1'; props.FF_GRADING = '1';
const L = 'programming/other/functions', TOK = { token: 'tok' };
const DATA = () => getSS('DATA'), colOf = (sh, n) => { for (let c = 1; c <= 30; c++) if (sh.get(1, c) === n) return c; return 0; };
const reg = (ph, nm) => post({ action: 'register_student', phone: ph, password_hash: H(ph), display_name: nm, year: 'Senior 2', parent_phone: '01100000009' });
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const SA = cr(reg('01000000002', 'Sara')), SB = cr(reg('01000000003', 'Omar'));

const QUIZ = { subject: 'programming', lesson: 'functions', title: 'F', questions: [
  { type: 'mcq', prompt: 'MCQ?', options: ['a', 'b'], correct: 1, explain: 'SECRET-EXPLAIN' },
  { type: 'written', id: 'w1', prompt: 'WRITE', max_marks: 4, model_answer: 'SECRET-MODEL', explain: 'SECRET-EXPLAIN-W' }] };
post({ action: 'admin_set_quiz_content', lesson: L, content_json: JSON.stringify(QUIZ), ...TOK });
post({ action: 'admin_set_written_models', lesson: L, models: [{ question_id: 'w1', max_marks: 4, model_answer: 'SECRET-MODEL', prompt: 'WRITE' }], ...TOK });

// R-015: direct API calls, no UI -------------------------------------------------------------------------------
const q = post({ action: 'get_quiz', lesson_path: L, ...SA });
const s = JSON.stringify(q);
t('R-015 get_quiz serves prompts only: no correct, explain or model answer', q.ok !== false && !/SECRET|"correct"|"explain"|model_answer/.test(s), s.slice(0, 160));
t('R-015 get_quiz review before submitting returns no data', (() => { const r = post({ action: 'get_quiz_review', lesson_path: L, ...SA }); return r.ok === false && !/SECRET|correct_answer/.test(JSON.stringify(r)); })());
t('R-015 a client-graded score is refused while deferred answers are on', post({ action: 'upload_quiz_result', student_id: SA.student_id, lesson: 'functions', lesson_path: L, subject: 'programming', quiz_title: 'F', start_time: '2026-10-21 10:00:00', score: 9, total: 9, questions: [], client_id: 'att-x-0001' }).ok === false);

// S3 submit with 2 photos --------------------------------------------------------------------------------------
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]).toString('base64');
const up = (i) => post({ action: 'upload_written_image', lesson_path: L, question_id: 'w1', attempt_id: 'att-A-0001', image_id: 'img-000' + i, data_base64: JPEG, ...SA });
t('two photos upload', up(1).ok && up(2).ok);
const sub = post({ action: 'upload_quiz_result', student_id: SA.student_id, lesson: 'functions', lesson_path: L, subject: 'programming', quiz_title: 'F',
  start_time: '2026-10-21 10:00:00', end_time: '2026-10-21 10:05:00', client_id: 'att-A-0001', answers: [{ i: 0, v: 1 }, { i: 1, v: null }] });
t('submit ok', sub.ok, JSON.stringify(sub));
const qr = DATA().getSheetByName('QuizResults'), row = () => qr.getLastRow(), cell = n => qr.get(row(), colOf(qr, n));
t('QuizResults dedupe_key is c:<client_id>', cell('dedupe_key') === 'c:att-A-0001', cell('dedupe_key'));
t('submit score/total cover the auto part only (1/1)', cell('score') === 1 && cell('total') === 1);
const wa = DATA().getSheetByName('WrittenAnswers');
t('WrittenAnswers lives next to QuizResults, keyed by the c: id, kind=quiz, 2 photos', !!wa && wa.get(2, colOf(wa, 'submission_id')) === 'c:att-A-0001' && wa.get(2, colOf(wa, 'kind')) === 'quiz' && String(wa.get(2, colOf(wa, 'drive_file_id'))).split(',').length === 2);
t('...and not in the Students spreadsheet', !getSS('STU').getSheetByName('WrittenAnswers'));

// R-016 before grading -----------------------------------------------------------------------------------------
let rv = post({ action: 'get_quiz_review', lesson_path: L, ...SA });
t('R-016 review lists every question; mcq correct, written pending', rv.ok && rv.review.items.length === 2 && rv.review.items[0].status === 'correct' && rv.review.items[1].status === 'pending' && rv.review.pending === 1, JSON.stringify(rv).slice(0, 220));
t('R-016 pending review still hides the model answer', !/SECRET-MODEL/.test(JSON.stringify(rv)));

// S4 sees it, grades it ---------------------------------------------------------------------------------------
const qu = post({ action: 'admin_grading_queue', status: 'pending', ...TOK });
const it = qu.items && qu.items[0];
t('S4 queue lists the S3 answer with model answer and 2 photos', qu.ok && qu.items.length === 1 && it.submission_id === 'c:att-A-0001' && it.model_answer === 'SECRET-MODEL' && it.image_count === 2 && it.kind === 'quiz', JSON.stringify(qu).slice(0, 220));
const grade = a => post({ action: 'admin_grade_written', submission_id: 'c:att-A-0001', question_id: 'w1', awarded: a, note: 'ok', student: '01000000002', ...TOK });
t('grade 3/4', grade(3).ok);
t('QuizResults = auto 1/1 + 3/4 = 4/5', cell('score') === 4 && cell('total') === 5, cell('score') + '/' + cell('total'));
t('regrade is idempotent (same value twice, then a new value)', grade(3).ok && cell('score') === 4 && cell('total') === 5 && grade(4).ok && cell('score') === 5 && cell('total') === 5);
rv = post({ action: 'get_quiz_review', lesson_path: L, ...SA });
t('R-016/R-017 review now shows graded 4/4 with the note', rv.review.items[1].status === 'graded' && rv.review.items[1].awarded === 4 && rv.review.items[1].note === 'ok' && rv.review.pending === 0, JSON.stringify(rv.review.items[1]));
t('questions_json entry updated by S4 (pending cleared)', (() => { const e = JSON.parse(cell('questions_json')).find(x => x.qid === 'w1'); return e && e.pending === false && e.awarded === 4; })());

// photos: owner and admin only; pick by index ---------------------------------------------------------------------
env.ctx.DriveApp.getFileById = id => ({ makeCopy() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => Buffer.from('IMG-' + id) }) });
const img = (c, i) => post({ action: 'get_written_image', submission_id: 'c:att-A-0001', question_id: 'w1', index: i, ...c });
t('R-018 owner and admin can fetch each photo, chosen by index', img(SA, 0).ok && img(TOK, 1).ok && img(SA, 0).data_base64 !== img(SA, 1).data_base64);
t('R-018 another student cannot', img(SB, 0).ok === false && /Not allowed/.test(img(SB, 0).error));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
