// Unit tests for the flag engine (AttFlags section of AttendanceAll.gs, pure). node tests/attendance/flags.test.js
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const ctx = vm.createContext({ console, Date, Math, Number, String, isFinite, Object });
// The flag engine lives inside the deployed AttendanceAll.gs (section "from AttFlags.gs"); it is pure, so the whole file loads into a bare context.
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "..", "tools", "quiz-maker-v2", "apps_script", "AttendanceAll.gs"), "utf8"), ctx, { filename: "AttendanceAll.gs" });
const run = c => vm.runInContext("att_runFlags_", ctx)(c);
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log("  ok  " + m); };
const HALL = { lat: 31.2, lng: 29.9 }, S = { session_id: "S1" }, T0 = "2026-10-27T09:00:00.000Z";
const base = o => Object.assign({ session: S, student_id: "1001", device_id: "D1", fp: "fpA", geo: { lat: 31.2, lng: 29.9, acc: 10 }, serverUtc: T0, hall: HALL, priorCheckins: [] }, o);
const prior = o => Object.assign({ session_id: "S1", student_id: "2002", server_utc: T0, lat: 31.2, lng: 29.9, acc: 10, fp_hash: "fpA", flags: [], status: "ok" }, o);

ok(JSON.stringify(run(base())) === "[]", "in the hall, accurate fix: no flags");
ok(run(base({ geo: { denied: true } })).join() === "GEO_DENIED", "denied location -> GEO_DENIED");
ok(run(base({ geo: { lat: 31.21, lng: 29.9, acc: 20 } })).includes("GEO_FAR"), "~1.1 km away -> GEO_FAR");
ok(!run(base({ geo: { lat: 31.2008, lng: 29.9, acc: 20 } })).includes("GEO_FAR"), "89 m away is inside the radius");
ok(!run(base({ geo: { lat: 31.2013, lng: 29.9, acc: 60 } })).includes("GEO_FAR"), "dist - acc <= 100 is NOT far (accuracy circle may reach the hall)");
ok(run(base({ geo: { lat: 31.2, lng: 29.9, acc: 151 } })).join() === "GEO_WEAK", "acc > 150 -> GEO_WEAK only (soft)");
ok(run(base({ hall: null, geo: { lat: 10, lng: 10, acc: 5 } })).join() === "", "no room configured: distance cannot be judged, no GEO_FAR");
ok(run(base({ priorCheckins: [prior({ lat: 31.200005 })] })).join() === "SAME_PHONE_MULTI_ID", "same fp, other ID, <10 m, <60 s -> SAME_PHONE_MULTI_ID");
ok(!run(base({ priorCheckins: [prior({ server_utc: "2026-10-27T08:58:00.000Z" })] })).includes("SAME_PHONE_MULTI_ID"), "...not if >60 s apart");
ok(!run(base({ priorCheckins: [prior({ lat: 31.2002 })] })).includes("SAME_PHONE_MULTI_ID"), "...not if >10 m apart");
ok(!run(base({ priorCheckins: [prior({ fp_hash: "other" })] })).includes("SAME_PHONE_MULTI_ID"), "...not if fingerprints differ");
ok(!run(base({ priorCheckins: [prior({ student_id: "1001" })] })).includes("SAME_PHONE_MULTI_ID"), "...not for the same student scanning twice");
ok(!run(base({ priorCheckins: [prior({ session_id: "OLD" })] })).includes("SAME_PHONE_MULTI_ID"), "...not across different sessions");
const same = id => prior({ student_id: id, fp_hash: "x" + id, server_utc: "2026-10-27T08:30:00.000Z" });
ok(run(base({ priorCheckins: [same("2"), same("3")] })).includes("IDENTICAL_COORDS"), "3 IDs with identical lat/lng/acc -> IDENTICAL_COORDS");
ok(!run(base({ priorCheckins: [same("2")] })).includes("IDENTICAL_COORDS"), "...2 IDs is not enough");
ok(!run(base({ priorCheckins: [same("2"), prior({ student_id: "3", acc: 10.5, fp_hash: "z" })] })).includes("IDENTICAL_COORDS"), "...a different accuracy is not identical");
ok(!run(base({ priorCheckins: [same("2"), same("2")] })).includes("IDENTICAL_COORDS"), "...the same other ID twice counts once");
const bad = n => Array.from({ length: n }, (_, i) => prior({ session_id: "OLD" + i, student_id: "1001", status: "review", fp_hash: "q" }));
ok(run(base({ priorCheckins: bad(3) })).includes("REPEATED"), "3 earlier flagged check-ins -> REPEATED");
ok(!run(base({ priorCheckins: bad(2) })).includes("REPEATED"), "...2 is not enough");
ok(!run(base({ priorCheckins: bad(3).map(p => Object.assign(p, { student_id: "9" })) })).includes("REPEATED"), "...other students' flags do not count");
ok(run(base({ geo: { denied: true }, priorCheckins: bad(3) })).join() === "GEO_DENIED,REPEATED", "flags combine in a stable order");
ok(run({ session: S, student_id: "1", geo: null, serverUtc: T0 }).join() === "GEO_DENIED", "sparse ctx (no geo/priors/hall) does not throw");

// --- location failure reasons -> flags (MASTER_PLAN_ATTENDANCE_MULTIUSER section 4.2) ---
const why = r => run(base({ geo: { denied: true, reason: r } })).join();
ok(why("PERMISSION_DENIED") === "GEO_DENIED", "PERMISSION_DENIED -> GEO_DENIED");
ok(why(undefined) === "GEO_DENIED", "missing reason (old client) -> GEO_DENIED");
ok(why("SOMETHING_NEW") === "GEO_DENIED", "unknown reason -> GEO_DENIED (fails closed)");
["POSITION_UNAVAILABLE", "TIMEOUT", "UNSUPPORTED", "INSECURE_CONTEXT"].forEach(r => ok(why(r) === "GEO_UNAVAILABLE", r + " -> GEO_UNAVAILABLE"));
ok(why("USER_SKIPPED") === "GEO_SKIPPED", "USER_SKIPPED -> GEO_SKIPPED");
ok(why(" timeout ") === "GEO_UNAVAILABLE", "reason is trimmed and case-insensitive");
ok(why("constructor") === "GEO_DENIED" && why("__proto__") === "GEO_DENIED", "object-prototype names are not reasons");
ok(vm.runInContext("att_flagsToStatus_", ctx)(["GEO_UNAVAILABLE"]) === "review" && vm.runInContext("att_flagsToStatus_", ctx)(["GEO_SKIPPED"]) === "review", "GEO_UNAVAILABLE and GEO_SKIPPED put the check-in in review");
ok(vm.runInContext("att_flagsToStatus_", ctx)(["GEO_WEAK"]) === "ok", "GEO_WEAK stays soft");
ok(run(base({ geo: { denied: true, reason: "TIMEOUT" }, priorCheckins: bad(3) })).join() === "GEO_UNAVAILABLE,REPEATED", "reason flag combines with the other flags in a stable order");
console.log("\n" + pass + " flag checks passed");
