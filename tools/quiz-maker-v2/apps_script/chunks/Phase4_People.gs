// =====================================================================================
// Phase 4 / S3 - people and money: student ownership, response filters, group ownership,
// payment scope, per-owner follow-up templates, add-by-phone rules.
//
// Contract: Docs/02-plans/math-teacher-sessions/00-MASTER-CONTRACT.md (v2), sections 2, 4, 5, 6.
// Paste into Apps Script as its own file, or let scripts/p4_wire.py --merge append it to Code.gs.
// Depends on Phase4_Scope.gs only through: p4_subjectOf(keyOrScope), and (optionally) p4_ctx(payload).
// Every p4f_* filter is a no-op unless the caller is a teacher or a SCOPED assistant, so the owner
// and the owner's own (unscoped) assistants see exactly what they saw before.
// Refusal text is always: {ok:false, error:"Not authorized."}.
// =====================================================================================

var P4_LOOKUPS_PER_HOUR = 30;                                   // contract A4 / A17 (one bucket per principal)
var P4_GROUPOWNER_HEADERS = ["group", "owner_id", "created_at"];
var P4_PC_ = { key: "", set: null, owners: null };               // per-request cache, keyed by principal + subjects (an assistant shares his teacher's)
var P4_GSTATE_ = {};                                             // "<principalKey>|<groupKey>" -> own|free|foreign (state at gate time)

function p4_resetCache_() { P4_PC_ = { key: "", set: null, owners: null }; P4_GSTATE_ = {}; }

// ---- small helpers --------------------------------------------------------------------

// Canonical comparison key for an id: a phone becomes its last 10 digits, anything else is lower-cased text.
function p4_idKey_(id) {
  var s = String(id == null ? "" : id).trim();
  var d = _normalizePhone(s);
  return d.length >= 10 ? d.slice(-10) : s.toLowerCase();
}

// A teacher, or an assistant who works for a teacher. Owner and the owner's own assistants are NOT scoped.
function p4_scoped_(ctx) {
  return !!ctx && (ctx.kind === "teacher" || (ctx.kind === "assistant" && !!ctx.principal));
}

function p4_principalKey_(ctx) { return p4_idKey_(ctx.principal || ctx.id); }

// Is this lesson key / scope inside the caller's subjects? Unknown subject never matches.
function p4_inSubjects_(ctx, v) {
  var subs = ctx && ctx.subjects ? ctx.subjects : [];
  if (subs.indexOf("*") >= 0) return true;
  var s = p4_subjectOf(String(v == null ? "" : v));
  return !!s && subs.indexOf(s) >= 0;
}

function p4_rows_(ss, name) {
  var sh = ss.getSheetByName(name);
  return sh && sh.getLastRow() >= 2 ? _sheetValuesAsObjects(sh) : [];
}

function p4_cacheKey_(ctx) {
  return ctx.kind === "owner" ? "owner" : p4_principalKey_(ctx) + "|" + (ctx.subjects || []).join(",");
}

// One Apps Script execution serves one request, so this lives exactly one request. Tests call p4_resetCache_().
function p4_cache_(ctx) {
  var k = p4_cacheKey_(ctx);
  if (P4_PC_.key !== k) P4_PC_ = { key: k, set: null, owners: null };
  return P4_PC_;
}

// The ctx for the request being served. Prefers the one the gate stored; falls back to p4_ctx(payload).
function p4_ctxFor_(payload) {
  try {
    if (typeof P4_GATE_RAN_ !== "undefined" && P4_GATE_RAN_ && typeof P4_CTX_ !== "undefined" && P4_CTX_) return P4_CTX_;
    return typeof p4_ctx === "function" ? p4_ctx(payload) : null;
  } catch (e) { return null; }
}

// ---- group ownership --------------------------------------------------------------------

// groupKey -> owner id key, from the GroupOwners tab. No tab / no row: the group belongs to the owner.
function p4_ownersMap_(ctx) {
  var c = p4_cache_(ctx);
  if (c.owners) return c.owners;
  var m = {};
  p4_rows_(_ss(), "GroupOwners").forEach(function (r) {
    var k = _groupKey(r.group);
    if (k && !m.hasOwnProperty(k)) m[k] = p4_idKey_(r.owner_id);
  });
  c.owners = m;
  return m;
}

function p4_ownsGroup(ctx, groupName) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var key = _groupKey(groupName);
  if (!key) return false;
  var owners = p4_ownersMap_(ctx);
  return owners.hasOwnProperty(key) && owners[key] === p4_principalKey_(ctx);
}

// own: the caller owns it. free: nobody owns it and it has no members (so it will be created for the caller).
// foreign: anything else. The answer given at gate time is remembered so the response filter can create the owner row.
function p4_groupState(ctx, groupName) {
  if (!ctx) return "foreign";
  if (ctx.kind === "owner") return "own";
  if (!p4_scoped_(ctx)) return "foreign";
  var key = _groupKey(groupName);
  if (!key) return "foreign";
  var owners = p4_ownersMap_(ctx), me = p4_principalKey_(ctx), st;
  if (owners.hasOwnProperty(key)) {
    st = owners[key] === me ? "own" : "foreign";
  } else {
    var has = false;
    p4_rows_(_ss(), "Groups").forEach(function (r) { if (!has && _groupKey(r.group) === key) has = true; });
    st = has ? "foreign" : "free";
  }
  P4_GSTATE_[me + "|" + key] = st;
  return st;
}

// ---- student linkage ("his students") ------------------------------------------------------

function p4_mark_(set, phone) { var k = _phoneKey(phone); if (k) set[k] = true; }

// phoneKey -> true for every student linked to this caller (contract section 2, four rules).
function p4_linkedSet_(ctx) {
  var c = p4_cache_(ctx);
  if (c.set) return c.set;
  var set = {};
  if (ctx.kind === "owner") {
    _sheetValuesAsObjects(_students()).forEach(function (r) { p4_mark_(set, r.phone); });
  } else if (p4_scoped_(ctx)) {
    var ss = _ss(), ds = _dataSs();
    var me = p4_principalKey_(ctx), owners = p4_ownersMap_(ctx), mine = {};
    Object.keys(owners).forEach(function (k) { if (owners[k] === me) mine[k] = true; });
    // 1. member of a group the teacher owns
    p4_rows_(ss, "Groups").forEach(function (r) { if (mine[_groupKey(r.group)]) p4_mark_(set, r.phone); });
    // 2. entitlement or quiz access for a lesson in scope
    p4_rows_(ss, "Entitlements").forEach(function (r) { if (p4_inSubjects_(ctx, r.scope)) p4_mark_(set, r.phone); });
    p4_rows_(ss, "QuizAccess").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.phone); });
    // 3. quiz result or submission for a lesson in scope
    p4_rows_(ds, "QuizResults").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.student_id); });
    p4_rows_(ds, "Submissions").forEach(function (r) { if (p4_inSubjects_(ctx, r.lesson)) p4_mark_(set, r.student_id); });
    // 4. payment or subscription request for a scope in scope
    p4_rows_(ss, "Payments").forEach(function (r) { if (p4_inSubjects_(ctx, r.scope)) p4_mark_(set, r.phone); });
  }
  c.set = set;
  return set;
}

// Array of phone keys (last 10 digits) linked to the caller. Used by S8 (stats) through typeof p4_linked_.
function p4_linked_(ctx) { return ctx ? Object.keys(p4_linkedSet_(ctx)) : []; }

function p4_ownsStudent(ctx, phoneOrRow) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var ph = phoneOrRow && typeof phoneOrRow === "object"
    ? (phoneOrRow.phone || phoneOrRow.student_id || phoneOrRow.student || "") : phoneOrRow;
  var k = _phoneKey(ph);
  return !!k && p4_linkedSet_(ctx).hasOwnProperty(k);
}

// ---- payments ----------------------------------------------------------------------------

// The payment's OWN stored scope decides. A `scope` override in the request must be in the caller's subjects too.
function p4_paymentInScope(ctx, payload) {
  if (!ctx) return false;
  if (ctx.kind === "owner") return true;
  if (!p4_scoped_(ctx)) return false;
  var id = String(payload && payload.payment_id != null ? payload.payment_id : "").trim();
  if (!id) return false;
  var row = null;
  p4_rows_(_ss(), "Payments").forEach(function (r) { if (!row && String(r.payment_id).trim() === id) row = r; });
  if (!row) return false;
  if (!p4_inSubjects_(ctx, row.scope)) return false;
  if (payload.scope && !p4_inSubjects_(ctx, payload.scope)) return false;
  return true;
}

// ---- generic row filtering (fail closed) ------------------------------------------------------

function p4_pick_(row, names) {
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// 1 keep, 0 drop, -1 drop because no recognised key was present.
function p4_judge_(ctx, row, rule) {
  if (!row || typeof row !== "object") return -1;
  var v;
  if (rule.student) { v = p4_pick_(row, rule.student); if (v === undefined) return -1; if (!p4_ownsStudent(ctx, v)) return 0; }
  if (rule.lesson) { v = p4_pick_(row, rule.lesson); if (v === undefined) return -1; if (!p4_inSubjects_(ctx, v)) return 0; }
  if (rule.group) { v = p4_pick_(row, rule.group); if (v === undefined) return -1; if (!p4_ownsGroup(ctx, v)) return 0; }
  return 1;
}

function p4_filterRows_(arr, ctx, rule, tag) {
  if (!Array.isArray(arr)) return [];
  var unrec = 0;
  var out = arr.filter(function (row) {
    var j = p4_judge_(ctx, row, rule);
    if (j < 0) unrec++;
    return j === 1;
  });
  if (unrec) { try { Logger.log("p4: dropped " + unrec + " unrecognised row(s) in " + tag); } catch (e) {} }
  return out;
}

// Rows that are bare lesson strings or objects (all_lessons, tracks).
function p4_filterLessonList_(arr, ctx, names, tag) {
  if (!Array.isArray(arr)) return [];
  var unrec = 0;
  var out = arr.filter(function (x) {
    if (typeof x === "string") return p4_inSubjects_(ctx, x);
    var j = p4_judge_(ctx, x, { lesson: names });
    if (j < 0) unrec++;
    return j === 1;
  });
  if (unrec) { try { Logger.log("p4: dropped " + unrec + " unrecognised row(s) in " + tag); } catch (e) {} }
  return out;
}

function p4_filterMap_(obj, keep) {
  var out = {};
  if (!obj || typeof obj !== "object") return out;
  Object.keys(obj).forEach(function (k) { if (keep(k, obj[k])) out[k] = obj[k]; });
  return out;
}

// Row belongs to the caller's subjects by the FIRST candidate field that is present (path, then subject, then lesson).
function p4_rowOk_(ctx, row, names) {
  if (!row || typeof row !== "object") return false;
  for (var i = 0; i < names.length; i++) {
    var v = row[names[i]];
    if (v !== undefined && v !== null && String(v).trim() !== "") return p4_inSubjects_(ctx, v);
  }
  return false;
}

// Parent-notification entries: lesson refs in scope are kept; monthly markers are kept with the note blanked
// (a month is not tied to one subject, so its free-text note could describe another subject); the rest are dropped.
function p4_notifKeep_(ctx, n) {
  if (!n || typeof n !== "object") return false;
  var ref = String(n.ref == null ? "" : n.ref).trim();
  if (/^\d{4}-\d{2}$/.test(ref)) { n.note = ""; return true; }
  if (ref && p4_subjectOf(ref)) return p4_inSubjects_(ctx, ref);
  return false;
}

// Fail closed on shape drift: a scoped caller only receives the top-level keys listed here. A key a handler adds
// later is removed (and logged) until it has been reviewed and added to the list.
function p4_allowKeys_(resp, keys, tag) {
  if (!resp || typeof resp !== "object") return resp;
  Object.keys(resp).forEach(function (k) {
    if (keys.indexOf(k) < 0) {
      delete resp[k];
      try { Logger.log("p4: removed unexpected key '" + k + "' from " + tag); } catch (e) {}
    }
  });
  return resp;
}

// ---- filters (names fixed by the contract table) ---------------------------------------------

function p4f_admin_get_all(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "students", "quiz_results", "submissions"], "get_all");
  resp.students = p4_filterRows_(resp.students, ctx, { student: ["phone"] }, "get_all.students");
  resp.quiz_results = p4_filterRows_(resp.quiz_results, ctx, { student: ["student_id"], lesson: ["lesson"] }, "get_all.quiz_results");
  resp.submissions = p4_filterRows_(resp.submissions, ctx, { student: ["student_id"], lesson: ["lesson"] }, "get_all.submissions");
  return resp;
}

function p4f_admin_access_overview(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "today", "counts", "videos", "quizzes", "groups", "roster", "payments", "access", "all_lessons", "tracks", "lessons_error", "quiz_access", "lesson_locks", "year_ends"], "access_overview");
  resp.roster = p4_filterRows_(resp.roster, ctx, { student: ["phone"] }, "overview.roster");
  resp.videos = p4_filterRows_(resp.videos, ctx, { lesson: ["lesson"] }, "overview.videos");
  resp.quizzes = p4_filterRows_(resp.quizzes, ctx, { lesson: ["lesson"] }, "overview.quizzes");
  resp.lesson_locks = p4_filterRows_(resp.lesson_locks, ctx, { lesson: ["lesson"] }, "overview.lesson_locks");
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "overview.groups");
  resp.payments = p4_filterRows_(resp.payments, ctx, { lesson: ["scope"] }, "overview.payments");
  resp.access = p4_filterRows_(resp.access, ctx, { student: ["phone"], lesson: ["scope"] }, "overview.access");
  resp.quiz_access = p4_filterRows_(resp.quiz_access, ctx, { student: ["phone"], lesson: ["lesson"] }, "overview.quiz_access");
  resp.all_lessons = p4_filterLessonList_(resp.all_lessons, ctx, ["lesson", "path"], "overview.all_lessons");
  resp.tracks = p4_filterLessonList_(resp.tracks, ctx, ["path", "track", "folder", "name"], "overview.tracks");
  // Recompute the counts from what is left; any count that cannot be recomputed is removed.
  var old = resp.counts || {}, n = {};
  var has = function (k) { return Object.prototype.hasOwnProperty.call(old, k); };
  ["pending", "active", "ending_soon", "expired", "cancelled", "invalid", "videos_locked", "videos_open", "quizzes_locked", "lessons_locked", "groups"]
    .forEach(function (k) { if (has(k)) n[k] = 0; });
  var inc = function (k) { if (n.hasOwnProperty(k)) n[k]++; };
  resp.payments.forEach(function (p) { if (p.status === "pending") inc("pending"); });
  resp.access.forEach(function (a) {
    if (n.hasOwnProperty(a.state)) n[a.state]++;
    if (a.state === "active" && a.days_left !== null && a.days_left !== undefined && a.days_left <= 7) inc("ending_soon");
  });
  resp.videos.forEach(function (v) { inc(v.locked ? "videos_locked" : "videos_open"); });
  resp.quizzes.forEach(function (q) { if (q.locked) inc("quizzes_locked"); });
  resp.lesson_locks.forEach(function (l) { if (l.locked) inc("lessons_locked"); });
  if (n.hasOwnProperty("groups")) n.groups = resp.groups.length;
  resp.counts = n;
  return resp;
}

function p4f_admin_list_payments(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "payments"], "list_payments");
  resp.payments = p4_filterRows_(resp.payments, ctx, { lesson: ["scope"] }, "list_payments");
  return resp;
}

function p4f_admin_list_groups(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "groups"], "list_groups");
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "list_groups");
  return resp;
}

function p4f_admin_followup_overview(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "today", "now", "settings", "groups", "unclassified", "students", "lessons", "all_lessons", "lessons_error", "slug_collisions", "join_mismatches", "facts", "templates", "flags", "week", "requirements", "parent_log"], "followup_overview");
  resp.groups = p4_filterRows_(resp.groups, ctx, { group: ["group"] }, "followup.groups");
  resp.unclassified = p4_filterRows_(resp.unclassified, ctx, { student: ["phone"] }, "followup.unclassified");
  resp.students = p4_filterMap_(resp.students, function (k, v) { return p4_ownsStudent(ctx, v && v.phone ? v.phone : k); });
  resp.facts = p4_filterMap_(resp.facts, function (k) { return p4_ownsStudent(ctx, k); });
  Object.keys(resp.facts).forEach(function (k) {
    resp.facts[k] = p4_filterMap_(resp.facts[k], function (lesson) { return p4_inSubjects_(ctx, lesson); });
  });
  resp.lessons = p4_filterMap_(resp.lessons, function (k) { return p4_inSubjects_(ctx, k); });
  resp.all_lessons = p4_filterRows_(resp.all_lessons, ctx, { lesson: ["path"] }, "followup.all_lessons");
  resp.requirements = p4_filterMap_(resp.requirements, function (k) { return p4_inSubjects_(ctx, k); });
  resp.parent_log = p4_filterMap_(resp.parent_log, function (k) { return p4_ownsStudent(ctx, k); });
  Object.keys(resp.parent_log).forEach(function (k) {
    resp.parent_log[k] = (resp.parent_log[k] || []).filter(function (n) { return p4_notifKeep_(ctx, n); });
  });
  resp.slug_collisions = [];     // lists lessons and rows across all subjects; not filterable safely
  resp.join_mismatches = [];     // carries student rows across all subjects
  return resp;
}

// Shared by the summary and the monthly review. Filters every list to the caller's subjects and recomputes the totals.
function p4_summaryFilter_(s, ctx) {
  if (!s || typeof s !== "object") return s;
  var lk = ["path", "subject", "lesson"];
  var okL = function (names) { return function (r) { return p4_rowOk_(ctx, r, names); }; };
  var arr = function (x) { return Array.isArray(x) ? x : []; };
  s.quizzes = arr(s.quizzes).filter(okL(lk));
  s.homework = arr(s.homework).filter(okL(lk));
  s.expected = arr(s.expected).filter(okL(["lesson"]));
  s.attendance = arr(s.attendance).filter(okL(["lesson"]));
  s.watch = arr(s.watch).filter(okL(["lesson"]));
  s.video_access = arr(s.video_access).filter(okL(["lesson"]));
  s.groups = arr(s.groups).filter(function (g) { return p4_ownsGroup(ctx, g && g.group); });
  s.notifications = arr(s.notifications).filter(function (n) { return p4_notifKeep_(ctx, n); });
  var items = arr(s.written && s.written.items).filter(okL(["lesson"]));
  var w = { pending: 0, graded: 0, awarded: 0, max: 0, items: items };
  items.forEach(function (i) {
    if (i.graded) {
      w.graded++;
      if (i.awarded !== null && i.awarded !== undefined) w.awarded += i.awarded;
      if (i.max !== null && i.max !== undefined) w.max += i.max;
    } else w.pending++;
  });
  s.written = w;
  var rnd = typeof _p2fuRound === "function" ? _p2fuRound : function (n) { return n === null ? null : Math.round(n * 100) / 100; };
  var avg = function (xs) { return xs.length ? rnd(xs.reduce(function (a, b) { return a + b; }, 0) / xs.length) : null; };
  var pcts = s.quizzes.filter(function (q) { return q.pct !== null && q.pct !== undefined; }).map(function (q) { return q.pct; });
  var center = s.attendance.filter(function (a) { return a.mode === "center"; }).length;
  var req = function (list, kind) { return list.filter(function (e) { return e[kind] && e[kind].required; }).length; };
  var missed = function (list, kind) { return list.filter(function (e) { return e[kind] && e[kind].missed; }).length; };
  s.totals = {
    quiz_count: s.quizzes.length, quiz_avg_pct: avg(pcts),
    quiz_required: req(s.expected, "quiz"), quiz_missed: missed(s.expected, "quiz"),
    homework_count: s.homework.length,
    homework_required: req(s.expected, "homework"), homework_missed: missed(s.expected, "homework"),
    attendance_center: center, attendance_online: s.attendance.length - center,
    watch_avg_pct: avg(s.watch.map(function (x) { return x.pct; }).filter(function (x) { return x !== null && x !== undefined; })),
    written_pending: w.pending, written_graded: w.graded
  };
  return s;
}

var P4_NOT_AUTH_ = { ok: false, error: "Not authorized." };
function p4_notAuth_() { return { ok: P4_NOT_AUTH_.ok, error: P4_NOT_AUTH_.error }; }

function p4f_admin_student_summary(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  if (!resp.student || !p4_ownsStudent(ctx, resp.student.phone)) return p4_notAuth_();
  p4_allowKeys_(resp, ["ok", "student", "groups", "range", "totals", "quizzes", "homework", "expected", "attendance", "watch", "video_access", "written", "notifications", "lessons_error"], "student_summary");
  return p4_summaryFilter_(resp, ctx);
}

function p4f_admin_monthly_review(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "month", "range", "closed", "reviews", "review"], "monthly_review");
  if (Array.isArray(resp.reviews)) {
    resp.reviews = resp.reviews.filter(function (rv) { return rv && p4_ownsStudent(ctx, rv.student); }).map(function (rv) {
      if (rv.summary) rv.summary = p4_summaryFilter_(rv.summary, ctx);
      if (rv.review && typeof rv.review === "object") rv.review.note = "";
      return rv;
    });
  }
  return resp;
}

function p4f_admin_list_parent_notifications(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "notifications", "not_notified"], "parent_notifications");
  resp.notifications = (Array.isArray(resp.notifications) ? resp.notifications : []).filter(function (n) {
    return n && p4_ownsStudent(ctx, n.student) && p4_notifKeep_(ctx, n);
  });
  if (Array.isArray(resp.not_notified)) {
    resp.not_notified = resp.not_notified.filter(function (p) { return p4_ownsStudent(ctx, p); });
  }
  return resp;
}

function p4_gradingCounts_(ctx) {
  try {
    var sh = _gAnswersSheet(), pending = 0, graded = 0;
    if (sh && sh.getLastRow() >= 2) {
      _sheetValuesAsObjects(sh).forEach(function (r) {
        if (!r.submission_id || !r.question_id) return;
        if (!p4_ownsStudent(ctx, r.student_id) || !p4_inSubjects_(ctx, _gCanon(r.lesson))) return;
        if (_gNum(r.awarded) !== null) graded++; else pending++;
      });
    }
    return { pending: pending, graded: graded };
  } catch (e) { return null; }
}

function p4f_admin_grading_queue(resp, ctx, payload) {
  if (!p4_scoped_(ctx) || !resp || resp.ok === false) return resp;
  p4_allowKeys_(resp, ["ok", "items", "truncated", "counts"], "grading_queue");
  resp.items = p4_filterRows_(resp.items, ctx, { student: ["student_id", "student"], lesson: ["lesson"] }, "grading_queue");
  resp.counts = p4_gradingCounts_(ctx);
  return resp;
}

// ---- add-by-phone (LINK) and group creation -------------------------------------------------------

// The A17 bucket: 30 lookups per hour per principal, shared with S5 (appointments, phone-collision checks).
// p4_lookupAllowed_(ctx[, n=1]) -> true if n more lookups fit in this hour (and counts them), false otherwise (also on any error).
// CacheService key: p4lk:<principal key>:<yyyymmddhh>
function p4_lookupAllowed_(ctx, n) {
  try {
    n = n > 0 ? n : 1;
    var cache = CacheService.getScriptCache();
    var hour = String(_fmt(new Date(), TZ, true)).slice(0, 13).replace(/[^0-9]/g, "");
    var key = "p4lk:" + p4_principalKey_(ctx) + ":" + hour;
    var cur = parseInt(cache.get(key) || "0", 10) || 0;
    if (cur + n > P4_LOOKUPS_PER_HOUR) return false;
    cache.put(key, String(cur + n), 3600);
    return true;
  } catch (e) { return false; }      // fail closed
}

function p4_registeredSet_() {
  var set = {};
  _sheetValuesAsObjects(_students()).forEach(function (r) { p4_mark_(set, r.phone); });
  return set;
}

function p4_linkReply_(resp, ctx, phones) {
  if (!resp || resp.ok !== true) return p4_notAuth_();
  var list = phones.filter(function (p) { return _phoneKey(p) !== ""; });
  if (!p4_lookupAllowed_(ctx, Math.max(1, list.length))) return { ok: false, error: "Too many requests." };
  var reg = p4_registeredSet_(), all = list.length > 0;
  list.forEach(function (p) { if (!reg[_phoneKey(p)]) all = false; });
  return { ok: true, registered: all };
}

function p4_groupOwnerId_(ctx) {
  var id = ctx.principal || ctx.id;
  return _normalizePhone(id).length >= 10 ? _canonicalPhone(id) : String(id);
}

function p4_createGroupOwner_(ctx, groupName) {
  return _withLock(function () {
    var ss = _ss();
    var sh = _sheetByName(ss, "GroupOwners", P4_GROUPOWNER_HEADERS);
    _ensureColumns(sh, P4_GROUPOWNER_HEADERS);
    var key = _groupKey(groupName), exists = false;
    p4_rows_(ss, "GroupOwners").forEach(function (r) { if (_groupKey(r.group) === key) exists = true; });
    if (exists) return false;
    var row = _appendByHeader(sh, { group: String(groupName), owner_id: p4_groupOwnerId_(ctx), created_at: _fmt(new Date(), TZ, true) });
    var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var col = hdr.indexOf("owner_id") + 1;
    if (col > 0) sh.getRange(row, col).setNumberFormat("@").setValue(p4_groupOwnerId_(ctx));
    return true;
  });
}

function p4f_admin_group_add(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  var phones = Array.isArray(payload.phones) ? payload.phones : [payload.phone];
  if (resp && resp.ok === true) {
    var name = String(resp.group || payload.group || ""), key = _groupKey(name);
    var slot = p4_principalKey_(ctx) + "|" + key;
    if (key && P4_GSTATE_[slot] === "free") {            // state at gate time: nobody owned it and it had no members
      p4_createGroupOwner_(ctx, name);
      P4_GSTATE_[slot] = "own";
      p4_resetOwners_();
    }
  }
  return p4_linkReply_(resp, ctx, phones);
}

function p4_resetOwners_() { P4_PC_.owners = null; }

function p4f_admin_grant_access(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  return p4_linkReply_(resp, ctx, [payload.phone]);
}

function p4f_admin_grant_quiz_access(resp, ctx, payload) {
  if (!p4_scoped_(ctx)) return resp;
  return p4_linkReply_(resp, ctx, [payload.phone]);
}

// ---- owner action: set or reset a group's owner -------------------------------------------------------

function p4_admin_set_group_owner(payload) {
  var ctx = typeof p4_ctx === "function" ? p4_ctx(payload) : null;
  if (!ctx || ctx.kind !== "owner") return p4_notAuth_();
  var group = String(payload.group == null ? "" : payload.group).trim();
  var key = _groupKey(group);
  if (!key) return { ok: false, error: "Missing group." };
  var ownerPhone = String(payload.owner_phone == null ? "" : payload.owner_phone).trim();
  return _withLock(function () {
    var ss = _ss();
    var members = p4_rows_(ss, "Groups").some(function (r) { return _groupKey(r.group) === key; });
    var sh = ss.getSheetByName("GroupOwners");
    var existingRow = 0;
    if (sh && sh.getLastRow() >= 2) {
      var vals = sh.getDataRange().getValues(), h = vals[0], gi = h.indexOf("group");
      for (var i = 1; i < vals.length; i++) if (_groupKey(vals[i][gi]) === key) { existingRow = i + 1; break; }
    }
    if (!members && !existingRow) return { ok: false, error: "No such group." };
    if (ownerPhone === "") {
      if (existingRow) sh.deleteRows(existingRow, 1);
      p4_resetCache_();
      return { ok: true };
    }
    var stu = _students(), sv = stu.getDataRange().getValues(), c = _studentCols(sv[0]), isTeacher = false;
    for (var j = 1; j < sv.length; j++) {
      if (_phonesMatch(sv[j][c.phone - 1], ownerPhone)) {
        var role = c.role ? String(sv[j][c.role - 1]).trim().toLowerCase() : "";
        var scope = c.teacher_scope ? String(sv[j][c.teacher_scope - 1]).trim() : "";
        isTeacher = role === "teacher" && scope !== "";
        break;
      }
    }
    if (!isTeacher) return { ok: false, error: "That person is not a teacher." };
    var id = _canonicalPhone(ownerPhone);
    var tab = _sheetByName(ss, "GroupOwners", P4_GROUPOWNER_HEADERS);
    _ensureColumns(tab, P4_GROUPOWNER_HEADERS);
    var hdr = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
    var oc = hdr.indexOf("owner_id") + 1;
    if (existingRow) {
      tab.getRange(existingRow, oc).setNumberFormat("@").setValue(id);
    } else {
      var r = _appendByHeader(tab, { group: group, owner_id: id, created_at: _fmt(new Date(), TZ, true) });
      tab.getRange(r, oc).setNumberFormat("@").setValue(id);
    }
    p4_resetCache_();
    return { ok: true };
  });
}

// ---- per-owner follow-up templates (used by the small Code.gs diff, patches/S3-templates.diff) -------------

// "" = the owner's own templates (unchanged behavior). ":<id>" = a teacher's own set. null = scoped caller with no id (refuse).
function p4_tplSuffix_(payload) {
  var ctx = p4_ctxFor_(payload);
  if (!ctx || !p4_scoped_(ctx)) return "";
  var id = ctx.principal || ctx.id;
  return id ? ":" + p4_idKey_(id) : null;
}

// rows of the FollowupTemplates tab -> {key: body}. Owner (sfx falsy): plain keys only, exactly as before.
// Teacher: his own rows override the owner's plain ones, which remain visible as read-only defaults.
function p4_tplView_(rows, sfx) {
  var out = {}, mine = {};
  (rows || []).forEach(function (r) {
    var k = String(r.key || "").trim(), b = String(r.body == null ? "" : r.body);
    if (!k || b.trim() === "") return;
    var at = k.indexOf(":");
    if (at < 0) { if (!out.hasOwnProperty(k)) out[k] = b; return; }
    if (sfx && k.slice(at) === sfx) { var base = k.slice(0, at); if (!mine.hasOwnProperty(base)) mine[base] = b; }
  });
  Object.keys(mine).forEach(function (k) { out[k] = mine[k]; });
  return out;
}

// ---- self test (S2's p4_selfTest calls this when it exists) -------------------------------------------------

function p4_selfTest_people() {
  var bad = [];
  var chk = function (name, ok) { if (!ok) bad.push(name); };
  chk("idKey phone", p4_idKey_("+20 100 000 0009") === "1000000009" && p4_idKey_("01000000009") === "1000000009");
  chk("idKey name", p4_idKey_(" Mo ") === "mo");
  var t = { kind: "teacher", via: "session", id: "01000000009", subjects: ["math"], principal: "01000000009" };
  var a = { kind: "assistant", via: "session", id: "01000000010", subjects: ["math"], principal: "01000000009" };
  var la = { kind: "assistant", via: "session", id: "01000000011", subjects: [], principal: "" };
  chk("scoped teacher", p4_scoped_(t) && p4_scoped_(a) && !p4_scoped_(la) && !p4_scoped_({ kind: "owner" }));
  chk("inSubjects", p4_inSubjects_(t, "math/x/y") && !p4_inSubjects_(t, "programming/x") && !p4_inSubjects_(t, ""));
  var v = p4_tplView_([{ key: "a", body: "own" }, { key: "a:1000000009", body: "mine" }, { key: "b:2", body: "other" }], ":1000000009");
  chk("tplView teacher", v.a === "mine" && !v.hasOwnProperty("b"));
  var o = p4_tplView_([{ key: "a", body: "own" }, { key: "a:1000000009", body: "mine" }], "");
  chk("tplView owner", o.a === "own" && Object.keys(o).length === 1);
  return bad.length ? "FAIL: " + bad.join(", ") : "ALL PASS";
}
