// P4 / S8: p4_admin_teacher_stats (owner only, read only, counts and sums only).
// Usage: node tests/test_p4_s8_stats.js
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { makeEnv } = require('./fixtures/phase2_env');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };
const APPS = path.join(__dirname, '..', 'apps_script');
const NOT_AUTH = r => r && r.ok === false && r.error === 'Not authorized.';
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const STUBS = `
var TEST_CTX = null, LINKED = {}, LESSONS_LIST = null, GH_CALLS = 0;
function p4_ctx() { return TEST_CTX; }
function p4_linked_(ctx) { return LINKED[ctx.principal || ctx.id] || []; }
function _allLessonsFromGithub() { GH_CALLS++; if (!LESSONS_LIST) throw new Error('no github'); return { lessons: LESSONS_LIST.map(function (l) { return { lesson: l }; }) }; }
`;
const TM = '01000000010', TE = '01000000011', TM2 = '01000000012', AS = '01000000013';
const A = '01000000002', B = '01000000003', C = '01000000004', D = '01000000005', E = '01000000006', F = '01000000007';

function build(opts = {}) {
  const api = makeEnv();
  const ctx = api.env.ctx;
  ctx.Utilities.DigestAlgorithm.SHA_256 = 'sha256';
  vm.runInContext(fs.readFileSync(path.join(APPS, 'chunks', 'Phase4_Stats.gs'), 'utf8'), ctx, { filename: 'Phase4_Stats.gs' });
  vm.runInContext(STUBS.replace(/function p4_linked_[^\n]*\n/, opts.noLinked ? '' : '$&'), ctx);
  api.env.setNow('2026-10-31T10:00:00Z');
  api.ctx = ctx;
  api.call = (p) => { try { return ctx.p4_admin_teacher_stats(p || {}); } catch (e) { return { ok: false, error: 'THROWN ' + e.message }; } };
  api.as = c => { ctx.TEST_CTX = c; };
  api.owner = () => api.as({ kind: 'owner', via: 'session', id: '01000000001', subjects: ['*'], principal: '' });
  return api;
}
function sheet(api, book, name, headers) { const ss = api.getSS(book); let sh = ss.getSheetByName(name); if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); } return sh; }
function addCol(sh, name) { sh.set(1, sh.getLastColumn() + 1, name); return sh.getLastColumn(); }
function setStaff(api, phone, role, scope, of) {
  const s = api.tab('Students'); let row = 0; for (let r = 2; r <= s.getLastRow(); r++) if (String(s.get(r, 1)) === phone) row = r;
  ['role', 'teacher_scope', 'assistant_of'].forEach(n => { if (!api.colOf(s, n)) addCol(s, n); });
  s.set(row, api.colOf(s, 'role'), role); s.set(row, api.colOf(s, 'teacher_scope'), scope || ''); s.set(row, api.colOf(s, 'assistant_of'), of || '');
}
const PH = ['payment_id', 'phone', 'name', 'scope', 'reference', 'note', 'status', 'created_at', 'decided_at'];
function pay(api, id, phone, scope, note, status, created, decided) {
  sheet(api, 'STU', 'Payments', PH).appendRow([id, phone, 'Canary Student', scope, 'REF-SECRET-' + id, note, status, created, decided || '']);
}
function world(extra = {}) {
  const api = build(extra);
  [[TM, 'Ziad Math'], [TE, 'Eman English'], [TM2, 'Bassem Math'], [AS, 'Aya Assistant']].forEach(([p, n]) => api.post({ action: 'register_student', phone: p, password_hash: H(p), display_name: n, year: 'Senior 2', parent_phone: '01100000009' }));
  api.post({ action: 'register_student', phone: E, password_hash: H('e'), display_name: 'Eve Canary', year: 'Senior 2', parent_phone: '01100000008' });
  api.post({ action: 'register_student', phone: F, password_hash: H('f'), display_name: 'Finn Canary', year: 'Senior 2', parent_phone: '01100000007' });
  setStaff(api, TM, 'teacher', 'math'); setStaff(api, TE, 'teacher', 'english'); setStaff(api, TM2, 'teacher', 'math'); setStaff(api, AS, 'assistant', '', TM);
  const CH = n => 'Grade 1 \u00b7 Chapter ' + n + ' \u00b7 250 EGP';
  pay(api, 'p1', A, 'math/sat/grade-1#ch1', CH(1), 'approved', '2026-10-04 10:00:00', '2026-10-05 10:00:00');
  pay(api, 'p2', B, 'math/sat/grade-1#t1', 'Grade 1 \u00b7 Term 1 \u00b7 1000 EGP', 'approved', '2026-09-19 10:00:00', '2026-09-20 10:00:00');
  pay(api, 'p3', C, 'math/sat/grade-1#ch2', CH(2), 'approved', '2026-07-30 10:00:00', '2026-08-01 10:00:00');
  pay(api, 'p4', E, 'math/sat/grade-1#ch3', CH(3), 'pending', '2026-10-29 10:00:00');
  pay(api, 'p5', F, 'math/sat/grade-1#ch4', CH(4), 'rejected', '2026-10-01 10:00:00', '2026-10-02 10:00:00');
  pay(api, 'p6', D, 'math/sat/lesson-1', 'please accept 999 EGP', 'approved', '2026-10-10 10:00:00', '2026-10-11 10:00:00');
  pay(api, 'p7', E, 'english/grade-2#ch2', 'Grade 2 \u00b7 Chapter 2 \u00b7 300 EGP', 'approved', '2026-10-09 10:00:00', '2026-10-10 10:00:00');
  pay(api, 'p8', F, 'english/grade-2#t1', 'Grade 2 \u00b7 Term 1 \u00b7 40 USD', 'approved', '2026-09-14 10:00:00', '2026-09-15 10:00:00');
  pay(api, 'p9', A, 'programming/baccalaureate/grade-1-secondary#ch3', CH(3), 'approved', '2026-10-01 10:00:00', '2026-10-02 10:00:00');
  pay(api, 'p10', D, '', '', 'approved', '2026-10-01 10:00:00', '2026-10-02 10:00:00');       // unknown subject
  const V = sheet(api, 'STU', 'Videos', ['lesson', 'slot', 'embed_url', 'locked', 'updated_at']);
  [['math/sat/l1', 'lesson', 'https://v/1'], ['math/sat/l2', 'lesson', ''], ['english/e1', 'lesson', 'https://v/2'], ['programming/p1', 'lesson', 'https://v/3'], ['programming/p2', 'lesson', 'https://v/4'], ['programming/p3', 'lesson', 'https://v/5']].forEach(r => V.appendRow([r[0], r[1], r[2], 'FALSE', '']));
  const L = sheet(api, 'STU', 'Lessons', ['lesson', 'locked', 'updated_at']);
  [['math/sat/l1', 'TRUE'], ['math/sat/l2', 'FALSE'], ['english/e1', 'TRUE'], ['programming/p1', 'TRUE'], ['programming/p2', 'TRUE'], ['programming/p3', 'FALSE']].forEach(r => L.appendRow([r[0], r[1], '']));
  const Q = sheet(api, 'STU', 'Quizzes', ['lesson', 'locked', 'updated_at']);
  [['math/sat/l1', 'TRUE'], ['english/e1', 'FALSE'], ['programming/p1', 'TRUE']].forEach(r => Q.appendRow([r[0], r[1], '']));
  const QR = sheet(api, 'DATA', 'QuizResults', ['student_id', 'name', 'subject', 'lesson', 'quiz_title', 'date', 'start_time', 'end_time', 'score', 'total']);
  [[A, 'math/sat/l1', '2026-10-20'], [A, 'math/sat/l1', '2026-10-25'], [B, 'math/sat/l2', '2026-10-30'], [C, 'math/sat/l1', '2026-08-01'], [E, 'english/e1', '2026-10-27']].forEach(r => QR.appendRow([r[0], 'Canary Student', '', r[1], 'Q', r[2], '', '', 5, 10]));
  const SB = sheet(api, 'DATA', 'Submissions', ['student_id', 'name', 'subject', 'lesson', 'submission_type', 'date']);
  SB.appendRow([D, 'Canary Student', '', 'math/sat/l1', 'text', '2026-10-29']);
  const WA = sheet(api, 'DATA', 'WrittenAnswers', ['submission_id', 'student_id', 'lesson', 'question_id', 'drive_file_id', 'awarded', 'max', 'note', 'graded_at', 'uploaded_at']);
  [['c:1', A, 'math/sat/l1', '', '2026-10-21 12:00:00'], ['c:2', B, 'math/sat/l1', '', '2026-10-28 12:00:00'], ['c:3', C, 'math/sat/l1', 2, '2026-10-01 12:00:00'], ['c:4', A, 'programming/p1', '', '2026-10-30 09:00:00']]
    .forEach((r, i) => WA.appendRow([r[0], r[1], r[2], 'q' + i, 'FILE-SECRET-' + i, r[3], 5, '', '', r[4]]));
  const EN = sheet(api, 'STU', 'Entitlements', ['phone', 'scope', 'expires_at', 'granted_at', 'source']); EN.appendRow([A, 'math/sat/l1', '', '', '']);
  const QA = sheet(api, 'STU', 'QuizAccess', ['phone', 'lesson', 'expires_at', 'granted_at', 'source']); QA.appendRow([B, 'math/sat/l2', '', '', '']);
  const G = sheet(api, 'STU', 'Groups', ['group', 'phone', 'name', 'added_at']);
  [['G-math', A], ['G-math', B], ['G-eng', E], ['G-prog', A]].forEach(r => G.appendRow([r[0], r[1], 'Canary Student', '']));
  const GO = sheet(api, 'STU', 'GroupOwners', ['group', 'owner_id', 'created_at']); GO.appendRow(['G-math', TM, '']); GO.appendRow(['G-eng', TE, '']);
  const TG = sheet(api, 'STU', 'TeacherTelegram', ['teacher_id', 'chat_id', 'linked_at']); TG.appendRow([TM, '99887766', '']);
  api.ctx.LESSONS_LIST = ['math/sat/l1', 'math/sat/l2', 'math/sat/l3', 'math/sat/l4', 'english/e1', 'english/e2', 'programming/p1', 'programming/p2', 'programming/p3', 'programming/p4', 'programming/p5'];
  api.ctx.LINKED[TM] = [A, B, C, D]; api.ctx.LINKED[TE] = [E]; api.ctx.LINKED[TM2] = [A];
  api.owner();
  return api;
}
const sub = (r, s) => r.subjects.find(x => x.subject === s);
const tch = (r, p) => r.teachers.find(x => x.phone === p);

// ---------------------------------------------------------------- who may call
{
  const api = world();
  const ok = api.call({});
  t('owner gets ok', ok.ok === true && ok.cached === false, JSON.stringify(ok).slice(0, 200));
  for (const [label, c] of [['teacher', { kind: 'teacher', subjects: ['math'], principal: TM, id: TM }], ['scoped assistant', { kind: 'assistant', subjects: ['math'], principal: TM, id: AS }],
    ['legacy assistant', { kind: 'assistant', subjects: [], principal: '', id: AS }], ['student', { kind: 'student', subjects: [], principal: '', id: A }], ['anon', { kind: 'anon', subjects: [], principal: '', id: '' }], ['no ctx', null]]) {
    api.as(c);
    t('refused for ' + label + ' even though the cache is warm', NOT_AUTH(api.call({})) && NOT_AUTH(api.call({ refresh: true })));
  }
}

// ---------------------------------------------------------------- every metric
{
  const api = world();
  const r = api.call({});
  t('generated_at is an ISO timestamp with offset', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(r.generated_at), r.generated_at);
  t('currency_note present, subjects are the three', typeof r.currency_note === 'string' && r.currency_note.length > 20 && eq(r.subjects.map(s => s.subject), ['programming', 'english', 'math']));
  const m = sub(r, 'math'), e = sub(r, 'english'), p = sub(r, 'programming');
  t('math revenue all_time (250+1000+250, free-text 999 ignored)', eq(m.revenue.all_time, { EGP: 1500 }), JSON.stringify(m.revenue));
  t('math revenue this month / last month / pending', eq(m.revenue.this_month, { EGP: 250 }) && eq(m.revenue.last_month, { EGP: 1000 }) && eq(m.revenue.pending, { EGP: 250 }), JSON.stringify(m.revenue));
  t('math payments approved 4 / pending 1 / rejected 1 / unpriced 1', eq(m.payments, { approved: 4, pending: 1, rejected: 1, unpriced: 1 }), JSON.stringify(m.payments));
  t('english revenue per currency, never converted', eq(e.revenue.all_time, { EGP: 300, USD: 40 }) && eq(e.revenue.this_month, { EGP: 300 }) && eq(e.revenue.last_month, { USD: 40 }), JSON.stringify(e.revenue));
  t('programming revenue', eq(p.revenue.all_time, { EGP: 250 }) && eq(p.revenue.this_month, { EGP: 250 }) && eq(p.revenue.last_month, {}));
  t('videos count only rows with a link', m.videos === 1 && e.videos === 1 && p.videos === 3, [m.videos, e.videos, p.videos].join());
  t('lessons total (from the lesson list) and locked', eq(m.lessons, { total: 4, locked: 1 }) && eq(e.lessons, { total: 2, locked: 1 }) && eq(p.lessons, { total: 5, locked: 2 }), JSON.stringify([m.lessons, e.lessons, p.lessons]));
  t('quizzes locked', m.quizzes.locked === 1 && e.quizzes.locked === 0 && p.quizzes.locked === 1);
  t('quiz results in 30 days (the August one is excluded)', m.quiz_results_30d === 3 && e.quiz_results_30d === 1 && p.quiz_results_30d === 0, [m.quiz_results_30d, e.quiz_results_30d, p.quiz_results_30d].join());
  t('subject students linked / active 30d', eq(m.students, { linked: 5, active_30d: 3 }) && eq(e.students, { linked: 2, active_30d: 1 }) && eq(p.students, { linked: 1, active_30d: 0 }), JSON.stringify([m.students, e.students, p.students]));
  t('written awaiting and oldest age in days', eq(m.written, { awaiting: 2, oldest_days: 10 }) && eq(e.written, { awaiting: 0, oldest_days: null }) && eq(p.written, { awaiting: 1, oldest_days: 1 }), JSON.stringify([m.written, e.written, p.written]));
  t('groups on a subject block is null (a group has no subject)', m.groups === null && e.groups === null);

  const zm = tch(r, TM), ze = tch(r, TE);
  t('two teachers listed, scope as array', r.teachers.length === 3 && eq(zm.scope, ['math']) && eq(ze.scope, ['english']) && zm.name === 'Ziad Math');
  t('teacher revenue equals his subject', eq(ze.revenue.all_time, { EGP: 300, USD: 40 }) && eq(zm.revenue.this_month, { EGP: 250 }));
  t('teacher students come from S3 linkage', eq(zm.students, { linked: 4, active_30d: 3 }) && eq(ze.students, { linked: 1, active_30d: 1 }), JSON.stringify([zm.students, ze.students]));
  t('teacher groups come from GroupOwners', zm.groups === 1 && ze.groups === 1);
  t('assistants and telegram flags', zm.assistants === 1 && ze.assistants === 0 && zm.telegram === true && ze.telegram === false);
  t('teacher written / lessons / videos', eq(zm.written, { awaiting: 2, oldest_days: 10 }) && eq(zm.lessons, { total: 4, locked: 1 }) && zm.videos === 1);
  t('no shared flag on english, shared flag on both math teachers and the math subject', !('shared_subject' in ze) && zm.shared_subject === true && tch(r, TM2).shared_subject === true && m.shared_subject === true && !('shared_subject' in e));
  t('owner block: everything including the unknown-subject payment', r.owner.payments.approved === 8 && eq(r.owner.revenue.all_time, { EGP: 2050, USD: 40 }) && r.owner.lessons.total === 11 && r.owner.lessons.locked === 4, JSON.stringify(r.owner.payments));
  t('owner students: union of everybody', eq(r.owner.students, { linked: 6, active_30d: 4 }), JSON.stringify(r.owner.students));
  t('owner groups and assistants', r.owner.groups === 3 && r.owner.assistants === 1);
  t('totals = the three subjects only (no unknown-subject row)', r.totals.payments.approved === 7 && eq(r.totals.revenue.all_time, { EGP: 2050, USD: 40 }) && r.totals.videos === 5 && r.totals.written.awaiting === 3 && r.totals.written.oldest_days === 10);
}

// ---------------------------------------------------------------- cache
{
  const api = world();
  const first = api.call({});
  api.getSS('STU').getSheetByName('Videos').appendRow(['math/sat/l9', 'lesson', 'https://v/9', 'FALSE', '']);
  const second = api.call({});
  t('second call is cached, same generated_at, old numbers', second.cached === true && second.generated_at === first.generated_at && sub(second, 'math').videos === 1);
  const third = api.call({ refresh: true });
  t('refresh:true recomputes (fresh numbers, cached false)', third.cached === false && sub(third, 'math').videos === 2);
  t('the cache key is p4stats:v1', 'p4stats:v1' in api.env.cache);
  const fourth = api.call({});
  t('refresh also refilled the cache', fourth.cached === true && sub(fourth, 'math').videos === 2);
  api.env.setNow('2026-10-31T10:10:00Z');
}

// ---------------------------------------------------------------- null, never a guess
{
  const api = world({ noLinked: true });
  api.ctx.LESSONS_LIST = null;                       // GitHub unreachable
  api.getSS('STU').getSheetByName('Videos').set(1, 3, 'link');   // embed_url header renamed: unreadable
  const r = api.call({});
  t('lesson list unavailable: lessons.total null (locked still counted)', sub(r, 'math').lessons.total === null && sub(r, 'math').lessons.locked === 1 && r.owner.lessons.total === null);
  t('unreadable Videos sheet: videos null everywhere', sub(r, 'math').videos === null && tch(r, TM).videos === null && r.owner.videos === null && r.totals.videos === null);
  t('no p4_linked_: teacher students null, other teacher fields still there', /MERGED FROM Phase4_/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8')) || tch(r, TM).students === null && tch(r, TM).assistants === 1 && tch(r, TM).revenue !== null);
  t('other metrics untouched by the failures', sub(r, 'math').payments.approved === 4 && sub(r, 'math').written.awaiting === 2);
}
{
  const api = world();
  api.getSS('DATA').getSheetByName('WrittenAnswers').set(1, 6, 'grade');   // awarded column gone
  const r = api.call({});
  t('unreadable WrittenAnswers: written null, owner and teacher too', sub(r, 'math').written === null && tch(r, TM).written === null && r.owner.written === null);
}
{
  const api = build(); api.owner();                  // brand new deployment: no tabs at all
  const r = api.call({});
  t('no data tabs yet: zeros, not errors', r.ok && sub(r, 'math').payments.approved === 0 && eq(sub(r, 'math').revenue.all_time, {}) && r.teachers.length === 0 && sub(r, 'math').written.oldest_days === null, JSON.stringify(r).slice(0, 200));
}

// ---------------------------------------------------------------- privacy
{
  const api = world();
  const r = api.call({ refresh: true });
  const s = JSON.stringify(r);
  const forbidden = [A, B, C, D, E, F, A.slice(1), B.slice(1), E.slice(1), 'Canary', 'Eve ', 'Finn ', 'Sara Mahmoud', 'Omar Ali', 'Lamis', 'Hana Sami', 'REF-SECRET', 'FILE-SECRET', '01100000009', '01100000008', '01100000007', 'please accept', '99887766', H(A)];
  forbidden.forEach(v => t('response never contains ' + JSON.stringify(v), !s.includes(v)));
  t('teacher phones and names (not student data) are allowed', s.includes(TM) && s.includes('Ziad Math'));
  const keys = new Set(); (function walk(o) { if (o && typeof o === 'object') Object.keys(o).forEach(k => { keys.add(k); walk(o[k]); }); })(r);
  t('no student-level key anywhere in the response', ['student', 'student_id', 'reference', 'note', 'payment_id', 'file_id', 'parent_phone', 'display_name'].every(k => !keys.has(k)), [...keys].join());
  const c = api.env.cache['p4stats:v1'];
  t('the cached copy is clean too', !c.includes('Canary') && !c.includes(A));
}

// ---------------------------------------------------------------- read only + load
{
  const api = world();
  const snap = () => JSON.stringify(['STU', 'DATA'].map(b => api.getSS(b).sheets.map(s => [s.name, [...s.cells.entries()]])));
  const before = snap();
  api.call({ refresh: true });
  t('read-only: no sheet changed', snap() === before);
  // bulk reads: count getRange calls per call (must not scale with rows)
  const count = () => { let n = 0; ['STU', 'DATA'].forEach(b => api.getSS(b).sheets.forEach(sh => { const o = sh.getRange.bind(sh); sh.getRange = (...a) => { n++; return o(...a); }; })); return () => n; };
  const getN = count();
  api.call({ refresh: true });
  const small = getN();
  const PS = api.getSS('STU').getSheetByName('Payments');
  for (let i = 0; i < 3000; i++) PS.appendRow(['x' + i, A, 'n', 'math/sat/l1', 'r', 'note', i % 3 ? 'approved' : 'pending', '2026-10-01 10:00:00', '2026-10-02 10:00:00']);
  const QR = api.getSS('DATA').getSheetByName('QuizResults');
  for (let i = 0; i < 3000; i++) QR.appendRow([A, 'n', '', 'math/sat/l1', 'Q', '2026-10-20', '', '', 1, 2]);
  const t0 = Date.now(); const big = api.call({ refresh: true }); const ms = Date.now() - t0;
  const largeN = getN() - small;
  t('getRange calls do not grow with rows (bulk reads)', largeN === small, small + ' vs ' + largeN);
  t('largest fixture (3000 payments + 3000 results) is computed correctly', big.ok && sub(big, 'math').payments.approved === 2004 && sub(big, 'math').quiz_results_30d === 3003, JSON.stringify(sub(big, 'math').payments));
  console.log('INFO sheet range reads per call: ' + small + '; 6000-row fixture computed in ' + ms + ' ms (Node mock, not Apps Script)');
  t('computed in under 5 s on the mock', ms < 5000, String(ms));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
