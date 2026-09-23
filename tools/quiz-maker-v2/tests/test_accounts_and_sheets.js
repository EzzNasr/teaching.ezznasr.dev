const { load } = require('./harness');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => require('crypto').createHash('sha256').update(s).digest('hex');

const env = load(path);
const { post, getSS, ctx } = env;

// --- register / login / reset -------------------------------------------------
let r = post({ action: 'register_student', phone: '01012345678', password_hash: H('oldpass'), display_name: 'Sara Ali', year: 'Senior 1', parent_phone: '01198765432' });
t('register works', r.ok, JSON.stringify(r));
const stu = getSS('STU');
t('students tab lives in credentials sheet only', stu.sheets.length === 1 && stu.sheets[0].getLastRow() === 2);
t('data sheet untouched by registration', getSS('DATA').sheets.length === 0);

r = post({ action: 'login_student', phone: '+20 101 234 5678', password_hash: H('oldpass') });
t('login with +20 format', r.ok, JSON.stringify(r));
r = post({ action: 'login_student', phone: '01012345678', password_hash: H('nope') });
t('wrong password rejected', !r.ok && /Incorrect/.test(r.error));

const before = post({ action: 'login_student', phone: '01012345678', password_hash: H('oldpass') });
r = post({ action: 'reset_password', phone: '01012345678', parent_phone: '01198765432', new_password_hash: H('newpass') });
t('reset with right parent number', r.ok, JSON.stringify(r));
t('old session token rotated', r.ok && r.session_token !== before.session_token);
t('old password no longer works', !post({ action: 'login_student', phone: '01012345678', password_hash: H('oldpass') }).ok);
t('new password works', post({ action: 'login_student', phone: '01012345678', password_hash: H('newpass') }).ok);

// reset lockout
let last;
for (let i = 0; i < 6; i++) last = post({ action: 'reset_password', phone: '01012345678', parent_phone: '01100000000', new_password_hash: H('x') });
t('reset locks after 5 wrong parent numbers', !last.ok && /Too many/.test(last.error), JSON.stringify(last));

// --- login brute force ------------------------------------------------------------
post({ action: 'register_student', phone: '01055555555', password_hash: H('secret1'), display_name: 'Omar', year: 'Senior 2', parent_phone: '01166666666' });
let errs = [];
for (let i = 0; i < 9; i++) errs.push(post({ action: 'login_student', phone: '01055555555', password_hash: H('guess' + i) }).error);
t('9 wrong guesses still just "Incorrect password"', errs.every(e => /Incorrect/.test(e)), JSON.stringify(errs));
t('correct password after 9 misses logs in', post({ action: 'login_student', phone: '01055555555', password_hash: H('secret1') }).ok);
errs = [];
for (let i = 0; i < 9; i++) errs.push(post({ action: 'login_student', phone: '01055555555', password_hash: H('again' + i) }).error);
t('counter was cleared by the successful login', errs.every(e => /Incorrect/.test(e)), JSON.stringify(errs));
errs = [];
for (let i = 0; i < 30; i++) errs.push(post({ action: 'login_student', phone: '01055555555', password_hash: H('brute' + i) }).error);
t('lock kicks in (later guesses get "Too many")', /Too many/.test(errs[29]), errs[29]);
t('only ~10 guesses were ever really checked', errs.filter(e => /Incorrect/.test(e)).length <= 10, errs.filter(e => /Incorrect/.test(e)).length);
t('correct password is refused while locked', !post({ action: 'login_student', phone: '01055555555', password_hash: H('secret1') }).ok);
t('a different account is not affected by the lock', post({ action: 'login_student', phone: '01012345678', password_hash: H('newpass') }).ok);
r = post({ action: 'reset_password', phone: '01055555555', parent_phone: '01166666666', new_password_hash: H('fresh99') });
t('forgot-password still works while login is locked', r.ok, JSON.stringify(r));
t('a successful reset lifts the login lock (new password works at once)', post({ action: 'login_student', phone: '01055555555', password_hash: H('fresh99') }).ok);

// --- row growth ---------------------------------------------------------------------
const q = getSS('DATA').getSheetByName('QuizResults');
let firstErr = null;
// simulate tidySheets(): trim to data + 20 spare rows
const tighten = sh => { sh.maxRows = sh.getLastRow() + 20; };
r = post({ action: 'upload_quiz_result', student_id: '01012345678', name: 'Sara', subject: 'english', lesson: 'l1', quiz_title: 'Q', start_time: '2026-09-20T10:00:00Z', end_time: '2026-09-20T10:05:00Z', score: 3, total: 5, questions: [], client_id: 'c0' });
t('quiz upload works', r.ok, JSON.stringify(r));
tighten(getSS('DATA').getSheetByName('QuizResults'));
for (let i = 1; i <= 40; i++) {
  r = post({ action: 'upload_quiz_result', student_id: '01012345678', name: 'Sara', subject: 'english', lesson: 'l1', quiz_title: 'Q', start_time: '2026-09-20T10:0' + (i % 10) + ':00Z', score: 3, total: 5, questions: [], client_id: 'c' + i });
  if (!r.ok && !firstErr) firstErr = 'upload #' + (i + 1) + ': ' + r.error;
}
t('40 more quiz uploads after tidySheets() trimming', !firstErr, firstErr);

// student registration at grid limit
const s = stu.sheets[0]; s.maxRows = s.getLastRow();
r = post({ action: 'register_student', phone: '01099999999', password_hash: H('a1234'), display_name: 'Full Grid' });
t('registration when Students grid is full', r.ok, r.error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
