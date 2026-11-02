/* ==========================================================================
   staff-guard.js — page-level role check for the dashboards (Phase 3 / S3, extended in Phase 4 / S7).

   CONVENIENCE ONLY. It decides where a signed-in account lands and which controls it sees; it is not a
   security boundary. Code.gs re-checks the caller on EVERY call, so a forged role in localStorage opens an
   empty page, never any data.

   Role keys used here:
     "admin"      the owner (is_admin)
     "teacher"    a teacher (kind "teacher", subjects from p4_session_scope)
     "sassistant" a SCOPED assistant (appointed by a teacher; the server returns principal_name)
     "assistant"  one of the owner's own assistants (unscoped, Phase 3)
     "student"    anyone else

   Usage (inside AuthEngine.mount's callback, once a session exists):
     StaffGuard.require(null, session).then(function (role) { if (role) start(session, role); });
     // null = use this page's entry in PAGES. An explicit list still works: it is expanded so that
     // listing "assistant" also lets scoped assistants and teachers in (the old ["admin","assistant"] pages).

   require() asks the server once. It calls p4_session_scope first; an old backend that does not know it
   falls back to p3_session_role, then to the cached role. It never blocks on a network error.
   After it resolves, StaffGuard.STATE = { kind, scope, principalName, role }.
   ========================================================================== */
(function () {
  "use strict";

  var ALL_STAFF = ["admin", "teacher", "assistant", "sassistant"];
  var WORK = ["admin", "teacher", "sassistant"];          // legacy owner-assistants are NOT let into these (unchanged)
  var PAGES = {
    "staff": ALL_STAFF,
    "followup": ALL_STAFF,
    "student-summary": ALL_STAFF,
    "grading": ALL_STAFF,
    "master": WORK,
    "access": WORK,
    "my-team": ["teacher"],
    "team": ["admin"],
    "teacher-stats": ["admin"],
    "wrong-questions": ["admin"]
  };
  var SESSION_KEY = "teaching_session";   // same key auth.js uses
  var HOME = "student.html";
  var STATE = { kind: "", scope: [], principalName: "", role: "" };

  function roleOf(session) {
    if (!session) return "none";
    if (session.is_admin) return "admin";
    if (session.role === "teacher") return "teacher";
    if (session.role === "assistant") return session.principal_name ? "sassistant" : "assistant";
    return session.role === "admin" ? "admin" : "student";
  }

  function pageName() {
    var m = /([^\/]+?)(?:\.html)?\/?$/.exec(location.pathname || "");
    return m ? m[1] : "";
  }

  // "assistant" in a list means every kind of assistant, and teachers share the staff pages.
  function expand(list) {
    var out = (list || []).slice();
    if (out.indexOf("assistant") !== -1) {
      ["sassistant", "teacher"].forEach(function (r) { if (out.indexOf(r) === -1) out.push(r); });
    }
    return out;
  }

  // Roles allowed on a page. Unknown page → owner only.
  function rolesFor(page) { return PAGES[page || pageName()] || ["admin"]; }

  // Sync check against the cached role.
  function allows(session, allowed) { return expand(allowed || rolesFor()).indexOf(roleOf(session)) !== -1; }

  function storeRole(session, role, extra) {
    var plain = role === "sassistant" ? "assistant" : role;
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (s) {
        s.role = plain;
        if (extra && extra.principalName) s.principal_name = extra.principalName; else delete s.principal_name;
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      }
    } catch (e) { /* storage unavailable: the role is just re-fetched next page */ }
    if (session) {
      session.role = plain;
      if (extra && extra.principalName) session.principal_name = extra.principalName; else delete session.principal_name;
    }
  }

  function setState(role, kind, scope, principalName) {
    STATE.role = role; STATE.kind = kind || ""; STATE.scope = Array.isArray(scope) ? scope.slice() : [];
    STATE.principalName = principalName || "";
  }

  function fromScope(r) {
    if (!r || r.ok === false) return null;
    var kind = r.kind;
    if (kind === "owner") return { role: "admin", kind: kind, scope: r.scope, principalName: "" };
    if (kind === "teacher") return { role: "teacher", kind: kind, scope: r.scope, principalName: "" };
    if (kind === "assistant") {
      var pn = r.principal_name ? String(r.principal_name) : "";
      return { role: pn ? "sassistant" : "assistant", kind: kind, scope: r.scope, principalName: pn };
    }
    if (kind === "student") return { role: "student", kind: kind, scope: [], principalName: "" };
    return null;
  }

  // Asks the server who this session is. Resolves a role key, or null when the answer is unusable
  // (offline, stale/none session).
  function refresh(session) {
    var A = window.AuthEngine;
    if (!session || !session.session_token || !A || typeof A.adminCall !== "function") return Promise.resolve(null);
    function legacy() {
      return A.adminCall(session, { action: "p3_session_role" }).then(function (r) {
        var role = r && r.ok !== false ? r.role : null;
        if (role === "admin" || role === "assistant" || role === "student") {
          storeRole(session, role); setState(role, role === "admin" ? "owner" : role, role === "admin" ? ["*"] : [], "");
          return role;
        }
        return null;
      }, function () { return null; });
    }
    return A.adminCall(session, { action: "p4_session_scope" }).then(function (r) {
      var got = fromScope(r);
      if (!got) return legacy();                       // old backend: the action is unknown, behave as before
      storeRole(session, got.role, got); setState(got.role, got.kind, got.scope, got.principalName);
      return got.role;
    }, function () { return legacy(); });
  }

  // Resolves the effective role when allowed, or null after redirecting to student.html.
  function require(allowed, session, opts) {
    opts = opts || {};
    var list = expand(allowed || rolesFor());
    session = session || (window.AuthEngine && window.AuthEngine.getSession && window.AuthEngine.getSession());
    var cached = roleOf(session);
    var go = function () { if (opts.redirect !== false) location.href = opts.home || HOME; return null; };
    if (!session) return Promise.resolve(go());
    return refresh(session).then(function (serverRole) {
      var role = serverRole || cached;
      if (!serverRole) setState(role, role === "admin" ? "owner" : role === "sassistant" ? "assistant" : role, [], session.principal_name || "");
      return list.indexOf(role) !== -1 ? role : go();
    });
  }

  // data-owner-only: hidden unless the owner. data-hide-assistant: hidden for every assistant.
  // data-teacher-only: shown only to a teacher. data-no-assistant is an alias of data-hide-assistant.
  function applyVisibility(root, role) {
    role = role || STATE.role;
    root = root || document;
    var q = function (sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
    var hide = function (n) { n.style.display = "none"; n.setAttribute("data-staff-hidden", "1"); };
    if (role !== "admin") q("[data-owner-only]").forEach(hide);
    if (role === "assistant" || role === "sassistant") { q("[data-hide-assistant]").forEach(hide); q("[data-no-assistant]").forEach(hide); }
    if (role !== "teacher") q("[data-teacher-only]").forEach(hide);
  }

  // A one-line badge such as "Teacher · math" or "Assistant of Mona · math". Text only.
  function scopeBadge(node) {
    if (!node) return;
    var scope = STATE.scope.filter(function (s) { return s !== "*"; }).join(", ");
    var text = "";
    if (STATE.role === "teacher") text = "Teacher" + (scope ? " · " + scope : "");
    else if (STATE.role === "sassistant") text = "Assistant of " + (STATE.principalName || "your teacher") + (scope ? " · " + scope : "");
    node.textContent = text;
    node.hidden = !text;
  }

  window.StaffGuard = {
    require: require, allows: allows, refresh: refresh, roleOf: roleOf, rolesFor: rolesFor, PAGES: PAGES,
    STATE: STATE, applyVisibility: applyVisibility, scopeBadge: scopeBadge,
    isOwner: function () { return STATE.role === "admin"; },
    isTeacher: function () { return STATE.role === "teacher"; },
    isAssistant: function () { return STATE.role === "assistant" || STATE.role === "sassistant"; }
  };
})();
