// node tests/attendance/rejected_absent.test.js : a check-in the teacher REJECTS counts as absent everywhere (2026-11-16, docs/attendance/decisions.md D20),
// on the emulated backend: projector counter, close summary, Past lectures list + detail, admin overview, roster, session CSV, live feed.
// Accepting it again brings it back; marking the student present by hand overrides the rejection.
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HALL = { lat: 31.2, lng: 29.9, acc: 10 }, FAR = { lat: 31.25, lng: 29.95, acc: 10 };

const gas = build(); gas.run("att_setup('SS1')");
const D = o => J(gas.ctx.att_dispatch_(o));
const t = (() => { const r = D({ action: "att_user_create", token: A, name: "Dr Rej" }); return { id: r.user.user_id, token: D({ action: "att_login", user_id: r.user.user_id, password: r.password }).token }; })();
const other = (() => { const r = D({ action: "att_user_create", token: A, name: "Dr Other" }); return { token: D({ action: "att_login", user_id: r.user.user_id, password: r.password }).token }; })();
const room = D({ action: "att_calibrate_room", token: t.token, name: "Hall", samples: [HALL] }).room.room_id;
const s = D({ action: "att_start_session", token: t.token, course: "Networks", room_id: room });
const tk = () => gas.ctx.att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60);
function come(id, name, geo) {
  const sec = (id + "k").repeat(8);
  D({ action: "att_signup", ticket: tk(), student_id: id, name, secret: sec, fp: "f" + id, geo });
  return D({ action: "att_attend", ticket: tk(), student_id: id, secret: sec, fp: "f" + id, geo });
}
ok(come("30001", "Good One", HALL).status === "recorded" && come("30002", "Good Two", HALL).status === "recorded" && come("30003", "Far Away", FAR).status === "recorded", "three students check in, one from outside the hall");

const live = () => D({ action: "att_live", token: t.token, session_id: s.session_id });
const flagged = D({ action: "att_flagged", token: t.token, session_id: s.session_id }).rows;
ok(flagged.length === 1 && flagged[0].student_id === "30003" && /GEO_FAR/.test(flagged[0].flags), "the far one waits in Needs review");
ok(live().present === 3 && live().flagged === 1, "before a decision: 3 present (a flagged check-in counts until it is decided)");

const cid = flagged[0].checkin_id;
ok(D({ action: "att_review", token: other.token, checkin_id: cid, decision: "rejected" }).code === "UNAUTHORIZED", "another teacher cannot reject it");
ok(D({ action: "att_review", token: t.token, checkin_id: cid, decision: "rejected", note: "not in the hall" }).ok, "the lecturer rejects it");

console.log("rejected = absent");
const L = live();
ok(L.present === 2 && L.rejected === 1 && L.flagged === 1, "projector counter: 2 present, 1 rejected; it still shows under 'looked unusual'");
ok(!L.feed.some(e => e.k === "att" && e.id === "30003"), "live feed: no 'attended' line for the rejected student");
const cl = D({ action: "att_close_session", token: t.token, session_id: s.session_id });
ok(cl.summary.present === 2 && cl.summary.rejected === 1, "close summary (and the Telegram message built from it): 2 present");
ok(gas.sent.some(m => /session closed/i.test(m.text) && /Present: <b>2<\/b>/.test(m.text)), "Telegram close message says Present: 2");
const hist = D({ action: "att_sessions", token: t.token }).sessions.find(x => x.session_id === s.session_id);
ok(hist.present === 2 && hist.rejected === 1 && hist.flagged === 1 && hist.unreviewed === 0, "Past lectures list: 2 present, 1 rejected, nothing left to decide");
const det = D({ action: "att_session_detail", token: t.token, session_id: s.session_id });
ok(det.summary.present === 2 && det.summary.rejected === 1 && det.checkins.length === 3, "lecture detail: summary 2 present, and the rejected row is still listed (so it can be changed back)");
const ov = D({ action: "att_overview", token: A });
ok(ov.totals.present === 2 && ov.totals.rejected === 1 && ov.by_user.find(u => u.user_id === t.id).present === 2, "admin overview: totals and the teacher's row count 2 present");
const ros = D({ action: "att_roster", token: t.token });
ok(ros.marks.length === 2 && !ros.marks.some(m => m[1] === "30003"), "roster marks leave the rejected student out (an old cached dashboard shows them absent too)");
ok(ros.rejected.length === 1 && ros.rejected[0][1] === "30003" && ros.rejected[0][3] === "not in the hall", "roster lists the rejection apart, with the note, so the grid can say why");
ok(ros.students.some(x => x.student_id === "30003"), "the rejected student stays on the roster (as absent), not hidden");
const csv = D({ action: "att_export", token: t.token, session_id: s.session_id }).csv.split("\r\n");
ok(/,attendance$/.test(csv[0]) && csv.some(l => /^30003,Far Away,.*rejected,not in the hall,absent \(rejected\)$/.test(l)) && csv.filter(l => /,present$/.test(l)).length === 2, "session CSV: an 'attendance' column, absent (rejected) for the rejected row, present for the others");

console.log("changing the decision");
ok(D({ action: "att_review", token: t.token, checkin_id: cid, decision: "accepted", note: "was at the door" }).ok && live().present === 3 && live().rejected === 0, "Accept again: back to present (last decision wins)");
D({ action: "att_review", token: t.token, checkin_id: cid, decision: "rejected", note: "not in the hall" });
ok(live().present === 2, "Reject again: absent again");

console.log("hand entry over a rejected check-in");
const m = D({ action: "att_manual_checkin", token: t.token, session_id: s.session_id, student_id: "30003", reason: "OTHER", note: "seen in class" });
ok(m.ok && m.status === "recorded" && m.overrode_reject === true, "Mark present by hand on a rejected student: recorded (the teacher's newer decision wins)");
const rows = gas.sheets.AttCheckins._g.filter(r => r[1] === s.session_id && r[2] === "30003");
const H = gas.run("ATT_HEADERS.AttCheckins"), col = k => H.indexOf(k);
ok(rows.length === 1 && rows[0][col("review_status")] === "accepted" && /Manual entry: Other - seen in class \(was rejected: not in the hall\)/.test(rows[0][col("review_note")]), "no second row: the same row becomes Accepted, its note keeps the hand entry and the old rejection");
ok(live().present === 3 && D({ action: "att_roster", token: t.token }).marks.some(x => x[1] === "30003"), "...and the student counts as present again");
ok(D({ action: "att_manual_checkin", token: t.token, session_id: s.session_id, student_id: "30003", reason: "NO_PHONE" }).status === "already", "a second hand entry: already present, nothing changed");

console.log(`\n${pass} rejected = absent checks passed`);
