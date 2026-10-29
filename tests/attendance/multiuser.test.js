// node tests/attendance/multiuser.test.js
// Session 2 (MASTER_PLAN_ATTENDANCE_MULTIUSER): migration, accounts + login, per-teacher scoping of EVERY action, geo reasons, the upgrade rule,
// ticket cap, history / overview / review, Telegram owner lines. Runs the REAL AttendanceAll.gs (accounts section included) on the Apps Script emulator.
const assert = require("assert"), path = require("path"), crypto = require("crypto");
const { build } = require("./gas_emulator.js");
const site = path.join(__dirname, "..", "..");
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const J = o => JSON.parse(JSON.stringify(o));
const A = "adm-secret";
const PW_RE = /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/;

function env() { const gas = build(); gas.run("att_setup('SS1')"); return { gas, D: o => J(gas.ctx.att_dispatch_(o)) }; }
const tk = (gas, sid, secs = 60) => gas.ctx.att_makeTicket_(sid, "", Math.floor(Date.now() / 1000) + secs);
const here = (i = 0) => ({ lat: 31.2 + i * 1e-6, lng: 29.9 + i * 1e-6, acc: 20 });
const sec = c => c.repeat(8);
const room = (D, token, name) => D({ action: "att_calibrate_room", token, name, samples: [{ lat: 31.2, lng: 29.9, acc: 10 }] });
const start = (D, token, course, room_id) => D({ action: "att_start_session", token, course, room_id });
const reg = (E, sid, id, name, c, geo) => E.D({ action: "att_signup", ticket: tk(E.gas, sid), student_id: id, name, secret: sec(c), fp: "fp" + id, geo: geo || here(Number(id.slice(-3))) });
const att = (E, sid, id, c, geo, extra) => E.D(Object.assign({ action: "att_attend", ticket: tk(E.gas, sid), student_id: id, secret: sec(c), fp: "fp" + id, geo: geo === undefined ? here(Number(id.slice(-3))) : geo }, extra || {}));
const mkUser = (D, name) => { const r = D({ action: "att_user_create", token: A, name }); const l = D({ action: "att_login", password: r.password }); return { id: r.user.user_id, pw: r.password, token: l.token, name }; };
const flagLog = gas => gas.sheets.AttFlagLog._g.slice(1).map(r => ({ session: r[1], student: r[2], code: r[3], detail: r[4] }));
const detail = (D, sid) => D({ action: "att_session_detail", token: A, session_id: sid });
const crow = (D, sid, id) => detail(D, sid).checkins.find(c => c.student_id === id);

(async () => {
  /* ───────────────────────── 1. migration ───────────────────────── */
  console.log("migration (legacy single-admin sheet)");
  {
    const gas = build(), D = o => J(gas.ctx.att_dispatch_(o));
    gas.props.ATT_MASTER_SECRET = "m".repeat(64);
    gas.ctx.__legacy = {
      AttStudents: ["student_id", "name", "device_id", "created_at", "status"], AttDevices: ["device_id", "student_id", "secret_hash", "fp_hash", "bound_at", "status"],
      AttRequests: ["req_id", "student_id", "new_device_id", "new_secret_hash", "new_fp_hash", "fp_match", "status", "created_at", "decided_at"],
      AttRooms: ["room_id", "name", "lat", "lng", "samples", "calibrated_at"], AttSessions: ["session_id", "course", "room_id", "start_utc", "close_utc", "status", "hall_lat", "hall_lng"],
      AttCheckins: ["checkin_id", "session_id", "student_id", "device_id", "server_utc", "lat", "lng", "acc", "dist_m", "fp_hash", "flags", "status"],
      AttFlagLog: ["ts_utc", "session_id", "student_id", "code", "detail"] };
    gas.run("Object.keys(__legacy).forEach(function (n) { att_ss_().insertSheet(n).appendRow(__legacy[n]); })");
    const iso = new Date().toISOString();
    gas.sheets.AttRooms.appendRow(["RM-OLD", "Old Hall", "31.2", "29.9", "3", iso]);
    gas.sheets.AttSessions.appendRow(["S-OLD", "Legacy Course", "RM-OLD", iso, iso, "closed", "31.2", "29.9"]);
    gas.sheets.AttRequests.appendRow(["R-OLD", "1001", "D-x", "h", "f", "false", "pending", iso, ""]);
    gas.sheets.AttCheckins.appendRow(["C-OLD", "S-OLD", "1001", "D-1", iso, "", "", "", "", "fp", "GEO_DENIED", "review"]);
    ok(D({ action: "att_rooms", token: A }).rooms.some(r => r.room_id === "RM-OLD" && r.owner_user_id === "ADMIN"), "BEFORE migrating: the admin still works on the legacy tabs and legacy rows read as owned by ADMIN");
    const legacySession = start(D, A, "Before migrate");
    ok(legacySession.ok, "BEFORE migrating: starting a session still works (old deployment order is safe)");
    ok(reg({ gas, D }, legacySession.session_id, "1002", "Pre Migrate", "p").ok && att({ gas, D }, legacySession.session_id, "1002", "p").ok, "BEFORE migrating: a student can still sign up and check in");
    const m1 = J(gas.run("att_migrate()"));
    ok(m1.ok && gas.sheets.AttSessions._g[0].length === 10 && gas.sheets.AttCheckins._g[0].length === 17 && gas.sheets.AttRooms._g[0].length === 7 && gas.sheets.AttRequests._g[0].length === 11, "att_migrate appends the new columns at the END of the existing tabs");
    ok(gas.sheets.AttUsers && gas.sheets.AttUsers._g[0].join() === "user_id,name,pw_hash,status,created_at,last_login", "att_migrate creates AttUsers");
    const sRow = id => gas.sheets.AttSessions._g.find(r => r[0] === id);
    ok(sRow("S-OLD")[8] === "ADMIN" && sRow("S-OLD")[9] === "Admin" && gas.sheets.AttRooms._g[1][6] === "ADMIN" && gas.sheets.AttRequests._g[1][10] === "ADMIN", "legacy rooms, sessions and requests are labelled owner ADMIN / Admin");
    ok(sRow(legacySession.session_id)[8] === "ADMIN" && sRow(legacySession.session_id)[9] === "Admin", "the session started BEFORE migrating lines up with the new columns");
    const snap = JSON.stringify(Object.keys(gas.sheets).map(k => gas.sheets[k]._g));
    const m2 = J(gas.run("att_migrate()"));
    ok(JSON.stringify(Object.keys(gas.sheets).map(k => gas.sheets[k]._g)) === snap && Object.values(m2.backfilled).every(n => n === 0), "att_migrate is idempotent (second run changes nothing)");
    ok(gas.run("att_setup('SS1')").ok, "att_setup no longer throws on migrated tabs");
    ok(gas.sheets.AttCheckins._g[1][0] === "C-OLD" && gas.sheets.AttCheckins._g[1][10] === "GEO_DENIED", "existing data is untouched and in the same place");
    const u1 = mkUser(D, "Mig Teacher");
    ok(D({ action: "att_sessions", token: u1.token }).sessions.length === 0 && D({ action: "att_rooms", token: u1.token }).rooms.length === 0 &&
       D({ action: "att_requests", token: u1.token }).requests.length === 0 && D({ action: "att_flagged", token: u1.token }).rows.length === 0, "a teacher sees NONE of the legacy data");
    ok(D({ action: "att_sessions", token: A }).sessions.some(s => s.session_id === "S-OLD" && s.owner_user_id === "ADMIN") && D({ action: "att_flagged", token: A }).rows.length >= 1, "the admin sees all of it");
    const gas2 = build(); gas2.run("att_ss_().insertSheet('AttRooms').appendRow(['bogus'])");
    assert.throws(() => gas2.run("att_setup('X')")); ok(true, "a tab with CONFLICTING headers is still refused, not overwritten");
  }

  /* ───────────────────────── 2. accounts + login ───────────────────────── */
  console.log("accounts + login");
  {
    const { gas, D } = env(), master = gas.props.ATT_MASTER_SECRET;
    ok(D({ action: "att_user_create", name: "No Token" }).code === "UNAUTHORIZED", "creating a user needs a token");
    const c1 = D({ action: "att_user_create", token: A, name: "  Dr   Salma  " });
    ok(c1.ok && c1.user.name === "Dr Salma" && c1.user.status === "active" && /^U-[0-9A-F]{8}$/.test(c1.user.user_id) && !("pw_hash" in c1.user), "admin creates a user: id, cleaned name, status active, no hash");
    ok(PW_RE.test(c1.password), "password is system-generated: 20 chars in groups of 5 from an unambiguous alphabet: " + c1.password);
    const canon = c1.password.replace(/-/g, "");
    ok(JSON.stringify(gas.sheets.AttUsers._g).indexOf(c1.password) < 0 && gas.sheets.AttUsers._g[1][2] === crypto.createHmac("sha256", master).update(canon).digest("hex"), "only HMAC-SHA256(master secret, password) is stored, never the password");
    const many = Array.from({ length: 40 }, (_, i) => D({ action: "att_user_create", token: A, name: "Bulk " + i }).password);
    ok(new Set(many.concat(c1.password)).size === 41 && many.every(p => PW_RE.test(p)), "40 more passwords: all unique, all well-formed");
    ok(D({ action: "att_user_create", token: A, name: "x" }).code === "BAD_REQUEST" && D({ action: "att_user_create", token: A, name: " admin " }).code === "BAD_REQUEST", "name too short / the reserved name 'Admin' rejected");
    const lg = D({ action: "att_login", password: c1.password });
    ok(lg.ok && /^u1\./.test(lg.token) && lg.user.role === "teacher" && lg.user.user_id === c1.user.user_id && lg.user.name === "Dr Salma", "login returns a signed token + user {user_id,name,role}");
    ok(Math.abs(lg.expires_at - (Date.now() + 12 * 3600 * 1000)) < 5000, "token lives 12 h");
    ok(D({ action: "att_login", password: c1.password.toLowerCase().replace(/-/g, "") }).ok, "password works in lower case and without the dashes");
    ok(D({ action: "att_users", token: A }).users.find(u => u.user_id === c1.user.user_id).last_login.length > 10, "last_login recorded");
    ok(D({ action: "att_login", password: "WRONG-WRONG-WRONG-WRONG" }).code === "BAD_PASSWORD" && D({ action: "att_login" }).code === "BAD_PASSWORD" && D({ action: "att_login", password: "x" }).code === "BAD_PASSWORD", "wrong / empty / short password -> BAD_PASSWORD");
    ok(!JSON.stringify(D({ action: "att_users", token: A })).match(/pw_hash|[0-9a-f]{64}/), "att_users never returns hashes");
    ok(D({ action: "att_me", token: A }).user.role === "admin" && D({ action: "att_me", token: A }).user.user_id === "ADMIN", "the raw ADMIN_TOKEN still works and means role admin");
    ok(D({ action: "att_me", token: lg.token }).user.name === "Dr Salma" && D({ action: "att_me", token: "garbage" }).code === "UNAUTHORIZED" && D({ action: "att_me" }).code === "UNAUTHORIZED", "att_me: any signed-in caller; bad/missing token -> UNAUTHORIZED");
    console.log("tokens");
    const flip = (t, i) => t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
    const parts = lg.token.split(".");
    ok(D({ action: "att_me", token: [parts[0], flip(parts[1], 5), parts[2]].join(".") }).code === "UNAUTHORIZED" && D({ action: "att_me", token: lg.token.slice(0, -1) + (lg.token.slice(-1) === "0" ? "1" : "0") }).code === "UNAUTHORIZED", "a tampered payload or signature is rejected");
    const forge = (body, key) => { const b64 = Buffer.from(JSON.stringify(body)).toString("base64url"); return "u1." + b64 + "." + crypto.createHmac("sha256", key).update("ut:" + b64).digest("hex").slice(0, 32); };
    const exp = Math.floor(Date.now() / 1000) + 600;
    ok(D({ action: "att_me", token: forge({ u: "ADMIN", r: "admin", e: exp, v: "" }, "wrong-key") }).code === "UNAUTHORIZED", "a token signed with the wrong key is rejected");
    ok(D({ action: "att_me", token: forge({ u: "ADMIN", r: "admin", e: exp, v: "" }, master) }).code === "UNAUTHORIZED", "even a CORRECTLY signed token claiming admin gives no admin (signed tokens are teacher-only)");
    ok(D({ action: "att_me", token: forge({ u: c1.user.user_id, r: "admin", e: exp, v: c1.user.user_id }, master) }).code === "UNAUTHORIZED", "token with a stale password marker is rejected");
    const pv = crypto.createHmac("sha256", master).update(canon).digest("hex").slice(0, 8);
    const asAdminClaim = D({ action: "att_overview", token: forge({ u: c1.user.user_id, r: "admin", e: exp, v: pv }, master) });
    ok(asAdminClaim.code === "FORBIDDEN", "a teacher whose token claims r:admin is still only a teacher (FORBIDDEN on admin actions)");
    ok(D({ action: "att_me", token: forge({ u: c1.user.user_id, r: "teacher", e: exp - 1200, v: pv }, master) }).code === "UNAUTHORIZED", "an expired token is rejected");
    ok(gas.run(`att_userTokenCheck_(${JSON.stringify(lg.token)}, undefined, ${Math.floor(Date.now() / 1000) + 12 * 3600 + 30})`) === null, "...and a real token expires after 12 h");
    console.log("admin-only actions");
    for (const [a, extra] of [["att_user_create", { name: "Zed" }], ["att_users", {}], ["att_user_update", { user_id: c1.user.user_id, name: "Zed" }], ["att_user_reset", { user_id: c1.user.user_id }], ["att_overview", {}]]) {
      ok(D(Object.assign({ action: a, token: lg.token }, extra)).code === "FORBIDDEN", a + ": teacher -> FORBIDDEN");
      ok(D(Object.assign({ action: a }, extra)).code === "UNAUTHORIZED", a + ": no token -> UNAUTHORIZED");
    }
    console.log("update / disable / reset");
    ok(D({ action: "att_user_update", token: A, user_id: c1.user.user_id, status: "banana" }).code === "BAD_REQUEST" && D({ action: "att_user_update", token: A, user_id: c1.user.user_id }).code === "BAD_REQUEST" &&
       D({ action: "att_user_update", token: A, user_id: "U-NOPE", name: "Zed" }).code === "NO_USER" && D({ action: "att_user_reset", token: A, user_id: "U-NOPE" }).code === "NO_USER", "update/reset validate their input (BAD_REQUEST, NO_USER)");
    ok(D({ action: "att_user_update", token: A, user_id: c1.user.user_id, name: "Dr Salma Z" }).user.name === "Dr Salma Z" && D({ action: "att_me", token: lg.token }).user.name === "Dr Salma Z", "rename takes effect at once");
    ok(D({ action: "att_user_update", token: A, user_id: c1.user.user_id, status: "disabled" }).ok, "admin disables the user");
    ok(D({ action: "att_me", token: lg.token }).code === "USER_DISABLED" && D({ action: "att_login", password: c1.password }).code === "USER_DISABLED", "disabled: the existing token and the password both -> USER_DISABLED");
    ok(D({ action: "att_user_update", token: A, user_id: c1.user.user_id, status: "active" }).ok && D({ action: "att_me", token: lg.token }).ok, "re-enabled: the same token works again");
    D({ action: "att_me", token: lg.token });   // warm the 60 s cache
    const urow = gas.sheets.AttUsers._g.find(r => r[0] === c1.user.user_id); urow[3] = "disabled";   // disabled behind the cache's back (e.g. edited in the sheet)
    ok(D({ action: "att_me", token: lg.token }).ok, "a sheet edit is picked up only after the 60 s cache...");
    gas.advance(61 * 1000);
    ok(D({ action: "att_me", token: lg.token }).code === "USER_DISABLED", "...within a minute (plan §4.5)");
    urow[3] = "active"; gas.advance(61 * 1000);
    const rs = D({ action: "att_user_reset", token: A, user_id: c1.user.user_id });
    ok(rs.ok && PW_RE.test(rs.password) && rs.password !== c1.password, "reset issues a new password, shown once");
    ok(D({ action: "att_login", password: c1.password }).code === "BAD_PASSWORD" && D({ action: "att_me", token: lg.token }).code === "UNAUTHORIZED", "after a reset the OLD password and the OLD token are dead");
    const lg2 = D({ action: "att_login", password: rs.password });
    ok(lg2.ok && D({ action: "att_me", token: lg2.token }).ok, "the new password works");
  }
  console.log("login lock-out (global, plan §4.5)");
  {
    const { gas, D } = env(), u = mkUser(D, "Lock Test");
    for (let i = 0; i < 9; i++) D({ action: "att_login", password: "NOPE-NOPE-NOPE-NOPE" + i });
    ok(D({ action: "att_login", password: u.pw }).ok, "9 failures do not lock");
    gas.advance(301 * 1000);
    for (let i = 0; i < 9; i++) D({ action: "att_login", password: "NOPE-NOPE-NOPE-NOPE" + i });
    gas.advance(301 * 1000);
    D({ action: "att_login", password: "NOPE-NOPE-NOPE-NOPE" });
    ok(D({ action: "att_login", password: u.pw }).ok, "failures are counted per 5-minute window");
    for (let i = 0; i < 10; i++) D({ action: "att_login", password: "NOPE-NOPE-NOPE-NOPE" + i });
    const lk = D({ action: "att_login", password: u.pw });
    ok(lk.code === "LOCKED" && lk.retry_after_sec > 0 && lk.retry_after_sec <= 300, "10 failures in 5 min -> LOCKED, even for the CORRECT password");
    ok(D({ action: "att_me", token: u.token }).ok && D({ action: "att_me", token: A }).ok, "signed-in users and the admin token are not affected by the lock");
    const R = room(D, A, "Hall"), S = start(D, A, "C", R.room.room_id);
    ok(S.ok && reg({ gas, D }, S.session_id, "1001", "Stu One", "a").ok, "students are not affected by the lock");
    gas.advance(301 * 1000);
    ok(D({ action: "att_login", password: u.pw }).ok, "after 5 minutes login works again");
  }

  /* ───────────────────────── 3. scoping ───────────────────────── */
  console.log("scoping: two teachers, simultaneous sessions, one roster");
  const E = env(), { gas, D } = E;
  const t1 = mkUser(D, "Teacher One"), t2 = mkUser(D, "Teacher Two");
  const r1 = room(D, t1.token, "Hall"), r2 = room(D, t2.token, "Hall"), rA = room(D, A, "Hall");
  ok(r1.ok && r2.ok && rA.ok && new Set([r1.room.room_id, r2.room.room_id, rA.room.room_id]).size === 3, "room names are unique PER OWNER: three people can each have a 'Hall'");
  ok(room(D, t1.token, "Hall").room.room_id === r1.room.room_id, "re-calibrating your own room updates it");
  const ids = rs => rs.rooms.map(r => r.room_id).sort().join();
  ok(ids(D({ action: "att_rooms", token: t1.token })) === r1.room.room_id && ids(D({ action: "att_rooms", token: t2.token })) === r2.room.room_id, "att_rooms: each teacher sees only their own rooms");
  ok(D({ action: "att_rooms", token: A }).rooms.length === 3 && ids(D({ action: "att_rooms", token: A, user_id: t2.id })) === r2.room.room_id, "admin sees all rooms (and may filter by user)");
  ok(ids(D({ action: "att_rooms", token: t2.token, user_id: t1.id })) === r2.room.room_id, "a teacher passing someone else's user_id is ignored (forced to own)");
  ok(start(D, t2.token, "C1", r1.room.room_id).code === "UNAUTHORIZED" && start(D, t2.token, "C1", "RM-NOPE").code === "NO_ROOM", "starting a session in another teacher's room -> UNAUTHORIZED; unknown room -> NO_ROOM");
  const s1 = start(D, t1.token, "C1", r1.room.room_id), s2 = start(D, t2.token, "C1", r2.room.room_id), sA = start(D, A, "C1", rA.room.room_id);
  ok(s1.ok && s2.ok && sA.ok && new Set([s1.session_id, s2.session_id, sA.session_id]).size === 3, "three owners run the SAME course at the same time: three sessions");
  ok(start(D, t1.token, "C1", r1.room.room_id).session_id === s1.session_id, "a double tap by the same owner returns the same session");
  const n1 = start(D, t1.token, "Twin", ""), n2 = start(D, t2.token, "Twin", "");
  ok(n1.ok && n2.ok && n1.session_id !== n2.session_id, "twin check includes the owner: two teachers with the same course and no room get separate sessions");
  const srow = id => gas.sheets.AttSessions._g.find(r => r[0] === id);
  ok(srow(s1.session_id)[8] === t1.id && srow(s1.session_id)[9] === "Teacher One" && srow(sA.session_id)[8] === "ADMIN" && srow(sA.session_id)[9] === "Admin", "sessions are stamped with owner_user_id + owner_name (admin: ADMIN / Admin)");
  ok(gas.sent.some(m => /session started/i.test(m.text) && /Owner: Teacher One/.test(m.text)) && gas.sent.some(m => /Owner: Teacher Two/.test(m.text)), "Telegram session-start messages carry the owner's name");

  for (const [id, name, c] of [["1001", "Stu One", "a"], ["1002", "Stu Two", "b"]]) ok(reg(E, s1.session_id, id, name, c).ok, "register " + id + " via teacher one's session");
  for (const [id, name, c] of [["2001", "Stu Three", "c"], ["2002", "Stu Four", "d"]]) ok(reg(E, s2.session_id, id, name, c).ok, "register " + id + " via teacher two's session");
  ok(att(E, s1.session_id, "1001", "a").ok && att(E, s1.session_id, "1002", "b", { denied: true, reason: "TIMEOUT" }).ok && att(E, s2.session_id, "2001", "c").ok && att(E, s2.session_id, "2002", "d", { denied: true, reason: "PERMISSION_DENIED" }).ok, "four check-ins (two flagged)");
  ok(reg(E, s2.session_id, "3003", "Reg Only", "e").ok, "a student registers in teacher two's session but never checks in");
  // a student asks for a device change at each session
  const cd1 = E.D({ action: "att_change_device", ticket: tk(gas, s1.session_id), student_id: "1001", new_secret: sec("x"), fp: "other" });
  const cd2 = E.D({ action: "att_change_device", ticket: tk(gas, s2.session_id), student_id: "2001", new_secret: sec("y"), fp: "other" });
  ok(cd1.status === "pending" && cd2.status === "pending", "two device-change requests, one per session");
  const rq = tok => D({ action: "att_requests", token: tok }).requests.map(r => r.req_id).sort().join();
  ok(rq(t1.token) === cd1.req_id && rq(t2.token) === cd2.req_id && rq(A) === [cd1.req_id, cd2.req_id].sort().join(), "att_requests: each request goes to the teacher who owns the session the student scanned; admin sees all");
  const rqRow = D({ action: "att_requests", token: A }).requests.find(r => r.req_id === cd1.req_id);
  ok(rqRow.session_id === s1.session_id && rqRow.owner_user_id === t1.id && rqRow.new_secret_hash === undefined, "the request carries session_id + owner_user_id and never the secret hash");
  ok(D({ action: "att_live", token: t1.token, session_id: s1.session_id }).pending === 1 && D({ action: "att_live", token: t2.token, session_id: s2.session_id }).pending === 1 && D({ action: "att_live", token: A, session_id: s1.session_id }).pending === 2, "att_live pending counts only the caller's requests (admin: all)");
  const cd1b = E.D({ action: "att_change_device", ticket: tk(gas, s2.session_id), student_id: "1001", new_secret: sec("x"), fp: "other" });
  ok(cd1b.req_id === cd1.req_id && rq(t2.token).includes(cd1.req_id) && !rq(t1.token).includes(cd1.req_id), "asking again from a DIFFERENT teacher's session re-routes the pending request to that teacher");
  E.D({ action: "att_change_device", ticket: tk(gas, s1.session_id), student_id: "1001", new_secret: sec("x"), fp: "other" });   // and back
  ok(gas.sent.filter(m => /Device change request/.test(m.text) && /Owner: Teacher One/.test(m.text)).length >= 1, "Telegram device-request message names the owner");

  const first = (tok, sid) => D({ action: "att_session_detail", token: tok, session_id: sid }).checkins[0];
  const c1id = detail(D, s1.session_id).checkins.find(c => c.student_id === "1001").checkin_id, c2id = detail(D, s2.session_id).checkins.find(c => c.student_id === "2001").checkin_id;
  console.log("foreign ids: teacher two against teacher one's data (and the reverse)");
  const foreign = [
    ["att_live", { session_id: s1.session_id }], ["att_close_session", { session_id: s1.session_id }], ["att_flagged", { session_id: s1.session_id }], ["att_export", { session_id: s1.session_id }],
    ["att_session_detail", { session_id: s1.session_id }], ["att_review", { checkin_id: c1id, decision: "accepted", note: "x" }], ["att_decide_request", { req_id: cd1.req_id, decision: "approve" }],
    ["att_start_session", { course: "C", room_id: r1.room.room_id }],
  ];
  for (const [a, extra] of foreign) ok(D(Object.assign({ action: a, token: t2.token }, extra)).code === "UNAUTHORIZED", "teacher two -> " + a + " on teacher one's id -> UNAUTHORIZED");
  for (const [a, extra] of [["att_live", { session_id: s2.session_id }], ["att_close_session", { session_id: s2.session_id }], ["att_session_detail", { session_id: s2.session_id }], ["att_review", { checkin_id: c2id, decision: "accepted" }], ["att_export", { session_id: s2.session_id }]])
    ok(D(Object.assign({ action: a, token: t1.token }, extra)).code === "UNAUTHORIZED", "teacher one -> " + a + " on teacher two's id -> UNAUTHORIZED");
  ok(D({ action: "att_session_detail", token: t1.token, session_id: "S-NOPE" }).code === "NO_SESSION" && D({ action: "att_export", token: t1.token, session_id: "S-NOPE" }).code === "NO_SESSION" && D({ action: "att_close_session", token: t1.token, session_id: "S-NOPE" }).code === "NO_SESSION" &&
     D({ action: "att_review", token: t1.token, checkin_id: "C-NOPE", decision: "accepted" }).code === "NO_CHECKIN", "ids that do not exist: NO_SESSION / NO_CHECKIN");
  ok(D({ action: "att_session_detail", token: t1.token, session_id: s1.session_id }).ok && D({ action: "att_session_detail", token: t1.token, session_id: s1.session_id }).checkins.length === 2, "...while teacher one reads their own session fine");
  console.log("lists never mix");
  const sess = tok => D({ action: "att_sessions", token: tok, limit: 200 }).sessions.map(s => s.session_id).sort().join();
  ok(sess(t1.token) === [s1.session_id, n1.session_id].sort().join() && sess(t2.token) === [s2.session_id, n2.session_id].sort().join(), "att_sessions: each teacher lists only their own");
  ok(sess(A).split(",").length >= 5 && D({ action: "att_sessions", token: A, user_id: t1.id }).sessions.every(s => s.owner_user_id === t1.id), "att_sessions: admin sees all and can filter by teacher");
  ok(sess(t2.token) === D({ action: "att_sessions", token: t2.token, user_id: t1.id, role: "admin", user: { role: "admin" }, _u: { role: "admin" } }).sessions.map(s => s.session_id).sort().join(), "user_id / role / user / _u in the payload cannot widen a teacher's scope");
  const fl = tok => D({ action: "att_flagged", token: tok }).rows.map(r => r.student_id).sort().join();
  ok(fl(t1.token) === "1002" && fl(t2.token) === "2002" && fl(A) === "1002,2002", "att_flagged (no session id): own rows only; admin all");
  const ro1 = D({ action: "att_roster", token: t1.token }), ro2 = D({ action: "att_roster", token: t2.token }), roA = D({ action: "att_roster", token: A });
  ok(ro1.students.map(s => s.student_id).sort().join() === "1001,1002" && ro2.students.map(s => s.student_id).sort().join() === "2001,2002", "att_roster: a teacher's students = those who checked in to THEIR sessions");
  ok(ro1.sessions.every(s => s.owner_user_id === t1.id) && ro1.courses.sort().join() === "C1,Twin" && ro1.marks.every(m => m[0] === s1.session_id || m[0] === n1.session_id), "att_roster: own sessions, own courses, own marks");
  ok(roA.students.length === 5 && roA.sessions.length >= 5, "att_roster: admin sees every active student and every session (unchanged behaviour)");
  ok(D({ action: "att_roster", token: A, user_id: t2.id }).students.map(s => s.student_id).sort().join() === "2001,2002", "att_roster: admin may filter by teacher");
  const lv1 = D({ action: "att_live", token: t1.token, session_id: s1.session_id }), lvA = D({ action: "att_live", token: A, session_id: s1.session_id });
  ok(lv1.registered === 2 && lv1.present === 2 && lv1.flagged === 1 && lvA.registered === 5, "att_live: registered = the teacher's own students (admin: everyone)");
  const reasonsOf = f => f.filter(e => e.k === "reg").map(e => e.id).join();
  ok(!reasonsOf(lv1.feed).includes("3003") && !reasonsOf(D({ action: "att_live", token: t2.token, session_id: s2.session_id }).feed).includes("3003") && reasonsOf(lvA.feed).includes("3003"), "live feed: a teacher does not see registrations that belong to someone else's session");
  ok(!JSON.stringify(lv1).includes("Stu Three") && !JSON.stringify(lv1).includes("2001"), "teacher one's live payload mentions no student of teacher two");
  console.log("decisions");
  ok(D({ action: "att_decide_request", token: t1.token, req_id: cd1.req_id, decision: "approve" }).ok, "teacher one approves the request routed to them");
  ok(D({ action: "att_decide_request", token: t1.token, req_id: cd2.req_id, decision: "deny" }).code === "UNAUTHORIZED" && D({ action: "att_decide_request", token: A, req_id: cd2.req_id, decision: "deny" }).ok, "teacher one cannot decide teacher two's request; the admin can decide any");
  ok(D({ action: "att_decide_request", token: t1.token, req_id: "R-NOPE", decision: "approve" }).code === "NO_REQUEST", "unknown request -> NO_REQUEST");
  const cl = D({ action: "att_close_session", token: A, session_id: s2.session_id });
  ok(cl.ok && cl.summary.present === 2 && cl.summary.flagged === 1 && D({ action: "att_close_session", token: t1.token, session_id: s1.session_id }).ok, "the admin may close a teacher's session; a teacher closes their own");
  ok(gas.sent.some(m => /session closed/i.test(m.text) && /Owner: Teacher Two/.test(m.text)), "Telegram close message names the owner");
  const ex1 = D({ action: "att_export", token: t1.token, session_id: s1.session_id }).csv.split("\r\n");
  ok(ex1[0] === "student_id,name,server_utc,status,flags,dist_m,acc,geo_reason,review_status,review_note" && ex1.length === 3 && ex1.some(l => /^1002,Stu Two,.*GEO_UNAVAILABLE.*TIMEOUT/.test(l)), "export: own rows, with geo_reason + review columns");

  /* ───────────────────────── 4. review, history, overview ───────────────────────── */
  console.log("review");
  ok(D({ action: "att_review", token: t1.token, checkin_id: c1id, decision: "maybe" }).code === "BAD_REQUEST", "decision must be accepted|rejected");
  const rv = D({ action: "att_review", token: t1.token, checkin_id: c1id, decision: "rejected", note: "  seen   elsewhere  " });
  ok(rv.ok && rv.review_status === "rejected" && rv.review_note === "seen elsewhere" && rv.reviewed_by === t1.id && rv.reviewed_by_name === "Teacher One" && /^\d{4}-\d\d-\d\dT/.test(rv.reviewed_at), "review stores decision, cleaned note, reviewer and time");
  const d1 = crow(D, s1.session_id, "1001");
  ok(d1.review_status === "rejected" && d1.reviewed_by === t1.id && d1.reviewed_by_name === "Teacher One" && d1.review_note === "seen elsewhere", "...and att_session_detail shows it");
  const rv2 = D({ action: "att_review", token: A, checkin_id: c1id, decision: "accepted", note: "x".repeat(900) });
  ok(rv2.ok && rv2.review_note.length === 500 && crow(D, s1.session_id, "1001").reviewed_by === "ADMIN", "the admin may review any check-in; the last decision wins; notes are capped at 500 chars");
  console.log("history + overview");
  const det = D({ action: "att_session_detail", token: t1.token, session_id: s1.session_id });
  ok(det.session.owner_name === "Teacher One" && det.session.room_name === "Hall" && det.summary.present === 2 && det.summary.flagged === 1 && det.summary.unreviewed === 1 && det.summary.geo.GEO_UNAVAILABLE === 1, "session detail: header, summary (present / flagged / unreviewed / GEO_* counts)");
  const bad = det.checkins.find(c => c.student_id === "1002");
  ok(bad.geo_reason === "TIMEOUT" && bad.flags === "GEO_UNAVAILABLE" && bad.status === "review" && bad.lat === null && bad.dist_m === null && bad.name === "Stu Two", "check-in rows: flags, geo_reason, null coordinates for a failed fix, name");
  ok(det.checkins.every((c, i, a) => i === 0 || a[i - 1].server_utc <= c.server_utc) && !JSON.stringify(det).match(/fp_hash|secret|device_id/), "rows are in time order and carry no device data");
  const ov = D({ action: "att_overview", token: A });
  const sum = (arr, k) => arr.reduce((n, x) => n + x[k], 0);
  ok(ov.ok && ov.totals.sessions === sum(ov.by_user, "sessions") && ov.totals.sessions === sum(ov.by_day, "sessions") && ov.totals.present === sum(ov.by_user, "present") && ov.totals.present === 4, "overview: totals equal the per-user and per-day sums");
  const ouT1 = ov.by_user.find(u => u.user_id === t1.id), ouT2 = ov.by_user.find(u => u.user_id === t2.id);
  ok(ouT1.name === "Teacher One" && ouT1.present === 2 && ouT1.flagged === 1 && ouT1.unreviewed === 1 && ouT1.geo.GEO_UNAVAILABLE === 1 && ouT2.geo.GEO_DENIED === 1 && ouT2.unreviewed === 1, "overview per user: sessions, present, flagged, unreviewed, GEO_* counts");
  ok(ov.by_user.some(u => u.user_id === "ADMIN" && u.name === "Admin") && ov.by_user.length === 3 && ov.by_day[0].day === new Date().toISOString().slice(0, 10), "overview lists every account (and the admin), and days are UTC dates");
  ok(D({ action: "att_overview", token: A, from: "2999-01-01" }).totals.sessions === 0 && D({ action: "att_overview", token: A, to: "2000-01-01" }).totals.sessions === 0, "overview date filters (from / to)");
  const today = new Date().toISOString().slice(0, 10);
  ok(D({ action: "att_overview", token: A, from: today, to: today }).totals.sessions === ov.totals.sessions, "a date-only `to` covers that whole day");
  ok(D({ action: "att_overview", token: A, from: "not-a-date" }).code === "BAD_REQUEST" && D({ action: "att_sessions", token: t1.token, to: "zzz" }).code === "BAD_REQUEST", "bad dates -> BAD_REQUEST");
  console.log("session list paging");
  const P = env(), pt = mkUser(P.D, "Pager"), other = mkUser(P.D, "Other");
  const ids5 = [];
  for (let i = 0; i < 5; i++) { const s = start(P.D, pt.token, i % 2 ? "Odd" : "Even", ""); ids5.push(s.session_id); P.gas.sheets.AttSessions._g.find(r => r[0] === s.session_id)[3] = new Date(Date.UTC(2026, 9, 10 + i, 9)).toISOString(); P.gas.run(`att_cdel_("att:s:${s.session_id}")`); P.gas.sheets.AttSessions._g.find(r => r[0] === s.session_id)[5] = "closed"; }
  start(P.D, other.token, "Even", "");
  const pg = [], seen = []; let cur = null;
  do { const r = P.D({ action: "att_sessions", token: pt.token, limit: 2, cursor: cur || undefined }); pg.push(r.sessions.length); r.sessions.forEach(s => seen.push(s.session_id)); cur = r.next_cursor; } while (cur);
  ok(pg.join() === "2,2,1" && seen.join() === ids5.slice().reverse().join(), "paging with limit 2: pages 2,2,1, newest first, no repeats, never another teacher's");
  ok(P.D({ action: "att_sessions", token: pt.token, course: "Odd" }).sessions.length === 2 && P.D({ action: "att_sessions", token: pt.token, from: "2026-10-12", to: "2026-10-13" }).sessions.length === 2, "course and date filters");
  ok(P.D({ action: "att_sessions", token: A, user_id: other.id }).sessions.length === 1, "admin filter by teacher");
  console.log("orphan check-in");
  {
    const o = env(), ot = mkUser(o.D, "Orph"), R = room(o.D, ot.token, "H"), S = start(o.D, ot.token, "C", R.room.room_id);
    reg(o, S.session_id, "7001", "Orphan", "o"); att(o, S.session_id, "7001", "o");
    const id = detail(o.D, S.session_id).checkins[0].checkin_id;
    o.gas.sheets.AttSessions._g.splice(o.gas.sheets.AttSessions._g.findIndex(r => r[0] === S.session_id), 1); o.gas.run(`att_cdel_("att:s:${S.session_id}")`);
    ok(o.D({ action: "att_review", token: ot.token, checkin_id: id, decision: "accepted" }).code === "UNAUTHORIZED" && o.D({ action: "att_review", token: A, checkin_id: id, decision: "accepted" }).ok, "a check-in whose session row is gone can only be reviewed by the admin");
  }

  /* ───────────────────────── 5. location reasons ───────────────────────── */
  console.log("location failure reasons -> flags, geo_reason, diagnostics");
  const G = env(), gt = mkUser(G.D, "Geo"), gR = room(G.D, gt.token, "H"), gS = start(G.D, gt.token, "C", gR.room.room_id), gsid = gS.session_id;
  const cases = [["PERMISSION_DENIED", "GEO_DENIED"], ["POSITION_UNAVAILABLE", "GEO_UNAVAILABLE"], ["TIMEOUT", "GEO_UNAVAILABLE"], ["UNSUPPORTED", "GEO_UNAVAILABLE"], ["INSECURE_CONTEXT", "GEO_UNAVAILABLE"], ["USER_SKIPPED", "GEO_SKIPPED"]];
  let n = 0;
  for (const [reason, flag] of cases) {
    const id = String(8100 + n++), c = String.fromCharCode(97 + n);
    reg(G, gsid, id, "Geo " + id, c);
    const r = att(G, gsid, id, c, { denied: true, reason }, { diag: { perm: "denied", attempts: 2, online: false, inapp: true } });
    const row = crow(G.D, gsid, id);
    ok(r.ok && row.flags === flag && row.geo_reason === reason && row.status === "review" && row.lat === null, reason + " -> " + flag + ", geo_reason stored, status review");
  }
  const logOf = id => flagLog(G.gas).filter(l => l.student === id);
  ok(logOf("8100")[0].detail === "reason=PERMISSION_DENIED;perm=denied;att=2;online=0;inapp=1", "AttFlagLog keeps the reason + diagnostics (perm, attempts, online, in-app) for the next investigation");
  reg(G, gsid, "8200", "Old Client", "q");
  const old = att(G, gsid, "8200", "q", { denied: true });
  ok(old.ok && crow(G.D, gsid, "8200").flags === "GEO_DENIED" && crow(G.D, gsid, "8200").geo_reason === "PERMISSION_DENIED" && logOf("8200")[0].detail === "reason=PERMISSION_DENIED;diag=none", "old payload {denied:true} without reason/diag: still accepted, treated as PERMISSION_DENIED");
  reg(G, gsid, "8201", "Injector", "r");
  att(G, gsid, "8201", "r", { denied: true, reason: "TIMEOUT;owner=9999" }, { diag: { perm: "x;owner=99", attempts: "abc", online: "maybe", inapp: 7 } });
  ok(crow(G.D, gsid, "8201").geo_reason === "PERMISSION_DENIED" && logOf("8201")[0].detail === "reason=PERMISSION_DENIED;perm=unknown;att=0;online=?;inapp=?" && !logOf("8201")[0].detail.includes("owner="), "an unknown reason and junk diagnostics are whitelisted: nothing can be injected into the log");
  reg(G, gsid, "8203", "Skip", "k"); att(G, gsid, "8203", "k", { denied: true, reason: "USER_SKIPPED" }, { diag: { perm: "denied", attempts: 2, online: true, inapp: false, fail_reason: "TIMEOUT" } });
  ok(crow(G.D, gsid, "8203").flags === "GEO_SKIPPED" && /;fail=TIMEOUT$/.test(logOf("8203")[0].detail), "S1 diag.fail_reason (the real failure behind a skipped check-in) is kept in the flag log, whitelisted");
  reg(G, gsid, "8202", "Big", "s"); att(G, gsid, "8202", "s", { denied: true, reason: "TIMEOUT" }, { diag: { attempts: 500 } });
  ok(/att=99;/.test(logOf("8202")[0].detail), "attempts is bounded");
  for (const [i, g] of [[0, { lat: 200, lng: 10, acc: 5 }], [1, { lat: "", lng: "", acc: 5 }], [2, { lat: null, lng: 31 }], [3, { lat: true, lng: 31 }]]) {
    const id = String(8300 + i), c = String.fromCharCode(65 + i); reg(G, gsid, id, "Bad " + id, c); att(G, gsid, id, c, g);
    ok(crow(G.D, gsid, id).flags === "GEO_DENIED" && crow(G.D, gsid, id).lat === null, "unusable coordinates " + JSON.stringify(g) + " -> treated as a failed fix (GEO_DENIED), nothing stored");
  }
  reg(G, gsid, "8400", "Good", "t"); const good = att(G, gsid, "8400", "t", { lat: 31.2, lng: 29.9, acc: 10 }, { diag: { perm: "granted", attempts: 1, online: true, inapp: false } });
  ok(good.ok && crow(G.D, gsid, "8400").flags === "" && crow(G.D, gsid, "8400").geo_reason === "" && logOf("8400").length === 0 && !("flags" in good), "a good fix: no flags, no geo_reason, nothing logged, no flags returned to the student");
  ok(gas.sent.length > 0 && gas.sent.every(m => m.chat === "111"), "Telegram goes only to the admin chat");

  /* ───────────────────────── 6. upgrade rule ───────────────────────── */
  console.log("upgrade rule (plan §4.3)");
  const U = env(), ut = mkUser(U.D, "Upg"), uR = room(U.D, ut.token, "H"), uS = start(U.D, ut.token, "C", uR.room.room_id), usid = uS.session_id;
  const rowsOf = id => U.gas.sheets.AttCheckins._g.filter(r => r[1] === usid && r[2] === id);
  reg(U, usid, "9001", "Upgrader", "u");
  const bad1 = att(U, usid, "9001", "u", { denied: true, reason: "TIMEOUT" }, { diag: { perm: "granted", attempts: 2, online: true, inapp: false } });
  const t0 = crow(U.D, usid, "9001").server_utc, tg0 = U.gas.sent.length;
  ok(bad1.ok && !bad1.upgraded && crow(U.D, usid, "9001").flags === "GEO_UNAVAILABLE", "first attempt: no fix -> recorded and flagged GEO_UNAVAILABLE");
  const up = att(U, usid, "9001", "u", { lat: 31.2, lng: 29.9, acc: 12 });
  const after = crow(U.D, usid, "9001");
  ok(up.ok && up.status === "recorded" && up.upgraded === true && Object.keys(up).sort().join() === "name,ok,server_utc,status,upgraded", "later attempt WITH a fix -> {status:'recorded', upgraded:true} and nothing else leaks");
  ok(rowsOf("9001").length === 1 && after.lat === 31.2 && after.lng === 29.9 && after.acc === 12 && after.dist_m !== null && after.geo_reason === "" && after.flags === "" && after.status === "ok", "the SAME row is updated: coordinates, distance, accuracy; geo_reason cleared; flags + status recomputed");
  ok(after.server_utc === t0 && up.server_utc === t0, "the recorded time stays the original check-in time");
  ok(flagLog(U.gas).some(l => l.student === "9001" && l.code === "GEO_UPGRADED" && /^was=TIMEOUT;/.test(l.detail)) && U.gas.sheets.AttCheckins._g[1][10].indexOf("GEO_UPGRADED") < 0, "GEO_UPGRADED goes to AttFlagLog only, never into the check-in's flags");
  ok(U.gas.sent.length === tg0, "an upgrade that leaves no flags sends no Telegram alert");
  const down = att(U, usid, "9001", "u", { denied: true, reason: "PERMISSION_DENIED" });
  ok(down.ok && !down.upgraded && crow(U.D, usid, "9001").lat === 31.2 && crow(U.D, usid, "9001").status === "ok" && rowsOf("9001").length === 1, "a good fix is never downgraded by a later bad attempt");
  const again = att(U, usid, "9001", "u", { lat: 31.3, lng: 29.9, acc: 5 });
  ok(again.ok && !again.upgraded && crow(U.D, usid, "9001").lat === 31.2, "a later GOOD attempt does not overwrite a good fix (duplicate behaviour unchanged)");
  reg(U, usid, "9002", "Bad Twice", "v"); att(U, usid, "9002", "v", { denied: true, reason: "TIMEOUT" });
  const twice = att(U, usid, "9002", "v", { denied: true, reason: "USER_SKIPPED" });
  ok(twice.ok && !twice.upgraded && crow(U.D, usid, "9002").geo_reason === "TIMEOUT" && crow(U.D, usid, "9002").flags === "GEO_UNAVAILABLE", "two failures in a row change nothing (first reason kept)");
  reg(U, usid, "9003", "Far Away", "w"); att(U, usid, "9003", "w", { denied: true, reason: "TIMEOUT" });
  const tg1 = U.gas.sent.length, far = att(U, usid, "9003", "w", { lat: 31.25, lng: 29.9, acc: 10 });
  ok(far.upgraded === true && crow(U.D, usid, "9003").flags === "GEO_FAR" && crow(U.D, usid, "9003").status === "review", "an upgrade with a fix far from the hall is flagged GEO_FAR (review)");
  U.gas.run("att_flushDigest()");
  ok(U.gas.sent.length > tg1 && /GEO_FAR/.test(U.gas.sent[U.gas.sent.length - 1].text) && /Upg/.test(U.gas.sent[U.gas.sent.length - 1].text), "...and Telegram is told, with the owner's name");
  // the repaired row must not count as its own "prior flagged" (REPEATED)
  const olds = [start(U.D, ut.token, "Old1", uR.room.room_id), start(U.D, ut.token, "Old2", uR.room.room_id), start(U.D, ut.token, "Old3", uR.room.room_id)];
  const prev = (c, sids) => { reg(U, usid, c.id, c.name, c.s); sids.forEach(sid => att(U, sid, c.id, c.s, { denied: true, reason: "TIMEOUT" })); };
  prev({ id: "9010", name: "Two Before", s: "x" }, olds.slice(0, 2).map(s => s.session_id));
  prev({ id: "9011", name: "Three Before", s: "y" }, olds.map(s => s.session_id));
  att(U, usid, "9010", "x", { denied: true, reason: "TIMEOUT" }); att(U, usid, "9011", "y", { denied: true, reason: "TIMEOUT" });
  att(U, usid, "9010", "x", { lat: 31.2, lng: 29.9, acc: 9 }); att(U, usid, "9011", "y", { lat: 31.2, lng: 29.9, acc: 9 });
  ok(crow(U.D, usid, "9010").flags === "" && crow(U.D, usid, "9010").status === "ok", "student with 2 earlier flagged check-ins: the row being repaired is NOT counted as its own prior (no REPEATED)");
  ok(crow(U.D, usid, "9011").flags === "REPEATED" && crow(U.D, usid, "9011").status === "review", "...while 3 genuine earlier flagged check-ins still earn REPEATED");

  /* ───────────────────────── 7. tickets, constants, hardening ───────────────────────── */
  console.log("tickets + constants + dispatcher");
  const T = env(), tt = mkUser(T.D, "Tick"), tR = room(T.D, tt.token, "H"), tS = start(T.D, tt.token, "C", tR.room.room_id);
  ok(T.gas.run("ATT_C.TICKET_SEC") === 240, "TICKET_SEC is 240");
  const tokenNow = () => T.gas.ctx.att_token_(tS.session_key, tS.session_id, Math.floor(Date.now() / 10000));
  const tkt = () => T.D({ action: "att_ticket", session_id: tS.session_id, token: tokenNow() });
  const t240 = tkt();
  ok(t240.ok && Math.abs(t240.expires_at - (Date.now() + 240000)) < 3000, "a ticket lives 240 s");
  const row = T.gas.sheets.AttSessions._g.find(r => r[0] === tS.session_id);
  row[3] = new Date(Date.now() - 200000).toISOString(); row[4] = new Date(Date.now() - 200000 + 300000).toISOString(); T.gas.run(`att_cdel_("att:s:${tS.session_id}")`);
  const capped = tkt();
  ok(capped.ok && capped.expires_at <= Date.parse(row[4]) && capped.expires_at > Date.now(), "near the end of the session the ticket is CAPPED by the close time (about 100 s, not 240)");
  row[4] = new Date(Date.now() - 1000).toISOString(); T.gas.run(`att_cdel_("att:s:${tS.session_id}")`);
  ok(tkt().code === "SESSION_CLOSED", "no ticket once the close time has passed");
  ok(T.gas.run("ATT_C.GEO_HIGH_TIMEOUT_MS === ATTF_CFG.GEO_HIGH_TIMEOUT_MS && ATT_C.GEO_LOW_TIMEOUT_MS === ATTF_CFG.GEO_LOW_TIMEOUT_MS && ATT_C.GEO_MAX_AGE_MS === ATTF_CFG.GEO_MAX_AGE_MS && ATT_C.GEO_SKIP_AFTER_FAILS === ATTF_CFG.GEO_SKIP_AFTER_FAILS && ATT_C.SUBMIT_WATCHDOG_MS === ATTF_CFG.SUBMIT_WATCHDOG_MS"), "ATT_C and ATTF_CFG agree on the student-page constants");
  const CFG = require(path.join(site, "contract/att_config.js"));
  if (CFG.GEO_HIGH_TIMEOUT_MS === undefined) console.log("  --  contract/att_config.js has no geo constants yet (Session 1 not landed): parity check skipped");
  else {
    const keys = ["TICKET_SEC", "GEO_HIGH_TIMEOUT_MS", "GEO_LOW_TIMEOUT_MS", "GEO_MAX_AGE_MS", "GEO_SKIP_AFTER_FAILS", "SUBMIT_WATCHDOG_MS", "WINDOW_SEC", "GRACE_SEC", "SESSION_MIN", "GEO_RADIUS_M", "GEO_WEAK_ACC_M"];
    ok(keys.every(k => CFG[k] === T.gas.run("ATT_C." + k)), "contract/att_config.js and ATT_C hold identical frozen constants");
  }
  for (const a of ["constructor", "__proto__", "toString", "hasOwnProperty", "att_nope"]) ok(T.D({ action: a, token: A }).code === "UNKNOWN_ACTION" && T.D({ action: a }).code === "UNKNOWN_ACTION", "action '" + a + "' -> UNKNOWN_ACTION");
  for (const a of ["att_me", "att_sessions", "att_session_detail", "att_review", "att_live", "att_close_session", "att_flagged", "att_export", "att_roster", "att_rooms", "att_requests", "att_calibrate_room", "att_start_session", "att_decide_request"])
    ok(T.D({ action: a }).code === "UNAUTHORIZED" && T.D({ action: a, token: "nope" }).code === "UNAUTHORIZED", a + " without a valid token -> UNAUTHORIZED");
  ok(T.D({ action: "att_status", session_id: tS.session_id }).ok, "student actions stay open (att_status needs no token)");

  console.log("\n" + pass + " multi-user checks passed");
})().catch(e => { console.error("\nFAIL:", e.stack || e.message); process.exit(1); });
