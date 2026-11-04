// For docs/attendance/screenshots/capture_dashboard.py: serves the site + the REAL AttendanceAll.gs (tests/attendance/gas_emulator.js)
// on 127.0.0.1:8767 with a little sample data (POST /api = att_dispatch_). Prints {"token": ...} for a signed-in teacher. Nothing touches the live system.
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = process.cwd();
const { build } = require(path.join(ROOT, "tests/attendance/gas_emulator.js"));
const gas = build(); gas.run("att_setup('SS1')");
const J = o => JSON.parse(JSON.stringify(o)), D = o => J(gas.ctx.att_dispatch_(o)), A = "adm-secret";
const u = D({ action: "att_user_create", token: A, name: "Dr Hossam" }), tok = D({ action: "att_login", password: u.password }).token;
const HERE = { lat: 31.2, lng: 29.9, acc: 10 };
const room = D({ action: "att_calibrate_room", token: tok, name: "Hall B", samples: [HERE] }).room.room_id;
const s = D({ action: "att_start_session", token: tok, course: "Web Programming", room_id: room });
const tk = () => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
[["20210101", "Mona Ali"], ["20210102", "Omar Hassan"], ["20210103", "Nour Samir"], ["20210104", "Youssef Adel"]].forEach(([id, n], i) => {
  const sec = String.fromCharCode(97 + i).repeat(16);
  D({ action: "att_signup", ticket: tk(), student_id: id, name: n, secret: sec, fp: "f" + i, geo: HERE });
  D({ action: "att_attend", ticket: tk(), student_id: id, secret: sec, fp: "f" + i, geo: HERE });
});
D({ action: "att_signup", ticket: tk(), student_id: "20210105", name: "Salma Kamal", secret: "z".repeat(16), fp: "fz", geo: HERE });
D({ action: "att_manual_checkin", token: tok, session_id: s.session_id, student_id: "20210105", reason: "PAGE_ERROR", note: "page froze on her phone" });
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png" };
http.createServer((req, res) => {
  if (req.method === "POST") { let b = ""; req.on("data", c => b += c); req.on("end", () => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(D(JSON.parse(b || "{}")))); }); return; }
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(d); });
}).listen(8767, "127.0.0.1", () => console.log(JSON.stringify({ token: tok })));
