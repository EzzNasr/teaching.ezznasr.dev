// Shared helpers for S4's two assembly-time tests (matrix, acceptance). Also a self-test, registered as R-P4-S4-06.
// Builds a world on top of tests/fixtures/phase2_env.js: owner, math teacher (token + session), scoped assistant,
// legacy assistant, one owned and one foreign student, groups, lessons, payments. Never ships its own backend code.
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeEnv } = require('./fixtures/phase2_env');
const APPS = path.join(__dirname, '..', 'apps_script');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function loadP4(api, names) {            // names e.g. ['Phase4_Scope.gs'] (contract section 9 pattern)
  const CODE = fs.readFileSync(path.join(APPS, 'Code.gs'), 'utf8');
  names.forEach(n => {
    if (new RegExp('MERGED FROM ' + n.replace('.', '\\.')).test(CODE)) return;   // already merged into Code.gs
    const f = [path.join(APPS, 'chunks', n), path.join(APPS, n)].find(fs.existsSync);
    if (f) vm.runInContext(fs.readFileSync(f, 'utf8'), api.env.ctx, { filename: n });
  });
}
const P4_FILES = ['Phase4_Scope.gs', 'Phase4_People.gs', 'Phase4_Team.gs', 'Phase4_Telegram.gs', 'Phase4_Stats.gs'];

// Apps Script services the shared harness does not have (SHA-256, UrlFetchApp). Test-side only.
function patchGas(api) {
  const ctx = api.env.ctx, fetches = [];
  ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  const md5 = ctx.Utilities.computeDigest;
  ctx.Utilities.computeDigest = (alg, s) => alg === 'sha256' ? [...crypto.createHash('sha256').update(String(s), 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)) : md5(alg, s);
  ctx.UrlFetchApp = { fetch: (url, opts) => { const body = opts && opts.payload ? JSON.parse(opts.payload) : null; fetches.push({ url, body, method: opts && opts.method }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, result: { message_id: 1 } }) }; } };
  api.fetches = fetches;
  return api;
}

function colEnsure(sh, name) {
  for (let c = 1; c <= 60; c++) { const v = sh.get(1, c); if (v === name) return c; if (v === '' || v == null) { sh.set(1, c, name); return c; } }
  throw new Error('no room for column ' + name);
}
function rowOf(sh, phone) {
  const pc = colEnsure(sh, 'phone'), want = String(phone).replace(/\D/g, '').slice(-10);
  for (let r = 2; r <= sh.getLastRow(); r++) if (String(sh.get(r, pc)).replace(/\D/g, '').slice(-10) === want) return r;
  return 0;
}
function setStudent(api, phone, fields) {
  const sh = api.tab('Students'), r = rowOf(sh, phone);
  if (!r) throw new Error('no student row for ' + phone);
  Object.entries(fields).forEach(([k, v]) => sh.set(r, colEnsure(sh, k), v));
  return r;
}

const TPHONE = '01000000101', APHONE = '01000000102', LPHONE = '01000000103', S1PHONE = '01000000111', S2PHONE = '01000000112';
const LESSONS = { math: 'math/test-course/lesson-1', programming: 'programming/test-course/lesson-1' };
const TOKEN = 'teachtok';

function makeWorld(opts = {}) {
  const api = patchGas(makeEnv(opts));
  Object.assign(api.env.props, { TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_ADMIN_CHAT_ID: '900', P4_TG_BOT_USERNAME: 'test_bot' });   // after the patch, so the stub catches every send
  if (!opts.noP4) loadP4(api, P4_FILES);
  const reg = (ph, nm) => { const r = api.post({ action: 'register_student', phone: ph, password_hash: api.H('pw'), display_name: nm, year: 'Senior 2', parent_phone: '01234567890' }); if (!r.ok) throw new Error('register ' + ph + ': ' + JSON.stringify(r)); return { student_id: r.student_id, session_token: r.session_token }; };
  const W = { api, post: api.post, owner: Object.assign({}, api.ADMIN), ownerTok: { token: 'tok' }, phones: { T: TPHONE, A: APHONE, L: LPHONE, S1: S1PHONE, S2: S2PHONE }, lessons: LESSONS, token: TOKEN };
  W.T = reg(TPHONE, 'Mr Samy'); W.A = reg(APHONE, 'Assistant Of Samy'); W.L = reg(LPHONE, 'Legacy Assistant');
  W.S1 = reg(S1PHONE, 'Owned Student'); W.S2 = reg(S2PHONE, 'Foreign Student');
  const tRow = setStudent(api, TPHONE, { role: 'teacher', teacher_scope: 'math' });
  const tPhoneCell = api.tab('Students').get(tRow, colEnsure(api.tab('Students'), 'phone'));
  setStudent(api, APHONE, { role: 'assistant', assistant_of: tPhoneCell });
  setStudent(api, LPHONE, { role: 'assistant' });
  W.tPhoneCell = tPhoneCell;
  api.env.props.P4_TEACHER_TOKENS = JSON.stringify({ [sha256(TOKEN)]: { name: 'Mr Samy', scope: 'math', created: '2026-10-30T00:00:00Z' } });
  api.ensure('GroupOwners', ['group', 'owner_id', 'created_at']).appendRow(['G-OWN', tPhoneCell, '2026-10-30']);
  api.post({ action: 'admin_group_add', token: 'tok', group: 'G-OWN', phone: S1PHONE });
  api.post({ action: 'admin_group_add', token: 'tok', group: 'G-OTHER', phone: S2PHONE });
  const pay = api.ensure('Payments', ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at']);
  W.addPayment = (id, scope, phone) => pay.appendRow([id, phone || S1PHONE, 'Owned Student', scope, 'ref-' + id, '', 'pending', '2026-10-29 10:00:00', '']);
  W.addPayment('PAY-MATH', 'math/test-course'); W.addPayment('PAY-PROG', 'programming/test-course');
  W.callers = {
    owner: () => W.owner, teacher_tok: () => ({ token: TOKEN }), teacher_ses: () => W.T, assistant_scoped: () => W.A,
    assistant_legacy: () => W.L, student: () => W.S1, anon: () => ({}),
  };
  return W;
}

module.exports = { sha256, loadP4, patchGas, colEnsure, rowOf, setStudent, makeWorld, P4_FILES, LESSONS, TPHONE, APHONE, LPHONE, S1PHONE, S2PHONE, TOKEN };

if (require.main === module) {   // self-test (R-P4-S4-06): the world builds without any Phase 4 code
  let fails = 0;
  const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 300))); if (!ok) fails++; };
  try {
    const W = makeWorld({ noP4: true });
    const rows = k => W.api.rows(k);
    const st = rows('Students');
    t('sha256 helper matches Node and the patched Utilities', W.api.env.ctx.Utilities.computeDigest('sha256', 'abc').length === 32 && sha256('abc').startsWith('ba7816bf'));
    t('five actors registered; teacher and assistants have the right role columns', st.length >= 6 && st.some(r => r.role === 'teacher' && r.teacher_scope === 'math') && st.filter(r => r.role === 'assistant').length === 2, JSON.stringify(st.map(r => [r.phone, r.role, r.teacher_scope, r.assistant_of])));
    t('scoped assistant points at the teacher, legacy one does not', st.filter(r => r.assistant_of).length === 1);
    t('GroupOwners, Groups and Payments are seeded', rows('GroupOwners').length === 1 && rows('Groups').length >= 2 && rows('Payments').length === 2, JSON.stringify([rows('GroupOwners').length, rows('Groups').length, rows('Payments').length]));
    t('teacher token property holds a hash, never the raw token', JSON.parse(W.api.env.props.P4_TEACHER_TOKENS)[sha256(TOKEN)] && !W.api.env.props.P4_TEACHER_TOKENS.includes(TOKEN));
    t('UrlFetchApp stub records calls', (() => { const n = W.api.fetches.length; W.api.env.ctx.UrlFetchApp.fetch('https://x', { method: 'post', payload: '{"a":1}' }); return W.api.fetches.length === n + 1 && W.api.fetches[n].body.a === 1; })());
    t('every caller factory returns credentials', Object.keys(W.callers).length === 7 && W.callers.teacher_tok().token === TOKEN);
    { const r = W.post(Object.assign({ action: 'admin_get_all' }, W.owner)); t('owner session still works on the untouched backend', r.ok === true || (r.ok === undefined && !r.error), JSON.stringify(r).slice(0, 200)); }
  } catch (e) { t('world builds', false, e && e.stack); }
  process.exit(fails ? 1 : 0);
}
