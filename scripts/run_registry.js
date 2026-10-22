#!/usr/bin/env node
// Runs docs/REGRESSION.md's registry (tools/quiz-maker-v2/tests/registry.json). Session 5.
//   node scripts/run_registry.js                 Node entries only (fast)
//   node scripts/run_registry.js --e2e           also the Playwright ones (need `pip install playwright`)
//   node scripts/run_registry.js --strict        release gate: pending / todo entries are NOT allowed
//   node scripts/run_registry.js --only R-003    one id (or a prefix like R-E)
//   node scripts/run_registry.js --list          print the registry and stop
// Status rules: active must pass. pending is EXPECTED to fail (XFAIL) until its session ships; when it
// passes (XPASS) the runner tells you to flip it to active. An entry with no command yet is TODO.
// Exit 0 = nothing wrong. --strict additionally fails on XFAIL, XPASS and TODO.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const site = path.resolve(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(site, 'tools/quiz-maker-v2/tests/registry.json'), 'utf8'));
const args = process.argv.slice(2), has = f => args.includes(f), val = f => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const only = val('--only'), strict = has('--strict'), e2e = has('--e2e');
const cwd = path.join(site, reg.cwd);
const py = (() => { for (const c of ['python3', 'python', 'py']) { const r = cp.spawnSync(c, ['--version']); if (!r.error && r.status === 0) return c; } return null; })();
const hasPw = py && cp.spawnSync(py, ['-c', 'import playwright']).status === 0;

if (has('--list')) { reg.entries.forEach(e => console.log(`${e.id.padEnd(7)} ${e.status.padEnd(8)} ${e.owner.padEnd(9)} ${e.cmd ? '' : '(no command yet) '}${e.title}`)); process.exit(0); }

const results = {};
const counts = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0, TODO: 0, SKIP: 0 }, bad = [];
const t0 = Date.now();
for (const e of reg.entries) {
  if (only && !(e.id === only || e.id.startsWith(only))) continue;
  let verdict, detail = '';
  if (e.status === 'retired') continue;
  if (e.same_run_as && results[e.same_run_as]) { const r0 = results[e.same_run_as]; verdict = r0.verdict === 'SKIP' ? 'SKIP' : (e.status === 'active' ? (r0.ok ? 'PASS' : 'FAIL') : (r0.ok ? 'XPASS' : 'XFAIL')); detail = 'same run as ' + e.same_run_as + ' ' + r0.detail; if (r0.verdict === 'SKIP') detail = r0.detail; }
  else if (!e.cmd) { verdict = 'TODO'; detail = e.expected_file ? 'expects ' + e.expected_file : ''; }
  else if (e.needs === 'playwright' && !(e2e && hasPw)) { verdict = 'SKIP'; detail = e2e ? 'playwright not installed' : 'use --e2e'; }
  else {
    const cmd = e.cmd[0] === 'python' ? py : e.cmd[0];
    if (!cmd) { verdict = 'SKIP'; detail = 'python not found'; }
    else {
      const r = cp.spawnSync(cmd, e.cmd.slice(1), { cwd, encoding: 'utf8', timeout: 300000 });
      const out = (r.stdout || '') + (r.stderr || '');
      const nf = (out.match(/^FAIL /gm) || []).length, np = (out.match(/^PASS /gm) || []).length;
      const ok = r.status === 0;
      detail = `${np} pass, ${nf} fail` + (r.error ? ' (' + r.error.message + ')' : '');
      verdict = e.status === 'active' ? (ok ? 'PASS' : 'FAIL') : (ok ? 'XPASS' : 'XFAIL');
      results[e.id] = { ok, detail };
      if (!ok && has('--verbose')) console.log(out.split('\n').filter(l => /^FAIL/.test(l)).join('\n'));
    }
  }
  if (!results[e.id]) results[e.id] = { ok: verdict === 'PASS' || verdict === 'XPASS', detail, verdict };
  counts[verdict]++;
  if (verdict === 'FAIL' || (strict && ['XFAIL', 'XPASS', 'TODO'].includes(verdict)) || verdict === 'XPASS') bad.push(e.id + ' ' + verdict);
  console.log(`${verdict.padEnd(6)} ${e.id.padEnd(7)} ${(e.status === 'pending' ? '[' + e.owner + '] ' : '') + e.title.slice(0, 70)}${detail ? '  (' + detail + ')' : ''}`);
}
console.log(`\n${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => v + ' ' + k).join(', ')}  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (counts.XPASS) console.log('XPASS: these now pass - set "status": "active" in tests/registry.json so they are protected.');
if (!strict && counts.TODO) console.log('TODO entries have no test yet; --strict (the release gate) refuses to ship with any.');
// XPASS is a failure of bookkeeping, not of code: it only blocks under --strict.
const exitBad = bad.filter(b => !/XPASS$/.test(b) || strict);
process.exit(exitBad.length ? (console.log('\nBLOCKING: ' + exitBad.join(', ')), 1) : 0);
