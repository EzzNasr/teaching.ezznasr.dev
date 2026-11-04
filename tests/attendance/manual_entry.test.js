// node tests/attendance/manual_entry.test.js : manual entry from the instructor's dashboard (docs/attendance-decisions.md D9), on the emulated backend.
//  - att_manual_checkin marks a student present: stored as a normal check-in (device MANUAL, flags MANUAL, status ok, accepted by the teacher, reason)
//  - already present (by phone or by hand) -> nothing written; unregistered ID needs a name and creates a student without a device
//  - that student can later sign up on their own phone (first phone binds), and their own check-in does not overwrite the manual row
//  - only the session's owner (or the admin) can do it, open or closed; it is never shown as cheating and never counted as flagged
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HERE = { lat: 31.2, lng: 29.9, acc: 10 };

const gas = build(); gas.run("att_setup('SS1')");
const D = o => J(gas.ctx.att_dispatch_(o));
const t1 = (() => { const r = D({ action: "att_user_create", token: A, name: "Dr One" }); return { id: r.user.user_id, token: D({ action: "att_login", password: r.password }).token }; })();
const t2 = (() => { const r = D({ action: "att_user_create", token: A, name: "Dr Two" }); return { id: r.user.user_id, token: D({ action: "att_login", password: r.password }).token }; })();
const room = D({ action: "att_calibrate_room", token: t1.token, name: "H", samples: [HERE] }).room.room_id;
const s = D({ action: "att_start_session", token: t1.token, course: "C1", room_id: room });
const tk = () => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
const signup = (id, c, name) => D({ action: "att_signup", ticket: tk(), student_id: id, name: name || "N " + id, secret: c.repeat(16), fp: "f" + c, geo: HERE });
const attend = (id, c) => D({ action: "att_attend", ticket: tk(), student_id: id, secret: c.repeat(16), fp: "f" + c, geo: HERE });
const man = (o, tok) => D(Object.assign({ action: "att_manual_checkin", token: tok || t1.token, session_id: s.session_id, reason: "NO_PHONE" }, o));
const rows = id => gas.sheets.AttCheckins._g.filter(r => r[1] === s.session_id && r[2] === id);
const H = gas.ctx.ATT_HEADERS.AttCheckins, col = k => H.indexOf(k);

console.log("registered student, no phone");
signup("20240001", "a", "Mona Ali"); signup("20240002", "b", "Omar Hassan");
let r = man({ student_id: "20240001" });
ok(r.ok && r.status === "recorded" && r.name === "Mona Ali" && !r.new_student, "marked present, the reply carries the name");
const row = rows("20240001")[0];
ok(rows("20240001").length === 1 && row[col("device_id")] === "MANUAL" && row[col("flags")] === "MANUAL" && row[col("status")] === "ok", "one row: device MANUAL, flags MANUAL, status ok");
ok(row[col("lat")] === "" && row[col("fp_hash")] === "" && row[col("review_status")] === "accepted" && row[col("reviewed_by")] === t1.id && row[col("review_note")] === "Manual entry: No phone / phone not working", "no location / fingerprint; accepted by the teacher, with the reason");
r = man({ student_id: "20240001", reason: "PAGE_ERROR" });
ok(r.ok && r.status === "already" && r.manual === true && rows("20240001").length === 1, "entered again: 'already' (by hand), no second row");
ok(attend("20240002", "b").status === "recorded", "Omar checks in by phone");
r = man({ student_id: "20240002" });
ok(r.ok && r.status === "already" && r.manual === false && rows("20240002").length === 1, "a student already checked in by phone: 'already' (by phone), nothing written");

console.log("the student then checks in by phone too");
const a1 = attend("20240001", "a");
ok(a1.status === "recorded" && rows("20240001").length === 1 && rows("20240001")[0][col("flags")] === "MANUAL" && rows("20240001")[0][col("lat")] === "", "their own check-in afterwards: recorded, the manual row is left as it is (no second row, not overwritten)");

console.log("student who never registered");
r = man({ student_id: "30000001" });
ok(r.code === "NAME_REQUIRED" && rows("30000001").length === 0, "no name: NAME_REQUIRED, nothing written");
r = man({ student_id: "30000001", name: "  Hand   Student ", reason: "OTHER", note: "phone stolen" });
ok(r.ok && r.status === "recorded" && r.new_student === true && r.name === "Hand Student", "with a name: recorded and a new student is created");
const st = gas.sheets.AttStudents._g.find(x => x[0] === "30000001");
ok(st && st[1] === "Hand Student" && st[2] === "" && st[4] === "active", "the student row has the name and NO device");
ok(/Manual entry: Other - phone stolen/.test(rows("30000001")[0][col("review_note")]), "the 'Other' note is kept");
const su = signup("30000001", "h", "Typed By Student");
ok(su.ok && su.status === "registered" && su.claimed === true && su.name === "Hand Student", "later, the student signs up on their own phone: the first phone is bound to that ID (name kept)");
ok(gas.sheets.AttStudents._g.find(x => x[0] === "30000001")[2] !== "" && gas.sheets.AttDevices._g.some(d => d[1] === "30000001" && d[5] === "active"), "the student row now has the device, and the device is active");
ok(signup("30000001", "x").code === "ID_TAKEN", "a second phone for that ID afterwards: ID_TAKEN (as for anyone)");
ok(attend("30000001", "h").status === "recorded" && rows("30000001").length === 1, "their phone check-in in this lecture: recorded, still one row");
ok(signup("20240001", "z").code === "ID_TAKEN", "a registered student (with a phone) is never claimable by another phone");

console.log("validation and access");
ok(man({ student_id: "12" }).code === "BAD_ID", "bad ID");
ok(man({ student_id: "20240009", reason: "WHATEVER" }).code === "BAD_REQUEST", "unknown reason");
ok(man({ student_id: "20240009", reason: "OTHER" }).code === "NOTE_REQUIRED", "'Other' needs a note");
ok(man({ student_id: "20240009", name: "X Y" }, t2.token).code === "UNAUTHORIZED", "another teacher cannot mark students in this lecture");
ok(D({ action: "att_manual_checkin", session_id: s.session_id, student_id: "20240009", reason: "NO_PHONE", name: "X Y" }).code === "UNAUTHORIZED", "no token: refused");
ok(man({ student_id: "20240009", name: "X Y", session_id: "S-NOPE" }).code === "NO_SESSION", "unknown lecture: NO_SESSION");
ok(gas.sheets.AttStudents._g.every(x => x[0] !== "20240009"), "nothing was created by the refused calls");
ok(man({ student_id: "20240010", name: "Admin Added" }, A).status === "recorded", "the admin can mark students in any teacher's lecture");

console.log("after the lecture is closed");
D({ action: "att_close_session", token: t1.token, session_id: s.session_id });
gas.advance(10 * 60000);
ok(attend("20240011", "q").ok === false, "students can no longer check in themselves");

ok(man({ student_id: "20240012", name: "Late Entry" }).status === "recorded", "the teacher can still enter a student by hand after the close");

console.log("counts, feed, roster");
const live = D({ action: "att_live", token: t1.token, session_id: s.session_id });
const det = D({ action: "att_session_detail", token: t1.token, session_id: s.session_id });
ok(live.present === 5 && live.flagged === 0 && det.summary.flagged === 0, "manual entries count as present and never as flagged (present " + live.present + ")");
ok(!live.feed.some(e => e.k === "bad"), "the live feed never shows a manual entry as cheating");
ok(live.feed.some(e => e.k === "att" && e.id === "20240012"), "the live feed shows it as an attendance");
const ros = D({ action: "att_roster", token: t1.token });
ok(ros.marks.some(m => m[1] === "20240012") && ros.students.some(x => x.student_id === "20240012"), "the roster shows the hand-entered student as present");
const csv = D({ action: "att_export", token: t1.token, session_id: s.session_id }).csv;
ok(/20240012,Late Entry,[^\n]*,ok,MANUAL,/.test(csv) && /Manual entry: No phone/.test(csv), "the CSV export marks the row MANUAL with the reason");
ok(gas.sheets.AttFlagLog._g.every(x => x[3] !== "MANUAL"), "nothing is written to the flag log");

console.log("\n" + pass + " manual entry checks passed");
