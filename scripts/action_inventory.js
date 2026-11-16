#!/usr/bin/env node
// Every action the backend answers, and which ones tests name (refactoring plan, Phase 0 / 0.3).
//
//   node scripts/action_inventory.js          print the actions, which tests name them, and the untested ones
//   node scripts/action_inventory.js --json   the same as JSON
//
// Sources of actions (the three routers):
//   1. Code.gs doPost: every `case "name":` inside doPost
//   2. FollowupRouter.gs fu2_routes_(): the merged route maps (read from the loaded backend, so it is exact)
//   3. AttendanceAll.gs att_dispatch_: the STUDENT / SCOPED / ADMIN_ONLY maps, plus att_login
// "Named by a test" = the action appears as a quoted string in a test file or test fixture. It is a static check:
// it proves a test sends or expects the action, not that every branch of it is covered.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GS_DIR = path.join(ROOT, 'tools', 'quiz-maker-v2', 'apps_script');
const TEST_DIRS = [
  path.join(ROOT, 'tools', 'quiz-maker-v2', 'tests'),
  path.join(ROOT, 'tests'),
];

function read(f) { return fs.readFileSync(f, 'utf8'); }

function routerActions() {
  const src = read(path.join(GS_DIR, 'Code.gs'));
  const start = src.indexOf('\nfunction doPost(');
  const end = src.indexOf('\nfunction ', start + 10);
  if (start < 0 || end < 0) throw new Error('doPost not found in Code.gs');
  const body = src.slice(start, end);
  const out = new Set();
  const re = /case\s+"([a-z0-9_]+)"\s*:/g;
  let m;
  while ((m = re.exec(body))) out.add(m[1]);
  return out;
}

function followupActions(ctx) {
  if (typeof ctx.fu2_routes_ !== 'function') throw new Error('fu2_routes_ not loaded');
  return new Set(Object.keys(ctx.fu2_routes_()));
}

function attendanceActions() {
  const src = read(path.join(GS_DIR, 'AttendanceAll.gs'));
  const start = src.indexOf('\nfunction att_dispatch_(');
  const end = src.indexOf('\nfunction ', start + 10);
  const body = src.slice(start, end);
  const out = new Set();
  ['STUDENT', 'SCOPED', 'ADMIN_ONLY'].forEach(name => {
    const m = new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\};').exec(body);
    if (!m) throw new Error('att_dispatch_: map ' + name + ' not found');
    m[1].replace(/\b(att_[a-z0-9_]+)\s*:/g, (_, a) => out.add(a));
  });
  if (/a === "att_login"/.test(body)) out.add('att_login');
  return out;
}

function loadBackend() {
  const { load } = require(path.join(ROOT, 'tools', 'quiz-maker-v2', 'tests', 'harness.js'));
  const files = fs.readdirSync(GS_DIR).filter(f => /\.gs$/.test(f)).sort().map(f => path.join(GS_DIR, f));
  return load(files, { clock: true }).ctx;
}

function testFiles() {
  const out = [];
  const walk = d => {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '_shots' && e.name !== 'node_modules') walk(p); }
      else if (/\.(js|py|json)$/.test(e.name) && e.name !== 'gs_inventory.json' && e.name !== 'action_baseline.json') out.push(p);
    });
  };
  TEST_DIRS.forEach(walk);
  return out;
}

function inventory(ctx) {
  ctx = ctx || loadBackend();
  const sources = { router: routerActions(), followup: followupActions(ctx), attendance: attendanceActions() };
  const all = new Map();
  Object.keys(sources).forEach(k => sources[k].forEach(a => all.set(a, k)));
  const texts = testFiles().map(f => ({ f: path.relative(ROOT, f).replace(/\\/g, '/'), s: read(f) }));
  const actions = [...all.keys()].sort().map(a => {
    const re = new RegExp('["\'`]' + a + '["\'`]');
    const by = texts.filter(t => re.test(t.s)).map(t => t.f);
    return { action: a, router: all.get(a), tests: by };
  });
  return { actions, untested: actions.filter(x => !x.tests.length).map(x => x.action) };
}

if (require.main === module) {
  const inv = inventory();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(inv, null, 1)); }
  else {
    inv.actions.forEach(x => console.log((x.tests.length ? String(x.tests.length).padStart(3) : '  -') + '  ' + x.router.padEnd(10) + ' ' + x.action));
    console.log('\n' + inv.actions.length + ' actions, ' + inv.untested.length + ' not named by any test');
  }
}
module.exports = { inventory, routerActions, attendanceActions, followupActions, loadBackend };
