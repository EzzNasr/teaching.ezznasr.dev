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
  window.__videoJsVersion = "v7-polish";

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

  // Line icons (Feather-style) built as real SVG so they look the same on every phone,
  // unlike emoji. 24x24 viewBox, stroke follows the text colour.
  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    lock: [["rect", { x: 3, y: 11, width: 18, height: 11, rx: 2 }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }]],
    clock: [["circle", { cx: 12, cy: 12, r: 10 }], ["polyline", { points: "12 6 12 12 16 14" }]],
    play: [["polygon", { points: "7 4 20 12 7 20 7 4" }]],
    alert: [["circle", { cx: 12, cy: 12, r: 10 }], ["line", { x1: 12, y1: 8, x2: 12, y2: 12 }], ["line", { x1: 12, y1: 16, x2: 12.01, y2: 16 }]],
  };
  function icon(name) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    (ICONS[name] || []).forEach(function (part) {
      var n = document.createElementNS(SVGNS, part[0]);
      Object.keys(part[1]).forEach(function (k) { n.setAttribute(k, part[1][k]); });
      svg.appendChild(n);
    });
    return svg;
  }
  function badge(name) {
    return el("div", { class: "vp-icon-badge", "aria-hidden": "true" }, [icon(name)]);
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
      ".media-slot.vp-panel{display:flex;align-items:center;justify-content:center;aspect-ratio:auto;min-height:220px;padding:8px;overflow:visible;text-align:center;" +
      "font-family:var(--sans,system-ui,sans-serif);font-size:14px;color:var(--ink,#10233f);border-style:solid;border-color:var(--line,#d6e1ef);" +
      "background:linear-gradient(180deg,var(--panel,#fff),var(--panel-soft,#eef4fb))}" +
      ".media-slot.vp-panel.vp-empty{min-height:150px}" +
      ".media-slot.vp-panel.vp-empty .vp-icon-badge{width:46px;height:46px}" +
      ".media-slot.vp-panel.vp-empty .vp-icon-badge svg{width:21px;height:21px}" +
      ".media-slot.vp-loading{border-style:solid;border-color:var(--line,#d6e1ef);background:var(--panel-soft,#eef4fb)}" +
      ".vp-loading-box{display:flex;flex-direction:column;align-items:center;gap:12px;font:500 13px var(--sans,system-ui,sans-serif);color:var(--ink-dim,#63738a)}" +
      ".vp-spinner{width:28px;height:28px;border-radius:50%;border:3px solid var(--line,#d6e1ef);border-top-color:var(--accent,#2f6fed);animation:vp-spin .8s linear infinite}" +
      "@keyframes vp-spin{to{transform:rotate(360deg)}}" +
      "@media (prefers-reduced-motion:reduce){.vp-spinner{animation-duration:2.4s}}" +
      "font-family:var(--sans,system-ui,sans-serif);font-size:14px;color:var(--ink,#10233f);border-style:solid}" +
      ".vp-box{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:24px 22px;width:100%;box-sizing:border-box;max-width:520px;margin:0 auto}" +
      ".vp-icon{font-size:26px;line-height:1}" +
      ".vp-icon-badge{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 2px;flex:0 0 auto;" +
      "color:var(--accent-strong,#2056bd);background:var(--accent-soft,rgba(47,111,237,.12));" +
      "border:1px solid color-mix(in srgb,var(--accent,#2f6fed) 28%,transparent);box-shadow:0 0 0 6px color-mix(in srgb,var(--accent,#2f6fed) 8%,transparent)}" +
      ".vp-icon-badge svg{width:26px;height:26px}" +
      "font-size:28px;margin:0 auto 4px;background:var(--accent-soft,rgba(47,111,237,.12));border:1px solid var(--line,#d6e1ef)}" +
      ".vp-title{margin:0;font-size:18px;font-weight:800;line-height:1.3;letter-spacing:-.01em}" +
      ".vp-text,.vp-status{margin:0;line-height:1.55;color:var(--ink-dim,#63738a)}" +
      ".vp-text{max-width:44ch}" +
      ".vp-status:empty{display:none}" +
      ".vp-hint{margin:-4px 0 0;font-size:12px;line-height:1.4;color:var(--ink-dim,#63738a)}" +
      ".vp-status.vp-error{color:var(--status-fail,#e2574c)}" +
      ".vp-pay{margin:0;width:100%;box-sizing:border-box;white-space:pre-line;line-height:1.5;color:var(--ink,#10233f);" +
      "background:var(--panel,#fff);border:1px solid var(--line,#d6e1ef);border-radius:10px;padding:10px 12px}" +
      ".vp-pay-ar{font-family:'Cairo',var(--sans,system-ui,sans-serif);font-size:15px;line-height:2;text-align:right;padding:14px 16px}" +
      ".vp-paywall{align-items:center;text-align:center}" +
      ".vp-paywall .vp-pay-ar,.vp-paywall .vp-form,.vp-paywall .vp-hint{text-align:right}" +
      ".vp-paywall.vp-box[dir=rtl]{font-family:'Cairo',var(--sans,system-ui,sans-serif)}" +
      ".vp-paywall .vp-form{flex-direction:row-reverse}" +
      ".vp-form{display:flex;gap:8px;flex-wrap:wrap;width:100%}" +
      ".vp-input{flex:1 1 220px;min-width:0;padding:10px 12px;border-radius:10px;border:1px solid var(--line-strong,#b8c9df);" +
      "background:var(--panel,#fff);color:var(--ink,#10233f);font:inherit}" +
      ".vp-btn{padding:11px 24px;border-radius:999px;border:1px solid var(--accent,#2f6fed);background:var(--accent,#2f6fed);" +
      "color:#fff;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 6px 16px -6px color-mix(in srgb,var(--accent,#2f6fed) 80%,transparent);" +
      "transition:transform .15s ease,box-shadow .15s ease,filter .15s ease}" +
      ".vp-box .vp-btn{margin-top:4px}" +
      ".media-slot.is-locked:not(.vp-panel){border-style:solid;border-color:transparent}" +
      ".vp-btn:hover:not([disabled]){transform:translateY(-1px);filter:brightness(1.06)}" +
      ".vp-btn.vp-ghost{box-shadow:none}" +
      'html[data-theme="dark"] .vp-btn{color:#0a1a32}' +
      'html[data-theme="dark"] .vp-btn.vp-ghost{color:var(--accent,#72a5ff)}' +
      ".vp-btn[disabled]{opacity:.6;cursor:default}" +
      ".vp-btn.vp-ghost{background:transparent;color:var(--accent,#2f6fed)}" +
      ".vp-poster{position:absolute;inset:0;z-index:2;cursor:pointer;background-size:cover;background-position:center;" +
      "background-color:#0a0e18;display:flex;align-items:center;justify-content:center;border:0;padding:0}" +
      ".vp-poster:after{content:'';position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.05),rgba(0,0,0,.28))}" +
      ".vp-poster-play{position:relative;z-index:1;width:64px;height:64px;border-radius:50%;background:rgba(20,24,34,.72);" +
      "display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;transition:transform .15s ease,background .15s ease}" +
      ".vp-poster:hover .vp-poster-play{transform:scale(1.08);background:rgba(30,90,220,.88)}" +
      ".media-slot.vp-yt iframe{position:absolute;left:0;top:-64px;width:100%;height:calc(100% + 128px)}" +
      ".vp-shield{position:absolute;inset:0;z-index:2;cursor:pointer;background:transparent}" +
      ".vp-bar{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;align-items:center;gap:10px;padding:8px 12px;" +
      "background:linear-gradient(transparent,rgba(8,12,22,.85));color:#fff;font:12px var(--mono,monospace);user-select:none}" +
      ".vp-bar button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer;padding:2px 6px;line-height:1}" +
      ".vp-bar input[type=range]{flex:1;accent-color:#fff;cursor:pointer}" +
      ".vp-speed{position:relative;display:flex}" +
      ".vp-bar .vp-speed-btn{font-size:13px;font-weight:600;min-width:38px;padding:3px 6px;border-radius:6px;background:rgba(255,255,255,.14)}" +
      ".vp-speed-menu{position:absolute;right:0;bottom:calc(100% + 10px);z-index:6;display:none;flex-direction:column;padding:4px;" +
      "border-radius:10px;background:rgba(20,24,34,.94);box-shadow:0 8px 24px rgba(0,0,0,.4);max-height:calc(var(--vp-slot-h,220px) - 64px);overflow:auto}" +
      ".vp-speed-menu.vp-open{display:flex}" +
      ".vp-bar .vp-speed-menu button{font-size:13px;text-align:center;padding:6px 14px;border-radius:6px;white-space:nowrap}" +
      ".vp-bar .vp-speed-menu button.vp-on{background:rgba(255,255,255,.22);font-weight:700}" +
      ".media-slot .video-lock{gap:10px;padding:20px 24px;background:radial-gradient(120% 120% at 50% 0%,rgba(44,76,140,.55),rgba(8,12,22,.92));" +
      "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}" +
      ".media-slot .video-lock__icon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;color:#fff;" +
      "background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.24);box-shadow:0 0 0 6px rgba(255,255,255,.05);filter:none;transition:transform .2s ease,background .2s ease}" +
      ".media-slot .video-lock__icon svg{width:26px;height:26px}" +
      ".media-slot .video-lock:hover .video-lock__icon{transform:scale(1.06)}" +
      ".media-slot .video-lock__title{font:800 17px/1.3 var(--sans,system-ui,sans-serif);color:#fff;letter-spacing:-.01em}" +
      ".media-slot .video-lock__msg,.media-slot .video-lock.is-tapped .video-lock__msg{font:500 13px/1.5 var(--sans,system-ui,sans-serif);color:rgba(232,236,246,.82);" +
      "max-width:340px;opacity:1;max-height:none;margin:0;overflow:visible}" +
      ".media-slot .video-lock.is-tapped .video-lock__icon{background:rgba(255,255,255,.2)}" +
      ".media-slot.is-locked .vp-shield,.media-slot.is-locked .vp-bar,.media-slot.is-locked .vp-poster{display:none}" +
      ".media-slot:fullscreen{border-radius:0;margin:0;background:#000}" +
      ".media-slot.vp-fs{position:fixed!important;inset:0;width:100vw;height:100vh;height:100dvh;max-width:none;margin:0;border-radius:0;z-index:2147483000;background:#000;aspect-ratio:auto}" +
      ".media-slot.vp-fs iframe{top:0;height:100%}" +
      "html.vp-fs-lock,html.vp-fs-lock body{overflow:hidden}" +
      ".vp-wm{position:absolute;z-index:5;pointer-events:none;user-select:none;white-space:nowrap;padding:3px 10px;border-radius:999px;" +
      "background:rgba(0,0,0,.26);color:rgba(255,255,255,.5);font:600 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;" +
      "font-variant-numeric:tabular-nums;letter-spacing:.08em;transition:left 9s linear,top 9s linear}" +
      ".vp-badge{position:absolute;top:8px;left:8px;z-index:4;padding:4px 9px;border-radius:999px;background:rgba(8,12,22,.78);" +
      "color:#e8ecf6;font:11px var(--mono,monospace);pointer-events:none}";
    var style = el("style", { id: "vp-style" });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // The Arabic payment instructions (vp-pay-ar) are set in Cairo -- loaded once,
  // same guard pattern as injectStyle above. If this fails to load for any reason
  // (offline, blocked), .vp-pay-ar's font-family already falls back to the site's
  // normal sans-serif, so nothing breaks -- it just looks like the rest of the page.
  function loadArabicFont() {
    if (document.getElementById("vp-font-cairo")) return;
    var link = el("link", {
      id: "vp-font-cairo",
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap",
    });
    document.head.appendChild(link);
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
        title: "Finish the quiz to unlock",
        msg: "Complete the quiz below and the video opens right away.",
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
        title: "Submit your work to unlock",
        msg: "Submit the assignment below and the video opens right away.",
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
      el("span", { class: "video-lock__icon", "aria-hidden": "true" }, [icon("lock")]),
      el("span", { class: "video-lock__title" }, [rule.title]),
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

  // Click-shield + custom controls over a YouTube iframe: the visitor never gets
  // YouTube's title bar, logo, "Watch on YouTube", share/copy-link or right-click menu.
  function ytId(embedUrl) {
    var m = /\/embed\/([A-Za-z0-9_-]{6,})/.exec(embedUrl);
    return m ? m[1] : null;
  }

  function attachControls(slot, frame) {
    var playing = false, dur = 0, seeking = false, rateApplied = false;
    function cmd(func, args) {
      try { frame.contentWindow.postMessage(JSON.stringify({ event: "command", func: func, args: args || [] }), "*"); } catch (e) {}
    }
    function fmt(t) { t = Math.max(0, t | 0); return ((t / 60) | 0) + ":" + ("0" + (t % 60)).slice(-2); }
    var shield = el("div", { class: "vp-shield" });
    var btn = el("button", { type: "button", "aria-label": "Play/pause" }, ["\u25B6"]);
    var range = el("input", { type: "range", min: "0", max: "1000", value: "0", "aria-label": "Seek" });
    var time = el("span", {}, ["0:00"]);
    var fs = el("button", { type: "button", "aria-label": "Fullscreen" }, ["\u26F6"]);
    var RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    var RATE_KEY = "teaching_video_rate";
    var rate = 1;
    try { var saved = parseFloat(localStorage.getItem(RATE_KEY)); if (RATES.indexOf(saved) !== -1) rate = saved; } catch (e) {}
    function rateLabel(r) { return r + "\u00D7"; }
    var speedBtn = el("button", { type: "button", class: "vp-speed-btn", "aria-label": "Playback speed", "aria-haspopup": "true" }, [rateLabel(rate)]);
    var menu = el("div", { class: "vp-speed-menu", role: "menu" });
    var items = RATES.map(function (r) {
      var b = el("button", { type: "button", role: "menuitemradio" }, [rateLabel(r)]);
      b.addEventListener("click", function (e) { e.stopPropagation(); setRate(r); closeMenu(); });
      menu.appendChild(b);
      return b;
    });
    var speed = el("div", { class: "vp-speed" }, [speedBtn, menu]);
    function closeMenu() { menu.classList.remove("vp-open"); }
    function setRate(r, fromPlayer) {
      rate = r;
      speedBtn.textContent = rateLabel(r);
      items.forEach(function (b, i) {
        var on = RATES[i] === r;
        b.classList.toggle("vp-on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
      if (!fromPlayer) {
        cmd("setPlaybackRate", [r]);
        try { localStorage.setItem(RATE_KEY, String(r)); } catch (e) {}
      }
    }
    setRate(rate, true);
    speedBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      slot.style.setProperty("--vp-slot-h", slot.clientHeight + "px");
      menu.classList.toggle("vp-open");
    });
    slot.addEventListener("click", function (e) { if (!speed.contains(e.target)) closeMenu(); });
    var bar = el("div", { class: "vp-bar" }, [btn, range, time, speed, fs]);
    var startedAt = Date.now(), unmuted = false, gaveUp = false;
    function toggle() { cmd("unMute"); cmd(playing ? "pauseVideo" : "playVideo"); }
    // If the phone blocked autoplay, YouTube shows its own red play button under our shield.
    // Let the next tap go straight through to it (a tap inside the iframe always counts as a gesture).
    var giveUpTimer = setTimeout(function () {
      if (!playing) { gaveUp = true; shield.style.pointerEvents = "none"; }
    }, 2500);
    shield.addEventListener("click", toggle);
    shield.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    btn.addEventListener("click", toggle);
    range.addEventListener("input", function () { seeking = true; });
    range.addEventListener("change", function () { cmd("seekTo", [(range.value / 1000) * dur, true]); seeking = false; });
    // iPhone Safari has no element fullscreen, and some Android browsers refuse it:
    // fall back to a CSS fixed overlay covering the viewport.
    function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement; }
    function cssFs(on) {
      slot.classList.toggle("vp-fs", on);
      document.documentElement.classList.toggle("vp-fs-lock", on);
    }
    fs.addEventListener("click", function () {
      if (slot.classList.contains("vp-fs")) { cssFs(false); return; }
      if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      var req = slot.requestFullscreen || slot.webkitRequestFullscreen;
      if (!req) { cssFs(true); return; }
      var r;
      try { r = req.call(slot); } catch (e) { cssFs(true); return; }
      if (r && r.then) {
        r.then(function () {
          try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(function () {}); } catch (e) {}
        }, function () { cssFs(true); });
      }
    });
    slot.appendChild(shield);
    slot.appendChild(bar);
    function onMsg(e) {
      if (e.source !== frame.contentWindow) return;
      var d; try { d = typeof e.data === "string" ? JSON.parse(e.data) : e.data; } catch (x) { return; }
      if (!d || d.event !== "infoDelivery" || !d.info) return;
      var i = d.info;
      if (typeof i.playerState === "number") {
        playing = i.playerState === 1;
        btn.textContent = playing ? "\u275A\u275A" : "\u25B6";
        if (playing) {
          clearTimeout(giveUpTimer);
          if (gaveUp) { gaveUp = false; shield.style.pointerEvents = ""; }
          if (!unmuted) { unmuted = true; cmd("unMute"); cmd("setVolume", [100]); }
          if (!rateApplied) { rateApplied = true; if (rate !== 1) cmd("setPlaybackRate", [rate]); }
        }
      }
      if (typeof i.playbackRate === "number" && i.playbackRate !== rate && RATES.indexOf(i.playbackRate) !== -1) setRate(i.playbackRate, true);
      if (i.duration) dur = i.duration;
      if (typeof i.currentTime === "number" && dur) {
        time.textContent = fmt(i.currentTime) + " / " + fmt(dur);
        if (!seeking) range.value = Math.round((i.currentTime / dur) * 1000);
      }
    }
    window.addEventListener("message", onMsg);
    frame.addEventListener("load", function () {
      frame.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
    });
  }

  // Moving watermark with the student's number. Drifts slowly to a new random
  // spot every ~9s; re-added if someone deletes or restyles it via DevTools.
  function attachWatermark(slot, text) {
    var wm = el("div", { class: "vp-wm" }, [String(text)]);
    function place() {
      wm.style.left = (4 + Math.random() * 62) + "%";
      wm.style.top = (6 + Math.random() * 78) + "%";
    }
    function fresh() {
      wm.setAttribute("class", "vp-wm");
      wm.removeAttribute("style");
      wm.style.left = (4 + Math.random() * 62) + "%";
      wm.style.top = (6 + Math.random() * 78) + "%";
    }
    fresh();
    slot.appendChild(wm);
    var timer = setInterval(function () { if (wm.isConnected) place(); }, 9000);
    var obs = new MutationObserver(function () {
      if (!wm.parentNode) slot.appendChild(wm);
      var st = wm.getAttribute("style") || "";
      if (wm.getAttribute("class") !== "vp-wm" || /display|opacity|visibility|font-size|color/.test(st)) fresh();
      if (wm.textContent !== String(text)) wm.textContent = String(text);
    });
    obs.observe(slot, { childList: true });
    obs.observe(wm, { attributes: true, childList: true, characterData: true, subtree: true });
    slot._vpWm = function () { clearInterval(timer); obs.disconnect(); };
  }

  // -- one slot -----------------------------------------------------------------

  function mountSlot(slot) {
    if (slot.getAttribute("data-vp-mounted")) return;
    if (slot.querySelector("iframe")) return; // a hard-coded video on an older page: leave it alone
    injectStyle(); // manual callers (quiz.js, once its own gate says this slot may show) skip mountAll's call
    var info = slotInfo(slot);
    if (!info.lesson) return;
    slot.setAttribute("data-vp-mounted", "1");

    var original = slot.innerHTML;
    var state = "init"; // init | video | panel | none
    var seq = 0; // only the newest answer is drawn
    var lastCheck = 0;
    var rule = null;

    function clear() {
      if (slot._vpWm) { slot._vpWm(); slot._vpWm = null; }
      if (rule) {
        rule.stop();
        rule = null;
      }
      slot.classList.remove("vp-panel", "vp-empty", "vp-loading", "is-locked", "vp-yt", "vp-fs");
      document.documentElement.classList.remove("vp-fs-lock");
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
        showProblem("This video can't be shown right now. Please let your teacher know.");
        return;
      }
      clear();
      state = "video";
      var isYT = /youtube/.test(data.embed_url);
      var src = data.embed_url;
      var vid = isYT ? ytId(data.embed_url) : null;
      if (isYT) {
        // nocookie host, no YouTube UI, no related videos, no keyboard/fullscreen buttons
        src = src.split("?")[0].replace("www.youtube.com", "www.youtube-nocookie.com") +
          "?controls=0&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&playsinline=1&cc_load_policy=0" +
          "&enablejsapi=1&origin=" + encodeURIComponent(location.origin);
      }
      var touch = !!(window.matchMedia && matchMedia("(pointer:coarse)").matches);
      function play() {
        slot.classList.add("vp-yt");
        var frame = el("iframe", {
          src: src + (isYT ? "&autoplay=1" + (touch ? "&mute=1" : "") : ""),
          title: titleText(),
          allow: "autoplay; encrypted-media; picture-in-picture",
          referrerpolicy: "strict-origin-when-cross-origin",
        });
        slot.appendChild(frame);
        if (isYT) attachControls(slot, frame);
      }
      if (isYT && vid) {
        // Our own thumbnail + play button \u2014 nothing YouTube-branded shows
        // until the visitor actually presses play.
        var poster = el("button", {
          type: "button",
          class: "vp-poster",
          "aria-label": "Play video",
          style: "background-image:url(https://i.ytimg.com/vi/" + vid + "/hqdefault.jpg)",
        }, [el("span", { class: "vp-poster-play" }, ["\u25B6"])]);
        poster.addEventListener("click", function () {
          poster.remove();
          play();
        });
        slot.appendChild(poster);
      } else {
        play();
      }
      if (session && session.student_id) attachWatermark(slot, session.student_id);
      if (data.locked && session && session.is_admin) {
        slot.appendChild(el("div", { class: "vp-badge" }, ["Admin preview \u00B7 locked for students"]));
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
        box.appendChild(badge("alert"));
        box.appendChild(el("p", { class: "vp-title" }, ["Couldn't load the video"]));
        box.appendChild(el("p", { class: "vp-text" }, [message]));
        box.appendChild(retry);
      });
    }

    function payBlock(box, data, arabic) {
      if (!data.pay_info) return;
      var cls = arabic ? "vp-pay vp-pay-ar" : "vp-pay";
      var p = el("p", { class: cls }, [data.pay_info]);
      if (arabic) p.setAttribute("dir", "rtl");
      box.appendChild(p);
    }

    function showLogin(data) {
      panel(function (box) {
        var btn = el("button", { class: "vp-btn", type: "button" }, ["Sign in"]);
        btn.addEventListener("click", function () {
          if (window.AuthEngine && typeof window.AuthEngine.openSignIn === "function") {
            window.AuthEngine.openSignIn();
          } else {
            btn.textContent = "Use the Sign in button at the top of the page";
            btn.disabled = true;
          }
        });
        box.appendChild(badge("lock"));
        if (data.session_replaced) {
          box.appendChild(el("p", { class: "vp-title" }, ["You've been signed out"]));
          box.appendChild(el("p", { class: "vp-text" }, ["Your account was signed in on another device, or its password was reset. Only one device can be signed in at a time, so sign in again to keep watching here."]));
        } else {
          box.appendChild(el("p", { class: "vp-title" }, [data.no_video ? "Sign in to open this lesson" : "Sign in to watch this video"]));
          box.appendChild(el("p", { class: "vp-text" }, [data.no_video ? "This lesson is for enrolled students. Sign in with your phone number to continue." : "This video is for enrolled students. Sign in with your phone number to continue."]));
        }
        payBlock(box, data);
        box.appendChild(btn);
      });
    }

    // The old "Video placeholder \u2014 add a YouTube embed URL" box, redrawn for students.
    function showEmpty() {
      var titles = { quiz: "Solution video coming soon", assignment: "Walkthrough video coming soon" };
      panel(function (box) {
        box.appendChild(badge("play"));
        box.appendChild(el("p", { class: "vp-title" }, [titles[info.kind] || "Lesson video coming soon"]));
        box.appendChild(el("p", { class: "vp-text" }, ["It hasn't been added yet \u2014 check back soon."]));
      });
      slot.classList.add("vp-empty");
    }

    function showNoVideoYet() {
      panel(function (box) {
        box.appendChild(badge("clock"));
        box.appendChild(el("p", { class: "vp-title" }, ["Video coming soon"]));
        box.appendChild(el("p", { class: "vp-text" }, ["You're all set \u2014 this lesson is unlocked for you. The video just hasn't been added yet, so check back soon."]));
      });
    }

    function showPending(data) {
      panel(function (box, say) {
        var again = el("button", { class: "vp-btn vp-ghost", type: "button" }, ["Check status"]);
        again.addEventListener("click", function () {
          again.disabled = true;
          say("Checking\u2026");
          load();
        });
        box.appendChild(badge("clock"));
        box.appendChild(el("p", { class: "vp-title" }, ["Payment note received"]));
        box.appendChild(
          el("p", { class: "vp-text" }, [
            "Thanks! Your teacher will confirm your payment, and this video unlocks as soon as they do.",
          ]),
        );
        box.appendChild(again);
      });
    }

    function showPayment(data, session) {
      panel(function (box, say) {
        loadArabicFont();
        box.classList.add("vp-paywall");
        box.setAttribute("dir", "rtl");

        var intro = "\u0628\u0639\u062F \u0625\u062A\u0645\u0627\u0645 \u0627\u0644\u062F\u0641\u0639\u060C \u0623\u062E\u0628\u0631\u0646\u0627 \u0628\u0631\u0642\u0645 \u0627\u0644\u062A\u062D\u0648\u064A\u0644 \u0623\u062F\u0646\u0627\u0647\u060C \u0648\u0633\u064A\u0642\u0648\u0645 \u0641\u0631\u064A\u0642 \u0627\u0644\u062F\u0639\u0645 \u0628\u0641\u062A\u062D \u0627\u0644\u062F\u0631\u0633.";
        if (data.request === "rejected") {
          intro = "\u0644\u0645 \u062A\u062A\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649 \u0639\u0645\u0644\u064A\u0629 \u0627\u0644\u062F\u0641\u0639 \u0627\u0644\u0623\u062E\u064A\u0631\u0629. \u0625\u0630\u0627 \u0643\u0646\u062A \u062A\u0639\u062A\u0642\u062F \u0623\u0646 \u0647\u0630\u0627 \u062E\u0637\u0623\u060C \u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064A\u0642 \u0627\u0644\u062F\u0639\u0645 \u2014 \u0623\u0648 \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u062A\u062D\u0648\u064A\u0644 \u062C\u062F\u064A\u062F.";
        } else if (data.request === "revoked") {
          intro = "\u062A\u0645 \u0625\u0644\u063A\u0627\u0621 \u0648\u0635\u0648\u0644\u0643 \u0625\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u0641\u064A\u062F\u064A\u0648. \u0625\u0630\u0627 \u0643\u0646\u062A \u062A\u0639\u062A\u0642\u062F \u0623\u0646 \u0647\u0630\u0627 \u062E\u0637\u0623\u060C \u062A\u0648\u0627\u0635\u0644 \u0645\u0639 \u0641\u0631\u064A\u0642 \u0627\u0644\u062F\u0639\u0645 \u2014 \u0623\u0648 \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u062A\u062D\u0648\u064A\u0644 \u062C\u062F\u064A\u062F.";
        } else if (data.expired) {
          intro = "\u0627\u0646\u062A\u0647\u062A \u0635\u0644\u0627\u062D\u064A\u0629 \u0648\u0635\u0648\u0644\u0643 \u0628\u062A\u0627\u0631\u064A\u062E " + data.expired + ". \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u062A\u062D\u0648\u064A\u0644 \u062C\u062F\u064A\u062F \u0644\u0644\u062A\u062C\u062F\u064A\u062F.";
        }
        var title = data.no_video
          ? "\u0647\u0630\u0627 \u0627\u0644\u062F\u0631\u0633 \u0645\u062A\u0627\u062D \u0644\u0644\u0637\u0644\u0627\u0628 \u0627\u0644\u0645\u0634\u062A\u0631\u0643\u064A\u0646 \u0641\u0642\u0637"
          : "\u0647\u0630\u0627 \u0627\u0644\u0641\u064A\u062F\u064A\u0648 \u0645\u062A\u0627\u062D \u0644\u0644\u0637\u0644\u0627\u0628 \u0627\u0644\u0645\u0634\u062A\u0631\u0643\u064A\u0646 \u0641\u0642\u0637";

        var input = el("input", {
          class: "vp-input",
          type: "text",
          dir: "auto",
          maxlength: "200",
          autocomplete: "off",
          placeholder: "\u0631\u0642\u0645 \u0627\u0644\u062A\u062D\u0648\u064A\u0644",
          "aria-label": "\u0631\u0642\u0645 \u0627\u0644\u062A\u062D\u0648\u064A\u0644",
        });
        var send = el("button", { class: "vp-btn", type: "button" }, ["\u0627\u0634\u062A\u0631\u0643"]);

        function submit() {
          var ref = input.value.trim();
          if (!ref) {
            say("\u0627\u0643\u062A\u0628 \u0631\u0642\u0645 \u0627\u0644\u062A\u062D\u0648\u064A\u0644 \u0623\u0648\u0644\u0627\u064B\u060C \u062D\u062A\u0649 \u064A\u062A\u0645\u0643\u0646 \u0641\u0631\u064A\u0642 \u0627\u0644\u062F\u0639\u0645 \u0645\u0646 \u0625\u064A\u062C\u0627\u062F \u0639\u0645\u0644\u064A\u0629 \u0627\u0644\u062F\u0641\u0639.", true);
            input.focus();
            return;
          }
          var s = getSession();
          if (!s) {
            load();
            return;
          }
          send.disabled = true;
          say("\u062C\u0627\u0631\u064A \u0627\u0644\u0625\u0631\u0633\u0627\u0644\u2026");
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

        box.appendChild(badge("lock"));
        box.appendChild(el("p", { class: "vp-title" }, [title]));
        box.appendChild(el("p", { class: "vp-text" }, [intro]));
        payBlock(box, data, true);
        box.appendChild(el("div", { class: "vp-form" }, [input, send]));
        box.appendChild(el("p", { class: "vp-hint" }, ["\u0631\u0642\u0645 \u0627\u0644\u0639\u0645\u0644\u064A\u0629\u060C \u0623\u0648 \u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062A\u0641 \u0627\u0644\u0630\u064A \u062D\u0648\u0651\u0644\u062A \u0645\u0646\u0647."]));
      });
    }

    function render(data, session) {
      if (!data.found) {
        // No video for this slot. The page's baked-in dev placeholder is redrawn as a
        // proper "coming soon" panel; anything else the page put there is restored as-is.
        if (!original.trim() || /placeholder|loading video|coming soon/i.test(original)) return showEmpty();
        clear();
        state = "none";
        slot.innerHTML = original;
        return;
      }
      if (data.embed_url) return showVideo(data, session);
      if (data.need === "payment") {
        return data.request === "pending" ? showPending(data) : showPayment(data, session);
      }
      if (data.need === "login") return showLogin(data);
      return showNoVideoYet(); // locked (lesson-wide), they already have access, nothing to show yet
    }

    function load() {
      var mine = ++seq;
      lastCheck = Date.now();
      var session = getSession();
      if (state === "init") {
        slot.textContent = "";
        slot.classList.add("vp-loading");
        slot.appendChild(el("div", { class: "vp-loading-box", role: "status", "aria-live": "polite" }, [
          el("div", { class: "vp-spinner" }),
          el("span", {}, ["Loading video\u2026"]),
        ]));
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
    for (var i = 0; i < slots.length; i++) {
      // A slot marked data-manual-mount (quiz.js, on quiz.html) decides for itself
      // when — or whether — to show this slot at all, tied to its own quiz-lock
      // check; auto-mounting it here would show/request the video before that
      // check has run. mountSlot stays available for that caller to use directly.
      if (slots[i].hasAttribute("data-manual-mount")) continue;
      mountSlot(slots[i]);
    }
  }

  window.VideoSlot = { mountAll: mountAll, mountSlot: mountSlot, slotInfo: slotInfo, icon: icon };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();