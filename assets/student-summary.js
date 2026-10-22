/* ==========================================================================
   student-summary.js — dashboard/student-summary.html (Phase 2, Session 2).
   One student: quiz scores + average, homework submitted vs missed (only REQUIRED items past due count),
   written-answer status, attendance, watch + video access, parent notifications, monthly review.
   Backend: admin_student_summary / admin_monthly_review / admin_log_parent_notification (Phase2_Followup.gs).
   ?mock=1 reads dashboard/_fixtures/*.json and writes nothing. Admin only, like followup.html.
   ========================================================================== */
(function () {
  "use strict";
  var MOCK = /[?&]mock=1\b/.test(location.search);
  var T = function () { return window.FollowupTemplates || {}; };
  var L = function () { return window.FollowupLogic || {}; };
  var ST = { session: null, roster: null, key: "", month: "", from: "", to: "", data: null, err: "", loading: false, today: "" };
  var MKS = { overview: null, sum: null, log: {}, month: {} };

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "class") n.className = v; else if (k === "html") n.innerHTML = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; n.appendChild(typeof c === "object" && c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function pkOf(p) { return L().phoneKey ? L().phoneKey(p) : String(p || "").replace(/\D/g, "").slice(-10); }
  function dm(v) { var m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v || "")); return m ? (+m[3]) + "/" + (+m[2]) : ""; }
  function lessonName(p) { p = String(p || ""); try { return T().prettyLesson ? T().prettyLesson(p) : p.split("/").pop(); } catch (e) { return p.split("/").pop(); } }
  function ymdAdd(ymd, n) { var p = ymd.split("-").map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return t.getUTCFullYear() + "-" + String(t.getUTCMonth() + 1).padStart(2, "0") + "-" + String(t.getUTCDate()).padStart(2, "0"); }
  function monthEnd(m) { var y = +m.slice(0, 4), mo = +m.slice(5, 7); return m + "-" + String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0"); }
  function monthLabel(m) { return T().monthLabel ? T().monthLabel(m) : m; }
  function qs(name) { var m = new RegExp("[?&]" + name + "=([^&]*)").exec(location.search); return m ? decodeURIComponent(m[1]) : ""; }

  var toastTimer = null;
  function toast(text, err) {
    var host = clear($("fu-toast-host"));
    host.appendChild(el("div", { class: "fu-toast" + (err ? " err" : ""), role: err ? "alert" : "status" }, [el("span", {}, [text])]));
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { clear(host); }, err ? 7000 : 3500);
  }
  function errText(e) {
    var m = (e && e.message) || "حصل خطأ، جرّب تاني.";
    if (m === "Not authorized.") m = "الحساب ده مسجّل دخول بس مش أدمن. فعّل is_admin = TRUE في شيت Students.";
    return m;
  }

  // ---- api (real: AuthEngine.adminCall; mock: fixtures, in memory) ---------------------------------
  function fx(name) { return fetch("_fixtures/" + name, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("fixture " + name + " " + r.status); return r.json(); }); }
  function mockApi(p) {
    var load = MKS.overview ? Promise.resolve() : Promise.all([fx("followup-overview.json"), fx("student-summary.json")]).then(function (a) { MKS.overview = a[0]; MKS.sum = a[1]; MKS.log = clone(a[0].parent_log || {}); });
    return load.then(function () {
      var d = MKS.overview;
      if (p.action === "admin_followup_overview") return clone(d);
      if (p.action === "admin_student_summary") {
        var st = d.students[pkOf(p.student)]; if (!st) return { ok: false, error: "Student not found." };
        var o = clone(MKS.sum); o.student = { phone: st.phone, name: st.name, year: st.year, parent_phone: st.parent_phone };
        o.groups = d.groups.filter(function (g) { return g.members.some(function (m) { return pkOf(m.phone) === pkOf(st.phone); }); }).map(function (g) { return { group: g.group, key: g.key }; });
        o.range = { from: p.from, to: p.to };
        o.notifications = (MKS.log[pkOf(st.phone)] || []).map(function (n) { return { student: st.phone, kind: n.kind, ref: n.ref, sent_at: n.sent_at, by: "mock", note: n.note || "" }; });
        return o;
      }
      if (p.action === "admin_log_parent_notification") {
        var k = pkOf(p.student), arr = MKS.log[k] = MKS.log[k] || [], ref = String(p.ref || "").toLowerCase();
        var hit = arr.filter(function (n) { return n.kind === p.kind && n.ref === ref; })[0];
        if (hit) { hit.note = p.note || ""; return { ok: true, created: false, notification: clone(hit) }; }
        var nn = { kind: p.kind, ref: ref || "custom-" + Date.now(), sent_at: d.today + " 12:00:00", note: p.note || "" };
        arr.unshift(nn); return { ok: true, created: true, notification: nn };
      }
      if (p.action === "admin_monthly_review") {
        var mk = pkOf(p.student) + "|" + p.month;
        if (p.op === "mark") { MKS.month[mk] = { status: p.status, sent_at: p.status === "sent" ? d.today + " 12:00:00" : "", note: p.note || "" }; return { ok: true, review: Object.assign({ student: p.student, month: p.month }, MKS.month[mk]) }; }
        var s2 = clone(MKS.sum), st2 = d.students[pkOf(p.student)];
        s2.student = { phone: st2.phone, name: st2.name, year: st2.year, parent_phone: st2.parent_phone }; s2.groups = [];
        s2.range = { from: p.month + "-01", to: monthEnd(p.month) };
        return { ok: true, month: p.month, range: s2.range, closed: true, reviews: [{ student: s2.student, summary: s2, review: MKS.month[mk] || { status: "pending", sent_at: "", note: "" } }] };
      }
      return { ok: false, error: "Unknown action" };
    });
  }
  function api(p) {
    var run = MOCK ? mockApi(p) : (window.AuthEngine && window.AuthEngine.adminCall ? window.AuthEngine.adminCall(ST.session, p) : Promise.reject(new Error("الصفحة محتاجة أحدث assets/auth.js — شغّل Sync site assets في Quiz Maker.")));
    return run.then(function (res) { if (res && res.ok === false) throw new Error(res.error || "حصل خطأ"); return res; });
  }

  // ---- views ---------------------------------------------------------------------------------------
  function linkTo(pk) { return "student-summary.html?student=" + pk + (MOCK ? "&mock=1" : ""); }
  function chip(text, tone, extra) { return el("span", Object.assign({ class: "fu-chip " + (tone || "grey") }, extra || {}), [text]); }
  function row(name, kids, cls) { return el("div", { class: "fu-lrow" + (cls ? " " + cls : "") }, [el("span", { class: "nm", dir: "auto" }, [name]), el("span", { class: "fu-chips" }, kids || [])]); }
  function card(title, kids, id) { return el("section", { class: "fu-card", id: id || null }, [el("h3", { style: "margin-bottom:8px" }, [title])].concat(kids)); }
  function kpi(label, value, tone, id) { return el("div", { class: "fu-kpi" + (tone ? " " + tone : ""), id: id || null }, [el("b", {}, [String(value)]), el("span", {}, [label])]); }
  function pct(n) { return n === null || n === undefined ? "—" : Math.round(n) + "%"; }

  function renderPicker() {
    var root = clear($("fu-root")), r = ST.roster, inGroup = {};
    root.appendChild(el("p", { class: "fu-dim" }, ["اختار الطالب:"]));
    var q = el("input", { type: "search", id: "ss-q", class: "fu-field", placeholder: "🔍 ابحث بالاسم أو الرقم…", "aria-label": "بحث", autocomplete: "off" });
    var list = el("div", { id: "ss-list" });
    function paint() {
      clear(list); var term = q.value.trim().toLowerCase(), n = 0;
      Object.keys(r.students).map(function (k) { return Object.assign({ key: k }, r.students[k]); }).sort(function (a, b) { return (a.name || "").toLowerCase() < (b.name || "").toLowerCase() ? -1 : 1; }).forEach(function (s) {
        if (term && (s.name || "").toLowerCase().indexOf(term) < 0 && String(s.phone).indexOf(term.replace(/\D/g, "") || "\u0000") < 0) return;
        n++;
        var gs = r.groups.filter(function (g) { return g.members.some(function (m) { return pkOf(m.phone) === s.key; }); }).map(function (g) { return g.group; });
        list.appendChild(el("a", { class: "fu-pickrow", href: linkTo(s.key), "data-pk": s.key }, [el("span", { style: "flex:1;font-weight:700", dir: "auto" }, [s.name]), gs.length ? chip(gs[0], "grey") : chip("بدون جروب", "amber")]));
      });
      if (!n) list.appendChild(el("div", { class: "fu-empty" }, ["مفيش نتائج"]));
    }
    q.addEventListener("input", paint); root.appendChild(q); root.appendChild(el("div", { style: "height:10px" })); root.appendChild(list); paint();
  }

  function renderSummary() {
    var root = clear($("fu-root")), s = ST.data, t = s.totals || {};
    var ck = L().checkParentPhone ? L().checkParentPhone(s.student.parent_phone, s.student.phone) : { level: "ok" };
    // header
    var gchips = (s.groups || []).map(function (g) { return chip(g.group, "grey"); });
    root.appendChild(el("section", { class: "fu-card", id: "ss-student" }, [
      el("div", { class: "fu-row fu-between" }, [el("h2", { style: "margin:0;font-size:22px", dir: "auto", id: "ss-name" }, [s.student.name]), s.student.year ? chip(s.student.year, "grey") : null]),
      el("div", { class: "fu-chips", style: "margin-top:8px" }, gchips.length ? gchips : [chip("بدون جروب", "amber")]),
      el("div", { class: "fu-phone", style: "margin-top:10px" }, [el("span", {}, ["ولي الأمر"]), ck.level === "missing" ? el("span", {}, ["—"]) : el("bdi", {}, [s.student.parent_phone]), ck.level === "ok" ? chip("✓", "green") : chip(ck.level === "missing" ? "⚠️ لا رقم" : "⚠️ راجع الرقم", ck.level === "missing" ? "red" : "amber")]),
      el("div", { style: "margin-top:10px" }, [el("a", { class: "fu-btn", href: "student-summary.html" + (MOCK ? "?mock=1" : ""), id: "ss-change" }, ["غيّر الطالب"])]),
    ]));
    // range
    var monthSel = el("select", { class: "fu-field", id: "ss-month", "aria-label": "الشهر", style: "direction:rtl;font:inherit" }, monthList().map(function (m) { return el("option", { value: m }, [monthLabel(m)]); }));
    monthSel.value = ST.month;
    monthSel.addEventListener("change", function () { ST.month = monthSel.value; ST.from = ST.month + "-01"; ST.to = monthEnd(ST.month); loadSummary(); });
    var from = el("input", { class: "fu-field", type: "date", id: "ss-from", value: ST.from, "aria-label": "من", style: "direction:ltr" }), to = el("input", { class: "fu-field", type: "date", id: "ss-to", value: ST.to, "aria-label": "إلى", style: "direction:ltr" });
    root.appendChild(el("section", { class: "fu-card", "aria-label": "الفترة" }, [
      el("label", {}, [el("span", { class: "fu-label" }, ["الشهر"]), monthSel]),
      el("div", { class: "fu-row", style: "margin-top:10px" }, [el("label", { style: "flex:1;min-width:140px" }, [el("span", { class: "fu-dim" }, ["من"]), from]), el("label", { style: "flex:1;min-width:140px" }, [el("span", { class: "fu-dim" }, ["إلى"]), to])]),
      el("div", { style: "margin-top:10px" }, [el("button", { class: "fu-btn", id: "ss-apply", type: "button", onclick: function () { if (from.value && to.value && from.value <= to.value) { ST.from = from.value; ST.to = to.value; loadSummary(); } else toast("اختار فترة صحيحة", true); } }, ["تطبيق الفترة"])]),
    ]));
    // KPIs
    root.appendChild(el("div", { class: "fu-kpis", id: "ss-kpis" }, [
      kpi("متوسط الكويزات", pct(t.quiz_avg_pct), t.quiz_avg_pct !== null && t.quiz_avg_pct >= 90 ? "good" : "", "kpi-quiz-avg"),
      kpi("كويزات اتحلت", t.quiz_count || 0, "", "kpi-quiz-count"),
      kpi("كويزات ناقصة", t.quiz_missed || 0, t.quiz_missed ? "bad" : "good", "kpi-quiz-missed"),
      kpi("واجبات اتسلّمت", t.homework_count || 0, "", "kpi-hw-count"),
      kpi("واجبات ناقصة", t.homework_missed || 0, t.homework_missed ? "bad" : "good", "kpi-hw-missed"),
      kpi("حضور سنتر / أونلاين", (t.attendance_center || 0) + " / " + (t.attendance_online || 0), "", "kpi-att"),
      kpi("متوسط المشاهدة", pct(t.watch_avg_pct), "", "kpi-watch"),
      kpi("إجابات كتابية (معلّق / اتصحّح)", (t.written_pending || 0) + " / " + (t.written_graded || 0), t.written_pending ? "bad" : "", "kpi-written"),
    ]));
    // quizzes + homework
    root.appendChild(card("📝 الكويزات", (s.quizzes || []).length ? s.quizzes.map(function (q) {
      return row(lessonName(q.path || q.lesson), [chip(q.score + " / " + q.total, q.pct >= 90 ? "green" : (q.pct >= 50 ? "amber" : "red")), chip(dm(q.date), "grey"), q.attempts > 1 ? chip(q.attempts + " محاولات", "grey") : null]);
    }) : [el("div", { class: "fu-dim" }, ["لا توجد كويزات في الفترة دي"])], "ss-quizzes"));
    root.appendChild(card("✍️ الواجبات", (s.homework || []).length ? s.homework.map(function (h) {
      return row(lessonName(h.path || h.lesson), [chip("✓ اتسلّم", "green"), h.score !== null && h.score !== undefined ? chip(h.score + " / " + h.total, "grey") : null, chip(dm(h.date), "grey")]);
    }) : [el("div", { class: "fu-dim" }, ["لا توجد واجبات في الفترة دي"])], "ss-homework"));
    // expected items (what is missing)
    root.appendChild(card("📌 المطلوب والناقص", (s.expected || []).length ? s.expected.map(function (e) {
      var q = e.quiz, h = e.homework;
      return row(lessonName(e.lesson), [
        q.required ? chip(q.done ? "كويز ✓" : (q.missed ? "كويز ✕ ناقص" : "كويز لسه"), q.done ? "green" : (q.missed ? "red" : "amber"), { "data-q": q.done ? "done" : (q.missed ? "missed" : "pending") }) : chip("كويز اختياري", "grey", { "data-q": "optional" }),
        h.required ? chip(h.done ? "واجب ✓" : (h.missed ? "واجب ✕ ناقص" : "واجب لسه (" + dm(h.due) + ")"), h.done ? "green" : (h.missed ? "red" : "amber"), { "data-h": h.done ? "done" : (h.missed ? "missed" : "pending") }) : chip("واجب اختياري", "grey", { "data-h": "optional" }),
      ]);
    }) : [el("div", { class: "fu-dim" }, ["مفيش دروس مطلوبة للطالب ده (حط جروبه ودروس الواجب والكويز أو ميعاد تسليم للدرس)."])], "ss-expected"));
    // attendance + watch + access
    var lessons = {};
    (s.attendance || []).forEach(function (a) { (lessons[a.lesson] = lessons[a.lesson] || {}).att = a; });
    (s.watch || []).forEach(function (w) { (lessons[w.lesson] = lessons[w.lesson] || {}).watch = w; });
    (s.video_access || []).forEach(function (v) { (lessons[v.lesson] = lessons[v.lesson] || {}).access = v; });
    var keys = Object.keys(lessons).sort();
    root.appendChild(card("🏫 الحضور والمشاهدة والفيديو", keys.length ? keys.map(function (k) {
      var o = lessons[k];
      return row(lessonName(k), [o.att ? chip(o.att.mode === "center" ? "🏫 سنتر" : "💻 أونلاين", o.att.mode === "center" ? "green" : "grey") : null, o.watch ? chip("▶ " + pct(o.watch.pct), o.watch.pct >= 80 ? "green" : "amber") : null, o.access ? chip(o.access.can_watch ? "🔓 الفيديو مفتوح" : "🔒 الفيديو مقفول", o.access.can_watch ? "green" : "red", { "data-access": o.access.can_watch ? "open" : "locked" }) : null]);
    }) : [el("div", { class: "fu-dim" }, ["لا توجد بيانات"])], "ss-attendance"));
    // written answers
    var w = s.written || {};
    root.appendChild(card("📷 الإجابات الكتابية", [
      el("div", { class: "fu-chips" }, [chip("⏳ معلّق " + (w.pending || 0), w.pending ? "amber" : "grey", { id: "ss-w-pending" }), chip("✓ اتصحّح " + (w.graded || 0), "green"), (w.max ? chip("الدرجة " + w.awarded + " / " + w.max, "grey") : null)]),
    ].concat((w.items || []).map(function (i) { return row(lessonName(i.lesson) + " · " + i.question, [i.graded ? chip(i.awarded + " / " + i.max, "green") : chip("معلّق", "amber")]); })), "ss-written"));
    // parent notifications
    root.appendChild(parentCard());
    // monthly review
    root.appendChild(monthlyCard());
  }

  function monthList() {
    var t = ST.today || new Date().toISOString().slice(0, 10), y = +t.slice(0, 4), m = +t.slice(5, 7), out = [];
    for (var i = 0; i < 12; i++) { out.push(y + "-" + String(m).padStart(2, "0")); m--; if (m < 1) { m = 12; y--; } }
    if (ST.month && out.indexOf(ST.month) < 0) out.unshift(ST.month);
    return out;
  }

  var KIND_AR = { homework: "واجب", quiz: "كويز", monthly: "شهري", custom: "رسالة" };
  function parentCard() {
    var s = ST.data, ns = s.notifications || [];
    var opts = [el("option", { value: "custom|" }, ["رسالة عامة"])];
    (s.expected || []).forEach(function (e) {
      opts.push(el("option", { value: "quiz|" + e.lesson }, ["كويز — " + lessonName(e.lesson)]));
      opts.push(el("option", { value: "homework|" + e.lesson }, ["واجب — " + lessonName(e.lesson)]));
    });
    var sel = el("select", { class: "fu-field", id: "ss-log-kind", "aria-label": "موضوع التواصل", style: "direction:rtl;font:inherit" }, opts);
    var note = el("input", { class: "fu-field", id: "ss-log-note", placeholder: "ملاحظة (اختياري)", dir: "auto", "aria-label": "ملاحظة" });
    var go = el("button", { class: "fu-btn primary", id: "ss-log-go", type: "button", onclick: function () {
      var p = sel.value.split("|"); go.disabled = true;
      api({ action: "admin_log_parent_notification", student: s.student.phone, kind: p[0], ref: p[1], note: note.value }).then(function () { toast("اتسجّل التواصل ✓"); return loadSummary(true); }, function (e) { go.disabled = false; toast(errText(e), true); });
    } }, ["📨 سجّل تواصل مع ولي الأمر"]);
    var list = ns.length ? ns.map(function (n) { return row((KIND_AR[n.kind] || n.kind) + (n.ref && n.kind !== "custom" && n.kind !== "monthly" ? " — " + lessonName(n.ref) : (n.kind === "monthly" ? " — " + monthLabel(n.ref) : "")) + (n.note ? " · " + n.note : ""), [chip("📨 " + dm(n.sent_at), "green")]); }) : [el("div", { class: "fu-dim", id: "ss-nonotif" }, ["لسه ما اتسجّلش تواصل في الفترة دي"])];
    return card("📨 التواصل مع ولي الأمر", list.concat([el("div", { class: "fu-logbox" }, [sel, note, go])]), "ss-parent");
  }

  function monthlyCard() {
    var host = el("div", { id: "ss-monthly-out" });
    var btn = el("button", { class: "fu-btn", id: "ss-monthly", type: "button", onclick: function () {
      btn.disabled = true; clear(host);
      api({ action: "admin_monthly_review", month: ST.month, student: ST.data.student.phone }).then(function (r) { btn.disabled = false; paintMonthly(host, r.reviews[0]); }, function (e) { btn.disabled = false; host.appendChild(el("div", { class: "fu-err", id: "ss-monthly-error", role: "alert" }, [errText(e)])); });
    } }, ["📅 جهّز التقرير الشهري (" + monthLabel(ST.month) + ")"]);
    return card("📅 التقرير الشهري", [btn, host], "ss-monthly-card");
  }
  function paintMonthly(host, rev) {
    var r = T().composeFull(rev.summary, "monthly_review", { month: ST.month, templates: {} });
    var ck = L().checkParentPhone ? L().checkParentPhone(rev.student.parent_phone, rev.student.phone) : { level: "ok", wa: "" };
    var bubble = el("div", { class: "fu-bubble", id: "ss-preview", dir: "auto" }), ta = el("textarea", { class: "fu-field fu-msg-edit", id: "ss-msg", dir: "auto", "aria-label": "نص التقرير" }); ta.value = r.text;
    var link = el("a", { class: "fu-btn wa", id: "ss-wa", target: "_blank", rel: "noopener", href: "#" }, ["فتح واتساب ↗"]);
    function sync() { bubble.innerHTML = T().formatPreview(ta.value); if (ck.level !== "missing" && ck.wa) link.href = T().waLink(ck.wa, ta.value); else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); } }
    ta.addEventListener("input", sync); sync();
    var status = (rev.review && rev.review.status) || "pending";
    clear(host);
    host.appendChild(el("div", { class: "fu-row fu-between", style: "margin:10px 0" }, [chip("الحالة: " + ({ pending: "معلّق", ready: "جاهز", sent: "اتبعت", closed: "مقفول" }[status] || status), status === "sent" ? "green" : "amber", { id: "ss-month-status" })]));
    if (ck.level === "missing") host.appendChild(el("div", { class: "fu-warnbox", role: "alert" }, ["⚠️ لا يوجد رقم ولي أمر — تقدر تنسخ الرسالة بس."]));
    host.appendChild(bubble); host.appendChild(ta);
    host.appendChild(el("div", { class: "fu-stack", style: "margin-top:12px" }, [link, el("div", { class: "fu-btns two" }, [
      el("button", { class: "fu-btn", id: "ss-copy", type: "button", onclick: function () { var p; try { p = T().copyText(ta.value); } catch (e) {} Promise.resolve(p).then(function () { toast("تم النسخ ✓"); }, function () { toast("تعذّر النسخ", true); }); } }, ["📋 نسخ"]),
      el("button", { class: "fu-btn", id: "ss-month-sent", type: "button", onclick: function () {
        api({ action: "admin_monthly_review", op: "mark", month: ST.month, student: rev.student.phone, status: "sent", note: "" }).then(function () { toast("اتسجّل إنها اتبعتت ✓"); return loadSummary(true); }, function (e) { toast(errText(e), true); });
      } }, ["✓ تم الإرسال"]),
    ])]));
  }

  // ---- load ------------------------------------------------------------------------------------------
  function loadSummary(quiet) {
    if (!quiet) { ST.loading = true; clear($("fu-root")).appendChild(el("div", { class: "fu-skel" })); }
    return api({ action: "admin_student_summary", student: ST.roster.students[ST.key].phone, from: ST.from, to: ST.to }).then(function (r) {
      ST.data = r; ST.loading = false; var y = window.scrollY; renderSummary(); if (quiet) window.scrollTo(0, y);
    }, function (e) {
      ST.loading = false; var root = clear($("fu-root"));
      root.appendChild(el("div", { class: "fu-err", id: "ss-error", role: "alert" }, [errText(e)]));
      root.appendChild(el("div", { style: "margin-top:12px" }, [el("button", { class: "fu-btn primary", type: "button", onclick: function () { loadSummary(); } }, ["حاول تاني"])]));
    });
  }
  function start(session) {
    ST.session = session; if (MOCK) $("fu-mock").hidden = false;
    clear($("fu-root")).appendChild(el("div", { class: "fu-skel" }));
    api({ action: "admin_followup_overview" }).then(function (o) {
      ST.roster = { students: o.students || {}, groups: o.groups || [] }; ST.today = o.today || "";
      (o.unclassified || []).forEach(function (u) { var k = pkOf(u.phone); if (!ST.roster.students[k]) ST.roster.students[k] = { phone: u.phone, name: u.name }; });
      var k = qs("student");
      if (!k) { renderPicker(); return; }
      if (!ST.roster.students[k]) { clear($("fu-root")).appendChild(el("div", { class: "fu-err", id: "ss-error", role: "alert" }, ["الطالب ده مش موجود."])); return; }
      ST.key = k; ST.month = (ST.today || new Date().toISOString().slice(0, 10)).slice(0, 7); ST.from = ST.month + "-01"; ST.to = ST.today || monthEnd(ST.month);
      loadSummary();
    }, function (e) {
      var root = clear($("fu-root")); root.appendChild(el("div", { class: "fu-err", id: "ss-error", role: "alert" }, [errText(e)]));
      root.appendChild(el("div", { style: "margin-top:12px" }, [el("button", { class: "fu-btn primary", type: "button", onclick: function () { start(session); } }, ["حاول تاني"])]));
    });
  }
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("لم يتم تحميل " + src)); }; document.head.appendChild(s); }); }
  function boot() {
    var missing = []; if (!window.FollowupLogic) missing.push("assets/followup-logic.js"); if (!window.FollowupTemplates) missing.push("assets/followup-templates.js");
    if (missing.length) { clear($("fu-root")).appendChild(el("div", { class: "fu-err", id: "ss-error", role: "alert" }, ["ملفات ناقصة: " + missing.join("، ")])); return; }
    if (MOCK) { start(null); return; }
    clear($("fu-root")).appendChild(el("span", { class: "fu-dim" }, ["جاري التحقق من تسجيل الدخول…"]));
    loadScript("/assets/auth.js").then(function () {
      window.AuthEngine.mount("#authgate", function (session) {
        var gate = $("authgate"); if (gate) gate.remove();
        if (!session.session_token) { var r = clear($("fu-root")); r.appendChild(el("div", { class: "fu-err" }, ["تسجيل الدخول المحفوظ ناقصه رمز الجلسة. ادخل تاني."])); r.appendChild(el("button", { class: "fu-btn primary", type: "button", onclick: function () { window.AuthEngine.clearSession(); location.reload(); } }, ["سجّل خروج وادخل تاني ←"])); return; }
        if (session.is_admin === false) { location.href = "student.html"; return; }   // convenience only: the server re-checks is_admin
        start(session);
      });
    }, function (e) { clear($("fu-root")).appendChild(el("div", { class: "fu-err", id: "ss-error", role: "alert" }, [e.message])); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
