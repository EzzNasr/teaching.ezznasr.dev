/* ==========================================================================
   auth.js — phone+password student identity for teaching.ezznasr.dev

   Backed by Code.gs's "check_student" / "register_student" / "login_student"
   actions and a Students Google Sheet (phone | password_hash | display_name
   | created_at). The password itself never leaves the browser — only a
   SHA-256 hash of it does (crypto.subtle.digest). The server just compares
   hashes; it never sees the plaintext.

   Session — { student_id, student_name } — is cached in localStorage under
   "teaching_session" so a returning student on the same device/browser
   skips straight past this gate on their next quiz/assignment.

   Two independent things happen here:

   1. AuthEngine.mount(rootSelector, onReady) — the phone -> login/register
      GATE. Only relevant on pages that actually need to know who's
      answering (quiz.html, assignment.html). Renders into rootSelector
      while signed out; once signed in, calls onReady(session) and leaves
      rootSelector alone (the caller's own engine takes over from there).

   2. The global corner widget — a small "Signed in as X" pill with a
      Log out menu, fixed to the bottom-right corner. This auto-mounts
      itself on ANY page that simply loads this script, independent of
      whether mount() above is used on that page at all. It renders
      nothing when signed out — it's a status/logout affordance, never a
      login prompt. This is what makes sign-in state visible and gives a
      way to log out from every page on the site (lesson pages, subject
      pages, home), not just quiz/assignment pages. Its own CSS is
      injected by this file, so no per-page <style> block is needed —
      just include this script tag.
   ========================================================================== */

(function () {
  "use strict";

  var SESSION_KEY = "teaching_session";
  var DRIVE_ENDPOINT = "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return (parsed && parsed.student_id) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (e) {
      /* localStorage unavailable — session just won't persist across reloads */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (e) {
      /* nothing to clear */
    }
  }

  function sha256Hex(text) {
    var enc = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); })
        .join("");
    });
  }

  function postToDrive(payload) {
    if (!DRIVE_ENDPOINT) return Promise.reject(new Error("not-configured"));
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight against Apps Script — see
      // quiz.js/assign.js for the full note. doPost JSON.parses regardless.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.json().then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "Request failed.");
        return data;
      });
    });
  }

  // -- Global corner widget ---------------------------------------------

  var WIDGET_ID = "auth-engine-widget";
  var WIDGET_STYLE_ID = "auth-engine-widget-style";
  var WIDGET_CSS =
    "#" + WIDGET_ID + "{position:fixed;top:var(--aew-top,64px);right:16px;z-index:9999;font-family:var(--mono,monospace);}" +
    "#" + WIDGET_ID + " .aew-toggle{display:flex;align-items:center;gap:8px;background:var(--panel-soft,#f2f2f2);border:1px solid var(--line,#ddd);border-radius:999px;padding:7px 14px 7px 7px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.14);color:var(--ink,#111);font-size:12.5px;font-family:inherit;}" +
    "#" + WIDGET_ID + " .aew-toggle:hover{border-color:var(--accent,#7c5cff);}" +
    "#" + WIDGET_ID + " .aew-avatar{width:24px;height:24px;border-radius:50%;background:var(--accent,#7c5cff);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;flex-shrink:0;}" +
    "#" + WIDGET_ID + " .aew-name{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    "#" + WIDGET_ID + " .aew-menu{position:absolute;right:0;top:calc(100% + 8px);min-width:200px;background:var(--panel-soft,#fff);border:1px solid var(--line,#ddd);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);overflow:hidden;display:none;}" +
    "#" + WIDGET_ID + " .aew-menu.open{display:block;}" +
    "#" + WIDGET_ID + " .aew-menu-item{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;background:none;border:none;padding:11px 14px;font-family:inherit;font-size:12.5px;color:var(--ink,#111);cursor:pointer;}" +
    "#" + WIDGET_ID + " .aew-menu-item:hover:not(:disabled){background:var(--line,#eee);}" +
    "#" + WIDGET_ID + " .aew-menu-item:disabled{color:var(--ink-dim,#888);cursor:default;}" +
    "#" + WIDGET_ID + " .aew-menu-item+.aew-menu-item{border-top:1px solid var(--line,#eee);}" +
    "#" + WIDGET_ID + " .aew-soon{font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-dim,#888);border:1px solid var(--line,#ddd);border-radius:5px;padding:2px 5px;flex-shrink:0;}" +
    "#" + WIDGET_ID + " .aew-logout{color:var(--status-fail,#c1443b);}" +
    ".aew-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;}" +
    ".aew-modal{background:var(--panel-soft,#fff);border:1px solid var(--line,#ddd);border-radius:16px;padding:28px 26px;max-width:340px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.28);font-family:var(--sans,sans-serif);position:relative;box-sizing:border-box;}" +
    ".aew-modal h3{margin:0 0 16px;font-size:16px;color:var(--ink,#111);font-family:var(--sans,sans-serif);}" +
    ".aew-modal .aew-field{margin-bottom:12px;}" +
    ".aew-modal input{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--line,#ddd);border-radius:9px;background:var(--panel,#fff);color:var(--ink,#111);font-size:14px;font-family:inherit;}" +
    ".aew-modal input:focus{outline:none;border-color:var(--accent,#7c5cff);}" +
    ".aew-modal .aew-error{color:var(--status-fail,#c1443b);font-size:12.5px;margin:2px 0 10px;min-height:1em;}" +
    ".aew-modal .aew-primary{width:100%;padding:11px;border:none;border-radius:9px;background:var(--accent,#7c5cff);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}" +
    ".aew-modal .aew-primary:disabled{opacity:.6;cursor:default;}" +
    ".aew-modal .aew-link{display:block;background:none;border:none;padding:0;color:var(--ink-dim,#888);font-size:12.5px;cursor:pointer;text-decoration:underline;margin-top:12px;font-family:inherit;}" +
    ".aew-modal .aew-close{position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;line-height:1;color:var(--ink-dim,#888);cursor:pointer;padding:4px;}";

  function injectWidgetStyle() {
    if (document.getElementById(WIDGET_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = WIDGET_STYLE_ID;
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    var a = parts[0] ? parts[0][0] : "?";
    var b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase();
  }

  function mountGlobalWidget() {
    var existingNode = document.getElementById(WIDGET_ID);
    if (existingNode) existingNode.remove();
    if (!document.body) return;

    injectWidgetStyle();

    var session = getSession();
    var widget;

    if (session) {
      var menu = el("div", { class: "aew-menu" }, [
        el("button", { class: "aew-menu-item", type: "button", disabled: "disabled" }, [
          document.createTextNode("Student dashboard"),
          el("span", { class: "aew-soon" }, ["Soon"]),
        ]),
        el("button", { class: "aew-menu-item aew-logout", type: "button" }, ["Log out"]),
      ]);

      var toggleBtn = el("button", { class: "aew-toggle", type: "button", "aria-haspopup": "true", "aria-expanded": "false" }, [
        el("span", { class: "aew-avatar" }, [initials(session.student_name)]),
        el("span", { class: "aew-name" }, [session.student_name]),
      ]);

      widget = el("div", { id: WIDGET_ID }, [toggleBtn, menu]);

      toggleBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = menu.classList.toggle("open");
        toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
      });

      menu.querySelector(".aew-logout").addEventListener("click", function () {
        clearSession();
        location.reload();
      });

      document.addEventListener("click", function (e) {
        if (!widget.contains(e.target)) menu.classList.remove("open");
      });
    } else {
      var signInBtn = el("button", { class: "aew-toggle", type: "button" }, ["Sign in"]);
      signInBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openSignInModal();
      });
      widget = el("div", { id: WIDGET_ID }, [signInBtn]);
    }

    document.body.appendChild(widget);
  }

  // Reusable phone -> login/register flow, rendered inside a floating
  // modal so it can be triggered from the corner widget on ANY page
  // (subject pages, lesson pages, home) — not just quiz.html/
  // assignment.html, which still use their own inline version further
  // below (unchanged, since that one already matches each page's own
  // forms.css styling).
  function openSignInModal() {
    if (document.getElementById("aew-overlay")) return;
    injectWidgetStyle();

    var phone = "";
    var step = "phone";

    var modal = el("div", { class: "aew-modal" });
    var closeBtn = el("button", { class: "aew-close", type: "button", "aria-label": "Close" }, ["\u00d7"]);
    var overlay = el("div", { id: "aew-overlay", class: "aew-overlay" }, [modal]);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKeydown);
    }
    function onKeydown(e) { if (e.key === "Escape") closeModal(); }
    document.addEventListener("keydown", onKeydown);

    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });

    function renderStep() {
      modal.innerHTML = "";
      modal.appendChild(closeBtn);
      if (step === "login") renderLoginStep();
      else if (step === "register") renderRegisterStep();
      else renderPhoneStep();
    }

    function renderPhoneStep() {
      var input = el("input", { type: "tel", inputmode: "tel", placeholder: "Phone number" });
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Continue \u2192"]);

      function submit() {
        var val = input.value.trim();
        if (!val) { error.textContent = "Enter your phone number."; return; }
        phone = val;
        btn.disabled = true;
        btn.textContent = "Checking\u2026";
        postToDrive({ action: "check_student", phone: phone })
          .then(function (data) { step = data.known ? "login" : "register"; renderStep(); })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = "Continue \u2192";
            error.textContent = (err.message === "not-configured")
              ? "Login isn't set up yet \u2014 let your instructor know."
              : (err.message || "Couldn't reach the server. Try again.");
          });
      }

      btn.addEventListener("click", submit);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      modal.appendChild(el("h3", {}, ["Sign in"]));
      modal.appendChild(el("div", { class: "aew-field" }, [input]));
      modal.appendChild(error);
      modal.appendChild(btn);
      input.focus();
    }

    function renderLoginStep() {
      var input = el("input", { type: "password", placeholder: "Password" });
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Log in \u2192"]);
      var back = el("button", { class: "aew-link", type: "button" }, ["\u2190 Not you?"]);

      back.addEventListener("click", function () { step = "phone"; renderStep(); });

      function submit() {
        var pw = input.value;
        if (!pw) { error.textContent = "Enter your password."; return; }
        btn.disabled = true;
        btn.textContent = "Logging in\u2026";
        sha256Hex(pw)
          .then(function (hash) { return postToDrive({ action: "login_student", phone: phone, password_hash: hash }); })
          .then(function (data) {
            saveSession({ student_id: data.student_id, student_name: data.student_name });
            location.reload();
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = "Log in \u2192";
            error.textContent = err.message || "Couldn't log in.";
          });
      }

      btn.addEventListener("click", submit);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      modal.appendChild(el("h3", {}, ["Welcome back"]));
      modal.appendChild(el("div", { class: "aew-field" }, [input]));
      modal.appendChild(error);
      modal.appendChild(btn);
      modal.appendChild(back);
      input.focus();
    }

    function renderRegisterStep() {
      var nameInput = el("input", { type: "text", placeholder: "Your name" });
      var passInput = el("input", { type: "password", placeholder: "Set a password" });
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Create account \u2192"]);
      var back = el("button", { class: "aew-link", type: "button" }, ["\u2190 Not you?"]);

      back.addEventListener("click", function () { step = "phone"; renderStep(); });

      function submit() {
        var name = nameInput.value.trim();
        var pw = passInput.value;
        if (!name) { error.textContent = "Enter your name."; return; }
        if (!pw || pw.length < 4) { error.textContent = "Choose a password (4+ characters)."; return; }
        btn.disabled = true;
        btn.textContent = "Creating\u2026";
        sha256Hex(pw)
          .then(function (hash) { return postToDrive({ action: "register_student", phone: phone, password_hash: hash, display_name: name }); })
          .then(function (data) {
            saveSession({ student_id: data.student_id, student_name: data.student_name });
            location.reload();
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = "Create account \u2192";
            error.textContent = err.message || "Couldn't create your account.";
          });
      }

      btn.addEventListener("click", submit);
      passInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      modal.appendChild(el("h3", {}, ["First time here"]));
      modal.appendChild(el("div", { class: "aew-field" }, [nameInput]));
      modal.appendChild(el("div", { class: "aew-field" }, [passInput]));
      modal.appendChild(error);
      modal.appendChild(btn);
      modal.appendChild(back);
      nameInput.focus();
    }

    document.body.appendChild(overlay);
    renderStep();
  }

  function autoMountGlobalWidget() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountGlobalWidget);
    } else {
      mountGlobalWidget();
    }
    // Keeps the widget in sync if the session is cleared/set in another
    // tab on the same site — cheap to support, not load-bearing.
    window.addEventListener("storage", function (e) {
      if (e.key === SESSION_KEY) mountGlobalWidget();
    });
  }

  autoMountGlobalWidget();

  // -- Login/register gate (per-page, opt-in) -----------------------------

  function mount(rootSelector, onReady) {
    var existing = getSession();
    if (existing) {
      onReady(existing);
      return;
    }

    var root = document.querySelector(rootSelector);
    if (!root) return;

    var step = "phone"; // "phone" | "login" | "register"
    var phone = "";

    render();

    function render() {
      root.innerHTML = "";
      if (step === "login") renderLoginStep();
      else if (step === "register") renderRegisterStep();
      else renderPhoneStep();
    }

    function renderPhoneStep() {
      var phoneInput = el("input", {
        class: "qz-input", type: "tel", inputmode: "tel",
        placeholder: "Phone number", required: "required",
      });
      var errorMsg = el("div", { class: "qz-error" });
      var nextBtn = el("button", { class: "qz-next", type: "button" }, ["Continue \u2192"]);

      function submit() {
        var val = phoneInput.value.trim();
        if (!val) {
          errorMsg.textContent = "Enter your phone number.";
          phoneInput.focus();
          return;
        }
        phone = val;
        nextBtn.disabled = true;
        nextBtn.textContent = "Checking\u2026";
        postToDrive({ action: "check_student", phone: phone })
          .then(function (data) {
            step = data.known ? "login" : "register";
            render();
          })
          .catch(function (err) {
            nextBtn.disabled = false;
            nextBtn.textContent = "Continue \u2192";
            errorMsg.textContent = (err.message === "not-configured")
              ? "Login isn't set up on this page yet \u2014 let your instructor know."
              : (err.message || "Couldn't reach the server. Try again.");
          });
      }

      nextBtn.addEventListener("click", submit);
      phoneInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["Sign in with your phone number"]),
        el("div", { class: "qz-field" }, [phoneInput]),
        errorMsg,
        el("div", { class: "qz-actions" }, [nextBtn]),
      ]);
      root.appendChild(card);
    }

    function renderLoginStep() {
      var passInput = el("input", { class: "qz-input", type: "password", placeholder: "Password", required: "required" });
      var errorMsg = el("div", { class: "qz-error" });
      var backBtn = el("button", { class: "qz-authswitch", type: "button" }, ["\u2190 Not you?"]);
      var loginBtn = el("button", { class: "qz-next", type: "button" }, ["Log in \u2192"]);

      backBtn.addEventListener("click", function () { step = "phone"; render(); });

      function submit() {
        var pw = passInput.value;
        if (!pw) {
          errorMsg.textContent = "Enter your password.";
          passInput.focus();
          return;
        }
        loginBtn.disabled = true;
        loginBtn.textContent = "Logging in\u2026";
        sha256Hex(pw)
          .then(function (hash) {
            return postToDrive({ action: "login_student", phone: phone, password_hash: hash });
          })
          .then(function (data) {
            var session = { student_id: data.student_id, student_name: data.student_name };
            saveSession(session);
            mountGlobalWidget();
            onReady(session);
          })
          .catch(function (err) {
            loginBtn.disabled = false;
            loginBtn.textContent = "Log in \u2192";
            errorMsg.textContent = err.message || "Couldn't log in.";
          });
      }

      loginBtn.addEventListener("click", submit);
      passInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["Welcome back \u2014 enter your password"]),
        el("div", { class: "qz-field" }, [passInput]),
        errorMsg,
        el("div", { class: "qz-actions-row" }, [backBtn, loginBtn]),
      ]);
      root.appendChild(card);
    }

    function renderRegisterStep() {
      var nameInput = el("input", { class: "qz-input", type: "text", placeholder: "Your name", required: "required" });
      var passInput = el("input", { class: "qz-input", type: "password", placeholder: "Set a password", required: "required" });
      var errorMsg = el("div", { class: "qz-error" });
      var backBtn = el("button", { class: "qz-authswitch", type: "button" }, ["\u2190 Not you?"]);
      var registerBtn = el("button", { class: "qz-next", type: "button" }, ["Create account \u2192"]);

      backBtn.addEventListener("click", function () { step = "phone"; render(); });

      function submit() {
        var name = nameInput.value.trim();
        var pw = passInput.value;
        if (!name) {
          errorMsg.textContent = "Enter your name.";
          nameInput.focus();
          return;
        }
        if (!pw || pw.length < 4) {
          errorMsg.textContent = "Choose a password (4+ characters).";
          passInput.focus();
          return;
        }
        registerBtn.disabled = true;
        registerBtn.textContent = "Creating\u2026";
        sha256Hex(pw)
          .then(function (hash) {
            return postToDrive({ action: "register_student", phone: phone, password_hash: hash, display_name: name });
          })
          .then(function (data) {
            var session = { student_id: data.student_id, student_name: data.student_name };
            saveSession(session);
            mountGlobalWidget();
            onReady(session);
          })
          .catch(function (err) {
            registerBtn.disabled = false;
            registerBtn.textContent = "Create account \u2192";
            errorMsg.textContent = err.message || "Couldn't create your account.";
          });
      }

      registerBtn.addEventListener("click", submit);
      passInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["First time here \u2014 set up your account"]),
        el("div", { class: "qz-field" }, [nameInput]),
        el("div", { class: "qz-field" }, [passInput]),
        errorMsg,
        el("div", { class: "qz-actions-row" }, [backBtn, registerBtn]),
      ]);
      root.appendChild(card);
    }
  }

  window.AuthEngine = { mount: mount, getSession: getSession, clearSession: clearSession };
})();