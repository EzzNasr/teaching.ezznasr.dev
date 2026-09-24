// A tiny local stand-in for the Apps Script web app, running the REAL Code.gs
// through the test harness. Used by e2e_video.py (real browser tests).
//   node tests/e2e_backend.js apps_script/Code.gs 8765
const http = require('http');
const { load } = require('./harness');
const env = load(process.argv[2]);
const port = +process.argv[3] || 8765;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'text/plain' };

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let out;
    try {
      const p = JSON.parse(body || '{}');
      if (req.url === '/__prop') { if (p.value === null) delete env.props[p.key]; else env.props[p.key] = p.value; out = { ok: true }; }
      else if (req.url === '/__make_admin') {
        const sh = env.getSS('STU').getSheetByName('Students');
        let col = 0; for (let c = 1; c <= 12; c++) if (sh.get(1, c) === 'is_admin') col = c;
        for (let r = 2; r <= sh.getLastRow(); r++) if (String(sh.get(r, 1)).endsWith(String(p.phone).slice(-10))) sh.set(r, col, true);
        out = { ok: true };
      } else out = env.post(p);
    } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
    res.writeHead(200, cors); res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
