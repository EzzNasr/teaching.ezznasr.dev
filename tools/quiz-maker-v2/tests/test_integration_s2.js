// Integration seams for Session 2 (R-I02): router wiring, fallback when the file is not pasted,
// feature-flag shape, shared AuditLog, and the admin-session identity rule (target is `student`, never `student_id`).
// Usage: node tests/test_integration_s2.js [apps_script dir]
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
const { makeEnv, LESSONS } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const J = o => JSON.stringify(o).slice(0, 220);

// 1. wired: the two existing actions now answer with the Phase 2 fields
{
  const f = makeEnv(), o = f.overview();
  t('router: admin_followup_overview is served by S2 (flags + week + requirements present)', o.ok && o.flags && o.week && o.week.start && o.requirements !== undefined, J(Object.keys(o)));
  const a = f.post({ action: 'admin_followup_set_attendance', token: 'tok', lesson: LESSONS.L2.now, items: [{ phone: f.P('sara'), mode: 'online' }] });
  t('router: admin_followup_set_attendance still works (single / online needs no week confirmation)', a.ok === true, J(a));
}
// 2. not pasted: the OLD handlers answer, nothing regresses to "not implemented"
{
  const env = load([path.join(dir, 'Code.gs'), path.join(dir, 'Phase2_Core.gs')]);
  const H = s => require('crypto').createHash('sha256').update(s).digest('hex');
  env.post({ action: 'register_student', phone: '01000000001', password_hash: H('a'), display_name: 'T', year: 'Senior 2', parent_phone: '01100000009' });
  const o = env.post({ action: 'admin_followup_overview', token: 'tok' });
  t('fallback: without Phase2_Followup.gs the old overview still answers', o.ok === true && !o.not_implemented, J(o));
  const s = env.post({ action: 'admin_student_summary', token: 'tok', student: '01000000001' });
  t('fallback: a Phase 2 only action says "not implemented" (and nothing else breaks)', s.ok === false && s.not_implemented === true, J(s));
}
// 3. flags: off => {disabled:true}, on => works (TRUE, 1, true)
{
  const f = makeEnv();
  for (const [a, flag, extra] of [['admin_monthly_review', 'FF_MONTHLY', { month: '2026-10', student: f.P('sara') }], ['admin_list_parent_notifications', 'FF_PARENT_LOG', {}], ['admin_log_parent_notification', 'FF_PARENT_LOG', { student: f.P('sara'), kind: 'quiz', ref: LESSONS.L2.now }]]) {
    delete f.env.props[flag];
    const off = f.post(Object.assign({ action: a, token: 'tok' }, extra));
    t(a + ': flag off -> {ok:false, disabled:true}', off.ok === false && off.disabled === true, J(off));
    for (const v of ['TRUE', '1', 'true']) { f.env.props[flag] = v; const on = f.post(Object.assign({ action: a, token: 'tok' }, extra)); t(a + ': flag ' + v + ' -> works', on.ok === true, J(on)); }
    delete f.env.props[flag];
  }
  t('admin_student_summary has no flag', f.post({ action: 'admin_student_summary', token: 'tok', student: f.P('sara') }).ok === true);
}
// 4. identity rule (contract v1.3): with an ADMIN SESSION the page sends student_id = the admin, the target in `student`
{
  const f = makeEnv(); f.env.props.FF_PARENT_LOG = '1';
  const login = f.post({ action: 'login_student', phone: '01000000001', password_hash: f.H('a') });
  const adm = { student_id: '01000000001', session_token: login.session_token };
  const sum = f.post(Object.assign({ action: 'admin_student_summary', student: f.P('sara') }, adm));
  t('summary with an admin session targets `student`, not the admin id', sum.ok === true && String(sum.student && (sum.student.phone || sum.student)).endsWith(f.short('sara')) || (sum.ok && JSON.stringify(sum).includes('Sara')), J(sum));
  const log = f.post(Object.assign({ action: 'admin_log_parent_notification', student: f.P('omar'), kind: 'custom', ref: 'x1', note: 'n' }, adm));
  const lst = f.post(Object.assign({ action: 'admin_list_parent_notifications', student: f.P('omar') }, adm));
  t('parent log written and listed for the TARGET student with an admin session', log.ok && lst.ok && lst.notifications.length === 1 && String(lst.notifications[0].student) === f.P('omar'), J([log, lst]));
  const st = f.post(Object.assign({ action: 'admin_student_summary', student: f.P('sara') }, f.S('sara')));
  t('a student session is refused on every S2 admin action', st.ok === false && /Not authorized/.test(st.error || ''), J(st));
  // 5. one shared AuditLog, contract header, who = admin phone for a session and "token" for the desktop app
  f.post({ action: 'admin_set_requirement', token: 'tok', lesson: LESSONS.L2.now, quiz_required: false });
  f.post(Object.assign({ action: 'admin_set_requirement', lesson: LESSONS.L3.now, homework_required: false }, adm));
  const sh = f.getSS('DATA').getSheetByName('AuditLog'), hdr = [1, 2, 3, 4, 5, 6].map(c => sh.get(1, c));
  t('AuditLog: one header (at, who, action, target, before, after) in the DATA spreadsheet', JSON.stringify(hdr) === JSON.stringify(['at', 'who', 'action', 'target', 'before', 'after']), J(hdr));
  const who = []; for (let r = 2; r <= sh.getLastRow(); r++) if (sh.get(r, 3) === 'set_requirement') who.push(String(sh.get(r, 2)));
  t('AuditLog: who is "token" for the desktop app and the admin phone for a session', who.length === 2 && who[0] === 'token' && who[1].endsWith('1000000001'), J(who));
  t('AuditLog: not also written to the Students spreadsheet (no second log)', !f.getSS('STU').getSheetByName('AuditLog'));
}
// 6. old-key lesson in a requirement is stored under the canonical key (shared p2k_canon, not a private list)
{
  const f = makeEnv(), r = f.post({ action: 'admin_set_requirement', token: 'tok', lesson: LESSONS.L3.old, quiz_required: false });
  const rows = f.rows('LessonRequirements');
  t('requirement for a typo-key lesson is stored under the canonical key', r.ok && rows.length === 1 && rows[0].lesson === LESSONS.L3.now, J(rows));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
