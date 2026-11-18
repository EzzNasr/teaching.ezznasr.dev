// node tests/attendance/blocked_repair.test.js : after the 46-students-flagged lecture (2026-11-18, docs/attendance/decisions.md D22, D23),
// on the emulated backend:
//  - D22 a phone that does not match the student is SAVED (status "blocked") in Needs review, absent until accepted; Accept all;
//    a real check-in from the student's own phone replaces it; accepting an unregistered sign-up adds the student
//  - D23 the incident: a scrambled phone list (one column of AttDevices sorted) refuses EVERY returning student;
//    att_checkDevices() says so, att_repairDevices(true) fixes it, att_recoverRefused() brings the lost lecture into Needs review;
//    IDs that lost a leading zero are detected and renamed
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HALL = { lat: 31.2, lng: 29.9, acc: 10 };

function env(n) {
  const gas = build(); gas.run("att_setup('SS1')");
  gas.ctx.Logger = { log() {} };
  const D = o => J(gas.ctx.att_dispatch_(o));
  const room = D({ action: "att_calibrate_room", token: A, name: "Hall", samples: [HALL] }).room.room_id;
  const start = () => D({ action: "att_start_session", token: A, course: "C" + Math.random(), room_id: room });
  const tk = s => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
  const id = i => String(20250000 + i), sec = i => ("p" + i + "x").repeat(8);
  const signup = (s, i, idOverride) => D({ action: "att_signup", ticket: tk(s), student_id: idOverride || id(i), name: "Student " + i, secret: sec(i), fp: "f" + i, geo: HALL });
  const attend = (s, i, idOverride) => D({ action: "att_attend", ticket: tk(s), student_id: idOverride || id(i), secret: sec(i), fp: "f" + i, geo: HALL });
  const live = s => D({ action: "att_live", token: A, session_id: s.session_id });
  const rowsOf = s => gas.sheets.AttCheckins._g.filter((r, k) => k > 0 && r[1] === s.session_id);
  const H = gas.run("ATT_HEADERS.AttCheckins"), col = k => H.indexOf(k);
  return { gas, D, start, tk, id, sec, signup, attend, live, rowsOf, col, n };
}

console.log("D22: suspected cheating is saved, absent until accepted");
{
  const E = env(), s = E.start();
  [1, 2, 3].forEach(i => { E.signup(s, i); E.attend(s, i); });
  ok(E.live(s).present === 3, "three students check in normally");
  const s2 = E.start();   // a new lecture
  const friend = E.attend(s2, 1, E.id(2));   // student 1's phone checks in student 2
  ok(friend.code === "DEVICE_ID_CONFLICT", "a phone checking in a different student is refused on the phone, as before");
  const row = E.rowsOf(s2).find(r => r[2] === E.id(2));
  ok(row && row[E.col("status")] === "blocked" && row[E.col("flags")] === "DEVICE_ID_CONFLICT" && row[E.col("lat")] !== "", "...and now SAVED for student 2: status blocked, the reason, the location");
  let L = E.live(s2);
  ok(L.present === 0 && L.blocked === 1 && L.flagged === 1, "projector: 0 attended, 1 needs a look (the blocked attempt is absent until accepted)");
  const fl = E.D({ action: "att_flagged", token: A, session_id: s2.session_id }).rows;
  ok(fl.length === 1 && fl[0].student_id === E.id(2) && fl[0].name === "Student 2" && fl[0].status === "blocked", "Needs review lists it with the student's real name and ID");
  ok(E.D({ action: "att_roster", token: A }).blocked.some(m => m[1] === E.id(2)), "roster lists it as blocked (the grid shows '?', counted absent)");
  ok(/"absent \(phone did not match, waiting for review\)"$/.test(E.D({ action: "att_export", token: A, session_id: s2.session_id }).csv.split("\r\n").find(l => l.startsWith(E.id(2)))), "lecture CSV: absent (phone did not match, waiting for review)");
  ok(E.attend(s2, 2).status === "recorded", "student 2 then checks in from their OWN phone: recorded");
  const r2 = E.rowsOf(s2).filter(r => r[2] === E.id(2));
  ok(r2.length === 1 && r2[0][E.col("status")] === "ok" && r2[0][E.col("flags")] === "" && r2[0][E.col("device_id")] === "D-" + E.gas.ctx.att_sha256Hex_(E.sec(2)).slice(0, 16), "...the same row now holds the real check-in (one row, status ok)");
  ok(E.live(s2).present === 1 && E.live(s2).blocked === 0, "...and counts as present");
  E.attend(s2, 3, E.id(2));
  ok(E.rowsOf(s2).filter(r => r[2] === E.id(2)).length === 1 && E.rowsOf(s2).find(r => r[2] === E.id(2))[E.col("status")] === "ok", "a later suspect attempt for someone already present writes nothing (flag log only)");

  const s3 = E.start();
  E.attend(s3, 1, E.id(3));
  const cid = E.D({ action: "att_flagged", token: A, session_id: s3.session_id }).rows[0].checkin_id;
  ok(E.D({ action: "att_review", token: A, checkin_id: cid, decision: "accepted" }).ok && E.live(s3).present === 1, "Accept: the blocked attempt counts as present");
  ok(E.D({ action: "att_review", token: A, checkin_id: cid, decision: "rejected" }).ok && E.live(s3).present === 0, "Reject: absent again");
  ok(E.D({ action: "att_manual_checkin", token: A, session_id: s3.session_id, student_id: E.id(3), reason: "OTHER", note: "seen" }).overrode_reject === true && E.live(s3).present === 1, "Mark present by hand also overrides it");

  // a sign-up from a phone already bound to someone else, for an ID that never registered
  const s4 = E.start();
  ok(E.D({ action: "att_signup", ticket: E.tk(s4), student_id: "20259999", name: "New Person", secret: E.sec(1), fp: "f1", geo: HALL }).code === "DEVICE_BOUND_OTHER_ID", "sign-up from a phone bound to another student: refused on the phone");
  const nb = E.D({ action: "att_flagged", token: A, session_id: s4.session_id }).rows;
  ok(nb.length === 1 && nb[0].student_id === "20259999" && nb[0].flags === "DEVICE_BOUND_OTHER_ID" && /Typed name: New Person/.test(nb[0].review_note), "...saved in Needs review with the name they typed");
  E.D({ action: "att_review", token: A, checkin_id: nb[0].checkin_id, decision: "accepted" });
  const st = E.gas.sheets.AttStudents._g.find(r => r[0] === "20259999");
  ok(st && st[1] === "New Person" && st[2] === "" && E.live(s4).present === 1, "accepting adds the student (with that name, no phone yet) and counts them present");
  ok(E.signup(s4, 50, "20259999").ok, "...and their own phone can still sign up to that ID later");
}

console.log("D22: Accept all for one lecture");
{
  const E = env(), s = E.start();
  [1, 2, 3, 4, 5].forEach(i => E.signup(s, i));
  const s2 = E.start();
  [2, 3, 4, 5].forEach(i => E.attend(s2, 1, E.id(i)));   // one phone tries four students
  ok(E.live(s2).blocked === 4 && E.live(s2).present === 0, "four blocked attempts, nobody present");
  ok(E.D({ action: "att_review_bulk", session_id: s2.session_id }).code === "UNAUTHORIZED", "Accept all needs a signed-in caller");
  const b = E.D({ action: "att_review_bulk", token: A, session_id: s2.session_id });
  ok(b.ok && b.accepted === 4 && E.live(s2).present === 4 && E.live(s2).flagged === 4, "Accept all: 4 accepted, 4 present (they still show as looked unusual)");
  ok(E.D({ action: "att_review_bulk", token: A, session_id: s2.session_id }).accepted === 0, "running it again changes nothing (already decided)");
}

console.log("D23: the incident: a scrambled phone list");
{
  const E = env(), s = E.start(), N = 12;
  for (let i = 1; i <= N; i++) { E.signup(s, i); E.attend(s, i); }
  ok(E.live(s).present === N, N + " students registered and checked in last week");
  // Someone sorts ONLY the student_id column of AttDevices (Sheets: select the column, Sort A-Z, "don't expand the selection").
  // Rows were in sign-up order; reversing that one column re-pairs every phone with another student's ID.
  const g = E.gas.sheets.AttDevices._g, sc = E.gas.run("ATT_HEADERS.AttDevices").indexOf("student_id"), ids = g.slice(1).map(r => r[sc]).reverse();
  g.slice(1).forEach((r, k) => { r[sc] = ids[k]; });
  E.gas.run('Object.keys({}).length'); for (let i = 1; i <= N; i++) E.gas.run(`att_cdel_("att:d:" + att_sha256Hex_(${JSON.stringify(E.sec(i))}))`);
  const s2 = E.start(), codes = [];
  for (let i = 1; i <= N; i++) codes.push(E.attend(s2, i).code);
  ok(codes.every(c => c === "DEVICE_ID_CONFLICT"), "the next lecture: EVERY student is refused as 'registered to another student' (the screen from the incident)");
  const L = E.live(s2);
  ok(L.present === 0 && L.feed.filter(e => e.k === "bad").length === N, "projector: 0 attended, " + N + " 'cheating caught'");
  ok(L.blocked === N && E.D({ action: "att_flagged", token: A, session_id: s2.session_id }).rows.length === N, "...but now all " + N + " are saved in Needs review, by name (before D22 they were in the flag log only)");

  const chk = E.gas.run("att_checkDevices()");
  ok(/PHONE RECORDS DAMAGED/.test(chk.verdict) && chk.owner_mismatch.length === N, "att_checkDevices: 'PHONE RECORDS DAMAGED', " + chk.owner_mismatch.length + " phones point at the wrong student");
  const last = chk.lectures.find(x => x.session_id === s2.session_id);
  ok(last && last.refused_students === N && last.refusals.DEVICE_ID_CONFLICT === N && last.checkins === N, "...and lists the lecture: " + N + " refused students, the reason, the saved rows");
  const dry = E.gas.run("att_repairDevices()");
  ok(dry.applied === false && dry.fixes.length === N && g.slice(1).map(r => r[sc]).join() === ids.join(), "att_repairDevices(): reports " + N + " fixes and changes nothing");
  const fix = E.gas.run("att_repairDevices(true)");
  ok(fix.applied && E.gas.run("att_checkDevices()").verdict === "phone records look consistent", "att_repairDevices(true): fixed; the check now says consistent");
  const s3 = E.start(), codes3 = [];
  for (let i = 1; i <= N; i++) codes3.push(E.attend(s3, i).status);
  ok(codes3.every(c => c === "recorded") && E.live(s3).present === N, "the next lecture: every student checks in again from their own phone");
  for (let i = 1; i <= N; i++) E.attend(s2, i);
  ok(E.live(s2).present === N && E.live(s2).blocked === 0, "...and in the damaged lecture (still in its late grace), each real check-in replaces the blocked row");

  // a device_id column sorted instead (the hash column is what phones send, so it is the truth)
  const dc = E.gas.run("ATT_HEADERS.AttDevices").indexOf("device_id"), dids = g.slice(1).map(r => r[dc]).reverse();
  g.slice(1).forEach((r, k) => { r[dc] = dids[k]; });
  ok(E.gas.run("att_checkDevices()").device_id_vs_fingerprint.length === N && E.gas.run("att_repairDevices(true)").fixes.length === N && E.gas.run("att_checkDevices()").verdict === "phone records look consistent", "a sorted device_id column is detected and repaired the same way");
}

console.log("D23: bringing a lecture lost before D22 back");
{
  const E = env(), s = E.start();
  for (let i = 1; i <= 5; i++) E.signup(s, i);
  const s2 = E.start(), log = E.gas.sheets.AttFlagLog;
  // the flag log of the real lecture: refusals only, nothing saved (what the old code wrote)
  for (let i = 1; i <= 5; i++) log.appendRow([new Date().toISOString(), s2.session_id, E.id(i), "DEVICE_ID_CONFLICT", "device D-x;owner=" + E.id(6 - i)]);
  log.appendRow([new Date().toISOString(), s2.session_id, E.id(1), "DEVICE_ID_CONFLICT", "again"]);   // the same student tapped twice
  log.appendRow([new Date().toISOString(), s2.session_id, E.id(2), "GEO_FAR", "dist_m=300"]);          // not a refusal
  const dry = E.gas.run(`att_recoverRefused(${JSON.stringify(s2.session_id)})`);
  ok(!dry.applied && dry.students.length === 5 && E.rowsOf(s2).length === 0, "att_recoverRefused(id): reports 5 students (one row each, refusals only) and writes nothing");
  ok(E.gas.run("att_recoverRefused()").session_id === s2.session_id, "without an id it picks the most recent lecture with refusals");
  E.gas.run(`att_recoverRefused(${JSON.stringify(s2.session_id)}, true)`);
  ok(E.rowsOf(s2).length === 5 && E.D({ action: "att_flagged", token: A, session_id: s2.session_id }).rows.every(r => r.status === "blocked" && /Recovered/.test(r.review_note)), "with true: 5 blocked rows in Needs review, marked as recovered");
  ok(E.D({ action: "att_review_bulk", token: A, session_id: s2.session_id }).accepted === 5 && E.live(s2).present === 5, "Accept all: the 5 students count as present in that lecture");
  ok(E.gas.run(`att_recoverRefused(${JSON.stringify(s2.session_id)}, true)`).students.length === 0, "running it again adds nothing");
}

console.log("D23: IDs that lost their leading zero");
{
  const E = env(), s = E.start();
  E.signup(s, 1, "0212345"); E.signup(s, 2, "0212346");
  // what a sheet column that is no longer plain text does: "0212345" becomes the number 212345
  ["AttStudents", "AttDevices"].forEach(t => { const c = E.gas.run(`ATT_HEADERS.${t}`).indexOf("student_id"); E.gas.sheets[t]._g.forEach((r, k) => { if (k > 0) r[c] = Number(r[c]); }); });
  for (let i = 1; i <= 2; i++) E.gas.run(`att_cdel_("att:d:" + att_sha256Hex_(${JSON.stringify(E.sec(i))}))`);
  const s2 = E.start();
  ok(E.attend(s2, 1, "0212345").code === "DEVICE_ID_CONFLICT", "the student's own phone is refused as 'registered to another student' (the stored ID lost its zero)");
  E.attend(s2, 2, "0212346");
  const chk = E.gas.run("att_checkDevices()");
  ok(/LEADING ZERO/.test(chk.verdict) && chk.lost_leading_zero.length === 2 && chk.numeric_id_cells.AttStudents === 2, "att_checkDevices: 'IDS LOST THEIR LEADING ZERO', 2 IDs, 2 number cells");
  const fix = E.gas.run("att_repairLeadingZeros(true)");
  ok(fix.applied && fix.ids.length === 2 && E.gas.sheets.AttStudents._g.some(r => r[0] === "0212345"), "att_repairLeadingZeros(true): the stored IDs get their zero back");
  for (let i = 1; i <= 2; i++) E.gas.run(`att_cdel_("att:d:" + att_sha256Hex_(${JSON.stringify(E.sec(i))}))`);
  ok(E.attend(E.start(), 1, "0212345").status === "recorded", "the student checks in again");
}

console.log(`\n${pass} blocked / repair checks passed`);
