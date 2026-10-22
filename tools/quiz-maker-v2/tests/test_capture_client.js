// capture.js pure parts (no browser): size fitting and the upload queue.
//   node tests/test_capture_client.js assets_templates/capture.js
const cap = require(require('path').resolve(process.argv[2] || 'assets_templates/capture.js'));
let pass = 0, fail = 0;
const t = (n, c, e) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + (e || ''))); };
(async () => {
  const f = cap.fitSize;
  t('landscape 4000x3000 -> long edge 1600', JSON.stringify(f(4000, 3000, 1600)) === '{"w":1600,"h":1200}');
  t('portrait 3000x4000 -> 1200x1600', JSON.stringify(f(3000, 4000, 1600)) === '{"w":1200,"h":1600}');
  t('already small: untouched, never upscaled', JSON.stringify(f(800, 600, 1600)) === '{"w":800,"h":600}');
  t('exactly at the limit: untouched', JSON.stringify(f(1600, 900, 1600)) === '{"w":1600,"h":900}');
  t('extreme strip never rounds to 0', f(100000, 10, 1600).h >= 1);

  const mk = (n, status) => Array.from({ length: n }, (_, i) => ({ id: 'i' + i, status: status || 'local' }));
  let sent = [];
  let r = await cap.runUploads(mk(3), it => { sent.push(it.id); return Promise.resolve(); });
  t('all ok: sent in order, one at a time', r.ok && sent.join() === 'i0,i1,i2');

  let active = 0, maxActive = 0;
  await cap.runUploads(mk(3), () => { active++; maxActive = Math.max(maxActive, active); return new Promise(res => setTimeout(() => { active--; res(); }, 5)); });
  t('never more than one upload in flight (weak connections)', maxActive === 1, maxActive);

  const items = mk(3); sent = [];
  r = await cap.runUploads(items, it => { sent.push(it.id); return it.id === 'i1' ? Promise.reject(new Error('boom')) : Promise.resolve(); });
  t('a failure does not stop the others; reported with the first error', !r.ok && r.failed.length === 1 && r.error === 'boom' && sent.join() === 'i0,i1,i2');
  t('statuses: ok / failed / ok', items.map(i => i.status).join() === 'ok,failed,ok');

  sent = [];
  r = await cap.runUploads(items, it => { sent.push(it.id); return Promise.resolve(); });
  t('retry re-sends ONLY what failed', r.ok && sent.join() === 'i1', sent.join());

  r = await cap.runUploads(mk(2), () => { throw new Error('sync throw'); });
  t('a send() that throws synchronously is a failure, not a crash', !r.ok && r.failed.length === 2 && r.error === 'sync throw');
  r = await cap.runUploads([], () => Promise.resolve());
  t('nothing to send is ok', r.ok);
  let changes = 0; await cap.runUploads(mk(2), () => Promise.resolve(), () => { changes++; });
  t('onChange fires for UI refresh', changes >= 4, changes);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
