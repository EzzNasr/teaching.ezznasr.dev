/* ==========================================================================
   i18n.js — Arabic / English for the STAFF pages (dashboard/*). Not loaded on student pages.

   Arabic is the default. The choice is kept on this device (localStorage "teaching-lang") and applies on
   every staff page (other open tabs follow too).

   How it works (so a page needs almost no code changes):
     - Each page adds its words as pairs:  I18n.add([["الفريق", "Team"], ["اتضاف {0} كمساعد.", "{0} was added as an assistant."]])
       A pair can be written from either side, so Arabic pages and English pages use the same list.
       {0} {1} … (or {name}) are holes: the text around them is matched, the hole is kept (and translated if it is
       itself a known word, e.g. a month name).
     - A MutationObserver translates every text node and the placeholder / title / aria-label / alt attributes as
       soon as the page writes them, before the browser paints. The original text is remembered on the node, so
       switching back and forth never loses it, and nothing is re-rendered: inputs keep what was typed.
     - window.confirm / alert / prompt go through t() as well.
     - Data is never touched when it sits inside translate="no" (or data-i18n-skip): student names, lesson titles,
       parent messages, WhatsApp templates. Input values and <textarea> are never touched.
     - Only text is changed (textContent / setAttribute). Nothing is ever parsed as HTML.

   API:  I18n.lang()  I18n.set("ar"|"en")  I18n.t(text, vars)  I18n.add(pairs)  I18n.onChange(fn)
         I18n.month(i) (0-11)  I18n.num(n)  I18n.date(d, opts)  I18n.locale()  I18n.untranslated()  (tests)
   ========================================================================== */
(function () {
  "use strict";
  if (window.I18n) return;
  var KEY = "teaching-lang";
  var root = document.documentElement;
  var AR = /[؀-ۿ]/, LATIN = /[A-Za-z]/;
  var maps = { en: Object.create(null), ar: Object.create(null) };   // target lang -> { source text: translation }
  var pats = { en: [], ar: [] };                                     // target lang -> [{re, names, out, weight}]
  var listeners = [];
  var lang = read();

  function read() { try { var v = localStorage.getItem(KEY); return v === "en" ? "en" : "ar"; } catch (e) { return "ar"; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private window: just this page */ } }

  // ---------- dictionary ----------
  var HOLE = /\{(\w+)\}/g;
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function compile(from, to) {
    var names = [], parts = from.split(HOLE), src = "^";
    for (var i = 0; i < parts.length; i++) {
      // {n}, {n2} … hold a number only ("3", "4,250", "80%", "2/11"); other holes hold any text.
      if (i % 2) { names.push(parts[i]); src += /^n\d*$/.test(parts[i]) ? "([0-9\\u0660-\\u0669.,:/%+-]+)" : "([\\s\\S]+?)"; } else src += esc(parts[i]);
    }
    return { re: new RegExp(src + "$"), names: names, out: to, weight: from.replace(HOLE, "").length, joins: / [·—] /.test(from) };
  }
  function addPair(ar, en) {
    if (!ar || !en) return;
    ar = String(ar).trim(); en = String(en).trim();
    if (HOLE.test(ar)) {
      HOLE.lastIndex = 0;
      // A side that is only holes ("{0}") would match everything: that direction is left out.
      if (/[^\s{}0-9\w]|[A-Za-z]/.test(ar.replace(HOLE, ""))) pats.en.push(compile(ar, en));
      if (/[^\s{}0-9]/.test(en.replace(HOLE, ""))) pats.ar.push(compile(en, ar));
    }
    // exact entries too, so t("… {0} …", [x]) finds its template directly
    { if (!(ar in maps.en)) maps.en[ar] = en; if (!(en in maps.ar)) maps.ar[en] = ar; }
    HOLE.lastIndex = 0;
  }
  function add(pairs) {
    (pairs || []).forEach(function (p) { if (p && p.length >= 2) addPair(p[0], p[1]); });
    ["en", "ar"].forEach(function (l) { pats[l].sort(function (a, b) { return b.weight - a.weight; }); });
    if (started) applyAll();
  }

  // Leading / trailing marks that are not words: emoji, arrows, ✓ ✕ ⚠️ ＋ etc. (letters, digits, quotes and brackets stay in the middle).
  // (Emoji count as marks even when Unicode calls them letters, e.g. ℹ️.)
  var AFFIX = /^((?:\p{Extended_Pictographic}|️|[^\p{L}\p{N}«»"'(\[{])*)([\s\S]*?[\p{L}\p{N})\]»"'.؟?!:]|)((?:\p{Extended_Pictographic}|️|[^\p{L}\p{N}«»"')\]}.؟?!:])*)$/u;
  var JOIN = / [·—] /, JOIN_SPLIT = /( [·—] )/;
  function flip(s, to) {
    if (!s) return s;
    return to === "en" ? s.replace(/←/g, "\u0000").replace(/→/g, "←").replace(/\u0000/g, "→").replace(/؟/g, "?").replace(/،/g, ",")
                       : s.replace(/→/g, "\u0000").replace(/←/g, "→").replace(/\u0000/g, "←");
  }
  function fill(out, vals) {
    return out.replace(HOLE, function (m, k) { return vals[k] != null ? vals[k] : m; });
  }
  // Translate one piece of text into `to`. Text that is already in `to`, or unknown, comes back unchanged.
  function tr(s, to, depth) {
    if (s == null) return s;
    s = String(s);
    var core = s.trim();
    if (!core) return s;
    var hit = maps[to][core];
    if (hit === undefined && (to === "en" ? AR : LATIN).test(core) && (depth || 0) < 3) {
      var list = pats[to];
      for (var i = 0; i < list.length; i++) {
        var m = list[i].re.exec(core);
        if (!m) continue;
        // A hole never swallows " · " / " — " unless the pattern itself has one: those are separate pieces.
        if (!list[i].joins && m.slice(1).some(function (x) { return JOIN.test(x); })) continue;
        var vals = {};
        for (var j = 0; j < list[i].names.length; j++) vals[list[i].names[j]] = tr(m[j + 1], to, (depth || 0) + 1);
        hit = fill(list[i].out, vals);
        break;
      }
    }
    // A hole that holds a list ("رياضة، برمجة"): translate each item when every item is known.
    if (hit === undefined && depth) {
      var sepIn = to === "en" ? /\s*،\s*/ : /\s*,\s*/, items = core.split(sepIn);
      if (items.length > 1) {
        var done = items.map(function (x) { var y = tr(x, to, depth + 1); return y === x ? null : y; });
        if (done.every(function (x) { return x !== null; })) hit = done.join(to === "en" ? ", " : "، ");
      }
    }
    // Emoji / arrows / marks around a known phrase ("⚠️ لا رقم ولي أمر", "تم الحفظ ✓", "افتح ←").
    if (hit === undefined && (depth || 0) < 3) {
      var am = AFFIX.exec(core);
      if (am && (am[1] || am[3]) && am[2]) {
        var mid = tr(am[2], to, (depth || 0) + 1);
        if (mid !== am[2]) hit = flip(am[1], to) + mid + flip(am[3], to);
      }
    }
    // Pieces joined by " · " / " — " ("الطلاب · 12", "رسالة مجمّعة · سارة"): translate the known pieces, keep the rest (data).
    if (hit === undefined && (depth || 0) < 3 && JOIN.test(core)) {
      var bits = core.split(JOIN_SPLIT), changed = false;
      for (var b = 0; b < bits.length; b += 2) {
        var y = tr(bits[b], to, (depth || 0) + 1);
        if (y !== bits[b]) { bits[b] = y; changed = true; }
      }
      if (changed) hit = bits.join("");
    }
    if (hit === undefined) return s;
    var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
    return lead + hit + tail;
  }
  // t("text") or t("اتضاف {0} كمساعد.", [name]) / t("… {name} …", {name: x}): into the current language.
  function t(s, vars) {
    var out = tr(s, lang);
    if (vars != null) {
      var v = Array.isArray(vars) ? vars : vars;
      out = String(out).replace(HOLE, function (m, k) { return v[k] != null ? String(v[k]) : m; });
    }
    return out;
  }

  // ---------- the page ----------
  var ATTRS = ["placeholder", "title", "aria-label", "alt"];
  function skipped(elm) {
    for (var n = elm; n && n.nodeType === 1; n = n.parentNode) {
      var tag = n.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "NOSCRIPT") return true;
      if (n.getAttribute("translate") === "no" || n.hasAttribute("data-i18n-skip") || n.isContentEditable) return true;
    }
    return false;
  }
  function doText(node) {
    if (!node.parentNode || skipped(node.parentNode)) return;
    var mem = node.__i18n;
    var src = mem && node.data === mem.out ? mem.src : node.data;
    var out = tr(src, lang);
    node.__i18n = { src: src, out: out };
    if (node.data !== out) node.data = out;
  }
  function doAttrs(elm) {
    if (skipped(elm)) return;
    var mem = elm.__i18nA || (elm.__i18nA = {});
    var list = ATTRS;
    if (elm.nodeName === "INPUT" && /^(button|submit|reset)$/i.test(elm.type)) list = ATTRS.concat("value");
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!elm.hasAttribute(a)) continue;
      var cur = elm.getAttribute(a), m = mem[a];
      var src = m && cur === m.out ? m.src : cur;
      var out = tr(src, lang);
      mem[a] = { src: src, out: out };
      if (cur !== out) elm.setAttribute(a, out);
    }
  }
  function walk(n) {
    if (!n) return;
    if (n.nodeType === 3) { doText(n); return; }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    if (n.nodeType === 1) { if (skipped(n)) return; doAttrs(n); }
    for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
  }
  function applyAll() { walk(root); }

  var started = false;
  // Old browsers / test fakes without MutationObserver: the page stays in its own language, nothing breaks.
  var obs = typeof MutationObserver === "function" ? new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "characterData") doText(r.target);
      else if (r.type === "attributes") { if (r.target.nodeType === 1) doAttrs(r.target); }
      else for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
    }
    ensureToggle();
  }) : null;

  function setDir() {
    root.setAttribute("lang", lang);
    root.setAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  }

  // ---------- the button (next to the dark-mode button) ----------
  function paintToggle(b) {
    b.textContent = lang === "ar" ? "EN" : "ع";
    b.setAttribute("aria-label", lang === "ar" ? "Switch to English" : "التحويل للعربي");
    b.setAttribute("title", lang === "ar" ? "English" : "عربي");
    b.setAttribute("lang", lang === "ar" ? "en" : "ar");
  }
  function ensureToggle() {
    var theme = document.getElementById("theme-toggle");
    var b = document.getElementById("lang-toggle");
    if (b || !theme || !theme.parentNode) return;
    b = document.createElement("button");
    b.type = "button"; b.id = "lang-toggle";
    b.className = (theme.className || "") + " lang-toggle";
    b.setAttribute("translate", "no");
    b.style.fontWeight = "800"; b.style.fontSize = "15px"; b.style.fontFamily = "'Cairo', system-ui, sans-serif";
    b.style.color = "inherit";
    paintToggle(b);
    b.addEventListener("click", function () { set(lang === "ar" ? "en" : "ar"); });
    theme.parentNode.insertBefore(b, theme);
  }

  function set(v, fromOtherTab) {
    v = v === "en" ? "en" : "ar";
    if (!fromOtherTab) write(v);
    if (v === lang) return;
    lang = v;
    setDir();
    applyAll();
    var b = document.getElementById("lang-toggle"); if (b) paintToggle(b);
    listeners.slice().forEach(function (fn) { try { fn(lang); } catch (e) { setTimeout(function () { throw e; }); } });
  }

  // ---------- dialogs ----------
  ["confirm", "alert", "prompt"].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function (msg) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) args[0] = t(msg);
      return orig.apply(window, args);
    };
  });

  // ---------- formats ----------
  var MONTHS = {
    ar: ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  };
  var DAYS = {
    ar: ["الأحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"],
    en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  };
  function locale() { return lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB"; }
  function num(n) { return Number(n || 0).toLocaleString("en-US"); }   // the same digits in both languages
  function date(d, opts) {
    d = d instanceof Date ? d : new Date(d);
    if (isNaN(d)) return "";
    try { return d.toLocaleDateString(locale(), opts || { day: "numeric", month: "long", year: "numeric" }); }
    catch (e) { return d.toDateString(); }
  }

  // Words every staff page shares.
  var COMMON = [
    ["الوضع الداكن", "Switch to dark mode"], ["الوضع الفاتح", "Switch to light mode"],
    ["تحديث", "Refresh"], ["جاري التحميل…", "Loading…"], ["جاري التحقق من تسجيل الدخول…", "Checking your sign-in…"],
    ["{0} — Teaching Portal", "{0} — Teaching Portal"],
    ["صفحات الإدارة", "Admin pages"],
    ["النتايج", "Results"], ["الوصول للدروس", "Lesson access"], ["المتابعة", "Follow-up"], ["المطلوبات", "Requirements"],
    ["التصحيح", "Grading"], ["الفريق", "Team"], ["الإيرادات", "Revenue"], ["الرئيسية", "Home"], ["فريقي", "My team"], ["إيراداتي", "My revenue"],
    ["وضع التجربة — بيانات وهمية، ولا يتم حفظ أي شيء", "Test mode — sample data, nothing is saved"], ["وضع التجربة — أرقام وهمية، ولا يتم حفظ أي شيء", "Test mode — sample numbers, nothing is saved"],
    ["صفحة الدخول ما اتحمّلتش. اعمل تحديث للصفحة.", "The sign-in part didn't load. Refresh the page."],
    ["ما قدرناش نحمّل {0}", "Couldn't load {0}"], ["لم يتم تحميل {0}", "Couldn't load {0}"],
    ["تسجيل الدخول المحفوظ ناقصه رمز الجلسة. اخرج وادخل تاني.", "Your saved sign-in is missing its session. Sign out and sign in again."],
    ["تسجيل الدخول المحفوظ ناقصه رمز الجلسة. ادخل تاني.", "Your saved sign-in is missing its session. Sign in again."],
    ["سجّل خروج وادخل تاني ←", "Sign out and sign in again →"], ["تسجيل خروج", "Sign out"],
    ["حصلت مشكلة. جرّب تاني.", "Something went wrong. Try again."], ["حصلت مشكلة.", "Something went wrong."],
    ["الصفحة دي لصاحب الموقع بس.", "This page is for the site owner only."],
    ["السيرفر لسه ما اتحدّثش. محتاج تنزّل نسخة جديدة من السكريبت.", "The server hasn't been updated yet. A new version of the script needs to be deployed."],
    ["أيوه", "Yes"], ["لأ", "No"], ["الكل", "All"], ["مفيش.", "None."], ["مفيش", "None"], ["اقفل", "Close"],
    ["تاريخ مش معروف", "Unknown date"]
  ];
  MONTHS.ar.forEach(function (m, i) { COMMON.push([m, MONTHS.en[i]], [m + " {0}", MONTHS.en[i] + " {0}"]); });
  // Days: both spellings used on the pages, alone and in front of a time or date ("الخميس 4:00 م").
  [DAYS.ar, ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]].forEach(function (list) {
    list.forEach(function (d, i) { COMMON.push([d, DAYS.en[i]], [d + " {0}", DAYS.en[i] + " {0}"]); });
  });
  COMMON.push(["{0} ص", "{0} AM"], ["{0} م", "{0} PM"], ["ص", "AM"], ["م", "PM"], ["يوم {0}", "{0}"],
    ["النهارده", "Today"], ["بكرة", "Tomorrow"], ["امبارح", "Yesterday"], ["دلوقتي", "Now"]);

  // Tests: visible text that is still in the other language (outside translate="no").
  function untranslated() {
    var other = lang === "en" ? AR : /[A-Za-z]{2,}/, out = [];
    (function scan(n) {
      if (n.nodeType === 3) { if (other.test(n.data)) out.push(n.data.trim()); return; }
      if (n.nodeType !== 1 || skipped(n) || n.id === "lang-toggle") return;
      if (n !== root && n.nodeName !== "BODY" && n.getClientRects && !n.getClientRects().length && n.nodeName !== "OPTION") return;
      for (var c = n.firstChild; c; c = c.nextSibling) scan(c);
    })(document.body || root);
    return out;
  }

  // Re-draw a page part after a language switch without losing what was typed: every input / select / textarea with an id
  // gets its value (and tick) back, and the focus stays where it was.
  function redraw(fn) {
    var keep = {}, focus = document.activeElement && document.activeElement.id;
    Array.prototype.forEach.call(document.querySelectorAll("input[id], textarea[id], select[id]"), function (n) {
      if (n.type === "file" || n.type === "password") return;
      keep[n.id] = { v: n.value, c: n.checked };
    });
    fn();
    Object.keys(keep).forEach(function (id) {
      var n = document.getElementById(id); if (!n) return;
      if (n.type === "checkbox" || n.type === "radio") n.checked = keep[id].c;
      else if (n.value !== keep[id].v) { n.value = keep[id].v; if (n.value !== keep[id].v && n.nodeName === "SELECT") return; }
    });
    if (focus) { var f = document.getElementById(focus); if (f && f.focus) f.focus(); }
  }

  window.I18n = {
    lang: function () { return lang; }, set: function (v) { set(v); }, t: t, add: add,
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    month: function (i) { return MONTHS[lang][i]; }, day: function (i) { return DAYS[lang][i]; },
    num: num, date: date, locale: locale, untranslated: untranslated, redraw: redraw
  };
  add(COMMON);
  setDir();
  started = true;
  if (obs) obs.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat("value") });
  applyAll();

  function ready() { ensureToggle(); applyAll(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  window.addEventListener("storage", function (e) { if (e.key === KEY) set(e.newValue, true); });
  window.addEventListener("pageshow", function () { var v = read(); if (v !== lang) set(v, true); });
})();
