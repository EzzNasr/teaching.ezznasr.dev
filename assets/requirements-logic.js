/* ==========================================================================
   requirements-logic.js — pure rules for the global requirements catalogue (Follow-up v2 / S4).
   UMD: global `RequirementsLogic`, also module.exports. No DOM, no network.

   The SERVER copy of these rules lives in Requirements.gs (req_* functions). Both must give the
   same answers: tests/test_req_parity.js runs the same fixtures through both.

   Precedence (lowest to highest):  built-in default  <  global row  <  group override.
   (The per-lesson LessonRequirements sheet is a separate, lower level and is NOT touched here.)
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RequirementsLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var BUILTIN_KEYS = ["watch", "homework", "quiz", "attendance", "written_answers"];
  var MAX_CUSTOM = 30;
  var MODES = ["inherit", "on", "off", "custom"];

  // Today's behaviour, exactly: everything on, everything in the monthly report, watch threshold 80,
  // parent messages for watch / homework / quiz only.
  var DEFAULTS = [
    { key: "watch",           label_ar: "مشاهدة الفيديو",     label_en: "Watch video",     kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: { pct: 80 } },
    { key: "homework",        label_ar: "الواجب",              label_en: "Homework",        kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: {} },
    { key: "quiz",            label_ar: "الكويز",              label_en: "Quiz",            kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: true,  weight: 1, rule: {} },
    { key: "attendance",      label_ar: "الحضور",              label_en: "Attendance",      kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: false, weight: 1, rule: {} },
    { key: "written_answers", label_ar: "الإجابات المكتوبة",   label_en: "Written answers", kind: "auto", scope: "per_lesson", enabled: true, in_monthly_report: true, parent_message: false, weight: 1, rule: {} },
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function groupKey(name) { return String(name == null ? "" : name).trim().replace(/\s+/g, " ").toLowerCase(); }
  function toDigits(s) { return String(s == null ? "" : s).replace(/[\u0660-\u0669]/g, function (d) { return d.charCodeAt(0) - 0x660; }).replace(/[\u06F0-\u06F9]/g, function (d) { return d.charCodeAt(0) - 0x6F0; }); }
  function phoneKey(p) { var d = toDigits(p).replace(/\D/g, ""); return d.length > 10 ? d.slice(-10) : d; }

  function isCustomKey(key) { return /^custom_[a-z0-9_]{1,40}$/.test(String(key)); }
  function isKnownKeyShape(key) { return BUILTIN_KEYS.indexOf(key) >= 0 || isCustomKey(key); }

  // slug from a free label: "Class behaviour!" -> "custom_class_behaviour"; "" if nothing usable
  function slugFor(label) {
    var s = String(label == null ? "" : label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    return s ? "custom_" + s : "";
  }

  function isInt(n) { return typeof n === "number" && isFinite(n) && Math.floor(n) === n; }

  // Returns {ok:true, rule} (a cleaned copy) or {ok:false, error}.
  function validateRule(key, rule) {
    if (rule === undefined || rule === null) rule = {};
    if (typeof rule !== "object" || Array.isArray(rule)) return { ok: false, error: "rule must be an object" };
    var out = {}, names = Object.keys(rule);
    var allowed = key === "watch" ? ["pct"] : key === "quiz" ? ["min_pct"] : [];
    for (var i = 0; i < names.length; i++) {
      if (allowed.indexOf(names[i]) < 0) return { ok: false, error: "Unknown rule field \"" + names[i] + "\" for " + key };
      var v = rule[names[i]];
      if (typeof v === "string" && /^\d+$/.test(v.trim())) v = parseInt(v, 10);
      if (!isInt(v) || v < 1 || v > 100) return { ok: false, error: names[i] + " must be a whole number from 1 to 100" };
      out[names[i]] = v;
    }
    if (key === "watch" && out.pct === undefined) out.pct = 80;
    return { ok: true, rule: out };
  }

  function validWeight(w) { return typeof w === "number" && isFinite(w) && w >= 0 && w <= 10; }

  function normalizeCatalog(rows) {
    // rows: stored global rows (any subset, any order). Missing built-ins fall back to DEFAULTS.
    var byKey = {};
    (rows || []).forEach(function (r) { if (r && r.key && !byKey.hasOwnProperty(r.key)) byKey[r.key] = r; });
    var out = DEFAULTS.map(function (d) {
      var r = byKey[d.key], e = clone(d);
      e.edited = false;
      if (r) {
        ["enabled", "in_monthly_report", "parent_message"].forEach(function (f) { if (typeof r[f] === "boolean") e[f] = r[f]; });
        if (validWeight(r.weight)) e.weight = r.weight;
        if (r.label_ar) e.label_ar = String(r.label_ar);
        if (r.label_en) e.label_en = String(r.label_en);
        if (r.rule && typeof r.rule === "object") { var v = validateRule(d.key, r.rule); if (v.ok) e.rule = v.rule; }
        e.edited = !!r.edited;
      }
      return e;
    });
    var customs = Object.keys(byKey).filter(function (k) { return isCustomKey(k); }).map(function (k) { return byKey[k]; });
    customs.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
    customs.forEach(function (r) {
      out.push({ key: r.key, label_ar: String(r.label_ar || ""), label_en: String(r.label_en || ""), kind: "manual", scope: "per_month",
                 enabled: r.enabled !== false, in_monthly_report: r.in_monthly_report !== false, parent_message: r.parent_message === true,
                 weight: validWeight(r.weight) ? r.weight : 1, rule: {}, edited: true });
    });
    return out;
  }

  // catalog + one group's overrides ({req_key: {mode, rule?, in_monthly_report?}}) -> effective map.
  function resolve(catalog, groupOverrides) {
    var out = {};
    catalog.forEach(function (c) {
      var e = { enabled: c.enabled, in_monthly_report: c.in_monthly_report, parent_message: c.parent_message,
                rule: clone(c.rule || {}), weight: c.weight, source: c.edited ? "global" : "default" };
      var o = groupOverrides && groupOverrides[c.key];
      if (o && o.mode === "off") { e.enabled = false; e.source = "group"; }
      else if (o && o.mode === "on") { e.enabled = true; e.source = "group"; }
      else if (o && o.mode === "custom") {
        e.enabled = true; e.source = "group";
        if (o.rule && typeof o.rule === "object") { var m = clone(c.rule || {}); Object.keys(o.rule).forEach(function (k) { m[k] = o.rule[k]; }); e.rule = m; }
        if (typeof o.in_monthly_report === "boolean") e.in_monthly_report = o.in_monthly_report;
      }
      out[c.key] = e;
    });
    return out;
  }

  // True when a group's effective entry is not what the global (no-override) entry says.
  function differs(effective, globalEntry) {
    if (!effective || !globalEntry) return false;
    return effective.enabled !== globalEntry.enabled || effective.in_monthly_report !== globalEntry.in_monthly_report ||
           JSON.stringify(effective.rule || {}) !== JSON.stringify(globalEntry.rule || {});
  }

  // What the monthly report counts for one student: enabled + in_monthly_report entries, with label.
  function monthlyList(catalog, effective) {
    return catalog.filter(function (c) { var e = effective[c.key]; return e && e.enabled && e.in_monthly_report; })
      .map(function (c) { var e = effective[c.key]; return { key: c.key, label_ar: c.label_ar, label_en: c.label_en, kind: c.kind, weight: e.weight, rule: e.rule, source: e.source }; });
  }

  // ---- lessons required in a month (Nov 2026) ------------------------------------------------------
  // For each month there is a GENERAL list (every group) and, optionally, a list for ONE group that replaces the
  // general list for that group (whole list, not lesson by lesson). Each entry is a ticked lesson; ticking makes its
  // homework and its quiz required, and either can be switched off on its own:
  //   {lesson: "programming/.../chapter-1-lesson-2-how-ai-works", homework: true, quiz: false}
  // Server copy: req_month_* in Requirements.gs (tests/test_req_parity.js keeps them equal).
  var MAX_MONTH_LESSONS = 60;
  function isMonth(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m == null ? "" : m).trim()); }
  function lessonPathKey(raw) {
    return String(raw == null ? "" : raw).trim().toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  }
  // {ok:true, lessons} (cleaned: lower-case paths, one entry per lesson, the first one wins) | {ok:false, error}
  function normalizeMonthLessons(list) {
    if (list === undefined || list === null) list = [];
    if (!Array.isArray(list)) return { ok: false, error: "lessons must be a list" };
    var out = [], seen = {};
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (typeof it === "string") it = { lesson: it };
      if (!it || typeof it !== "object") return { ok: false, error: "lesson #" + (i + 1) + " is not valid" };
      var p = lessonPathKey(it.lesson);
      if (!p || p.length > 200 || !/^[a-z0-9][a-z0-9._\/-]*$/.test(p)) return { ok: false, error: "lesson #" + (i + 1) + " has no valid lesson path" };
      if (it.homework !== undefined && typeof it.homework !== "boolean") return { ok: false, error: "homework must be true or false" };
      if (it.quiz !== undefined && typeof it.quiz !== "boolean") return { ok: false, error: "quiz must be true or false" };
      if (seen[p]) continue;
      seen[p] = true;
      out.push({ lesson: p, homework: it.homework !== false, quiz: it.quiz !== false });
    }
    if (out.length > MAX_MONTH_LESSONS) return { ok: false, error: "At most " + MAX_MONTH_LESSONS + " lessons in a month." };
    return { ok: true, lessons: out };
  }
  // plans = one month: {general: {lessons} | null, groups: {group_key: {lessons}}}
  // -> {source: "group" | "general" | "none", lessons: [...]}; "none" = nothing chosen for the month (the report then
  //    falls back to each group's weekly lesson lists, as before).
  function resolveMonthLessons(plans, group) {
    var gk = groupKey(group), p = plans || {};
    var g = gk && p.groups && Object.prototype.hasOwnProperty.call(p.groups, gk) ? p.groups[gk] : null;
    if (g && Array.isArray(g.lessons)) return { source: "group", lessons: clone(g.lessons) };
    if (p.general && Array.isArray(p.general.lessons)) return { source: "general", lessons: clone(p.general.lessons) };
    return { source: "none", lessons: [] };
  }
  // {homework, quiz}: how many lessons ask for each, for the "what is required" line
  function monthLessonCounts(lessons) {
    var c = { lessons: 0, homework: 0, quiz: 0 };
    (lessons || []).forEach(function (l) { c.lessons++; if (l.homework) c.homework++; if (l.quiz) c.quiz++; });
    return c;
  }

  return {
    BUILTIN_KEYS: BUILTIN_KEYS, MAX_CUSTOM: MAX_CUSTOM, MODES: MODES, DEFAULTS: DEFAULTS, MAX_MONTH_LESSONS: MAX_MONTH_LESSONS,
    groupKey: groupKey, phoneKey: phoneKey, isCustomKey: isCustomKey, isKnownKeyShape: isKnownKeyShape, slugFor: slugFor,
    validateRule: validateRule, validWeight: validWeight, normalizeCatalog: normalizeCatalog, resolve: resolve, differs: differs, monthlyList: monthlyList,
    isMonth: isMonth, lessonPathKey: lessonPathKey, normalizeMonthLessons: normalizeMonthLessons, resolveMonthLessons: resolveMonthLessons,
    monthLessonCounts: monthLessonCounts,
  };
});
