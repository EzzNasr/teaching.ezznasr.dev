/* ==========================================================================
   requirements.js — dashboard/requirements.html (Follow-up v2 / S4). Staff page (admin + assistant).

   Tabs: Global · Groups (overrides + manual monthly checklist) · Preview (one student) · History.
   Server actions (guide 3.3): admin_req_get, admin_req_save_global, admin_req_save_group, admin_req_check,
   admin_req_history. The group list and members come from the existing admin_followup_overview.
   The precedence rules come from assets/requirements-logic.js (same rules as Requirements.gs).

   ?mock=1  -> everything runs on an in-memory fixture below; nothing is sent anywhere, nothing is saved.
   No innerHTML with data: every string is set with textContent.
   ========================================================================== */
(function () {
  "use strict";

  var TZ_LABEL = "Alex";                     // any time zone a person reads says this word
  var RL = window.RequirementsLogic;
  var MOCK = /[?&]mock=1\b/.test(location.search);

  var AR = {
    modes: { inherit: "زي العام", on: "مفعّل", off: "متوقف", custom: "مخصّص" },
    // One line under the choices: what the picked mode does for this group.
    modeHelp: {
      inherit: "زي العام: المجموعة دي بتمشي على الإعداد العام زي ما هو.",
      on: "مفعّل: المطلوب ده شغّال للمجموعة دي حتى لو متقفل في العام، بنفس أرقام العام.",
      off: "متوقف: المجموعة دي مش بتتحاسب على المطلوب ده خالص (مش بيدخل في الالتزام ولا التقرير).",
      custom: "مخصّص: شغّال للمجموعة دي بأرقام خاصة بيها (النسبة أو الدرجة أو التقرير) بدل أرقام العام."
    },
    measure: {
      watch: "بنحسب نسبة مشاهدة الطالب للفيديو. بيعتبر خلّص لما يوصل للنسبة المطلوبة.",
      homework: "بنشوف هل الطالب سلّم واجب الدرس قبل الموعد النهائي.",
      quiz: "بنشوف هل الطالب حلّ كويز الدرس. لو حددت حد أدنى لازم درجته توصله.",
      attendance: "بنحسب حضور الطالب للحصة زي ما اتسجّل في صفحة المتابعة.",
      written_answers: "بنشوف هل الطالب بعت الإجابات المكتوبة بتاعة الدرس.",
      manual: "مطلوب بتقيّمه بنفسك كل شهر لكل طالب (تم / لم يتم). بتسجّله من تبويب المجموعات."
    }
  };

  var STATE = { session: null, role: "admin", data: null, overview: null, overviewErr: "", tab: "global", group: "", copyFrom: "",
                month: "", mreq: "", student: "", history: null, loading: false, busy: {}, newOpen: false, newDraft: { ar: "", en: "" }, dlg: null };

  // ---- tiny DOM helpers ----------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v === null || v === undefined) return;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function chip(text, cls) { return el("span", { class: "rq-chip" + (cls ? " " + cls : "") }, [text]); }
  function pk(p) { return RL.phoneKey(p); }
  function currentMonth() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7); }
    catch (e) { return new Date().toISOString().slice(0, 7); }
  }
  function fmtAt(s) {   // "2026-11-02T16:05:00+02:00" -> "2026-11-02 16:05"
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(s || ""));
    return m ? m[1] + " " + m[2] : String(s || "");
  }

  // ---- toast + dialog ------------------------------------------------------------------------------
  var toastTimer = null;
  function toast(text, opt) {
    opt = opt || {};
    var host = clear($("rq-toast-host"));
    host.appendChild(el("div", { class: "rq-toast" + (opt.err ? " err" : ""), role: opt.err ? "alert" : "status" }, [text]));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { clear(host); }, opt.err ? 7000 : 3000);
  }
  function confirmDialog(title, body, okText, onOk) {
    var layer = clear($("rq-layer"));
    function close() { clear(layer); }
    var dlg = el("div", { class: "rq-dlg", id: "rq-dialog", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("h3", {}, [title]), el("p", { class: "rq-dim" }, [body]),
      el("div", { class: "rq-row" }, [
        el("button", { class: "rq-btn primary", id: "rq-dialog-ok", type: "button", onclick: function () { close(); onOk(); } }, [okText]),
        el("button", { class: "rq-btn", id: "rq-dialog-cancel", type: "button", onclick: close }, ["إلغاء"])
      ])
    ]);
    layer.appendChild(el("div", { class: "rq-veil", onclick: function (e) { if (e.target === e.currentTarget) close(); } }, [dlg]));
    $("rq-dialog-cancel").focus();
  }

  // ==========================================================================
  //   MOCK BACKEND (only with ?mock=1): same validation and precedence as the server, in memory.
  // ==========================================================================
  var MK = null;
  function mockInit() {
    if (MK) return;
    MK = {
      rows: [], over: {}, checks: {}, audit: [],
      groups: { "sat 6pm": "Sat 6pm", "mon 5pm": "Mon 5pm" },
      members: { "sat 6pm": [["01012345001", "Mariam Ahmed"], ["01012345002", "Sara Mahmoud"], ["01012345003", "Omar Ali"]], "mon 5pm": [["01012345004", "Nour Hassan"], ["01012345005", "Youssef Samir"]] },
      unclassified: [["01512345012", "Mostafa Adel"]]
    };
  }
  function mClone(o) { return JSON.parse(JSON.stringify(o)); }
  function mCat() { return RL.normalizeCatalog(MK.rows); }
  function mAudit(act, target, what) { MK.audit.unshift({ at: new Date().toISOString().slice(0, 16) + ":00+02:00", by: "Mock Teacher", role: "admin", what: act + " " + target + ": " + what }); }
  function mockApi(p) {
    mockInit();
    return new Promise(function (res) {
      setTimeout(function () { try { res(mockRoute(p)); } catch (e) { res({ ok: false, error: e.message }); } }, 30);
    });
  }
  function mockRoute(p) {
    var a = p.action, cat = mCat(), i;
    if (a === "admin_followup_overview") {
      var students = {};
      var groups = Object.keys(MK.groups).map(function (k) {
        return { group: MK.groups[k], key: k, members: MK.members[k].map(function (m) { students[pk(m[0])] = { phone: m[0], name: m[1] }; return { phone: m[0], name: m[1] }; }) };
      });
      MK.unclassified.forEach(function (m) { students[pk(m[0])] = { phone: m[0], name: m[1] }; });
      return { ok: true, groups: groups, unclassified: MK.unclassified.map(function (m) { return { phone: m[0], name: m[1] }; }), students: students };
    }
    if (a === "admin_req_get") {
      var eff = {}; Object.keys(MK.groups).forEach(function (k) { eff[k] = RL.resolve(cat, MK.over[k]); });
      var out = { ok: true, catalog: cat, groups: mClone(MK.over), effective: eff, unclassified: RL.resolve(cat, null), group_names: mClone(MK.groups) };
      if (p.month) { out.month = p.month; out.checks = {}; Object.keys(MK.checks).forEach(function (k) { var x = k.split("|"); if (x[2] === p.month) { (out.checks[x[0]] = out.checks[x[0]] || {})[x[1]] = mClone(MK.checks[k]); } }); }
      return out;
    }
    if (a === "admin_req_save_global") {
      var key = String(p.key || "").trim(), patch = p.patch || {};
      if (!key || !Object.keys(patch).length) return { ok: false, error: "Nothing to change." };
      var cur = null; cat.forEach(function (c) { if (c.key === key) cur = c; });
      var row = null; MK.rows.forEach(function (r) { if (r.key === key) row = r; });
      if (!cur) {
        if (!RL.isCustomKey(key)) return { ok: false, error: "Unknown requirement \"" + key + "\"." };
        if (patch.kind !== "manual") return { ok: false, error: "A new requirement must have kind \"manual\"." };
        if (cat.filter(function (c) { return c.kind === "manual"; }).length >= RL.MAX_CUSTOM) return { ok: false, error: "At most " + RL.MAX_CUSTOM + " custom requirements." };
        if (!String(patch.label_ar || "").trim() && !String(patch.label_en || "").trim()) return { ok: false, error: "A new requirement needs a label." };
        row = { key: key, label_ar: patch.label_ar || "", label_en: patch.label_en || "", enabled: true, in_monthly_report: true, parent_message: false, weight: 1, sort: MK.rows.length + 1, edited: true };
        MK.rows.push(row); mAudit("global", key, "created"); return { ok: true, requirement: mCat().filter(function (c) { return c.key === key; })[0] };
      }
      if (!row) { row = { key: key }; MK.rows.push(row); }
      if (patch.weight !== undefined && !RL.validWeight(patch.weight)) return { ok: false, error: "weight must be a number from 0 to 10." };
      if (patch.rule !== undefined) { var v = RL.validateRule(key, patch.rule); if (!v.ok) return { ok: false, error: v.error }; row.rule = v.rule; }
      ["enabled", "in_monthly_report", "parent_message", "weight", "label_ar", "label_en"].forEach(function (f) { if (patch[f] !== undefined) row[f] = patch[f]; });
      row.edited = true; mAudit("global", key, Object.keys(patch).join(", "));
      return { ok: true, requirement: mCat().filter(function (c) { return c.key === key; })[0] };
    }
    if (a === "admin_req_save_group") {
      var gk = RL.groupKey(p.group), rk = String(p.key || "");
      if (!MK.groups[gk]) return { ok: false, error: "Unknown group." };
      if (!cat.some(function (c) { return c.key === rk; })) return { ok: false, error: "Unknown requirement \"" + rk + "\"." };
      if (RL.MODES.indexOf(p.mode) < 0) return { ok: false, error: "mode must be inherit, on, off or custom." };
      MK.over[gk] = MK.over[gk] || {};
      if (p.mode === "inherit") delete MK.over[gk][rk];
      else {
        var o = { mode: p.mode, note: p.note || "" };
        if (p.mode === "custom") {
          var pt = p.patch || {};
          if (pt.rule === undefined && pt.in_monthly_report === undefined) return { ok: false, error: "mode \"custom\" needs a rule or in_monthly_report." };
          if (pt.rule !== undefined) { var vr = RL.validateRule(rk, pt.rule); if (!vr.ok) return { ok: false, error: vr.error }; o.rule = vr.rule; }
          if (pt.in_monthly_report !== undefined) o.in_monthly_report = pt.in_monthly_report;
        }
        MK.over[gk][rk] = o;
      }
      mAudit("group", gk + "|" + rk, p.mode);
      return { ok: true, effective: RL.resolve(cat, MK.over[gk]) };
    }
    if (a === "admin_req_check") {
      var c0 = null; cat.forEach(function (c) { if (c.key === p.key) c0 = c; });
      if (!c0 || c0.kind !== "manual") return { ok: false, error: "Only manual requirements are ticked by hand." };
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month || "")) return { ok: false, error: "month must be yyyy-MM." };
      var ck = pk(p.student) + "|" + p.key + "|" + p.month;
      if (p.met === null && !p.note) delete MK.checks[ck]; else MK.checks[ck] = { met: p.met, note: p.note || "" };
      mAudit("check", ck, String(p.met));
      return { ok: true };
    }
    if (a === "admin_req_history") return { ok: true, items: MK.audit.slice(0, Math.min(p.limit || 30, 50)) };
    return { ok: false, error: "Unknown action" };
  }

  // ---- API ---------------------------------------------------------------------------------------------
  function api(payload) {
    var p;
    if (MOCK) p = mockApi(payload);
    else if (!window.AuthEngine || typeof window.AuthEngine.adminCall !== "function") p = Promise.reject(new Error("الصفحة محتاجة أحدث assets/auth.js."));
    else p = window.AuthEngine.adminCall(STATE.session, payload);
    return p.then(function (res) {
      if (res && res.ok === false) throw new Error(res.error || "حصل خطأ");
      return res;
    });
  }
  function errText(err) {
    var m = (err && err.message) || "حصل خطأ، جرّب تاني.";
    if (m === "Not authorized.") m = "الحساب ده مش مسموح له بالصفحة دي. لو إنت مساعد، اطلب من الأدمن يفعّل صلاحية المطلوبات.";
    if (/Unknown action/.test(m)) m = "السيرفر لسه مش متحدّث بنسخة المطلوبات. الأدمن محتاج ينشر آخر نسخة من Apps Script (Code.gs والملفات الجديدة).";
    return m;
  }

  // ---- data loading --------------------------------------------------------------------------------
  function loadReq(quiet) {
    var payload = { action: "admin_req_get" };
    if (STATE.month) payload.month = STATE.month;
    return api(payload).then(function (d) {
      STATE.data = d;
      if (!STATE.group || !d.group_names[STATE.group]) STATE.group = Object.keys(d.group_names).sort(byName(d.group_names))[0] || "";
      return d;
    });
  }
  function byName(names) { return function (a, b) { return String(names[a]).localeCompare(String(names[b])); }; }
  function loadOverview() {
    return api({ action: "admin_followup_overview" }).then(function (o) { STATE.overview = o; STATE.overviewErr = ""; },
      function (e) { STATE.overview = null; STATE.overviewErr = errText(e); });
  }
  function loadAll(quiet) {
    if (STATE.loading) return Promise.resolve();
    STATE.loading = true; $("rq-refresh").style.opacity = ".5";
    if (!quiet) clear($("rq-root")).appendChild(el("span", { class: "rq-dim" }, ["جاري التحميل…"]));
    return Promise.all([loadReq(), loadOverview()]).then(function () {
      STATE.loading = false; $("rq-refresh").style.opacity = ""; render();
    }, function (err) {
      STATE.loading = false; $("rq-refresh").style.opacity = "";
      if (quiet && STATE.data) { toast(errText(err), { err: true }); return; }
      renderError(errText(err));
    });
  }
  function renderError(msg) {
    var r = clear($("rq-root"));
    r.appendChild(el("div", { class: "rq-err", role: "alert" }, [msg]));
    r.appendChild(el("button", { class: "rq-btn primary", type: "button", onclick: function () { loadAll(false); } }, ["جرّب تاني"]));
  }
  // one write, then a quiet reload so every tab shows the server's truth
  function write(busyKey, payload, okText) {
    if (STATE.busy[busyKey]) return Promise.resolve(null);
    STATE.busy[busyKey] = true;
    return api(payload).then(function (res) {
      STATE.busy[busyKey] = false;
      if (okText) toast(okText);
      STATE.history = null;
      return loadReq().then(function () { render(true); return res; });
    }, function (err) {
      STATE.busy[busyKey] = false; toast(errText(err), { err: true }); render(true); return null;
    });
  }

  // ---- shared bits ---------------------------------------------------------------------------------
  function catalog() { return (STATE.data && STATE.data.catalog) || []; }
  function labelOf(c) { return c.label_ar || c.label_en || c.key; }
  function groupsList() {
    var names = (STATE.data && STATE.data.group_names) || {};
    return Object.keys(names).sort(byName(names)).map(function (k) { return { key: k, name: names[k] }; });
  }
  function ruleText(key, rule) {
    if (key === "watch") return "نسبة المشاهدة " + ((rule && rule.pct) || 80) + "%";
    if (key === "quiz") return rule && rule.min_pct ? "الدرجة لا تقل عن " + rule.min_pct + "%" : "أي درجة تكفي";
    return "";
  }
  function effText(c, e) {
    if (!e.enabled) return "متوقف";
    var parts = ["مفعّل"], rt = ruleText(c.key, e.rule); if (rt) parts.push(rt);
    parts.push(e.in_monthly_report ? "داخل تقرير الشهر" : "خارج تقرير الشهر");
    return parts.join(" · ");
  }
  // Where the setting comes from; the title says it in a full sentence.
  function sourceChip(s) {
    var c = s === "group" ? chip("🎯 من المجموعة", "teal") : s === "global" ? chip("🌐 من العام") : chip("⚙️ الافتراضي");
    c.title = s === "group" ? "المجموعة دي ليها استثناء خاص بيها" : s === "global" ? "جاي من الإعدادات العامة اللي إنت عدّلتها" : "إعداد البداية، محدش عدّله لسه";
    return c;
  }

  function swRow(id, title, hint, checked, onChange, disabled) {
    var input = el("input", { type: "checkbox", id: id, role: "switch", checked: checked, disabled: disabled, onchange: function (e) { onChange(e.target.checked, e.target); } });
    if (checked) input.checked = true;
    return el("label", { class: "rq-sw", for: id }, [el("span", {}, [title, hint ? el("small", {}, [hint]) : null]), input]);
  }

  // ==========================================================================
  //   GLOBAL TAB
  // ==========================================================================
  function renderGlobal(root) {
    root.appendChild(el("h2", { class: "rq-h2" }, ["المطلوبات العامة"]));
    root.appendChild(el("p", { class: "rq-dim" }, ["الإعدادات هنا بتسري على كل المجموعات، إلا لو مجموعة عملت استثناء من تبويب «المجموعات»."]));
    catalog().forEach(function (c) { root.appendChild(globalCard(c)); });
    root.appendChild(newReqBlock());
  }

  function globalCard(c) {
    var k = c.key, manual = c.kind === "manual", busy = !!STATE.busy["g|" + k];
    var card = el("section", { class: "rq-card" + (c.enabled ? "" : " off"), id: "rq-card-" + k }, [
      el("div", { class: "rq-row rq-between" }, [
        el("h3", {}, [labelOf(c)]),
        el("div", { class: "rq-row" }, [Object.assign(chip(manual ? "✍️ يدوي" : "🤖 تلقائي", manual ? "warn" : "teal"), { title: manual ? "يدوي: إنت بتسجّله بنفسك لكل طالب كل شهر" : "تلقائي: الموقع بيحسبه لوحده من نشاط الطالب" }), (c.label_en && c.label_en !== labelOf(c) ? el("span", { class: "rq-key", lang: "en", dir: "ltr" }, [c.label_en]) : null)])
      ]),
      el("p", { class: "rq-measure" }, [AR.measure[manual ? "manual" : k] || ""])
    ]);
    function save(patch, okText) { return write("g|" + k, { action: "admin_req_save_global", key: k, patch: patch }, okText || "اتحفظ ✓"); }
    card.appendChild(swRow("rq-sw-" + k + "-enabled", "مفعّل", "لو اتقفل، مفيش حد بيتحاسب عليه", c.enabled, function (v) { save({ enabled: v }); }, busy));
    card.appendChild(swRow("rq-sw-" + k + "-report", "يدخل في تقرير الشهر", null, c.in_monthly_report, function (v) { save({ in_monthly_report: v }); }, busy));
    if (!manual) card.appendChild(swRow("rq-sw-" + k + "-parent", "ممكن يطلّع رسالة لولي الأمر", "لو اتقفل، التقصير فيه ما بيظهرش في رسائل أولياء الأمور", c.parent_message, function (v) { save({ parent_message: v }); }, busy));
    if (k === "watch") card.appendChild(numField("rq-rule-" + k, "نسبة المشاهدة المطلوبة (من 1 إلى 100)", c.rule.pct, 1, 100, 1, false, function (v) { return save({ rule: { pct: v } }); }, busy));
    if (k === "quiz") card.appendChild(numField("rq-rule-" + k, "أقل درجة مطلوبة % (سيبها فاضية = أي درجة تكفي)", c.rule.min_pct, 1, 100, 1, true, function (v) { return save({ rule: v === null ? {} : { min_pct: v } }); }, busy));
    card.appendChild(numField("rq-weight-" + k, "الوزن في نسبة الالتزام (من 0 إلى 10)", c.weight, 0, 10, 0.5, false, function (v) { return save({ weight: v }); }, busy));
    if (manual) {
      card.appendChild(el("div", { class: "rq-row", style: "margin-top:10px" }, [
        el("button", { class: "rq-btn", type: "button", id: "rq-rename-" + k, onclick: function () { renameManual(c); } }, ["✏️ تعديل الاسم"])
      ]));
    }
    return card;
  }

  // number input that saves on change; blank allowed only when `optional`
  function numField(id, label, value, min, max, step, optional, onSave, disabled) {
    var err = el("div", { class: "rq-errline", id: id + "-err", hidden: true });
    var input = el("input", { class: "rq-in num", id: id, type: "number", inputmode: "decimal", min: String(min), max: String(max), step: String(step), disabled: disabled,
      value: value === undefined || value === null ? "" : String(value) });
    input.addEventListener("change", function () {
      var raw = input.value.trim(), v;
      if (raw === "") { if (!optional) { fail("لازم تكتب رقم."); return; } v = null; }
      else {
        v = Number(raw);
        if (!isFinite(v) || v < min || v > max) { fail("الرقم لازم يكون من " + min + " إلى " + max + "."); return; }
        if (step === 1 && Math.floor(v) !== v) { fail("الرقم لازم يكون صحيح (بدون كسور)."); return; }
      }
      err.hidden = true; input.classList.remove("bad");
      onSave(v);
    });
    function fail(msg) { err.textContent = msg; err.hidden = false; input.classList.add("bad"); }
    return el("div", { class: "rq-field" }, [el("label", { for: id }, [el("span", {}, [label])]), input, err]);
  }

  function renameManual(c) {
    var layer = clear($("rq-layer"));
    function close() { clear(layer); }
    var ar = el("input", { class: "rq-in", id: "rq-ren-ar", type: "text", maxlength: "80", value: c.label_ar || "" });
    var en = el("input", { class: "rq-in rq-ltr", id: "rq-ren-en", type: "text", maxlength: "80", value: c.label_en || "" });
    layer.appendChild(el("div", { class: "rq-veil", onclick: function (e) { if (e.target === e.currentTarget) close(); } }, [
      el("div", { class: "rq-dlg", role: "dialog", "aria-modal": "true", "aria-label": "تعديل الاسم" }, [
        el("h3", {}, ["تعديل اسم المطلوب"]),
        el("label", { class: "rq-field", for: "rq-ren-ar" }, [el("span", {}, ["الاسم بالعربي"]), ar]),
        el("label", { class: "rq-field", for: "rq-ren-en" }, [el("span", {}, ["الاسم بالإنجليزي (اختياري)"]), en]),
        el("div", { class: "rq-row", style: "margin-top:14px" }, [
          el("button", { class: "rq-btn primary", id: "rq-ren-save", type: "button", onclick: function () {
            if (!ar.value.trim() && !en.value.trim()) { toast("اكتب اسم واحد على الأقل.", { err: true }); return; }
            close(); write("g|" + c.key, { action: "admin_req_save_global", key: c.key, patch: { label_ar: ar.value.trim(), label_en: en.value.trim() } }, "اتحفظ ✓");
          } }, ["حفظ"]),
          el("button", { class: "rq-btn", type: "button", onclick: close }, ["إلغاء"])
        ])
      ])
    ]));
    ar.focus();
  }

  function newReqBlock() {
    var wrap = el("section", { class: "rq-card", id: "rq-new-card" });
    var count = catalog().filter(function (c) { return c.kind === "manual"; }).length;
    if (!STATE.newOpen) {
      wrap.appendChild(el("div", { class: "rq-row rq-between" }, [
        el("div", {}, [el("h3", {}, ["مطلوب جديد (يدوي)"]), el("p", { class: "rq-measure" }, ["مثال: السلوك في الحصة، أو إحضار الكراسة. بتقيّمه بنفسك كل شهر."])]),
        el("button", { class: "rq-btn primary", id: "rq-new-open", type: "button", disabled: count >= RL.MAX_CUSTOM, onclick: function () { STATE.newOpen = true; STATE.newDraft = { ar: "", en: "" }; render(true); } }, ["+ مطلوب جديد"])
      ]));
      if (count >= RL.MAX_CUSTOM) wrap.appendChild(el("p", { class: "rq-errline" }, ["وصلت للحد الأقصى (" + RL.MAX_CUSTOM + " مطلوب يدوي)."]));
      return wrap;
    }
    // The draft lives in STATE so a re-render (another save landing while the teacher types) keeps what was typed.
    var ar = el("input", { class: "rq-in", id: "rq-new-ar", type: "text", maxlength: "80", placeholder: "مثلاً: السلوك في الحصة", value: STATE.newDraft.ar, oninput: function (ev) { STATE.newDraft.ar = ev.target.value; } });
    var en = el("input", { class: "rq-in rq-ltr", id: "rq-new-en", type: "text", maxlength: "80", placeholder: "Behaviour in class (optional)", value: STATE.newDraft.en, oninput: function (ev) { STATE.newDraft.en = ev.target.value; } });
    var err = el("div", { class: "rq-errline", id: "rq-new-err", hidden: true });
    wrap.appendChild(el("h3", {}, ["مطلوب جديد (يدوي)"]));
    wrap.appendChild(el("label", { class: "rq-field", for: "rq-new-ar" }, [el("span", {}, ["الاسم بالعربي"]), ar]));
    wrap.appendChild(el("label", { class: "rq-field", for: "rq-new-en" }, [el("span", {}, ["الاسم بالإنجليزي (اختياري)"]), en]));
    wrap.appendChild(err);
    wrap.appendChild(el("div", { class: "rq-row", style: "margin-top:14px" }, [
      el("button", { class: "rq-btn primary", id: "rq-new-save", type: "button", onclick: function () {
        var a = ar.value.trim(), e = en.value.trim();
        if (!a && !e) { err.textContent = "اكتب اسم للمطلوب."; err.hidden = false; return; }
        var key = RL.slugFor(e) || RL.slugFor(a);
        var taken = {}; catalog().forEach(function (c) { taken[c.key] = true; });
        if (!key) key = "custom_" + Math.random().toString(36).slice(2, 8);
        var base = key, n = 2; while (taken[key]) { key = base.slice(0, 36) + "_" + n; n++; }
        STATE.newOpen = false; STATE.newDraft = { ar: "", en: "" };
        write("new", { action: "admin_req_save_global", key: key, patch: { kind: "manual", label_ar: a, label_en: e } }, "اتضاف المطلوب ✓");
      } }, ["إضافة"]),
      el("button", { class: "rq-btn", id: "rq-new-cancel", type: "button", onclick: function () { STATE.newOpen = false; render(true); } }, ["إلغاء"])
    ]));
    return wrap;
  }

  // ==========================================================================
  //   GROUPS TAB
  // ==========================================================================
  function renderGroups(root) {
    var gl = groupsList();
    root.appendChild(el("h2", { class: "rq-h2" }, ["استثناءات المجموعات"]));
    if (!gl.length) { root.appendChild(el("div", { class: "rq-empty" }, ["مفيش مجموعات لسه. اعمل مجموعات من صفحة الصلاحيات الأول."])); return; }
    var sel = el("select", { class: "rq-sel", id: "rq-group-select", "aria-label": "المجموعة", onchange: function (e) { STATE.group = e.target.value; render(true); } },
      gl.map(function (g) { var o = el("option", { value: g.key }, [g.name]); if (g.key === STATE.group) o.selected = true; return o; }));
    root.appendChild(el("div", { class: "rq-card" }, [el("label", { class: "rq-field", for: "rq-group-select", style: "margin:0" }, [el("span", {}, ["المجموعة"]), sel])]));

    var gk = STATE.group, ov = (STATE.data.groups || {})[gk] || {}, eff = (STATE.data.effective || {})[gk] || {};
    var glob = RL.resolve(catalog(), null);
    catalog().forEach(function (c) {
      var k = c.key, o = ov[k], mode = o ? o.mode : "inherit", e = eff[k] || glob[k], busy = !!STATE.busy["s|" + gk + "|" + k];
      var card = el("section", { class: "rq-card", id: "rq-gcard-" + k }, [
        el("div", { class: "rq-row rq-between" }, [el("h3", {}, [labelOf(c)]),
          el("div", { class: "rq-row" }, [sourceChip(e.source), RL.differs(e, glob[k]) ? chip("⚠️ يختلف عن العام", "warn") : null])])
      ]);
      var seg = el("div", { class: "rq-seg", role: "radiogroup", "aria-label": "وضع " + labelOf(c) });
      RL.MODES.forEach(function (m) {
        var id = "rq-mode-" + k + "-" + m;
        var inp = el("input", { type: "radio", name: "rq-mode-" + k, id: id, value: m, disabled: busy, onchange: function () { setMode(gk, c, m, o); } });
        if (m === mode) inp.checked = true;
        seg.appendChild(el("label", { for: id, class: (m === mode ? "sel" : "") + (m === "off" && m === mode ? " offsel" : "") }, [inp, AR.modes[m]]));
      });
      card.appendChild(seg);
      card.appendChild(el("p", { class: "rq-measure rq-modehelp", id: "rq-modehelp-" + k, style: "margin:8px 0 0" }, [AR.modeHelp[mode] || ""]));
      card.appendChild(el("p", { class: "rq-eff", id: "rq-eff-" + k }, ["اللي بيتطبّق فعلًا: " + effText(c, e)]));
      if (mode === "custom") {
        var rule = o.rule || {};
        if (k === "watch") card.appendChild(numField("rq-grule-" + k, "نسبة المشاهدة لهذه المجموعة", rule.pct !== undefined ? rule.pct : c.rule.pct, 1, 100, 1, false,
          function (v) { return saveGroup(gk, k, "custom", { rule: { pct: v }, in_monthly_report: o.in_monthly_report }, o.note); }, busy));
        if (k === "quiz") card.appendChild(numField("rq-grule-" + k, "أقل درجة لهذه المجموعة % (فاضي = أي درجة)", rule.min_pct, 1, 100, 1, true,
          function (v) { return saveGroup(gk, k, "custom", { rule: v === null ? {} : { min_pct: v }, in_monthly_report: o.in_monthly_report }, o.note); }, busy));
        card.appendChild(swRow("rq-greport-" + k, "يدخل في تقرير الشهر (لهذه المجموعة)", null, e.in_monthly_report,
          function (v) { saveGroup(gk, k, "custom", { rule: o.rule, in_monthly_report: v }, o.note); }, busy));
      }
      if (mode !== "inherit") {
        var note = el("input", { class: "rq-in", id: "rq-gnote-" + k, type: "text", maxlength: "200", value: o.note || "", placeholder: "ملاحظة (اختياري): ليه الاستثناء ده؟", disabled: busy });
        note.addEventListener("change", function () {
          var patch = mode === "custom" ? { rule: o.rule, in_monthly_report: o.in_monthly_report } : undefined;
          if (patch) { Object.keys(patch).forEach(function (x) { if (patch[x] === undefined) delete patch[x]; }); }
          saveGroup(gk, k, mode, patch, note.value.trim());
        });
        card.appendChild(el("label", { class: "rq-field", for: "rq-gnote-" + k }, [el("span", {}, ["ملاحظة"]), note]));
      }
      root.appendChild(card);
    });

    // copy from another group
    var others = gl.filter(function (g) { return g.key !== gk; });
    if (others.length) {
      if (!STATE.copyFrom || !others.some(function (g) { return g.key === STATE.copyFrom; })) STATE.copyFrom = others[0].key;
      var cs = el("select", { class: "rq-sel", id: "rq-copy-from", "aria-label": "انسخ من", onchange: function (e) { STATE.copyFrom = e.target.value; } },
        others.map(function (g) { var o2 = el("option", { value: g.key }, [g.name]); if (g.key === STATE.copyFrom) o2.selected = true; return o2; }));
      root.appendChild(el("section", { class: "rq-card", id: "rq-copy-card" }, [
        el("h3", {}, ["انسخ الاستثناءات من مجموعة تانية"]),
        el("p", { class: "rq-measure" }, ["بتخلّي استثناءات المجموعة دي زي المجموعة اللي تختارها بالظبط."]),
        el("label", { class: "rq-field", for: "rq-copy-from" }, [el("span", {}, ["انسخ من"]), cs]),
        el("div", { class: "rq-row", style: "margin-top:12px" }, [el("button", { class: "rq-btn", id: "rq-copy-go", type: "button", onclick: copyGroup }, ["نسخ"])])
      ]));
    }
    renderManualChecklist(root);
  }

  function setMode(gk, c, mode, cur) {
    if (mode === "custom") {
      var e = ((STATE.data.effective || {})[gk] || {})[c.key] || {};
      var patch = c.key === "watch" ? { rule: { pct: (e.rule && e.rule.pct) || (c.rule && c.rule.pct) || 80 } }
                : c.key === "quiz" ? { rule: c.rule && c.rule.min_pct ? { min_pct: c.rule.min_pct } : {} }
                : { in_monthly_report: e.in_monthly_report !== false };
      return saveGroup(gk, c.key, "custom", patch, cur && cur.note);
    }
    return saveGroup(gk, c.key, mode, undefined, mode === "inherit" ? undefined : (cur && cur.note));
  }
  function saveGroup(gk, key, mode, patch, note) {
    var p = { action: "admin_req_save_group", group: gk, key: key, mode: mode };
    if (patch) p.patch = patch;
    if (note) p.note = note;
    return write("s|" + gk + "|" + key, p, "اتحفظ ✓");
  }

  function copyGroup() {
    var from = STATE.copyFrom, to = STATE.group, names = STATE.data.group_names;
    var src = (STATE.data.groups || {})[from] || {}, dst = (STATE.data.groups || {})[to] || {};
    var jobs = [];
    catalog().forEach(function (c) {
      var a = src[c.key], b = dst[c.key];
      var sa = a ? JSON.stringify([a.mode, a.rule || null, a.in_monthly_report === undefined ? null : a.in_monthly_report, a.note || ""]) : "inherit";
      var sb = b ? JSON.stringify([b.mode, b.rule || null, b.in_monthly_report === undefined ? null : b.in_monthly_report, b.note || ""]) : "inherit";
      if (sa === sb) return;
      if (!a) { jobs.push({ action: "admin_req_save_group", group: to, key: c.key, mode: "inherit" }); return; }
      var p = { action: "admin_req_save_group", group: to, key: c.key, mode: a.mode };
      if (a.mode === "custom") { p.patch = {}; if (a.rule) p.patch.rule = a.rule; if (a.in_monthly_report !== undefined) p.patch.in_monthly_report = a.in_monthly_report; }
      if (a.note) p.note = a.note;
      jobs.push(p);
    });
    if (!jobs.length) { toast("المجموعتين زي بعض أصلاً."); return; }
    confirmDialog("نسخ الاستثناءات؟", "استثناءات «" + names[to] + "» هتبقى زي «" + names[from] + "» (" + jobs.length + " تغيير).", "نسخ", function () {
      var failed = 0, i = 0;
      (function next() {
        if (i >= jobs.length) {
          STATE.history = null;
          loadReq().then(function () { render(true); toast(failed ? "اتنسخ جزء، و" + failed + " فشلوا." : "اتنسخ ✓", { err: !!failed }); });
          return;
        }
        api(jobs[i++]).then(next, function () { failed++; next(); });
      })();
    });
  }

  // ---- manual monthly checklist (admin_req_check) --------------------------------------------------
  function renderManualChecklist(root) {
    var manual = catalog().filter(function (c) { return c.kind === "manual"; });
    var card = el("section", { class: "rq-card", id: "rq-manual-card" }, [el("h3", {}, ["التقييم اليدوي الشهري"])]);
    root.appendChild(card);
    if (!manual.length) { card.appendChild(el("p", { class: "rq-measure" }, ["لما تضيف مطلوب يدوي من التبويب العام هتلاقيه هنا."])); return; }
    if (!STATE.month) STATE.month = currentMonth();
    if (!STATE.mreq || !manual.some(function (c) { return c.key === STATE.mreq; })) STATE.mreq = manual[0].key;
    var month = el("input", { class: "rq-in rq-ltr", id: "rq-month", type: "month", value: STATE.month, "aria-label": "الشهر" });
    month.addEventListener("change", function () {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) { toast("اختار شهر صح.", { err: true }); return; }
      STATE.month = month.value; loadReq().then(function () { render(true); }, function (e) { toast(errText(e), { err: true }); });
    });
    var req = el("select", { class: "rq-sel", id: "rq-mreq", "aria-label": "المطلوب", onchange: function (e) { STATE.mreq = e.target.value; render(true); } },
      manual.map(function (c) { var o = el("option", { value: c.key }, [labelOf(c)]); if (c.key === STATE.mreq) o.selected = true; return o; }));
    card.appendChild(el("div", { class: "rq-row" }, [
      el("label", { class: "rq-field", for: "rq-month", style: "flex:1;min-width:150px;margin:0" }, [el("span", {}, ["الشهر"]), month]),
      el("label", { class: "rq-field", for: "rq-mreq", style: "flex:2;min-width:180px;margin:0" }, [el("span", {}, ["المطلوب"]), req])
    ]));
    var members = membersOf(STATE.group);
    if (STATE.overviewErr) { card.appendChild(el("p", { class: "rq-errline" }, ["تعذّر تحميل أسماء الطلاب: " + STATE.overviewErr])); return; }
    if (!members.length) { card.appendChild(el("p", { class: "rq-measure" }, ["المجموعة دي مفيهاش طلاب."])); return; }
    var checks = (STATE.data.checks || {});
    members.forEach(function (m) {
      var key = pk(m.phone), cur = ((checks[key] || {})[STATE.mreq]) || { met: null, note: "" }, busy = !!STATE.busy["c|" + key];
      function set(met) { saveCheck(m, met, note.value.trim()); }
      var note = el("input", { class: "rq-in", id: "rq-note-" + key, type: "text", maxlength: "200", value: cur.note || "", placeholder: "ملاحظة (اختياري)", disabled: busy });
      note.addEventListener("change", function () { saveCheck(m, cur.met === undefined ? null : cur.met, note.value.trim()); });
      function tbtn(id, cls, text, met) { return el("button", { type: "button", id: id, class: cls + (cur.met === met ? " sel" : ""), disabled: busy, "aria-pressed": cur.met === met ? "true" : "false", onclick: function () { set(met); } }, [text]); }
      card.appendChild(el("div", { class: "rq-stu", id: "rq-stu-" + key }, [
        el("strong", {}, [m.name || m.phone]),
        el("div", { class: "rq-tri" }, [tbtn("rq-chk-" + key + "-yes", "yes", "✓ تم", true), tbtn("rq-chk-" + key + "-no", "no", "✗ لم يتم", false), tbtn("rq-chk-" + key + "-clear", "clear", "— لسه", null)]),
        note
      ]));
    });
  }
  function saveCheck(m, met, note) {
    var key = pk(m.phone);
    return write("c|" + key, { action: "admin_req_check", student: m.phone, key: STATE.mreq, month: STATE.month, met: met, note: note }, "اتسجّل ✓");
  }

  function membersOf(gk) {
    var o = STATE.overview; if (!o) return [];
    var g = (o.groups || []).filter(function (x) { return x.key === gk; })[0];
    return g ? g.members || [] : [];
  }

  // ==========================================================================
  //   PREVIEW TAB (live, from the same precedence rules; no server call)
  // ==========================================================================
  function allStudents() {
    var o = STATE.overview, out = [];
    if (!o) return out;
    (o.groups || []).forEach(function (g) { (g.members || []).forEach(function (m) { out.push({ key: pk(m.phone), phone: m.phone, name: m.name || m.phone, group: g.key, groupName: g.group }); }); });
    (o.unclassified || []).forEach(function (m) { out.push({ key: pk(m.phone), phone: m.phone, name: m.name || m.phone, group: "", groupName: "غير مصنّف" }); });
    return out;
  }
  function renderPreview(root) {
    root.appendChild(el("h2", { class: "rq-h2" }, ["معاينة طالب"]));
    root.appendChild(el("p", { class: "rq-dim" }, ["بتشوف إيه اللي هيتحسب على الطالب في تقرير الشهر، بعد العام والاستثناءات."]));
    if (STATE.overviewErr) { root.appendChild(el("div", { class: "rq-err" }, ["تعذّر تحميل الطلاب: " + STATE.overviewErr])); return; }
    var list = allStudents();
    if (!list.length) { root.appendChild(el("div", { class: "rq-empty" }, ["مفيش طلاب لسه."])); return; }
    if (!STATE.student || !list.some(function (s) { return s.key === STATE.student; })) STATE.student = list[0].key;
    var sel = el("select", { class: "rq-sel", id: "rq-pv-student", "aria-label": "الطالب", onchange: function (e) { STATE.student = e.target.value; render(true); } },
      list.map(function (s) { var o = el("option", { value: s.key }, [s.name + " — " + s.groupName]); if (s.key === STATE.student) o.selected = true; return o; }));
    root.appendChild(el("div", { class: "rq-card" }, [el("label", { class: "rq-field", for: "rq-pv-student", style: "margin:0" }, [el("span", {}, ["الطالب"]), sel])]));
    var st = list.filter(function (s) { return s.key === STATE.student; })[0];
    var cat = catalog(), ovs = (STATE.data.groups || {})[st.group] || null, eff = RL.resolve(cat, st.group ? ovs : null);
    var counted = RL.monthlyList(cat, eff);
    var card = el("section", { class: "rq-card", id: "rq-pv-card" }, [
      el("div", { class: "rq-row rq-between" }, [el("h3", {}, [st.name]), chip(st.groupName)]),
      el("p", { class: "rq-eff", id: "rq-pv-count" }, ["بيتحسب عليه في تقرير الشهر: " + counted.length + " من " + cat.length + " مطلوب"])
    ]);
    cat.forEach(function (c) {
      var e = eff[c.key], inRep = e.enabled && e.in_monthly_report;
      var why = !e.enabled ? "متوقف" : !e.in_monthly_report ? "خارج تقرير الشهر" : "داخل التقرير · الوزن " + e.weight;
      var rt = e.enabled ? ruleText(c.key, e.rule) : "";
      var mchk = "";
      if (c.kind === "manual" && inRep) {
        var ck = ((STATE.data.checks || {})[st.key] || {})[c.key];
        mchk = ck && ck.met !== null && ck.met !== undefined ? (ck.met ? " · ✓ تم" : " · ✗ لم يتم") : " · لسه (" + (STATE.month || currentMonth()) + ")";
      }
      card.appendChild(el("div", { class: "rq-pv", id: "rq-pv-" + c.key }, [
        el("div", {}, [el("strong", {}, [labelOf(c)]), el("div", { class: "rq-dim" }, [why + (rt ? " · " + rt : "") + mchk])]),
        el("div", { class: "rq-row" }, [inRep ? chip("✅ بيتحسب", "ok") : chip("⏸️ مش بيتحسب"), sourceChip(e.source)])
      ]));
    });
    root.appendChild(card);
  }

  // ==========================================================================
  //   HISTORY TAB
  // ==========================================================================
  function renderHistory(root) {
    root.appendChild(el("div", { class: "rq-row rq-between" }, [el("h2", { class: "rq-h2" }, ["السجل"]),
      el("button", { class: "rq-btn", id: "rq-hist-refresh", type: "button", onclick: function () { STATE.history = null; render(true); } }, ["تحديث"])]));
    root.appendChild(el("p", { class: "rq-dim" }, ["آخر التغييرات في المطلوبات. التوقيت بتوقيت " + TZ_LABEL + "."]));
    var box = el("div", { class: "rq-card", id: "rq-hist-list" });
    root.appendChild(box);
    if (STATE.history) { fillHistory(box, STATE.history); return; }
    box.appendChild(el("span", { class: "rq-dim" }, ["جاري التحميل…"]));
    api({ action: "admin_req_history", limit: 50 }).then(function (r) { STATE.history = r.items || []; if (STATE.tab === "history") fillHistory(clear(box), STATE.history); },
      function (e) { clear(box).appendChild(el("div", { class: "rq-errline" }, [errText(e)])); });
  }
  function fillHistory(box, items) {
    if (!items.length) { box.appendChild(el("div", { class: "rq-empty" }, ["مفيش تغييرات لسه."])); return; }
    items.forEach(function (it) {
      box.appendChild(el("div", { class: "rq-hi" }, [
        el("div", { class: "rq-row rq-between" }, [el("strong", {}, [it.by || "—"]), el("div", { class: "rq-row" }, [it.role ? chip(it.role === "admin" ? "أدمن" : "مساعد", it.role === "admin" ? "teal" : "warn") : null, el("span", { class: "rq-dim rq-ltr" }, [fmtAt(it.at)])])]),
        el("div", { class: "what" }, [it.what || ""])
      ]));
    });
  }

  // ==========================================================================
  //   shell
  // ==========================================================================
  var TABS = [["global", "العام"], ["groups", "المجموعات"], ["preview", "معاينة"], ["history", "السجل"]];
  function renderTabs() {
    var nav = clear($("rq-tabs")); nav.hidden = false;
    TABS.forEach(function (t) {
      nav.appendChild(el("button", { class: "rq-tab", id: "rq-tab-" + t[0], role: "tab", type: "button", "aria-selected": STATE.tab === t[0] ? "true" : "false",
        onclick: function () { STATE.tab = t[0]; try { sessionStorage.setItem("rq-tab", t[0]); } catch (e) {} if (location.hash !== "#" + t[0]) { try { history.replaceState(null, "", "#" + t[0]); } catch (e) {} } render(true); } }, [t[1]]));
    });
  }
  function render(keepScroll) {
    var y = window.pageYOffset;
    if (!STATE.data) return;
    renderTabs();
    var root = clear($("rq-root"));
    if (STATE.tab === "global") renderGlobal(root);
    else if (STATE.tab === "groups") renderGroups(root);
    else if (STATE.tab === "preview") renderPreview(root);
    else renderHistory(root);
    if (keepScroll) window.scrollTo(0, y);
  }

  function readHash() {
    var h = (location.hash || "").replace(/^#/, "");
    if (TABS.some(function (t) { return t[0] === h; })) STATE.tab = h;
    else { try { var s = sessionStorage.getItem("rq-tab"); if (s && TABS.some(function (t) { return t[0] === s; })) STATE.tab = s; } catch (e) {} }
  }
  function start(session, role) {
    STATE.session = session; STATE.role = role || (session && session.role) || "admin";
    $("rq-refresh").hidden = false;
    if (MOCK) $("rq-mock").hidden = false;
    readHash();
    loadAll(false);
  }
  function loadScript(src) {
    return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = function () { rej(new Error("لم يتم تحميل " + src)); }; document.head.appendChild(s); });
  }
  function boot() {
    $("rq-refresh").addEventListener("click", function () { if (!STATE.loading) { STATE.history = null; loadAll(true).then(function () { toast("تم التحديث ✓"); }); } });
    window.addEventListener("hashchange", function () { var before = STATE.tab; readHash(); if (STATE.data && before !== STATE.tab) render(true); });
    if (!RL) { renderError("ملف ناقص: assets/requirements-logic.js"); return; }
    if (MOCK) { start(null); return; }
    clear($("rq-root")).appendChild(el("span", { class: "rq-dim" }, ["جاري التحقق من تسجيل الدخول…"]));
    loadScript("/assets/auth.js").then(function () {
      window.AuthEngine.mount("#authgate", function (session) {
        var gate = $("authgate"); if (gate) gate.remove();
        if (!session.session_token) {
          var r = clear($("rq-root")); r.appendChild(el("div", { class: "rq-err" }, ["تسجيل الدخول المحفوظ ناقصه رمز الجلسة. ادخل تاني."]));
          r.appendChild(el("button", { class: "rq-btn primary", type: "button", onclick: function () { window.AuthEngine.clearSession(); location.reload(); } }, ["سجّل خروج وادخل تاني ←"])); return;
        }
        // Convenience only: the server re-checks the role on every call.
        window.StaffGuard.require(null, session).then(function (role) { if (role) start(session, role); });
      }, { staff: true });
    }, function (e) { renderError(e.message); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
