// node tests/attendance/id_text.test.js : the 18 Nov 2026 incident (22 students, 46 refusals, docs/attendance/decisions.md D26), on the
// emulated backend whose sheets behave like Google Sheets: a row the plain-text format does not cover turns digit-only text into a
// number, so "0600925004" is stored as 600925004.
//  - reproduction: with the OLD write (appendRow), a student whose ID starts with 0 signs up, then is refused as "registered to another
//    student"; the flag log shows the same 9 digits on both sides (the zero is lost there too), exactly what the live sheet showed
//  - the fix: every write is plain text, so the same student checks in; the stored cells keep the zero, also past the formatted rows
//  - the repair: att_addLeadingZero / att_renameStudents give the lost zero back everywhere, then the student checks in again
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HALL = { lat: 31.2, lng: 29.9, acc: 10 };
const TABS = ["AttStudents", "AttDevices", "AttCheckins", "AttFlagLog", "AttRequests"];

function env() {
  const gas = build(); gas.run("att_setup('SS1')");
  gas.ctx.Logger = { log() {} };
  const D = o => J(gas.ctx.att_dispatch_(o));
  const room = D({ action: "att_calibrate_room", token: A, name: "Hall", samples: [HALL] }).room.room_id;
  const start = () => D({ action: "att_start_session", token: A, course: "Therapeutics " + Math.random(), room_id: room });
  const tk = s => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
  const sec = id => ("phone-" + id).padEnd(24, "x");
  const signup = (s, id) => D({ action: "att_signup", ticket: tk(s), student_id: id, name: "Student " + id, secret: sec(id), fp: "f" + id, geo: HALL });
  const attend = (s, id) => D({ action: "att_attend", ticket: tk(s), student_id: id, secret: sec(id), fp: "f" + id, geo: HALL });
  // What the live sheet looked like: new rows land where the setup's plain-text format does not reach (rows added after it ran).
  const unformatFutureRows = () => TABS.forEach(t => { gas.sheets[t]._ahead.clear(); });
  const cell = (t, id, col) => { const h = gas.run(`ATT_HEADERS.${t}`), c = h.indexOf(col || "student_id"); return gas.sheets[t]._g.slice(1).map(r => r[c]).filter(v => String(v).replace(/^0+/, "") === String(id).replace(/^0+/, "")); };
  return { gas, D, start, tk, signup, attend, unformatFutureRows, cell };
}
// The write the live backend used until D26.
const OLD_APPEND = 'att_append_ = function (name, obj) { att_sheet_(name).appendRow(ATT_HEADERS[name].map(function (k) { return obj[k] == null ? "" : obj[k]; })); };' +
  'att_logFlag_ = function (sessionId, studentId, code, detail) { att_append_("AttFlagLog", { ts_utc: att_iso_(), session_id: sessionId, student_id: studentId, code: code, detail: detail || "" }); };';

console.log("reproduction: the old write loses the leading zero");
{
  const E = env(); E.gas.run(OLD_APPEND); E.unformatFutureRows();
  const s = E.start();
  ok(E.signup(s, "0600925004").ok, "a student whose ID starts with 0 signs up: OK (as on 18 Nov)");
  ok(E.cell("AttDevices", "0600925004").every(v => v === 600925004), "...but the sheet stored the ID as the NUMBER 600925004 (zero gone)");
  const r = E.attend(s, "0600925004");
  ok(r.code === "DEVICE_ID_CONFLICT", "seconds later the check-in from the SAME phone is refused: 'registered to another student'");
  const log = E.gas.sheets.AttFlagLog._g.slice(1).find(x => x[3] === "DEVICE_ID_CONFLICT");
  ok(log && log[2] === 600925004 && /owner=600925004$/.test(log[4]), "flag log: the typed ID also lost its zero, so both sides read 600925004 (the mystery in the live sheet)");
  ok(E.D({ action: "att_live", token: A, session_id: s.session_id }).present === 0, "0 attended");
  ok(E.signup(s, "0600925013").ok && E.attend(s, "0600925013").code === "DEVICE_ID_CONFLICT" && E.signup(s, "600925099").ok && E.attend(s, "600925099").status === "recorded",
    "every ID with a leading 0 fails the same way; an ID without one is not affected");
}

console.log("the fix: every value is written as plain text (D26)");
{
  const E = env(); E.unformatFutureRows();
  const s = E.start();
  ok(E.signup(s, "0600925004").ok && E.attend(s, "0600925004").status === "recorded", "the same student, same unformatted rows: signs up AND checks in");
  ok(TABS.slice(0, 3).every(t => E.cell(t, "0600925004").length >= 1 && E.cell(t, "0600925004").every(v => v === "0600925004")), "students, phones and check-ins all keep \"0600925004\" as text");
  ok(E.D({ action: "att_live", token: A, session_id: s.session_id }).present === 1, "1 attended");
  E.attend(s, "0600925004");   // a duplicate: nothing new, but proves the stored row still matches
  ok(E.D({ action: "att_session_detail", token: A, session_id: s.session_id }).checkins.length === 1, "a repeat check-in finds the stored row (one row, no conflict)");
  const s2 = E.start();
  E.D({ action: "att_attend", ticket: E.tk(s2), student_id: "0600925777", secret: ("phone-0600925004").padEnd(24, "x"), fp: "f", geo: HALL });   // a real conflict, logged
  const log = E.gas.sheets.AttFlagLog._g.slice(1).find(x => x[3] === "DEVICE_ID_CONFLICT");
  ok(log && log[2] === "0600925777" && /owner=0600925004$/.test(log[4]), "the flag log keeps the zero too (written as text under its own lock)");
  E.D({ action: "att_review", token: A, checkin_id: E.D({ action: "att_flagged", token: A, session_id: s2.session_id }).rows[0].checkin_id, decision: "rejected", note: "007" });
  ok(E.gas.sheets.AttCheckins._g.slice(1).some(r => r[14] === "007"), "updated cells are text too (a note \"007\" stays \"007\")");
  // past the end of the sheet: new rows are inserted, and still written as text
  const sh = E.gas.sheets.AttStudents; sh._max = sh._g.length;
  ok(E.signup(E.start(), "0600925005").ok && E.cell("AttStudents", "0600925005")[0] === "0600925005" && sh.getMaxRows() > sh._g.length - 1, "a write past the last row of the tab inserts rows and still keeps the zero");
  const chk = E.gas.run("att_checkDevices()");
  ok(Object.keys(chk.numeric_id_cells).length === 5 && Object.values(chk.numeric_id_cells).every(n => n === 0), "att_checkDevices: no ID stored as a number in any of the 5 tabs");
}

console.log("the repair for the 22 students of 18 Nov");
{
  const E = env(); E.gas.run(OLD_APPEND); E.unformatFutureRows();
  const s = E.start(), ids = ["0600925004", "0600925013", "0600925021"];
  ids.forEach(id => { E.signup(s, id); E.attend(s, id); E.attend(s, id); });
  ok(E.D({ action: "att_live", token: A, session_id: s.session_id }).present === 0, "the damaged lecture: 3 students refused, 0 attended");
  // The live lecture ran before D22, when a refusal was only logged: remove the blocked rows the current code saved.
  const ck = E.gas.sheets.AttCheckins, st = E.gas.run("ATT_HEADERS.AttCheckins").indexOf("status");
  ck._g = [ck._g[0]].concat(ck._g.slice(1).filter(r => r[st] !== "blocked"));
  // Deploy the fixed backend into the SAME project: same sheet, same secrets, same open lecture (the fixed code is simply loaded again).
  E.gas.run(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "tools", "quiz-maker-v2", "apps_script", "AttendanceAll.gs"), "utf8"));
  E.gas.ctx.Logger = { log() {} };
  const E2 = E;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  E2.gas.ctx.Utilities.formatDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const dry = E2.gas.run(`att_addLeadingZero(${JSON.stringify(today)}, 9)`);
  ok(!dry.applied && Object.keys(dry.map).length === 3 && dry.map["600925004"] === "0600925004", "att_addLeadingZero(day, 9): lists the 3 IDs it would give a 0 back, writes nothing");
  ok(E2.gas.run(`att_addLeadingZero(${JSON.stringify(today)}, 9, true)`).applied, "with true: renamed");
  ok(TABS.every(t => E2.cell(t, "0600925004").every(v => v === "0600925004")), "the ID has its zero back in every tab, as text (students, phones, check-ins, requests, flag log)");
  const rec = E2.gas.run(`att_recoverRefused(${JSON.stringify(s.session_id)}, true)`);
  ok(rec.students.length === 3 && rec.students.every(x => ids.includes(x.student_id)), "att_recoverRefused then brings the 3 students into Needs review under their REAL IDs");
  ok(E2.D({ action: "att_review_bulk", token: A, session_id: s.session_id }).accepted === 3 && E2.D({ action: "att_live", token: A, session_id: s.session_id }).present === 3, "Accept all: the damaged lecture counts all 3 as present");
  const s2 = E2.start();
  ok(ids.every(id => E2.attend(s2, id).status === "recorded"), "the next lecture: every one of them checks in from their own phone");
  ok(E2.gas.run('att_renameStudents({"0600925013": "0600925004"})').refused === true, "renaming onto an ID that already exists is refused");
}

console.log("editor buttons: recover + accept the latest misfired lecture, then the ID repair (D26)");
{
  const E = env(); E.gas.run(OLD_APPEND); E.unformatFutureRows();
  const s = E.start(), ids = ["0600925004", "0600925013"];
  ids.forEach(id => { E.signup(s, id); E.attend(s, id); });
  const ck = E.gas.sheets.AttCheckins, st = E.gas.run("ATT_HEADERS.AttCheckins").indexOf("status");
  ck._g = [ck._g[0]].concat(ck._g.slice(1).filter(r => r[st] !== "blocked"));   // as on 18 Nov: refusals only logged
  E.gas.run(require("fs").readFileSync(require("path").join(__dirname, "..", "..", "tools", "quiz-maker-v2", "apps_script", "AttendanceAll.gs"), "utf8"));
  E.gas.ctx.Logger = { log() {} };
  E.gas.ctx.Utilities.formatDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const r = E.gas.run("att_recoverAndAcceptLatest()");
  ok(r && r.lecture.session_id === s.session_id && r.recovered === 2 && r.accepted === 2, "att_recoverAndAcceptLatest(): finds the misfired lecture, recovers and accepts both students");
  const L = E.D({ action: "att_live", token: A, session_id: s.session_id });
  ok(L.present === 2 && L.blocked === 0, "...they count as present in that lecture");
  ok(E.D({ action: "att_session_detail", token: A, session_id: s.session_id }).checkins.every(c => /system fault/.test(c.review_note) && c.reviewed_by === "ADMIN"), "...each row says why it was accepted, and by whom");
  const again = E.gas.run("att_recoverAndAcceptLatest()");
  ok(again.recovered === 0 && again.accepted === 0 && E.D({ action: "att_live", token: A, session_id: s.session_id }).present === 2, "running it twice changes nothing");
  const pv = E.gas.run("att_addLeadingZeroPreview()");
  ok(!pv.applied && Object.keys(pv.map).length === 2, "att_addLeadingZeroPreview(): lists the 2 IDs, writes nothing");
  ok(E.gas.run("att_addLeadingZeroApply()").applied && ids.every(id => E.cell("AttCheckins", id).every(v => v === id)), "att_addLeadingZeroApply(): the IDs get their 0 back, the accepted check-ins follow them");
  const s2 = E.start();
  ok(ids.every(id => E.attend(s2, id).status === "recorded"), "and the students check in normally afterwards");
}

console.log(`\n${pass} plain-text ID checks passed`);
