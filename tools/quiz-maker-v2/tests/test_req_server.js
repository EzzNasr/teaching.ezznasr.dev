// S4 requirements: Requirements.gs against the REAL Code.gs (one shared scope, like Apps Script).
//   node tests/test_req_server.js            (run from tools/quiz-maker-v2)
// Routing and the assistant allow-list are Session 5's job, so this test calls req_routes_()[action](payload)
// directly. For the assistant cases it adds the five action names to P3_STAFF_ALLOW inside the test context,
// which is exactly what Session 5 ships in Code.gs.
const path = require('path'), crypto = require('crypto');
const { load } = require('./harness');
const APPS = path.join(__dirname, '..', 'apps_script');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x === undefined ? '' : (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300)))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const ACTIONS = ['admin_req_get', 'admin_req_save_global', 'admin_req_save_group', 'admin_req_check', 'admin_req_history',
  'admin_req_month_get', 'admin_req_month_save'];   // Nov 2026: the month's required lessons

function boot() {
  const env = load([path.join(APPS, 'Code.gs'), path.join(APPS, 'Requirements.gs')]);
  const { post, getSS, ctx } = env;
  const reg = (phone, pw, name) => post({ action: 'register_student', phone, password_hash: H(pw), display_name: name, year: 'Senior 2', parent_phone: '01100000009' });
  const adm = reg('01000000001', 'a', 'Teacher');
  const stu = getSS('STU').getSheetByName('Students');
  let col = 0; for (let c = 1; c <= 16; c++) if (stu.get(1, c) === 'is_admin') col = c;
  stu.set(2, col, true);
  const people = {};
  [['sara', '01000000002', 'Sara Mahmoud'], ['omar', '01000000003', 'Omar Ali'], ['nour', '01000000004', 'Nour Hassan'], ['kid', '01000000005', 'Kid Student']].forEach(([k, ph, nm]) => {
    const r = reg(ph, k, nm); people[k] = { phone: ph, creds: { student_id: r.student_id, session_token: r.session_token } };
  });
  const TOK = { token: 'tok' }, ADMIN = { student_id: adm.student_id, session_token: adm.session_token };
  ['sara', 'omar'].forEach(k => post(Object.assign({ action: 'admin_group_add', group: 'Sat 6pm', phone: people[k].phone }, TOK)));
  post(Object.assign({ action: 'admin_group_add', group: 'Mon 5pm', phone: people.nour.phone }, TOK));
  // sara becomes an assistant (is_admin stays blank)
  ctx.p3_admin_set_role(Object.assign({ phone: people.sara.phone, role: 'assistant' }, ADMIN));
  const routes = () => ctx.req_routes_();
  const run = (name, payload) => JSON.parse(JSON.stringify(routes()[name](Object.assign({ action: name }, payload))));
  const sheet = n => getSS('DATA').getSheetByName(n);
  const auditRows = () => { const sh = sheet('AuditLog'); const o = []; if (!sh) return o; for (let r = 2; r <= sh.getLastRow(); r++) o.push({ at: sh.get(r, 1), who: sh.get(r, 2), action: sh.get(r, 3), target: sh.get(r, 4), before: sh.get(r, 5), after: sh.get(r, 6) }); return o; };
  return Object.assign(env, { people, TOK, ADMIN, run, sheet, auditRows, STUDENT: people.kid.creds, ASSISTANT: people.sara.creds });
}
const J = o => JSON.parse(JSON.stringify(o));

const TODAY = {
  watch:           { enabled: true, in_monthly_report: true, parent_message: true,  rule: { pct: 80 }, weight: 1, source: 'default' },
  homework:        { enabled: true, in_monthly_report: true, parent_message: true,  rule: {}, weight: 1, source: 'default' },
  quiz:            { enabled: true, in_monthly_report: true, parent_message: true,  rule: {}, weight: 1, source: 'default' },
  attendance:      { enabled: true, in_monthly_report: true, parent_message: false, rule: {}, weight: 1, source: 'default' },
  written_answers: { enabled: true, in_monthly_report: true, parent_message: false, rule: {}, weight: 1, source: 'default' },
};

// 1. defaults == today's behaviour, and reads never create sheets ---------------------------------------------
{
  const E = boot(), { ctx, run, sheet, ADMIN } = E;
  t('req_effective_("") is exactly today\'s set', JSON.stringify(J(ctx.req_effective_(''))) === JSON.stringify(TODAY), J(ctx.req_effective_('')));
  t('req_effective_(unknown group) = global defaults', JSON.stringify(J(ctx.req_effective_('no such group'))) === JSON.stringify(TODAY));
  t('req_catalog_() has the 5 built-ins in order, auto + per_lesson', JSON.stringify(J(ctx.req_catalog_()).map(c => c.key + ':' + c.kind + ':' + c.scope)) === JSON.stringify(['watch:auto:per_lesson', 'homework:auto:per_lesson', 'quiz:auto:per_lesson', 'attendance:auto:per_lesson', 'written_answers:auto:per_lesson']));
  const ov = { groups: [{ key: 'sat 6pm', group: 'Sat 6pm' }, { key: 'mon 5pm', group: 'Mon 5pm' }] };
  ctx.req_overviewHook_(ov);
  t('hook fills groups[].requirements with the default set', JSON.stringify(J(ov.groups[0].requirements)) === JSON.stringify(TODAY) && JSON.stringify(J(ov.groups[1].requirements)) === JSON.stringify(TODAY));
  t('hook fills unclassified_requirements', JSON.stringify(J(ov.unclassified_requirements)) === JSON.stringify(TODAY));
  const g = run('admin_req_get', ADMIN);
  t('admin_req_get ok with catalog/groups/effective/unclassified', g.ok && g.catalog.length === 5 && typeof g.groups === 'object' && g.effective['sat 6pm'] && g.effective['mon 5pm'] && g.unclassified.watch.rule.pct === 80, g);
  t('admin_req_get returns the group spellings (extra field)', g.group_names['sat 6pm'] === 'Sat 6pm');
  const h = run('admin_req_history', ADMIN);
  t('history is empty and ok', h.ok && h.items.length === 0, h);
  t('reads created no sheet (Requirements/GroupRequirements/RequirementChecks)', !sheet('Requirements') && !sheet('GroupRequirements') && !sheet('RequirementChecks'));
  const bad = { admin_req_get: 1 };
  t('hook tolerates a missing/empty overview', (() => { try { ctx.req_overviewHook_(null); ctx.req_overviewHook_({}); return true; } catch (e) { return false; } })());
}

// 2. who may call ------------------------------------------------------------------------------------------------
{
  const E = boot(), { run, ctx, STUDENT, ASSISTANT, TOK, ADMIN } = E;
  ACTIONS.forEach(a => {
    const r = run(a, Object.assign({ key: 'watch', patch: { weight: 2 }, group: 'sat 6pm', mode: 'off', student: '01000000003', month: '2026-11', met: true }, STUDENT));
    t(a + ': a student session is refused', r.ok === false && r.error === 'Not authorized.', r);
    const r2 = run(a, { student_id: '01000000002', session_token: 'wrong', key: 'watch', patch: { weight: 2 } });
    t(a + ': a wrong session token is refused', r2.ok === false, r2);
  });
  const noList = run('admin_req_get', ASSISTANT);
  // integration: S5 put the five admin_req_* actions on P3_STAFF_ALLOW (contract 3.3), so the owner's assistant is allowed.
  t('assistant is allowed: the actions are on P3_STAFF_ALLOW (added by S5)', noList.ok === true, noList);
  ACTIONS.forEach(a => ctx.P3_STAFF_ALLOW.push(a));
  t('admin_req_get works with the desktop token', run('admin_req_get', TOK).ok === true);
  t('assistant can read once allow-listed', run('admin_req_get', ASSISTANT).ok === true);
  const w = run('admin_req_save_global', Object.assign({ key: 'watch', patch: { rule: { pct: 65 } } }, ASSISTANT));
  t('assistant can write once allow-listed', w.ok === true && w.requirement.rule.pct === 65, w);
}

// 3. global saves, validation, audit ------------------------------------------------------------------------------
{
  const E = boot(), { run, ctx, sheet, auditRows, ADMIN, ASSISTANT } = E;
  const s = (key, patch, who) => run('admin_req_save_global', Object.assign({ key, patch }, who || ADMIN));
  let r = s('watch', { rule: { pct: 70 } });
  t('save watch pct 70 ok', r.ok && r.requirement.rule.pct === 70 && r.requirement.edited === true, r);
  t('Requirements tab seeded with the five built-ins', sheet('Requirements') && sheet('Requirements').getLastRow() === 6);
  t('effective watch = 70, source global; others stay default', ctx.req_effective_('').watch.rule.pct === 70 && ctx.req_effective_('').watch.source === 'global' && ctx.req_effective_('').homework.source === 'default');
  r = s('homework', { enabled: false, parent_message: false });
  t('disable homework globally', r.ok && ctx.req_effective_('').homework.enabled === false && ctx.req_effective_('').homework.parent_message === false);
  r = s('quiz', { weight: 2.5, in_monthly_report: false, label_en: ' Quiz! ' });
  t('weight, report flag, label trimmed', r.ok && r.requirement.weight === 2.5 && r.requirement.in_monthly_report === false && r.requirement.label_en === 'Quiz!', r);
  t('no-change save returns ok and writes no audit row', (() => { const n = auditRows().length; const x = s('quiz', { weight: 2.5 }); return x.ok && auditRows().length === n; })());

  const bads = [
    ['unknown key', 'nope', { enabled: true }], ['unknown field', 'watch', { colour: 'red' }], ['empty patch', 'watch', {}], ['pct 0', 'watch', { rule: { pct: 0 } }],
    ['pct 101', 'watch', { rule: { pct: 101 } }], ['pct text', 'watch', { rule: { pct: 'abc' } }], ['rule on homework', 'homework', { rule: { pct: 50 } }],
    ['enabled as text', 'watch', { enabled: 'yes' }], ['weight 11', 'watch', { weight: 11 }], ['weight -1', 'watch', { weight: -1 }],
    ['kind change', 'watch', { kind: 'manual' }], ['new custom without kind', 'custom_x', { label_en: 'X' }], ['new custom without label', 'custom_x', { kind: 'manual' }],
    ['bad slug: upper case', 'custom_Bad', { kind: 'manual', label_en: 'X' }], ['bad slug: space', 'custom_a b', { kind: 'manual', label_en: 'X' }], ['bad slug: empty', 'custom_', { kind: 'manual', label_en: 'X' }],
    ['bad slug: too long', 'custom_' + 'a'.repeat(41), { kind: 'manual', label_en: 'X' }], ['non-custom new key', 'behaviour', { kind: 'manual', label_en: 'X' }],
    ['label too long', 'watch', { label_en: 'x'.repeat(81) }], ['rule on a new custom', 'custom_r', { kind: 'manual', label_en: 'R', rule: { pct: 5 } }],
  ];
  bads.forEach(([name, key, patch]) => { const x = s(key, patch); t('refused: ' + name, x.ok === false && !!x.error, x); });
  t('refused: missing key', run('admin_req_save_global', Object.assign({ patch: { enabled: true } }, ADMIN)).ok === false);
  t('refused: missing patch', run('admin_req_save_global', Object.assign({ key: 'watch' }, ADMIN)).ok === false);
  t('after all the refusals watch is still 70 (nothing half-written)', ctx.req_effective_('').watch.rule.pct === 70);

  r = s('custom_behaviour', { kind: 'manual', label_ar: 'السلوك', label_en: 'Behaviour', weight: 2 });
  t('create a custom manual requirement', r.ok && r.requirement.kind === 'manual' && r.requirement.scope === 'per_month' && r.requirement.weight === 2 && r.requirement.enabled === true && r.requirement.parent_message === false, r);
  t('custom appears in catalogue and effective set', ctx.req_catalog_().some(c => c.key === 'custom_behaviour') && ctx.req_effective_('').custom_behaviour.enabled === true);
  r = s('custom_behaviour', { enabled: false });
  t('custom can be switched off', r.ok && ctx.req_effective_('').custom_behaviour.enabled === false);
  for (let i = 0; i < 29; i++) { const x = s('custom_c' + i, { kind: 'manual', label_en: 'C' + i }); if (!x.ok) { t('creating custom #' + (i + 2) + ' should work', false, x); break; } }
  r = s('custom_overflow', { kind: 'manual', label_en: 'One too many' });
  t('31st custom requirement is refused (max 30)', r.ok === false && /30/.test(r.error), r);
  t('exactly 30 customs exist', ctx.req_catalog_().filter(c => c.kind === 'manual').length === 30);

  const au = auditRows().filter(x => x.action === 'req_save_global');
  const aw = au.find(x => x.target === 'watch');
  t('audit row written for the watch save with before/after', aw && /Teacher \[admin\]/.test(aw.who) && JSON.parse(aw.before).rule.pct === 80 && JSON.parse(aw.after).rule.pct === 70, aw);
  const as = s('written_answers', { in_monthly_report: false }, ASSISTANT);
  t('assistant save is allowed (allow-listed by S5)', as.ok === true, as);
  E.ctx.P3_STAFF_ALLOW.push('admin_req_save_global');
  const as2 = s('written_answers', { in_monthly_report: false }, ASSISTANT);
  const last = auditRows().filter(x => x.action === 'req_save_global').pop();
  t('assistant save is audited with name and role', as2.ok && /Sara Mahmoud \[assistant\]/.test(last.who), last);
  t('one audit row per successful change, none for refusals or no-change saves', au.length === 34, au.length);
}

// 4. group overrides ----------------------------------------------------------------------------------------------
{
  const E = boot(), { run, ctx, sheet, auditRows, ADMIN } = E;
  const sg = (group, key, mode, patch, note) => run('admin_req_save_group', Object.assign({ group, key, mode, patch, note }, ADMIN));
  run('admin_req_save_global', Object.assign({ key: 'quiz', patch: { enabled: false } }, ADMIN));
  run('admin_req_save_global', Object.assign({ key: 'watch', patch: { rule: { pct: 70 } } }, ADMIN));
  let r = sg('Sat 6pm', 'watch', 'off');
  t('group off: effective returned for that group', r.ok && r.effective.watch.enabled === false && r.effective.watch.source === 'group', r);
  t('other group unaffected', ctx.req_effective_('mon 5pm').watch.enabled === true && ctx.req_effective_('mon 5pm').watch.source === 'global');
  t('group key is canonical (case/space insensitive)', ctx.req_effective_('  SAT   6PM ').watch.enabled === false);
  r = sg('sat 6pm', 'quiz', 'on');
  t('group on beats global off', r.ok && r.effective.quiz.enabled === true && ctx.req_effective_('sat 6pm').quiz.source === 'group' && ctx.req_effective_('mon 5pm').quiz.enabled === false);
  r = sg('sat 6pm', 'watch', 'custom', { rule: { pct: 50 }, in_monthly_report: false }, 'slow connection');
  t('group custom: rule 50, report flag off, note stored', r.ok && r.effective.watch.rule.pct === 50 && r.effective.watch.in_monthly_report === false && r.effective.watch.enabled === true, r);
  t('GroupRequirements holds exactly one row per (group, key)', sheet('GroupRequirements').getLastRow() === 3, sheet('GroupRequirements').getLastRow());
  const g = run('admin_req_get', ADMIN);
  t('admin_req_get shows the overrides with mode and note', g.groups['sat 6pm'].watch.mode === 'custom' && g.groups['sat 6pm'].watch.note === 'slow connection' && g.groups['sat 6pm'].quiz.mode === 'on', g.groups);
  t('admin_req_get effective matches req_effective_', JSON.stringify(g.effective['sat 6pm']) === JSON.stringify(J(ctx.req_effective_('sat 6pm'))));
  const ov = { groups: [{ key: 'sat 6pm', group: 'Sat 6pm' }, { key: 'mon 5pm', group: 'Mon 5pm' }] };
  ctx.req_overviewHook_(ov);
  t('hook uses the group override for sat and global for mon', ov.groups[0].requirements.watch.rule.pct === 50 && ov.groups[1].requirements.watch.rule.pct === 70 && ov.groups[0].requirements.watch.source === 'group');
  r = sg('sat 6pm', 'watch', 'inherit');
  t('inherit removes the override (back to global 70)', r.ok && r.effective.watch.rule.pct === 70 && r.effective.watch.source === 'global' && sheet('GroupRequirements').getLastRow() === 2);
  t('inherit when nothing is stored is a harmless no-op', sg('sat 6pm', 'homework', 'inherit').ok);
  r = sg('sat 6pm', 'quiz', 'off'); sg('sat 6pm', 'quiz', 'on');
  t('changing mode overwrites the same row', sheet('GroupRequirements').getLastRow() === 2);

  const bads = [['unknown group', 'Tue 1am', 'watch', 'off'], ['unknown key', 'sat 6pm', 'nope', 'off'], ['bad mode', 'sat 6pm', 'watch', 'maybe'], ['custom without patch', 'sat 6pm', 'watch', 'custom'],
    ['patch with mode on', 'sat 6pm', 'watch', 'on', { rule: { pct: 5 } }], ['pct 0', 'sat 6pm', 'watch', 'custom', { rule: { pct: 0 } }], ['pct 101', 'sat 6pm', 'watch', 'custom', { rule: { pct: 101 } }],
    ['unknown patch field', 'sat 6pm', 'watch', 'custom', { weight: 3 }], ['rule on homework', 'sat 6pm', 'homework', 'custom', { rule: { pct: 5 } }], ['report flag as text', 'sat 6pm', 'watch', 'custom', { in_monthly_report: 'no' }]];
  bads.forEach(([n, grp, key, mode, patch]) => { const x = sg(grp, key, mode, patch); t('refused: ' + n, x.ok === false && !!x.error, x); });
  t('refused: missing group', run('admin_req_save_group', Object.assign({ key: 'watch', mode: 'off' }, ADMIN)).ok === false);
  t('refused: note over 200 chars', sg('sat 6pm', 'watch', 'off', undefined, 'x'.repeat(201)).ok === false);
  t('an override for a custom requirement works', (() => {
    run('admin_req_save_global', Object.assign({ key: 'custom_behaviour', patch: { kind: 'manual', label_en: 'Behaviour' } }, ADMIN));
    const x = sg('sat 6pm', 'custom_behaviour', 'off'); return x.ok && x.effective.custom_behaviour.enabled === false && ctx.req_effective_('mon 5pm').custom_behaviour.enabled === true;
  })());
  const au = auditRows().filter(x => x.action === 'req_save_group');
  t('every real group change left an audit row (with who)', au.length >= 6 && au.every(x => /\[admin\]$/.test(x.who) && /\|/.test(x.target)), au.length);
  t('precedence: default < global < group, end to end', (() => {
    const e = ctx.req_effective_('sat 6pm'); const m = ctx.req_effective_('mon 5pm');
    return m.homework.source === 'default' && m.watch.source === 'global' && e.quiz.source === 'group';
  })());
}

// 5. manual checks ------------------------------------------------------------------------------------------------
{
  const E = boot(), { run, ctx, sheet, auditRows, ADMIN, people } = E;
  run('admin_req_save_global', Object.assign({ key: 'custom_behaviour', patch: { kind: 'manual', label_en: 'Behaviour' } }, ADMIN));
  const ck = (student, key, month, met, note) => run('admin_req_check', Object.assign({ student, key, month, met, note }, ADMIN));
  const P = k => people[k].phone;
  let r = ck(P('omar'), 'custom_behaviour', '2026-11', true, 'great');
  t('tick a manual requirement', r.ok === true, r);
  const c = ctx.req_checks_for_('1000000003', '2026-11');
  t('req_checks_for_ returns met + note for the custom key', c.custom_behaviour && c.custom_behaviour.met === true && c.custom_behaviour.note === 'great', J(c));
  t('another month is unchecked: {met:null}', ctx.req_checks_for_('1000000003', '2026-10').custom_behaviour.met === null);
  t('another student is unchecked', ctx.req_checks_for_('1000000002', '2026-11').custom_behaviour.met === null);
  t('student accepted in any phone spelling', ck('+20 100 000 0003', 'custom_behaviour', '2026-11', false).ok && ctx.req_checks_for_('1000000003', '2026-11').custom_behaviour.met === false);
  t('same (student,key,month) stays ONE row', sheet('RequirementChecks').getLastRow() === 2, sheet('RequirementChecks').getLastRow());
  t('month and phone key are stored as plain text', sheet('RequirementChecks').get(2, 3) === '2026-11' && sheet('RequirementChecks').get(2, 1) === '1000000003');
  ck(P('sara'), 'custom_behaviour', '2026-11', true);
  const g = run('admin_req_get', Object.assign({ month: '2026-11' }, ADMIN));
  t('admin_req_get with month returns the checks (extra field)', g.ok && g.checks['1000000003'].custom_behaviour.met === false && g.checks['1000000002'].custom_behaviour.met === true && g.month === '2026-11', g.checks);
  t('admin_req_get with a bad month fails cleanly', run('admin_req_get', Object.assign({ month: '2026-13' }, ADMIN)).ok === false);
  r = ck(P('omar'), 'custom_behaviour', '2026-11', null, '');
  t('met:null with no note clears the row', r.ok && ctx.req_checks_for_('1000000003', '2026-11').custom_behaviour.met === null && sheet('RequirementChecks').getLastRow() === 2);
  t('met:null with a note keeps a note-only row', ck(P('omar'), 'custom_behaviour', '2026-11', null, 'ask next week').ok && ctx.req_checks_for_('1000000003', '2026-11').custom_behaviour.note === 'ask next week');
  const bads = [['built-in key', P('omar'), 'homework', '2026-11', true], ['unknown key', P('omar'), 'custom_zzz', '2026-11', true], ['bad month', P('omar'), 'custom_behaviour', '2026-13', true],
    ['month format', P('omar'), 'custom_behaviour', 'Nov 2026', true], ['unknown student', '01999999999', 'custom_behaviour', '2026-11', true], ['met as text', P('omar'), 'custom_behaviour', '2026-11', 'yes'],
    ['met missing', P('omar'), 'custom_behaviour', '2026-11', undefined], ['no student', '', 'custom_behaviour', '2026-11', true]];
  bads.forEach(([n, st, key, mo, met]) => { const x = ck(st, key, mo, met); t('refused: ' + n, x.ok === false && !!x.error, x); });
  t('audit rows for checks name the student|key|month', auditRows().some(x => x.action === 'req_check' && x.target === '1000000003|custom_behaviour|2026-11'));
  t('req_checks_for_ lists every manual key even with no rows', Object.keys(ctx.req_checks_for_('1000000004', '2026-11')).join() === 'custom_behaviour');
}

// 6. history ------------------------------------------------------------------------------------------------------
{
  const E = boot(), { run, ADMIN, TOK, ctx, ASSISTANT } = E;
  ACTIONS.forEach(a => ctx.P3_STAFF_ALLOW.push(a));
  run('admin_req_save_global', Object.assign({ key: 'watch', patch: { rule: { pct: 60 } } }, ADMIN));
  run('admin_req_save_global', Object.assign({ key: 'quiz', patch: { enabled: false } }, ASSISTANT));
  run('admin_req_save_group', Object.assign({ group: 'sat 6pm', key: 'watch', mode: 'off' }, TOK));
  const h = run('admin_req_history', ADMIN);
  t('history lists the 3 changes, newest first', h.ok && h.items.length === 3 && /group/.test(h.items[0].what) && /quiz/.test(h.items[1].what) && /watch/.test(h.items[2].what), h);
  t('history has by + role for admin, assistant and token', h.items[2].by === 'Teacher' && h.items[2].role === 'admin' && h.items[1].by === 'Sara Mahmoud' && h.items[1].role === 'assistant' && h.items[0].by === 'token' && h.items[0].role === 'admin', h.items.map(i => i.by + '/' + i.role));
  t('history what is a readable sentence with before -> after', /pct/.test(h.items[2].what) && /->/.test(h.items[2].what), h.items[2].what);
  t('history items carry at', h.items.every(i => typeof i.at === 'string' && i.at.length > 8));
  t('history limit is honoured', run('admin_req_history', Object.assign({ limit: 2 }, ADMIN)).items.length === 2);
  t('history limit is capped at 50', (() => { for (let i = 0; i < 60; i++) run('admin_req_save_global', Object.assign({ key: 'watch', patch: { weight: i % 2 ? 1 : 2 } }, ADMIN)); return run('admin_req_history', Object.assign({ limit: 500 }, ADMIN)).items.length === 50; })());
  t('history ignores other features\' audit rows', (() => { E.ctx.p2_audit('x', 'p2_something', 'y', '', ''); return run('admin_req_history', ADMIN).items.every(i => !/p2_something/.test(i.what)); })());
  t('a student cannot read history', run('admin_req_history', E.STUDENT).ok === false);
}

// 7. the routes table ---------------------------------------------------------------------------------------------
{
  const E = boot();
  const names = Object.keys(E.ctx.req_routes_()).sort();
  t('req_routes_() has exactly the five frozen action names + the two month-lessons ones', JSON.stringify(names) === JSON.stringify(ACTIONS.slice().sort()), names);
  t('every route is a function', Object.values(E.ctx.req_routes_()).every(f => typeof f === 'function'));
  t('a route never throws: garbage payload comes back {ok:false,error}', (() => { const r = E.ctx.req_routes_().admin_req_get(null); return r.ok === false && !!r.error; })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
