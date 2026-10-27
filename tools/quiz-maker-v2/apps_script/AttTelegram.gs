/* AttTelegram.gs — attendance Telegram notifications (MASTER-SPEC §5/§6).
 * Entry point: att_notify_(event, data) — never throws; call it OUTSIDE the sheet lock.
 *   events: session_start | session_close | device_request | flag | digest
 * Self-contained (does not use Code.gs helpers) so the attendance bot can be a different bot from the payments bot.
 *
 * Script Properties (all optional; with none set, nothing is sent):
 *   ATT_TG_BOT_TOKEN   bot used for attendance (falls back to TELEGRAM_BOT_TOKEN)
 *   ATT_TG_ADMIN_IDS   chat id(s), comma separated (falls back to TELEGRAM_ADMIN_CHAT_ID)
 * Approve / Deny taps arrive at the web-app webhook as callback_data "ad:<req_id>" / "dd:<req_id>"
 * (Code.gs handleTelegramUpdate). If ATT_TG_BOT_TOKEN is a separate bot, set ITS webhook to the same
 * web-app URL + ?tg=<TELEGRAM_WEBHOOK_SECRET>.
 * Flag alerts are batched: queued in CacheService and sent as ONE message ~30 s later by a one-shot
 * time-driven trigger (att_flushDigest). If a trigger cannot be created, they are sent immediately.
 */
var ATT_TG_C = { DIGEST_DELAY_MS: 30000, QUEUE_KEY: "att:digestq", QUEUE_TTL_SEC: 1800, QUEUE_MAX: 200 };

function att_tgProp_(k) { try { return PropertiesService.getScriptProperties().getProperty(k) || ""; } catch (e) { return ""; } }
function att_tgToken_() { return att_tgProp_("ATT_TG_BOT_TOKEN") || att_tgProp_("TELEGRAM_BOT_TOKEN"); }
function att_tgAdminIds_() {
  return String(att_tgProp_("ATT_TG_ADMIN_IDS") || att_tgProp_("TELEGRAM_ADMIN_CHAT_ID"))
    .split(",").map(function (x) { return x.trim(); }).filter(Boolean);
}
function att_tgCall_(method, body) {
  var token = att_tgToken_();
  if (!token) return null;
  return UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true,
  });
}
function att_esc_(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Send one HTML message (optionally with an inline keyboard) to every attendance admin. Never throws. */
function att_tgSend_(text, markup) {
  try {
    if (!att_tgToken_()) return;
    att_tgAdminIds_().forEach(function (id) {
      try {
        var body = { chat_id: id, text: String(text).slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true };
        if (markup) body.reply_markup = markup;
        att_tgCall_("sendMessage", body);
      } catch (e) { console.error("att tg send to " + id + ": " + e); }
    });
  } catch (e) { console.error("att tg send: " + e); }
}

function att_cairoTime_(iso) {
  try { return Utilities.formatDate(new Date(iso), "Africa/Cairo", "HH:mm"); } catch (e) { return String(iso || ""); }
}

function att_notify_(event, data) {
  try {
    data = data || {};
    if (event === "session_start") {
      att_tgSend_("🟢 <b>Attendance session started</b>\nCourse: " + att_esc_(data.course || "-") + "\nRoom: " + att_esc_(data.room || "-") +
        "\nCloses: " + att_esc_(att_cairoTime_(data.close_utc)) + " (Cairo)");
    } else if (event === "session_close") {
      var s = data.summary || {};
      att_tgSend_("🔴 <b>Attendance session closed</b>\nCourse: " + att_esc_(data.course || "-") + "\nPresent: " + (s.present || 0) +
        " · Flagged: " + (s.flagged || 0) + " · Pending device requests: " + (s.pending || 0));
    } else if (event === "device_request") {
      var name = ""; try { name = att_studentName_(String(data.student_id)); } catch (e) {}
      att_tgSend_("📱 <b>Device change request</b>\nStudent ID: " + att_esc_(data.student_id) + (name ? " (" + att_esc_(name) + ")" : "") +
        "\n" + (data.fp_match ? "✅ Same phone model/fingerprint as the registered device." : "⚠️ Fingerprint differs from the registered device — check the student's ID in person.") +
        "\nRequest: " + att_esc_(data.req_id),
        { inline_keyboard: [[{ text: "✅ Approve", callback_data: "ad:" + data.req_id }, { text: "❌ Deny", callback_data: "dd:" + data.req_id }]] });
    } else if (event === "flag") {
      att_queueFlag_(data);
    } else if (event === "digest") {
      att_flushDigest();
    }
  } catch (e) { console.error("att_notify_ " + event + ": " + e); }
}

/* ───────── flag digest ───────── */
function att_queueFlag_(data) {
  var lock = LockService.getScriptLock(), got = false, first = false;
  try {
    got = lock.tryLock(3000);
    var cache = CacheService.getScriptCache(), raw = cache.get(ATT_TG_C.QUEUE_KEY), q = [];
    try { q = raw ? JSON.parse(raw) : []; } catch (e) { q = []; }
    first = q.length === 0;
    if (q.length < ATT_TG_C.QUEUE_MAX) q.push({ s: data.session_id, id: data.student_id, f: data.flags || [], h: !!data.hard, st: data.status || "" });
    cache.put(ATT_TG_C.QUEUE_KEY, JSON.stringify(q), ATT_TG_C.QUEUE_TTL_SEC);
  } finally { if (got) lock.releaseLock(); }
  if (!first) return;                       // a flush is already scheduled for this batch
  try {
    ScriptApp.newTrigger("att_flushDigest").timeBased().after(ATT_TG_C.DIGEST_DELAY_MS).create();
  } catch (e) {
    console.error("att digest trigger: " + e + " - sending now");
    att_flushDigest();                      // cannot schedule (scope/quota): never hold an alert back
  }
}

function att_flushDigest() {
  var lock = LockService.getScriptLock(), got = false, q = [];
  try {
    got = lock.tryLock(5000);
    var cache = CacheService.getScriptCache(), raw = cache.get(ATT_TG_C.QUEUE_KEY);
    try { q = raw ? JSON.parse(raw) : []; } catch (e) { q = []; }
    cache.remove(ATT_TG_C.QUEUE_KEY);
  } finally { if (got) lock.releaseLock(); }
  try {   // tidy: remove our spent one-shot triggers
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "att_flushDigest") ScriptApp.deleteTrigger(t); });
  } catch (e) {}
  if (!q.length) return 0;
  var byKey = {}, order = [];
  q.forEach(function (x) {
    var k = x.s + "|" + x.id;
    if (!byKey[k]) { byKey[k] = { id: x.id, flags: {}, hard: false }; order.push(k); }
    (x.f || []).forEach(function (f) { byKey[k].flags[f] = 1; });
    if (x.h) byKey[k].hard = true;
  });
  var lines = order.map(function (k) {
    var o = byKey[k];
    return (o.hard ? "⛔ " : "🚩 ") + att_esc_(o.id) + " — " + att_esc_(Object.keys(o.flags).join(", "));
  });
  att_tgSend_("🚩 <b>Attendance flags</b> (" + order.length + ")\n" + lines.join("\n"));
  return order.length;
}
