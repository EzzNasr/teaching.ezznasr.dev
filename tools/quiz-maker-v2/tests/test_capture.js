// Session 3: deferred answers, server-side grading, photo upload, post-submit review.
//   node tests/test_capture.js apps_script/Code.gs apps_script/Phase2_Capture.gs
// Runs the REAL Code.gs + Phase2_Capture.gs. The four router lines S5 will add to
// doPost are applied here at load time (see capture_router.js), so Code.gs is untouched.
const { load } = require('./harness');
const { buildCombined } = require('./capture_router');
const crypto = require('crypto');
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const env = load(buildCombined(process.argv[2], process.argv[3]));
const { post, getSS, props, drive } = env;
const L = 'programming/other/functions';
const TOK = { token: 'tok' };
const tab = n => getSS('DATA').getSheetByName(n) || getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 30; c++) if (sh.get(1, c) === name) return c; return 0; };

const reg = (ph, pw, nm) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 2', parent_phone: '01100000009' });
const A = reg('01000000002', 'b', 'Sara'), B = reg('01000000003', 'c', 'Omar');
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const SA = cr(A), SB = cr(B);

const QUIZ = {
  subject: 'programming', lesson: 'functions', title: 'Functions',
  questions: [
    { q: 'LEGACY?', options: ['no', 'yes', 'maybe'], correct: 1, explain: 'SECRET-EXPLAIN-1' },
    { type: 'mcq', prompt: 'MULTI?', options: ['a', 'b', 'c', 'd'], correct: [0, 2], explain: 'SECRET-EXPLAIN-2' },
    { type: 'truefalse', prompt: 'TF?', correct: false, explain: 'SECRET-EXPLAIN-3' },
    { type: 'match', prompt: 'MATCH', options: ['red', 'green'], rows: [{ label: 'apple', correct: 'red' }, { label: 'leaf', correct: 'green' }], explain: 'SECRET-EXPLAIN-4' },
    { type: 'written', id: 'w1', prompt: 'WRITE IT', max_marks: 4, model_answer: 'SECRET-MODEL', explain: 'SECRET-EXPLAIN-5' },
  ],
};
t('quiz content syncs', post(Object.assign({ action: 'admin_set_quiz_content', lesson: L, content_json: JSON.stringify(QUIZ) }, TOK)).ok);
const getQuiz = (creds) => post(Object.assign({ action: 'get_quiz', lesson_path: L }, creds || {}));
const SECRETS = ['SECRET-EXPLAIN', 'SECRET-MODEL'];
const leaks = r => { const s = JSON.stringify(r); return SECRETS.some(x => s.includes(x)) || /"correct"/.test(s); };

// a tiny valid-looking JPEG / PNG / junk
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(300, 7)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(50, 1)]).toString('base64');
const JUNK = Buffer.from('<html>not an image</html>').toString('base64');
const up = (creds, o) => post(Object.assign({ action: 'upload_written_image', lesson_path: L, question_id: 'w1', attempt_id: 'attempt-0001', image_id: 'image-0001', data_base64: JPEG }, creds, o || {}));
const answers = (extra) => [{ i: 0, v: 1 }, { i: 1, v: [0, 2] }, { i: 2, v: 1 }, { i: 3, v: ['red', 'green'] }].concat(extra || []);
const submit = (creds, o) => post(Object.assign({ action: 'upload_quiz_result', student_id: creds.student_id, lesson: 'functions', lesson_path: L, subject: 'programming',
  quiz_title: 'Functions', start_time: '2026-10-20 10:00:00', end_time: '2026-10-20 10:05:00', client_id: 'attempt-0001', answers: answers() }, o || {}));
const review = (creds, o) => post(Object.assign({ action: 'get_quiz_review', lesson_path: L }, creds, o || {}));

// 1. flags off: nothing changes for existing lessons --------------------------------------------------------------
{
  const r = getQuiz(SA);
  t('flags off: get_quiz still returns the quiz', r.ok && r.quiz && r.features && r.features.deferred === false && r.features.camera === false, JSON.stringify(r).slice(0, 200));
  t('flags off: legacy answers still shipped (unchanged behaviour)', r.quiz.questions[0].correct === 1);
  t('flags off: written question is not served (nothing can answer it)', !r.quiz.questions.some(q => q.type === 'written') && r.quiz.questions.length === 4);
  t('flags off: every served question carries its original index', r.quiz.questions.every((q, i) => q._i === i));
  const s = post({ action: 'upload_quiz_result', student_id: SA.student_id, lesson: 'functions', lesson_path: L, subject: 'x', quiz_title: 'Q', start_time: '2026-10-20 09:00:00', score: 3, total: 4, questions: [], client_id: 'legacy-0001' });
  t('flags off: client-graded submit still works', s.ok, JSON.stringify(s));
  t('flags off: upload_written_image refused as disabled (contract)', up(SA).ok === false && up(SA).disabled === true && /FF_CAMERA/.test(up(SA).error));
}

// 2. deferred on: no answers leave the server ----------------------------------------------------------------------
props.FF_DEFERRED_ANSWERS = '1';
{
  const r = getQuiz(SA);
  t('deferred: get_quiz ok, flagged deferred', r.ok && r.quiz.deferred === true && r.features.deferred === true);
  t('R-015 deferred: no "correct", explanations or model answers in the response', !leaks(r), JSON.stringify(r).slice(0, 300));
  t('R-015 deferred: same for a call with no student at all', !leaks(getQuiz()));
  t('deferred: multi-select still identifiable without the key', r.quiz.questions[1].multi === true && r.quiz.questions[0].multi === false);
  t('deferred: match rows keep only labels', JSON.stringify(r.quiz.questions[3].rows) === JSON.stringify([{ label: 'apple' }, { label: 'leaf' }]));
  t('deferred, camera off: written still hidden', r.quiz.questions.length === 4);
  t('deferred: the stored content is untouched (admin read still has the key)', JSON.stringify(post(Object.assign({ action: 'admin_get_quiz_content', lesson: L }, TOK))).includes('SECRET-MODEL'));
}

// 3. server grades; a client score is never trusted ----------------------------------------------------------------
{
  let r = post({ action: 'upload_quiz_result', student_id: SA.student_id, lesson: 'functions', lesson_path: L, subject: 'programming', quiz_title: 'F', start_time: '2026-10-20 10:00:00', score: 99, total: 99, questions: [], client_id: 'tamper-0001' });
  t('deferred: a client-graded submit for a synced quiz is refused', !r.ok && /refresh/i.test(r.error), JSON.stringify(r));
  t('deferred: ...and nothing was written for it', !tab('QuizResults') || ![...Array(tab('QuizResults').getLastRow())].some((_, i) => String(tab('QuizResults').get(i + 1, colOf(tab('QuizResults'), 'dedupe_key'))) === 'c:tamper-0001'));
  r = submit(SA, { client_id: 'attempt-0100', score: 99, total: 99, answers: answers([{ i: 4, v: null }]) });
  t('answers submit ok', r.ok, JSON.stringify(r));
  const sh = tab('QuizResults'), last = sh.getLastRow();
  const row = n => sh.get(last, colOf(sh, n));
  t('score computed server-side: all 4 auto questions right, client score ignored (4 of 4+4 marks)', row('score') === 4 && row('total') === 8, row('score') + '/' + row('total'));
  const qs = JSON.parse(row('questions_json'));
  t('entries carry correct answers for the review', qs[0].correct_answer === 'yes' && qs[1].correct_answer === 'a, c' && qs[2].correct_answer === 'False');
  r = submit(SB, { client_id: 'attempt-0200', answers: [{ i: 0, v: 0 }, { i: 1, v: [0] }, { i: 2, v: 0 }, { i: 3, v: ['green', 'red'] }] });
  const last2 = sh.getLastRow();
  t('wrong answers score 0', sh.get(last2, colOf(sh, 'score')) === 0);
  r = submit(SB, { client_id: 'attempt-0201', answers: [{ i: 0, v: 99 }, { i: 1, v: 'zzz' }, { i: 3, v: ['nope', ''] }] });
  t('garbage values (out of range / wrong type) grade as wrong, never throw', r.ok && sh.get(sh.getLastRow(), colOf(sh, 'score')) === 0, JSON.stringify(r));
  t('resending the same attempt is still a duplicate', submit(SA, { client_id: 'attempt-0100', answers: answers() }).duplicate === true);
}

// 4. review: nothing before submit, own attempt only, after submit ---------------------------------------------------
{
  const C = reg('01000000004', 'd', 'Lina'), SC = cr(C);
  let r = review(SC);
  t('R-015 review before submitting: error, no data', !r.ok && /Submit the quiz first/.test(r.error) && !leaks(r), JSON.stringify(r));
  t('review needs a session', !post({ action: 'get_quiz_review', lesson_path: L, student_id: SC.student_id }).ok);
  t('review with someone else\'s attempt id: still nothing', !review(SC, { client_id: 'attempt-0100' }).ok);
  r = review(SA);
  t('R-016 review after submit lists every question with right/wrong', r.ok && r.review.items.length === 5, JSON.stringify(r).slice(0, 200));
  t('review statuses', r.review.items.slice(0, 4).every(x => x.status === 'correct') && r.review.items[4].status === 'wrong');
  t('review includes explanations (only now)', r.review.items[0].explain === 'SECRET-EXPLAIN-1');
  r = review(SB, { client_id: 'attempt-0200' });
  t('review shows what was wrong and the right answer', r.ok && r.review.items[0].status === 'wrong' && r.review.items[0].your_answer === 'no' && r.review.items[0].correct_answer === 'yes');
}

// 5. photos -------------------------------------------------------------------------------------------------------
props.FF_CAMERA = '1';
{
  t('camera on: written question served, without its model answer', (() => { const r = getQuiz(SA); const w = r.quiz.questions.find(q => q.type === 'written'); return !!w && w.qid === 'w1' && w.max_marks === 4 && !leaks(r); })());
  t('upload needs a session', !post({ action: 'upload_written_image', lesson_path: L, question_id: 'w1', attempt_id: 'attempt-0300', image_id: 'image-0001', data_base64: JPEG, student_id: SA.student_id }).ok);
  t('a bad session token is refused', !up({ student_id: SA.student_id, session_token: 'nope' }, { attempt_id: 'attempt-0300' }).ok);
  let r = up(SA, { attempt_id: 'attempt-0300', data_base64: JUNK });
  t('non-image bytes refused (magic check, not the mime the client claims)', !r.ok && /JPEG, PNG or WebP/.test(r.error), JSON.stringify(r));
  r = up(SA, { attempt_id: 'attempt-0300', data_base64: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(3 * 1024 * 1024)]).toString('base64') });
  t('oversize refused', !r.ok && /too large/.test(r.error), JSON.stringify(r));
  t('empty refused', !up(SA, { attempt_id: 'attempt-0300', data_base64: '' }).ok);
  t('a question that is not "written" is refused', !up(SA, { attempt_id: 'attempt-0300', question_id: '0' }).ok);
  t('bad ids refused', !up(SA, { attempt_id: 'a' }).ok && !up(SA, { attempt_id: 'attempt-0300', image_id: '../x' }).ok);
  t('nothing stored for any refusal', !tab('WrittenAnswers') || tab('WrittenAnswers').getLastRow() < 2);
  const files0 = drive.files.length;
  r = up(SA, { attempt_id: 'attempt-0300' });
  t('R-014 upload ok', r.ok && r.count === 1 && !r.drive_file_id, JSON.stringify(r));
  t('...the response never exposes a Drive id', !/file\d+/.test(JSON.stringify(r)));
  r = up(SA, { attempt_id: 'attempt-0300' });
  t('R-014 a retried upload (same image_id) is a duplicate: one file, one row', r.ok && r.duplicate && drive.files.length === files0 + 1 && tab('WrittenAnswers').getLastRow() === 2, JSON.stringify(r));
  r = up(SA, { attempt_id: 'attempt-0300', image_id: 'image-0002', data_base64: PNG });
  t('a second photo for the same answer joins the same row', r.ok && r.count === 2 && tab('WrittenAnswers').getLastRow() === 2);
  up(SA, { attempt_id: 'attempt-0300', image_id: 'image-0003' });
  r = up(SA, { attempt_id: 'attempt-0300', image_id: 'image-0004' });
  t('more than 3 photos per answer refused, and its file is cleaned up', !r.ok && /up to 3/.test(r.error) && drive.files.filter(f => !f.trashed).length === files0 + 3 && drive.files[drive.files.length - 1].trashed, JSON.stringify(r));
  t('another student with the same ids gets their own row (no cross-student merge)', up(SB, { attempt_id: 'attempt-0300' }).ok && tab('WrittenAnswers').getLastRow() === 3);
  const ws = tab('WrittenAnswers');
  t('row stores student, lesson, question, 3 files', String(ws.get(2, colOf(ws, 'student_id'))).endsWith('1000000002') && ws.get(2, colOf(ws, 'lesson')) === L && String(ws.get(2, colOf(ws, 'drive_file_id'))).split(',').length === 3);
  t('awarded/max/note/graded_at left blank for S4', ['awarded', 'max', 'note', 'graded_at'].every(n => ws.get(2, colOf(ws, n)) === ''));
}

// 6. submit with photos -> pending, then graded by S4 shows through ---------------------------------------------------
{
  let r = submit(SA, { client_id: 'attempt-0300', answers: answers([{ i: 4, v: null }]) });
  t('submit with photos ok', r.ok, JSON.stringify(r));
  const sh = tab('QuizResults'), last = sh.getLastRow();
  const qs = JSON.parse(sh.get(last, colOf(sh, 'questions_json')));
  t('written entry is pending, counts its photos, hides model answer', qs[4].pending === true && qs[4].image_count === 3 && qs[4].correct_answer === '' && qs[4].max === 4);
  t('score and total = auto-graded only at submit (S4 adds written marks when graded)', sh.get(last, colOf(sh, 'score')) === 4 && sh.get(last, colOf(sh, 'total')) === 4);
  r = review(SA, { client_id: 'attempt-0300' });
  t('R-016 review: written shows "pending grading", not wrong', r.ok && r.review.items[4].status === 'pending' && r.review.pending === 1 && r.review.items[4].is_correct === null);
  // S4 grades (simulated by writing the sheet the way admin_grade_written will)
  const ws = tab('WrittenAnswers'); const row = 2;
  ws.set(row, colOf(ws, 'awarded'), 3); ws.set(row, colOf(ws, 'max'), 4); ws.set(row, colOf(ws, 'note'), 'good, missed one step'); ws.set(row, colOf(ws, 'graded_at'), '2026-10-21 12:00:00');
  r = review(SA, { client_id: 'attempt-0300' });
  t('R-017 review reflects the grade: 3/4 with the teacher note', r.review.items[4].status === 'graded' && r.review.items[4].awarded === 3 && r.review.items[4].max === 4 && r.review.items[4].note === 'good, missed one step');
  t('another student cannot read that review', !review(SB, { client_id: 'attempt-0300' }).ok);
  r = submit(SB, { client_id: 'attempt-0400', answers: answers([{ i: 4, v: null }]) });
  const e4 = JSON.parse(sh.get(sh.getLastRow(), colOf(sh, 'questions_json')))[4];
  t('a written question with no photo is "no answer", not pending', e4.pending === false && e4.your_answer === '');
}

// 7. locks and limits -------------------------------------------------------------------------------------------------
{
  post(Object.assign({ action: 'admin_set_quiz_lock', lesson: L, locked: true }, TOK));
  t('a locked quiz refuses photo uploads', !up(SA, { attempt_id: 'attempt-0500' }).ok && /locked/i.test(up(SA, { attempt_id: 'attempt-0500' }).error));
  post(Object.assign({ action: 'admin_set_quiz_lock', lesson: L, locked: false }, TOK));
  const D = reg('01000000005', 'e', 'Hana'), SD = cr(D);
  let ok = 0, lastErr = '';
  for (let i = 0; i < 70; i++) { const r = up(SD, { attempt_id: 'attempt-' + String(1000 + Math.floor(i / 3)), image_id: 'image-r' + String(100 + i), question_id: 'w1' }); if (r.ok) ok++; else lastErr = r.error; }
  t('per-student hourly cap holds (60), with a clear message', ok <= 60 && /Too many photos/.test(lastErr), ok + ' ' + lastErr);
}

// 8. homework path: camera only, no quiz content needed ---------------------------------------------------------------
{
  props.FF_DEFERRED_ANSWERS = '0';
  const r = up(SB, { kind: 'assignment', lesson_path: 'programming/other/hw1', attempt_id: 'hw-attempt-01', question_id: 'h1' });
  t('assignment photos need only FF_CAMERA (no deferred flag, no quiz content)', r.ok, JSON.stringify(r));
  props.FF_CAMERA = '0';
  t('with the camera flag off even that is refused', !up(SB, { kind: 'assignment', lesson_path: 'programming/other/hw1', attempt_id: 'hw-attempt-01', image_id: 'image-zz01' }).ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
