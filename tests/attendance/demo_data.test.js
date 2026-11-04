// node tests/attendance/demo_data.test.js : att_seedDemo / att_demoLive / att_clearDemo (docs/attendance/demo-data.md), on the emulated backend.
//  - the seed fills every screen: 2 demo teachers (working passwords), rooms, 14 lectures, every flag (incl. REPEATED), a cheating
//    attempt, an upgrade, reviews in every state, hand entries, phone-change requests in every state, students with different rates
//  - the flags come from the real rule engine; each teacher sees only their own; the admin sees both
//  - att_demoLive: real check-ins into an open demo lecture (new student, far away, cheating attempt); never a Telegram message
//  - att_clearDemo removes every demo row and leaves real data byte-for-byte the same; seeding twice = one copy
const assert = require("assert");
const { build } = require("./gas_emulator.js");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret", HERE = { lat: 31.2, lng: 29.9, acc: 10 };

const gas = build(); gas.run("att_setup('SS1')");
const D = o => J(gas.ctx.att_dispatch_(o));
// some REAL data first: a real teacher, room, lecture, students, a check-in, a request
const real = D({ action: "att_user_create", token: A, name: "Dr Real" }), RT = D({ action: "att_login", password: real.password }).token;
const rr = D({ action: "att_calibrate_room", token: RT, name: "Real Hall", samples: [HERE] }).room;
const rs = D({ action: "att_start_session", token: RT, course: "Real Course", room_id: rr.room_id });
const tk = () => gas.ctx.att_makeTicket_(rs.session_id, "", Math.floor(Date.now() / 1000) + 60);
D({ action: "att_signup", ticket: tk(), student_id: "20240001", name: "Real Student", secret: "r".repeat(16), fp: "fr", geo: HERE });
D({ action: "att_attend", ticket: tk(), student_id: "20240001", secret: "r".repeat(16), fp: "fr", geo: HERE });
D({ action: "att_change_device", ticket: tk(), student_id: "20240001", new_secret: "n".repeat(16), fp: "fn" });
const snap = () => JSON.stringify(Object.keys(gas.sheets).sort().map(n => [n, gas.sheets[n]._g]));
const before = snap(), sent0 = gas.sent.length;

console.log("seed");
const out = J(gas.run("att_seedDemo()"));
ok(out.teachers.length === 2 && out.teachers.every(t => /^DEMO /.test(t.name) && t.password), "two demo teachers, names start with DEMO, passwords returned (and logged)");
const T1 = D({ action: "att_login", password: out.teachers[0].password }).token, T2 = D({ action: "att_login", password: out.teachers[1].password }).token;
ok(T1 && T2, "both demo passwords sign in");
const ses = D({ action: "att_sessions", token: A, limit: 200 }).sessions.filter(s => /^DEMO /.test(s.course));
ok(ses.length === 14 && new Set(ses.map(s => s.course)).size === 3 && ses.every(s => s.status === "closed"), "14 closed demo lectures in 3 courses");
const ages = ses.map(s => (Date.now() - Date.parse(s.start_utc)) / 86400000);
ok(Math.min(...ages) > 0.5 && Math.max(...ages) < 24, "spread over the last 23 days");
ok(D({ action: "att_sessions", token: T1 }).sessions.length === 11 && D({ action: "att_sessions", token: T2 }).sessions.length === 3, "each demo teacher sees only their own lectures (11 / 3), never the real one");
ok(D({ action: "att_rooms", token: T1 }).rooms.length === 2 && D({ action: "att_rooms", token: T2 }).rooms.length === 1, "rooms 2 + 1, private per teacher");
const all = [].concat(...ses.map(s => D({ action: "att_session_detail", token: A, session_id: s.session_id }).checkins));
const flags = new Set([].concat(...all.map(c => String(c.flags || "").split(",").filter(Boolean))));
for (const f of ["GEO_FAR", "GEO_DENIED", "GEO_SKIPPED", "GEO_UNAVAILABLE", "GEO_WEAK", "SAME_PHONE_MULTI_ID", "IDENTICAL_COORDS", "REPEATED", "MANUAL"])
  ok(flags.has(f), "the data shows " + f);
ok(all.every(c => /^9997\d{4}$/.test(c.student_id)), "every demo check-in is a 9997xxxx student");
const rv = all.map(c => c.review_status);
ok(rv.includes("accepted") && rv.includes("rejected") && all.some(c => c.status === "review" && !c.review_status), "reviews: accepted, rejected and still undecided");
ok(all.filter(c => /^Manual entry/.test(c.review_note || "")).length === 3, "three hand entries");
const reqs = D({ action: "att_requests", token: T1 }).requests, st = reqs.map(r => r.status);
ok(st.filter(x => x === "pending").length === 2 && st.includes("approved") && reqs.some(r => r.status === "pending" && r.fp_match) && reqs.some(r => r.status === "pending" && !r.fp_match), "Dr Hossam's phone changes: 2 pending (same model / different), 1 approved");
ok(D({ action: "att_requests", token: T2 }).requests.some(r => r.status === "denied"), "Eng. Mariam's: 1 denied");
const log = gas.sheets.AttFlagLog._g.slice(1).map(r => r[3]);
ok(log.includes("DEVICE_ID_CONFLICT") && log.includes("GEO_UPGRADED"), "flag log: a cheating attempt and an upgraded first attempt");
const ros = D({ action: "att_roster", token: T1, limit: 200 });
ok(ros.students.length >= 25 && new Set(ros.students.map(s => ros.marks.filter(m => m[1] === s.student_id).length)).size >= 4, "All students: " + ros.students.length + " students with different attendance counts");
ok(D({ action: "att_flagged", token: T1 }).rows.some(r => !r.review_status), "Needs review has something to decide");
ok(D({ action: "att_overview", token: A }).by_user.some(u => /^DEMO /.test(u.name)), "the admin's All teachers lists the demo teachers");
ok(gas.sent.length === sent0, "seeding sent no Telegram message");
// a demo student signs in from a phone with the seeded device and checks in to a real open lecture? no: their secrets are demo-only. A login with a demo phone works:
const s0 = gas.run('att_demoSecret_("99970101")');
ok(gas.ctx.att_getDevice_(gas.ctx.att_sha256Hex_(s0)).student_id === "99970101", "seeded devices are real device rows (att_demoLive can check in as them)");

console.log("live lecture");
const lv = J(gas.run("att_demoLive()"));
const live = D({ action: "att_live", token: T1, session_id: lv.session_id });
ok(/^DEMO /.test(D({ action: "att_session_detail", token: T1, session_id: lv.session_id }).session.course) && live.ok, "att_demoLive opened a demo lecture owned by the demo teacher");
ok(live.present === 12 && live.flagged >= 1 && live.feed.some(e => e.k === "bad") && live.feed.some(e => e.k === "reg"), "12 check in: one far (flagged), one new sign-up, one cheating attempt in red (" + lv.results.join(", ") + ")");
ok(gas.sent.length === sent0, "a live demo lecture sends no Telegram message (flags, cheating, start)");
const again = J(gas.run("att_demoLive()"));
ok(again.session_id === lv.session_id, "a second run reuses the open demo lecture");
D({ action: "att_close_session", token: T1, session_id: lv.session_id });
ok(gas.sent.length === sent0, "closing a demo lecture sends no Telegram summary");

console.log("real data is never touched");
const rl = D({ action: "att_live", token: RT, session_id: rs.session_id });
ok(rl.present === 1 && D({ action: "att_sessions", token: RT }).sessions.length === 1, "the real teacher still sees only the real lecture");
const realCheck = D({ action: "att_attend", ticket: tk(), student_id: "20240001", secret: "r".repeat(16), fp: "fr", geo: HERE });
ok(realCheck.status === "recorded", "a real check-in still works while demo data is there");
const sentBefore = gas.sent.length, rs2 = D({ action: "att_start_session", token: RT, course: "Real Course 2", room_id: rr.room_id });
ok(gas.sent.length > sentBefore && /Real Course 2/.test(gas.sent[gas.sent.length - 1].text), "(control) a real lecture still sends its Telegram message");
D({ action: "att_close_session", token: RT, session_id: rs2.session_id });

console.log("clear");
const cl = J(gas.run("att_clearDemo()"));
ok(cl.AttCheckins > 100 && cl.AttUsers === 2 && cl.AttSessions === 15 && cl.AttRooms === 3, "removed: " + JSON.stringify(cl));
const after = JSON.parse(snap());
const leftDemo = after.some(([n, g]) => g.slice(1).some(r => r.some(c => /^9997\d{4}$/.test(String(c)) || /^DEMO /.test(String(c)))));
ok(!leftDemo, "no demo row is left in any tab");
const beforeTabs = JSON.parse(before), byName = Object.fromEntries(after);
const realRows = Object.fromEntries(beforeTabs.map(([n, g]) => [n, g]));
ok(Object.keys(realRows).every(n => JSON.stringify(byName[n].slice(0, realRows[n].length)) === JSON.stringify(realRows[n])), "every real row is still there, unchanged and in order");
ok(D({ action: "att_login", password: out.teachers[0].password }).ok === false, "the demo teachers can no longer sign in");

console.log("re-seed");
gas.run("att_seedDemo()"); const o2 = J(gas.run("att_seedDemo()"));
ok(D({ action: "att_sessions", token: A, limit: 200 }).sessions.filter(s => /^DEMO /.test(s.course)).length === 14 && D({ action: "att_users", token: A }).users.filter(u => /^DEMO /.test(u.name)).length === 2, "seeding twice leaves one copy (the second run clears the first)");
ok(D({ action: "att_login", password: o2.teachers[0].password }).ok, "the newest passwords work");
gas.run("att_clearDemo()");
console.log("\n" + pass + " demo data checks passed");
