// P4-S1: assets/math-render.js in a real DOM (jsdom) with the REAL vendored KaTeX served over http.
//   node tests/test_p4_s1_math.js            (run from tools/quiz-maker-v2; needs `npm i --no-save jsdom`, otherwise it SKIPs)
// What it proves: only \( \) and \[ \] are typeset; "$5" and plain text are untouched and never load KaTeX;
// missing KaTeX leaves the text exactly as written and throws nothing; Arabic + math keeps its order.
const fs = require('fs'), path = require('path'), http = require('http');
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (e) {
  console.log('SKIP all: jsdom is not installed (run: npm i --no-save jsdom). Nothing was checked.');
  process.exit(0);
}
const SITE = path.join(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(SITE, 'assets', 'math-render.js'), 'utf8');
const MIRROR = fs.readFileSync(path.join(SITE, 'tools', 'quiz-maker-v2', 'assets_templates', 'math-render.js'), 'utf8');
const VENDOR = path.join(SITE, 'assets', 'vendor', 'katex');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + (extra || ''))); };
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

function serve(root) {          // root = a folder to serve under /assets/vendor/katex/, or null for "everything is 404"
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace('/assets/vendor/katex/', '');
      const f = root && req.url.startsWith('/assets/vendor/katex/') ? path.join(root, rel) : null;
      if (f && f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
      } else { res.writeHead(404); res.end('no'); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function page(srv, body) {
  const port = srv.address().port;
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="r">' + body + '</div></body></html>',
    { url: 'http://127.0.0.1:' + port + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  dom.window.eval(SRC);
  dom.window.MathRender.base = 'http://127.0.0.1:' + port + '/assets/vendor/katex/';
  return dom.window;
}
const settle = (w, ms) => new Promise(res => { const to = setTimeout(() => res('timeout'), ms || 8000); w.MathRender.whenSettled(ok => { clearTimeout(to); res(ok); }); });
const scriptsAdded = w => w.document.head.querySelectorAll('script, link').length;

(async () => {
  t('the shipped asset and its assets_templates mirror are identical', SRC.replace(/\r\n/g, '\n') === MIRROR.replace(/\r\n/g, '\n'));
  const have = ['katex.min.js', 'katex.min.css', 'contrib/auto-render.min.js'].every(f => fs.existsSync(path.join(VENDOR, f)));
  t('vendored KaTeX files are present (otherwise see assets/vendor/katex/DROP-IN.md)', have);

  // 1. plain text and "$5": untouched, and KaTeX is never even requested --------------------------------------------------
  {
    const srv = await serve(VENDOR);
    const w = await page(srv, '<p id="a">Price is $5 and $10 \u2014 no math here.</p><p id="b">use \\\\ or (x) or [y] only</p>');
    const before = w.document.getElementById('r').innerHTML;
    w.MathRender.render(w.document.getElementById('r'));
    t('plain text and "$5" are untouched', w.document.getElementById('r').innerHTML === before);
    t('...and KaTeX is not requested for a page without math', w.MathRender._status() === 'idle' && scriptsAdded(w) === 0, w.MathRender._status() + ' ' + scriptsAdded(w));
    let threw = false; try { w.MathRender.render(null); w.MathRender.render(undefined); w.MathRender.render({}); } catch (e) { threw = true; }
    t('render(null / undefined / junk) throws nothing', !threw);
    w.close(); srv.close();
  }

  // 2. inline math, with the real KaTeX ----------------------------------------------------------------------------------
  if (have) {
    const srv = await serve(VENDOR);
    const w = await page(srv, '<p id="q">Simplify \\(\\frac12 + \\frac13\\) now. Cost $5.</p><code id="c">\\(x\\)</code>');
    const r = w.document.getElementById('r');
    w.MathRender.render(r);
    const ok = await settle(w);
    t('inline math: KaTeX loads lazily and typesets \\( \\)', ok === true && r.querySelectorAll('#q .katex').length === 1, String(ok));
    t('...the \\( \\) delimiters are gone from the page text', !/\\[()]/.test(r.querySelector('#q').textContent), r.querySelector('#q').textContent);
    t('...text around the equation is kept', /Simplify/.test(r.querySelector('#q').textContent) && /now\. Cost \$5\./.test(r.querySelector('#q').textContent));
    t('...<code> is left alone', r.querySelector('#c').textContent === '\\(x\\)' && !r.querySelector('#c .katex'));
    const html = r.innerHTML;
    w.MathRender.render(r);
    t('rendering the same element again changes nothing', r.innerHTML === html);
    t('both CSS and the two scripts were added to the page', w.document.head.querySelectorAll('link[rel=stylesheet]').length === 1 && w.document.head.querySelectorAll('script').length === 2);

    // 3. display math
    const d = w.document.createElement('div'); d.textContent = 'Solve \\[ x^2 = 4 \\] please'; r.appendChild(d);
    w.MathRender.render(d);
    t('display math \\[ \\] gets .katex-display', !!d.querySelector('.katex-display'));

    // 4. $ is not a delimiter, even next to real math
    const e = w.document.createElement('div'); e.textContent = '$x^2$ and $$y$$ but \\(z\\)'; r.appendChild(e);
    w.MathRender.render(e);
    t('"$x^2$" and "$$y$$" are NOT typeset, only \\( \\) is', e.querySelectorAll('.katex').length === 1 && /\$x\^2\$ and \$\$y\$\$/.test(e.textContent));

    // 5. broken TeX never throws
    const b = w.document.createElement('div'); b.textContent = 'bad \\(\\frac{\\) end'; r.appendChild(b);
    let threw = false; try { w.MathRender.render(b); } catch (x) { threw = true; }
    t('malformed TeX does not throw and the page keeps working', !threw && /bad/.test(b.textContent) && /end/.test(b.textContent));

    // 6. Arabic and math keep their order
    const a = w.document.createElement('p'); a.setAttribute('dir', 'rtl');
    a.textContent = '\u0627\u062d\u0633\u0628 \\(x^2\\) \u062b\u0645 \\(y\\) \u0627\u0644\u0646\u0647\u0627\u064a\u0629'; r.appendChild(a);
    w.MathRender.render(a);
    const kids = Array.from(a.childNodes).map(n => (n.nodeType === 3 ? 'T:' + n.nodeValue : 'M'));
    t('Arabic + math: text, math, text, math, text in the original order', kids.join('|') === 'T:\u0627\u062d\u0633\u0628 |M|T: \u062b\u0645 |M|T: \u0627\u0644\u0646\u0647\u0627\u064a\u0629', kids.join('|'));
    t('...the Arabic words are untouched', a.textContent.indexOf('\u0627\u062d\u0633\u0628') === 0 && /\u0627\u0644\u0646\u0647\u0627\u064a\u0629$/.test(a.textContent));
    w.close(); srv.close();
  }

  // 7. KaTeX missing: text stays exactly as written, nothing throws ------------------------------------------------------
  {
    const srv = await serve(null);
    const w = await page(srv, '<p id="q">Find \\(\\frac{a}{b}\\) and \\[ x \\] \u0645\u0631\u062d\u0628\u0627</p>');
    const r = w.document.getElementById('r');
    const before = r.innerHTML;
    let threw = false, ok;
    try { w.MathRender.render(r); ok = await settle(w); } catch (e) { threw = true; }
    t('KaTeX missing (404): nothing thrown', !threw);
    t('...settles as failed, text byte-for-byte unchanged', ok === false && r.innerHTML === before, String(ok));
    let again = false; try { w.MathRender.render(r); } catch (e) { again = true; }
    const n = scriptsAdded(w);
    w.MathRender.render(r);
    t('...later renders are quiet no-ops (no retry storm)', !again && scriptsAdded(w) === n && r.innerHTML === before);
    w.close(); srv.close();
  }

  // 8. quiz.js / assign.js load math-render.js on demand (no page template has to include it) ------------------------------
  if (have) {
    for (const f of ['assets/quiz.js', 'assets/assign.js']) {
      const s = fs.readFileSync(path.join(SITE, f), 'utf8').replace(/\r\n/g, '\n');
      const a = s.indexOf('  var mathLoad = null;'), b = s.indexOf('\n  }\n', s.indexOf('  function typeset(', a)) + 4;
      t(f + ': the on-demand typeset helper is present', a > 0 && b > a);
      for (const serveLoader of [true, false]) {
        const hits = [];
        const srv = await new Promise(resolve => {
          const sv = http.createServer((req, res) => {
            const u = decodeURIComponent(req.url.split('?')[0]); hits.push(u);
            let file = null;
            if (u === '/assets/math-render.js' && serveLoader) file = path.join(SITE, 'assets', 'math-render.js');
            else if (u.startsWith('/assets/vendor/katex/')) file = path.join(VENDOR, u.replace('/assets/vendor/katex/', ''));
            if (file && fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file)); }
            else { res.writeHead(404); res.end('no'); }
          });
          sv.listen(0, '127.0.0.1', () => resolve(sv));
        });
        const dom = new JSDOM('<!doctype html><html><head></head><body><div id="plain">Cost is $5, no math</div><div id="m1">A \\(\\frac{1}{2}\\) B</div><div id="m2">C \\[ x^2 \\]</div></body></html>',
          { url: 'http://127.0.0.1:' + srv.address().port + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
        const w = dom.window;
        w.eval(s.slice(a, b) + '\nwindow.__typeset = typeset;');
        const loaderHits = () => hits.filter(h => h === '/assets/math-render.js').length;
        const tag = f + (serveLoader ? '' : ' (math-render.js missing)') + ': ';
        let threw = false;
        try { w.__typeset(w.document.getElementById('plain')); w.__typeset(null); } catch (e) { threw = true; }
        await new Promise(r => setTimeout(r, 150));
        t(tag + 'text without math fetches nothing and throws nothing', !threw && hits.length === 0, JSON.stringify(hits));
        const m1 = w.document.getElementById('m1').innerHTML;
        try { w.__typeset(w.document.getElementById('m1')); w.__typeset(w.document.getElementById('m2')); } catch (e) { threw = true; }
        if (serveLoader) {
          for (let i = 0; i < 80 && !(w.document.querySelector('#m1 .katex') && w.document.querySelector('#m2 .katex-display')); i++) await new Promise(r => setTimeout(r, 100));
          t(tag + 'math text is typeset after the loader arrives (inline and display)', !!w.document.querySelector('#m1 .katex') && !!w.document.querySelector('#m2 .katex-display'));
          t(tag + 'math-render.js was requested exactly once for two math nodes', loaderHits() === 1, loaderHits());
        } else {
          await new Promise(r => setTimeout(r, 600));
          t(tag + 'loader 404: nothing thrown, text exactly as written', !threw && w.document.getElementById('m1').innerHTML === m1, threw);
          t(tag + '...and it is not retried for the second math node', loaderHits() === 1, loaderHits());
        }
        w.close(); srv.close();
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL unexpected error: ' + (e && e.stack || e)); process.exit(1); });
