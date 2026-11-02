// =====================================================================================
// FollowupNotify.gs  (Follow-up v2, Session 2: notifications)
//
// Telegram notifications for the follow-up page: an hourly tick asks the shared event engine
// what is due, sends one message per (group, session, event) exactly once, and lets the admin
// snooze or mark done from Telegram. Also the three sheets and four actions the page uses.
//
// Depends on (all optional at load time, checked when used):
//   Code.gs   : _props, _tgAdminIds, _tgCall, _esc, _prettyLesson, _withLock, _sheetByName, _dataSs,
//               _fmt, _cairoIso, TZ, _requireAdminAny, p2_audit
//   S5        : fu2_core_overviewInternal_()          (FollowupRouter.gs)
//   S3        : fu2_logic_dueNow_(overview, nowIso)   (FollowupLogic.gs, generated)
// Exposes to S5   : fu2_notify_routes_(), fu2_notify_overviewHook_(overview),
//                   fu2_notify_telegramCallback_(cq), fu2_notify_installTrigger(), fu2_notify_removeTrigger()
// New sheets (only these): FollowupNotifications, FollowupDone, NotifySettings.
// No existing sheet or column is touched. Nothing here edits Code.gs.
// =====================================================================================

var FU2_NOTIFY_TZ_LABEL = "Alex";             // the only word a person ever reads for this time zone
var FU2_NOTIFY_HOUR_DEFAULT = 16;
var FU2_NOTIFY_QUIET_FROM = 8;                // sends allowed from 08:00 ...
var FU2_NOTIFY_QUIET_TO = 22;                 // ... until 22:00 (exclusive)
var FU2_NOTIFY_PAGE = "https://teaching.ezznasr.dev/dashboard/followup.html";
var FU2_NOTIFY_CALLBACK_MAX = 64;             // Telegram's callback_data limit, in bytes

var FU2_NOTIFY_LOG_SHEET = "FollowupNotifications";
var FU2_NOTIFY_LOG_HEADERS = ["group_key", "group", "session_date", "event", "fired_at", "count"];
var FU2_DONE_SHEET = "FollowupDone";
var FU2_DONE_HEADERS = ["group_key", "kind", "session_date", "marked_at", "by"];
var FU2_SETTINGS_SHEET = "NotifySettings";
var FU2_SETTINGS_HEADERS = ["group_key", "enabled", "hour", "snooze_until", "updated_at", "updated_by"];

// event key -> the manual "done" kind it can be marked with. parents_* and attendance finish by themselves.
var FU2_NOTIFY_DONE_KIND = { remind_watch: "watch", remind_hw: "hw", advance_lessons: "advance" };
var FU2_NOTIFY_KINDS = { watch: 1, hw: 1, advance: 1 };

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
function fu2_notify_now_() { return _fmt(new Date(), TZ, true); }          // "yyyy-MM-dd HH:mm:ss" in Alex time
function fu2_notify_today_() { return _fmt(new Date(), TZ, false); }
function fu2_notify_hourNow_() { return parseInt(fu2_notify_now_().slice(11, 13), 10); }

function fu2_notify_addDays_(ymd, n) {
  var p = String(ymd).split("-").map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  var m = t.getUTCMonth() + 1, d = t.getUTCDate();
  return t.getUTCFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}

function fu2_notify_bool_(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

// A cell that Sheets may have turned into a Date -> text.
function fu2_notify_cell_(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return _fmt(v, TZ, false);
  return String(v).trim();
}

function fu2_notify_rows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  var head = values[0], out = [];
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < head.length; j++) if (head[j] !== "") o[head[j]] = values[i][j];
    out.push(o);
  }
  return out;
}

// Appends one row and stores every cell as plain text, so "2026-11-07" never becomes a date cell
// and a group key never becomes a number.
function fu2_notify_appendText_(sheet, vals) {
  sheet.appendRow(vals);
  var r = sheet.getLastRow(), rng = sheet.getRange(r, 1, 1, vals.length);
  rng.setNumberFormat("@");
  rng.setValues([vals.map(function (v) { return v === null || v === undefined ? "" : String(v); })]);
  return r;
}

function fu2_notify_writeRowText_(sheet, row, vals) {
  var rng = sheet.getRange(row, 1, 1, vals.length);
  rng.setNumberFormat("@");
  rng.setValues([vals.map(function (v) { return v === null || v === undefined ? "" : String(v); })]);
}

function fu2_notify_audit_(payload, action, target, before, after) {
  try {
    if (typeof p2_audit !== "function") return;
    var who = payload && payload.token ? "token" : String((payload && payload.student_id) || "");
    p2_audit(who, action, target, before, after);
  } catch (e) { /* auditing never breaks the action */ }
}

function fu2_notify_by_(payload) {
  return payload && payload.token ? "token" : String((payload && payload.student_id) || "");
}

// ---------------------------------------------------------------------------------------------
// Sheets: settings and done (read once each by the hook, written under the lock)
// ---------------------------------------------------------------------------------------------
function fu2_notify_defaults_() { return { enabled: true, hour: FU2_NOTIFY_HOUR_DEFAULT, snooze_until: "" }; }

function fu2_notify_settingsFromRow_(r) {
  var h = parseInt(r.hour, 10);
  return {
    enabled: fu2_notify_bool_(r.enabled, true),
    hour: (isNaN(h) || h < 0 || h > 23) ? FU2_NOTIFY_HOUR_DEFAULT : h,
    snooze_until: fu2_notify_cell_(r.snooze_until),
  };
}

// {group_key: {enabled,hour,snooze_until}} for the groups that have a row. Does not create the sheet.
function fu2_notify_settingsMap_() {
  var out = {};
  fu2_notify_rows_(_dataSs().getSheetByName(FU2_SETTINGS_SHEET)).forEach(function (r) {
    var k = fu2_notify_cell_(r.group_key);
    if (k) out[k] = fu2_notify_settingsFromRow_(r);   // later rows win
  });
  return out;
}

// {group_key: ["watch|2026-11-07", ...]}. Does not create the sheet.
function fu2_notify_doneMap_() {
  var out = {};
  fu2_notify_rows_(_dataSs().getSheetByName(FU2_DONE_SHEET)).forEach(function (r) {
    var k = fu2_notify_cell_(r.group_key), kind = fu2_notify_cell_(r.kind), d = fu2_notify_cell_(r.session_date);
    if (!k || !kind || !d) return;
    var s = kind + "|" + d;
    if (!out[k]) out[k] = [];
    if (out[k].indexOf(s) === -1) out[k].push(s);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Overview hook (S5 calls it at the end of the follow-up overview, inside its own try/catch)
// ---------------------------------------------------------------------------------------------
function fu2_notify_overviewHook_(overview) {
  if (!overview) return;
  overview.tz_label = FU2_NOTIFY_TZ_LABEL;
  var settings = fu2_notify_settingsMap_(), done = fu2_notify_doneMap_();
  (overview.groups || []).forEach(function (g) {
    var k = String(g.key || g.group_key || g.group || "");
    g.done = (done[k] || []).slice();
    g.notify = settings[k] ? { enabled: settings[k].enabled, hour: settings[k].hour, snooze_until: settings[k].snooze_until } : fu2_notify_defaults_();
  });
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------
function fu2_notify_markDone_(payload) {
  var group = String(payload.group || payload.group_key || "").trim();
  var kind = String(payload.kind || "").trim();
  var date = String(payload.session_date || "").trim();
  if (!group || group.length > 200) throw new Error("Missing group.");
  if (!FU2_NOTIFY_KINDS.hasOwnProperty(kind)) throw new Error("Unknown kind.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid session date.");
  return _withLock(function () {
    var sh = _sheetByName(_dataSs(), FU2_DONE_SHEET, FU2_DONE_HEADERS);
    var exists = fu2_notify_rows_(sh).some(function (r) {
      return fu2_notify_cell_(r.group_key) === group && fu2_notify_cell_(r.kind) === kind && fu2_notify_cell_(r.session_date) === date;
    });
    if (!exists) {
      fu2_notify_appendText_(sh, [group, kind, date, fu2_notify_now_(), fu2_notify_by_(payload)]);
      fu2_notify_audit_(payload, "fu2_mark_done", group, "", kind + "|" + date);
    }
    return { ok: true, done: fu2_notify_doneMap_()[group] || [] };
  });
}

function fu2_notify_settingsGet_(payload) {
  return { ok: true, groups: fu2_notify_settingsMap_() };
}

function fu2_notify_settingsSave_(payload) {
  var group = String(payload.group || payload.group_key || "").trim();
  if (!group || group.length > 200) throw new Error("Missing group.");
  var has = function (f) { return payload.hasOwnProperty(f) && payload[f] !== undefined; };
  var patch = {};
  if (has("enabled")) patch.enabled = fu2_notify_bool_(payload.enabled, true);
  if (has("hour")) {
    var h = Number(payload.hour);
    if (payload.hour === "" || payload.hour === null || isNaN(h) || h !== Math.floor(h) || h < 0 || h > 23) throw new Error("Hour must be 0 to 23.");
    patch.hour = h;
  }
  if (has("snooze_until")) {
    var s = String(payload.snooze_until === null ? "" : payload.snooze_until).trim();
    if (s !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("Snooze must be a date (yyyy-MM-dd) or empty.");
    patch.snooze_until = s;
  }
  return _withLock(function () {
    var settings = fu2_notify_writeSettings_(group, patch, payload);
    return { ok: true, settings: settings };
  });
}

// Merges a patch into the group's settings row (creates it on first use). Call inside the lock.
function fu2_notify_writeSettings_(group, patch, payload) {
  var sh = _sheetByName(_dataSs(), FU2_SETTINGS_SHEET, FU2_SETTINGS_HEADERS);
  var rows = fu2_notify_rows_(sh), row = null;
  rows.forEach(function (r) { if (fu2_notify_cell_(r.group_key) === group) row = r; });
  var before = row ? fu2_notify_settingsFromRow_(row) : fu2_notify_defaults_();
  var after = {
    enabled: patch.hasOwnProperty("enabled") ? patch.enabled : before.enabled,
    hour: patch.hasOwnProperty("hour") ? patch.hour : before.hour,
    snooze_until: patch.hasOwnProperty("snooze_until") ? patch.snooze_until : before.snooze_until,
  };
  var vals = [group, after.enabled ? "TRUE" : "FALSE", after.hour, after.snooze_until, fu2_notify_now_(), fu2_notify_by_(payload)];
  if (row) fu2_notify_writeRowText_(sh, row._row, vals); else fu2_notify_appendText_(sh, vals);
  fu2_notify_audit_(payload, "fu2_notify_settings", group, before, after);
  return after;
}

function fu2_notify_test_(payload) {
  var ids = _tgAdminIds(), sent = 0;
  var text = "✅ <b>Test from Follow-up</b>\n🕓 " + fu2_notify_time12_(fu2_notify_now_().slice(11, 16)) + " " + FU2_NOTIFY_TZ_LABEL;   // integration: 12-hour
  ids.forEach(function (id) { if (fu2_notify_sendOne_(id, text, null)) sent++; });
  return { ok: true, sent_to: sent };
}

// For the script editor (run it from the function list). Not an action: nothing in doPost can reach it.
function fu2_notify_sendTest() { return fu2_notify_test_({}); }

function fu2_notify_wrap_(fn) {
  return function (payload) {
    try {
      payload = payload || {};
      _requireAdminAny(payload);
      return fn(payload);
    } catch (e) {
      var out = { ok: false, error: String((e && e.message) || e) };
      if (e && e.retryable) out.retryable = true;
      return out;
    }
  };
}

// {action: function(payload)} for S5's router.
function fu2_notify_routes_() {
  return {
    admin_fu2_mark_done: fu2_notify_wrap_(fu2_notify_markDone_),
    admin_fu2_notify_settings_get: fu2_notify_wrap_(fu2_notify_settingsGet_),
    admin_fu2_notify_settings_save: fu2_notify_wrap_(fu2_notify_settingsSave_),
    admin_fu2_notify_test: fu2_notify_wrap_(fu2_notify_test_),
  };
}

// ---------------------------------------------------------------------------------------------
// Telegram sending
// ---------------------------------------------------------------------------------------------
function fu2_notify_okResponse_(resp) {
  try {
    if (resp && typeof resp.getResponseCode === "function") return resp.getResponseCode() < 300;
  } catch (e) { return false; }
  return true;
}

// One chat. Never throws; true when Telegram accepted it.
function fu2_notify_sendOne_(chatId, text, keyboard) {
  try {
    var body = { chat_id: chatId, text: String(text).slice(0, 3500), parse_mode: "HTML", disable_web_page_preview: true };
    if (keyboard && keyboard.length) body.reply_markup = { inline_keyboard: keyboard };
    return fu2_notify_okResponse_(_tgCall("sendMessage", body));
  } catch (e) {
    console.error("fu2 notify send failed for " + chatId + ": " + e);
    return false;
  }
}

function fu2_notify_bytes_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? (i++, 4) : 3;
  }
  return n;
}

function fu2_notify_cap_(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fu2_notify_plural_(n, one, many) { return n + " " + (n === 1 ? one : many); }

// English text, group and lesson names as stored, times written 12-hour: "4:05 PM Alex" (owner decision, contract 3.9 / 3.12).
// "HH:MM" -> "h:MM AM|PM"; "" for bad input (same rule as fmtTime12 on the page).
function fu2_notify_time12_(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm == null ? "" : hhmm)); if (!m) return "";
  var h = +m[1]; if (h > 23) return "";
  return ((h % 12) || 12) + ":" + m[2] + " " + (h >= 12 ? "PM" : "AM");
}
function fu2_notify_compose_(d) {
  var g = "<b>" + _esc(fu2_notify_cap_(d.group || d.group_key, 120)) + "</b>";
  var n = Math.max(0, parseInt(d.count, 10) || 0), key = String(d.key);
  var line;
  if (key === "attendance") line = "📋 " + g + ": mark attendance, " + fu2_notify_plural_(n, "student", "students") + " unmarked.";
  else if (key === "parents_watch") line = "👀 " + g + ": message the parents, " + fu2_notify_plural_(n, "student has", "students have") + " not watched the video.";
  else if (key === "parents_hw") line = "📚 " + g + ": message the parents, " + fu2_notify_plural_(n, "student is", "students are") + " missing homework or the quiz.";
  else if (key === "remind_watch") line = "🎬 " + g + ": remind the group to watch the video, " + n + " not done.";
  else if (key === "remind_hw") line = "📝 " + g + ": remind the group about homework, " + n + " missing.";
  else if (key === "advance_lessons") line = "⏭️ " + g + ": move the group on to the next lesson.";
  else if (key === "setup_missing") line = "⚙️ " + g + ": set the weekday, time and current lesson.";
  else line = "🔔 " + g + ": " + _esc(key) + ", " + n + ".";
  if ((key === "parents_watch" || key === "parents_hw") && d.blocked_count > 0)
    line += " " + d.blocked_count + " more waiting for attendance first.";
  if (d.lesson && key !== "setup_missing" && key !== "attendance") {
    var pretty = typeof _prettyLesson === "function" ? _prettyLesson(d.lesson) : String(d.lesson);
    line += "\n📘 " + _esc(fu2_notify_cap_(pretty, 160));
  }
  line += "\n🕓 " + fu2_notify_time12_(fu2_notify_now_().slice(11, 16)) + " " + FU2_NOTIFY_TZ_LABEL;   // integration: was 24-hour
  return line;
}

// Open (URL) + Snooze + Done (only for events that can be marked). A callback that would be over
// Telegram's 64 byte limit is left out rather than risking the whole message being refused.
function fu2_notify_keyboard_(d) {
  var key = String(d.key), gk = String(d.group_key);
  var row = [{ text: "Open", url: FU2_NOTIFY_PAGE + "#g=" + encodeURIComponent(gk) + "&step=" + encodeURIComponent(key) }];
  var snooze = "fu:snooze:" + gk;
  if (fu2_notify_bytes_(snooze) <= FU2_NOTIFY_CALLBACK_MAX) row.push({ text: "Snooze 1 day", callback_data: snooze });
  if (FU2_NOTIFY_DONE_KIND.hasOwnProperty(key) && d.session_date) {
    var done = "fu:done:" + gk + ":" + key + ":" + d.session_date;
    if (fu2_notify_bytes_(done) <= FU2_NOTIFY_CALLBACK_MAX) row.push({ text: "Done", callback_data: done });
  }
  return [row];
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------
function fu2_notify_logKey_(groupKey, sessionDate, event) { return groupKey + "|" + sessionDate + "|" + event; }

// Trigger entry point (a plain public name; triggers can't reliably target names ending in "_").
function fu2_notify_tick() { return fu2_notify_tick_(); }

function fu2_notify_tick_() {
  try {
    if (typeof fu2_core_overviewInternal_ !== "function" || typeof fu2_logic_dueNow_ !== "function")
      return { ok: false, error: "Follow-up logic is not installed." };
    var hour = fu2_notify_hourNow_();
    if (hour < FU2_NOTIFY_QUIET_FROM || hour >= FU2_NOTIFY_QUIET_TO) return { ok: true, sent: 0, quiet: true };

    // Build the overview BEFORE taking our lock (the overview may take the script lock itself).
    var overview = fu2_core_overviewInternal_();
    var due = fu2_logic_dueNow_(overview, _cairoIso(new Date())) || [];
    due = due.filter(function (d) { return d && d.group_key && d.key && (parseInt(d.count, 10) || 0) > 0; });
    if (!due.length) return { ok: true, sent: 0 };
    var chats = _tgAdminIds();
    if (!chats.length) return { ok: true, sent: 0, error: "No Telegram chat configured." };

    // Claim under the lock (so two ticks never send the same event), send outside it.
    var claimed = [];
    try {
      _withLock(function () {
        var sh = _sheetByName(_dataSs(), FU2_NOTIFY_LOG_SHEET, FU2_NOTIFY_LOG_HEADERS);
        var seen = {};
        fu2_notify_rows_(sh).forEach(function (r) {
          seen[fu2_notify_logKey_(fu2_notify_cell_(r.group_key), fu2_notify_cell_(r.session_date), fu2_notify_cell_(r.event))] = 1;
        });
        due.forEach(function (d) {
          var lk = fu2_notify_logKey_(String(d.group_key), String(d.session_date || ""), String(d.key));
          if (seen[lk]) return;
          seen[lk] = 1;
          fu2_notify_appendText_(sh, [d.group_key, d.group || "", d.session_date || "", d.key, fu2_notify_now_(), d.count]);
          claimed.push(d);
        });
      }, 5000);
    } catch (busy) {
      return { ok: true, sent: 0, busy: true };
    }

    var sent = 0, failed = [];
    claimed.forEach(function (d) {
      var text = fu2_notify_compose_(d), kb = fu2_notify_keyboard_(d), okAny = false;
      chats.forEach(function (id) { if (fu2_notify_sendOne_(id, text, kb)) okAny = true; });
      if (okAny) sent++; else failed.push(d);
    });
    // Nobody got it: give the claim back so the next tick tries again.
    if (failed.length) fu2_notify_unclaim_(failed);
    return { ok: true, sent: sent, failed: failed.length };
  } catch (e) {
    console.error("fu2 notify tick failed: " + e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function fu2_notify_unclaim_(items) {
  try {
    _withLock(function () {
      var sh = _sheetByName(_dataSs(), FU2_NOTIFY_LOG_SHEET, FU2_NOTIFY_LOG_HEADERS);
      var wanted = {};
      items.forEach(function (d) { wanted[fu2_notify_logKey_(String(d.group_key), String(d.session_date || ""), String(d.key))] = 1; });
      var rows = fu2_notify_rows_(sh).filter(function (r) {
        return wanted[fu2_notify_logKey_(fu2_notify_cell_(r.group_key), fu2_notify_cell_(r.session_date), fu2_notify_cell_(r.event))];
      });
      rows.sort(function (a, b) { return b._row - a._row; });   // bottom first so row numbers stay valid
      rows.forEach(function (r) { sh.deleteRows(r._row, 1); });
    }, 5000);
  } catch (e) { console.error("fu2 notify unclaim failed: " + e); }
}

// ---------------------------------------------------------------------------------------------
// Trigger management (run fu2_notify_installTrigger once from the script editor)
// ---------------------------------------------------------------------------------------------
function fu2_notify_removeTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === "fu2_notify_tick" || h === "fu2_notify_tick_") { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function fu2_notify_installTrigger() {
  fu2_notify_removeTrigger();
  ScriptApp.newTrigger("fu2_notify_tick").timeBased().everyHours(1).create();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Telegram callbacks:  fu:snooze:<group_key>   fu:done:<group_key>:<event key>:<session_date>
// S5 has already checked the webhook secret, the admin id and the update_id; the id is checked again here.
// Returns the verdict line to append to the message. Never throws.
// ---------------------------------------------------------------------------------------------
function fu2_notify_telegramCallback_(cq) {
  try {
    if (!cq || !cq.from || _tgAdminIds().indexOf(String(cq.from.id)) === -1) return "Not allowed.";
    var data = String(cq.data || "");
    var by = "telegram:" + cq.from.id, payload = { student_id: by };
    var m = /^fu:snooze:(.+)$/.exec(data);
    if (m) {
      var until = fu2_notify_addDays_(fu2_notify_today_(), 1);
      _withLock(function () { fu2_notify_writeSettings_(m[1], { snooze_until: until }, payload); });
      return "😴 Snoozed until " + until + " (" + FU2_NOTIFY_TZ_LABEL + ").";
    }
    m = /^fu:done:(.+):([a-z_]+):(\d{4}-\d{2}-\d{2})$/.exec(data);
    if (m) {
      var kind = FU2_NOTIFY_DONE_KIND[m[2]];
      if (!kind) return "Nothing to mark: this one finishes by itself.";
      var res = fu2_notify_markDone_({ group: m[1], kind: kind, session_date: m[3], student_id: by });
      return res && res.ok ? "✅ Marked done." : "Could not mark it done.";
    }
    return "Unknown button.";
  } catch (e) {
    console.error("fu2 notify callback failed: " + e);
    return "Something went wrong. Try from the page.";
  }
}
