// R-SEC04 + R-SEC02: staff accounts (owner, teacher, assistant).
//   node tests/test_sec_staff_accounts.js apps_script/Code.gs      (run from tools/quiz-maker-v2)
// R-SEC04: "Forgot password" (parent phone) is refused for every staff row; students keep it.
// R-SEC02: a staff row's password cell is upgraded to the salted, iterated, peppered form at the next sign-in;
//          the stored value itself no longer signs in; students are unchanged; no pepper = no upgrade.
const { load } = require('./harness');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const H = s => require('crypto').createHash('sha256').update(s).digest('hex');
const codeGs = process.argv[2] || 'apps_script/Code.gs';
const PEPPER = 'test-pepper-0123456789abcdef';

// One student, one owner, one teacher, one assistant, one "student" role row; each with a parent number on file.
function setup(props) {
  const env = load(codeGs, { props });
  const people = [
    { phone: '01011111111', pw: 'stud-pass', parent: '01111111111', kind: 'student' },
    { phone: '01022222222', pw: 'owner-pass', parent: '01122222222', kind: 'owner' },
    { phone: '01033333333', pw: 'teach-pass', parent: '01133333333', kind: 'teacher' },
    { phone: '01044444444', pw: 'assist-pass', parent: '01144444444', kind: 'assistant' },
    { phone: '01055555555', pw: 'plain-pass', parent: '01155555555', kind: 'student-role' },
  ];
  people.forEach(p => {
    const r = env.post({ action: 'register_student', phone: p.phone, password_hash: H(p.pw), display_name: p.kind, year: 'Senior 1', parent_phone: p.parent });
    if (!r.ok) throw new Error('register failed: ' + JSON.stringify(r));
  });
  const sh = env.getSS('STU').getSheetByName('Students');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  let roleCol = head.indexOf('role') + 1;
  if (!roleCol) { roleCol = head.length + 1; sh.set(1, roleCol, 'role'); }
  const adminCol = head.indexOf('is_admin') + 1, pwCol = head.indexOf('password_hash') + 1;
  people.forEach((p, i) => {
    const row = i + 2;
    if (p.kind === 'owner') sh.set(row, adminCol, true);
    if (p.kind === 'teacher') sh.set(row, roleCol, 'Teacher ');
    if (p.kind === 'assistant') sh.set(row, roleCol, 'assistant');
    if (p.kind === 'student-role') sh.set(row, roleCol, 'student');
    p.row = row;
  });
  const cell = p => String(sh.get(p.row, pwCol));
  const by = k => people.find(p => p.kind === k);
  return { env, people, cell, by, sh, pwCol };
}

// ------------------------------------------------------------------ R-SEC04
{
  const { env, by, cell } = setup({ PASSWORD_PEPPER: PEPPER });
  ['owner', 'teacher', 'assistant'].forEach(k => {
    const p = by(k), before = cell(p);
    const r = env.post({ action: 'reset_password', phone: p.phone, parent_phone: p.parent, new_password_hash: H('hijack') });
    t('R-SEC04 ' + k + ': reset by parent phone refused', !r.ok && /can't be reset here/.test(r.error), JSON.stringify(r));
    t('R-SEC04 ' + k + ': password cell unchanged', cell(p) === before);
    t('R-SEC04 ' + k + ': the hijack password does not sign in', !env.post({ action: 'login_student', phone: p.phone, password_hash: H('hijack') }).ok);
  });
  ['student', 'student-role'].forEach(k => {
    const p = by(k);
    const r = env.post({ action: 'reset_password', phone: p.phone, parent_phone: p.parent, new_password_hash: H('new-' + k) });
    t('R-SEC04 ' + k + ': reset still works', r.ok, JSON.stringify(r));
    t('R-SEC04 ' + k + ': new password signs in', env.post({ action: 'login_student', phone: p.phone, password_hash: H('new-' + k) }).ok);
  });
}

// ------------------------------------------------------------------ R-SEC02
{
  const { env, by, cell, sh } = setup({ PASSWORD_PEPPER: PEPPER });
  ['owner', 'teacher', 'assistant'].forEach(k => {
    const p = by(k), legacy = cell(p);
    t('R-SEC02 ' + k + ': starts with the old plain value', legacy === H(p.pw));
    env.hmacCalls.n = 0;
    let r = env.post({ action: 'login_student', phone: p.phone, password_hash: H(p.pw) });
    t('R-SEC02 ' + k + ': old value signs in once', r.ok, JSON.stringify(r));
    const up = cell(p);
    t('R-SEC02 ' + k + ': cell upgraded to the strong form', /^s2\$2000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(up), up);
    t('R-SEC02 ' + k + ': the work is iterated (2000 rounds)', env.hmacCalls.n === 2000, env.hmacCalls.n);
    t('R-SEC02 ' + k + ': the old plain value does not appear in the cell', up.indexOf(legacy) === -1);
    r = env.post({ action: 'login_student', phone: p.phone, password_hash: H(p.pw) });
    t('R-SEC02 ' + k + ': the real password still signs in', r.ok, JSON.stringify(r));
    t('R-SEC02 ' + k + ': cell is not rewritten on later sign-ins', cell(p) === up);
    t('R-SEC02 ' + k + ': the stored cell itself does not sign in', !env.post({ action: 'login_student', phone: p.phone, password_hash: up }).ok);
    t('R-SEC02 ' + k + ': a wrong password is refused', /Incorrect/.test(env.post({ action: 'login_student', phone: p.phone, password_hash: H('nope') }).error || ''));
  });
  const a = cell(by('owner')).split('$')[2], b = cell(by('teacher')).split('$')[2];
  t('R-SEC02 every row has its own salt', a && b && a !== b);
  ['student', 'student-role'].forEach(k => {
    const p = by(k);
    t('R-SEC02 ' + k + ': signs in as before', env.post({ action: 'login_student', phone: p.phone, password_hash: H(p.pw) }).ok);
    t('R-SEC02 ' + k + ': cell left in the old form (students unchanged)', cell(p) === H(p.pw));
  });
  // A staff password set by hand in the sheet (the browser hash, as before) works and is upgraded.
  const tch = by('teacher');
  sh.set(tch.row, sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].indexOf('password_hash') + 1, H('by-hand'));
  t('R-SEC02 a hand-set staff password signs in', env.post({ action: 'login_student', phone: tch.phone, password_hash: H('by-hand') }).ok);
  t('R-SEC02 ... and is upgraded', /^s2\$/.test(cell(tch)));
  // A teacher demoted to student keeps a strong cell, which must still work.
  sh.set(tch.row, sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].indexOf('role') + 1, '');
  t('R-SEC02 a demoted teacher with a strong cell still signs in', env.post({ action: 'login_student', phone: tch.phone, password_hash: H('by-hand') }).ok);
  // Losing the pepper must fail closed with a clear message, never let anyone in.
  env.props.PASSWORD_PEPPER = '';
  const r = env.post({ action: 'login_student', phone: by('owner').phone, password_hash: H('owner-pass') });
  t('R-SEC02 pepper missing: an upgraded row is refused with a clear message', !r.ok && /not available/.test(r.error), JSON.stringify(r));
}

// No pepper set (deploy before the property): nothing is upgraded, everything works as before.
{
  const { env, by, cell } = setup({});
  ['owner', 'teacher'].forEach(k => {
    const p = by(k);
    t('R-SEC02 no pepper: ' + k + ' signs in', env.post({ action: 'login_student', phone: p.phone, password_hash: H(p.pw) }).ok);
    t('R-SEC02 no pepper: ' + k + ' cell left as is', cell(p) === H(p.pw));
  });
}
{
  const { env, by, cell } = setup({ PASSWORD_PEPPER: 'short' });
  const p = by('owner');
  env.post({ action: 'login_student', phone: p.phone, password_hash: H(p.pw) });
  t('R-SEC02 a pepper under 16 characters is ignored', cell(p) === H(p.pw));
}

// New passwords need 8+ characters (register and reset forms); sign-in keeps accepting older, shorter ones.
{
  const fs = require('fs'), path = require('path');
  const SITE = path.resolve(__dirname, '..', '..', '..');
  ['assets/auth.js', 'tools/quiz-maker-v2/assets_templates/auth.js'].forEach(f => {
    const s = fs.readFileSync(path.join(SITE, f), 'utf8');
    t(f + ': the four new-password checks ask for 8+', (s.match(/val\.length < 8\)/g) || []).length === 4 && (s.match(/\(8\+ characters\)/g) || []).length === 4);
    t(f + ': no 4-character minimum left', !/val\.length < 4\b/.test(s) && !/4\+ characters/.test(s));
  });
  const { env } = setup({ PASSWORD_PEPPER: PEPPER });
  env.post({ action: 'register_student', phone: '01066666666', password_hash: H('abcd'), display_name: 'old short', year: 'Senior 1', parent_phone: '01166666666' });
  t('an existing 4-character password still signs in (the server never sees the length)', env.post({ action: 'login_student', phone: '01066666666', password_hash: H('abcd') }).ok);
  const { makePepper } = require(path.join(SITE, 'scripts', 'make_pepper.js'));
  const a = makePepper(), b = makePepper();
  t('make_pepper: 48 URL-safe characters, long enough for the server (16+)', /^[A-Za-z0-9_-]{48}$/.test(a) && a.length >= 16);
  t('make_pepper: a new value every run', a !== b);
  const e2 = setup({ PASSWORD_PEPPER: a });
  const o = e2.by('owner');
  e2.env.post({ action: 'login_student', phone: o.phone, password_hash: H(o.pw) });
  t('make_pepper: a generated value is accepted and used for the upgrade', /^s2\$/.test(e2.cell(o)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
