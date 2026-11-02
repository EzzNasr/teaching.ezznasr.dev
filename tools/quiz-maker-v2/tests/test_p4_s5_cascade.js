// P4 / S5: the phone cascade of p4_teacher_update_student. One test per phone-keyed sheet, rollback, busy lock, flag.
// Usage: node tests/test_p4_s5_cascade.js
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeEnv } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

const APPS = path.join(__dirname, '..', 'apps_script');
const NOT_AUTH = r => r && r.ok === false && r.error === 'Not authorized.';
const GENERIC = r => r && r.ok === false && r.error === 'Could not apply that change.';
const STUBS = `
var TEST_CTX = null, PINGS = [], OWNED = {};
function p4_ctx() { return TEST_CTX; }
function p4_ownsStudent(ctx, p) { return OWNED[_normalizePhone(p)] === true; }
function p4_ownerPing_(txt) { PINGS.push(txt); }
`;
const TZ = '01000000010', OLD = '01000000003', NEW = '01088888888', DECOY = '01000000004';

// [book, tab, headers, index of the phone column, how many extra payload columns]
const STORES = [
  ['STU', 'Entitlements', ['phone', 'scope', 'expires_at', 'granted_at', 'source'], 'phone'],
  ['STU', 'Payments', ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at'], 'phone'],
  ['STU', 'QuizAccess', ['phone', 'lesson', 'expires_at', 'granted_at', 'source'], 'phone'],
  ['STU', 'Groups', ['group', 'phone', 'name', 'added_at'], 'phone'],
  ['STU', 'Attendance', ['lesson', 'phone', 'mode', 'marked_at'], 'phone'],
  ['STU', 'WatchProgress', ['phone', 'lesson', 'pct', 'duration_s', 'first_at', 'updated_at'], 'phone'],
  ['STU', 'ParentNotifications', ['student', 'kind', 'ref', 'sent_at', 'by', 'note'], 'student'],
  ['STU', 'MonthlyReviews', ['student', 'month', 'status', 'sent_at', 'note'], 'student'],
  ['DATA', 'QuizResults', ['student_id', 'name', 'subject', 'lesson', 'quiz_title', 'date', 'start_time', 'end_time', 'score', 'total', 'questions_json', 'dedupe_key'], 'student_id'],
  ['DATA', 'Submissions', ['student_id', 'name', 'subject', 'lesson', 'submission_type', 'text', 'text_truncated', 'url', 'note', 'file_id', 'file_name', 'date', 'submitted_time', 'score', 'total', 'answers_json', 'dedupe_key'], 'student_id'],
  ['DATA', 'WrittenAnswers', ['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at'], 'student_id'],
];

function build(opts = {}) {
  const api = makeEnv();
  const ctx = api.env.ctx;
  ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  vm.runInContext(fs.readFileSync(path.join(APPS, 'chunks', 'Phase4_Team.gs'), 'utf8'), ctx, { filename: 'Phase4_Team.gs' });
  vm.runInContext(STUBS, ctx);
  api.ctx = ctx;
  api.call = (fn, p) => { try { return ctx[fn](p || {}); } catch (e) { return { ok: false, error: 'THROWN: ' + e.message }; } };
  api.reg = (ph, nm) => api.post({ action: 'register_student', phone: ph, password_hash: crypto.createHash('sha256').update(ph).digest('hex'), display_name: nm, year: 'Senior 2', parent_phone: '01100000009' });
  api.reg(TZ, 'Ziad Teacher');
  ctx.p4_setup();
  const s = api.tab('Students'); let row = 0;
  for (let r = 2; r <= s.getLastRow(); r++) if (String(s.get(r, 1)) === TZ) row = r;
  s.set(row, api.colOf(s, 'role'), 'teacher'); s.set(row, api.colOf(s, 'teacher_scope'), 'math');
  ctx.TEST_CTX = { kind: 'teacher', via: 'session', id: TZ, subjects: ['math'], principal: TZ };
  ctx.OWNED[OLD] = true;
  api.edit = changes => api.call('p4_teacher_update_student', { student: OLD, changes });
  api.on = () => { api.env.props.P4_TEACHER_PHONE_EDIT = '1'; };
  return api;
}

// Seeds every phone-keyed store: [old phone as typed (string)], [decoy], [old phone, number-typed and with +20], [old phone again].
function seed(api, only) {
  STORES.forEach(([book, tab, headers, col]) => {
    if (only && !only(tab)) return;
    const ss = api.getSS(book);
    let sh = ss.getSheetByName(tab); if (!sh) { sh = ss.insertSheet(tab); sh.appendRow(headers); }
    const ci = headers.indexOf(col);
    const mk = (val, tag) => headers.map((h, i) => i === ci ? val : h + ':' + tag);
    sh.appendRow(mk(OLD, 'a'));
    sh.appendRow(mk(DECOY, 'b'));
    sh.appendRow(mk(1000000003, 'c'));            // number-typed, leading 0 lost
    sh.appendRow(mk('+20 100 000 0003', 'd'));
    sh.appendRow(mk('0' + '1000000099', 'e'));    // a different student
  });
}
const grid = (api, book, tab) => { const sh = api.getSS(book).getSheetByName(tab); if (!sh) return null; const o = []; for (let r = 1; r <= sh.getLastRow(); r++) { const row = []; for (let c = 1; c <= sh.getLastColumn(); c++) row.push(sh.get(r, c)); o.push(row); } return o; };
const snapshot = api => JSON.stringify(['STU', 'DATA'].map(b => api.getSS(b).sheets.filter(s => s.name !== 'StudentEditLog').map(s => [s.name, grid(api, b, s.name)])));
const phonesIn = (api, [book, tab, headers, col]) => (grid(api, book, tab) || []).slice(1).map(r => r[headers.indexOf(col)]);

// ---------------------------------------------------------------- one test per store, one run
{
  const api = build(); api.on(); seed(api);
  const beforeGrids = {}; STORES.forEach(s => { beforeGrids[s[1]] = grid(api, s[0], s[1]); });
  const audit = api.getSS('DATA').insertSheet('AuditLog'); audit.appendRow(['at', 'who', 'action', 'target', 'before', 'after']); audit.appendRow(['t', 'x', 'p3_admin_set_role', OLD, '', '']);
  const r = api.edit({ phone: NEW });
  t('the edit succeeds', r.ok === true && r.student.phone === NEW, JSON.stringify(r));
  STORES.forEach(st => {
    const [book, tab, headers, col] = st, ci = headers.indexOf(col);
    const after = grid(api, book, tab), before = beforeGrids[tab];
    const ph = phonesIn(api, st);
    const moved = ph[0] === NEW && ph[2] === NEW && ph[3] === NEW;
    const oldGone = ph.every(p => !/1000000003$/.test(String(p).replace(/\D/g, '')));
    const decoys = ph[1] === DECOY && ph[4] === '01000000099';
    const rest = after.every((row, ri) => row.every((v, cj) => cj === ci || v === before[ri][cj]));
    t(`cascade ${book}/${tab}.${col}: new phone on all 3 old rows, old gone, decoys and other columns untouched`, moved && oldGone && decoys && rest && after.length === before.length, JSON.stringify(ph));
  });
  const stu = api.tab('Students');
  const phoneCol = api.colOf(stu, 'phone'); const col = []; for (let rr = 2; rr <= stu.getLastRow(); rr++) col.push(stu.get(rr, phoneCol));
  t('Students.phone rewritten, old gone, nobody else touched', col.includes(NEW) && !col.includes(OLD) && col.includes(DECOY) && col.length === 6, JSON.stringify(col));
  t('AuditLog is deliberately NOT rewritten (history)', grid(api, 'DATA', 'AuditLog')[1][3] === OLD);
  t('exactly one owner ping', api.ctx.PINGS.length === 1 && api.ctx.PINGS[0].includes(OLD) && api.ctx.PINGS[0].includes(NEW));
  const log = api.rows('StudentEditLog');
  t('one log row for the phone', log.length === 1 && log[0].field === 'phone' && log[0].old_value === OLD && log[0].new_value === NEW);
}

// ---------------------------------------------------------------- writes are per column, not per cell
{
  const api = build(); api.on(); seed(api);
  let calls = 0;
  [['STU'], ['DATA']].forEach(([b]) => api.getSS(b).sheets.forEach(sh => {
    const orig = sh.getRange.bind(sh);
    sh.getRange = (...a) => { const rg = orig(...a); const sv = rg.setValue.bind(rg), svs = rg.setValues.bind(rg); rg.setValue = v => { calls++; return sv(v); }; rg.setValues = v => { calls++; return svs(v); }; return rg; };
  }));
  api.edit({ phone: NEW });
  t('at most one setValues per store (+ the Students cells), never one per row', calls <= STORES.length + 3, String(calls));
}

// ---------------------------------------------------------------- failure leaves everything unchanged
function sabotage(api, book, tab, how) {
  const sh = api.getSS(book).getSheetByName(tab), orig = sh.getRange.bind(sh);
  sh.getRange = (...a) => { const rg = orig(...a); if (how === 'values') { rg.setValues = () => { throw new Error('boom: ' + tab); }; } else { rg.setValue = () => { throw new Error('boom: ' + tab); }; } return rg; };
}
{
  const api = build(); api.on(); seed(api);
  const before = snapshot(api);
  sabotage(api, 'DATA', 'Submissions', 'values');
  const r = api.edit({ phone: NEW, name: 'Should Not Stick' });
  t('a write failing in the 10th store: generic error', GENERIC(r), JSON.stringify(r));
  t('...and EVERY store, Students included, is exactly as before (rolled back)', snapshot(api) === before);
  t('...no log rows, no ping', api.rows('StudentEditLog').length === 0 && api.ctx.PINGS.length === 0);
}
{
  const api = build(); api.on(); seed(api);
  const before = snapshot(api);
  sabotage(api, 'STU', 'Students', 'value');
  const r = api.edit({ phone: NEW });
  t('a failure writing the Students row last: generic error', GENERIC(r), JSON.stringify(r));
  t('...all 11 stores rolled back', snapshot(api) === before);
}
{
  const api = build(); api.on(); seed(api);
  const before = snapshot(api);
  api.env.lockState.busy = true;
  const r = api.edit({ phone: NEW });
  t('lock not obtained: generic error', GENERIC(r), JSON.stringify(r));
  t('...nothing changed anywhere', snapshot(api) === before && api.ctx.PINGS.length === 0 && api.rows('StudentEditLog').length === 0);
  api.env.lockState.busy = false;
    const again = api.edit({ phone: NEW });
  t('retry after the lock frees up works', again.ok === true);
  t('the lock was requested with a 20 s wait', api.env.lockState.waits.includes(20000), JSON.stringify(api.env.lockState.waits));
}
{
  const api = build(); api.on(); seed(api);
  const before = snapshot(api);
  const sh = api.getSS('DATA').getSheetByName('Submissions'); sh.set(1, 1, 'student');   // header renamed by hand
  const mid = snapshot(api);
  const r = api.edit({ phone: NEW, name: 'Should Not Stick' });
  t('a store whose phone column cannot be found: refused before any write', GENERIC(r) && snapshot(api) === mid, JSON.stringify(r));
  sh.set(1, 1, 'student_id');
  t('...and it works again once the header is back', api.edit({ phone: NEW }).ok === true);
}
{
  const api = build(); api.on(); seed(api);
  const before = snapshot(api);
  const r = api.edit({ phone: DECOY });
  t('collision with an existing student: generic, all stores untouched', GENERIC(r) && snapshot(api) === before);
}

// ---------------------------------------------------------------- flag and missing tabs
{
  const api = build(); seed(api);                       // flag NOT set: default is off
  const before = snapshot(api);
  let r = api.edit({ phone: NEW });
  t('default (P4_TEACHER_PHONE_EDIT unset): phone change refused', GENERIC(r) && snapshot(api) === before);
  api.env.props.P4_TEACHER_PHONE_EDIT = '0';
  r = api.edit({ phone: NEW, name: 'Also Refused' });
  t('"0": a request with a phone change is refused whole', GENERIC(r) && snapshot(api) === before);
  r = api.edit({ name: 'Allowed Name', parent_phone: '01234567890' });
  t('"0": name and parent phone still work', r.ok === true && r.student.name === 'Allowed Name' && r.student.parent_phone === '01234567890' && r.student.phone === OLD, JSON.stringify(r));
  t('"0": no store was touched by the name edit', STORES.every(st => phonesIn(api, st)[0] === OLD));
  api.env.props.P4_TEACHER_PHONE_EDIT = '1';
  r = api.edit({ phone: NEW });
  t('"1": the same phone change now goes through', r.ok === true && phonesIn(api, STORES[0])[0] === NEW);
  api.env.props.P4_TEACHER_PHONE_EDIT = '';
  api.ctx.OWNED[NEW] = true;
  r = api.call('p4_teacher_update_student', { student: NEW, changes: { phone: '01077777777' } });
  t('blank property falls back to the default (off)', GENERIC(r));
}
{
  const api = build(); api.on();                        // none of the 11 tabs exist (fresh deployment)
  const r = api.edit({ phone: NEW });
  t('no phone-keyed tab exists yet: the edit still works (only Students changes)', r.ok === true && r.student.phone === NEW);
}
{
  const api = build(); api.on(); seed(api, tab => tab === 'Payments' || tab === 'QuizResults');
  const r = api.edit({ phone: NEW });
  t('only some tabs exist: those are cascaded, the rest skipped', r.ok === true && phonesIn(api, STORES[1])[0] === NEW && phonesIn(api, STORES[8])[0] === NEW);
}
{
  // DATA_SHEET_ID unset: QuizResults / Submissions live in the Students spreadsheet and are still found
  const api = makeEnv({ props: { DATA_SHEET_ID: '' } });
  const ctx = api.env.ctx; ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  vm.runInContext(fs.readFileSync(path.join(APPS, 'chunks', 'Phase4_Team.gs'), 'utf8'), ctx); vm.runInContext(STUBS, ctx);
  ctx.p4_setup(); api.env.props.P4_TEACHER_PHONE_EDIT = '1';
  const s = api.tab('Students'); const hs = ['student_id', 'name', 'lesson'];
  const q = api.tab('QuizResults') || api.getSS('STU').insertSheet('QuizResults'); if (!q.getLastRow()) q.appendRow(hs); q.appendRow([OLD, 'x', 'l']);
  ctx.TEST_CTX = { kind: 'teacher', via: 'session', id: '01000000002', subjects: ['math'], principal: '01000000002' };
  const sc = api.colOf(s, 'role'); s.set(3, sc, 'teacher'); s.set(3, api.colOf(s, 'teacher_scope'), 'math');
  ctx.OWNED[OLD] = true;
  const r = ctx.p4_teacher_update_student({ student: OLD, changes: { phone: NEW } });
  t('without DATA_SHEET_ID the data tabs in the main book are cascaded too', r.ok === true && q.get(2, 1) === NEW, JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
