/* math-render.js — equations in quiz and assignment text (P4-S1).

   window.MathRender.render(rootEl)
     Typesets \( inline \) and \[ display \] math inside rootEl, and nothing else.
     "$" is NOT a delimiter ("$5" stays "$5").

   Cheap by design:
     - Does nothing unless rootEl's text contains \( or \[  (so a page with no math never loads KaTeX).
     - KaTeX (CSS + JS + auto-render) loads lazily, once, from /assets/vendor/katex/ .
     - Safe by design: if the KaTeX files are missing, blocked or slow, the text is left exactly as written
       and nothing throws. Questions stay readable as plain text.

   Callers guard with `window.MathRender &&` so a page that does not load this file is unaffected.
*/
(function (root) {
  "use strict";

  var DELIMS = [
    { left: "\\(", right: "\\)", display: false },
    { left: "\\[", right: "\\]", display: true },
  ];

  var state = { status: "idle", pending: [], cbs: [] };   // idle -> loading -> ready | failed
  var api = { base: "/assets/vendor/katex/" };

  function hasMath(el) {
    var t = "";
    try { t = (el && el.textContent) || ""; } catch (e) { return false; }
    return t.indexOf("\\(") !== -1 || t.indexOf("\\[") !== -1;
  }

  function finish(ok) {
    state.status = ok ? "ready" : "failed";
    var list = state.pending; state.pending = [];
    if (ok) list.forEach(typeset);   // on failure the text is simply left as written
    var cbs = state.cbs; state.cbs = [];
    cbs.forEach(function (f) { try { f(ok); } catch (e) { /* caller's problem */ } });
  }

  function typeset(el) {
    try {
      if (!el || !hasMath(el) || typeof root.renderMathInElement !== "function") return;
      root.renderMathInElement(el, { delimiters: DELIMS, throwOnError: false, strict: "ignore", ignoredClasses: ["katex", "katex-display"] });
    } catch (e) { /* leave the text as it was */ }
  }

  function tag(doc, name, attrs, onload, onerror) {
    var n = doc.createElement(name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    n.onload = onload; n.onerror = onerror;
    (doc.head || doc.documentElement).appendChild(n);
    return n;
  }

  // KaTeX output inherits the page direction. On an Arabic (rtl) page that would MIRROR every equation (a < b drawn
  // as b > a, a/b + c/d in reverse order). Equations are always laid out left to right, and isolated from the Arabic
  // text around them so they cannot reorder it either.
  var CSS = ".katex,.katex-display{direction:ltr;unicode-bidi:isolate}.katex-display{text-align:center}";
  function addStyle(doc) {
    try {
      if (doc.querySelector("style[data-math-render]")) return;
      var st = doc.createElement("style");
      st.setAttribute("data-math-render", "");
      st.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(st);
    } catch (e) { /* cosmetic only */ }
  }

  function load() {
    state.status = "loading";
    var doc = root.document;
    if (!doc) return finish(false);
    addStyle(doc);
    var base = api.base, left = 3, dead = false;
    function done() { if (!dead && --left === 0) finish(true); }
    function fail() { if (!dead) { dead = true; finish(false); } }
    try {
      // Already on the page (for example a test or a future page that bundles it): use it, only add the CSS.
      if (root.katex && typeof root.renderMathInElement === "function") {
        tag(doc, "link", { rel: "stylesheet", href: base + "katex.min.css" }, function () {}, function () {});
        return finish(true);
      }
      tag(doc, "link", { rel: "stylesheet", href: base + "katex.min.css" }, done, fail);
      tag(doc, "script", { src: base + "katex.min.js", async: "" }, function () {
        tag(doc, "script", { src: base + "contrib/auto-render.min.js", async: "" }, function () {
          if (typeof root.renderMathInElement === "function") done(); else fail();
        }, fail);
        done();
      }, fail);
    } catch (e) { fail(); }
  }

  api.render = function (el) {
    try {
      if (!hasMath(el)) return;
      if (state.status === "ready") return typeset(el);
      if (state.status === "failed") return;
      state.pending.push(el);
      if (state.status === "idle") load();
    } catch (e) { /* never break the page over an equation */ }
  };

  // For tests and for pages that want to know when typesetting is possible: cb(true|false).
  api.whenSettled = function (cb) {
    if (state.status === "ready") cb(true);
    else if (state.status === "failed") cb(false);
    else state.cbs.push(cb);
  };
  api._status = function () { return state.status; };

  root.MathRender = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
