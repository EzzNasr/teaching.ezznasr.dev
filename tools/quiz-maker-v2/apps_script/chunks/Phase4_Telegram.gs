/* Phase4_Telegram.gs - P4 / S6: Telegram per teacher (contract section 6b).
 * A teacher links his OWN private Telegram chat to the existing payments bot. He then gets payment requests for his own
 * subject(s) and can Approve / Reject them from there, exactly like the owner. Dashboard approval keeps working.
 *
 * Depends on (frozen signatures, other sessions): p4_ctxForPhone, p4_ctx, p4_teacherCovers, p4_paymentInScope (Phase4_Scope / People).
 * Depends on Code.gs: _props, _ss, _tgCall, _tgAdminIds, _withLock, _sheetValuesAsObjects, _prettyLesson, _normalizePhone,
 *   _phonesMatch, handleAdminDecidePayment (the SAME internal function the owner's Telegram tap calls).
 * Security model: identity comes ONLY from the TeacherTelegram sheet (chat id -> teacher id). Nothing in callback_data or message
 * text is trusted except the payment id, and every decision is re-checked against a FRESH read of the teacher's role and scope.
 * Needs Script Property P4_TG_BOT_USERNAME (bot username without @). The bot token is never logged or stored here.
 * Script Properties used: P4_TG_BOT_USERNAME, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, ADMIN_TOKEN (all pre-existing except the first).
 */

var P4TG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 symbols, no 0/O/1/I
var P4TG_CODE_LEN = 8;
var P4TG_CODE_TTL_SEC = 900;
var P4TG_STARTS_PER_HOUR = 5;
var P4TG_TAB = "TeacherTelegram";
var P4TG_HEADERS = ["teacher_id", "chat_id", "linked_at"];
var P4TG_NOT_AUTH = { ok: false, error: "Not authorized." };

/* ---------------------------------------------------------------- small helpers (private) */

function p4tg_log_(msg) { try { console.log("p4tg: " + msg); } catch (e) {} }

function p4tg_esc_(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function p4tg_sha_(s) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return d.map(function (b) { return ("0" + ((b < 0 ? b + 256 : b)).toString(16)).slice(-2); }).join("");
}

// 8 symbols from a 32-symbol alphabet = 40 bits. Bytes come from UUID v4 (secure random); 256 % 32 == 0, so no modulo bias.
function p4tg_newCode_() {
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^0-9a-f]/gi, "");
  var out = "";
  for (var i = 0; i < P4TG_CODE_LEN; i++) out += P4TG_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) % 32);
  return out;
}

function p4tg_same_(a, b) {
  if (typeof _phonesMatch === "function") return _phonesMatch(a, b);
  return String(a) === String(b);
}

function p4tg_cache_() { return CacheService.getScriptCache(); }

function p4tg_adminIds_() { try { return _tgAdminIds(); } catch (e) { return []; } }

// One Telegram call. NEVER throws, never logs the token (it is scrubbed from any error text). Returns the parsed JSON or null.
function p4tg_call_(method, body) {
  var token = "";
  try {
    token = String(_props().getProperty("TELEGRAM_BOT_TOKEN") || "");
    if (!token) return null;
    var res = _tgCall(method, body);
    var txt = res && typeof res.getContentText === "function" ? res.getContentText() : "";
    try { return txt ? JSON.parse(txt) : {}; } catch (e) { return {}; }
  } catch (err) {
    var m = String(err && err.message || err);
    if (token) m = m.split(token).join("***");
    p4tg_log_("telegram call " + method + " failed: " + m.slice(0, 200));
    return null;
  }
}

// The caller must be a TEACHER using a dashboard SESSION. Assistants and token callers get null. Fresh read through p4_ctx.
function p4tg_callerTeacher_(payload) {
  try {
    if (typeof p4_ctx !== "function") return null;
    var ctx = p4_ctx(payload);
    if (!ctx || ctx.kind !== "teacher" || ctx.via !== "session" || !ctx.id) return null;
    return ctx;
  } catch (e) { return null; }
}

// Fresh teacher context for a stored teacher id (role + scope re-read from the sheet by S2). null = no longer a teacher.
function p4tg_ctxFor_(teacherId) {
  try {
    if (typeof p4_ctxForPhone !== "function") return null;
    var ctx = p4_ctxForPhone(teacherId);
    if (!ctx || ctx.kind !== "teacher" || !ctx.subjects || !ctx.subjects.length) return null;
    return ctx;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- TeacherTelegram sheet */

function p4tg_sheet_(create) {
  var ss = _ss();
  var sh = ss.getSheetByName(P4TG_TAB);
  if (!sh && create) {
    sh = ss.insertSheet(P4TG_TAB);   // S5's p4_setup creates the same tab with the same headers; this is the idempotent fallback
    sh.appendRow(P4TG_HEADERS);
  }
  return sh || null;
}

// [{row, teacher_id, chat_id, linked_at}] (row = 1-based sheet row). Empty when the tab does not exist yet.
function p4tg_rows_() {
  var sh = p4tg_sheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(1, 1, sh.getLastRow(), 3).getValues();
  var out = [];
  for (var i = 1; i < vals.length; i++) {
    var t = String(vals[i][0] == null ? "" : vals[i][0]).trim(), c = String(vals[i][1] == null ? "" : vals[i][1]).trim();
    if (t && c) out.push({ row: i + 1, teacher_id: t, chat_id: c, linked_at: String(vals[i][2] == null ? "" : vals[i][2]) });
  }
  return out;
}

// chat id -> teacher id, or "" when unknown OR ambiguous (a chat listed under two teachers is refused).
function p4tg_teacherOfChat_(chatId) {
  var found = "", n = 0;
  p4tg_rows_().forEach(function (r) { if (r.chat_id === String(chatId)) { found = r.teacher_id; n++; } });
  return n === 1 ? found : "";
}

function p4tg_deleteRows_(sh, rows) {
  rows.slice().sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRows(r, 1); });
}

// One row per teacher AND one teacher per chat: a new link replaces both kinds of older row. Caller holds the lock.
function p4tg_upsert_(teacherId, chatId) {
  var sh = p4tg_sheet_(true);
  var drop = [];
  p4tg_rows_().forEach(function (r) { if (p4tg_same_(r.teacher_id, teacherId) || r.chat_id === String(chatId)) drop.push(r.row); });
  if (drop.length) p4tg_deleteRows_(sh, drop);
  var at = sh.getLastRow() + 1;
  sh.getRange(at, 1, 1, 3).setNumberFormat("@");
  sh.getRange(at, 1, 1, 3).setValues([[String(teacherId), String(chatId), new Date().toISOString()]]);
}

function p4tg_unlinkPhone_(phone) {
  var sh = p4tg_sheet_(false);
  if (!sh) return 0;
  var drop = [];
  p4tg_rows_().forEach(function (r) { if (p4tg_same_(r.teacher_id, phone)) drop.push(r.row); });
  if (drop.length) p4tg_deleteRows_(sh, drop);
  return drop.length;
}

/* ---------------------------------------------------------------- payments (read only) */

// The payment row by id, built ONLY from the Payments sheet. null if missing.
function p4tg_payment_(id) {
  var sh = _ss().getSheetByName("Payments");
  if (!sh || sh.getLastRow() < 2) return null;
  var rows = _sheetValuesAsObjects(sh);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].payment_id || "").trim() === String(id)) {
      var r = rows[i];
      return { payment_id: String(r.payment_id), phone: String(r.phone || ""), name: String(r.name || ""), scope: String(r.scope || ""),
               reference: String(r.reference || ""), note: String(r.note || ""), status: String(r.status || "").trim().toLowerCase() };
    }
  }
  return null;
}

function p4tg_paymentText_(p) {
  var label = typeof _prettyLesson === "function" ? _prettyLesson(p.scope) : p.scope;
  return "💳 <b>Payment request</b>\n\n👤 " + p4tg_esc_(p.name) + "\n📱 " + p4tg_esc_(p.phone) +
    "\n📘 " + p4tg_esc_(label) + (p.note ? "\n📦 " + p4tg_esc_(p.note) : "") + "\n🧾 Ref: " + p4tg_esc_(p.reference);
}

/* ---------------------------------------------------------------- owner ping */

/** Plain-text message to the owner's chat(s). Never throws. */
function p4_ownerPing_(text) {
  try {
    var ids = p4tg_adminIds_();
    for (var i = 0; i < ids.length; i++) p4tg_call_("sendMessage", { chat_id: ids[i], text: String(text == null ? "" : text).slice(0, 3500), disable_web_page_preview: true });
  } catch (e) { p4tg_log_("ownerPing failed"); }
}

/* ---------------------------------------------------------------- teacher-facing actions (session, teacher only) */

function p4tg_startAllowed_(teacherId) {
  var cache = p4tg_cache_(), key = "p4tgr:" + p4tg_sha_(teacherId), now = Date.now();
  var n = 0, t0 = now, raw = cache.get(key);
  if (raw) { var p = String(raw).split("|"); n = Number(p[0]) || 0; t0 = Number(p[1]) || now; if (now - t0 >= 3600000) { n = 0; t0 = now; } }
  if (n >= P4TG_STARTS_PER_HOUR) return false;
  cache.put(key, (n + 1) + "|" + t0, 3600);
  return true;
}

/** {student_id, session_token} -> {ok, link, expires_in:900}. Teacher only (assistants and tokens are refused). */
function p4_tg_link_start(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    var bot = String(_props().getProperty("P4_TG_BOT_USERNAME") || "").replace(/^@/, "").trim();
    if (!/^[A-Za-z0-9_]{3,64}$/.test(bot)) return { ok: false, error: "Telegram is not set up yet." };
    var allowed = _withLock(function () { return p4tg_startAllowed_(ctx.id); }, 10000);
    if (!allowed) return { ok: false, error: "Too many attempts. Try again in an hour." };
    var code = p4tg_newCode_();
    p4tg_cache_().put("p4tg:" + p4tg_sha_(code), String(ctx.id), P4TG_CODE_TTL_SEC);   // only the HASH of the code is stored
    p4tg_log_("link code issued");
    return { ok: true, link: "https://t.me/" + bot + "?start=" + code, expires_in: P4TG_CODE_TTL_SEC };
  } catch (err) {
    p4tg_log_("link_start failed: " + String(err && err.message || err).slice(0, 120));
    return { ok: false, error: "Could not create the link. Try again." };
  }
}

function p4_tg_status(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    var mine = p4tg_rows_().filter(function (r) { return p4tg_same_(r.teacher_id, ctx.id); })[0];
    return { ok: true, linked: !!mine, since: mine ? mine.linked_at : "" };
  } catch (err) { return { ok: false, error: "Could not read the status." }; }
}

function p4_tg_unlink(payload) {
  try {
    var ctx = p4tg_callerTeacher_(payload);
    if (!ctx) return P4TG_NOT_AUTH;
    _withLock(function () { p4tg_unlinkPhone_(ctx.id); }, 10000);
    p4tg_log_("teacher unlinked");
    return { ok: true };
  } catch (err) { return { ok: false, error: "Could not unlink. Try again." }; }
}

/** Owner only: {phone} -> {ok}. Always ok, whether or not that teacher was linked. */
function p4_admin_tg_unlink(payload) {
  try {
    var ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null;
    if (!ctx || ctx.kind !== "owner") return P4TG_NOT_AUTH;
    _withLock(function () { p4tg_unlinkPhone_(payload && payload.phone); }, 10000);
    p4tg_log_("owner unlinked a teacher");
    return { ok: true };
  } catch (err) { return { ok: false, error: "Could not unlink. Try again." }; }
}

/* ---------------------------------------------------------------- notify teachers of a new payment request */

/** Called from _notifyAdmin after the owner message. `arg` = a payment id (what _notifyAdmin has) or an object with payment_id.
 *  Re-reads the payment from the sheet; sends to every linked teacher whose subjects cover the payment's own scope. Never throws. */
function p4_tg_notifyPayment(arg) {
  try {
    var pid = String(arg && typeof arg === "object" ? arg.payment_id : arg == null ? "" : arg).trim();
    if (!pid) return;
    var rows = p4tg_rows_();
    if (!rows.length) return;
    var pay = p4tg_payment_(pid);
    if (!pay || pay.status !== "pending" || typeof p4_teacherCovers !== "function") return;
    var admin = p4tg_adminIds_(), seen = {}, sent = [];
    var kb = { inline_keyboard: [[{ text: "✅ Approve", callback_data: "ap:" + pid }, { text: "❌ Reject", callback_data: "rj:" + pid }]] };
    var text = p4tg_paymentText_(pay);
    rows.forEach(function (r) {
      try {
        if (seen[r.chat_id] || admin.indexOf(r.chat_id) !== -1) return;   // owner already got it; one message per chat
        seen[r.chat_id] = true;
        var ctx = p4tg_ctxFor_(r.teacher_id);
        if (!ctx || !p4_teacherCovers(ctx, pay.scope)) return;
        var res = p4tg_call_("sendMessage", { chat_id: r.chat_id, text: text.slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kb });
        var mid = res && res.result && res.result.message_id;
        if (mid) sent.push({ c: r.chat_id, m: mid });
      } catch (e) { p4tg_log_("notify one failed"); }
    });
    if (sent.length) p4tg_cache_().put("p4tgm:" + pid, JSON.stringify(sent), 21600);
    p4tg_log_("payment ping to " + sent.length + " teacher chat(s)");
  } catch (err) { p4tg_log_("notifyPayment failed: " + String(err && err.message || err).slice(0, 120)); }
}

/* ---------------------------------------------------------------- webhook updates */

/** Returns true ONLY when this update was fully handled here (a /start link, or an ap:/rj: tap from a chat registered in
 *  TeacherTelegram). false for everything else so the existing owner path runs unchanged. Never throws. */
function p4_tg_handleUpdate(update) {
  try {
    if (!update || typeof update !== "object") return false;
    if (update.message) return p4tg_onMessage_(update);
    if (update.callback_query) return p4tg_onCallback_(update);
    return false;
  } catch (err) {
    p4tg_log_("handleUpdate failed: " + String(err && err.message || err).slice(0, 120));
    return false;
  }
}

function p4tg_seen_(update) {
  var key = "p4tgu:" + update.update_id, cache = p4tg_cache_();
  if (update.update_id === undefined || update.update_id === null) return false;
  if (cache.get(key)) return true;
  cache.put(key, "1", 21600);
  return false;
}

// "/start <code>" in a PRIVATE chat. Every failure is a silent no-op: no reply tells a valid code from an invalid or expired one.
function p4tg_onMessage_(update) {
  var msg = update.message, chat = msg && msg.chat;
  if (!chat || chat.type !== "private") return false;
  var m = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.exec(String(msg.text || ""));
  if (!m) return false;
  if (p4tg_seen_(update)) return true;
  if (!msg.from || String(msg.from.id) !== String(chat.id)) return true;
  var hash = p4tg_sha_(String(m[1]).toUpperCase());
  var outcome = _withLock(function () {
    var cache = p4tg_cache_(), key = "p4tg:" + hash;
    var teacherId = cache.get(key);
    if (!teacherId) return null;
    cache.remove(key);                                  // single use, even if the checks below fail
    var ctx = p4tg_ctxFor_(teacherId);
    if (!ctx) return null;                              // no longer a teacher
    p4tg_upsert_(teacherId, chat.id);
    return ctx.subjects.join(", ");
  }, 10000);
  if (outcome === null) { p4tg_log_("link refused"); return true; }
  p4tg_call_("sendMessage", { chat_id: chat.id, text: "Connected. You will receive payment requests for: " + outcome + "." });
  p4tg_log_("teacher chat linked");
  return true;
}

function p4tg_edit_(chatId, messageId, text, entities) {
  var body = { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000) };
  if (entities && entities.length) body.entities = entities;
  p4tg_call_("editMessageText", body);   // no reply_markup = buttons removed
}

// After a decision, take the buttons off every teacher message we sent for this payment (errors ignored).
function p4tg_stripOthers_(pid, exceptChat, exceptMsg) {
  try {
    var raw = p4tg_cache_().get("p4tgm:" + pid);
    if (!raw) return;
    JSON.parse(raw).forEach(function (x) {
      if (String(x.c) === String(exceptChat) && String(x.m) === String(exceptMsg)) return;
      p4tg_call_("editMessageReplyMarkup", { chat_id: x.c, message_id: x.m, reply_markup: { inline_keyboard: [] } });
    });
  } catch (e) {}
}

function p4tg_onCallback_(update) {
  var cq = update.callback_query;
  var m = /^(ap|rj):(\S+)$/.exec(String(cq && cq.data || ""));
  if (!m) return false;
  var chat = cq.message && cq.message.chat;
  if (!chat || chat.type !== "private" || !cq.from || String(chat.id) !== String(cq.from.id)) return false;
  if (p4tg_adminIds_().indexOf(String(chat.id)) !== -1) return false;     // the owner's own chats stay on the existing path
  var teacherId = p4tg_teacherOfChat_(chat.id);                           // identity from the sheet, never from callback text
  if (!teacherId) return false;                                           // not a registered teacher chat
  if (p4tg_seen_(update)) return true;                                    // Telegram retries; each update is handled once
  p4tg_call_("answerCallbackQuery", { callback_query_id: cq.id });         // clear the spinner first
  var pid = m[2], approve = m[1] === "ap";

  var ctx = p4tg_ctxFor_(teacherId);                                      // FRESH role + scope
  if (!ctx) { p4tg_log_("refused: not a teacher any more"); return true; }
  var inScope = false;
  try { inScope = typeof p4_paymentInScope === "function" && p4_paymentInScope(ctx, { payment_id: pid }) === true; } catch (e) { inScope = false; }
  if (!inScope) { p4tg_log_("refused: payment outside scope"); return true; }   // no reply, no detail

  var out;
  try {
    out = handleAdminDecidePayment({ token: _props().getProperty("ADMIN_TOKEN"), payment_id: pid, decision: approve ? "approve" : "reject" });
  } catch (err) {
    var emsg = String(err && err.message || err);
    if (/already (approved|rejected|revoked)/i.test(emsg)) {
      p4tg_log_("already decided");
      p4tg_edit_(chat.id, cq.message.message_id, String(cq.message.text || "") + "\n\nAlready decided", cq.message.entities);
      p4tg_stripOthers_(pid, chat.id, cq.message.message_id);
    } else {
      p4tg_log_("decision failed: " + emsg.slice(0, 120));
    }
    return true;
  }
  var verdict = approve ? "✅ Approved" : "❌ Rejected";
  p4tg_log_("decided " + (approve ? "approve" : "reject") + " by teacher");
  p4tg_edit_(chat.id, cq.message.message_id, String(cq.message.text || "") + "\n\n" + verdict, cq.message.entities);
  p4tg_stripOthers_(pid, chat.id, cq.message.message_id);
  p4_ownerPing_(verdict + " by teacher " + teacherId + ": " + String(out && out.name || "") + " (payment " + pid + ")");
  return true;
}

/* ---------------------------------------------------------------- editor self-test (no Telegram, no sheet writes) */

function p4_selfTest_tg() {
  var fails = [];
  var ck = function (name, ok) { if (!ok) fails.push(name); };
  ck("sha256 vector", p4tg_sha_("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  var seen = {}, okAlpha = true, okLen = true;
  for (var i = 0; i < 200; i++) {
    var c = p4tg_newCode_();
    seen[c] = true;
    if (c.length !== P4TG_CODE_LEN) okLen = false;
    if (!new RegExp("^[" + P4TG_ALPHABET + "]+$").test(c)) okAlpha = false;
  }
  ck("code length", okLen); ck("code alphabet", okAlpha); ck("codes differ", Object.keys(seen).length > 190);
  ck("esc", p4tg_esc_("<b>&") === "&lt;b&gt;&amp;");
  ck("start parse", /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.test("/start ABCD2345"));
  ck("start parse rejects short", !/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]{8})\s*$/.test("/start ABC"));
  var res = fails.length ? "FAIL: " + fails.join(", ") : "ALL PASS";
  Logger.log("p4_selfTest_tg: " + res);
  return res;
}
