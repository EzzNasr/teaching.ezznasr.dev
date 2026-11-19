// R-REF-1: the deployed backend matches its inventory snapshot (the refactor oracle, scripts/gs_inventory.js).
// Fails when a top-level function or var is lost, added, changed or declared twice. A pure file move passes.
// After a deliberate backend change: node scripts/gs_inventory.js --write, and commit the snapshot with the change.
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { build, compare } = require(path.join(ROOT, 'scripts', 'gs_inventory.js'));
const snap = require('./fixtures/gs_inventory.json');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  -> ' + String(extra).slice(0, 600) : '')); }
};

// 1. The checker itself classifies correctly (so a green result means something).
const base = { items: { a: { kind: 'function', file: 'x.gs', hash: '1' }, b: { kind: 'function', file: 'x.gs', hash: '2' }, c: { kind: 'var', file: 'x.gs', hash: '3' } } };
const moved = compare(base, { items: { a: { kind: 'function', file: 'y.gs', hash: '1' }, b: base.items.b, c: base.items.c } });
check('a moved function with the same text is not a difference', !moved.missing.length && !moved.added.length && !moved.changed.length && moved.moved.length === 1);
const lost = compare(base, { items: { a: base.items.a, c: base.items.c } });
check('a lost function is reported as missing', lost.missing.join() === 'b');
const edited = compare(base, { items: { a: base.items.a, b: { kind: 'function', file: 'x.gs', hash: '9' }, c: base.items.c } });
check('an edited function is reported as changed', edited.changed.join() === 'b');
const extra = compare(base, { items: Object.assign({ d: { kind: 'function', file: 'x.gs', hash: '4' } }, base.items) });
check('a new function is reported as added', extra.added.join() === 'd');

// 2. The real backend against the committed snapshot.
const now = build();
const d = compare(snap, now);
// The file count may grow (splitting Code.gs adds files); it must never fall below the 8 files deployed today.
check('every deployed .gs file was read', now.files.length >= 8, now.files.join(', '));
check('no top-level name is declared twice', now.dups.length === 0, now.dups.join('; '));
check('every function in the snapshot still exists', d.missing.length === 0, d.missing.join(', '));
check('no function was changed without updating the snapshot', d.changed.length === 0, d.changed.join(', '));
check('no new top-level name without updating the snapshot', d.added.length === 0, d.added.join(', '));
check('every top-level function loaded in the emulator', !Object.keys(now.items).some(n => now.items[n].kind === 'function' && now.items[n].hash === snapHashOfNotLoaded()));
if (d.changed.length || d.added.length || d.missing.length) console.log('If this change is deliberate: node scripts/gs_inventory.js --write');

function snapHashOfNotLoaded() {
  return require('crypto').createHash('sha256').update('NOT LOADED').digest('hex').slice(0, 16);
}

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
