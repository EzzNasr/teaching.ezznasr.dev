/* ===========================================================================
 * AttendanceAll.gs: the whole attendance backend in ONE file.
 * Merged from: Attendance.gs, AttSetup.gs, AttFlags.gs, AttTelegram.gs.
 * Add it to the SAME Apps Script project as Code.gs (Code.gs needs only the one att_route_ hook line).
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
  WINDOW_SEC: 10, GRACE_SEC: 3, TICKET_SEC: 90, SESSION_MIN: 5,
  GEO_RADIUS_M: 100, GEO_WEAK_ACC_M: 150, ID_REGEX: /^[0-9]{4,12}$/,
  NAME_MAX: 60, TOKEN_LEN: 16, CACHE_SEC: 60, LOCK_MS: 25000, DUP_START_MS: 20000,
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
  var sh = att_sheet_(name), n = sh.getLastRow();
  if (n < 2) return [];
  var v = sh.getRange(1, 1, n, ATT_HEADERS[name].length).getValues(), h = v[0], out = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < h.length; j++) o[h[j]] = v[i][j] === null ? "" : (typeof v[i][j] === "string" ? v[i][j] : String(v[i][j]));
    out.push(o);
  }
  return out;
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

/* ───────── dispatcher ───────── */
function att_dispatch_(p) {
  p = p || {};
  var a = String(p.action || "");
  var ADMIN = { att_start_session: att_startSession_, att_close_session: att_closeSession_, att_live: att_live_, att_rooms: att_rooms_,
    att_calibrate_room: att_calibrateRoom_, att_requests: att_requests_, att_decide_request: att_decideRequest_, att_flagged: att_flagged_, att_export: att_export_, att_roster: att_roster_ };
  var STUDENT = { att_ticket: att_ticketAction_, att_signup: att_signup_, att_attend: att_attend_, att_change_device: att_changeDevice_, att_status: att_status_ };
  try {
    if (ADMIN[a]) { if (!att_requireAdmin_(p)) return att_err_("UNAUTHORIZED", "Unauthorized"); return ADMIN[a](p); }
    if (STUDENT[a]) return STUDENT[a](p);
    return att_err_("UNKNOWN_ACTION");
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
  var exp = Math.floor(now / 1000) + ATT_C.TICKET_SEC;
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

function att_normGeo_(g) {
  if (g && g.denied !== true && isFinite(Number(g.lat)) && isFinite(Number(g.lng)) && g.lat !== null && g.lng !== null) {
    var acc = Number(g.acc); return { lat: Number(g.lat), lng: Number(g.lng), acc: isFinite(acc) && acc >= 0 ? acc : 0 };
  }
  return { denied: true };
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
  var geo = att_normGeo_(p.geo), fp = String(p.fp || ""), serverUtc = att_iso_();
  var hall = (s.hall_lat != null && s.hall_lng != null) ? { lat: s.hall_lat, lng: s.hall_lng } : null;
  var dist = (!geo.denied && hall) ? att_haversine_(geo.lat, geo.lng, hall.lat, hall.lng) : null;

  // priors read OUTSIDE the lock (keeps the critical section short); flags are pure.
  var priors = att_rows_("AttCheckins").filter(function (r) { return r.session_id === s.session_id || r.student_id === sid; }).map(function (r) {
    return { checkin_id: r.checkin_id, session_id: r.session_id, student_id: r.student_id, device_id: r.device_id, server_utc: r.server_utc,
      lat: att_num_(r.lat), lng: att_num_(r.lng), acc: att_num_(r.acc), dist_m: att_num_(r.dist_m), fp_hash: r.fp_hash,
      flags: r.flags ? r.flags.split(",") : [], status: r.status };
  });
  var flags = [];
  try { flags = att_runFlags_({ session: s, student_id: sid, device_id: dev.device_id, fp: fp, geo: geo, serverUtc: serverUtc, hall: hall, priorCheckins: priors }) || []; }
  catch (e) { console.error("runFlags: " + e); flags = []; }
  var status = flags.some(function (f) { return f !== "GEO_WEAK"; }) ? "review" : "ok";

  var res = att_withLock_(function () {
    var sh = att_sheet_("AttCheckins"), n = sh.getLastRow();
    if (n >= 2) {
      var v = sh.getRange(2, 1, n - 1, 3).getValues(); // A checkin_id, B session_id, C student_id
      for (var i = 0; i < v.length; i++) {
        if (String(v[i][1]) === s.session_id && String(v[i][2]) === sid) {
          return att_ok_({ status: "recorded", server_utc: String(sh.getRange(i + 2, 5).getValue()), dup: true });
        }
      }
    }
    att_append_("AttCheckins", { checkin_id: Utilities.getUuid(), session_id: s.session_id, student_id: sid, device_id: dev.device_id, server_utc: serverUtc,
      lat: geo.denied ? "" : geo.lat, lng: geo.denied ? "" : geo.lng, acc: geo.denied ? "" : geo.acc, dist_m: dist == null ? "" : Math.round(dist * 10) / 10,
      fp_hash: fp, flags: flags.join(","), status: status });
    return att_ok_({ status: "recorded", server_utc: serverUtc });
  });
  if (!res.ok) return res;
  if (!res.dup && flags.length) {
    flags.forEach(function (f) { att_logFlag_(s.session_id, sid, f, dist == null ? "" : "dist_m=" + Math.round(dist)); });
    att_safeNotify_("flag", { session_id: s.session_id, student_id: sid, flags: flags, status: status });
  }
  return att_ok_({ status: "recorded", server_utc: res.server_utc, name: att_studentName_(sid) }); // flags are NEVER returned
}

function att_changeDevice_(p) {
  var t = att_checkTicket_(p.ticket); if (!t) return att_err_("TICKET_EXPIRED");
  var sid = String(p.student_id || "").trim(), secret = String(p.new_secret || "");
  if (!ATT_C.ID_REGEX.test(sid)) return att_err_("BAD_ID");
  if (secret.length < 8) return att_err_("BAD_REQUEST", "Missing device secret");
  var hash = att_sha256Hex_(secret), fp = String(p.fp || ""), nowIso = att_iso_();
  var res = att_withLock_(function () {
    var st = att_rows_("AttStudents").filter(function (x) { return x.student_id === sid; })[0];
    if (!st) return att_err_("UNKNOWN_STUDENT");
    var devs = att_rows_("AttDevices");
    var active = devs.filter(function (d) { return d.student_id === sid && d.status === "active"; })[0];
    if (devs.some(function (d) { return d.secret_hash === hash && d.status === "active" && d.student_id !== sid; })) return att_err_("DEVICE_BOUND_OTHER_ID");
    if (active && active.secret_hash === hash) return att_err_("DEVICE_ALREADY_ACTIVE");
    var reqs = att_rows_("AttRequests");
    var pend = reqs.filter(function (r) { return r.student_id === sid && r.status === "pending"; })[0];
    if (pend) return att_ok_({ status: "pending", req_id: pend.req_id });
    var rid = "R-" + Utilities.getUuid().replace(/-/g, "").slice(0, 10);
    var match = !!(active && active.fp_hash && active.fp_hash === fp);
    att_append_("AttRequests", { req_id: rid, student_id: sid, new_device_id: "D-" + hash.slice(0, 16), new_secret_hash: hash, new_fp_hash: fp,
      fp_match: match ? "true" : "false", status: "pending", created_at: nowIso, decided_at: "" });
    return att_ok_({ status: "pending", req_id: rid, _new: true, _match: match });
  });
  if (res.ok && res._new) { att_safeNotify_("device_request", { req_id: res.req_id, student_id: sid, fp_match: res._match, session_id: t.s }); }
  if (res.ok) { delete res._new; delete res._match; }
  return res;
}

function att_status_(p) {
  var s = att_getSession_(p.session_id); if (!s) return att_err_("NO_SESSION");
  var now = Date.now();
  return att_ok_({ close_utc: s.close_utc, server_utc: att_iso_(new Date(now)), status: att_isOpen_(s, now) ? "open" : "closed" });
}

/* ───────── admin actions ───────── */
function att_startSession_(p) {
  var room = null;
  if (p.room_id) { room = att_getRoom_(p.room_id); if (!room) return att_err_("NO_ROOM"); }
  var course = String(p.course || "").slice(0, 100), roomId = room ? room.room_id : "";
  var start = new Date(), close = new Date(start.getTime() + ATT_C.SESSION_MIN * 60000);
  var sid = "S-" + start.getTime().toString(36).toUpperCase() + Utilities.getUuid().slice(0, 4).toUpperCase();
  var s = { session_id: sid, course: course, room_id: roomId, start_utc: att_iso_(start), close_utc: att_iso_(close),
    status: "open", hall_lat: room ? room.lat : "", hall_lng: room ? room.lng : "" };
  var existing = null;
  att_withLock_(function () {
    // A double tap or a client retry within 20 s must not create a second session.
    existing = att_rows_("AttSessions").filter(function (r) {
      return r.status === "open" && r.course === course && r.room_id === roomId && start.getTime() - Date.parse(r.start_utc) < ATT_C.DUP_START_MS;
    }).pop() || null;
    if (!existing) att_append_("AttSessions", s);
    return true;
  });
  if (existing) {
    return att_ok_({ session_id: existing.session_id, session_key: att_sessionKey_(existing.session_id), start_utc: existing.start_utc, close_utc: existing.close_utc });
  }
  s.hall_lat = att_num_(s.hall_lat); s.hall_lng = att_num_(s.hall_lng); att_cput_("att:s:" + sid, s);
  att_safeNotify_("session_start", { session_id: sid, course: s.course, room: room ? room.name : "", start_utc: s.start_utc, close_utc: s.close_utc });
  return att_ok_({ session_id: sid, session_key: att_sessionKey_(sid), start_utc: s.start_utc, close_utc: s.close_utc });
}

function att_counts_(sessionId) {
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.session_id === sessionId; });
  var pending = att_rows_("AttRequests").filter(function (r) { return r.status === "pending"; }).length;
  return { rows: rows, present: rows.length, flagged: rows.filter(function (r) { return r.status === "review"; }).length, pending: pending };
}

function att_closeSession_(p) {
  var s = att_getSession_(p.session_id); if (!s) return att_err_("NO_SESSION");
  if (s.status !== "closed") {
    var row = att_rows_("AttSessions").filter(function (x) { return x.session_id === s.session_id; })[0];
    var nowIso = att_iso_();
    att_withLock_(function () { att_update_("AttSessions", row._row, { status: "closed", close_utc: nowIso }); return true; });
    s.status = "closed"; s.close_utc = nowIso; att_cput_("att:s:" + s.session_id, s);
  }
  var c = att_counts_(s.session_id), summary = { present: c.present, flagged: c.flagged, pending: c.pending };
  att_safeNotify_("session_close", { session_id: s.session_id, course: s.course, summary: summary });
  return att_ok_({ summary: summary });
}

/** Admin activity feed for one session, newest first: registrations (yellow), check-ins (green), attempted cheating (red).
 *  Cheating events are masked HERE: only {l: first letter of the name, d: last 2 digits of the ID} ever leave the server. */
function att_feed_(sessionId) {
  var s = sessionId ? att_getSession_(sessionId) : null; if (!s) return [];
  var names = {}; att_rows_("AttStudents").forEach(function (x) { names[x.student_id] = x; });
  var ev = [];
  Object.keys(names).forEach(function (id) {
    var x = names[id]; if (x.created_at && x.created_at >= s.start_utc) ev.push({ t: x.created_at, k: "reg", n: x.name, id: id });
  });
  att_rows_("AttCheckins").forEach(function (r) {
    if (r.session_id === sessionId) ev.push({ t: r.server_utc, k: "att", n: (names[r.student_id] || {}).name || "", id: r.student_id });
  });
  att_rows_("AttFlagLog").forEach(function (r) {
    if (r.session_id !== sessionId || r.code === "GEO_WEAK") return;
    var m = /owner=(\d+)/.exec(r.detail || ""), who = m ? m[1] : r.student_id, nm = (names[who] || {}).name || "";
    if (!nm) { var n2 = /;n=(.)/.exec(r.detail || ""); nm = n2 ? n2[1] : ""; }
    ev.push({ t: r.ts_utc, k: "bad", l: nm ? nm.charAt(0).toUpperCase() : "?", d: String(who).slice(-2) });
  });
  ev.sort(function (a, b) { return a.t < b.t ? 1 : a.t > b.t ? -1 : 0; });
  return ev.slice(0, 80);
}

function att_live_(p) {
  var c = att_counts_(String(p.session_id || ""));
  var registered = att_rows_("AttStudents").filter(function (x) { return x.status === "active"; }).length;
  var recent = c.rows.slice(-10).reverse().map(function (r) { return { student_id: r.student_id, server_utc: r.server_utc, status: r.status }; });
  return att_ok_({ registered: registered, present: c.present, flagged: c.flagged, pending: c.pending, recent: recent, feed: att_feed_(String(p.session_id || "")) });
}

function att_rooms_() {
  return att_ok_({ rooms: att_rows_("AttRooms").map(function (r) {
    return { room_id: r.room_id, name: r.name, lat: att_num_(r.lat), lng: att_num_(r.lng), samples: att_num_(r.samples), calibrated_at: r.calibrated_at };
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

function att_calibrateRoom_(p) {
  var name = String(p.name || "").trim().slice(0, 60); if (!name) return att_err_("BAD_REQUEST", "Room name required");
  var avg = att_average_(p.samples); if (!avg) return att_err_("BAD_REQUEST", "No valid samples");
  var room = null;
  var res = att_withLock_(function () {
    var ex = att_rows_("AttRooms").filter(function (r) { return r.name === name; })[0], nowIso = att_iso_();
    if (ex) { att_update_("AttRooms", ex._row, { lat: avg.lat, lng: avg.lng, samples: avg.n, calibrated_at: nowIso }); room = { room_id: ex.room_id }; }
    else { room = { room_id: "RM-" + Utilities.getUuid().replace(/-/g, "").slice(0, 8) }; att_append_("AttRooms", { room_id: room.room_id, name: name, lat: avg.lat, lng: avg.lng, samples: avg.n, calibrated_at: nowIso }); }
    room.name = name; room.lat = avg.lat; room.lng = avg.lng; room.samples = avg.n; room.calibrated_at = nowIso;
    return att_ok_({ room: room });
  });
  if (res.ok) att_cdel_("att:r:" + room.room_id);
  return res;
}

function att_requests_() {
  var rows = att_rows_("AttRequests").reverse().map(function (r) {
    var o = att_clean_(r); delete o.new_secret_hash; o.fp_match = (o.fp_match === "true"); return o;
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
function att_decideRequest_(p) {
  var d = String(p.decision || ""); if (d !== "approve" && d !== "deny") return att_err_("BAD_REQUEST", "decision must be approve|deny");
  var r = att_decide_(String(p.req_id || ""), d === "approve");
  return r.ok ? att_ok_({}) : r;
}
/** Interface for AttTelegram.gs (att_decideFromTelegram_ lives there and returns the verdict text).
 *  decision = "approve" | "deny". Returns {ok:true,...} or {ok:false,code}; double decisions -> ALREADY_DECIDED. */
function att_applyDecision_(reqId, decision) { return att_decide_(String(reqId || ""), decision === "approve"); }

function att_flagged_(p) {
  var names = {}; att_rows_("AttStudents").forEach(function (s) { names[s.student_id] = s.name; });
  var rows = att_rows_("AttCheckins").filter(function (r) { return r.status === "review" && (!p.session_id || r.session_id === p.session_id); })
    .reverse().map(function (r) { var o = att_clean_(r); o.name = names[r.student_id] || ""; return o; });
  return att_ok_({ rows: rows });
}

/** Roster: every student, the lectures (sessions) shown, and who checked in to which one and when.
 *  p.course (optional) filters sessions; p.limit = how many of the latest sessions (default 30, max 200).
 *  Returns {students:[{student_id,name}], sessions:[{session_id,course,room_id,start_utc,status}] oldest->newest,
 *           marks:[[session_id,student_id,server_utc,status]], courses:[...all distinct courses]} */
function att_roster_(p) {
  var limit = Math.min(Math.max(parseInt(p.limit, 10) || 30, 1), 200), course = String(p.course || "");
  var all = att_rows_("AttSessions"), seen = {}, courses = [];
  all.forEach(function (x) { if (x.course && !seen[x.course]) { seen[x.course] = 1; courses.push(x.course); } });
  courses.sort();
  var sessions = all.filter(function (x) { return !course || x.course === course; })
    .sort(function (a, b) { return Date.parse(a.start_utc) - Date.parse(b.start_utc); });
  sessions = sessions.slice(Math.max(0, sessions.length - limit));
  var inSet = {}; sessions.forEach(function (x) { inSet[x.session_id] = 1; });
  var marks = att_rows_("AttCheckins").filter(function (r) { return inSet[r.session_id]; })
    .map(function (r) { return [r.session_id, r.student_id, r.server_utc, r.status]; });
  var students = att_rows_("AttStudents").filter(function (x) { return x.status === "active"; })
    .map(function (x) { return { student_id: x.student_id, name: x.name }; });
  return att_ok_({
    students: students,
    sessions: sessions.map(function (x) { return { session_id: x.session_id, course: x.course, room_id: x.room_id, start_utc: x.start_utc, status: x.status }; }),
    marks: marks, courses: courses });
}

function att_csvCell_(v) {
  var s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function att_export_(p) {
  var sid = String(p.session_id || ""); if (!att_getSession_(sid)) return att_err_("NO_SESSION");
  var names = {}; att_rows_("AttStudents").forEach(function (s) { names[s.student_id] = s.name; });
  var lines = [["student_id", "name", "server_utc", "status", "flags", "dist_m", "acc"].join(",")];
  att_rows_("AttCheckins").filter(function (r) { return r.session_id === sid; }).forEach(function (r) {
    lines.push([r.student_id, names[r.student_id] || "", r.server_utc, r.status, r.flags, r.dist_m, r.acc].map(att_csvCell_).join(","));
  });
  return att_ok_({ csv: lines.join("\r\n") });
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
/* AttSetup.gs — Session 1. Creates the 7 attendance tabs (idempotent) and ATT_MASTER_SECRET.
 * Run att_setup() once from the Apps Script editor.
 * Standalone (non-container-bound) project? Run att_setup("<spreadsheetId>") once; it is stored as ATT_SHEET_ID.
 */
var ATT_HEADERS = {
  AttStudents: ["student_id", "name", "device_id", "created_at", "status"],
  AttDevices: ["device_id", "student_id", "secret_hash", "fp_hash", "bound_at", "status"],
  AttRequests: ["req_id", "student_id", "new_device_id", "new_secret_hash", "new_fp_hash", "fp_match", "status", "created_at", "decided_at"],
  AttRooms: ["room_id", "name", "lat", "lng", "samples", "calibrated_at"],
  AttSessions: ["session_id", "course", "room_id", "start_utc", "close_utc", "status", "hall_lat", "hall_lng"],
  AttCheckins: ["checkin_id", "session_id", "student_id", "device_id", "server_utc", "lat", "lng", "acc", "dist_m", "fp_hash", "flags", "status"],
  AttFlagLog: ["ts_utc", "session_id", "student_id", "code", "detail"],
};

function att_setup(sheetId) {
  var props = PropertiesService.getScriptProperties();
  sheetId = sheetId || ATT_DEFAULT_SHEET_ID;
  if (sheetId) props.setProperty("ATT_SHEET_ID", String(sheetId));
  var ss = att_ss_();
  var report = [];
  Object.keys(ATT_HEADERS).forEach(function (name) {
    var h = ATT_HEADERS[name];
    var sh = ss.getSheetByName(name);
    var created = false;
    if (!sh) { sh = ss.insertSheet(name); created = true; }
    var cur = sh.getLastRow() >= 1 ? sh.getRange(1, 1, 1, Math.max(h.length, sh.getLastColumn())).getValues()[0] : [];
    var empty = cur.every(function (v) { return v === "" || v == null; });
    var same = h.every(function (x, i) { return cur[i] === x; });
    if (empty) {
      sh.getRange(1, 1, 1, h.length).setValues([h]);
    } else if (!same) {
      throw new Error("Tab " + name + " exists with different headers; fix or rename it manually (not overwritten).");
    }
    // Plain-text columns: keeps ISO timestamps and IDs with leading zeros exactly as written.
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), h.length).setNumberFormat("@");
    sh.setFrozenRows(1);
    report.push(name + (created ? " (created)" : " (ok)"));
  });
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
 *     geo:            {lat,lng,acc} | {denied:true},
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
  REPEATED_MIN: 3           // REPEATED: >= 3 prior flagged (review) check-ins, ever
};
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
    flags.push("GEO_DENIED"); // explicit {denied:true}, missing, or unusable coordinates
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
  if (d.session_id) lines.push("Session: <code>" + attt_e_(d.session_id) + "</code>");
  if (d.close_utc) lines.push("Check-in closes: " + attt_e_(attt_time_(d.close_utc)) + " (Cairo)");
  return lines.join("\n");
}

function attt_fmtSessionClose_(d) {
  var lines = ["🔴 <b>Attendance session closed</b>"];
  if (d.course) lines.push("Course: " + attt_e_(d.course));
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
  lines.push(hint);
  return lines.join("\n");
}

function attt_fmtDigest_(d) {
  var items = d.items || [];
  // merge by session + student
  var merged = {}, order = [];
  items.forEach(function (it) {
    var k = String(it.s) + "\u0000" + String(it.id);
    if (!merged[k]) { merged[k] = { s: it.s, id: it.id, codes: [], n: 0 }; order.push(k); }
    merged[k].n++;
    attt_codes_(it.f).forEach(function (c) { if (merged[k].codes.indexOf(c) < 0) merged[k].codes.push(c); });
  });
  var lines = ["🚩 <b>Flag digest</b> — " + order.length + " student" + (order.length === 1 ? "" : "s") +
               ", " + items.length + " check-in" + (items.length === 1 ? "" : "s")];
  order.slice(0, ATTT_DIGEST_MAX_LINES).forEach(function (k) {
    var m = merged[k];
    lines.push("• <code>" + attt_e_(m.id) + "</code> — " + attt_e_(m.codes.join(", ")) +
               (m.s ? " <i>(" + attt_e_(m.s) + ")</i>" : ""));
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
  var item = { t: Date.now(), s: d.session_id || "", id: d.student_id || "", f: codes };
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