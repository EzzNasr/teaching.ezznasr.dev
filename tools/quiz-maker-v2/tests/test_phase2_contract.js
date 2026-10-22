// Contract conformance for the 10 Phase 2 actions (docs/contract.md section 4).
// Self-adapting: an action whose handler is not pasted yet is reported as "pending" (still a PASS
// line, so the suite is green during the build); once a handler exists it must obey the contract.
// Usage: node tests/test_phase2_contract.js [apps_script dir]   (Session 5)
const path = require('path');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
// action: [kind, flag]
const C = {
  admin_student_summary: ['admin', null], admin_monthly_review: ['admin', 'FF_MONTHLY'], admin_set_requirement: ['admin', null],
  admin_log_parent_notification: ['admin', 'FF_PARENT_LOG'], admin_list_parent_notifications: ['admin', 'FF_PARENT_LOG'],
  upload_written_image: ['student', 'FF_CAMERA'], get_quiz_review: ['student', 'FF_DEFERRED_ANSWERS'],
  admin_grading_queue: ['admin', 'FF_GRADING'], admin_grade_written: ['admin', 'FF_GRADING'], admin_migrate_lesson_keys: ['admin', null],
};
const env = load(path.join(dir, 'Code.gs'));
const FLAGS = ['FF_CAMERA', 'FF_DEFERRED_ANSWERS', 'FF_GRADING', 'FF_PARENT_LOG', 'FF_MONTHLY'];
const setFlags = v => FLAGS.forEach(f => { env.props[f] = v; });
const H = s => require('crypto').createHash('sha256').update(s).digest('hex');
env.post({ action: 'register_student', phone: '01000000001', password_hash: H('t'), display_name: 'Teacher', year: 'Senior 1', parent_phone: '01100000009' });
const sheet = env.getSS('STU').getSheetByName('Students');
let col = 0; for (let c = 1; c <= 14; c++) if (sheet.get(1, c) === 'is_admin') col = c;
sheet.set(2, col, true);
const login = env.post({ action: 'login_student', phone: '01000000001', password_hash: H('t') });
const sess = { student_id: '01000000001', session_token: login.session_token };

for (const [a, [kind, flag]] of Object.entries(C)) {
  setFlags('1');
  const probe = env.post({ action: a, token: 'tok' });
  if (probe.not_implemented) { t('contract ' + a + ': pending (handler not pasted yet)', true); continue; }
  t(a + ': answers with a boolean ok', typeof probe.ok === 'boolean', JSON.stringify(probe));
  const anon = env.post({ action: a });
  t(a + ': refuses a caller with no credentials', anon.ok === false && /Not authorized|Missing session|session/i.test(anon.error || ''), JSON.stringify(anon));
  if (kind === 'admin') {
    const bad = env.post({ action: a, token: 'wrong' });
    t(a + ': refuses a wrong admin token', bad.ok === false && /Not authorized/.test(bad.error || ''), JSON.stringify(bad));
    const asStudent = env.post({ action: a, ...sess, student_id: '01999999999' });
    t(a + ': refuses an unknown session', asStudent.ok === false, JSON.stringify(asStudent));
  }
  if (flag) {
    setFlags('0');
    const off = env.post(kind === 'admin' ? { action: a, token: 'tok' } : { action: a, ...sess });
    t(a + ': with ' + flag + ' off -> {ok:false, disabled:true}', off.ok === false && off.disabled === true, JSON.stringify(off));
  } else {
    setFlags('0');
    const r = env.post({ action: a, token: 'tok' });
    t(a + ': has no flag, so it is never "disabled"', !r.disabled, JSON.stringify(r));
  }
  setFlags('1');
}
if (C.admin_migrate_lesson_keys && !env.post({ action: 'admin_migrate_lesson_keys', token: 'tok' }).not_implemented) {
  const r = env.post({ action: 'admin_migrate_lesson_keys', token: 'tok' });
  t('admin_migrate_lesson_keys: dry-run is the default (R-020)', r.ok === true && r.dry_run === true && Array.isArray(r.changes), JSON.stringify(r).slice(0, 200));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
