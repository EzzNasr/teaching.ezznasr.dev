// Runs the REAL postToDrive text from each shipped file against a scripted fake server.
const fs = require('fs'), vm = require('vm');
const root = process.argv[2];
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };

function extract(file) {
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('  // Retries (same payload, same client_id) when the request never got a');
  const endmark = '        return data;\n      });\n  }\n';
  const b = s.indexOf(endmark, a) + endmark.length;
  return s.slice(a, b);
}

function sandbox(code, script) {
  const log = { fetches: 0, delays: [], bodies: [] };
  const ctx = {
    DRIVE_ENDPOINT: 'https://example.test/exec', Promise, JSON, Math, Error,
    setTimeout: (f, ms) => { log.delays.push(ms); setImmediate(f); },
    fetch: (url, opts) => {
      log.fetches++; log.bodies.push(opts.body);
      const step = script[Math.min(log.fetches - 1, script.length - 1)];
      if (step === 'net') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ text: () => Promise.resolve(step === 'html' ? '<html>oops</html>' : JSON.stringify(step)) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\nthis.postToDrive = postToDrive; this.RETRY_DELAYS = RETRY_DELAYS; this.BUSY_DELAYS = BUSY_DELAYS;', ctx);
  return { ctx, log };
}
const BUSY = { ok: false, retryable: true, error: 'The server is busy right now — please try again in a moment.' };
const OK = { ok: true };

const files = ['assets/quiz.js', 'assets/assign.js', 'tools/quiz-maker-v2/assets_templates/quiz.js', 'tools/quiz-maker-v2/assets_templates/assign.js'];
const blocks = files.map(f => extract(root + '/' + f));
t('all four shipped copies contain the identical postToDrive', blocks.every(b => b === blocks[0]));

(async () => {
  const code = blocks[0];
  let s, r;

  s = sandbox(code, [BUSY, BUSY, OK]); let busyCalls = 0;
  r = await s.ctx.postToDrive({ a: 1 }, () => busyCalls++);
  t('busy, busy, ok -> resolves ok', r && r.ok === true);
  t('...after exactly 3 requests carrying the same body', s.log.fetches === 3 && new Set(s.log.bodies).size === 1);
  t('...onBusy fired for each busy reply', busyCalls === 2, busyCalls);
  t('...waited ~2 s then ~5 s (each spread ±25%)', s.log.delays.length === 2 && s.log.delays[0] >= 1500 && s.log.delays[0] <= 2500 && s.log.delays[1] >= 3750 && s.log.delays[1] <= 6250, JSON.stringify(s.log.delays));

  s = sandbox(code, [BUSY]); busyCalls = 0;
  let err = null; try { await s.ctx.postToDrive({}, () => busyCalls++); } catch (e) { err = e; }
  t('busy forever -> gives up after 4 retries (5 requests) with the friendly text', err && /busy/i.test(err.message) && s.log.fetches === 5, err && err.message + ' fetches=' + s.log.fetches);
  t('...onBusy fired 4 times, delays follow 2/5/10/20 s', busyCalls === 4 && s.log.delays.length === 4 && [2000, 5000, 10000, 20000].every((d, i) => s.log.delays[i] >= d * 0.75 && s.log.delays[i] <= d * 1.25), JSON.stringify(s.log.delays));

  s = sandbox(code, [{ ok: false, error: 'Missing student_id' }]);
  err = null; try { await s.ctx.postToDrive({}); } catch (e) { err = e; }
  t('a normal {ok:false} is NOT retried', err && err.message === 'Missing student_id' && s.log.fetches === 1);

  s = sandbox(code, ['net', 'net', OK]);
  r = await s.ctx.postToDrive({});
  t('network failure twice then ok: unchanged 1.5 s / 4 s schedule', r.ok && s.log.fetches === 3 && s.log.delays[0] === 1500 && s.log.delays[1] === 4000, JSON.stringify(s.log.delays));
  s = sandbox(code, ['net']);
  err = null; try { await s.ctx.postToDrive({}); } catch (e) { err = e; }
  t('network down for good: 3 requests, then "Couldn\'t reach the server."', err && /reach/.test(err.message) && s.log.fetches === 3);

  s = sandbox(code, ['html', OK]);
  r = await s.ctx.postToDrive({});
  t('HTML reply still retried once', r.ok && s.log.fetches === 2);

  s = sandbox(code, [BUSY, 'net', BUSY, OK]);
  r = await s.ctx.postToDrive({}, () => { throw new Error('ui bug'); });
  t('mixed busy / network failures still resolve; a throwing onBusy is harmless', r.ok && s.log.fetches === 4);

  s = sandbox(code, [OK]); s.ctx.DRIVE_ENDPOINT = '';
  err = null; try { await s.ctx.postToDrive({}); } catch (e) { err = e; }
  t('no endpoint configured -> "not-configured" (unchanged)', err && err.message === 'not-configured' && s.log.fetches === 0);

  s = sandbox(code, [OK]);
  r = await s.ctx.postToDrive({});
  t('old one-argument call style still works', r.ok);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
