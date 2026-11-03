// Guards commit 99d91f0 ("one account = one active sign-in" + photo reporting + written answers out of the auto score),
// which was silently undone once by an assembly built from an older copy of the site (0757045) and restored 2026-11-03.
//   node tests/test_session_photos_99d91f0.js        (run from tools/quiz-maker-v2)
// A: the server side, through the real router AND the Phase 4 gate (deny-by-default: the actions must be listed).
// B: the student pages still ask before work starts and report photos afterwards (the part that was lost).
const fs = require('fs'), path = require('path');
const { makeWorld, S1PHONE } = require('./test_p4_s4_support');
const ROOT = path.join(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
const t = (n, ok, d) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  -> ' + JSON.stringify(d === undefined ? '' : d).slice(0, 300))); };

// ---------------------------------------------------------------- A. server
{
  const W = makeWorld();
  let r = W.post(Object.assign({ action: 'check_session' }, W.S1));
  t('check_session: a live student sign-in is valid (and passes the P4 gate)', r.ok === true && r.valid === true && r.state === 'student', r);
  r = W.post({ action: 'check_session', student_id: W.S1.student_id, session_token: 'not-the-token' });
  t('check_session: a wrong token is not valid (answers ok:true, never blocks the page)', r.ok === true && r.valid === false, r);
  r = W.post(Object.assign({ action: 'check_session' }, W.T));
  t('check_session: a signed-in math teacher previewing a quiz is not refused by the P4 gate', r.ok === true && r.valid === true, r);
  r = W.post(Object.assign({ action: 'check_session' }, W.A));
  t('check_session: the teacher\'s assistant is not refused either', r.ok === true, r);
  const again = W.post({ action: 'login_student', phone: S1PHONE, password_hash: W.api.H('pw') });
  t('signing in again issues a new token', again.ok === true && again.session_token && again.session_token !== W.S1.session_token, again);
  r = W.post(Object.assign({ action: 'check_session' }, W.S1));
  t('check_session: the OLD device is no longer the live sign-in', r.ok === true && r.valid === false, r);
  r = W.post({ action: 'check_session', student_id: W.S1.student_id, session_token: again.session_token });
  t('check_session: the new device is', r.ok === true && r.valid === true, r);

  const sent = () => (W.api.env.telegram || W.api.env.sent || []).length;
  r = W.post({ action: 'report_photos', kind: 'quiz', student_id: W.S1.student_id, session_token: again.session_token,
    attempt_id: 'attempt-12345678', lesson_path: 'programming/x/lesson-one', expected: 2 });
  t('report_photos: accepted through the P4 gate, counts what the server holds', r.ok === true && r.received === 0, r);
  r = W.post({ action: 'report_photos', kind: 'quiz', student_id: W.S1.student_id, attempt_id: 'bad', expected: 1 });
  t('report_photos: a malformed attempt id is refused', r.ok === false, r);
}

// ---------------------------------------------------------------- A2. grading rule (written marks are teacher-graded)
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
  const body = src.slice(src.indexOf('function _p2cGradeQuiz('), src.indexOf('function _p2cGradeQuiz(') + 900);
  t('_p2cGradeQuiz: written answers never count in the submit-time total', /if \(e\.type !== "written"\) \{ total \+= 1;/.test(body) && !/total \+= e\.max/.test(body), body.slice(0, 300));
  t('upload_submission recomputes score/total from auto-graded answers (old cached pages)', /autoAns = meta\.answers\.filter/.test(src));
  t('Telegram: auto score shown as "MCQ x/y", written answers on their own line', /function _autoScoreLine\(/.test(src) && /function _writtenLine\(/.test(src));
  t('router: check_session and report_photos are wired', /case "check_session":/.test(src) && /case "report_photos":/.test(src));
}

// ---------------------------------------------------------------- B. the student pages
for (const f of ['assets/quiz.js', 'assets/assign.js']) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  t(f + ': asks check_session before work (sessionStillValid)', /function sessionStillValid\(/.test(s) && /action: "check_session"/.test(s));
  t(f + ': a network blip never blocks the student (resolves valid on error)', /sessionStillValid[\s\S]{0,1200}(resolve\(true\)|return true)/.test(s));
  t(f + ': reports how many photos arrived (report_photos)', /action: "report_photos"/.test(s));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
