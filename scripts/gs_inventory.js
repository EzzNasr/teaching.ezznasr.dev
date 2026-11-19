#!/usr/bin/env node
// Backend inventory: the oracle for the refactor (refactoring plan, Phase 0 / 3.1).
//
// Lists every top-level function and var of the DEPLOYED Apps Script files (the *.gs files directly in
// tools/quiz-maker-v2/apps_script/, not chunks/) with a hash of its exact source text, and compares it with the
// committed snapshot tools/quiz-maker-v2/tests/fixtures/gs_inventory.json.
//
//   node scripts/gs_inventory.js            check (exit 1 on any difference)  -- registry R-REF-1
//   node scripts/gs_inventory.js --write    rewrite the snapshot after a deliberate backend change
//
// What a difference means:
//   missing   a function or var that existed is gone            -> lost in a move, or a deliberate delete
//   added     a new name                                       -> new code (record it with --write)
//   changed   same name, different source text                 -> a behaviour change (a pure move never does this)
//   duplicate the same name is declared at top level twice      -> Apps Script would silently keep only one
// A file move with identical text is NOT a difference (that is what a mechanical split looks like); it is listed
// as "moved" for information. So splitting Code.gs must end with: 0 missing, 0 added, 0 changed, 0 duplicate.
//
// Function text comes from V8 (Function.prototype.toString on the loaded script), so comments and spacing outside
// a function never count; inside one they do. Vars are recorded by kind and their initialiser's source line.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GS_DIR = path.join(ROOT, 'tools', 'quiz-maker-v2', 'apps_script');
const SNAP = path.join(ROOT, 'tools', 'quiz-maker-v2', 'tests', 'fixtures', 'gs_inventory.json');

function deployedFiles() {
  return fs.readdirSync(GS_DIR).filter(f => /\.gs$/.test(f)).sort().map(f => path.join(GS_DIR, f));
}

// Line endings are normalised: a Windows checkout has CRLF, CI has LF, and both must give the same hash.
const sha = s => crypto.createHash('sha256').update(String(s).replace(/\r\n?/g, '\n')).digest('hex').slice(0, 16);

// Static scan: top-level declarations (column 0), for duplicates and for which file a name lives in.
function scan(files) {
  const where = {};
  const dups = [];
  files.forEach(f => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line) || /^var\s+([A-Za-z_$][\w$]*)\b/.exec(line);
      if (!m) return;
      const kind = line.startsWith('var') ? 'var' : 'function';
      if (where[m[1]]) dups.push(m[1] + ' (' + where[m[1]].at + ' and ' + rel + ':' + (i + 1) + ')');
      else where[m[1]] = { kind, file: rel, at: rel + ':' + (i + 1), line: line.trim() };
    });
  });
  return { where, dups };
}

function build() {
  const files = deployedFiles();
  const { where, dups } = scan(files);
  // Load the real files the way the tests do, then read each function's source text from V8.
  const { load } = require(path.join(ROOT, 'tools', 'quiz-maker-v2', 'tests', 'harness.js'));
  const env = load(files, { clock: true });
  const items = {};
  Object.keys(where).sort().forEach(name => {
    const w = where[name];
    let text;
    if (w.kind === 'function') {
      const fn = env.ctx[name];
      text = typeof fn === 'function' ? Function.prototype.toString.call(fn) : 'NOT LOADED';
    } else {
      text = w.line;   // the declaration line; a var's value can depend on run time, its source cannot
    }
    items[name] = { kind: w.kind, file: w.file, hash: sha(text) };
  });
  return { files: files.map(f => path.relative(ROOT, f).replace(/\\/g, '/')), count: Object.keys(items).length, dups, items };
}

function compare(snap, now) {
  const out = { missing: [], added: [], changed: [], moved: [] };
  Object.keys(snap.items).forEach(n => {
    const a = snap.items[n], b = now.items[n];
    if (!b) out.missing.push(n);
    else if (a.hash !== b.hash || a.kind !== b.kind) out.changed.push(n);
    else if (a.file !== b.file) out.moved.push(n + ' (' + a.file + ' -> ' + b.file + ')');
  });
  Object.keys(now.items).forEach(n => { if (!snap.items[n]) out.added.push(n); });
  return out;
}

function main() {
  const now = build();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(SNAP), { recursive: true });
    const { dups, ...rest } = now;
    fs.writeFileSync(SNAP, JSON.stringify(rest, null, 1) + '\n');
    console.log('wrote ' + path.relative(ROOT, SNAP) + ': ' + now.count + ' names from ' + now.files.length + ' files');
    if (dups.length) { console.log('FAIL duplicate top-level names:\n  ' + dups.join('\n  ')); process.exit(1); }
    return;
  }
  if (!fs.existsSync(SNAP)) { console.log('FAIL no snapshot; run: node scripts/gs_inventory.js --write'); process.exit(1); }
  const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const d = compare(snap, now);
  let fail = 0;
  const report = (label, list, bad) => {
    if (!list.length) { if (bad) console.log('PASS no ' + label + ' names'); return; }
    console.log((bad ? 'FAIL ' : 'INFO ') + list.length + ' ' + label + ':\n  ' + list.slice(0, 60).join('\n  ') + (list.length > 60 ? '\n  ...' : ''));
    if (bad) fail++;
  };
  report('missing', d.missing, true);
  report('added', d.added, true);
  report('changed', d.changed, true);
  report('duplicate', now.dups, true);
  report('moved (same text, different file)', d.moved, false);
  if (fail) {
    console.log('\nThe deployed backend differs from tools/quiz-maker-v2/tests/fixtures/gs_inventory.json.');
    console.log('A pure move must show none of the above. If the change is deliberate, record it: node scripts/gs_inventory.js --write');
    process.exit(1);
  }
  console.log('PASS backend inventory matches the snapshot (' + now.count + ' names, ' + now.files.length + ' files)');
}

if (require.main === module) main();
module.exports = { build, compare };
