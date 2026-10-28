/* ==========================================================================
   lesson-combobox.js  (Phase 3 / S2)

   One compact control that replaces "search box + <select>" for choosing a lesson.

     var cb = LessonCombobox.create({
       id: "pick-current",                 // id of the (visually hidden) native <select> mirror, kept for tests / forms
       value: "programming/…/lesson-1",    // current value ("" = none)
       items: [{ value, label, group, search?, flag? }],   // group = chapter heading, search = extra words to match
       placeholder: "— اختار الدرس —", searchPlaceholder: "🔍 ابحث…", ariaLabel: "اختيار الدرس",
       allowEmpty: false,                  // true adds a "clear" entry at the top of the list
       filter: function (item) { … },      // re-checked every time the list is drawn (e.g. the global Senior 1/2 filter)
       renderButton: function (item) { … return [node|string, …]; },   // what the closed control shows
       autoOpen: false,                    // open straight away (used by "add a lesson")
       onPick: function (value) { … }
     });
     parent.appendChild(cb);               // cb is a <div>; cb.open() / cb.close() / cb.value()

   Closed, it is ONE button (one row high). Open, the list floats over the page (absolute on wide
   screens, fixed at the top on phones) so choosing a lesson never changes the page height.
   Keyboard: Enter / Space / ArrowDown open; type to filter; ArrowUp / ArrowDown move; Enter picks;
   Escape closes and returns focus to the button. Touch: every row is >= 44px.

   The native <select> mirror (same id, same values, grouped options) keeps `change` working for
   anything that drives it directly. No dependencies. Works as a plain script or via require().
   ========================================================================== */
(function (root) {
  "use strict";

  // ---- pure helpers (unit-tested in Node) -------------------------------------------------------

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[ً-ٰٟ]/g, "")        // Arabic diacritics
      .replace(/[أإآ]/g, "ا")    // أ إ آ -> ا
      .replace(/ى/g, "ي").replace(/ة/g, "ه")
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
  }

  // Every typed word must appear somewhere in label + group + search + value (order does not matter).
  function matches(item, q) {
    var words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = norm([item.label, item.group, item.search, item.value].join(" "));
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  // -> [{ group, items:[…] }] in the order the items arrive; a new run starts whenever the group changes.
  function groupRuns(items) {
    var runs = [];
    items.forEach(function (it) {
      var g = it.group || "";
      if (!runs.length || runs[runs.length - 1].group !== g) runs.push({ group: g, items: [] });
      runs[runs.length - 1].items.push(it);
    });
    return runs;
  }

  // ArrowUp / ArrowDown over `count` options; wraps; -1 = nothing active yet.
  function step(active, dir, count) {
    if (!count) return -1;
    if (active < 0) return dir > 0 ? 0 : count - 1;
    return (active + dir + count) % count;
  }

  // ---- DOM ----------------------------------------------------------------------------------------

  var uid = 0;
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (attrs[k] === false || attrs[k] === null || attrs[k] === undefined) return;
      else n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "object" && c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }

  function create(opts) {
    opts = opts || {};
    var n = ++uid, listId = "fu-cb-list-" + n;
    var items = (opts.items || []).slice();
    var value = opts.value == null ? "" : String(opts.value);
    var placeholder = opts.placeholder || "— اختار الدرس —";
    var isOpen = false, active = -1, visible = [];

    var wrap = h("div", { class: "fu-cb" + (opts.className ? " " + opts.className : "") });

    // native mirror (visually hidden but still a real, focus-skipped <select> with the same id and value)
    var native = h("select", { class: "fu-cb-native fu-lesson-select", id: opts.id || false, tabindex: "-1", "aria-hidden": "true", dir: "ltr" });
    function fillNative() {
      native.innerHTML = "";
      native.appendChild(h("option", { value: "" }, [placeholder]));
      var seen = {};
      groupRuns(items).forEach(function (run) {
        var og = h("optgroup", { label: run.group || "—" });
        run.items.forEach(function (it) { if (seen[it.value]) return; seen[it.value] = 1; og.appendChild(h("option", { value: it.value }, [it.label])); });
        native.appendChild(og);
      });
      native.value = value;
    }

    var btn = h("button", { class: "fu-cb-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": opts.ariaLabel || false, dir: "ltr" });
    function itemOf(v) { for (var i = 0; i < items.length; i++) if (items[i].value === v) return items[i]; return null; }
    function drawButton() {
      btn.innerHTML = "";
      var it = value ? itemOf(value) : null;
      if (value && !it) it = { value: value, label: value.split("/").pop() };
      var kids = it ? (opts.renderButton ? opts.renderButton(it) : [it.label]) : [h("span", { class: "fu-cb-ph" }, [placeholder])];
      var main = h("span", { class: "fu-cb-label" }, kids);
      btn.appendChild(main);
      if (it && it.flag) btn.appendChild(h("span", { class: "fu-cb-flag" }, [it.flag]));
      btn.appendChild(h("span", { class: "fu-cb-caret", "aria-hidden": "true" }, ["▾"]));
      btn.classList.toggle("is-empty", !it);
    }

    var q = h("input", { class: "fu-cb-q", type: "search", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": listId, autocomplete: "off", autocapitalize: "off", spellcheck: "false",
      placeholder: opts.searchPlaceholder || "🔍 ابحث عن درس…", "aria-label": opts.searchLabel || "بحث في الدروس", dir: "auto" });
    var closeBtn = h("button", { class: "fu-cb-x", type: "button", "aria-label": "إغلاق" }, ["✕"]);
    var list = h("ul", { class: "fu-cb-list", role: "listbox", id: listId });
    var empty = h("div", { class: "fu-cb-empty", hidden: true }, [opts.emptyText || "مفيش نتايج"]);
    var count = h("div", { class: "fu-cb-count", "aria-live": "polite" });
    var pop = h("div", { class: "fu-cb-pop", role: "dialog", "aria-label": opts.ariaLabel || "اختيار الدرس", hidden: true }, [
      h("div", { class: "fu-cb-head" }, [q, closeBtn]), list, empty, count]);
    var backdrop = h("div", { class: "fu-cb-backdrop", hidden: true });

    function draw() {
      list.innerHTML = ""; visible = [];
      var pool = items.filter(function (it) { return (!opts.filter || opts.filter(it) || it.value === value) && matches(it, q.value); });
      if (opts.allowEmpty && !q.value.trim()) {
        visible.push({ value: "", label: opts.emptyOptionText || "— مفيش درس —", clear: true });
      }
      var optIndex = visible.length;
      if (optIndex) list.appendChild(optionNode(visible[0], 0));
      groupRuns(pool).forEach(function (run) {
        if (run.group) list.appendChild(h("li", { class: "fu-cb-grp", role: "presentation" }, [run.group]));
        run.items.forEach(function (it) { visible.push(it); list.appendChild(optionNode(it, optIndex++)); });
      });
      var real = visible.filter(function (v) { return !v.clear; }).length;
      empty.hidden = real > 0;
      count.textContent = real ? real + " درس" : "";
      if (active >= visible.length) active = visible.length - 1;
      markActive(false);
    }
    function optionNode(it, i) {
      var li = h("li", { class: "fu-cb-opt" + (it.clear ? " is-clear" : ""), role: "option", id: listId + "-" + i, "data-i": i, "data-value": it.value, "aria-selected": it.value === value ? "true" : "false", dir: "ltr" }, [it.label]);
      if (it.flag) li.appendChild(h("span", { class: "fu-cb-flag" }, [it.flag]));
      return li;
    }
    function markActive(scroll) {
      var nodes = list.querySelectorAll(".fu-cb-opt");
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("is-active", i === active);
      if (active >= 0 && nodes[active]) {
        q.setAttribute("aria-activedescendant", nodes[active].id);
        if (scroll && nodes[active].scrollIntoView) { try { nodes[active].scrollIntoView({ block: "nearest" }); } catch (e) { /* old browser */ } }
      } else q.removeAttribute("aria-activedescendant");
    }

    function onDocDown(e) { if (!wrap.contains(e.target)) close(false); }
    function open() {
      if (isOpen) return;
      isOpen = true; q.value = ""; active = -1;
      draw();
      for (var i = 0; i < visible.length; i++) if (visible[i].value === value && !visible[i].clear) { active = i; break; }
      markActive(true);
      pop.hidden = false; backdrop.hidden = false;
      btn.setAttribute("aria-expanded", "true"); wrap.classList.add("is-open");
      document.addEventListener("pointerdown", onDocDown, true);
      try { q.focus({ preventScroll: true }); } catch (e) { q.focus(); }
      markActive(true);
    }
    function close(refocus) {
      if (!isOpen) return;
      isOpen = false;
      pop.hidden = true; backdrop.hidden = true;
      btn.setAttribute("aria-expanded", "false"); wrap.classList.remove("is-open");
      document.removeEventListener("pointerdown", onDocDown, true);
      if (refocus) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }
    }
    function pick(i) {
      var it = visible[i]; if (!it) return;
      value = it.value; native.value = value; drawButton(); close(true);
      if (opts.onPick) opts.onPick(value);
    }

    btn.addEventListener("click", function () { if (isOpen) close(true); else open(); });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
    });
    closeBtn.addEventListener("click", function () { close(true); });
    backdrop.addEventListener("click", function () { close(false); });
    q.addEventListener("input", function () { active = visible.length ? 0 : -1; draw(); active = visible.length ? 0 : -1; markActive(true); });
    q.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); active = step(active, 1, visible.length); markActive(true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = step(active, -1, visible.length); markActive(true); }
      else if (e.key === "Enter") { e.preventDefault(); if (active >= 0) pick(active); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
      else if (e.key === "Home" && !q.value) { e.preventDefault(); active = visible.length ? 0 : -1; markActive(true); }
      else if (e.key === "End" && !q.value) { e.preventDefault(); active = visible.length - 1; markActive(true); }
    });
    list.addEventListener("click", function (e) {
      var li = e.target.closest ? e.target.closest(".fu-cb-opt") : null;
      if (li) pick(+li.getAttribute("data-i"));
    });
    list.addEventListener("pointermove", function (e) {
      var li = e.target.closest ? e.target.closest(".fu-cb-opt") : null;
      if (li && +li.getAttribute("data-i") !== active) { active = +li.getAttribute("data-i"); markActive(false); }
    });
    // Something drove the native mirror directly (a test, a form autofill): follow it.
    native.addEventListener("change", function () {
      value = native.value; drawButton();
      if (opts.onPick) opts.onPick(value);
    });

    fillNative(); drawButton();
    wrap.appendChild(btn); wrap.appendChild(native); wrap.appendChild(backdrop); wrap.appendChild(pop);
    wrap.open = open; wrap.close = function () { close(false); };
    wrap.value = function () { return value; };
    if (opts.autoOpen) {
      // wait until the caller has put the control in the page, so focus() can work
      (root.requestAnimationFrame || function (f) { return setTimeout(f, 0); })(function () { if (wrap.isConnected !== false) open(); });
    }
    return wrap;
  }

  var api = { create: create, matches: matches, groupRuns: groupRuns, step: step, norm: norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LessonCombobox = api;
})(typeof window !== "undefined" ? window : globalThis);
