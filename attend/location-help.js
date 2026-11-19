// Illustrated "turn location on" guide for the student page (2026-11-19, docs/attendance/decisions.md D24).
// Shown by attend.js only after two "Allow location" taps that brought no location back (the student is not seeing the browser's
// question). Two tabs, iPhone and Android, each with drawn step screens (not real screenshots: they are drawn here as inline SVG so the
// page needs no image downloads) and a caption in English and Arabic. All text is static; nothing from the student or the server is used.
//   ATT_LOC_HELP.html(platform)  -> markup ("ios" | "android"; anything else opens the iPhone tab)
//   ATT_LOC_HELP.bind(root)      -> makes the two tabs switch
(function (g) {
  "use strict";
  var W = 180, H = 300;   // one phone screen, in SVG units
  var BLUE = "#0a84ff", GREEN = "#34c759", RING = "#ff9f0a", INK = "#1c1c1e", MUT = "#8e8e93", LINE = "#e5e5ea";

  function esc(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function text(x, y, t, size, fill, weight, anchor) {
    return '<text x="' + x + '" y="' + y + '" font-size="' + (size || 12) + '" fill="' + (fill || INK) + '"' + (weight ? ' font-weight="' + weight + '"' : "") +
      (anchor ? ' text-anchor="' + anchor + '"' : "") + ' font-family="-apple-system,Segoe UI,Roboto,Arial,sans-serif">' + esc(t) + "</text>";
  }
  function toggle(x, y, on) {
    return '<rect x="' + x + '" y="' + (y - 9) + '" width="30" height="18" rx="9" fill="' + (on ? GREEN : "#d1d1d6") + '"/>' +
      '<circle cx="' + (on ? x + 21 : x + 9) + '" cy="' + y + '" r="7.5" fill="#fff"/>';
  }
  function ring(x, y, w, h) {   // the orange "tap here" outline plus a fingertip
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8" fill="none" stroke="' + RING + '" stroke-width="3"/>' +
      '<circle cx="' + (x + w - 14) + '" cy="' + (y + h - 4) + '" r="9" fill="' + RING + '" fill-opacity=".55"/>';
  }
  function frame(inner, header, bar) {
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-hidden="true" focusable="false">' +
      '<rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" rx="18" fill="#f2f2f7" stroke="#3a3a3c" stroke-width="2"/>' +
      text(16, 22, "9:41", 10, INK, "600") + '<rect x="' + (W - 34) + '" y="14" width="20" height="9" rx="2" fill="none" stroke="' + INK + '"/>';
    if (header) s += text(W / 2, 48, header, 13, INK, "700", "middle");
    if (bar) s += bar;
    return s + inner + "</svg>";
  }
  // rows: [{t, sub, hi, toggle: true|false, check, chev}] drawn as a settings list from y0
  function list(rows, y0) {
    var s = "", y = y0 || 64;
    rows.forEach(function (r) {
      var h = r.sub ? 40 : 32;
      s += '<rect x="10" y="' + y + '" width="' + (W - 20) + '" height="' + h + '" fill="#fff"/>' + '<line x1="18" y1="' + (y + h) + '" x2="' + (W - 10) + '" y2="' + (y + h) + '" stroke="' + LINE + '"/>';
      s += text(20, y + (r.sub ? 17 : 20), r.t, 11.5, r.dim ? MUT : INK, r.hi ? "600" : "");
      if (r.sub) s += text(20, y + 32, r.sub, 9.5, MUT);
      if (r.toggle != null) s += toggle(W - 50, y + h / 2, r.toggle);
      if (r.check) s += '<path d="M' + (W - 32) + " " + (y + h / 2) + " l5 5 l10 -11" + '" fill="none" stroke="' + BLUE + '" stroke-width="2.5" stroke-linecap="round"/>';
      if (r.chev) s += text(W - 22, y + h / 2 + 4, "›", 14, MUT);
      if (r.hi) s += ring(12, y + 2, W - 24, h - 4);
      y += h;
    });
    return s;
  }
  function browserBar(kind, y) {   // address bar of Safari (aA on the left) or Chrome (tune icon on the left)
    var s = '<rect x="10" y="' + y + '" width="' + (W - 20) + '" height="30" rx="10" fill="#fff" stroke="' + LINE + '"/>';
    s += text(kind === "aA" ? 22 : 24, y + 20, kind === "aA" ? "aA" : "☰", kind === "aA" ? 12 : 12, INK, "700");
    s += text(W / 2 + 8, y + 19, "teaching.ezznasr.dev", 9.5, MUT, "", "middle");
    return s + ring(12, y + 1, 32, 28);
  }

  var SCREENS = {
    ios: [
      { svg: function () { return frame(list([{ t: "Notifications", chev: 1, dim: 1 }, { t: "General", chev: 1, dim: 1 }, { t: "Privacy & Security", chev: 1, hi: 1 }, { t: "Safari", chev: 1, dim: 1 }]), "Settings"); },
        en: "Open the Settings app and tap Privacy & Security.", ar: "افتح تطبيق الإعدادات واضغط «الخصوصية والأمن»." },
      { svg: function () { return frame(list([{ t: "Location Services", toggle: true, hi: 1 }, { t: "Tracking", chev: 1, dim: 1 }, { t: "Contacts", chev: 1, dim: 1 }]), "Privacy & Security"); },
        en: "Tap Location Services and switch it on (green).", ar: "اضغط «خدمات الموقع» وشغّلها (أخضر)." },
      { svg: function () { return frame(list([{ t: "Never", dim: 1 }, { t: "Ask Next Time", dim: 1 }, { t: "While Using the App", check: 1, hi: 1 }], 92) + text(20, 80, "Safari Websites", 10, MUT, "600"), "Location Services"); },
        en: "In the same list tap Safari Websites, then While Using the App.", ar: "في نفس القائمة اضغط «مواقع Safari» ثم «أثناء استخدام التطبيق»." },
      { svg: function () { return frame(browserBar("aA", 40) + '<rect x="14" y="80" width="' + (W - 28) + '" height="118" rx="12" fill="#fff" stroke="' + LINE + '"/>' +
          text(26, 102, "Hide Toolbar", 11, MUT) + text(26, 130, "Website Settings", 11.5, INK, "600") + ring(18, 114, W - 36, 26) +
          text(26, 166, "Location", 11, INK) + text(W - 30, 166, "Allow", 11, BLUE, "600", "end") + text(26, 188, "Then tap Done", 9.5, MUT)); },
        en: "Back on this page: tap aA, Website Settings, set Location to Allow. Then tap Try again.", ar: "ارجع لهذه الصفحة: اضغط aA ثم «إعدادات موقع الويب» واجعل «الموقع» على «سماح». ثم اضغط «حاول مرة أخرى»." }
    ],
    android: [
      { svg: function () {
          var s = frame("", "Quick settings"), tiles = [["Wi-Fi", 0], ["Bluetooth", 0], ["Location", 1], ["Flashlight", 0]], out = "";
          tiles.forEach(function (t, i) {
            var x = 14 + (i % 2) * 78, y = 70 + Math.floor(i / 2) * 58, on = t[1];
            out += '<rect x="' + x + '" y="' + y + '" width="72" height="48" rx="14" fill="' + (on ? "#1a73e8" : "#fff") + '" stroke="' + LINE + '"/>' + text(x + 36, y + 29, t[0], 10.5, on ? "#fff" : INK, on ? "700" : "", "middle");
            if (on) out += ring(x - 2, y - 2, 76, 52);
          });
          return s.replace("</svg>", out + text(W / 2, 214, "Swipe down from the top", 9.5, MUT, "", "middle") + "</svg>");
        },
        en: "Swipe down from the top of the screen and turn Location on.", ar: "اسحب من أعلى الشاشة وشغّل «الموقع»." },
      { svg: function () { return frame(list([{ t: "Chrome", sub: "App info", chev: 1, dim: 0 }, { t: "Notifications", chev: 1, dim: 1 }, { t: "Permissions", chev: 1, hi: 1 }, { t: "Storage", chev: 1, dim: 1 }]), "Apps › Chrome"); },
        en: "Open Settings, Apps, Chrome, then tap Permissions.", ar: "افتح الإعدادات ثم «التطبيقات» ثم Chrome ثم «الأذونات»." },
      { svg: function () { return frame(list([{ t: "While using the app", check: 1, hi: 1 }, { t: "Ask every time", dim: 1 }, { t: "Don't allow", dim: 1 }], 92) + text(20, 80, "Location", 10, MUT, "600"), "Location permission"); },
        en: "Tap Location and choose Allow only while using the app.", ar: "اضغط «الموقع» واختر «السماح أثناء استخدام التطبيق فقط»." },
      { svg: function () { return frame(browserBar("tune", 40) + '<rect x="14" y="80" width="' + (W - 28) + '" height="118" rx="12" fill="#fff" stroke="' + LINE + '"/>' +
          text(26, 104, "Connection is secure", 10, MUT) + text(26, 132, "Permissions", 11.5, INK, "600") + ring(18, 116, W - 36, 26) +
          text(26, 166, "Location", 11, INK) + toggle(W - 54, 162, true) + text(26, 188, "or tap Reset permissions", 9.5, MUT)); },
        en: "Back on this page: tap the icon left of the address, Permissions, turn Location on. Then tap Try again.", ar: "ارجع لهذه الصفحة: اضغط الرمز يسار العنوان ثم «الأذونات» وشغّل «الموقع». ثم اضغط «حاول مرة أخرى»." }
    ]
  };

  function pane(p, show) {
    var s = '<div class="lh-pane" data-pane="' + p + '"' + (show ? "" : " hidden") + '>';
    SCREENS[p].forEach(function (st, i) {
      s += '<figure class="lh-step">' + st.svg() + '<figcaption><b>' + (i + 1) + '</b><span>' + esc(st.en) + '</span><span lang="ar" dir="rtl">' + esc(st.ar) + "</span></figcaption></figure>";
    });
    return s + "</div>";
  }
  function html(platform) {
    var p = platform === "android" ? "android" : "ios";
    return '<div class="lh"><p class="lh-title">How to turn location on <span lang="ar" dir="rtl">· طريقة تشغيل الموقع</span></p>' +
      '<div class="lh-tabs" role="tablist">' +
      '<button type="button" role="tab" data-lh="ios" aria-selected="' + (p === "ios") + '">iPhone</button>' +
      '<button type="button" role="tab" data-lh="android" aria-selected="' + (p === "android") + '">Android</button></div>' +
      pane("ios", p === "ios") + pane("android", p === "android") + "</div>";
  }
  function bind(root) {
    if (!root || !root.addEventListener) return;
    root.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-lh]") : null; if (!b) return;
      var p = b.getAttribute("data-lh");
      Array.prototype.forEach.call(root.querySelectorAll("[data-lh]"), function (x) { x.setAttribute("aria-selected", String(x === b)); });
      Array.prototype.forEach.call(root.querySelectorAll("[data-pane]"), function (x) { x.hidden = x.getAttribute("data-pane") !== p; });
    });
  }
  var api = { html: html, bind: bind, SCREENS: SCREENS };
  g.ATT_LOC_HELP = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
