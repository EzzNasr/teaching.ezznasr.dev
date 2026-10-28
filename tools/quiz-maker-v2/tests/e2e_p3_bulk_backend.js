// e2e stand-in backend for the Phase 3 bulk-access page test: the real Code.gs (+ Phase2) PLUS Phase3_BulkAccess.gs,
// with the three p3_admin_bulk_* actions routed by hand (the real router lines are pasted at assembly).
//   node tests/e2e_p3_bulk_backend.js apps_script/Code.gs apps_script/Phase3_BulkAccess.gs 8765
const http = require('http'), fs = require('fs'), vm = require('vm');
const { load } = require('./harness');
const env = load(process.argv[2]);
vm.runInContext(fs.readFileSync(process.argv[3], 'utf8'), env.ctx, { filename: 'Phase3_BulkAccess.gs' });
const port = +process.argv[4] || 8765;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'text/plain' };
const P3 = { p3_admin_bulk_preview: 1, p3_admin_bulk_grant: 1, p3_admin_bulk_revoke: 1 };
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
      } else if (P3[p.action]) {
        try { out = env.ctx[p.action](p); if (out.ok === undefined) out.ok = true; } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
      } else out = env.post(p);
    } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
    res.writeHead(200, cors); res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
