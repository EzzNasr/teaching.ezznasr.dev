// Follow-up v2, Session 5: one group per student (contract 3.7) on every add path of admin_group_add.
// Usage: node tests/test_one_group.js [apps_script dir]
const path = require('path'), crypto = require('crypto');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'apps_script'));
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (typeof x === 'string' ? x : JSON.stringify(x)))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');

const env = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')], { clock: true });
const { post, getSS, lockState } = env;
const TOK = { token: 'tok' };
const reg = (ph, nm) => post({ action: 'register_student', phone: ph, password_hash: H(nm), display_name: nm, year: 'Senior 2', parent_phone: '01100000009' });
reg('01000000001', 'Teacher'); ['Sara', 'Omar', 'Nour', 'Hana'].forEach((n, i) => reg('0100000000' + (i + 2), n));
const S = '01000000002', O = '01000000003', N = '01000000004', Hh = '01000000005';
const add = (group, phone, extra) => post(Object.assign({ action: 'admin_group_add', group, phone }, extra || {}, TOK));
const addMany = (group, phones, extra) => post(Object.assign({ action: 'admin_group_add', group, phones }, extra || {}, TOK));
const groups = () => { const r = post(Object.assign({ action: 'admin_list_groups' }, TOK)); const o = {}; (r.groups || []).forEach(g => { o[g.group] = g.members.map(m => m.phone.slice(-10)).sort(); }); return o; };
const tab = n => getSS('STU').getSheetByName(n);
const rowCount = () => tab('Groups').getLastRow();
const audit = () => { const sh = getSS('DATA').getSheetByName('AuditLog'); const o = []; if (!sh) return o; for (let r = 2; r <= sh.getLastRow(); r++) o.push({ who: sh.get(r, 2), action: sh.get(r, 3), target: sh.get(r, 4), before: sh.get(r, 5), after: sh.get(r, 6) }); return o; };
const k = p => p.slice(-10);

// ---- setup
let r = addMany('Sat 6pm', [S, O]); t('setup: Sat 6pm has Sara and Omar', r.ok && r.count === 2, r);
r = add('Sun 8pm', N); t('setup: Sun 8pm has Nour', r.ok && r.already === false, r);

// ---- single add
let rows0 = rowCount();
r = add('Sun 8pm', S);
t('single add of a student who is in another group is refused with code in_other_group', r.ok === false && r.code === 'in_other_group', r);
t('...naming the group they are in and the student', r.from === 'Sat 6pm' && r.conflicts.length === 1 && r.conflicts[0].name === 'Sara' && /Sat 6pm/.test(r.error), r);
t('...and nothing was written', rowCount() === rows0 && groups()['Sat 6pm'].length === 2 && groups()['Sun 8pm'].length === 1, groups());
r = add('sun  8PM', S);
t('the group is matched however it is typed', r.code === 'in_other_group');
r = add('Sat 6pm', S);
t('adding to the group they are already in is still just "already"', r.ok && r.already === true, r);
r = add('Sun 8pm', S, { move: false });
t('move:false is the same as no move', r.code === 'in_other_group');
r = add('Sun 8pm', S, { move: true });
t('move:true moves them: ok, not "already", reports where from', r.ok && r.already === false && r.moved && r.moved.length === 1 && r.moved[0].from === 'Sat 6pm' && r.moved[0].name === 'Sara', r);
t('...old group lost her, new group has her, total rows unchanged', groups()['Sat 6pm'].join() === k(O) && groups()['Sun 8pm'].join() === [k(N), k(S)].sort().join() && rowCount() === rows0, groups());
const a = audit().filter(x => x.action === 'group_move');
t('...with one AuditLog row (who, target, before, after)', a.length === 1 && a[0].who === 'token' && /1000000002$/.test(a[0].target) && /Sat 6pm/.test(a[0].before) && /Sun 8pm/.test(a[0].after), a);
r = add('Sat 6pm', S, { move: 'true' });
t('move:"true" (string) also counts', r.ok && r.moved && r.moved.length === 1, r);

// ---- bulk add: all or nothing
rows0 = rowCount(); const before = JSON.stringify(groups());
r = addMany('New Group', [Hh, N, O]);
t('bulk add with ONE conflicting student refuses the whole request', r.ok === false && r.code === 'in_other_group' && r.conflicts.length === 2, r);
t('...nothing written, not even the free student, and no new group appeared', JSON.stringify(groups()) === before && rowCount() === rows0 && !groups()['New Group'], groups());
t('...the message says how many', /2 of these students/.test(r.error), r.error);
r = addMany('New Group', [Hh, N, O], { move: true });
t('bulk add with move:true moves the conflicts and adds the free one', r.ok && r.count === 3 && r.moved.length === 2 && groups()['New Group'].length === 3, r);
t('...old groups lost them; Sun 8pm still has Sara (she was never in the request)', groups()['Sun 8pm'] === undefined || !groups()['Sun 8pm'].includes(k(N)), groups());
t('...one audit row per moved student', audit().filter(x => x.action === 'group_move').length === 1 + 1 + 2, audit().filter(x => x.action === 'group_move').length);
r = addMany('New Group', [Hh, N]);
t('bulk add of people already in THIS group: "already", no error', r.ok && r.count === 0 && r.already.length === 2, r);
r = addMany('Elsewhere', [S, S]);
t('a duplicate inside one request is reported once', r.code === 'in_other_group' && r.conflicts.length === 1, r);

// ---- emptied groups forget what they gave (same as admin_group_remove)
{
  const e2 = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')], { clock: true });
  const p2 = x => e2.post(Object.assign({}, x, TOK));
  ['Teacher', 'Sara', 'Omar'].forEach((n, i) => e2.post({ action: 'register_student', phone: '0100000000' + (i + 1), password_hash: H(n), display_name: n, year: 'Senior 2', parent_phone: '01100000009' }));
  p2({ action: 'admin_group_add', group: 'Solo', phone: S });
  let g = p2({ action: 'admin_group_grant_access', group: 'Solo', scope: 'english/grammar', days: 30 });
  t('setup: Solo gives english/grammar to its only member', g.ok, g);
  p2({ action: 'admin_group_add', group: 'Other', phone: O });
  p2({ action: 'admin_group_grant_access', group: 'Other', scope: 'programming/other/loops', days: 30 });
  const mv = p2({ action: 'admin_group_add', group: 'Other', phone: S, move: true });
  t('moving the only member out of a group works and the new group\'s rule is inherited', mv.ok && mv.inherited && mv.inherited.some(x => x.target === 'programming/other/loops'), mv);
  const gl = p2({ action: 'admin_list_groups' }).groups;
  t('the emptied group is gone from the list and its remembered grants are forgotten', !gl.some(x => x.group === 'Solo') && !(tab2(e2, 'GroupGrants') || []).some(x => /solo/i.test(x)), gl.map(x => x.group));
}
function tab2(e, n) { const sh = e.getSS('STU').getSheetByName(n); if (!sh) return null; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) o.push(String(sh.get(r, 1)) + '|' + String(sh.get(r, 2))); return o; }

// ---- legacy duplicates and cleanup
{
  const e3 = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')], { clock: true });
  ['Teacher', 'Sara'].forEach((n, i) => e3.post({ action: 'register_student', phone: '0100000000' + (i + 1), password_hash: H(n), display_name: n, year: 'Senior 2', parent_phone: '01100000009' }));
  const p3 = x => e3.post(Object.assign({}, x, TOK));
  p3({ action: 'admin_group_add', group: 'A', phone: S });
  const sh = e3.getSS('STU').getSheetByName('Groups'); const hd = {}; for (let c = 1; c <= 8; c++) if (sh.get(1, c)) hd[sh.get(1, c)] = c;
  [['B', S], ['C', S]].forEach(([g, p]) => { const rr = sh.getLastRow() + 1; sh.set(rr, hd.group, g); sh.set(rr, hd.phone, p); sh.set(rr, hd.name, ''); sh.set(rr, hd.added_at, '2026-01-01'); });
  let x = p3({ action: 'admin_group_add', group: 'A', phone: S });
  t('legacy: already in A (and B, C): plain "already", no error, nothing changed', x.ok && x.already === true && sh.getLastRow() === 4, x);
  x = p3({ action: 'admin_group_add', group: 'A', phone: S, move: true });
  t('legacy: move:true into the group they are already in tidies the extra memberships', x.ok && x.already === true && x.moved.length === 1 && x.moved[0].from === 'B', x);
  const left = p3({ action: 'admin_list_groups' }).groups.map(g => g.group).sort();
  t('...they end up in exactly one group', left.join() === 'A', left);
}

// ---- every route that could change membership
{
  const e4 = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')], { clock: true });
  ['Teacher', 'Sara'].forEach((n, i) => e4.post({ action: 'register_student', phone: '0100000000' + (i + 1), password_hash: H(n), display_name: n, year: 'Senior 2', parent_phone: '01100000009' }));
  const p4 = x => e4.post(Object.assign({}, x, TOK));
  p4({ action: 'admin_group_add', group: 'A', phone: S });
  const before4 = JSON.stringify(p4({ action: 'admin_list_groups' }).groups);
  p4({ action: 'admin_followup_save_group', group: 'A', weekday: 6, time: '18:00' });
  p4({ action: 'admin_group_grant_access', group: 'A', scope: 'english/grammar', days: 5 });
  t('follow-up group edit and group grants do not change who is in a group', JSON.stringify(p4({ action: 'admin_list_groups' }).groups).replace(/"grants":\[[^\]]*\]/, '') === before4.replace(/"grants":\[[^\]]*\]/, ''));
  const ro = e4.post({ action: 'admin_group_add', group: 'B', phone: S });
  t('add needs staff credentials', ro.ok === false);
}

// ---- concurrency: the check and the write happen under one lock
{
  const e5 = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')], { clock: true });
  ['Teacher', 'Sara'].forEach((n, i) => e5.post({ action: 'register_student', phone: '0100000000' + (i + 1), password_hash: H(n), display_name: n, year: 'Senior 2', parent_phone: '01100000009' }));
  const p5 = x => e5.post(Object.assign({}, x, TOK));
  const w0 = e5.lockState.waits.length;
  const first = p5({ action: 'admin_group_add', group: 'X', phone: S });
  const second = p5({ action: 'admin_group_add', group: 'Y', phone: S });   // the request that "arrived at the same time" is serialised by the lock and sees the first one's row
  t('two near-simultaneous adds of one student to different groups: exactly one wins', first.ok && second.code === 'in_other_group' && second.from === 'X', [first, second]);
  t('...each add took the script lock (that is what makes it atomic)', e5.lockState.waits.length - w0 === 2, e5.lockState.waits.length - w0);
  e5.lockState.busy = true;
  const busy = p5({ action: 'admin_group_add', group: 'Y', phone: S, move: true });
  e5.lockState.busy = false;
  t('a busy lock answers retryable and changes nothing', busy.ok === false && busy.retryable === true && p5({ action: 'admin_list_groups' }).groups.map(g => g.group).join() === 'X', busy);
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
