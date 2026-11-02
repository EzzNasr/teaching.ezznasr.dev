// R-P4-S4-04 (pending until assembly): the authorization matrix. tests/fixtures/p4_matrix.json x 7 callers x
// lesson context x ownership variants, run against the REAL Phase 4 code merged and wired into Code.gs.
//   gate layer  : env.ctx.p4_gate(payload) must allow or deny exactly as the contract rules say
//   router layer: a denied teacher/assistant cell must come back from doPost as exactly "Not authorized."
//   old callers : legacy assistant, student, anon fall through the gate untouched; admin-ish actions still refuse them
// Also: P4_ACTIONS matches the fixture, and every router case is in P4_ACTIONS or passes as PUB.
const fs = require('fs'), path = require('path');
const { makeWorld, LESSONS, S1PHONE, S2PHONE } = require('./test_p4_s4_support');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'p4_matrix.json'), 'utf8'));
const CODE = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
let fails = 0;
const t = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '  ' + String(d === undefined ? '' : d).slice(0, 600))); if (!ok) fails++; };

if (!/function p4_gate\(/.test(CODE) || !/var __g = \(typeof p4_gate/.test(CODE)) {
  t('Phase 4 is merged and wired into Code.gs (run scripts/p4_wire.py --merge --wire first)', false, 'p4_gate or hook H3 not found in Code.gs');
  process.exit(1);
}
let W;
try { W = makeWorld(); } catch (e) { t('world builds', false, e && e.stack); process.exit(1); }
const ctx = W.api.env.ctx;
const P3 = new Set((CODE.match(/var P3_STAFF_ALLOW = \[([^\]]*)\]/) || [, ''])[1].match(/"[a-z_0-9]+"/g).map(s => s.replace(/"/g, '')));
const denyAssist = a => fx.assistant_deny.some(d => d === a || (d.endsWith('*') && a.startsWith(d.slice(0, -1))));

// P4_ACTIONS drift: rule class per action
try {
  const table = ctx.P4_ACTIONS;
  const names = Object.keys(table || {});
  t('P4_ACTIONS exists and has a row for every fixture action that is not PUB', names.length > 0 && fx.actions.filter(a => a.rule !== 'PUB').every(a => names.includes(a.action)), fx.actions.filter(a => a.rule !== 'PUB' && !names.includes(a.action)).map(a => a.action).join(', '));
  t('P4_ACTIONS has no action the fixture does not know', names.every(n => fx.actions.some(a => a.action === n)), names.filter(n => !fx.actions.some(a => a.action === n)).join(', '));
} catch (e) { t('P4_ACTIONS readable', false, e.message); }

const lessonVal = c => c === 'none' ? undefined : LESSONS[c];
function variants(a) {
  const out = [];
  const ctxs = a.needs.includes('L') ? ['math', 'programming', 'none'] : ['math'];
  const stu = a.needs.includes('St') ? ['own', 'foreign'] : ['own'];
  const grp = a.group_optional ? ['own', 'foreign'] : a.needs.includes('GC') ? ['own', 'free', 'foreign'] : a.needs.includes('G') ? ['own', 'foreign'] : ['own'];
  const pay = a.needs.includes('PAY') ? ['math', 'programming'] : ['math'];
  ctxs.forEach(c => stu.forEach(s => grp.forEach(g => pay.forEach(p => out.push({ c, s, g, p })))));
  return out;
}
function build(a, v, creds) {
  const p = Object.assign({ action: a.action }, creds), f = a.fields || {};
  if (f.lesson && lessonVal(v.c)) p[f.lesson] = lessonVal(v.c);
  if (a.action === 'upload_attachment' && lessonVal(v.c)) p.subject = v.c;
  if (f.student) { const ph = v.s === 'own' ? S1PHONE : S2PHONE; if (f.student.includes('[]')) p.items = [{ phone: ph, mode: 'present' }]; else p[f.student] = ph; }
  if (f.group) p[f.group] = v.g === 'own' ? 'G-OWN' : v.g === 'free' ? 'G-NEW' : 'G-OTHER';
  if (f.payment) p[f.payment] = v.p === 'math' ? 'PAY-MATH' : 'PAY-PROG';
  if (a.action === 'admin_decide_payment') p.decision = 'approve';
  return p;
}
function expectGate(a, caller, v) {                       // true = allow, false = deny
  if (caller === 'owner' || ['assistant_legacy', 'student', 'anon'].includes(caller)) return true;
  if (a.rule === 'PUB') return true;
  if (a.rule === 'O') return false;
  const kind = caller === 'teacher_tok' ? 'tok' : 'ses';
  if (caller === 'assistant_scoped') {
    if (a.rule === 'T' || a.action.startsWith('p4_') || !P3.has(a.action) || denyAssist(a.action)) return false;
  }
  if (a.via.length && !a.via.includes(kind)) return false;
  if (!a.via.length && a.rule !== 'PUB') return false;
  if (a.resolve) return false;                             // lesson resolved from an id that does not exist in the fixture: cannot resolve = deny
  const n = a.needs;
  if (a.group_optional && v.g === 'foreign') return false;   // "+GP if a group field is present"
  if (n.includes('L') && v.c !== 'math') return false;
  if (n.includes('St') && v.s !== 'own') return false;
  if (n.includes('G') && v.g !== 'own') return false;
  if (n.includes('GC') && v.g === 'foreign') return false;
  if (n.includes('PAY') && v.p !== 'math') return false;
  return true;
}
const unwired = ['upload_attachment', 'delete_attachment'];
let cells = 0;
fx.actions.forEach(a => {
  const bad = [];
  Object.keys(W.callers).forEach(caller => {
    const creds = W.callers[caller]();
    variants(a).forEach(v => {
      const payload = build(a, v, creds), want = expectGate(a, caller, v);
      cells++;
      let got;
      try { const g = ctx.p4_gate(JSON.parse(JSON.stringify(payload))); got = !(g && g.deny); if (g && g.deny && g.deny.error !== 'Not authorized.') bad.push(`${caller}/${v.c}/${v.s}/${v.g}/${v.p}: refusal text ${JSON.stringify(g.deny)}`); }
      catch (e) { bad.push(`${caller}: gate threw ${e.message}`); return; }
      if (got !== want) bad.push(`${caller} [lesson ${v.c}, student ${v.s}, group ${v.g}, payment ${v.p}] gate ${got ? 'ALLOWED' : 'DENIED'}, expected ${want ? 'allow' : 'deny'}`);
      // router layer: only for cells that must be refused, never perform a write
      if (!want && ['teacher_tok', 'teacher_ses', 'assistant_scoped'].includes(caller)) {
        const r = W.post(JSON.parse(JSON.stringify(payload)));
        if (!(r.ok === false && r.error === 'Not authorized.')) bad.push(`${caller} [${v.c}/${v.s}/${v.g}/${v.p}] router answered ${JSON.stringify(r).slice(0, 120)} instead of Not authorized.`);
      }
      if (['student', 'anon', 'assistant_legacy'].includes(caller) && a.rule !== 'PUB' && !unwired.includes(a.action) && /^(admin_|p3_admin_|p4_admin_)/.test(a.action) && v === variants(a)[0]) {
        const r = W.post(JSON.parse(JSON.stringify(payload)));
        const okLegacy = caller === 'assistant_legacy' && P3.has(a.action);
        if (!okLegacy && r.ok !== false) bad.push(`${caller} reached ${a.action} and got ${JSON.stringify(r).slice(0, 100)}`);
      }
    });
  });
  t(`matrix ${a.action} (${a.rule})`, bad.length === 0, bad.slice(0, 4).join(' | ') + (bad.length > 4 ? ` (+${bad.length - 4} more)` : ''));
});
t(`grid size sanity: ${cells} cells evaluated`, cells > 1000, cells);

// router coverage: every case is in P4_ACTIONS or passes as PUB (not admin-ish)
const dpA = CODE.indexOf('function doPost('), dp = CODE.slice(dpA, CODE.indexOf('\n}\n', dpA));
const cases = [...new Set([...dp.matchAll(/^[ \t]*case "([^"]+)":/gm)].map(m => m[1]))];
const names = Object.keys(ctx.P4_ACTIONS || {});
const loose = cases.filter(c => /^(admin_|p3_admin_|p4_admin_)/.test(c) && !names.includes(c));
t('every admin-ish router case is in P4_ACTIONS (otherwise a teacher is denied by default, which is fine, but it must be listed)', loose.length === 0, loose.join(', '));
process.exit(fails ? 1 : 0);
