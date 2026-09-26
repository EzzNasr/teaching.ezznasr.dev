// Smoke test for the quiz-access override layer added on top of the Quizzes gate:
// admin_grant/revoke_quiz_access (single student) and admin_group_grant/revoke_quiz_access
// (whole group), including auto-expiry. Run:
//   node tests/test_quiz_access_override.js apps_script/Code.gs
const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const LESSON = 'programming/other/functions';
const env = load(path);
const { post, getSS } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 8; c++) if (sh.get(1, c) === name) return c; return 0; };

const reg = (ph, pw, nm) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const Bm = reg('01000000003', 'c', 'Omar');
const stu = getSS('STU').getSheetByName('Students');
stu.set(2, colOf(stu, 'is_admin'), true);
const TOK = { token: 'tok' };
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const SA = cr(A), SB = cr(Bm);

const state = (lesson, sid) => post(Object.assign({ action: 'get_quiz_state', lesson }, sid ? { student_id: sid } : {}));
const setLock = (lesson, locked) => post(Object.assign({ action: 'admin_set_quiz_lock', lesson, locked }, TOK));
const submit = (creds, lesson, clientId) => post({ action: 'upload_quiz_result', student_id: creds.student_id, lesson, subject: 'x', quiz_title: 'Q', start_time: '2026-01-01 10:00:00', end_time: '2026-01-01 10:05:00', score: 1, total: 1, questions: [], client_id: clientId });

// 1. lock the lesson's quiz globally
{
  let r = setLock(LESSON, true);
  t('quiz locked globally', r.ok && r.locked === true, JSON.stringify(r));
  r = submit(SA, LESSON, 'c1');
  t('locked out normally', !r.ok, JSON.stringify(r));
}

// 2. grant one student a quiz-access override, no explicit term -> uses default (never, since no DEFAULT_ACCESS_DAYS)
{
  let r = post(Object.assign({ action: 'admin_grant_quiz_access', phone: A.student_id, lesson: LESSON }, TOK));
  t('single-student grant succeeds', r.ok && r.lesson === LESSON, JSON.stringify(r));
  r = state(LESSON, A.student_id);
  t('get_quiz_state: open for the granted student', r.ok && r.locked === false, JSON.stringify(r));
  t('get_quiz_state: still globally locked', r.locked_globally === true, JSON.stringify(r));
  r = state(LESSON, Bm.student_id);
  t('get_quiz_state: still locked for a different student', r.ok && r.locked === true, JSON.stringify(r));
  r = submit(SA, LESSON, 'c2');
  t('granted student can submit even while globally locked', r.ok, JSON.stringify(r));
  r = submit(SB, LESSON, 'c3');
  t('ungranted student is still blocked', !r.ok, JSON.stringify(r));
}

// 3. revoke it
{
  let r = post(Object.assign({ action: 'admin_revoke_quiz_access', phone: A.student_id, lesson: LESSON }, TOK));
  t('revoke succeeds', r.ok && r.removed === 1, JSON.stringify(r));
  r = submit(SA, LESSON, 'c4');
  t('revoked student is locked out again', !r.ok, JSON.stringify(r));
  r = post(Object.assign({ action: 'admin_revoke_quiz_access', phone: A.student_id, lesson: LESSON }, TOK));
  t('revoking again is a clean error, not a crash', !r.ok, JSON.stringify(r));
}

// 4. expiry: a 1-day grant, then travel forward via a manually-edited sheet row
{
  let r = post(Object.assign({ action: 'admin_grant_quiz_access', phone: Bm.student_id, lesson: LESSON, expires_at: '2020-01-01' }, TOK));
  t('grant with an already-past date succeeds (teacher error, not our job to block)', r.ok, JSON.stringify(r));
  r = submit(SB, LESSON, 'c5');
  t('an already-expired override does not open the quiz', !r.ok, JSON.stringify(r));
  r = state(LESSON, Bm.student_id);
  t('get_quiz_state agrees it is locked (auto-relocked, no manual step)', r.locked === true, JSON.stringify(r));
}

// 5. group grant/revoke, mirroring the video-access group flow
{
  let r = post(Object.assign({ action: 'admin_group_add', group: 'G1', phone: A.student_id }, TOK));
  t('group created', r.ok, JSON.stringify(r));
  r = post(Object.assign({ action: 'admin_group_add', group: 'G1', phone: Bm.student_id }, TOK));
  t('second member added', r.ok, JSON.stringify(r));
  r = post(Object.assign({ action: 'admin_group_grant_quiz_access', group: 'G1', lesson: LESSON, days: 30 }, TOK));
  t('group grant applies to both members', r.ok && r.count === 2, JSON.stringify(r));
  t('sara can submit again via the group grant', submit(SA, LESSON, 'c6').ok);
  t('omar can submit again via the group grant', submit(SB, LESSON, 'c7').ok);
  r = post(Object.assign({ action: 'admin_group_revoke_quiz_access', group: 'G1', lesson: LESSON }, TOK));
  t('group revoke removes both', r.ok && r.removed_students === 2, JSON.stringify(r));
  t('sara locked out again after group revoke', !submit(SA, LESSON, 'c8').ok);
  t('omar locked out again after group revoke', !submit(SB, LESSON, 'c9').ok);
}

// 6. overview includes the quiz_access rows and doesn't crash without GITHUB_REPO set
{
  post(Object.assign({ action: 'admin_grant_quiz_access', phone: A.student_id, lesson: LESSON }, TOK));
  let r = post(Object.assign({ action: 'admin_access_overview' }, TOK));
  t('overview call still succeeds with no GITHUB_REPO configured', r.ok, JSON.stringify(r));
  t('overview soft-fails lesson listing instead of throwing', Array.isArray(r.all_lessons) && r.all_lessons.length === 0 && !!r.lessons_error, JSON.stringify({ all_lessons: r.all_lessons, lessons_error: r.lessons_error }));
  t('overview includes the quiz_access row', Array.isArray(r.quiz_access) && r.quiz_access.some(x => x.lesson === LESSON && x.phone === A.student_id && x.state === 'active'), JSON.stringify(r.quiz_access));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
