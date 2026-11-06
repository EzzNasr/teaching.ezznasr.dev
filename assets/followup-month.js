/* ==========================================================================
   followup-month.js — pure helpers for the monthly report on the follow-up page (Nov 2026).
   UMD: global `FollowupMonth`, also module.exports. No DOM, no network.

   1. The month's required lessons (the editor): a draft list of ticked lessons, each with its own homework / quiz
      switch. Storage and the general-vs-group rule are in Requirements.gs (req_month_*) and RequirementsLogic
      (normalizeMonthLessons / resolveMonthLessons); this file only edits a draft.
   2. The mass send (one group or all groups): which students get a message, which are held back and why, with the
      counts the preview shows before anything is queued.
   Used by assets/followup-app.js. Tests: tools/quiz-maker-v2/tests/test_month_lessons.js
   ========================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FollowupMonth = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function key(p) { return String(p == null ? "" : p).trim().toLowerCase(); }

  // ---- 1. the editor draft --------------------------------------------------------------------------
  // draft = [{lesson, homework, quiz}] in the order the lessons were ticked
  function draftFrom(lessons) { return clone(lessons || []); }
  function indexOf(draft, lesson) { var k = key(lesson); for (var i = 0; i < draft.length; i++) if (draft[i].lesson === k) return i; return -1; }
  function isOn(draft, lesson) { return indexOf(draft, lesson) >= 0; }
  function entry(draft, lesson) { var i = indexOf(draft, lesson); return i < 0 ? null : draft[i]; }
  // Ticking a lesson makes its homework and its quiz required, except a part the lesson does not have
  // (meta = {has_quiz, has_assignment} from the overview; unknown = assume it has it).
  function toggle(draft, lesson, on, meta) {
    var out = clone(draft), i = indexOf(out, lesson);
    if (on && i < 0) {
      meta = meta || {};
      out.push({ lesson: key(lesson), homework: meta.has_assignment !== false, quiz: meta.has_quiz !== false });
    } else if (!on && i >= 0) out.splice(i, 1);
    return out;
  }
  function setPart(draft, lesson, part, value) {
    if (part !== "homework" && part !== "quiz") throw new Error("part must be homework or quiz");
    var out = clone(draft), i = indexOf(out, lesson);
    if (i >= 0) out[i][part] = !!value;
    return out;
  }
  function sameLessons(a, b) {
    var x = (a || []).map(function (l) { return [l.lesson, !!l.homework, !!l.quiz].join("|"); }).sort();
    var y = (b || []).map(function (l) { return [l.lesson, !!l.homework, !!l.quiz].join("|"); }).sort();
    return JSON.stringify(x) === JSON.stringify(y);
  }
  // all_lessons rows ({path}) -> [{folder, lessons:[path]}] by the folder above the lesson ("programming/.../grade-2-secondary"),
  // lessons in path order. A search word keeps only the matching lessons (path or label).
  function byFolder(rows, query, labelOf) {
    var q = String(query || "").trim().toLowerCase(), groups = {}, order = [];
    (rows || []).forEach(function (r) {
      var p = key(r && (r.path || r.lesson || r)); if (!p) return;
      if (q) {
        var lab = labelOf ? String(labelOf(p) || "").toLowerCase() : "";
        if (p.indexOf(q) < 0 && lab.indexOf(q) < 0) return;
      }
      var f = p.indexOf("/") < 0 ? "" : p.slice(0, p.lastIndexOf("/"));
      if (!groups[f]) { groups[f] = []; order.push(f); }
      if (groups[f].indexOf(p) < 0) groups[f].push(p);
    });
    order.sort();
    return order.map(function (f) { return { folder: f, lessons: groups[f].slice().sort() }; });
  }

  // ---- 2. the mass send ------------------------------------------------------------------------------
  // reviews: admin_monthly_review rows ({student, summary, review}) of one or more groups (each with .group = {group, key}).
  // fns: {contacted(r) -> bool, check(r) -> {level:"ok"|"warn"|"missing", wa}, text(r) -> string}
  // -> {ready:[{r, text, to}], held:[{r, reason}], already:[r], counts:{students, ready, complete, missing, held, already}}
  //    A student in two groups is counted once (the first group wins). "complete" / "missing" are about the ready ones.
  var REASONS = { missing: "لا رقم ولي أمر", warn: "رقم ولي الأمر محتاج مراجعة", text: "الرسالة فاضية" };
  function sendPlan(reviews, fns) {
    var seen = {}, ready = [], held = [], already = [], complete = 0;
    (reviews || []).forEach(function (r) {
      var pk = String((r && r.student && r.student.phone) || "").replace(/\D/g, "").slice(-10);
      if (!pk || seen[pk]) return;
      seen[pk] = true;
      if (fns.contacted(r)) { already.push(r); return; }
      var ck = fns.check(r) || {}, text = String(fns.text(r) || "").trim();
      if (ck.level !== "ok" || !ck.wa) { held.push({ r: r, reason: REASONS[ck.level === "warn" ? "warn" : "missing"] }); return; }
      if (!text) { held.push({ r: r, reason: REASONS.text }); return; }
      var t = (r.summary && r.summary.totals) || {};
      if (!((t.quiz_missed || 0) + (t.homework_missed || 0))) complete++;
      ready.push({ r: r, text: text, to: ck.wa });
    });
    return { ready: ready, held: held, already: already,
      counts: { students: ready.length + held.length + already.length, ready: ready.length, complete: complete,
                missing: ready.length - complete, held: held.length, already: already.length } };
  }
  // ready rows -> one admin_fu2_wa_enqueue payload per group (the server dedupes and logs per row)
  function enqueuePayloads(ready, month, sendTo) {
    var by = {}, order = [];
    ready.forEach(function (x) {
      var g = x.r.group || {}, gk = g.key || "";
      if (!by[gk]) { by[gk] = { action: "admin_fu2_wa_enqueue", event: "monthly", send_to: sendTo === "parents" ? "parents" : "test", group: g.group || "", group_key: gk, items: [] }; order.push(gk); }
      by[gk].items.push({ student_key: String(x.r.student.phone || "").replace(/\D/g, "").slice(-10), student_phone: x.r.student.phone, name: x.r.student.name,
        to: x.to, text: x.text, log_items: [{ kind: "monthly", ref: month }] });
    });
    return order.map(function (k) { return by[k]; });
  }

  return { draftFrom: draftFrom, isOn: isOn, entry: entry, toggle: toggle, setPart: setPart, sameLessons: sameLessons, byFolder: byFolder,
           sendPlan: sendPlan, enqueuePayloads: enqueuePayloads, REASONS: REASONS };
});
