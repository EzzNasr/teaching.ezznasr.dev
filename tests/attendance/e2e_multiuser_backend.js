// e2e stand-in for the deployed Apps Script web app: serves the site statically and answers POST /api with the REAL AttendanceAll.gs
// (Apps Script emulator). Used by e2e_multiuser.py.   node tests/attendance/e2e_multiuser_backend.js <site dir> <port>
const http = require("http"), fs = require("fs"), path = require("path");
const site = path.resolve(process.argv[2] || path.join(__dirname, "..", "..")), port = +(process.argv[3] || 8793);
const { build } = require("./gas_emulator.js");
const gas = build(); gas.run("att_setup('SS1')");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" };
http.createServer((q, r) => {
  if (q.method === "POST") { let b = ""; q.on("data", c => (b += c)); q.on("end", () => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify(gas.ctx.att_dispatch_(JSON.parse(b)))); }); return; }
  if (q.url === "/__sheet/AttFlagLog") { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify(gas.sheets.AttFlagLog._g)); }   // test-only peek at the flag log
  let f = path.join(site, decodeURIComponent(q.url.split("?")[0])); if (f.endsWith("/")) f += "index.html";
  if (!f.startsWith(site)) { r.statusCode = 403; return r.end("no"); }
  fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; return r.end("not found"); } r.setHeader("content-type", types[path.extname(f)] || "application/octet-stream"); r.end(d); });
}).listen(port, "127.0.0.1", () => console.log("up " + port));
