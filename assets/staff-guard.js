/* ==========================================================================
   staff-guard.js — page-level role check for the dashboards (Phase 3 / S3).

   CONVENIENCE ONLY. It decides where a signed-in account lands; it is not a
   security boundary. Code.gs re-checks the role on EVERY call (admins: all
   actions; assistants: only the staff allow-list; everyone else: nothing),
   so a forged role in localStorage opens an empty page, never any data.

   Roles come from auth.js: session.role is "admin" | "assistant" | "student".
   An assistant has is_admin === false, so pages must NOT test is_admin alone.

   Usage (inside AuthEngine.mount's callback, once a session exists):

     StaffGuard.require(["admin", "assistant"], session).then(function (role) {
       if (!role) return;          // redirected to student.html
       start(session, role);       // role: "admin" | "assistant"
     });

   Which roles each page needs (see PAGES): staff pages = admin + assistant,
   admin-only pages = admin. An unknown page defaults to admin-only.

   require() first trusts the cached role, then asks the server once
   (p3_session_role) so an account promoted or demoted since its last login is
   treated correctly. If the server can't be reached it falls back to the
   cached role and never blocks.
   ========================================================================== */
(function () {
  "use strict";

  var STAFF = ["admin", "assistant"];
  var ADMIN = ["admin"];
  var PAGES = {
    "followup": STAFF,
    "student-summary": STAFF,
    "grading": STAFF,
    "master": ADMIN,
    "access": ADMIN,
    "wrong-questions": ADMIN,
    "team": ADMIN,
  };
  var SESSION_KEY = "teaching_session";   // same key auth.js uses
  var HOME = "student.html";

  function roleOf(session) {
    if (!session) return "none";
    if (session.is_admin) return "admin";
    return session.role === "assistant" || session.role === "admin" ? session.role : "student";
  }

  function pageName() {
    var m = /([^\/]+?)(?:\.html)?\/?$/.exec(location.pathname || "");
    return m ? m[1] : "";
  }

  // Roles allowed on a page. Unknown page → admin only.
  function rolesFor(page) {
    return PAGES[page || pageName()] || ADMIN;
  }

  // Sync check against the cached role. Drop-in for the old `session.is_admin === false` test:
  //   if (!StaffGuard.allows(session, ["admin","assistant"])) { location.href = "student.html"; return; }
  function allows(session, allowed) {
    return (allowed || rolesFor()).indexOf(roleOf(session)) !== -1;
  }

  function storeRole(session, role) {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      if (s && s.role !== role) { s.role = role; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
    } catch (e) { /* storage unavailable: the role is just re-fetched next page */ }
    if (session) session.role = role;
  }

  // Asks the server who this session is. Resolves "admin" | "assistant" | "student", or null when the
  // answer is unusable (offline, old backend without the action, stale/none session).
  function refresh(session) {
    var A = window.AuthEngine;
    if (!session || !session.session_token || !A || typeof A.adminCall !== "function") return Promise.resolve(null);
    return A.adminCall(session, { action: "p3_session_role" }).then(function (r) {
      var role = r && r.ok !== false ? r.role : null;
      if (role === "admin" || role === "assistant" || role === "student") { storeRole(session, role); return role; }
      return null;
    }, function () { return null; });
  }

  // Resolves the effective role when allowed, or null after redirecting to student.html.
  function require(allowed, session, opts) {
    opts = opts || {};
    allowed = allowed || rolesFor();
    session = session || (window.AuthEngine && window.AuthEngine.getSession && window.AuthEngine.getSession());
    var cached = roleOf(session);
    var go = function () { if (opts.redirect !== false) location.href = opts.home || HOME; return null; };
    if (!session) return Promise.resolve(go());
    // Cached role is enough to let someone IN straight away only when the server agrees; otherwise ask.
    return refresh(session).then(function (serverRole) {
      var role = serverRole || cached;
      return allowed.indexOf(role) !== -1 ? role : go();
    });
  }

  window.StaffGuard = { require: require, allows: allows, refresh: refresh, roleOf: roleOf, rolesFor: rolesFor, PAGES: PAGES };
})();
