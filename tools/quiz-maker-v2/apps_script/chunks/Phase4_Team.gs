// ============================================================================
// Phase4_Team.gs  (P4 / S5)  Teacher accounts, teacher-appointed assistants, student record edits.
//
// Contract: 00-MASTER-CONTRACT.md v2 sections 2, 3, 6, 6c. Nothing here runs at load time.
// Depends on Code.gs helpers only (+ Phase3 role helpers when present). Every call into another
// P4 session is guarded with typeof and fails CLOSED:
//   S2: p4_ctx(payload)            (who is calling; kind "owner" | "teacher" | "assistant" ...)
//   S3: p4_ownsStudent(ctx, phone), p4_lookupAllowed_(ctx)  (shared A17 bucket)
//   S6: p4_ownerPing_(text)
// Private helpers are prefixed p4t_ (or P4T_) and never collide with S2/S3/S6/S8 names.
//
// Editor functions: p4_setup, p4_mint_teacher_token, p4_revoke_teacher_token, p4_selfTest_team.
// Router actions:   p4_admin_set_teacher, p4_admin_list_teachers, p4_admin_list_edit_log,
//                   p4_teacher_set_assistant, p4_teacher_list_assistants, p4_teacher_revoke_assistant,
//                   p4_teacher_update_student.
// ============================================================================

var P4T_SUBJECTS = ["programming", "english", "math"];
var P4T_STU_COLS = ["teacher_scope", "assistant_of"];
var P4T_GROUPOWNERS_HEADERS = ["group", "owner_id", "created_at"];
var P4T_TELEGRAM_HEADERS = ["teacher_id", "chat_id", "linked_at"];
var P4T_EDITLOG_HEADERS = ["ts", "actor_kind", "actor_id", "student_old", "student_new", "field", "old_value", "new_value"];
var P4T_GENERIC = "Could not apply that change.";
var P4T_LOCK_MS = 20000;
var P4T_LOOKUP_LIMIT = 30;
var P4T_LOOKUP_WINDOW_S = 3600;
// Ships OFF: Drive meta files and written-image file names still carry the old phone and cannot
// be rewritten (see HANDOFF section 7). An explicit "1" in Script Properties turns it on.
var P4T_PHONE_EDIT_DEFAULT = "0";

// Every store that keys data by a student's phone. book: "ss" = _ss(), "data" = _dataSs().
var P4T_PHONE_STORES = [
  { book: "ss", tab: "Entitlements", col: "phone" },
  { book: "ss", tab: "Payments", col: "phone" },
  { book: "ss", tab: "QuizAccess", col: "phone" },
  { book: "ss", tab: "Groups", col: "phone" },
  { book: "ss", tab: "Attendance", col: "phone" },
  { book: "ss", tab: "WatchProgress", col: "phone" },
  { book: "ss", tab: "ParentNotifications", col: "student" },
  { book: "ss", tab: "MonthlyReviews", col: "student" },
  { book: "data", tab: "QuizResults", col: "student_id" },
  { book: "data", tab: "Submissions", col: "student_id" },
  { book: "data", tab: "WrittenAnswers", col: "student_id" }
];

// ---------------------------------------------------------------- small pure helpers

function p4t_denied_() { return { ok: false, error: "Not authorized." }; }
function p4t_generic_() { return { ok: false, error: P4T_GENERIC }; }
function p4t_lc_(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

function p4t_hash_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join("");
}

// "math, Programming" -> "math,programming". Returns null for anything unknown, "*" included.
// "" -> "" (meaning: no scope).
function p4t_scope_(raw) {
  var parts = String(raw == null ? "" : raw).split(",").map(p4t_lc_).filter(function (x) { return x !== ""; });
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (P4T_SUBJECTS.indexOf(parts[i]) === -1) return null;
    if (out.indexOf(parts[i]) === -1) out.push(parts[i]);
  }
  return out.join(",");
}

// Trim, strip control characters, 2 to 80 characters. Returns "" when not acceptable.
function p4t_cleanName_(v) {
  if (typeof v !== "string") return "";
  var s = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  var n = Array.from(s).length;
  return n >= 2 && n <= 80 ? s : "";
}

// Egyptian mobile in canonical form (same rule as auth.js isEgyptMobile), else "".
function p4t_cleanPhone_(v) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  var d = _canonicalPhone(v);
  return /^01[0125]\d{8}$/.test(d) ? d : "";
}

function p4t_maxAssistants_() {
  var n = parseInt(_props().getProperty("P4_MAX_ASSISTANTS") || "5", 10);
  return isNaN(n) || n < 0 ? 5 : n;
}

function p4t_phoneEditOn_() {
  var v = _props().getProperty("P4_TEACHER_PHONE_EDIT");
  if (v === null || v === undefined || String(v).trim() === "") v = P4T_PHONE_EDIT_DEFAULT;
  return String(v).trim() !== "0";
}

function p4t_ctx_(payload) {
  try { return typeof p4_ctx === "function" ? p4_ctx(payload) : null; } catch (e) { return null; }
}
function p4t_isOwner_(payload) { var c = p4t_ctx_(payload); return !!c && c.kind === "owner"; }

function p4t_who_(payload) {
  try { return typeof _p3Who === "function" ? _p3Who(payload) : String((payload && payload.student_id) || "admin-token"); } catch (e) { return "admin"; }
}
function p4t_audit_(payload, action, target, before, after) {
  try { if (typeof p2_audit === "function") p2_audit(p4t_who_(payload), action, target, before, after); } catch (e) { /* best effort */ }
}

// A17: one lookup bucket per principal. S3's helper when present, otherwise the same idea on
// CacheService (key p4lk:<principal or id>, 30 per rolling window). true = allowed.
function p4t_lookup_(ctx) {
  try {
    if (typeof p4_lookupAllowed_ === "function") {
      var r = p4_lookupAllowed_(ctx);
      return !(r === false || r === null || r === undefined || (typeof r === "object" && r.ok === false));
    }
  } catch (e) { return false; }
  try {
    var id = String((ctx && (ctx.principal || ctx.id)) || "");
    if (!id) return false;
    var cache = CacheService.getScriptCache(), key = "p4lk:" + id;
    var now = Math.floor(Date.now() / 1000), n = 0, t0 = now;
    var raw = cache.get(key);
    if (raw) { var p = String(raw).split("|"); n = parseInt(p[0], 10) || 0; t0 = parseInt(p[1], 10) || now; }
    if (now - t0 >= P4T_LOOKUP_WINDOW_S) { n = 0; t0 = now; }
    if (n >= P4T_LOOKUP_LIMIT) return false;
    cache.put(key, (n + 1) + "|" + t0, Math.max(1, P4T_LOOKUP_WINDOW_S - (now - t0)));
    return true;
  } catch (e2) { return false; }
}

// ---------------------------------------------------------------- Students-sheet access

function p4t_headers_(sheet) {
  var last = sheet.getLastColumn();
  return last < 1 ? [] : sheet.getRange(1, 1, 1, last).getValues()[0];
}

function p4t_ensureCol_(sheet, name) {
  var headers = p4t_headers_(sheet);
  for (var i = 0; i < headers.length; i++) if (String(headers[i]).trim() === name) return i + 1;
  var last = sheet.getLastColumn();
  if (typeof sheet.getMaxColumns === "function" && last >= sheet.getMaxColumns()) sheet.insertColumnAfter(last);
  sheet.getRange(1, last + 1).setValue(name);
  return last + 1;
}

// Write path: makes sure role / teacher_scope / assistant_of exist, returns {sheet, c}.
function p4t_studentsForWrite_() {
  var sheet = _students();
  if (typeof _p3EnsureRoleColumn === "function") _p3EnsureRoleColumn(sheet); else p4t_ensureCol_(sheet, "role");
  P4T_STU_COLS.forEach(function (n) { p4t_ensureCol_(sheet, n); });
  return { sheet: sheet, c: _studentCols(p4t_headers_(sheet)) };
}

// Read path: never creates columns; a missing column reads as blank.
function p4t_studentsRead_() {
  var values = _students().getDataRange().getValues();
  return { values: values, c: _studentCols(values[0]) };
}

function p4t_get_(values, c, i, name) {
  return c[name] ? values[i][c[name] - 1] : "";
}

function p4t_findIdx_(values, c, phone) {
  var target = _normalizePhone(phone);
  if (!target) return -1;
  for (var i = 1; i < values.length; i++) if (_phonesMatch(values[i][c.phone - 1], target)) return i;
  return -1;
}

function p4t_roleOf_(values, c, i) { return p4t_lc_(p4t_get_(values, c, i, "role")); }
function p4t_isAdminRow_(values, c, i) { return c.is_admin ? _isTruthyFlag(values[i][c.is_admin - 1]) : false; }
function p4t_phoneOut_(v) { return _restoreLeadingZero(String(v == null ? "" : v)); }
function p4t_nameOut_(v) { return String(v == null ? "" : v); }

function p4t_setCell_(sheet, row, col, value) {
  sheet.getRange(row, col).setNumberFormat("@").setValue(value);
}

// Appends one row as plain text (phones keep their leading 0, "=..." stays text).
function p4t_appendText_(sheet, headers, rec) {
  var hs = p4t_headers_(sheet);
  var row = hs.map(function (h) { return rec.hasOwnProperty(h) && rec[h] !== null && rec[h] !== undefined ? String(rec[h]) : ""; });
  var r = sheet.getLastRow() + 1;
  if (r > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, r - sheet.getMaxRows()));
  sheet.getRange(r, 1, 1, hs.length).setNumberFormat("@").setValues([row]);
  return r;
}

function p4t_now_() { return Utilities.formatDate(new Date(), "Africa/Cairo", "yyyy-MM-dd HH:mm:ss"); }

// ---------------------------------------------------------------- editor functions

// Idempotent. Run once from the editor after pasting.
function p4_setup() {
  var done = [];
  var S = p4t_studentsForWrite_();
  done.push("Students columns: role, teacher_scope, assistant_of");
  var rows = Math.max(S.sheet.getMaxRows() - 1, 1);
  P4T_STU_COLS.forEach(function (n) { S.sheet.getRange(2, S.c[n], rows, 1).setNumberFormat("@"); });
  var ss = _ss();
  [["GroupOwners", P4T_GROUPOWNERS_HEADERS], ["TeacherTelegram", P4T_TELEGRAM_HEADERS], ["StudentEditLog", P4T_EDITLOG_HEADERS]].forEach(function (p) {
    var sh = _followupSheet(ss, p[0], p[1]);
    _ensureColumns(sh, p[1]);
    var hs = p4t_headers_(sh), n = Math.max(sh.getMaxRows() - 1, 1);
    hs.forEach(function (h, i) { if (p[1].indexOf(h) !== -1) sh.getRange(2, i + 1, n, 1).setNumberFormat("@"); });
    done.push("tab " + p[0]);
  });
  var props = _props();
  if (!props.getProperty("P4_TEACHER_TOKENS")) props.setProperty("P4_TEACHER_TOKENS", "{}");
  if (!props.getProperty("P4_MAX_ASSISTANTS")) props.setProperty("P4_MAX_ASSISTANTS", "5");
  if (props.getProperty("P4_TEACHER_PHONE_EDIT") === null || props.getProperty("P4_TEACHER_PHONE_EDIT") === undefined) props.setProperty("P4_TEACHER_PHONE_EDIT", P4T_PHONE_EDIT_DEFAULT);
  Logger.log("p4_setup OK | " + done.join(" | ") + " | P4_TEACHER_PHONE_EDIT=" + (props.getProperty("P4_TEACHER_PHONE_EDIT")));
  return "OK";
}

function p4t_tokens_() {
  try {
    var o = JSON.parse(_props().getProperty("P4_TEACHER_TOKENS") || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }
}

// Logs the raw token ONCE (Executions log). Only its SHA-256 hex is stored.
function p4_mint_teacher_token(name, scope) {
  var nm = String(name == null ? "" : name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,39}$/.test(nm)) throw new Error("Token name: 1 to 40 letters, digits, space, dot, dash or underscore.");
  var sc = p4t_scope_(scope);
  if (sc === null || sc === "") throw new Error("Scope must be one or more of: " + P4T_SUBJECTS.join(", ") + ".");
  var raw = "p4t_" + Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  _withLock(function () {
    var all = p4t_tokens_();
    Object.keys(all).forEach(function (h) { if (all[h] && p4t_lc_(all[h].name) === p4t_lc_(nm)) throw new Error('A token named "' + nm + '" already exists. Revoke it first.'); });
    all[p4t_hash_(raw)] = { name: nm, scope: sc, created: p4t_now_().replace(" ", "T") };
    _props().setProperty("P4_TEACHER_TOKENS", JSON.stringify(all));
  });
  Logger.log("TEACHER TOKEN for \"" + nm + "\" (scope " + sc + "). Copy it now; it is never shown again:\n" + raw);
  return raw;
}

function p4_revoke_teacher_token(name) {
  var nm = p4t_lc_(name), removed = 0;
  _withLock(function () {
    var all = p4t_tokens_();
    Object.keys(all).forEach(function (h) { if (all[h] && p4t_lc_(all[h].name) === nm) { delete all[h]; removed++; } });
    _props().setProperty("P4_TEACHER_TOKENS", JSON.stringify(all));
  });
  Logger.log("p4_revoke_teacher_token: removed " + removed + " token(s) named \"" + name + "\".");
  return removed;
}

// ---------------------------------------------------------------- owner: accounts

// {phone, scope}: scope "math" (or "math,english") makes a teacher; "" removes him.
function p4_admin_set_teacher(payload) {
  payload = payload || {};
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var phone = _normalizePhone(payload.phone);
  if (!phone) return { ok: false, error: "Missing phone number." };
  var scope = p4t_scope_(payload.scope);
  if (scope === null) return { ok: false, error: "Unknown subject. Use: " + P4T_SUBJECTS.join(", ") + "." };
  var res = _withLock(function () {
    var S = p4t_studentsForWrite_();
    var values = S.sheet.getDataRange().getValues(), c = S.c;
    var i = p4t_findIdx_(values, c, phone);
    if (i < 0) return { ok: false, error: "No student account with that phone number." };
    if (p4t_isAdminRow_(values, c, i)) return { ok: false, error: "This account is the owner; its role can't be changed here." };
    var row = i + 1, tPhone = _normalizePhone(values[i][c.phone - 1]);
    var beforeRole = p4t_roleOf_(values, c, i), beforeScope = p4t_lc_(p4t_get_(values, c, i, "teacher_scope"));
    var out = { ok: true, phone: p4t_phoneOut_(values[i][c.phone - 1]) };
    if (scope !== "") {
      p4t_setCell_(S.sheet, row, c.role, "teacher");
      p4t_setCell_(S.sheet, row, c.teacher_scope, scope);
      p4t_setCell_(S.sheet, row, c.assistant_of, "");
      out.role = "teacher"; out.scope = scope;
      out._before = { role: beforeRole, scope: beforeScope }; out._after = { role: "teacher", scope: scope };
      return out;
    }
    // Removal. Only a teacher is demoted; any other role is left alone.
    if (beforeRole !== "teacher") { out.role = beforeRole === "assistant" ? "assistant" : "student"; out.scope = ""; out._noop = true; return out; }
    p4t_setCell_(S.sheet, row, c.role, "");
    p4t_setCell_(S.sheet, row, c.teacher_scope, "");
    var reset = 0;
    for (var k = 1; k < values.length; k++) {
      if (k === i) continue;
      if (p4t_roleOf_(values, c, k) === "assistant" && String(p4t_get_(values, c, k, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(values, c, k, "assistant_of"), tPhone)) {
        p4t_setCell_(S.sheet, k + 1, c.role, "");
        p4t_setCell_(S.sheet, k + 1, c.assistant_of, "");
        reset++;
      }
    }
    out.role = "student"; out.scope = ""; out._reset = reset;
    out._before = { role: "teacher", scope: beforeScope }; out._after = { role: "student", scope: "" };
    return out;
  });
  if (res && res.ok && !res._noop && res._before) p4t_audit_(payload, "p4_admin_set_teacher", res.phone, res._before, res._after);
  if (res) { delete res._before; delete res._after; delete res._noop; delete res._reset; }
  return res;
}

// {} -> {ok, teachers:[{phone,name,scope,telegram,assistants:[{phone,name}]}], tokens:[{name,scope,created}]}
function p4_admin_list_teachers(payload) {
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var R = p4t_studentsRead_(), values = R.values, c = R.c;
  var linked = [];
  try {
    var tg = _ss().getSheetByName("TeacherTelegram");
    if (tg && tg.getLastRow() >= 2) {
      var h = _headerIndex(tg);
      if (h.teacher_id) tg.getRange(2, h.teacher_id, tg.getLastRow() - 1, 1).getValues().forEach(function (r) { if (String(r[0]).trim() !== "") linked.push(r[0]); });
    }
  } catch (e) { /* tab missing: nobody linked */ }
  var teachers = [], byPhone = {};
  for (var i = 1; i < values.length; i++) {
    if (p4t_roleOf_(values, c, i) !== "teacher" || p4t_isAdminRow_(values, c, i)) continue;
    var ph = _normalizePhone(values[i][c.phone - 1]);
    var t = { phone: p4t_phoneOut_(values[i][c.phone - 1]), name: p4t_nameOut_(values[i][c.display_name - 1]), scope: p4t_lc_(p4t_get_(values, c, i, "teacher_scope")),
              telegram: linked.some(function (l) { return _phonesMatch(l, ph); }), assistants: [] };
    teachers.push(t); byPhone[ph] = t;
  }
  for (var k = 1; k < values.length; k++) {
    if (p4t_roleOf_(values, c, k) !== "assistant") continue;
    var of = p4t_get_(values, c, k, "assistant_of");
    if (String(of).trim() === "") continue;
    teachers.forEach(function (t2) {
      if (_phonesMatch(of, t2.phone)) t2.assistants.push({ phone: p4t_phoneOut_(values[k][c.phone - 1]), name: p4t_nameOut_(values[k][c.display_name - 1]) });
    });
  }
  var toks = p4t_tokens_(), tokens = Object.keys(toks).map(function (h2) {
    return { name: String(toks[h2] && toks[h2].name || ""), scope: String(toks[h2] && toks[h2].scope || ""), created: String(toks[h2] && toks[h2].created || "") };
  });
  return { ok: true, teachers: teachers, tokens: tokens };
}

// {limit?} newest first, default 200.
// Rows from StudentEditLog (teachers editing a student's name/phones) plus the AuditLog rows written by a teacher or
// an assistant (attendance, grades, parent contacts, group settings...). Each row says who: actor_kind
// "teacher" | "assistant", actor_id (phone) and actor_name. The owner's own AuditLog rows are left out.
function p4_admin_list_edit_log(payload) {
  if (!p4t_isOwner_(payload)) return p4t_denied_();
  var limit = parseInt(payload && payload.limit, 10);
  if (isNaN(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 1000);
  var rows = [];
  var sh = _ss().getSheetByName("StudentEditLog");
  if (sh && sh.getLastRow() >= 2) {
    var hs = p4t_headers_(sh);
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, hs.length).getValues();
    for (var r = vals.length - 1; r >= 0 && rows.length < limit; r--) {
      var o = {};
      hs.forEach(function (h, j) { if (h !== "") o[h] = String(vals[r][j] == null ? "" : vals[r][j]); });
      o.source = "edit";
      rows.push(o);
    }
  }
  var staff = {};
  try { staff = p4t_staffByPhone_(); } catch (e) { staff = {}; }
  rows.forEach(function (o) { var who = staff[_normalizePhone(o.actor_id)]; if (who && !o.actor_name) o.actor_name = who.name; });
  try { rows = rows.concat(p4t_staffAudit_(staff, limit)); } catch (e2) { Logger.log("staff audit read failed: " + (e2 && e2.message)); }
  rows.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0; });
  return { ok: true, rows: rows.slice(0, limit) };
}

// {normalized phone: {kind: "teacher"|"assistant", name}} for every teacher and assistant row in Students.
function p4t_staffByPhone_() {
  var S = p4_readStudents_(), out = {};
  for (var i = 1; i < S.values.length; i++) {
    var role = p4_roleOf_(S, i);
    if (role !== "teacher" && role !== "assistant") continue;
    if (S.c.is_admin && _isTruthyFlag(p4_cell_(S, i, "is_admin"))) continue;
    var ph = _normalizePhone(p4_idOf_(S, i));
    if (!ph) continue;
    var nm = S.c.display_name ? String(p4_cell_(S, i, "display_name") || "") : "";
    out[ph] = { kind: role, name: nm };
  }
  return out;
}

// The newest AuditLog rows whose "who" is a teacher or an assistant, shaped like StudentEditLog rows.
// Reads only the last 3000 AuditLog rows so a long log stays quick.
function p4t_staffAudit_(staff, limit) {
  var sh = _dataSs().getSheetByName("AuditLog");
  if (!sh || sh.getLastRow() < 2 || !Object.keys(staff).length) return [];
  var last = sh.getLastRow(), n = Math.min(last - 1, 3000);
  var vals = sh.getRange(last - n + 1, 1, n, 6).getValues(), out = [];
  var s = function (v) { return v == null ? "" : (v instanceof Date ? _cairoIso(v) : String(v)); };
  for (var r = vals.length - 1; r >= 0 && out.length < limit; r--) {
    var who = staff[_normalizePhone(s(vals[r][1]))];
    if (!who) continue;
    var target = s(vals[r][3]);
    if (!target) {   // attendance rows keep the student's phone inside before/after
      try { var bj = JSON.parse(s(vals[r][5]) || "{}"); target = String(bj.phone || bj.student || ""); } catch (e) { /* not JSON */ }
    }
    out.push({ ts: s(vals[r][0]).replace("T", " ").slice(0, 19), actor_kind: who.kind, actor_id: s(vals[r][1]), actor_name: who.name,
               student_old: target, student_new: target, field: s(vals[r][2]), old_value: s(vals[r][4]), new_value: s(vals[r][5]), source: "audit" });
  }
  return out;
}

// ---------------------------------------------------------------- teacher identity

// The calling teacher, re-read from the sheet: {ctx, phone, name, scope} or null.
// kind "teacher" is required HERE too; a scoped assistant is kind "assistant" and never passes.
function p4t_teacher_(payload) {
  var ctx = p4t_ctx_(payload);
  if (!ctx || ctx.kind !== "teacher") return null;
  var phone = _normalizePhone(ctx.principal || ctx.id);
  if (!phone) return null;
  var R = p4t_studentsRead_(), i = p4t_findIdx_(R.values, R.c, phone);
  if (i < 0 || p4t_isAdminRow_(R.values, R.c, i) || p4t_roleOf_(R.values, R.c, i) !== "teacher") return null;
  var scope = p4t_lc_(p4t_get_(R.values, R.c, i, "teacher_scope"));
  if (scope === "") return null;
  return { ctx: ctx, phone: _normalizePhone(R.values[i][R.c.phone - 1]), name: p4t_nameOut_(R.values[i][R.c.display_name - 1]), scope: scope };
}

// ---------------------------------------------------------------- teacher: assistants

function p4t_countAssistants_(values, c, tPhone) {
  var n = 0;
  for (var i = 1; i < values.length; i++) {
    if (p4t_roleOf_(values, c, i) === "assistant" && String(p4t_get_(values, c, i, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(values, c, i, "assistant_of"), tPhone)) n++;
  }
  return n;
}

// {phone}. Always {ok:true, registered:bool}; only a plain student actually changes.
function p4_teacher_set_assistant(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  if (!p4t_lookup_(T.ctx)) return { ok: false, error: "Too many requests." };
  var phone = _normalizePhone(payload.phone);
  var registered = false;
  try {
    var R0 = p4t_studentsRead_();
    registered = !!phone && p4t_findIdx_(R0.values, R0.c, phone) >= 0;
    if (registered) {
      _withLock(function () {
        var S = p4t_studentsForWrite_();
        var values = S.sheet.getDataRange().getValues(), c = S.c;
        var i = p4t_findIdx_(values, c, phone);
        if (i < 0) return;
        var role = p4t_roleOf_(values, c, i);
        var plain = (role === "" || role === "student") && !p4t_isAdminRow_(values, c, i) &&
          p4t_lc_(p4t_get_(values, c, i, "teacher_scope")) === "" && String(p4t_get_(values, c, i, "assistant_of")).trim() === "";
        if (!plain || _phonesMatch(values[i][c.phone - 1], T.phone)) return;
        if (p4t_countAssistants_(values, c, T.phone) >= p4t_maxAssistants_()) return;
        p4t_setCell_(S.sheet, i + 1, c.role, "assistant");
        p4t_setCell_(S.sheet, i + 1, c.assistant_of, T.phone);
        p4t_audit_(payload, "p4_teacher_set_assistant", p4t_phoneOut_(values[i][c.phone - 1]), { role: "", assistant_of: "" }, { role: "assistant", assistant_of: T.phone });
      }, P4T_LOCK_MS);
    }
  } catch (e) { /* the answer must not depend on what happened */ }
  return { ok: true, registered: registered };
}

function p4_teacher_list_assistants(payload) {
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var R = p4t_studentsRead_(), out = [];
  for (var i = 1; i < R.values.length; i++) {
    if (p4t_roleOf_(R.values, R.c, i) === "assistant" && String(p4t_get_(R.values, R.c, i, "assistant_of")).trim() !== "" && _phonesMatch(p4t_get_(R.values, R.c, i, "assistant_of"), T.phone)) {
      out.push({ phone: p4t_phoneOut_(R.values[i][R.c.phone - 1]), name: p4t_nameOut_(R.values[i][R.c.display_name - 1]) });
    }
  }
  return { ok: true, assistants: out, max: p4t_maxAssistants_() };
}

// {phone}. Only an assistant whose assistant_of is this teacher; anything else is "Not authorized.".
function p4_teacher_revoke_assistant(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var phone = _normalizePhone(payload.phone);
  if (!phone) return p4t_denied_();
  var done = false;
  try {
    done = _withLock(function () {
      var S = p4t_studentsForWrite_();
      var values = S.sheet.getDataRange().getValues(), c = S.c;
      var i = p4t_findIdx_(values, c, phone);
      if (i < 0 || p4t_roleOf_(values, c, i) !== "assistant") return false;
      var of = p4t_get_(values, c, i, "assistant_of");
      if (String(of).trim() === "" || !_phonesMatch(of, T.phone)) return false;
      p4t_setCell_(S.sheet, i + 1, c.role, "");
      p4t_setCell_(S.sheet, i + 1, c.assistant_of, "");
      p4t_audit_(payload, "p4_teacher_revoke_assistant", p4t_phoneOut_(values[i][c.phone - 1]), { role: "assistant", assistant_of: T.phone }, { role: "", assistant_of: "" });
      return true;
    }, P4T_LOCK_MS);
  } catch (e) { done = false; }
  return done ? { ok: true } : p4t_denied_();
}

// ---------------------------------------------------------------- teacher: student record edits

// Plans one store: every cell in `col` that matches oldPhone gets newPhone. Reads the column once.
// Returns null when the tab does not exist or is empty (nothing to rewrite); throws when the tab
// exists but lacks the column (cannot rewrite -> the whole edit is refused before any write).
function p4t_planStore_(store, oldPhone, newPhone) {
  var book = store.book === "data" ? _dataSs() : _ss();
  var sh = book.getSheetByName(store.tab);
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) return null;
  var idx = _headerIndex(sh);
  if (!idx[store.col]) throw new Error("The " + store.tab + ' sheet is missing the "' + store.col + '" column.');
  var n = sh.getLastRow() - 1;
  if (n < 1) return null;
  var oldVals = sh.getRange(2, idx[store.col], n, 1).getValues(), newVals = [], hits = 0;
  for (var i = 0; i < n; i++) {
    var cell = oldVals[i][0];
    if (cell !== "" && cell !== null && _phonesMatch(cell, oldPhone)) { newVals.push([newPhone]); hits++; } else newVals.push([cell]);
  }
  return hits ? { store: store, sheet: sh, col: idx[store.col], n: n, oldVals: oldVals, newVals: newVals, hits: hits } : null;
}

// Rewrites the phone everywhere or nowhere. Throws (after restoring what it had changed) on any failure.
function p4t_cascade_(oldPhone, newPhone, studentsWrites) {
  var plans = [];
  P4T_PHONE_STORES.forEach(function (st) { var p = p4t_planStore_(st, oldPhone, newPhone); if (p) plans.push(p); });
  var applied = [];
  try {
    plans.forEach(function (p) {
      var rng = p.sheet.getRange(2, p.col, p.n, 1);
      applied.push(p);
      rng.setNumberFormat("@");
      rng.setValues(p.newVals);
    });
    studentsWrites(applied);
  } catch (e) {
    for (var k = applied.length - 1; k >= 0; k--) {
      try { applied[k].sheet.getRange(2, applied[k].col, applied[k].n, 1).setValues(applied[k].oldVals); } catch (e2) { Logger.log("p4 cascade rollback failed on " + applied[k].store.tab + ": " + e2); }
    }
    throw e;
  }
  var counts = {};
  plans.forEach(function (p) { counts[p.store.tab] = p.hits; });
  return counts;
}

// {student_id, session_token, student, changes:{name?, phone?, parent_phone?}}
function p4_teacher_update_student(payload) {
  payload = payload || {};
  var T = p4t_teacher_(payload);
  if (!T) return p4t_denied_();
  var ownsFn = typeof p4_ownsStudent === "function" ? p4_ownsStudent : null;
  var target = String(payload.student == null ? "" : payload.student);

  // Ownership and "plain student" check against the CURRENT stored phone. Same answer for
  // "does not exist", "not yours" and "not a plain student".
  function resolve(values, c) {
    var i = p4t_findIdx_(values, c, target);
    if (i < 0 || !ownsFn) return -1;
    var role = p4t_roleOf_(values, c, i);
    if ((role !== "" && role !== "student") || p4t_isAdminRow_(values, c, i)) return -1;
    var cur = p4t_phoneOut_(values[i][c.phone - 1]);
    try { if (!ownsFn(T.ctx, cur)) return -1; } catch (e) { return -1; }
    return i;
  }
  var R0 = p4t_studentsRead_();
  if (resolve(R0.values, R0.c) < 0) return p4t_denied_();

  // Whitelist + validation.
  var ch = payload.changes;
  if (!ch || typeof ch !== "object" || Array.isArray(ch)) return p4t_generic_();
  var keys = Object.keys(ch);
  if (!keys.length) return p4t_generic_();
  for (var k = 0; k < keys.length; k++) if (keys[k] !== "name" && keys[k] !== "phone" && keys[k] !== "parent_phone") return p4t_generic_();
  var want = {};
  if (ch.hasOwnProperty("name")) { want.name = p4t_cleanName_(ch.name); if (want.name === "") return p4t_generic_(); }
  if (ch.hasOwnProperty("phone")) { want.phone = p4t_cleanPhone_(ch.phone); if (want.phone === "") return p4t_generic_(); }
  if (ch.hasOwnProperty("parent_phone")) { want.parent_phone = p4t_cleanPhone_(ch.parent_phone); if (want.parent_phone === "") return p4t_generic_(); }

  var result = null, logRows = [], pingText = "";
  try {
    result = _withLock(function () {
      var S = p4t_studentsForWrite_();
      var values = S.sheet.getDataRange().getValues(), c = S.c;
      var i = resolve(values, c);                              // re-check inside the lock
      if (i < 0) return p4t_denied_();
      var row = i + 1;
      var curName = p4t_nameOut_(values[i][c.display_name - 1]);
      var curPhone = p4t_phoneOut_(values[i][c.phone - 1]);
      var curParent = c.parent_phone ? p4t_phoneOut_(values[i][c.parent_phone - 1]) : "";
      var eff = {};
      if (want.hasOwnProperty("name") && want.name !== curName) eff.name = want.name;
      if (want.hasOwnProperty("phone") && _normalizePhone(want.phone) !== _normalizePhone(curPhone)) eff.phone = want.phone;
      if (want.hasOwnProperty("parent_phone") && _normalizePhone(want.parent_phone) !== _normalizePhone(curParent)) eff.parent_phone = want.parent_phone;
      var student = function (n, p, pp) { return { name: n, phone: p, parent_phone: pp }; };
      if (!Object.keys(eff).length) return { ok: true, student: student(curName, curPhone, curParent) };

      if (eff.hasOwnProperty("phone")) {
        if (!p4t_phoneEditOn_()) return p4t_generic_();
        for (var j = 1; j < values.length; j++) {
          if (j !== i && _phonesMatch(values[j][c.phone - 1], eff.phone)) { p4t_lookup_(T.ctx); return p4t_generic_(); }
        }
      }
      var newName = eff.hasOwnProperty("name") ? eff.name : curName;
      var newPhone = eff.hasOwnProperty("phone") ? eff.phone : curPhone;
      var newParent = eff.hasOwnProperty("parent_phone") ? eff.parent_phone : curParent;
      var old = { name: values[i][c.display_name - 1], phone: values[i][c.phone - 1], parent: c.parent_phone ? values[i][c.parent_phone - 1] : "" };

      var writeStudents = function (applied) {
        var done = [];
        try {
          if (eff.hasOwnProperty("phone")) { p4t_setCell_(S.sheet, row, c.phone, newPhone); done.push(["phone", c.phone, old.phone]); }
          if (eff.hasOwnProperty("name")) { p4t_setCell_(S.sheet, row, c.display_name, newName); done.push(["name", c.display_name, old.name]); }
          if (eff.hasOwnProperty("parent_phone")) {
            if (!c.parent_phone) throw new Error("The Students sheet has no parent_phone column.");
            p4t_setCell_(S.sheet, row, c.parent_phone, newParent); done.push(["parent", c.parent_phone, old.parent]);
          }
        } catch (e) {
          done.forEach(function (d) { try { S.sheet.getRange(row, d[1]).setValue(d[2]); } catch (e2) { /* best effort */ } });
          throw e;
        }
      };
      if (eff.hasOwnProperty("phone")) p4t_cascade_(curPhone, newPhone, writeStudents); else writeStudents([]);

      var ts = p4t_now_();
      ["name", "phone", "parent_phone"].forEach(function (f) {
        if (!eff.hasOwnProperty(f)) return;
        logRows.push({ ts: ts, actor_kind: "teacher", actor_id: T.phone, student_old: curPhone, student_new: newPhone, field: f,
                       old_value: f === "name" ? curName : f === "phone" ? curPhone : curParent, new_value: eff[f] });
      });
      if (eff.hasOwnProperty("phone")) pingText = "Teacher " + T.name + " changed a student's phone.\nStudent: " + newName + "\nOld: " + curPhone + "\nNew: " + newPhone;
      return { ok: true, student: student(newName, newPhone, newParent) };
    }, P4T_LOCK_MS);
  } catch (e) {
    Logger.log("p4_teacher_update_student refused: " + (e && e.message));
    return p4t_generic_();
  }
  if (result && result.ok && logRows.length) {
    try {
      var logSheet = _followupSheet(_ss(), "StudentEditLog", P4T_EDITLOG_HEADERS);
      _ensureColumns(logSheet, P4T_EDITLOG_HEADERS);
      logRows.forEach(function (r) { p4t_appendText_(logSheet, P4T_EDITLOG_HEADERS, r); });
    } catch (e3) { Logger.log("StudentEditLog write failed: " + (e3 && e3.message)); }
    if (pingText) { try { if (typeof p4_ownerPing_ === "function") p4_ownerPing_(pingText); } catch (e4) { /* best effort */ } }
  }
  return result;
}

// ---------------------------------------------------------------- self test (pure: no sheet access)

function p4_selfTest_team() {
  var bad = [];
  var eq = function (n, a, b) { if (a !== b) bad.push(n + ": got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };
  eq("sha256(abc)", p4t_hash_("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  eq("scope math", p4t_scope_("Math"), "math");
  eq("scope dedupe", p4t_scope_("math, math,english"), "math,english");
  eq("scope blank", p4t_scope_(""), "");
  eq("scope star refused", p4t_scope_("*"), null);
  eq("scope unknown refused", p4t_scope_("math,art"), null);
  eq("name trims and strips", p4t_cleanName_("  Sara\u0000 Ali \n"), "Sara Ali");
  eq("name too short", p4t_cleanName_("A"), "");
  eq("name too long", p4t_cleanName_(new Array(82).join("x")), "");
  eq("name not a string", p4t_cleanName_(12345), "");
  eq("name html kept as text", p4t_cleanName_("<b>Ann</b>"), "<b>Ann</b>");
  eq("phone ok", p4t_cleanPhone_("+20 101 234 5678"), "01012345678");
  eq("phone lost zero", p4t_cleanPhone_("1012345678"), "01012345678");
  eq("phone landline refused", p4t_cleanPhone_("034567890"), "");
  eq("phone short refused", p4t_cleanPhone_("0101234"), "");
  eq("phone object refused", p4t_cleanPhone_({}), "");
  eq("stores listed", P4T_PHONE_STORES.length, 11);
  var out = bad.length ? "FAIL: " + bad.join(" | ") : "ALL PASS";
  Logger.log("p4_selfTest_team: " + out);
  return out;
}
