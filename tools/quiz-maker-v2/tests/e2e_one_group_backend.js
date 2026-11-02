// Like e2e_backend.js but loads Code.gs + FollowupRouter.gs (follow-up v2) and adds /__dup (a legacy "student in two groups" row).
//   node tests/e2e_one_group_backend.js apps_script 8765
const http = require('http'), path = require('path');
const { load } = require('./harness');
const dir = process.argv[2] || 'apps_script';
const env = load([path.join(dir, 'Code.gs'), path.join(dir, 'FollowupRouter.gs')]);
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
      if (req.url === '/__make_admin') {
        const sh = env.getSS('STU').getSheetByName('Students');
        let col = 0; for (let c = 1; c <= 12; c++) if (sh.get(1, c) === 'is_admin') col = c;
        for (let r = 2; r <= sh.getLastRow(); r++) if (String(sh.get(r, 1)).endsWith(String(p.phone).slice(-10))) sh.set(r, col, true);
        out = { ok: true };
      } else if (req.url === '/__dup') {
        const sh = env.getSS('STU').getSheetByName('Groups'); const r = sh.getLastRow() + 1; const h = {};
        for (let c = 1; c <= 8; c++) if (sh.get(1, c)) h[sh.get(1, c)] = c;
        sh.set(r, h.group, p.group); sh.set(r, h.phone, p.phone); sh.set(r, h.name, ''); sh.set(r, h.added_at, '2026-01-01 00:00:00');
        out = { ok: true };
      } else out = env.post(p);
    } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
    res.writeHead(200, cors); res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
