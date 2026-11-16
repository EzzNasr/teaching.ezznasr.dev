// node tests/attendance/extend_login.test.js : 2026-11-16 changes after the first demo (docs/attendance/decisions.md D15 to D18), on the emulated backend.
//  - D16: a QR token of the whole previous 10 s window is accepted (10 to 20 s to open the page), two windows back is not
//  - D15: "+2 minutes" (att_extend_session): owner or admin only, moves the close time, new scans and saves follow it, capped at 15 min
//  - D17: sign-in with teacher ID + password; wrong passwords pause THAT ID only, never every teacher
//  - D18: the nightly backup copies the sheet and keeps the newest 14
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HERE = { lat: 31.2, lng: 29.9, acc: 10 };

function env() {
  const gas = build(); gas.run("att_setup('SS1')");
  const D = o => J(gas.ctx.att_dispatch_(o));
  const mk = name => { const r = D({ action: "att_user_create", token: A, name }); const l = D({ action: "att_login", user_id: r.user.user_id, password: r.password }); return { id: r.user.user_id, pw: r.password, token: l.token, login: l }; };
  const T1 = mk("Dr One"), T2 = mk("Dr Two");
  const rm = D({ action: "att_calibrate_room", token: T1.token, name: "H", samples: [HERE] });
  const s = D({ action: "att_start_session", token: T1.token, course: "C1", room_id: rm.room.room_id });
  const row = () => gas.sheets.AttSessions._g.find(r => r[0] === s.session_id);
  const setTimes = (startMs, closeMs) => { const r = row(); r[3] = new Date(startMs).toISOString(); r[4] = new Date(closeMs).toISOString(); gas.run(`att_cdel_("att:s:${s.session_id}")`); };
  const token = back => gas.ctx.att_token_(s.session_key, s.session_id, Math.floor(Date.now() / 10000) - back);
  const ticket = back => D({ action: "att_ticket", session_id: s.session_id, token: token(back || 0) });
  return { gas, D, T1, T2, s, row, setTimes, token, ticket };
}

console.log("QR token: the previous window is accepted");
{
  const E = env();
  ok(E.ticket(0).ok, "the code on the screen right now works");
  ok(E.ticket(1).ok, "the code of the previous 10 s window still works (a phone that was slow to open the page)");
  ok(E.ticket(2).code === "TOKEN_EXPIRED", "a code two windows old is refused");
  ok(E.gas.run(`att_tokenOk_("k", "S", att_token_("k", "S", 100), 1019)`) === true && E.gas.run(`att_tokenOk_("k", "S", att_token_("k", "S", 100), 1020)`) === false, "a code lives until the END of the next window (at most 20 s), no longer");
  ok(E.ticket(-1).code === "TOKEN_EXPIRED", "a code from the future is refused");
}

console.log("+2 minutes");
{
  const E = env(), s = E.s, close0 = Date.parse(s.close_utc);
  ok(E.D({ action: "att_extend_session", session_id: s.session_id }).code === "UNAUTHORIZED", "needs a signed-in caller");
  ok(E.D({ action: "att_extend_session", token: E.T2.token, session_id: s.session_id }).code === "UNAUTHORIZED", "another teacher cannot add time to this lecture");
  const x = E.D({ action: "att_extend_session", token: E.T1.token, session_id: s.session_id });
  ok(x.ok && Date.parse(x.close_utc) === close0 + 120000 && x.can_extend === true, "the lecturer adds 2 minutes to the close time");
  ok(Date.parse(E.row()[4]) === close0 + 120000 && E.row()[5] === "open", "the sheet row carries the new close time and stays open");
  ok(Date.parse(E.D({ action: "att_status", session_id: s.session_id }).close_utc) === close0 + 120000, "att_status (what a student page asks) reports the new close time");
  const a = E.D({ action: "att_extend_session", token: A, session_id: s.session_id });
  ok(a.ok && Date.parse(a.close_utc) === close0 + 240000, "the admin can add time to any lecture");

  // The original 5 minutes are over, but the lecture was extended: new scans and saves still work.
  const now = Date.now();
  E.setTimes(now - 6 * 60000, now + 60000);
  const t = E.ticket();
  ok(t.ok && t.expires_at <= now + 61000, "a scan after the original 5 minutes gets a ticket that ends at the new close time");
  ok(E.D({ action: "att_signup", ticket: t.ticket, student_id: "20240001", name: "Late One", secret: "a".repeat(16), fp: "fa", geo: HERE }).ok &&
     E.D({ action: "att_attend", ticket: t.ticket, student_id: "20240001", secret: "a".repeat(16), fp: "fa", geo: HERE }).status === "recorded", "...and that student is recorded");

  // Time just ran out (inside the late grace): the lecturer can still bring the QR back.
  E.setTimes(now - 5 * 60000 - 30000, now - 30000);
  ok(E.ticket().code === "SESSION_CLOSED", "after the close time no new scan is accepted");
  const back = E.D({ action: "att_extend_session", token: E.T1.token, session_id: s.session_id });
  ok(back.ok && Math.abs(Date.parse(back.close_utc) - (Date.now() + 120000)) < 3000, "+2 minutes just after the time ran out counts from NOW");
  ok(E.ticket().ok, "...and scans work again");

  // Cap and dead sessions.
  E.setTimes(now - 14 * 60000, now + 30000);
  const cap = E.D({ action: "att_extend_session", token: E.T1.token, session_id: s.session_id });
  ok(cap.ok && Math.abs(Date.parse(cap.close_utc) - (now + 60000)) < 1500 && cap.can_extend === false, "the close time never passes 15 minutes after the start");
  ok(E.D({ action: "att_extend_session", token: E.T1.token, session_id: s.session_id }).code === "MAX_REACHED", "at the cap: MAX_REACHED");
  E.setTimes(now - 10 * 60000, now - 5 * 60000);
  ok(E.D({ action: "att_extend_session", token: E.T1.token, session_id: s.session_id }).code === "SESSION_CLOSED", "a lecture whose time ran out long ago cannot be reopened");
  const E2 = env();
  E2.D({ action: "att_close_session", token: E2.T1.token, session_id: E2.s.session_id });
  ok(E2.D({ action: "att_extend_session", token: E2.T1.token, session_id: E2.s.session_id }).code === "SESSION_CLOSED", "a lecture the teacher ended cannot be extended");
  ok(E2.ticket().code === "SESSION_CLOSED", "...and takes no new scans");
}

console.log("sign-in with teacher ID + password");
{
  const E = env(), D = E.D, T1 = E.T1, T2 = E.T2;
  ok(T1.login.ok && T1.login.user.user_id === T1.id && T1.login.user.role === "teacher", "ID + password signs the teacher in");
  ok(D({ action: "att_login", user_id: T1.id.toLowerCase().replace("-", ""), password: T1.pw.toLowerCase().replace(/-/g, "") }).ok, "the ID is forgiving: lower case, without the dash");
  ok(D({ action: "att_login", user_id: T1.id, password: T2.pw }).code === "BAD_PASSWORD", "another teacher's password does not open this ID");
  ok(D({ action: "att_login", user_id: "U-00000000", password: T1.pw }).code === "BAD_PASSWORD" && D({ action: "att_login", user_id: "nonsense", password: T1.pw }).code === "BAD_PASSWORD", "an unknown or malformed ID is refused with the same answer");
  for (let i = 0; i < 8; i++) D({ action: "att_login", user_id: T1.id, password: "NOPE-NOPE-NOPE-NOPE" + i });   // 8 here + the one above = 9
  ok(D({ action: "att_login", user_id: T1.id, password: T1.pw }).ok, "9 wrong passwords do not lock the ID, and a good sign-in clears the count");
  for (let i = 0; i < 10; i++) D({ action: "att_login", user_id: T1.id, password: "NOPE-NOPE-NOPE-NOPE" + i });
  const lk = D({ action: "att_login", user_id: T1.id, password: T1.pw });
  ok(lk.code === "LOCKED" && lk.retry_after_sec > 0, "10 wrong passwords pause THAT ID");
  ok(D({ action: "att_login", user_id: T2.id, password: T2.pw }).ok, "...while every other teacher still signs in");
  ok(D({ action: "att_me", token: T1.token }).ok, "...and the paused teacher's open dashboard keeps working");
  ok(D({ action: "att_me", token: A }).ok && !E.gas.run('att_cget_("att:lock")'), "the admin token and the old shared lock-out are untouched");
  for (let i = 0; i < 30; i++) D({ action: "att_login", user_id: "U-0000000" + (i % 10), password: "x".repeat(12) });
  ok(D({ action: "att_login", user_id: T2.id, password: T2.pw }).ok, "guessing at IDs that do not exist locks nobody");
  E.gas.advance(301000);
  ok(D({ action: "att_login", user_id: T1.id, password: T1.pw }).ok, "after 5 minutes the paused ID works again");
  D({ action: "att_user_update", token: A, user_id: T2.id, status: "disabled" });
  ok(D({ action: "att_login", user_id: T2.id, password: T2.pw }).code === "USER_DISABLED", "a disabled account cannot sign in");
  ok(D({ action: "att_login", password: T1.pw }).ok, "a dashboard page cached from before this change (password only) still signs in");
}

console.log("nightly backup");
{
  const E = env(), files = [], made = [];
  const file = name => ({ getName: () => name, trashed: false, setTrashed(v) { this.trashed = v; } });
  for (let d = 1; d <= 15; d++) files.push(file("Attendance backup 2026-11-" + String(d).padStart(2, "0") + " 0300"));
  files.push(file("My own notes"));
  const folder = { getFiles: () => { let i = 0; const live = files.filter(f => !f.trashed); return { hasNext: () => i < live.length, next: () => live[i++] }; } };
  E.gas.ctx.Utilities.formatDate = () => "2026-11-16 0300";
  E.gas.ctx.DriveApp = {
    getFoldersByName: n => ({ hasNext: () => n === "Attendance backups", next: () => folder }),
    createFolder: () => { throw new Error("the folder already exists"); },
    getFileById: id => ({ makeCopy: (name, into) => { made.push({ id, name, into }); files.push(file(name)); } }),
  };
  const msg = E.gas.run("att_backupNow()");
  ok(made.length === 1 && made[0].name === "Attendance backup 2026-11-16 0300" && made[0].into === folder && made[0].id === "SS1", "one dated copy of the attendance sheet goes into the backup folder");
  const kept = files.filter(f => !f.trashed).map(f => f.getName());
  ok(kept.filter(n => /^Attendance backup /.test(n)).length === 14 && kept.includes("Attendance backup 2026-11-16 0300") && !kept.includes("Attendance backup 2026-11-01 0300") && !kept.includes("Attendance backup 2026-11-02 0300"), "the newest 14 are kept, the oldest go to the bin");
  ok(kept.includes("My own notes"), "other files in the folder are never touched");
  ok(/kept 14, binned 2/.test(msg), "the log line says what happened: " + msg);
}

console.log("load test: the scan step (emulated HTTP)");
{
  const E = env(), logs = [];
  let expireNext = 0;   // makes the next N scans arrive with a code two windows old, like a phone far too slow to open the page
  const call = body => {
    const o = JSON.parse(body);
    if (o.action === "att_ticket" && expireNext > 0) { expireNext--; o.token = E.gas.ctx.att_token_(E.gas.ctx.att_sessionKey_(o.session_id), o.session_id, Math.floor(Date.now() / 10000) - 2); }
    return JSON.stringify(E.gas.ctx.att_dispatch_(o));
  };
  const resp = txt => ({ getContentText: () => txt, getResponseCode: () => 200 });
  E.gas.ctx.UrlFetchApp = { fetch: (_u, opt) => resp(call(opt.payload)), fetchAll: reqs => reqs.map(r => resp(call(r.payload))) };
  E.gas.ctx.Logger = { log: m => logs.push(String(m)) };
  const before = E.gas.sheets.AttCheckins._g.length;
  ok(E.gas.run("att_loadTest(12)") === true && /recorded 12\/12/.test(logs.join("\n")) && /QR expired on scan 0/.test(logs.join("\n")), "att_loadTest: every student scans the live QR code over HTTP first, then checks in: 12/12, no expired scans");
  ok(E.gas.sheets.AttCheckins._g.length === before + 12, "...12 check-in rows written");
  // att_cleanupTest between runs, as in the real procedure (two load tests started within 20 s would otherwise share one session: double-tap protection)
  E.gas.run("att_cleanupTest()"); logs.length = 0; expireNext = 3;
  ok(E.gas.run("att_loadTestFirstDay(8)") === true && /recorded 8\/8/.test(logs.join("\n")) && /QR expired on scan 3/.test(logs.join("\n")), "first-day run: 3 scans arrive too late, they are counted, those students scan again and everyone is recorded");
  ok(/"scanned":/.test(logs.join("\n")) && /"QR_EXPIRED":3/.test(logs.join("\n")), "each round's log line shows the scans and the expired ones");
  E.gas.run("att_cleanupTest()");
  ok(!E.gas.sheets.AttCheckins._g.some((r, i) => i > 0 && /^9998/.test(String(r[2]))), "att_cleanupTest removes the load-test rows");
}

console.log(`\n${pass} extend / login / backup checks passed`);
