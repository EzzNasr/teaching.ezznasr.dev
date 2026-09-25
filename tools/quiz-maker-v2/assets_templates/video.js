/* ==========================================================================
   video.js — fills a page's <div class="media-slot"> with the lesson video,
   or with a "locked" box when this viewer isn't allowed to watch it yet.

   Nothing about the video is in the page HTML any more. On load this asks
   Code.gs's public get_video action for the slot, sending the signed-in
   student's session (if any), and draws whatever comes back:

     - no video set for this slot   -> the slot's original content is put back
     - video allowed (unlocked, or this student has paid, or an admin)
                                    -> the <iframe>
     - locked, not signed in        -> "Sign in" button (opens the corner-widget
                                       sign-in modal; the page reloads after login)
     - locked, signed in, no access -> the payment note + an "I paid" form that
                                       adds a PENDING request for the teacher
                                       (nothing unlocks until they approve it),
                                       or "waiting for approval" / "not approved" /
                                       "your access ended on ..." as the case is

   The server decides; this file only draws. A locked video's URL is never sent
   to a viewer who may not watch it, so there is nothing in the page to dig out.

   Which video: the lesson path and slot come from the page address
   (/programming/other/functions/quiz.html -> lesson "programming/other/functions",
   slot "quiz"; index.html or a bare folder -> slot "lesson"; assignment.html ->
   slot "assignment"). A slot can override that with
   data-video-lesson="..." data-video-slot="lesson|quiz|assignment".

   A slot that already contains an <iframe> (a video hard-coded into an older
   page) is left completely alone.

   Quiz and assignment pages keep their "finish it first" rule: even a viewer who
   may watch the solution video sees it blurred behind "Finish the quiz below to
   unlock this video" until they have submitted once (same localStorage keys and
   the same .video-lock look as the inline script this replaces).

   DRIVE_ENDPOINT is baked in by app_main.py's "Sync site assets", like assign.js.
   Its own CSS is injected here (like auth.js) — no per-page <style> block needed.
   ========================================================================== */

(function () {
  "use strict";

  if (window.VideoSlot) return; // loaded twice — the first copy already did the work

  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";
  var SESSION_KEY = "teaching_session";
  var RECHECK_AFTER_MS = 20000; // returning to a tab that shows a locked box re-checks, at most this often

  // Defence in depth: Code.gs only ever stores these two shapes, and the page
  // refuses anything else even if the server were ever wrong.
  var EMBED_OK = /^https:\/\/(?:(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[A-Za-z0-9_-]{11}|player\.vimeo\.com\/video\/\d+)(?:\?[A-Za-z0-9_=&%.-]*)?$/;

  var LOCK = "\uD83D\uDD12";

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  // -- talking to Code.gs -------------------------------------------------------

  function call(payload, isRetry) {
    if (!DRIVE_ENDPOINT || DRIVE_ENDPOINT.indexOf("{{") === 0) {
      return Promise.reject(new Error("Videos aren't set up yet \u2014 let your teacher know."));
    }
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight against Apps Script; doPost JSON.parses regardless.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(
      function (resp) {
        return resp.text().then(function (raw) {
          var data;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            // Apps Script occasionally answers with an HTML page instead of JSON
            // (right after a redeploy, under load). One silent retry clears it.
            if (!isRetry) return call(payload, true);
            throw new Error("The server sent back something unexpected. Please try again.");
          }
          if (!data || !data.ok) throw new Error((data && data.error) || "Request failed.");
          return data;
        });
      },
      function () {
        throw new Error("Couldn't reach the server. Check your connection and try again.");
      },
    );
  }

  function getSession() {
    try {
      if (window.AuthEngine && typeof window.AuthEngine.getSession === "function") {
        return window.AuthEngine.getSession();
      }
      var raw = localStorage.getItem(SESSION_KEY);
      var s = raw ? JSON.parse(raw) : null;
      return s && s.student_id && s.session_token ? s : null;
    } catch (e) {
      return null;
    }
  }

  // -- which video is this slot? ------------------------------------------------

  function slotInfo(slot) {
    var lesson = slot.getAttribute("data-video-lesson");
    var kind = slot.getAttribute("data-video-slot");
    if (lesson && kind) return { lesson: lesson, kind: kind };

    var parts = location.pathname.split("/").filter(Boolean).map(function (p) {
      try {
        return decodeURIComponent(p);
      } catch (e) {
        return p;
      }
    });
    var last = parts.length ? parts[parts.length - 1] : "";
    var found = "lesson";
    var m = /^(index|quiz|assignment)(?:\.html?)?$/i.exec(last);
    if (m) {
      parts.pop();
      if (m[1].toLowerCase() !== "index") found = m[1].toLowerCase();
    } else if (/\.html?$/i.test(last)) {
      parts.pop(); // some other page file in the folder
    }
    return { lesson: parts.join("/"), kind: found };
  }

  // -- styles -------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById("vp-style")) return;
    var css =
      ".media-slot{position:relative}" +
      ".media-slot.vp-panel{display:block;aspect-ratio:auto;min-height:0;padding:0;overflow:visible;text-align:left;" +
      "font-family:var(--sans,system-ui,sans-serif);font-size:14px;color:var(--ink,#10233f);border-style:solid}" +
      ".vp-box{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:22px;max-width:560px;margin:0 auto}" +
      ".vp-icon{font-size:26px;line-height:1}" +
      ".vp-title{margin:0;font-size:17px;font-weight:800;line-height:1.3}" +
      ".vp-text,.vp-status{margin:0;line-height:1.5;color:var(--ink-dim,#63738a)}" +
      ".vp-status:empty{display:none}" +
      ".vp-hint{margin:-4px 0 0;font-size:12px;line-height:1.4;color:var(--ink-dim,#63738a)}" +
      ".vp-status.vp-error{color:var(--status-fail,#e2574c)}" +
      ".vp-pay{margin:0;width:100%;box-sizing:border-box;white-space:pre-line;line-height:1.5;color:var(--ink,#10233f);" +
      "background:var(--panel,#fff);border:1px solid var(--line,#d6e1ef);border-radius:10px;padding:10px 12px}" +
      ".vp-form{display:flex;gap:8px;flex-wrap:wrap;width:100%}" +
      ".vp-input{flex:1 1 220px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--line-strong,#b8c9df);" +
      "background:var(--panel,#fff);color:var(--ink,#10233f);font:inherit}" +
      ".vp-btn{padding:10px 16px;border-radius:10px;border:1px solid var(--accent,#2f6fed);background:var(--accent,#2f6fed);" +
      "color:#fff;font:inherit;font-weight:700;cursor:pointer}" +
      'html[data-theme="dark"] .vp-btn{color:#0a1a32}' +
      'html[data-theme="dark"] .vp-btn.vp-ghost{color:var(--accent,#72a5ff)}' +
      ".vp-btn[disabled]{opacity:.6;cursor:default}" +
      ".vp-btn.vp-ghost{background:transparent;color:var(--accent,#2f6fed)}" +
      ".vp-badge{position:absolute;top:8px;left:8px;z-index:4;padding:4px 9px;border-radius:999px;background:rgba(8,12,22,.78);" +
      "color:#e8ecf6;font:11px var(--mono,monospace);pointer-events:none}";
    var style = el("style", { id: "vp-style" });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // -- "finish the quiz / assignment first" (same rule as the old inline script) -

  function finishRule(kind) {
    if (kind === "quiz") {
      var dataEl = document.getElementById("quiz-data");
      var quiz = {};
      try {
        quiz = JSON.parse((dataEl && dataEl.textContent) || "{}");
      } catch (e) {}
      return {
        key: "teaching_last_attempt:" + (quiz.subject || "?") + ":" + (quiz.lesson || "?"),
        msg: "Finish the quiz below to unlock this video.",
        watch: document.getElementById("quiz-root"),
      };
    }
    if (kind === "assignment") {
      var root = document.getElementById("assign-root");
      return {
        key:
          "teaching_last_submission:" +
          ((root && root.getAttribute("data-subject")) || "?") + ":" +
          ((root && root.getAttribute("data-lesson")) || "?"),
        msg: "Submit the assignment below to unlock this video.",
        watch: root,
      };
    }
    return null;
  }

  // Returns { stop() }. Blurs + covers the slot until the rule's localStorage key exists.
  function applyFinishRule(slot, kind) {
    var rule = finishRule(kind);
    if (!rule) return null;
    var overlay = el("div", { class: "video-lock" }, [
      el("span", { class: "video-lock__icon", "aria-hidden": "true" }, [LOCK]),
      el("span", { class: "video-lock__msg" }, [rule.msg]),
    ]);
    function done() {
      try {
        return !!localStorage.getItem(rule.key);
      } catch (e) {
        return false;
      }
    }
    function sync() {
      if (done()) {
        slot.classList.remove("is-locked");
        if (slot.contains(overlay)) slot.removeChild(overlay);
      } else if (!slot.contains(overlay)) {
        slot.classList.add("is-locked");
        slot.appendChild(overlay);
      }
    }
    overlay.addEventListener("click", function () {
      overlay.classList.add("is-tapped");
      overlay.classList.remove("shake");
      void overlay.offsetWidth;
      overlay.classList.add("shake");
    });
    sync();
    var observer = null;
    if (rule.watch && window.MutationObserver) {
      observer = new MutationObserver(sync);
      observer.observe(rule.watch, { childList: true, subtree: true });
    }
    return {
      stop: function () {
        if (observer) observer.disconnect();
        slot.classList.remove("is-locked");
      },
    };
  }

  // -- one slot -----------------------------------------------------------------

  function mountSlot(slot) {
    if (slot.getAttribute("data-vp-mounted")) return;
    if (slot.querySelector("iframe")) return; // a hard-coded video on an older page: leave it alone
    var info = slotInfo(slot);
    if (!info.lesson) return;
    slot.setAttribute("data-vp-mounted", "1");

    var original = slot.innerHTML;
    var state = "init"; // init | video | panel | none
    var seq = 0; // only the newest answer is drawn
    var lastCheck = 0;
    var rule = null;

    function clear() {
      if (rule) {
        rule.stop();
        rule = null;
      }
      slot.classList.remove("vp-panel", "is-locked");
      while (slot.firstChild) slot.removeChild(slot.firstChild);
    }

    function titleText() {
      var t = slot.getAttribute("data-video-title");
      if (t) return t;
      var h1 = document.querySelector("h1");
      return (h1 && h1.textContent.trim()) || "Lesson video";
    }

    function showVideo(data, session) {
      if (!EMBED_OK.test(data.embed_url)) {
        showProblem("This video can't be shown. Please tell your teacher.");
        return;
      }
      clear();
      state = "video";
      slot.appendChild(
        el("iframe", {
          src: data.embed_url,
          title: titleText(),
          allowfullscreen: "",
          referrerpolicy: "strict-origin-when-cross-origin",
        }),
      );
      if (data.locked && session && session.is_admin) {
        slot.appendChild(el("div", { class: "vp-badge" }, [LOCK + " Locked for students \u2014 you're previewing"]));
      }
      rule = applyFinishRule(slot, info.kind);
    }

    function panel(build) {
      clear();
      state = "panel";
      slot.classList.add("vp-panel");
      var box = el("div", { class: "vp-box", role: "group", "aria-label": "Video access" });
      var status = el("p", { class: "vp-status", role: "status", "aria-live": "polite" });
      function say(msg, isError) {
        status.textContent = msg || "";
        status.className = "vp-status" + (isError ? " vp-error" : "");
      }
      build(box, say);
      box.appendChild(status);
      slot.appendChild(box);
    }

    function showProblem(message) {
      panel(function (box, say) {
        var retry = el("button", { class: "vp-btn vp-ghost", type: "button" }, ["Try again"]);
        retry.addEventListener("click", function () {
          retry.disabled = true;
          say("Loading\u2026");
          load();
        });
        box.appendChild(el("p", { class: "vp-text" }, [message]));
        box.appendChild(retry);
      });
    }

    function payBlock(box, data) {
      if (data.pay_info) box.appendChild(el("p", { class: "vp-pay" }, [data.pay_info]));
    }

    function showLogin(data) {
      panel(function (box) {
        var btn = el("button", { class: "vp-btn", type: "button" }, ["Sign in"]);
        btn.addEventListener("click", function () {
          if (window.AuthEngine && typeof window.AuthEngine.openSignIn === "function") {
            window.AuthEngine.openSignIn();
          } else {
            btn.textContent = "Use the sign-in button in the corner of the page";
            btn.disabled = true;
          }
        });
        box.appendChild(el("div", { class: "vp-icon", "aria-hidden": "true" }, [LOCK]));
        box.appendChild(el("p", { class: "vp-title" }, ["This video is for enrolled students"]));
        box.appendChild(el("p", { class: "vp-text" }, ["Sign in with your phone number to watch it."]));
        payBlock(box, data);
        box.appendChild(btn);
      });
    }

    function showPending(data) {
      panel(function (box, say) {
        var again = el("button", { class: "vp-btn vp-ghost", type: "button" }, ["Check again"]);
        again.addEventListener("click", function () {
          again.disabled = true;
          say("Checking\u2026");
          load();
        });
        box.appendChild(el("div", { class: "vp-icon", "aria-hidden": "true" }, ["\u23F3"]));
        box.appendChild(el("p", { class: "vp-title" }, ["Waiting for approval"]));
        box.appendChild(
          el("p", { class: "vp-text" }, [
            "We got your payment note. This video unlocks as soon as your teacher confirms it.",
          ]),
        );
        box.appendChild(again);
      });
    }

    function showPayment(data, session) {
      panel(function (box, say) {
        var intro = "Once you've paid, tell us below and your teacher will unlock it.";
        if (data.request === "rejected") {
          intro = "Your last payment note wasn't approved. If you think that's a mistake, contact your teacher \u2014 or send a new note.";
        } else if (data.request === "revoked") {
          intro = "Your access to this video was removed. If you think that's a mistake, contact your teacher \u2014 or send a new payment note.";
        } else if (data.expired) {
          intro = "Your access ended on " + data.expired + ". Send a new payment note to renew it.";
        }
        var input = el("input", {
          class: "vp-input",
          type: "text",
          maxlength: "200",
          autocomplete: "off",
          placeholder: "Payment reference",
          "aria-label": "Payment reference",
        });
        var send = el("button", { class: "vp-btn", type: "button" }, ["I paid"]);

        function submit() {
          var ref = input.value.trim();
          if (!ref) {
            say("Type the payment reference first, so your teacher can find your payment.", true);
            input.focus();
            return;
          }
          var s = getSession();
          if (!s) {
            load();
            return;
          }
          send.disabled = true;
          say("Sending\u2026");
          call({
            action: "request_access",
            student_id: s.student_id,
            session_token: s.session_token,
            lesson: info.lesson,
            reference: ref,
          }).then(
            function (r) {
              if (r.status === "active") load();
              else showPending(data);
            },
            function (err) {
              send.disabled = false;
              say(err.message, true);
              if (/session|log in|sign in/i.test(err.message)) load();
            },
          );
        }
        send.addEventListener("click", submit);
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") submit();
        });

        box.appendChild(el("div", { class: "vp-icon", "aria-hidden": "true" }, [LOCK]));
        box.appendChild(el("p", { class: "vp-title" }, ["This video is for enrolled students"]));
        box.appendChild(el("p", { class: "vp-text" }, [intro]));
        payBlock(box, data);
        box.appendChild(el("div", { class: "vp-form" }, [input, send]));
        box.appendChild(el("p", { class: "vp-hint" }, ["The transaction number, or the phone number you paid from."]));
      });
    }

    function render(data, session) {
      if (!data.found) {
        clear();
        state = "none";
        slot.innerHTML = original; // no video for this slot: exactly what the page had before
        return;
      }
      if (data.embed_url) return showVideo(data, session);
      if (data.need === "payment") {
        return data.request === "pending" ? showPending(data) : showPayment(data, session);
      }
      return showLogin(data);
    }

    function load() {
      var mine = ++seq;
      lastCheck = Date.now();
      var session = getSession();
      if (state === "init") {
        slot.textContent = "Loading video\u2026";
      }
      var payload = { action: "get_video", lesson: info.lesson, slot: info.kind };
      if (session) {
        payload.student_id = session.student_id;
        payload.session_token = session.session_token;
      }
      call(payload).then(
        function (data) {
          if (mine === seq) render(data, session);
        },
        function (err) {
          if (mine === seq) showProblem(err.message);
        },
      );
    }

    // Coming back to this tab (e.g. after paying in another app) re-checks a locked box.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state === "panel" && Date.now() - lastCheck > RECHECK_AFTER_MS) load();
    });
    // Signed in or out in another tab.
    window.addEventListener("storage", function (e) {
      if (e.key === SESSION_KEY) load();
    });

    load();
  }

  function mountAll() {
    injectStyle();
    var slots = document.querySelectorAll(".media-slot");
    for (var i = 0; i < slots.length; i++) mountSlot(slots[i]);
  }

  window.VideoSlot = { mountAll: mountAll, slotInfo: slotInfo };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
