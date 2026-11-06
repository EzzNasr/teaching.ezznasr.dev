// =====================================================================================
// FollowupWhatsApp.gs  (WhatsApp sender, phase 1: one tap queues, the spare phone sends)
// Decisions and setup: docs/whatsapp/README.md (in the repo).
//
// The follow-up page composes the parent messages exactly as it always has (FollowupTemplates in the browser) and, with one
// tap, QUEUES them here instead of opening wa.me one by one. A spare Android phone at home (Termux + Node + Baileys,
// tools/wa-sender/) asks for queued messages, sends them slowly from its own WhatsApp number, and reports back. Only a
// reported success writes the parent contact log (ParentNotifications), the same entry the "I sent it" button writes.
//
// Safety, in order of importance:
//   1. OFF by default. Script Property WA_MODE = "off" | "test" | "live". In "test" every message goes to WA_TEST_TO (the
//      owner's own number) with a [TEST] header naming the real recipient, and nothing is logged as contacted.
//   2. Nothing is ever sent twice by the server: an item is handed out once ("sending" with a lease). If the phone goes
//      silent mid-send, the item becomes "unknown" (never re-queued automatically) and the owner is told on Telegram.
//      The phone itself journals every attempt before sending (tools/wa-sender/lib/journal.js).
//   3. Enqueue is idempotent: the same student + the same contact items while one is queued / sending / sent in the last
//      7 days is skipped, and so is anything already in the contact log. (Test mode: only queued / sending / unknown block,
//      so the owner can send the same test again.)
//   4. Pace and limits are the server's: sending hours (WA_HOURS, default 9-21 Alex time), a daily cap (WA_DAILY_CAP,
//      default 60), and a random 25-75 s gap between messages that the phone must respect.
//   4b. Per batch "send_to" (Nov 2026): "test" queues the batch as TEST rows even while WA_MODE is live (they go to
//      WA_TEST_TO, nothing is logged). The monthly report batch defaults to "test"; "parents" only takes effect in live.
//   5. The phone has its OWN token (WA_SENDER_TOKEN, field wa_token), never the admin token: it can only claim, report and
//      say "I am alive". A stolen phone cannot read or change anything else.
//
// Actions (all routed by FollowupRouter.gs, admin_fu2_* prefix, so Code.gs needs no change):
//   page  (owner only, _requireAdminAny):  admin_fu2_wa_status, admin_fu2_wa_enqueue, admin_fu2_wa_cancel
//   phone (wa_token):                      admin_fu2_wa_claim, admin_fu2_wa_report, admin_fu2_wa_heartbeat
// Editor functions: fu2_wa_setup, fu2_wa_modeOff, fu2_wa_modeTest, fu2_wa_modeLive, fu2_wa_installTrigger, fu2_wa_removeTrigger,
//                   fu2_wa_watchdog (hourly trigger).
// New sheet (only this one): WaOutbox. No existing sheet or column is touched.
// =====================================================================================

var FU2_WA_SHEET = "WaOutbox";
var FU2_WA_HEADERS = ["id", "created_at", "created_by", "mode", "group_key", "group", "event", "student_key", "student_phone", "student_name",
  "to", "text", "log_items", "status", "attempts", "lease_until", "sent_at", "result", "error", "updated_at"];
var FU2_WA_EVENTS = { parents_watch: 1, parents_hw: 1, monthly: 1, custom: 1 };
var FU2_WA_LEASE_MS = 15 * 60 * 1000;          // a claimed item must be reported within 15 minutes
var FU2_WA_CLAIM_MAX = 5;                      // items per claim (the phone sends them one by one with the gap)
var FU2_WA_DEDUPE_DAYS = 7;
var FU2_WA_TEXT_MAX = 1500;
var FU2_WA_MAX_ATTEMPTS = 3;
var FU2_WA_SILENT_ALERT_MIN = 90;              // queued work + no heartbeat for this long, during sending hours -> Telegram

// ---------------------------------------------------------------------------------------------
// settings (Script Properties)
// ---------------------------------------------------------------------------------------------
function fu2_wa_mode_() { var m = String(_props().getProperty("WA_MODE") || "off").trim().toLowerCase(); return m === "test" || m === "live" ? m : "off"; }
function fu2_wa_int_(k, d, lo, hi) { var n = parseInt(_props().getProperty(k), 10); return isFinite(n) && n >= lo && n <= hi ? n : d; }
function fu2_wa_hours_() {
  var m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(_props().getProperty("WA_HOURS") || "9-21").trim());
  var from = m ? +m[1] : 9, to = m ? +m[2] : 21;
  if (!(from >= 0 && to <= 24 && from < to)) { from = 9; to = 21; }
  return { from: from, to: to };
}
function fu2_wa_cfg_() {
  return { mode: fu2_wa_mode_(), cap: fu2_wa_int_("WA_DAILY_CAP", 60, 1, 500), hours: fu2_wa_hours_(),
    gap: { min: fu2_wa_int_("WA_MIN_GAP_SEC", 25, 5, 600), max: fu2_wa_int_("WA_MAX_GAP_SEC", 75, 10, 1200) },
    testTo: _normalizePhone(_props().getProperty("WA_TEST_TO") || ""), configured: !!_props().getProperty("WA_SENDER_TOKEN") };
}
function fu2_wa_nowStr_() { return _fmt(new Date(), TZ, true); }
function fu2_wa_today_() { return _fmt(new Date(), TZ, false); }
function fu2_wa_hourNow_() { return parseInt(fu2_wa_nowStr_().slice(11, 13), 10); }
function fu2_wa_inHours_(cfg) { var h = fu2_wa_hourNow_(); return h >= cfg.hours.from && h < cfg.hours.to; }

// ---------------------------------------------------------------------------------------------
// the WaOutbox sheet
// ---------------------------------------------------------------------------------------------
function fu2_wa_sheet_() { return _sheetByName(_dataSs(), FU2_WA_SHEET, FU2_WA_HEADERS); }
function fu2_wa_rows_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(1, 1, sh.getLastRow(), FU2_WA_HEADERS.length).getValues(), out = [];
  for (var i = 1; i < v.length; i++) {
    var o = { _row: i + 1 };
    FU2_WA_HEADERS.forEach(function (k, j) { var x = v[i][j]; o[k] = x === null || x === undefined ? "" : (x instanceof Date ? _fmt(x, TZ, true) : String(x)); });
    if (o.id) out.push(o);
  }
  return out;
}
// Every cell is written as plain text, so a phone number never turns into a number and a date never into a date cell.
function fu2_wa_write_(sh, row, o) {
  var vals = FU2_WA_HEADERS.map(function (k) { return o[k] === undefined || o[k] === null ? "" : String(o[k]); });
  var rng = sh.getRange(row, 1, 1, vals.length); rng.setNumberFormat("@"); rng.setValues([vals]);
}
function fu2_wa_append_(sh, o) { fu2_wa_write_(sh, sh.getLastRow() + 1, o); }
function fu2_wa_items_(r) { try { var a = JSON.parse(r.log_items || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
function fu2_wa_itemsKey_(items) {
  return items.map(function (it) { return String(it.kind).toLowerCase() + ":" + String(it.ref).toLowerCase(); }).sort().join("|");
}
function fu2_wa_public_(r) {
  return { id: r.id, created_at: r.created_at, mode: r.mode, group: r.group, event: r.event, student_name: r.student_name,
    to: r.to, status: r.status, attempts: +r.attempts || 0, sent_at: r.sent_at, error: r.error, preview: String(r.text || "").slice(0, 80) };
}
function fu2_wa_sentToday_(rows) { var d = fu2_wa_today_(); return rows.filter(function (r) { return r.status === "sent" && String(r.sent_at).slice(0, 10) === d; }).length; }

// ---------------------------------------------------------------------------------------------
// phone authentication
// ---------------------------------------------------------------------------------------------
function fu2_wa_requireSender_(payload) {
  var want = String(_props().getProperty("WA_SENDER_TOKEN") || ""), got = String((payload && payload.wa_token) || "");
  if (!want || got.length !== want.length) throw new Error("Unauthorized");
  var diff = 0; for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) throw new Error("Unauthorized");
}
function fu2_wa_seen_() { try { return JSON.parse(_props().getProperty("WA_LAST_SEEN") || "null"); } catch (e) { return null; } }

// ---------------------------------------------------------------------------------------------
// page actions (owner only)
// ---------------------------------------------------------------------------------------------
function fu2_wa_status_(payload) {
  var cfg = fu2_wa_cfg_(), rows = fu2_wa_rows_(_dataSs().getSheetByName(FU2_WA_SHEET));
  var by = {}; rows.forEach(function (r) { by[r.status] = (by[r.status] || 0) + 1; });
  return { ok: true, mode: cfg.mode, configured: cfg.configured, test_to: cfg.mode === "test" ? cfg.testTo : "",
    hours: cfg.hours, cap: cfg.cap, sent_today: fu2_wa_sentToday_(rows), counts: by, phone: fu2_wa_seen_(),
    recent: rows.slice(-30).reverse().map(fu2_wa_public_) };
}

// The mode one batch is queued in: WA_MODE, except that "send_to":"test" (the monthly batch's default) keeps it in test.
function fu2_wa_batchMode_(cfg, payload, event) {
  var to = String(payload.send_to || "").trim().toLowerCase();
  if (!to) to = event === "monthly" ? "test" : "";
  if (to && to !== "test" && to !== "parents") throw new Error('send_to must be "test" or "parents".');
  return cfg.mode === "live" && to !== "test" ? "live" : "test";
}

/** {group, group_key, event, send_to?, items:[{student_key, student_phone, name, to, text, log_items:[{kind, ref}]}]} -> {mode, queued, skipped[]} */
function fu2_wa_enqueue_(payload) {
  var cfg = fu2_wa_cfg_();
  if (cfg.mode === "off") throw new Error("WhatsApp sending is switched off (WA_MODE).");
  if (!cfg.configured) throw new Error("The WhatsApp phone is not set up yet (run fu2_wa_setup).");
  var event = String(payload.event || "").trim();
  if (!FU2_WA_EVENTS.hasOwnProperty(event)) throw new Error("Unknown event: " + event);
  var mode = fu2_wa_batchMode_(cfg, payload, event);
  if (mode === "test" && cfg.testTo.length < 11) throw new Error("Test mode needs WA_TEST_TO (your own number with the country code).");
  var list = Array.isArray(payload.items) ? payload.items : [];
  if (!list.length) throw new Error("Nothing to send.");
  if (list.length > 200) throw new Error("Too many messages at once.");
  var group = String(payload.group || "").slice(0, 100), groupKey = String(payload.group_key || "").slice(0, 100), who = fu2_wa_who_(payload);
  var logged = fu2_wa_loggedMap_();
  return _withLock(function () {
    var sh = fu2_wa_sheet_(), rows = fu2_wa_rows_(sh), now = new Date(), nowStr = fu2_wa_nowStr_(), since = _fmt(new Date(now.getTime() - FU2_WA_DEDUPE_DAYS * 86400000), TZ, true);
    var recent = {};
    rows.forEach(function (r) {
      // test mode: an already-SENT test does not block sending the same student again (the owner re-tests freely);
      // one still waiting or in flight does, so a double tap never queues two
      if ((r.status === "queued" || r.status === "sending" || r.status === "unknown" || (r.status === "sent" && r.sent_at >= since && mode === "live")) && r.mode === mode)
        recent[r.student_key + "#" + fu2_wa_itemsKey_(fu2_wa_items_(r))] = r.status;
    });
    var queued = 0, skipped = [];
    list.forEach(function (it) {
      var name = String(it.name || "").slice(0, 80), key = _phoneKey(it.student_key || it.student_phone || "");
      var to = _normalizePhone(it.to || ""), text = String(it.text || "").trim();
      var items = (Array.isArray(it.log_items) ? it.log_items : []).map(function (x) { return { kind: String(x.kind || "").toLowerCase(), ref: String(x.ref || "").toLowerCase().slice(0, 200) }; })
        .filter(function (x) { return x.kind && x.ref; });
      var why = "";
      if (key.length < 10) why = "no student phone";
      else if (!/^[1-9]\d{10,14}$/.test(to)) why = "parent number is not a full international number";
      else if (!text) why = "empty message";
      else if (text.length > FU2_WA_TEXT_MAX) why = "message too long";
      else if (!items.length) why = "nothing to log";
      else if (recent[key + "#" + fu2_wa_itemsKey_(items)]) why = "already " + recent[key + "#" + fu2_wa_itemsKey_(items)];
      else if (mode === "live" && items.every(function (x) { return logged[key + "|" + x.kind + "|" + x.ref]; })) why = "already contacted";
      if (why) { skipped.push({ name: name, reason: why }); return; }
      var row = { id: "WA-" + String(Utilities.getUuid()).replace(/-/g, "").slice(0, 12), created_at: nowStr, created_by: who, mode: mode,
        group_key: groupKey, group: group, event: event, student_key: key, student_phone: _normalizePhone(it.student_phone || ""), student_name: name,
        to: to, text: text, log_items: JSON.stringify(items), status: "queued", attempts: 0, lease_until: "", sent_at: "", result: "", error: "", updated_at: nowStr };
      fu2_wa_append_(sh, row); recent[key + "#" + fu2_wa_itemsKey_(items)] = "queued"; queued++;
    });
    return { ok: true, mode: mode, queued: queued, skipped: skipped };
  });
}
function fu2_wa_who_(payload) { try { return payload.token ? "admin" : String(_normalizePhone(payload.student_id || "") || "admin"); } catch (e) { return "admin"; } }
// "phoneKey|kind|ref" -> true for every ParentNotifications entry (the contact log).
function fu2_wa_loggedMap_() {
  var out = {};
  try {
    var ss = _ss(), sh = ss.getSheetByName("ParentNotifications");
    if (!sh || sh.getLastRow() < 2) return out;
    var v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues(), h = v[0];
    var cs = h.indexOf("student"), ck = h.indexOf("kind"), cr = h.indexOf("ref");
    for (var i = 1; i < v.length; i++) out[_phoneKey(v[i][cs]) + "|" + String(v[i][ck]).toLowerCase() + "|" + String(v[i][cr]).toLowerCase()] = true;
  } catch (e) { console.error("wa loggedMap: " + e); }
  return out;
}

/** {id} cancels one queued item, {all:true} every queued item. Items already handed to the phone cannot be cancelled. */
function fu2_wa_cancel_(payload) {
  return _withLock(function () {
    var sh = fu2_wa_sheet_(), n = 0, nowStr = fu2_wa_nowStr_();
    fu2_wa_rows_(sh).forEach(function (r) {
      if (r.status !== "queued" || !(payload.all === true || r.id === String(payload.id || ""))) return;
      r.status = "cancelled"; r.updated_at = nowStr; fu2_wa_write_(sh, r._row, r); n++;
    });
    return { ok: true, cancelled: n };
  });
}

// ---------------------------------------------------------------------------------------------
// phone actions (wa_token)
// ---------------------------------------------------------------------------------------------
/** -> {mode, items:[{id, to, text}], gap:{min,max}, wait_sec, why}. Hands each item out once. */
function fu2_wa_claim_(payload) {
  fu2_wa_requireSender_(payload);
  fu2_wa_touch_(payload, "claim");
  var cfg = fu2_wa_cfg_(), base = { ok: true, mode: cfg.mode, gap: cfg.gap, items: [] };
  if (cfg.mode === "off") return Object.assign(base, { why: "off", wait_sec: 600 });
  if (!fu2_wa_inHours_(cfg)) return Object.assign(base, { why: "outside sending hours " + cfg.hours.from + "-" + cfg.hours.to, wait_sec: 900 });
  if (cfg.mode === "test" && cfg.testTo.length < 11) return Object.assign(base, { why: "WA_TEST_TO missing", wait_sec: 900 });
  var want = Math.max(1, Math.min(FU2_WA_CLAIM_MAX, parseInt(payload.max, 10) || FU2_WA_CLAIM_MAX));
  return _withLock(function () {
    var sh = fu2_wa_sheet_(), rows = fu2_wa_rows_(sh), nowMs = Date.now(), nowStr = fu2_wa_nowStr_();
    var left = cfg.cap - fu2_wa_sentToday_(rows) - rows.filter(function (r) { return r.status === "sending"; }).length;
    if (left <= 0) return Object.assign(base, { why: "daily cap " + cfg.cap + " reached", wait_sec: 1800 });
    var out = [];
    // live also hands out TEST rows (a batch queued with send_to "test"); they still go to WA_TEST_TO only
    var testOk = cfg.testTo.length >= 11;
    rows.filter(function (r) { return r.status === "queued" && (r.mode === cfg.mode || (cfg.mode === "live" && r.mode === "test" && testOk)); }).slice(0, Math.min(want, left)).forEach(function (r) {
      r.status = "sending"; r.attempts = (+r.attempts || 0) + 1; r.lease_until = String(nowMs + FU2_WA_LEASE_MS); r.updated_at = nowStr;
      fu2_wa_write_(sh, r._row, r);
      var to = r.to, text = r.text;
      if (r.mode !== "live") { to = cfg.testTo; text = "[TEST] → " + (r.student_name || "?") + " · " + r.to + "\n\n" + text; }
      out.push({ id: r.id, to: to, text: text });
    });
    return Object.assign(base, { items: out, wait_sec: out.length ? 0 : 300, why: out.length ? "" : "queue empty" });
  });
}

/** {results:[{id, ok, wa_id?, error?, retryable?}]} -> marks sent / queued again / failed; a live success writes the contact log. */
function fu2_wa_report_(payload) {
  fu2_wa_requireSender_(payload);
  fu2_wa_touch_(payload, "report");
  var results = Array.isArray(payload.results) ? payload.results.slice(0, 50) : [], toLog = [], failed = [];
  var res = _withLock(function () {
    var sh = fu2_wa_sheet_(), rows = fu2_wa_rows_(sh), byId = {}, nowStr = fu2_wa_nowStr_(), n = 0;
    rows.forEach(function (r) { byId[r.id] = r; });
    results.forEach(function (x) {
      var r = byId[String(x && x.id || "")];
      if (!r || (r.status !== "sending" && r.status !== "unknown")) return;   // a late or repeated report changes nothing
      if (x.ok === true) {
        r.status = "sent"; r.sent_at = nowStr; r.result = String(x.wa_id || "").slice(0, 100); r.error = "";
        if (r.mode === "live") toLog.push(r);
      } else {
        r.error = String(x.error || "failed").slice(0, 300);
        r.status = x.retryable === true && (+r.attempts || 0) < FU2_WA_MAX_ATTEMPTS ? "queued" : "failed";
        if (r.status === "failed") failed.push(r);
      }
      r.lease_until = ""; r.updated_at = nowStr; fu2_wa_write_(sh, r._row, r); n++;
    });
    return { ok: true, updated: n };
  });
  // The contact log has its own lock, so it is written after ours is released.
  var admin = _props().getProperty("ADMIN_TOKEN"), logErr = 0;
  toLog.forEach(function (r) {
    fu2_wa_items_(r).forEach(function (it) {
      // a monthly report: mark the month "sent" (saves the requirements snapshot and writes the same contact-log entry)
      if (it.kind === "monthly" && typeof p2_admin_monthly_review === "function") {
        try { p2_admin_monthly_review({ token: admin, op: "mark", month: it.ref, student: r.student_phone || r.student_key, group: r.group_key || "", status: "sent", note: "WhatsApp (phone) " + r.id }); return; }
        catch (e) { console.error("wa monthly mark " + r.id + ": " + e); }   // falls through to the plain contact log
      }
      try { p2_admin_log_parent_notification({ token: admin, student: r.student_phone || r.student_key, kind: it.kind, ref: it.ref, note: "WhatsApp (phone) " + r.id }); }
      catch (e) { logErr++; console.error("wa log " + r.id + ": " + e); }
    });
  });
  if (failed.length) fu2_wa_alert_("⚠️ <b>WhatsApp: " + failed.length + " message" + (failed.length === 1 ? "" : "s") + " not sent</b>\n" +
    failed.slice(0, 5).map(function (r) { return "• " + _esc(r.student_name || r.student_key) + ": " + _esc(r.error); }).join("\n"));
  if (logErr) res.log_errors = logErr;
  return res;
}

/** {state:"connected"|"connecting"|"logged_out"|..., app?, battery?} : the phone says it is alive. */
function fu2_wa_heartbeat_(payload) {
  fu2_wa_requireSender_(payload);
  var prev = fu2_wa_seen_() || {}, s = fu2_wa_touch_(payload, "heartbeat");
  if (s.state === "logged_out" && prev.state !== "logged_out")
    fu2_wa_alert_("📵 <b>WhatsApp phone is logged out</b>\nOpen WhatsApp on the spare phone, then run <code>npm run pair</code> in Termux to link it again.");
  return { ok: true, mode: fu2_wa_mode_() };
}
function fu2_wa_touch_(payload, what) {
  var s = { at: fu2_wa_nowStr_(), ms: Date.now(), what: what, state: String(payload.state || "").slice(0, 30) || "connected",
    app: String(payload.app || "").slice(0, 40), battery: isFinite(+payload.battery) ? +payload.battery : null };
  if (what !== "heartbeat") { var prev = fu2_wa_seen_(); if (prev && prev.state) s.state = prev.state; }
  try { _props().setProperty("WA_LAST_SEEN", JSON.stringify(s)); } catch (e) {}
  return s;
}
function fu2_wa_alert_(html) { try { _notifyAdmin(html); } catch (e) { console.error("wa alert: " + e); } }

// ---------------------------------------------------------------------------------------------
// hourly watchdog (trigger): stuck items and a silent phone
// ---------------------------------------------------------------------------------------------
function fu2_wa_watchdog() {
  var cfg = fu2_wa_cfg_(); if (cfg.mode === "off") return { ok: true, mode: "off" };
  var stuck = [];
  var r0 = _withLock(function () {
    var sh = fu2_wa_sheet_(), now = Date.now(), nowStr = fu2_wa_nowStr_(), queued = 0;
    fu2_wa_rows_(sh).forEach(function (r) {
      if (r.status === "queued") queued++;
      if (r.status === "sending" && +r.lease_until && +r.lease_until < now) {   // handed out, never reported: maybe sent, maybe not
        r.status = "unknown"; r.updated_at = nowStr; r.error = "the phone did not report back; check the chat before sending again";
        fu2_wa_write_(sh, r._row, r); stuck.push(r);
      }
    });
    return { queued: queued };
  });
  if (stuck.length) fu2_wa_alert_("❓ <b>WhatsApp: " + stuck.length + " message" + (stuck.length === 1 ? "" : "s") + " with no report</b>\n" +
    "The phone took them but never said whether they went out. Check the chats before sending again:\n" +
    stuck.slice(0, 5).map(function (r) { return "• " + _esc(r.student_name || r.student_key); }).join("\n"));
  var seen = fu2_wa_seen_(), quietMin = seen && seen.ms ? (Date.now() - seen.ms) / 60000 : Infinity, nag = _props().getProperty("WA_SILENT_NAG") || "";
  if (r0.queued && fu2_wa_inHours_(cfg) && quietMin > FU2_WA_SILENT_ALERT_MIN && nag !== fu2_wa_today_()) {
    fu2_wa_alert_("📴 <b>WhatsApp phone is silent</b> (" + (isFinite(quietMin) ? Math.round(quietMin) + " min" : "never seen") + ")\n" + r0.queued +
      " message" + (r0.queued === 1 ? " is" : "s are") + " waiting. Check that the phone is on, charging and on Wi-Fi, and that Termux is running.");
    _props().setProperty("WA_SILENT_NAG", fu2_wa_today_());
  }
  return { ok: true, stuck: stuck.length, queued: r0.queued };
}
function fu2_wa_installTrigger() {
  fu2_wa_removeTrigger();
  ScriptApp.newTrigger("fu2_wa_watchdog").timeBased().everyHours(1).create();
  return "fu2_wa_watchdog runs every hour";
}
function fu2_wa_removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "fu2_wa_watchdog") ScriptApp.deleteTrigger(t); });
}

// ---------------------------------------------------------------------------------------------
// editor functions (setup and the mode switch)
// ---------------------------------------------------------------------------------------------
/** Creates the phone's token (once) and the WaOutbox sheet; leaves the mode OFF. The log shows what to put in the phone's config. */
function fu2_wa_setup() {
  var p = _props(), tok = p.getProperty("WA_SENDER_TOKEN");
  if (!tok) { tok = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""); p.setProperty("WA_SENDER_TOKEN", tok); }
  if (!p.getProperty("WA_MODE")) p.setProperty("WA_MODE", "off");
  fu2_wa_sheet_();
  var msg = "WhatsApp sender ready. Put these in tools/wa-sender/config.json on the phone:\n  api_url: (the /exec URL)\n  wa_token: " + tok +
    "\nMode is " + fu2_wa_mode_() + ". Set WA_TEST_TO (your own number, e.g. 2010xxxxxxxx), then run fu2_wa_modeTest.";
  Logger.log(msg);
  return { ok: true, mode: fu2_wa_mode_() };
}
function fu2_wa_setMode_(m) { _props().setProperty("WA_MODE", m); Logger.log("WA_MODE = " + m); return m; }
function fu2_wa_modeOff() { return fu2_wa_setMode_("off"); }
function fu2_wa_modeTest() { return fu2_wa_setMode_("test"); }
function fu2_wa_modeLive() { return fu2_wa_setMode_("live"); }

// ---------------------------------------------------------------------------------------------
// route map for FollowupRouter.gs
// ---------------------------------------------------------------------------------------------
function fu2_wa_wrap_(fn, admin) {
  return function (payload) {
    try {
      payload = payload || {};
      if (admin) _requireAdminAny(payload);
      return fn(payload);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
}
function fu2_wa_routes_() {
  return {
    admin_fu2_wa_status: fu2_wa_wrap_(fu2_wa_status_, true),
    admin_fu2_wa_enqueue: fu2_wa_wrap_(fu2_wa_enqueue_, true),
    admin_fu2_wa_cancel: fu2_wa_wrap_(fu2_wa_cancel_, true),
    admin_fu2_wa_claim: fu2_wa_wrap_(fu2_wa_claim_, false),
    admin_fu2_wa_report: fu2_wa_wrap_(fu2_wa_report_, false),
    admin_fu2_wa_heartbeat: fu2_wa_wrap_(fu2_wa_heartbeat_, false),
  };
}
