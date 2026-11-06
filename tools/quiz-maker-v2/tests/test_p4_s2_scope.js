// P4 / S2 - authorization core: who is calling, the action table, the gate, lesson filters, hooks.
// Usage: node tests/test_p4_s2_scope.js     (S3, S5 and S6 are stubbed, contract section 9)
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeEnv, loadP4 } = require('./p4_load');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const J = x => JSON.stringify(x);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const NOT_AUTH = r => r && r.ok === false && r.error === 'Not authorized.';
const APPS = path.join(__dirname, '..', 'apps_script');
const CODE_TEXT = fs.readFileSync(path.join(APPS, 'Code.gs'), 'utf8');

const MATH = 'math/sat/lesson-1', PROG = 'programming/baccalaureate/grade-2-secondary/chapter-1-lesson-2-how-ai-works';

function build(opts = {}) {
  const tokens = {};
  tokens[sha('math-tok')] = { name: 'Sara Mahmoud', scope: 'math', created: '2026-10-30' };
  tokens[sha('ghost-tok')] = { name: 'Ghost', scope: 'math,programming', created: '2026-10-30' };
  tokens[sha('empty-tok')] = { name: 'Nobody', scope: '', created: '2026-10-30' };
  const api = makeEnv({ props: Object.assign({ P4_TEACHER_TOKENS: J(tokens), ATTACHMENTS_FOLDER_ID: 'ATT' }, opts.props || {}) });
  const ctx = api.env.ctx;
  // The mock digest is MD5 only; make it honour SHA-256 like Apps Script.
  ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  ctx.Utilities.computeDigest = (alg, s) => [...crypto.createHash(alg === 'sha256' ? 'sha256' : 'md5').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b));
  loadP4(api, ['Phase4_Scope.gs']);

  // Students sheet: the three new columns
  const stu = api.tab('Students');
  ['role', 'teacher_scope', 'assistant_of'].forEach(h => { if (!api.colOf(stu, h)) stu.set(1, stu.getLastColumn() + 1, h); });
  const col = n => api.colOf(stu, n);
  const rowOf = ph => { for (let r = 2; r <= stu.getLastRow(); r++) if (String(stu.get(r, col('phone'))) === ph) return r; return 0; };
  api.setRow = (ph, role, scope, of) => { const r = rowOf(ph); stu.set(r, col('role'), role || ''); stu.set(r, col('teacher_scope'), scope || ''); stu.set(r, col('assistant_of'), of || ''); };
  api.addUser = (ph, name) => { const r = api.post({ action: 'register_student', phone: ph, password_hash: api.H(name), display_name: name, year: 'Senior 2', parent_phone: '01100000009' }); return { student_id: r.student_id, session_token: r.session_token }; };
  api.extra = { prog: api.addUser('01000000006', 'Pat Prog'), orphan: api.addUser('01000000007', 'Orphan Asst'), emptyt: api.addUser('01000000008', 'Empty Teacher') };
  api.setRow('01000000002', 'teacher', 'math');                       // sara  : math teacher
  api.setRow('01000000003', 'assistant', '', '01000000002');          // omar  : scoped assistant of sara
  api.setRow('01000000004', 'assistant', '', '');                     // lamis : legacy owner assistant
  api.setRow('01000000006', 'teacher', 'programming, english');       // prog  : two subjects
  api.setRow('01000000007', 'assistant', '', '01000000005');          // orphan: assistant of a plain student -> student
  api.setRow('01000000008', 'teacher', '');                           // emptyt: teacher, no scope -> student
  api.sess = k => (api.extra[k] || api.S(k));

  // S3 stubs (contract section 9)
  vm.runInContext(`
    var STUB_CALLS = [];
    function p4_ownsStudent(ctx, p) { return ctx.kind === 'owner' || String(p) === 'OWNED'; }
    function p4_ownsGroup(ctx, g) { return ctx.kind === 'owner' || g === 'G-OWN'; }
    function p4_groupState(c, g) { return g === 'G-OWN' ? 'own' : g === 'G-NEW' ? 'free' : 'foreign'; }
    function p4_paymentInScope(c, p) { return c.kind === 'owner' || p.payment_id === 'PAY-MATH'; }
  `, ctx);
  if (!opts.noStubFilters) Object.keys(ctx.P4_ACTIONS).forEach(a => {
    const f = ctx.P4_ACTIONS[a].filter;
    if (f && !/^p4f_admin_list_(videos|lessons|lesson_tags)$/.test(f)) vm.runInContext(`function ${f}(resp, c, p) { STUB_CALLS.push('${f}'); return resp; }`, ctx);
  });

  // Drive stub for delete_attachment
  const mk = (id, name, parent) => ({ id, getName: () => name, getParents: () => { let d = false; return { hasNext: () => !d, next: () => { d = true; return { getId: () => parent }; } }; } });
  const files = { 'F-MATH': mk('F-MATH', 'math--sat-foo--abcd1234--notes.pdf', 'ATT'), 'F-PROG': mk('F-PROG', 'programming--lesson-1--abcd1234--x.pdf', 'ATT'),
    'F-OUT': mk('F-OUT', 'math--sat-foo--abcd1234--notes.pdf', 'ELSEWHERE'), 'F-ODD': mk('F-ODD', 'weird.pdf', 'ATT'),
    'F-MIX': mk('F-MIX', 'math--programming-x--abcd1234--n.pdf', 'ATT') };
  ctx.DriveApp.getFileById = id => { if (!files[id]) throw new Error('no such file'); return files[id]; };

  // Written answers
  const ws = api.getSS('DATA').insertSheet('WrittenAnswers');
  ws.appendRow(['submission_id', 'question_id', 'student_id', 'lesson', 'drive_file_id']);
  ws.appendRow(['SUB-M', 'Q1', 'OWNED', MATH, 'x']);
  ws.appendRow(['SUB-P', 'Q1', 'OWNED', PROG, 'x']);
  ws.appendRow(['SUB-F', 'Q1', 'STRANGER', MATH, 'x']);
  return api;
}

const A = ctx => ctx.P4_ACTIONS;

// ---------------------------------------------------------------- p4_subjectOf
{
  const api = build(), c = api.env.ctx, s = c.p4_subjectOf;
  t('subjectOf: math key', s('math/sat/lesson-1') === 'math');
  t('subjectOf: english and programming', s('english/ielts/x') === 'english' && s('programming/other/functions') === 'programming');
  t('subjectOf: scope with #ch2 and #t1', s('math/sat#ch2') === 'math' && s('programming/baccalaureate/grade-2-secondary#t1') === 'programming');
  t('subjectOf: case, slashes, backslash', s('/Math/SAT/') === 'math' && s('MATH\\sat') === 'math');
  const oldKey = Object.keys(c.P2_LESSON_ALIASES)[0];
  t('subjectOf: old alias key resolves', !!oldKey && s(oldKey) === 'programming', oldKey);
  t('subjectOf: junk is empty', ['', '   ', null, undefined, 5, {}, ['math/x'], 'art/x', '*', 'all', 'mathematics/x', 'math-x/y', '../math/x', 'math/../programming/x', 'x/math'].every(v => s(v) === ''), '');
  t('subjectOf: trailing "#" only', s('#ch1') === '');
}

// ---------------------------------------------------------------- token verification
{
  const api = build(), c = api.env.ctx;
  t('hashToken_ = sha256 hex', c.p4_hashToken_('abc') === sha('abc') && c.p4_hashToken_('') === sha(''));
  t('findTeacherToken_: valid', c.p4_findTeacherToken_('math-tok').name === 'Sara Mahmoud' && J(c.p4_findTeacherToken_('math-tok').scope) === '["math"]');
  t('findTeacherToken_: two subjects', J(c.p4_findTeacherToken_('ghost-tok').scope) === '["math","programming"]');
  t('findTeacherToken_: unknown, empty scope, blank, non-string', c.p4_findTeacherToken_('nope') === null && c.p4_findTeacherToken_('empty-tok') === null && c.p4_findTeacherToken_('') === null && c.p4_findTeacherToken_(123) === null && c.p4_findTeacherToken_(null) === null);
  t('findTeacherToken_: the stored hash is not a token', c.p4_findTeacherToken_(sha('math-tok')) === null);
  api.env.props.P4_TEACHER_TOKENS = 'not json';
  t('findTeacherToken_: corrupt property -> null', c.p4_findTeacherToken_('math-tok') === null);
  api.env.props.P4_TEACHER_TOKENS = '[]';
  t('findTeacherToken_: wrong shape -> null', c.p4_findTeacherToken_('math-tok') === null);
  delete api.env.props.P4_TEACHER_TOKENS;
  t('findTeacherToken_: property missing -> null', c.p4_findTeacherToken_('math-tok') === null);
}

// ---------------------------------------------------------------- p4_ctx
{
  const api = build(), c = api.env.ctx, ctxOf = p => JSON.parse(J(c.p4_ctx(p)));
  let x = ctxOf({ token: 'tok' });
  t('ctx: owner token', x.kind === 'owner' && x.via === 'token' && J(x.subjects) === '["*"]' && x.principal === '', J(x));
  x = ctxOf(Object.assign({}, api.ADMIN));
  t('ctx: owner session', x.kind === 'owner' && x.via === 'session' && x.id === '01000000001' && J(x.subjects) === '["*"]', J(x));
  x = ctxOf({ token: 'math-tok' });
  t('ctx: teacher token, principal = his phone', x.kind === 'teacher' && x.via === 'token' && x.id === 'Sara Mahmoud' && J(x.subjects) === '["math"]' && x.principal === '01000000002', J(x));
  x = ctxOf({ token: 'ghost-tok' });
  t('ctx: teacher token without a row, principal = name', x.kind === 'teacher' && x.principal === 'Ghost' && J(x.subjects) === '["math","programming"]', J(x));
  x = ctxOf({ token: 'revoked-tok' });
  t('ctx: unknown or revoked token is anon', x.kind === 'anon' && x.via === 'none' && x.id === '' && J(x.subjects) === '[]', J(x));
  t('ctx: empty-scope token is anon', ctxOf({ token: 'empty-tok' }).kind === 'anon');
  x = ctxOf(Object.assign({ token: 'nope' }, api.S('sara')));
  t('ctx: a bad token does not fall back to the session', x.kind === 'anon', J(x));
  x = ctxOf({ token: { $gt: '' } });
  t('ctx: non-string token is anon', x.kind === 'anon');
  x = ctxOf(Object.assign({}, api.S('sara')));
  t('ctx: teacher session', x.kind === 'teacher' && x.via === 'session' && x.id === '01000000002' && x.principal === '01000000002' && J(x.subjects) === '["math"]', J(x));
  x = ctxOf(Object.assign({}, api.sess('prog')));
  t('ctx: scope list parsed ("programming, english")', J(x.subjects) === '["programming","english"]', J(x));
  x = ctxOf(Object.assign({}, api.S('omar')));
  t('ctx: scoped assistant', x.kind === 'assistant' && x.via === 'session' && x.principal === '01000000002' && J(x.subjects) === '["math"]' && x.id === '01000000003', J(x));
  x = ctxOf(Object.assign({}, api.S('lamis')));
  t('ctx: blank assistant_of stays legacy', x.kind === 'assistant' && x.principal === '' && J(x.subjects) === '[]', J(x));
  x = ctxOf(Object.assign({}, api.sess('orphan')));
  t('ctx: assistant of a non-teacher is a student', x.kind === 'student' && x.principal === '' && J(x.subjects) === '[]', J(x));
  x = ctxOf(Object.assign({}, api.sess('emptyt')));
  t('ctx: teacher with empty scope is a student', x.kind === 'student', J(x));
  x = ctxOf(Object.assign({}, api.S('hana')));
  t('ctx: plain student', x.kind === 'student' && x.via === 'session' && J(x.subjects) === '[]', J(x));
  t('ctx: anon (nothing)', ctxOf({}).kind === 'anon' && ctxOf(null).kind === 'anon' && ctxOf(undefined).kind === 'anon');
  t('ctx: stale session token is anon', ctxOf({ student_id: api.P('sara'), session_token: 'old' }).kind === 'anon');
  t('ctx: empty session token is anon', ctxOf({ student_id: api.P('sara'), session_token: '' }).kind === 'anon');
  t('ctx: unknown phone is anon', ctxOf({ student_id: '01999999999', session_token: 'x' }).kind === 'anon');

  // Identity comes only from token / student_id / session_token
  x = ctxOf(Object.assign({ role: 'teacher', teacher_scope: 'math', assistant_of: '01000000002', is_admin: true, kind: 'owner', subjects: ['*'], principal: 'x' }, api.S('hana')));
  t('ctx: forged role / assistant_of / is_admin / kind in the payload are ignored', x.kind === 'student' && J(x.subjects) === '[]' && x.principal === '', J(x));
  x = ctxOf(Object.assign({ assistant_of: '01000000002', role: 'assistant' }, api.S('lamis')));
  t('ctx: forged assistant_of cannot upgrade a legacy assistant', x.kind === 'assistant' && x.principal === '', J(x));
  x = ctxOf({ token: 'math-tok', role: 'owner', subjects: ['*'], is_admin: true });
  t('ctx: forged fields next to a teacher token are ignored', x.kind === 'teacher' && J(x.subjects) === '["math"]', J(x));
  t('ctx: stores the result in P4_CTX_', c.P4_CTX_ && c.P4_CTX_.kind === 'teacher' && c.p4_ctx({}).kind === 'anon' && c.P4_CTX_.kind === 'anon');

  // Fresh reads: a change in the sheet takes effect on the very next call
  const stu = api.tab('Students'), rc = api.colOf(stu, 'role'), sc = api.colOf(stu, 'teacher_scope'), ac = api.colOf(stu, 'assistant_of');
  const sara = 3, omar = 4;
  stu.set(sara, rc, '');
  t('fresh: teacher role removed -> student at once', ctxOf(api.S('sara')).kind === 'student');
  t('fresh: his assistant becomes a student at once (teacher row gone)', ctxOf(api.S('omar')).kind === 'student');
  stu.set(sara, rc, 'teacher'); stu.set(sara, sc, '');
  t('fresh: teacher loses his scope -> student', ctxOf(api.S('sara')).kind === 'student');
  t('fresh: teacher loses scope -> assistant is a student', ctxOf(api.S('omar')).kind === 'student');
  stu.set(sara, sc, 'math,english');
  x = ctxOf(api.S('omar'));
  t('fresh: scope change reaches the assistant on the next call', J(x.subjects) === '["math","english"]' && x.kind === 'assistant', J(x));
  stu.set(omar, ac, '');
  t('fresh: appointment cleared -> legacy assistant', ctxOf(api.S('omar')).principal === '');
  stu.set(omar, ac, '01000000002'); stu.set(sara, sc, 'math');
  stu.set(3, api.colOf(stu, 'is_admin'), true);
  t('fresh: is_admin wins over role', ctxOf(api.S('sara')).kind === 'owner');
  stu.set(3, api.colOf(stu, 'is_admin'), '');
  t('fresh: is_admin removed -> teacher again', ctxOf(api.S('sara')).kind === 'teacher');
  stu.set(3, api.colOf(stu, 'session_token'), 'rotated');
  t('fresh: rotated session token locks the old one out', ctxOf(api.S('sara')).kind === 'anon');
}

// ---------------------------------------------------------------- p4_ctxForPhone
{
  const api = build(), c = api.env.ctx, f = p => c.p4_ctxForPhone(p) && JSON.parse(J(c.p4_ctxForPhone(p)));
  const x = f('01000000002');
  t('ctxForPhone: teacher', x && x.kind === 'teacher' && x.via === 'telegram' && x.id === '01000000002' && x.principal === '01000000002' && J(x.subjects) === '["math"]', J(x));
  t('ctxForPhone: typed another way (+20 form)', !!f('+20 100 000 0002'));
  t('ctxForPhone: scoped assistant -> null', c.p4_ctxForPhone('01000000003') === null);
  t('ctxForPhone: legacy assistant -> null', c.p4_ctxForPhone('01000000004') === null);
  t('ctxForPhone: student -> null', c.p4_ctxForPhone('01000000005') === null);
  t('ctxForPhone: owner without a role -> null', c.p4_ctxForPhone('01000000001') === null);
  t('ctxForPhone: unknown, empty, junk -> null', c.p4_ctxForPhone('01999999999') === null && c.p4_ctxForPhone('') === null && c.p4_ctxForPhone(null) === null && c.p4_ctxForPhone({}) === null);
  t('ctxForPhone: teacher with empty scope -> null', c.p4_ctxForPhone('01000000008') === null);
  api.setRow('01000000002', 'student', 'math');
  t('ctxForPhone: fresh read (role removed -> null)', c.p4_ctxForPhone('01000000002') === null);
  c.p4_ctx({}); c.p4_ctxForPhone('01000000006');
  t('ctxForPhone: does not touch P4_CTX_', c.P4_CTX_.kind === 'anon');
}

// ---------------------------------------------------------------- router coverage
{
  const api = build(), c = api.env.ctx;
  const body = CODE_TEXT.slice(CODE_TEXT.indexOf('function doPost(e)'));
  const sw = body.slice(0, body.indexOf('\nfunction ', 10));
  const cases = [...new Set([...sw.matchAll(/case "([A-Za-z0-9_]+)"/g)].map(m => m[1]))];
  const missing = cases.filter(a => !Object.prototype.hasOwnProperty.call(c.P4_ACTIONS, a));
  t('every doPost case has a P4_ACTIONS row (' + cases.length + ' cases)', cases.length > 60 && missing.length === 0, missing.join(','));
  const contract = ['upload_attachment', 'delete_attachment', 'admin_set_video', 'admin_list_videos', 'admin_set_quiz_content', 'admin_get_quiz_content', 'admin_set_written_models', 'admin_get_written_models', 'admin_set_lesson_lock', 'admin_set_quiz_lock', 'admin_set_lesson_tags', 'admin_list_lesson_tags', 'admin_list_lessons', 'admin_set_requirement', 'admin_grant_access', 'admin_grant_quiz_access', 'admin_revoke_access', 'admin_revoke_quiz_access', 'admin_group_add', 'admin_group_remove', 'admin_group_grant_access', 'admin_group_grant_quiz_access', 'admin_group_revoke_access', 'admin_group_revoke_quiz_access', 'admin_list_groups', 'admin_get_all', 'admin_access_overview', 'admin_list_payments', 'admin_decide_payment', 'admin_followup_overview', 'admin_followup_set_attendance', 'admin_followup_save_group', 'admin_followup_save_templates', 'admin_student_summary', 'admin_monthly_review', 'admin_log_parent_notification', 'admin_list_parent_notifications', 'admin_grading_queue', 'admin_grade_written', 'get_written_image', 'admin_migrate_lesson_keys', 'p3_admin_set_role', 'p3_admin_backfill_submission', 'p3_admin_bulk_preview', 'p3_admin_bulk_grant', 'p3_admin_bulk_revoke', 'ping', 'p4_session_scope', 'p4_admin_set_teacher', 'p4_admin_list_teachers', 'p4_admin_set_group_owner', 'p4_admin_tg_unlink', 'p4_admin_list_edit_log', 'p4_admin_teacher_stats', 'p4_teacher_update_student', 'p4_teacher_set_assistant', 'p4_teacher_list_assistants', 'p4_teacher_revoke_assistant', 'p4_tg_link_start', 'p4_tg_status', 'p4_tg_unlink',
    'admin_fu2_mark_done'];   // integration: follow-up v2 "reminder sent / advance done" (routed by FollowupRouter.gs, not a doPost case)
  t('every contract section 5 action has a row', contract.every(a => c.P4_ACTIONS[a]), contract.filter(a => !c.P4_ACTIONS[a]).join(','));
  t('no row for a name that is neither in the router nor the contract', Object.keys(c.P4_ACTIONS).every(a => cases.includes(a) || contract.includes(a)), Object.keys(c.P4_ACTIONS).filter(a => !cases.includes(a) && !contract.includes(a)).join(','));
  const O = Object.keys(c.P4_ACTIONS).filter(a => c.P4_ACTIONS[a].rule === 'O').sort();
  t('owner-only rows are the contract O list + the 4 extra p3_admin_ actions', O.length === 3 + 3 + 4 + 6, O.join(','));
  t('bulk actions are O (A10)', ['p3_admin_bulk_preview', 'p3_admin_bulk_grant', 'p3_admin_bulk_revoke'].every(a => c.P4_ACTIONS[a].rule === 'O'));
  t('every named filter is p4f_<action>', Object.keys(c.P4_ACTIONS).every(a => !c.P4_ACTIONS[a].filter || c.P4_ACTIONS[a].filter === 'p4f_' + a));
  t('every filter row in the contract table has its filter', ['admin_list_videos', 'admin_list_lesson_tags', 'admin_list_lessons', 'admin_grant_access', 'admin_grant_quiz_access', 'admin_group_add', 'admin_list_groups', 'admin_get_all', 'admin_access_overview', 'admin_list_payments', 'admin_followup_overview', 'admin_student_summary', 'admin_monthly_review', 'admin_list_parent_notifications', 'admin_grading_queue'].every(a => c.P4_ACTIONS[a].filter === 'p4f_' + a));
  const pub = Object.keys(c.P4_ACTIONS).filter(a => c.P4_ACTIONS[a].rule === 'PUB').sort();
  console.log('INFO rows=' + Object.keys(c.P4_ACTIONS).length + ' PUB=' + pub.join(','));
  console.log('INFO P4_ASSISTANT_DENY=' + c.P4_ASSISTANT_DENY.join(','));
  // integration (follow-up v2): P3_STAFF_ALLOW gained 8 actions for the OWNER's assistants. Only admin_fu2_mark_done has a
  // P4 row (same scope as admin_followup_save_group); the other 7 have none, so p4_gate denies them to teachers and scoped
  // assistants (deny by default). FU2_OWNER_ONLY states that contract.
  const FU2_OWNER_ONLY = ['admin_fu2_notify_settings_get', 'admin_fu2_notify_settings_save', 'admin_req_get', 'admin_req_save_global', 'admin_req_save_group', 'admin_req_check', 'admin_req_history',
    'admin_req_month_get', 'admin_req_month_save'];   // Nov 2026: the month's required lessons, owner + owner-assistant only
  const stillAllowed = c.P3_STAFF_ALLOW.filter(a => c.P4_ACTIONS[a] && !c.P4_ASSISTANT_DENY.includes(a) && !['O', 'T'].includes(c.P4_ACTIONS[a].rule) && c.P4_ACTIONS[a].ses);
  console.log('INFO scoped assistant allowed (' + stillAllowed.length + '): ' + stillAllowed.join(','));
  t('scoped assistant ends up allowed for 13 of the 23 P3_STAFF_ALLOW actions (12 + admin_fu2_mark_done)', stillAllowed.length === 13 && c.P3_STAFF_ALLOW.length === 23 && !stillAllowed.includes('admin_followup_save_templates') && stillAllowed.includes('admin_fu2_mark_done'), stillAllowed.length + '/' + c.P3_STAFF_ALLOW.length);
  t('P3_STAFF_ALLOW rows all exist, except the follow-up v2 owner-only actions (which must NOT have one)', c.P3_STAFF_ALLOW.every(a => c.P4_ACTIONS[a] ? !FU2_OWNER_ONLY.includes(a) : FU2_OWNER_ONLY.includes(a)), c.P3_STAFF_ALLOW.filter(a => !c.P4_ACTIONS[a] && !FU2_OWNER_ONLY.includes(a)).join(','));
}

// ---------------------------------------------------------------- the gate, every row
{
  const api = build(), c = api.env.ctx;
  const ALLOW = Array.from(c.P3_STAFF_ALLOW), DENY = Array.from(c.P4_ASSISTANT_DENY);
  const setPath = (p, spec, v) => { const i = spec.indexOf('[].'); if (i === -1) p[spec] = v; else p[spec.slice(0, i)] = [{ [spec.slice(i + 3)]: v }]; };
  function mk(action, which) {
    const row = JSON.parse(J(c.P4_ACTIONS[action])), p = { action };
    const lesson = which === 'ok' ? MATH : PROG, subj = which === 'ok' ? 'math' : 'programming';
    (row.L || []).forEach(f => { p[f] = f === 'subject' ? subj : f === 'scope' ? lesson + '#ch1' : lesson; });
    (row.Lsoft || []).forEach(f => { p[f] = lesson; });
    (row.St || []).forEach(f => setPath(p, f, 'OWNED'));
    (row.G || []).forEach(f => { p[f] = row.rule === 'GC' ? 'G-NEW' : 'G-OWN'; });
    if (row.needs.includes('PAY')) p.payment_id = which === 'ok' ? 'PAY-MATH' : 'PAY-PROG';
    if (row.res === 'written') { p.submission_id = which === 'ok' ? 'SUB-M' : 'SUB-P'; p.question_id = 'Q1'; }
    if (row.res === 'attachment') p.file_id = which === 'ok' ? 'F-MATH' : 'F-PROG';
    return p;
  }
  function expected(action, kind, via, which) {
    const row = c.P4_ACTIONS[action];
    if (row.rule === 'PUB') return true;
    if (row.rule === 'O') return false;
    if (row.rule === 'T' && kind !== 'teacher') return false;
    if (kind === 'assistant' && (!ALLOW.includes(action) || DENY.includes(action))) return false;
    if (via === 'token' ? !row.tok : !row.ses) return false;
    if (which === 'bad' && (row.needs.includes('LW') || row.needs.includes('PAY'))) return false;
    return true;
  }
  const callers = {
    'teacher session': { kind: 'teacher', via: 'session', id: () => api.S('sara') },
    'teacher token': { kind: 'teacher', via: 'token', id: () => ({ token: 'math-tok' }) },
    'scoped assistant': { kind: 'assistant', via: 'session', id: () => api.S('omar') },
  };
  let rows = 0, bad = [];
  Object.keys(c.P4_ACTIONS).forEach(a => {
    ['ok', 'bad'].forEach(which => Object.keys(callers).forEach(name => {
      const cl = callers[name], p = Object.assign(mk(a, which), cl.id());
      const r = c.p4_gate(p), allowed = !(r && r.deny);
      const want = expected(a, cl.kind, cl.via, which);
      rows++;
      if (allowed !== want) bad.push(a + ' / ' + name + ' / ' + which + ' want ' + want + ' got ' + allowed);
      if (r && r.deny && !NOT_AUTH(JSON.parse(J(r.deny)))) bad.push(a + ' refusal text');
    }));
  });
  t('gate: every row x {teacher session, teacher token, scoped assistant} x {math, programming}: ' + rows + ' cases', bad.length === 0, bad.slice(0, 6).join(' | ') + (bad.length > 6 ? ' ... +' + (bad.length - 6) : ''));

  // owner passes every row (token and session), including O
  let ob = [];
  Object.keys(c.P4_ACTIONS).forEach(a => ['bad'].forEach(w => {
    [{ token: 'tok' }, api.ADMIN].forEach(id => { const r = c.p4_gate(Object.assign(mk(a, w), id)); if (r && r.deny) ob.push(a); });
  }));
  t('gate: owner passes every row, token or session', ob.length === 0, ob.join(','));

  // legacy assistant, student, anon fall through (the existing checks decide)
  let fb = [];
  Object.keys(c.P4_ACTIONS).forEach(a => [api.S('lamis'), api.S('hana'), {}, { token: 'nope' }].forEach(id => { const r = c.p4_gate(Object.assign(mk(a, 'bad'), id)); if (r && r.deny) fb.push(a); }));
  t('gate: legacy assistant, student, anon and a bad token all fall through untouched', fb.length === 0, fb.slice(0, 5).join(','));

  const g = (p, id) => c.p4_gate(Object.assign({}, p, id));
  const den = r => !!(r && r.deny && NOT_AUTH(JSON.parse(J(r.deny))));
  const S = api.S('sara'), T = { token: 'math-tok' }, AS = api.S('omar');

  // Hand-written cases (not derived from the table)
  t('hand: grant access, math scope ok / programming denied', !den(g({ action: 'admin_grant_access', scope: 'math/sat#ch2', phone: '01055555555' }, S)) && den(g({ action: 'admin_grant_access', scope: PROG + '#ch1', phone: '01055555555' }, S)));
  t('hand: wildcard and unknown scopes denied', den(g({ action: 'admin_grant_access', scope: '*', phone: '0105' }, S)) && den(g({ action: 'admin_grant_access', scope: 'all', phone: '0105' }, S)) && den(g({ action: 'admin_grant_access', phone: '0105' }, S)));
  t('hand: lesson alias to a programming lesson denied', den(g({ action: 'admin_set_lesson_lock', lesson: Object.keys(c.P2_LESSON_ALIASES)[0] }, S)));
  t('hand: lesson smuggling (.., case, array, object, number) denied', ['math/../programming/x', 'MATH/../programming/x', ['math/x'], { a: 1 }, 7, true, null, ''].every(v => den(g({ action: 'admin_set_lesson_lock', lesson: v }, S))));
  t('hand: lesson with different case / slashes / backslash is read like the handler does', !den(g({ action: 'admin_set_lesson_lock', lesson: '/MATH//Sat/Lesson-1/' }, S)) && !den(g({ action: 'admin_set_lesson_lock', lesson: 'math\\sat' }, S)));
  t('hand: admin_get_all passes the gate for a teacher (filtered later), not for an assistant', !den(g({ action: 'admin_get_all' }, S)) && den(g({ action: 'admin_get_all' }, AS)));
  t('hand: assistant cannot decide, list payments, save templates', ['admin_decide_payment', 'admin_list_payments', 'admin_followup_save_templates'].every(a => den(g({ action: a, payment_id: 'PAY-MATH', templates: {} }, AS))));
  t('hand: teacher can decide his own payment, not another subject\'s', !den(g({ action: 'admin_decide_payment', payment_id: 'PAY-MATH' }, S)) && den(g({ action: 'admin_decide_payment', payment_id: 'PAY-PROG' }, S)) && den(g({ action: 'admin_decide_payment' }, S)));
  t('hand: teacher can save templates (A3), assistant cannot', !den(g({ action: 'admin_followup_save_templates', templates: {} }, S)));
  t('hand: assistant cannot call any p4_ action but p4_session_scope', ['p4_tg_status', 'p4_teacher_update_student', 'p4_teacher_set_assistant', 'p4_admin_list_teachers'].every(a => den(g({ action: a, student: 'OWNED' }, AS))) && !den(g({ action: 'p4_session_scope' }, AS)));
  t('hand: teacher passes T rows, never O rows', !den(g({ action: 'p4_tg_status' }, S)) && !den(g({ action: 'p4_teacher_update_student', student: 'OWNED' }, S)) && den(g({ action: 'p4_teacher_update_student', student: 'STRANGER' }, S)) && den(g({ action: 'p4_admin_list_teachers' }, S)) && den(g({ action: 'p3_admin_set_role' }, S)));
  t('hand: teacher token cannot use session-only or T rows', den(g({ action: 'p4_tg_status' }, T)) && den(g({ action: 'admin_grading_queue' }, T)) && den(g({ action: 'admin_list_payments' }, T)));
  t('hand: teacher session cannot use token-only rows', den(g({ action: 'upload_attachment', subject: 'math', lesson: 'x' }, S)) && den(g({ action: 'admin_set_quiz_content', lesson: MATH }, S)));
  t('hand: unknown admin_/p3_admin_/p4_admin_ actions denied for teacher and assistant', ['admin_x', 'p3_admin_x', 'p4_admin_x'].every(a => den(g({ action: a }, S)) && den(g({ action: a }, T)) && den(g({ action: a }, AS))));
  t('hand: unknown non-admin actions pass (att_*, future student actions)', ['att_login', 'att_anything', 'get_something_new', ''].every(a => !den(g({ action: a }, S))));
  t('hand: missing action passes (the router answers Unknown action)', !den(g({}, S)));
  t('hand: prototype names are not rows', !den(g({ action: 'constructor' }, S)) && !den(g({ action: '__proto__' }, S)) && !den(g({ action: 'toString' }, S)));
  t('hand: owner and student paths on get_written_image are untouched', !den(g({ action: 'get_written_image', submission_id: 'SUB-P', question_id: 'Q1' }, api.ADMIN)) && !den(g({ action: 'get_written_image', submission_id: 'SUB-P', question_id: 'Q1' }, api.S('hana'))));

  // Both-field rules
  t('upload_attachment: subject must be covered; a lesson naming another subject is refused', !den(g({ action: 'upload_attachment', subject: 'math', lesson: 'sat-foo' }, T)) && !den(g({ action: 'upload_attachment', subject: 'Math', lesson: MATH }, T)) && den(g({ action: 'upload_attachment', subject: 'math', lesson: PROG }, T)) && den(g({ action: 'upload_attachment', subject: 'programming', lesson: 'x' }, T)) && den(g({ action: 'upload_attachment', lesson: MATH }, T)) && den(g({ action: 'upload_attachment', subject: ['math'], lesson: 'x' }, T)));

  // delete_attachment resolution
  const del = f => g({ action: 'delete_attachment', file_id: f }, T);
  t('delete_attachment: math file ok', !den(del('F-MATH')));
  t('delete_attachment: programming file denied', den(del('F-PROG')));
  t('delete_attachment: file outside the attachments folder denied', den(del('F-OUT')));
  t('delete_attachment: unparseable name denied', den(del('F-ODD')));
  t('delete_attachment: lesson part naming another subject denied', den(del('F-MIX')));
  t('delete_attachment: unknown id, empty, missing, non-string denied', den(del('F-NONE')) && den(del('')) && den(g({ action: 'delete_attachment' }, T)) && den(del(['F-MATH'])) && den(del(null)));
  api.env.props.ATTACHMENTS_FOLDER_ID = '';
  t('delete_attachment: folder not configured denied', den(del('F-MATH')));
  api.env.props.ATTACHMENTS_FOLDER_ID = 'ATT';
  t('delete_attachment: owner passes unresolved ids (handler decides)', !den(g({ action: 'delete_attachment', file_id: 'F-OUT' }, { token: 'tok' })));

  // Written answers: the stored row decides, not the request
  const wr = (a, p, id) => g(Object.assign({ action: a, question_id: 'Q1' }, p), id);
  t('written: math answer of an owned student ok', !den(wr('admin_grade_written', { submission_id: 'SUB-M' }, S)) && !den(wr('get_written_image', { submission_id: 'SUB-M' }, S)) && !den(wr('admin_grade_written', { submission_id: 'SUB-M' }, AS)));
  t('written: programming answer denied', den(wr('admin_grade_written', { submission_id: 'SUB-P' }, S)) && den(wr('get_written_image', { submission_id: 'SUB-P' }, S)));
  t('written: math answer of a student he does not own denied', den(wr('admin_grade_written', { submission_id: 'SUB-F' }, S)) && den(wr('get_written_image', { submission_id: 'SUB-F' }, S)));
  t('written: a forged student/lesson in the request changes nothing', den(wr('admin_grade_written', { submission_id: 'SUB-F', student: 'OWNED', lesson: MATH }, S)) && den(wr('get_written_image', { submission_id: 'SUB-P', student: 'OWNED', lesson: MATH, scope: MATH }, S)));
  t('written: unknown or missing ids denied', den(wr('admin_grade_written', { submission_id: 'NOPE' }, S)) && den(g({ action: 'admin_grade_written' }, S)) && den(g({ action: 'get_written_image', submission_id: 'SUB-M' }, S)));

  // payment_id on revoke: the handler ignores phone/scope then, so the payment's own subject decides
  t('revoke by payment_id: checks the payment, not the fields', !den(g({ action: 'admin_revoke_access', payment_id: 'PAY-MATH' }, S)) && den(g({ action: 'admin_revoke_access', payment_id: 'PAY-PROG' }, S)) && den(g({ action: 'admin_revoke_access', payment_id: 'PAY-PROG', phone: 'OWNED', scope: MATH }, S)) && !den(g({ action: 'admin_revoke_access', phone: 'OWNED', scope: MATH }, S)) && den(g({ action: 'admin_revoke_access', phone: 'STRANGER', scope: MATH }, S)));

  // Optional needs
  t('set_requirement: group optional, checked when present', !den(g({ action: 'admin_set_requirement', lesson: MATH }, S)) && !den(g({ action: 'admin_set_requirement', lesson: MATH, group: 'G-OWN' }, S)) && den(g({ action: 'admin_set_requirement', lesson: MATH, group: 'G-OTHER' }, S)));
  t('set_attendance: every item student must be owned, list required', !den(g({ action: 'admin_followup_set_attendance', lesson: MATH, items: [{ phone: 'OWNED' }, { phone: 'OWNED' }] }, S)) && den(g({ action: 'admin_followup_set_attendance', lesson: MATH, items: [{ phone: 'OWNED' }, { phone: 'STRANGER' }] }, S)) && den(g({ action: 'admin_followup_set_attendance', lesson: MATH, items: [] }, S)) && den(g({ action: 'admin_followup_set_attendance', lesson: MATH }, S)) && den(g({ action: 'admin_followup_set_attendance', items: [{}] }, S)) && den(g({ action: 'admin_followup_set_attendance', items: 'OWNED' }, S)) && den(g({ action: 'admin_followup_set_attendance', items: [{ phone: ['OWNED'] }] }, S)) && den(g({ action: 'admin_followup_set_attendance', items: [{ phone: 'OWNED' }], group: 'G-OTHER' }, S)));
  t('monthly_review: student or group, at least one, each owned', !den(g({ action: 'admin_monthly_review', student: 'OWNED' }, S)) && !den(g({ action: 'admin_monthly_review', group: 'G-OWN' }, S)) && den(g({ action: 'admin_monthly_review' }, S)) && den(g({ action: 'admin_monthly_review', student: 'STRANGER' }, S)) && den(g({ action: 'admin_monthly_review', group: 'G-OTHER' }, S)) && den(g({ action: 'admin_monthly_review', student: 'OWNED', group: 'G-OTHER' }, S)));
  t('student_summary and log_parent_notification need an owned student', !den(g({ action: 'admin_student_summary', student: 'OWNED' }, S)) && den(g({ action: 'admin_student_summary', student: 'STRANGER' }, S)) && den(g({ action: 'admin_student_summary' }, S)) && den(g({ action: 'admin_log_parent_notification', student: 'STRANGER' }, S)));
  t('group rules: GC own/free ok, foreign denied; GP own only', !den(g({ action: 'admin_group_add', group: 'G-OWN', phone: '0105' }, S)) && !den(g({ action: 'admin_group_add', group: 'G-NEW', phone: '0105' }, S)) && den(g({ action: 'admin_group_add', group: 'G-OTHER', phone: '0105' }, S)) && den(g({ action: 'admin_group_remove', group: 'G-NEW' }, S)) && den(g({ action: 'admin_group_remove' }, S)));
  t('group grants need lesson in scope and group owned', !den(g({ action: 'admin_group_grant_access', scope: MATH, group: 'G-OWN' }, S)) && den(g({ action: 'admin_group_grant_access', scope: PROG, group: 'G-OWN' }, S)) && den(g({ action: 'admin_group_grant_access', scope: MATH, group: 'G-OTHER' }, S)) && den(g({ action: 'admin_group_revoke_quiz_access', lesson: MATH, group: 'G-OTHER' }, S)));
  t('link rows: an unowned student may be added to an in-scope lesson', !den(g({ action: 'admin_grant_quiz_access', lesson: MATH, phone: '01099999999' }, S)) && den(g({ action: 'admin_grant_quiz_access', lesson: PROG, phone: '01099999999' }, S)));
  t('S3 function missing -> deny (fail closed)', (() => { const api2 = build(); vm.runInContext('p4_ownsStudent = undefined; p4_paymentInScope = undefined;', api2.env.ctx); const r1 = api2.env.ctx.p4_gate(Object.assign({ action: 'admin_student_summary', student: 'OWNED' }, api2.S('sara'))); const r2 = api2.env.ctx.p4_gate(Object.assign({ action: 'admin_decide_payment', payment_id: 'PAY-MATH' }, api2.S('sara'))); return den(r1) && den(r2); })());
  t('scoped assistant of a two-subject teacher gets both subjects', (() => { const api2 = build(); api2.setRow('01000000002', 'teacher', 'math,programming'); const r = api2.env.ctx.p4_gate(Object.assign({ action: 'admin_set_requirement', lesson: PROG }, api2.S('omar'))); return !r.deny; })());
  t('wrong via ("telegram") never passes the gate', den(c.p4_decide_({ kind: 'teacher', via: 'telegram', id: 'x', subjects: ['math'], principal: 'x' }, { action: 'admin_set_lesson_lock', lesson: MATH })));
  t('gate never throws on junk payloads', [undefined, null, {}, { action: null }, { action: {} }, { action: ['admin_get_all'] }, { action: 5 }].every(p => { try { c.p4_gate(p); return true; } catch (e) { return false; } }));
  t('gate error on a scoped caller fails closed', (() => { const api2 = build(); vm.runInContext('function p4_rowFor_() { throw new Error("boom"); }', api2.env.ctx); return den(api2.env.ctx.p4_gate(Object.assign({ action: 'admin_get_all' }, api2.S('sara')))); })());
  t('gate error on a student does not lock students out', (() => { const api2 = build(); vm.runInContext('function p4_rowFor_() { throw new Error("boom"); }', api2.env.ctx); return !den(api2.env.ctx.p4_gate(Object.assign({ action: 'get_quiz' }, api2.S('hana')))); })());
}

// ---------------------------------------------------------------- fail-closed hooks
{
  const api = build(), c = api.env.ctx, S = api.S('sara'), g = p => c.p4_gate(p);
  const tokP = a => ({ action: a, token: 'math-tok', subject: 'math', lesson: 'x', file_id: 'F-MATH' });
  c.P4_GATE_RAN_ = false; c.P4_CTX_ = null;
  t('H1 false before any gate', c.p4_tokenAllows(tokP('upload_attachment')) === false);
  c.p4_ctx({ token: 'math-tok' });
  t('H1 false when the gate has not run (ctx alone is not enough)', c.p4_tokenAllows(tokP('upload_attachment')) === false);
  t('H1 true after the gate allowed a token row', (g(tokP('upload_attachment')), c.p4_tokenAllows(tokP('upload_attachment')) === true));
  t('H1 true for ping and for each tok row after the gate', (() => { g({ action: 'ping', token: 'math-tok' }); return c.p4_tokenAllows({ action: 'ping', token: 'math-tok' }) === true; })());
  t('H1 false for another action than the one gated (session-only row)', (() => { g(tokP('upload_attachment')); return c.p4_tokenAllows({ action: 'admin_grading_queue', token: 'math-tok' }) === false; })());
  t('H1 false for an O row and a T row', (() => { g(tokP('upload_attachment')); return c.p4_tokenAllows({ action: 'p3_admin_set_role', token: 'math-tok' }) === false && c.p4_tokenAllows({ action: 'p4_tg_status', token: 'math-tok' }) === false; })());
  t('H1 false when the token in the payload is swapped after the gate', (() => { g(tokP('upload_attachment')); return c.p4_tokenAllows({ action: 'upload_attachment', token: 'nope' }) === false; })());
  t('H1 false after a DENIED gate', (() => { const r = g({ action: 'upload_attachment', token: 'math-tok', subject: 'programming', lesson: 'x' }); return !!r.deny && c.p4_tokenAllows({ action: 'upload_attachment', token: 'math-tok' }) === false; })());
  t('H1 false for owner token, student, anon (existing paths decide)', ['tok'].every(tk => { g({ action: 'ping', token: tk }); return c.p4_tokenAllows({ action: 'ping', token: tk }) === false; }) && (() => { g({ action: 'ping' }); return c.p4_tokenAllows({ action: 'ping' }) === false; })());
  t('H1 false for a teacher session caller', (() => { g(Object.assign({ action: 'admin_list_videos' }, S)); return c.p4_tokenAllows({ action: 'admin_list_videos', token: 'math-tok' }) === false; })());
  t('H1: gate state is per request (a new gate resets it)', (() => { g(tokP('upload_attachment')); g({ action: 'get_quiz' }); return c.p4_tokenAllows(tokP('upload_attachment')) === false; })());

  const stu = api.tab('Students'), cols = (() => { const m = {}; for (let i = 1; i <= 20; i++) if (stu.get(1, i)) m[stu.get(1, i)] = i; return m; })();
  const rowVals = r => { const o = []; for (let i = 1; i <= stu.getLastColumn(); i++) o.push(stu.get(r, i)); return o; };
  const sessionP = (a, id) => Object.assign({ action: a }, id);
  c.P4_GATE_RAN_ = false; c.P4_CTX_ = null;
  t('H2 false before any gate', c.p4_teacherAllows(rowVals(3), cols, sessionP('admin_grading_queue', S)) === false);
  g(sessionP('admin_grading_queue', S));
  t('H2 true for the teacher\'s own row on a ses row after the gate', c.p4_teacherAllows(rowVals(3), cols, sessionP('admin_grading_queue', S)) === true);
  t('H2 false for another person\'s row', c.p4_teacherAllows(rowVals(5), cols, sessionP('admin_grading_queue', S)) === false);
  t('H2 false for a wrong session token', c.p4_teacherAllows(rowVals(3), cols, sessionP('admin_grading_queue', { student_id: S.student_id, session_token: 'x' })) === false);
  t('H2 false on an O row and on a token-only row', c.p4_teacherAllows(rowVals(3), cols, sessionP('p3_admin_set_role', S)) === false && c.p4_teacherAllows(rowVals(3), cols, sessionP('upload_attachment', S)) === false);
  t('H2 false once the role was removed after the gate', (() => { g(sessionP('admin_grading_queue', S)); api.setRow('01000000002', 'student', 'math'); const r = c.p4_teacherAllows(rowVals(3), cols, sessionP('admin_grading_queue', S)); api.setRow('01000000002', 'teacher', 'math'); return r === false; })());
  t('H2 false for a scoped assistant (the P3 line handles them)', (() => { g(sessionP('admin_grading_queue', api.S('omar'))); return c.p4_teacherAllows(rowVals(4), cols, sessionP('admin_grading_queue', api.S('omar'))) === false; })());
  t('H2 false after a denied gate', (() => { const r = g(sessionP('p3_admin_set_role', S)); return !!r.deny && c.p4_teacherAllows(rowVals(3), cols, sessionP('admin_grading_queue', S)) === false; })());
  t('H2 false on junk arguments', c.p4_teacherAllows(null, cols, {}) === false && c.p4_teacherAllows(rowVals(3), null, {}) === false && c.p4_teacherAllows(rowVals(3), cols, null) === false);
}

// ---------------------------------------------------------------- filters
{
  const api = build(), c = api.env.ctx;
  const S = api.S('sara'), AS = api.S('omar');
  const run = (a, resp, id) => { c.p4_gate(Object.assign({ action: a }, id)); return JSON.parse(J(c.p4_filter(JSON.parse(J(resp)), Object.assign({ action: a }, id)))); };
  const videos = { ok: true, videos: [{ lesson: MATH, slot: 'lesson' }, { lesson: PROG, slot: 'quiz' }, { slot: 'x' }, { lesson: 'english/ielts/a' }, { lesson: 'Math/other/b', slot: 'lesson' }, { lesson: 'art/x' }, null, 5, { lesson: ['math/x'] }] };
  [['teacher', S], ['scoped assistant', AS]].forEach(([n, id]) => {
    if (n === 'scoped assistant') { /* admin_list_videos has no ses+P3 allow, so it is not reachable for an assistant; the filter itself still serves the ctx */ }
    const ctx = JSON.parse(J(c.p4_ctx(id)));
    const out = JSON.parse(J(c.p4f_admin_list_videos(JSON.parse(J(videos)), ctx, {})));
    t('p4f_admin_list_videos keeps only math rows, drops unrecognised (' + n + ')', J(out.videos.map(v => v.lesson)) === J([MATH, 'Math/other/b']) && out.ok === true, J(out.videos));
  });
  const ls = { ok: true, lessons: [{ lesson: MATH, track: 'math', has_quiz: true }, { lesson: PROG, track: 'programming' }, { track: 'english' }, { foo: 1 }], tracks: ['math', 'programming', 'english', 'art', 7] };
  let r = run('admin_list_lessons', ls, S);
  t('p4f_admin_list_lessons: lessons and tracks', J(r.lessons.map(l => l.lesson)) === J([MATH]) && J(r.tracks) === J(['math']), J(r));
  const tg = { ok: true, tags: [{ lesson: MATH, chapter: 1, term: 1 }, { lesson: PROG, chapter: 2, term: 1 }, { chapter: 3 }] };
  r = run('admin_list_lesson_tags', tg, S);
  t('p4f_admin_list_lesson_tags', J(r.tags) === J([{ lesson: MATH, chapter: 1, term: 1 }]), J(r));
  t('filters keep scalar fields (ok, other keys) untouched', r.ok === true);
  const two = JSON.parse(J(c.p4f_admin_list_videos(JSON.parse(J(videos)), { kind: 'teacher', subjects: ['math', 'programming'], principal: 'x' }, {})));
  t('filter respects a two-subject scope', two.videos.length === 3, J(two.videos));
  const none = JSON.parse(J(c.p4f_admin_list_videos(JSON.parse(J(videos)), { kind: 'assistant', subjects: [], principal: '' }, {})));
  t('filter with no subjects keeps nothing', none.videos.length === 0);
  const orig = JSON.parse(J(videos));
  c.p4f_admin_list_videos(videos, { kind: 'teacher', subjects: ['math'], principal: 'x' }, {});
  t('filter does not mutate its input', J(videos) === J(orig));

  // dispatch through p4_filter
  r = run('admin_list_videos', videos, S);
  t('p4_filter dispatches to p4f_<action> for a teacher', r.videos.length === 2);
  r = run('admin_list_videos', videos, api.ADMIN);
  t('p4_filter leaves the owner untouched', r.videos.length === videos.videos.length);
  r = run('admin_list_videos', videos, { token: 'tok' });
  t('p4_filter leaves the owner token untouched', r.videos.length === videos.videos.length);
  r = run('admin_list_videos', videos, api.S('hana'));
  t('p4_filter leaves a student untouched', r.videos.length === videos.videos.length);
  r = run('admin_list_videos', videos, api.S('lamis'));
  t('p4_filter leaves a legacy assistant untouched', r.videos.length === videos.videos.length);
  c.STUB_CALLS.length = 0;
  r = run('admin_get_all', { ok: true, students: [1] }, S);
  t('p4_filter calls the (stub) S3 filter for a teacher', c.STUB_CALLS.includes('p4f_admin_get_all') && r.ok === true);
  c.STUB_CALLS.length = 0; run('admin_get_all', { ok: true }, api.ADMIN);
  t('p4_filter does not call S3 filters for the owner', c.STUB_CALLS.length === 0);
  r = run('admin_followup_overview', { ok: true, x: 1 }, AS);
  t('p4_filter runs for a scoped assistant too', c.STUB_CALLS.includes('p4f_admin_followup_overview'));
  r = run('admin_set_lesson_lock', { ok: true, lesson: MATH }, S);
  t('p4_filter: row without a filter returns the response as is', r.ok === true && r.lesson === MATH);
  r = run('admin_list_videos', { ok: false, error: 'boom' }, S);
  t('p4_filter: error responses pass through', r.ok === false && r.error === 'boom');
  t('p4_filter: non-object responses pass through', c.p4_filter('x', Object.assign({ action: 'admin_list_videos' }, S)) === 'x' && c.p4_filter(null, Object.assign({ action: 'admin_list_videos' }, S)) === null);
  vm.runInContext('p4f_admin_get_all = undefined;', c);
  r = run('admin_get_all', { ok: true, students: [{ name: 'secret' }] }, S);
  t('p4_filter: a MISSING filter fails closed for a teacher', NOT_AUTH(r) && !/secret/.test(J(r)), J(r));
  r = run('admin_get_all', { ok: true, students: [{ name: 'secret' }] }, api.ADMIN);
  t('p4_filter: a missing filter does not hurt the owner', r.ok === true && r.students.length === 1);
  vm.runInContext('function p4f_admin_get_all() { throw new Error("x"); }', c);
  r = run('admin_get_all', { ok: true }, S);
  t('p4_filter: a throwing filter fails closed', NOT_AUTH(r));
  t('p4_filter works through _p2Post (name, resp, payload)', (() => { const out = c._p2Post('p4_filter', JSON.parse(J(videos)), Object.assign({ action: 'admin_list_videos' }, S)); return out.videos.length === 2; })());
  const api2 = build({ noStubFilters: true });
  const out2 = JSON.parse(J(api2.env.ctx.p4_filter({ ok: true, groups: [{ g: 'x' }] }, Object.assign({ action: 'admin_list_groups' }, api2.S('sara')))));
  t('p4_filter: half-wired deploy (no S3 file) refuses a teacher', /MERGED FROM Phase4_/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8')) || NOT_AUTH(out2));   // moot once S3 is merged (p4_wire --check covers it)
}

// ---------------------------------------------------------------- session scope and ping
{
  const api = build(), c = api.env.ctx, sc = p => JSON.parse(J(c.p4_session_scope(p)));
  let r = sc(api.ADMIN);
  t('p4_session_scope: owner', r.ok && r.role === 'admin' && r.kind === 'owner' && J(r.scope) === '["*"]' && !('principal_name' in r), J(r));
  r = sc(api.S('sara'));
  t('p4_session_scope: teacher', r.ok && r.role === 'teacher' && r.kind === 'teacher' && J(r.scope) === '["math"]' && !('principal_name' in r), J(r));
  r = sc(api.S('omar'));
  t('p4_session_scope: scoped assistant gets principal_name', r.ok && r.role === 'assistant' && r.kind === 'assistant' && J(r.scope) === '["math"]' && r.principal_name === 'Sara Mahmoud', J(r));
  r = sc(api.S('lamis'));
  t('p4_session_scope: legacy assistant', r.kind === 'assistant' && J(r.scope) === '[]' && !('principal_name' in r), J(r));
  r = sc(api.S('hana'));
  t('p4_session_scope: student', r.role === 'student' && J(r.scope) === '[]', J(r));
  r = sc({ student_id: api.P('sara'), session_token: 'stale' });
  t('p4_session_scope: stale session is "none", never an error', r.ok === true && r.role === 'none' && r.kind === 'anon' && J(r.scope) === '[]', J(r));
  t('p4_session_scope: gate treats it as public', !c.p4_gate(Object.assign({ action: 'p4_session_scope' }, api.S('omar'))).deny);

  let p = JSON.parse(J(c.p4_pingDecorate({ ok: true, message: 'pong' }, { action: 'ping', token: 'math-tok' })));
  t('pingDecorate: teacher token', p.ok && p.message === 'pong' && p.kind === 'teacher' && J(p.subjects) === '["math"]' && p.name === 'Sara Mahmoud', J(p));
  p = JSON.parse(J(c.p4_pingDecorate({ ok: true, message: 'pong' }, { action: 'ping', token: 'tok' })));
  t('pingDecorate: owner token', p.kind === 'owner' && J(p.subjects) === '["*"]' && p.name === 'owner', J(p));
  p = JSON.parse(J(c.p4_pingDecorate({ ok: true, message: 'pong' }, { action: 'ping' })));
  t('pingDecorate: never throws on anon', p.kind === 'anon' && J(p.subjects) === '[]' && p.name === '', J(p));
  t('pingDecorate: passes junk responses through', c.p4_pingDecorate(null, {}) === null && c.p4_pingDecorate('x', {}) === 'x');
}

// ---------------------------------------------------------------- the file itself
{
  const api = build(), c = api.env.ctx;
  const src = fs.readFileSync(path.join(APPS, 'chunks', 'Phase4_Scope.gs'), 'utf8');
  const mine = [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]);
  const theirs = new Set([...CODE_TEXT.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]));
  const clash = mine.filter(n => theirs.has(n));
  t('defines no function named like one in Code.gs (' + mine.length + ' functions)', /MERGED FROM Phase4_/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8')) || clash.length === 0, clash.join(','));   // after assembly the chunks ARE in Code.gs; p4_wire --check rejects duplicate names
  t('every function starts with p4_ or p4f_', mine.every(n => /^p4f?_/.test(n)), mine.filter(n => !/^p4f?_/.test(n)).join(','));
  const vars = [...src.matchAll(/^var\s+([A-Za-z0-9_$]+)/gm)].map(m => m[1]);
  t('every top-level var starts with P4_', vars.every(n => /^P4_/.test(n)), vars.join(','));
  t('does not edit or redefine Code.gs globals', /MERGED FROM Phase4_/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8')) || !vars.some(n => new RegExp('^var ' + n + '\\b', 'm').test(CODE_TEXT)));
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n').replace(/\s\/\/ .*$/gm, '');
  t('every error text in code is exactly "Not authorized."', [...code.matchAll(/error:\s*"([^"]*)"/g)].every(m => m[1] === 'Not authorized.') && (code.match(/error:\s*"/g) || []).length === 1);
  t('the file has no tabs and no BOM', !/\t/.test(src) && src.charCodeAt(0) !== 0xFEFF);
  const r = c.p4_selfTest();
  t('p4_selfTest() says ALL PASS', r === 'ALL PASS', r);
  vm.runInContext('function p4_selfTest_people() { return "FAIL x"; }', c);
  t('p4_selfTest() reports a failing sibling test', c.p4_selfTest() !== 'ALL PASS');
  vm.runInContext('function p4_selfTest_people() { return "ALL PASS"; } function p4_selfTest_team() { return true; } function p4_selfTest_tg() { throw new Error("x"); }', c);
  t('p4_selfTest() calls people/team/tg and survives a throw', c.p4_selfTest() !== 'ALL PASS');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
