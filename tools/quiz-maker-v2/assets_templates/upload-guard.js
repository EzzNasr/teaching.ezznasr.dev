/* ==========================================================================
   upload-guard.js — full-screen "do not close this page" screen for uploads.

   Shown while a student's answers / photos / file are being sent. It covers the
   whole page (nothing underneath can be tapped), warns the browser before the
   tab is closed or reloaded, keeps the phone awake where supported, and only
   goes away when the student presses a button after "done" or "failed".

   Dependency-free. Loaded on demand by quiz.js / assign.js; if it can't load,
   those pages carry on exactly as before (they use noopGuard()).

     var g = UploadGuard.begin({ message: "Sending your answers" });
     g.set({ message: "Sending photo 2 of 3", step: 2, total: 3 });   // step/total => real progress bar
     g.busy();                       // "server is busy, still trying" line
     g.success({ message, onClose }) // green tick, student presses Continue
     g.fail({ message, retry })      // red, Try again (if retry given) + Close
     g.close();                      // remove silently (e.g. caller shows its own result)

   Only one screen exists at a time: begin() while one is open re-uses it.
   ========================================================================== */
(function (root) {
  "use strict";

  var doc = root.document;
  var CSS =
    ".tug-back{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;" +
    "background:rgba(10,14,26,.94);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);overflow:auto;" +
    "font-family:Cairo,system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif}" +
    ".tug-card{width:100%;max-width:460px;background:#fff;color:#111827;border-radius:20px;padding:26px 22px 22px;text-align:center;" +
    "box-shadow:0 20px 60px rgba(0,0,0,.5);border:4px solid #f59e0b}" +
    ".tug-card.ok{border-color:#16a34a}.tug-card.bad{border-color:#dc2626}" +
    ".tug-warn{background:#dc2626;color:#fff;border-radius:12px;padding:12px 10px;margin:0 0 18px;font-weight:800;font-size:22px;line-height:1.35}" +
    ".tug-warn small{display:block;font-size:16px;font-weight:700;opacity:.95;margin-top:2px}" +
    ".tug-spin{width:64px;height:64px;margin:4px auto 14px;border-radius:50%;border:7px solid #fde68a;border-top-color:#f59e0b;" +
    "animation:tug-rot 1s linear infinite}" +
    ".tug-icon{width:72px;height:72px;margin:0 auto 12px;border-radius:50%;display:flex;align-items:center;justify-content:center;" +
    "font-size:40px;font-weight:800;color:#fff}.tug-card.ok .tug-icon{background:#16a34a}.tug-card.bad .tug-icon{background:#dc2626}" +
    ".tug-l{display:block}.tug-btn .tug-l:last-child:not(:first-child){font-size:14px;font-weight:700;opacity:.9}" +
    ".tug-msg{font-size:19px;font-weight:700;margin:0 0 4px;overflow-wrap:anywhere}" +
    ".tug-msg2{font-size:15px;color:#374151;margin:0 0 14px;overflow-wrap:anywhere}" +
    ".tug-bar{height:14px;border-radius:99px;background:#e5e7eb;overflow:hidden;margin:6px 0 8px;position:relative}" +
    ".tug-bar i{position:absolute;inset-block:0;inset-inline-start:0;width:0;background:#f59e0b;border-radius:99px;transition:width .3s}" +
    ".tug-bar.ind i{width:40%;animation:tug-ind 1.4s ease-in-out infinite}" +
    ".tug-meta{font-size:14px;color:#4b5563;margin:0 0 10px}" +
    ".tug-slow{font-size:14.5px;font-weight:700;color:#92400e;background:#fef3c7;border-radius:10px;padding:8px 10px;margin:10px 0 0}" +
    ".tug-btns{display:flex;flex-direction:column;gap:10px;margin-top:16px}" +
    ".tug-btn{font:inherit;font-size:18px;font-weight:800;border:0;border-radius:12px;padding:14px 16px;cursor:pointer;background:#16a34a;color:#fff}" +
    ".tug-btn.alt{background:#e5e7eb;color:#111827}.tug-btn.red{background:#dc2626}" +
    "@keyframes tug-rot{to{transform:rotate(360deg)}}" +
    "@keyframes tug-ind{0%{inset-inline-start:-40%}100%{inset-inline-start:100%}}" +
    "@media (prefers-reduced-motion:reduce){.tug-spin{animation-duration:3s}.tug-bar.ind i{animation-duration:3s}}";

  var state = null;   // the one open screen, or null

  function injectCss() {
    if (doc.getElementById("tug-css")) return;
    var st = doc.createElement("style"); st.id = "tug-css"; st.textContent = CSS; doc.head.appendChild(st);
  }
  function h(tag, cls, text) {
    var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e;
  }
  // "Arabic / English" strings become two lines, each in its own direction, so mixed text never scrambles.
  function setBi(node, text) {
    node.textContent = "";
    text = String(text == null ? "" : text);
    var i = text.indexOf(" / ");
    if (i > 0 && /[؀-ۿ]/.test(text.slice(0, i))) {
      var a = h("span", "tug-l", text.slice(0, i)); a.dir = "rtl";
      var e = h("span", "tug-l", text.slice(i + 3)); e.dir = "ltr";
      node.appendChild(a); node.appendChild(e);
    } else {
      var one = h("span", "tug-l", text); one.dir = "auto"; node.appendChild(one);
    }
    return node;
  }
  function onBeforeUnload(ev) {
    ev.preventDefault(); ev.returnValue = "Your upload is still running. / الرفع لسه شغال."; return ev.returnValue;
  }

  function lockWake(s) {
    try {
      if (root.navigator && root.navigator.wakeLock && root.navigator.wakeLock.request) {
        root.navigator.wakeLock.request("screen").then(function (l) { s.wake = l; if (s.closed) { try { l.release(); } catch (e) { /* ignore */ } } }, function () { /* not allowed: fine */ });
      }
    } catch (e) { /* ignore */ }
  }

  function teardown(s) {
    if (!s || s.closed) return;
    s.closed = true;
    clearInterval(s.timer);
    root.removeEventListener("beforeunload", onBeforeUnload);
    try { if (s.wake) s.wake.release(); } catch (e) { /* ignore */ }
    try { doc.documentElement.style.overflow = s.prevOverflow; } catch (e) { /* ignore */ }
    if (s.back && s.back.parentNode) s.back.parentNode.removeChild(s.back);
    if (state === s) state = null;
  }

  function begin(opts) {
    opts = opts || {};
    if (!doc || !doc.body) return noopGuard();
    if (state && !state.closed) { state.api.set(opts); return state.api; }
    injectCss();

    var s = { closed: false, startedAt: Date.now(), wake: null, prevOverflow: doc.documentElement.style.overflow };
    s.back = h("div", "tug-back");
    s.back.setAttribute("role", "alertdialog");
    s.back.setAttribute("aria-modal", "true");
    s.back.setAttribute("aria-live", "assertive");
    s.back.setAttribute("aria-label", "Upload in progress — do not close this page");
    s.card = h("div", "tug-card");
    s.back.appendChild(s.card);
    // a tap on the dark area must never dismiss anything
    s.back.addEventListener("click", function (e) { e.stopPropagation(); });
    s.back.addEventListener("keydown", function (e) { if (e.key === "Escape") e.preventDefault(); });
    doc.body.appendChild(s.back);
    doc.documentElement.style.overflow = "hidden";
    root.addEventListener("beforeunload", onBeforeUnload);
    lockWake(s);

    var cur = { message: opts.message || "", step: null, total: null, busy: false };

    function viewWorking() {
      s.card.className = "tug-card";
      s.card.textContent = "";
      var warn = h("div", "tug-warn", "⚠️ لا تقفل الصفحة حتى يخلص الرفع");
      warn.appendChild(h("small", "", "DO NOT close or leave this page until it finishes"));
      s.card.appendChild(warn);
      s.card.appendChild(h("div", "tug-spin"));
      s.msgEl = h("p", "tug-msg"); s.card.appendChild(s.msgEl);
      s.msg2El = setBi(h("p", "tug-msg2"), "استنى لحد ما تظهر علامة ✓ الخضراء / Wait for the green ✓ before leaving");
      s.card.appendChild(s.msg2El);
      s.bar = h("div", "tug-bar"); s.fill = h("i"); s.bar.appendChild(s.fill); s.card.appendChild(s.bar);
      s.metaEl = h("p", "tug-meta"); s.card.appendChild(s.metaEl);
      s.slowEl = h("div", "tug-slow"); s.slowEl.hidden = true; s.card.appendChild(s.slowEl);
      paint();
    }

    function paint() {
      if (s.closed || !s.msgEl) return;
      setBi(s.msgEl, cur.message || "Sending…");
      var real = cur.total && cur.total > 0 && cur.step != null;
      s.bar.className = "tug-bar" + (real ? "" : " ind");
      s.fill.style.width = real ? Math.max(6, Math.min(100, Math.round((cur.step / cur.total) * 100))) + "%" : "";
      var secs = Math.floor((Date.now() - s.startedAt) / 1000);
      s.metaEl.textContent = (real ? cur.step + " / " + cur.total + " · " : "") + secs + "s";
      var slow = cur.busy || secs >= 20;
      s.slowEl.hidden = !slow;
      if (slow) setBi(s.slowEl, cur.busy
        ? "السيرفر مزدحم دلوقتي — بنحاول تاني، لا تقفل الصفحة. / Server is busy — still trying. Keep this page open."
        : "النت بطيء شوية — طبيعي، استنى. / Slow connection — normal, keep waiting.");
    }

    function viewEnd(kind, message, detail, buttons) {
      clearInterval(s.timer);
      root.removeEventListener("beforeunload", onBeforeUnload);
      try { if (s.wake) s.wake.release(); } catch (e) { /* ignore */ }
      s.card.className = "tug-card " + kind;
      s.card.textContent = "";
      s.card.appendChild(h("div", "tug-icon", kind === "ok" ? "✓" : "!"));
      s.card.appendChild(setBi(h("p", "tug-msg"), message));
      if (detail) s.card.appendChild(setBi(h("p", "tug-msg2"), detail));
      var box = h("div", "tug-btns");
      buttons.forEach(function (b) {
        var btn = setBi(h("button", "tug-btn" + (b.cls ? " " + b.cls : "")), b.label);
        btn.type = "button"; btn.addEventListener("click", b.fn); box.appendChild(btn);
      });
      s.card.appendChild(box);
      var first = box.querySelector("button"); if (first) { try { first.focus(); } catch (e) { /* ignore */ } }
    }

    var api = {
      set: function (o) {
        if (s.closed || !o) return api;
        if (o.message != null) cur.message = o.message;
        if ("step" in o) cur.step = o.step;
        if ("total" in o) cur.total = o.total;
        if ("step" in o || o.message != null || "busy" in o) cur.busy = !!o.busy;
        // coming back from a fail screen (retry)
        if (!s.msgEl || !s.msgEl.parentNode) { s.startedAt = Date.now(); viewWorking(); root.addEventListener("beforeunload", onBeforeUnload); s.timer = setInterval(paint, 1000); lockWake(s); }
        paint(); return api;
      },
      busy: function () { cur.busy = true; paint(); return api; },
      success: function (o) {
        o = o || {};
        viewEnd("ok", o.message || "تم الإرسال ✓ / Sent ✓",
          o.detail || "تقدر تقفل الصفحة دلوقتي. / You can close this page now.",
          [{ label: "تمام / Continue", fn: function () { teardown(s); if (o.onClose) o.onClose(); } }]);
        return api;
      },
      fail: function (o) {
        o = o || {};
        var btns = [];
        if (typeof o.retry === "function") btns.push({ label: "ابعت تاني / Try again", cls: "red", fn: function () { api.set({ message: o.retryMessage || "Sending again…" }); o.retry(); } });
        btns.push({ label: o.retry ? "قفل / Close" : "تمام / OK", cls: "alt", fn: function () { teardown(s); if (o.onClose) o.onClose(); } });
        viewEnd("bad", o.message || "مااتبعتش / Not sent yet",
          o.detail || "إجاباتك محفوظة على الجهاز. اضغط «ابعت تاني». / Your work is saved on this device. Tap Try again.", btns);
        return api;
      },
      close: function () { teardown(s); return api; }
    };

    s.api = api;
    state = s;
    viewWorking();
    s.timer = setInterval(paint, 1000);
    if (opts.step != null) cur.step = opts.step;
    if (opts.total != null) cur.total = opts.total;
    paint();
    return api;
  }

  // Same shape, does nothing. Used when this script could not be loaded.
  function noopGuard() {
    var api = { set: function () { return api; }, busy: function () { return api; }, success: function (o) { if (o && o.onClose) o.onClose(); return api; },
                fail: function (o) { if (o && o.onClose) o.onClose(); return api; }, close: function () { return api; } };
    return api;
  }

  function isOpen() { return !!(state && !state.closed); }

  var out = { begin: begin, noopGuard: noopGuard, isOpen: isOpen };
  if (typeof module !== "undefined" && module.exports) module.exports = out;
  root.UploadGuard = out;
})(typeof window !== "undefined" ? window : globalThis);
