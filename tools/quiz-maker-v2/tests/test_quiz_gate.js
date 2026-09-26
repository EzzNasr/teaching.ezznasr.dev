const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const L1 = 'programming/other/functions', L2 = 'english/grammar';
const env = load(path);
const { post, getSS, lockState } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 8; c++) if (sh.get(1, c) === name) return c; return 0; };

const reg = (ph, pw, nm) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const stu = getSS('STU').getSheetByName('Students');
stu.set(2, colOf(stu, 'is_admin'), true);
const ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const SA = cr(A);
const TOK = { token: 'tok' };

const state = (lesson) => post({ action: 'get_quiz_state', lesson });
const setLock = (lesson, locked, creds = TOK) => post(Object.assign({ action: 'admin_set_quiz_lock', lesson, locked }, creds));
const submit = (creds, lesson, clientId) => post({ action: 'upload_quiz_result', student_id: creds.student_id, lesson, subject: 'x', quiz_title: 'Q', start_time: '2026-01-01 10:00:00', end_time: '2026-01-01 10:05:00', score: 1, total: 1, questions: [], client_id: clientId });

// 1. untouched lessons behave exactly as before -----------------------------------------------------------------
{
  let r = state(L1);
  t('a lesson never gated: open (locked:false), no error', r.ok && r.locked === false, JSON.stringify(r));
  t('reading never creates the Quizzes tab', tab('Quizzes') === null);
  r = submit(SA, L1, 'c1');
  t('a student can submit a never-gated quiz, as always', r.ok && !r.duplicate, JSON.stringify(r));
}

// 2. who may lock/unlock ------------------------------------------------------------------------------------
{
  let r = setLock(L2, true, SA);
  t('a student cannot set the quiz lock', !r.ok && /Not authorized/.test(r.error), JSON.stringify(r));
  t('no credentials cannot set it', !setLock(L2, true, {}).ok);
  t('locked is required', !post({ action: 'admin_set_quiz_lock', lesson: L2, token: 'tok' }).ok);
  t('nothing was created by the refused calls', tab('Quizzes') === null);
}

// 3. gating a lesson starts it locked, and locking blocks submission -------------------------------------------------
{
  let r = setLock(L2, true);
  t('the FIRST gate on a lesson can be created as locked', r.ok && r.locked === true, JSON.stringify(r));
  r = state(L2);
  t('get_quiz_state reflects it', r.ok && r.locked === true, JSON.stringify(r));
  r = submit(SA, L2, 'c2');
  t('a locked quiz refuses the submission, with a clear message', !r.ok && /locked/i.test(r.error), JSON.stringify(r));
  t('...and it is NOT retryable (resending would just fail again)', !r.retryable, JSON.stringify(r));
  t('nothing was written for the refused submission', !tab('QuizResults') || tab('QuizResults').getLastRow() < 2);
  t('a DIFFERENT, ungated lesson is unaffected', submit(SA, L1, 'c3').ok);
}

// 4. unlocking opens it again, admin session works too ----------------------------------------------------------
{
  let r = setLock(L2, false, ADMIN);
  t('an admin session can unlock (not just the desktop token)', r.ok && r.locked === false, JSON.stringify(r));
  r = state(L2);
  t('get_quiz_state flips immediately', r.locked === false);
  r = submit(SA, L2, 'c4');
  t('submission now works', r.ok, JSON.stringify(r));
  r = setLock(L2, true);
  t('locking again after use still works (no duplicate row)', r.ok && r.locked === true);
  t('exactly one Quizzes row for this lesson', (() => { const sh = tab('Quizzes'); let n = 0; for (let rr = 2; rr <= sh.getLastRow(); rr++) if (String(sh.get(rr, colOf(sh, 'lesson'))) === L2) n++; return n === 1; })());
}

// 5. lesson-path normalisation matches the video lock's rules ------------------------------------------------------
{
  t('different spellings of the same lesson hit the same gate', state('/English/Grammar/').locked === true);
  t('an invalid lesson path is refused, not silently treated as open', !setLock('../etc', true).ok);
}

// 6. busy lock / damaged sheet --------------------------------------------------------------------------------------
{
  lockState.busy = true;
  let r = setLock(L1, true);
  t('busy lock: setting it is retryable', !r.ok && r.retryable === true, JSON.stringify(r));
  r = state(L1);
  t('busy lock: reading state still works (no lock needed)', r.ok && r.locked === false);
  lockState.busy = false;

  setLock(L1, true);
  const sh = tab('Quizzes'), lc = colOf(sh, 'locked');
  sh.set(1, lc, 'oops');
  r = state(L1);
  t('a damaged Quizzes header FAILS CLOSED (locked), consistent with the video lock', r.ok && r.locked === true, JSON.stringify(r));
  r = submit(SA, L1, 'c5');
  t('...so submission is blocked too, until the sheet is fixed', !r.ok && /locked/i.test(r.error), JSON.stringify(r));
  sh.set(1, lc, 'locked');
  t('fixing the header shows its real state again (it was locked)', state(L1).locked === true);
}

// 7. the overview the dashboard reads includes quiz-gate rows and their counts ---------------------------------------
{
  setLock(L1, true);
  const r = post({ action: 'admin_access_overview', token: 'tok' });
  t('overview lists the gated lesson and its lock state', r.ok && r.quizzes.some(q => q.lesson === L1 && q.locked === true), JSON.stringify(r.quizzes));
  t('overview counts locked quizzes', r.counts.quizzes_locked >= 1, r.counts.quizzes_locked);
  setLock(L1, false);
  t('unlocking updates the overview too', post({ action: 'admin_access_overview', token: 'tok' }).quizzes.find(q => q.lesson === L1).locked === false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
