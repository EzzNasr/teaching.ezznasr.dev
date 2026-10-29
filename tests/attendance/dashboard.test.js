// node tests/attendance/dashboard.test.js
// Session 3 (MASTER_PLAN_ATTENDANCE_MULTIUSER, Phase 3): the REAL attend/admin/admin.js (mini fake DOM) against the REAL AttendanceAll.gs.
// Covers: one login box (password or admin token), role-aware tabs, teacher isolation in History, review (accept/reject),
// admin Users (create / reset / disable, password shown once), All sessions overview + drill-down.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm"), nodeCrypto = require("crypto");
const { build } = require("./gas_emulator.js");
const site = path.join(__dirname, "..", ".."), adminDir = path.join(site, "attend/admin");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const ADM = "adm-secret";

const gas = build(), D = o => J(gas.ctx.att_dispatch_(o));
gas.run("att_setup('SS1')");
const geo = { lat: 31.2, lng: 29.9, acc: 10 };
const tk = sid => gas.ctx.att_makeTicket_(sid, "", Math.floor(Date.now() / 1000) + 60);
const sec = c => c.repeat(8);
function teach(name) { const r = D({ action: "att_user_create", token: ADM, name }); const l = D({ action: "att_login", password: r.password }); return { id: r.user.user_id, pw: r.password, token: l.token, name }; }
function lecture(owner, course, students) {   // students: [id, name, geo]
  const room = D({ action: "att_calibrate_room", token: owner, name: "Hall-" + course, samples: [geo] }).room.room_id;
  const s = D({ action: "att_start_session", token: owner, course, room_id: room });
  students.forEach(([id, name, g], i) => {
    D({ action: "att_signup", ticket: tk(s.session_id), student_id: id, name, secret: sec(String.fromCharCode(97 + (Number(id) % 20))), fp: "f" + id, geo: g });
    D({ action: "att_attend", ticket: tk(s.session_id), student_id: id, secret: sec(String.fromCharCode(97 + (Number(id) % 20))), fp: "f" + id, geo: g });
  });
  D({ action: "att_close_session", token: owner, session_id: s.session_id });
  return s.session_id;
}
const T1 = teach("Dr Alpha"), T2 = teach("Dr Beta");
const sidA = lecture(T1.token, "Alpha Course", [["20001", "Mona Ali", geo], ["20002", "Omar Hassan", { denied: true, reason: "TIMEOUT" }], ["20003", "Nour Samir", { denied: true, reason: "USER_SKIPPED" }]]);
const sidB = lecture(T2.token, "Beta Course", [["20004", "Beta Student", geo], ["20005", "Beta Denied", { denied: true, reason: "PERMISSION_DENIED" }]]);
const sidLegacy = lecture(ADM, "Legacy Course", [["20006", "Legacy Kid", geo]]);

// ---------- mini DOM (same idea as admin_roster.test.js, one instance per "browser tab") ----------
class El {
  constructor(tag) { this.tag = tag; this.children = []; this._t = ""; this.className = ""; this.hidden = false; this.value = ""; this.disabled = false; this.checked = false; this.style = {}; this.attrs = {}; this._l = {}; this.onclick = null; this.onchange = null;
    this.classList = { toggle() {}, add() {}, remove() {} }; }
  set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map(c => c.textContent).join(""); }
  appendChild(c) { this.children.push(c); return c; } get firstChild() { return this.children[0] || null; } removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } setAttribute(k, v) { this.attrs[k] = v; } addEventListener(t, f) { this._l[t] = f; }
  click() { this.onclick && this.onclick(); } remove() {} focus() {}
}
const all = (el, pred, out = []) => { if (pred(el)) out.push(el); el.children.forEach(c => all(c, pred, out)); return out; };
const html = fs.readFileSync(path.join(adminDir, "index.html"), "utf8");
function ui(saved) {
  const byId = {}; [...html.matchAll(/id="([^"]+)"/g)].forEach(m => (byId[m[1]] = new El("x")));
  const tabBtns = [...html.matchAll(/<button\b([^>]*)data-tab="(\w+)"([^>]*)>/g)].map(m => { const e = new El("button"); e.attrs["data-tab"] = m[2]; if (/id="(\w+)"/.test(m[1] + m[3])) byId[/id="(\w+)"/.exec(m[1] + m[3])[1]] = e; return e; });
  [...html.matchAll(/<\w+[^>]*\bid="([^"]+)"[^>]*\bhidden\b/g)].forEach(m => (byId[m[1]].hidden = true));
  byId.rosLimit.value = "30"; byId.hisFrom.value = ""; byId.hisTo.value = ""; byId.hisUser.value = ""; byId.hisCourse.value = "";
  const downloads = [], blobs = {}, calls = [];
  const store = saved ? { att_admin: saved } : {};
  const ctx = {
    console, Promise, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, JSON, Math, Date, Object, Array, String, Number, Error, RegExp, Uint8Array, Intl, TextEncoder, URLSearchParams,
    crypto: nodeCrypto.webcrypto, parseInt, isNaN, encodeURIComponent, decodeURIComponent, requestAnimationFrame: () => 0,
    location: { search: "", hash: "", protocol: "https:" }, navigator: { clipboard: { writeText: t => { ctx.__copied = t; return Promise.resolve(); } } }, screen: {},
    sessionStorage: { _: store, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = String(v); }, removeItem(k) { delete this._[k]; } },
    localStorage: { _: {}, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = String(v); } },
    Blob: class { constructor(p) { this.parts = p; } }, URL: { createObjectURL: b => { const u = "blob:" + Object.keys(blobs).length; blobs[u] = b; return u; }, revokeObjectURL() {} },
    confirm: () => true, prompt: (_m, d) => "Renamed Teacher", alert() {},
    document: { getElementById: id => byId[id], createElement: t => { const e = new El(t); if (t === "a") e.click = function () { downloads.push({ name: this.download, text: blobs[this.href].parts.join("") }); }; return e; },
      querySelectorAll: () => tabBtns, body: new El("body"), documentElement: new El("html"), addEventListener() {}, hidden: false },
    ATT_FETCH: async (_u, init) => { const b = JSON.parse(init.body); calls.push(b.action); return { json: async () => J(gas.ctx.att_dispatch_(b)) }; },
  };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; vm.createContext(ctx);
  ["contract/att_config.js", "contract/att_api.js", "attend/admin/token.js", "attend/admin/qr.js", "attend/admin/admin.js"].forEach(f => vm.runInContext(fs.readFileSync(path.join(site, f), "utf8"), ctx, { filename: f }));
  const wait = async (c, n = 80) => { for (let i = 0; i < n && !c(); i++) await sleep(25); return c(); };
  const tab = n => tabBtns.find(b => b.attrs["data-tab"] === n).click();
  const type = async (v) => { byId.tok.value = v; byId.loginBtn.click(); };
  return { byId, ctx, calls, downloads, store, wait, tab, type, tabBtns };
}
const cells = tr => tr.children.map(c => c.textContent);
const rowsOf = box => (box.children[0] ? box.children[0].children : []).slice(1);
const btn = (row, label) => all(row, e => e.tag === "button" && e.textContent === label)[0];

(async () => {
  /* ───────── login box ───────── */
  console.log("login");
  {
    const u = ui(null);
    ok(u.byId.login.hidden === false || u.byId.login.hidden === true, "page boots");
    await u.wait(() => !u.byId.login.hidden);
    await u.type("WRONG-WRONG-WRONG-WRONG");
    await u.wait(() => /Wrong/.test(u.byId.loginMsg.textContent));
    ok(/Wrong password or token/.test(u.byId.loginMsg.textContent) && u.byId.panel.hidden && u.byId.loginBtn.disabled === false, "a wrong value shows one clear message and stays on the login page");
    ok(u.calls.join(",") === "att_me,att_login", "it is asked as a token first (att_me, never counted), then as a password: " + u.calls.join(","));
    const lf = gas.run('att_cget_("att:lf")');
    ok(lf && lf.n === 1, "only ONE failed attempt counts toward the global lock-out");
  }
  {
    const u = ui(null); await u.wait(() => !u.byId.login.hidden);
    const before = (gas.run('att_cget_("att:lf")') || {}).n || 0;
    await u.type(ADM); await u.wait(() => !u.byId.panel.hidden);
    ok(!u.byId.panel.hidden && u.calls.join(",").startsWith("att_me") && !u.calls.includes("att_login"), "the admin token logs in through att_me alone");
    ok(((gas.run('att_cget_("att:lf")') || {}).n || 0) === before, "pasting the admin token never counts as a failed password");
    ok(u.store.att_admin === ADM, "token kept in sessionStorage for reloads");
  }
  {
    const u = ui("stale-token-from-yesterday"); await u.wait(() => !u.byId.login.hidden);
    const before = (gas.run('att_cget_("att:lf")') || {}).n || 0;
    ok(!u.byId.login.hidden && u.byId.panel.hidden && u.store.att_admin === undefined, "a stale saved token returns to the login page and is forgotten");
    ok(!u.calls.includes("att_login") && ((gas.run('att_cget_("att:lf")') || {}).n || 0) === before, "a stale saved token is NEVER replayed as a password (no lock-out damage)");
  }

  /* ───────── teacher ───────── */
  console.log("teacher view");
  const t1 = ui(null); await t1.wait(() => !t1.byId.login.hidden);
  await t1.type(T1.pw); await t1.wait(() => !t1.byId.panel.hidden);
  ok(!t1.byId.panel.hidden && t1.calls.join(",").startsWith("att_me,att_login"), "teacher signs in with the generated password");
  ok(/Dr Alpha/.test(t1.byId.who.textContent) && /Teacher/.test(t1.byId.who.textContent), "header shows who is signed in and the role: " + t1.byId.who.textContent);
  ok(t1.byId.tabUsers.hidden && t1.byId.tabOverview.hidden && t1.byId.hisUserWrap.hidden, "Users, All sessions and the teacher filter are hidden for a teacher");
  t1.tab("users");
  ok(t1.byId["t-users"].hidden && !t1.byId["t-session"].hidden, "forcing the Users tab on a teacher falls back to Session (and sends no admin call)");
  ok(!t1.calls.includes("att_users"), "no att_users request was made");
  t1.tab("history"); await t1.wait(() => rowsOf(t1.byId.hisTable).length);
  let hrows = rowsOf(t1.byId.hisTable);
  ok(hrows.length === 1 && /Alpha Course/.test(hrows[0].textContent) && !/Beta|Legacy/.test(t1.byId.hisTable.textContent), "History lists ONLY this teacher's session (no Beta/Legacy)");
  const hc = cells(hrows[0]);
  ok(hc.includes("3") && /UNAVAILABLE 1/.test(hc.join("|")) && /SKIPPED 1/.test(hc.join("|")), "row shows present 3 and the location-problem counts: " + hc.join(" | "));
  btn(hrows[0], "Open").click(); await t1.wait(() => rowsOf(t1.byId.detTable).length);
  ok(!t1.byId.hisDetail.hidden && t1.byId.hisList.hidden, "Open switches to the session detail");
  let drows = rowsOf(t1.byId.detTable);
  ok(drows.length === 3 && /Alpha Course/.test(t1.byId.detTitle.textContent) && /Present 3/.test(t1.byId.detSummary.textContent), "detail lists all 3 check-ins with the summary");
  const omar = drows.find(r => /Omar/.test(r.textContent));
  ok(/GEO_UNAVAILABLE/.test(omar.textContent) && /TIMEOUT/.test(omar.textContent), "Omar's row shows flag GEO_UNAVAILABLE and the reason TIMEOUT");
  ok(/GEO_SKIPPED/.test(drows.find(r => /Nour/.test(r.textContent)).textContent), "Nour's row shows GEO_SKIPPED");
  t1.byId.detFlagOnly.checked = true; t1.byId.detFlagOnly._l.change();
  ok(rowsOf(t1.byId.detTable).length === 2, "'Flagged only' hides the clean check-in");
  t1.byId.detFlagOnly.checked = false; t1.byId.detFlagOnly._l.change();
  // reject Omar with a note
  const note = all(omar, e => e.tag === "input")[0]; note.value = "phone was off, saw him in class";
  btn(omar, "Reject").click();
  await t1.wait(() => /rejected/.test(rowsOf(t1.byId.detTable).find(r => /Omar/.test(r.textContent)).textContent));
  const serverRow = D({ action: "att_session_detail", token: T1.token, session_id: sidA }).checkins.find(c => c.student_id === "20002");
  ok(serverRow.review_status === "rejected" && serverRow.review_note === "phone was off, saw him in class" && serverRow.reviewed_by === T1.id, "Reject is stored on the server with the note and the reviewer");
  const omar2 = rowsOf(t1.byId.detTable).find(r => /Omar/.test(r.textContent));
  ok(/Dr Alpha/.test(omar2.textContent) && /phone was off/.test(omar2.textContent), "the row now shows the decision, the note and who decided");
  btn(omar2, "Accept").click();
  await t1.wait(() => /accepted/.test(rowsOf(t1.byId.detTable).find(r => /Omar/.test(r.textContent)).textContent));
  ok(D({ action: "att_session_detail", token: T1.token, session_id: sidA }).checkins.find(c => c.student_id === "20002").review_status === "accepted", "the decision can be changed (last one wins)");
  t1.byId.detCsv.click(); await t1.wait(() => t1.downloads.length);
  ok(t1.downloads.length === 1 && /20001/.test(t1.downloads[0].text) && !/20004/.test(t1.downloads[0].text) && /geo_reason/.test(t1.downloads[0].text), "detail CSV export has this session only, with geo_reason");
  t1.byId.hisBack.click();
  ok(!t1.byId.hisList.hidden && t1.byId.hisDetail.hidden, "Back returns to the list");
  // teacher B's session id is refused, and a refusal does NOT log the teacher out
  const foreign = D({ action: "att_session_detail", token: T1.token, session_id: sidB });
  ok(foreign.ok === false && foreign.code === "UNAUTHORIZED", "(server) teacher A cannot open teacher B's session");
  t1.ctx.document.getElementById("hisCourse").value = "Beta Course"; t1.byId.hisGo.click(); await sleep(150);
  ok(/No sessions match/.test(t1.byId.hisMsg.textContent) && !t1.byId.panel.hidden, "filtering for another teacher's course shows nothing and keeps the teacher signed in");
  t1.byId.hisCourse.value = "";
  // logout
  t1.byId.logout.click();
  ok(t1.byId.panel.hidden && !t1.byId.login.hidden, "log out returns to the login page");
  ok(t1.store.att_admin === undefined, "log out forgets the token");

  /* ───────── admin ───────── */
  console.log("admin view");
  const ad = ui(null); await ad.wait(() => !ad.byId.login.hidden);
  await ad.type(ADM); await ad.wait(() => !ad.byId.panel.hidden);
  ok(!ad.byId.tabUsers.hidden && !ad.byId.tabOverview.hidden && !ad.byId.hisUserWrap.hidden && /Admin/.test(ad.byId.who.textContent), "admin sees Users, All sessions and the teacher filter");
  ad.tab("history"); await ad.wait(() => rowsOf(ad.byId.hisTable).length >= 3);
  hrows = rowsOf(ad.byId.hisTable);
  ok(hrows.length === 3, "admin's History lists every teacher's sessions (3)");
  const heads = cells(ad.byId.hisTable.children[0].children[0]);
  ok(heads.includes("Teacher") && /Dr Alpha/.test(ad.byId.hisTable.textContent) && /Dr Beta/.test(ad.byId.hisTable.textContent) && /Admin/.test(ad.byId.hisTable.textContent), "with a Teacher column naming each owner (legacy = Admin)");
  const opts = ad.byId.hisUser.children.map(o => o.textContent);
  ok(opts.includes("Dr Alpha") && opts.includes("Dr Beta"), "teacher filter lists the accounts: " + opts.join(", "));
  // detail of someone else's session
  btn(hrows.find(r => /Beta Course/.test(r.textContent)), "Open").click(); await ad.wait(() => rowsOf(ad.byId.detTable).length);
  ok(rowsOf(ad.byId.detTable).length === 2 && /Dr Beta/.test(ad.byId.detTitle.textContent), "admin can open any teacher's session and sees the owner");

  // overview
  ad.tab("overview"); await ad.wait(() => ad.byId.ovTotals.children.length);
  const stats = ad.byId.ovTotals.children.slice(0, 4).map(c => c.children[0].textContent);
  ok(stats[0] === "3" && stats[1] === "6", "totals: 3 sessions, 6 present: " + stats.join(","));
  const urows = rowsOf(ad.byId.ovUsers);
  const alpha = urows.find(r => /Dr Alpha/.test(r.textContent)), beta = urows.find(r => /Dr Beta/.test(r.textContent));
  ok(urows.length >= 3 && cells(alpha)[1] === "1" && cells(alpha)[2] === "3" && cells(beta)[2] === "2", "per-teacher rows (sessions / present): Alpha 1/3, Beta 1/2");
  ok(/DENIED 1/.test(beta.textContent) && /UNAVAILABLE 1/.test(alpha.textContent), "per-teacher location-problem counts");
  btn(beta, "Sessions").click(); await ad.wait(() => !ad.byId["t-history"].hidden && rowsOf(ad.byId.hisTable).length === 1);
  ok(ad.byId.hisUser.value === T2.id && rowsOf(ad.byId.hisTable).length === 1 && /Beta Course/.test(rowsOf(ad.byId.hisTable)[0].textContent), "'Sessions' on a teacher drills into History filtered to that teacher");
  ad.tab("overview"); await ad.wait(() => rowsOf(ad.byId.ovDays).length);
  const day = rowsOf(ad.byId.ovDays)[0]; const dayStr = cells(day)[0];
  btn(day, "Sessions").click(); await ad.wait(() => ad.byId.hisFrom.value === dayStr && rowsOf(ad.byId.hisTable).length === 3);
  ok(ad.byId.hisFrom.value === dayStr && ad.byId.hisTo.value === dayStr && ad.byId.hisUser.value === "" && rowsOf(ad.byId.hisTable).length === 3, "'Sessions' on a day drills into History for that day (all 3 sessions ran today)");
  ad.byId.ovFrom.value = "2020-01-01"; ad.byId.ovTo.value = "2020-01-02"; ad.tab("overview"); ad.byId.ovGo.click();
  await ad.wait(() => ad.byId.ovTotals.children.length && ad.byId.ovTotals.children[0].children[0].textContent === "0");
  ok(ad.byId.ovTotals.children[0].children[0].textContent === "0", "date range with no sessions: totals are 0");
  ad.byId.ovFrom.value = ""; ad.byId.ovTo.value = "";

  // users
  ad.tab("users"); await ad.wait(() => rowsOf(ad.byId.userList).length >= 2);
  ok(rowsOf(ad.byId.userList).length === 2 && /Dr Alpha/.test(ad.byId.userList.textContent) && /never|\d{4}/.test(ad.byId.userList.textContent), "Users lists both teachers (with last login)");
  ok(!/pw_hash|[0-9a-f]{64}/.test(ad.byId.userList.textContent), "no password hash is ever shown");
  ad.byId.userName.value = "Dr Gamma"; ad.byId.userCreate.click();
  await ad.wait(() => !ad.byId.secret.hidden);
  const pw = ad.byId.secretPw.textContent;
  ok(!ad.byId.secret.hidden && /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(pw) && /Dr Gamma/.test(ad.byId.secretWho.textContent), "creating a teacher shows the generated password once: " + pw.replace(/./g, (c, i) => i < 5 ? c : "*"));
  ok(D({ action: "att_login", password: pw.toLowerCase().replace(/-/g, "") }).ok, "the shown password really logs the new teacher in");
  ad.byId.secretCopy.click(); await sleep(20);
  ok(ad.ctx.__copied === pw, "Copy puts the password on the clipboard");
  ad.byId.secretDone.click();
  ok(ad.byId.secret.hidden && ad.byId.secretPw.textContent === "", "'I saved it' hides and wipes the password from the page");
  await ad.wait(() => rowsOf(ad.byId.userList).length === 3);
  ok(rowsOf(ad.byId.userList).length === 3, "the list refreshes with the new teacher");
  // rename
  const gamma = () => rowsOf(ad.byId.userList).find(r => /Dr Gamma|Renamed Teacher/.test(r.textContent));
  btn(gamma(), "Rename").click(); await ad.wait(() => /Renamed Teacher/.test(ad.byId.userList.textContent));
  ok(/Renamed Teacher/.test(ad.byId.userList.textContent), "Rename works");
  // reset password: old one dies, new one shown
  const g = D({ action: "att_login", password: pw });
  btn(gamma(), "Reset password").click(); await ad.wait(() => !ad.byId.secret.hidden);
  const pw2 = ad.byId.secretPw.textContent;
  ok(pw2 !== pw && D({ action: "att_login", password: pw2 }).ok, "Reset password shows a NEW password once and it works");
  ok(D({ action: "att_me", token: g.token }).code === "UNAUTHORIZED", "the old session token of that teacher stops working");
  ad.byId.secretDone.click();
  // disable: that teacher's open dashboard is signed out on its next call
  const gu = ui(null); await gu.wait(() => !gu.byId.login.hidden);
  await gu.type(pw2); await gu.wait(() => !gu.byId.panel.hidden);
  ok(!gu.byId.panel.hidden, "the reset password signs the teacher in on the dashboard");
  btn(gamma(), "Disable").click(); await ad.wait(() => /disabled/.test(gamma().textContent));
  ok(/disabled/.test(gamma().textContent) && btn(gamma(), "Enable"), "Disable marks the account disabled and offers Enable");
  gas.advance(61000);   // the 60 s "still active?" cache
  gu.tab("history"); await gu.wait(() => !gu.byId.login.hidden);
  ok(!gu.byId.login.hidden && gu.byId.panel.hidden && /disabled/.test(gu.byId.loginMsg.textContent), "a disabled teacher is signed out on the next call with a clear message");
  await gu.type(pw2); await gu.wait(() => /disabled/.test(gu.byId.loginMsg.textContent));
  ok(gu.byId.panel.hidden, "and cannot sign in again");
  btn(gamma(), "Enable").click(); await ad.wait(() => !/disabled/.test(gamma().textContent.replace(/Disable|Enable/g, "")));
  ok(D({ action: "att_login", password: pw2 }).ok, "Enable lets them in again");

  // admin-only enforcement is server side
  ok(D({ action: "att_users", token: T1.token }).code === "FORBIDDEN" && D({ action: "att_overview", token: T1.token }).code === "FORBIDDEN" && D({ action: "att_user_create", token: T1.token, name: "x y" }).code === "FORBIDDEN", "(server) a teacher token is refused on users / overview / user-create with FORBIDDEN");
  const t1b = ui(T1.token); await t1b.wait(() => !t1b.byId.panel.hidden);
  ok(!t1b.byId.panel.hidden, "a teacher token saved in sessionStorage restores the session after a reload");

  // XSS: every string is rendered with textContent
  const evil = teach("<img src=x onerror=alert(1)>");
  ad.tab("users"); await ad.wait(() => /<img/.test(ad.byId.userList.textContent));
  ok(/<img src=x/.test(ad.byId.userList.textContent), "names are rendered as text (textContent), never as HTML");
  console.log("\n" + pass + " dashboard checks passed");
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
