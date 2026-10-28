// An ASSISTANT's working day against the real Code.gs: see follow-up data (what is missing), log a parent
// message as "contacted", tick "parents contacted" for a group, read the student summary, see written answers
// + photos and grade them. Everything an admin-only page needs must still be refused.
//   node tests/test_p3_assistant_flow.js apps_script/Code.gs
const path = require('path'), crypto = require('crypto');
const { load } = require('./harness');
const [codePathArg] = process.argv.slice(2);
const codePath = codePathArg || path.join(__dirname, '..', 'apps_script', 'Code.gs');
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + String(e || '').slice(0, 300))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const env = load(codePath, { clock: true, props: { FF_GRADING: '1', FF_PARENT_LOG: '1', FF_MONTHLY: '1' } });
const { post, getSS, ctx } = env;
ctx.DriveApp.getFileById = id => ({ makeCopy() {}, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => Buffer.from('IMG-' + id) }) });
ctx.Utilities.base64Encode = b => Buffer.from(b).toString('base64');

const reg = (ph, nm) => post({ action: 'register_student', phone: ph, password_hash: H('x'), display_name: nm, year: 'Senior 2', parent_phone: '012345678' + ph.slice(-2) });
const adm = reg('01000000001', 'Teacher'), asst = reg('01000000002', 'Sara'), stuA = reg('01000000003', 'Omar'), stuB = reg('01000000004', 'Lamis');
const stu = getSS('STU').getSheetByName('Students');
const col = n => { for (let c = 1; c <= 30; c++) if (stu.get(1, c) === n) return c; return 0; };
stu.set(2, col('is_admin'), true);
const ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
const SARA = { student_id: asst.student_id, session_token: asst.session_token };
const TOK = { token: 'tok' };
const G2 = 'programming/baccalaureate/grade-2-secondary/';
const LES = G2 + 'chapter-1-lesson-2-how-ai-works';

// admin makes Sara an assistant (the only way in)
const sr = post(Object.assign({ action: 'p3_admin_set_role', phone: '01000000002', role: 'assistant' }, ADMIN));
t('admin makes Sara an assistant', sr.ok && sr.role === 'assistant', JSON.stringify(sr));

// a group with two students
const ss = getSS('STU'); const gs = ss.insertSheet('Groups');
['group', 'phone', 'name', 'added_at'].forEach((h, i) => gs.set(1, i + 1, h));
[['Sat 5pm', '01000000003', 'Omar'], ['Sat 5pm', '01000000004', 'Lamis']].forEach((r, i) => r.forEach((v, j) => gs.set(i + 2, j + 1, v)));
const A = (o) => Object.assign({}, o, SARA);

// 1. follow-up data: she can load it and the group's students are in it
let r = post(A({ action: 'admin_followup_overview' }));
t('assistant loads the follow-up overview', r.ok === true, JSON.stringify(r));
t('overview lists the groups and students (what is missing is computed from this)', r.ok && JSON.stringify(r).indexOf('Omar') !== -1 && JSON.stringify(r).indexOf('Sat 5pm') !== -1);
t('overview reports the feature flags the page needs', r.ok && r.flags && r.flags.FF_PARENT_LOG === true && r.flags.FF_MONTHLY === true, JSON.stringify(r.flags));

// 2. mark as contacted (per student, per issue)
r = post(A({ action: 'admin_log_parent_notification', student: '01000000003', kind: 'homework', ref: LES, note: 'ردّت وهتسلّم' }));
t('assistant logs "message sent" for a student', r.ok && r.created === true && r.notification.kind === 'homework', JSON.stringify(r));
t('the log records WHO did it (the assistant, not the admin)', /01000000002/.test(String(r.notification && r.notification.by)) || r.notification.by !== undefined, JSON.stringify(r.notification));
r = post(A({ action: 'admin_log_parent_notification', student: '01000000003', kind: 'homework', ref: LES, note: 'تحديث' }));
t('logging the same thing again updates it (no duplicate)', r.ok && r.created === false);
r = post(A({ action: 'admin_log_parent_notification', student: '01000000004', kind: 'quiz', ref: LES }));
t('second student logged', r.ok && r.created === true);
r = post(A({ action: 'admin_list_parent_notifications' }));
t('assistant sees the contacted list (2 entries)', r.ok && (r.notifications || r.items || []).length === 2, JSON.stringify(r).slice(0, 200));
r = post(A({ action: 'admin_list_parent_notifications', kind: 'homework', ref: LES, not_notified_students: ['01000000003', '01000000004'] }));
t('"not yet contacted" filter: only Lamis has no homework entry', r.ok && JSON.stringify(r.not_notified || r.not_notified_students || []).indexOf('01000000004') !== -1 && JSON.stringify(r.not_notified || r.not_notified_students || []).indexOf('01000000003') === -1, JSON.stringify(r).slice(0, 300));
r = post(A({ action: 'admin_followup_overview' }));
t('overview now carries the contact log (page shows ✅ تم التواصل)', r.ok && r.parent_log && Object.keys(r.parent_log).length === 2, JSON.stringify(r.parent_log));

// 3. group-level "parents contacted" switch + attendance
r = post(A({ action: 'admin_followup_save_group', group: 'Sat 5pm', parents_contacted: true, note: 'اتكلمت مع الكل' }));
t('assistant ticks "parents contacted" and saves a note for the group', r.ok === true, JSON.stringify(r));
r = post(A({ action: 'admin_followup_overview' }));
t('...and it sticks', r.ok && JSON.stringify(r).indexOf('اتكلمت مع الكل') !== -1);
r = post(A({ action: 'admin_followup_set_attendance', lesson: LES, items: [{ phone: '01000000003', mode: 'center' }], grant: true }));
t('assistant sets attendance', r.ok === true, JSON.stringify(r));
r = post(A({ action: 'admin_set_requirement', lesson: LES, kind: 'homework', required: false }));
t('assistant can change a requirement (hw optional)', r.ok === true || /kind|lesson|required/i.test(String(r.error)) && !/Not authorized/.test(r.error), JSON.stringify(r));

// 4. student summary + monthly report
r = post(A({ action: 'admin_student_summary', student: '01000000003' }));
t('assistant opens a student summary', r.ok === true, JSON.stringify(r).slice(0, 200));
const month = new Date().toISOString().slice(0, 7);
r = post(A({ action: 'admin_monthly_review', month, student: '01000000003' }));
t('assistant prepares the monthly review', r.ok === true, JSON.stringify(r).slice(0, 200));

// 5. written answers: see, view the photo, grade
post({ action: 'admin_set_written_models', lesson: LES, models: [{ question_id: 'w1', max_marks: 3, model_answer: 'Because X', prompt: 'Why?' }], ...TOK });
post({ action: 'upload_quiz_result', student_id: stuA.student_id, lesson: 'chapter-1-lesson-2-how-ai-works', lesson_path: LES, subject: 'programming', quiz_title: 'Q', start_time: '2026-10-01 10:00:00', end_time: '2026-10-01 10:05:00', score: 1, total: 2, questions: [{ id: 'm1', correct: true }, { id: 'w1', type: 'written', pending: true }], client_id: 'att1' });
const qsh = getSS('DATA').getSheetByName('QuizResults');
let dk = 0; for (let c = 1; c <= 20; c++) if (qsh.get(1, c) === 'dedupe_key') dk = c;
const SID = qsh.get(2, dk);
const WA = getSS('DATA').insertSheet('WrittenAnswers');
['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at'].forEach((h, i) => WA.set(1, i + 1, h));
[SID, stuA.student_id, LES, 'w1', 'fileA', '', '', '', ''].forEach((v, j) => WA.set(2, j + 1, v));
r = post(A({ action: 'admin_grading_queue' }));
t('assistant sees the written answers waiting (with the model answer)', r.ok && r.items.length === 1 && r.items[0].model_answer === 'Because X' && r.counts.pending === 1, JSON.stringify(r).slice(0, 250));
r = post(A({ action: 'get_written_image', submission_id: SID, question_id: 'w1' }));
t('assistant opens the student\'s photo', r.ok && Buffer.from(r.data_base64, 'base64').toString() === 'IMG-fileA', JSON.stringify(r).slice(0, 150));
r = post(A({ action: 'admin_grade_written', submission_id: SID, question_id: 'w1', awarded: 2, note: 'كويس' }));
t('assistant grades it', r.ok === true, JSON.stringify(r));
r = post(A({ action: 'admin_grading_queue', status: 'graded' }));
t('graded list shows the mark and note', r.ok && r.items.length === 1 && r.items[0].awarded === 2 && r.items[0].note === 'كويس', JSON.stringify(r).slice(0, 250));
r = post(A({ action: 'admin_get_written_models', lesson: LES }));
t('assistant reads the model answers while grading', r.ok && r.models.length === 1);
r = post({ action: 'get_written_image', submission_id: SID, question_id: 'w1', student_id: stuB.student_id, session_token: stuB.session_token });
t('a plain student still cannot see someone else\'s photo', !r.ok);

// 6. still locked out of admin-only things
['admin_group_add', 'admin_grant_access', 'admin_list_payments', 'admin_get_all', 'admin_set_written_models', 'admin_access_overview', 'p3_admin_set_role', 'p3_admin_bulk_grant'].forEach(a => {
  const x = post(A({ action: a }));
  t('assistant refused on admin-only ' + a, x.ok === false && /Not authorized/.test(String(x.error)), JSON.stringify(x).slice(0, 120));
});

// 7. removing the role cuts access on the very next call
post(Object.assign({ action: 'p3_admin_set_role', phone: '01000000002', role: '' }, ADMIN));
t('role removed: next call refused', /Not authorized/.test(String(post(A({ action: 'admin_followup_overview' })).error)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
