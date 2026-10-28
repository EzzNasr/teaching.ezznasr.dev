// Phase 3 / S3 - assistant role: allow-list guard, role column, admin-only role management.
// Usage: node tests/test_p3_roles.js
const fs = require('fs'), path = require('path');
const { load } = require('./harness');
const { makeEnv } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const APPS = path.join(__dirname, '..', 'apps_script');
const CODE = path.join(APPS, 'Code.gs'), P3 = path.join(APPS, 'Phase3_Roles.gs');
const LISTED = ['admin_followup_overview', 'admin_followup_set_attendance', 'admin_followup_save_group', 'admin_followup_save_templates',
  'admin_student_summary', 'admin_monthly_review', 'admin_set_requirement', 'admin_log_parent_notification', 'admin_list_parent_notifications',
  'admin_grading_queue', 'admin_grade_written', 'admin_get_written_models', 'get_written_image'];
const ADMIN_ONLY = ['admin_grant_access', 'admin_decide_payment', 'admin_set_lesson_lock', 'admin_group_add', 'admin_migrate_lesson_keys',
  'admin_get_all', 'admin_list_payments', 'admin_access_overview', 'admin_revoke_access', 'admin_set_written_models', 'admin_list_groups', 'admin_set_video', 'admin_set_quiz_lock'];
const NOT_AUTH = r => r && r.ok === false && r.error === 'Not authorized.';

// Build the usual Phase 2 env, then load Phase3_Roles.gs into the SAME context (Apps Script: one global scope).
function build() {
  const api = makeEnv();
  require('vm').runInContext(fs.readFileSync(P3, 'utf8'), api.env.ctx, { filename: 'Phase3_Roles.gs' });
  const ctx = api.env.ctx;
  const call = (fn, payload) => { try { return ctx[fn](payload); } catch (e) { return { ok: false, error: e.message }; } };
  api.call = call;
  api.setRole = (phone, role) => call('p3_admin_set_role', Object.assign({ phone, role }, api.ADMIN));
  return api;
}

// ---- allow-list is exactly the frozen contract
{
  const api = build();
  t('P3_STAFF_ALLOW is exactly the 13 contract actions', JSON.stringify(api.env.ctx.P3_STAFF_ALLOW.slice().sort()) === JSON.stringify(LISTED.slice().sort()), JSON.stringify(api.env.ctx.P3_STAFF_ALLOW));
}

// ---- before any role exists: nobody is an assistant, nothing changes
{
  const api = build();
  const r = api.post(Object.assign({ action: 'admin_followup_overview' }, api.S('sara')));
  t('no role column yet: a plain student is still refused', NOT_AUTH(r), JSON.stringify(r));
  t('admin session still works on a listed action', api.post(Object.assign({ action: 'admin_followup_overview' }, api.ADMIN)).error !== 'Not authorized.');
  t('p3_session_role: student / admin', api.env.ctx.p3_session_role(api.S('sara')) === 'student' && api.env.ctx.p3_session_role(api.ADMIN) === 'admin');
  t('p3_session_role: none and stale', api.env.ctx.p3_session_role({}) === 'none' && api.env.ctx.p3_session_role({ student_id: api.P('sara'), session_token: 'old' }) === 'stale');
}

// ---- granting the role
{
  const api = build();
  const r = api.setRole(api.P('sara'), 'assistant');
  t('admin can make an assistant', r.ok === true && r.role === 'assistant' && r.changed === true && r.name === 'Sara Mahmoud', JSON.stringify(r));
  const stu = api.tab('Students');
  const isAdminCol = api.colOf(stu, 'is_admin'), roleCol = api.colOf(stu, 'role');
  t('role column created by the call', roleCol > 0);
  t('is_admin stays blank for the assistant', stu.get(3, isAdminCol) === '' || stu.get(3, isAdminCol) === false || stu.get(3, isAdminCol) == null, String(stu.get(3, isAdminCol)));
  t('only the target row got a role', stu.get(3, roleCol) === 'assistant' && ['', undefined, null].includes(stu.get(2, roleCol)) && ['', undefined, null].includes(stu.get(4, roleCol)));
  t('p3_session_role says assistant', api.env.ctx.p3_session_role(api.S('sara')) === 'assistant');
  t('re-granting is a no-op (changed:false)', api.setRole(api.P('sara'), 'assistant').changed === false);
  const sh = api.getSS('DATA').getSheetByName('AuditLog'); const au = []; for (let r = 2; r <= sh.getLastRow(); r++) au.push({ action: sh.get(r, 3), target: sh.get(r, 4), before: sh.get(r, 5), after: sh.get(r, 6) });
  t('audit row written once, with before/after', au.filter(x => x.action === 'p3_admin_set_role').length === 1 && /assistant/.test(au[au.length - 1].after), JSON.stringify(au));

  // every listed action gets past the guard
  for (const a of LISTED) {
    const res = api.post(Object.assign({ action: a }, api.S('sara')));
    t('assistant passes the guard on ' + a, !NOT_AUTH(res), JSON.stringify(res).slice(0, 160));
  }
  // and every other admin action is refused with the same message
  for (const a of ADMIN_ONLY) {
    const res = api.post(Object.assign({ action: a }, api.S('sara')));
    t('assistant refused on ' + a, NOT_AUTH(res) || /Not authorized/.test(String(res.error)), JSON.stringify(res).slice(0, 160));
  }
  // a plain student is still refused on listed actions
  t('plain student refused on a listed action', NOT_AUTH(api.post(Object.assign({ action: 'admin_followup_overview' }, api.S('omar')))));
  // ADMIN_TOKEN path unchanged
  t('ADMIN_TOKEN path unchanged for listed + unlisted actions', api.post({ action: 'admin_followup_overview', token: 'tok' }).error !== 'Not authorized.' && api.post({ action: 'admin_list_groups', token: 'tok' }).ok === true);
  // a wrong token is still refused even with an assistant's student_id attached
  t('wrong token refused', NOT_AUTH(api.post({ action: 'admin_followup_overview', token: 'nope', student_id: api.P('sara'), session_token: api.S('sara').session_token })));
  // action must be a string equal to a listed name
  t('non-string action never counts as listed', !api.env.ctx.p3_assistantAllows([], {}, { action: ['admin_followup_overview'] }));
  // forged / stale / missing session
  t('wrong session_token refused', NOT_AUTH(api.post({ action: 'admin_followup_overview', student_id: api.P('sara'), session_token: 'forged' })) || /Not authorized|expired|invalid/.test(api.post({ action: 'admin_followup_overview', student_id: api.P('sara'), session_token: 'forged' }).error));
  t('missing session refused', api.post({ action: 'admin_followup_overview', student_id: api.P('sara') }).ok === false);

  // the assistant cannot manage roles or staff, not even for themselves
  t('assistant cannot call p3_admin_set_role', NOT_AUTH(api.call('p3_admin_set_role', Object.assign({ action: 'p3_admin_set_role', phone: api.P('omar'), role: 'assistant' }, api.S('sara')))));
  t('assistant cannot call p3_admin_list_staff', NOT_AUTH(api.call('p3_admin_list_staff', Object.assign({ action: 'p3_admin_list_staff' }, api.S('sara')))));
  t('assistant cannot promote themselves', api.call('p3_admin_set_role', Object.assign({ action: 'admin_followup_overview', phone: api.P('sara'), role: 'admin' }, api.S('sara'))).ok === false);
  t('Omar is still a student after the attempts', api.env.ctx.p3_session_role(api.S('omar')) === 'student');

  // a new login (new token) makes the old session stale for the role too
  const old = api.S('sara');
  api.tab('Students').set(3, api.colOf(stu, 'session_token'), 'new-token');
  t('stale assistant token refused', NOT_AUTH(api.post(Object.assign({ action: 'admin_followup_overview' }, old))) || /expired|invalid|Not authorized/.test(api.post(Object.assign({ action: 'admin_followup_overview' }, old)).error));
  t('stale assistant token reads as "stale"', api.env.ctx.p3_session_role(old) === 'stale');
  api.tab('Students').set(3, api.colOf(stu, 'session_token'), old.session_token);

  // login decoration
  const login = who => api.env.ctx.p3_withRole(api.post({ action: 'login_student', phone: api.P(who), password_hash: api.H(who) }), {});
  const lr = login('sara');
  t('login reply: assistant has role "assistant" and is_admin false', lr.ok && lr.role === 'assistant' && lr.is_admin === false, JSON.stringify(lr));
  t('login reply: student role', login('omar').role === 'student');
  t('login reply: admin role', api.env.ctx.p3_withRole(api.post({ action: 'login_student', phone: '01000000001', password_hash: api.H('a') }), {}).role === 'admin');
  t('p3_withRole leaves failures alone', api.env.ctx.p3_withRole({ ok: false, error: 'x' }, {}).role === undefined);

  // staff list
  const ls = api.call('p3_admin_list_staff', Object.assign({ action: 'p3_admin_list_staff' }, api.ADMIN));
  t('list_staff: admin (read-only) + assistant, and the allow-list', ls.ok && ls.staff.length === 2 && ls.staff.some(s => s.role === 'admin') && ls.staff.some(s => s.role === 'assistant' && s.phone === api.P('sara')) && ls.allow.length === 13, JSON.stringify(ls));

  // revoking takes effect on the very next call
  const rv = api.setRole(api.P('sara'), '');
  t('admin can remove the role', rv.ok && rv.role === 'student' && rv.changed === true, JSON.stringify(rv));
  t('revoked: refused on the next call', NOT_AUTH(api.post(Object.assign({ action: 'admin_followup_overview' }, api.S('sara')))));
  t('revoked: login reply says student', login('sara').role === 'student');
  t('"student" as the role value also clears', api.setRole(api.P('sara'), 'assistant').ok && api.setRole(api.P('sara'), 'student').role === 'student');
}

// ---- set_role validation
{
  const api = build();
  t('unknown phone refused', /No student account/.test(api.setRole('01999999999', 'assistant').error));
  t('empty phone refused', /Missing phone/.test(api.setRole('', 'assistant').error));
  t('cannot grant admin through the web', /by hand/.test(api.setRole(api.P('sara'), 'admin').error));
  t('unknown role refused', /Unknown role/.test(api.setRole(api.P('sara'), 'boss').error));
  t('an admin account cannot be changed', /admin/.test(api.setRole('01000000001', 'assistant').error || ''));
  t('admin stays admin after the refused change', api.env.ctx.p3_session_role(api.ADMIN) === 'admin');
  t('plain student cannot set roles', NOT_AUTH(api.call('p3_admin_set_role', Object.assign({ action: 'p3_admin_set_role', phone: api.P('omar'), role: 'assistant' }, api.S('omar')))));
  t('ADMIN_TOKEN can set roles (desktop app)', api.call('p3_admin_set_role', { action: 'p3_admin_set_role', token: 'tok', phone: api.P('omar'), role: 'assistant' }).ok === true);
  t('phone typed with spaces / Arabic digits still matches', api.setRole('٠١٠٠ ٠٠٠٠ ٠٠٣', 'assistant').name === 'Omar Ali');
  t('a student who typed the phone differently (+20) is found once', api.setRole('+201000000004', 'assistant').name === 'Lamis Adel');
}

// ---- Code.gs wiring and hygiene
{
  const code = fs.readFileSync(CODE, 'utf8'), p3 = fs.readFileSync(P3, 'utf8');
  t('Code.gs guard calls p3_assistantAllows behind a typeof check (Phase3 file optional)', /typeof p3_assistantAllows === "function"/.test(code));
  // without the Phase 3 file, nothing changes for anyone
  const env = load(CODE, { clock: true });
  const ok = Object.keys(env.ctx).indexOf('p3_assistantAllows') === -1;
  t('Code.gs alone has no p3_ globals (nothing silently depends on them)', ok);
  // every top-level name in Phase3_Roles.gs is prefixed and does not collide with Code.gs
  const names = s => [...s.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/gm)].map(m => m[1] || m[2]);
  const mine = names(p3), theirs = new Set(names(code));
  t('Phase3_Roles.gs globals are all p3_ / _p3 / P3_ prefixed', mine.every(n => /^(p3_|_p3|P3_)/.test(n)), mine.filter(n => !/^(p3_|_p3|P3_)/.test(n)).join(','));
  t('Phase3_Roles.gs does not redefine anything in Code.gs', !mine.some(n => theirs.has(n)), mine.filter(n => theirs.has(n)).join(','));
  // every listed handler is reached through the central guard (grep proof for the handoff)
  const missing = [];
  const hand = { admin_followup_overview: 'function handleAdminFollowupOverview', admin_followup_set_attendance: 'function p2_admin_followup_set_attendance', admin_followup_save_group: 'function handleAdminFollowupSaveGroup',
    admin_followup_save_templates: 'function handleAdminFollowupSaveTemplates', admin_student_summary: 'function p2_admin_student_summary', admin_monthly_review: 'function p2_admin_monthly_review',
    admin_set_requirement: 'function p2_admin_set_requirement', admin_log_parent_notification: 'function p2_admin_log_parent_notification', admin_list_parent_notifications: 'function p2_admin_list_parent_notifications',
    admin_grading_queue: 'function handleAdminGradingQueue', admin_grade_written: 'function handleAdminGradeWritten', admin_get_written_models: 'function handleAdminGetWrittenModels', get_written_image: 'function handleGetWrittenImage' };
  for (const [a, sig] of Object.entries(hand)) {
    const i = code.indexOf(sig); const body = code.slice(i, i + 1400);
    if (i < 0 || !/_requireAdminAny\(payload\)/.test(body)) missing.push(a);
  }
  t('every listed handler authenticates through _requireAdminAny (none checks is_admin itself)', missing.length === 0, missing.join(','));
  // router wiring: only checked once the assembler has pasted the Phase 3 cases
  if (/case "p3_admin_set_role"/.test(code)) {
    const api = build();
    t('router: p3_admin_set_role served', api.post(Object.assign({ action: 'p3_admin_set_role', phone: api.P('sara'), role: 'assistant' }, api.ADMIN)).ok === true);
    t('router: p3_admin_list_staff served', api.post(Object.assign({ action: 'p3_admin_list_staff' }, api.ADMIN)).ok === true);
    t('router: p3_session_role served', api.post(Object.assign({ action: 'p3_session_role' }, api.S('sara'))).role === 'assistant');
    t('router: assistant refused on p3_admin_set_role', NOT_AUTH(api.post(Object.assign({ action: 'p3_admin_set_role', phone: api.P('omar'), role: 'assistant' }, api.S('sara')))));
    t('router: login reply carries role', api.post({ action: 'login_student', phone: api.P('sara'), password_hash: api.H('sara') }).role === 'assistant');
  } else console.log('SKIP router wiring tests (Phase 3 router cases not pasted yet - see HANDOFF-S3.md)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
