/* ===========================================================================
 * AttendanceAll.gs: the whole attendance backend in ONE file.
 * Merged from: Attendance.gs, AttSetup.gs, AttFlags.gs, AttTelegram.gs.
 * Add it to the SAME Apps Script project as Code.gs (Code.gs needs only the one att_route_ hook line).
 * Multi-user (MASTER_PLAN_ATTENDANCE_MULTIUSER, Session 2): accounts + login live in the last section of this file,
 * which MUST be added to the same project. After pasting both files run att_migrate() ONCE, then att_selfTest().
 * Telegram: uses its OWN bot (ATT_TG_* Script Properties), never the main site's bot.
 * =========================================================================== */

// Attendance spreadsheet. Used when the ATT_SHEET_ID script property is not set yet.
var ATT_DEFAULT_SHEET_ID = "19RYNRfY9JisKs27YhqwXFEL0AuTFrXsiVPfaWzZ1_5w";

/** Run from the editor's function dropdown for the first-time setup. */
function runSetup() { return att_setup(ATT_DEFAULT_SHEET_ID); }



/* ############################################################
 * ### from Attendance.gs
 * ############################################################ */
/* Attendance.gs — Session 1 (backend core). Implements MASTER-SPEC §2–§4. Entry point: att_dispatch_(payload).
 * Depends only through the §5 interface on: att_runFlags_(ctx) and att_notify_(event,data)  (AttStubs.gs until S2 lands).
 * All sheet values are written as text (see AttSetup.gs); numbers are re-parsed with Number() on read.
 */
var ATT_C = {
  WINDOW_SEC: 10, GRACE_SEC: 3, TICKET_SEC: 240, SESSION_MIN: 5,   // TICKET_SEC is FROZEN: change it in contract/att_config.js, here, the emulator and the test vectors together
  GEO_RADIUS_M: 100, GEO_WEAK_ACC_M: 150, ID_REGEX: /^[0-9]{4,12}$/,
  NAME_MAX: 60, TOKEN_LEN: 16, CACHE_SEC: 60, LOCK_MS: 25000, DUP_START_MS: 20000,
  // student page (plan section 3). The server does not use these; they are kept here so both sides stay identical (tests/attendance/multiuser.test.js compares them)
  GEO_HIGH_TIMEOUT_MS: 20000, GEO_LOW_TIMEOUT_MS: 10000, GEO_MAX_AGE_MS: 60000, GEO_SKIP_AFTER_FAILS: 2, SUBMIT_WATCHDOG_MS: 30000,
  // multi-user (plan section 4.5)
  ADMIN_ID: "ADMIN", ADMIN_NAME: "Admin", USER_TOKEN_TTL_SEC: 12 * 3600, LOGIN_MAX_FAILS: 10, LOGIN_WINDOW_SEC: 300, LOGIN_LOCK_SEC: 300,
};
var ATT_SS_ = null; // per-execution spreadsheet handle

/* ───────── generic helpers ───────── */
function att_ok_(o) { o = o || {}; o.ok = true; return o; }
function att_err_(code, msg) { return { ok: false, error: msg || code, code: code }; }
function att_hex_(bytes) {
  return bytes.map(function (b) { var v = (b + 256) % 256; return (v < 16 ? "0" : "") + v.toString(16); }).join("");
}
function att_hmacHex_(key, msg) { return att_hex_(Utilities.computeHmacSha256Signature(String(msg), String(key))); }
function att_sha256Hex_(s) { return att_hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)); }
function att_eq_(a, b) {
  a = String(a); b = String(b); if (a.length !== b.length) return false;
  var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
function att_masterSecret_() {
  var s = PropertiesService.getScriptProperties().getProperty("ATT_MASTER_SECRET");
  if (!s) throw new Error("ATT_MASTER_SECRET missing - run att_setup()");
  return s;
}
function att_adminToken_() {
  var t = (typeof ADMIN_TOKEN !== "undefined") ? ADMIN_TOKEN : PropertiesService.getScriptProperties().getProperty("ADMIN_TOKEN");
  return t ? String(t) : "";
}
function att_requireAdmin_(p) {
  var t = att_adminToken_();
  return !!t && att_eq_(String(p.token || ""), t);
}
function att_iso_(d) { return (d || new Date()).toISOString(); }
function att_num_(v) { return (v === "" || v == null || isNaN(Number(v))) ? null : Number(v); }
function att_safeNotify_(event, data) { try { att_notify_(event, data); } catch (e) { console.error("notify " + event + ": " + e); } }

/* ───────── crypto (§2) ───────── */
function att_sessionKey_(sessionId, master) { return att_hmacHex_(master || att_masterSecret_(), "key:" + sessionId); }
function att_token_(sessionKey, sessionId, win) { return att_hmacHex_(sessionKey, sessionId + ":" + win).slice(0, ATT_C.TOKEN_LEN); }
function att_tokenOk_(sessionKey, sessionId, token, epochSec) {
  token = String(token || "").toLowerCase();
  var w = Math.floor(epochSec / ATT_C.WINDOW_SEC);
  if (att_eq_(token, att_token_(sessionKey, sessionId, w))) return true;
  if ((epochSec % ATT_C.WINDOW_SEC) < ATT_C.GRACE_SEC && att_eq_(token, att_token_(sessionKey, sessionId, w - 1))) return true;
  return false;
}
function att_makeTicket_(sessionId, deviceId, expSec, master) {
  var body = JSON.stringify({ s: sessionId, d: deviceId, e: expSec });
  var b64 = Utilities.base64EncodeWebSafe(body, Utilities.Charset.UTF_8).replace(/=+$/, "");
  var sig = att_hmacHex_(master || att_masterSecret_(), "tk:" + sessionId + ":" + deviceId + ":" + expSec).slice(0, 24);
  return b64 + "." + sig;
}
/** Returns {s,d,e} for a valid, unexpired ticket, else null. */
function att_checkTicket_(ticket, master, nowSec) {
  try {
    var parts = String(ticket || "").split(".");
    if (parts.length !== 2 || !parts[0]) return null;
    var padded = parts[0] + ["", "===", "==", "="][parts[0].length % 4];
    var o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
    if (typeof o.s !== "string" || typeof o.d !== "string" || typeof o.e !== "number") return null;
    var sig = att_hmacHex_(master || att_masterSecret_(), "tk:" + o.s + ":" + o.d + ":" + o.e).slice(0, 24);
    if (!att_eq_(sig, parts[1])) return null;
    if (o.e <= (nowSec != null ? nowSec : Math.floor(Date.now() / 1000))) return null;
    return o;
  } catch (e) { return null; }
}

/* ───────── sheets / cache / lock ───────── */
function att_ss_() {
  if (ATT_SS_) return ATT_SS_;
  var id = PropertiesService.getScriptProperties().getProperty("ATT_SHEET_ID") || ATT_DEFAULT_SHEET_ID;
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("No spreadsheet: run att_setup('<spreadsheetId>') or bind the script to the sheet");
  return (ATT_SS_ = ss);
}
function att_sheet_(name) {
  var sh = att_ss_().getSheetByName(name);
  if (!sh) throw new Error("Missing tab " + name + " - run att_setup()");
  return sh;
}
function att_rows_(name) {
  var sh = att_sheet_(name), n = sh.getLastRow(), keys = ATT_HEADERS[name];
  if (n < 2) return [];
  // A tab that has not been through att_migrate() yet has fewer columns than ATT_HEADERS: read what exists, the new columns read as "".
  var cols = Math.max(1, Math.min(keys.length, sh.getLastColumn() || keys.length));
  var v = sh.getRange(1, 1, n, cols).getValues(), h = v[0], out = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    keys.forEach(function (k) { o[k] = ""; });
    for (var j = 0; j < h.length; j++) o[h[j]] = v[i][j] === null ? "" : (typeof v[i][j] === "string" ? v[i][j] : String(v[i][j]));
    out.push(o);
  }
  return out;
}
/** One row of a tab as an object (same shape as att_rows_). */
function att_rowAt_(name, rowNo) {
  var sh = att_sheet_(name), keys = ATT_HEADERS[name], cols = Math.max(1, Math.min(keys.length, sh.getLastColumn() || keys.length));
  var v = sh.getRange(rowNo, 1, 1, cols).getValues()[0], o = { _row: rowNo };
  keys.forEach(function (k, j) { o[k] = (j < cols && v[j] != null) ? String(v[j]) : ""; });
  return o;
}
function att_append_(name, obj) {
  att_sheet_(name).appendRow(ATT_HEADERS[name].map(function (k) { return obj[k] == null ? "" : obj[k]; }));
}
function att_update_(name, row, obj) {
  var sh = att_sheet_(name), h = ATT_HEADERS[name];
  Object.keys(obj).forEach(function (k) { var c = h.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(obj[k]); });
}
function att_cget_(k) { try { var v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function att_cput_(k, o) { try { CacheService.getScriptCache().put(k, JSON.stringify(o), ATT_C.CACHE_SEC); } catch (e) {} }
function att_cdel_(k) { try { CacheService.getScriptCache().remove(k); } catch (e) {} }
function att_withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(ATT_C.LOCK_MS)) return att_err_("BUSY", "Server busy, try again");
  try { return fn(); } finally { lock.releaseLock(); }
}
function att_clean_(o) { var c = {}; Object.keys(o).forEach(function (k) { if (k !== "_row") c[k] = o[k]; }); return c; }

function att_getSession_(id) {
  id = String(id || ""); if (!id) return null;
  var c = att_cget_("att:s:" + id); if (c) return c;
  var r = att_rows_("AttSessions").filter(function (x) { return x.session_id === id; })[0];
  if (!r) return null;
  r = att_clean_(r); r.hall_lat = att_num_(r.hall_lat); r.hall_lng = att_num_(r.hall_lng);
  att_cput_("att:s:" + id, r); return r;
}
function att_getRoom_(id) {
  id = String(id || ""); if (!id) return null;
  var c = att_cget_("att:r:" + id); if (c) return c;
  var r = att_rows_("AttRooms").filter(function (x) { return x.room_id === id; })[0];
  if (!r) return null;
  r = att_clean_(r); r.lat = att_num_(r.lat); r.lng = att_num_(r.lng); r.samples = att_num_(r.samples);
  att_cput_("att:r:" + id, r); return r;
}
/** Device row by secret hash (prefers an active row). */
function att_getDevice_(hash) {
  var c = att_cget_("att:d:" + hash); if (c) return c;
  var rows = att_rows_("AttDevices").filter(function (x) { return x.secret_hash === hash; });
  if (!rows.length) return null;
  var r = rows.filter(function (x) { return x.status === "active"; })[0] || rows[0];
  r = att_clean_(r); att_cput_("att:d:" + hash, r); return r;
}
/** Student's display name (cached 60 s). Returns "" when unknown. */
function att_studentName_(sid) {
  var c = att_cget_("att:n:" + sid); if (c && typeof c.n === "string") return c.n;
  var r = att_rows_("AttStudents").filter(function (x) { return x.student_id === sid; })[0];
  if (!r) return "";
  att_cput_("att:n:" + sid, { n: r.name || "" }); return r.name || "";
}
function att_studentExists_(sid) {
  return att_rows_("AttStudents").some(function (x) { return x.student_id === sid; });
}
function att_isOpen_(s, nowMs) {
  return s.status === "open" && nowMs <= Date.parse(s.start_utc) + ATT_C.SESSION_MIN * 60000;
}
function att_haversine_(lat1, lng1, lat2, lng2) {
  var R = 6371000, rad = Math.PI / 180, dLa = (lat2 - lat1) * rad, dLo = (lng2 - lng1) * rad;
  var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function att_logFlag_(sessionId, studentId, code, detail) {
  try { att_append_("AttFlagLog", { ts_utc: att_iso_(), session_id: sessionId, student_id: studentId, code: code, detail: detail || "" }); } catch (e) { console.error("flaglog: " + e); }
}

/* ───────── multi-user scoping (plan §4.7) ───────── */
function att_adminUser_() { return { user_id: ATT_C.ADMIN_ID, name: ATT_C.ADMIN_NAME, role: "admin" }; }
function att_has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function att_unauthorized_() { return att_err_("UNAUTHORIZED", "Unauthorized"); }
/** Owner of a session / room / request row. Legacy rows (blank owner) belong to the admin. */
function att_ownerOf_(row) { var o = row ? String(row.owner_user_id == null ? "" : row.owner_user_id) : ""; return o || ATT_C.ADMIN_ID; }
/** Admin sees everything; a teacher sees only what they own. */
function att_canSee_(u, ownerId) { return !!u && (u.role === "admin" || att_ownerOf_({ owner_user_id: ownerId }) === u.user_id); }
/** Whose rows a list action covers: a teacher is FORCED to their own id; the admin may narrow with p.user_id (null = everyone). */
function att_effOwner_(p, u) {
  if (!u || u.role !== "admin") return u ? u.user_id : ATT_C.ADMIN_ID;
  var f = String((p && p.user_id) || ""); return f || null;
}
/** {s} for a session the caller may see; {err} otherwise (NO_SESSION, or UNAUTHORIZED for a foreign id). */
function att_scopeSession_(u, id) {
  var s = att_getSession_(id); if (!s) return { err: att_err_("NO_SESSION") };
  if (!att_canSee_(u, s.owner_user_id)) return { err: att_unauthorized_() };
  return { s: s };
}
/** Set of session ids owned by ownerId (optionally one course). */
function att_ownedSessionIds_(ownerId, course) {
  var set = {};
  att_rows_("AttSessions").forEach(function (r) { if (att_ownerOf_(r) === ownerId && (!course || r.course === course)) set[r.session_id] = 1; });
  return set;
}

/* ───────── dispatcher ───────── */
function att_dispatch_(p) {
  p = p || {};
  var a = String(p.action || "");
  try {
    // Student actions are open and handled first, so they never depend on the accounts section.
    var STUDENT = { att_ticket: att_ticketAction_, att_signup: att_signup_, att_attend: att_attend_, att_change_device: att_changeDevice_, att_status: att_status_ };
    if (att_has_(STUDENT, a)) return STUDENT[a](p);
    if (a === "att_login") return att_login_(p);
    // Signed-in callers (teacher or admin). Every one of these filters by owner inside (a teacher only ever gets their own rows).
    var SCOPED = { att_me: att_me_, att_start_session: att_startSession_, att_close_session: att_closeSession_, att_live: att_live_, att_rooms: att_rooms_,
      att_calibrate_room: att_calibrateRoom_, att_requests: att_requests_, att_decide_request: att_decideRequest_, att_flagged: att_flagged_, att_export: att_export_, att_roster: att_roster_,
      att_sessions: att_sessionsList_, att_session_detail: att_sessionDetail_, att_review: att_review_ };
    var ADMIN_ONLY = { att_user_create: att_userCreate_, att_users: att_users_, att_user_update: att_userUpdate_, att_user_reset: att_userReset_, att_overview: att_overview_ };
    var fn = att_has_(SCOPED, a) ? SCOPED[a] : (att_has_(ADMIN_ONLY, a) ? ADMIN_ONLY[a] : null);
    if (!fn) return att_err_("UNKNOWN_ACTION");
    var au = att_auth_(p);
    if (!au.ok) return au.err;
    if (att_has_(ADMIN_ONLY, a) && au.user.role !== "admin") return att_err_("FORBIDDEN", "Admin only");
    return fn(p, au.user);   // the caller is passed as an argument, never read from the payload (a client cannot spoof it)
  } catch (e) {
    console.error(a + ": " + (e && e.stack || e));
    return att_err_("SERVER_ERROR", "Server error");
  }
}

/* ───────── student actions ───────── */
function att_ticketAction_(p) {
  var s = att_getSession_(p.session_id); if (!s) return att_err_("NO_SESSION");
  var now = Date.now();
  if (!att_isOpen_(s, now)) return att_err_("SESSION_CLOSED");
  if (!att_tokenOk_(att_sessionKey_(s.session_id), s.session_id, p.token, Math.floor(now / 1000))) return att_err_("TOKEN_EXPIRED");
  // The ticket must not outlive the session (plan section 3): capped by the close time as well as the 240 s TTL.
  var nowSec = Math.floor(now / 1000), exp = nowSec + ATT_C.TICKET_SEC;
  [Date.parse(s.close_utc), Date.parse(s.start_utc) + ATT_C.SESSION_MIN * 60000].forEach(function (ms) { if (isFinite(ms)) exp = Math.min(exp, Math.floor(ms / 1000)); });
  if (exp <= nowSec) return att_err_("SESSION_CLOSED");
  // The request carries no device id, so d is "" (see HANDOFF-1).
  return att_ok_({ ticket: att_makeTicket_(s.session_id, "", exp), expires_at: exp * 1000, close_utc: s.close_utc, server_utc: att_iso_() });
}

function att_signup_(p) {
  var t = att_checkTicket_(p.ticket); if (!t) return att_err_("TICKET_EXPIRED");
  var sid = String(p.student_id || "").trim();
  if (!ATT_C.ID_REGEX.test(sid)) return att_err_("BAD_ID");
  var secret = String(p.secret || ""); if (secret.length < 8) return att_err_("BAD_REQUEST", "Missing device secret");
  var name = String(p.name || "").replace(/\s+/g, " ").trim().slice(0, ATT_C.NAME_MAX);
  if (name.length < 2) return att_err_("NAME_REQUIRED", "Name is required");
  var hash = att_sha256Hex_(secret), deviceId = "D-" + hash.slice(0, 16), nowIso = att_iso_();
  var res = att_withLock_(function () {
    var bound = att_rows_("AttDevices").filter(function (x) { return x.secret_hash === hash && x.status === "active"; })[0];
    var taken = att_rows_("AttStudents").some(function (x) { return x.student_id === sid; });
    // A phone already bound to a DIFFERENT student that tries to register/claim another ID is an attempted cheat (checked before ID_TAKEN, which used to hide it).
    if (bound && bound.student_id !== sid) { var e1 = att_err_("DEVICE_BOUND_OTHER_ID"); e1._owner = bound.student_id; return e1; }
    if (taken) return att_err_("ID_TAKEN");
    if (bound) return att_err_("DEVICE_BOUND_OTHER_ID");
    att_append_("AttStudents", { student_id: sid, name: name, device_id: deviceId, created_at: nowIso, status: "active" });
    att_append_("AttDevices", { device_id: deviceId, student_id: sid, secret_hash: hash, fp_hash: String(p.fp || ""), bound_at: nowIso, status: "active" });
    return att_ok_({ status: "registered", name: name });
  });
  if (res.ok) { att_cdel_("att:d:" + hash); att_cdel_("att:n:" + sid); }
  else if (res.code === "DEVICE_BOUND_OTHER_ID") {
    att_logFlag_(t.s, sid, "DEVICE_BOUND_OTHER_ID", "signup;owner=" + (res._owner || "") + ";n=" + name.charAt(0));
    att_safeNotify_("flag", { session_id: t.s, student_id: sid, flags: ["DEVICE_BOUND_OTHER_ID"], hard: true });
  }
  delete res._owner;
  return res;
}

/** A finite number within +-lim, else null ("" / null / booleans are NOT numbers). */
function att_coord_(v, lim) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  var n = Number(v); return (isFinite(n) && Math.abs(n) <= lim) ? n : null;
}
/** Failure reason of a missing/denied fix. A missing or unknown reason (old clients) is treated as PERMISSION_DENIED (plan §4.1). */
function att_geoReason_(r) {
  r = String(r == null ? "" : r).trim().toUpperCase();
  return att_has_(ATTF_GEO_REASON_FLAG, r) ? r : "PERMISSION_DENIED";
}
/** -> {lat,lng,acc} for a usable fix, else {denied:true, reason}. */
function att_normGeo_(g) {
  var lat = g ? att_coord_(g.lat, 90) : null, lng = g ? att_coord_(g.lng, 180) : null;
  if (g && g.denied !== true && lat !== null && lng !== null) {
    var acc = Number(g.acc); return { lat: lat, lng: lng, acc: isFinite(acc) && acc >= 0 ? acc : 0 };
  }
  return { denied: true, reason: att_geoReason_(g && g.reason) };
}
/** Diagnostics sent by the student page (plan §4.1). Whitelisted and bounded: it only ever ends up in a log line. */
function att_normDiag_(d) {
  if (!d || typeof d !== "object") return null;
  var perm = String(d.perm || "").toLowerCase(); if (["granted", "prompt", "denied", "unknown"].indexOf(perm) < 0) perm = "unknown";
  var n = Math.floor(Number(d.attempts)); if (!isFinite(n) || n < 0) n = 0;
  function b(v) { return (v === true || v === "true") ? "1" : (v === false || v === "false") ? "0" : "?"; }
  var fail = d.fail_reason ? att_geoReason_(d.fail_reason) : "";   // S1 extra: the real failure behind a USER_SKIPPED check-in
  return { perm: perm, attempts: Math.min(n, 99), online: b(d.online), inapp: b(d.inapp), fail: fail };
}
/** AttFlagLog.detail for a flag. The three location-failure flags carry the reason + diagnostics so the NEXT case is diagnosable. */
function att_flagDetail_(code, dist, geo, diag) {
  if (code === "GEO_DENIED" || code === "GEO_UNAVAILABLE" || code === "GEO_SKIPPED") {
    return "reason=" + (geo.denied ? geo.reason : "") + (diag ? ";perm=" + diag.perm + ";att=" + diag.attempts + ";online=" + diag.online + ";inapp=" + diag.inapp + (diag.fail ? ";fail=" + diag.fail : "") : ";diag=none");
  }
  return dist == null ? "" : "dist_m=" + Math.round(dist);
}

function att_attend_(p) {
  var t = att_checkTicket_(p.ticket); if (!t) return att_err_("TICKET_EXPIRED");
  var s = att_getSession_(t.s); if (!s) return att_err_("NO_SESSION");
  if (!att_isOpen_(s, Date.now())) return att_err_("SESSION_CLOSED");
  var sid = String(p.student_id || "").trim(), secret = String(p.secret || "");
  var dev = secret ? att_getDevice_(att_sha256Hex_(secret)) : null;
  var hard = null;
  // A student who never registered is simply new: tell the page to register, no flag, no log, no Telegram.
  if (!dev && sid && !att_studentExists_(sid)) return att_err_("UNKNOWN_STUDENT");
  if (!dev) hard = "DEVICE_UNKNOWN";
  else if (dev.status !== "active") hard = (dev.student_id === sid) ? "ID_BOUND_OTHER_DEVICE" : "DEVICE_UNKNOWN";
  else if (dev.student_id !== sid) hard = "DEVICE_ID_CONFLICT";
  if (hard) {
    att_logFlag_(s.session_id, sid, hard, dev ? "device " + dev.device_id + ";owner=" + dev.student_id : "");
    att_safeNotify_("flag", { session_id: s.session_id, student_id: sid, flags: [hard], hard: true });
    return att_err_(hard);
  }
  var geo = att_normGeo_(p.geo), diag = att_normDiag_(p.diag), fp = String(p.fp || ""), serverUtc = att_iso_();
  var hall = (s.hall_lat != null && s.hall_lng != null) ? { lat: s.hall_lat, lng: s.hall_lng } : null;
  var dist = (!geo.denied && hall) ? att_haversine_(geo.lat, geo.lng, hall.lat, hall.lng) : null;

  // priors read OUTSIDE the lock (keeps the critical section short); flags are pure.
  var priors = att_rows_("AttCheckins").filter(function (r) { return r.session_id === s.session_id || r.student_id === sid; }).map(function (r) {
    return { checkin_id: r.checkin_id, session_id: r.session_id, student_id: r.student_id, device_id: r.device_id, server_utc: r.server_utc,
      lat: att_num_(r.lat), lng: att_num_(r.lng), acc: att_num_(r.acc), dist_m: att_num_(r.dist_m), fp_hash: r.fp_hash,
      flags: r.flags ? r.flags.split(",") : [], status: r.status };
  });
  function flagsFor(pr) {
    try { return att_runFlags_({ session: s, student_id: sid, device_id: dev.device_id, fp: fp, geo: geo, serverUtc: serverUtc, hall: hall, priorCheckins: pr }) || []; }
    catch (e) { console.error("runFlags: " + e); return []; }
  }
  var flags = flagsFor(priors);
  var status = att_flagsToStatus_(flags);

  var res = att_withLock_(function () {
    var sh = att_sheet_("AttCheckins"), n = sh.getLastRow();
    if (n >= 2) {
      var v = sh.getRange(2, 1, n - 1, 3).getValues(); // A checkin_id, B session_id, C student_id
      for (var i = 0; i < v.length; i++) {
        if (String(v[i][1]) === s.session_id && String(v[i][2]) === sid) {
          var cur = att_rowAt_("AttCheckins", i + 2);
          // Upgrade rule (plan §4.3): a record WITHOUT coordinates is completed by a later attempt WITH valid coordinates, so one bad first
          // attempt can be corrected. A good fix is never downgraded; any other repeat changes nothing. The recorded time stays the first one.
          if (!geo.denied && att_num_(cur.lat) === null && att_num_(cur.lng) === null) {
            var f2 = flagsFor(priors.filter(function (x) { return x.checkin_id !== cur.checkin_id; })), st2 = att_flagsToStatus_(f2);   // the row being repaired must not count as its own "prior"
            att_update_("AttCheckins", cur._row, { lat: geo.lat, lng: geo.lng, acc: geo.acc, dist_m: dist == null ? "" : Math.round(dist * 10) / 10,
              fp_hash: fp, flags: f2.join(","), status: st2, geo_reason: "" });
            return att_ok_({ status: "recorded", server_utc: cur.server_utc, dup: true, upgraded: true, _flags: f2, _status: st2, _was: cur.geo_reason });
          }
          return att_ok_({ status: "recorded", server_utc: cur.server_utc, dup: true });
        }
      }
    }
    att_append_("AttCheckins", { checkin_id: Utilities.getUuid(), session_id: s.session_id, student_id: sid, device_id: dev.device_id, server_utc: serverUtc,
      lat: geo.denied ? "" : geo.lat, lng: geo.denied ? "" : geo.lng, acc: geo.denied ? "" : geo.acc, dist_m: dist == null ? "" : Math.round(dist * 10) / 10,
      fp_hash: fp, flags: flags.join(","), status: status, geo_reason: geo.denied ? geo.reason : "" });
    return att_ok_({ status: "recorded", server_utc: serverUtc });
  });
  if (!res.ok) return res;
  var outFlags = res.upgraded ? res._flags : flags, outStatus = res.upgraded ? res._status : status;
  if (res.upgraded) att_logFlag_(s.session_id, sid, "GEO_UPGRADED", "was=" + (res._was || "-") + ";dist_m=" + (dist == null ? "" : Math.round(dist)) + ";acc=" + Math.round(geo.acc));   // log only: not a check-in flag
  if ((!res.dup || res.upgraded) && outFlags.length) {
    outFlags.forEach(function (f) { att_logFlag_(s.session_id, sid, f, att_flagDetail_(f, dist, geo, diag)); });
    att_safeNotify_("flag", { session_id: s.session_id, student_id: sid, flags: outFlags, status: outStatus, owner_name: s.owner_name || "" });
  }
  var out = { status: "recorded", server_utc: res.server_utc, name: att_studentName_(sid) };   // flags are NEVER returned
  if (res.upgraded) out.upgraded = true;
  return att_ok_(out);
}

function att_changeDevice_(p) {
  var t = att_checkTicket_(p.ticket); if (!t) return att_err_("TICKET_EXPIRED");
  var sid = String(p.student_id || "").trim(), secret = String(p.new_secret || "");
  if (!ATT_C.ID_REGEX.test(sid)) return att_err_("BAD_ID");
  if (secret.length < 8) return att_err_("BAD_REQUEST", "Missing device secret");
  var hash = att_sha256Hex_(secret), fp = String(p.fp || ""), nowIso = att_iso_();
  var ses = att_getSession_(t.s), owner = att_ownerOf_(ses), ownerName = (ses && ses.owner_name) || (owner === ATT_C.ADMIN_ID ? ATT_C.ADMIN_NAME : "");   // the request is owned by whoever owns the session the student scanned
  var res = att_withLock_(function () {
    var st = att_rows_("AttStudents").filter(function (x) { return x.student_id === sid; })[0];
    if (!st) return att_err_("UNKNOWN_STUDENT");
    var devs = att_rows_("AttDevices");
    var active = devs.filter(function (d) { return d.student_id === sid && d.status === "active"; })[0];
    if (devs.some(function (d) { return d.secret_hash === hash && d.status === "active" && d.student_id !== sid; })) return att_err_("DEVICE_BOUND_OTHER_ID");
    if (active && active.secret_hash === hash) return att_err_("DEVICE_ALREADY_ACTIVE");
    var reqs = att_rows_("AttRequests");
    var pend = reqs.filter(function (r) { return r.student_id === sid && r.status === "pending"; })[0];
    if (pend) {
      // Goes to the teacher whose session the student scanned MOST RECENTLY (plan decision 2): a request left with an absent teacher is re-routed.
      if (pend.session_id !== t.s || att_ownerOf_(pend) !== owner) att_update_("AttRequests", pend._row, { session_id: t.s, owner_user_id: owner });
      return att_ok_({ status: "pending", req_id: pend.req_id });
    }
    var rid = "R-" + Utilities.getUuid().replace(/-/g, "").slice(0, 10);
    var match = !!(active && active.fp_hash && active.fp_hash === fp);
    att_append_("AttRequests", { req_id: rid, student_id: sid, new_device_id: "D-" + hash.slice(0, 16), new_secret_hash: hash, new_fp_hash: fp,
      fp_match: match ? "true" : "false", status: "pending", created_at: nowIso, decided_at: "", session_id: t.s, owner_user_id: owner });
    return att_ok_({ status: "pending", req_id: rid, _new: true, _match: match });
  });
  if (res.ok && res._new) { att_safeNotify_("device_request", { req_id: res.req_id, student_id: sid, fp_match: res._match, session_id: t.s, owner_name: ownerName }); }
  if (res.ok) { delete res._new; delete res._match; }
  return res;
}

function att_status_(p) {
  var s = att_getSession_(p.session_id); if (!s) return att_err_("NO_SESSION");
  var now = Date.now();
  return att_ok_({ close_utc: s.close_utc, server_utc: att_iso_(new Date(now)), status: att_isOpen_(s, now) ? "open" : "closed" });
}

/* ───────── admin actions ───────── */
function att_startSession_(p, u) {
  u = u || att_adminUser_();
  var room = null;
  if (p.room_id) {
    room = att_getRoom_(p.room_id); if (!room) return att_err_("NO_ROOM");
    if (!att_canSee_(u, room.owner_user_id)) return att_unauthorized_();   // rooms are private per teacher (plan decision 3)
  }
  var course = String(p.course || "").slice(0, 100), roomId = room ? room.room_id : "";
  var start = new Date(), close = new Date(start.getTime() + ATT_C.SESSION_MIN * 60000);
  var sid = "S-" + start.getTime().toString(36).toUpperCase() + Utilities.getUuid().slice(0, 4).toUpperCase();
  var s = { session_id: sid, course: course, room_id: roomId, start_utc: att_iso_(start), close_utc: att_iso_(close),
    status: "open", hall_lat: room ? room.lat : "", hall_lng: room ? room.lng : "", owner_user_id: u.user_id, owner_name: u.name };
  var existing = null;
  att_withLock_(function () {
    // A double tap or a client retry within 20 s must not create a second session. The twin must be THIS owner's: two teachers can run the same course at once.
    existing = att_rows_("AttSessions").filter(function (r) {
      return r.status === "open" && r.course === course && r.room_id === roomId && att_ownerOf_(r) === u.user_id && start.getTime() - Date.parse(r.start_utc) < ATT_C.DUP_START_MS;
    }).pop() || null;
    if (!existing) att_append_("AttSessions", s);
    return true;
  });
  if (existing) {
    return att_ok_({ session_id: existing.session_id, session_key: att_sessionKey_(existing.session_id), start_utc: existing.start_utc, close_utc: existing.close_utc });
  }
  s.hall_lat = att_num_(s.hall_lat); s.hall_lng = att_num_(s.hall_lng); att_cput_("att:s:" + sid, s);
  att_safeNotify_("session_start", { session_id: sid, course: s.course, room: room ? room.name : "", start_utc: s.start_utc, close_utc: s.close_utc, owner_name: u.name });
  return att_ok_({ session_id: sid, session_key: att_sessionKey_(sid), start_utc: s.start_utc, close_utc: s.close_utc });
}

/** ownerId = count only that owner's pending device requests; null = all (admin). */
function att_counts_(sessionId, ownerId) {
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.session_id === sessionId; });
  var pending = att_rows_("AttRequests").filter(function (r) { return r.status === "pending" && (ownerId == null || att_ownerOf_(r) === ownerId); }).length;
  return { rows: rows, present: rows.length, flagged: rows.filter(function (r) { return r.status === "review"; }).length, pending: pending };
}

function att_closeSession_(p, u) {
  u = u || att_adminUser_();
  var sc = att_scopeSession_(u, p.session_id); if (sc.err) return sc.err;
  var s = sc.s;
  if (s.status !== "closed") {
    var row = att_rows_("AttSessions").filter(function (x) { return x.session_id === s.session_id; })[0];
    var nowIso = att_iso_();
    att_withLock_(function () { att_update_("AttSessions", row._row, { status: "closed", close_utc: nowIso }); return true; });
    s.status = "closed"; s.close_utc = nowIso; att_cput_("att:s:" + s.session_id, s);
  }
  var c = att_counts_(s.session_id, att_ownerOf_(s)), summary = { present: c.present, flagged: c.flagged, pending: c.pending };
  att_safeNotify_("session_close", { session_id: s.session_id, course: s.course, summary: summary, owner_name: s.owner_name || "" });
  return att_ok_({ summary: summary });
}

/** Admin activity feed for one session, newest first: registrations (yellow), check-ins (green), attempted cheating (red).
 *  Cheating events are masked HERE: only {l: first letter of the name, d: last 2 digits of the ID} ever leave the server. */
function att_feed_(sessionId, u) {
  var s = sessionId ? att_getSession_(sessionId) : null; if (!s) return [];
  var scoped = !!u && u.role !== "admin";
  var names = {}; att_rows_("AttStudents").forEach(function (x) { names[x.student_id] = x; });
  var ev = [], here = {};
  att_rows_("AttCheckins").forEach(function (r) {
    if (r.session_id !== sessionId) return;
    here[r.student_id] = 1;
    ev.push({ t: r.server_utc, k: "att", n: (names[r.student_id] || {}).name || "", id: r.student_id });
  });
  Object.keys(names).forEach(function (id) {
    var x = names[id];
    if (!x.created_at || x.created_at < s.start_utc) return;
    // Registrations are not tied to a session in the sheet, so a teacher only sees the ones that also checked in HERE
    // (otherwise they would see students who registered in another teacher's simultaneous session).
    if (scoped && !here[id]) return;
    ev.push({ t: x.created_at, k: "reg", n: x.name, id: id });
  });
  att_rows_("AttFlagLog").forEach(function (r) {
    if (r.session_id !== sessionId || r.code === "GEO_WEAK" || r.code === "GEO_UPGRADED") return;   // GEO_UPGRADED is a log line, not an incident
    var m = /owner=(\d+)/.exec(r.detail || ""), who = m ? m[1] : r.student_id, nm = (names[who] || {}).name || "";
    if (!nm) { var n2 = /;n=(.)/.exec(r.detail || ""); nm = n2 ? n2[1] : ""; }
    ev.push({ t: r.ts_utc, k: "bad", l: nm ? nm.charAt(0).toUpperCase() : "?", d: String(who).slice(-2) });
  });
  ev.sort(function (a, b) { return a.t < b.t ? 1 : a.t > b.t ? -1 : 0; });
  return ev.slice(0, 80);
}

function att_live_(p, u) {
  u = u || att_adminUser_();
  var sid = String(p.session_id || ""), s0 = sid ? att_getSession_(sid) : null;
  if (s0 && !att_canSee_(u, s0.owner_user_id)) return att_unauthorized_();
  var admin = u.role === "admin";
  var c = att_counts_(sid, admin ? null : u.user_id);
  var active = {}; att_rows_("AttStudents").forEach(function (x) { if (x.status === "active") active[x.student_id] = 1; });
  var registered;
  if (admin) registered = Object.keys(active).length;
  else {   // a teacher's "registered" = active students who have checked in to any of THEIR sessions
    var mine = att_ownedSessionIds_(u.user_id), seen = {};
    att_rows_("AttCheckins").forEach(function (r) { if (mine[r.session_id] && active[r.student_id]) seen[r.student_id] = 1; });
    registered = Object.keys(seen).length;
  }
  var recent = c.rows.slice(-10).reverse().map(function (r) { return { student_id: r.student_id, server_utc: r.server_utc, status: r.status }; });
  return att_ok_({ registered: registered, present: c.present, flagged: c.flagged, pending: c.pending, recent: recent, feed: att_feed_(sid, u) });
}

function att_rooms_(p, u) {
  var owner = att_effOwner_(p, u || att_adminUser_());
  return att_ok_({ rooms: att_rows_("AttRooms").filter(function (r) { return owner == null || att_ownerOf_(r) === owner; }).map(function (r) {
    return { room_id: r.room_id, name: r.name, lat: att_num_(r.lat), lng: att_num_(r.lng), samples: att_num_(r.samples), calibrated_at: r.calibrated_at, owner_user_id: att_ownerOf_(r) };
  }) });
}

/** Pure: accuracy-weighted (1/acc) mean of samples. Returns {lat,lng,n} or null. */
function att_average_(samples) {
  var sw = 0, la = 0, lo = 0, n = 0;
  (samples || []).forEach(function (x) {
    var lat = Number(x && x.lat), lng = Number(x && x.lng), acc = Number(x && x.acc);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    var w = 1 / Math.max(isFinite(acc) && acc > 0 ? acc : 100, 1);
    sw += w; la += lat * w; lo += lng * w; n++;
  });
  return n ? { lat: la / sw, lng: lo / sw, n: n } : null;
}

function att_calibrateRoom_(p, u) {
  u = u || att_adminUser_();
  var name = String(p.name || "").trim().slice(0, 60); if (!name) return att_err_("BAD_REQUEST", "Room name required");
  var avg = att_average_(p.samples); if (!avg) return att_err_("BAD_REQUEST", "No valid samples");
  var room = null;
  var res = att_withLock_(function () {
    // a room name is unique PER OWNER: two teachers may each have a "Hall 1"
    var ex = att_rows_("AttRooms").filter(function (r) { return r.name === name && att_ownerOf_(r) === u.user_id; })[0], nowIso = att_iso_();
    if (ex) { att_update_("AttRooms", ex._row, { lat: avg.lat, lng: avg.lng, samples: avg.n, calibrated_at: nowIso }); room = { room_id: ex.room_id }; }
    else { room = { room_id: "RM-" + Utilities.getUuid().replace(/-/g, "").slice(0, 8) }; att_append_("AttRooms", { room_id: room.room_id, name: name, lat: avg.lat, lng: avg.lng, samples: avg.n, calibrated_at: nowIso, owner_user_id: u.user_id }); }
    room.name = name; room.lat = avg.lat; room.lng = avg.lng; room.samples = avg.n; room.calibrated_at = nowIso; room.owner_user_id = u.user_id;
    return att_ok_({ room: room });
  });
  if (res.ok) att_cdel_("att:r:" + room.room_id);
  return res;
}

function att_requests_(p, u) {
  var owner = att_effOwner_(p, u || att_adminUser_());
  var rows = att_rows_("AttRequests").filter(function (r) { return owner == null || att_ownerOf_(r) === owner; }).reverse().map(function (r) {
    var o = att_clean_(r); delete o.new_secret_hash; o.fp_match = (o.fp_match === "true"); o.owner_user_id = att_ownerOf_(r); return o;
  });
  return att_ok_({ requests: rows });
}

/** Shared by the web action and the Telegram callback. */
function att_decide_(reqId, approve) {
  var res = att_withLock_(function () {
    var r = att_rows_("AttRequests").filter(function (x) { return x.req_id === reqId; })[0];
    if (!r) return att_err_("NO_REQUEST");
    if (r.status !== "pending") return att_err_("ALREADY_DECIDED");
    var nowIso = att_iso_(), drop = [];
    if (approve) {
      var devs = att_rows_("AttDevices");
      if (devs.some(function (d) { return d.secret_hash === r.new_secret_hash && d.status === "active" && d.student_id !== r.student_id; })) return att_err_("DEVICE_BOUND_OTHER_ID");
      devs.forEach(function (d) {
        if (d.student_id === r.student_id && d.status === "active" && d.secret_hash !== r.new_secret_hash) { att_update_("AttDevices", d._row, { status: "revoked" }); drop.push(d.secret_hash); }
      });
      var same = devs.filter(function (d) { return d.secret_hash === r.new_secret_hash && d.student_id === r.student_id; })[0];
      if (same) att_update_("AttDevices", same._row, { status: "active", bound_at: nowIso, fp_hash: r.new_fp_hash });
      else att_append_("AttDevices", { device_id: r.new_device_id, student_id: r.student_id, secret_hash: r.new_secret_hash, fp_hash: r.new_fp_hash, bound_at: nowIso, status: "active" });
      var st = att_rows_("AttStudents").filter(function (x) { return x.student_id === r.student_id; })[0];
      if (st) att_update_("AttStudents", st._row, { device_id: r.new_device_id });
      drop.push(r.new_secret_hash);
    }
    att_update_("AttRequests", r._row, { status: approve ? "approved" : "denied", decided_at: nowIso });
    drop.forEach(function (h) { att_cdel_("att:d:" + h); });
    return att_ok_({ student_id: r.student_id, status: approve ? "approved" : "denied" });
  });
  return res;
}
function att_decideRequest_(p, u) {
  u = u || att_adminUser_();
  var d = String(p.decision || ""); if (d !== "approve" && d !== "deny") return att_err_("BAD_REQUEST", "decision must be approve|deny");
  var id = String(p.req_id || ""), r0 = att_rows_("AttRequests").filter(function (x) { return x.req_id === id; })[0];
  if (r0 && !att_canSee_(u, att_ownerOf_(r0))) return att_unauthorized_();   // a teacher decides only requests routed to them; the admin decides any
  var r = att_decide_(id, d === "approve");
  return r.ok ? att_ok_({}) : r;
}
/** Interface for AttTelegram.gs (att_decideFromTelegram_ lives there and returns the verdict text).
 *  decision = "approve" | "deny". Returns {ok:true,...} or {ok:false,code}; double decisions -> ALREADY_DECIDED. */
function att_applyDecision_(reqId, decision) { return att_decide_(String(reqId || ""), decision === "approve"); }

function att_flagged_(p, u) {
  u = u || att_adminUser_();
  var sid = String(p.session_id || ""), s0 = sid ? att_getSession_(sid) : null;
  if (s0 && !att_canSee_(u, s0.owner_user_id)) return att_unauthorized_();
  var owner = att_effOwner_(p, u), vis = owner == null ? null : att_ownedSessionIds_(owner);
  var names = {}; att_rows_("AttStudents").forEach(function (s) { names[s.student_id] = s.name; });
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.status === "review" && (!sid || r.session_id === sid) && (!vis || vis[r.session_id]); })
    .reverse().map(function (r) { var o = att_clean_(r); o.name = names[r.student_id] || ""; return o; });
  return att_ok_({ rows: rows });
}

/** Roster: every student, the lectures (sessions) shown, and who checked in to which one and when.
 *  p.course (optional) filters sessions; p.limit = how many of the latest sessions (default 30, max 200).
 *  A TEACHER gets only the sessions they own, and as students only those who checked in to those sessions (plan §4.7);
 *  the admin gets everything (and may narrow with p.user_id).
 *  Returns {students:[{student_id,name}], sessions:[{session_id,course,room_id,start_utc,status}] oldest->newest,
 *           marks:[[session_id,student_id,server_utc,status]], courses:[...all distinct courses]} */
function att_roster_(p, u) {
  u = u || att_adminUser_();
  var owner = att_effOwner_(p, u);
  var limit = Math.min(Math.max(parseInt(p.limit, 10) || 30, 1), 200), course = String(p.course || "");
  var all = att_rows_("AttSessions").filter(function (x) { return owner == null || att_ownerOf_(x) === owner; }), seen = {}, courses = [];
  all.forEach(function (x) { if (x.course && !seen[x.course]) { seen[x.course] = 1; courses.push(x.course); } });
  courses.sort();
  var sessions = all.filter(function (x) { return !course || x.course === course; })
    .sort(function (a, b) { return Date.parse(a.start_utc) - Date.parse(b.start_utc); });
  var scopeIds = {}; sessions.forEach(function (x) { scopeIds[x.session_id] = 1; });   // every session of the (course) scope, not just the visible window
  sessions = sessions.slice(Math.max(0, sessions.length - limit));
  var inSet = {}; sessions.forEach(function (x) { inSet[x.session_id] = 1; });
  var checkins = att_rows_("AttCheckins");
  var marks = checkins.filter(function (r) { return inSet[r.session_id]; })
    .map(function (r) { return [r.session_id, r.student_id, r.server_utc, r.status]; });
  var known = null;
  if (owner != null) { known = {}; checkins.forEach(function (r) { if (scopeIds[r.session_id]) known[r.student_id] = 1; }); }
  var students = att_rows_("AttStudents").filter(function (x) { return x.status === "active" && (known === null || known[x.student_id]); })
    .map(function (x) { return { student_id: x.student_id, name: x.name }; });
  return att_ok_({
    students: students,
    sessions: sessions.map(function (x) { return { session_id: x.session_id, course: x.course, room_id: x.room_id, start_utc: x.start_utc, status: x.status, owner_user_id: att_ownerOf_(x), owner_name: x.owner_name || "" }; }),
    marks: marks, courses: courses });
}

function att_csvCell_(v) {
  var s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function att_export_(p, u) {
  u = u || att_adminUser_();
  var sc = att_scopeSession_(u, String(p.session_id || "")); if (sc.err) return sc.err;
  var sid = sc.s.session_id;
  var names = {}; att_rows_("AttStudents").forEach(function (s) { names[s.student_id] = s.name; });
  var lines = [["student_id", "name", "server_utc", "status", "flags", "dist_m", "acc", "geo_reason", "review_status", "review_note"].join(",")];
  att_rows_("AttCheckins").filter(function (r) { return r.session_id === sid; }).forEach(function (r) {
    lines.push([r.student_id, names[r.student_id] || "", r.server_utc, r.status, r.flags, r.dist_m, r.acc, r.geo_reason, r.review_status, r.review_note].map(att_csvCell_).join(","));
  });
  return att_ok_({ csv: lines.join("\r\n") });
}

/* ───────── session history, overview, review (plan §4.6) ───────── */
var ATT_GEO_FLAGS_ = ["GEO_DENIED", "GEO_UNAVAILABLE", "GEO_SKIPPED", "GEO_FAR", "GEO_WEAK"];

/** {present, flagged, unreviewed, geo:{GEO_*: n}} for a list of AttCheckins rows. unreviewed = flagged (status review) with no review decision yet. */
function att_tally_(rows) {
  var t = att_newBucket_(); delete t.sessions;
  rows.forEach(function (r) {
    t.present++;
    if (r.status === "review") { t.flagged++; if (!r.review_status) t.unreviewed++; }
    String(r.flags || "").split(",").forEach(function (c) { if (c && att_has_(t.geo, c)) t.geo[c]++; });
  });
  return t;
}
function att_newBucket_() {
  var b = { sessions: 0, present: 0, flagged: 0, unreviewed: 0, geo: {} };
  ATT_GEO_FLAGS_.forEach(function (c) { b.geo[c] = 0; });
  return b;
}
function att_bucketAdd_(b, t) {
  b.sessions++; b.present += t.present; b.flagged += t.flagged; b.unreviewed += t.unreviewed;
  ATT_GEO_FLAGS_.forEach(function (c) { b.geo[c] += t.geo[c]; });
}
function att_groupBySession_(rows) {
  var m = {}; rows.forEach(function (r) { (m[r.session_id] = m[r.session_id] || []).push(r); }); return m;
}
/** p.from / p.to: ISO date ("2026-10-27") or date-time. A date-only `to` covers that whole UTC day. Days are UTC days. -> {from,to} ms (null = open) or {err}. */
function att_range_(p) {
  function one(v, endOfDay) {
    if (v === undefined || v === null || v === "") return null;
    var s = String(v).trim(), ms = Date.parse(s);
    if (!isFinite(ms)) return NaN;
    return (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? ms + 86400000 - 1 : ms;
  }
  var f = one(p && p.from, false), t = one(p && p.to, true);
  if ((f !== null && isNaN(f)) || (t !== null && isNaN(t))) return { err: att_err_("BAD_REQUEST", "from/to must be ISO dates") };
  return { from: f, to: t };
}
function att_inRange_(s, rg) {
  var ms = Date.parse(s.start_utc);
  return !((rg.from !== null && ms < rg.from) || (rg.to !== null && ms > rg.to));
}
function att_sessKey_(s) { return s.start_utc + "|" + s.session_id; }

/** att_sessions {from?,to?,user_id?,course?,limit,cursor?}: newest first. A teacher is forced to their own sessions; the admin may filter by user_id. */
function att_sessionsList_(p, u) {
  u = u || att_adminUser_();
  var rg = att_range_(p); if (rg.err) return rg.err;
  var owner = att_effOwner_(p, u), course = String(p.course || ""), limit = Math.min(Math.max(parseInt(p.limit, 10) || 30, 1), 200);
  var list = att_rows_("AttSessions").filter(function (s) { return (owner == null || att_ownerOf_(s) === owner) && (!course || s.course === course) && att_inRange_(s, rg); });
  list.sort(function (a, b) { var x = att_sessKey_(a), y = att_sessKey_(b); return x < y ? 1 : x > y ? -1 : 0; });
  var cur = String(p.cursor || "");
  if (cur) list = list.filter(function (s) { return att_sessKey_(s) < cur; });   // keyset paging: stable while new sessions are being added
  var page = list.slice(0, limit), more = list.length > limit;
  var by = att_groupBySession_(att_rows_("AttCheckins")), names = att_userNames_(), rooms = {};
  att_rows_("AttRooms").forEach(function (r) { rooms[r.room_id] = r.name; });
  return att_ok_({
    sessions: page.map(function (s) {
      var t = att_tally_(by[s.session_id] || []), o = att_ownerOf_(s);
      return { session_id: s.session_id, course: s.course, room_id: s.room_id, room_name: rooms[s.room_id] || "", start_utc: s.start_utc, close_utc: s.close_utc, status: s.status,
        owner_user_id: o, owner_name: names[o] || s.owner_name || "", present: t.present, flagged: t.flagged, unreviewed: t.unreviewed, geo: t.geo };
    }),
    next_cursor: more ? att_sessKey_(page[page.length - 1]) : null });
}

/** att_session_detail {session_id}: every check-in of one session with flags, distance, accuracy, geo_reason and review state. */
function att_sessionDetail_(p, u) {
  u = u || att_adminUser_();
  var sc = att_scopeSession_(u, String(p.session_id || "")); if (sc.err) return sc.err;
  var s = sc.s, names = att_userNames_(), stu = {}, rooms = {};
  att_rows_("AttStudents").forEach(function (x) { stu[x.student_id] = x.name; });
  att_rows_("AttRooms").forEach(function (r) { rooms[r.room_id] = r.name; });
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.session_id === s.session_id; });
  rows.sort(function (a, b) { return a.server_utc < b.server_utc ? -1 : a.server_utc > b.server_utc ? 1 : 0; });
  var o = att_ownerOf_(s), t = att_tally_(rows);
  return att_ok_({
    session: { session_id: s.session_id, course: s.course, room_id: s.room_id, room_name: rooms[s.room_id] || "", start_utc: s.start_utc, close_utc: s.close_utc, status: s.status,
      owner_user_id: o, owner_name: names[o] || s.owner_name || "" },
    summary: t,
    checkins: rows.map(function (r) {
      return { checkin_id: r.checkin_id, student_id: r.student_id, name: stu[r.student_id] || "", server_utc: r.server_utc, lat: att_num_(r.lat), lng: att_num_(r.lng), acc: att_num_(r.acc),
        dist_m: att_num_(r.dist_m), flags: r.flags, status: r.status, geo_reason: r.geo_reason, review_status: r.review_status, review_note: r.review_note,
        reviewed_by: r.reviewed_by, reviewed_by_name: r.reviewed_by ? (names[r.reviewed_by] || "") : "", reviewed_at: r.reviewed_at };
    }) });
}

/** att_review {checkin_id, decision:"accepted|rejected", note}: stores reviewer + time. Can be changed later (last decision wins). */
function att_review_(p, u) {
  u = u || att_adminUser_();
  var dec = String(p.decision || ""); if (dec !== "accepted" && dec !== "rejected") return att_err_("BAD_REQUEST", "decision must be accepted|rejected");
  var id = String(p.checkin_id || ""), note = String(p.note == null ? "" : p.note).replace(/\s+/g, " ").trim().slice(0, 500);
  return att_withLock_(function () {
    var r = att_rows_("AttCheckins").filter(function (x) { return x.checkin_id === id; })[0];
    if (!r) return att_err_("NO_CHECKIN");
    var s = att_getSession_(r.session_id);
    if (!att_canSee_(u, s ? s.owner_user_id : ATT_C.ADMIN_ID)) return att_unauthorized_();   // an orphan check-in (no session row) is admin-only
    var now = att_iso_();
    att_update_("AttCheckins", r._row, { review_status: dec, review_note: note, reviewed_by: u.user_id, reviewed_at: now });
    return att_ok_({ checkin_id: id, review_status: dec, review_note: note, reviewed_by: u.user_id, reviewed_by_name: u.name, reviewed_at: now });
  });
}

/** att_overview {from?,to?} (admin): totals, per user and per UTC day: sessions, present, flagged, GEO_* counts, unreviewed. */
function att_overview_(p) {
  var rg = att_range_(p); if (rg.err) return rg.err;
  var names = att_userNames_(), status = {}; status[ATT_C.ADMIN_ID] = "active";
  att_rows_("AttUsers").forEach(function (r) { status[r.user_id] = r.status; });
  var by = att_groupBySession_(att_rows_("AttCheckins")), totals = att_newBucket_(), users = {}, days = {};
  Object.keys(names).forEach(function (id) { users[id] = att_newBucket_(); });   // every account is listed, even with 0 sessions
  att_rows_("AttSessions").forEach(function (s) {
    if (!att_inRange_(s, rg)) return;
    var t = att_tally_(by[s.session_id] || []), o = att_ownerOf_(s), d = String(s.start_utc).slice(0, 10);
    if (!users[o]) { users[o] = att_newBucket_(); names[o] = s.owner_name || o; }
    if (!days[d]) days[d] = att_newBucket_();
    att_bucketAdd_(totals, t); att_bucketAdd_(users[o], t); att_bucketAdd_(days[d], t);
  });
  var byUser = Object.keys(users).map(function (id) { var b = users[id]; b.user_id = id; b.name = names[id] || id; b.status = status[id] || "active"; return b; });
  byUser.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  var byDay = Object.keys(days).sort().reverse().map(function (d) { var b = days[d]; b.day = d; return b; });
  return att_ok_({ range: { from: p.from || null, to: p.to || null }, totals: totals, by_user: byUser, by_day: byDay });
}

/* ═════════ tests (run from the editor) ═════════ */
function att_selfTest() {
  var out = [], allOk = true;
  function chk(name, got, want) { var ok = (got === want); if (!ok) allOk = false; out.push((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  got=" + got + " want=" + want)); }
  var M = "MASTER1", sk = att_sessionKey_("S-TEST", M);
  chk("sessionKey vector", sk, "30720e548ab67b904aaf2c32c6a98b7d7b4dcf1595213b25c93d1b1f5caa0eba");
  chk("token vector", att_token_(sk, "S-TEST", 170000000), "a592d194c472b486");
  var tk = att_makeTicket_("S-TEST", "DEV1", 1700000090, M);
  chk("ticket sig vector", tk.split(".")[1], "41804657c2188b49246700f0");
  chk("ticket roundtrip", JSON.stringify(att_checkTicket_(tk, M, 1700000000)), JSON.stringify({ s: "S-TEST", d: "DEV1", e: 1700000090 }));
  chk("ticket expired", att_checkTicket_(tk, M, 1700000090), null);
  chk("ticket tampered", att_checkTicket_(tk.slice(0, -1) + (tk.slice(-1) === "0" ? "1" : "0"), M, 1700000000), null);
  var e = 1700000000, w = Math.floor(e / 10); // e%10 == 0 -> grace applies
  chk("token current window", att_tokenOk_(sk, "S-TEST", att_token_(sk, "S-TEST", w), e), true);
  chk("token previous in grace (t%10=0)", att_tokenOk_(sk, "S-TEST", att_token_(sk, "S-TEST", w - 1), e), true);
  chk("token previous in grace edge (t%10=2)", att_tokenOk_(sk, "S-TEST", att_token_(sk, "S-TEST", w - 1), e + 2), true);
  chk("token previous rejected (t%10=3)", att_tokenOk_(sk, "S-TEST", att_token_(sk, "S-TEST", w - 1), e + 3), false);
  chk("token two windows old rejected", att_tokenOk_(sk, "S-TEST", att_token_(sk, "S-TEST", w - 2), e), false);
  chk("hex of signed bytes", att_hex_([-1, 0, 15, 127, -128]), "ff000f7f80");
  chk("haversine ~111.2km/deg", Math.round(att_haversine_(0, 0, 1, 0) / 1000), 111);
  var av = att_average_([{ lat: 30, lng: 31, acc: 10 }, { lat: 30.0003, lng: 31.0003, acc: 30 }]);
  chk("calibrate weights 1/acc", Math.round(av.lat * 1e6), Math.round((30 * 0.1 + 30.0003 * (1 / 30)) / (0.1 + 1 / 30) * 1e6));
  chk("csv injection guard", att_csvCell_("=1+1"), "'=1+1");
  chk("csv quoting", att_csvCell_('a,"b"'), '"a,""b"""');
  // multi-user accounts section - pure checks
  chk("password canon", att_pwCanon_(" abcde-fghjk "), "ABCDEFGHJK");
  chk("password hash vector", att_pwHash_("abcde-fghjk-lmnpq-rstuv", M), "9934611ad4750b316e07335598a2a5f21bd02e474a37fbbc352c85b09e584e75");
  var gp = att_genPassword_();
  chk("generated password shape", /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(gp), true);
  var ut = att_userTokenMake_("U-1", "abcd1234", 1700000100, M);
  chk("user token roundtrip", JSON.stringify(att_userTokenCheck_(ut, M, 1700000000)), JSON.stringify({ u: "U-1", r: "teacher", e: 1700000100, v: "abcd1234" }));
  chk("user token expired", att_userTokenCheck_(ut, M, 1700000100), null);
  chk("user token wrong key", att_userTokenCheck_(ut, "OTHER", 1700000000), null);
  chk("user token tampered", att_userTokenCheck_(ut.slice(0, -1) + (ut.slice(-1) === "0" ? "1" : "0"), M, 1700000000), null);
  chk("geo reason TIMEOUT -> GEO_UNAVAILABLE", att_geoFlagForReason_("TIMEOUT"), "GEO_UNAVAILABLE");
  chk("geo reason USER_SKIPPED -> GEO_SKIPPED", att_geoFlagForReason_("USER_SKIPPED"), "GEO_SKIPPED");
  chk("geo reason missing -> GEO_DENIED", att_geoFlagForReason_(undefined), "GEO_DENIED");
  chk("normGeo bad coords -> denied", JSON.stringify(att_normGeo_({ lat: 200, lng: 1 })), JSON.stringify({ denied: true, reason: "PERMISSION_DENIED" }));
  chk("owner of a legacy row is ADMIN", att_ownerOf_({ owner_user_id: "" }), "ADMIN");
  chk("teacher cannot see another owner", att_canSee_({ user_id: "U-1", role: "teacher" }, "U-2"), false);
  chk("admin sees any owner", att_canSee_(att_adminUser_(), "U-2"), true);
  Logger.log(out.join("\n") + "\n=> " + (allOk ? "ALL PASS" : "SOME FAIL"));
  return allOk;
}

/** Scripted end-to-end run through att_dispatch_ against the configured sheet. Test rows use IDs 9999xxxx and course ATT-TEST; remove with att_cleanupTest(). */
function att_scriptedRun() {
  var A = att_adminToken_(), out = [], allOk = true;
  function chk(name, cond) { if (!cond) allOk = false; out.push((cond ? "PASS " : "FAIL ") + name); }
  function D(o) { return att_dispatch_(o); }
  var room = D({ action: "att_calibrate_room", token: A, name: "ATT-TEST-ROOM", samples: [{ lat: 31.2001, lng: 29.9187, acc: 10 }, { lat: 31.2002, lng: 29.9188, acc: 20 }] });
  chk("calibrate", room.ok);
  var s = D({ action: "att_start_session", token: A, course: "ATT-TEST", room_id: room.room.room_id });
  chk("start session", s.ok && s.session_key.length === 64);
  function ticket() {
    var tok = att_token_(s.session_key, s.session_id, Math.floor(Date.now() / 10000));
    var t = D({ action: "att_ticket", session_id: s.session_id, token: tok }); return t.ticket;
  }
  chk("ticket with bad token", D({ action: "att_ticket", session_id: s.session_id, token: "0000000000000000" }).code === "TOKEN_EXPIRED");
  chk("ticket unknown session", D({ action: "att_ticket", session_id: "S-NOPE", token: "x" }).code === "NO_SESSION");
  var near = { lat: 31.2001, lng: 29.9187, acc: 15 }, SA = "secretAAAAAAAA", SB = "secretBBBBBBBB", SC = "secretCCCCCCCC";
  chk("signup A", D({ action: "att_signup", ticket: ticket(), student_id: "99990001", name: "Test One", secret: SA, fp: "fpA", geo: near }).status === "registered");
  chk("signup B", D({ action: "att_signup", ticket: ticket(), student_id: "99990002", name: "Test Two", secret: SB, fp: "fpB", geo: near }).status === "registered");
  chk("bad id", D({ action: "att_signup", ticket: ticket(), student_id: "12", name: "Test", secret: SC }).code === "BAD_ID");
  chk("id taken", D({ action: "att_signup", ticket: ticket(), student_id: "99990001", name: "Test", secret: SC }).code === "ID_TAKEN");
  chk("device bound other id", D({ action: "att_signup", ticket: ticket(), student_id: "99990003", name: "Test", secret: SA }).code === "DEVICE_BOUND_OTHER_ID");
  chk("bad ticket", D({ action: "att_signup", ticket: "x.y", student_id: "99990009", name: "Test", secret: SC }).code === "TICKET_EXPIRED");
  chk("signup needs a name", D({ action: "att_signup", ticket: ticket(), student_id: "99990005", secret: "secretEEEEEEEE" }).code === "NAME_REQUIRED");
  chk("never-registered ID is UNKNOWN_STUDENT (not a device flag)", D({ action: "att_attend", ticket: ticket(), student_id: "99990006", secret: "secretFFFFFFFF", fp: "x", geo: near }).code === "UNKNOWN_STUDENT");
  chk("...and nothing was logged for it", att_rows_("AttFlagLog").filter(function (x) { return x.student_id === "99990006"; }).length === 0);
  chk("start session twice in a row = same session", D({ action: "att_start_session", token: A, course: "ATT-TEST", room_id: room.room.room_id }).session_id === s.session_id);
  var r1 = D({ action: "att_attend", ticket: ticket(), student_id: "99990001", secret: SA, fp: "fpA", geo: near });
  chk("attend A (returns name, no flags)", r1.status === "recorded" && r1.flags === undefined && r1.name === "Test One");
  var r2 = D({ action: "att_attend", ticket: ticket(), student_id: "99990001", secret: SA, fp: "fpA", geo: near });
  chk("attend A again = recorded, same time", r2.status === "recorded" && r2.server_utc === r1.server_utc);
  chk("conflict", D({ action: "att_attend", ticket: ticket(), student_id: "99990002", secret: SA, fp: "fpA", geo: near }).code === "DEVICE_ID_CONFLICT");
  chk("unknown device", D({ action: "att_attend", ticket: ticket(), student_id: "99990001", secret: SC, fp: "x", geo: near }).code === "DEVICE_UNKNOWN");
  chk("attend B geo denied", D({ action: "att_attend", ticket: ticket(), student_id: "99990002", secret: SB, fp: "fpB", geo: { denied: true } }).status === "recorded");
  var cd = D({ action: "att_change_device", ticket: ticket(), student_id: "99990001", new_secret: SC, fp: "fpC" });
  chk("change device pending", cd.status === "pending" && !!cd.req_id);
  chk("change device idempotent", D({ action: "att_change_device", ticket: ticket(), student_id: "99990001", new_secret: SC, fp: "fpC" }).req_id === cd.req_id);
  var reqs = D({ action: "att_requests", token: A });
  chk("requests lists pending (no secret hash)", reqs.ok && reqs.requests.some(function (x) { return x.req_id === cd.req_id && x.status === "pending" && x.new_secret_hash === undefined; }));
  chk("approve", D({ action: "att_decide_request", token: A, req_id: cd.req_id, decision: "approve" }).ok);
  chk("decide twice", D({ action: "att_decide_request", token: A, req_id: cd.req_id, decision: "approve" }).code === "ALREADY_DECIDED");
  chk("old device now ID_BOUND_OTHER_DEVICE", D({ action: "att_attend", ticket: ticket(), student_id: "99990001", secret: SA, fp: "fpA", geo: near }).code === "ID_BOUND_OTHER_DEVICE");
  chk("new device accepted", D({ action: "att_attend", ticket: ticket(), student_id: "99990001", secret: SC, fp: "fpC", geo: near }).status === "recorded");
  chk("admin auth", D({ action: "att_live", token: "wrong", session_id: s.session_id }).code === "UNAUTHORIZED");
  var live = D({ action: "att_live", token: A, session_id: s.session_id });
  chk("live present=2 (no duplicate row)", live.ok && live.present === 2 && live.registered >= 2);
  chk("status open", D({ action: "att_status", session_id: s.session_id }).status === "open");
  chk("export", D({ action: "att_export", token: A, session_id: s.session_id }).csv.split("\r\n").length === 3);
  chk("flagged ok", D({ action: "att_flagged", token: A, session_id: s.session_id }).ok);
  var cl = D({ action: "att_close_session", token: A, session_id: s.session_id });
  chk("close", cl.ok && cl.summary.present === 2);
  // multi-user: two throw-away teachers (names start with ATT-TEST, removed by att_cleanupTest)
  var u1 = D({ action: "att_user_create", token: A, name: "ATT-TEST-T1" }), u2 = D({ action: "att_user_create", token: A, name: "ATT-TEST-T2" });
  chk("create two teachers", u1.ok && u2.ok && u1.password !== u2.password);
  var l1 = D({ action: "att_login", password: u1.password }), l2 = D({ action: "att_login", password: u2.password });
  chk("both teachers log in", l1.ok && l2.ok && l1.user.role === "teacher");
  var tr = D({ action: "att_calibrate_room", token: l1.token, name: "ATT-TEST-ROOM", samples: [{ lat: 31.2, lng: 29.9, acc: 10 }] });
  var ts = D({ action: "att_start_session", token: l1.token, course: "ATT-TEST", room_id: tr.room.room_id });
  chk("teacher 1 starts a session in their own room", tr.ok && ts.ok);
  chk("teacher 2 cannot use teacher 1's room", D({ action: "att_start_session", token: l2.token, course: "ATT-TEST", room_id: tr.room.room_id }).code === "UNAUTHORIZED");
  chk("teacher 2 cannot read teacher 1's session", D({ action: "att_session_detail", token: l2.token, session_id: ts.session_id }).code === "UNAUTHORIZED" && D({ action: "att_live", token: l2.token, session_id: ts.session_id }).code === "UNAUTHORIZED");
  chk("teacher 2's list is empty of it", D({ action: "att_sessions", token: l2.token }).sessions.every(function (x) { return x.session_id !== ts.session_id; }));
  chk("teacher cannot use admin actions", D({ action: "att_users", token: l1.token }).code === "FORBIDDEN");
  chk("admin sees the teacher's session", D({ action: "att_sessions", token: A }).sessions.some(function (x) { return x.session_id === ts.session_id && x.owner_name === "ATT-TEST-T1"; }));
  chk("attend after close", D({ action: "att_attend", ticket: ticket() || att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60), student_id: "99990002", secret: SB, fp: "fpB", geo: near }).code === "SESSION_CLOSED");
  Logger.log(out.join("\n") + "\n=> " + (allOk ? "ALL PASS" : "SOME FAIL") + "  (clean up with att_cleanupTest())");
  return allOk;
}

/** 80 parallel att_attend calls over HTTP (UrlFetchApp.fetchAll) against the DEPLOYED web app; verifies none are lost.
 *  The web app must be (re)deployed with this code first. */
function att_loadTest() {
  var N = 80, A = att_adminToken_(), url = PropertiesService.getScriptProperties().getProperty("ATT_LOADTEST_URL") || ScriptApp.getService().getUrl();
  var room = att_dispatch_({ action: "att_calibrate_room", token: A, name: "ATT-TEST-ROOM", samples: [{ lat: 31.2, lng: 29.9, acc: 10 }] });
  var s = att_dispatch_({ action: "att_start_session", token: A, course: "ATT-TEST", room_id: room.room.room_id });
  function tk() { return att_makeTicket_(s.session_id, "", Math.floor(Date.now() / 1000) + 60); }
  for (var i = 0; i < N; i++) {
    var r = att_dispatch_({ action: "att_signup", ticket: tk(), student_id: String(99980000 + i), name: "Load " + i, secret: "loadtest-secret-" + i, fp: "lt" + i, geo: { lat: 31.2, lng: 29.9, acc: 10 } });
    if (!r.ok) throw new Error("signup " + i + ": " + r.code);
  }
  var reqs = [];
  for (var j = 0; j < N; j++) reqs.push({ url: url, method: "post", contentType: "text/plain;charset=utf-8", muteHttpExceptions: true, followRedirects: true,
    payload: JSON.stringify({ action: "att_attend", ticket: tk(), student_id: String(99980000 + j), secret: "loadtest-secret-" + j, fp: "lt" + j, geo: { lat: 31.2, lng: 29.9, acc: 10 } }) });
  var resp = UrlFetchApp.fetchAll(reqs), okN = 0, codes = {};
  resp.forEach(function (x) { try { var o = JSON.parse(x.getContentText()); if (o.ok && o.status === "recorded") okN++; else codes[o.code || "?"] = (codes[o.code || "?"] || 0) + 1; } catch (e) { codes["PARSE"] = (codes["PARSE"] || 0) + 1; } });
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.session_id === s.session_id; }), uniq = {};
  rows.forEach(function (r) { uniq[r.student_id] = 1; });
  var pass = okN === N && rows.length === N && Object.keys(uniq).length === N;
  Logger.log("loadtest: ok=" + okN + "/" + N + " rows=" + rows.length + " unique=" + Object.keys(uniq).length + " other=" + JSON.stringify(codes) + " => " + (pass ? "PASS" : "FAIL"));
  return pass;
}

/** Deletes everything created by att_scriptedRun / att_loadTest (course ATT-TEST, room ATT-TEST-ROOM, IDs 9998xxxx/9999xxxx). */
function att_cleanupTest() {
  var tests = att_rows_("AttSessions").filter(function (r) { return r.course === "ATT-TEST"; }).map(function (r) { return r.session_id; });
  var isTestId = function (id) { return /^999[89]\d{4}$/.test(id); };
  var spec = { AttCheckins: function (r) { return tests.indexOf(r.session_id) >= 0; }, AttFlagLog: function (r) { return tests.indexOf(r.session_id) >= 0 || isTestId(r.student_id); },
    AttSessions: function (r) { return r.course === "ATT-TEST"; }, AttRooms: function (r) { return r.name === "ATT-TEST-ROOM"; },
    AttRequests: function (r) { return isTestId(r.student_id); }, AttDevices: function (r) { return isTestId(r.student_id); }, AttStudents: function (r) { return isTestId(r.student_id); } };
  var counts = {};
  att_rows_("AttUsers").forEach(function (u) { if (/^ATT-TEST/.test(u.name)) att_cdel_("att:u:" + u.user_id); });
  spec.AttUsers = function (r) { return /^ATT-TEST/.test(r.name); };
  att_withLock_(function () {
    Object.keys(spec).forEach(function (tab) {
      var rows = att_rows_(tab).filter(spec[tab]).reverse(); counts[tab] = rows.length;
      rows.forEach(function (r) { att_sheet_(tab).deleteRow(r._row); });
    });
    return true;
  });
  Logger.log("cleanup: " + JSON.stringify(counts));
  return counts;
}


/* ############################################################
 * ### from AttSetup.gs
 * ############################################################ */
/* AttSetup.gs — Session 1, extended by Session 2 (multi-user). Creates the 8 attendance tabs (idempotent) and ATT_MASTER_SECRET.
 * Run att_setup() once from the Apps Script editor. UPGRADING from the single-admin version: run att_migrate() once
 * (adds the new columns at the END of the existing tabs, creates AttUsers, labels legacy rows owner ADMIN; safe to re-run).
 * Standalone (non-container-bound) project? Run att_setup("<spreadsheetId>") once; it is stored as ATT_SHEET_ID.
 */
var ATT_HEADERS = {
  AttStudents: ["student_id", "name", "device_id", "created_at", "status"],
  AttDevices: ["device_id", "student_id", "secret_hash", "fp_hash", "bound_at", "status"],
  AttRequests: ["req_id", "student_id", "new_device_id", "new_secret_hash", "new_fp_hash", "fp_match", "status", "created_at", "decided_at", "session_id", "owner_user_id"],
  AttRooms: ["room_id", "name", "lat", "lng", "samples", "calibrated_at", "owner_user_id"],
  AttSessions: ["session_id", "course", "room_id", "start_utc", "close_utc", "status", "hall_lat", "hall_lng", "owner_user_id", "owner_name"],
  AttCheckins: ["checkin_id", "session_id", "student_id", "device_id", "server_utc", "lat", "lng", "acc", "dist_m", "fp_hash", "flags", "status", "geo_reason", "review_status", "review_note", "reviewed_by", "reviewed_at"],
  AttFlagLog: ["ts_utc", "session_id", "student_id", "code", "detail"],
  AttUsers: ["user_id", "name", "pw_hash", "status", "created_at", "last_login"],
};

/** Creates missing tabs, appends missing columns to older tabs (existing data is never rewritten or reordered; a tab whose headers
 *  CONFLICT is refused, not overwritten) and makes sure ATT_MASTER_SECRET exists. Returns the per-tab report. */
function att_ensureTabs_() {
  var ss = att_ss_(), report = [];
  Object.keys(ATT_HEADERS).forEach(function (name) {
    var h = ATT_HEADERS[name], sh = ss.getSheetByName(name), created = false;
    if (!sh) { sh = ss.insertSheet(name); created = true; }
    var cur = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(h.length, sh.getLastColumn())).getValues()[0] : [];
    var have = cur.length; while (have > 0 && (cur[have - 1] === "" || cur[have - 1] == null)) have--;
    for (var i = 0; i < have && i < h.length; i++) {
      if (cur[i] !== h[i]) throw new Error("Tab " + name + " exists with different headers; fix or rename it manually (not overwritten).");
    }
    var added = 0;
    if (have < h.length) { sh.getRange(1, have + 1, 1, h.length - have).setValues([h.slice(have)]); added = h.length - have; }
    // Plain-text columns: keeps ISO timestamps and IDs with leading zeros exactly as written.
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), h.length).setNumberFormat("@");
    sh.setFrozenRows(1);
    report.push(name + (created ? " (created)" : added ? " (+" + added + " column" + (added === 1 ? "" : "s") + ")" : " (ok)"));
  });
  return report;
}

function att_setup(sheetId) {
  var props = PropertiesService.getScriptProperties();
  sheetId = sheetId || ATT_DEFAULT_SHEET_ID;
  if (sheetId) props.setProperty("ATT_SHEET_ID", String(sheetId));
  var report = att_ensureTabs_();
  var secretMade = false;
  if (!props.getProperty("ATT_MASTER_SECRET")) {
    // 2 UUIDv4 (CSPRNG-backed) -> 64 hex chars
    var s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
    props.setProperty("ATT_MASTER_SECRET", s);
    secretMade = true;
  }
  var adminOk = !!props.getProperty("ADMIN_TOKEN") || typeof ADMIN_TOKEN !== "undefined";
  Logger.log("att_setup: " + report.join(", ") + " | ATT_MASTER_SECRET " + (secretMade ? "created" : "already set") +
    " | ADMIN_TOKEN " + (adminOk ? "found" : "NOT FOUND (admin actions will fail)"));
  return { ok: true, tabs: report, secret_created: secretMade, admin_token_found: adminOk };
}

/** Writes `val` into every blank cell of one column. One read + one write. Returns how many cells were filled. */
function att_backfillCol_(tab, col, val) {
  var sh = att_sheet_(tab), n = sh.getLastRow(); if (n < 2) return 0;
  var rng = sh.getRange(2, ATT_HEADERS[tab].indexOf(col) + 1, n - 1, 1), v = rng.getValues(), cnt = 0;
  for (var i = 0; i < v.length; i++) { if (v[i][0] === "" || v[i][0] == null) { v[i][0] = val; cnt++; } }
  if (cnt) rng.setValues(v);
  return cnt;
}

/** ONE-TIME upgrade to multi-user (plan §6 step 1). IDEMPOTENT: re-running changes nothing. Appends the new columns, creates AttUsers,
 *  gives every legacy room / session / request to the admin (owner_user_id "ADMIN", owner_name "Admin"). Never deletes or reorders data. */
function att_migrate(sheetId) {
  var props = PropertiesService.getScriptProperties();
  var setup = att_setup(sheetId || props.getProperty("ATT_SHEET_ID") || undefined);
  var filled = {
    AttRooms: att_backfillCol_("AttRooms", "owner_user_id", ATT_C.ADMIN_ID),
    AttSessions: att_backfillCol_("AttSessions", "owner_user_id", ATT_C.ADMIN_ID) + att_backfillCol_("AttSessions", "owner_name", ATT_C.ADMIN_NAME),
    AttRequests: att_backfillCol_("AttRequests", "owner_user_id", ATT_C.ADMIN_ID),
  };
  Logger.log("att_migrate: " + setup.tabs.join(", ") + " | legacy cells labelled ADMIN: " + JSON.stringify(filled));
  return { ok: true, tabs: setup.tabs, backfilled: filled };
}


/* ############################################################
 * ### from AttFlags.gs
 * ############################################################ */
/**
 * AttFlags.gs — Session 2 (flag engine). MASTER-SPEC §5.
 *
 * PURE: no Apps Script globals, no sheet access, no side effects. Runs unchanged in
 * Node (see the module.exports guard at the bottom) and in Apps Script V8.
 *
 *   att_runFlags_(ctx) -> string[]   (codes only, never shown to students)
 *
 *   ctx = {
 *     session:        {session_id, ...} | "session-id-string",
 *     student_id:     string,
 *     device_id:      string,                       (not used by any current flag)
 *     fp:             string (fp_hash hex),
 *     geo:            {lat,lng,acc} | {denied:true, reason?},   reason -> flag: see ATTF_GEO_REASON_FLAG
 *     serverUtc:      ISO string of THIS check-in (server clock),
 *     hall:           {lat,lng},
 *     priorCheckins:  AttCheckins rows (objects keyed by the §3 headers) — MUST contain
 *                     every row of this session AND every row of this student from any
 *                     session. Extra rows are ignored (filtered here).
 *   }
 *
 * Extra helpers (additive, optional for other files):
 *   att_haversineM_(lat1,lng1,lat2,lng2) -> metres   (S1 can reuse it for AttCheckins.dist_m)
 *   att_flagsToStatus_(flags)            -> "ok" | "review"   (§5: review unless only GEO_WEAK)
 */

var ATTF_CFG = {
  GEO_RADIUS_M: 100,        // GEO_FAR when (dist - acc) > this
  GEO_WEAK_ACC_M: 150,      // GEO_WEAK when acc > this
  SAME_PHONE_MAX_M: 10,     // SAME_PHONE_MULTI_ID: <= 10 m apart
  SAME_PHONE_MAX_SEC: 60,   //                      <= 60 s apart
  IDENTICAL_MIN_IDS: 3,     // IDENTICAL_COORDS: >= 3 distinct IDs
  IDENTICAL_DECIMALS: 6,    //                   identical to 6 decimals
  REPEATED_MIN: 3,          // REPEATED: >= 3 prior flagged (review) check-ins, ever
  // student page (plan section 3); not used by the engine, kept identical to ATT_C and contract/att_config.js
  GEO_HIGH_TIMEOUT_MS: 20000, GEO_LOW_TIMEOUT_MS: 10000, GEO_MAX_AGE_MS: 60000, GEO_SKIP_AFTER_FAILS: 2, SUBMIT_WATCHDOG_MS: 30000
};
// Why a location fix is missing -> the flag it earns (plan §4.2). All of them are "review"; GEO_WEAK stays the only soft flag.
var ATTF_GEO_REASON_FLAG = {
  PERMISSION_DENIED: "GEO_DENIED",
  POSITION_UNAVAILABLE: "GEO_UNAVAILABLE", TIMEOUT: "GEO_UNAVAILABLE", UNSUPPORTED: "GEO_UNAVAILABLE", INSECURE_CONTEXT: "GEO_UNAVAILABLE",
  USER_SKIPPED: "GEO_SKIPPED"
};
/** A missing or unknown reason (old clients) counts as PERMISSION_DENIED. */
function att_geoFlagForReason_(reason) {
  var r = String(reason === undefined || reason === null ? "" : reason).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(ATTF_GEO_REASON_FLAG, r) ? ATTF_GEO_REASON_FLAG[r] : "GEO_DENIED";
}
var ATTF_EARTH_R_M = 6371008.8; // mean Earth radius

/** Great-circle distance in metres. */
function att_haversineM_(lat1, lng1, lat2, lng2) {
  var rad = Math.PI / 180;
  var dLat = (lat2 - lat1) * rad;
  var dLng = (lng2 - lng1) * rad;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * ATTF_EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "ok" unless any flag other than GEO_WEAK is present (§5). */
function att_flagsToStatus_(flags) {
  for (var i = 0; i < (flags || []).length; i++) {
    if (flags[i] !== "GEO_WEAK") return "review";
  }
  return "ok";
}

// ---------- internals (prefix attf_) ----------

function attf_num_(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return NaN;
  var n = Number(v);
  return isFinite(n) ? n : NaN;
}

/** Normalise a geo-ish object ({lat,lng,acc}) -> {ok,lat,lng,acc}. Missing acc counts as 0. */
function attf_geo_(g) {
  if (!g || g.denied) return { ok: false };
  var lat = attf_num_(g.lat), lng = attf_num_(g.lng), acc = attf_num_(g.acc);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false };
  if (isNaN(acc) || acc < 0) acc = 0;
  return { ok: true, lat: lat, lng: lng, acc: acc };
}

/** Distances are compared at millimetre resolution so exact-boundary values (100.0 m) are stable. */
function attf_mm_(m) { return Math.round(m * 1000) / 1000; }

function attf_coordKey_(g) {
  var d = ATTF_CFG.IDENTICAL_DECIMALS;
  return g.lat.toFixed(d) + "|" + g.lng.toFixed(d) + "|" + g.acc.toFixed(d);
}

function attf_flagCodes_(row) {
  var f = row && row.flags;
  if (Array.isArray(f)) return f.map(String);
  return String(f === undefined || f === null ? "" : f).split(/[\s,;|]+/).filter(Boolean);
}

/** A prior check-in counts as "flagged" when its status is review (or, lacking status, a non-soft flag). */
function attf_isFlagged_(row) {
  if (row && row.status !== undefined && row.status !== null && String(row.status) !== "") {
    return String(row.status) === "review";
  }
  return att_flagsToStatus_(attf_flagCodes_(row)) === "review";
}

// ---------- the engine ----------

function att_runFlags_(ctx) {
  ctx = ctx || {};
  var flags = [];
  var student = String(ctx.student_id === undefined || ctx.student_id === null ? "" : ctx.student_id);
  var sid = ctx.session && typeof ctx.session === "object" ? ctx.session.session_id : ctx.session;
  sid = sid === undefined || sid === null ? "" : String(sid);
  var priors = Array.isArray(ctx.priorCheckins) ? ctx.priorCheckins : [];
  var g = attf_geo_(ctx.geo);
  var hall = attf_geo_(ctx.hall && { lat: ctx.hall.lat, lng: ctx.hall.lng, acc: 0 });

  // --- geo ---
  if (!g.ok) {
    flags.push(att_geoFlagForReason_(ctx.geo && ctx.geo.reason)); // {denied:true, reason}, missing, or unusable coordinates (no reason -> GEO_DENIED)
  } else {
    if (hall.ok) {
      var dist = att_haversineM_(g.lat, g.lng, hall.lat, hall.lng);
      if (attf_mm_(dist - g.acc) > ATTF_CFG.GEO_RADIUS_M) flags.push("GEO_FAR");
    }
    if (g.acc > ATTF_CFG.GEO_WEAK_ACC_M) flags.push("GEO_WEAK");
  }

  // --- same-session cross-student flags ---
  var sameSession = sid ? priors.filter(function (p) { return p && String(p.session_id) === sid; }) : [];

  // SAME_PHONE_MULTI_ID: another ID, same fp_hash, <=10 m apart, <=60 s apart.
  // Needs usable coordinates on both rows (distance cannot be judged otherwise).
  var fp = ctx.fp === undefined || ctx.fp === null ? "" : String(ctx.fp);
  var nowMs = Date.parse(ctx.serverUtc);
  if (g.ok && fp && !isNaN(nowMs)) {
    for (var i = 0; i < sameSession.length; i++) {
      var p = sameSession[i];
      if (String(p.student_id) === student) continue;
      if (String(p.fp_hash === undefined || p.fp_hash === null ? "" : p.fp_hash) !== fp) continue;
      var pg = attf_geo_(p);
      var pMs = Date.parse(p.server_utc);
      if (!pg.ok || isNaN(pMs)) continue;
      if (Math.abs(nowMs - pMs) > ATTF_CFG.SAME_PHONE_MAX_SEC * 1000) continue;
      if (attf_mm_(att_haversineM_(g.lat, g.lng, pg.lat, pg.lng)) > ATTF_CFG.SAME_PHONE_MAX_M) continue;
      flags.push("SAME_PHONE_MULTI_ID");
      break;
    }
  }

  // IDENTICAL_COORDS: >=3 distinct IDs (counting this one) with identical lat/lng/acc to 6 decimals.
  if (g.ok) {
    var key = attf_coordKey_(g);
    var ids = {};
    ids[student] = true;
    for (var j = 0; j < sameSession.length; j++) {
      var q = sameSession[j];
      var qg = attf_geo_(q);
      if (qg.ok && attf_coordKey_(qg) === key) ids[String(q.student_id)] = true;
    }
    if (Object.keys(ids).length >= ATTF_CFG.IDENTICAL_MIN_IDS) flags.push("IDENTICAL_COORDS");
  }

  // --- history: REPEATED (>=3 prior flagged check-ins for this student, any session) ---
  var flaggedBefore = 0;
  for (var k = 0; k < priors.length; k++) {
    var r = priors[k];
    if (r && String(r.student_id) === student && attf_isFlagged_(r)) flaggedBefore++;
  }
  if (flaggedBefore >= ATTF_CFG.REPEATED_MIN) flags.push("REPEATED");

  return flags;
}

// Node test hook. `module` does not exist in Apps Script, so this is inert there.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    att_runFlags_: att_runFlags_,
    att_haversineM_: att_haversineM_,
    att_flagsToStatus_: att_flagsToStatus_,
    att_geoFlagForReason_: att_geoFlagForReason_,
    ATTF_CFG: ATTF_CFG
  };
}


/* ############################################################
 * ### from AttTelegram.gs
 * ############################################################ */
/**
 * AttTelegram.gs: attendance notifications on a SEPARATE Telegram bot.
 *
 * Fully self-contained: it does NOT use the main site's bot or any Code.gs Telegram helper.
 * Script Properties used (all new, all attendance-only):
 *   ATT_TG_BOT_TOKEN   token of the NEW bot (from @BotFather)
 *   ATT_TG_ADMIN_IDS   chat id(s) allowed to receive messages and tap buttons, comma separated
 *   ATT_TG_SECRET      webhook secret (att_setupTelegram() creates it)
 *   ATT_WEBAPP_URL     optional; defaults to ATT_DEFAULT_WEBAPP_URL
 *
 * Public surface:
 *   att_notify_(event, data)   session_start | session_close | device_request | flag | digest (never throws)
 *   att_route_(e, payload)     the ONE hook Code.gs.doPost calls; returns an output or null
 *   att_setupTelegram()        run once: creates the secret and reports what is missing
 *   att_setWebhook()           run once: points the new bot at the web app
 *   att_flushDigest(), att_installTrigger(), att_testTelegram()
 */

// Same web app your site already uses. Override with the ATT_WEBAPP_URL property if you ever redeploy to a new URL.
var ATT_DEFAULT_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec";

var ATTT_QUEUE_KEY = "att_flag_queue";
var ATTT_QUEUE_MAX = 200;           // newest kept if exceeded
var ATTT_QUEUE_TTL_SEC = 3600;
var ATTT_DIGEST_MAX_LINES = 25;
var ATTT_TRIGGER_FN = "att_flushDigest";
var ATTT_NOTIFY_SOFT_FLAGS = false; // false: a check-in whose ONLY flag is GEO_WEAK never reaches Telegram
var ATTT_TZ = "Africa/Cairo";

// ---------- small helpers ----------

function attt_e_(v) {
  return String(v === undefined || v === null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function attt_prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ""; }
function attt_adminIds_() { return attt_prop_("ATT_TG_ADMIN_IDS").split(",").map(function (x) { return x.trim(); }).filter(Boolean); }
function attt_json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Raw call to the NEW bot's API. */
function attt_call_(method, body) {
  var token = attt_prop_("ATT_TG_BOT_TOKEN");
  if (!token) { attt_log_("ATT_TG_BOT_TOKEN is not set (attendance Telegram disabled)"); return null; }
  var r = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "post", contentType: "application/json", payload: JSON.stringify(body || {}), muteHttpExceptions: true });
  try { var o = JSON.parse(r.getContentText()); if (!o.ok) attt_log_("telegram " + method + " failed: " + r.getContentText().slice(0, 200)); return o; } catch (e) { return null; }
}

function attt_log_(msg) {
  try { if (typeof Logger !== "undefined") Logger.log(msg); } catch (e) { /* ignore */ }
}

function attt_bool_(v) {
  var s = String(v === undefined || v === null ? "" : v).toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y";
}

/** "HH:mm" in Cairo (display only). Falls back to the raw value. */
function attt_time_(iso) {
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    return Utilities.formatDate(d, ATTT_TZ, "HH:mm");
  } catch (e) { return String(iso || ""); }
}

function attt_codes_(flags) {
  if (Array.isArray(flags)) return flags.map(String).filter(Boolean);
  return String(flags === undefined || flags === null ? "" : flags).split(/[\s,;|]+/).filter(Boolean);
}

/** Sends to every id in ATT_TG_ADMIN_IDS via the new bot. replyMarkup optional (inline keyboard object). */
function attt_send_(html, replyMarkup) {
  attt_adminIds_().forEach(function (id) {
    var body = { chat_id: id, text: html, parse_mode: "HTML" };
    if (replyMarkup) body.reply_markup = replyMarkup;
    attt_call_("sendMessage", body);
  });
}

// ---------- formatters (all dynamic text goes through _esc) ----------

function attt_fmtSessionStart_(d) {
  var lines = ["🟢 <b>Attendance session started</b>"];
  if (d.course) lines.push("Course: " + attt_e_(d.course));
  if (d.room || d.room_id) lines.push("Room: " + attt_e_(d.room || d.room_id));
  if (d.owner_name) lines.push("Owner: " + attt_e_(d.owner_name));
  if (d.session_id) lines.push("Session: <code>" + attt_e_(d.session_id) + "</code>");
  if (d.close_utc) lines.push("Check-in closes: " + attt_e_(attt_time_(d.close_utc)) + " (Cairo)");
  return lines.join("\n");
}

function attt_fmtSessionClose_(d) {
  var lines = ["🔴 <b>Attendance session closed</b>"];
  if (d.course) lines.push("Course: " + attt_e_(d.course));
  if (d.owner_name) lines.push("Owner: " + attt_e_(d.owner_name));
  if (d.session_id) lines.push("Session: <code>" + attt_e_(d.session_id) + "</code>");
  var s = d.summary || d;
  lines.push("Present: <b>" + attt_e_(s.present === undefined ? "?" : s.present) + "</b>" +
             " · Flagged: <b>" + attt_e_(s.flagged === undefined ? "?" : s.flagged) + "</b>" +
             " · Pending requests: <b>" + attt_e_(s.pending === undefined ? "?" : s.pending) + "</b>");
  return lines.join("\n");
}

function attt_fmtDeviceRequest_(d) {
  var hint;
  if (d.fp_match === undefined || d.fp_match === null || d.fp_match === "") {
    hint = "ℹ️ Fingerprint comparison unavailable.";
  } else if (attt_bool_(d.fp_match)) {
    hint = "✅ Fingerprint matches the old device — likely same phone.";
  } else {
    hint = "⚠️ Fingerprint differs from the old device — verify before approving.";
  }
  var lines = ["📱 <b>Device change request</b>"];
  lines.push("Student: <code>" + attt_e_(d.student_id) + "</code>" + (d.name ? " (" + attt_e_(d.name) + ")" : ""));
  lines.push("Request: <code>" + attt_e_(d.req_id) + "</code>");
  if (d.owner_name) lines.push("Owner: " + attt_e_(d.owner_name));
  lines.push(hint);
  return lines.join("\n");
}

function attt_fmtDigest_(d) {
  var items = d.items || [];
  // merge by session + student
  var merged = {}, order = [];
  items.forEach(function (it) {
    var k = String(it.s) + "\u0000" + String(it.id);
    if (!merged[k]) { merged[k] = { s: it.s, id: it.id, o: it.o || "", codes: [], n: 0 }; order.push(k); }
    merged[k].n++;
    attt_codes_(it.f).forEach(function (c) { if (merged[k].codes.indexOf(c) < 0) merged[k].codes.push(c); });
  });
  var lines = ["🚩 <b>Flag digest</b> — " + order.length + " student" + (order.length === 1 ? "" : "s") +
               ", " + items.length + " check-in" + (items.length === 1 ? "" : "s")];
  order.slice(0, ATTT_DIGEST_MAX_LINES).forEach(function (k) {
    var m = merged[k];
    lines.push("• <code>" + attt_e_(m.id) + "</code> — " + attt_e_(m.codes.join(", ")) +
               (m.s || m.o ? " <i>(" + attt_e_([m.s, m.o].filter(Boolean).join(" · ")) + ")</i>" : ""));
  });
  if (order.length > ATTT_DIGEST_MAX_LINES) lines.push("… and " + (order.length - ATTT_DIGEST_MAX_LINES) + " more (see AttFlagLog).");
  return lines.join("\n");
}

// ---------- flag queue (CacheService) ----------

function attt_withLock_(fn) {
  var lock = null, got = false;
  try { lock = LockService.getScriptLock(); got = lock.tryLock(3000); } catch (e) { got = false; }
  try { return fn(); } // best effort even if the lock was not obtained
  finally { if (got) { try { lock.releaseLock(); } catch (e) { /* ignore */ } } }
}

function attt_enqueueFlag_(d) {
  var codes = attt_codes_(d.flags);
  if (!codes.length) return;
  if (!ATTT_NOTIFY_SOFT_FLAGS && codes.every(function (c) { return c === "GEO_WEAK"; })) return;
  var item = { t: Date.now(), s: d.session_id || "", id: d.student_id || "", f: codes, o: d.owner_name || "" };
  if (d.dist_m !== undefined && d.dist_m !== null && d.dist_m !== "") item.d = d.dist_m;
  attt_withLock_(function () {
    var cache = CacheService.getScriptCache();
    var q = [];
    try { q = JSON.parse(cache.get(ATTT_QUEUE_KEY) || "[]"); } catch (e) { q = []; }
    q.push(item);
    if (q.length > ATTT_QUEUE_MAX) q = q.slice(q.length - ATTT_QUEUE_MAX);
    cache.put(ATTT_QUEUE_KEY, JSON.stringify(q), ATTT_QUEUE_TTL_SEC);
  });
}

function attt_drainQueue_() {
  return attt_withLock_(function () {
    var cache = CacheService.getScriptCache();
    var q = [];
    try { q = JSON.parse(cache.get(ATTT_QUEUE_KEY) || "[]"); } catch (e) { q = []; }
    if (q.length) cache.remove(ATTT_QUEUE_KEY);
    return q;
  });
}

// ---------- public API ----------

/** Never throws. Call outside the attendance lock. */
function att_notify_(event, data) {
  try {
    data = data || {};
    switch (String(event)) {
      case "session_start":
        attt_send_(attt_fmtSessionStart_(data));
        break;
      case "session_close":
        try { att_flushDigest(); } catch (e1) { attt_log_("att_notify_ pre-close flush failed: " + e1); }
        attt_send_(attt_fmtSessionClose_(data));
        break;
      case "device_request":
        attt_send_(attt_fmtDeviceRequest_(data), {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: "ad:" + data.req_id },
            { text: "❌ Deny", callback_data: "dd:" + data.req_id }
          ]]
        });
        break;
      case "flag":
        attt_enqueueFlag_(data);
        break;
      case "digest":
        if ((data.items || []).length) attt_send_(attt_fmtDigest_(data));
        break;
      default:
        attt_log_("att_notify_: unknown event " + event);
    }
  } catch (e) {
    attt_log_("att_notify_(" + event + ") failed: " + e);
  }
}

/** Time-trigger target. Sends one digest if anything is queued; returns the number of queued check-ins. */
function att_flushDigest() {
  var items = attt_drainQueue_();
  if (!items || !items.length) return 0;
  att_notify_("digest", { items: items });
  return items.length;
}

/** Run once from the editor (needs authorisation). Idempotent: replaces any existing flush trigger. */
function att_installTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === ATTT_TRIGGER_FN) { ScriptApp.deleteTrigger(t); removed++; }
  });
  // Apps Script recurring triggers cannot be shorter than 1 minute (everyMinutes accepts 1, 5, 10, 15, 30).
  ScriptApp.newTrigger(ATTT_TRIGGER_FN).timeBased().everyMinutes(1).create();
  return "Installed " + ATTT_TRIGGER_FN + " every 1 minute (replaced " + removed + " old trigger(s)).";
}

/** Plain-text verdict for editMessageText (no parse_mode, so no escaping). */
function att_decideFromTelegram_(reqId, approve) {
  var decision = approve ? "approve" : "deny";
  try {
    var res = att_applyDecision_(String(reqId), decision);
    if (res && res.ok === false) {
      return "\u26a0\ufe0f Request " + reqId + " not " + (approve ? "approved" : "denied") + ": " + (res.error || res.code || "unknown error");
    }
    return (approve ? "\u2705 Approved" : "\u274c Denied") + " device change " + reqId;
  } catch (e) {
    attt_log_("att_decideFromTelegram_ failed: " + e);
    return "\u26a0\ufe0f Could not " + decision + " request " + reqId + ": " + (e && e.message ? e.message : e);
  }
}

/** Webhook for the NEW bot. URL must carry ?att_tg=<ATT_TG_SECRET>; tapper must be in ATT_TG_ADMIN_IDS. */
function att_handleTelegram_(e, update) {
  try {
    var secret = attt_prop_("ATT_TG_SECRET");
    if (!secret || !e || !e.parameter || e.parameter.att_tg !== secret) return attt_json_({ ok: true });
    var cq = update && update.callback_query;
    if (!cq || !cq.from || !cq.data) return attt_json_({ ok: true });
    if (attt_adminIds_().indexOf(String(cq.from.id)) === -1) return attt_json_({ ok: true });
    var m = /^(ad|dd):(\S+)$/.exec(String(cq.data));
    if (!m) return attt_json_({ ok: true });
    // Apps Script answers POSTs with a redirect, Telegram retries; handle each update_id once.
    var seenKey = "attu:" + update.update_id, cache = CacheService.getScriptCache();
    if (cache.get(seenKey)) return attt_json_({ ok: true });
    cache.put(seenKey, "1", 21600);
    attt_call_("answerCallbackQuery", { callback_query_id: cq.id });   // clear the spinner first
    var approve = m[1] === "ad", verdict = att_decideFromTelegram_(m[2], approve);
    var chatId = cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id;
    if (cq.message) {
      attt_call_("editMessageText", { chat_id: chatId, message_id: cq.message.message_id,
        text: String(cq.message.text || "") + "\n\n" + verdict, entities: cq.message.entities || [] });
    } else {
      attt_call_("sendMessage", { chat_id: chatId, text: verdict });
    }
  } catch (err) { attt_log_("att_handleTelegram_ failed: " + err); }
  return attt_json_({ ok: true });
}

/** The single hook for Code.gs.doPost: returns an output for attendance traffic, null for everything else. */
function att_route_(e, payload) {
  try {
    if (e && e.parameter && e.parameter.att_tg !== undefined) return att_handleTelegram_(e, payload);
    if (payload && String(payload.action || "").indexOf("att_") === 0) return attt_json_(att_dispatch_(payload));
  } catch (err) { attt_log_("att_route_ failed: " + err); return attt_json_({ ok: false, error: "Server error", code: "SERVER_ERROR" }); }
  return null;
}

/** Run once: creates ATT_TG_SECRET and tells you what is still missing. */
function att_setupTelegram() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty("ATT_TG_SECRET")) p.setProperty("ATT_TG_SECRET", (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""));
  var missing = ["ATT_TG_BOT_TOKEN", "ATT_TG_ADMIN_IDS"].filter(function (k) { return !p.getProperty(k); });
  var msg = missing.length ? "STILL MISSING Script Properties: " + missing.join(", ") : "Telegram properties OK. Next: run att_setWebhook()";
  Logger.log("att_setupTelegram: " + msg);
  return msg;
}

/** Run once after deploying: points the NEW bot's webhook at the web app (tapping Approve/Deny then works). */
function att_setWebhook() {
  var secret = attt_prop_("ATT_TG_SECRET");
  if (!secret) throw new Error("Run att_setupTelegram() first");
  var base = attt_prop_("ATT_WEBAPP_URL") || ATT_DEFAULT_WEBAPP_URL;
  var res = attt_call_("setWebhook", { url: base + "?att_tg=" + secret, allowed_updates: ["callback_query"], drop_pending_updates: true });
  Logger.log("att_setWebhook: " + JSON.stringify(res));
  return res;
}

/** Shows what Telegram thinks the webhook is (pending count, last error). */
function att_webhookInfo() {
  var r = attt_call_("getWebhookInfo", {});
  Logger.log("att_webhookInfo: " + JSON.stringify(r));
  return r;
}

/** Dev helper (run from the editor): sample request with buttons + sample flag digest. */
function att_testTelegram() {
  att_notify_("device_request", { req_id: "R-TEST", student_id: "20240001", name: "Test Student", fp_match: true });
  att_notify_("flag", { session_id: "S-TEST", student_id: "20240002", flags: ["GEO_FAR", "REPEATED"], dist_m: 312 });
  att_notify_("flag", { session_id: "S-TEST", student_id: "20240003", flags: ["GEO_DENIED"] });
  return "sent; digest flushed " + att_flushDigest() + " queued check-in(s)";
}

/* ===========================================================================
 * ATTENDANCE MULTI-USER ACCOUNTS (merged from the former AttUsers.gs; one file now): accounts and authentication (Session 2, MASTER_PLAN_ATTENDANCE_MULTIUSER §4.4-§4.6).
 * Lives in AttendanceAll.gs: the Apps Script project is just Code.gs + AttendanceAll.gs. No Code.gs change is needed
 * (att_route_ already sends every att_* action to att_dispatch_).
 *
 * Public surface:
 *   att_login_(p)            {password}            -> {ok, token, user, expires_at}   (public)
 *   att_me_(p, u)            any signed-in caller  -> {ok, user}
 *   att_userCreate_(p, u)    admin  {name}         -> {ok, user, password}            (password shown ONCE)
 *   att_users_(p, u)         admin                 -> {ok, users}                      (never includes hashes)
 *   att_userUpdate_(p, u)    admin  {user_id, name?, status?}
 *   att_userReset_(p, u)     admin  {user_id}      -> {ok, user, password}            (new password shown ONCE)
 *   att_auth_(p)             internal: {ok:true, user} | {ok:false, err}
 *
 * Token  = "u1." + base64url({u,r,e,v}) + "." + HMAC(master, "ut:" + payload).slice(0,32)
 *          u = user_id, r = role (always "teacher": a signed token can NEVER grant admin), e = expiry (epoch s), v = first 8 hex of pw_hash
 *          (v makes a password reset kill that user's old tokens). TTL 12 h.
 * pw_hash = HMAC-SHA256(ATT_MASTER_SECRET, canonical password). Passwords are system-generated (20 chars from a 32-symbol
 *          alphabet = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX); the canonical form is upper-case letters/digits only,
 *          so typing it in lower case or without the dashes still works.
 * The raw ADMIN_TOKEN keeps working in the same `token` field and resolves to role "admin" (backward compatible).
 * =========================================================================== */

var ATTU_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no 0/O/1/I
var ATTU_PW_LEN = 20;

/* ───────── passwords ───────── */
function att_pwCanon_(pw) { return String(pw == null ? "" : pw).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function att_pwHash_(pw, master) { return att_hmacHex_(master || att_masterSecret_(), att_pwCanon_(pw)); }
/** Random bytes from UUIDv4 (CSPRNG-backed). The 2 fixed nibbles of each UUID (version, variant) are skipped. */
function att_randBytes_(n) {
  var out = [];
  while (out.length < n) {
    var hex = Utilities.getUuid().replace(/-/g, "");
    hex = hex.slice(0, 12) + hex.slice(13, 16) + hex.slice(17);   // drop the version + variant nibbles -> 30 random hex digits
    for (var i = 0; i + 1 < hex.length && out.length < n; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  }
  return out;
}
/** 20 random symbols, shown in groups of 5: "K7M2Q-XH9TD-3WPRA-6NBYE". */
function att_genPassword_() {
  var b = att_randBytes_(ATTU_PW_LEN), s = "";
  for (var i = 0; i < b.length; i++) s += ATTU_ALPHABET.charAt(b[i] % 32);   // 256 % 32 == 0: no modulo bias
  return s.replace(/(.{5})(?=.)/g, "$1-");
}

/* ───────── signed user tokens ───────── */
function att_userTokenMake_(userId, pv, expSec, master) {
  var body = JSON.stringify({ u: String(userId), r: "teacher", e: expSec, v: String(pv || "") });
  var b64 = Utilities.base64EncodeWebSafe(body, Utilities.Charset.UTF_8).replace(/=+$/, "");
  return "u1." + b64 + "." + att_hmacHex_(master || att_masterSecret_(), "ut:" + b64).slice(0, 32);
}
/** {u,r,e,v} for a validly signed, unexpired token, else null. */
function att_userTokenCheck_(token, master, nowSec) {
  try {
    var parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "u1" || !parts[1]) return null;
    var sig = att_hmacHex_(master || att_masterSecret_(), "ut:" + parts[1]).slice(0, 32);
    if (!att_eq_(sig, parts[2])) return null;
    var padded = parts[1] + ["", "===", "==", "="][parts[1].length % 4];
    var o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString());
    if (typeof o.u !== "string" || !o.u || typeof o.e !== "number") return null;
    if (o.e <= (nowSec != null ? nowSec : Math.floor(Date.now() / 1000))) return null;
    return o;
  } catch (e) { return null; }
}

/* ───────── user rows ───────── */
function att_userPublic_(r) { return { user_id: r.user_id, name: r.name, status: r.status, created_at: r.created_at, last_login: r.last_login }; }
/** {name,status,pv} for a user id (cached CACHE_SEC), or null. This is the "still active?" check made on EVERY call. */
function att_userState_(id) {
  id = String(id || ""); if (!id) return null;
  var c = att_cget_("att:u:" + id); if (c) return c;
  var r = att_rows_("AttUsers").filter(function (x) { return x.user_id === id; })[0];
  if (!r) return null;
  var st = { name: r.name, status: r.status, pv: String(r.pw_hash || "").slice(0, 8) };
  att_cput_("att:u:" + id, st); return st;
}
/** user_id -> display name for every account (+ the built-in admin). */
function att_userNames_() {
  var m = {}; m[ATT_C.ADMIN_ID] = ATT_C.ADMIN_NAME;
  att_rows_("AttUsers").forEach(function (r) { m[r.user_id] = r.name; });
  return m;
}

/* ───────── auth ───────── */
/** Resolves p.token to a caller. Never throws for bad input.
 *  -> {ok:true, user:{user_id,name,role}} | {ok:false, err:{ok:false, code}} (UNAUTHORIZED | USER_DISABLED) */
function att_auth_(p) {
  var t = String((p && p.token) || "");
  if (!t) return { ok: false, err: att_err_("UNAUTHORIZED", "Unauthorized") };
  var at = att_adminToken_();
  if (at && att_eq_(t, at)) return { ok: true, user: att_adminUser_() };
  var o = att_userTokenCheck_(t);
  if (!o) return { ok: false, err: att_err_("UNAUTHORIZED", "Unauthorized") };
  var st = att_userState_(o.u);
  if (!st) return { ok: false, err: att_err_("UNAUTHORIZED", "Unauthorized") };
  if (st.status !== "active") return { ok: false, err: att_err_("USER_DISABLED", "This account is disabled") };
  if (String(o.v || "") !== st.pv) return { ok: false, err: att_err_("UNAUTHORIZED", "Session expired, sign in again") };   // password was reset
  return { ok: true, user: { user_id: o.u, name: st.name, role: "teacher" } };
}

/** Login throttle. Apps Script exposes no client IP, so the lock is GLOBAL (plan §4.5, accepted trade-off). */
function att_loginLocked_() {
  var l = att_cget_("att:lock");
  if (!l) return 0;
  var left = Math.ceil((l.until - Date.now()) / 1000);
  return left > 0 ? left : 0;
}
function att_loginFail_() {
  var now = Date.now(), f = att_cget_("att:lf");
  if (!f || now - f.t0 > ATT_C.LOGIN_WINDOW_SEC * 1000) f = { n: 0, t0: now };
  f.n++;
  if (f.n >= ATT_C.LOGIN_MAX_FAILS) {
    try { CacheService.getScriptCache().put("att:lock", JSON.stringify({ until: now + ATT_C.LOGIN_LOCK_SEC * 1000 }), ATT_C.LOGIN_LOCK_SEC); } catch (e) {}
    att_cdel_("att:lf");
    return;
  }
  var ttl = Math.max(1, ATT_C.LOGIN_WINDOW_SEC - Math.floor((now - f.t0) / 1000));
  try { CacheService.getScriptCache().put("att:lf", JSON.stringify(f), ttl); } catch (e) {}
}

function att_login_(p) {
  var left = att_loginLocked_();
  if (left) { var lk = att_err_("LOCKED", "Too many failed attempts. Try again in " + Math.ceil(left / 60) + " min."); lk.retry_after_sec = left; return lk; }
  var canon = att_pwCanon_(p && p.password);
  if (canon.length < 8) { att_loginFail_(); return att_err_("BAD_PASSWORD", "Wrong password"); }
  var h = att_pwHash_(canon), match = null;
  att_rows_("AttUsers").forEach(function (u) { if (att_eq_(h, String(u.pw_hash || "")) && !match) match = u; });   // compares ALL rows: no early exit
  if (!match) { att_loginFail_(); return att_err_("BAD_PASSWORD", "Wrong password"); }
  if (match.status !== "active") return att_err_("USER_DISABLED", "This account is disabled");
  att_withLock_(function () { att_update_("AttUsers", match._row, { last_login: att_iso_() }); return true; });
  var exp = Math.floor(Date.now() / 1000) + ATT_C.USER_TOKEN_TTL_SEC;
  return att_ok_({ token: att_userTokenMake_(match.user_id, h.slice(0, 8), exp), user: { user_id: match.user_id, name: match.name, role: "teacher" }, expires_at: exp * 1000 });
}

function att_me_(p, u) { return att_ok_({ user: { user_id: u.user_id, name: u.name, role: u.role } }); }

/* ───────── admin: user management ───────── */
function att_cleanName_(v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, ATT_C.NAME_MAX); }

function att_userCreate_(p, u) {
  var name = att_cleanName_(p.name);
  if (name.length < 2) return att_err_("BAD_REQUEST", "Name is required");
  if (name.toLowerCase() === ATT_C.ADMIN_NAME.toLowerCase()) return att_err_("BAD_REQUEST", "That name is reserved");
  var out = null;
  var res = att_withLock_(function () {
    var rows = att_rows_("AttUsers"), taken = {}, ids = {}, pw, h;
    rows.forEach(function (r) { taken[r.pw_hash] = 1; ids[r.user_id] = 1; });
    do { pw = att_genPassword_(); h = att_pwHash_(pw); } while (taken[h]);
    var id; do { id = "U-" + att_hex_(att_randBytes_(4)).toUpperCase(); } while (ids[id]);
    var row = { user_id: id, name: name, pw_hash: h, status: "active", created_at: att_iso_(), last_login: "" };
    att_append_("AttUsers", row);
    out = { user: att_userPublic_(row), password: pw };
    return att_ok_(out);
  });
  return res;
}

function att_users_() {
  var rows = att_rows_("AttUsers").map(att_userPublic_);
  rows.sort(function (a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0; });
  return att_ok_({ users: rows });
}

function att_userUpdate_(p) {
  var id = String(p.user_id || ""), upd = {};
  if (p.name !== undefined) {
    var name = att_cleanName_(p.name);
    if (name.length < 2) return att_err_("BAD_REQUEST", "Name is required");
    if (name.toLowerCase() === ATT_C.ADMIN_NAME.toLowerCase()) return att_err_("BAD_REQUEST", "That name is reserved");
    upd.name = name;
  }
  if (p.status !== undefined) {
    var st = String(p.status);
    if (st !== "active" && st !== "disabled") return att_err_("BAD_REQUEST", "status must be active|disabled");
    upd.status = st;
  }
  if (!Object.keys(upd).length) return att_err_("BAD_REQUEST", "Nothing to update");
  var res = att_withLock_(function () {
    var r = att_rows_("AttUsers").filter(function (x) { return x.user_id === id; })[0];
    if (!r) return att_err_("NO_USER");
    att_update_("AttUsers", r._row, upd);
    var o = att_userPublic_(r); Object.keys(upd).forEach(function (k) { o[k] = upd[k]; });
    return att_ok_({ user: o });
  });
  if (res.ok) att_cdel_("att:u:" + id);   // script cache is shared by every execution: a disabled user is out immediately
  return res;
}

function att_userReset_(p) {
  var id = String(p.user_id || ""), pw = null;
  var res = att_withLock_(function () {
    var rows = att_rows_("AttUsers"), r = rows.filter(function (x) { return x.user_id === id; })[0];
    if (!r) return att_err_("NO_USER");
    var taken = {}; rows.forEach(function (x) { taken[x.pw_hash] = 1; });
    var h; do { pw = att_genPassword_(); h = att_pwHash_(pw); } while (taken[h]);
    att_update_("AttUsers", r._row, { pw_hash: h });
    return att_ok_({ user: att_userPublic_(r), password: pw });
  });
  if (res.ok) att_cdel_("att:u:" + id);
  return res;
}
