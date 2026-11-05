/* ==========================================================================
   draft-store.js — the Save model for the staff dashboards (Phase 4 / S7, contract 6d).

   Field edits are STAGED in the browser and sent by one Save button. Decisions
   (payments, assistants, Telegram link) are NOT staged: they stay immediate.

   CONVENIENCE ONLY. Nothing here is a security boundary: every staged action is
   re-checked by the server when it is finally sent.

   API (window.Draft):
     Draft.init({ page, user, send, afterSave })
         send(action, payload) -> Promise of the parsed response ({ok:false} counts as a failure).
         afterSave(results)    optional: called once after a Save in which at least one op succeeded, and
                               after a restored batch was saved (restored ops have no callbacks).
     Draft.stage({ id, label, action, payload, onSaved, onFailed })   same id replaces the earlier op
     Draft.has(id) / Draft.get(id) / Draft.ops() / Draft.count() / Draft.dirty()
     Draft.discard(id) / Draft.discardAll()
     Draft.save() -> Promise of [{ id, ok, resp }], one op at a time in staging order.
         Successful ops are removed; failed ops stay staged. A second press while saving returns the
         same promise (nothing is sent twice).
     Draft.pauseRefresh() -> true while there are staged edits or a Save is running. Page timers and
         refreshes must skip while it is true, and never overwrite a staged field.
     Draft.onChange(fn)   fn(count, reason) after every change; reason is "stage", "discard", "discardAll", "restore" or "save"
                          (pages repaint staged badges, and re-read the server after a discard so no unsent edit stays on screen).

   Also: a sticky bar "Save (n) / Discard" (role="status"), a beforeunload warning only while
   count() > 0, and a sessionStorage mirror (key p4draft:<page>:<user>) with a
   "Restore n unsaved changes" offer after a reload. sessionStorage only, never localStorage.
   ========================================================================== */
(function () {
  "use strict";

  var cfg = { page: "", user: "", send: null, afterSave: null };
  var ops = [];                 // { id, label, action, payload, onSaved, onFailed, restored }
  var listeners = [];
  var saving = null;            // the in-flight Save promise
  var bar = null, msgNode = null, countNode = null, saveBtn = null, discardBtn = null, restoreBtn = null;
  var unloadOn = false;
  var offered = null;           // ops read from sessionStorage and not restored yet
  var lastFailed = 0;

  function storeKey() { return "p4draft:" + cfg.page + ":" + cfg.user; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function persist() {
    try {
      var k = storeKey();
      if (!ops.length) { window.sessionStorage.removeItem(k); return; }
      window.sessionStorage.setItem(k, JSON.stringify(ops.map(function (o) {
        return { id: o.id, label: o.label, action: o.action, payload: o.payload };
      })));
    } catch (e) { /* private mode or storage full: staging still works, it just will not survive a reload */ }
  }

  function readStored() {
    try {
      var raw = window.sessionStorage.getItem(storeKey());
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter(function (o) { return o && o.id && o.action && o.payload; }) : [];
    } catch (e) { return []; }
  }

  function onBeforeUnload(e) {
    if (ops.length > 0) { e.preventDefault(); e.returnValue = ""; return ""; }
  }
  function syncUnload() {
    var need = ops.length > 0;
    if (need && !unloadOn) { window.addEventListener("beforeunload", onBeforeUnload); unloadOn = true; }
    if (!need && unloadOn) { window.removeEventListener("beforeunload", onBeforeUnload); unloadOn = false; }
  }

  // ---- the sticky bar ------------------------------------------------------------------------
  function ensureBar() {
    if (bar || typeof document === "undefined" || !document.body) return;
    if (!document.getElementById("p4-draft-style")) {
      var st = document.createElement("style");
      st.id = "p4-draft-style";
      st.textContent =
        "#p4-draft-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:none;align-items:center;gap:10px;" +
        "flex-wrap:wrap;padding:10px 16px;background:var(--bg,#fff);border-top:2px solid var(--accent,#2457d6);" +
        "box-shadow:0 -4px 14px rgba(0,0,0,.12);font:14px var(--sans,system-ui,sans-serif);color:inherit}" +
        "#p4-draft-bar.is-on{display:flex}#p4-draft-bar .p4d-msg{flex:1 1 200px}" +
        "#p4-draft-bar button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--line,#bbb);" +
        "background:var(--bg,#fff);color:inherit;cursor:pointer}" +
        "#p4-draft-bar button.p4d-primary{background:var(--accent,#2457d6);color:#fff;border-color:var(--accent,#2457d6)}" +
        "#p4-draft-bar button[disabled]{opacity:.55;cursor:default}" +
        "body.p4-draft-on{padding-bottom:var(--p4-bar-h,56px)}";
      document.head.appendChild(st);
    }
    bar = document.createElement("div");
    bar.id = "p4-draft-bar";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    msgNode = document.createElement("span"); msgNode.className = "p4d-msg";
    saveBtn = document.createElement("button"); saveBtn.type = "button"; saveBtn.className = "p4d-primary"; saveBtn.id = "p4-draft-save";
    discardBtn = document.createElement("button"); discardBtn.type = "button"; discardBtn.id = "p4-draft-discard"; discardBtn.textContent = "Discard";
    restoreBtn = document.createElement("button"); restoreBtn.type = "button"; restoreBtn.id = "p4-draft-restore";
    saveBtn.addEventListener("click", function () { save(); });
    discardBtn.addEventListener("click", function () {
      if (offered && !ops.length) { offered = null; persist(); paint(); return; }
      if (!window.confirm || window.confirm("Discard " + ops.length + " unsaved change(s)?")) discardAll();
    });
    restoreBtn.addEventListener("click", function () { restore(); });
    [msgNode, restoreBtn, saveBtn, discardBtn].forEach(function (n) { bar.appendChild(n); });
    document.body.appendChild(bar);
  }

  function paint() {
    ensureBar();
    if (!bar) return;
    var n = ops.length, offer = offered && offered.length && !n;
    bar.className = (n || offer) ? "is-on" : "";
    // The bar is fixed to the bottom of the screen: tell the page how tall it is so toasts, bottom sheets and the last
    // rows of the page are drawn above it instead of under it (body.p4-draft-on + --p4-bar-h, see the CSS above).
    try {
      var on = !!(n || offer), root = document.documentElement;
      if (document.body && document.body.classList) document.body.classList.toggle("p4-draft-on", on);
      if (root && root.style) root.style.setProperty("--p4-bar-h", on ? ((bar.offsetHeight || 56) + "px") : "0px");
      // The bar wraps to 2-3 lines on a phone once its buttons and message are filled in (below), so measure again
      // after layout and whenever it changes size; the first reading alone was too small (toast stayed under it).
      if (on && !bar._p4Measure) {
        bar._p4Measure = function () {
          var h = bar.className === "is-on" ? (bar.offsetHeight || 56) + "px" : "0px";
          root.style.setProperty("--p4-bar-h", h);
        };
        if (window.ResizeObserver) new ResizeObserver(bar._p4Measure).observe(bar);
        window.addEventListener("resize", bar._p4Measure);
      }
      if (on && window.requestAnimationFrame) requestAnimationFrame(bar._p4Measure);
    } catch (e) { /* layout hint only */ }
    saveBtn.hidden = !n; discardBtn.hidden = !(n || offer); restoreBtn.hidden = !offer;
    saveBtn.textContent = "Save (" + n + ")";
    saveBtn.disabled = !!saving;
    restoreBtn.textContent = "Restore " + (offered ? offered.length : 0) + " unsaved change" + (offered && offered.length === 1 ? "" : "s");
    if (saving) msgNode.textContent = "Saving…";
    else if (lastFailed && n) msgNode.textContent = lastFailed + " change" + (lastFailed === 1 ? "" : "s") + " could not be saved and " + (lastFailed === 1 ? "is" : "are") + " still staged.";
    else if (n) msgNode.textContent = n + " unsaved change" + (n === 1 ? "" : "s");
    else if (offer) msgNode.textContent = "You have unsaved changes from before the page reloaded.";
    else msgNode.textContent = "";
  }

  function changed(reason) {
    persist(); syncUnload(); paint();
    listeners.slice().forEach(function (fn) { try { fn(ops.length, reason || "change"); } catch (e) { /* a repaint hook must not break staging */ } });
  }

  // ---- API ----------------------------------------------------------------------------------
  function init(opts) {
    opts = opts || {};
    cfg.page = String(opts.page || "page"); cfg.user = String(opts.user || "");
    cfg.send = typeof opts.send === "function" ? opts.send : null;
    cfg.afterSave = typeof opts.afterSave === "function" ? opts.afterSave : null;
    var stored = readStored();
    offered = ops.length ? null : (stored.length ? stored : null);
    paint(); syncUnload();
  }

  function stage(op) {
    if (!op || !op.id || !op.action) throw new Error("Draft.stage needs {id, action, payload}");
    var rec = { id: String(op.id), label: String(op.label || "An unsaved change"), action: op.action, payload: op.payload || {},
      onSaved: op.onSaved || null, onFailed: op.onFailed || null, restored: false };
    var i = indexOf(rec.id);
    if (i >= 0) ops[i] = rec; else ops.push(rec);
    offered = null;
    changed("stage");
    return rec;
  }

  function indexOf(id) { for (var i = 0; i < ops.length; i++) if (ops[i].id === String(id)) return i; return -1; }
  function has(id) { return indexOf(id) >= 0; }
  function get(id) { var i = indexOf(id); return i < 0 ? null : { id: ops[i].id, label: ops[i].label, action: ops[i].action, payload: clone(ops[i].payload) }; }
  function list() { return ops.map(function (o) { return { id: o.id, label: o.label, action: o.action, payload: clone(o.payload) }; }); }
  function count() { return ops.length; }
  function dirty() { return ops.length > 0; }
  function pauseRefresh() { return ops.length > 0 || !!saving; }

  function discard(id) { var i = indexOf(id); if (i >= 0) { ops.splice(i, 1); lastFailed = 0; changed("discard"); } }
  function discardAll() { if (ops.length) { ops = []; lastFailed = 0; changed("discardAll"); } else { offered = null; persist(); paint(); } }
  function onChange(fn) { if (typeof fn === "function") listeners.push(fn); }

  function restore() {
    if (!offered) return list();
    offered.forEach(function (o) {
      if (indexOf(o.id) < 0) ops.push({ id: String(o.id), label: String(o.label || "An unsaved change"), action: o.action, payload: o.payload, onSaved: null, onFailed: null, restored: true });
    });
    offered = null;
    changed("restore");
    return list();
  }

  function isOk(resp) { return !!resp && resp.ok !== false; }

  function save() {
    if (saving) return saving;
    if (!ops.length) return Promise.resolve([]);
    if (!cfg.send) return Promise.reject(new Error("Draft.init({send}) was not called"));
    var batch = ops.slice(), results = [], anyOk = false, anyRestored = false;
    lastFailed = 0;
    saving = batch.reduce(function (chain, op) {
      return chain.then(function () {
        var p;
        try { p = Promise.resolve(cfg.send(op.action, clone(op.payload))); } catch (e) { p = Promise.reject(e); }
        return p.then(function (resp) {
          if (isOk(resp)) {
            var at = ops.indexOf(op); if (at >= 0) ops.splice(at, 1);     // a replaced (re-staged) op is a different object and stays
            anyOk = true; if (op.restored) anyRestored = true;
            results.push({ id: op.id, ok: true, resp: resp });
            if (op.onSaved) { try { op.onSaved(resp, op); } catch (e) { /* the page's row update must not stop the batch */ } }
          } else { fail(op, resp); }
        }, function (err) { fail(op, { ok: false, error: (err && err.message) || "Request failed." }); });
      });
    }, Promise.resolve()).then(function () {
      saving = null;
      persist(); syncUnload(); paint();
      if (cfg.afterSave && (anyOk || anyRestored)) { try { cfg.afterSave(results); } catch (e) { /* ignore */ } }
      listeners.slice().forEach(function (fn) { try { fn(ops.length, "save"); } catch (e) { /* ignore */ } });
      return results;
    });
    paint();
    return saving;

    function fail(op, resp) {
      lastFailed++;
      results.push({ id: op.id, ok: false, resp: resp });
      if (op.onFailed) { try { op.onFailed(resp, op); } catch (e) { /* ignore */ } }
    }
  }

  // Tests only: forget everything, including the bar and listeners.
  function _reset() {
    ops = []; listeners = []; saving = null; offered = null; lastFailed = 0;
    if (unloadOn) { window.removeEventListener("beforeunload", onBeforeUnload); unloadOn = false; }
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = msgNode = saveBtn = discardBtn = restoreBtn = null;
    cfg = { page: "", user: "", send: null, afterSave: null };
  }

  window.Draft = {
    init: init, stage: stage, has: has, get: get, ops: list, count: count, dirty: dirty,
    discard: discard, discardAll: discardAll, save: save, restore: restore,
    pauseRefresh: pauseRefresh, onChange: onChange, _reset: _reset
  };
})();
