(function () {
  "use strict";
  var CFG = window.ATT_CONFIG, api = window.attApi;
  // Real backend once API_URL is set; mock otherwise.
  if (/^REPLACE_/.test(CFG.API_URL)) window.ATT_FETCH = window.attMockFetch;

  // Wording is the agreed message table (S5). Students only ever see their OWN id; flags are never revealed.
  // {id} is only ever this device's own stored/typed ID.
  var MESSAGES = {
    RECORDED: "Attendance recorded",
    NEED_QR: "Scan the QR on the screen to check in.",
    QR_EXPIRED: "QR expired. Scan the screen again.",
    SESSION_CLOSED: "Attendance closed for this lecture.",
    NO_SESSION: "Session not found. Scan the screen again.",
    BAD_ID: "Enter a valid student ID (4-12 digits).",
    ID_TAKEN: "This ID is already registered. Tap Change device to request approval.",
    ID_BOUND_OTHER_DEVICE: "DETECTED: ID {id} is registered to a different device. This attempt and both IDs have been recorded and sent to the instructor for review. If you changed phones, tap Change device.",
    TOKEN_EXPIRED: "QR expired. Scan the screen again.",
    TICKET_EXPIRED: "QR expired. Scan the screen again.",
    DEVICE_BOUND_OTHER_ID: "DETECTED: this device is registered to another student. Both IDs have been recorded and sent for review.",
    DEVICE_ID_CONFLICT: "DETECTED: this device is registered to another student. Both IDs have been recorded and sent for review.",
    UNKNOWN_STUDENT: "First time here? Type your name, then tap Sign up (first time).",
    NAME_REQUIRED: "Type your name to sign up.",
    DEVICE_UNKNOWN: "This device is not recognized for that ID. Tap Change device to request approval.",
    CHANGE_PENDING: "Request sent. Show your student ID to the instructor.",
    GEO_NOTE: "Your location could not be verified inside the lecture hall. This has been recorded for review.",
    NO_STORAGE: "Open this page in Chrome or Safari. This in-app browser can't save your device.",
    NETWORK: "No connection. Check your internet and try again.",
    GENERIC: "Something went wrong. Try again."
  };

  var $ = function (i) { return document.getElementById(i); };
  var el = { clock: $("clock"), sub: $("sub"), welcome: $("welcome"), sid: $("sid"), save: $("save"),
    signup: $("signup"), change: $("change"), msg: $("msg"), name: $("name"), namebox: $("namebox") };
  var st = { secret: null, fp: null, id: null, name: "", recognized: false, ticket: null, ticketExp: 0,
    closeMs: 0, offset: 0, busy: false, dead: false };

  function say(text, kind) { el.msg.textContent = text || ""; el.msg.className = kind || "info"; }
  function fmt(tpl, id) { return tpl.replace("{id}", id || ""); }
  var tf = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  function srvNow() { return Date.now() + st.offset; }

  // ---------- device identity: localStorage + cookie + IndexedDB ----------
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return localStorage.getItem(k) === v; } catch (e) { return false; } }
  function ckGet(k) { var m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; }
  function ckSet(k, v) {
    try {
      document.cookie = k + "=" + encodeURIComponent(v) + ";max-age=63072000;path=/;SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : "");
      return ckGet(k) === v;
    } catch (e) { return false; }
  }
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open("att_dev", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var q = db.transaction("kv").objectStore("kv").get(k);
        q.onsuccess = function () { res(q.result == null ? null : q.result); };
        q.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k);
        tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); };
      });
    }).catch(function () { return false; });
  }
  // Persist k=v to all stores; resolves to number of stores that kept it.
  function saveAll(k, v) {
    return idbSet(k, v).then(function (a) { return [lsSet(k, v), ckSet(k, v), a].filter(Boolean).length; });
  }
  function loadAll(k) {
    return idbGet(k).then(function (a) { return lsGet(k) || ckGet(k) || a || null; });
  }
  var HEX64 = /^[0-9a-f]{64}$/;
  function initDevice() {
    return loadAll("att_secret").then(function (s) {
      if (!HEX64.test(s || "")) { s = hex(crypto.getRandomValues(new Uint8Array(32))); }
      st.secret = s;
      return saveAll("att_secret", s);
    }).then(function (n) {
      if (n === 0) throw new Error("NO_STORAGE");
      return loadAll("att_id");
    }).then(function (id) {
      if (id && CFG.ID_REGEX.test(id)) { st.id = id; st.recognized = true; saveAll("att_id", id); }
      return loadAll("att_name");
    }).then(function (n) { if (st.recognized && n) st.name = String(n).slice(0, 60); });
  }
  // Spec 4: fp = SHA-256 hex of screen|tz|lang|hwConcurrency|webglRenderer.
  // ASSUMPTION: "screen" = widthxheight (CSS px).
  function webglRenderer() {
    try {
      var c = document.createElement("canvas"), g = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!g) return "na";
      var x = g.getExtension("WEBGL_debug_renderer_info");
      return String(g.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : g.RENDERER) || "na");
    } catch (e) { return "na"; }
  }
  function fingerprint() {
    var raw = [screen.width + "x" + screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language,
      navigator.hardwareConcurrency, webglRenderer()].join("|");
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)).then(hex).catch(function () { return "na"; });
    }
    return Promise.resolve("na");
  }

  // ---------- geolocation ----------
  // Spec 4: geo = {lat,lng,acc} or {denied:true}. Any failure (denied, timeout, unsupported) -> {denied:true}.
  function geo() {
    return new Promise(function (res) {
      if (!navigator.geolocation) return res({ denied: true });
      navigator.geolocation.getCurrentPosition(function (p) {
        res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });
      }, function () { res({ denied: true }); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
    });
  }

  // ---------- ticket + countdown ----------
  function fetchTicket(sess, tok) {
    var t0 = Date.now();
    return api.call("att_ticket", { session_id: sess, token: tok }).then(function (r) {
      var t1 = Date.now();
      if (!r.ok) return r;
      if (r.server_utc) st.offset = Date.parse(r.server_utc) - (t0 + t1) / 2;
      st.ticket = r.ticket;
      st.ticketExp = srvNow() + CFG.TICKET_SEC * 1000;
      st.closeMs = Date.parse(r.close_utc);
      return r;
    });
  }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return ("0" + Math.floor(s / 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2); }
  function kill(msg) {
    st.dead = true; el.save.disabled = true; el.signup.disabled = true; el.change.disabled = true;
    if (msg) say(msg, "err");
  }
  function tick() {
    if (!st.closeMs) return;
    var left = st.closeMs - srvNow();
    el.clock.textContent = mmss(left);
    if (st.dead) return;
    if (left <= 0) { el.sub.textContent = ""; return kill(MESSAGES.SESSION_CLOSED); }
    if (st.ticketExp <= srvNow() && !st.done) { el.sub.textContent = ""; return kill(MESSAGES.QR_EXPIRED); }
    if (!st.done) el.sub.textContent = "QR valid " + mmss(st.ticketExp - srvNow());
  }

  // ---------- UI state ----------
  function render() {
    el.sid.value = st.id || el.sid.value;
    el.sid.readOnly = st.recognized;
    el.welcome.textContent = st.recognized ? "Welcome, " + (st.name || st.id) : "";
    el.signup.hidden = st.recognized;
    el.change.hidden = st.recognized;
    el.namebox.hidden = st.recognized;
  }
  function readId() { var v = el.sid.value.trim(); return CFG.ID_REGEX.test(v) ? v : null; }
  function busy(b) {
    st.busy = b;
    [el.save, el.signup, el.change].forEach(function (x) { x.disabled = b || st.dead; });
  }
  var ROUTE = { ID_TAKEN: 1, ID_BOUND_OTHER_DEVICE: 1, DEVICE_UNKNOWN: 1 };   // -> change-device flow
  function toChangeDevice(id) {
    if (st.recognized) { saveAll("att_id", ""); saveAll("att_name", ""); }
    st.recognized = false; st.id = null; st.name = ""; render(); el.sid.value = id || el.sid.value;
    el.signup.hidden = false; el.change.hidden = false; el.change.className = "pri";
  }
  function errMsg(r, id) {
    if (r.code === "SESSION_CLOSED") { kill(MESSAGES.SESSION_CLOSED); return; }
    if (r.code === "TICKET_EXPIRED" || r.code === "TOKEN_EXPIRED") { kill(MESSAGES.QR_EXPIRED); return; }
    var own = st.recognized ? st.id : id;
    if (ROUTE[r.code]) toChangeDevice(id);
    if (r.code === "UNKNOWN_STUDENT" && el.name) { el.signup.hidden = false; el.namebox.hidden = false; try { el.name.focus(); } catch (e) {} }
    say(fmt(MESSAGES[r.code] || (r.code === "NETWORK" ? MESSAGES.NETWORK : MESSAGES.GENERIC), own), "err");
  }
  function success(r) {
    st.done = true;
    if (r.name) { st.name = String(r.name).slice(0, 60); saveAll("att_name", st.name); render(); }
    el.save.classList.add("ok"); el.save.textContent = "\u2713 Saved";
    el.save.disabled = true; el.signup.hidden = true; el.change.hidden = true;
    el.sub.textContent = r.server_utc ? tf.format(new Date(r.server_utc)) : tf.format(new Date(srvNow()));
    say(MESSAGES.RECORDED + (st.geoDenied ? ". " + MESSAGES.GEO_NOTE : ""), "ok");
  }
  function ctx(needGeo) {
    return Promise.all([needGeo ? geo() : Promise.resolve(null), fingerprint()]).then(function (a) { if (a[0]) st.geoDenied = !!a[0].denied; return { geo: a[0], fp: a[1] }; });
  }
  function guard() {
    if (st.dead || st.busy) return false;
    if (!st.ticket || st.ticketExp <= srvNow()) { kill(MESSAGES.QR_EXPIRED); return false; }
    return true;
  }
  function pAttend(id, c) { return { ticket: st.ticket, student_id: id, secret: st.secret, fp: c.fp, geo: c.geo }; }
  function pSignup(id, c) { var p = pAttend(id, c), n = el.name.value.trim().slice(0, 60); if (n) p.name = n; return p; }
  function pChange(id, c) { return { ticket: st.ticket, student_id: id, new_secret: st.secret, fp: c.fp }; }

  // ---------- flows ----------
  function attend() {
    if (!guard()) return Promise.resolve();
    var id = st.recognized ? st.id : readId();
    if (!id) return say(MESSAGES.BAD_ID, "err"), Promise.resolve();
    // First-timer who typed ID + name and tapped the big button: register them instead of bouncing them with an error.
    if (!st.recognized && el.name.value.trim()) return signup();
    busy(true); say("Saving\u2026", "info");
    return ctx(true).then(function (c) { return api.call("att_attend", pAttend(id, c)); }).then(function (r) {
      if (r.ok) { st.id = id; st.recognized = true; saveAll("att_id", id); return success(r); }
      errMsg(r, id);
    }).then(function () { if (!st.done) busy(false); });
  }
  function signup() {
    if (!guard()) return Promise.resolve();
    var id = readId();
    if (!id) return say(MESSAGES.BAD_ID, "err"), Promise.resolve();
    if (!el.name.value.trim()) { say(MESSAGES.NAME_REQUIRED, "err"); return Promise.resolve(); }
    busy(true); say("Registering\u2026", "info");
    return ctx(true).then(function (c) { return api.call("att_signup", pSignup(id, c)); }).then(function (r) {
      if (!r.ok) { errMsg(r, id); return busy(false); }
      st.id = id; st.recognized = true; st.name = el.name.value.trim().slice(0, 60); if (st.name) saveAll("att_name", st.name);
      return saveAll("att_id", id).then(function () {
        render(); busy(false); return attend();   // ASSUMPTION: ticket reusable for signup then attend
      });
    });
  }
  function changeDevice() {
    if (!guard()) return Promise.resolve();
    var id = readId();
    if (!id) return say(MESSAGES.BAD_ID, "err"), Promise.resolve();
    busy(true); say("Sending\u2026", "info");
    return ctx(false).then(function (c) { return api.call("att_change_device", pChange(id, c)); }).then(function (r) {
      if (r.ok) { el.change.hidden = true; el.signup.hidden = true; el.save.hidden = false; say(MESSAGES.CHANGE_PENDING, "info"); busy(false); el.save.disabled = true; return; }
      errMsg(r, id); busy(false);
    });
  }

  // ---------- boot ----------
  var IN_APP = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|GSA\//i;
  function boot() {
    var q = new URLSearchParams(location.search), sess = q.get("s"), tok = q.get("t");
    el.save.addEventListener("click", attend);
    el.signup.addEventListener("click", signup);
    el.change.addEventListener("click", changeDevice);
    el.sid.addEventListener("input", function () { el.sid.value = el.sid.value.replace(/\D/g, ""); });
    setInterval(tick, 250);
    if (!sess || !tok) { kill(MESSAGES.NEED_QR); return; }
    initDevice().catch(function (e) {
      if (e && e.message === "NO_STORAGE") { kill(MESSAGES.NO_STORAGE); throw e; }
      throw e;
    }).then(function () {
      if (IN_APP.test(navigator.userAgent)) say(MESSAGES.NO_STORAGE, "info");
      render();
      return fetchTicket(sess, tok);
    }).then(function (r) {
      if (!r.ok) { kill(MESSAGES[r.code] || MESSAGES.GENERIC); return; }
      el.save.disabled = false; say("", "info"); tick();
      if (st.recognized) attend();       // zero-tap path for returning students
    }).catch(function () {});
  }
  boot();
})();
