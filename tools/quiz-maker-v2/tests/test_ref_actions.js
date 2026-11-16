// R-REF-2: every backend action is accounted for (refactor guard, scripts/action_inventory.js).
//   1. Every routed action is named by at least one test. No exceptions.
//   2. Actions named ONLY by the authorization list tests (no behaviour test yet) are listed in
//      tests/fixtures/action_baseline.json "authz_only". The list may only shrink: a new action needs a behaviour test.
//   3. Every name in P4_ACTIONS, P3_STAFF_ALLOW and P4_ASSISTANT_DENY is a real routed action (no stale or misspelt rows).
//   4. Routed actions that teachers can never call (absent from P4_ACTIONS) are listed in "not_in_p4_actions". A new
//      action must be either added to P4_ACTIONS or to that list on purpose: teacher access is always a decision.
// To record a deliberate change, edit tests/fixtures/action_baseline.json in the same commit as the code.
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const { inventory, loadBackend } = require(path.join(ROOT, 'scripts', 'action_inventory.js'));
const base = require('./fixtures/action_baseline.json');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  -> ' + String(extra).slice(0, 800) : '')); }
};
const diff = (a, b) => a.filter(x => b.indexOf(x) === -1);

const ctx = loadBackend();
const inv = inventory(ctx);
const routed = inv.actions.map(x => x.action);
const AUTHZ_LISTS = base.authz_list_files;

// The three routers were all read (a parse failure would make every later check pass vacuously).
['router', 'followup', 'attendance'].forEach(r => {
  const n = inv.actions.filter(x => x.router === r).length;
  check('actions found in the ' + r + ' router (' + n + ')', n >= base.min_per_router[r], n);
});
check('total routed actions did not drop below the baseline (' + routed.length + ')', routed.length >= base.min_total, routed.length);

// 1
check('every routed action is named by at least one test', inv.untested.length === 0, inv.untested.join(', '));

// 2
const authzOnly = inv.actions.filter(x => x.tests.length && x.tests.every(t => AUTHZ_LISTS.indexOf(t) !== -1)).map(x => x.action);
check('no NEW action is tested only by the authorization lists', diff(authzOnly, base.authz_only).length === 0, diff(authzOnly, base.authz_only).join(', '));
check('the authz_only baseline lists nothing that now has a behaviour test (remove it from the list)', diff(base.authz_only, authzOnly).length === 0, diff(base.authz_only, authzOnly).join(', '));

// 3
const p4 = Object.keys(ctx.P4_ACTIONS || {});
check('P4_ACTIONS was loaded', p4.length > 50, p4.length);
check('every P4_ACTIONS row names a routed action', diff(p4, routed).length === 0, diff(p4, routed).join(', '));
check('every P3_STAFF_ALLOW entry names a routed action', diff(ctx.P3_STAFF_ALLOW || [], routed).length === 0, diff(ctx.P3_STAFF_ALLOW || [], routed).join(', '));
check('every P4_ASSISTANT_DENY entry names a routed action', diff(ctx.P4_ASSISTANT_DENY || [], routed).length === 0, diff(ctx.P4_ASSISTANT_DENY || [], routed).join(', '));

// 4
const notInP4 = routed.filter(a => a.indexOf('att_') !== 0 && p4.indexOf(a) === -1);
check('no new action is missing from P4_ACTIONS without being listed as teacher-denied', diff(notInP4, base.not_in_p4_actions).length === 0, diff(notInP4, base.not_in_p4_actions).join(', '));
check('the teacher-denied list has no stale entries', diff(base.not_in_p4_actions, notInP4).length === 0, diff(base.not_in_p4_actions, notInP4).join(', '));

console.log('\n' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
