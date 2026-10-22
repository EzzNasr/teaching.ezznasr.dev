// R-024: written (photo) questions in quizzes AND homework. The score a teacher/parent sees uses the CURRENT total:
//   - ungraded written questions are NOT counted (12 auto questions all right = 12/12, even with 8 written marks waiting)
//   - every written question you grade adds its max to the total and its awarded marks to the score
//   - regrading / grading twice always lands on the same numbers; the follow-up facts show the same figures
// Usage: node tests/test_R024_written_totals.js
const { makeEnv } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + JSON.stringify(x).slice(0, 300))); };
const f = makeEnv(); const { post, getSS } = f; const props = f.env.props; props.FF_GRADING = '1'; props.FF_CAMERA = '1'; props.FF_DEFERRED_ANSWERS = '1';
const TOK = { token: 'tok' }, sara = f.S('sara'), omar = f.S('omar');
const L = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works';
const HW = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-3-ai-in-daily-life-and-industry';
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(300, 7)]).toString('base64');
const num = v => v === '' || v == null ? null : +v;
const row = (tab, key) => { const sh = getSS('DATA').getSheetByName(tab); const c = {}; for (let i = 1; i <= 40; i++) if (sh.get(1, i)) c[sh.get(1, i)] = i;
  for (let r = sh.getLastRow(); r >= 2; r--) if (String(sh.get(r, c.dedupe_key)).replace(/^c:/, '') === key) return { score: num(sh.get(r, c.score)), total: num(sh.get(r, c.total)) }; return null; };
const grade = (sid, q, a, extra) => post(Object.assign({ action: 'admin_grade_written', submission_id: sid, question_id: q, awarded: a }, extra || {}, TOK));
const sidOf = (kind, q) => { const r = post(Object.assign({ action: 'admin_grading_queue', status: 'all' }, TOK)); return (r.items || []).find(i => i.question_id === q && i.kind === kind); };

// ---------- QUIZ: 3 auto + two written (4 and 4 marks) ----------
const QUIZ = { subject: 'programming', lesson: 'chapter-1-lesson-2-how-ai-works', title: 'Q', questions: [
  { type: 'truefalse', prompt: 'a', correct: true }, { type: 'truefalse', prompt: 'b', correct: true }, { type: 'truefalse', prompt: 'c', correct: true },
  { type: 'written', id: 'w1', prompt: 'W1', max_marks: 4, model_answer: 'M1' }, { type: 'written', id: 'w2', prompt: 'W2', max_marks: 4, model_answer: 'M2' }] };
t('quiz content syncs', post(Object.assign({ action: 'admin_set_quiz_content', lesson: L, content_json: JSON.stringify(QUIZ) }, TOK)).ok);
t('models sync', post(Object.assign({ action: 'admin_set_written_models', lesson: L, models: [{ question_id: 'w1', max_marks: 4, model_answer: 'M1', prompt: 'W1' }, { question_id: 'w2', max_marks: 4, model_answer: 'M2', prompt: 'W2' }] }, TOK)).ok);
const served = post(Object.assign({ action: 'get_quiz', lesson_path: L }, sara));
const wq = (served.quiz.questions || []).filter(q => q.type === 'written').map(q => q.qid);
t('written questions are served when the camera flag is on', wq.length === 2, wq);
wq.forEach((qid, k) => post(Object.assign({ action: 'upload_written_image', lesson_path: L, question_id: qid, attempt_id: 'qz-attempt-1', image_id: 'img-' + k + '-0001', data_base64: JPEG }, sara)));
const sub = post(Object.assign({ action: 'upload_quiz_result', student_id: sara.student_id, lesson: 'chapter-1-lesson-2-how-ai-works', lesson_path: L, subject: 'programming', quiz_title: 'Q',
  start_time: '2026-10-20 10:00:00', end_time: '2026-10-20 10:05:00', client_id: 'qz-attempt-1', answers: [{ i: 0, v: 0 }, { i: 1, v: 0 }, { i: 2, v: 0 }] }, sara));
t('quiz submit ok', sub.ok, sub);
let r = row('QuizResults', 'qz-attempt-1');
t('ungraded: 3 of 3 (the 8 written marks are NOT in the total)', r && r.score === 3 && r.total === 3, r);
const q1 = sidOf('quiz', wq[0]), q2 = sidOf('quiz', wq[1]);
t('both written answers are in the grading queue', !!q1 && !!q2, [q1, q2]);
const sid = q1 && q1.submission_id;
let g = grade(sid, wq[0], 4);
r = row('QuizResults', 'qz-attempt-1');
t('graded one (4/4): 7 of 7 — only the graded question joins the total', g.ok && r.score === 7 && r.total === 7, [g, r]);
g = grade(sid, wq[1], 3);
r = row('QuizResults', 'qz-attempt-1');
t('graded the second (3/4): 10 of 11', g.ok && r.score === 10 && r.total === 11, [g, r]);
grade(sid, wq[1], 3); grade(sid, wq[0], 4);
r = row('QuizResults', 'qz-attempt-1');
t('grading again changes nothing (idempotent)', r.score === 10 && r.total === 11, r);
grade(sid, wq[0], 2);
r = row('QuizResults', 'qz-attempt-1');
t('regrade 4 -> 2: 8 of 11', r.score === 8 && r.total === 11, r);

// ---------- HOMEWORK: 2 auto + one written (6 marks), client excludes a pending written from the total ----------
post(Object.assign({ action: 'admin_set_written_models', lesson: HW, models: [{ question_id: 'wh1', max_marks: 6, model_answer: 'HM', prompt: 'HW1' }] }, TOK));
const up = post(Object.assign({ action: 'upload_written_image', kind: 'assignment', lesson_path: HW, question_id: 'wh1', attempt_id: 'hw-attempt-1', image_id: 'img-hw-0001', data_base64: JPEG }, omar));
t('homework photo uploads (kind assignment)', up.ok, up);
const hs = post(Object.assign({ action: 'upload_submission', type: 'assignment', client_id: 'hw-attempt-1', subject: 'programming', lesson: 'chapter-1-lesson-3-ai-in-daily-life-and-industry', student_id: omar.student_id, name: 'Omar',
  date: '2026-10-20', submitted_time: '2026-10-20T10:00:00Z', submission_type: 'graded', score: 2, total: 2,
  answers: [{ id: 'g1', type: 'truefalse', is_correct: true }, { id: 'g2', type: 'truefalse', is_correct: true }, { id: 'wh1', type: 'written', pending: true, max: 6, is_correct: false, image_count: 1 }] }, omar));
t('homework submit ok', hs.ok, hs);
r = row('Submissions', 'hw-attempt-1');
t('homework ungraded: 2 of 2 (written 6 marks not counted)', r && r.score === 2 && r.total === 2, r);
const h1 = sidOf('homework', 'wh1');
t('homework written answer is in the queue as kind "homework" with its model answer', !!h1 && h1.model_answer === 'HM' && h1.max === 6, h1);
g = grade(h1 && h1.submission_id, 'wh1', 5, { kind: 'homework' });
r = row('Submissions', 'hw-attempt-1');
t('homework graded 5/6: 7 of 8', g.ok && r && r.score === 7 && r.total === 8, [g, r]);
grade(h1.submission_id, 'wh1', 5);
r = row('Submissions', 'hw-attempt-1');
t('homework regrade is idempotent', r.score === 7 && r.total === 8, r);

// ---------- what the follow-up page / parent message reads ----------
f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: L, review_lessons: [L] }); f.group('Sat 6pm', [f.P('sara')]);
f.saveGroup({ group: 'Sat 6pm', weekday: 6, time: '18:00', current_lesson: L, review_lessons: [L] });
const ov = f.overview(), facts = ((ov.facts || {})[String(f.P('sara')).slice(-10)] || {})[L];
t('follow-up facts carry the current total (8 of 11), not the old one', facts && facts.quiz && facts.quiz.score === 8 && facts.quiz.total === 11, facts && facts.quiz);

console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
