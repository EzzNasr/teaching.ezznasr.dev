// P4 / S5: teacher accounts and tokens, teacher-appointed assistants, student record edits (not the phone cascade).
// Usage: node tests/test_p4_s5_team.js
// Builds the usual Phase 2 env, loads chunks/Phase4_Team.gs into the same context and stubs S2 / S3 / S6 (contract section 9).
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeEnv } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const APPS = path.join(__dirname, '..', 'apps_script');
const CODE = fs.readFileSync(path.join(APPS, 'Code.gs'), 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const NOT_AUTH = r => r && r.ok === false && r.error === 'Not authorized.';
const GENERIC = r => r && r.ok === false && r.error === 'Could not apply that change.';

const STUBS = `
var TEST_CTX = null, PINGS = [], OWNED = {}, LOOKUPS = 0;
function p4_ctx() { return TEST_CTX; }
function p4_ownsStudent(ctx, p) { return ctx.kind === 'owner' || OWNED[_normalizePhone(p)] === true; }
function p4_ownerPing_(txt) { PINGS.push(txt); }
`;

function build(opts = {}) {
  const api = makeEnv(opts);
  const ctx = api.env.ctx;
  // The mock only knows MD5; add SHA-256 here (tests only).
  ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  const md5 = ctx.Utilities.computeDigest;
  ctx.Utilities.computeDigest = (alg, s) => alg === 'sha256' ? [...crypto.createHash('sha256').update(String(s)).digest()].map(b => (b > 127 ? b - 256 : b)) : md5(alg, s);
  const f = path.join(APPS, 'chunks', 'Phase4_Team.gs');
  vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: 'Phase4_Team.gs' });
  if (!opts.noStubs) vm.runInContext(STUBS, ctx);
  api.ctx = ctx;
  api.call = (fn, payload) => { try { return ctx[fn](payload || {}); } catch (e) { return { ok: false, error: 'THROWN: ' + e.message }; } };
  api.as = c => { ctx.TEST_CTX = c; };
  api.owner = () => api.as({ kind: 'owner', via: 'session', id: '01000000001', subjects: ['*'], principal: '' });
  api.teacher = ph => api.as({ kind: 'teacher', via: 'session', id: ph, subjects: ['math'], principal: ph });
  api.assistantOf = (ph, tph) => api.as({ kind: 'assistant', via: 'session', id: ph, subjects: ['math'], principal: tph });
  api.reg = (ph, nm, parent) => api.post({ action: 'register_student', phone: ph, password_hash: sha(ph), display_name: nm, year: 'Senior 2', parent_phone: parent || '01100000009' });
  api.stu = () => api.tab('Students');
  api.cell = (ph, col) => { const s = api.stu(); const c = api.colOf(s, col); for (let r = 2; r <= s.getLastRow(); r++) if (String(s.get(r, api.colOf(s, 'phone'))).slice(-10) === ph.slice(-10)) return s.get(r, c); return undefined; };
  api.logRows = () => api.rows('StudentEditLog');
  api.ownedSet = (...phones) => { ctx.OWNED = {}; phones.forEach(p => { ctx.OWNED[p] = true; }); };
  return api;
}

const TZ = '01000000010';          // the math teacher
const ASSIST = i => '0100000002' + i;   // spare students for assistants

function world(opts) {
  const api = build(opts);
  api.reg(TZ, 'Ziad Teacher');
  api.reg('01000000011', 'Other Teacher');
  for (let i = 0; i < 8; i++) api.reg(ASSIST(i), 'Assist ' + i);
  api.call('p4_setup');
  return api;
}

// ---------------------------------------------------------------- self test + setup
{
  const api = build();
  t('p4_selfTest_team: ALL PASS', api.call('p4_selfTest_team') === 'ALL PASS' || api.ctx.p4_selfTest_team() === 'ALL PASS');
}
{
  const api = build();
  api.ctx.p4_setup();
  const s1 = api.stu();
  t('p4_setup adds role, teacher_scope, assistant_of', ['role', 'teacher_scope', 'assistant_of'].every(h => api.colOf(s1, h) > 0));
  const heads = n => { const sh = api.tab(n); return sh ? [1, 2, 3, 4, 5, 6, 7, 8].map(c => sh.get(1, c)).filter(Boolean).join(',') : null; };
  t('GroupOwners headers', heads('GroupOwners') === 'group,owner_id,created_at', heads('GroupOwners'));
  t('TeacherTelegram headers', heads('TeacherTelegram') === 'teacher_id,chat_id,linked_at', heads('TeacherTelegram'));
  t('StudentEditLog headers', heads('StudentEditLog') === 'ts,actor_kind,actor_id,student_old,student_new,field,old_value,new_value', heads('StudentEditLog'));
  const before = JSON.stringify([heads('GroupOwners'), heads('StudentEditLog'), s1.getLastColumn(), api.env.props.P4_TEACHER_TOKENS]);
  api.ctx.p4_setup();
  const after = JSON.stringify([heads('GroupOwners'), heads('StudentEditLog'), api.stu().getLastColumn(), api.env.props.P4_TEACHER_TOKENS]);
  t('p4_setup is idempotent', before === after, before + ' vs ' + after);
  t('p4_setup: phone edit ships off, max assistants 5', api.env.props.P4_TEACHER_PHONE_EDIT === '0' && api.env.props.P4_MAX_ASSISTANTS === '5');
}

// ---------------------------------------------------------------- tokens
{
  const api = world();
  const raw = api.ctx.p4_mint_teacher_token('Ziad laptop', 'math');
  const stored = api.env.props.P4_TEACHER_TOKENS;
  const hash = sha(raw);
  t('mint returns a long raw token', typeof raw === 'string' && raw.length >= 60);
  t('mint stores the SHA-256 hex only', stored.includes(hash) && !stored.includes(raw), stored);
  const o = JSON.parse(stored)[hash];
  t('stored entry has name, scope, created', o && o.name === 'Ziad laptop' && o.scope === 'math' && /^\d{4}-\d\d-\d\dT/.test(o.created), JSON.stringify(o));
  let err = ''; try { api.ctx.p4_mint_teacher_token('ziad LAPTOP', 'math'); } catch (e) { err = e.message; }
  t('duplicate token name refused', /already exists/.test(err), err);
  err = ''; try { api.ctx.p4_mint_teacher_token('x', '*'); } catch (e) { err = e.message; }
  t('scope * refused for a teacher token', /Scope must be/.test(err), err);
  err = ''; try { api.ctx.p4_mint_teacher_token('x', 'art'); } catch (e) { err = e.message; }
  t('unknown subject refused', /Scope must be/.test(err), err);
  err = ''; try { api.ctx.p4_mint_teacher_token('', 'math'); } catch (e) { err = e.message; }
  t('empty token name refused', /Token name/.test(err), err);
  api.owner();
  const l = api.call('p4_admin_list_teachers');
  t('list shows token name/scope/created, never a hash or the raw token', l.ok && l.tokens.length === 1 && l.tokens[0].name === 'Ziad laptop' && !JSON.stringify(l).includes(hash) && !JSON.stringify(l).includes(raw), JSON.stringify(l));
  t('revoke removes it', api.ctx.p4_revoke_teacher_token('ziad laptop') === 1 && api.env.props.P4_TEACHER_TOKENS === '{}');
}

// ---------------------------------------------------------------- accounts
{
  const api = world();
  for (const who of [null, { kind: 'anon', subjects: [], principal: '' }, { kind: 'student', subjects: [], principal: '', id: '01000000002' }, { kind: 'teacher', subjects: ['math'], principal: TZ, id: TZ }]) {
    api.as(who);
    t('set_teacher refused for ' + (who ? who.kind : 'no ctx'), NOT_AUTH(api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' })));
    t('list_teachers refused for ' + (who ? who.kind : 'no ctx'), NOT_AUTH(api.call('p4_admin_list_teachers')));
    t('list_edit_log refused for ' + (who ? who.kind : 'no ctx'), NOT_AUTH(api.call('p4_admin_list_edit_log')));
  }
  api.owner();
  let r = api.call('p4_admin_set_teacher', { phone: TZ, scope: 'Math' });
  t('owner makes a teacher', r.ok && r.role === 'teacher' && r.scope === 'math' && r.phone === TZ, JSON.stringify(r));
  t('role and teacher_scope written, assistant_of blank', api.cell(TZ, 'role') === 'teacher' && api.cell(TZ, 'teacher_scope') === 'math' && !api.cell(TZ, 'assistant_of'));
  t('other rows untouched', !api.cell('01000000011', 'role') && !api.cell('01000000011', 'teacher_scope'));
  r = api.call('p4_admin_set_teacher', { phone: '01000000001', scope: 'math' });
  t('owner target refused', r.ok === false && /owner/i.test(r.error) && !api.cell('01000000001', 'teacher_scope'), JSON.stringify(r));
  t('unknown phone refused', api.call('p4_admin_set_teacher', { phone: '01999999999', scope: 'math' }).ok === false);
  t('scope * refused', api.call('p4_admin_set_teacher', { phone: '01000000011', scope: '*' }).ok === false && !api.cell('01000000011', 'role'));
  t('unknown subject refused', api.call('p4_admin_set_teacher', { phone: '01000000011', scope: 'art' }).ok === false);
  r = api.call('p4_admin_set_teacher', { phone: '01000000011', scope: 'math,english' });
  t('two subjects allowed', r.ok && r.scope === 'math,english');
  api.call('p4_admin_set_teacher', { phone: '01000000011', scope: '' });

  // assistants of two teachers, then remove the first teacher
  api.call('p4_admin_set_teacher', { phone: '01000000011', scope: 'math' });
  api.teacher(TZ);   api.ownedSet();
  api.call('p4_teacher_set_assistant', { phone: ASSIST(0) }); api.call('p4_teacher_set_assistant', { phone: ASSIST(1) });
  api.teacher('01000000011');
  api.call('p4_teacher_set_assistant', { phone: ASSIST(2) });
  api.owner();
  // legacy owner assistant (no assistant_of)
  api.post(Object.assign({ action: 'p3_admin_set_role', phone: ASSIST(3), role: 'assistant' }, api.ADMIN));
  let list = api.call('p4_admin_list_teachers');
  const z = list.teachers.find(x => x.phone === TZ);
  t('list: teachers with their assistants and telegram flag', list.ok && list.teachers.length === 2 && z.scope === 'math' && z.telegram === false && z.assistants.length === 2 && z.name === 'Ziad Teacher', JSON.stringify(list));
  t('list never shows the legacy owner assistant under a teacher', !JSON.stringify(list.teachers).includes(ASSIST(3)));
  api.ensure('TeacherTelegram', ['teacher_id', 'chat_id', 'linked_at']).appendRow([TZ, '555', '2026-10-30']);
  list = api.call('p4_admin_list_teachers');
  t('telegram flag comes from TeacherTelegram', list.teachers.find(x => x.phone === TZ).telegram === true && list.teachers.find(x => x.phone === '01000000011').telegram === false);
  r = api.call('p4_admin_set_teacher', { phone: TZ, scope: '' });
  t('removal returns role student', r.ok && r.role === 'student' && r.scope === '', JSON.stringify(r));
  t('removal clears role and scope', !api.cell(TZ, 'role') && !api.cell(TZ, 'teacher_scope'));
  t('removal resets BOTH his assistants', !api.cell(ASSIST(0), 'role') && !api.cell(ASSIST(0), 'assistant_of') && !api.cell(ASSIST(1), 'role') && !api.cell(ASSIST(1), 'assistant_of'));
  t('another teacher\'s assistant is untouched', api.cell(ASSIST(2), 'role') === 'assistant' && String(api.cell(ASSIST(2), 'assistant_of')).slice(-10) === '1000000011');
  t('legacy owner assistant is untouched', api.cell(ASSIST(3), 'role') === 'assistant');
  r = api.call('p4_admin_set_teacher', { phone: ASSIST(3), scope: '' });
  t('removing a scope from a non-teacher leaves a legacy assistant alone', r.ok && api.cell(ASSIST(3), 'role') === 'assistant' && r.role === 'assistant', JSON.stringify(r));
  const au = api.getSS('DATA').getSheetByName('AuditLog');
  let n = 0; for (let i = 2; i <= au.getLastRow(); i++) if (au.get(i, 3) === 'p4_admin_set_teacher') n++;
  t('account changes are audited', n >= 2, String(n));
}

// ---------------------------------------------------------------- assistants
{
  const api = world();
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' }); api.call('p4_admin_set_teacher', { phone: '01000000011', scope: 'math' });
  const tOther = '01000000011';
  api.teacher(tOther); api.call('p4_teacher_set_assistant', { phone: ASSIST(7) });
  api.post(Object.assign({ action: 'p3_admin_set_role', phone: ASSIST(6), role: 'assistant' }, api.ADMIN));   // legacy
  api.teacher(TZ);

  let r = api.call('p4_teacher_set_assistant', { phone: ASSIST(0) });
  t('appoint a registered student', r.ok === true && r.registered === true && api.cell(ASSIST(0), 'role') === 'assistant' && String(api.cell(ASSIST(0), 'assistant_of')).slice(-10) === TZ.slice(-10), JSON.stringify(r));
  t('assistant_of keeps the leading zero as text', api.cell(ASSIST(0), 'assistant_of') === TZ, String(api.cell(ASSIST(0), 'assistant_of')));
  r = api.call('p4_teacher_set_assistant', { phone: '01555555555' });
  t('unregistered phone: same shape, registered false, no row written', r.ok === true && r.registered === false && Object.keys(r).sort().join() === 'ok,registered');
  const snap = () => JSON.stringify(['01000000001', tOther, ASSIST(7), ASSIST(6)].map(p => [api.cell(p, 'role'), api.cell(p, 'assistant_of'), api.cell(p, 'teacher_scope'), api.cell(p, 'is_admin')]));
  const s0 = snap();
  r = api.call('p4_teacher_set_assistant', { phone: '01000000001' });
  t('owner target: ok/registered true, nothing changes', r.ok && r.registered === true && snap() === s0 && !api.cell('01000000001', 'assistant_of'));
  r = api.call('p4_teacher_set_assistant', { phone: tOther });
  t('another teacher: ok/registered true, nothing changes', r.ok && r.registered === true && snap() === s0);
  r = api.call('p4_teacher_set_assistant', { phone: ASSIST(7) });
  t('another teacher\'s assistant: not taken over', r.ok && r.registered === true && String(api.cell(ASSIST(7), 'assistant_of')).slice(-10) === tOther.slice(-10));
  r = api.call('p4_teacher_set_assistant', { phone: ASSIST(6) });
  t('legacy owner assistant: not taken over', r.ok && r.registered === true && !api.cell(ASSIST(6), 'assistant_of'));
  r = api.call('p4_teacher_set_assistant', { phone: TZ });
  t('appointing himself: ok, no change', r.ok && api.cell(TZ, 'role') === 'teacher' && !api.cell(TZ, 'assistant_of'));
  r = api.call('p4_teacher_set_assistant', { phone: '' });
  t('blank phone: ok/registered false', r.ok === true && r.registered === false);

  // max 5 (silently)
  api.reg('01000000040', 'Extra A'); api.reg('01000000041', 'Extra B'); api.reg('01000000042', 'Extra C');
  api.call('p4_teacher_set_assistant', { phone: ASSIST(1) }); api.call('p4_teacher_set_assistant', { phone: ASSIST(2) });
  api.call('p4_teacher_set_assistant', { phone: ASSIST(3) }); api.call('p4_teacher_set_assistant', { phone: ASSIST(4) });
  const l5 = api.call('p4_teacher_list_assistants');
  t('five appointed, list says max 5', l5.ok && l5.assistants.length === 5 && l5.max === 5, JSON.stringify(l5));
  r = api.call('p4_teacher_set_assistant', { phone: ASSIST(5) });
  t('sixth: identical answer, row NOT written', r.ok === true && r.registered === true && !api.cell(ASSIST(5), 'role') && api.call('p4_teacher_list_assistants').assistants.length === 5);
  t('list contains only his own (never the other teacher\'s or legacy ones)', !JSON.stringify(l5).includes(ASSIST(7)) && !JSON.stringify(l5).includes(ASSIST(6)));
  api.env.props.P4_MAX_ASSISTANTS = '6';
  api.call('p4_teacher_set_assistant', { phone: ASSIST(5) });
  t('P4_MAX_ASSISTANTS is read from Script Properties', api.cell(ASSIST(5), 'role') === 'assistant');
  api.env.props.P4_MAX_ASSISTANTS = '5';

  // revoke
  r = api.call('p4_teacher_revoke_assistant', { phone: ASSIST(7) });
  t('revoke another teacher\'s assistant: Not authorized, unchanged', NOT_AUTH(r) && api.cell(ASSIST(7), 'role') === 'assistant');
  r = api.call('p4_teacher_revoke_assistant', { phone: ASSIST(6) });
  t('revoke a legacy owner assistant: Not authorized, unchanged', NOT_AUTH(r) && api.cell(ASSIST(6), 'role') === 'assistant');
  r = api.call('p4_teacher_revoke_assistant', { phone: '01555555555' });
  t('revoke an unknown phone: same Not authorized', NOT_AUTH(r));
  r = api.call('p4_teacher_revoke_assistant', { phone: ASSIST(0) });
  t('revoke his own assistant', r.ok === true && !api.cell(ASSIST(0), 'role') && !api.cell(ASSIST(0), 'assistant_of'));
  t('revoking twice: Not authorized', NOT_AUTH(api.call('p4_teacher_revoke_assistant', { phone: ASSIST(0) })));

  // who may call
  api.assistantOf(ASSIST(1), TZ);
  t('a scoped assistant cannot appoint', NOT_AUTH(api.call('p4_teacher_set_assistant', { phone: ASSIST(5) })));
  t('a scoped assistant cannot list or revoke', NOT_AUTH(api.call('p4_teacher_list_assistants')) && NOT_AUTH(api.call('p4_teacher_revoke_assistant', { phone: ASSIST(2) })));
  api.as({ kind: 'student', subjects: [], principal: '', id: ASSIST(5) });
  t('a student cannot appoint', NOT_AUTH(api.call('p4_teacher_set_assistant', { phone: ASSIST(5) })));
  api.owner();
  t('the owner is not a teacher here (use p3_admin_set_role)', NOT_AUTH(api.call('p4_teacher_set_assistant', { phone: ASSIST(5) })));
  api.as(null);
  t('no ctx at all: refused', NOT_AUTH(api.call('p4_teacher_list_assistants')));
  // a ctx that claims teacher but whose row is not a teacher any more (scope removed meanwhile)
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: '' }); api.teacher(TZ);
  t('stale teacher ctx is re-checked against the sheet', NOT_AUTH(api.call('p4_teacher_set_assistant', { phone: ASSIST(5) })) && NOT_AUTH(api.call('p4_teacher_list_assistants')));
}

// ---------------------------------------------------------------- appointment lookup bucket
{
  const api = world();
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' }); api.teacher(TZ);
  let last = null, regs = 0;
  for (let i = 0; i < 31; i++) { last = api.call('p4_teacher_set_assistant', { phone: '0155555' + String(1000 + i) }); if (last.ok) regs++; }
  t('fallback bucket: 30 lookups allowed, the 31st is refused', regs === 30 && last.ok === false && last.error === 'Too many requests.', JSON.stringify(last));
  t('the bucket is keyed by the principal (p4lk:<id>)', Object.keys(api.env.cache).some(k => k === 'p4lk:' + TZ || k.indexOf('p4lk:' + String(TZ).slice(-10) + ':') === 0), Object.keys(api.env.cache).join());
  // S3's helper wins when it exists
  const api2 = world();
  api2.owner(); api2.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' }); api2.teacher(TZ);
  require('vm').runInContext('function p4_lookupAllowed_(c) { LOOKUPS++; return LOOKUPS <= 2; }', api2.ctx);
  api2.call('p4_teacher_set_assistant', { phone: ASSIST(0) }); api2.call('p4_teacher_set_assistant', { phone: ASSIST(1) });
  const third = api2.call('p4_teacher_set_assistant', { phone: ASSIST(2) });
  t('S3 helper used (typeof guard): 3rd call refused, row not written', api2.ctx.LOOKUPS === 3 && third.ok === false && !api2.cell(ASSIST(2), 'role') && Object.keys(api2.env.cache).every(k => !k.startsWith('p4lk:')), JSON.stringify(third));
}

// ---------------------------------------------------------------- record edits
{
  const api = world();
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' });
  api.ownedSet('01000000002', '01000000003');      // sara and omar are his
  api.teacher(TZ);
  const S = '01000000002';
  const edit = (student, changes) => api.call('p4_teacher_update_student', { student, changes });
  const state = () => JSON.stringify([api.cell(S, 'display_name'), api.cell(S, 'phone'), api.cell(S, 'parent_phone'), api.cell(S, 'is_admin'), api.cell(S, 'role'), api.cell(S, 'password_hash'), api.cell(S, 'session_token'), api.logRows().length]);

  let r = edit(S, { name: '  Sara M. Mahmoud ', parent_phone: '01234567890' });
  t('name + parent phone edit works (phone flag is off)', r.ok === true && r.student.name === 'Sara M. Mahmoud' && r.student.parent_phone === '01234567890' && r.student.phone === S, JSON.stringify(r));
  t('response carries exactly the three fields', Object.keys(r.student).sort().join() === 'name,parent_phone,phone');
  t('sheet updated', api.cell(S, 'display_name') === 'Sara M. Mahmoud' && api.cell(S, 'parent_phone') === '01234567890');
  let log = api.logRows();
  t('one log row per changed field (2)', log.length === 2 && log.map(x => x.field).sort().join() === 'name,parent_phone', JSON.stringify(log));
  t('log row content', log[0].actor_kind === 'teacher' && log[0].actor_id === TZ && log[0].student_old === S && log[0].student_new === S && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(log[0].ts) &&
    log.find(x => x.field === 'name').old_value === 'Sara Mahmoud' && log.find(x => x.field === 'name').new_value === 'Sara M. Mahmoud', JSON.stringify(log));
  t('no owner ping for a name / parent edit', (api.ctx.PINGS || []).length === 0);
  t('log phones kept as text with the leading 0', log[0].student_old.startsWith('0'));

  const s0 = state();
  r = edit(S, { name: 'Sara M. Mahmoud', parent_phone: '+20 123 456 7890' });
  t('unchanged values: ok, student returned, nothing written, nothing logged', r.ok === true && r.student.name === 'Sara M. Mahmoud' && state() === s0, JSON.stringify(r));
  const s1 = state();
  for (const [label, ch] of [
    ['extra key is_admin (with a valid name)', { name: 'Valid Name', is_admin: true }],
    ['extra key role', { role: 'teacher' }],
    ['extra key password_hash', { password_hash: 'x' }],
    ['extra key year', { year: 'Senior 1' }],
    ['empty changes', {}],
    ['changes not an object', 'name'],
    ['changes an array', ['name']],
    ['name too short', { name: 'A' }],
    ['name only spaces', { name: '    ' }],
    ['name 81 chars', { name: 'x'.repeat(81) }],
    ['name is a number', { name: 12345 }],
    ['name null', { name: null }],
    ['parent landline', { parent_phone: '034567890' }],
    ['parent letters', { parent_phone: 'abc' }],
    ['parent blank', { parent_phone: '' }],
    ['parent object', { parent_phone: {} }],
    ['phone landline', { phone: '034567890' }],
    ['phone too short', { phone: '0101' }],
  ]) {
    r = edit(S, ch);
    t('refused whole request: ' + label, GENERIC(r) && state() === s1, JSON.stringify(r));
  }
  r = edit(S, { name: 'Sara\u0000 \u0007Ahmed\n' });
  t('control characters are stripped', r.ok && r.student.name === 'Sara Ahmed', JSON.stringify(r));
  r = edit(S, { name: 'x'.repeat(80) });
  t('80 characters is allowed', r.ok === true && r.student.name.length === 80);
  r = edit(S, { name: '<script>alert(1)</script>' });
  t('a <script> name is stored and returned unchanged (plain text, never executed)', r.ok && r.student.name === '<script>alert(1)</script>' && api.cell(S, 'display_name') === '<script>alert(1)</script>');
  r = edit(S, { name: '=HYPERLINK("x")' });
  t('a formula-looking name stays text', r.ok && api.cell(S, 'display_name') === '=HYPERLINK("x")');
  edit(S, { name: 'Sara Mahmoud' });

  // phone change while the flag is off: whole request refused, even with a valid name
  const s2 = state();
  r = edit(S, { phone: '01099999999', name: 'Should Not Apply' });
  t('P4_TEACHER_PHONE_EDIT default 0: phone change refuses the whole request', GENERIC(r) && state() === s2, JSON.stringify(r));
  t('flag off: no owner ping', (api.ctx.PINGS || []).length === 0);

  // ownership
  const nonOwned = ['01000000004', '01000000005', TZ, '01000000011', '01000000001', ASSIST(0), '01777777777', '', 'abc'];
  api.owner(); api.call('p4_admin_set_teacher', { phone: '01000000011', scope: 'math' }); api.teacher(TZ);
  api.ownedSet('01000000002', '01000000003', '01000000004', TZ, '01000000011', '01000000001');   // even if the stub says "owned", a staff row is never editable
  api.post(Object.assign({ action: 'p3_admin_set_role', phone: ASSIST(0), role: 'assistant' }, api.ADMIN));
  api.ctx.OWNED[ASSIST(0)] = true;
  const before = JSON.stringify(['01000000004', '01000000011', '01000000001', TZ, ASSIST(0)].map(p => [api.cell(p, 'display_name'), api.cell(p, 'parent_phone'), api.cell(p, 'role')]));
  for (const p of [TZ, '01000000011', '01000000001', ASSIST(0), '01777777777', '', 'abc']) {
    r = edit(p, { name: 'Hacked Name' });
    t('staff / unknown target is Not authorized: ' + (p || '(blank)'), NOT_AUTH(r) && !('student' in r), JSON.stringify(r));
  }
  api.ownedSet('01000000002');
  r = edit('01000000003', { name: 'Hacked Name' });
  t('a student he does not own: Not authorized, no data back', NOT_AUTH(r) && !('student' in r) && api.cell('01000000003', 'display_name') === 'Omar Ali', JSON.stringify(r));
  t('nothing else was touched', before === JSON.stringify(['01000000004', '01000000011', '01000000001', TZ, ASSIST(0)].map(p => [api.cell(p, 'display_name'), api.cell(p, 'parent_phone'), api.cell(p, 'role')])));
  api.ownedSet('01000000002', '01000000003');
  // callers
  api.assistantOf(ASSIST(1), TZ);
  t('a scoped assistant caller is refused', NOT_AUTH(edit(S, { name: 'By Assistant' })) && api.cell(S, 'display_name') === 'Sara Mahmoud');
  api.owner();
  t('the owner caller is refused here (not a teacher)', NOT_AUTH(edit(S, { name: 'By Owner' })));
  api.as({ kind: 'student', subjects: [], principal: '', id: S });
  t('a student caller is refused', NOT_AUTH(edit(S, { name: 'By Student' })));
  api.as(null);
  t('no ctx: refused', NOT_AUTH(edit(S, { name: 'By Nobody' })));
  t('password, session and flags never touched by edits', api.cell(S, 'password_hash') === sha('sara') && !api.cell(S, 'is_admin'));
}

// ---------------------------------------------------------------- phone edit end to end (flag on) + collisions + ping
{
  const api = world();
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' });
  api.ownedSet('01000000002', '01000000003');
  api.teacher(TZ);
  api.env.props.P4_TEACHER_PHONE_EDIT = '1';
  const edit = (student, changes) => api.call('p4_teacher_update_student', { student, changes });
  const S = '01000000002';
  // collision uses the bucket and gives the generic error
  require('vm').runInContext('function p4_lookupAllowed_(c) { LOOKUPS++; return true; }', api.ctx);
  let r = edit(S, { phone: '01000000003' });
  t('collision: generic error, nothing changed', GENERIC(r) && api.cell(S, 'phone') === S);
  t('collision counted exactly one lookup in the shared bucket', api.ctx.LOOKUPS === 1, String(api.ctx.LOOKUPS));
  r = edit(S, { phone: '+20 100 000 0003' });
  t('collision is found through the last-10-digits rule too', GENERIC(r) && api.ctx.LOOKUPS === 2);
  r = edit(S, { phone: '01000000002' });
  t('same phone: no-op, not a collision with himself', r.ok === true && api.ctx.LOOKUPS === 2 && api.logRows().length === 0);

  r = edit(S, { phone: '+20 109 999 9999', name: 'Sara New', parent_phone: '01555555555' });
  t('phone + name + parent in one request', r.ok === true && r.student.phone === '01099999999' && r.student.name === 'Sara New' && r.student.parent_phone === '01555555555', JSON.stringify(r));
  t('Students row holds the new phone, canonical text', api.cell('01099999999', 'phone') === '01099999999' && api.cell('01099999999', 'display_name') === 'Sara New');
  const log = api.logRows();
  t('three log rows with old -> new phone on each', log.length === 3 && log.every(x => x.student_old === S && x.student_new === '01099999999'), JSON.stringify(log));
  t('log has the old and new phone values', log.some(x => x.field === 'phone' && x.old_value === S && x.new_value === '01099999999'));
  const pings = api.ctx.PINGS || [];
  t('owner pinged once, with teacher, student, old and new phone', pings.length === 1 && /Ziad Teacher/.test(pings[0]) && /Sara New/.test(pings[0]) && pings[0].includes(S) && pings[0].includes('01099999999'), JSON.stringify(pings));
  t('session token and password survive the phone change', api.cell('01099999999', 'password_hash') === sha('sara') && String(api.cell('01099999999', 'session_token')).length > 10);
  // what the student's browser does next
  const sess = api.S('sara');
  let err = ''; try { api.ctx._requireStudentSession({ student_id: S, session_token: sess.session_token }); } catch (e) { err = e.message; }
  t('REPORT: a browser still holding the OLD phone fails the session check ("No matching student.")', /No matching student/.test(err), err);
  t('REPORT: the same token works once the client uses the NEW phone', api.ctx._requireStudentSession({ student_id: '01099999999', session_token: sess.session_token }) === true);
  const login = api.post({ action: 'login_student', phone: '01099999999', password_hash: api.H('sara') });
  t('login with the new phone works and issues a fresh token', login.ok === true && login.student_id === '01099999999' && login.session_token !== sess.session_token);

  // ownership follows the CURRENT phone: the old phone is no longer addressable
  r = edit(S, { name: 'Late Edit' });
  t('old phone no longer resolves: Not authorized', NOT_AUTH(r));
  // ping failure / missing helper never breaks the edit
  require('vm').runInContext('function p4_ownerPing_() { throw new Error("telegram down"); }', api.ctx);
  api.ownedSet('01099999999', '01000000003');
  r = edit('01099999999', { phone: '01088888888' });
  t('a throwing owner ping does not fail the edit', r.ok === true && api.cell('01088888888', 'phone') === '01088888888');
}
{
  // Fail-closed behaviour when other sessions' code is absent (nothing from S3 / S6 injected).
  const api = build({ noStubs: true });
  api.reg(TZ, 'Ziad Teacher'); api.ctx.p4_setup();   // 01000000002 (Sara Mahmoud) already exists in the fixture
  vm.runInContext("function p4_ctx() { return { kind: 'teacher', via: 'session', id: '" + TZ + "', subjects: ['math'], principal: '" + TZ + "' }; }", api.ctx);
  const s = api.stu(); let row = 0;
  for (let r = 2; r <= s.getLastRow(); r++) if (String(s.get(r, api.colOf(s, 'phone'))) === TZ) row = r;
  s.set(row, api.colOf(s, 'role'), 'teacher'); s.set(row, api.colOf(s, 'teacher_scope'), 'math');
  const rr = api.call('p4_teacher_update_student', { student: '01000000002', changes: { name: 'Fail Closed' } });
  t('no p4_ownsStudent present: edit refused (fail closed)', NOT_AUTH(rr) && api.cell('01000000002', 'display_name') === 'Sara Mahmoud', JSON.stringify(rr));
  const rs = api.call('p4_teacher_set_assistant', { phone: '01000000002' });
  t('no S3 bucket helper: appointment works through the fallback bucket', rs.ok === true && rs.registered === true && api.cell('01000000002', 'role') === 'assistant', JSON.stringify(rs));
  api.env.props.P4_TEACHER_PHONE_EDIT = '1';
  vm.runInContext("function p4_ownsStudent() { return true; }", api.ctx);
  const re = api.call('p4_teacher_update_student', { student: '01000000003', changes: { phone: '01077777777' } });
  t('no S6 ping helper (typeof guard): the phone edit still succeeds', re.ok === true && api.cell('01077777777', 'phone') === '01077777777', JSON.stringify(re));
}

// ---------------------------------------------------------------- edit log (owner)
{
  const api = world();
  api.owner(); api.call('p4_admin_set_teacher', { phone: TZ, scope: 'math' });
  api.ownedSet('01000000002', '01000000003'); api.teacher(TZ);
  for (let i = 0; i < 5; i++) api.call('p4_teacher_update_student', { student: '01000000002', changes: { name: 'Name ' + i } });
  api.owner();
  let r = api.call('p4_admin_list_edit_log', {});
  t('edit log: newest first', r.ok && r.rows.length === 5 && r.rows[0].new_value === 'Name 4' && r.rows[4].new_value === 'Name 0', JSON.stringify(r.rows.map(x => x.new_value)));
  r = api.call('p4_admin_list_edit_log', { limit: 2 });
  t('edit log: limit respected', r.rows.length === 2 && r.rows[0].new_value === 'Name 4');
  t('edit log: every row has the contract columns', ['ts', 'actor_kind', 'actor_id', 'student_old', 'student_new', 'field', 'old_value', 'new_value'].every(k => k in r.rows[0]));
  const empty = world(); empty.owner();
  t('edit log with no rows', JSON.stringify(empty.call('p4_admin_list_edit_log', {})) === '{"ok":true,"rows":[]}');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
