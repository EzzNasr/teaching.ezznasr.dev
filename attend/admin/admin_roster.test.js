// Runs the REAL admin.js (mini fake DOM) against the REAL server code. ATT_SINGLE=1 node tests/admin_roster.test.js
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm"), nodeCrypto = require("crypto");
process.env.ATT_SINGLE = "1";
const { build } = require("./gas_emulator.js");
const site = path.join(__dirname, "..", "site"), adminDir = path.join(site, "attend/admin");
const gas = build(), D = o => gas.ctx.att_dispatch_(o), A = { token: "adm-secret" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };

// ---------- seed: 3 lectures on different days, 4 students ----------
gas.run("att_setup('SS1')");
const room = D({ action: "att_calibrate_room", ...A, name: "Hall", samples: [{ lat: 31.2, lng: 29.9, acc: 10 }] }).room.room_id;
const geo = { lat: 31.2, lng: 29.9, acc: 10 };
const students = [["10001", "Mona Ali"], ["10002", "Omar Hassan"], ["10003", "Nour Samir"], ["10004", "=cmd|calc"]];
function lecture(course, whenIso, attendees) {
  const s = D({ action: "att_start_session", ...A, course, room_id: room });
  const tk = () => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
  attendees.forEach(([id, name], i) => {
    const sec = (id + "x").repeat(8).slice(0, 64);
    D({ action: "att_signup", ticket: tk(), student_id: id, name, secret: sec, fp: "f" + id, geo });   // ID_TAKEN on later lectures is fine
    D({ action: "att_attend", ticket: tk(), student_id: id, secret: sec, fp: "f" + id, geo });
  });
  D({ action: "att_close_session", ...A, session_id: s.session_id });
  // move the lecture (and its check-ins) to a past day
  const S = gas.sheets.AttSessions._g, row = S.find(r => r[0] === s.session_id); row[3] = whenIso;
  gas.sheets.AttCheckins._g.forEach((r, i) => { if (i > 0 && r[1] === s.session_id) r[4] = whenIso.replace(/T\d\d:\d\d/, "T09:05"); });
  return s.session_id;
}
lecture("Computer Organization", "2026-10-11T09:00:00.000Z", [students[0], students[1], students[3]]);
lecture("Computer Organization", "2026-10-18T09:00:00.000Z", [students[0], students[3]]);
lecture("Math", "2026-10-19T07:00:00.000Z", [students[0], students[1]]);
D({ action: "att_signup", ticket: gas.ctx.att_makeTicket_("S", "", Math.floor(Date.now() / 1000) + 60), student_id: "10003", name: "Nour Samir", secret: "n".repeat(64), fp: "n", geo });   // registered, never attends

// ---------- mini DOM ----------
class El {
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.className = ""; this.hidden = false; this.value = ""; this.disabled = false; this.style = {}; this.attrs = {}; this._l = {}; this.onclick = null; this.onchange = null;
    this.classList = { toggle() {}, add() {}, remove() {} }; }
  set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map(c => c.textContent).join(""); }
  appendChild(c) { this.children.push(c); return c; } get firstChild() { return this.children[0] || null; } removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = v; } addEventListener(t, f) { this._l[t] = f; }
  click() { this.onclick && this.onclick(); } remove() {} focus() {}
}
const html = fs.readFileSync(path.join(adminDir, "index.html"), "utf8");
const byId = {}; [...html.matchAll(/id="([^"]+)"/g)].forEach(m => (byId[m[1]] = new El("x")));
const tabBtns = [...html.matchAll(/data-tab="(\w+)"/g)].map(m => { const e = new El("button"); e.attrs["data-tab"] = m[1]; return e; });
byId.rosLimit.value = "30"; byId.rosCourse.value = ""; byId.rosSearch.value = "";
const downloads = [], blobs = {};
const ctx = {
  console, Promise, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Uint8Array, Intl, TextEncoder, URLSearchParams,
  crypto: nodeCrypto.webcrypto, parseInt, isNaN, encodeURIComponent, decodeURIComponent, requestAnimationFrame: () => 0,
  location: { search: "", hash: "", protocol: "https:" }, navigator: {}, screen: {},
  sessionStorage: { _: { att_admin: "adm-secret" }, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = String(v); }, removeItem(k) { delete this._[k]; } },
  localStorage: { _: {}, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = String(v); } },
  Blob: class { constructor(p) { this.parts = p; } }, URL: { createObjectURL: b => { const u = "blob:" + Object.keys(blobs).length; blobs[u] = b; return u; }, revokeObjectURL() {} },
  document: { getElementById: id => byId[id], createElement: t => { const e = new El(t); if (t === "a") e.click = function () { downloads.push({ name: this.download, text: blobs[this.href].parts.join("") }); }; return e; },
    querySelectorAll: () => tabBtns, body: new El("body"), documentElement: new El("html"), addEventListener() {}, hidden: false },
  ATT_FETCH: async (_u, init) => ({ json: async () => JSON.parse(JSON.stringify(gas.ctx.att_dispatch_(JSON.parse(init.body)))) }),
};
ctx.window = ctx; ctx.window.addEventListener = () => {}; vm.createContext(ctx);
["contract/att_config.js", "contract/att_api.js", "attend/admin/token.js", "attend/admin/qr.js", "attend/admin/admin.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(site, f), "utf8"), ctx, { filename: f }));
const cells = tr => tr.children.map(c => c.textContent);
const rows = () => byId.rosTable.children[0] ? byId.rosTable.children[0].children : [];
const find = (id) => rows().slice(1).find(r => r.children[0].textContent.includes(id));

(async () => {
  for (let i = 0; i < 40 && byId.panel.hidden; i++) await sleep(25);
  ok(!byId.panel.hidden, "admin logs in with the saved token");
  tabBtns.find(b => b.attrs["data-tab"] === "roster").click();
  for (let i = 0; i < 60 && !rows().length; i++) await sleep(25);
  ok(!byId.rosTable.hidden && byId["t-roster"].hidden === false, "Roster tab opens and loads");
  const head = cells(rows()[0]);
  ok(head.length === 3 + 3, "header: Student, Present, %, + 3 lecture columns (" + head.length + ")");
  ok(/Sun 11 Oct/.test(head[3]) && /Sun 18 Oct/.test(head[4]) && /Mon 19 Oct/.test(head[5]), "lecture columns are dated, oldest to newest: " + head.slice(3).join(" | "));
  ok(/Computer Organization/.test(head[3]) && /Math/.test(head[5]), "each column shows its course");
  ok(rows().length - 1 === 4, "all 4 registered students listed (including the one who never attended)");
  const mona = cells(find("10001")), nour = cells(find("10003")), omar = cells(find("10002"));
  ok(/Mona Ali/.test(mona[0]) && /10001/.test(mona[0]), "row shows name AND ID: " + mona[0]);
  ok(mona[1] === "3 / 3" && mona[2] === "100%", "Mona present 3 / 3 = 100%");
  ok(mona.slice(3).every(c => /^12:05$|^10:00$/.test(c) || /\d\d:\d\d/.test(c)) && /12:05/.test(mona[3]), "present cells show the check-in time in Cairo time: " + mona.slice(3).join(","));
  ok(omar[1] === "2 / 3" && omar[3] !== "\u2013" && omar[4] === "\u2013" && omar[5] !== "\u2013", "Omar present on 11 Oct and 19 Oct, absent 18 Oct (dash)");
  ok(nour[1] === "0 / 3" && nour[2] === "0%" && nour.slice(3).every(c => c === "\u2013"), "Nour never attended: 0 / 3, all dashes");
  const names = rows().slice(1).map(r => r.children[0].children[0].textContent);
  ok(JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), "sorted by name: " + names.join(", "));

  byId.rosSearch.value = "omar"; byId.rosSearch._l.input(); await sleep(10);
  ok(rows().length - 1 === 1 && /Omar/.test(rows()[1].textContent), "search by name filters the list");
  byId.rosSearch.value = "10003"; byId.rosSearch._l.input(); await sleep(10);
  ok(rows().length - 1 === 1 && /Nour/.test(rows()[1].textContent), "search by ID filters the list");
  byId.rosSearch.value = ""; byId.rosSearch._l.input();

  byId.rosCourse.value = "Math"; byId.rosCourse.onchange();
  for (let i = 0; i < 60 && cells(rows()[0] || { children: [] }).length !== 4; i++) await sleep(25);
  ok(cells(rows()[0]).length === 4 && cells(find("10001"))[1] === "1 / 1", "course filter 'Math': one lecture column, Mona 1 / 1");
  ok(Array.from(byId.rosCourse.children).map(o => o.textContent).join("|") === "All courses|Computer Organization|Math", "course dropdown lists every course");
  byId.rosCourse.value = ""; byId.rosCourse.onchange();
  for (let i = 0; i < 60 && cells(rows()[0] || { children: [] }).length !== 6; i++) await sleep(25);

  byId.rosCsv.click();
  ok(downloads.length === 1 && /^roster_\d{4}-\d\d-\d\d\.csv$/.test(downloads[0].name), "CSV export downloads: " + downloads[0].name);
  const csv = downloads[0].text.replace(/^\ufeff/, "").split("\r\n");
  ok(csv[0].startsWith("student_id,name,present,total,percent,2026-10-11") && csv[0].includes("2026-10-19"), "CSV header has the lecture dates");
  ok(csv.some(l => l.startsWith("10001,Mona Ali,3,3,100,")) && csv.some(l => l.startsWith("10003,Nour Samir,0,3,0,,,")), "CSV rows: IDs, names, counts, times / blanks");
  ok(csv.some(l => l.includes("'=cmd|calc")) && !csv.some(l => /(^|,)=cmd/.test(l)), "CSV neutralises a name that starts with '=' (spreadsheet formula injection)");
  console.log("\n" + pass + " roster page checks passed"); process.exit(0);
})().catch(e => { console.error("\nFAIL:", e.message); process.exit(1); });
