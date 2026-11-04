// node tests/attendance/late_grace.test.js : Nov 2026 production hardening (docs/attendance-decisions.md), on the emulated backend.
//  - late grace: a check-in from a ticket issued while the session was open still counts LATE_GRACE_SEC (120 s) after the ticket
//    expires / the session closes (by time or by the teacher); no NEW ticket after close; device requests get no grace
//  - the short critical section: inside the lock only rows added since the history read are checked, and duplicates are still caught
//    when another check-in lands in between, when the student's own row is far up the tab, and when rows were deleted meanwhile
//  - a sign-up retried after a lost answer is "already registered", never ID_TAKEN
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HERE = { lat: 31.2, lng: 29.9, acc: 10 };

function env() {
  const gas = build(); gas.run("att_setup('SS1')");
  const D = o => J(gas.ctx.att_dispatch_(o));
  const rm = D({ action: "att_calibrate_room", token: A, name: "H", samples: [HERE] });
  const s = D({ action: "att_start_session", token: A, course: "C1", room_id: rm.room.room_id });
  const nowSec = () => Math.floor(Date.now() / 1000);
  const tk = (expSec) => gas.run(`att_makeTicket_(${JSON.stringify(s.session_id)}, "", ${expSec == null ? nowSec() + 60 : expSec})`);
  const signup = (id, sec, t) => D({ action: "att_signup", ticket: t || tk(), student_id: id, name: "N " + id, secret: sec.repeat(16), fp: "f" + sec, geo: HERE });
  const attend = (id, sec, t, geo) => D({ action: "att_attend", ticket: t || tk(), student_id: id, secret: sec.repeat(16), fp: "f" + sec, geo: geo || HERE });
  const sesRow = () => gas.sheets.AttSessions._g.find(r => r[0] === s.session_id);
  const setTimes = (startMs, closeMs, status) => { const r = sesRow(); r[3] = new Date(startMs).toISOString(); r[4] = new Date(closeMs).toISOString(); if (status) r[5] = status; gas.run(`att_cdel_("att:s:${s.session_id}")`); };
  const rowsOf = id => gas.sheets.AttCheckins._g.filter(r => r[1] === s.session_id && r[2] === id).length;
  const tokenNow = () => gas.ctx.att_token_(s.session_key, s.session_id, Math.floor(Date.now() / 10000));
  return { gas, D, s, tk, nowSec, signup, attend, setTimes, rowsOf, tokenNow };
}

console.log("late grace: ticket");
{
  const E = env(); E.signup("20240001", "a"); E.signup("20240002", "b"); E.signup("20240003", "c");
  ok(E.gas.run("ATT_C.LATE_GRACE_SEC") === 120, "LATE_GRACE_SEC is 120");
  ok(E.attend("20240001", "a", E.tk(E.nowSec() - 60)).status === "recorded", "a ticket that expired 60 s ago still records the check-in");
  ok(E.attend("20240002", "b", E.tk(E.nowSec() - 125)).code === "TICKET_EXPIRED", "a ticket that expired 125 s ago is refused");
  ok(E.signup("20240009", "z", E.tk(E.nowSec() - 60)).status === "registered", "sign-up gets the same grace (the page chains sign-up -> attend)");
  ok(E.D({ action: "att_change_device", ticket: E.tk(E.nowSec() - 30), student_id: "20240003", new_secret: "y".repeat(16), fp: "fy" }).code === "TICKET_EXPIRED", "a device-change request gets NO grace");
  ok(E.gas.run(`att_checkTicket_(att_makeTicket_("S", "", 1000), null, 1000)`) === null && E.gas.run(`att_checkTicket_(att_makeTicket_("S", "", 1000), null, 1100, 120)`) !== null, "att_checkTicket_: no grace by default, grace only when asked");
}

console.log("late grace: session closed by time");
{
  const E = env(); ["1", "2", "3"].forEach(n => E.signup("2024000" + n, n));
  const t = E.tk();
  E.setTimes(Date.now() - 6 * 60000, Date.now() - 60000);   // 5-minute session that ended a minute ago
  ok(E.D({ action: "att_ticket", session_id: E.s.session_id, token: E.tokenNow() }).code === "SESSION_CLOSED", "no NEW ticket once the 5 minutes are over");
  ok(E.D({ action: "att_status", session_id: E.s.session_id }).status === "closed", "att_status says closed");
  ok(E.attend("20240001", "1", t).status === "recorded", "a check-in still retrying 60 s after the close is recorded");
  E.setTimes(Date.now() - 7 * 60000 - 5000, Date.now() - 2 * 60000 - 5000);
  ok(E.attend("20240002", "2", t).code === "SESSION_CLOSED", "125 s after the close it is refused (SESSION_CLOSED)");
}

console.log("late grace: session closed early by the teacher");
{
  const E = env(); E.signup("20240001", "a"); E.signup("20240002", "b");
  const t = E.tk();
  ok(E.D({ action: "att_close_session", token: A, session_id: E.s.session_id }).ok, "teacher closes the session");
  ok(E.D({ action: "att_ticket", session_id: E.s.session_id, token: E.tokenNow() }).code === "SESSION_CLOSED", "no new ticket after the teacher closed it");
  ok(E.attend("20240001", "a", t).status === "recorded", "a check-in already on its way when the teacher closed is still recorded");
  E.setTimes(Date.now() - 4 * 60000, Date.now() - 125000, "closed");
  ok(E.attend("20240002", "b", t).code === "SESSION_CLOSED", "125 s after the teacher's close it is refused");
}

console.log("short lock: duplicates are still caught");
{
  const E = env(); E.signup("20240001", "a");
  for (let i = 0; i < 35; i++) { E.signup(String(20250000 + i), "o" + i); }
  for (let i = 0; i < 5; i++) E.attend(String(20250000 + i), "o" + i);    // 5 other rows ABOVE the student's own
  ok(E.attend("20240001", "a").status === "recorded", "first check-in");
  for (let i = 5; i < 35; i++) E.attend(String(20250000 + i), "o" + i);   // the student's own row is now 30 rows up (beyond the 20-row margin)
  const again = E.attend("20240001", "a");
  ok(again.status === "recorded" && E.rowsOf("20240001") === 1, "a repeat with the row far up the tab: found, no second row");
  // rows deleted meanwhile (by hand): the remembered row number is stale -> full scan
  const g = E.gas.sheets.AttCheckins._g, before = g.length;
  const realLock = E.gas.ctx.LockService;
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => { g.splice(1, 1); return true; }, releaseLock() {} }) };   // delete one row above it while waiting for the lock
  const moved = E.attend("20240001", "a");
  E.gas.ctx.LockService = realLock;
  ok(moved.status === "recorded" && moved.server_utc === again.server_utc && E.rowsOf("20240001") === 1 && g.length === before - 1,
    "another row deleted above it while waiting for the lock: still found (full-scan fallback), no second row, same time");
}
{
  const E = env(); E.signup("20240001", "a");
  // The same student's other request (a double tap / an earlier retry) is appended by ANOTHER execution between this one's history read and its lock.
  const g = E.gas.sheets.AttCheckins._g, realLock = E.gas.ctx.LockService;
  let injected = false;
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => {
    if (!injected) { injected = true; g.push(["X-1", E.s.session_id, "20240001", "D-x", new Date().toISOString(), 31.2, 29.9, 10, 0, "fa", "", "ok", "", "", "", "", ""]); }
    return true; }, releaseLock() {} }) };
  const r = E.attend("20240001", "a");
  E.gas.ctx.LockService = realLock;
  ok(r.status === "recorded" && E.rowsOf("20240001") === 1, "a row added by a concurrent request after the history read is seen inside the lock: no duplicate");
  ok(E.attend("20240001", "a").status === "recorded" && E.rowsOf("20240001") === 1, "and a later repeat is a duplicate too");
}
{
  const E = env(); for (let i = 0; i < 25; i++) E.signup(String(20260000 + i), "s" + i);
  const all25 = Array.from({ length: 25 }, (_, i) => E.attend(String(20260000 + i), "s" + i).status === "recorded").every(Boolean);
  ok(all25 && E.gas.sheets.AttCheckins._g.length === 26, "25 students, 25 rows (+ header): nothing lost, nothing doubled");
  const busy = E.gas.ctx.LockService;
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock() {} }) };
  ok(E.attend("20260000", "s0").code === "BUSY", "lock not obtained -> BUSY (the page retries it)");
  E.gas.ctx.LockService = busy;
}

console.log("a flagged check-in takes the project lock only once (flag queue uses the user lock)");
{
  const E = env(); E.signup("20240001", "a");
  const real = E.gas.ctx.LockService, calls = { script: 0, user: 0 };
  E.gas.ctx.LockService = { getScriptLock: () => { calls.script++; return { tryLock: () => true, releaseLock() {} }; },
    getUserLock: () => { calls.user++; return { tryLock: () => true, releaseLock() {} }; } };
  const far = { lat: 31.3, lng: 30.0, acc: 10 };   // ~13 km away -> GEO_FAR, a real (review) flag -> queued for the Telegram digest
  const r = E.attend("20240001", "a", null, far);
  E.gas.ctx.LockService = real;
  ok(r.status === "recorded", "the far check-in is recorded");
  ok(calls.script === 1 && calls.user === 1, "script lock once (the check-in), user lock once (the flag queue): " + JSON.stringify(calls));
  const q = JSON.parse(E.gas.run('CacheService.getScriptCache().get(ATTT_QUEUE_KEY)') || "[]");
  ok(q.length === 1 && q[0].f.indexOf("GEO_FAR") >= 0, "the flag is in the digest queue");
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }), getUserLock: () => { throw new Error("no user lock here"); } };
  E.signup("20240002", "x");
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }), getUserLock: () => { throw new Error("no user lock here"); } };
  ok(E.attend("20240002", "x", null, far).status === "recorded", "no user lock available: a FLAGGED check-in is still recorded (best effort)");
  E.gas.ctx.LockService = real;
}

console.log("sign-up retry is idempotent");
{
  const E = env();
  ok(E.signup("20240001", "a").status === "registered", "sign-up");
  const r = E.signup("20240001", "a");
  ok(r.ok && r.status === "registered" && r.dup === true, "the same phone + the same ID again (lost answer) -> already registered");
  ok(E.gas.sheets.AttStudents._g.filter(x => x[0] === "20240001").length === 1 && E.gas.sheets.AttDevices._g.filter(x => x[1] === "20240001").length === 1, "...no second student or device row");
  ok(E.signup("20240001", "b").code === "ID_TAKEN", "ANOTHER phone with that ID -> still ID_TAKEN");
  ok(E.signup("20240002", "a").code === "DEVICE_BOUND_OTHER_ID", "this phone with ANOTHER ID -> still DEVICE_BOUND_OTHER_ID");
  // a different phone registers the same ID between this request's read and its lock
  const g = E.gas.sheets.AttStudents._g, realLock = E.gas.ctx.LockService;
  E.gas.ctx.LockService = { getScriptLock: () => ({ tryLock: () => { g.push(["20240077", "Other", "D-zz", new Date().toISOString(), "active"]); return true; }, releaseLock() {} }) };
  const race = E.signup("20240077", "c");
  E.gas.ctx.LockService = realLock;
  ok(race.code === "ID_TAKEN" && g.filter(x => x[0] === "20240077").length === 1, "an ID registered by another phone while waiting for the lock -> ID_TAKEN, not a second row");
}

console.log("\n" + pass + " late-grace / short-lock checks passed");
