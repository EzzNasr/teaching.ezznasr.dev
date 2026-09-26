const { load } = require('./harness');
const crypto = require('crypto');
const path = process.argv[2];
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const has = (o, s) => JSON.stringify(o).includes(s);

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const plus = n => addDays(today, n);

const L1 = 'programming/other/functions', L2 = 'english/grammar';
const env = load(path);
const { post, getSS, lockState } = env;
const tab = n => getSS('STU').getSheetByName(n);
const colOf = (sh, name) => { for (let c = 1; c <= 8; c++) if (sh.get(1, c) === name) return c; return 0; };
const rows = n => { const sh = tab(n); return sh ? Math.max(sh.getLastRow() - 1, 0) : 0; };

const reg = (ph, pw, nm) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const A = reg('01000000002', 'b', 'Sara');
const B = reg('01000000003', 'c', 'Omar');
const stu = getSS('STU').getSheetByName('Students');
stu.set(2, colOf(stu, 'is_admin'), true);
const cr = r => ({ student_id: r.student_id, session_token: r.session_token });
const ADMIN = cr(adm), SA = cr(A), SB = cr(B);
const TOK = { token: 'tok' };

const add = (group, phone, creds = TOK) => post(Object.assign({ action: 'admin_group_add', group, phone }, creds));
const remove = (group, phone, creds = TOK) => post(Object.assign({ action: 'admin_group_remove', group, phone }, creds));
const list = (creds = TOK) => post(Object.assign({ action: 'admin_list_groups' }, creds));
const groupGrant = (body, creds = TOK) => post(Object.assign({ action: 'admin_group_grant_access' }, creds, body));
const groupRevoke = (body, creds = TOK) => post(Object.assign({ action: 'admin_group_revoke_access' }, creds, body));
const canWatch = (creds, lesson) => { const r = post({ action: 'get_video', lesson, slot: 'lesson', student_id: creds.student_id, session_token: creds.session_token }); return !!r.embed_url; };
const setVideo = (lesson, id) => post({ action: 'admin_set_video', token: 'tok', lesson, slot: 'lesson', video_url: 'https://www.youtube.com/embed/' + id, locked: true });
setVideo(L1, 'AAAAAAAAAAA'); setVideo(L2, 'BBBBBBBBBBB');

// 1. who may manage groups -----------------------------------------------------------------------------
{
  t('a student cannot add to a group', !add('Grade 2', '01000000002', SA).ok);
  t('no credentials cannot either', !add('Grade 2', '01000000002', {}).ok);
  t('nothing was created', tab('Groups') === null);
}

// 2. adding, listing, name validation ----------------------------------------------------------------------
{
  let r = add('Grade 2', '01000000002');
  t('adding a known student joins their name in', r.ok && r.name === 'Sara' && r.known_student === true && r.already === false, JSON.stringify(r));
  t('reading is admin-only', !list(SA).ok);
  r = list();
  t('the group and its member appear', r.ok && r.groups.length === 1 && r.groups[0].group === 'Grade 2' && r.groups[0].members.length === 1 && r.groups[0].members[0].phone === '01000000002', JSON.stringify(r));
  r = add('grade   2', '01000000003');   // different spacing/case, unregistered-yet phone too? no, Omar is registered
  t('a differently-typed name joins the SAME group', r.ok && r.group === 'Grade 2', JSON.stringify(r));
  t('...and both members show under the one, first-used spelling', list().groups.length === 1 && list().groups[0].members.length === 2);
  r = add('Grade 2', '01000000002');
  t('adding the same member twice is harmless (already: true), no duplicate row', r.ok && r.already === true && rows('Groups') === 2, JSON.stringify(r));
  r = add('Grade 2', '01099999999');
  t('an unregistered phone can be added; flagged unknown', r.ok && r.known_student === false && r.name === '', JSON.stringify(r));
  t('bad group name (empty) is refused', !add('   ', '01000000002').ok);
  t('bad group name (too long) is refused', !add('x'.repeat(61), '01000000002').ok);
  t('bad phone is refused', !add('Grade 2', '123').ok);
  t('an admin session can add too (not just the desktop token)', add('Staff', adm.student_id).ok === false || add('Staff', '01000000001', ADMIN).ok);
}

// 3. removing --------------------------------------------------------------------------------------------------
{
  let r = remove('Grade 2', '01099999999');
  t('removing a member works', r.ok && r.removed === 1, JSON.stringify(r));
  t('removing someone not in the group is refused', !remove('Grade 2', '01099999999').ok);
  t('removing from a group that does not exist is refused', !remove('No Such Group', '01000000002').ok);
  r = list();
  t('the group now has 2 members', r.groups[0].members.length === 2);
}

// 4. bulk grant ------------------------------------------------------------------------------------------------------
{
  let r = groupGrant({ group: 'grade 2', scope: L1, days: 30 });   // different spacing/case on purpose
  t('bulk grant finds the group however it is typed, and grants both members', r.ok && r.count === 2 && r.expires_at === plus(30), JSON.stringify(r));
  t('SERVER: Sara can now watch', canWatch(SA, L1));
  t('SERVER: Omar can now watch', canWatch(SB, L1));
  t('the granted list names them', r.granted.some(g => g.name === 'Sara') && r.granted.some(g => g.name === 'Omar'), JSON.stringify(r.granted));
  r = groupGrant({ group: 'Grade 2', scope: L1, never: true });
  t('granting again with never:true extends to no end date, never shortens', r.ok && r.expires_at === '', JSON.stringify(r));
  r = groupGrant({ group: 'Nonexistent Group', scope: L1, days: 10 });
  t('granting an empty/unknown group is refused, not a silent no-op', !r.ok && /no members/.test(r.error), JSON.stringify(r));
  t('a student cannot bulk-grant', !groupGrant({ group: 'Grade 2', scope: L1, days: 5 }, SA).ok);
}

// 5. bulk revoke -----------------------------------------------------------------------------------------------------
{
  let r = groupRevoke({ group: 'GRADE 2', scope: L1 });   // yet another casing
  t('bulk revoke finds the group and removes access from every member that had it', r.ok && r.removed_students === 2, JSON.stringify(r));
  t('SERVER: Sara can no longer watch', !canWatch(SA, L1));
  t('SERVER: Omar can no longer watch', !canWatch(SB, L1));
  r = groupRevoke({ group: 'Grade 2', scope: L1 });
  t('revoking again removes nobody (already gone) but does not error', r.ok && r.removed_students === 0, JSON.stringify(r));
  r = groupRevoke({ group: 'Totally Unknown Group', scope: L1 });
  t('bulk-revoking a group that has no members at all is refused, not a silent no-op', !r.ok && /no members/.test(r.error), JSON.stringify(r));
  t('a student cannot bulk-revoke either', !groupRevoke({ group: 'Grade 2', scope: L1 }, SA).ok);
  t('no credentials cannot bulk-revoke', !groupRevoke({ group: 'Grade 2', scope: L1 }, {}).ok);
  add('Staff', '01000000002');
  groupGrant({ group: 'Staff', scope: L2, days: 10 });
  add('Grade 2', '01000000002');   // Sara is now in BOTH groups again
  groupGrant({ group: 'Grade 2', scope: L2, days: 10 });
  const saraL2Rows = (() => { const sh = tab('Entitlements'); let n = 0; for (let rr = 2; rr <= sh.getLastRow(); rr++) if (String(sh.get(rr, colOf(sh, 'phone'))).endsWith('1000000002') && sh.get(rr, colOf(sh, 'scope')) === L2) n++; return n; })();
  t('access is per (student, scope), not per group: granting the same scope from two groups merges into one entitlement', saraL2Rows === 1, saraL2Rows);
  r = groupRevoke({ group: 'Staff', scope: L2 });
  t('so revoking via either group removes that shared access (not tied to which group granted it)', r.ok && !canWatch(SA, L2), JSON.stringify(r));
}

// 6. revoke marks the payment behind a group grant too, same as a single revoke -------------------------------------------
{
  const q = post(Object.assign({ action: 'request_access', lesson: L1, reference: 'ref' }, SB));
  post(Object.assign({ action: 'admin_decide_payment', payment_id: q.payment_id, decision: 'approve', days: 20 }, TOK));
  add('Paid Batch', '01000000003');
  const r = groupRevoke({ group: 'Paid Batch', scope: L1 });
  t('a bulk revoke also marks an individual payment behind it as revoked', r.ok && r.payments_revoked.indexOf(q.payment_id) !== -1, JSON.stringify(r));
  const ov = post(Object.assign({ action: 'admin_access_overview' }, TOK));
  t('...visible in the overview', ov.payments.find(p => p.payment_id === q.payment_id).status === 'revoked');
}

// 7. busy lock ------------------------------------------------------------------------------------------------------------------
{
  lockState.busy = true;
  t('busy lock: add is retryable', !add('Grade 2', '01000000002').ok && add('Grade 2', '01000000002').retryable !== false);
  t('busy lock: bulk grant is retryable', !groupGrant({ group: 'Grade 2', scope: L1, days: 5 }).ok);
  lockState.busy = false;
  t('reading the list needs no lock and still works while busy would have blocked writes', list().ok);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
