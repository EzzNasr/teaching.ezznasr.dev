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

   Usage: AuthEngine.mount(rootSelector, onReady, barSelector).
     - rootSelector: where the phone -> login/register flow renders while
       signed out. Once a quiz/assignment engine takes over, that engine
       typically wipes this container on every screen change — don't rely
       on anything staying here after onReady() fires.
     - onReady(session): fires once a session exists (immediately, if one
       was already cached; after login/register succeeds, otherwise).
     - barSelector (optional): a container that the calling engine's own
       render loop never touches. If given, a small "Signed in as ... —
       Log out" bar is rendered there whenever a session is active, and it
       survives however many times the engine re-renders rootSelector.
       Without it, there's simply no logout control rendered.
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

  // Renders "Signed in as X — Log out" into barSelector. Lives outside
  // whatever container the calling engine (quiz.js/assign.js) re-renders,
  // so it isn't wiped out the moment the engine draws its next screen.
  function renderLoggedInBar(barSelector, session) {
    var bar = document.querySelector(barSelector);
    if (!bar) return;
    bar.innerHTML = "";
    var logoutBtn = el("button", { class: "qz-authswitch", type: "button" }, ["Log out"]);
    logoutBtn.addEventListener("click", function () {
      clearSession();
      location.reload();
    });
    bar.appendChild(el("div", { class: "qz-loggedinbar" }, [
      document.createTextNode("Signed in as " + session.student_name + " \u2014 "),
      logoutBtn,
    ]));
  }

  function mount(rootSelector, onReady, barSelector) {
    var existing = getSession();
    if (existing) {
      if (barSelector) renderLoggedInBar(barSelector, existing);
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
            if (barSelector) renderLoggedInBar(barSelector, session);
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
            if (barSelector) renderLoggedInBar(barSelector, session);
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
