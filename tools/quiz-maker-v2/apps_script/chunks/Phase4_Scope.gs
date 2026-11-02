// Phase4_Scope.gs  (P4 / S2: authorization core)
//
// Paste into the same Apps Script project as Code.gs (File > New > Script). Does NOT edit Code.gs;
// scripts/p4_wire.py inserts the four hooks (H1 to H4) at assembly.
//
// What it does: works out WHO is calling (owner, teacher, scoped assistant, legacy assistant, student,
// anon), decides per action from the P4_ACTIONS table, and filters lesson-based lists. Deny by default,
// fail closed. Every refusal is exactly {ok:false, error:"Not authorized."}.
// Identity comes ONLY from payload.token, or payload.student_id + payload.session_token. Nothing else.
// Every function here starts with p4_ / p4f_ or is a P4_ global, so nothing can collide with Code.gs.
//
// Order of this file: 1 subjects, 2 token verification, 3 ctx, 4 ctxForPhone, 5 action table,
// 6 gate, 7 covers/filter/hooks, 8 attachment resolution, 9 lesson filters, 10 session scope + ping,
// 11 self test.

// ============================================================================
// 1. Subjects
// ============================================================================
var P4_SUBJECTS = ["programming", "english", "math"];

// Per-request globals (Apps Script starts every request with a fresh global scope; p4_gate resets them anyway).
var P4_CTX_ = null;
var P4_GATE_RAN_ = false;

function p4_deny_() { return { ok: false, error: "Not authorized." }; }

function p4_log_(msg) {
  try { if (typeof Logger !== "undefined" && Logger && Logger.log) Logger.log("[p4] " + msg); } catch (e) { /* never fails a request */ }
}

function p4_global_(name) {
  var g = (typeof globalThis !== "undefined") ? globalThis : this;
  return g[name];
}

// "math/sat/x", "math/sat/x#ch2", a grade scope, an old alias -> "math" | "programming" | "english" | "".
// Only strings count. Normalised like _lessonPath (lowercase, "\" -> "/", no leading slash); any ".." is refused.
function p4_subjectOf(keyOrScope) {
  if (typeof keyOrScope !== "string") return "";
  var s = keyOrScope.split("#")[0].trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!s || s.indexOf("..") !== -1) return "";
  try { if (typeof p2k_canon === "function") s = String(p2k_canon(s)).toLowerCase(); } catch (e) { /* keep s */ }
  var seg = s.split("/")[0];
  return P4_SUBJECTS.indexOf(seg) !== -1 ? seg : "";
}

// "Math, programming ,x" -> ["math","programming"]. "*" is NOT a teacher scope (only the owner has it).
function p4_parseScope_(s) {
  var out = [];
  String(s == null ? "" : s).split(",").forEach(function (p) {
    p = p.trim().toLowerCase();
    if (P4_SUBJECTS.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p);
  });
  return out;
}

// ============================================================================
// 2. Teacher token verification (minting, revoking, listing: S5)
// ============================================================================
// SHA-256 hex of a string. Apps Script digest bytes are signed: (b + 256) % 256.
function p4_hashToken_(raw) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(raw), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { b = (b + 256) % 256; return ("0" + b.toString(16)).slice(-2); }).join("");
}

// Constant-time string equality (no early exit).
function p4_safeEq_(a, b) {
  a = String(a); b = String(b);
  var n = Math.max(a.length, b.length), d = a.length ^ b.length;
  for (var i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// raw token -> {name, scope:[subjects], created} or null. Looks at EVERY stored hash (no early exit).
function p4_findTeacherToken_(raw) {
  if (typeof raw !== "string" || !raw) return null;
  var map;
  try { map = JSON.parse(_props().getProperty("P4_TEACHER_TOKENS") || "{}"); } catch (e) { return null; }
  if (!map || typeof map !== "object") return null;
  var h = p4_hashToken_(raw), hit = null;
  Object.keys(map).forEach(function (k) {
    if (p4_safeEq_(k, h) && !hit) {
      var e = map[k] || {}, scope = p4_parseScope_(e.scope);
      if (scope.length) hit = { name: String(e.name == null ? "" : e.name), scope: scope, created: String(e.created || "") };
    }
  });
  return hit;
}

// ============================================================================
// 3. Who is calling
// ============================================================================
function p4_anon_() { return { kind: "anon", via: "none", id: "", subjects: [], principal: "" }; }

function p4_readStudents_() {
  var values = _students().getDataRange().getValues();
  return { values: values, c: _studentCols(values[0]) };
}

function p4_cell_(S, i, name) {
  var col = S.c[name];
  return col ? S.values[i][col - 1] : "";
}

function p4_findRow_(S, phone) {
  var target = _normalizePhone(phone);
  if (!target) return -1;
  for (var i = 1; i < S.values.length; i++) {
    if (_phonesMatch(S.values[i][S.c.phone - 1], target)) return i;
  }
  return -1;
}

function p4_idOf_(S, i) {
  var cell = S.values[i][S.c.phone - 1];
  return _canonicalPhone(cell) || _normalizePhone(cell);
}

function p4_roleOf_(S, i) { return String(p4_cell_(S, i, "role") == null ? "" : p4_cell_(S, i, "role")).trim().toLowerCase(); }
function p4_scopeOf_(S, i) { return p4_parseScope_(p4_cell_(S, i, "teacher_scope")); }

// A teacher row: role "teacher" and a non-empty scope. Returns {i, id, scope} or null.
function p4_teacherRow_(S, phone) {
  var i = p4_findRow_(S, phone);
  if (i < 0) return null;
  if (p4_roleOf_(S, i) !== "teacher") return null;
  var scope = p4_scopeOf_(S, i);
  return scope.length ? { i: i, id: p4_idOf_(S, i), scope: scope } : null;
}

// Computes the caller's context (may throw; p4_ctx catches). Token beats session, like _requireAdminAny.
function p4_ctxCompute_(payload) {
  var hasToken = payload.token !== undefined && payload.token !== null && payload.token !== "";
  if (hasToken) {
    if (typeof payload.token !== "string") return p4_anon_();
    var expected = _props().getProperty("ADMIN_TOKEN");
    if (expected && p4_safeEq_(payload.token, expected)) return { kind: "owner", via: "token", id: "owner", subjects: ["*"], principal: "" };
    var t = p4_findTeacherToken_(payload.token);
    if (!t) return p4_anon_();
    var principal = t.name;
    try {
      var S0 = p4_readStudents_(), want = t.name.trim().toLowerCase();
      for (var j = 1; j < S0.values.length; j++) {
        if (String(p4_cell_(S0, j, "display_name")).trim().toLowerCase() === want && p4_roleOf_(S0, j) === "teacher" && p4_scopeOf_(S0, j).length) {
          principal = p4_idOf_(S0, j); break;
        }
      }
    } catch (e) { /* no matching row: the name stands in */ }
    return { kind: "teacher", via: "token", id: t.name, subjects: t.scope.slice(), principal: principal };
  }

  if (!payload.student_id || !payload.session_token) return p4_anon_();
  var S = p4_readStudents_();
  var i = p4_findRow_(S, payload.student_id);
  if (i < 0) return p4_anon_();
  var stored = String(p4_cell_(S, i, "session_token"));
  if (!stored || stored !== String(payload.session_token)) return p4_anon_();
  var id = p4_idOf_(S, i);
  if (S.c.is_admin && _isTruthyFlag(p4_cell_(S, i, "is_admin"))) return { kind: "owner", via: "session", id: id, subjects: ["*"], principal: "" };

  var role = p4_roleOf_(S, i);
  if (role === "teacher") {
    var scope = p4_scopeOf_(S, i);
    if (scope.length) return { kind: "teacher", via: "session", id: id, subjects: scope, principal: id };
  } else if (role === "assistant") {
    var of = String(p4_cell_(S, i, "assistant_of") == null ? "" : p4_cell_(S, i, "assistant_of")).trim();
    if (!of) return { kind: "assistant", via: "session", id: id, subjects: [], principal: "" };       // legacy owner assistant
    var tr = p4_teacherRow_(S, of);
    if (tr) return { kind: "assistant", via: "session", id: id, subjects: tr.scope.slice(), principal: tr.id };   // scoped
  }
  return { kind: "student", via: "session", id: id, subjects: [], principal: "" };
}

function p4_ctx(payload) {
  var ctx;
  try { ctx = p4_ctxCompute_(payload || {}); } catch (e) { ctx = p4_anon_(); }
  P4_CTX_ = ctx;
  return ctx;
}

// ============================================================================
// 4. Telegram identity
// ============================================================================
// Fresh read of that Students row. A teacher ctx (via "telegram") only for role teacher + non-empty scope, else null.
function p4_ctxForPhone(phone) {
  try {
    var S = p4_readStudents_();
    var tr = p4_teacherRow_(S, phone);
    if (!tr) return null;
    return { kind: "teacher", via: "telegram", id: tr.id, subjects: tr.scope.slice(), principal: tr.id };
  } catch (e) { return null; }
}

// ============================================================================
// 5. The action table (contract section 5)
// ============================================================================
// Row: {rule, needs, link, tok, ses, filter, L, Lsoft, St, G, opt, any, res, payIf}
//   rule   PUB pass-through | O owner only | T teacher only | LW LF SP GP GC PAY SF LINK ALLOW (teacher or scoped assistant, via needs)
//   needs  checks that must all hold: LW lesson in scope, SP student owned, GP group owned, GC group own/free, PAY payment in scope
//   L / St / G  payload fields the checks read ("items[].phone" = field of every list item)
//   Lsoft  extra lesson fields, checked only when they name a known subject (a bare slug is accepted)
//   opt    needs whose fields may be absent (then skipped); any: at least one of the optional needs must have a value
//   res    "attachment" | "written": the file or the stored answer decides lesson (and student), not the request
//   payIf  when payload.payment_id is present the handler ignores the other fields, so only PAY is checked
//   link   a student by phone is being added to the teacher's scope (that student need not be owned yet)
//   tok / ses  allowed callers: desktop token, dashboard session
var P4_ACTIONS = (function () {
  var t = {};
  function add(names, row) {
    String(names).split(/\s+/).forEach(function (n) {
      if (!n) return;
      var r = {};
      Object.keys(row).forEach(function (k) { r[k] = row[k]; });
      t[n] = r;
    });
  }
  // Attachments (desktop token only)
  add("upload_attachment", { rule: "LW", needs: ["LW"], L: ["subject"], Lsoft: ["lesson"], tok: true });
  add("delete_attachment", { rule: "LW", needs: ["LW"], res: "attachment", tok: true });
  // Videos
  add("admin_set_video", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true, ses: true });
  add("admin_list_videos", { rule: "LF", needs: [], tok: true, ses: true, filter: "p4f_admin_list_videos" });
  // Quiz content and written models
  add("admin_set_quiz_content admin_get_quiz_content admin_set_written_models", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true });
  add("admin_get_written_models", { rule: "LW", needs: ["LW"], L: ["lesson"], tok: true, ses: true });
  // Locks and tags (dashboard)
  add("admin_set_lesson_lock admin_set_quiz_lock admin_set_lesson_tags", { rule: "LW", needs: ["LW"], L: ["lesson"], ses: true });
  add("admin_list_lesson_tags", { rule: "LF", needs: [], ses: true, filter: "p4f_admin_list_lesson_tags" });
  add("admin_list_lessons", { rule: "LF", needs: [], ses: true, filter: "p4f_admin_list_lessons" });
  add("admin_set_requirement", { rule: "LW", needs: ["LW", "GP"], L: ["lesson"], G: ["group"], opt: ["GP"], ses: true });
  // Access grants. The student being added need not be owned yet (LINK); the response is cut to {ok, registered} by S3.
  add("admin_grant_access", { rule: "LW", needs: ["LW"], L: ["scope"], link: true, ses: true, filter: "p4f_admin_grant_access" });
  add("admin_grant_quiz_access", { rule: "LW", needs: ["LW"], L: ["lesson"], link: true, ses: true, filter: "p4f_admin_grant_quiz_access" });
  add("admin_revoke_access", { rule: "LW", needs: ["LW", "SP"], L: ["scope"], St: ["phone"], payIf: true, ses: true });
  add("admin_revoke_quiz_access", { rule: "LW", needs: ["LW", "SP"], L: ["lesson"], St: ["phone"], ses: true });
  // Groups
  add("admin_group_add", { rule: "GC", needs: ["GC"], G: ["group"], link: true, ses: true, filter: "p4f_admin_group_add" });
  add("admin_group_remove", { rule: "GP", needs: ["GP"], G: ["group"], ses: true });
  add("admin_group_grant_access admin_group_revoke_access", { rule: "LW", needs: ["LW", "GP"], L: ["scope"], G: ["group"], ses: true });
  add("admin_group_grant_quiz_access admin_group_revoke_quiz_access", { rule: "LW", needs: ["LW", "GP"], L: ["lesson"], G: ["group"], ses: true });
  // Lists filtered by student ownership (S3)
  add("admin_list_groups", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_groups" });
  add("admin_get_all", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_get_all" });
  add("admin_access_overview", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_access_overview" });
  add("admin_list_payments", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_payments" });
  add("admin_followup_overview", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_followup_overview" });
  add("admin_list_parent_notifications", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_list_parent_notifications" });
  add("admin_grading_queue", { rule: "SF", needs: [], ses: true, filter: "p4f_admin_grading_queue" });
  // Payments
  add("admin_decide_payment", { rule: "PAY", needs: ["PAY"], ses: true });
  // Follow-up
  add("admin_followup_set_attendance", { rule: "SP", needs: ["SP", "GP"], St: ["items[].phone"], G: ["group"], opt: ["GP"], ses: true });
  add("admin_followup_save_group", { rule: "GP", needs: ["GP"], G: ["group"], ses: true });
  add("admin_followup_save_templates", { rule: "ALLOW", needs: [], ses: true });
  add("admin_student_summary", { rule: "SP", needs: ["SP"], St: ["student"], ses: true, filter: "p4f_admin_student_summary" });
  add("admin_monthly_review", { rule: "SP", needs: ["SP", "GP"], St: ["student"], G: ["group"], opt: ["SP", "GP"], any: true, ses: true, filter: "p4f_admin_monthly_review" });
  add("admin_log_parent_notification", { rule: "SP", needs: ["SP"], St: ["student"], ses: true });
  // Written answers: the stored answer decides the student and the lesson
  add("admin_grade_written get_written_image", { rule: "SP", needs: ["SP", "LW"], res: "written", ses: true });
  // Owner only
  add("admin_migrate_lesson_keys p3_admin_set_role p3_admin_backfill_submission", { rule: "O", needs: [] });
  add("p3_admin_bulk_preview p3_admin_bulk_grant p3_admin_bulk_revoke", { rule: "O", needs: [] });
  // Not in the contract table, but in the router and under the p3_admin_ prefix: owner only (see handoff).
  add("p3_admin_list_staff p3_admin_diagnose_submissions p3_admin_restore_submissions p3_admin_flag_status", { rule: "O", needs: [] });
  add("p4_admin_set_teacher p4_admin_list_teachers p4_admin_set_group_owner p4_admin_tg_unlink p4_admin_list_edit_log p4_admin_teacher_stats", { rule: "O", needs: [] });
  // New teacher-side actions
  add("p4_teacher_update_student", { rule: "T", needs: ["SP"], St: ["student"], ses: true });
  add("p4_teacher_set_assistant p4_teacher_list_assistants p4_teacher_revoke_assistant", { rule: "T", needs: [], ses: true });
  add("p4_tg_link_start p4_tg_status p4_tg_unlink", { rule: "T", needs: [], ses: true });
  // Public (student or open) actions, listed explicitly
  add("ping", { rule: "PUB", needs: [], tok: true });
  add("p4_session_scope", { rule: "PUB", needs: [] });
  add("check_student register_student login_student reset_password update_profile get_my_results get_video get_quiz get_quiz_review get_quiz_state " +
      "get_subscription_options record_watch request_access request_subscription upload_submission upload_quiz_result upload_written_image p3_session_role",
      { rule: "PUB", needs: [] });
  return t;
})();

// A16: a scoped assistant is never allowed these, plus every p4_ action.
var P4_ASSISTANT_DENY = ["admin_decide_payment", "admin_list_payments", "admin_followup_save_templates"].concat(
  Object.keys(P4_ACTIONS).filter(function (a) { return a.indexOf("p4_") === 0; }));

function p4_rowFor_(action) {
  action = String(action == null ? "" : action);
  return Object.prototype.hasOwnProperty.call(P4_ACTIONS, action) ? P4_ACTIONS[action] : null;
}

function p4_adminish_(action) {
  return /^(admin_|p3_admin_|p4_admin_)/.test(action) || action === "upload_attachment" || action === "delete_attachment";
}

function p4_isScoped_(ctx) {
  return !!ctx && (ctx.kind === "teacher" || (ctx.kind === "assistant" && !!ctx.principal));
}

// ============================================================================
// 6. The gate
// ============================================================================
// Reads a payload value as text. Only strings and finite numbers are usable; anything else is null (= deny).
function p4_str_(v) {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && isFinite(v)) return String(v);
  return null;
}

// Collects the values behind field specs. {vals:[text], bad:bool}. A scalar field that is absent or blank adds nothing;
// "list[].field": every item must be an object carrying the field (otherwise bad).
function p4_gather_(payload, specs) {
  var out = { vals: [], bad: false };
  (specs || []).forEach(function (spec) {
    var at = spec.indexOf("[].");
    if (at === -1) {
      var v = payload[spec];
      if (v === undefined || v === null || v === "") return;
      var s = p4_str_(v);
      if (s === null) { out.bad = true; return; }
      if (s !== "") out.vals.push(s);
      return;
    }
    var listName = spec.slice(0, at), field = spec.slice(at + 3), list = payload[listName];
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) { out.bad = true; return; }
    list.forEach(function (it) {
      var s2 = (it && typeof it === "object") ? p4_str_(it[field]) : null;
      if (s2 === null || s2 === "") out.bad = true; else out.vals.push(s2);
    });
  });
  return out;
}

// The stored written answer behind {submission_id, question_id}: {students:[phone], lessons:[lesson]} or null.
function p4_resolveWritten_(payload, matchStudent) {
  var sid = String(payload.submission_id == null ? "" : payload.submission_id).trim();
  var qid = String(payload.question_id == null ? "" : payload.question_id).trim();
  if (!sid || !qid) return null;
  var sh = _dataSs().getSheetByName("WrittenAnswers");
  if (!sh || sh.getLastRow() < 2) return null;
  var hit = null;
  _sheetValuesAsObjects(sh).forEach(function (r) {
    if (hit) return;
    if (String(r.submission_id).trim() !== sid || String(r.question_id).trim() !== qid) return;
    if (matchStudent && payload.student && !_phonesMatch(r.student_id, payload.student)) return;
    hit = r;
  });
  if (!hit || !String(hit.student_id == null ? "" : hit.student_id).trim() || !String(hit.lesson == null ? "" : hit.lesson).trim()) return null;
  return { students: [String(hit.student_id).trim()], lessons: [String(hit.lesson).trim()] };
}

// One need against the caller. Returns true, false, or "skip" (optional and absent).
function p4_needHolds_(need, ctx, payload, row, res) {
  if (need === "PAY") {
    var pay = p4_global_("p4_paymentInScope");
    return typeof pay === "function" ? !!pay(ctx, payload) : false;
  }
  var specs = need === "LW" ? row.L : need === "SP" ? row.St : (need === "GP" || need === "GC") ? row.G : null;
  if (!specs && !res) return false;
  var g = p4_gather_(payload, specs);
  if (res) {
    var extra = need === "LW" ? res.lessons : need === "SP" ? res.students : null;
    (extra || []).forEach(function (x) { g.vals.push(x); });
  }
  if (g.bad) return false;
  var optional = (row.opt || []).indexOf(need) !== -1;
  if (!g.vals.length) return optional ? "skip" : false;

  var fn;
  for (var i = 0; i < g.vals.length; i++) {
    var v = g.vals[i];
    if (need === "LW") {
      if (!p4_teacherCovers(ctx, v)) return false;
    } else if (need === "SP") {
      fn = p4_global_("p4_ownsStudent");
      if (typeof fn !== "function" || !fn(ctx, v)) return false;
    } else if (need === "GP") {
      fn = p4_global_("p4_ownsGroup");
      if (typeof fn !== "function" || !fn(ctx, v)) return false;
    } else if (need === "GC") {
      fn = p4_global_("p4_groupState");
      if (typeof fn !== "function") return false;
      var st = fn(ctx, v);
      if (st !== "own" && st !== "free") return false;
    } else {
      return false;
    }
  }
  if (need === "LW" && row.Lsoft) {
    var soft = p4_gather_(payload, row.Lsoft);
    if (soft.bad) return false;
    for (var k = 0; k < soft.vals.length; k++) {
      var sj = p4_subjectOf(soft.vals[k]);
      if (sj && !p4_teacherCovers(ctx, soft.vals[k])) return false;
    }
  }
  return true;
}

// The decision for an already-resolved ctx. {} = continue, {deny} = refuse. Throws are caught by p4_gate.
function p4_decide_(ctx, payload) {
  var action = String(payload.action == null ? "" : payload.action);
  var row = p4_rowFor_(action);
  if (!row && !p4_adminish_(action)) return {};            // unknown, not admin-ish: the router decides
  if (row && row.rule === "PUB") return {};
  if (ctx.kind === "owner") return {};
  if (!p4_isScoped_(ctx)) return {};                        // legacy assistants, students, anon: existing checks, unchanged
  var DENY = { deny: p4_deny_() };
  if (!row) return DENY;                                    // admin-ish and not in the table
  if (row.rule === "O") return DENY;
  if (row.rule === "T" && ctx.kind !== "teacher") return DENY;
  if (ctx.kind === "assistant") {
    var allow = p4_global_("P3_STAFF_ALLOW");
    if (!Array.isArray(allow) || allow.indexOf(action) === -1) return DENY;
    if (P4_ASSISTANT_DENY.indexOf(action) !== -1) return DENY;
  }
  if (ctx.via === "token" && !row.tok) return DENY;
  if (ctx.via === "session" && !row.ses) return DENY;
  if (ctx.via !== "token" && ctx.via !== "session") return DENY;

  var needs = row.needs || [];
  if (row.payIf && String(payload.payment_id == null ? "" : payload.payment_id).trim()) needs = ["PAY"];
  var res = null;
  if (row.res === "attachment") res = p4_resolveAttachment_(payload);
  else if (row.res === "written") res = p4_resolveWritten_(payload, action === "admin_grade_written");
  if (row.res && !res) return DENY;

  var sawValue = false;
  for (var i = 0; i < needs.length; i++) {
    if (row.link && needs[i] === "SP") continue;            // the student being added need not be owned yet
    var ok = p4_needHolds_(needs[i], ctx, payload, row, res);
    if (ok === false) return DENY;
    if (ok === true) sawValue = true;
  }
  if (row.any && !sawValue) return DENY;
  return {};
}

function p4_gate(payload) {
  P4_GATE_RAN_ = false;
  P4_CTX_ = null;
  payload = payload || {};
  var ctx = p4_ctx(payload), out;
  try {
    out = p4_decide_(ctx, payload);
  } catch (e) {
    p4_log_("gate error on " + payload.action + ": " + (e && e.message));
    out = p4_isScoped_(ctx) || ctx.kind === "owner" ? { deny: p4_deny_() } : {};   // anyone else has no extra rights to protect
    if (out.deny) return out;
  }
  P4_GATE_RAN_ = !out.deny;
  return out;
}

// ============================================================================
// 7. Coverage, response filters and the two hooks
// ============================================================================
function p4_teacherCovers(ctx, keyOrSubject) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_isScoped_(ctx)) return false;
  var s = p4_subjectOf(keyOrSubject);
  return !!s && (ctx.subjects || []).indexOf(s) !== -1;
}

// Called by the router for every action with a filter (H4). Teachers and scoped assistants only; a missing filter fails closed.
function p4_filter(resp, payload) {
  var ctx = (P4_GATE_RAN_ && P4_CTX_) ? P4_CTX_ : p4_ctx(payload);
  if (!p4_isScoped_(ctx)) return resp;
  if (!resp || typeof resp !== "object" || resp.ok === false) return resp;
  var row = p4_rowFor_(payload && payload.action);
  if (!row || !row.filter) return resp;
  var fn = p4_global_(row.filter);
  if (typeof fn !== "function") { p4_log_("missing filter " + row.filter); return p4_deny_(); }
  try { return fn(resp, ctx, payload); } catch (e) { p4_log_("filter error " + row.filter + ": " + (e && e.message)); return p4_deny_(); }
}

// H1: a valid teacher token on an action whose row allows tokens. Never before the gate ran in this request.
function p4_tokenAllows(payload) {
  if (!P4_GATE_RAN_ || !P4_CTX_ || !payload) return false;
  if (P4_CTX_.kind !== "teacher" || P4_CTX_.via !== "token") return false;
  var t = p4_findTeacherToken_(payload.token);
  if (!t || t.name !== P4_CTX_.id) return false;
  var row = p4_rowFor_(payload.action);
  return !!row && !!row.tok && row.rule !== "O" && row.rule !== "T";
}

// H2: `row` is the caller's Students row (already matched on phone and session token), `c` the column map.
function p4_teacherAllows(row, c, payload) {
  if (!P4_GATE_RAN_ || !P4_CTX_ || !payload || !row || !c) return false;
  var ctx = P4_CTX_;
  if (ctx.kind !== "teacher" || ctx.via !== "session") return false;
  if (!_phonesMatch(row[c.phone - 1], ctx.id)) return false;
  if (String(row[c.session_token - 1]) !== String(payload.session_token)) return false;
  if (!c.role || String(row[c.role - 1] == null ? "" : row[c.role - 1]).trim().toLowerCase() !== "teacher") return false;
  var r = p4_rowFor_(payload.action);
  return !!r && !!r.ses && r.rule !== "O";
}

// ============================================================================
// 8. delete_attachment: resolve the file to its subject
// ============================================================================
// Files are stored as <subject>--<lesson>--<id>--<name> inside ATTACHMENTS_FOLDER_ID. The file must really sit in that folder,
// and its name must start with a subject slug. Anything else cannot be resolved.
function p4_resolveAttachment_(payload) {
  var id = payload.file_id;
  if (typeof id !== "string" || !id.trim()) return null;
  try {
    var folderId = _props().getProperty("ATTACHMENTS_FOLDER_ID");
    if (!folderId) return null;
    var f = DriveApp.getFileById(id.trim()), inFolder = false, parents = f.getParents();
    while (parents.hasNext()) { if (parents.next().getId() === folderId) inFolder = true; }
    if (!inFolder) return null;
    var parts = String(f.getName()).split("--");
    if (parts.length < 4 || !p4_subjectOf(parts[0])) return null;
    var lessons = [parts[0]];
    var lead = parts[1].split("-")[0];
    if (p4_subjectOf(lead)) lessons.push(lead);              // the lesson part names a subject too: it must be covered as well
    return { lessons: lessons, students: [] };
  } catch (e) { return null; }
}

// ============================================================================
// 9. Lesson filters (teachers and scoped assistants keep only rows of their subjects; unrecognised rows are dropped)
// ============================================================================
function p4_keepLessonRow_(ctx, it) {
  if (typeof it === "string") return p4_teacherCovers(ctx, it);
  if (!it || typeof it !== "object") return false;
  var keys = ["lesson", "lesson_key", "scope", "track"];
  for (var i = 0; i < keys.length; i++) {
    if (typeof it[keys[i]] === "string") return p4_teacherCovers(ctx, it[keys[i]]);
  }
  return false;
}

function p4_filterLessonLists_(resp, ctx) {
  var out = {};
  Object.keys(resp).forEach(function (k) {
    var v = resp[k];
    if (Array.isArray(v)) {
      var kept = v.filter(function (it) { return p4_keepLessonRow_(ctx, it); });
      if (kept.length !== v.length) p4_log_("filter dropped " + (v.length - kept.length) + " of " + v.length + " in " + k);
      out[k] = kept;
    } else out[k] = v;
  });
  return out;
}

function p4f_admin_list_videos(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }
function p4f_admin_list_lessons(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }
function p4f_admin_list_lesson_tags(resp, ctx, payload) { return p4_filterLessonLists_(resp, ctx); }

// ============================================================================
// 10. Session scope and ping
// ============================================================================
// Router action p4_session_scope: the dashboard asks "what am I?". Never throws, never reveals more than the caller's own role.
function p4_session_scope(payload) {
  var ctx = p4_ctx(payload);
  var role = ctx.kind === "owner" ? "admin" : ctx.kind === "anon" ? "none" : ctx.kind;
  var out = { ok: true, role: role, kind: ctx.kind, scope: ctx.kind === "owner" ? ["*"] : (ctx.subjects || []).slice() };
  if (ctx.kind === "assistant" && ctx.principal) {
    try {
      var S = p4_readStudents_(), i = p4_findRow_(S, ctx.principal);
      out.principal_name = i < 0 ? "" : String(p4_cell_(S, i, "display_name") == null ? "" : p4_cell_(S, i, "display_name"));
    } catch (e) { out.principal_name = ""; }
  }
  return out;
}

// Decorates the token ping with who the token belongs to. Signature fits _p2Post(name, resp, payload).
function p4_pingDecorate(resp, payload) {
  try {
    if (!resp || typeof resp !== "object") return resp;
    var ctx = p4_ctx(payload);                               // ping carries only a token: no sheet read unless a teacher name is looked up
    resp.kind = ctx.kind;
    resp.subjects = (ctx.subjects || []).slice();
    resp.name = ctx.kind === "teacher" ? ctx.id : (ctx.kind === "owner" ? "owner" : "");
  } catch (e) { /* the ping itself still works */ }
  return resp;
}

// ============================================================================
// 11. Self test (editor only): Run > p4_selfTest, then read the log. Pure checks, then the other P4 files' own tests.
// ============================================================================
function p4_selfTest() {
  var fails = [], n = 0;
  function t(name, cond) { n++; if (!cond) fails.push(name); }
  function owner() { return { kind: "owner", via: "session", id: "o", subjects: ["*"], principal: "" }; }
  function teacher(via) { return { kind: "teacher", via: via || "session", id: "t", subjects: ["math"], principal: "t" }; }
  function assistant() { return { kind: "assistant", via: "session", id: "a", subjects: ["math"], principal: "t" }; }
  function legacy() { return { kind: "assistant", via: "session", id: "l", subjects: [], principal: "" }; }
  function denied(ctx, payload) { var r = p4_decide_(ctx, payload); return !!(r && r.deny && r.deny.ok === false && r.deny.error === "Not authorized."); }

  t("subjectOf math key", p4_subjectOf("math/sat/lesson-1") === "math");
  t("subjectOf scope #ch2", p4_subjectOf("programming/baccalaureate/grade-2-secondary#ch2") === "programming");
  t("subjectOf junk", p4_subjectOf("") === "" && p4_subjectOf(null) === "" && p4_subjectOf(["math"]) === "" && p4_subjectOf("art/x") === "" && p4_subjectOf("math/../programming/x") === "");
  t("subjectOf backslash and leading slash", p4_subjectOf("/Math\\sat") === "math");
  t("parseScope", JSON.stringify(p4_parseScope_(" Math, programming,x,*,math")) === JSON.stringify(["math", "programming"]));
  t("sha256 abc", p4_hashToken_("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  t("safeEq", p4_safeEq_("abc", "abc") && !p4_safeEq_("abc", "abd") && !p4_safeEq_("abc", "abcd"));
  Object.keys(P4_ACTIONS).forEach(function (a) {
    var r = P4_ACTIONS[a];
    t("row valid " + a, ["PUB", "O", "T", "ALLOW", "LW", "LF", "SP", "GP", "GC", "PAY", "SF"].indexOf(r.rule) !== -1 && Array.isArray(r.needs));
    if (r.rule === "O") t("O row has no via " + a, !r.tok && !r.ses);
  });
  t("assistant deny list has p4_ rows", P4_ASSISTANT_DENY.indexOf("p4_tg_status") !== -1 && P4_ASSISTANT_DENY.indexOf("admin_decide_payment") !== -1);
  t("owner passes O", !denied(owner(), { action: "p3_admin_set_role" }));
  t("teacher denied O", denied(teacher(), { action: "p3_admin_set_role" }));
  t("assistant denied T", denied(assistant(), { action: "p4_tg_status" }));
  t("PUB passes teacher", !denied(teacher(), { action: "check_student" }));
  t("unknown admin_x denied for teacher", denied(teacher(), { action: "admin_nope" }));
  t("unknown plain action passes", !denied(teacher(), { action: "something_new" }));
  t("student and legacy assistant fall through", !denied({ kind: "student", via: "session", id: "s", subjects: [], principal: "" }, { action: "admin_get_all" }) && !denied(legacy(), { action: "admin_get_all" }));
  t("token on a session-only row denied", denied(teacher("token"), { action: "admin_set_lesson_lock", lesson: "math/x" }));
  t("session on a token-only row denied", denied(teacher("session"), { action: "upload_attachment", subject: "math", lesson: "x" }));
  t("covered lesson passes", !denied(teacher(), { action: "admin_set_lesson_lock", lesson: "math/sat/x" }));
  t("foreign lesson denied", denied(teacher(), { action: "admin_set_lesson_lock", lesson: "programming/x/y" }));
  t("missing lesson denied", denied(teacher(), { action: "admin_set_lesson_lock" }));
  t("array lesson denied", denied(teacher(), { action: "admin_set_lesson_lock", lesson: ["math/x"] }));
  t("covers: owner/teacher/legacy", p4_teacherCovers(owner(), "programming/x") && p4_teacherCovers(teacher(), "math/x") && !p4_teacherCovers(teacher(), "english/x") && !p4_teacherCovers(legacy(), "math/x"));
  P4_GATE_RAN_ = false;
  t("fail closed without gate", p4_tokenAllows({ token: "x", action: "ping" }) === false && p4_teacherAllows([], {}, { action: "admin_set_video" }) === false);

  var msg = fails.length ? "FAIL (" + fails.length + " of " + n + "): " + fails.join("; ") : "ALL PASS (" + n + " checks)";
  p4_log_(msg);
  var ok = !fails.length;
  ["p4_selfTest_people", "p4_selfTest_team", "p4_selfTest_tg"].forEach(function (name) {
    var f = p4_global_(name);
    if (typeof f !== "function") return;
    var r;
    try { r = f(); } catch (e) { r = "FAIL: threw " + (e && e.message); }
    var good = r === true || (typeof r === "string" && r.indexOf("ALL PASS") !== -1);
    p4_log_(name + ": " + (good ? "ALL PASS" : String(r)));
    if (!good) { ok = false; msg += " | " + name + " failed"; }
  });
  p4_log_(ok ? "ALL PASS" : "NOT ALL PASS: " + msg);
  return ok ? "ALL PASS" : msg;
}
