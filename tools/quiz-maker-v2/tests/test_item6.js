const { load } = require('./harness');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const rows = (env, tab) => { const sh = env.getSS('DATA').getSheetByName(tab); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };
const live = env => env.drive.files.filter(f => !f.trashed).length;

const quiz = (id, extra) => Object.assign({ action: 'upload_quiz_result', student_id: '01012345678', name: 'Sara', subject: 'english', lesson: 'l1', quiz_title: 'Q', start_time: '2026-09-20T10:00:00Z', end_time: '2026-09-20T10:05:00Z', score: 3, total: 5, questions: [], client_id: id }, extra || {});
const sub = (id, extra) => Object.assign({ action: 'upload_submission', student_id: '01012345678', name: 'Sara', subject: 'english', lesson: 'l1', submission_type: 'text', text: 'hello ' + id, submitted_time: '2026-09-20T10:00:00Z', client_id: id }, extra || {});

// 1. Drive files are never created while the lock is held ------------------------
{
  const env = load(path);
  env.post(quiz('q1'));
  env.post(sub('s1'));
  env.post(sub('s2', { submission_type: 'file', filename: 'a.txt', mime_type: 'text/plain', data_base64: Buffer.from('hi').toString('base64'), text: undefined }));
  t('quiz + text + file uploads all succeed', rows(env, 'QuizResults') === 1 && rows(env, 'Submissions') === 2);
  t('no Drive file was created while the lock was held', env.drive.createdWhileLocked === 0, env.drive.createdWhileLocked);
  t('lock wait for uploads is the shorter 20 s', env.lockState.waits.every(w => w === 20000), JSON.stringify(env.lockState.waits));
}

// 2. Re-sent copy: stops at the quick check, no new Drive file -----------------------
{
  const env = load(path);
  env.post(quiz('q1'));
  const before = env.drive.files.length;
  const r = env.post(quiz('q1'));
  t('re-sent quiz is acknowledged as duplicate', r.ok && r.duplicate);
  t('re-sent quiz creates no Drive file and no row', env.drive.files.length === before && rows(env, 'QuizResults') === 1);
  env.post(sub('s1'));
  const b2 = env.drive.files.length;
  const r2 = env.post(sub('s1'));
  t('re-sent submission: duplicate, no new files, one row', r2.duplicate && env.drive.files.length === b2 && rows(env, 'Submissions') === 1);
}

// 3. Race: identical request lands while the first is still creating its file --------
{
  const env = load(path);
  env.post(quiz('warm'));                      // tab exists, as in real use
  env.drive.onCreate = () => { env.post(quiz('same')); };   // 2nd copy runs to completion mid-way through the 1st
  const r = env.post(quiz('same'));
  t('race: first request reports duplicate', r.ok && r.duplicate, JSON.stringify(r));
  t('race: exactly one row for that attempt', rows(env, 'QuizResults') === 2, rows(env, 'QuizResults'));
  t('race: loser\'s Drive file was trashed (no stray copy)', live(env) === 2, 'live files: ' + live(env));

  const env2 = load(path);
  env2.post(sub('warm'));
  env2.drive.onCreate = () => { env2.post(sub('same')); };
  const r2 = env2.post(sub('same'));
  t('race (submission): one row, loser\'s meta file trashed (3 created, 2 kept)', r2.duplicate && rows(env2, 'Submissions') === 2 && live(env2) === 2 && env2.drive.files.length === 3, `rows ${rows(env2, 'Submissions')} live ${live(env2)}`);
}

// 4. Lock busy: retryable answer, nothing left behind, resend works ---------------------
{
  const env = load(path);
  env.post(quiz('warm'));
  const base = live(env);
  env.lockState.busy = true;
  const r = env.post(quiz('busy1'));
  t('busy lock -> {ok:false, retryable:true} with a friendly message', r.ok === false && r.retryable === true && /busy/i.test(r.error), JSON.stringify(r));
  t('busy lock: no row written, Drive file cleaned up', rows(env, 'QuizResults') === 1 && live(env) === base, `rows ${rows(env, 'QuizResults')} live ${live(env)} base ${base}`);
  env.lockState.busy = false;
  const r2 = env.post(quiz('busy1'));
  t('resending the same record afterwards succeeds once', r2.ok && !r2.duplicate && rows(env, 'QuizResults') === 2 && live(env) === base + 1);

  env.lockState.busy = true;
  const rs = env.post(sub('busy2', { submission_type: 'file', filename: 'b.txt', data_base64: Buffer.from('x').toString('base64'), text: undefined }));
  const liveBefore = live(env);
  t('busy lock on a file submission: retryable, both Drive files cleaned up', rs.retryable === true && rows(env, 'Submissions') === 0 && env.drive.files.slice(-2).every(f => f.trashed), JSON.stringify(rs));
  env.lockState.busy = false;
  const rs2 = env.post(sub('busy2', { submission_type: 'file', filename: 'b.txt', data_base64: Buffer.from('x').toString('base64'), text: undefined }));
  t('...and the resend then succeeds with one row', rs2.ok && rows(env, 'Submissions') === 1);

  // registration also gets the friendly retryable answer
  env.lockState.busy = true;
  const rg = env.post({ action: 'register_student', phone: '01011112222', password_hash: 'h', display_name: 'X' });
  t('registration with a busy lock: retryable + friendly text', rg.retryable === true && /busy/i.test(rg.error), JSON.stringify(rg));
  env.lockState.busy = false;
}

// 5. Ordinary errors are NOT marked retryable ------------------------------------------------
{
  const env = load(path);
  const r = env.post({ action: 'upload_quiz_result', client_id: 'x' });
  t('missing student_id is a normal (non-retryable) rejection', r.ok === false && !r.retryable, JSON.stringify(r));
  const r2 = env.post({ action: 'login_student', phone: '01000000000', password_hash: 'h' });
  t('login errors are not retryable', r2.ok === false && !r2.retryable);
}

// 6. First-ever upload (no tabs yet) and a tab that lacks a column -----------------------------
{
  const env = load(path);
  t('no tabs before the first upload', env.getSS('DATA').sheets.length === 0);
  const r = env.post(quiz('first'));
  t('first upload creates the tab and saves the row', r.ok && rows(env, 'QuizResults') === 1);

  const env2 = load(path);
  const ss = env2.getSS('DATA'); const sh = ss.insertSheet('QuizResults');
  sh.appendRow(['student_id', 'name', 'subject', 'lesson', 'quiz_title', 'date', 'start_time', 'end_time', 'score', 'total', 'questions_json']); // no dedupe_key
  const a = env2.post(quiz('old1')); const b = env2.post(quiz('old1'));
  const hdr = []; for (let c = 1; c <= sh.getLastColumn(); c++) hdr.push(sh.get(1, c));
  t('older tab without dedupe_key: column added once, duplicate still caught', a.ok && b.duplicate && hdr.filter(h => h === 'dedupe_key').length === 1 && rows(env2, 'QuizResults') === 1, JSON.stringify(hdr));
}

// 7. A whole class: 30 attempts, 30 submissions ---------------------------------------------
{
  const env = load(path);
  env.post(quiz('warm')); env.post(sub('warm'));
  let bad = 0;
  for (let i = 0; i < 30; i++) {
    if (!env.post(quiz('cq' + i, { start_time: '2026-09-20T10:' + String(i).padStart(2, '0') + ':00Z', student_id: '0101000' + String(1000 + i) })).ok) bad++;
    if (!env.post(sub('cs' + i, { student_id: '0101000' + String(1000 + i) })).ok) bad++;
  }
  t('30 quiz results + 30 submissions: no errors', bad === 0, bad);
  t('31 quiz rows, 31 submission rows, one live Drive file per row pair', rows(env, 'QuizResults') === 31 && rows(env, 'Submissions') === 31 && live(env) === 62, `${rows(env, 'QuizResults')}/${rows(env, 'Submissions')} live ${live(env)}`);
  t('still no Drive file created under the lock', env.drive.createdWhileLocked === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
