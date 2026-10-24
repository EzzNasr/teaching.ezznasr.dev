(function () {
  "use strict";
  var CFG = window.ATT_CONFIG, api = window.attApi, T = window.ATT_TOKEN;
  var BASE = "https://teaching.ezznasr.dev/attend/";   // QR target (spec)
  var DEBUG = /[?&]debug=1/.test(location.search);
  // Mock (with admin extension) until a real API_URL is set in att_config.js.
  if (/^REPLACE_/.test(CFG.API_URL)) window.ATT_FETCH = window.attMockExt || window.attMockFetch;

  var $ = function (i) { return document.getElementById(i); };
  var S = { tok: null, sess: null, key: null, closeMs: 0, offset: 0, win: -1, liveTimer: null, tickTimer: null, syncTimer: null, roomId: "", closed: false, course: "", room: "", wake: null };

  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} return null; }
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {} return null; }
  function msg(id, text, kind) { var e = $(id); e.textContent = text || ""; e.className = "msg" + (kind ? " " + kind : ""); }
  function srvNow() { return Date.now() + S.offset; }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); return ("0" + Math.floor(s / 60)).slice(-2) + ":" + ("0" + (s % 60)).slice(-2); }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function mk(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }

  // ---------- API ----------
  function A(action, payload) {
    return api.call(action, Object.assign({ token: S.tok }, payload || {})).then(function (r) {
      // ASSUMPTION: spec does not name the bad-token code; match common wordings.
      if (!r.ok && r.code !== "NETWORK" && /unauthori|forbidden|bad_token|invalid.?token|auth/i.test(String(r.code) + " " + String(r.error))) { logout("Token rejected. Log in again."); }
      return r;
    });
  }

  // ---------- login ----------
  function showLogin(text) { $("panel").hidden = true; $("proj").hidden = true; $("login").hidden = false; msg("loginMsg", text, text ? "err" : ""); }
  function login() {
    var t = $("tok").value.trim();
    if (!t) return msg("loginMsg", "Enter the admin token.", "err");
    S.tok = t; msg("loginMsg", "Checking…");
    A("att_requests", {}).then(function (r) {
      if (!r.ok) { if (S.tok) { S.tok = null; msg("loginMsg", r.code === "NETWORK" ? "No connection." : "Token rejected.", "err"); } return; }
      ss("att_admin", t); $("tok").value = ""; $("login").hidden = true; $("panel").hidden = false;
      initPanel();
    });
  }
  function logout(text) {
    stopSession(); S.tok = null; ss("att_admin", null); showLogin(typeof text === "string" ? text : "");
  }

  // ---------- panel ----------
  function fillList(id, key) {
    var dl = $(id); clear(dl);
    (JSON.parse(ls(key) || "[]")).forEach(function (v) { var o = document.createElement("option"); o.value = v; dl.appendChild(o); });
  }
  function remember(key, v) {
    if (!v) return; var a = JSON.parse(ls(key) || "[]").filter(function (x) { return x !== v; }); a.unshift(v); ls(key, JSON.stringify(a.slice(0, 10)));
  }
  function loadRooms() {
    return A("att_rooms", {}).then(function (r) {
      var sel = $("room"), dl = $("roomNames"), keep = sel.value || ls("att_room_id") || "";
      clear(sel); clear(dl);
      if (!r.ok) return msg("startMsg", "Could not load rooms: " + (r.code || "error"), "err");
      r.rooms.forEach(function (x) {
        var o = document.createElement("option"); o.value = x.room_id; o.textContent = x.name || x.room_id; sel.appendChild(o);
        var d = document.createElement("option"); d.value = x.name || ""; dl.appendChild(d);
      });
      if (keep && Array.prototype.some.call(sel.options, function (o) { return o.value === keep; })) sel.value = keep;
    });
  }
  function initPanel() {
    fillList("courses", "att_courses");
    var cs = JSON.parse(ls("att_courses") || "[]");
    if (!$("course").value && cs[0]) $("course").value = cs[0];
    loadRooms(); tab("session");
  }
  function tab(name) {
    ["session", "requests", "flagged", "calib"].forEach(function (n) { $("t-" + n).hidden = n !== name; });
    Array.prototype.forEach.call(document.querySelectorAll("nav [data-tab]"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
    if (name === "requests") loadRequests();
    if (name === "flagged") loadFlagged();
  }

  // ---------- session + projector ----------
  function startSession() {
    var course = $("course").value.trim(), roomId = $("room").value, room = $("room").selectedOptions[0] ? $("room").selectedOptions[0].textContent : "";
    if (!course || !roomId) return msg("startMsg", "Enter course and pick a room (calibrate one first if the list is empty).", "err");
    $("startBtn").disabled = true; msg("startMsg", "Starting…");
    var t0 = Date.now();
    A("att_start_session", { course: course, room_id: roomId }).then(function (r) {
      $("startBtn").disabled = false;
      if (!r.ok) return msg("startMsg", "Could not start: " + (r.code || "error"), "err");
      var t1 = Date.now();
      S.sess = r.session_id; S.key = r.session_key; S.closed = false; S.course = course; S.room = room; S.roomId = roomId;
      S.offset = Date.parse(r.start_utc) - (t0 + t1) / 2;
      S.closeMs = Date.parse(r.close_utc); S.win = -1;
      remember("att_courses", course); ls("att_room_id", roomId);
      msg("startMsg", ""); $("summary").hidden = true; $("resumeBtn").hidden = false;
      showProjector();
    });
  }
  function showProjector() {
    $("panel").hidden = true; $("proj").hidden = false; $("closeBtn").disabled = S.closed;
    $("pinfo").textContent = S.course + " · " + S.room;
    clearInterval(S.tickTimer); clearInterval(S.liveTimer);
    clearInterval(S.syncTimer);
    S.tickTimer = setInterval(tick, 200); S.liveTimer = setInterval(poll, 4000); S.syncTimer = setInterval(syncClock, 30000);
    tick(); poll(); syncClock(); wake();
  }
  // Refine clock offset with att_status.server_utc (spec 4); drives the QR window and countdown.
  function syncClock() {
    if (!S.sess) return;
    var t0 = Date.now();
    A("att_status", { session_id: S.sess }).then(function (r) {
      if (r.ok && r.server_utc) S.offset = Date.parse(r.server_utc) - (t0 + Date.now()) / 2;
    });
  }
  function hideProjector(tabName) { $("proj").hidden = true; $("panel").hidden = false; tab(tabName || "session"); }
  function stopSession() {
    clearInterval(S.tickTimer); clearInterval(S.liveTimer); clearInterval(S.syncTimer); S.tickTimer = S.liveTimer = S.syncTimer = null;
    try { if (S.wake) S.wake.release(); } catch (e) {} S.wake = null;
  }
  function wake() { try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { S.wake = l; }).catch(function () {}); } catch (e) {} }

  function tick() {
    var now = srvNow(), left = S.closeMs - now;
    $("pclock").textContent = mmss(left);
    var win = T.windowOf(now);
    if (!S.closed && left > 0) {
      if (win !== S.win) { S.win = win; drawFor(win); }
      var into = (now / 1000) % CFG.WINDOW_SEC;
      $("protbar").style.transform = "scaleX(" + (1 - into / CFG.WINDOW_SEC).toFixed(3) + ")";
    } else {
      blankQR(S.closed ? "Session closed" : "Attendance closed");
    }
  }
  function drawFor(win) {
    T.token(S.key, S.sess, win).then(function (t) {
      if (S.win !== win) return;   // a newer window already took over
      drawQR(BASE + "?s=" + encodeURIComponent(S.sess) + "&t=" + t);
    });
  }
  function drawQR(text) {
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), quiet = 4, total = n + quiet * 2;
    var px = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.58);
    var scale = Math.max(2, Math.floor(px / total)), size = total * scale;
    var c = $("qr"); c.width = size; c.height = size; c.style.width = size + "px"; c.style.height = size + "px";
    var g = c.getContext("2d"); if (!g) return;
    g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); g.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
    $("qr").hidden = false; $("prot").hidden = false;
  }
  function blankQR(text) { $("qr").hidden = true; $("prot").hidden = true; $("pinfo").textContent = text + " · " + S.course + " · " + S.room; }

  function poll() {
    if (!S.sess) return;
    A("att_live", { session_id: S.sess }).then(function (r) {
      if (!r.ok) return;
      $("pcount").textContent = "Registered " + r.registered + " / Present " + r.present + " | Flagged " + r.flagged;
      var p = r.pending | 0;
      ["pBadge", "pendBadge"].forEach(function (id) { $(id).hidden = !p; $(id).textContent = p; });
    });
  }
  function closeSession() {
    if (!S.sess || S.closed || !confirm("Close this session now? Students will no longer be able to check in.")) return;
    A("att_close_session", { session_id: S.sess }).then(function (r) {
      if (!r.ok) return alert("Could not close: " + (r.code || "error"));
      S.closed = true; $("closeBtn").disabled = true; tick(); poll();
      var s = r.summary || {};
      hideProjector("session");
      $("summary").hidden = false;
      $("sumText").textContent = S.course + " / " + S.room + ": Present " + (s.present | 0) + ", Flagged " + (s.flagged | 0) + ", Pending requests " + (s.pending | 0);
      msg("csvMsg", "");
    });
  }

  // ---------- requests ----------
  function loadRequests() {
    msg("reqMsg", "Loading…");
    A("att_requests", {}).then(function (r) {
      var box = $("reqList"); clear(box);
      if (!r.ok) return msg("reqMsg", "Could not load: " + (r.code || "error"), "err");
      var list = r.requests.filter(function (q) { return !q.status || q.status === "pending"; });
      msg("reqMsg", list.length ? "" : "No pending requests.");
      list.forEach(function (q) {
        var row = mk("div", null, "card"), top = mk("div", "ID " + q.student_id);
        top.style.fontWeight = "700";
        var hint = mk("div", q.fp_match ? "Fingerprint matches the registered device" : "Fingerprint differs from registered device", q.fp_match ? "hint-ok" : "hint-bad");
        var when = mk("div", q.created_at ? new Date(q.created_at).toLocaleTimeString("en-GB", { timeZone: CFG.TZ }) : "", "msg");
        var btns = mk("div", null, "row");
        var ok = mk("button", "Approve", "ok"), no = mk("button", "Deny", "bad");
        ok.onclick = function () { decide(q.req_id, "approve", btns); };
        no.onclick = function () { decide(q.req_id, "deny", btns); };
        btns.appendChild(ok); btns.appendChild(no);
        [top, hint, when, btns].forEach(function (x) { row.appendChild(x); });
        box.appendChild(row);
      });
    });
  }
  function decide(id, decision, btns) {
    Array.prototype.forEach.call(btns.children, function (b) { b.disabled = true; });
    A("att_decide_request", { req_id: id, decision: decision }).then(function (r) {
      if (!r.ok) { msg("reqMsg", "Failed: " + (r.code || "error"), "err"); }
      loadRequests(); poll();
    });
  }

  // ---------- flagged ----------
  function loadFlagged() {
    msg("flagMsg", "Loading...");
    A("att_flagged", S.sess ? { session_id: S.sess } : {}).then(function (r) {
      var box = $("flagList"); clear(box);
      if (!r.ok) return msg("flagMsg", "Could not load: " + (r.code || "error"), "err");
      // ASSUMPTION: rows are AttFlagLog rows {student_id, code,...} or AttCheckins rows {student_id, flags}. Aggregate per student.
      var by = {}, order = [];
      r.rows.forEach(function (x) {
        var id = String(x.student_id), o = by[id];
        if (!o) { o = by[id] = { n: 0, codes: {} }; order.push(id); }
        o.n++;
        (x.code ? [x.code] : String(x.flags || "").split(/[\s,;|]+/).filter(Boolean)).forEach(function (c) { o.codes[c] = (o.codes[c] || 0) + 1; });
      });
      msg("flagMsg", order.length ? "" : "Nothing flagged.");
      if (!order.length) return;
      var t = mk("table"), h = mk("tr");
      ["Student", "Flags", "Reasons"].forEach(function (x) { h.appendChild(mk("th", x)); }); t.appendChild(h);
      order.sort(function (a, b) { return by[b].n - by[a].n; }).forEach(function (id) {
        var tr = mk("tr"); tr.appendChild(mk("td", id)); tr.appendChild(mk("td", String(by[id].n)));
        var td = mk("td"); Object.keys(by[id].codes).forEach(function (c) { td.appendChild(mk("span", c + (by[id].codes[c] > 1 ? " x" + by[id].codes[c] : ""), "tag")); }); tr.appendChild(td); t.appendChild(tr);
      });
      box.appendChild(t);
    });
  }

  // ---------- CSV ----------
  function exportCSV() {
    A("att_export", { session_id: S.sess }).then(function (r) {
      if (!r.ok) return msg("csvMsg", "Export failed: " + (r.code || "error"), "err");
      var blob = new Blob(["\ufeff" + r.csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "attendance_" + (S.sess || "session") + ".csv"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      msg("csvMsg", "CSV exported.", "ok");
    });
  }

  // ---------- calibration ----------
  function calibrate() {
    var room = $("calRoom").value.trim();
    if (!room) return msg("calMsg", "Enter the room name.", "err");
    if (!navigator.geolocation) return msg("calMsg", "Location is not available on this device.", "err");
    var N = 10, got = [], tries = 0;
    $("calBtn").disabled = true;
    (function next() {
      if (got.length >= N || tries >= N + 6) return finish();
      tries++; msg("calMsg", "Reading " + (got.length + 1) + " of " + N + "…");
      navigator.geolocation.getCurrentPosition(function (p) {
        got.push({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp });
        setTimeout(next, 1000);
      }, function (e) {
        if (e && e.code === 1) { $("calBtn").disabled = false; return msg("calMsg", "Location permission denied.", "err"); }
        setTimeout(next, 1000);
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
    })();
    function finish() {
      if (got.length < 5) { $("calBtn").disabled = false; return msg("calMsg", "Only " + got.length + " usable readings. Try again outdoors/near a window.", "err"); }
      var accs = got.map(function (g) { return g.acc; }).sort(function (a, b) { return a - b; }), med = accs[Math.floor(accs.length / 2)];
      A("att_calibrate_room", { name: room, samples: got.map(function (g) { return { lat: g.lat, lng: g.lng, acc: g.acc }; }) }).then(function (r) {
        $("calBtn").disabled = false;
        if (!r.ok) return msg("calMsg", "Save failed: " + (r.code || "error"), "err");
        loadRooms();
        msg("calMsg", "Saved " + got.length + " readings for " + room + ". Median accuracy " + Math.round(med) + " m" + (med > CFG.GEO_WEAK_ACC_M ? " (weak: retry in a better spot)" : "") + ".", med > CFG.GEO_WEAK_ACC_M ? "err" : "ok");
      });
    }
  }

  // ---------- boot ----------
  function boot() {
    $("loginBtn").onclick = login;
    $("tok").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
    $("logout").onclick = function () { logout(""); };
    $("startBtn").onclick = startSession;
    $("resumeBtn").onclick = function () { if (S.sess) showProjector(); };
    $("closeBtn").onclick = closeSession;
    $("csvBtn").onclick = exportCSV;
    $("calBtn").onclick = calibrate;
    $("flagRefresh").onclick = loadFlagged;
    $("fsBtn").onclick = function () { var d = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : (d.requestFullscreen && d.requestFullscreen())); };
    $("reqBtn").onclick = function () { hideProjector("requests"); };
    $("hideBtn").onclick = function () { hideProjector("session"); };
    Array.prototype.forEach.call(document.querySelectorAll("nav [data-tab]"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
    window.addEventListener("resize", function () { S.win = -1; });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !$("proj").hidden) wake(); });
    if (DEBUG) T.selfTest().then(function (ok) { console.assert(ok, "TOKEN VECTOR MISMATCH (spec section 2)"); if (ok) console.log("token vector OK"); });
    var saved = ss("att_admin");
    if (saved) { $("tok").value = saved; login(); } else showLogin("");
  }
  boot();
})();
