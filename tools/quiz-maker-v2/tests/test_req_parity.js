// S4 requirements: the server copy (Requirements.gs) and the client copy (assets/requirements-logic.js) must agree.
//   node tests/test_req_parity.js            (run from tools/quiz-maker-v2)
const fs = require('fs'), vm = require('vm'), path = require('path');
const L = require(path.join(__dirname, '..', '..', '..', 'assets', 'requirements-logic.js'));
const src = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Requirements.gs'), 'utf8');
const ctx = vm.createContext({});          // Requirements.gs only DEFINES things at load, so a bare context is enough
vm.runInContext(src, ctx, { filename: 'Requirements.gs' });
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x === undefined ? '' : JSON.stringify(x)))); };
const J = o => JSON.stringify(o);
const gs = (fn, ...a) => JSON.parse(J(ctx[fn](...a)));     // normalise cross-realm objects

t('built-in keys equal', J(gs('req_defaults_').map(d => d.key)) === J(L.BUILTIN_KEYS));
t('MAX_CUSTOM equal', ctx.REQ_MAX_CUSTOM === L.MAX_CUSTOM);
t('modes equal', J(ctx.REQ_MODES) === J(L.MODES));
t('defaults equal field by field', J(gs('req_defaults_')) === J(L.DEFAULTS));

const ROWS = [
  [],
  [{ key: 'watch', enabled: true, in_monthly_report: true, parent_message: true, weight: 1, rule: { pct: 70 }, edited: true }],
  [{ key: 'quiz', enabled: false, in_monthly_report: false, parent_message: false, weight: 3, rule: { min_pct: 60 }, edited: true }, { key: 'homework', label_ar: 'واجب', label_en: 'HW', enabled: true, edited: true }],
  [{ key: 'custom_b', label_en: 'B', sort: 2, enabled: true }, { key: 'custom_a', label_ar: 'أ', sort: 1, enabled: false, weight: 4 }, { key: 'watch', rule: { pct: 'x' }, weight: 99, edited: true }],
  [{ key: 'bogus', enabled: false }, { key: 'custom_Bad', label_en: 'x' }],
];
const OVS = [
  null, {},
  { watch: { mode: 'off' } },
  { watch: { mode: 'custom', rule: { pct: 50 } }, quiz: { mode: 'on' }, homework: { mode: 'custom', in_monthly_report: false } },
  { custom_a: { mode: 'on' }, custom_b: { mode: 'custom', in_monthly_report: false }, attendance: { mode: 'inherit' } },
  { quiz: { mode: 'custom', rule: { min_pct: 80 } }, written_answers: { mode: 'off' } },
];
let i = 0;
ROWS.forEach(rows => {
  const a = gs('req_normalizeCatalog_', rows), b = JSON.parse(J(L.normalizeCatalog(rows)));
  t('catalogue #' + (++i) + ' equal', J(a) === J(b), { server: a.map(x => x.key), client: b.map(x => x.key) });
  OVS.forEach((ov, j) => {
    const ea = gs('req_resolve_', a, ov), eb = JSON.parse(J(L.resolve(b, ov)));
    t('  effective #' + i + '.' + j + ' equal', J(ea) === J(eb), { ea, eb });
  });
});
const RULES = [['watch', { pct: 80 }], ['watch', {}], ['watch', { pct: 0 }], ['watch', { pct: 101 }], ['watch', { pct: '55' }], ['watch', { pct: 1.5 }], ['watch', { min_pct: 5 }],
  ['quiz', { min_pct: 70 }], ['quiz', {}], ['quiz', { pct: 70 }], ['homework', {}], ['homework', { pct: 1 }], ['attendance', null], ['quiz', [1]], ['quiz', 'x']];
RULES.forEach(([k, r]) => {
  const a = gs('req_validateRule_', k, r), b = JSON.parse(J(L.validateRule(k, r)));
  t('validateRule(' + k + ',' + J(r) + ') same verdict', a.ok === b.ok && (!a.ok || J(a.rule) === J(b.rule)), { a, b });
});
['custom_x', 'custom_', 'custom_Bad', 'watch', 'custom_' + 'a'.repeat(40), 'custom_' + 'a'.repeat(41)].forEach(k =>
  t('custom key shape "' + k.slice(0, 14) + '" same', ctx.req_isCustomKey_(k) === L.isCustomKey(k)));
[0, 1, 10, 10.5, -1, '1', NaN].forEach(w => t('weight ' + String(w) + ' same', ctx.req_validWeight_(w) === L.validWeight(w)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
