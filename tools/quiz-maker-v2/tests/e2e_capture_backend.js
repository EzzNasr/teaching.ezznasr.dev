// Local stand-in for the Apps Script web app for e2e_capture.py: the REAL Code.gs + Phase2_Capture.gs
// (with S5's four router lines applied in memory, see capture_router.js).
//   node tests/e2e_capture_backend.js apps_script/Code.gs apps_script/Phase2_Capture.gs 8765
const http = require('http');
const { load } = require('./harness');
const { buildCombined } = require('./capture_router');
const env = load(buildCombined(process.argv[2], process.argv[3]));
const port = +process.argv[4] || 8765;
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
      else if (req.url === '/__drive') out = { ok: true, files: env.drive.files.map(f => ({ id: f.id, name: f.name, trashed: f.trashed })) };
      else if (req.url === '/__sheet') {
        const ss = env.getSS('DATA'), alt = env.getSS('STU');
        const sh = ss.getSheetByName(p.name) || alt.getSheetByName(p.name);
        const rows = [];
        if (sh) for (let r = 1; r <= sh.getLastRow(); r++) { const row = []; for (let c = 1; c <= sh.getLastColumn(); c++) row.push(sh.get(r, c)); rows.push(row); }
        out = { ok: true, rows };
      }
      else out = env.post(p);
    } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
    res.writeHead(200, cors); res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log('ready'));
