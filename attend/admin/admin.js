(function () {
  "use strict";
  var CFG = window.ATT_CONFIG, api = window.attApi, T = window.ATT_TOKEN;
  var BASE = "https://teaching.ezznasr.dev/attend/";   // QR target (spec)
  var DEBUG = /[?&]debug=1/.test(location.search);
  // Mock (with admin extension) until a real API_URL is set in att_config.js.
  if (/^REPLACE_/.test(CFG.API_URL)) window.ATT_FETCH = window.attMockExt || window.attMockFetch;

  var $ = function (i) { return document.getElementById(i); };
  var S = { tok: null, user: null, role: "teacher", sess: null, key: null, closeMs: 0, offset: 0, win: -1, liveTimer: null, tickTimer: null, syncTimer: null, roomId: "", closed: false, course: "", room: "", wake: null };

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
      // Only a rejected/disabled account signs the user out. FORBIDDEN (a teacher calling an admin action) must not.
      if (!r.ok && (r.code === "UNAUTHORIZED" || r.code === "USER_DISABLED")) { logout(r.code === "USER_DISABLED" ? "This account is disabled." : "Session expired. Sign in again."); }
      return r;
    });
  }

  // ---------- login ----------
  // One box: a teacher password OR the admin token. We ask att_me first (it never counts as a failed login), and only if the
  // server says the value is not a valid token do we try it as a password (att_login: wrong ones count toward the global lock-out).
  function showLogin(text) { $("panel").hidden = true; $("proj").hidden = true; $("login").hidden = false; $("loginBtn").disabled = false; msg("loginMsg", text, text ? "err" : ""); }
  function enter(user, tok) {
    S.tok = tok; S.user = user; S.role = user.role === "admin" ? "admin" : "teacher";
    ss("att_admin", tok); $("tok").value = ""; $("loginBtn").disabled = false; msg("loginMsg", "");
    $("login").hidden = true; $("panel").hidden = false;
    initPanel();
  }
  function login(saved) {
    var t = saved || $("tok").value.trim();
    if (!t) return msg("loginMsg", "Enter your password or the admin token.", "err");
    msg("loginMsg", "Checking\u2026"); $("loginBtn").disabled = true;
    function fail(text) { S.tok = null; if (saved) ss("att_admin", null); showLogin(text); }
    api.call("att_me", { token: t }).then(function (r) {
      if (r.ok) return enter(r.user, t);
      if (r.code === "NETWORK") return fail("No connection.");
      if (r.code === "USER_DISABLED") return fail("This account is disabled.");
      if (saved) return fail("");   // a stale saved token is never sent to att_login as a password
      return api.call("att_login", { password: t }).then(function (l) {
        if (l.ok) return enter(l.user, l.token);
        fail(l.code === "NETWORK" ? "No connection." : l.code === "LOCKED" ? (l.error || "Too many attempts. Wait a few minutes.") : l.code === "USER_DISABLED" ? "This account is disabled." : "Wrong password or token.");
      });
    });
  }
  function logout(text) {
    stopSession(); S.tok = null; S.user = null; S.sess = null; H.items = []; H.cursor = null; H.sel = null; ss("att_admin", null);
    $("secret").hidden = true; $("secretPw").textContent = "";
    showLogin(typeof text === "string" ? text : "");
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
    var adm = S.role === "admin";
    $("who").textContent = adm ? "Signed in as Admin \u00b7 sees every teacher" : (S.user && S.user.name ? S.user.name : "") + " \u00b7 Teacher \u00b7 sees only your own sessions";
    $("tabOverview").hidden = !adm; $("tabUsers").hidden = !adm; $("hisUserWrap").hidden = !adm;
    loadRooms(); tab("session");
  }
  function tab(name) {
    if ((name === "users" || name === "overview") && S.role !== "admin") name = "session";   // the server refuses these anyway
    ["session", "requests", "flagged", "roster", "calib", "history", "overview", "users"].forEach(function (n) { $("t-" + n).hidden = n !== name; });
    Array.prototype.forEach.call(document.querySelectorAll("nav [data-tab]"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
    if (name === "requests") loadRequests();
    if (name === "flagged") loadFlagged();
    if (name === "roster") loadRoster();
    if (name === "history") { showHisList(); fillHisUsers().then(function () { loadHistory(true); }); }
    if (name === "overview") loadOverview();
    if (name === "users") loadUsers();
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
    var px = Math.min(window.innerWidth * 0.9, window.innerHeight * 0.44);
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
      renderFeed(r.feed || []);
      var p = r.pending | 0;
      ["pBadge", "pendBadge"].forEach(function (id) { $(id).hidden = !p; $(id).textContent = p; });
    });
  }
  // Activity feed: registered = yellow, attended = green, attempted cheating = red (server sends only first letter + last 2 digits).
  var fTimeS = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  function renderFeed(list) {
    ["pfeed", "sfeed"].forEach(function (id) {
      var box = $(id); if (!box) return; clear(box);
      if (!list.length) { if (id === "sfeed") box.appendChild(mk("div", "No activity yet.", "msg")); return; }
      list.forEach(function (e) {
        var d = new Date(e.t), when = isNaN(d) ? "" : fTimeS.format(d), row, text;
        if (e.k === "bad") { row = mk("div", null, "ev ev-bad"); text = "Attempted cheating detected and flagged \u00b7 " + (e.l || "?") + " \u00b7 ID \u2022\u2022" + (e.d || ""); }
        else if (e.k === "reg") { row = mk("div", null, "ev ev-reg"); text = "Registered \u00b7 " + (e.n || "(no name)") + " \u00b7 " + e.id; }
        else { row = mk("div", null, "ev ev-att"); text = "Attended \u00b7 " + (e.n || "(no name)") + " \u00b7 " + e.id; }
        row.appendChild(mk("time", when)); row.appendChild(mk("span", text)); box.appendChild(row);
      });
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

  // ---------- roster: every student x every lecture ----------
  var R = { d: null };
  var fDay = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, weekday: "short", day: "2-digit", month: "short" });
  var fDate = new Intl.DateTimeFormat("en-CA", { timeZone: CFG.TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  var fTime = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  function loadRoster() {
    msg("rosMsg", "Loading...");
    // Always fetch plenty of sessions; "show last N" is applied after same-day sessions are merged into one lecture.
    A("att_roster", { course: $("rosCourse").value, limit: 200 }).then(function (r) {
      if (!r.ok) return msg("rosMsg", "Could not load: " + (r.code || "error"), "err");
      R.d = r;
      var sel = $("rosCourse"), keep = sel.value; clear(sel);
      var all = mk("option", "All courses"); all.value = ""; sel.appendChild(all);
      (r.courses || []).forEach(function (c) { var o = mk("option", c); o.value = c; sel.appendChild(o); });
      sel.value = keep;
      renderRoster();
    });
  }
  // One lecture = one course on one (Cairo) day, however many sessions were started for it.
  function rosterModel() {
    var d = R.d, q = $("rosSearch").value.trim().toLowerCase(), lim = Number($("rosLimit").value) || 30;
    var groups = [], idx = {};
    d.sessions.forEach(function (x) {
      var k = (x.course || "") + "|" + fDate.format(new Date(x.start_utc));
      if (!(k in idx)) { idx[k] = groups.length; groups.push({ start_utc: x.start_utc, course: x.course, ids: {} }); }
      groups[idx[k]].ids[x.session_id] = 1;
    });
    groups = groups.slice(-lim);
    var gOf = {}; groups.forEach(function (g, i) { Object.keys(g.ids).forEach(function (id) { gOf[id] = i; }); });
    var here = {}; // "groupIndex|studentId" -> attended
    d.marks.forEach(function (m) { if (m[0] in gOf) here[gOf[m[0]] + "|" + m[1]] = true; });
    var rows = d.students.filter(function (s) { return !q || String(s.student_id).toLowerCase().indexOf(q) >= 0 || String(s.name || "").toLowerCase().indexOf(q) >= 0; })
      .map(function (s) {
        var cells = groups.map(function (g, i) { return !!here[i + "|" + s.student_id]; });
        var n = cells.filter(Boolean).length;
        return { id: s.student_id, name: s.name || "", cells: cells, n: n, pct: groups.length ? Math.round(100 * n / groups.length) : 0 };
      }).sort(function (a, b) { return (a.name || "\uffff").localeCompare(b.name || "\uffff") || String(a.id).localeCompare(String(b.id)); });
    return { sessions: groups, rows: rows };
  }
  function renderRoster() {
    var box = $("rosTable"); clear(box);
    var m = rosterModel();
    msg("rosMsg", m.rows.length + " student" + (m.rows.length === 1 ? "" : "s") + " \u00b7 " + m.sessions.length + " lecture" + (m.sessions.length === 1 ? "" : "s"));
    if (!m.rows.length) return;
    var t = mk("table", null, "ros"), h = mk("tr");
    h.appendChild(mk("th", "Student", "l")); h.appendChild(mk("th", "Present")); h.appendChild(mk("th", "%"));
    m.sessions.forEach(function (x) {
      var th = mk("th", fDay.format(new Date(x.start_utc))); th.appendChild(mk("small", x.course || "")); h.appendChild(th);
    });
    t.appendChild(h);
    m.rows.forEach(function (r) {
      var tr = mk("tr"), td0 = mk("td", null, "l");
      td0.appendChild(mk("b", r.name || "(no name)")); td0.appendChild(mk("small", String(r.id))); tr.appendChild(td0);
      tr.appendChild(mk("td", r.n + " / " + m.sessions.length)); tr.appendChild(mk("td", r.pct + "%"));
      r.cells.forEach(function (c) { tr.appendChild(c ? mk("td", "\u2713", "pre") : mk("td", "\u2013", "abs")); });
      t.appendChild(tr);
    });
    box.appendChild(t);
  }
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportRoster() {
    if (!R.d) return msg("rosMsg", "Nothing loaded yet.", "err");
    var m = rosterModel();
    var head = ["student_id", "name", "present", "total", "percent"].concat(m.sessions.map(function (x) { return fDate.format(new Date(x.start_utc)) + " " + (x.course || ""); }));
    var lines = [head.map(csvCell).join(",")];
    m.rows.forEach(function (r) {
      lines.push([r.id, r.name, r.n, m.sessions.length, r.pct].concat(r.cells.map(function (c) { return c ? "Present" : "Absent"; })).map(csvCell).join(","));
    });
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "roster_" + fDate.format(new Date()) + ".csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    msg("rosMsg", "Roster exported.", "ok");
  }

  // ---------- CSV ----------
  function exportCSV(sid, msgId) {
    sid = typeof sid === "string" ? sid : S.sess; msgId = msgId || "csvMsg";
    A("att_export", { session_id: sid }).then(function (r) {
      if (!r.ok) return msg(msgId, "Export failed: " + (r.code || "error"), "err");
      var blob = new Blob(["\ufeff" + r.csv], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = "attendance_" + (sid || "session") + ".csv"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      msg(msgId, "CSV exported.", "ok");
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

  // ---------- history: past sessions, per-session check-ins, accept / reject ----------
  var H = { items: [], cursor: null, sel: null, rows: [], users: null };
  var fWhen = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.TZ, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  function when(iso) { var d = new Date(iso); return isNaN(d) ? "" : fWhen.format(d); }
  var WARN = { GEO_UNAVAILABLE: 1, GEO_SKIPPED: 1, GEO_WEAK: 1, GEO_UPGRADED: 1 };
  function tagFor(code) { return mk("span", code, "tag " + (WARN[code] ? "warn" : "bad")); }
  function geoTags(g) { var td = mk("td"); Object.keys(g || {}).forEach(function (k) { if (g[k]) td.appendChild(mk("span", k.replace("GEO_", "") + " " + g[k], "tag " + (WARN[k] ? "warn" : "bad"))); }); return td; }
  function showHisList() { $("hisList").hidden = false; $("hisDetail").hidden = true; H.sel = null; }
  function fillHisUsers() {
    if (S.role !== "admin" || H.users) return Promise.resolve();
    return A("att_users", {}).then(function (r) {
      if (!r.ok) return;
      H.users = r.users; var sel = $("hisUser"), keep = sel.value;
      var a = mk("option", "Admin (legacy sessions)"); a.value = "ADMIN"; sel.appendChild(a);
      r.users.forEach(function (u) { var o = mk("option", u.name + (u.status === "active" ? "" : " (disabled)")); o.value = u.user_id; sel.appendChild(o); });
      sel.value = keep;
    });
  }
  function loadHistory(reset) {
    if (reset) { H.items = []; H.cursor = null; }
    msg("hisMsg", "Loading…");
    var p = { limit: 30 };
    if (H.cursor) p.cursor = H.cursor;
    if ($("hisCourse").value.trim()) p.course = $("hisCourse").value.trim();
    if ($("hisFrom").value) p.from = $("hisFrom").value;
    if ($("hisTo").value) p.to = $("hisTo").value;
    if (S.role === "admin" && $("hisUser").value) p.user_id = $("hisUser").value;
    A("att_sessions", p).then(function (r) {
      if (!r.ok) return msg("hisMsg", "Could not load: " + (r.error || r.code || "error"), "err");
      H.items = H.items.concat(r.sessions || []); H.cursor = r.next_cursor || null;
      $("hisMore").hidden = !H.cursor;
      msg("hisMsg", H.items.length ? H.items.length + " session" + (H.items.length === 1 ? "" : "s") + (H.cursor ? " shown (more available)" : "") : "No sessions match.");
      renderHistory();
    });
  }
  function renderHistory() {
    var box = $("hisTable"); clear(box);
    if (!H.items.length) return;
    var adm = S.role === "admin", t = mk("table", null, "his"), h = mk("tr");
    ["When", "Course", "Room"].concat(adm ? ["Teacher"] : []).concat(["Present", "Flagged", "To review", "Location problems", ""]).forEach(function (x) { h.appendChild(mk("th", x)); });
    t.appendChild(h);
    H.items.forEach(function (x) {
      var tr = mk("tr");
      tr.appendChild(mk("td", when(x.start_utc))); tr.appendChild(mk("td", x.course || "")); tr.appendChild(mk("td", x.room_name || ""));
      if (adm) tr.appendChild(mk("td", x.owner_name || x.owner_user_id || ""));
      tr.appendChild(mk("td", String(x.present | 0), "n")); tr.appendChild(mk("td", String(x.flagged | 0), "n")); tr.appendChild(mk("td", String(x.unreviewed | 0), "n"));
      tr.appendChild(geoTags(x.geo));
      var td = mk("td"), b = mk("button", "Open"); b.onclick = function () { openDetail(x.session_id); }; td.appendChild(b); tr.appendChild(td);
      t.appendChild(tr);
    });
    box.appendChild(t);
  }
  function openDetail(id) {
    $("hisList").hidden = true; $("hisDetail").hidden = false; H.sel = id; H.rows = [];
    $("detTitle").textContent = "Loading…"; $("detSummary").textContent = ""; clear($("detTable")); msg("detMsg", "");
    A("att_session_detail", { session_id: id }).then(function (r) {
      if (!r.ok) { msg("detMsg", "Could not load: " + (r.error || r.code || "error"), "err"); $("detTitle").textContent = "Session"; return; }
      var s = r.session, t = r.summary || {};
      H.rows = r.checkins || [];
      $("detTitle").textContent = (s.course || "") + " · " + (s.room_name || "") + " · " + when(s.start_utc) + (S.role === "admin" ? " · " + (s.owner_name || s.owner_user_id || "") : "");
      $("detSummary").textContent = "Present " + (t.present | 0) + " · Flagged " + (t.flagged | 0) + " · Still to review " + (t.unreviewed | 0);
      renderDetail();
    });
  }
  function renderDetail() {
    var box = $("detTable"); clear(box);
    var only = $("detFlagOnly").checked, list = H.rows.filter(function (r) { return !only || r.flags; });
    if (!list.length) return msg("detMsg", H.rows.length ? "No flagged check-ins." : "No check-ins in this session.");
    msg("detMsg", list.length + " check-in" + (list.length === 1 ? "" : "s"));
    var t = mk("table", null, "his"), h = mk("tr");
    ["Time", "Student", "Flags", "Distance", "Accuracy", "Location", "Review", "Decision"].forEach(function (x) { h.appendChild(mk("th", x)); });
    t.appendChild(h);
    list.forEach(function (r) {
      var tr = mk("tr", null, r.review_status === "rejected" ? "rej" : "");
      tr.appendChild(mk("td", when(r.server_utc)));
      var s = mk("td"); s.appendChild(mk("b", r.name || "(no name)")); s.appendChild(mk("div", String(r.student_id), "msg")); tr.appendChild(s);
      var f = mk("td"); String(r.flags || "").split(/[\s,;|]+/).filter(Boolean).forEach(function (c) { f.appendChild(tagFor(c)); }); tr.appendChild(f);
      tr.appendChild(mk("td", r.dist_m == null ? "" : Math.round(r.dist_m) + " m", "n")); tr.appendChild(mk("td", r.acc == null ? "" : Math.round(r.acc) + " m", "n"));
      tr.appendChild(mk("td", r.geo_reason || ""));
      var rv = mk("td");
      if (r.review_status) { rv.appendChild(mk("span", r.review_status, "tag " + (r.review_status === "accepted" ? "good" : "bad"))); if (r.review_note) rv.appendChild(mk("div", r.review_note, "msg")); if (r.reviewed_by_name || r.reviewed_at) rv.appendChild(mk("div", (r.reviewed_by_name || "") + (r.reviewed_at ? " · " + when(r.reviewed_at) : ""), "msg")); }
      else rv.appendChild(mk("span", r.flags ? "to review" : "", "msg"));
      tr.appendChild(rv);
      var d = mk("td", null, "dec"), note = mk("input", null, "note"); note.setAttribute("placeholder", "note (optional)"); note.value = r.review_note || "";
      var ok = mk("button", "Accept", "ok"), no = mk("button", "Reject", "bad");
      ok.onclick = function () { review(r, "accepted", note, [ok, no]); }; no.onclick = function () { review(r, "rejected", note, [ok, no]); };
      d.appendChild(note); d.appendChild(ok); d.appendChild(no); tr.appendChild(d);
      t.appendChild(tr);
    });
    box.appendChild(t);
  }
  function review(r, decision, noteEl, btns) {
    btns.forEach(function (b) { b.disabled = true; });
    A("att_review", { checkin_id: r.checkin_id, decision: decision, note: noteEl.value }).then(function (x) {
      if (!x.ok) { btns.forEach(function (b) { b.disabled = false; }); return msg("detMsg", "Could not save: " + (x.error || x.code || "error"), "err"); }
      r.review_status = x.review_status; r.review_note = x.review_note; r.reviewed_by = x.reviewed_by; r.reviewed_by_name = x.reviewed_by_name; r.reviewed_at = x.reviewed_at;
      renderDetail(); msg("detMsg", "Saved: " + r.student_id + " " + decision + ".", "ok");
    });
  }

  // ---------- admin: all sessions overview ----------
  function geoLine(g) { return Object.keys(g || {}).filter(function (k) { return g[k]; }).map(function (k) { return k.replace("GEO_", "") + " " + g[k]; }).join(" · "); }
  function loadOverview() {
    msg("ovMsg", "Loading…");
    var p = {}; if ($("ovFrom").value) p.from = $("ovFrom").value; if ($("ovTo").value) p.to = $("ovTo").value;
    A("att_overview", p).then(function (r) {
      if (!r.ok) return msg("ovMsg", "Could not load: " + (r.error || r.code || "error"), "err");
      msg("ovMsg", "");
      var tot = r.totals || {}, box = $("ovTotals"); clear(box);
      [["Sessions", tot.sessions], ["Present", tot.present], ["Flagged", tot.flagged], ["To review", tot.unreviewed]].forEach(function (x) {
        var c = mk("div", null, "stat"); c.appendChild(mk("b", String(x[1] | 0))); c.appendChild(mk("span", x[0])); box.appendChild(c);
      });
      var gl = geoLine(tot.geo); if (gl) box.appendChild(mk("div", "Location problems: " + gl, "msg"));
      ovTable($("ovUsers"), r.by_user || [], "Teacher", function (b) { return b.name + (b.status === "active" ? "" : " (disabled)"); }, function (b) { openHistory({ user: b.user_id }); });
      ovTable($("ovDays"), r.by_day || [], "Day (UTC)", function (b) { return b.day; }, function (b) { openHistory({ from: b.day, to: b.day }); });
    });
  }
  function ovTable(box, rows, first, label, open) {
    clear(box);
    if (!rows.length) return box.appendChild(mk("div", "Nothing in this range.", "msg"));
    var t = mk("table", null, "his"), h = mk("tr");
    [first, "Sessions", "Present", "Flagged", "To review", "Location problems", ""].forEach(function (x) { h.appendChild(mk("th", x)); }); t.appendChild(h);
    rows.forEach(function (b) {
      var tr = mk("tr"); tr.appendChild(mk("td", label(b)));
      [b.sessions, b.present, b.flagged, b.unreviewed].forEach(function (n) { tr.appendChild(mk("td", String(n | 0), "n")); });
      tr.appendChild(geoTags(b.geo));
      var td = mk("td"), btn = mk("button", "Sessions"); btn.onclick = function () { open(b); }; td.appendChild(btn); tr.appendChild(td); t.appendChild(tr);
    });
    box.appendChild(t);
  }
  function openHistory(f) {
    $("hisUser").value = f.user || ""; $("hisFrom").value = f.from || ""; $("hisTo").value = f.to || ""; $("hisCourse").value = "";
    tab("history");
  }

  // ---------- admin: teacher accounts ----------
  function loadUsers() {
    msg("userMsg", "Loading…");
    A("att_users", {}).then(function (r) {
      if (!r.ok) return msg("userMsg", "Could not load: " + (r.error || r.code || "error"), "err");
      msg("userMsg", r.users.length ? "" : "No teacher accounts yet. Create the first one above.");
      H.users = null;   // history's teacher filter is rebuilt next time
      var box = $("userList"); clear(box);
      if (!r.users.length) return;
      var t = mk("table", null, "his"), h = mk("tr");
      ["Name", "Status", "Created", "Last login", ""].forEach(function (x) { h.appendChild(mk("th", x)); }); t.appendChild(h);
      r.users.forEach(function (u) {
        var on = u.status === "active", tr = mk("tr");
        tr.appendChild(mk("td", u.name)); tr.appendChild(mk("td", on ? "active" : "disabled", on ? "" : "pill-off"));
        tr.appendChild(mk("td", when(u.created_at))); tr.appendChild(mk("td", u.last_login ? when(u.last_login) : "never"));
        var td = mk("td"), ren = mk("button", "Rename"), tog = mk("button", on ? "Disable" : "Enable", on ? "bad" : "ok"), rst = mk("button", "Reset password");
        ren.onclick = function () { var n = prompt("New name for " + u.name, u.name); if (n && n.trim() && n.trim() !== u.name) userCall("att_user_update", { user_id: u.user_id, name: n.trim() }); };
        tog.onclick = function () { if (!on || confirm("Disable " + u.name + "? They are signed out within a minute.")) userCall("att_user_update", { user_id: u.user_id, status: on ? "disabled" : "active" }); };
        rst.onclick = function () { if (confirm("Reset the password of " + u.name + "? Their current password and sessions stop working.")) userCall("att_user_reset", { user_id: u.user_id }, "Password reset"); };
        [ren, tog, rst].forEach(function (b) { td.appendChild(b); }); tr.appendChild(td); t.appendChild(tr);
      });
      box.appendChild(t);
    });
  }
  function userCall(action, payload, what) {
    A(action, payload).then(function (r) {
      if (!r.ok) return msg("userMsg", "Failed: " + (r.error || r.code || "error"), "err");
      if (r.password) showSecret(r.user.name, r.password, what || "Account created");
      else msg("userMsg", "Saved.", "ok");
      loadUsers();
    });
  }
  function showSecret(name, pw, what) {
    $("secretWho").textContent = what + " — " + name; $("secretPw").textContent = pw; $("secret").hidden = false;
    msg("userMsg", "");
  }
  function createUser() {
    var n = $("userName").value.trim();
    if (n.length < 2) return msg("userMsg", "Enter the teacher's name.", "err");
    $("userCreate").disabled = true;
    A("att_user_create", { name: n }).then(function (r) {
      $("userCreate").disabled = false;
      if (!r.ok) return msg("userMsg", "Failed: " + (r.error || r.code || "error"), "err");
      $("userName").value = ""; showSecret(r.user.name, r.password, "Account created"); loadUsers();
    });
  }
  function copySecret() {
    var pw = $("secretPw").textContent;
    function done(ok) { msg("userMsg", ok ? "Password copied." : "Could not copy: select it and copy by hand.", ok ? "ok" : "err"); }
    try { navigator.clipboard.writeText(pw).then(function () { done(true); }, function () { done(false); }); } catch (e) { done(false); }
  }

  // ---------- boot ----------
  function boot() {
    $("loginBtn").onclick = function () { login(); };
    $("tok").addEventListener("keydown", function (e) { if (e.key === "Enter") login(); });
    $("hisGo").onclick = function () { showHisList(); loadHistory(true); };
    $("hisReset").onclick = function () { $("hisCourse").value = ""; $("hisFrom").value = ""; $("hisTo").value = ""; $("hisUser").value = ""; showHisList(); loadHistory(true); };
    $("hisMore").onclick = function () { loadHistory(false); };
    $("hisBack").onclick = function () { showHisList(); };
    $("detCsv").onclick = function () { if (H.sel) exportCSV(H.sel, "detMsg"); };
    $("detFlagOnly").addEventListener("change", renderDetail);
    $("ovGo").onclick = loadOverview;
    $("userCreate").onclick = createUser;
    $("userName").addEventListener("keydown", function (e) { if (e.key === "Enter") createUser(); });
    $("secretCopy").onclick = copySecret;
    $("secretDone").onclick = function () { $("secret").hidden = true; $("secretPw").textContent = ""; };
    $("logout").onclick = function () { logout(""); };
    $("startBtn").onclick = startSession;
    $("resumeBtn").onclick = function () { if (S.sess) showProjector(); };
    $("closeBtn").onclick = closeSession;
    $("csvBtn").onclick = function () { exportCSV(); };
    $("calBtn").onclick = calibrate;
    $("flagRefresh").onclick = loadFlagged;
    $("rosRefresh").onclick = loadRoster;
    $("rosCsv").onclick = exportRoster;
    $("rosCourse").onchange = loadRoster;
    $("rosLimit").onchange = function () { if (R.d) renderRoster(); else loadRoster(); };
    $("rosSearch").addEventListener("input", function () { if (R.d) renderRoster(); });
    $("fsBtn").onclick = function () { var d = document.documentElement; (document.fullscreenElement ? document.exitFullscreen() : (d.requestFullscreen && d.requestFullscreen())); };
    $("reqBtn").onclick = function () { hideProjector("requests"); };
    $("hideBtn").onclick = function () { hideProjector("session"); };
    Array.prototype.forEach.call(document.querySelectorAll("nav [data-tab]"), function (b) { b.onclick = function () { tab(b.getAttribute("data-tab")); }; });
    window.addEventListener("resize", function () { S.win = -1; });
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !$("proj").hidden) wake(); });
    if (DEBUG) T.selfTest().then(function (ok) { console.assert(ok, "TOKEN VECTOR MISMATCH (spec section 2)"); if (ok) console.log("token vector OK"); });
    var saved = ss("att_admin");
    if (saved) login(saved); else showLogin("");
  }
  boot();
})();
