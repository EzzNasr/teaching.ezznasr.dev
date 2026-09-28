/* ==========================================================================
   subscribe.js — fills a grade page's <div id="subscriptions"> with the
   chapter/term subscription cards (see subscription-plan.md). This is the
   *new* student action, separate from the per-lesson "I paid" flow that
   video.js already handles — that one is unchanged.

   Which grade: read from the page path (.../baccalaureate/<grade>/...),
   or from data-subscribe-grade="<grade>" on the mount div if the page
   isn't under that path (e.g. previewing the section somewhere else).

   Draws, in order:
     - not signed in            -> short RTL prompt + "تسجيل الدخول" button
                                    (opens the corner sign-in modal, same
                                    as video.js's locked-video prompt; the
                                    panel reloads once a session appears)
     - signed in                -> get_subscription_options {grade, ...}
                                    one card per returned chapter, plus one
                                    card for the current term, each with a
                                    state:
                                      available       -> price + "اشتراك"
                                                          opens the payment
                                                          form for that card
                                      pending         -> "بانتظار موافقة
                                                          المعلم"
                                      owned           -> "مفعّل حتى <year_end>"
                                      covered_by_term -> "ضمن اشتراك الترم"
     - buying                   -> same payment-instructions block +
                                    reference field as video.js's paywall,
                                    then request_subscription, then the
                                    pending state. One open form at a time;
                                    the button disables while the request
                                    is in flight (one purchase per click).

   Approval is manual, always — there is no "instant unlock" here the way
   request_access sometimes returns status:"active"; a successful
   request_subscription always leaves the item pending until the teacher
   approves it in the dashboard.

   DRIVE_ENDPOINT is baked in by app_main.py's "Sync site assets", like
   assign.js/video.js. Its own CSS is injected here (class prefix "sp-")
   so this never depends on video.js having loaded on the same page.
   ========================================================================== */

(function () {
  "use strict";

  if (window.SubscriptionPanel) return; // loaded twice — the first copy already did the work

  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";
  var SESSION_KEY = "teaching_session";
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
      return Promise.reject(new Error("الاشتراكات غير مفعّلة بعد \u2014 برجاء إبلاغ المعلم."));
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
            throw new Error("الخادم أرسل ردًا غير متوقع. حاول مرة أخرى.");
          }
          if (!data || !data.ok) throw new Error((data && data.error) || "فشل تنفيذ الطلب.");
          return data;
        });
      },
      function () {
        throw new Error("تعذّر الاتصال بالخادم. تحقق من اتصال الإنترنت وحاول مرة أخرى.");
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

  // -- which grade is this? ------------------------------------------------

  function gradeFromRoot(root) {
    var override = root.getAttribute("data-subscribe-grade");
    if (override) return override;
    var parts = location.pathname.split("/").filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      if (/^grade-\d+-secondary$/.test(parts[i])) return parts[i];
    }
    return "";
  }

  // -- styles -------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById("sp-style")) return;
    var css =
      // This section is almost entirely Arabic (headings, buttons, badges, not just the
      // payment paragraph), so it uses Cairo throughout rather than the site's Latin sans.
      "#subscriptions{font-family:'Cairo',var(--sans,system-ui,sans-serif);color:var(--ink,#10233f);margin-top:12px}" +
      ".sp-panel{background:linear-gradient(180deg,var(--accent-soft,#dce9ff) 0%,var(--panel,#fff) 200px);" +
      "border:1px solid var(--line,#d6e1ef);border-radius:20px;padding:28px;" +
      "box-shadow:0 14px 32px rgba(16,35,63,.07)}" +
      ".sp-kicker{display:inline-block;background:var(--accent,#2f6fed);color:#fff;padding:5px 11px;" +
      "border-radius:999px;font:700 11px var(--mono,monospace);letter-spacing:.04em;margin-bottom:10px}" +
      "html[data-theme=\"dark\"] .sp-kicker{color:#0a1a32}" +
      ".sp-head{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:20px}" +
      ".sp-head h2{font-size:27px;letter-spacing:-.05em;margin:0}" +
      ".sp-head p{margin:6px 0 0;color:var(--ink-dim,#63738a);font-size:13px}" +
      ".sp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:17px;align-items:start}" +
      "@media(max-width:760px){.sp-grid{grid-template-columns:1fr}}" +
      // The card is a flip card: .sp-card is just the 3D perspective + hover-lift shell;
      // .sp-flip is what actually rotates; .sp-face-front/.sp-face-back are the two faces,
      // stacked in the same grid cell so the card's height is the taller of the two — a
      // longer title or a longer payment text simply makes that face (and so the whole
      // card) taller, never clipped.
      ".sp-card{position:relative;perspective:1400px;transition:transform .25s ease}" +
      ".sp-card:hover{transform:translateY(-5px)}" +
      ".sp-flip{position:relative;display:grid;min-height:148px;" +
      "transition:transform .5s cubic-bezier(.2,.8,.2,1);transform-style:preserve-3d}" +
      ".sp-flip.is-flipped{transform:rotateY(180deg)}" +
      ".sp-face{grid-area:1/1;padding:18px;display:flex;flex-direction:column;gap:10px;" +
      "justify-content:space-between;background:var(--panel,#fff);overflow-wrap:anywhere;" +
      "border:1px solid var(--line,#d6e1ef);border-radius:14px;box-shadow:0 10px 24px rgba(16,35,63,.07);" +
      "backface-visibility:hidden;-webkit-backface-visibility:hidden}" +
      ".sp-card:hover .sp-face{border-color:var(--accent,#2f6fed);box-shadow:0 17px 32px rgba(16,35,63,.14)}" +
      ".sp-face-back{transform:rotateY(180deg)}" +
      ".sp-face>div:first-child{display:flex;flex-direction:column;gap:10px}" +
      ".sp-face h3{margin:0;font-size:16px;line-height:1.3;overflow-wrap:anywhere}" +
      ".sp-price{font:700 15px var(--mono,monospace);color:var(--accent-strong,#2056bd)}" +
      ".sp-badge{align-self:flex-start;font:600 11px var(--mono,monospace);padding:4px 9px;border-radius:999px;" +
      "background:var(--accent-soft,#dce9ff);color:var(--accent-strong,#2056bd);overflow-wrap:anywhere}" +
      ".sp-badge.sp-badge-owned{background:var(--mint-soft,#d7f5e6);color:var(--mint-strong,#168a56)}" +
      ".sp-note{margin:0;color:var(--ink-dim,#63738a);font-size:13px;line-height:1.5;overflow-wrap:anywhere}" +
      ".sp-btn{padding:10px 16px;border-radius:10px;border:1px solid var(--accent,#2f6fed);" +
      "background:var(--accent,#2f6fed);color:#fff;font:inherit;font-weight:700;cursor:pointer;align-self:flex-start}" +
      'html[data-theme="dark"] .sp-btn{color:#0a1a32}' +
      ".sp-btn[disabled]{opacity:.6;cursor:default}" +
      ".sp-btn.sp-ghost{background:transparent;color:var(--accent,#2f6fed)}" +
      'html[data-theme="dark"] .sp-btn.sp-ghost{color:var(--accent-strong,#9fc2ff)}' +
      ".sp-empty{grid-column:1/-1;padding:24px;border:1px dashed var(--line-strong,#b8c9df);border-radius:14px;" +
      "color:var(--ink-dim,#63738a);background:var(--panel-soft,#eef4fb)}" +
      // Plain info boxes (signed-out prompt, error state) — same look as a card face, but no flip.
      ".sp-box{padding:18px;display:flex;flex-direction:column;gap:10px;background:var(--panel,#fff);" +
      "border:1px solid var(--line,#d6e1ef);border-radius:14px;box-shadow:0 10px 24px rgba(16,35,63,.07)}" +
      ".sp-form{display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box}" +
      ".sp-pay-ar{margin:0;width:100%;box-sizing:border-box;white-space:pre-line;line-height:1.8;" +
      "font-family:'Cairo',var(--sans,system-ui,sans-serif);font-size:14.5px;text-align:right;" +
      "color:var(--ink,#10233f);background:var(--panel-soft,#eef4fb);border:1px solid var(--line,#d6e1ef);" +
      "border-radius:10px;padding:12px 14px}" +
      ".sp-row{display:flex;gap:8px;flex-wrap:wrap}" +
      ".sp-input{flex:1 1 160px;min-width:0;padding:10px 12px;border-radius:10px;" +
      "border:1px solid var(--line-strong,#b8c9df);background:var(--panel,#fff);color:var(--ink,#10233f);font:inherit}" +
      ".sp-status{margin:0;font-size:12.5px;line-height:1.5;color:var(--ink-dim,#63738a)}" +
      ".sp-status:empty{display:none}" +
      ".sp-status.sp-error{color:var(--status-fail,#e2574c)}";
    var style = el("style", { id: "sp-style" });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // Payment instructions (.sp-pay-ar) are set in Cairo, same guard pattern as
  // video.js. If this fails to load (offline, blocked) the font-family falls
  // back to the site's normal sans-serif, so nothing breaks.
  function loadArabicFont() {
    if (document.getElementById("sp-font-cairo")) return;
    var link = el("link", {
      id: "sp-font-cairo",
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap",
    });
    document.head.appendChild(link);
  }

  // -- one grade page's Subscriptions section ------------------------------------

  function mount(root) {
    if (root.getAttribute("data-sp-mounted")) return;
    root.setAttribute("data-sp-mounted", "1");
    injectStyle();
    loadArabicFont(); // whole section is Cairo now, not just the payment paragraph — load it up front

    var grade = gradeFromRoot(root);
    var openForm = null; // the .sp-flip currently flipped open to its payment-details face, if any
    var panel = el("div", { class: "sp-panel" }); // a section of its own, distinct from the lesson grid above
    root.appendChild(panel);

    function clear() {
      openForm = null;
      while (panel.firstChild) panel.removeChild(panel.firstChild);
    }

    function head(subtitle) {
      panel.appendChild(
        el("div", { class: "sp-head" }, [
          el("div", {}, [
            el("span", { class: "sp-kicker" }, ["اشتراكات الفيديو"]),
            el("h2", {}, ["الاشتراكات"]),
            el("p", {}, [subtitle]),
          ]),
        ]),
      );
    }

    function showSignedOut() {
      clear();
      head("افتح دروس الفيديو باشتراك في فصل أو في الترم كاملاً.");
      var box = el("div", { class: "sp-box" });
      box.appendChild(el("p", { class: "sp-note" }, ["سجّل الدخول برقم هاتفك لعرض خيارات الاشتراك المتاحة لهذا الصف."]));
      var btn = el("button", { class: "sp-btn", type: "button" }, ["تسجيل الدخول"]);
      btn.addEventListener("click", function () {
        if (window.AuthEngine && typeof window.AuthEngine.openSignIn === "function") {
          window.AuthEngine.openSignIn();
        } else {
          btn.textContent = "استخدم زر تسجيل الدخول أعلى الصفحة";
          btn.disabled = true;
        }
      });
      box.appendChild(btn);
      panel.appendChild(box);
    }

    function showProblem(message) {
      clear();
      head("افتح دروس الفيديو باشتراك في فصل أو في الترم كاملاً.");
      var box = el("div", { class: "sp-box" });
      box.appendChild(el("p", { class: "sp-note sp-error" }, [message]));
      var retry = el("button", { class: "sp-btn sp-ghost", type: "button" }, ["إعادة المحاولة"]);
      retry.addEventListener("click", load);
      box.appendChild(retry);
      panel.appendChild(box);
    }

    // -- cards: a click on "اشتراك" flips the card over to show the payment details --------
    // Only one card is flipped open at a time; opening a second one flips the first back.

    function collapseForm() {
      if (openForm) openForm.classList.remove("is-flipped");
      openForm = null;
    }

    function stateBadge(state, yearEnd) {
      if (state === "owned") return el("span", { class: "sp-badge sp-badge-owned" }, ["مفعّل حتى " + yearEnd]);
      if (state === "pending") return el("span", { class: "sp-badge" }, ["بانتظار موافقة المعلم"]);
      if (state === "covered_by_term") return el("span", { class: "sp-badge sp-badge-owned" }, ["ضمن اشتراك الترم"]);
      return null;
    }

    // The back face: payment instructions, the reference field, and confirm/back buttons.
    function buildBackFace(item) {
      var back = el("div", { class: "sp-face sp-face-back" });
      var pay = el("p", { class: "sp-pay-ar" }, [item.pay_info || ""]);
      var input = el("input", {
        class: "sp-input",
        type: "text",
        dir: "auto",
        maxlength: "200",
        autocomplete: "off",
        placeholder: "رقم التحويل",
        "aria-label": "رقم التحويل",
      });
      var send = el("button", { class: "sp-btn", type: "button" }, ["اشترك"]);
      var back_btn = el("button", { class: "sp-btn sp-ghost", type: "button" }, ["\u2190 رجوع"]);
      var status = el("p", { class: "sp-status", role: "status", "aria-live": "polite" });

      function say(msg, isError) {
        status.textContent = msg || "";
        status.className = "sp-status" + (isError ? " sp-error" : "");
      }

      function submit() {
        var ref = input.value.trim();
        if (!ref) {
          say("اكتب رقم التحويل أولاً.", true);
          input.focus();
          return;
        }
        var s = getSession();
        if (!s) {
          load();
          return;
        }
        send.disabled = true;
        back_btn.disabled = true;
        say("جاري الإرسال\u2026");
        var payload = {
          action: "request_subscription",
          student_id: s.student_id,
          session_token: s.session_token,
          grade: grade,
          item_type: item.item_type,
          reference: ref,
        };
        if (item.item_type === "chapter") payload.chapter = item.chapter;
        else payload.term = item.term;
        call(payload).then(
          function () {
            load();
          },
          function (err) {
            send.disabled = false;
            back_btn.disabled = false;
            say(err.message, true);
            if (/session|log in|sign in|تسجيل/i.test(err.message)) load();
          },
        );
      }

      send.addEventListener("click", submit);
      back_btn.addEventListener("click", collapseForm);
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") submit();
      });

      back.appendChild(pay);
      back.appendChild(el("div", { class: "sp-row" }, [input, send, back_btn]));
      back.appendChild(status);
      return back;
    }

    function buildCard(item, session, yearEnd) {
      var card = el("div", { class: "sp-card" });
      var flip = el("div", { class: "sp-flip" });
      var front = el("div", { class: "sp-face sp-face-front" });
      var top = el("div", {}, [
        el("h3", {}, [item.title]),
        el("span", { class: "sp-price" }, [item.price + " جنيه"]),
      ]);
      var badge = stateBadge(item.state, yearEnd);
      if (badge) top.appendChild(badge);
      front.appendChild(top);
      flip.appendChild(front);
      if (item.state === "available") {
        var buy = el("button", { class: "sp-btn", type: "button" }, ["اشتراك"]);
        buy.addEventListener("click", function () {
          var wasOpen = flip === openForm;
          collapseForm();
          if (!wasOpen) {
            loadArabicFont();
            flip.classList.add("is-flipped");
            openForm = flip;
            var input = flip.querySelector(".sp-input");
            if (input) setTimeout(function () { input.focus(); }, 260); // after the flip settles
          }
        });
        front.appendChild(buy);
        flip.appendChild(buildBackFace(item));
      }
      card.appendChild(flip);
      return card;
    }

    function showOptions(data, session) {
      clear();
      head("افتح دروس الفيديو باشتراك في فصل أو في الترم كاملاً.");
      var grid = el("div", { class: "sp-grid" });
      var chapters = data.chapters || [];
      if (!chapters.length && !data.term) {
        grid.appendChild(
          el("div", { class: "sp-empty" }, ["لا توجد اشتراكات متاحة لهذا الصف حتى الآن."]),
        );
      }
      chapters.forEach(function (c) {
        grid.appendChild(
          buildCard(
            {
              item_type: "chapter",
              chapter: c.chapter,
              title: c.title || "Chapter " + c.chapter,
              price: c.price,
              state: c.state,
              pay_info: data.pay_info_chapter,
            },
            session,
            data.year_end,
          ),
        );
      });
      if (data.term) {
        grid.appendChild(
          buildCard(
            {
              item_type: "term",
              term: data.term.term,
              title: "اشتراك ترم كامل",
              price: data.term.price,
              state: data.term.state,
              pay_info: data.pay_info_term,
            },
            session,
            data.year_end,
          ),
        );
      }
      panel.appendChild(grid);
    }

    function load() {
      var session = getSession();
      if (!session) {
        showSignedOut();
        return;
      }
      if (!grade) return; // page not under a recognised grade folder — nothing to show
      clear();
      panel.appendChild(el("p", { class: "sp-note" }, ["جاري تحميل خيارات الاشتراك\u2026"]));
      call({
        action: "get_subscription_options",
        student_id: session.student_id,
        session_token: session.session_token,
        grade: grade,
      }).then(
        function (data) {
          // Code.gs answers signed_in:false for a stale/expired session (no error) — treat it as signed out.
          if (data.signed_in === false) showSignedOut();
          else showOptions(data, session);
        },
        function (err) {
          showProblem(err.message);
        },
      );
    }

    // Signed in or out in another tab.
    window.addEventListener("storage", function (e) {
      if (e.key === SESSION_KEY) load();
    });

    load();
  }

  function mountAll() {
    var root = document.getElementById("subscriptions");
    if (root) mount(root);
  }

  window.SubscriptionPanel = { mount: mount };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
