/* ==========================================================================
   auth.js — phone+password student identity for teaching.ezznasr.dev

   Backed by Code.gs's "check_student" / "register_student" / "login_student"
   actions and a Students Google Sheet (phone | password_hash | display_name
   | created_at). The password itself never leaves the browser — only a
   SHA-256 hash of it does (crypto.subtle.digest). The server just compares
   hashes; it never sees the plaintext.

   Session — { student_id, student_name, session_token } — is cached in
   localStorage under "teaching_session" so a returning student on the
   same device/browser skips straight past this gate on their next
   quiz/assignment. session_token is what proves a "give me my data" call
   (dashboards) actually came from that student having logged in, since
   student_id alone is just their phone number's digits — not a secret.

   Two independent things happen here:

   1. AuthEngine.mount(rootSelector, onReady) — the phone -> login/register
      GATE. Only relevant on pages that actually need to know who's
      answering (quiz.html, assignment.html). Renders into rootSelector
      while signed out; once signed in, calls onReady(session) and leaves
      rootSelector alone (the caller's own engine takes over from there).

   2. The global corner widget — a small "Signed in as X" pill (or "Sign
      in" pill when signed out) fixed to the bottom-right corner, present
      on ANY page that loads this script. Clicking it when signed out opens
      the same phone -> login/register flow in a floating modal. Its own
      CSS is injected by this file — no per-page <style> block needed.
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

  // Toggles a button between idle and "working" — working dims the button
  // (kept visible, just disabled-looking) and inserts a real progress-bar
  // element right after it in the DOM. This is a plain sibling, not a
  // positioned ::after — it can't detach from the button and render
  // somewhere else on the page, unlike the old ring approach.
  function setBusy(btn, busy) {
    btn.disabled = busy;
    if (busy) {
      btn.classList.add("is-loading");
      if (!btn._qzLoadbar) {
        var bar = el("div", { class: "qz-loadbar" }, [el("div", { class: "qz-loadbar__fill" })]);
        btn.insertAdjacentElement("afterend", bar);
        btn._qzLoadbar = bar;
      }
    } else {
      btn.classList.remove("is-loading");
      if (btn._qzLoadbar) {
        btn._qzLoadbar.remove();
        btn._qzLoadbar = null;
      }
    }
  }

  function maskPhone(phone) {
    var digits = String(phone || "").replace(/[^0-9]/g, "");
    if (digits.length <= 4) return digits;
    return "\u2022\u2022\u2022\u2022 " + digits.slice(-4);
  }

  // Shared checkmark-draw success content, used by both the inline gate
  // and the floating modal so the animation/timing feels identical.
  var SUCCESS_ANIM_MS = 1100; // must match the CSS: circle .5s + check .3s@.5s + msg .35s@.75s
  function buildSuccessContent(name) {
    var svg = "<svg viewBox=\"0 0 52 52\" class=\"qz-success__check\" aria-hidden=\"true\">" +
      "<circle cx=\"26\" cy=\"26\" r=\"24\"/>" +
      "<path d=\"M14 27l7 7 16-16\"/>" +
      "</svg>";
    return [
      el("div", { class: "qz-success__badge", html: svg }),
      el("p", { class: "qz-success__msg" }, [name ? ("Welcome, " + name + "!") : "You're signed in!"]),
    ];
  }

  function looksLikePhone(value) {
    return String(value || "").replace(/[^0-9]/g, "").length >= 6;
  }

  // A password <input> plus a "Show"/"Hide" toggle, wrapped together so
  // the toggle can be positioned inside the field. inputClass is applied
  // to the <input> itself (callers use different class names: "qz-input"
  // inline vs. none in the floating modal, which styles via ".aew-modal
  // input" instead); toggleClass picks which button skin to use.
  function passwordField(placeholder, inputClass, toggleClass) {
    var input = el("input", {
      class: inputClass || "", type: "password", placeholder: placeholder, required: "required",
      autocomplete: "current-password",
    });
    var toggle = el("button", { class: toggleClass, type: "button", tabindex: "-1" }, ["Show"]);
    toggle.addEventListener("click", function () {
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "Hide" : "Show";
    });
    var wrap = el("div", { class: "qz-pwfield" }, [input, toggle]);
    return { wrap: wrap, input: input };
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

  function postToDrive(payload, isRetry) {
    if (!DRIVE_ENDPOINT) return Promise.reject(new Error("not-configured"));
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight against Apps Script — see
      // quiz.js/assign.js for the full note. doPost JSON.parses regardless.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.text().then(function (raw) {
        var data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          // Apps Script Web Apps occasionally return an HTML page instead
          // of JSON — a transient Google-side hiccup (seen right after
          // redeploys, under load), not a login/deploy bug. One silent
          // retry clears it almost every time; the student just sees the
          // loading state run slightly longer, not an error.
          if (!isRetry) return postToDrive(payload, true);
          throw new Error("The server sent back something unexpected. Please try again.");
        }
        if (!data || !data.ok) throw new Error((data && data.error) || "Request failed.");
        return data;
      });
    });
  }

  // -- Dashboard data calls -----------------------------------------------
  // Thin wrappers around postToDrive so hand-built dashboard pages never
  // need to know DRIVE_ENDPOINT themselves — they just call
  // AuthEngine.getMyResults(session) with whatever AuthEngine.getSession()
  // gave them. Session shape is { student_id, student_name, session_token }.

  function requireSession(session) {
    if (!session || !session.student_id || !session.session_token) {
      return Promise.reject(new Error("Not signed in."));
    }
    return null;
  }

  function getMyResults(session) {
    var missing = requireSession(session);
    if (missing) return missing;
    return postToDrive({
      action: "get_my_results",
      student_id: session.student_id,
      session_token: session.session_token,
    });
  }

  function adminGetAll(session) {
    var missing = requireSession(session);
    if (missing) return missing;
    return postToDrive({
      action: "admin_get_all",
      student_id: session.student_id,
      session_token: session.session_token,
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
    ".aew-modal h3{margin:0 0 4px;font-size:16px;color:var(--ink,#111);font-family:var(--sans,sans-serif);}" +
    ".aew-modal .aew-sub{margin:0 0 16px;font-size:12.5px;color:var(--ink-dim,#888);font-family:var(--mono,monospace);}" +
    ".aew-modal .aew-field{margin-bottom:12px;}" +
    ".aew-modal input{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--line,#ddd);border-radius:9px;background:var(--panel,#fff);color:var(--ink,#111);font-size:14px;font-family:inherit;}" +
    ".aew-modal input:focus{outline:none;border-color:var(--accent,#7c5cff);}" +
    ".aew-modal .qz-pwfield{position:relative;}" +
    ".aew-modal .qz-pwfield input{padding-right:52px;}" +
    ".aew-modal .aew-error{color:var(--status-fail,#c1443b);font-size:12.5px;margin:2px 0 10px;min-height:1em;}" +
    ".aew-modal .aew-primary{width:100%;padding:11px;border:none;border-radius:9px;background:var(--accent,#7c5cff);color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;position:relative;}" +
    ".aew-modal .aew-primary:disabled{opacity:.85;cursor:default;}" +
    ".aew-modal .aew-link{display:block;background:none;border:none;padding:0;color:var(--ink-dim,#888);font-size:12.5px;cursor:pointer;text-decoration:underline;margin-top:12px;font-family:inherit;}" +
    ".aew-modal .aew-close{position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;line-height:1;color:var(--ink-dim,#888);cursor:pointer;padding:4px;}" +
    ".aew-pwtoggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--ink-dim,#888);font-family:var(--mono,monospace);font-size:11px;cursor:pointer;padding:4px 6px;}" +
    ".aew-pwtoggle:hover{color:var(--accent,#7c5cff);}" +
    // Loading indicator: a real block-level bar inserted after the button
    // (see setBusy() below), not a positioned ::after ring — a normal
    // sibling in document flow has no position/inset to break, so it
    // can't fall back to the viewport and render as a giant line the way
    // the ring did.
    ".is-loading{opacity:.7;pointer-events:none;}" +
    ".qz-loadbar{margin-top:8px;height:4px;width:100%;background:var(--line,#ddd);border-radius:999px;overflow:hidden;}" +
    ".qz-loadbar__fill{height:100%;width:40%;background:var(--accent-strong,var(--accent,#7c5cff));border-radius:999px;animation:qz-loadbar-slide 1.1s ease-in-out infinite;}" +
    "@keyframes qz-loadbar-slide{0%{transform:translateX(-100%);}50%{transform:translateX(75%);}100%{transform:translateX(220%);}}" +
    // Sign-in success (checkmark draw-in) — same shapes/timing as forms.css
    // so the modal and the inline gate feel identical.
    ".aew-modal .qz-success{padding:14px 0 6px;text-align:center;}" +
    ".qz-success__badge{width:64px;height:64px;margin:0 auto 14px;}" +
    ".qz-success__check{width:100%;height:100%;}" +
    ".qz-success__check circle{stroke:var(--status-shipped,#2f9e6f);stroke-width:2;fill:none;stroke-dasharray:151;stroke-dashoffset:151;animation:qz-circle .5s ease-out forwards;}" +
    ".qz-success__check path{stroke:var(--status-shipped,#2f9e6f);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;fill:none;stroke-dasharray:36;stroke-dashoffset:36;animation:qz-check .3s .5s ease-out forwards;}" +
    ".qz-success__msg{font-family:var(--mono,monospace);font-size:14px;color:var(--ink,#111);margin:0;opacity:0;animation:qz-fadeup .35s .75s ease-out forwards;}" +
    "@keyframes qz-circle{to{stroke-dashoffset:0;}}" +
    "@keyframes qz-check{to{stroke-dashoffset:0;}}" +
    "@keyframes qz-fadeup{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}" +
    // Custom select chrome — a bare <select> ignores qz-input/modal input
    // theming entirely (background, radius, and especially the OS-drawn
    // arrow), which is what made the year dropdown look untouched next to
    // the styled fields around it. This can't restyle the native open
    // popup list (that's OS chrome, no CSS reaches it), only the closed
    // control — but that's the part that actually looked out of place.
    ".qz-select,.aew-modal select{appearance:none;-webkit-appearance:none;-moz-appearance:none;cursor:pointer;background-repeat:no-repeat;background-position:right 14px center;background-size:11px 7px;padding-right:38px !important;background-image:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 12 8\"><path d=\"M1 1l5 5 5-5\" stroke=\"%23888a99\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>');}" +
    ".aew-modal select{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid var(--line,#ddd);border-radius:9px;background-color:var(--panel,#fff);color:var(--ink,#111);font-size:14px;font-family:inherit;}" +
    ".aew-modal select:focus{outline:none;border-color:var(--accent,#7c5cff);}" +
    ".qz-select:invalid,.aew-modal select:invalid{color:var(--ink-dim,#888);}" +
    // Sign-out confirmation — brief, then reload. Mirrors the sign-in
    // success checkmark's motion language (same fade+rise) without the
    // full animated checkmark, since "signed out" is a neutral action,
    // not an achievement.
    ".aew-signedout{cursor:default;gap:8px;animation:qz-fadeup .25s ease-out;}" +
    ".aew-signedout .aew-avatar{background:var(--ink-dim,#888);}";

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
    if (!document.body) {
      // Script tag ran before <body> existed (e.g. placed in <head>
      // without defer). Try again once the DOM is actually ready instead
      // of silently giving up.
      document.addEventListener("DOMContentLoaded", mountGlobalWidget, { once: true });
      return;
    }

    injectWidgetStyle();

    var session = getSession();
    var widget;

    if (session) {
      var dashboardBtn = el("button", { class: "aew-menu-item", type: "button" }, ["My dashboard"]);
      dashboardBtn.addEventListener("click", function () {
        location.href = "/dashboard/student.html";
      });

      var menu = el("div", { class: "aew-menu" }, [
        dashboardBtn,
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
        widget.innerHTML = "";
        widget.appendChild(el("div", { class: "aew-toggle aew-signedout" }, [
          el("span", { class: "aew-avatar" }, ["\u2713"]),
          el("span", { class: "aew-name" }, ["Signed out"]),
        ]));
        setTimeout(function () { location.reload(); }, 700);
      });

      document.addEventListener("click", function (e) {
        if (!widget.contains(e.target)) menu.classList.remove("open");
      });
    } else {
      var signInBtn = el("button", { class: "aew-toggle", type: "button" }, ["Sign in"]);
      signInBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openSignInModal(signInBtn);
      });
      widget = el("div", { id: WIDGET_ID }, [signInBtn]);
    }

    document.body.appendChild(widget);
  }

  // Reusable phone -> login/register flow, rendered inside a floating
  // modal so it can be triggered from the corner widget on ANY page
  // (subject pages, lesson pages, home) — not just quiz.html/
  // assignment.html, which still use their own inline version further
  // below (unchanged in shape, since that one already matches each
  // page's own forms.css styling, just sharing the same polish).
  function openSignInModal(triggerEl) {
    if (document.getElementById("aew-overlay")) return;
    injectWidgetStyle();

    var phone = "";
    var knownName = null; // filled in from check_student's response, once we have it
    var step = "phone";
    var busy = false; // guards against a double-fire (Enter + click racing the disabled flag)
    var previouslyFocused = triggerEl || document.activeElement;

    var modal = el("div", { class: "aew-modal", role: "dialog", "aria-modal": "true", "aria-label": "Sign in" });
    var closeBtn = el("button", { class: "aew-close", type: "button", "aria-label": "Close" }, ["\u00d7"]);
    var overlay = el("div", { id: "aew-overlay", class: "aew-overlay" }, [modal]);

    function closeModal() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKeydown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
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

    function showModalSuccess(name) {
      modal.innerHTML = "";
      modal.appendChild(closeBtn);
      modal.appendChild(el("div", { class: "qz-success" }, buildSuccessContent(name)));
    }

    function renderPhoneStep() {
      var input = el("input", { type: "tel", inputmode: "tel", placeholder: "Phone number", autocomplete: "tel" });
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Continue \u2192"]);

      function submit() {
        if (busy) return;
        var val = input.value.trim();
        if (!looksLikePhone(val)) {
          error.textContent = "Enter a valid phone number.";
          input.focus();
          return;
        }
        phone = val;
        busy = true;
        setBusy(btn, true);
        postToDrive({ action: "check_student", phone: phone })
          .then(function (data) {
            knownName = data.display_name || null;
            step = data.known ? "login" : "register";
            busy = false;
            renderStep();
          })
          .catch(function (err) {
            busy = false;
            setBusy(btn, false);
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
      var pw = passwordField("Password", "", "aew-pwtoggle");
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Log in \u2192"]);
      var back = el("button", { class: "aew-link", type: "button" },
        [knownName ? "\u2190 Not " + knownName + "?" : "\u2190 Wrong number?"]);

      back.addEventListener("click", function () { step = "phone"; renderStep(); });

      function submit() {
        if (busy) return;
        var val = pw.input.value;
        if (!val) {
          error.textContent = "Enter your password.";
          pw.input.focus();
          return;
        }
        busy = true;
        setBusy(btn, true);
        sha256Hex(val)
          .then(function (hash) { return postToDrive({ action: "login_student", phone: phone, password_hash: hash }); })
          .then(function (data) {
            saveSession({ student_id: data.student_id, student_name: data.student_name, session_token: data.session_token, year: data.year || "", parent_phone: data.parent_phone || "" });
            showModalSuccess(data.student_name);
            setTimeout(function () { location.reload(); }, SUCCESS_ANIM_MS);
          })
          .catch(function (err) {
            busy = false;
            setBusy(btn, false);
            error.textContent = err.message || "Couldn't log in.";
          });
      }

      btn.addEventListener("click", submit);
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      modal.appendChild(el("h3", {}, [knownName ? "Welcome back, " + knownName : "Welcome back"]));
      modal.appendChild(el("p", { class: "aew-sub" }, [maskPhone(phone)]));
      modal.appendChild(el("div", { class: "aew-field" }, [pw.wrap]));
      modal.appendChild(error);
      modal.appendChild(btn);
      modal.appendChild(back);
      pw.input.focus();
    }

    function renderRegisterStep() {
      var nameInput = el("input", { type: "text", placeholder: "Your name", autocomplete: "name" });
      var yearSelect = el("select", { class: "qz-select" }, [
        el("option", { value: "", disabled: "disabled", selected: "selected" }, ["Which year are you in?"]),
        el("option", { value: "Senior 1" }, ["Senior 1"]),
        el("option", { value: "Senior 2" }, ["Senior 2"]),
      ]);
      var parentPhoneInput = el("input", { type: "tel", inputmode: "tel", placeholder: "Parent's phone number", autocomplete: "tel" });
      var pw = passwordField("Set a password", "", "aew-pwtoggle");
      var error = el("div", { class: "aew-error" });
      var btn = el("button", { class: "aew-primary", type: "button" }, ["Create account \u2192"]);
      var back = el("button", { class: "aew-link", type: "button" }, ["\u2190 Wrong number?"]);

      back.addEventListener("click", function () { step = "phone"; renderStep(); });

      function submit() {
        if (busy) return;
        var name = nameInput.value.trim();
        var year = yearSelect.value;
        var parentPhone = parentPhoneInput.value.trim();
        var val = pw.input.value;
        if (!name) {
          error.textContent = "Enter your name.";
          nameInput.focus();
          return;
        }
        if (!year) {
          error.textContent = "Choose your year.";
          yearSelect.focus();
          return;
        }
        if (!looksLikePhone(parentPhone)) {
          error.textContent = "Enter a valid parent's phone number.";
          parentPhoneInput.focus();
          return;
        }
        if (!val || val.length < 4) {
          error.textContent = "Choose a password (4+ characters).";
          pw.input.focus();
          return;
        }
        busy = true;
        setBusy(btn, true);
        sha256Hex(val)
          .then(function (hash) {
            return postToDrive({ action: "register_student", phone: phone, password_hash: hash, display_name: name, year: year, parent_phone: parentPhone });
          })
          .then(function (data) {
            saveSession({ student_id: data.student_id, student_name: data.student_name, session_token: data.session_token, year: data.year || "", parent_phone: data.parent_phone || "" });
            showModalSuccess(data.student_name);
            setTimeout(function () { location.reload(); }, SUCCESS_ANIM_MS);
          })
          .catch(function (err) {
            busy = false;
            setBusy(btn, false);
            error.textContent = err.message || "Couldn't create your account.";
          });
      }

      btn.addEventListener("click", submit);
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      modal.appendChild(el("h3", {}, ["First time here"]));
      modal.appendChild(el("p", { class: "aew-sub" }, [maskPhone(phone)]));
      modal.appendChild(el("div", { class: "aew-field" }, [nameInput]));
      modal.appendChild(el("div", { class: "aew-field" }, [yearSelect]));
      modal.appendChild(el("div", { class: "aew-field" }, [parentPhoneInput]));
      modal.appendChild(el("div", { class: "aew-field" }, [pw.wrap]));
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
    var root = document.querySelector(rootSelector);
    if (!root) return;

    // A cached session with both fields already on file skips the gate
    // entirely, same as before — zero extra network calls for the common
    // case. Missing either one (old account, or one that only ever went
    // through the corner-widget flow before it collected these) routes
    // straight to the completeProfile step below instead of onReady —
    // no password re-entry needed, the existing session_token is already
    // proof enough, it just needs these two fields filled in once.
    if (existing && existing.year && existing.parent_phone) {
      onReady(existing);
      return;
    }

    var step = existing ? "completeProfile" : "phone"; // "phone" | "login" | "register" | "completeProfile"
    var phone = "";
    var knownName = null;
    var busy = false;
    var sessionForProfile = existing || null;

    function renderSuccessThenReady(session) {
      root.innerHTML = "";
      var card = el("div", { class: "qz-card frame qz-success" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
      ].concat(buildSuccessContent(session.student_name)));
      root.appendChild(card);
      setTimeout(function () { onReady(session); }, SUCCESS_ANIM_MS);
    }

    // Shared by both the login and register submit handlers: saves the
    // session, then either continues straight to the success screen (the
    // common case), or — if year/parent_phone are still missing on this
    // account — routes to completeProfile before onReady ever fires.
    function proceedAfterAuth(data) {
      var session = {
        student_id: data.student_id, student_name: data.student_name, session_token: data.session_token,
        year: data.year || "", parent_phone: data.parent_phone || "",
      };
      saveSession(session);
      mountGlobalWidget();
      if (!session.year || !session.parent_phone) {
        sessionForProfile = session;
        step = "completeProfile";
        render();
        return;
      }
      renderSuccessThenReady(session);
    }

    render();

    function render() {
      root.innerHTML = "";
      if (step === "completeProfile") renderCompleteProfileStep(sessionForProfile);
      else if (step === "login") renderLoginStep();
      else if (step === "register") renderRegisterStep();
      else renderPhoneStep();
    }

    function renderCompleteProfileStep(session) {
      var yearSelect = el("select", { class: "qz-input qz-select", required: "required" }, [
        el("option", { value: "" }, ["Which year are you in?"]),
        el("option", { value: "Senior 1" }, ["Senior 1"]),
        el("option", { value: "Senior 2" }, ["Senior 2"]),
      ]);
      if (session.year) yearSelect.value = session.year;
      var parentPhoneInput = el("input", {
        class: "qz-input", type: "tel", inputmode: "tel", autocomplete: "tel",
        placeholder: "Parent's phone number", required: "required",
      });
      if (session.parent_phone) parentPhoneInput.value = session.parent_phone;
      var errorMsg = el("div", { class: "qz-error" });
      var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Save & continue \u2192"]);

      function submit() {
        if (busy) return;
        var year = yearSelect.value;
        var parentPhone = parentPhoneInput.value.trim();
        if (!year) {
          errorMsg.textContent = "Choose your year.";
          yearSelect.focus();
          return;
        }
        if (!looksLikePhone(parentPhone)) {
          errorMsg.textContent = "Enter a valid parent's phone number.";
          parentPhoneInput.focus();
          return;
        }
        busy = true;
        setBusy(submitBtn, true);
        postToDrive({ action: "update_profile", student_id: session.student_id, session_token: session.session_token, year: year, parent_phone: parentPhone })
          .then(function () {
            session.year = year;
            session.parent_phone = parentPhone;
            saveSession(session);
            onReady(session);
          })
          .catch(function (err) {
            busy = false;
            setBusy(submitBtn, false);
            errorMsg.textContent = err.message || "Couldn't save \u2014 try again.";
          });
      }

      submitBtn.addEventListener("click", submit);

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["A couple of details we still need"]),
        el("p", { class: "qz-subtle" }, ["Signed in as " + session.student_name]),
        el("div", { class: "qz-field" }, [yearSelect]),
        el("div", { class: "qz-field" }, [parentPhoneInput]),
        errorMsg,
        el("div", { class: "qz-actions" }, [submitBtn]),
      ]);
      root.appendChild(card);
    }

    function renderPhoneStep() {
      var phoneInput = el("input", {
        class: "qz-input", type: "tel", inputmode: "tel", autocomplete: "tel",
        placeholder: "Phone number", required: "required",
      });
      var errorMsg = el("div", { class: "qz-error" });
      var nextBtn = el("button", { class: "qz-next", type: "button" }, ["Continue \u2192"]);

      function submit() {
        if (busy) return;
        var val = phoneInput.value.trim();
        if (!looksLikePhone(val)) {
          errorMsg.textContent = "Enter a valid phone number.";
          phoneInput.focus();
          return;
        }
        phone = val;
        busy = true;
        setBusy(nextBtn, true);
        postToDrive({ action: "check_student", phone: phone })
          .then(function (data) {
            knownName = data.display_name || null;
            step = data.known ? "login" : "register";
            busy = false;
            render();
          })
          .catch(function (err) {
            busy = false;
            setBusy(nextBtn, false);
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
      var pw = passwordField("Password", "qz-input", "qz-pwtoggle");
      var errorMsg = el("div", { class: "qz-error" });
      var backBtn = el("button", { class: "qz-authswitch", type: "button" },
        [knownName ? "\u2190 Not " + knownName + "?" : "\u2190 Wrong number?"]);
      var loginBtn = el("button", { class: "qz-next", type: "button" }, ["Log in \u2192"]);

      backBtn.addEventListener("click", function () { step = "phone"; render(); });

      function submit() {
        if (busy) return;
        var val = pw.input.value;
        if (!val) {
          errorMsg.textContent = "Enter your password.";
          pw.input.focus();
          return;
        }
        busy = true;
        setBusy(loginBtn, true);
        sha256Hex(val)
          .then(function (hash) {
            return postToDrive({ action: "login_student", phone: phone, password_hash: hash });
          })
          .then(function (data) {
            proceedAfterAuth(data);
          })
          .catch(function (err) {
            busy = false;
            setBusy(loginBtn, false);
            errorMsg.textContent = err.message || "Couldn't log in.";
          });
      }

      loginBtn.addEventListener("click", submit);
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, [knownName ? "Welcome back, " + knownName : "Welcome back"]),
        el("p", { class: "qz-subtle" }, [maskPhone(phone)]),
        el("div", { class: "qz-field" }, [pw.wrap]),
        errorMsg,
        el("div", { class: "qz-actions-row" }, [backBtn, loginBtn]),
      ]);
      root.appendChild(card);
    }

    function renderRegisterStep() {
      var nameInput = el("input", { class: "qz-input", type: "text", placeholder: "Your name", required: "required", autocomplete: "name" });
      var yearSelect = el("select", { class: "qz-input qz-select", required: "required" }, [
        el("option", { value: "", disabled: "disabled", selected: "selected" }, ["Which year are you in?"]),
        el("option", { value: "Senior 1" }, ["Senior 1"]),
        el("option", { value: "Senior 2" }, ["Senior 2"]),
      ]);
      var parentPhoneInput = el("input", { class: "qz-input", type: "tel", inputmode: "tel", placeholder: "Parent's phone number", required: "required", autocomplete: "tel" });
      var pw = passwordField("Set a password", "qz-input", "qz-pwtoggle");
      var errorMsg = el("div", { class: "qz-error" });
      var backBtn = el("button", { class: "qz-authswitch", type: "button" }, ["\u2190 Wrong number?"]);
      var registerBtn = el("button", { class: "qz-next", type: "button" }, ["Create account \u2192"]);

      backBtn.addEventListener("click", function () { step = "phone"; render(); });

      function submit() {
        if (busy) return;
        var name = nameInput.value.trim();
        var year = yearSelect.value;
        var parentPhone = parentPhoneInput.value.trim();
        var val = pw.input.value;
        if (!name) {
          errorMsg.textContent = "Enter your name.";
          nameInput.focus();
          return;
        }
        if (!year) {
          errorMsg.textContent = "Choose your year.";
          yearSelect.focus();
          return;
        }
        if (!looksLikePhone(parentPhone)) {
          errorMsg.textContent = "Enter a valid parent's phone number.";
          parentPhoneInput.focus();
          return;
        }
        if (!val || val.length < 4) {
          errorMsg.textContent = "Choose a password (4+ characters).";
          pw.input.focus();
          return;
        }
        busy = true;
        setBusy(registerBtn, true);
        sha256Hex(val)
          .then(function (hash) {
            return postToDrive({ action: "register_student", phone: phone, password_hash: hash, display_name: name, year: year, parent_phone: parentPhone });
          })
          .then(function (data) {
            proceedAfterAuth(data);
          })
          .catch(function (err) {
            busy = false;
            setBusy(registerBtn, false);
            errorMsg.textContent = err.message || "Couldn't create your account.";
          });
      }

      registerBtn.addEventListener("click", submit);
      pw.input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["First time here \u2014 set up your account"]),
        el("p", { class: "qz-subtle" }, [maskPhone(phone)]),
        el("div", { class: "qz-field" }, [nameInput]),
        el("div", { class: "qz-field" }, [yearSelect]),
        el("div", { class: "qz-field" }, [parentPhoneInput]),
        el("div", { class: "qz-field" }, [pw.wrap]),
        errorMsg,
        el("div", { class: "qz-actions-row" }, [backBtn, registerBtn]),
      ]);
      root.appendChild(card);
    }
  }

  window.AuthEngine = {
    mount: mount,
    getSession: getSession,
    clearSession: clearSession,
    getMyResults: getMyResults,
    adminGetAll: adminGetAll,
  };
})();
