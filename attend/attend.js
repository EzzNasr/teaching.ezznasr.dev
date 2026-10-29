(function () {
  "use strict";
  var CFG = window.ATT_CONFIG, api = window.attApi;
  // Real backend once API_URL is set; mock otherwise.
  if (/^REPLACE_/.test(CFG.API_URL)) window.ATT_FETCH = window.attMockFetch;

  // Tunables live in att_config.js; the fallbacks keep the page working if a stale cached config is served.
  var K = {
    GEO_HIGH_TIMEOUT_MS: CFG.GEO_HIGH_TIMEOUT_MS || 20000,
    GEO_LOW_TIMEOUT_MS: CFG.GEO_LOW_TIMEOUT_MS || 10000,
    GEO_MAX_AGE_MS: CFG.GEO_MAX_AGE_MS || 60000,
    GEO_SKIP_AFTER_FAILS: CFG.GEO_SKIP_AFTER_FAILS || 2,
    SUBMIT_WATCHDOG_MS: CFG.SUBMIT_WATCHDOG_MS || 30000
  };

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
    GENERIC: "Something went wrong. Try again.",
    // S1: retry card (nothing was confirmed by the server, so we never say \"saved\")
    NETWORK_RETRY: "No connection. Your attendance is not saved yet. Check your internet, then tap Retry.",
    BUSY_RETRY: "The server is busy. Your attendance is not saved yet. Tap Retry.",
    SERVER_RETRY: "The server had a problem. Your attendance is not saved yet. Tap Retry.",
    UNCONFIRMED: "This is taking too long. Your attendance is not confirmed yet. Tap Retry.",
    // S1: location gate
    GATE_ASK_T: "Turn on location to check in",
    GATE_ASK: "Attendance only counts inside the lecture hall. Your location is read when you save.",
    GATE_WORK_T: "Finding your location",
    GATE_WORK: "Keep this page open. Indoors this can take up to 30 seconds.",
    GATE_DENIED_T: "Location is blocked",
    GATE_DENIED: "This page can't see your location. Turn it on for this site, then tap Try again.",
    GATE_WEAK_T: "Couldn't find your location",
    GATE_WEAK: "Your phone didn't return a location in time. Fix the items below, then tap Try again.",
    GATE_UNSUP_T: "This browser can't share location",
    GATE_UNSUP: "Open this page in Chrome or Safari, then scan the QR again.",
    GATE_FAIL_1: "Location is still unavailable.",
    HELP_BLOCKED: "How to turn location on",
    HELP_WEAK: "To get a better location signal"
  };
  var STEPS = {
    blocked: {
      ios: ["Tap aA in the address bar, then Website Settings.", "Set Location to Allow.", "If Location is missing: Settings > Privacy & Security > Location Services. Turn it on and set Safari Websites to While Using."],
      android: ["Tap the lock icon next to the address.", "Tap Permissions, then Location, and choose Allow.", "Make sure Location is on in your phone's quick settings."],
      inapp: ["Tap the menu in the corner of this screen.", "Choose Open in browser (Chrome or Safari).", "Scan the QR on the screen again."],
      other: ["Click the lock icon next to the address.", "Set Location to Allow for this site."]
    },
    weak: {
      ios: ["Turn on Location Services in Settings > Privacy & Security.", "Move near a window or doorway.", "Turn Wi-Fi on. It improves indoor location even if you aren't connected."],
      android: ["Turn on Location (GPS) in your phone's quick settings.", "Move near a window or doorway.", "Turn Wi-Fi on. It improves indoor location even if you aren't connected."],
      inapp: ["Tap the menu in the corner of this screen.", "Choose Open in browser (Chrome or Safari).", "Scan the QR on the screen again."],
      other: ["Turn on location services on this device.", "Move near a window or doorway."]
    }
  };

  var IN_APP = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|GSA\//i;
  var RETRYABLE = { NETWORK: "NETWORK_RETRY", BUSY: "BUSY_RETRY", SERVER_ERROR: "SERVER_RETRY" };

  var $ = function (i) { return document.getElementById(i); };
  var el = { clock: $("clock"), sub: $("sub"), welcome: $("welcome"), sid: $("sid"), save: $("save"),
    signup: $("signup"), change: $("change"), msg: $("msg"), name: $("name"), namebox: $("namebox"),
    gate: $("gate"), gateTitle: $("gateTitle"), gateText: $("gateText"), gateBtn: $("gateBtn"), gateHelp: $("gateHelp"),
    gateHelpTitle: $("gateHelpTitle"), gateSteps: $("gateSteps"), gateMsg: $("gateMsg"), gateSkipBox: $("gateSkipBox"), gateSkip: $("gateSkip"),
    form: $("form"), done: $("done"), doneName: $("doneName"), doneTime: $("doneTime"), doneNote: $("doneNote"),
    busy: $("busy"), spin: $("spin"), busyStep: $("busyStep"), busyWarn: $("busyWarn"), busyErr: $("busyErr"), busyRetry: $("busyRetry") };
  var st = { secret: null, fp: null, id: null, name: "", recognized: false, ticket: null, ticketExp: 0,
    closeMs: 0, offset: 0, busy: false, dead: false, done: false,
    view: "none", perm: "unknown", fix: null, geoFail: null, geoAttempts: 0, geoFails: 0, skipped: false, acquiring: false,
    run: 0, lastKind: "attend", wd: null, wl: null };

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
  // The page keeps the REASON a fix failed (the server used to see only "denied"):
  // PERMISSION_DENIED | POSITION_UNAVAILABLE | TIMEOUT | UNSUPPORTED | INSECURE_CONTEXT  (+ USER_SKIPPED when the student continues without).
  var GEO_REASON = { 1: "PERMISSION_DENIED", 2: "POSITION_UNAVAILABLE", 3: "TIMEOUT" };
  function permState() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        return navigator.permissions.query({ name: "geolocation" }).then(function (s) { return s.state || "unknown"; }, function () { return "unknown"; });
      }
    } catch (e) {}
    return Promise.resolve("unknown");
  }
  // One getCurrentPosition call -> {ok:true,pos} | {ok:false,reason}.
  // `guard` adds a hard stop for the case where permission is already granted but the browser never answers.
  // It is NOT used while a permission prompt may still be open (the student could be reading it).
  function getFix(o, guard) {
    return new Promise(function (res) {
      if (window.isSecureContext === false) return res({ ok: false, reason: "INSECURE_CONTEXT" });
      if (!navigator.geolocation) return res({ ok: false, reason: "UNSUPPORTED" });
      var done = false, gt = null;
      function fin(r) { if (done) return; done = true; if (gt) clearTimeout(gt); res(r); }
      if (guard) gt = setTimeout(function () { fin({ ok: false, reason: "TIMEOUT" }); }, o.timeout + 5000);
      try {
        navigator.geolocation.getCurrentPosition(function (p) {
          fin({ ok: true, pos: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: Date.now() } });
        }, function (e) {
          fin({ ok: false, reason: GEO_REASON[e && e.code] || "POSITION_UNAVAILABLE" });
        }, { enableHighAccuracy: !!o.high, maximumAge: o.maxAge, timeout: o.timeout });
      } catch (e) { fin({ ok: false, reason: "UNSUPPORTED" }); }
    });
  }
  // Stage 1: GPS-quality fix. Stage 2 (only after a timeout / unavailable): any recent coarse fix. A real denial stops at once.
  function acquire(guard) {
    return getFix({ high: true, timeout: K.GEO_HIGH_TIMEOUT_MS, maxAge: 0 }, guard).then(function (r) {
      if (r.ok || r.reason === "PERMISSION_DENIED" || r.reason === "UNSUPPORTED" || r.reason === "INSECURE_CONTEXT") return r;
      return getFix({ high: false, timeout: K.GEO_LOW_TIMEOUT_MS, maxAge: K.GEO_MAX_AGE_MS }, guard);
    });
  }
  function fixFresh() { return !!st.fix && Date.now() - st.fix.ts <= K.GEO_MAX_AGE_MS; }
  function refreshPerm() { return permState().then(function (s) { st.perm = s; return s; }); }
  // What the server receives (contract 4.1): coordinates, or {denied:true, reason}.
  function geoPayload() {
    if (st.fix) return { lat: st.fix.lat, lng: st.fix.lng, acc: st.fix.acc };
    return { denied: true, reason: st.skipped ? "USER_SKIPPED" : ((st.geoFail && st.geoFail.reason) || "PERMISSION_DENIED") };
  }
  function diag() {
    var d = { perm: st.perm, attempts: st.geoAttempts, online: navigator.onLine !== false, inapp: IN_APP.test(navigator.userAgent || "") };
    if (!st.fix && st.geoFail) d.fail_reason = st.geoFail.reason;   // additive (see HANDOFF-S1): why the skipped/failed fix failed
    return d;
  }

  // ---------- ticket + countdown ----------
  function fetchTicket(sess, tok) {
    var t0 = Date.now();
    return api.call("att_ticket", { session_id: sess, token: tok }).then(function (r) {
      var t1 = Date.now();
      if (!r.ok) return r;
      if (r.server_utc) st.offset = Date.parse(r.server_utc) - (t0 + t1) / 2;
      st.ticket = r.ticket;
      // Trust the server's own expiry (server clock) so a config/server mismatch can't make the page lie about the countdown.
      st.ticketExp = (isFinite(Number(r.expires_at)) && Number(r.expires_at) > 0) ? Number(r.expires_at) : srvNow() + CFG.TICKET_SEC * 1000;
      st.closeMs = Date.parse(r.close_utc);
      return r;
    });
  }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return ("0" + Math.floor(s / 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2); }
  function kill(msg) {
    st.dead = true; st.busy = false; clearTimeout(st.wd); hideBusy(); unlock();
    el.save.disabled = true; el.signup.disabled = true; el.change.disabled = true; el.gateBtn.disabled = true; el.gateSkip.disabled = true;
    if (st.view === "gate") view("none");
    if (msg) say(msg, "err");
  }
  function tick() {
    if (!st.closeMs) return;
    var left = st.closeMs - srvNow();
    el.clock.textContent = mmss(left);
    if (st.dead || st.done) return;
    if (left <= 0) { el.sub.textContent = ""; return kill(MESSAGES.SESSION_CLOSED); }
    // A request already in flight is allowed to finish: the server decides, not our countdown.
    if (st.ticketExp <= srvNow() && !st.busy) { el.sub.textContent = ""; return kill(MESSAGES.QR_EXPIRED); }
    el.sub.textContent = "QR valid " + mmss(st.ticketExp - srvNow());
  }

  // ---------- views: gate -> form -> done ----------
  function view(name) {
    st.view = name;
    el.gate.hidden = name !== "gate"; el.form.hidden = name !== "form"; el.done.hidden = name !== "done";
  }
  function platform() {
    var ua = navigator.userAgent || "";
    if (IN_APP.test(ua)) return "inapp";
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
    if (/Android/i.test(ua)) return "android";
    return "other";
  }
  function setSteps(list) {
    el.gateSteps.textContent = "";
    list.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; el.gateSteps.appendChild(li); });
  }
  // mode: ask | working | denied | weak | unsupported
  function gateUi(mode) {
    var p = platform(), help = mode === "denied" || mode === "weak";
    var T = { ask: [MESSAGES.GATE_ASK_T, MESSAGES.GATE_ASK], working: [MESSAGES.GATE_WORK_T, MESSAGES.GATE_WORK],
      denied: [MESSAGES.GATE_DENIED_T, MESSAGES.GATE_DENIED], weak: [MESSAGES.GATE_WEAK_T, MESSAGES.GATE_WEAK],
      unsupported: [MESSAGES.GATE_UNSUP_T, MESSAGES.GATE_UNSUP] }[mode];
    el.gateTitle.textContent = T[0]; el.gateText.textContent = T[1];
    el.gateBtn.hidden = mode === "unsupported";
    el.gateBtn.disabled = mode === "working" || st.dead;
    el.gateBtn.textContent = mode === "working" ? "Finding your location\u2026" : (mode === "ask" ? "Allow location" : "Try again");
    el.gateHelp.hidden = !help;
    if (help) { el.gateHelpTitle.textContent = mode === "denied" ? MESSAGES.HELP_BLOCKED : MESSAGES.HELP_WEAK; setSteps(STEPS[mode === "denied" ? "blocked" : "weak"][p]); }
    el.gateMsg.textContent = (mode === "denied" || mode === "weak") && st.geoFails > 0 ? MESSAGES.GATE_FAIL_1 : "";
    el.gateSkipBox.hidden = !(st.geoFails >= K.GEO_SKIP_AFTER_FAILS || mode === "unsupported");
  }
  function enterForm() {
    view("form"); render(); el.save.disabled = st.dead; say("", "info"); tick();
  }
  function startGate() {
    view("gate");
    return refreshPerm().then(function (s) {
      watchPerm();
      if (s === "granted") return gateAttempt(true);   // already allowed: no tap needed, nothing to ask
      gateUi(s === "denied" ? "denied" : "ask");
    });
  }
  // A tap (or a silent attempt when permission is already granted).
  function gateAttempt(guard) {
    if (st.dead || st.acquiring || st.view !== "gate") return Promise.resolve();
    st.acquiring = true; st.geoAttempts++;
    gateUi("working");
    return acquire(guard).then(function (r) {
      st.acquiring = false;
      refreshPerm();
      if (st.dead) return;
      if (r.ok) { st.fix = r.pos; st.geoFail = null; st.skipped = false; return enterForm(); }
      st.geoFail = { reason: r.reason }; st.geoFails++;
      gateUi(r.reason === "PERMISSION_DENIED" ? "denied" : (r.reason === "UNSUPPORTED" || r.reason === "INSECURE_CONTEXT") ? "unsupported" : "weak");
    });
  }
  function skipLocation() {
    if (st.dead || st.view !== "gate") return;
    st.skipped = true; enterForm();
  }
  // If the student flips the setting (or comes back from the settings screen) while the gate is open, continue by itself.
  var permWatched = false;
  function watchPerm() {
    if (permWatched) return; permWatched = true;
    try {
      navigator.permissions.query({ name: "geolocation" }).then(function (s) {
        s.addEventListener("change", function () { st.perm = s.state; if (s.state === "granted" && st.view === "gate" && !st.acquiring) gateAttempt(true); });
      }).catch(function () {});
    } catch (e) {}
  }
  function onVisible() {
    if (document.hidden || st.view !== "gate" || st.acquiring || st.dead) return;
    refreshPerm().then(function (s) { if (s === "granted" && st.view === "gate" && !st.acquiring) gateAttempt(true); });
  }

  // ---------- form UI ----------
  function render() {
    el.sid.value = st.id || el.sid.value;
    el.sid.readOnly = st.recognized;
    el.welcome.textContent = st.recognized ? "Welcome, " + (st.name || st.id) : "";
    el.signup.hidden = st.recognized;
    el.change.hidden = st.recognized;
    el.namebox.hidden = st.recognized;
  }
  function readId() { var v = el.sid.value.trim(); return CFG.ID_REGEX.test(v) ? v : null; }
  function setBtns() { [el.save, el.signup, el.change].forEach(function (x) { x.disabled = st.busy || st.dead || st.done; }); }
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
    el.save.classList.add("ok"); el.save.textContent = "\u2713 Saved"; setBtns();
    el.clock.hidden = true; el.sub.hidden = true;
    el.doneName.textContent = st.name ? "Welcome, " + st.name : "";
    el.doneTime.textContent = "Recorded at " + (r.server_utc ? tf.format(new Date(r.server_utc)) : tf.format(new Date(srvNow())));
    el.doneNote.textContent = st.fix ? "" : MESSAGES.GEO_NOTE;
    say("", "info"); view("done");
  }

  // ---------- blocking overlay: from tap to server answer ----------
  function showBusy(step) {
    el.busy.hidden = false; el.spin.hidden = false; el.busyStep.textContent = step; el.busyWarn.hidden = false; el.busyWarn.textContent = "Don't close this page.";
    el.busyErr.hidden = true; el.busyRetry.hidden = true;
    try { el.busy.focus(); } catch (e) {}
  }
  function setStep(t) { if (st.busy && el.busyRetry.hidden) el.busyStep.textContent = t; }
  function showRetry(text) {
    el.busy.hidden = false; el.spin.hidden = true; el.busyStep.textContent = "Not saved yet"; el.busyWarn.textContent = "Keep this page open.";
    el.busyErr.textContent = text; el.busyErr.hidden = false; el.busyRetry.hidden = false;
    try { el.busyRetry.focus(); } catch (e) {}
  }
  function hideBusy() { el.busy.hidden = true; el.busyWarn.textContent = "Don't close this page."; }
  function lock() {
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { if (st.busy) st.wl = l; else { try { l.release(); } catch (e) {} } }).catch(function () {}); } catch (e) {}
  }
  function unlock() { try { if (st.wl) st.wl.release(); } catch (e) {} st.wl = null; }
  function begin(step) {
    st.busy = true; setBtns(); say("", "info"); showBusy(step); lock();
    clearTimeout(st.wd); st.wd = setTimeout(function () { if (st.busy && !st.done && !st.dead) showRetry(MESSAGES.UNCONFIRMED); }, K.SUBMIT_WATCHDOG_MS);
  }
  function end() { clearTimeout(st.wd); st.busy = false; hideBusy(); unlock(); setBtns(); }
  function retry() {
    if (st.done || st.dead) return;
    st.run++; end();            // any answer still on its way for the old attempt is handled in finish()
    run(st.lastKind);
  }

  // ---------- flows ----------
  function guard() {
    if (st.dead || st.busy || st.done) return false;
    if (!st.ticket || st.ticketExp <= srvNow()) { kill(MESSAGES.QR_EXPIRED); return false; }
    return true;
  }
  function pAttend(id, c) { return { ticket: st.ticket, student_id: id, secret: st.secret, fp: c.fp, geo: c.geo, diag: diag() }; }
  function pSignup(id, c) { var p = pAttend(id, c), n = el.name.value.trim().slice(0, 60); if (n) p.name = n; return p; }
  function pChange(id, c) { return { ticket: st.ticket, student_id: id, new_secret: st.secret, fp: c.fp }; }
  // Make sure a recent fix exists at submit time. Failure never blocks the check-in: it is sent with its reason.
  function ensureFix(need) {
    if (!need || fixFresh() || (st.skipped && !st.fix)) return Promise.resolve();
    return acquire(st.perm === "granted").then(function (r) {
      if (r.ok) { st.fix = r.pos; st.geoFail = null; } else st.geoFail = { reason: r.reason };   // an older fix, if any, is still used
    });
  }
  // A failed answer: retryable problems keep the overlay (never claim success); everything else returns to the form.
  function fail(r, id, my) {
    if (my !== st.run) return;
    var k = RETRYABLE[r.code];
    if (k) return showRetry(MESSAGES[k]);
    end(); errMsg(r, id);
  }
  function finishAttend(r, id, my) {
    if (st.done) return;
    if (!r.ok) return fail(r, id, my);
    end();                      // also covers a late "recorded" answer for an attempt the student already retried
    st.id = id; st.recognized = true; saveAll("att_id", id); success(r);
  }
  function doAttend(id, c, my) {
    return api.call("att_attend", pAttend(id, c)).then(function (r) { return finishAttend(r, id, my); });
  }
  // kind: attend | signup | change
  function run(kind) {
    if (!guard()) return Promise.resolve();
    var id = (kind === "attend" && st.recognized) ? st.id : readId();
    if (!id) return say(MESSAGES.BAD_ID, "err"), Promise.resolve();
    // First-timer who typed ID + name and tapped the big button: register them instead of bouncing them with an error.
    if (kind === "attend" && !st.recognized && el.name.value.trim()) kind = "signup";
    if (kind === "signup" && !el.name.value.trim()) { say(MESSAGES.NAME_REQUIRED, "err"); return Promise.resolve(); }
    var need = kind !== "change", my = ++st.run;
    st.lastKind = kind;
    begin(need ? "Checking location\u2026" : "Sending request\u2026");
    return ensureFix(need).then(function () {
      if (my !== st.run) return null;
      setStep("Verifying device\u2026");
      return fingerprint();
    }).then(function (fp) {
      if (fp === null || my !== st.run) return null;
      var c = { geo: need ? geoPayload() : null, fp: fp };
      if (kind === "change") {
        setStep("Sending request\u2026");
        return api.call("att_change_device", pChange(id, c)).then(function (r) {
          if (!r.ok) return fail(r, id, my);
          end(); el.change.hidden = true; el.signup.hidden = true; el.save.hidden = false; say(MESSAGES.CHANGE_PENDING, "info"); el.save.disabled = true;
        });
      }
      if (kind === "signup") {
        setStep("Registering\u2026");
        return api.call("att_signup", pSignup(id, c)).then(function (r) {
          if (!r.ok) return fail(r, id, my);
          st.id = id; st.recognized = true; st.name = el.name.value.trim().slice(0, 60); if (st.name) saveAll("att_name", st.name);
          return saveAll("att_id", id).then(function () {
            render(); setStep("Saving attendance\u2026");
            return doAttend(id, c, my);   // ASSUMPTION: ticket reusable for signup then attend (overlay stays up across both calls)
          });
        });
      }
      setStep("Saving attendance\u2026");
      return doAttend(id, c, my);
    }).catch(function () { if (my === st.run && !st.done) showRetry(MESSAGES.GENERIC + " Your attendance is not saved yet."); });
  }

  // ---------- boot ----------
  function boot() {
    var q = new URLSearchParams(location.search), sess = q.get("s"), tok = q.get("t");
    el.save.addEventListener("click", function () { run("attend"); });
    el.signup.addEventListener("click", function () { run("signup"); });
    el.change.addEventListener("click", function () { run("change"); });
    el.gateBtn.addEventListener("click", function () { gateAttempt(st.perm === "granted"); });
    el.gateSkip.addEventListener("click", skipLocation);
    el.busyRetry.addEventListener("click", retry);
    el.sid.addEventListener("input", function () { el.sid.value = el.sid.value.replace(/\D/g, ""); });
    // Closing during a save is the one thing that loses an attendance: ask the browser to confirm.
    window.addEventListener("beforeunload", function (e) { if (st.busy && !st.done) { e.preventDefault(); e.returnValue = ""; return ""; } });
    document.addEventListener("visibilitychange", onVisible);
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
      tick();
      // Location comes first. No auto check-in any more: a returning student sees "Welcome back" and taps once, after the gate.
      return startGate();
    }).catch(function () {});
  }
  boot();
})();
