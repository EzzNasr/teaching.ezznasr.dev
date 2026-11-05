// R-TEAM-LOG-1: the Team page's activity log (p4_admin_list_edit_log) shows changes by teachers AND by assistants,
// each labelled with who made them; the owner's own changes are left out; grading records the real grader.
//   node tests/test_staff_activity_log.js        (run from tools/quiz-maker-v2)
const { makeWorld, APHONE, TPHONE, LPHONE } = require('./test_p4_s4_support');
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 600))); if (!ok) fails++; };
const J = o => JSON.stringify(o);
const tail = p => String(p).replace(/\D/g, '').slice(-10);

const W = makeWorld({ props: { FF_GRADING: '1' } });
const { api, post } = W;
const ctx = api.env.ctx;

// One AuditLog row each: the scoped assistant, the legacy assistant, the teacher and the owner.
ctx.p2_audit(W.A.student_id, 'attendance_center', '', { lesson: 'math/l1', phone: '1000000123', mode: '' }, { lesson: 'math/l1', phone: '1000000123', mode: 'center' });
ctx.p2_audit(W.L.student_id, 'fu2_mark_done', 'G-OWN', '', 'watch|2026-11-01');
ctx.p2_audit(W.T.student_id, 'set_requirement', 'math/l1', '', { quiz_required: false });
ctx.p2_audit(W.owner.student_id, 'attendance_absent', '', '', { phone: '1000000123', mode: 'absent' });
// And a teacher edit in StudentEditLog, the way p4_teacher_update_student writes it.
api.ensure('StudentEditLog', ['ts', 'actor_kind', 'actor_id', 'student_old', 'student_new', 'field', 'old_value', 'new_value'])
  .appendRow(['2000-01-01 10:00:00', 'teacher', W.T.student_id, '01000000555', '01000000555', 'name', 'Old', 'New']);

const r = post(Object.assign({ action: 'p4_admin_list_edit_log', limit: 50 }, W.owner));
const rows = (r && r.rows) || [];
t('the owner can read the log', r && r.ok === true, J(r));
const asst = rows.filter(x => x.actor_kind === 'assistant');
t('assistants\' changes are listed (scoped and legacy)', asst.length === 2 && asst.some(x => tail(x.actor_id) === tail(APHONE)) && asst.some(x => tail(x.actor_id) === tail(LPHONE)), J(rows));
t('...with the assistant\'s name', asst.some(x => x.actor_name === 'Assistant Of Samy'), J(asst));
const teach = rows.filter(x => x.actor_kind === 'teacher');
t('teachers\' changes are listed: the student edit and the AuditLog row', teach.length === 2 && teach.some(x => x.field === 'name') && teach.some(x => x.field === 'set_requirement'), J(teach));
t('the owner\'s own changes are not listed', !rows.some(x => x.field === 'attendance_absent'), J(rows));
t('an attendance row names the student from the logged phone', asst.some(x => x.field === 'attendance_center' && /1000000123/.test(x.student_old)), J(asst));
t('newest first', rows.every((x, i) => i === 0 || rows[i - 1].ts >= x.ts), J(rows.map(x => x.ts)));
t('a non-owner cannot read it', post(Object.assign({ action: 'p4_admin_list_edit_log' }, W.A)).ok === false);
t('limit is honoured', (post(Object.assign({ action: 'p4_admin_list_edit_log', limit: 2 }, W.owner)).rows || []).length === 2);

// Grading: the AuditLog row records who graded (was always "admin").
ctx._gAudit('grade_written', { submission_id: 'S1', question_id: 'w1' }, { awarded: null }, { awarded: 2 }, { student_id: W.A.student_id, session_token: 'x' });
const auditWho = () => { const sh = ctx._dataSs().getSheetByName('AuditLog'), n = sh.getLastRow(); return String(sh.get(n, 2)); };
t('a grade is logged under the phone of whoever graded it', tail(auditWho()) === tail(APHONE), auditWho());
ctx._gAudit('grade_written', { submission_id: 'S2', question_id: 'w1' }, {}, {}, { token: 'tok' });
t('a grade from the Quiz Maker token still logs as admin', auditWho() === 'admin', auditWho());
ctx._gAudit('grade_written', { submission_id: 'S3', question_id: 'w1' }, {}, {}, { student_id: W.A.student_id, session_token: 'x' });
const r2 = post(Object.assign({ action: 'p4_admin_list_edit_log', limit: 50 }, W.owner));
t('...and the assistant\'s grade then shows in the log', (r2.rows || []).some(x => x.field === 'grade_written' && x.actor_kind === 'assistant'), J(r2.rows));

console.log('\n' + (fails ? fails + ' failed' : 'all passed'));
process.exit(fails ? 1 : 0);
