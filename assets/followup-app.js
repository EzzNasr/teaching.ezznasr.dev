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
    contact: "all",          // parent-contact filter: "all" | "pending" (not contacted) | "contacted"   (kept in the URL hash: cf=)
    sort: "default",         // "default" | "nc" = not-contacted first, then most problems (kept in the URL hash: sort=nc)
    hashRead: false,
    borrow: null,            // unclassified tab: group key whose lesson roles are used (local only)
    adding: {},              // group key -> true while the blank "add lesson" picker is shown
    editTime: {},            // group key -> true while the weekday/time editor is shown
    lessonQ: {},             // lesson-picker search text, by picker id
    sheetClose: null, view: null,
    year: "all",             // global Senior filter: "all" | "1" | "2"  (persisted in localStorage)
  };
  var TITLES = {};           // lesson path -> real lesson name (assets/lesson-titles.json, built by tools/seo/seo_build.py)
  var YEARS = [{ k: "1", label: "سينيور 1" }, { k: "2", label: "سينيور 2" }];
  try { var y0 = localStorage.getItem("fu-year"); if (y0 === "1" || y0 === "2") STATE.year = y0; } catch (e) {}

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
    var slug = lessonSlug(p), c = /chapter-(\d+)/i.exec(slug), m = /lesson-(\d+)/i.exec(slug);
    if (!m) return "";
    return (c ? "الفصل " + c[1] + " · " : "") + "الدرس " + m[1];
  }
  function pretty(p) { return lessonTitle(p); }

  // ---- lesson names (never show the folder slug when a real name is known) -----------------------
  function titleCase(t) { return t.replace(/\b([a-z])([a-z]*)/g, function (_, a, b) { return a.toUpperCase() + b; }); }
  // "Chapter 2 Lesson 1 – Personal information" -> "Personal information"
  function stripNumbering(t) { return String(t || "").replace(/^\s*(chapter\s*\d+\s*)?lesson\s*\d+\s*[\u2013\u2014:\-]*\s*/i, "").trim(); }
  function lessonTitle(p) {
    if (!p) return "";
    var t = TITLES[p];
    if (t) return stripNumbering(t) || t;
    var slug = lessonSlug(p).replace(/^chapter-\d+-/i, "").replace(/^lesson-\d+-?/i, "");   // unknown lesson: tidy the slug
    return titleCase(slug.replace(/-/g, " ").trim());
  }
  // "Ch 2 · L1 — Personal information"
  function lessonLabel(p) {
    if (!p) return "";
    var slug = lessonSlug(p), c = /chapter-(\d+)/i.exec(slug), m = /lesson-(\d+)/i.exec(slug);
    var num = (c ? "Ch " + c[1] + (m ? " · " : "") : "") + (m ? "L" + m[1] : "");
    var t = lessonTitle(p);
    return num && t ? num + " \u2014 " + t : (t || num);
  }
  function lessonChip(p) { return el("span", { class: "fu-lname", dir: "ltr", title: lessonSlug(p) }, [lessonLabel(p)]); }
  function loadTitles() {
    return fetch("/assets/lesson-titles.json", { cache: "no-cache" }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) { TITLES = j || {}; }, function () { TITLES = {}; });
  }

  // ---- year (Senior 1 / Senior 2) ----------------------------------------------------------------
  function yearOfStudent(st) {
    var t = String((st && st.year) || "").replace(/[\u0661\u0662]/g, function (c) { return c === "\u0661" ? "1" : "2"; });
    var m = /(^|\D)([12])(\D|$)/.exec(t);
    return m ? m[2] : "";
  }
  function yearOfLesson(p) { var m = /grade-([12])-secondary/i.exec(p || ""); return m ? m[1] : ""; }   // Programming only; others have no year
  function yearLabel(k) { return k === "all" ? "الكل" : "سينيور " + k; }
  function setYear(k) {
    STATE.year = k; STATE.open = null; STATE.filter = "all"; STATE.q = "";
    try { localStorage.setItem("fu-year", k); } catch (e) {}
    if (STATE.data) {
      var tabs = visibleTabKeys();
      if (tabs.length && tabs.indexOf(STATE.tab) < 0) STATE.tab = tabs[0];   // nothing visible: keep the tab so switching back restores it
      if (STATE.borrow && visibleGroups().every(function (g) { return g.key !== STATE.borrow; })) STATE.borrow = (visibleGroups()[0] || {}).key || null;
      writeHash(); renderYearBar(); renderTabs(); renderPage(); window.scrollTo(0, 0);
      checkYearLessons();
    }
  }

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
  function dmOf(v) { var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? (+m[3]) + "/" + (+m[2]) : ""; }
  function weekOfYmd(ymd) {
    var p = ymd.split("-").map(Number), dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(), back = (dow + 1) % 7;
    function add(n) { var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return t.getUTCFullYear() + "-" + String(t.getUTCMonth() + 1).padStart(2, "0") + "-" + String(t.getUTCDate()).padStart(2, "0"); }
    return { start: add(-back), end: add(-back + 6) };
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
    if (t.setLessonTitles) t.setLessonTitles(TITLES);
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
  var MK = { base: null, data: null, baseCan: {}, req: {}, log: {}, month: {}, sum: null };
  function mockLoad() {
    var p = MK.data ? Promise.resolve() : fetch("_fixtures/followup-overview.json", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("fixture " + r.status); return r.json();
    }).then(function (j) { MK.data = j; MK.log = clone(j.parent_log || {}); })
      .then(function () { return fetch("_fixtures/student-summary.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { MK.sum = j; }, function () {}); });
    return p;
  }
  function mockOverview() {
    var d = clone(MK.data), used = {};
    d.groups.forEach(function (g) {
      if (g.settings.current_lesson) used[g.settings.current_lesson] = 1;
      allOf(g.settings).forEach(function (r) { used[r] = 1; });
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
    d.flags = d.flags || { FF_PARENT_LOG: true, FF_MONTHLY: true };   // MOCK ONLY: the live page never assumes a flag, it uses overview.flags from the server
    d.week = weekOfYmd(d.today);
    Object.keys(d.lessons).forEach(function (pth) {
      var r = MK.req[pth] || {};
      d.lessons[pth].quiz_required = r.quiz_required !== false; d.lessons[pth].homework_required = r.homework_required !== false; d.lessons[pth].due_override = r.due_override || "";
    });
    d.parent_log = clone(MK.log);
    return d;
  }
  function mockSummary(st, i, from, to) {
    var o = clone(MK.sum || { totals: {}, quizzes: [], homework: [], expected: [], attendance: [], watch: [], video_access: [], written: { pending: 0, graded: 0, awarded: 0, max: 0, items: [] }, notifications: [] });
    o.ok = true; o.student = { phone: st.phone, name: st.name, year: st.year || "", parent_phone: st.parent_phone || "" };
    o.groups = MK.data.groups.filter(function (g) { return g.members.some(function (m) { return pkOf(m.phone) === pkOf(st.phone); }); }).map(function (g) { return { group: g.group, key: g.key }; });
    o.range = { from: from, to: to };
    if (o.totals.quiz_avg_pct != null) o.totals.quiz_avg_pct = Math.max(30, o.totals.quiz_avg_pct - i * 7);
    o.totals.homework_missed = (o.totals.homework_missed || 0) + (i % 3 === 0 ? 1 : 0);
    o.notifications = (MK.log[pkOf(st.phone)] || []).map(function (n) { return { student: st.phone, kind: n.kind, ref: n.ref, sent_at: n.sent_at, by: "mock", note: n.note || "" }; });
    return o;
  }
  function mockApi(payload) {
    return mockLoad().then(function () {
      var a = payload.action, d = MK.data;
      if (a === "admin_followup_overview") return mockOverview();
      if (a === "admin_followup_set_attendance") {
        var out = [], nCenter = payload.items.filter(function (it) { return it.mode === "center"; }).length;
        if (payload.grant !== false && nCenter > 1 && payload.week_confirm !== weekOfYmd(d.today).start) return { ok: false, error: "Bulk center needs this week's confirmation (week_confirm = " + weekOfYmd(d.today).start + ")." };
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
        ["weekday", "time", "current_lesson", "review_lessons", "hw_lessons", "quiz_lessons", "note", "parents_contacted", "watch_deadline_override", "hw_deadline_override"].forEach(function (k) { if (k in payload) g.settings[k] = payload[k]; });
        return { ok: true, settings: clone(g.settings) };
      }
      if (a === "admin_set_requirement") {
        var lk = String(payload.lesson || "").toLowerCase(), cur = MK.req[lk] || { quiz_required: true, homework_required: true, due_override: "" };
        ["quiz_required", "homework_required", "due_override"].forEach(function (k) { if (k in payload) cur[k] = payload[k]; });
        MK.req[lk] = cur; return { ok: true, requirement: Object.assign({ lesson: lk }, cur) };
      }
      if (a === "admin_log_parent_notification") {
        var kinds = { quiz: 1, homework: 1, monthly: 1, custom: 1 };
        if (!kinds[payload.kind]) return { ok: false, error: 'kind must be "quiz", "homework", "monthly" or "custom".' };
        var pk = pkOf(payload.student), ref = String(payload.ref || "").toLowerCase(), arr = MK.log[pk] = MK.log[pk] || [];
        var hit = arr.filter(function (n) { return n.kind === payload.kind && n.ref === ref; })[0];
        var stamp = d.today + " 12:00:00";
        if (hit) { if ("note" in payload) hit.note = payload.note; return { ok: true, created: false, notification: clone(hit) }; }   // like the backend: an edit keeps the original sent_at
        var nn = { kind: payload.kind, ref: ref || (payload.kind === "custom" ? "custom-" + Date.now() : ""), sent_at: stamp, note: payload.note || "" };
        arr.unshift(nn); return { ok: true, created: true, notification: clone(nn) };
      }
      if (a === "admin_group_add") {
        var gname = String(payload.group || "").trim(); if (!gname) return { ok: false, error: "Missing group." };
        var gk = gname.toLowerCase(), grp = d.groups.filter(function (x) { return x.key === gk; })[0];
        if (!grp) { grp = { group: gname, key: gk, settings: { weekday: null, time: "", current_lesson: "", review_lessons: [], hw_lessons: null, quiz_lessons: null, note: "", parents_contacted: false, watch_deadline_override: "", hw_deadline_override: "" }, members: [] }; d.groups.push(grp); }
        var u = d.unclassified.filter(function (x) { return pkOf(x.phone) === pkOf(payload.phone); })[0];
        var nm = u ? u.name : ((d.students[pkOf(payload.phone)] || {}).name || payload.phone);
        d.unclassified = d.unclassified.filter(function (x) { return pkOf(x.phone) !== pkOf(payload.phone); });
        if (!grp.members.some(function (x) { return pkOf(x.phone) === pkOf(payload.phone); })) grp.members.push({ phone: payload.phone, name: nm });
        return { ok: true };
      }
      if (a === "admin_monthly_review") {
        if (payload.op === "mark") {
          var mk = pkOf(payload.student) + "|" + payload.month; MK.month[mk] = { status: payload.status, sent_at: payload.status === "sent" ? d.today + " 12:00:00" : "", note: payload.note || "" };
          if (payload.status === "sent") { var pk2 = pkOf(payload.student); (MK.log[pk2] = MK.log[pk2] || []).unshift({ kind: "monthly", ref: payload.month, sent_at: d.today + " 12:00:00", note: payload.note || "" }); }
          return { ok: true, review: Object.assign({ student: payload.student, month: payload.month }, MK.month[mk]) };
        }
        var grp2 = d.groups.filter(function (x) { return x.group === payload.group; })[0];
        var members = payload.student ? [{ phone: payload.student }] : (grp2 ? grp2.members : []);
        var rng = { from: payload.month + "-01", to: payload.month + "-" + (payload.month === d.today.slice(0, 7) ? d.today.slice(8) : "28") };
        return { ok: true, month: payload.month, range: rng, closed: payload.month !== d.today.slice(0, 7), reviews: members.map(function (m, i) {
          var st = Object.assign({ phone: m.phone, name: m.name }, d.students[pkOf(m.phone)] || {}), sum = mockSummary(st, i, rng.from, rng.to);
          var row = MK.month[pkOf(m.phone) + "|" + payload.month] || { status: "pending", sent_at: "", note: "" };
          return { student: sum.student, summary: sum, review: row };
        }) };
      }
      if (a === "admin_student_summary") {
        var sk = pkOf(payload.student), st2 = d.students[sk]; if (!st2) return { ok: false, error: "Student not found." };
        return mockSummary(st2, 0, payload.from || d.today.slice(0, 8) + "01", payload.to || d.today);
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
    var fm = /Feature disabled: (FF_[A-Z_]+)/.exec(m);
    if (fm) m = "الميزة دي متوقفة على السيرفر. افتح Apps Script ← Project Settings ← Script Properties وضيف " + fm[1] + " = 1، وبعدين اضغط تحديث.";
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
  function confirmDialog(text, okLabel, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var back = el("div", { class: "fu-back center", role: "presentation" });
      function done(v) { back.remove(); document.removeEventListener("keydown", onKey); resolve(v); }
      function onKey(e) { if (e.key === "Escape") done(false); }
      var ok = el("button", { class: "fu-btn primary", type: "button", onclick: function () { done(true); } }, [okLabel || "تأكيد"]);
      var chk = null;
      if (opts.check) {   // an explicit tick is required before the OK button works (bulk center = per-week decision)
        chk = el("input", { type: "checkbox", id: "fu-dialog-check" });
        ok.disabled = true;
        chk.addEventListener("change", function () { ok.disabled = !chk.checked; });
      }
      back.appendChild(el("div", { class: "fu-dialog", role: "alertdialog", "aria-modal": "true" }, [
        el("p", { style: "margin:0 0 16px;font-weight:700" }, [text]),
        chk ? el("label", { class: "fu-check" }, [chk, el("span", {}, [opts.check])]) : null,
        el("div", { class: "fu-btns two" }, [ok, el("button", { class: "fu-btn", type: "button", onclick: function () { done(false); } }, [opts.cancelLabel || "إلغاء"])]),
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
      var s = b ? clone(b.settings) : { weekday: null, time: "", current_lesson: "", review_lessons: [], hw_lessons: null, quiz_lessons: null, note: "", parents_contacted: false, watch_deadline_override: "", hw_deadline_override: "" };
      return { group: "طلاب غير مصنفين", key: NONE_TAB, unclassified: true, borrowed: b, settings: s, members: (d.unclassified || []) };
    }
    return groupByKey(STATE.tab) || allGroups()[0] || null;
  }
  function studentOf(m) {
    var k = pkOf(m.phone), s = STATE.data.students[k] || {};
    return Object.assign({ phone: m.phone, name: m.name }, s, { key: k, name: m.name || s.name });
  }
  function flag(n) { return !!(STATE.data && STATE.data.flags && STATE.data.flags[n]); }
  var KIND_LABEL = { homework: "واجب", quiz: "كويز", monthly: "شهري", custom: "رسالة" };
  // what a parent message is logged as (contract kinds: quiz, homework, monthly, custom)
  function logKind(a) {
    var k = String(a.kind || ""), l = String(a.lesson || "");
    if (/^homework_/.test(k)) return { kind: "homework", ref: l };
    if (/^quiz_/.test(k)) return { kind: "quiz", ref: l };
    return { kind: "custom", ref: "watch:" + l };
  }
  function logItems(a) { return a.kind === "combined" ? (a.issues || []).map(logKind) : [logKind(a)]; }
  function logOf(pk) { return ((STATE.data && STATE.data.parent_log) || {})[pk] || []; }
  function loggedFor(pk, it) { var ref = String(it.ref).toLowerCase(); return logOf(pk).some(function (n) { return n.kind === it.kind && String(n.ref).toLowerCase() === ref; }); }
  // Parent contact per student (S1). Derived once per render from parent_log by FollowupLogic (pure, tested).
  //   state: "pending" (a due problem with no log entry) | "contacted" | "none" (nothing to contact about).  FF_PARENT_LOG off -> always "none".
  function contactOf(st, ac) {
    var lg = logOf(st.key), none = { state: "none", severity: 0, sum: { contacted_week: false, contacted_month: false, last_sent_at: "", last_kind: "", count: 0 } };
    if (!flag("FF_PARENT_LOG") || !L().contactSummary) return none;
    var issues = []; ac.dueNeg.forEach(function (a) { logItems(a).forEach(function (it) { issues.push(it); }); });
    var sum = L().contactSummary(lg, STATE.data.today, STATE.data.week);
    return { state: L().contactState(issues, lg, sum), severity: ac.dueNeg.length, sum: sum };
  }
  var CONTACT_FILTERS = [["all", "الكل"], ["pending", "⭕ لم يتم التواصل"], ["contacted", "✅ تم التواصل"]];
  // a group's year = the year of its members (mixed / unknown shown as their own groups in the menus)
  var YG_LABEL = { "1": "سينيور 1", "2": "سينيور 2", mixed: "مختلط", unknown: "بدون سنة" }, YG_ORDER = ["1", "2", "mixed", "unknown"];
  function groupYearKey(g) {
    var c = { "1": 0, "2": 0 };
    (g.members || []).forEach(function (m) { var y = yearOfStudent(studentOf(m)); if (y) c[y]++; });
    return c["1"] && c["2"] ? "mixed" : (c["1"] ? "1" : (c["2"] ? "2" : "unknown"));
  }
  function groupOptGroups(groups) {
    var by = {};
    groups.forEach(function (g) { (by[groupYearKey(g)] = by[groupYearKey(g)] || []).push(g); });
    return YG_ORDER.filter(function (k) { return by[k]; }).map(function (k) {
      return el("optgroup", { label: YG_LABEL[k], "data-year-group": k }, by[k].map(function (g) { return el("option", { value: g.key }, [g.group]); }));
    });
  }

  // ---- global year filter: who / which groups are visible ---------------------------------------
  function yearPass(m) { return STATE.year === "all" || yearOfStudent(studentOf(m)) === STATE.year; }
  function visibleMembers(g) { return (g.members || []).filter(yearPass); }
  function visibleGroups() { return allGroups().filter(function (g) { return STATE.year === "all" || visibleMembers(g).length > 0; }); }
  function visibleTabKeys() {
    var keys = visibleGroups().map(function (g) { return g.key; }), d = STATE.data;
    if (STATE.year === "all" || ((d && d.unclassified) || []).some(yearPass)) keys.push(NONE_TAB);
    return keys;
  }
  function everyone() {   // unique students across all groups + unclassified
    var seen = {}, out = [];
    allGroups().forEach(function (g) { g.members.forEach(add); });
    ((STATE.data && STATE.data.unclassified) || []).forEach(add);
    function add(m) { var k = pkOf(m.phone); if (!seen[k]) { seen[k] = 1; out.push(m); } }
    return out;
  }
  function lessonsForYear(all) {
    var list = (all || []).slice();
    if (STATE.year !== "all") list = list.filter(function (l) { var y = yearOfLesson(l.path); return !y || y === STATE.year; });
    function num(p, re) { var m = re.exec(lessonSlug(p)); return m ? +m[1] : 999; }
    list.sort(function (a, b) {
      return (yearOfLesson(a.path) || "9").localeCompare(yearOfLesson(b.path) || "9") ||
        num(a.path, /chapter-(\d+)/i) - num(b.path, /chapter-(\d+)/i) ||
        num(a.path, /lesson-(\d+)/i) - num(b.path, /lesson-(\d+)/i) ||
        a.path.localeCompare(b.path);
    });
    return list;
  }
  function lessonGroupLabel(p) {
    var y = yearOfLesson(p), c = /chapter-(\d+)/i.exec(lessonSlug(p));
    if (!y) return "دروس عامة";
    return (STATE.year === "all" ? "سينيور " + y : "") + (c ? (STATE.year === "all" ? " · " : "") + "الفصل " + c[1] : (STATE.year === "all" ? "" : "دروس السنة"));
  }

  // ---- per-student actions (what the buttons are) ----------------------------------------------
  function ratio(q) { return q && q.total ? q.score / q.total * 100 : 0; }
  function buildActions(st, g, summary, dl, check) {
    var d = STATE.data, v = summary.verdicts || {}, cur = g.settings.current_lesson, facts = (d.facts[st.key] || {});
    var reviews = allOf(g.settings);
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
      if (h.state === "homework_missing") neg.push({ kind: "homework_missing", lesson: h.lesson, verdict: h, label: "📝 الواجب" + tag, due: h.due !== undefined ? !!h.due : hwOver });
      else if (h.state === "homework_done") pos.push({ kind: "homework_done", lesson: h.lesson, verdict: h, label: "🌟 شكر على الواجب" + tag, due: true });
    });
    (v.quiz || []).forEach(function (q) {
      var tag = multi ? " · " + (lessonNo(q.lesson) || pretty(q.lesson)) : "";
      if (q.state === "quiz_absent") neg.push({ kind: "quiz_absent", lesson: q.lesson, verdict: q, label: "❓ الكويز (غائب)" + tag, due: q.due !== undefined ? !!q.due : true, warn: true });
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
    var rows = visibleMembers(g).map(function (m) {
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
        notnotified: flag("FF_PARENT_LOG") && ac.dueNeg.some(function (a) { return logItems(a).some(function (it) { return !loggedFor(st.key, it); }); }),
      };
      return { st: st, sm: sm, ck: ck, ac: ac, tags: tags, contact: contactOf(st, ac) };
    });
    var counts = { unmarked: 0, unwatched: 0, hwmissing: 0, quizabsent: 0, noparent: 0, late: 0 };
    rows.forEach(function (r) { Object.keys(counts).forEach(function (k) { if (r.tags[k]) counts[k]++; }); });
    var cur = g.settings.current_lesson, anyTrack = false;
    rows.forEach(function (r) { var f = ((STATE.data.facts[r.st.key] || {})[cur]); if (f && f.watch_pct !== null && f.watch_pct !== undefined) anyTrack = true; });
    var cc = L().contactCounts ? L().contactCounts(rows.map(function (r) { return r.contact.state; })) : { pending: 0, contacted: 0, none: 0, total: 0 };
    return { dl: dl, rows: rows, counts: counts, cc: cc, noTracking: !!cur && rows.length > 0 && !anyTrack, g: g };
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
    var payload = { action: "admin_followup_set_attendance", lesson: lesson, items: items, grant: true };
    if (opts.week_confirm) { payload.week_confirm = opts.week_confirm; payload.bulk = true; }
    return api(payload).then(function (res) {
      (res.results || []).forEach(function (r) {
        var f = (facts[pkOf(r.phone)] || {})[lesson]; if (f) { f.can_watch = r.can_watch; f.quiz_open = r.quiz_open; }
      });
      refreshPage();
      if (!opts.silent) {
        var one = items.length === 1;
        var name = one ? (STATE.data.students[pkOf(items[0].phone)] || {}).name || "" : items.length + " طالب";
        var modeTxt = items[0].mode === "center" ? "سنتر" : (items[0].mode === "online" ? "أونلاين" : "غير محدد");
        var wk = STATE.data.week, exp = (items.some(function (it) { return it.mode === "center"; }) && (res.expires_at || (wk && wk.end))) ? " — ينتهي يوم الجمعة " + dmOf(res.expires_at || wk.end) : "";
        toast("تم تسجيل " + name + ": " + modeTxt + exp, { undo: function () {
          setAttendance(g, items.map(function (it) { var k = pkOf(it.phone); return { phone: it.phone, mode: prev[k].att || "" }; }), { silent: true, week_confirm: wk && wk.start });
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

  // ---- rendering: global year bar ---------------------------------------------------------------
  function renderYearBar() {
    var bar = $("fu-year"); if (!bar) return;
    clear(bar);
    var d = STATE.data;
    if (!d) { bar.hidden = true; return; }
    bar.hidden = false;
    var all = everyone(), counts = { all: all.length, "1": 0, "2": 0 }, unknown = 0;
    all.forEach(function (m) { var y = yearOfStudent(studentOf(m)); if (y) counts[y]++; else unknown++; });
    var seg = el("div", { class: "fu-yseg", role: "radiogroup", "aria-label": "السنة الدراسية" });
    [{ k: "all", label: "الكل" }].concat(YEARS).forEach(function (y) {
      seg.appendChild(el("button", { type: "button", role: "radio", "aria-checked": String(STATE.year === y.k), "data-year": y.k, onclick: function () { if (STATE.year !== y.k) setYear(y.k); } },
        [y.label, el("small", {}, [String(counts[y.k])])]));
    });
    bar.appendChild(seg);
    if (STATE.year !== "all") bar.appendChild(el("div", { class: "fu-yhint", id: "fu-yhint" }, [
      "المعروض دلوقتي لطلاب " + yearLabel(STATE.year) + " بس: الجروبات، الطلاب، والدروس." + (unknown ? " (" + unknown + " طالب بدون سنة مش ظاهرين — اختار «الكل».)" : "")]));
  }

  // ---- first-visit banner ----------------------------------------------------------------------
  function guideBanner() {
    var seen = false; try { seen = localStorage.getItem("fu-guide-seen") === "1"; } catch (e) {}
    if (seen || MOCK) return null;
    function dismiss() { try { localStorage.setItem("fu-guide-seen", "1"); } catch (e) {} refreshPage(); }
    return el("section", { class: "fu-card fu-guidebanner", id: "fu-guidebanner" }, [
      el("div", { class: "fu-big" }, ["👋 أول مرة تستخدم الصفحة؟"]),
      el("div", { class: "fu-dim", style: "margin:4px 0 12px" }, ["اختار السنة من فوق وبعدين الجروب. الدليل القصير بيشرح الخطوات في دقيقة."]),
      el("div", { class: "fu-btns two" }, [
        el("button", { class: "fu-btn primary", type: "button", id: "fu-guide-open", onclick: function () { dismiss(); openHelp(); } }, ["📖 افتح الدليل"]),
        el("button", { class: "fu-btn", type: "button", id: "fu-guide-hide", onclick: dismiss }, ["إخفاء"]),
      ]),
    ]);
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
    visibleGroups().forEach(function (g) { tab(g.key, g.group, visibleMembers(g).length); });
    if (visibleTabKeys().indexOf(NONE_TAB) >= 0) tab(NONE_TAB, "طلاب غير مصنفين", (d.unclassified || []).filter(yearPass).length);
  }
  function selectTab(key) {
    STATE.tab = key; STATE.open = null; STATE.filter = "all"; STATE.q = ""; STATE.lessonQ = {}; STATE.contact = "all"; STATE.sort = "default";
    try { sessionStorage.setItem("fu-tab", key); } catch (e) {}
    writeHash(); renderTabs(); renderPage(); window.scrollTo(0, 0);
  }
  function writeHash() {
    var parts = [];
    if (STATE.open) parts.push("student=" + STATE.open);
    if (STATE.contact !== "all") parts.push("cf=" + STATE.contact);
    if (STATE.sort === "nc") parts.push("sort=nc");
    var h = parts.length ? "#" + parts.join("&") : "";
    try { history.replaceState(null, "", location.pathname + location.search + h); } catch (e) {}
  }
  // restore the contact filter / sort from a shared link (first load only)
  function readHashFilters() {
    var c = /[#&]cf=(pending|contacted)\b/.exec(location.hash), s0 = /[#&]sort=nc\b/.test(location.hash);
    STATE.contact = c ? c[1] : "all"; STATE.sort = s0 ? "nc" : "default";
  }
  function updatedLine() {
    var n = $("fu-updated");
    n.textContent = STATE.data ? "آخر تحديث " + hhmm(new Date(STATE.fetchedAt)) + (MOCK ? " · تجربة" : "") : "";
  }

  // ---- rendering: group page -------------------------------------------------------------------
  function lockChip(label, locked) { return el("span", { class: "fu-chip " + (locked ? "red" : "green") }, [(locked ? "🔒 " : "🔓 ") + label]); }

  // Words a teacher might type for a lesson besides its title: "ch2 l1", "c2l1", "2.1", "الفصل 2", "سينيور 1" ...
  function pickSearch(p) {
    var s = lessonSlug(p), c = /chapter-(\d+)/i.exec(s), m = /lesson-(\d+)/i.exec(s), out = [s.replace(/-/g, " ")], y = yearOfLesson(p);
    if (c && m) out.push("ch" + c[1], "l" + m[1], "c" + c[1] + "l" + m[1], "ch" + c[1] + "l" + m[1], c[1] + "." + m[1], "الفصل " + c[1], "الدرس " + m[1]);
    else if (m) out.push("l" + m[1], "الدرس " + m[1]);
    if (y) out.push("سينيور " + y, "senior " + y);
    return out.join(" ");
  }

  // One control: a button showing the lesson name; it opens a searchable list (assets/lesson-combobox.js).
  // opts: { allowEmpty, autoOpen, renderButton(item) } . If the combobox script did not load, a plain <select> is used instead.
  function lessonPicker(id, value, onPick, lessons, opts) {
    opts = opts || {};
    var pool = lessonsForYear(lessons), seen = {}, items = [];
    pool.forEach(function (l) {
      if (seen[l.path]) return; seen[l.path] = 1;
      items.push({ value: l.path, label: lessonLabel(l.path), group: lessonGroupLabel(l.path), search: pickSearch(l.path) });
    });
    if (value && !seen[value]) {   // current value is outside the Senior 1/2 filter: keep it visible, flagged
      var y = yearOfLesson(value), off = STATE.year !== "all" && y && y !== STATE.year;
      items.unshift({ value: value, label: lessonLabel(value), group: lessonGroupLabel(value), search: pickSearch(value), flag: off ? "سينيور " + y : "" });
    }
    if (window.LessonCombobox) {
      return el("div", { class: "fu-pick" }, [window.LessonCombobox.create({
        id: id, value: value || "", items: items, ariaLabel: "اختيار الدرس", allowEmpty: !!opts.allowEmpty, emptyOptionText: opts.emptyOptionText,
        autoOpen: !!opts.autoOpen, renderButton: opts.renderButton, onPick: onPick,
      })]);
    }
    var sel = el("select", { class: "fu-field fu-lesson-select", id: id, "aria-label": "اختيار الدرس", dir: "ltr" });
    sel.appendChild(el("option", { value: "" }, ["— اختار الدرس —"]));
    var groups = {}, order = [];
    items.forEach(function (it) {
      if (!groups[it.group]) { groups[it.group] = el("optgroup", { label: it.group }); order.push(it.group); }
      groups[it.group].appendChild(el("option", { value: it.value }, [it.label + (it.flag ? "  (" + it.flag + ")" : "")]));
    });
    order.forEach(function (gl) { sel.appendChild(groups[gl]); });
    sel.value = value || "";
    sel.addEventListener("change", function () { onPick(sel.value); });
    return el("div", { class: "fu-pick" }, [sel]);
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

  function setRequirement(path, patch) {
    var d = STATE.data; d.lessons[path] = d.lessons[path] || lessonInfo(path) || { path: path };
    var meta = d.lessons[path], before = {};
    Object.keys(patch).forEach(function (k) { before[k] = meta[k]; meta[k] = patch[k]; });
    refreshPage();
    return api(Object.assign({ action: "admin_set_requirement", lesson: path }, patch)).then(function () {
      return load(true).then(function () { toast("تم الحفظ ✓"); });
    }, function (err) { Object.keys(before).forEach(function (k) { meta[k] = before[k]; }); refreshPage(); toast(errText(err), { err: true }); });
  }
  function reqSwitch(id, label, on, onchange) {
    var chk = el("input", { type: "checkbox", id: id, role: "switch" }); chk.checked = on;
    chk.addEventListener("change", function () { onchange(chk.checked); });
    return el("label", { class: "fu-switch" }, [el("span", {}, [label]), chk, el("span", { class: "trk", "aria-hidden": "true" })]);
  }
  // Homework and quiz lessons are separate lists (Oct 22). null / missing = the group was never split: both follow review_lessons.
  function listOf(s, key) { var v = s[key]; return (v === null || v === undefined) ? (s.review_lessons || []) : v; }
  function hwOf(s) { return listOf(s, "hw_lessons"); }
  function quizOf(s) { return listOf(s, "quiz_lessons"); }
  function allOf(s) { var o = []; (s.review_lessons || []).concat(hwOf(s), quizOf(s)).forEach(function (p) { if (p && o.indexOf(p) < 0) o.push(p); }); return o; }
  function saveLists(g, hw, quiz, extra) {
    var u = []; hw.concat(quiz).forEach(function (p) { if (p && u.indexOf(p) < 0) u.push(p); });
    return saveGroup(g, Object.assign({ hw_lessons: hw, quiz_lessons: quiz, review_lessons: u }, extra || {}), { reload: true });
  }
  // Read-only view (an unclassified group): just say when a lesson is optional.
  function reqControls(path, i, ro, kind) {
    var meta = lessonInfo(path) || {}, q = meta.quiz_required !== false, h = meta.homework_required !== false;
    return el("div", { class: "fu-chips", style: "margin-top:6px" }, [kind === "quiz" && !q ? el("span", { class: "fu-chip grey" }, ["الكويز اختياري"]) : null, kind === "hw" && !h ? el("span", { class: "fu-chip grey" }, ["الواجب اختياري"]) : null]);
  }

  // ONE row per homework / quiz lesson: [ lesson name (opens the list) ][ required switch ][ 📅 ][ ✕ ].
  // The custom due date (homework only) is hidden until the 📅 button is tapped. Same ids and same
  // admin_set_requirement / admin_followup_save_group payloads as before.
  function lessonRow(kind, path, i, all, list, commit) {
    var isHw = kind === "hw", meta = lessonInfo(path) || {};
    var req = isHw ? meta.homework_required !== false : meta.quiz_required !== false;
    var reqName = isHw ? "الواجب مطلوب" : "الكويز مطلوب";
    var line = el("div", { class: "fu-lessonline" + (req ? "" : " is-optional"), "data-req": i, "data-kind": kind });
    line.appendChild(lessonPicker("pick-" + kind + "-" + i, path, function (v) { var nx = list.slice(); if (v) nx[i] = v; else nx.splice(i, 1); commit(nx); }, all, {
      renderButton: function (it) {
        var inf = lessonInfo(it.value), kids = [];
        if (!isHw && inf) kids.push(el("span", { class: "fu-lockdot", title: inf.quiz_locked ? "الكويز مقفول" : "الكويز مفتوح" }, [inf.quiz_locked ? "🔒" : "🔓"]));
        kids.push(it.label);
        if (!req) kids.push("  · اختياري");
        return kids;
      },
    }));
    var chk = el("input", { type: "checkbox", id: (isHw ? "req-hw-" : "req-quiz-") + i, role: "switch", "aria-label": reqName });
    chk.checked = req;
    chk.addEventListener("change", function () { setRequirement(path, isHw ? { homework_required: chk.checked } : { quiz_required: chk.checked }); });
    line.appendChild(el("label", { class: "fu-miniswitch", title: reqName }, [chk, el("span", { class: "trk", "aria-hidden": "true" })]));
    var extra = null;
    if (isHw) {
      var due = el("input", { class: "fu-field", type: "date", id: "req-due-" + i, value: meta.due_override || "", "aria-label": "ميعاد تسليم مخصص للدرس", style: "direction:ltr" });
      due.addEventListener("change", function () { setRequirement(path, { due_override: due.value }); });
      extra = el("div", { class: "fu-lessonextra", hidden: "hidden" }, [el("label", {}, [el("span", { class: "fu-dim" }, ["ميعاد تسليم مخصص للدرس ده (اختياري)"]), due])]);
      var cal = el("button", { class: "fu-ibtn" + (meta.due_override ? " has-date" : ""), type: "button", "data-cal": i, "aria-expanded": "false", "aria-controls": "req-due-" + i,
        "aria-label": "ميعاد تسليم مخصص" + (meta.due_override ? ": " + meta.due_override : ""), title: meta.due_override ? "ميعاد مخصص: " + meta.due_override : "ميعاد تسليم مخصص" }, ["📅"]);
      cal.addEventListener("click", function () {
        var opening = extra.hasAttribute("hidden");
        if (opening) extra.removeAttribute("hidden"); else extra.setAttribute("hidden", "hidden");
        cal.setAttribute("aria-expanded", opening ? "true" : "false"); cal.setAttribute("aria-pressed", opening ? "true" : "false");
      });
      line.appendChild(cal);
    }
    line.appendChild(el("button", { class: "fu-ibtn", type: "button", "aria-label": "حذف الدرس", "data-remove": i, "data-kind": kind, onclick: function () { var nx = list.slice(); nx.splice(i, 1); commit(nx); } }, ["✕"]));
    return el("div", { class: "fu-lessonrow", "data-row": i }, [line, extra]);
  }

  function rolesCard(g, V) {
    var d = STATE.data, s = g.settings, all = d.all_lessons || [], card = el("section", { class: "fu-card fu-compact", "aria-label": "الحصص" });
    var ro = !!g.unclassified;
    // role A
    var a = el("div", { class: "fu-role", id: "fu-role-a" });
    a.appendChild(el("div", { class: "fu-row fu-between" }, [el("h3", {}, ["🎬 الحصة الحالية"]), el("span", { class: "fu-dim" }, ["حضور + مشاهدة"])]));
    if (ro) a.appendChild(s.current_lesson ? el("div", { style: "margin-top:8px" }, [lessonChip(s.current_lesson)]) : el("div", { class: "fu-dim" }, ["اختار جروب من «اعرض بحصص جروب»"]));
    else a.appendChild(lessonPicker("pick-current", s.current_lesson, function (v) { saveGroup(g, { current_lesson: v }, { reload: true }); }, all, { allowEmpty: true, emptyOptionText: "— مفيش حصة حالية —" }));
    var ci = lessonInfo(s.current_lesson);
    if (ci) a.appendChild(el("div", { class: "fu-chips", style: "margin-top:8px" }, [lockChip("الحصة", ci.lesson_locked), lockChip("الفيديو", ci.video_locked), lockChip("الكويز", ci.quiz_locked)]));
    if (V.noTracking) a.appendChild(el("div", { class: "fu-hint", id: "fu-notrack" }, ["لا توجد بيانات مشاهدة لهذه الحصة بعد"]));
    card.appendChild(a);
    // roles B and C: homework lessons and quiz lessons are chosen separately
    function kindBlock(kind) {
      var isHw = kind === "hw", list = (isHw ? hwOf(s) : quizOf(s)).slice(), other = (isHw ? quizOf(s) : hwOf(s)).slice();
      var box = el("div", { class: "fu-role", id: isHw ? "fu-role-hw" : "fu-role-quiz", "data-kind": kind });
      box.appendChild(el("div", { class: "fu-row fu-between" }, [el("h3", {}, [isHw ? "📝 الواجب" : "❓ الكويز"]), el("span", { class: "fu-dim" }, ["الحصة السابقة"])]));
      function commit(nx) { return isHw ? saveLists(g, nx, other) : saveLists(g, other, nx); }
      list.forEach(function (path, i) {
        if (ro) box.appendChild(el("div", { class: "fu-lessonrow" }, [lessonChip(path), reqControls(path, i, ro, kind)]));
        else box.appendChild(lessonRow(kind, path, i, all, list, commit));
      });
      if (!ro) {
        var akey = g.key + ":" + kind, adding = !!STATE.adding[akey];
        if (adding || !list.length) box.appendChild(el("div", { class: "fu-lessonrow" }, [lessonPicker("pick-" + kind + "-new", "", function (v) { if (!v) return; STATE.adding[akey] = false; commit(list.concat([v])); }, all, { autoOpen: adding && list.length > 0 })]));
        if (!adding && list.length && list.length < 5) box.appendChild(el("div", { style: "margin-top:8px" }, [el("button", { class: "fu-chip", id: "fu-add-" + kind, type: "button", onclick: function () { STATE.adding[akey] = true; refreshPage(); } }, ["＋ إضافة درس"])]));
      }
      return box;
    }
    card.appendChild(kindBlock("hw"));
    card.appendChild(kindBlock("quiz"));
    if (!ro && (hwOf(s).length || quizOf(s).length)) card.appendChild(el("div", { class: "fu-colhint", id: "fu-colhint" }, ["المفتاح = مطلوب · 📅 ميعاد تسليم خاص للواجب · ✕ حذف"]));
    card.appendChild(el("div", { class: "fu-hint" }, ["⚠️ حرّك الاختيارين لقدّام بعد كل حصة، وإلا مواعيد الحصة الجديدة ممكن تظهر متأخرة."]));
    if (STATE.year !== "all") {
      var off = [s.current_lesson].concat(allOf(s)).filter(function (p) { var y = yearOfLesson(p); return p && y && y !== STATE.year; });
      if (off.length) card.appendChild(el("div", { class: "fu-warnbox", id: "fu-year-mismatch", role: "alert" }, ["⚠️ في درس مختار من سينيور " + yearOfLesson(off[0]) + " والعرض الحالي " + yearLabel(STATE.year) + " — راجع اختيار الدروس."]));
    }
    return card;
  }

  function settingsCard(g) {
    var s = g.settings;
    var card = el("section", { class: "fu-card fu-compact", "aria-label": "إعدادات الجروب" });
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
    var sel = el("select", { class: "fu-field", id: "fu-borrow", "aria-label": "اعرض بحصص جروب", style: "direction:rtl;font:inherit" }, groupOptGroups(visibleGroups()));
    sel.value = (visibleGroups().filter(function (g) { return g.key === STATE.borrow; })[0] || visibleGroups()[0] || {}).key || "";
    sel.addEventListener("change", function () { STATE.borrow = sel.value; STATE.open = null; refreshPage(); });
    return el("section", { class: "fu-card" }, [el("label", {}, [el("span", { class: "fu-label" }, ["اعرض بحصص جروب ▾"]), sel]),
      el("div", { class: "fu-hint" }, ["الاختيار ده محلي ومش بيتحفظ — بيحدد بس الحصة الحالية وحصة الواجب والكويز المستخدمة في الحالات تحت."])]);
  }

  function noGroupsCard() {
    return el("section", { class: "fu-card", id: "fu-nogroups" }, [
      el("h3", {}, ["مفيش جروبات" + (STATE.year !== "all" ? " لـ " + yearLabel(STATE.year) : "") + " لسه"]),
      el("p", { class: "fu-dim", style: "margin:8px 0 12px" }, ["الطلاب اللي تحت لسه من غير جروب. اعمل جروب جديد أو ضمّهم لجروب موجود، وبعدها تظهر حصصهم ومتابعتهم."]),
      el("button", { class: "fu-btn primary", id: "fu-assign", type: "button", style: STATE.role === "assistant" ? "display:none" : "", onclick: openAssign }, ["➕ اعمل جروب وضيف الطلاب"]),
    ]);
  }
  function openAssign() {
    if (STATE.role === "assistant") return;   // admin_group_add is admin-only by design (S3)
    var d = STATE.data, pool = (d.unclassified || []).filter(yearPass), groups = allGroups();
    openSheet(function (sheet) {
      sheet.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, ["تعيين طلاب لجروب"]), el("button", { class: "fu-ibtn", id: "fu-close", type: "button", "aria-label": "إغلاق", onclick: closeSheet }, ["✕"])]));
      var sel = el("select", { class: "fu-field", id: "fu-assign-group", "aria-label": "الجروب", style: "direction:rtl;font:inherit" }, groupOptGroups(groups));
      sel.appendChild(el("option", { value: "__new" }, ["＋ جروب جديد…"]));
      var nm = el("input", { class: "fu-field", id: "fu-assign-name", placeholder: "اسم الجروب الجديد (مثال: Sun 4pm)", dir: "auto", "aria-label": "اسم الجروب الجديد" });
      function sync() { nm.hidden = sel.value !== "__new"; }
      sel.value = groups.length ? groups[0].key : "__new"; sync(); sel.addEventListener("change", sync);
      sheet.appendChild(el("label", {}, [el("span", { class: "fu-label" }, ["الجروب"]), sel]));
      sheet.appendChild(nm);
      sheet.appendChild(el("div", { class: "fu-label", style: "margin-top:14px" }, ["الطلاب (" + pool.length + ")"]));
      var list = el("div", { id: "fu-assign-list" });
      pool.forEach(function (m) {
        var c = el("input", { type: "checkbox", value: m.phone, checked: true });
        list.appendChild(el("label", { class: "fu-check" }, [c, el("span", {}, [m.name || m.phone])]));
      });
      if (!pool.length) list.appendChild(el("div", { class: "fu-empty" }, ["مفيش طلاب من غير جروب" + (STATE.year !== "all" ? " في " + yearLabel(STATE.year) : "")]));
      sheet.appendChild(list);
      var go = el("button", { class: "fu-btn primary", id: "fu-assign-go", type: "button", style: "margin-top:14px", onclick: function () {
        var phones = Array.prototype.filter.call(list.querySelectorAll("input:checked"), function () { return true; }).map(function (i) { return i.value; });
        var gname = sel.value === "__new" ? nm.value.trim() : (groupByKey(sel.value) || {}).group;
        if (!gname) { toast("اكتب اسم الجروب", { err: true }); return; }
        if (!phones.length) { toast("اختار طالب واحد على الأقل", { err: true }); return; }
        go.disabled = true;
        var ok = 0, bad = [];
        phones.reduce(function (p, ph) { return p.then(function () { return api({ action: "admin_group_add", group: gname, phone: ph }).then(function () { ok++; }, function (e) { bad.push(errText(e)); }); }); }, Promise.resolve())
          .then(function () { closeSheet(); return load(true); })
          .then(function () {
            var g2 = allGroups().filter(function (x) { return x.group.toLowerCase() === gname.toLowerCase(); })[0];
            if (g2) selectTab(g2.key);
            toast(bad.length ? "اتعيّن " + ok + " وفشل " + bad.length + ": " + bad[0] : "اتعيّن " + ok + " طالب لجروب " + gname + " ✓", { err: !!bad.length });
          });
      } }, ["تعيين"]);
      sheet.appendChild(go);
    }, { label: "تعيين طلاب لجروب" });
  }

  // switching the year with lessons of the OTHER year selected: ask once, then clear them (or keep them, the warning stays)
  function checkYearLessons() {
    if (!STATE.data || STATE.year === "all") return;
    var bad = [];
    visibleGroups().forEach(function (g) {
      var s = g.settings, off = function (p) { var y = yearOfLesson(p); return !!(p && y && y !== STATE.year); };
      var cur = off(s.current_lesson), rv = allOf(s).filter(off);
      if (cur || rv.length) bad.push({ g: g, cur: cur, rv: rv });
    });
    if (!bad.length) return;
    confirmDialog("الجروبات دي فيها دروس من سنة تانية غير " + yearLabel(STATE.year) + ": " + bad.map(function (b) { return b.g.group; }).join("، ") + ". تمسح الدروس دي؟", "امسحها", { cancelLabel: "سيبها" }).then(function (ok) {
      if (!ok) return;
      bad.reduce(function (p, b) {
        return p.then(function () {
          var s = b.g.settings;
          var keep = function (arr) { return arr.filter(function (x) { return b.rv.indexOf(x) < 0; }); }, nh = keep(hwOf(s)), nq = keep(quizOf(s));
          return saveGroup(b.g, { current_lesson: b.cur ? "" : s.current_lesson, review_lessons: keep(s.review_lessons || []), hw_lessons: nh, quiz_lessons: nq }, { quiet: true });
        });
      }, Promise.resolve()).then(function () { return load(true); }).then(function () { toast("تم مسح الدروس من السنة التانية ✓"); });
    });
  }

  function groupActions(g, V) {
    var wrap = el("div", { class: "fu-stack", style: "margin-bottom:14px" });
    wrap.appendChild(el("button", { class: "fu-btn primary", id: "fu-reminder", type: "button", onclick: function () { openReminder(g, V); } }, ["📣 رسالة تذكير للجروب"]));
    wrap.appendChild(el("button", { class: "fu-btn", id: "fu-copy-names", type: "button", onclick: function () { copyMissingNames(V); } }, ["📋 نسخ أسماء اللي لسه ما سلّموش"]));
    var cur = g.settings.current_lesson;
    if (flag("FF_MONTHLY")) wrap.appendChild(el("button", { class: "fu-btn", id: "fu-monthly", type: "button", onclick: function () { openMonthly(g); } }, ["📅 المراجعة الشهرية"]));
    wrap.appendChild(el("div", { class: "fu-btns two" }, [
      el("button", { class: "fu-btn", id: "fu-all-center", type: "button", onclick: function () { bulk(g, "center"); } }, ["الكل سنتر"]),
      el("button", { class: "fu-btn", id: "fu-all-online", type: "button", onclick: function () { bulk(g, "online"); } }, ["الكل أونلاين"]),
    ]));
    if (!cur) wrap.lastChild.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
    return wrap;
  }
  function bulk(g, mode) {
    var vis = visibleMembers(g), n = vis.length;
    if (!n) { toast("مفيش طلاب ظاهرين في الجروب ده", { err: true }); return; }
    var wk = STATE.data.week, needWeek = mode === "center" && n > 1 && wk;
    confirmDialog("تسجيل " + n + " طالب" + (STATE.year !== "all" ? " (" + yearLabel(STATE.year) + " بس)" : "") + " كـ «" + (mode === "center" ? "سنتر" : "أونلاين") + "»؟" + (mode === "center" ? " هيتفتح الفيديو والكويز مجانًا للكل، وبينتهي يوم الجمعة." : ""), "تأكيد",
      needWeek ? { check: "أؤكد إن أسبوع " + dmOf(wk.start) + " ← " + dmOf(wk.end) + " (السبت–الجمعة) سنتر للـ " + n + " طالب" } : null).then(function (ok) {
      if (ok) setAttendance(g, vis.map(function (m) { return { phone: m.phone, mode: mode }; }), needWeek ? { week_confirm: wk.start } : {});
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
    if (flag("FF_PARENT_LOG") && V.cc.total > 0) {
      f.appendChild(el("button", { class: "fu-contactline" + (V.cc.pending ? "" : " done"), id: "fu-contactline", type: "button", "aria-pressed": String(STATE.contact === "pending"), onclick: function () { setContact(STATE.contact === "pending" ? "all" : "pending"); } },
        [el("b", {}, [(V.cc.contacted) + " من " + V.cc.total]), el("span", {}, [" تم التواصل مع ولي الأمر" + (V.cc.pending ? " · اضغط تشوف اللي لسه" : " 🎉")])]));
    }
    f.appendChild(el("button", { class: "fu-infolink", id: "fu-info-required", type: "button", onclick: function () { openHelp("required"); } }, ["ℹ️ إزاي الصفحة بتحدد إيه الناقص؟"]));
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
    FILTERS.concat(flag("FF_PARENT_LOG") ? [["notnotified", "لم يُبلَّغ بعد"]] : []).forEach(function (x) {
      chips.appendChild(el("button", { class: "fu-chip", type: "button", "data-filter": x[0], "aria-pressed": String(STATE.filter === x[0]), onclick: function () { STATE.filter = x[0]; STATE.open = null; refreshPage(); } }, [x[1]]));
    });
    f.appendChild(chips);
    if (flag("FF_PARENT_LOG") && L().contactSummary) {
      var cc = V.cc, cchips = el("div", { class: "fu-filters fu-cfilters", role: "group", "aria-label": "التواصل مع ولي الأمر" });
      CONTACT_FILTERS.forEach(function (x) {
        var n = x[0] === "pending" ? cc.pending : (x[0] === "contacted" ? cc.contacted : null);
        cchips.appendChild(el("button", { class: "fu-chip", type: "button", "data-cfilter": x[0], "aria-pressed": String(STATE.contact === x[0]), onclick: function () { setContact(x[0]); } }, [x[1] + (n === null ? "" : " · " + n)]));
      });
      cchips.appendChild(el("button", { class: "fu-chip", type: "button", "data-sort": "nc", "aria-pressed": String(STATE.sort === "nc"), title: "اللي لسه ما اتكلمش معاهم الأول، وبعدين الأكتر مشاكل", onclick: function () { STATE.sort = STATE.sort === "nc" ? "default" : "nc"; writeHash(); refreshPage(); } }, ["↕ غير المتواصَل أولًا"]));
      f.appendChild(cchips);
    }
    return f;
  }
  function setContact(v) {
    STATE.contact = v; STATE.open = null;
    if (v === "pending") STATE.sort = "nc";      // sort "not contacted first" is the default while that filter is on
    writeHash(); refreshPage();
  }
  function passFilter(r) {
    var f = STATE.filter;
    if (f !== "all" && !r.tags[f]) return false;
    if (STATE.contact !== "all" && r.contact.state !== STATE.contact) return false;
    var q = (STATE.q || "").trim().toLowerCase();
    if (!q) return true;
    return r.st.name.toLowerCase().indexOf(q) >= 0 || String(r.st.phone).indexOf(q.replace(/\D/g, "") || "\u0000") >= 0;
  }
  function microChips(r) {
    var chips = el("div", { class: "fu-chips chips" });
    (r.sm.microChips || []).forEach(function (c) { chips.appendChild(el("span", { class: "fu-chip t-" + (c.tone || "grey"), "data-chip": c.key }, [c.label])); });
    if (STATE.year === "all") { var yk = yearOfStudent(r.st); if (yk) chips.insertBefore(el("span", { class: "fu-chip fu-year-chip", "data-chip": "year" }, ["S" + yk]), chips.firstChild); }
    if (flag("FF_PARENT_LOG") && logOf(r.st.key)[0]) chips.appendChild(el("span", { class: "fu-chip green", "data-chip": "notified", title: "آخر تواصل مع ولي الأمر" + (r.contact.sum.contacted_month ? "" : " (مش الشهر ده)") }, [(r.contact.state === "contacted" ? "✅ تم التواصل · " : "📨 ") + dmOf(r.contact.sum.last_sent_at || logOf(r.st.key)[0].sent_at)]));
    if (r.contact.state === "pending") chips.appendChild(el("span", { class: "fu-chip amber", "data-chip": "contact-pending", title: "فيه مشكلة مستحقة ولسه ما اتسجّلش تواصل عنها" }, ["⭕ لم يتم التواصل"]));
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
  function infoBtn() { return el("button", { class: "fu-ibtn fu-info", type: "button", "data-info": "required", "aria-label": "إزاي بنحدد إن ده ناقص؟", title: "إزاي بنحدد إن ده ناقص؟", onclick: function (e) { e.stopPropagation(); openHelp("required"); } }, ["ℹ️"]); }
  function studentBody(r, g, V) {
    var d = STATE.data, s = g.settings, cur = s.current_lesson, st = r.st, facts = d.facts[st.key] || {};
    var body = el("div", { class: "fu-stu-body", id: "fu-body-" + st.key });
    // section A
    if (cur) {
      var f = facts[cur] || {}, info = lessonInfo(cur) || {};
      var A = el("div", { class: "fu-sec", "data-sec": "current" });
      A.appendChild(el("h4", {}, [el("span", {}, ["🎬 الحصة الحالية"]), lessonNo(cur) ? el("span", { class: "fu-dim" }, [lessonNo(cur)]) : null]));
      A.appendChild(el("div", { style: "margin-bottom:10px" }, [lessonChip(cur)]));
      var seg = el("div", { class: "fu-seg", role: "radiogroup", "aria-label": "الحضور" });
      [["online", "أونلاين"], ["center", "سنتر"]].forEach(function (x) {
        seg.appendChild(el("button", { type: "button", role: "radio", "aria-checked": String(f.attendance === x[0]), "data-att": x[0], onclick: function () {
          if (f.attendance === x[0]) return; setAttendance(g, [{ phone: st.phone, mode: x[0] }]);
        } }, [x[1]]));
      });
      A.appendChild(seg);
      if (!f.attendance) A.appendChild(el("div", { class: "fu-hint", style: "background:var(--fu-warn-bg);color:var(--fu-warn)" }, ["⚠️ الحضور غير محدد"]));
      else {
        var wd = f.attendance === "center" ? null : ((f.watch_pct || 0) >= d.settings.watch_done_pct);
        A.appendChild(el("div", { class: "fu-chips", style: "margin-top:10px", "data-att-state": f.attendance === "center" ? "center" : (wd ? "watched" : "must") }, [
          f.attendance === "center" ? el("span", { class: "fu-chip green" }, ["🏫 حضر في السنتر"]) : (wd ? el("span", { class: "fu-chip green" }, ["✅ شاهد أونلاين"]) : el("span", { class: "fu-chip amber" }, ["💻 لازم يشاهد أونلاين"]))]));
      }
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
    allOf(s).forEach(function (path) {
      var inHw = hwOf(s).indexOf(path) >= 0, inQz = quizOf(s).indexOf(path) >= 0;
      var f = facts[path] || {}, info = lessonInfo(path) || {}, B = el("div", { class: "fu-sec", "data-sec": "review" });
      B.appendChild(el("h4", {}, [el("span", {}, [inHw && inQz ? "📝 واجب وكويز" : (inHw ? "📝 الواجب" : "❓ الكويز")]), lessonNo(path) ? el("span", { class: "fu-dim" }, [lessonNo(path)]) : null]));
      B.appendChild(el("div", { style: "margin-bottom:8px" }, [lessonChip(path)]));
      if (inHw && info.has_assignment !== false) {
        var ok = f.homework && f.homework.submitted;
        B.appendChild(el("div", { class: "fu-kv" }, [el("span", {}, ["الواجب"]), el("span", { class: "fu-chip " + (ok ? "green" : "red"), "data-hw": ok ? "done" : "missing" }, [ok ? "✓ تم" : "✕ لم يُسلَّم"]), ok ? null : infoBtn()]));
      }
      if (inQz && info.has_quiz !== false) {
        var q = f.quiz || {};
        if (q.taken) B.appendChild(el("div", { class: "fu-kv" }, [el("span", {}, ["الكويز"]), el("span", { class: "fu-chip " + (ratio(q) >= d.settings.praise_quiz_pct ? "green" : "grey"), "data-quiz": "taken" }, ["❓ " + q.score + " / " + q.total])]));
        else B.appendChild(el("div", { class: "fu-absent", "data-quiz": "absent", role: "status" }, ["⚠️ غائب عن الكويز – تعويض ", infoBtn()]));
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
    if (flag("FF_PARENT_LOG")) {
      var lg = logOf(st.key).slice(0, 3);
      if (lg.length) body.appendChild(el("div", { class: "fu-chips", "data-log": "" }, lg.map(function (n) { return el("span", { class: "fu-chip grey" }, ["📨 " + (KIND_LABEL[n.kind] || n.kind) + " · " + dmOf(n.sent_at) + (n.note ? " — " + n.note : "")]); })));
    }
    body.appendChild(el("a", { class: "fu-btn", id: "fu-summary-link-" + st.key, href: "student-summary.html?student=" + st.key + (MOCK ? "&mock=1" : "") }, ["📊 ملخص الطالب"]));
    return body;
  }
  function renderRows(V) {
    var host = clear($("fu-rows")), shown = V.rows.filter(passFilter);
    if (STATE.sort === "nc" && L().contactSort) {
      var byKey = {}; shown.forEach(function (r) { byKey[r.st.key] = r; });
      shown = L().contactSort(shown.map(function (r) { return { id: r.st.key, state: r.contact.state, severity: r.contact.severity, name: r.st.name }; })).map(function (k) { return byKey[k]; });
    }
    if ($("fu-count")) $("fu-count").textContent = "الطلاب · " + shown.length + (shown.length !== V.rows.length ? " / " + V.rows.length : "");
    if (!shown.length) { host.appendChild(el("div", { class: "fu-empty" }, [V.rows.length ? "مفيش طلاب بالفلتر ده" : (STATE.year !== "all" ? "مفيش طلاب " + yearLabel(STATE.year) + " في الجروب ده" : "مفيش طلاب في الجروب ده")])); return; }
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
      if (flag("FF_PARENT_LOG")) sheet.appendChild(logBox(st, a));
      sheet.appendChild(el("div", { class: "fu-stack" }, [link, el("div", { class: "fu-btns two" }, [
        el("button", { class: "fu-btn", id: "fu-copy", type: "button", onclick: function () { copy(ta.value); } }, ["📋 نسخ"]),
        el("button", { class: "fu-btn", id: "fu-close", type: "button", onclick: closeSheet }, ["إغلاق"]),
      ])]));
    }, { label: "الرسالة" });
  }
  // "I sent it" -> one ParentNotifications entry per item (a combined message logs each of its issues)
  function logBox(st, a) {
    var items = logItems(a), done = items.every(function (it) { return loggedFor(st.key, it); });
    var note = el("input", { class: "fu-field", id: "fu-log-note", placeholder: "ملاحظة (اختياري) — مثال: ردّت وقالت هتسلّم", dir: "auto", "aria-label": "ملاحظة التواصل" });
    var btn = el("button", { class: "fu-btn", id: "fu-log-send", type: "button" }, [done ? "✓ اتسجّل — تحديث الملاحظة" : "📨 سجّل إني بعتّ الرسالة"]);
    btn.addEventListener("click", function () {
      btn.disabled = true;
      var d = STATE.data; d.parent_log = d.parent_log || {};
      items.reduce(function (p, it) {
        return p.then(function () {
          return api({ action: "admin_log_parent_notification", student: st.phone, kind: it.kind, ref: it.ref, note: note.value }).then(function (res) {
            var arr = d.parent_log[st.key] = (d.parent_log[st.key] || []).filter(function (n) { return !(n.kind === it.kind && String(n.ref).toLowerCase() === String(it.ref).toLowerCase()); });
            var n = res.notification || {};
            arr.unshift({ kind: it.kind, ref: String(it.ref).toLowerCase(), sent_at: n.sent_at || (d.today + " 00:00:00"), note: note.value });
          });
        });
      }, Promise.resolve()).then(function () {
        btn.textContent = "✓ اتسجّل"; btn.disabled = false; toast("اتسجّل التواصل مع ولي الأمر ✓"); refreshPage();
      }, function (err) { btn.disabled = false; toast(errText(err), { err: true }); });
    });
    return el("div", { class: "fu-logbox" }, [el("span", { class: "fu-dim" }, ["بعد ما تبعت الرسالة في واتساب، سجّلها هنا عشان تعرف مين اتبلّغ."]), note, btn]);
  }

  // ---- monthly review (FF_MONTHLY): one message per student, batch per group, printable ------------
  function monthOptions() {
    var t = STATE.data.today, y = +t.slice(0, 4), m = +t.slice(5, 7), out = [];
    for (var i = 0; i < 6; i++) { out.push(y + "-" + String(m).padStart(2, "0")); m--; if (m < 1) { m = 12; y--; } }
    return out;
  }
  function monthLabelOf(m) { return T().monthLabel ? T().monthLabel(m) : m; }
  function monthlyText(rev, month) {
    try {
      var r = T().composeFull(rev.summary, "monthly_review", { month: month, templates: STATE.data.templates || {} });
      return { text: r.text, missing: r.missing || [] };
    } catch (e) { console.error(e); return { text: "", missing: [], error: e }; }
  }
  var MSTATUS = { pending: ["معلّق", "amber"], ready: ["جاهز", "green"], sent: ["اتبعت", "green"], closed: ["مقفول", "grey"] };
  function markMonth(rev, month, status, note) {
    return api({ action: "admin_monthly_review", op: "mark", month: month, student: rev.student.phone, status: status, note: note || "" }).then(function (res) {
      rev.review = Object.assign(rev.review || {}, res.review);
      if (status === "sent") {
        var d = STATE.data; d.parent_log = d.parent_log || {};
        var pk = pkOf(rev.student.phone);
        d.parent_log[pk] = (d.parent_log[pk] || []).filter(function (n) { return !(n.kind === "monthly" && n.ref === month); });
        d.parent_log[pk].unshift({ kind: "monthly", ref: month, sent_at: (res.review && res.review.sent_at) || (d.today + " 00:00:00"), note: note || "" });
        refreshPage();
      }
      return res;
    });
  }
  function printMonthly(reviews, month) {
    var host = el("div", { id: "fu-print", dir: "rtl" });
    reviews.forEach(function (r) {
      var m = monthlyText(r, month);
      host.appendChild(el("section", { class: "fu-print-page" }, [el("h1", {}, ["التقرير الشهري — " + monthLabelOf(month)]), el("h2", {}, [r.student.name]), el("div", { class: "fu-print-body", html: T().formatPreview(m.text) })]));
    });
    document.body.appendChild(host); document.body.classList.add("fu-printing");
    function cleanup() { host.remove(); document.body.classList.remove("fu-printing"); window.removeEventListener("afterprint", cleanup); }
    window.addEventListener("afterprint", cleanup);
    window.print();
  }
  // a student's monthly report counts as "contacted" when marked sent OR a monthly log entry exists for that month
  function monthContacted(r, month) {
    return (r.review || {}).status === "sent" || (L().monthlySent ? L().monthlySent(logOf(pkOf(r.student.phone)), month) : false);
  }
  function openMonthly(g, month0) {
    var month = month0 || STATE.data.today.slice(0, 7), data = null, loading = true, err = "";
    var mf = STATE.contact === "pending" || STATE.contact === "contacted" ? STATE.contact : "all", msort = STATE.sort === "nc";   // same filter / sort as the page, adjustable here
    openSheet(function (sheet) {
      var body = el("div", { id: "fu-monthly-body" }); sheet.appendChild(body);
      function fetchIt() {
        loading = true; err = ""; paint();
        api({ action: "admin_monthly_review", month: month, group: g.group }).then(function (r) { data = r; loading = false; paint(); }, function (e) { loading = false; err = errText(e); paint(); });
      }
      function paint() {
        clear(body);
        body.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, ["المراجعة الشهرية · " + g.group]), el("button", { class: "fu-ibtn", id: "fu-close", type: "button", "aria-label": "إغلاق", onclick: closeSheet }, ["✕"])]));
        var sel = el("select", { class: "fu-field", id: "fu-month", "aria-label": "الشهر", style: "direction:rtl;font:inherit" }, monthOptions().map(function (m) { return el("option", { value: m }, [monthLabelOf(m)]); }));
        sel.value = month; sel.addEventListener("change", function () { month = sel.value; fetchIt(); });
        body.appendChild(el("label", { style: "display:block;margin-top:10px" }, [el("span", { class: "fu-label" }, ["الشهر"]), sel]));
        if (loading) { body.appendChild(el("div", { class: "fu-skel" })); return; }
        if (err) { body.appendChild(el("div", { class: "fu-err", id: "fu-monthly-error", role: "alert" }, [err])); return; }
        var revs = data.reviews || [], sentN = revs.filter(function (r) { return monthContacted(r, month); }).length;
        var logOn = flag("FF_PARENT_LOG"), shownRevs = revs;   // copy-all / print / mark-ready keep using the FULL list; the filter only changes what is listed
        body.appendChild(el("div", { class: "fu-hint" }, [data.closed ? "الشهر خلص — الأرقام نهائية." : "الشهر لسه شغال — الأرقام لحد النهارده (" + dmOf(data.range.to) + ")."]));
        body.appendChild(el("div", { class: "fu-stack", style: "margin:12px 0" }, [
          el("button", { class: "fu-btn", id: "fu-monthly-copy-all", type: "button", onclick: function () {
            copy(revs.map(function (r) { return r.student.name + "\n" + monthlyText(r, month).text; }).join("\n\n———\n\n"));
          } }, ["📋 نسخ كل الرسائل"]),
          el("div", { class: "fu-btns two" }, [
            el("button", { class: "fu-btn", id: "fu-monthly-print", type: "button", onclick: function () { printMonthly(revs, month); } }, ["🖨️ طباعة"]),
            el("button", { class: "fu-btn", id: "fu-monthly-ready", type: "button", onclick: function () {
              var todo = revs.filter(function (r) { return (r.review || {}).status === "pending"; });
              todo.reduce(function (p, r) { return p.then(function () { return markMonth(r, month, "ready"); }); }, Promise.resolve()).then(function () { paint(); toast("اتعلّم " + todo.length + " كجاهز ✓"); }, function (e) { toast(errText(e), { err: true }); });
            } }, ["✓ الكل جاهز"]),
          ]),
        ]));
        if (logOn) {
          body.appendChild(el("div", { class: "fu-contactline" + (sentN === revs.length ? " done" : ""), id: "fu-monthly-count" }, [el("b", {}, [sentN + " من " + revs.length]), el("span", {}, [" اتبعتلهم تقرير " + monthLabelOf(month)])]));
          var mchips = el("div", { class: "fu-filters fu-cfilters", role: "group", "aria-label": "فلتر التواصل" });
          CONTACT_FILTERS.forEach(function (x) {
            mchips.appendChild(el("button", { class: "fu-chip", type: "button", "data-mfilter": x[0], "aria-pressed": String(mf === x[0]), onclick: function () { mf = x[0]; if (x[0] === "pending") msort = true; paint(); } }, [x[1]]));
          });
          mchips.appendChild(el("button", { class: "fu-chip", type: "button", "data-msort": "nc", "aria-pressed": String(msort), onclick: function () { msort = !msort; paint(); } }, ["↕ غير المتواصَل أولًا"]));
          body.appendChild(mchips);
          shownRevs = revs.filter(function (r) { var c = monthContacted(r, month); return mf === "all" || (mf === "contacted" ? c : !c); });
          if (msort && L().contactSort) {
            var byK = {}; shownRevs.forEach(function (r) { byK[pkOf(r.student.phone)] = r; });
            shownRevs = L().contactSort(shownRevs.map(function (r) { var t0 = r.summary.totals || {}; return { id: pkOf(r.student.phone), state: monthContacted(r, month) ? "contacted" : "pending", severity: (t0.quiz_missed || 0) + (t0.homework_missed || 0), name: r.student.name }; })).map(function (k) { return byK[k]; });
          }
        }
        shownRevs.forEach(function (r) {
          var t = r.summary.totals || {}, st = MSTATUS[(r.review || {}).status] || MSTATUS.pending, ck = parentCheck({ phone: r.student.phone, parent_phone: r.student.parent_phone });
          body.appendChild(el("div", { class: "fu-sec fu-mrow", "data-review": pkOf(r.student.phone) }, [
            el("h4", {}, [el("span", {}, [r.student.name]), el("span", { class: "fu-chip " + st[1], "data-status": (r.review || {}).status || "pending" }, [st[0]])]),
            el("div", { class: "fu-chips" }, [
              el("span", { class: "fu-chip grey" }, ["📝 " + (t.quiz_avg_pct != null ? Math.round(t.quiz_avg_pct) + "%" : "—")]),
              (t.quiz_missed || t.homework_missed) ? el("span", { class: "fu-chip red" }, ["⚠️ ناقص " + ((t.quiz_missed || 0) + (t.homework_missed || 0))]) : el("span", { class: "fu-chip green" }, ["✓ مفيش ناقص"]),
              ck.level === "missing" ? el("span", { class: "fu-chip red" }, ["لا رقم ولي أمر"]) : null,
              logOn ? (monthContacted(r, month) ? el("span", { class: "fu-chip green", "data-contact": "sent" }, ["✅ تم التواصل"]) : el("span", { class: "fu-chip amber", "data-contact": "pending" }, ["⭕ لم يتم التواصل"])) : null,
            ]),
            el("div", { style: "margin-top:10px" }, [el("button", { class: "fu-btn wa", type: "button", "data-open-review": pkOf(r.student.phone), onclick: function () { openMonthlyMessage(g, r, month); } }, ["💬 معاينة وإرسال"])]),
          ]));
        });
        if (!shownRevs.length) body.appendChild(el("div", { class: "fu-empty" }, [revs.length ? "مفيش طلاب بالفلتر ده" : "مفيش طلاب في الجروب ده"]));
      }
      fetchIt();
    }, { full: true, label: "المراجعة الشهرية" });
  }
  function openMonthlyMessage(g, rev, month) {
    var m = monthlyText(rev, month), ck = parentCheck({ phone: rev.student.phone, parent_phone: rev.student.parent_phone });
    var digits = ck.wa || (L().waDigits ? L().waDigits(rev.student.parent_phone) : "");
    openSheet(function (sheet) {
      var link = el("a", { class: "fu-btn wa", id: "fu-wa-open", target: "_blank", rel: "noopener", href: "#" }, ["فتح واتساب ↗"]);
      var bubble = el("div", { class: "fu-bubble", id: "fu-preview", dir: "auto" });
      var ta = el("textarea", { class: "fu-field fu-msg-edit", id: "fu-msg-text", dir: "auto", "aria-label": "نص الرسالة" }); ta.value = m.text;
      function sync() {
        try { bubble.innerHTML = T().formatPreview(ta.value); } catch (e) { bubble.textContent = ta.value; }
        if (digits && ck.level !== "missing" && T().waLink) link.href = T().waLink(digits, ta.value); else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); }
      }
      ta.addEventListener("input", sync);
      var st = MSTATUS[(rev.review || {}).status] || MSTATUS.pending;
      sheet.appendChild(el("div", { class: "fu-row fu-between" }, [el("h2", {}, ["تقرير " + monthLabelOf(month) + " · " + rev.student.name]), el("span", { class: "fu-chip " + st[1], id: "fu-month-status" }, [st[0]])]));
      if (ck.level === "missing") sheet.appendChild(el("div", { class: "fu-warnbox", id: "fu-phonewarn", role: "alert" }, ["⚠️ لا يوجد رقم ولي أمر — زر واتساب متوقف، تقدر تنسخ الرسالة."]));
      else if (ck.level === "warn") sheet.appendChild(el("div", { class: "fu-warnbox" }, ["⚠️ راجع رقم ولي الأمر قبل الإرسال. " + (ck.reason || "")]));
      if (m.missing.length) sheet.appendChild(el("div", { class: "fu-warnbox", id: "fu-missing" }, ["متغيرات غير معروفة في القالب: " + m.missing.join(" ")]));
      if (isLate()) sheet.appendChild(el("div", { class: "fu-hint", id: "fu-late" }, ["🌙 الوقت متأخر — يُفضّل الإرسال بكرة."]));
      sheet.appendChild(bubble);
      sheet.appendChild(el("label", {}, [el("span", { class: "fu-dim" }, ["✏️ تقدر تعدّل النص قبل الإرسال — التعديل للرسالة دي بس."]), ta]));
      sync();
      var chip = function () { var s2 = MSTATUS[(rev.review || {}).status] || MSTATUS.pending; var c = $("fu-month-status"); if (c) { c.textContent = s2[0]; c.className = "fu-chip " + s2[1]; } };
      sheet.appendChild(el("div", { class: "fu-stack", style: "margin-top:12px" }, [link,
        el("div", { class: "fu-btns two" }, [
          el("button", { class: "fu-btn", id: "fu-month-sent", type: "button", onclick: function () { markMonth(rev, month, "sent", "").then(function () { chip(); toast("اتسجّل إنها اتبعتت ✓"); }, function (e) { toast(errText(e), { err: true }); }); } }, ["✓ تم الإرسال"]),
          el("button", { class: "fu-btn", id: "fu-month-ready", type: "button", onclick: function () { markMonth(rev, month, "ready", "").then(function () { chip(); toast("اتعلّمت جاهزة ✓"); }, function (e) { toast(errText(e), { err: true }); }); } }, ["جاهزة"]),
        ]),
        el("div", { class: "fu-btns two" }, [
          el("button", { class: "fu-btn", id: "fu-copy", type: "button", onclick: function () { copy(ta.value); } }, ["📋 نسخ"]),
          el("button", { class: "fu-btn", id: "fu-month-back", type: "button", onclick: function () { openMonthly(g, month); } }, ["رجوع للقائمة"]),
        ]),
      ]));
    }, { label: "التقرير الشهري" });
  }

  function openReminder(g, V) {
    var res, err = null, rv = hwOf(g.settings);
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
  // "How does the page know what is required?" — mirrors the server rule (Code.gs handleAdminFollowupOverview / _p2fuSummaryFor).
  function requiredGuide() {
    var box = el("section", { class: "fu-sec fu-reqguide", id: "fu-help-required" });
    box.appendChild(el("h3", { style: "margin:0 0 8px" }, ["🧭 إزاي الصفحة بتحدد إيه المطلوب والناقص؟"]));
    box.appendChild(el("ol", { class: "fu-reqlist" }, [
      ["الدروس المتوقعة", "لكل جروب الطالب فيه، الصفحة بتاخد قايمة «واجب» وقايمة «كويز» (ولو لسه ما اتفصلوش بتاخد «المراجعة» للاتنين). وأي درس ليه ميعاد مخصص بيتحسب كمان."],
      ["مطلوب ولا اختياري؟", "مفتاحي «الواجب مطلوب» و«الكويز مطلوب» تحت كل درس. الدرس اللي ملوش إعداد محفوظ يعتبر الاتنين مطلوبين."],
      ["الميعاد", "لو الدرس ليه ميعاد مخصص بيتحسب هو. غير كده بيتحسب ميعاد واجب الجروب (من يوم وساعة الحصة وعدد أيام التسليم)."],
      ["اتسلّم ولا لأ؟", "الصفحة بتدوّر في تسليمات الواجب ونتايج الكويز على نفس رقم الطالب + نفس المادة + نفس الدرس (آخر جزء في مسار الدرس). أي تسجيل مطابق = اتسلّم. لو فيه أكتر من واحد بنعتمد آخر نتيجة."],
      ["الناقص", "ناقص = مطلوب + ما اتسلّمش + الميعاد عدّى. قبل الميعاد بيظهر «لسه بدري» ومش بيتحسب."],
    ].map(function (x) { return el("li", {}, [el("b", {}, [x[0]]), el("span", {}, [" — " + x[1]])]); })));
    box.appendChild(el("div", { class: "fu-hint", id: "fu-help-example" }, [
      el("b", {}, ["مثال: "]),
      "جروب «Sat 6pm» واجبه Ch 2 · L1، وميعاد التسليم الأحد. سارة سلّمت يوم الخميس فتظهر ✓ تم. عمر ما سلّمش: قبل الأحد يظهر «لسه بدري»، وبعد الأحد يظهر ✕ لم يُسلَّم ويتحسب «واجب ناقص». لو الدرس ده مفتاح «الواجب مطلوب» عليه مقفول، عمر مش هيتحسب عليه أصلًا.",
    ]));
    box.appendChild(el("div", { class: "fu-dim", style: "margin-top:8px" }, [
      "لو طالب بيقول إنه سلّم وبرضه ظاهر ناقص: ده معناه إن مفيش تسجيل مطابق وصل للسيرفر (مثلًا التسليم ما اكتملش، أو الدرس متسجّل بمفتاح مختلف). اطلب منه يفتح صفحة الدرس تاني من نفس الجهاز، وراجع تبويب التسليمات في الشيت.",
    ]));
    return box;
  }
  function openHelp(focus) {
    var steps = [
      ["اختار السنة", "من الشريط اللي فوق: الكل / سينيور 1 / سينيور 2. الاختيار بيفلتر الجروبات والطلاب وقوائم الدروس في الصفحة كلها، وبيتفكر لحد ما تغيّره."],
      ["اختار الجروب", "من التبويبات تحت العنوان. الرقم جنب الاسم = عدد الطلاب الظاهرين في السنة المختارة."],
      ["حدد الدروس", "«الحصة الحالية» = حضور ومشاهدة. «واجب وكويز» = الحصة السابقة. أسماء الدروس بتظهر بالفصل والدرس (مثلًا Ch 2 · L1). حرّكهم لقدّام بعد كل حصة."],
      ["سجّل الحضور", "افتح الطالب واختار أونلاين أو سنتر، أو استخدم «الكل سنتر / الكل أونلاين» (بيطبّق على الطلاب الظاهرين بس)."],
      ["ابعت لولي الأمر", "الأزرار تحت كل طالب بتجهّز رسالة جاهزة. راجعها وعدّل لو عايز، وبعدين «فتح واتساب» — الإرسال دايمًا بإيدك."],
      ["عدّل القوالب", "زرار ✏️ فوق بيفتح محرر قوالب الرسائل."],
    ];
    openSheet(function (sheet) {
      sheet.appendChild(el("h2", {}, ["دليل الاستخدام"]));
      var rg = requiredGuide();
      if (focus === "required") { sheet.appendChild(rg); sheet.appendChild(el("h3", { style: "margin:16px 0 8px" }, ["خطوات الاستخدام"])); }
      sheet.appendChild(el("ol", { class: "fu-help fu-guide" }, steps.map(function (x) {
        return el("li", {}, [el("b", {}, [x[0]]), el("span", {}, [" — " + x[1]])]);
      })));
      sheet.appendChild(el("h3", { style: "margin:16px 0 8px" }, ["قواعد الرسائل"]));
      sheet.appendChild(el("ol", { class: "fu-help" }, [
        "الإرسال يدوي بس — مفيش بوتات ولا أتمتة غير رسمية لواتساب (خطر حظر الحساب).",
        "ما تبعتش عشرات الرسائل في دقايق — وزّعها.",
        "تجنّب الإرسال متأخر بالليل (بعد 10 مساءً بتوقيت القاهرة).",
        "رسالة الجروب الأول، ورسالة ولي الأمر بعد الميعاد بس.",
        "بيانات الطلاب وأولياء الأمور تفضل ورا تسجيل دخول الأدمن، ومتتحطش في الريبو.",
      ].map(function (t) { return el("li", {}, [t]); })));
      if (focus !== "required") sheet.appendChild(rg);
      sheet.appendChild(el("button", { class: "fu-btn", id: "fu-close", type: "button", onclick: closeSheet }, ["تمام"]));
    }, { label: "دليل الاستخدام", full: true });
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
    if (STATE.year !== "all" && !visibleTabKeys().length) { root.appendChild(el("div", { class: "fu-empty", id: "fu-year-empty" }, ["مفيش طلاب " + yearLabel(STATE.year) + " لسه."])); return; }
    var V = STATE.view = computeView(g);
    if (d.lessons_error) root.appendChild(el("div", { class: "fu-warnbox", id: "fu-lessons-error", role: "alert" }, ["⚠️ تعذّر تحميل قائمة الدروس من GitHub — قد تكون القائمة ناقصة. (" + (typeof d.lessons_error === "string" ? d.lessons_error : "") + ")"]));
    var fb = flagBanner(); if (fb) root.appendChild(fb);
    var gb = guideBanner(); if (gb) root.appendChild(gb);
    var noGroups = g.unclassified && !visibleGroups().length;
    if (noGroups) root.appendChild(noGroupsCard());
    else if (g.unclassified) root.appendChild(borrowCard());
    if (!noGroups && (!g.unclassified || (g.settings && g.settings.weekday !== null && g.settings.weekday !== undefined))) root.appendChild(nextSessionCard(g, V));
    if (!noGroups) root.appendChild(rolesCard(g, V));
    if (!g.unclassified) root.appendChild(settingsCard(g));
    if (!noGroups) root.appendChild(bannerAndTiles(V));
    if (!g.unclassified) root.appendChild(groupActions(g, V));
    root.appendChild(listHead(V));
    root.appendChild(el("div", { id: "fu-rows" }));
    renderRows(V);
  }
  // A Phase 2 switch is OFF on the server: say which Script Property to set instead of silently hiding the feature.
  function flagBanner() {
    var list = L().flagNotices ? L().flagNotices(STATE.data && STATE.data.flags) : [];
    if (!list.length) return null;
    var box = el("section", { class: "fu-warnbox fu-flagbanner", id: "fu-flag-banner", role: "alert" });
    box.appendChild(el("b", {}, ["⚠️ في ميزات متوقفة على السيرفر"]));
    list.forEach(function (n) {
      box.appendChild(el("div", { class: "fu-flagline", "data-flag": n.flag }, [n.feature + " متوقفة. ضيف ", el("bdi", { dir: "ltr", class: "fu-code" }, [n.property + " = 1"]), " في Apps Script ← Project Settings ← Script Properties."]));
    });
    box.appendChild(el("div", { class: "fu-dim" }, ["مفيش إعادة نشر مطلوبة. بعد ما تضيفها اضغط تحديث. (أو شغّل p3_setup_enable_followup_flags من محرر Apps Script مرة واحدة.)"]));
    box.appendChild(el("button", { class: "fu-btn", id: "fu-flag-reload", type: "button", onclick: function () { if (!STATE.loading) load(true).then(function () { toast("تم التحديث ✓"); }); } }, ["🔄 تحديث"]));
    return box;
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
      var m = /student=(\d+)/.exec(location.hash);
      if (!STATE.hashRead) { STATE.hashRead = true; readHashFilters(); }
      // a deep link to a student the year filter hides switches the filter back to "all"
      if (m && STATE.year !== "all" && data.students[m[1]] && yearOfStudent(data.students[m[1]]) !== STATE.year) { STATE.year = "all"; try { localStorage.setItem("fu-year", "all"); } catch (e) {} }
      var keys = visibleTabKeys();
      if (!STATE.tab || keys.indexOf(STATE.tab) < 0) {
        var t0 = null; try { t0 = sessionStorage.getItem("fu-tab"); } catch (e) {}
        STATE.tab = (t0 && keys.indexOf(t0) >= 0) ? t0 : (keys[0] || NONE_TAB);
      }
      if (!STATE.borrow || visibleGroups().every(function (g) { return g.key !== STATE.borrow; })) STATE.borrow = (visibleGroups()[0] || {}).key || null;
      if (m && !STATE.open && !quiet) {
        STATE.open = m[1];
        var hg = allGroups().filter(function (g) { return g.members.some(function (x) { return pkOf(x.phone) === m[1]; }); })[0];
        if (hg) STATE.tab = hg.key; else if ((data.unclassified || []).some(function (x) { return pkOf(x.phone) === m[1]; })) STATE.tab = NONE_TAB;
      }
      renderYearBar(); renderTabs(); refreshPage();
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
    $("fu-help").addEventListener("click", function () { openHelp(); });
    $("fu-templates").addEventListener("click", openTemplates);
    window.addEventListener("hashchange", function () {
      var m = /student=(\d+)/.exec(location.hash);
      if (STATE.data && m && STATE.open !== m[1]) { STATE.open = m[1]; refreshPage(); }
    });
  }
  function start(session, role) {
    STATE.session = session;
    STATE.role = role || (session && session.role) || "admin";   // "assistant" => hide admin-only controls
    $("fu-refresh").hidden = false; $("fu-templates").hidden = false;
    if (MOCK) $("fu-mock").hidden = false;
    loadTitles().then(function () { load(false); });
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
        // Convenience only: the server re-checks on every call. Assistants (role) are allowed in.
        window.StaffGuard.require(["admin","assistant"], session).then(function (role) { if (role) start(session, role); });
      }, { staff: true });
    }, function (e) { renderError(e.message); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
