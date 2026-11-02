// Phase 4 / S7: assets/draft-store.js (the Save model). Uses the small fake DOM next to this file (jsdom was not available).
const { makeDom, settle } = require('./test_p4_s7_fakedom');
let pass = 0, fail = 0;
const t = (n, c, x) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (x || ''))); };

function fresh(opts) {
  const dom = makeDom();
  dom.loadAsset('assets/draft-store.js');
  const sent = [];
  const D = dom.window.Draft;
  const send = opts && opts.send ? opts.send : (a, p) => { sent.push({ a, p }); return Promise.resolve({ ok: true }); };
  const saved = [];
  D.init({ page: 'p', user: 'u1', send: (a, p) => { const r = send(a, p); if (!(opts && opts.send)) return r; sent.push({ a, p }); return r; }, afterSave: r => saved.push(r) });
  return { dom, D, sent, saved, win: dom.window };
}
const stage = (D, id, extra) => D.stage(Object.assign({ id, label: 'L ' + id, action: 'act_' + id, payload: { v: id } }, extra || {}));
const bar = dom => dom.document.getElementById('p4-draft-bar');
const text = n => n.textContent;

(async function main() {
  // ---- stage, count, nothing sent
  { const { dom, D, sent } = fresh();
    for (let i = 1; i <= 5; i++) stage(D, 'e' + i);
    t('stage: five edits staged, count 5, dirty', D.count() === 5 && D.dirty() && D.has('e3'));
    await settle();
    t('stage: nothing is sent until Save', sent.length === 0);
    t('bar: visible, a role=status region, shows "Save (5)"', bar(dom).getAttribute('role') === 'status' && bar(dom).classList.contains('is-on') && /Save \(5\)/.test(text(bar(dom))), text(bar(dom)));
    t('bar: Save and Discard are buttons', dom.document.getElementById('p4-draft-save').tagName === 'BUTTON' && dom.document.getElementById('p4-draft-discard').tagName === 'BUTTON'); }

  // ---- replace by id, discard
  { const { D } = fresh();
    stage(D, 'a'); D.stage({ id: 'a', label: 'new', action: 'act_a', payload: { v: 'second' } }); stage(D, 'b');
    t('replace: the same id replaces the earlier op in place (count 2, newest payload, same position)', D.count() === 2 && D.get('a').payload.v === 'second' && D.ops()[0].id === 'a');
    D.discard('a'); t('discard: removes one op', D.count() === 1 && !D.has('a'));
    D.discardAll(); t('discardAll: empties everything', D.count() === 0 && !D.dirty()); }

  // ---- beforeunload only while dirty
  { const { win, D } = fresh();
    const fire = () => { const e = new win.Event('beforeunload', { cancelable: true }); win.dispatchEvent(e); return e.defaultPrevented; };
    t('beforeunload: no warning when nothing is staged', fire() === false);
    stage(D, 'x'); t('beforeunload: warns while something is staged', fire() === true);
    D.discard('x'); t('beforeunload: stops warning after the last edit is gone', fire() === false); }

  // ---- sessionStorage mirror and restore
  { const { dom, D, win } = fresh();
    stage(D, 'r1'); stage(D, 'r2');
    const raw = win.sessionStorage.getItem('p4draft:p:u1');
    t('persist: mirrored in sessionStorage under p4draft:<page>:<user>, without functions', !!raw && JSON.parse(raw).length === 2 && !/onSaved/.test(raw));
    t('persist: localStorage is never used', win.localStorage.length === 0);
    D._reset();
    const sent = [], saved = [];
    D.init({ page: 'p', user: 'u1', send: (a, p) => { sent.push(a); return Promise.resolve({ ok: true }); }, afterSave: r => saved.push(r) });
    t('restore: after a reload nothing is staged yet, there is an offer', D.count() === 0 && /Restore 2 unsaved changes/.test(text(dom.document.getElementById('p4-draft-restore'))) && bar(dom).classList.contains('is-on'));
    dom.document.getElementById('p4-draft-restore').click();
    t('restore: pressing it brings the edits back', D.count() === 2 && D.has('r1') && D.has('r2'));
    const res = await D.save();
    t('restore: restored edits save, and afterSave runs (they have no callbacks of their own)', res.every(r => r.ok) && sent.length === 2 && saved.length === 1 && D.count() === 0);
    t('restore: a clean save clears the mirror', win.sessionStorage.getItem('p4draft:p:u1') === null);
    D._reset(); stage(D, 'z'); D._reset();
    D.init({ page: 'p', user: 'someone-else', send: () => Promise.resolve({ ok: true }) });
    t('restore: another user does not get the offer', D.count() === 0 && !bar(dom).classList.contains('is-on')); }

  // ---- save in order, success removes
  { const { D, sent } = fresh();
    const seen = [];
    ['one', 'two', 'three'].forEach(n => stage(D, n, { onSaved: () => seen.push(n) }));
    const res = await D.save();
    t('save: sent one at a time in staging order', JSON.stringify(sent.map(s => s.a)) === JSON.stringify(['act_one', 'act_two', 'act_three']));
    t('save: each success removes its op and runs onSaved', D.count() === 0 && JSON.stringify(seen) === JSON.stringify(['one', 'two', 'three']) && res.length === 3);
    t('save: the action is not part of the payload; the payload is sent as a copy', sent[0].p.action === undefined && sent[0].p.v === 'one'); }

  // ---- partial failure
  { const calls = [];
    const { D, saved, dom } = fresh({ send: (a) => { calls.push(a); return Promise.resolve(a === 'act_two' ? { ok: false, error: 'Not authorized.' } : { ok: true }); } });
    const failed = [];
    stage(D, 'one'); stage(D, 'two', { onFailed: r => failed.push(r.error) }); stage(D, 'three');
    const res = await D.save();
    t('partial failure: the failed op stays staged, the others are saved', D.count() === 1 && D.has('two') && res.filter(r => r.ok).length === 2);
    t('partial failure: it carries on after a failure (three was still sent)', JSON.stringify(calls) === JSON.stringify(['act_one', 'act_two', 'act_three']));
    t('partial failure: onFailed receives the server answer, afterSave still runs once', failed.join() === 'Not authorized.' && saved.length === 1);
    t('partial failure: the bar says what happened', /1 change could not be saved/.test(text(bar(dom))), text(bar(dom))); }
  { const { D, dom } = fresh({ send: () => Promise.reject(new Error('offline')) });
    stage(D, 'a');
    const res = await D.save();
    t('network error: counts as a failure and stays staged', res[0].ok === false && res[0].resp.error === 'offline' && D.count() === 1);
    t('network error: the bar says the change could not be saved', /could not be saved/.test(text(bar(dom)))); }

  // ---- double press
  { const { D, sent } = fresh();
    stage(D, 'a'); stage(D, 'b');
    const p1 = D.save(), p2 = D.save();
    await Promise.all([p1, p2]);
    t('double press: the second Save is the same run (every op sent once)', p1 === p2 && sent.length === 2); }

  // ---- re-staging during a save keeps the newer edit
  { let release; const gate = new Promise(r => { release = r; });
    const sent = [];
    const { D } = fresh({ send: (a, p) => { sent.push(p.v); return sent.length === 1 ? gate.then(() => ({ ok: true })) : Promise.resolve({ ok: true }); } });
    stage(D, 'a');
    const run = D.save();
    D.stage({ id: 'a', label: 'again', action: 'act_a', payload: { v: 'newer' } });
    release(); await run;
    t('re-stage while saving: the newer edit is not lost', D.count() === 1 && D.get('a').payload.v === 'newer'); }

  // ---- a timer refresh pauses while dirty and never overwrites a staged field
  { const { D } = fresh();
    const field = { value: 'server-1' }; let refreshes = 0;
    const server = { v: 'server-1' };
    const timerRefresh = () => { if (D.pauseRefresh()) return; refreshes++; field.value = server.v; };
    stage(D, 'f', { payload: { v: 'staged' } }); field.value = 'staged'; server.v = 'server-2';
    timerRefresh(); timerRefresh();
    t('timer: refresh is skipped while edits are staged and the staged field is untouched', refreshes === 0 && field.value === 'staged' && D.pauseRefresh() === true);
    await D.save(); timerRefresh();
    t('timer: after Save the refresh runs again', refreshes === 1 && field.value === 'server-2' && D.pauseRefresh() === false); }
  { let release; const gate = new Promise(r => { release = r; });
    const { D } = fresh({ send: () => gate.then(() => ({ ok: true })) });
    stage(D, 'a'); const run = D.save();
    t('timer: refresh also pauses while a Save is running', D.pauseRefresh() === true);
    release(); await run; t('timer: and resumes after it', D.pauseRefresh() === false); }

  // ---- onChange reasons
  { const { D } = fresh(); const why = [];
    D.onChange((n, w) => why.push(w + ':' + n));
    stage(D, 'a'); stage(D, 'b'); D.discard('a'); D.discardAll(); stage(D, 'c'); await D.save();
    t('onChange: reports stage, discard, discardAll and save with the new count', JSON.stringify(why) === JSON.stringify(['stage:1', 'stage:2', 'discard:1', 'discardAll:0', 'stage:1', 'save:0']), JSON.stringify(why)); }

  // ---- private mode / broken storage
  { const dom = makeDom(); dom.loadAsset('assets/draft-store.js');
    dom.window.sessionStorage.setItem = () => { throw new Error('quota'); };
    const D = dom.window.Draft; D.init({ page: 'p', user: 'u', send: () => Promise.resolve({ ok: true }) });
    let threw = false; try { stage(D, 'a'); } catch (e) { threw = true; }
    t('private mode: staging still works when sessionStorage throws', !threw && D.count() === 1 && (await D.save()).length === 1); }

  // ---- misuse
  { const { D } = fresh(); let threw = false;
    try { D.stage({ label: 'no id' }); } catch (e) { threw = true; }
    t('misuse: stage() without id or action throws, count unchanged', threw && D.count() === 0);
    const dom = makeDom(); dom.loadAsset('assets/draft-store.js');
    const D2 = dom.window.Draft; D2.init({ page: 'p', user: 'u' }); D2.stage({ id: 'a', action: 'x', payload: {} });
    let rejected = false; try { await D2.save(); } catch (e) { rejected = true; }
    t('misuse: Save without a send function rejects instead of losing the edits', rejected && D2.count() === 1); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
