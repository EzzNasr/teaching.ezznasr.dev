// R-022: every state change the teacher makes leaves an AuditLog row (who, action, target, before, after).
// Cross-feature coverage: grants, revokes, quiz lock, group grants, center decisions, requirements, grading, migration.
// Usage: node tests/test_R022_audit_coverage.js
const { makeEnv, LESSONS } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const J = o => JSON.stringify(o).slice(0, 240);
const f = makeEnv(); f.env.props.FF_GRADING = '1';
const log = () => { const sh = f.getSS('DATA').getSheetByName('AuditLog'); const o = []; if (!sh) return o; for (let r = 2; r <= sh.getLastRow(); r++) o.push({ at: sh.get(r, 1), who: sh.get(r, 2), action: sh.get(r, 3), target: sh.get(r, 4), before: sh.get(r, 5), after: sh.get(r, 6) }); return o; };
const T = f.TOK, L = LESSONS.L2.now;
const sara = f.P('sara'), omar = f.P('omar');
const did = (name, fn, action) => {
  const n0 = log().length; const r = fn();
  const added = log().slice(n0);
  t(name + ': action succeeds', r && r.ok === true, J(r));
  t(name + ': one audit row "' + action + '"', added.some(x => x.action === action), J(added));
  return added;
};
did('grant video access', () => f.post({ action: 'admin_grant_access', phone: sara, scope: L, never: true, ...T }), 'admin_grant_access');
did('revoke video access', () => f.post({ action: 'admin_revoke_access', phone: sara, scope: L, ...T }), 'admin_revoke_access');
did('grant quiz access', () => f.post({ action: 'admin_grant_quiz_access', phone: sara, lesson: L, never: true, ...T }), 'admin_grant_quiz_access');
did('revoke quiz access', () => f.post({ action: 'admin_revoke_quiz_access', phone: sara, lesson: L, ...T }), 'admin_revoke_quiz_access');
f.group('Sat 5pm', [sara, omar]);
did('group grant', () => f.post({ action: 'admin_group_grant_access', group: 'Sat 5pm', scope: L, never: true, ...T }), 'admin_group_grant_access');
did('group revoke', () => f.post({ action: 'admin_group_revoke_access', group: 'Sat 5pm', scope: L, ...T }), 'admin_group_revoke_access');
did('lock a quiz', () => f.post({ action: 'admin_set_quiz_lock', lesson: L, locked: true, ...T }), 'admin_set_quiz_lock');
{
  const n0 = log().length;
  const a = f.post({ action: 'admin_followup_set_attendance', lesson: L, items: [{ phone: omar, mode: 'center' }], ...T });
  t('center decision succeeds', a.ok === true, J(a));
  t('center decision is audited (attendance_*)', log().slice(n0).some(x => /^attendance_/.test(x.action)), J(log().slice(n0)));
}
// the named S2 action: find whatever name S2 writes for a center decision and a requirement change
const n1 = log().length;
const rq = f.post({ action: 'admin_set_requirement', lesson: L, quiz_required: false, homework_required: true, ...T });
t('requirement change succeeds', rq.ok === true, J(rq));
t('requirement change is audited', log().length > n1 && log().slice(n1).some(x => /requirement/.test(x.action)), J(log().slice(n1)));
// who: desktop token vs admin session
const lg = f.post({ action: 'login_student', phone: '01000000001', password_hash: f.H('a') });
const n2 = log().length;
f.post({ action: 'admin_grant_access', phone: omar, scope: L, never: true, student_id: '01000000001', session_token: lg.session_token });
const a2 = log().slice(n2).find(x => x.action === 'admin_grant_access');
t('who = admin phone for a logged-in admin session', !!a2 && a2.who.endsWith('1000000001'), J(a2));
const a1 = log().find(x => x.action === 'admin_grant_access');
t('who = "token" for the desktop app', !!a1 && a1.who === 'token', J(a1));
// a FAILED action is not logged as done
const n3 = log().length;
const bad = f.post({ action: 'admin_grant_access', phone: '01099999999', scope: L, never: true, token: 'WRONG' });
t('failed (unauthorised) action leaves no audit row', bad.ok === false && log().length === n3, J(log().slice(n3)));
// migration dry run vs apply
f.addEnt(sara, LESSONS.L2.old, '', 'manual');   // an old-key row, so the migration has something to change
const n4 = log().length;
f.post({ action: 'admin_migrate_lesson_keys', dry_run: true, ...T });
t('migration dry run writes no audit row', log().length === n4);
f.post({ action: 'admin_migrate_lesson_keys', dry_run: false, ...T });
t('migration apply writes an audit row', log().slice(n4).some(x => x.action === 'migrate_lesson_keys'), J(log().slice(n4)));
// one shared log with one header
const sh = f.getSS('DATA').getSheetByName('AuditLog'); let hdrs = 0; for (let r = 1; r <= sh.getLastRow(); r++) if (sh.get(r, 1) === 'at') hdrs++;
t('one AuditLog, one header row, DATA spreadsheet only', hdrs === 1 && !f.getSS('STU').getSheetByName('AuditLog'));
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
