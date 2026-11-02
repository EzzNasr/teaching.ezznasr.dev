// Tests for the pure flow core of assets/followup-walk.js (the sheet itself is covered by e2e_followup_walk.py).
//   node tests/test_followup_walk.js [repo-root]       (run from tools/quiz-maker-v2/; default root = ../..)
const path = require('path');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..'));
const W = require(path.join(root, 'assets', 'followup-walk.js'));
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e === undefined ? '' : (typeof e === 'string' ? e : JSON.stringify(e))))); };
const eq = (n, a, b) => t(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' expected ' + JSON.stringify(b));
const rows = n => Array.from({ length: n }, (_, i) => ({ key: '10000001' + String(i + 1).padStart(2, '0'), name: 'S' + (i + 1) }));

t('module surface', typeof W.open === 'function' && typeof W.createFlow === 'function' && Object.keys(W.KIND_TITLE).join() === 'parents_watch,parents_hw,attendance_none');
t('open() without a DOM throws a clear error', (() => { try { W.open({ rows: rows(1) }); return false; } catch (e) { return /browser/.test(e.message); } })());

let f = W.createFlow(rows(3));
eq('start: total / index / position', [f.total(), f.index(), f.position()], [3, 0, 1]);
eq('start: current is the first row, not finished', [f.current().name, f.finished()], ['S1', false]);
eq('next is refused before the WhatsApp link was used', [f.canNext(), f.next(), f.index()], [false, false, 0]);
f.act('1000000101');
eq('after act(): canNext, next advances, row marked sent', [f.canNext(), f.next(), f.index(), f.status('1000000101')], [true, true, 1, 'sent']);
eq('act() on another student does not unlock this one', [f.act('1000000103'), f.canNext()], [undefined, false]);
eq('skip works without act and marks skipped', [f.skip(), f.status('1000000102'), f.index()], [true, 'skipped', 2]);
eq('act() for a key that is not in the list is ignored', [f.act('nope'), f.acted('nope')], [undefined, false]);
f.next();                                                     // 3rd: acted earlier through act('1000000103')
eq('finished after the last row; position never exceeds total', [f.finished(), f.position(), f.current()], [true, 3, null]);
eq('result lists', f.result(), { sent: ['1000000101', '1000000103'], skipped: ['1000000102'] });
eq('next / skip after the end do nothing', [f.next(), f.skip(), f.index()], [false, false, 3]);

f = W.createFlow(rows(4)); f.act('1000000101'); f.next(); f.skip();      // 1 sent, 2 skipped, now on 3
eq('back goes to the previous student', [f.back(), f.current().name], [true, 'S2']);
eq('back keeps the earlier status until it is acted on again', [f.status('1000000102'), f.acted('1000000102')], ['skipped', false]);
f.act('1000000102'); f.next();
eq('a skipped student can be redone: now sent, no longer skipped', [f.result().sent, f.result().skipped], [['1000000101', '1000000102'], []]);
f.back(); f.back();
eq('back stops at the first student', [f.back(), f.index()], [false, 0]);
eq('going back to a student that was already sent keeps canNext true', [f.canNext(), f.acted('1000000101')], [true, true]);

f = W.createFlow(rows(5)); f.act('1000000101'); f.next(); f.skip();
eq('"done for now": students not reached are in neither list', f.result(), { sent: ['1000000101'], skipped: ['1000000102'] });

eq('empty rows: nothing to do, finished from the start', (() => { const e = W.createFlow([]); return [e.total(), e.finished(), e.current(), e.result()]; })(), [0, true, null, { sent: [], skipped: [] }]);
eq('undefined rows are fine', W.createFlow().total(), 0);
eq('rows without a key and repeated keys are dropped', W.createFlow([{ key: 'a' }, { name: 'no key' }, null, { key: 'a', name: 'dup' }, { key: 'b' }]).rows().map(r => r.key), ['a', 'b']);
eq('rows are not changed (a copy is returned)', (() => { const src = rows(2), fl = W.createFlow(src); fl.rows().pop(); return fl.total(); })(), 2);
eq('result order follows the list order, not the click order', (() => { const fl = W.createFlow(rows(3)); fl.act('1000000101'); fl.next(); fl.act('1000000102'); fl.next(); fl.back(); fl.back(); fl.act('1000000101'); return fl.result().sent; })(), ['1000000101', '1000000102']);
eq('opened WhatsApp on the current row, then "done for now": that row counts as sent', (() => { const fl = W.createFlow(rows(3)); fl.act('1000000101'); fl.next(); fl.act('1000000102'); return fl.result(); })(), { sent: ['1000000101', '1000000102'], skipped: [] });
eq('a row opened after being skipped (skip, back, open) is sent, not skipped', (() => { const fl = W.createFlow(rows(2)); fl.skip(); fl.back(); fl.act('1000000101'); return fl.result(); })(), { sent: ['1000000101'], skipped: [] });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
