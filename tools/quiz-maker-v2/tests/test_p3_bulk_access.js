// Phase 3 / S4: bulk lesson + quiz access (apps_script/Phase3_BulkAccess.gs) against the REAL Code.gs.
//   node tests/test_p3_bulk_access.js apps_script/Code.gs apps_script/Phase3_BulkAccess.gs
const { load } = require('./harness');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [codePath, p3Path] = process.argv.slice(2);
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e === undefined ? '' : (typeof e === 'string' ? e : JSON.stringify(e))))); };
const H = s => crypto.createHash('sha256').update(s).digest('hex');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

const L = ['programming/other/functions', 'programming/other/loops', 'english/grammar'];
const env = load(codePath);
// Phase3_*.gs files are not auto-loaded by the shared harness: run ours into the same context (shared scope, like Apps Script).
require('vm').runInContext(fs.readFileSync(p3Path, 'utf8'), env.ctx, { filename: path.basename(p3Path) });
const { post, getSS, ctx, lockState } = env;
const tab = n => getSS('STU').getSheetByName(n);
const rowsOf = n => { const sh = tab(n); if (!sh) return []; const hd = []; for (let c = 1; c <= 10; c++) hd.push(sh.get(1, c)); const o = []; for (let r = 2; r <= sh.getLastRow(); r++) { const row = {}; hd.forEach((h, i) => { if (h) row[h] = sh.get(r, i + 1); }); o.push(row); } return o; };
const audit = () => { const sh = getSS('DATA').getSheetByName('AuditLog'); if (!sh) return []; const o = []; for (let r = 2; r <= sh.getLastRow(); r++) o.push({ who: sh.get(r, 2), action: sh.get(r, 3), after: sh.get(r, 6) }); return o; };
const TOK = { token: 'tok' };
const call = (fn, p, creds) => { try { return ctx[fn](Object.assign({}, p, creds || TOK)); } catch (e) { return { ok: false, thrown: String(e.message || e) }; } };
const grant = (p, c) => call('p3_admin_bulk_grant', p, c), revoke = (p, c) => call('p3_admin_bulk_revoke', p, c), preview = (p, c) => call('p3_admin_bulk_preview', p, c);

const reg = (ph, pw, nm) => post({ action: 'register_student', phone: ph, password_hash: H(pw), display_name: nm, year: 'Senior 1', parent_phone: '01100000009' });
const adm = reg('01000000001', 'a', 'Teacher');
const P = ['01000000002', '01000000003', '01000000004', '01000000005', '01000000006'];
P.forEach((p, i) => reg(p, 'x', 'S' + i));
const stu = getSS('STU').getSheetByName('Students');
let isAdminCol = 0; for (let c = 1; c <= 12; c++) if (stu.get(1, c) === 'is_admin') isAdminCol = c;
stu.set(2, isAdminCol, true);
const addG = (group, phones) => post({ action: 'admin_group_add', group, phones, ...TOK });
t('setup: group A has 3 members', addG('GroupA', [P[0], P[1], P[2]]).ok);
t('setup: group B has 1 member (overlaps A)', addG('GroupB', [P[2]]).ok);
t('setup: empty-ish group exists', addG('GroupC', [P[3]]).ok);

const ent = () => rowsOf('Entitlements'), qa = () => rowsOf('QuizAccess');

// ---- guard
{
  const r = grant({ kind: 'lesson', lessons: [L[0]], groups: ['GroupA'] }, { token: 'wrong' });
  t('bad admin token is refused (grant)', !r.ok, r);
  t('bad admin token is refused (revoke)', !revoke({ kind: 'lesson', lessons: [L[0]], groups: ['GroupA'] }, { token: 'wrong' }).ok);
  t('bad admin token is refused (preview)', !preview({ kind: 'lesson', lessons: [L[0]], groups: ['GroupA'] }, { token: 'wrong' }).ok);
  t('nothing was written by refused calls', ent().length === 0);
}

// ---- validation
{
  t('kind required', !!grant({ lessons: [L[0]], groups: ['GroupA'] }).thrown);
  t('lessons required', !!grant({ kind: 'lesson', lessons: [], groups: ['GroupA'] }).thrown);
  t('targets required', !!grant({ kind: 'lesson', lessons: [L[0]] }).thrown);
  t('an invalid lesson rejects the whole batch', !!grant({ kind: 'quiz', lessons: [L[0], '../x'], groups: ['GroupA'] }).thrown);
  t('validation wrote nothing', ent().length === 0 && qa().length === 0);
}

// ---- 3 lessons x 2 groups -> 6 rows (groups A,B share phone P2 -> distinct students = 3 -> 9 pairs; use C instead for clean 3x2)
{
  const body = { kind: 'lesson', lessons: L, groups: ['GroupA'], members: [P[3]] };   // 4 distinct students x 3 lessons = 12
  const pv = preview(body);
  t('preview: counts match (12 new)', pv.ok && pv.total === 12 && pv.would_create === 12 && pv.would_skip === 0 && pv.students === 4 && pv.lessons === 3, pv);
  t('preview wrote nothing', ent().length === 0);
  const w0 = lockState.waits.length;
  const r = grant(body);
  const w1 = lockState.waits.length;
  t('grant applied 12, skipped 0, no failures', r.ok && r.applied === 12 && r.skipped === 0 && r.failed.length === 0, r);
  t('12 Entitlements rows exist', ent().length === 12, ent().length);
  t('group members carry group source, direct student is manual', ent().filter(e => e.source === 'group:GroupA').length === 9 && ent().filter(e => e.source === 'manual').length === 3, ent().map(e => e.source));
  t('group rules remembered (1 group x 3 lessons)', rowsOf('GroupGrants').filter(g => g.kind === 'access').length === 3, rowsOf('GroupGrants'));
  t('one lock for the whole request', w1 - w0 === 1, w1 - w0);
  // idempotent on rerun (never expires default -> forever)
  const pv2 = preview(body);
  t('preview after grant: all skipped', pv2.would_apply === 0 && pv2.would_skip === 12, pv2);
  const r2 = grant(body);
  t('rerun is a no-op (applied 0, skipped 12)', r2.ok && r2.applied === 0 && r2.skipped === 12, r2);
  t('rerun adds no rows', ent().length === 12);
  t('outside students untouched', !ent().some(e => String(e.phone).endsWith('4') && false) && !ent().some(e => String(e.phone).includes(P[4].slice(1))));
}

// ---- overlap: a phone reached via two groups + members counts once
{
  const body = { kind: 'quiz', lessons: [L[0]], groups: ['GroupA', 'GroupB'], members: [P[2], '+2' + P[2]] };
  const pv = preview(body);
  t('overlapping targets are deduped (3 students)', pv.students === 3 && pv.total === 3, pv);
  const r = grant(Object.assign({ days: 30 }, body));
  t('quiz grant created 3 rows', r.ok && r.applied === 3 && qa().length === 3, r);
  t('quiz rows carry the term', qa().every(q => q.expires_at === addDays(today, 30)), qa());
  const r2 = grant(Object.assign({ days: 30 }, body));
  t('rerunning with days extends (existing single-grant rule), not duplicates', r2.ok && qa().length === 3 && r2.extended === 3, r2);
  const r3 = grant(Object.assign({ never: true }, body));
  t('never grant converts to forever', r3.ok && qa().every(q => q.expires_at === ''), qa());
  const r4 = grant(Object.assign({ days: 5 }, body));
  t('a short grant never shortens forever (skipped)', r4.ok && r4.applied === 0 && r4.skipped === 3, r4);
  t('quiz group rules remembered for both groups', rowsOf('GroupGrants').filter(g => g.kind === 'quiz').length === 2, rowsOf('GroupGrants'));
}

// ---- partial failure is reported, not swallowed
{
  const r = grant({ kind: 'lesson', lessons: [L[0]], groups: ['NoSuchGroup'], members: ['123', P[4]] });
  t('valid target still applied', r.ok && r.applied === 1, r);
  t('unknown group reported', r.failed.some(f => f.target === 'NoSuchGroup'), r.failed);
  t('bad phone reported', r.failed.some(f => f.target === '123'), r.failed);
  t('preview reports the same failures', preview({ kind: 'lesson', lessons: [L[0]], groups: ['NoSuchGroup'], members: ['123', P[4]] }).failed.length === 2);
}

// ---- cap
{
  const many = []; for (let i = 0; i < 90; i++) many.push('0100001' + String(1000 + i));
  const before = ent().length;
  const r = grant({ kind: 'lesson', lessons: [L[0], L[1], L[2], 'a/b', 'a/c'], members: many });   // 90 x 5 = 450 > 400
  t('cap enforced with a clear message', r.thrown && /limit is 400/.test(r.thrown), r);
  t('cap refusal wrote nothing', ent().length === before);
  const ok = grant({ kind: 'lesson', lessons: ['a/b', 'a/c', 'a/d', 'a/e'], members: many.slice(0, 100) });  // 90 x 4 = 360
  t('just under the cap passes', ok.ok && ok.applied === 360, ok);
}

// ---- revoke symmetrical
{
  const body = { kind: 'lesson', lessons: L, groups: ['GroupA'], members: [P[3]] };
  const pv = preview(Object.assign({ mode: 'revoke' }, body));
  t('revoke preview: 12 would be revoked', pv.ok && pv.would_revoke === 12 && pv.would_skip === 0, pv);
  const before = ent().length;
  const r = revoke(body);
  t('revoke applied 12', r.ok && r.applied === 12 && r.failed.length === 0, r);
  t('exactly those 12 rows are gone', ent().length === before - 12);
  t('revoked list carries what to re-grant', r.revoked.length === 12 && r.revoked.every(x => x.phone && x.lesson), r.revoked[0]);
  t('group rules for GroupA removed', rowsOf('GroupGrants').filter(g => g.kind === 'access' && g.group === 'GroupA').length === 0, rowsOf('GroupGrants'));
  const r2 = revoke(body);
  t('revoking again is a no-op, not an error', r2.ok && r2.applied === 0 && r2.skipped === 12, r2);
  t('non-selected students keep their access', ent().some(e => String(e.phone).includes(P[4].slice(1))));
  // undo hint: re-grant from the revoked list restores them
  const again = grant(body);
  t('re-grant restores the 12 rows', again.ok && again.applied === 12, again);
}
{
  const r = revoke({ kind: 'quiz', lessons: [L[0]], groups: ['GroupA'] });
  t('quiz revoke removes the group members\' overrides', r.ok && r.applied === 3 && qa().length === 0, r);
}

// ---- payment bookkeeping on lesson revoke (same as single revoke)
{
  const ph = P[4];
  post({ action: 'admin_grant_access', phone: ph, scope: 'english/vocab', ...TOK });
  const r = revoke({ kind: 'lesson', lessons: ['english/vocab'], members: [ph] });
  t('manual access revoked with no payments touched', r.ok && r.applied === 1 && r.payments_revoked.length === 0, r);
}

// ---- audit
{
  const a = audit().filter(x => /^p3_admin_bulk_/.test(x.action));
  t('every applied action is audited', a.some(x => x.action === 'p3_admin_bulk_grant') && a.some(x => x.action === 'p3_admin_bulk_revoke'), a.map(x => x.action));
}

// ---- existing single / group quiz-access paths still work next to the bulk file
{
  const r = post({ action: 'admin_group_grant_quiz_access', group: 'GroupC', lesson: L[1], ...TOK });
  t('existing admin_group_grant_quiz_access still works', r.ok && r.count === 1, r);
  const b = grant({ kind: 'quiz', lessons: [L[1]], groups: ['GroupC'] });
  t('bulk sees it and skips (idempotent with the old path)', b.ok && b.applied === 0 && b.skipped === 1, b);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
