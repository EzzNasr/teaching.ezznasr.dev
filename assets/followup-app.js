/* ==========================================================================
   followup-app.js — page logic for dashboard/followup.html (Chunk 5).

   Built by contract only (IMPROVEMENT_PLAN.md §3 API, §4 rules):
     window.FollowupLogic      (Chunk 3, assets/followup-logic.js)
     window.FollowupTemplates  (Chunk 4, assets/followup-templates.js)
   Every assumption about a library return shape the plan leaves open lives in the
   "ADAPTERS" section below, so integration (Chunk 6) only has to look in one place.

   ?mock=1  -> loads dashboard/_fixtures/followup-overview.json, fakes the write actions in
               memory, skips sign-in. Nothing real is read or written.
   Real mode -> AuthEngine.adminCall exactly like dashboard/access.html.
   The page NEVER sends anything: the only way out is a wa.me link the owner taps.
   ========================================================================== */
(function () {
  "use strict";

  var MOCK = /[?&]mock=1\b/.test(location.search);
  var L = function () { return window.FollowupLogic || {}; };
  var T = function () { return window.FollowupTemplates || {}; };

  var DAYS_AR = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  var NONE_TAB = "__none";
  var NEG_SESSION = { session_unwatched: 1, session_locked: 1, session_unfinished: 1 };

  var STATE = {
    session: null, data: null, fetchedAt: 0, loading: false,
    tab: null, open: null, filter: "all", q: "",
    borrow: null,            // unclassified tab: group key whose lesson roles are used (local only)
    adding: {},              // group key -> true while the blank "add lesson" picker is shown
    editTime: {},            // group key -> true while the weekday/time editor is shown
    lessonQ: {},             // lesson-picker search text, by picker id
    sheetClose: null, view: null,
  };

  // ---- tiny DOM helpers ------------------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") n.className = v;
      else if (k === "value") n.value = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "object" && c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pkOf(phone) {
    var f = L().phoneKey;
    return f ? f(phone) : String(phone || "").replace(/\D/g, "").slice(-10);
  }
  function lessonSlug(p) { return String(p || "").split("/").pop(); }
  function lessonNo(p) {
    var m = /lesson-(\d+)/i.exec(lessonSlug(p));
    return m ? "الدرس " + m[1] : "";
  }
  function pretty(p) { return lessonSlug(p).replace(/-/g, " "); }

  // ---- Cairo time -----------------------------------------------------------------------------
  function cairo(date) {
    var parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return { h: +o.hour % 24, m: +o.minute };
  }
  function hhmm(date) { var c = cairo(date); return String(c.h).padStart(2, "0") + ":" + String(c.m).padStart(2, "0"); }
  function timeAr(t) {
    var m = /^(\d{2}):(\d{2})$/.exec(t || ""); if (!m) return "";
    var h = +m[1], ap = h >= 12 ? "م" : "ص";
    return ((h % 12) || 12) + ":" + m[2] + " " + ap;
  }
  function nowD() {
    var d = STATE.data;
    var base = d && d.now ? Date.parse(d.now) : Date.now();
    return new Date(base + (d ? Date.now() - STATE.fetchedAt : 0));
  }

  // ===========================================================================================
  // ADAPTERS — the only place that knows how the libraries' loosely-specified shapes look.
  //   groupDeadlines(settings, now) -> {session|next, watch, hw}  each a Date / ISO string (the deadline instant)
  //   deadlineState(now, deadline)  -> "upcoming" | "today" | "overdue"
  //   deadlineWhen(now, deadline)   -> Arabic phrase (النهارده / بكرة / يوم …)
  //   studentSummary(student, group, overview) -> {verdicts, issues, praises, needsAttendance, microChips, primaryAction}
  //   compose(summary, kind, ctx)   -> string (or {text, missing}); template overrides come in as ctx.templates
  //   buildContext({student, group, lesson, verdict, facts, deadlines, now}) -> placeholder map
  // ===========================================================================================
  function pick(o, names) {
    if (!o) return null;
    for (var i = 0; i < names.length; i++) if (o[names[i]] !== undefined && o[names[i]] !== null) return o[names[i]];
    return null;
  }
  function toDate(x) {
    if (!x) return null;
    if (x instanceof Date) return x;
    if (typeof x === "object") return toDate(pick(x, ["at", "date", "ts", "end", "iso"]));
    var d = new Date(x); return isNaN(d) ? null : d;
  }
  function deadlinesFor(g) {
    var raw = null;
    try { if (L().groupDeadlines && g.settings && g.settings.weekday !== null && g.settings.weekday !== undefined) raw = L().groupDeadlines(g.settings, nowD()); } catch (e) { raw = null; }
    var o = {
      raw: raw,
      next: toDate(pick(raw, ["session", "next", "nextSession", "next_session"])),
      watch: toDate(pick(raw, ["watch", "watchDeadline", "watch_deadline"])),
      hw: toDate(pick(raw, ["hw", "homework", "hwDeadline", "hw_deadline"])),
    };
    return o;
  }
  function dlState(d) {
    if (!d) return "none";
    try { return L().deadlineState(nowD(), d); } catch (e) { return d < nowD() ? "overdue" : "upcoming"; }
  }
  function dlWhen(d) {
    if (!d) return "";
    try { return L().deadlineWhen(nowD(), d) || ""; } catch (e) { return ""; }
  }
  function summaryFor(st, g) {
    var s = null;
    try { s = L().studentSummary(st, g, STATE.data); } catch (e) { console.error("studentSummary failed", e); }
    return s || { verdicts: {}, issues: [], praises: [], needsAttendance: false, microChips: [], primaryAction: null };
  }
  function parentCheck(st) {
    try { return L().checkParentPhone(st.parent_phone, st.phone); } catch (e) { return { ok: false, level: "missing", reason: "", wa: "" }; }
  }
  function composeMsg(summary, kind, ctx) {
    var t = T();
    var ov = STATE.data && STATE.data.templates || {};
    if (t.setTemplates) t.setTemplates(ov); else if (t.setOverrides) t.setOverrides(ov);
    var c = Object.assign({ templates: ov }, ctx);
    var r = t.compose(summary, kind, c);
    var text = typeof r === "string" ? r : (r && r.text) || "";
    var missing = (r && r.missing) || [];
    if (typeof r === "string") (text.match(/\{[a-z_]+\}/gi) || []).forEach(function (m) { if (missing.indexOf(m) < 0) missing.push(m); });
    return { text: text, missing: missing };
  }

  // ---- words -----------------------------------------------------------------------------------
  function fmtCountdown(next) {
    if (!next) return "";
    var mins = Math.round((next - nowD()) / 60000);
    if (mins < 1) return "دلوقتي";
    if (mins < 60) return "بعد " + mins + " دقيقة";
    if (mins < 60 * 24) return "بعد " + Math.round(mins / 60) + " ساعة";
    var d = Math.round(mins / 1440);
    return d === 1 ? "بعد يوم" : "بعد " + d + " أيام";
  }
  function dlTileText(state, d) {
    if (state === "overdue") return "انتهى ❗";
    if (state === "today") return "النهارده ⏰";
    if (state === "upcoming") return dlWhen(d) || "لسه بدري";
    return "—";
  }

  // ---- api -------------------------------------------------------------------------------------
  var MK = { base: null, data: null, baseCan: {} };
  function mockLoad() {
    var p = MK.data ? Promise.resolve() : fetch("_fixtures/followup-overview.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("fixture " + r.status); return r.json();
    }).then(function (j) { MK.data = j; });
    return p;
  }
  function mockOverview() {
    var d = clone(MK.data), used = {};
    d.groups.forEach(function (g) {
      if (g.settings.current_lesson) used[g.settings.current_lesson] = 1;
      (g.settings.review_lessons || []).forEach(function (r) { used[r] = 1; });
    });
    Object.keys(used).forEach(function (p) {
      if (!d.lessons[p]) {
        var a = (d.all_lessons || []).filter(function (x) { return x.path === p; })[0] || {};
        d.lessons[p] = { path: p, subject: p.split("/")[0], slug: lessonSlug(p), has_video: true, has_quiz: true, has_assignment: true,
          lesson_locked: !!a.lesson_locked, video_locked: !!a.video_locked, quiz_locked: !!a.quiz_locked };
      }
      Object.keys(d.students).forEach(function (k) {
        d.facts[k] = d.facts[k] || {};
        if (!d.facts[k][p]) d.facts[k][p] = { can_watch: true, attendance: null, watch_pct: null, quiz: { taken: false }, quiz_open: true, homework: { submitted: false } };
      });
    });
    return d;
  }
  function mockApi(payload) {
    return mockLoad().then(function () {
      var a = payload.action, d = MK.data;
      if (a === "admin_followup_overview") return mockOverview();
      if (a === "admin_followup_set_attendance") {
        var out = [];
        payload.items.forEach(function (it) {
          var k = pkOf(it.phone); d.facts[k] = d.facts[k] || {};
          var f = d.facts[k][payload.lesson] = d.facts[k][payload.lesson] || { can_watch: true, attendance: null, watch_pct: null, quiz: { taken: false }, quiz_open: true, homework: { submitted: false } };
          var bk = k + "|" + payload.lesson;
          if (!(bk in MK.baseCan)) MK.baseCan[bk] = { w: f.can_watch, q: f.quiz_open };
          f.attendance = it.mode || null;
          if (it.mode === "center") { f.can_watch = true; f.quiz_open = true; }
          else { f.can_watch = MK.baseCan[bk].w; f.quiz_open = MK.baseCan[bk].q; }
          out.push({ phone: it.phone, mode: it.mode, can_watch: f.can_watch, quiz_open: f.quiz_open });
        });
        return { ok: true, results: out };
      }
      if (a === "admin_followup_save_group") {
        var g = d.groups.filter(function (x) { return x.group === payload.group; })[0];
        if (!g) return { ok: false, error: "Group not found." };
        ["weekday", "time", "current_lesson", "review_lessons", "note", "parents_contacted", "watch_deadline_override", "hw_deadline_override"].forEach(function (k) { if (k in payload) g.settings[k] = payload[k]; });
        return { ok: true, settings: clone(g.settings) };
      }
      if (a === "admin_followup_save_templates") {
        d.templates = d.templates || {};
        Object.keys(payload.templates).forEach(function (k) { var v = payload.templates[k]; if (v) d.templates[k] = v; else delete d.templates[k]; });
        return { ok: true, templates: clone(d.templates) };
      }
      return { ok: false, error: "Unknown action" };
    });
  }
  function api(payload) {
    var p;
    if (MOCK) p = mockApi(payload);
    else if (!window.AuthEngine || typeof window.AuthEngine.adminCall !== "function") p = Promise.reject(new Error("الصفحة محتاجة أحدث assets/auth.js — شغّل Sync site assets في Quiz Maker."));
    else p = window.AuthEngine.adminCall(STATE.session, payload);
    return p.then(function (res) {
      if (res && res.ok === false) throw new Error(res.error || "حصل خطأ");
      return res;
    });
  }
  function errText(err) {
    var m = (err && err.message) || "حصل خطأ، جرّب تاني.";
    if (m === "Not authorized.") m = "الحساب ده مسجّل دخول بس مش أدمن. فعّل is_admin = TRUE في شيت Students.";
    return m;
  }

  // ---- toast / dialog / sheet ------------------------------------------------------------------
  var toastTimer = null;
  function toast(text, opt) {
    opt = opt || {};
    var host = clear($("fu-toast-host"));
    var n = el("div", { class: "fu-toast" + (opt.err ? " err" : ""), role: opt.err ? "alert" : "status" }, [el("span", {}, [text])]);
    if (opt.undo) n.appendChild(el("button", { type: "button", onclick: function () { clear(host); opt.undo(); } }, ["تراجع"]));
    host.appendChild(n);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { clear(host); }, opt.undo ? 8000 : (opt.err ? 7000 : 3500));
  }
  function confirmDialog(text, okLabel) {
    return new Promise(function (resolve) {
      var back = el("div", { class: "fu-back center", role: "presentation" });
      function done(v) { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); }
      function onKey(e) { if (e.key === "Escape") done(false); }
      var ok = el("button", { class: "fu-btn primary", type: "button", onclick: function () { done(true); } }, [okLabel || "تأكيد"]);
      back.appendChild(el("div", { class: "fu-dialog", role: "alertdialog", "aria-modal": "true" }, [
        el("p", { style: "margin:0 0 16px;font-weight:700" }, [text]),
        el("div", { class: "fu-btns two" }, [ok, el("button", { class: "fu-btn", type: "button", onclick: function () { done(false); } }, ["إلغاء"])]),
      ]));
      document.addEventListener("keydown", onKey);
      $("fu-layer").appendChild(back); ok.focus();
    });
  }
  function closeSheet() {
    var f = STATE.sheetClose; STATE.sheetClose = null;
    clear($("fu-layer")); document.body.style.overflow = "";
    if (f) f();
  }
  function openSheet(build, opts) {
    opts = opts || {};
    closeSheet();
    var returnTo = document.activeElement;
    var sheet = el("div", { class: "fu-sheet" + (opts.full ? " full" : ""), role: "dialog", "aria-modal": "true", "aria-label": opts.label || "" });
    var back = el("div", { class: "fu-back", onclick: function (e) { if (e.target === back) closeSheet(); } }, [sheet]);
    sheet.appendChild(el("div", { class: "fu-grab", "aria-hidden": "true" }));
    build(sheet);
    function onKey(e) { if (e.key === "Escape") closeSheet(); }
    document.addEventListener("keydown", onKey);
    STATE.sheetClose = function () { document.removeEventListener("keydown", onKey); if (returnTo && returnTo.focus && document.contains(returnTo)) returnTo.focus(); };
    $("fu-layer").appendChild(back);
    document.body.style.overflow = "hidden";
    var first = sheet.querySelector("a.fu-btn,button.fu-btn"); if (first) first.focus({ preventScroll: true });
  }
  function copy(text) {
    var t = T();
    var p = null;
    try { if (t.copyText) p = t.copyText(text); } catch (e) { p = null; }
    function fb() {
      var ta = el("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) {} ta.remove(); return ok;
    }
    var done = function (ok) { toast(ok ? "تم النسخ ✓" : "تعذّر النسخ — انسخ يدويًا", { err: !ok }); };
    if (p && p.then) p.then(function () { done(true); }, function () { done(fb()); });
    else if (p === true || p === undefined && t.copyText) done(true);
    else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fb()); });
    else done(fb());
  }

  // ---- data access -----------------------------------------------------------------------------
  function allGroups() { return (STATE.data && STATE.data.groups) || []; }
  function groupByKey(k) { return allGroups().filter(function (g) { return g.key === k; })[0] || null; }
  function lessonInfo(path) {
    var d = STATE.data; if (!path) return null;
    if (d.lessons && d.lessons[path]) return d.lessons[path];
    var a = (d.all_lessons || []).filter(function (x) { return x.path === path; })[0];
    return a ? { path: path, slug: lessonSlug(path), has_video: true, has_quiz: true, has_assignment: true, lesson_locked: a.lesson_locked, video_locked: a.video_locked, quiz_locked: a.quiz_locked } : null;
  }
  // The "group" the logic library sees. Unclassified borrows another group's lesson roles (local only).
  function currentGroup() {
    var d = STATE.data;
    if (STATE.tab === NONE_TAB) {
      var b = groupByKey(STATE.borrow) || allGroups()[0] || null;
      var s = b ? clone(b.settings) : { weekday: null, time: "", current_lesson: "", review_lessons: [], note: "", parents_contacted: false, watch_deadline_override: "", hw_deadline_override: "" };
      return { group: "طلاب غير مصنفين", key: NONE_TAB, unclassified: true, borrowed: b, settings: s, members: d.unclassified || [] };
    }
    return groupByKey(STATE.tab) || allGroups()[0] || null;
  }
  function studentOf(m) {
    var k = pkOf(m.phone), s = STATE.data.students[k] || {};
    return Object.assign({ phone: m.phone, name: m.name }, s, { key: k, name: m.name || s.name });
  }

  // ---- per-student actions (what the buttons are) ----------------------------------------------
  function ratio(q) { return q && q.total ? q.score / q.total * 100 : 0; }
  function buildActions(st, g, summary, dl, check) {
    var d = STATE.data, v = summary.verdicts || {}, cur = g.settings.current_lesson, facts = (d.facts[st.key] || {});
    var reviews = g.settings.review_lessons || [];
    var neg = [], pos = [];
    var multi = reviews.length > 1;
    var cf = facts[cur] || {};
    var blocked = !!summary.needsAttendance;
    var watchOver = dl.watch ? dlState(dl.watch) === "overdue" : true;
    var hwOver = dl.hw ? dlState(dl.hw) === "overdue" : true;

    var sv = v.session;
    if (sv && cur) {
      var ss = sv.state;
      if (NEG_SESSION[ss]) {
        neg.push({ kind: ss === "session_unfinished" ? "session_unfinished" : "session_unwatched", lesson: cur, verdict: sv, label: "▶ المشاهدة", due: watchOver, session: true, blocked: blocked, chip: ss });
      } else if (ss === "session_done" || (ss === "optional" && (cf.watch_pct || 0) >= d.settings.watch_done_pct)) {
        pos.push({ kind: "session_done", lesson: cur, verdict: sv, label: "✅ أنهى المشاهدة", due: true, session: true, blocked: blocked });
      }
    }
    if (blocked && sv && cur && !neg.some(function (a) { return a.session; })) {
      neg.push({ kind: "session_unwatched", lesson: cur, verdict: sv, label: "▶ المشاهدة", due: false, session: true, blocked: true, stub: true });
    }
    (v.homework || []).forEach(function (h) {
      var tag = multi ? " · " + (lessonNo(h.lesson) || pretty(h.lesson)) : "";
      if (h.state === "homework_missing") neg.push({ kind: "homework_missing", lesson: h.lesson, verdict: h, label: "📝 الواجب" + tag, due: hwOver });
      else if (h.state === "homework_done") pos.push({ kind: "homework_done", lesson: h.lesson, verdict: h, label: "🌟 شكر على الواجب" + tag, due: true });
    });
    (v.quiz || []).forEach(function (q) {
      var tag = multi ? " · " + (lessonNo(q.lesson) || pretty(q.lesson)) : "";
      if (q.state === "quiz_absent") neg.push({ kind: "quiz_absent", lesson: q.lesson, verdict: q, label: "❓ الكويز (غائب)" + tag, due: true, warn: true });
      else if (q.state === "quiz_taken") {
        var qf = (facts[q.lesson] || {}).quiz;
        if (ratio(qf) >= d.settings.praise_quiz_pct) pos.push({ kind: "quiz_praise", lesson: q.lesson, verdict: q, label: "👏 كويز ممتاز" + tag, due: true });
        else pos.push({ kind: "quiz_mark", lesson: q.lesson, verdict: q, label: "📊 نتيجة الكويز" + tag, due: true });
      }
    });
    var noPhone = check.level === "missing";
    neg.concat(pos).forEach(function (a) {
      a.disabled = noPhone || !!a.blocked;
      a.reason = noPhone ? "لا رقم ولي أمر" : (a.blocked ? "حدد الحضور أولًا" : (a.due ? "" : "لسه بدري"));
    });
    var dueNeg = neg.filter(function (a) { return a.due && !a.disabled; });
    var open = neg.filter(function (a) { return !a.blocked; });
    var primary = null, singles = [];
    if (dueNeg.length >= 2) { primary = { kind: "combined", lesson: cur, label: "💬 رسالة مجمّعة لولي الأمر (" + dueNeg.length + ")", due: true, disabled: noPhone, reason: noPhone ? "لا رقم ولي أمر" : "", issues: dueNeg }; singles = neg; }
    else if (neg.length) { primary = Object.assign({ primary: true }, dueNeg[0] || neg[0]); singles = []; if (neg.length > 1) singles = neg.filter(function (a) { return a !== (dueNeg[0] || neg[0]); }); }
    return { neg: neg, pos: pos, dueNeg: dueNeg, primary: primary, singles: singles, noPhone: noPhone, hasDue: dueNeg.length > 0, openCount: open.length };
  }

  // ---- group view (computed once per render) ---------------------------------------------------
  function computeView(g) {
    var dl = deadlinesFor(g);
    var rows = g.members.map(function (m) {
      var st = studentOf(m), sm = summaryFor(st, g), ck = parentCheck(st);
      var ac = buildActions(st, g, sm, dl, ck);
      var v = sm.verdicts || {};
      var tags = {
        unmarked: !!sm.needsAttendance,
        noparent: ck.level !== "ok",
        late: ac.hasDue,
        unwatched: !!(v.session && NEG_SESSION[v.session.state]),
        hwmissing: (v.homework || []).some(function (h) { return h.state === "homework_missing"; }),
        quizabsent: (v.quiz || []).some(function (q) { return q.state === "quiz_absent"; }),
      };
      return { st: st, sm: sm, ck: ck, ac: ac, tags: tags };
    });
    var counts = { unmarked: 0, unwatched: 0, hwmissing: 0, quizabsent: 0, noparent: 0, late: 0 };
    rows.forEach(function (r) { Object.keys(counts).forEach(function (k) { if (r.tags[k]) counts[k]++; }); });
    var cur = g.settings.current_lesson, anyTrack = false;
    rows.forEach(function (r) { var f = ((STATE.data.facts[r.st.key] || {})[cur]); if (f && f.watch_pct !== null && f.watch_pct !== undefined) anyTrack = true; });
    return { dl: dl, rows: rows, counts: counts, noTracking: !!cur && rows.length > 0 && !anyTrack, g: g };
  }

  // ---- actions: attendance / group save / templates --------------------------------------------
  function setAttendance(g, items, opts) {
    opts = opts || {};
    var lesson = g.settings.current_lesson;
    if (!lesson) { toast("اختار الحصة الحالية الأول", { err: true }); return Promise.resolve(); }
    var facts = STATE.data.facts, prev = {};
    items.forEach(function (it) {
      var k = pkOf(it.phone); facts[k] = facts[k] || {}; var f = facts[k][lesson] = facts[k][lesson] || { can_watch: true, attendance: null, watch_pct: null, quiz: { taken: false }, quiz_open: true, homework: { submitted: false } };
      prev[k] = { att: f.attendance, can: f.can_watch, qo: f.quiz_open };
      f.attendance = it.mode || null;
      if (it.mode === "center") { f.can_watch = true; f.quiz_open = true; }
    });
    refreshPage();
    return api({ action: "admin_followup_set_attendance", lesson: lesson, items: items, grant: true }).then(function (res) {
      (res.results || []).forEach(function (r) {
        var f = (facts[pkOf(r.phone)] || {})[lesson]; if (f) { f.can_watch = r.can_watch; f.quiz_open = r.quiz_open; }
      });
      refreshPage();
      if (!opts.silent) {
        var one = items.length === 1;
        var name = one ? (STATE.data.students[pkOf(items[0].phone)] || {}).name || "" : items.length + " طالب";
        var modeTxt = items[0].mode === "center" ? "سنتر" : (items[0].mode === "online" ? "أونلاين" : "غير محدد");
        toast("تم تسجيل " + name + ": " + modeTxt, { undo: function () {
          setAttendance(g, items.map(function (it) { var k = pkOf(it.phone); return { phone: it.phone, mode: prev[k].att || "" }; }), { silent: true });
        } });
      }
    }, function (err) {
      items.forEach(function (it) { var k = pkOf(it.phone), f = facts[k][lesson]; f.attendance = prev[k].att; f.can_watch = prev[k].can; f.quiz_open = prev[k].qo; });
      refreshPage(); toast(errText(err), { err: true });
    });
  }
  function saveGroup(g, patch, opts) {
    opts = opts || {};
    var real = g.unclassified ? null : g;
    if (!real) return Promise.resolve();
    var before = clone(real.settings), s = Object.assign({}, real.settings, patch);
    real.settings = s; refreshPage();
    var payload = Object.assign({ action: "admin_followup_save_group", group: real.group }, s);
    return api(payload).then(function (res) {
      if (res.settings) real.settings = res.settings;
      if (opts.reload) return load(true).then(function () { if (!opts.quiet) toast("تم الحفظ ✓"); });
      refreshPage(); if (!opts.quiet) toast("تم الحفظ ✓");
    }, function (err) { real.settings = before; refreshPage(); toast(errText(err), { err: true }); });
  }

  // ---- rendering: shell ------------------------------------------------------------------------
  function renderTabs() {
    var nav = clear($("fu-tabs")), d = STATE.data;
    if (!d) { nav.hidden = true; return; }
    nav.hidden = false;
    function tab(key, label, n) {
      var b = el("button", { class: "fu-tab", type: "button", role: "tab", "aria-selected": String(STATE.tab === key), "data-tab": key, onclick: function () { selectTab(key); } }, [label, el("small", {}, ["· " + n])]);
      nav.appendChild(b);
    }
    allGroups().forEach(function (g) { tab(g.key, g.group, g.members.length); });
    tab(NONE_TAB, "طلاب غير مصنفين", (d.unclassified || []).length);
  }
  function selectTab(key) {
    STATE.tab = key; STATE.open = null; STATE.filter = "all"; STATE.q = ""; STATE.lessonQ = {};
    try { sessionStorage.setItem("fu-tab", key); } catch (e) {}
    writeHash(); renderTabs(); renderPage(); window.scrollTo(0, 0);
  }
  function writeHash() {
    var h = (STATE.open ? "#student=" + STATE.open : "");
    try { history.replaceState(null, "", location.pathname + location.search + h); } catch (e) {}
  }
  function updatedLine() {
    var n = $("fu-updated");
    n.textContent = STATE.data ? "آخر تحديث " + hhmm(new Date(STATE.fetchedAt)) + (MOCK ? " · تجربة" : "") : "";
  }

  // ---- rendering: group page -------------------------------------------------------------------
  function lockChip(label, locked) { return el("span", { class: "fu-chip " + (locked ? "red" : "green") }, [(locked ? "🔒 " : "🔓 ") + label]); }

  function lessonPicker(id, value, onPick, lessons) {
    var q = STATE.lessonQ[id] || "";
    var opts = (lessons || []).filter(function (l) { return !q || l.path.toLowerCase().indexOf(q.toLowerCase()) >= 0 || l.path === value; });
    var sel = el("select", { class: "fu-field", id: id, "aria-label": "اختيار الدرس" });
    sel.appendChild(el("option", { value: "" }, ["— اختار الدرس —"]));
    var seen = {};
    opts.forEach(function (l) { seen[l.path] = 1; sel.appendChild(el("option", { value: l.path }, [lessonSlug(l.path)])); });
    if (value && !seen[value]) sel.appendChild(el("option", { value: value }, [lessonSlug(value)]));
    sel.value = value || "";
    sel.addEventListener("change", function () { onPick(sel.value); });
    var search = el("input", { class: "fu-field fu-search-lessons", type: "search", placeholder: "🔍 ابحث عن درس…", value: q, "aria-label": "بحث في الدروس", dir: "ltr" });
    search.addEventListener("input", function () {
      STATE.lessonQ[id] = search.value; var cur = sel.value;
      var qq = search.value.toLowerCase();
      Array.prototype.forEach.call(sel.options, function (o) { o.hidden = !!(qq && o.value && o.value !== cur && o.value.toLowerCase().indexOf(qq) < 0); });
    });
    return el("div", { class: "fu-pick" }, [search, sel]);
  }

  function nextSessionCard(g, V) {
    var s = g.settings, card = el("section", { class: "fu-card", "aria-label": "الحصة الجاية" });
    var hasTime = s.weekday !== null && s.weekday !== undefined && s.time;
    card.appendChild(el("div", { class: "fu-row fu-between" }, [
      el("div", {}, [el("div", { class: "fu-dim" }, ["الحصة الجاية"]), el("div", { class: "fu-big", id: "fu-when" }, [hasTime ? DAYS_AR[s.weekday] + " " + timeAr(s.time) : "لم يتحدد الميعاد"])]),
      el("div", { class: "fu-stack", style: "justify-items:end" }, [
        V.dl.next ? el("span", { class: "fu-chip amber", id: "fu-countdown" }, ["⏳ " + fmtCountdown(V.dl.next)]) : null,
        !g.unclassified ? el("button", { class: "fu-chip", type: "button", id: "fu-edit-time", onclick: function () { STATE.editTime[g.key] = !STATE.editTime[g.key]; refreshPage(); } }, ["✏️ تعديل الميعاد"]) : null,
      ]),
    ]));
    if (STATE.editTime[g.key] && !g.unclassified) {
      var wd = el("select", { class: "fu-field", id: "fu-wd", "aria-label": "اليوم", style: "direction:rtl;font:inherit" }, DAYS_AR.map(function (n, i) { return el("option", { value: i }, [n]); }));
      wd.value = (s.weekday === null || s.weekday === undefined) ? "6" : String(s.weekday);
      var tm = el("input", { class: "fu-field", id: "fu-time", type: "time", value: s.time || "18:00", "aria-label": "الساعة", style: "direction:ltr" });
      card.appendChild(el("div", { class: "fu-role" }, [
        el("div", { class: "fu-row" }, [el("div", { style: "flex:1" }, [wd]), el("div", { style: "flex:1" }, [tm])]),
        el("div", { style: "margin-top:10px" }, [el("button", { class: "fu-btn primary", id: "fu-save-time", type: "button", onclick: function () {
          STATE.editTime[g.key] = false; saveGroup(g, { weekday: +wd.value, time: tm.value }, { reload: false });
        } }, ["حفظ الميعاد"])]),
      ]));
    }
    function tile(label, d) {
      var st = dlState(d);
      return el("div", { class: "s-" + st, "data-dl": label }, [el("div", { class: "lbl" }, [label]), el("div", { class: "val" }, [dlTileText(st, d)])]);
    }
    card.appendChild(el("div", { class: "fu-dl" }, [tile("ميعاد المشاهدة", V.dl.watch), tile("ميعاد الواجب", V.dl.hw)]));
    return card;
  }

  function rolesCard(g, V) {
    var d = STATE.data, s = g.settings, all = d.all_lessons || [], card = el("section", { class: "fu-card", "aria-label": "الحصص" });
    var ro = !!g.unclassified;
    // role A
    var a = el("div", { class: "fu-role", id: "fu-role-a" });
    a.appendChild(el("div", { class: "fu-row fu-between" }, [el("h3", {}, ["🎬 الحصة الحالية"]), el("span", { class: "fu-dim" }, ["حضور + مشاهدة"])]));
    if (ro) a.appendChild(s.current_lesson ? el("div", { style: "margin-top:8px" }, [el("span", { class: "fu-slug" }, [lessonSlug(s.current_lesson)])]) : el("div", { class: "fu-dim" }, ["اختار جروب من «اعرض بحصص جروب»"]));
    else a.appendChild(lessonPicker("pick-current", s.current_lesson, function (v) { saveGroup(g, { current_lesson: v }, { reload: true }); }, all));
    var ci = lessonInfo(s.current_lesson);
    if (ci) a.appendChild(el("div", { class: "fu-chips", style: "margin-top:10px" }, [lockChip("الحصة", ci.lesson_locked), lockChip("الفيديو", ci.video_locked), lockChip("الكويز", ci.quiz_locked)]));
    if (V.noTracking) a.appendChild(el("div", { class: "fu-hint", id: "fu-notrack" }, ["لا توجد بيانات مشاهدة لهذه الحصة بعد"]));
    card.appendChild(a);
    // role B
    var b = el("div", { class: "fu-role", id: "fu-role-b" });
    b.appendChild(el("div", { class: "fu-row fu-between" }, [el("h3", {}, ["📝 واجب وكويز"]), el("span", { class: "fu-dim" }, ["الحصة السابقة"])]));
    var rv = (s.review_lessons || []).slice();
    rv.forEach(function (path, i) {
      var inf = lessonInfo(path);
      var row = el("div", { style: "margin-top:8px" });
      if (ro) row.appendChild(el("span", { class: "fu-slug" }, [lessonSlug(path)]));
      else {
        row.appendChild(el("div", { class: "fu-row" }, [
          el("div", { class: "grow", style: "flex:1;min-width:0" }, [lessonPicker("pick-review-" + i, path, function (v) {
            var nx = rv.slice(); if (v) nx[i] = v; else nx.splice(i, 1);
            saveGroup(g, { review_lessons: nx }, { reload: true });
          }, all)]),
          el("button", { class: "fu-ibtn", type: "button", "aria-label": "حذف الدرس", "data-remove": i, onclick: function () { var nx = rv.slice(); nx.splice(i, 1); saveGroup(g, { review_lessons: nx }, { reload: true }); } }, ["✕"]),
        ]));
      }
      if (inf) row.appendChild(el("div", { class: "fu-chips", style: "margin-top:6px" }, [lockChip("الكويز" + (rv.length > 1 ? " · " + (lessonNo(path) || "") : ""), inf.quiz_locked)]));
      b.appendChild(row);
    });
    if (!ro) {
      if (STATE.adding[g.key] || !rv.length) b.appendChild(lessonPicker("pick-review-new", "", function (v) {
        if (!v) return; STATE.adding[g.key] = false; saveGroup(g, { review_lessons: rv.concat([v]) }, { reload: true });
      }, all));
      else if (rv.length < 5) b.appendChild(el("div", { style: "margin-top:10px" }, [el("button", { class: "fu-chip", id: "fu-add-review", type: "button", onclick: function () { STATE.adding[g.key] = true; refreshPage(); } }, ["＋ إضافة درس"])]));
    }
    card.appendChild(b);
    card.appendChild(el("div", { class: "fu-hint" }, ["⚠️ حرّك الاختيارين لقدّام بعد كل حصة، وإلا مواعيد الحصة الجديدة ممكن تظهر متأخرة."]));
    return card;
  }

  function settingsCard(g) {
    var s = g.settings;
    var card = el("section", { class: "fu-card", "aria-label": "إعدادات الجروب" });
    var chk = el("input", { type: "checkbox", id: "fu-contacted", role: "switch" }); chk.checked = !!s.parents_contacted;
    chk.addEventListener("change", function () { saveGroup(g, { parents_contacted: chk.checked }, { quiet: true }); });
    card.appendChild(el("label", { class: "fu-switch" }, [el("span", {}, ["تم التواصل مع أولياء الأمور"]), chk, el("span", { class: "trk", "aria-hidden": "true" })]));
    var note = el("textarea", { class: "fu-field", id: "fu-note", "aria-label": "ملاحظات الجروب", placeholder: "ملاحظات الجروب…" }); note.value = s.note || "";
    var wo = el("input", { class: "fu-field", type: "date", id: "fu-wo", value: s.watch_deadline_override || "", "aria-label": "تاريخ بديل لميعاد المشاهدة", style: "direction:ltr" });
    var ho = el("input", { class: "fu-field", type: "date", id: "fu-ho", value: s.hw_deadline_override || "", "aria-label": "تاريخ بديل لميعاد الواجب", style: "direction:ltr" });
    var det = el("details", { class: "fu-det" }, [el("summary", {}, ["ملاحظات الجروب"]),
      note,
      el("div", { class: "fu-row", style: "margin-top:10px" }, [
        el("label", { style: "flex:1;min-width:140px" }, [el("span", { class: "fu-label" }, ["بديل ميعاد المشاهدة"]), wo]),
        el("label", { style: "flex:1;min-width:140px" }, [el("span", { class: "fu-label" }, ["بديل ميعاد الواجب"]), ho]),
      ]),
      el("div", { style: "margin-top:10px" }, [el("button", { class: "fu-btn primary", id: "fu-save-settings", type: "button", onclick: function () {
        saveGroup(g, { note: note.value, watch_deadline_override: wo.value, hw_deadline_override: ho.value }, { reload: false });
      } }, ["حفظ"])]),
    ]);
    if (s.note || s.watch_deadline_override || s.hw_deadline_override) det.open = true;
    card.appendChild(det);
    return card;
  }

  function borrowCard() {
    var sel = el("select", { class: "fu-field", id: "fu-borrow", "aria-label": "اعرض بحصص جروب", style: "direction:rtl;font:inherit" },
      allGroups().map(function (g) { return el("option", { value: g.key }, [g.group]); }));
    sel.value = (groupByKey(STATE.borrow) || allGroups()[0] || {}).key || "";
    sel.addEventListener("change", function () { STATE.borrow = sel.value; STATE.open = null; refreshPage(); });
    return el("section", { class: "fu-card" }, [el("label", {}, [el("span", { class: "fu-label" }, ["اعرض بحصص جروب ▾"]), sel]),
      el("div", { class: "fu-hint" }, ["الاختيار ده محلي ومش بيتحفظ — بيحدد بس الحصة الحالية وحصة الواجب والكويز المستخدمة في الحالات تحت."])]);
  }

  function groupActions(g, V) {
    var wrap = el("div", { class: "fu-stack", style: "margin-bottom:14px" });
    wrap.appendChild(el("button", { class: "fu-btn primary", id: "fu-reminder", type: "button", onclick: function () { openReminder(g, V); } }, ["📣 رسالة تذكير للجروب"]));
    wrap.appendChild(el("button", { class: "fu-btn", id: "fu-copy-names", type: "button", onclick: function () { copyMissingNames(V); } }, ["📋 نسخ أسماء اللي لسه ما سلّموش"]));
    var cur = g.settings.current_lesson;
    wrap.appendChild(el("div", { class: "fu-btns two" }, [
      el("button", { class: "fu-btn", id: "fu-all-center", type: "button", onclick: function () { bulk(g, "center"); } }, ["الكل سنتر"]),
      el("button", { class: "fu-btn", id: "fu-all-online", type: "button", onclick: function () { bulk(g, "online"); } }, ["الكل أونلاين"]),
    ]));
    if (!cur) wrap.lastChild.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    return wrap;
  }
  function bulk(g, mode) {
    var n = g.members.length;
    confirmDialog("تسجيل " + n + " طالب كـ «" + (mode === "center" ? "سنتر" : "أونلاين") + "»؟" + (mode === "center" ? " هيتفتح الفيديو والكويز مجانًا للكل." : ""), "تأكيد").then(function (ok) {
      if (ok) setAttendance(g, g.members.map(function (m) { return { phone: m.phone, mode: mode }; }));
    });
  }
  function missingNames(V) {
    return V.rows.filter(function (r) { return r.tags.hwmissing; }).map(function (r) { return r.st.name; });
  }
  function copyMissingNames(V) {
    var names = missingNames(V);
    if (!names.length) { toast("كله سلّم الواجب 🎉"); return; }
    copy(names.join("\n"));
  }

  function bannerAndTiles(V) {
    var f = document.createDocumentFragment(), c = V.counts;
    if (c.unmarked > 0) f.appendChild(el("button", { class: "fu-banner", id: "fu-unmarked", type: "button", onclick: function () { STATE.filter = "unmarked"; STATE.open = null; refreshPage(); } }, ["⚠️ " + c.unmarked + " " + (c.unmarked === 1 ? "طالب" : "طلاب") + " لم يتم تحديد حضورهم"]));
    var t = el("div", { class: "fu-tiles" });
    [["unwatched", "لم يشاهدوا"], ["hwmissing", "واجب ناقص"], ["quizabsent", "غياب كويز"]].forEach(function (x) {
      t.appendChild(el("button", { class: "fu-tile" + (c[x[0]] ? "" : " zero"), type: "button", "data-tile": x[0], "aria-pressed": String(STATE.filter === x[0]), onclick: function () {
        STATE.filter = STATE.filter === x[0] ? "all" : x[0]; STATE.open = null; refreshPage();
      } }, [el("b", {}, [String(c[x[0]])]), el("span", {}, [x[1]])]));
    });
    f.appendChild(t);
    return f;
  }

  // ---- rendering: student list -----------------------------------------------------------------
  var FILTERS = [["all", "الكل"], ["late", "متأخرين"], ["noparent", "بدون رقم ولي أمر"], ["unmarked", "غير محدد الحضور"]];
  function listHead(V) {
    var f = document.createDocumentFragment();
    f.appendChild(el("div", { class: "fu-listhead" }, [el("h2", { id: "fu-count" }, ["الطلاب · " + V.rows.length])]));
    var inp = el("input", { type: "search", id: "fu-q", placeholder: "🔍 ابحث بالاسم…", value: STATE.q, "aria-label": "بحث بالاسم أو الرقم", autocomplete: "off" });
    inp.addEventListener("input", function () { STATE.q = inp.value; renderRows(V); });
    f.appendChild(el("div", { class: "fu-search" }, [inp]));
    var chips = el("div", { class: "fu-filters", role: "group", "aria-label": "فلتر" });
    FILTERS.forEach(function (x) {
      chips.appendChild(el("button", { class: "fu-chip", type: "button", "data-filter": x[0], "aria-pressed": String(STATE.filter === x[0]), onclick: function () { STATE.filter = x[0]; STATE.open = null; refreshPage(); } }, [x[1]]));
    });
    f.appendChild(chips);
    return f;
  }
  function passFilter(r) {
    var f = STATE.filter;
    if (f !== "all" && !r.tags[f]) return false;
    var q = (STATE.q || "").trim().toLowerCase();
    if (!q) return true;
    return r.st.name.toLowerCase().indexOf(q) >= 0 || String(r.st.phone).indexOf(q.replace(/\D/g, "") || "\u0000") >= 0;
  }
  function microChips(r) {
    var chips = el("div", { class: "fu-chips chips" });
    (r.sm.microChips || []).forEach(function (c) { chips.appendChild(el("span", { class: "fu-chip t-" + (c.tone || "grey"), "data-chip": c.key }, [c.label])); });
    var hasParentChip = (r.sm.microChips || []).some(function (c) { return /parent|phone/i.test(c.key || ""); });
    if (!hasParentChip && r.ck.level === "missing") chips.appendChild(el("span", { class: "fu-chip red", "data-chip": "parent" }, ["⚠️ لا رقم ولي أمر"]));
    else if (!hasParentChip && r.ck.level === "warn") chips.appendChild(el("span", { class: "fu-chip amber", "data-chip": "parent" }, ["⚠️ راجع رقم ولي الأمر"]));
    return chips;
  }
  function msgButton(r, g, a, V, primary) {
    var cls = "fu-btn" + (a.reason ? " has-reason" : "") + (primary ? " wa" : "") + (a.warn && !primary ? " warn" : "") + (!a.due && !a.disabled ? " muted" : "");
    var kids = [a.label];
    if (a.reason) kids.push(el("small", {}, [a.reason]));
    var b = el("button", { class: cls, type: "button", "data-kind": a.kind, disabled: a.disabled ? "" : null, "aria-disabled": a.disabled ? "true" : null, onclick: function () { if (!a.disabled) openMessage(r, g, a, V); } }, kids);
    return b;
  }
  function studentBody(r, g, V) {
    var d = STATE.data, s = g.settings, cur = s.current_lesson, st = r.st, facts = d.facts[st.key] || {};
    var body = el("div", { class: "fu-stu-body", id: "fu-body-" + st.key });
    // section A
    if (cur) {
      var f = facts[cur] || {}, info = lessonInfo(cur) || {};
      var A = el("div", { class: "fu-sec", "data-sec": "current" });
      A.appendChild(el("h4", {}, [el("span", {}, ["🎬 الحصة الحالية"]), lessonNo(cur) ? el("span", { class: "fu-dim" }, [lessonNo(cur)]) : null]));
      A.appendChild(el("div", { style: "margin-bottom:10px" }, [el("span", { class: "fu-slug" }, [lessonSlug(cur)])]));
      var seg = el("div", { class: "fu-seg", role: "radiogroup", "aria-label": "الحضور" });
      [["online", "أونلاين"], ["center", "سنتر"]].forEach(function (x) {
        seg.appendChild(el("button", { type: "button", role: "radio", "aria-checked": String(f.attendance === x[0]), "data-att": x[0], onclick: function () {
          if (f.attendance === x[0]) return; setAttendance(g, [{ phone: st.phone, mode: x[0] }]);
        } }, [x[1]]));
      });
      A.appendChild(seg);
      if (!f.attendance) A.appendChild(el("div", { class: "fu-hint", style: "background:var(--fu-warn-bg);color:var(--fu-warn)" }, ["⚠️ الحضور غير محدد"]));
      if (f.attendance === "center") A.appendChild(el("div", { class: "fu-chips", style: "margin-top:10px" }, [el("span", { class: "fu-chip green" }, ["🔓 الفيديو والكويز مفتوحين مجانًا"])]));
      var watch = el("div", { style: "margin-top:12px", "data-watch": "" });
      var pct = f.watch_pct;
      if (f.attendance === "center") watch.appendChild(el("div", { class: "fu-dim" }, ["المشاهدة اختيارية" + (pct !== null && pct !== undefined ? " — اتشاف منها " + pct + "%" : "")]));
      else if (f.can_watch === false) watch.appendChild(el("div", { class: "fu-chips" }, [el("span", { class: "fu-chip red" }, ["🔒 الفيديو مقفول"])]));
      else if (pct === null || pct === undefined) watch.appendChild(el("div", { class: "fu-dim" }, ["لا توجد بيانات"]));
      else {
        watch.appendChild(el("div", { class: "fu-row fu-between" }, [el("span", { class: "fu-label" }, ["مشاهدة الحصة: " + pct + "%"]), el("span", { class: "fu-dim" }, ["المطلوب " + d.settings.watch_done_pct + "%"])]));
        watch.appendChild(el("div", { class: "fu-bar", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }, [el("i", { style: "width:" + Math.min(100, pct) + "%" }), el("u", { style: "inset-inline-start:" + d.settings.watch_done_pct + "%" })]));
      }
      A.appendChild(watch);
      if (info.has_video === false) A.appendChild(el("div", { class: "fu-dim" }, ["الحصة دي ملهاش فيديو"]));
      body.appendChild(A);
    }
    // section B (one sub-block per review lesson)
    (s.review_lessons || []).forEach(function (path) {
      var f = facts[path] || {}, info = lessonInfo(path) || {}, B = el("div", { class: "fu-sec", "data-sec": "review" });
      B.appendChild(el("h4", {}, [el("span", {}, ["📝 واجب وكويز"]), lessonNo(path) ? el("span", { class: "fu-dim" }, [lessonNo(path)]) : null]));
      B.appendChild(el("div", { style: "margin-bottom:8px" }, [el("span", { class: "fu-slug" }, [lessonSlug(path)])]));
      if (info.has_assignment !== false) {
        var ok = f.homework && f.homework.submitted;
        B.appendChild(el("div", { class: "fu-kv" }, [el("span", {}, ["الواجب"]), el("span", { class: "fu-chip " + (ok ? "green" : "red"), "data-hw": ok ? "done" : "missing" }, [ok ? "✓ تم" : "✕ لم يُسلَّم"])]));
      }
      if (info.has_quiz !== false) {
        var q = f.quiz || {};
        if (q.taken) B.appendChild(el("div", { class: "fu-kv" }, [el("span", {}, ["الكويز"]), el("span", { class: "fu-chip " + (ratio(q) >= d.settings.praise_quiz_pct ? "green" : "grey"), "data-quiz": "taken" }, ["❓ " + q.score + " / " + q.total])]));
        else B.appendChild(el("div", { class: "fu-absent", "data-quiz": "absent", role: "status" }, ["⚠️ غائب عن الكويز – تعويض"]));
      }
      body.appendChild(B);
    });
    // parent phone
    var ck = r.ck, ph = el("div", { class: "fu-phone" }, [el("span", {}, ["ولي الأمر"]), ck.level === "missing" ? el("span", {}, ["—"]) : el("bdi", {}, [st.parent_phone || ""]), ck.level === "ok" ? el("span", { class: "fu-chip green" }, ["✓"]) : null]);
    body.appendChild(ph);
    if (ck.level !== "ok") body.appendChild(el("div", { class: "fu-warnbox", id: "fu-phonewarn", role: "alert" }, ["⚠️ " + (ck.level === "missing" ? "لا يوجد رقم ولي أمر — أزرار الرسائل متوقفة. " : "راجع الرقم قبل الإرسال. ") + (ck.reason || "")]));
    // message buttons
    var ac = r.ac, btns = el("div", { class: "fu-btns", "data-buttons": "" });
    if (ac.primary) btns.appendChild(msgButton(r, g, ac.primary, V, true));
    if (ac.singles.length) {
      var row = el("div", { class: "fu-btns two" }); ac.singles.forEach(function (a) { row.appendChild(msgButton(r, g, a, V, false)); }); btns.appendChild(row);
    }
    if (ac.pos.length) {
      var prow = el("div", { class: "fu-btns two" }); ac.pos.forEach(function (a) { prow.appendChild(msgButton(r, g, a, V, false)); }); btns.appendChild(prow);
    }
    if (btns.childNodes.length) body.appendChild(btns);
    return body;
  }
  function renderRows(V) {
    var host = clear($("fu-rows")), shown = V.rows.filter(passFilter);
    if ($("fu-count")) $("fu-count").textContent = "الطلاب · " + shown.length + (shown.length !== V.rows.length ? " / " + V.rows.length : "");
    if (!shown.length) { host.appendChild(el("div", { class: "fu-empty" }, [V.rows.length ? "مفيش طلاب بالفلتر ده" : "مفيش طلاب في الجروب ده"])); return; }
    shown.forEach(function (r) {
      var st = r.st, open = STATE.open === st.key;
      var head = el("button", { class: "fu-stu-head", type: "button", "aria-expanded": String(open), "aria-controls": "fu-body-" + st.key, onclick: function () { toggleStudent(st.key); } }, [
        el("span", { class: "fu-av", "aria-hidden": "true" }, [(st.name || "?").trim().charAt(0).toUpperCase()]),
        el("span", { class: "fu-stu-main" }, [el("div", { class: "fu-stu-name" }, [st.name]), microChips(r)]),
        el("span", { class: "fu-chev", "aria-hidden": "true" }, [open ? "⌃" : "⌄"]),
      ]);
      var card = el("div", { class: "fu-stu" + (open ? " open" : ""), id: "stu-" + st.key, "data-pk": st.key }, [head]);
      if (open) card.appendChild(studentBody(r, V.g, V));
      host.appendChild(card);
    });
  }
  function toggleStudent(pk) {
    STATE.open = STATE.open === pk ? null : pk; writeHash();
    renderRows(STATE.view);
    if (STATE.open) { var n = $("stu-" + pk); if (n && n.scrollIntoView) n.scrollIntoView({ block: "start", behavior: "smooth" }); }
  }

  // ---- messages --------------------------------------------------------------------------------
  function isLate() { var h = cairo(nowD()).h; return h >= 22 || h < 6; }
  function openMessage(r, g, a, V) {
    var st = r.st, ctx, res, err = null;
    try {
      ctx = { student: st, group: g, lesson: a.lesson, facts: (STATE.data.facts[st.key] || {})[a.lesson] || null, deadlines: V.dl.raw, now: nowD(), lessons: STATE.data.lessons };
      var sm = Object.assign({}, r.sm, { dueIssues: (a.issues || []).map(function (i) { return { kind: i.kind, lesson: i.lesson }; }) });
      res = composeMsg(sm, a.kind, ctx);
    } catch (e) { console.error(e); err = e; res = { text: "", missing: [] }; }
    var digits = r.ck.wa || (L().waDigits ? L().waDigits(st.parent_phone) : "");
    var title = a.kind === "combined" ? "رسالة مجمّعة" : a.label.replace(/^[^\s]+\s/, "");
    openSheet(function (sheet) {
      var link = el("a", { class: "fu-btn wa", id: "fu-wa-open", target: "_blank", rel: "noopener", href: "#" }, ["فتح واتساب ↗"]);
      var bubble = el("div", { class: "fu-bubble", id: "fu-preview", dir: "auto" });
      var ta = el("textarea", { class: "fu-field fu-msg-edit", id: "fu-msg-text", dir: "auto", "aria-label": "نص الرسالة" }); ta.value = res.text;
      function sync() {
        try { bubble.innerHTML = T().formatPreview(ta.value); } catch (e) { bubble.textContent = ta.value; }
        link.href = digits && T().waLink ? T().waLink(digits, ta.value) : "#";
      }
      ta.addEventListener("input", sync);
      sheet.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, [title + " · " + st.name]), el("span", { class: "fu-chip green", id: "fu-recipient" }, ["ولي الأمر ", el("bdi", { style: "direction:ltr" }, [st.parent_phone || ""])])]));
      if (r.ck.level === "warn") sheet.appendChild(el("div", { class: "fu-warnbox" }, ["⚠️ راجع رقم ولي الأمر قبل الإرسال. " + (r.ck.reason || "")]));
      if (err) sheet.appendChild(el("div", { class: "fu-warnbox", role: "alert" }, ["تعذّر تجهيز الرسالة: " + err.message]));
      if (res.missing.length) sheet.appendChild(el("div", { class: "fu-warnbox", id: "fu-missing" }, ["متغيرات غير معروفة في القالب: " + res.missing.join(" ")]));
      if (isLate()) sheet.appendChild(el("div", { class: "fu-hint", id: "fu-late" }, ["🌙 الوقت متأخر — يُفضّل الإرسال بكرة."]));
      sheet.appendChild(bubble);
      sheet.appendChild(el("label", {}, [el("span", { class: "fu-dim" }, ["✏️ تقدر تعدّل النص قبل الإرسال — التعديل للرسالة دي بس."]), ta]));
      sheet.appendChild(el("div", { class: "fu-dim", style: "margin:6px 0 12px" }, ["النجمة * = خط عريض في واتساب"]));
      sync();
      sheet.appendChild(el("div", { class: "fu-stack" }, [link, el("div", { class: "fu-btns two" }, [
        el("button", { class: "fu-btn", id: "fu-copy", type: "button", onclick: function () { copy(ta.value); } }, ["📋 نسخ"]),
        el("button", { class: "fu-btn", id: "fu-close", type: "button", onclick: closeSheet }, ["إغلاق"]),
      ])]));
    }, { label: "الرسالة" });
  }
  function openReminder(g, V) {
    var res, err = null, rv = g.settings.review_lessons || [];
    try {
      var ctx = { student: {}, group: g, lesson: rv[0] || g.settings.current_lesson, verdicts: null, facts: null, deadlines: V.dl.raw, now: nowD(), lessons: STATE.data && STATE.data.lessons };
      res = composeMsg(null, "group_reminder", ctx);
    } catch (e) { console.error(e); err = e; res = { text: "", missing: [] }; }
    var st = dlState(V.dl.hw), stTxt = { upcoming: "قبل الميعاد", today: "النهارده", overdue: "انتهى", none: "بدون ميعاد" }[st];
    var names = missingNames(V);
    openSheet(function (sheet) {
      sheet.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, ["تذكير الجروب · " + g.group]), el("span", { class: "fu-chip " + (st === "overdue" ? "red" : st === "today" ? "amber" : "green"), id: "fu-reminder-state" }, [stTxt])]));
      if (err) sheet.appendChild(el("div", { class: "fu-warnbox", role: "alert" }, ["تعذّر تجهيز الرسالة: " + err.message]));
      if (res.missing.length) sheet.appendChild(el("div", { class: "fu-warnbox" }, ["متغيرات غير معروفة في القالب: " + res.missing.join(" ")]));
      var bubble = el("div", { class: "fu-bubble", id: "fu-preview", dir: "auto" });
      try { bubble.innerHTML = T().formatPreview(res.text); } catch (e) { bubble.textContent = res.text; }
      sheet.appendChild(bubble);
      sheet.appendChild(el("div", { class: "fu-dim", style: "margin-bottom:12px" }, ["الجروبات مفيهاش رابط مباشر — اضغط «نسخ» والصق الرسالة في جروب واتساب."]));
      sheet.appendChild(el("div", { class: "fu-stack" }, [
        el("button", { class: "fu-btn primary", id: "fu-copy", type: "button", onclick: function () { copy(res.text); } }, ["📋 نسخ الرسالة"]),
        el("button", { class: "fu-btn", id: "fu-copy-names2", type: "button", onclick: function () { if (names.length) copy(names.join("\n")); else toast("كله سلّم الواجب 🎉"); } }, ["📋 نسخ أسماء اللي لسه ما سلّموش (" + names.length + ")"]),
        el("button", { class: "fu-btn", id: "fu-close", type: "button", onclick: closeSheet }, ["إغلاق"]),
      ]));
    }, { label: "تذكير الجروب" });
  }
  function openTemplates() {
    var g = currentGroup(), V = STATE.view, sample = {};
    try {
      var r = V && V.rows[0];
      if (r && g) sample = T().buildContext({ student: r.st, group: g, lesson: g.settings.current_lesson, verdict: (r.sm.verdicts || {}).session || null, facts: (STATE.data.facts[r.st.key] || {})[g.settings.current_lesson] || null, deadlines: V.dl.raw, now: nowD() });
    } catch (e) { sample = {}; }
    openSheet(function (sheet) {
      sheet.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, ["قوالب الرسائل"]), el("button", { class: "fu-ibtn", id: "fu-close", type: "button", "aria-label": "إغلاق", onclick: closeSheet }, ["✕"])]));
      var host = el("div", { id: "fu-editor", style: "margin-top:12px" });
      sheet.appendChild(host);
      if (!T().mountEditor) { host.appendChild(el("div", { class: "fu-err" }, ["محرر القوالب غير متاح (followup-templates.js)."])); return; }
      T().mountEditor(host, { templates: clone(STATE.data.templates || {}), defaults: T().DEFAULTS, sample: sample,
        onSave: function (changes) {
          return api({ action: "admin_followup_save_templates", templates: changes }).then(function (res) {
            STATE.data.templates = res.templates || {}; toast("تم حفظ القوالب ✓"); return res;
          }, function (err) { toast(errText(err), { err: true }); throw err; });
        } });
    }, { full: true, label: "قوالب الرسائل" });
  }
  function openHelp() {
    openSheet(function (sheet) {
      sheet.appendChild(el("h2", {}, ["قواعد الرسائل"]));
      sheet.appendChild(el("ol", { class: "fu-help" }, [
        "الإرسال يدوي بس — مفيش بوتات ولا أتمتة غير رسمية لواتساب (خطر حظر الحساب).",
        "ما تبعتش عشرات الرسائل في دقايق — وزّعها.",
        "تجنّب الإرسال متأخر بالليل (بعد 10 مساءً بتوقيت القاهرة).",
        "رسالة الجروب الأول، ورسالة ولي الأمر بعد الميعاد بس.",
        "بيانات الطلاب وأولياء الأمور تفضل ورا تسجيل دخول الأدمن، ومتتحطش في الريبو.",
      ].map(function (t) { return el("li", {}, [t]); })));
      sheet.appendChild(el("button", { class: "fu-btn", id: "fu-close", type: "button", onclick: closeSheet }, ["تمام"]));
    }, { label: "قواعد الرسائل" });
  }

  // ---- render orchestration --------------------------------------------------------------------
  function renderLoading() {
    var r = clear($("fu-root"));
    for (var i = 0; i < 4; i++) r.appendChild(el("div", { class: "fu-skel", "aria-hidden": "true" }));
    r.appendChild(el("span", { class: "fu-dim", role: "status" }, ["جاري التحميل…"]));
  }
  function renderError(msg, retry) {
    var r = clear($("fu-root"));
    r.appendChild(el("div", { class: "fu-err", role: "alert", id: "fu-error" }, [msg]));
    if (retry) r.appendChild(el("div", { style: "margin-top:12px" }, [el("button", { class: "fu-btn primary", type: "button", onclick: retry }, ["حاول تاني"])]));
  }
  function renderPage() {
    var d = STATE.data, root = clear($("fu-root"));
    if (!d) return;
    updatedLine();
    var g = currentGroup();
    if (!g) { root.appendChild(el("div", { class: "fu-empty" }, ["مفيش جروبات لسه. أضف جروبات من لوحة Groups الأول."])); return; }
    var V = STATE.view = computeView(g);
    if (d.lessons_error) root.appendChild(el("div", { class: "fu-warnbox", id: "fu-lessons-error", role: "alert" }, ["⚠️ تعذّر تحميل قائمة الدروس من GitHub — قد تكون القائمة ناقصة. (" + (typeof d.lessons_error === "string" ? d.lessons_error : "") + ")"]));
    if (g.unclassified) root.appendChild(borrowCard());
    if (!g.unclassified || (g.settings && g.settings.weekday !== null && g.settings.weekday !== undefined)) root.appendChild(nextSessionCard(g, V));
    root.appendChild(rolesCard(g, V));
    if (!g.unclassified) root.appendChild(settingsCard(g));
    root.appendChild(bannerAndTiles(V));
    if (!g.unclassified) root.appendChild(groupActions(g, V));
    root.appendChild(listHead(V));
    root.appendChild(el("div", { id: "fu-rows" }));
    renderRows(V);
  }
  function refreshPage() {
    var y = window.scrollY, ae = document.activeElement, id = ae && ae.id, keepQ = id === "fu-q";
    renderPage(); window.scrollTo(0, y);
    if (keepQ && $("fu-q")) $("fu-q").focus();
  }

  function load(quiet) {
    if (!quiet) renderLoading();
    STATE.loading = true; $("fu-refresh").style.opacity = ".6";
    return api({ action: "admin_followup_overview" }).then(function (data) {
      STATE.loading = false; $("fu-refresh").style.opacity = "";
      STATE.data = data; STATE.fetchedAt = Date.now();
      if (!STATE.tab || (STATE.tab !== NONE_TAB && !groupByKey(STATE.tab))) {
        var t0 = null; try { t0 = sessionStorage.getItem("fu-tab"); } catch (e) {}
        STATE.tab = (t0 && (t0 === NONE_TAB || groupByKey(t0))) ? t0 : (allGroups()[0] ? allGroups()[0].key : NONE_TAB);
      }
      if (!STATE.borrow) STATE.borrow = allGroups()[0] ? allGroups()[0].key : null;
      var m = /student=(\d+)/.exec(location.hash);
      if (m && !STATE.open && !quiet) {
        STATE.open = m[1];
        var hg = allGroups().filter(function (g) { return g.members.some(function (x) { return pkOf(x.phone) === m[1]; }); })[0];
        if (hg) STATE.tab = hg.key; else if ((data.unclassified || []).some(function (x) { return pkOf(x.phone) === m[1]; })) STATE.tab = NONE_TAB;
      }
      renderTabs(); refreshPage();
      if (m && STATE.open && !quiet) { var n = $("stu-" + STATE.open); if (n) n.scrollIntoView({ block: "start" }); }
    }, function (err) {
      STATE.loading = false; $("fu-refresh").style.opacity = "";
      if (quiet && STATE.data) { toast(errText(err), { err: true }); return; }
      renderError(errText(err), function () { load(false); });
    });
  }

  // ---- boot ------------------------------------------------------------------------------------
  function bindChrome() {
    $("fu-refresh").addEventListener("click", function () { if (!STATE.loading) load(true).then(function () { toast("تم التحديث ✓"); }); });
    $("fu-help").addEventListener("click", openHelp);
    $("fu-templates").addEventListener("click", openTemplates);
    window.addEventListener("hashchange", function () {
      var m = /student=(\d+)/.exec(location.hash);
      if (STATE.data && m && STATE.open !== m[1]) { STATE.open = m[1]; refreshPage(); }
    });
  }
  function start(session) {
    STATE.session = session;
    $("fu-refresh").hidden = false; $("fu-templates").hidden = false;
    if (MOCK) $("fu-mock").hidden = false;
    load(false);
  }
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("لم يتم تحميل " + src)); }; document.head.appendChild(s); });
  }
  function boot() {
    bindChrome();
    var missing = [];
    if (!window.FollowupLogic) missing.push("assets/followup-logic.js");
    if (!window.FollowupTemplates) missing.push("assets/followup-templates.js");
    if (missing.length) { renderError("ملفات ناقصة: " + missing.join("، ") + " — شغّل Chunk 3 / Chunk 4 أو ادمجهم الأول."); return; }
    if (MOCK) { start(null); return; }
    clear($("fu-root")).appendChild(el("span", { class: "fu-dim" }, ["جاري التحقق من تسجيل الدخول…"]));
    loadScript("/assets/auth.js").then(function () {
      window.AuthEngine.mount("#authgate", function (session) {
        var gate = $("authgate"); if (gate) gate.remove();
        if (!session.session_token) {
          var btn = el("button", { class: "fu-btn primary", type: "button", onclick: function () { window.AuthEngine.clearSession(); location.reload(); } }, ["سجّل خروج وادخل تاني ←"]);
          var r = clear($("fu-root")); r.appendChild(el("div", { class: "fu-err" }, ["تسجيل الدخول المحفوظ ناقصه رمز الجلسة. ادخل تاني (الرقم والباسورد زي ما هم)."])); r.appendChild(btn); return;
        }
        // Convenience only: the server re-checks is_admin on every call.
        if (session.is_admin === false) { location.href = "student.html"; return; }
        start(session);
      });
    }, function (e) { renderError(e.message); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
