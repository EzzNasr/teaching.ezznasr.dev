// =====================================================================================
// FollowupRouter.gs  (Follow-up v2, Session 5: core wiring)
//
// What lives here:
//   fu2_dispatch_(payload)          doPost sends every admin_fu2_* / admin_req_* action here (one line in Code.gs, marked // FU2:)
//   fu2_routes_()                   merges the route maps of the other files, each only if it exists
//   fu2_core_routes_()              actions that belong to the core: admin_fu2_group_duplicates
//   fu2_core_overviewInternal_()    the follow-up overview WITHOUT a session check, for S2's hourly tick
//   fu2_core_requirements_(...)     the monthly report's "requirements" section (summary.requirements)
//   fu2_core_snapshotParse_(...)    reads the snapshot saved when a month was marked sent / closed
//
// Optional, found by name at call time (a missing one changes nothing):
//   fu2_notify_routes_()  S2, FollowupNotify.gs        req_routes_()  S4, Requirements.gs
//   fu2_wa_routes_()      FollowupWhatsApp.gs (WhatsApp sender, docs/whatsapp/README.md)
//   req_effective_(groupKey)  req_catalog_()  req_checks_for_(phoneKey, month)   S4
// Nothing here is reachable except through the actions listed in fu2_core_routes_() and the merged route maps.
// =====================================================================================

var FU2_REQ_BUILTIN = ["watch", "homework", "quiz", "attendance", "written_answers"];

// ---- routing -----------------------------------------------------------------------------------
function fu2_callGlobal_(name, args) {
  var g = typeof globalThis !== "undefined" ? globalThis : this;
  if (g && typeof g[name] === "function") return { found: true, value: g[name].apply(null, args || []) };
  return { found: false };
}

// {action: function(payload)}. Later maps win; core last so nothing can shadow its two actions.
function fu2_routes_() {
  var out = {};
  ["fu2_notify_routes_", "req_routes_", "fu2_wa_routes_", "fu2_core_routes_"].forEach(function (name) {
    try {
      var r = fu2_callGlobal_(name);
      if (r.found && r.value) Object.keys(r.value).forEach(function (a) { if (typeof r.value[a] === "function") out[a] = r.value[a]; });
    } catch (e) { console.error("FU2 route map " + name + " failed: " + e); }
  });
  return out;
}

function fu2_dispatch_(payload) {
  var action = String((payload && payload.action) || "");
  var routes = fu2_routes_();
  if (!Object.prototype.hasOwnProperty.call(routes, action)) return { ok: false, error: "Unknown action: " + action };
  return routes[action](payload);
}

function fu2_core_routes_() {
  return {
    // Admin only: the action is deliberately NOT on P3_STAFF_ALLOW, so an assistant session is refused here.
    admin_fu2_group_duplicates: function (payload) {
      _requireAdminAny(payload);
      return { ok: true, duplicates: _fu2Duplicates() };
    },
  };
}

// The same overview as admin_followup_overview (hooks included), for server-side callers such as the notification tick.
// Not an action and never listed in a route map, so nothing in a request can reach it. It authenticates itself with
// the ADMIN_TOKEN Script Property, so that property has to be set (it already is: the desktop app uses it).
function fu2_core_overviewInternal_() {
  return p2_admin_followup_overview({ action: "admin_followup_overview", token: _props().getProperty("ADMIN_TOKEN") });
}

// ---- monthly report: requirements ------------------------------------------------------------------
function fu2_round1_(n) { return n === null || n === undefined || !isFinite(n) ? null : Math.round(n * 10) / 10; }

// Built-in set, used when Requirements.gs (S4) is not installed: today's behaviour, all on, all in the report.
function fu2_defaultEffective_() {
  var o = {};
  FU2_REQ_BUILTIN.forEach(function (k) {
    o[k] = { enabled: true, in_monthly_report: true, parent_message: k === "watch" || k === "homework" || k === "quiz",
             rule: k === "watch" ? { pct: 80 } : {}, weight: 1, source: "default" };
  });
  return o;
}
var FU2_DEFAULT_LABELS = {
  watch: ["المشاهدة", "Video watching"], homework: ["الواجب", "Homework"], quiz: ["الكويز", "Quiz"],
  attendance: ["الحضور", "Attendance"], written_answers: ["الإجابات الكتابية", "Written answers"],
};

// Cached on X (one load per request) so a 40-student month does not read the requirement sheets 40 times.
function fu2_core_effective_(X, groupKey) {
  X.fu2 = X.fu2 || { eff: {}, catalog: null };
  if (Object.prototype.hasOwnProperty.call(X.fu2.eff, groupKey)) return X.fu2.eff[groupKey];
  var eff = null;
  try { var r = fu2_callGlobal_("req_effective_", [groupKey]); if (r.found && r.value && typeof r.value === "object") eff = r.value; }
  catch (e) { console.error("FU2 req_effective_ failed: " + e); }
  X.fu2.eff[groupKey] = eff;
  return eff;
}
function fu2_core_catalog_(X) {
  X.fu2 = X.fu2 || { eff: {}, catalog: null };
  if (X.fu2.catalog === null) {
    var map = {};
    try {
      var r = fu2_callGlobal_("req_catalog_");
      if (r.found && Array.isArray(r.value)) r.value.forEach(function (c) { if (c && c.key) map[c.key] = c; });
    } catch (e) { console.error("FU2 req_catalog_ failed: " + e); }
    X.fu2.catalog = map;
  }
  return X.fu2.catalog;
}

// summary = the object _p2fuSummaryFor is about to return (totals, expected, quizzes, attendance, watch, written, groups).
// -> {items:[...], compliance_pct, source}   (contract 3.6)
function fu2_core_requirements_(X, key, summary, month) {
  var gk = summary.groups && summary.groups.length ? String(summary.groups[0].key || "") : "";
  var eff = fu2_core_effective_(X, gk), catalog = fu2_core_catalog_(X), fromServer = !!eff;
  if (!eff) eff = fu2_defaultEffective_();
  var keys = FU2_REQ_BUILTIN.filter(function (k) { return eff[k]; });
  Object.keys(eff).sort().forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });

  var exp = summary.expected || [];
  var attBy = {}, watchBy = {}, quizBy = {};
  (summary.attendance || []).forEach(function (a) { attBy[a.lesson] = 1; });
  (summary.watch || []).forEach(function (w) { watchBy[w.lesson] = w.pct; });
  (summary.quizzes || []).forEach(function (q) { quizBy[q.subject + "|" + q.lesson] = q.pct; });   // by subject|slug: works even when the lesson list from GitHub is down
  var checks = null;

  var items = [], sources = {};
  keys.forEach(function (k) {
    var e = eff[k];
    if (!e || e.enabled === false || e.in_monthly_report === false) return;
    var rule = e.rule || {}, weight = typeof e.weight === "number" && e.weight >= 0 ? e.weight : 1;
    var cat = catalog[k] || {}, lab = FU2_DEFAULT_LABELS[k] || [k, k];
    var isManual = FU2_REQ_BUILTIN.indexOf(k) < 0 || cat.kind === "manual";
    var item = { key: k, label_ar: cat.label_ar || lab[0], label_en: cat.label_en || lab[1], kind: isManual ? "manual" : "auto", met: 0, expected: 0, pct: null, weight: weight };
    if (isManual) {
      if (checks === null) {
        checks = {};
        try { var r = fu2_callGlobal_("req_checks_for_", [_phoneKey(summary.student.phone), month]); if (r.found && r.value) checks = r.value; }
        catch (err) { console.error("FU2 req_checks_for_ failed: " + err); }
      }
      var c = checks[k], met = c && (c.met === true || c.met === false) ? c.met : null;
      item.met = met; item.expected = met === null ? 0 : 1; item.pct = met === null ? null : (met ? 100 : 0);
      if (c && c.note) item.note = String(c.note);
      if (c && c.by) item.by = String(c.by);
    } else {
      var need, met2 = 0;
      if (k === "homework") { need = exp.filter(function (x) { return x.homework && x.homework.required; }); met2 = need.filter(function (x) { return x.homework.done; }).length; }
      else if (k === "quiz") {
        need = exp.filter(function (x) { return x.quiz && x.quiz.required; });
        met2 = need.filter(function (x) {
          if (!x.quiz.done) return false;
          if (rule.min_pct === undefined || rule.min_pct === null || rule.min_pct === "") return true;
          var qp = quizBy[_firstSegment(x.lesson) + "|" + _p2fuSlug(x.lesson)];
          return qp !== undefined && qp !== null && qp >= Number(rule.min_pct);
        }).length;
      }
      else if (k === "attendance") { need = exp; met2 = need.filter(function (x) { return attBy[x.lesson]; }).length; }
      else if (k === "watch") {
        need = exp; var th = rule.pct !== undefined && rule.pct !== null && rule.pct !== "" ? Number(rule.pct) : 80;
        met2 = need.filter(function (x) { return watchBy[x.lesson] !== undefined && watchBy[x.lesson] >= th; }).length;
      }
      else if (k === "written_answers") {
        // Only graded answers can be judged (an ungraded one is the teacher's pending work, not the student's miss): met = scored at least half.
        need = (summary.written && summary.written.items || []).filter(function (x) { return x.graded; });
        met2 = need.filter(function (x) { return x.max > 0 && x.awarded !== null && x.awarded >= x.max / 2; }).length;
      }
      item.expected = need ? need.length : 0; item.met = met2; item.pct = item.expected ? fu2_round1_(met2 / item.expected * 100) : null;
    }
    items.push(item);
    sources[e.source || "default"] = 1;
  });

  var wsum = 0, acc = 0;
  items.forEach(function (it) { if (it.pct !== null && it.weight > 0) { wsum += it.weight; acc += it.weight * it.pct; } });
  var source = !fromServer ? "default" : sources.group ? "group" : sources.global ? "global" : "default";
  return { items: items, compliance_pct: wsum ? fu2_round1_(acc / wsum) : null, source: source };
}

// A saved snapshot cell -> object, or null when absent / unreadable.
function fu2_core_snapshotParse_(cell) {
  try {
    var s = String(cell == null ? "" : cell).trim();
    if (!s) return null;
    var o = JSON.parse(s);
    return o && typeof o === "object" && Array.isArray(o.items) ? o : null;
  } catch (e) { return null; }
}
