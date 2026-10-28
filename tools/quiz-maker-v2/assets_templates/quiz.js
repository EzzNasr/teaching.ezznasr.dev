/* ==========================================================================
   quiz.js — dependency-free MCQ engine for teaching.ezznasr.dev
   Renders into a container from a <script type="application/json"> block.
   Scoring is client-side. Results are queued into localStorage under
   "teaching_pending_submissions" so a future sync step can POST them.

   v2 change: the browser now remembers each student's *last* attempt per
   lesson (keyed by subject+lesson, stored under "teaching_last_attempt:"),
   and shows it on the start screen instead of forgetting on navigation —
   the actual gap that was reported. This is still per-browser, per-device
   (no server), same limitation as before, just no longer silently lost.

   Login (v2): the free-typed name/email start screen is gone. auth.js
   (must be loaded first — see quiz.html) gates entry with phone+password
   and hands back { student_id, student_name }; every answer now also
   carries the question's chapter, and the full question list (not just
   misses) is what gets recorded, so results can be aggregated by chapter.
   ========================================================================== */

(function () {
  "use strict";

  var QUEUE_KEY = "teaching_pending_submissions";
  var LAST_ATTEMPT_PREFIX = "teaching_last_attempt:";
  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";

  // Claims this page's media-slot for manual mounting (by mount(), below,
  // once the quiz-lock check has actually run) before video.js's own
  // auto-mount — which fires later, on DOMContentLoaded — can reach it.
  // Without this, a locked quiz's solution video would still load (and be
  // visible/inspectable) the instant the page opened, before quiz.js had
  // any chance to say no. quiz.js runs synchronously at parse time, ahead
  // of DOMContentLoaded, which is what makes the timing here reliable.
  (function () {
    var slot = document.querySelector(".media-slot");
    if (slot) slot.setAttribute("data-manual-mount", "1");
  })();

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      // null/undefined/false are skipped; DOM nodes pass through; anything else
      // (a number such as 0 or 123 that a Sheet cell turned into) is shown as
      // text instead of throwing inside appendChild.
      if (c === null || c === undefined || c === false) return;
      node.appendChild(
        typeof c === "object" && typeof c.nodeType === "number" ? c : document.createTextNode(String(c))
      );
    });
    return node;
  }

  // Unique id per attempt. The server refuses a second row with the same
  // client_id, so re-sending the same record (auto-retry below, or the
  // "Retry sending" button) can never create a duplicate.
  function newId() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  // Retries (same payload, same client_id) when the request never got a
  // usable answer: network drop / timeout, or Apps Script returning an
  // HTML page instead of JSON. Safe because the server dedupes on
  // client_id. A real server-side rejection ({ok:false}) is NOT retried —
  // with one exception: {ok:false, retryable:true} means the server's lock
  // was busy (a whole class saving at once). That is waited out for longer,
  // spread randomly so students don't all retry in the same second, and
  // onBusy() lets the page say "still saving" instead of showing an error.
  var RETRY_DELAYS = [1500, 4000];
  var BUSY_DELAYS = [2000, 5000, 10000, 20000];
  function postToDrive(payload, onBusy, tries) {
    tries = tries || { net: 0, busy: 0 };
    if (!DRIVE_ENDPOINT) return Promise.reject(new Error("not-configured"));
    function resendAfter(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); })
        .then(function () { return postToDrive(payload, onBusy, tries); });
    }
    function again(reason) {
      if (tries.net >= RETRY_DELAYS.length) throw reason;
      return resendAfter(RETRY_DELAYS[tries.net++]);
    }
    function busyAgain(reason) {
      if (tries.busy >= BUSY_DELAYS.length) throw reason;
      if (onBusy) { try { onBusy(); } catch (e) { /* display only */ } }
      return resendAfter(BUSY_DELAYS[tries.busy++] * (0.75 + Math.random() * 0.5));
    }
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    })
      .then(function (resp) { return resp.text(); })
      .then(function (raw) { return { raw: raw }; }, function () { return { netFail: true }; })
      .then(function (r) {
        if (r.netFail) return again(new Error("Couldn't reach the server."));
        var data;
        try {
          data = JSON.parse(r.raw);
        } catch (e) {
          return again(new Error("The server sent back something unexpected. Please try again."));
        }
        if (data && data.ok === false && data.retryable) {
          return busyAgain(new Error(data.error || "The server is busy right now. Please try again."));
        }
        if (!data || !data.ok) throw new Error((data && data.error) || "Drive bridge rejected the request.");
        return data;
      });
  }

  // A record leaves the queue the moment the server confirms it. Whatever is
  // still queued was never confirmed, and is re-sent by resendPending() below.
  function dequeueSubmission(clientId) {
    if (!clientId) return;
    try {
      var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      var keep = q.filter(function (r) { return !r || r.client_id !== clientId; });
      if (keep.length !== q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(keep));
    } catch (e) { /* storage unavailable - nothing to clean */ }
  }

  // Re-sends records that are still in the queue (the server never confirmed
  // them), for THIS student only, oldest first, at most MAX_RESEND per page
  // load. Same client_id as the first try, so a copy that did land is dropped
  // by the server and can never become a second row.
  var MAX_RESEND = 10;
  function pendingFor(studentId) {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]").filter(function (r) {
        return r && r.client_id && r.student_id && String(r.student_id) === String(studentId) &&
          (r.type === "assignment" || r.type === "quiz");
      }).slice(0, MAX_RESEND);
    } catch (e) { return []; }
  }
  function resendPending(session, notify) {
    var list = pendingFor(session.student_id);
    if (!list.length) return Promise.resolve(0);
    notify({ state: "sending", count: list.length });
    var sent = 0, failed = 0;
    return list.reduce(function (chain, rec) {
      return chain.then(function () {
        var action = rec.type === "quiz" ? "upload_quiz_result" : "upload_submission";
        return postToDrive(Object.assign({}, rec, { action: action })).then(
          function () { dequeueSubmission(rec.client_id); sent++; },
          function () { failed++; }
        );
      });
    }, Promise.resolve()).then(function () {
      notify({ state: failed ? "failed" : "done", sent: sent, failed: failed });
      return sent;
    });
  }
  // A one-line notice above the page while earlier unsent work is being re-sent.
  function showResendNotice(root, session) {
    if (!root.parentNode || !pendingFor(session.student_id).length) return;
    var box = el("div", { class: "qz-progress", role: "status", dir: "auto" }, []);
    root.parentNode.insertBefore(box, root);
    resendPending(session, function (s) {
      if (s.state === "sending") box.textContent = "\u0641\u064a \u0648\u0627\u062c\u0628 \u0644\u0633\u0647 \u0645\u0627 \u0627\u062a\u0628\u0639\u062a\u0634 \u2014 \u0628\u0646\u0628\u0639\u062a\u0647 \u062f\u0644\u0648\u0642\u062a\u064a\u2026 / Sending your earlier work\u2026";
      else if (s.state === "done") { box.textContent = "\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0648\u0627\u062c\u0628 \u2713 / Earlier work sent \u2713"; setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 6000); }
      else { box.className = "qz-error"; box.textContent = "\u0627\u0644\u0648\u0627\u062c\u0628 \u0644\u0633\u0647 \u0645\u0627 \u0627\u062a\u0628\u0639\u062a\u0634 \u2014 \u0647\u0646\u062d\u0627\u0648\u0644 \u062a\u0627\u0646\u064a \u0644\u0645\u0627 \u062a\u0641\u062a\u062d \u0623\u064a \u062f\u0631\u0633 / Earlier work hasn\u2019t been sent yet. It stays on this device and will retry next time you open a lesson page."; }
    });
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  // The full subject/[group/]slug lesson path, derived from the page URL —
  // same approach and same result as video.js's own slotInfo(), used here so
  // the quiz gate check (get_quiz_state / upload_quiz_result) matches the
  // identifier every admin_* lock action actually keys its sheets by. quiz.lesson
  // (from the embedded quiz data) is only ever the bare slug — see the note by
  // this function's one call site below and the matching note in Code.gs's
  // handleUploadQuizResult for why that's a different, intentionally-untouched
  // field.
  function fullLessonPath() {
    var parts = location.pathname.split("/").filter(Boolean).map(function (p) {
      try { return decodeURIComponent(p); } catch (e) { return p; }
    });
    var last = parts.length ? parts[parts.length - 1] : "";
    if (/\.html?$/i.test(last)) parts.pop();
    return parts.join("/");
  }

  function lastAttemptKey(quiz) {
    return LAST_ATTEMPT_PREFIX + (quiz.subject || "?") + ":" + (quiz.lesson || "?");
  }

  function loadLastAttempt(quiz) {
    try {
      var raw = localStorage.getItem(lastAttemptKey(quiz));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveLastAttempt(quiz, attempt) {
    try {
      localStorage.setItem(lastAttemptKey(quiz), JSON.stringify(attempt));
    } catch (e) {
      /* localStorage unavailable — nothing to recover here */
    }
  }

  function queueSubmission(payload) {
    try {
      var existing = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      existing.push(payload);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(existing));
    } catch (e) {
      /* localStorage unavailable — fail silently, nothing to recover here */
    }
  }

  // Normalizes every question into one shape regardless of source:
  // - legacy quizzes (no "type" field): the original {q, options, correct: int}
  // - new mcq/truefalse/match questions built via the shared Quiz Maker dialogs
  // "kind" drives which renderer runs: "single" keeps the classic
  // click-an-option-for-instant-feedback flow (legacy mcq AND true/false,
  // which is really just a 2-option single-choice question); "multi" and
  // "match" need an explicit Submit step since more than one input has to
  // be filled in before grading makes sense.
  function toChoiceForm(q) {
    if (!q.type) {
      return {
        kind: "single", type: "mcq", prompt: q.q, options: q.options,
        correctIndices: [q.correct], explain: q.explain, chapter: q.chapter,
      };
    }
    if (q.type === "truefalse") {
      return {
        kind: "single", type: "truefalse", prompt: q.prompt, options: ["True", "False"],
        correctIndices: [q.correct ? 0 : 1], explain: q.explain, chapter: q.chapter,
      };
    }
    if (q.type === "match") {
      return {
        kind: "match", type: "match", prompt: q.prompt, rows: q.rows, options: q.options,
        explain: q.explain, chapter: q.chapter,
      };
    }
    // mcq
    return {
      kind: q.correct.length > 1 ? "multi" : "single", type: "mcq", prompt: q.prompt,
      options: q.options, correctIndices: q.correct, explain: q.explain, chapter: q.chapter,
    };
  }

  // First option is always the unanswered placeholder, so a match row
  // can't be silently left at a default that happens to be correct.
  function buildSelect(options) {
    var sel = el("select", { class: "qz-select" }, [
      el("option", { value: "" }, ["Choose\u2026"]),
    ].concat(options.map(function (opt) { return el("option", { value: opt }, [opt]); })));
    return sel;
  }

  function mount(rootSelector, dataSelector) {
    var root = document.querySelector(rootSelector);
    var dataNode = document.querySelector(dataSelector);
    if (!root || !dataNode) return;

    // dataNode now holds metadata only (subject/lesson/title/question_count) —
    // never the questions themselves. Those come from the server (get_quiz),
    // and only when this viewer is actually allowed to see them: a locked quiz
    // used to still ship its full Q&A JSON in the page source, visible to
    // anyone regardless of what the on-screen "locked" message said. A page
    // generated before this change may still carry a legacy embedded
    // "questions" array here too; that's kept as a fallback ONLY for the
    // unlocked, nothing-synced-to-the-server-yet case below — never shown
    // while locked.
    var quiz;
    try {
      quiz = JSON.parse(dataNode.textContent);
    } catch (e) {
      root.textContent = "Quiz data could not be loaded.";
      return;
    }
    var legacyQuestions = quiz.questions || null;
    quiz.questions = null;

    if (!window.AuthEngine) {
      root.textContent = "Sign-in couldn't load. Refresh the page to try again.";
      return;
    }

    var mediaSlot = document.querySelector(".media-slot");

    window.AuthEngine.mount(rootSelector, function (session) {
      showResendNotice(root, session);
      checkGateThenStart(session);
    });

    // The quiz (and its solution video, if this page has one) can be locked
    // separately from its lesson (get_quiz / admin_set_quiz_lock in Code.gs) so
    // a teacher can open it right at test time. A lesson that has never been
    // gated is unaffected. get_quiz withholds the actual questions whenever
    // it says locked, so there is nothing for a locked page to leak via its
    // source — same as the video's own lock. A network error here fails OPEN
    // for the quiz using the legacy embedded copy if this page still has one
    // (older, not-yet-synced lessons) — the server still refuses the
    // submission if it's really locked, so nothing unlocks by accident — but
    // once a lesson's content lives only on the server, a network error
    // means there is nothing to fall back to, so that shows a plain "try
    // again" screen instead of silently starting a quiz with no questions.
    function checkGateThenStart(session) {
      root.innerHTML = "";
      root.appendChild(el("p", { class: "qz-lede" }, ["Checking\u2026"]));
      postToDrive({ action: "get_quiz", lesson: fullLessonPath(), student_id: session.student_id })
        .then(
          function (data) {
            if (data && data.locked) { renderLocked(session); return; }
            var loaded = (data && data.quiz && data.quiz.questions) || legacyQuestions || null;
            if (!loaded || !loaded.length) { renderLoadError(session); return; }
            quiz.questions = loaded;
            // Server-stamped: while true the questions carry NO answers and the server grades.
            quiz.deferred = !!(data && data.quiz && data.quiz.deferred);
            if (mediaSlot && window.VideoSlot) window.VideoSlot.mountSlot(mediaSlot);
            if (quiz.deferred) startDeferredQuiz(session); else startQuiz(session);
          },
          function () {
            if (legacyQuestions && legacyQuestions.length) {
              quiz.questions = legacyQuestions;
              startQuiz(session);
            } else {
              renderLoadError(session);
            }
          }
        );
    }

    function renderLoadError(session) {
      root.innerHTML = "";
      var retry = el("button", { class: "qz-next", type: "button" }, ["Try again"]);
      retry.addEventListener("click", function () { checkGateThenStart(session); });
      root.appendChild(el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["Couldn't load the quiz"]),
        el("p", { class: "qz-lede" }, ["Check your connection and try again."]),
        el("div", { class: "qz-actions" }, [retry]),
      ]));
    }

    function renderLocked(session) {
      root.innerHTML = "";
      var retry = el("button", { class: "qz-next", type: "button" }, ["Check again"]);
      retry.addEventListener("click", function () { checkGateThenStart(session); });
      root.appendChild(el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, ["Quiz locked"]),
        el("p", { class: "qz-lede" }, ["This quiz isn't open yet. Your teacher will unlock it when it's time."]),
        el("div", { class: "qz-actions" }, [retry]),
      ]));
      // Nothing about the solution video is requested from the server while the
      // quiz itself is locked — showing it would defeat the point of the gate.
      if (mediaSlot) {
        mediaSlot.setAttribute("data-vp-mounted", "1"); // keeps video.js from mounting it later on this load
        mediaSlot.innerHTML = "";
        mediaSlot.classList.add("vp-panel", "is-locked");
        var lockIcon = window.VideoSlot && window.VideoSlot.icon ? window.VideoSlot.icon("lock") : null;
        mediaSlot.appendChild(el("div", { class: "vp-box" }, [
          lockIcon ? el("div", { class: "vp-icon-badge", "aria-hidden": "true" }, [lockIcon]) : null,
          el("p", { class: "vp-title" }, ["Solution video locked"]),
          el("p", { class: "vp-text" }, ["It becomes available once this quiz is open and you\u2019ve finished it."]),
        ]));
      }
    }

    // ======================================================================
    // Deferred-answers mode (Phase 2). Used only when the server stamps
    // quiz.deferred = true (FF_DEFERRED_ANSWERS). The questions arrive WITHOUT
    // answers or explanations; the student answers everything, submits once,
    // the server grades, and only then does the page show what was right and
    // wrong (get_quiz_review). "Written" questions are answered with photos
    // (capture.js, loaded on demand). Legacy mode above/below is untouched.
    // ======================================================================
    var deferredCssDone = false;
    function injectDeferredCss() {
      if (deferredCssDone) return;
      deferredCssDone = true;
      var st = document.createElement("style");
      st.textContent =
        ".qz-option--picked{border-color:var(--accent,#2563eb);background:var(--panel,var(--panel-soft))}" +
        ".qz-option--picked .qz-option__tag{color:var(--accent-strong,var(--accent,#2563eb))}" +
        ".qz-verdict__tag--pending{color:var(--ink-dim,#666)}" +
        ".qz-review__item{margin:0 0 18px;padding-bottom:14px;border-bottom:1px dashed var(--line,#ccc)}" +
        ".qz-review__line{font-size:14.5px;margin:4px 0;overflow-wrap:anywhere}" +
        ".qz-nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}";
      document.head.appendChild(st);
    }

    function loadCapture() {
      if (window.TeachingCapture) return Promise.resolve(window.TeachingCapture);
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = "/assets/capture.js?v=1";
        s.onload = function () { window.TeachingCapture ? resolve(window.TeachingCapture) : reject(new Error("camera tools missing")); };
        s.onerror = function () { reject(new Error("Couldn't load the camera tools. Check your connection and refresh the page.")); };
        document.head.appendChild(s);
      });
    }

    function startDeferredQuiz(session) {
      injectDeferredCss();
      var lessonPath = fullLessonPath();
      var draftKey = "teaching_quiz_draft:" + session.student_id + ":" + lessonPath;
      var qs = quiz.questions;
      var st = {
        phase: "start",          // start | quiz | sending | sendfail | review
        index: 0, answers: {}, clientId: null, startTime: null,
        widgets: {},             // qid -> capture widget (kept across navigation)
        error: "", busy: false, review: null, draft: null,
      };

      function loadDraft() {
        try { var d = JSON.parse(localStorage.getItem(draftKey) || "null"); return d && d.clientId && d.answers ? d : null; } catch (e) { return null; }
      }
      function saveDraft() {
        try { localStorage.setItem(draftKey, JSON.stringify({ clientId: st.clientId, startTime: st.startTime, index: st.index, answers: st.answers })); } catch (e) { /* no storage: no draft */ }
      }
      function clearDraft() { try { localStorage.removeItem(draftKey); } catch (e) { /* ignore */ } }
      function post(payload, onBusy) {
        return postToDrive(Object.assign({ student_id: session.student_id, session_token: session.session_token }, payload), onBusy);
      }

      st.draft = loadDraft();
      render();

      function render() {
        root.innerHTML = "";
        if (st.phase === "start") return renderStartD();
        if (st.phase === "review") return renderReview();
        if (st.phase === "sending" || st.phase === "sendfail") return renderSending();
        renderQuestionD();
      }

      function card(children) {
        return el("div", { class: "qz-card frame" }, [el("span", { class: "tick-br" }), el("span", { class: "tick-bl" })].concat(children));
      }

      function renderStartD() {
        var kids = [
          el("p", { class: "qz-question" }, [quiz.title ? (quiz.title + " — before you start") : "Before you start"]),
          el("div", { class: "qz-verdict" }, [el("span", { class: "qz-verdict__explain" }, ["Signed in as " + session.student_name])]),
          el("div", { class: "qz-verdict" }, [el("span", { class: "qz-verdict__explain" },
            ["Answer every question, then submit once. You'll see which answers were right or wrong after you submit."])]),
        ];
        var actions = el("div", { class: "qz-actions" });
        if (st.draft) {
          var resume = el("button", { class: "qz-next", type: "button" }, ["Resume where you stopped →"]);
          resume.addEventListener("click", function () {
            st.clientId = st.draft.clientId; st.startTime = st.draft.startTime; st.answers = st.draft.answers || {};
            st.index = Math.min(Math.max(0, st.draft.index || 0), qs.length - 1); st.phase = "quiz"; render();
          });
          var fresh = el("button", { class: "qz-retry", type: "button" }, ["Start over"]);
          fresh.addEventListener("click", function () { clearDraft(); st.draft = null; begin(); });
          actions.appendChild(resume); actions.appendChild(fresh);
        } else {
          var go = el("button", { class: "qz-next", type: "button" }, ["Begin quiz →"]);
          go.addEventListener("click", begin);
          actions.appendChild(go);
        }
        kids.push(actions);
        root.appendChild(card(kids));
      }

      function begin() {
        st.startTime = new Date().toISOString(); st.clientId = newId();
        st.answers = {}; st.index = 0; st.phase = "quiz"; st.error = "";
        saveDraft(); render();
      }

      function answered(q) {
        var v = st.answers[q._i];
        if (q.type === "written") return true;
        if (q.type === "match") return Array.isArray(v) && v.length === q.rows.length && v.every(function (x) { return x; });
        if (q.multi) return Array.isArray(v) && v.length > 0;
        return typeof v === "number";
      }

      function leave(q) { var w = q && st.widgets[q.qid]; if (w) w.stop(); }

      function renderQuestionD() {
        var q = qs[st.index];
        var body = el("div", { class: "qz-options" });
        var nextBtn = el("button", { class: "qz-next", type: "button" }, [st.index + 1 >= qs.length ? "Submit quiz →" : "Next →"]);
        function refresh() { nextBtn.disabled = !answered(q); }

        if (q.type === "match") {
          var cur = Array.isArray(st.answers[q._i]) ? st.answers[q._i].slice() : q.rows.map(function () { return ""; });
          q.rows.forEach(function (row, k) {
            var sel = buildSelect(q.options);
            sel.value = cur[k] || "";
            sel.addEventListener("change", function () { cur[k] = sel.value; st.answers[q._i] = cur.slice(); saveDraft(); refresh(); });
            body.appendChild(el("div", { class: "qz-graded-row" }, [el("span", { class: "qz-graded-row__label" }, [row.label]), sel]));
          });
        } else if (q.type === "written") {
          body.appendChild(el("p", { class: "qz-lede" }, ["Write your answer on paper, then take a clear photo of it" +
            (q.max_marks ? " (" + q.max_marks + " mark" + (q.max_marks > 1 ? "s" : "") + ")" : "") + "."]));
          var slot = el("div", {}, [el("p", { class: "qz-progress" }, ["Loading camera tools…"])]);
          body.appendChild(slot);
          if (st.widgets[q.qid]) { slot.innerHTML = ""; slot.appendChild(st.widgets[q.qid].el); }
          else {
            loadCapture().then(function (cap) {
              if (!st.widgets[q.qid]) st.widgets[q.qid] = cap.createWidget({ key: draftKey + ":" + q.qid, max: q.max_images || 3 });
              slot.innerHTML = ""; slot.appendChild(st.widgets[q.qid].el);
            }, function (e) { slot.innerHTML = ""; slot.appendChild(el("div", { class: "qz-error" }, [e.message])); });
          }
        } else if (q.multi) {
          var picks = Array.isArray(st.answers[q._i]) ? st.answers[q._i].slice() : [];
          q.options.forEach(function (opt, i) {
            var cb = el("input", { type: "checkbox", value: String(i) });
            cb.checked = picks.indexOf(i) !== -1;
            cb.addEventListener("change", function () {
              picks = picks.filter(function (x) { return x !== i; });
              if (cb.checked) picks.push(i);
              st.answers[q._i] = picks.slice().sort(); saveDraft(); refresh();
            });
            body.appendChild(el("div", { class: "qz-graded-row" }, [el("label", { class: "qz-graded-check" }, [cb, " " + opt])]));
          });
          body.insertBefore(el("p", { class: "qz-lede" }, ["Select all that apply."]), body.firstChild);
        } else {
          q.options.forEach(function (opt, i) {
            var btn = el("button", { class: "qz-option" + (st.answers[q._i] === i ? " qz-option--picked" : ""), type: "button" }, [
              el("span", { class: "qz-option__tag" }, [String.fromCharCode(65 + i)]), el("span", {}, [opt]),
            ]);
            btn.addEventListener("click", function () {
              st.answers[q._i] = i; saveDraft();
              Array.prototype.forEach.call(body.children, function (c, j) { c.classList.toggle("qz-option--picked", j === i); });
              refresh();
            });
            body.appendChild(btn);
          });
        }

        var nav = el("div", { class: "qz-nav" });
        if (st.index > 0) {
          var back = el("button", { class: "qz-retry", type: "button" }, ["← Back"]);
          back.addEventListener("click", function () { leave(q); st.index--; saveDraft(); render(); });
          nav.appendChild(back);
        }
        nextBtn.addEventListener("click", function () {
          leave(q);
          if (st.index + 1 >= qs.length) { st.error = ""; submitD(); return; }
          st.index++; saveDraft(); render();
        });
        nav.appendChild(nextBtn);
        refresh();

        root.appendChild(el("div", { class: "qz-progress" }, ["Question " + (st.index + 1) + " of " + qs.length]));
        root.appendChild(card([
          el("p", { class: "qz-question", html: q.prompt }),
          body,
          st.error ? el("div", { class: "qz-error" }, [st.error]) : null,
          nav,
        ]));
      }

      // 1) the answers, 2) photos for every written question (best effort), 3) the review.
      // The answers go first: a refused or failed photo can never stop them being saved.
      // The server pairs a photo with its answers by attempt_id, so the order is free.
      function submitD() {
        st.phase = "sending"; st.busy = false; st.photosLater = 0; render();
        sendAnswers();
      }

      function sendPhotos() {
        var failed = 0;
        var written = qs.filter(function (q) { return q.type === "written" && st.widgets[q.qid]; });
        return written.reduce(function (chain, q) {
          return chain.then(function () {
            return st.widgets[q.qid].upload(function (item, b64) {
              return post({ action: "upload_written_image", kind: "quiz", lesson_path: lessonPath, attempt_id: st.clientId,
                            question_id: q.qid, image_id: item.id, data_base64: b64, mime_type: "image/jpeg" }, function () { st.busy = true; });
            }).then(function (r) { if (!r || !r.ok) failed++; }, function () { failed++; });
          });
        }, Promise.resolve()).then(function () { st.photosLater = failed; return failed; });
      }

      function sendAnswers() {
        if (!st.endTime) st.endTime = new Date().toISOString();
        var record = {
          action: "upload_quiz_result", type: "quiz", client_id: st.clientId,
          subject: quiz.subject || null, lesson: quiz.lesson || null, lesson_path: lessonPath, quiz_title: quiz.title || null,
          name: session.student_name, email: null, date: isoDate(new Date(st.startTime)), start_time: st.startTime, end_time: st.endTime,
          answers: qs.map(function (q) { var v = st.answers[q._i]; return { i: q._i, v: v === undefined ? null : v }; }),
        };
        st.phase = "sending"; st.error = ""; render();
        return post(record, function () { st.busy = true; render(); }).then(function () {
          saveLastAttempt(quiz, { date: record.date, pending: true });   // unlocks the solution video on this page
          return sendPhotos().then(function () { return fetchReview(); });
        }, function (err) {
          st.phase = "sendfail"; st.error = (err && err.message) || "Couldn't reach the server."; st.sendStep = "answers"; render();
        });
      }

      function fetchReview() {
        return post({ action: "get_quiz_review", lesson_path: lessonPath, client_id: st.clientId }).then(function (data) {
          st.review = data.review;
          saveLastAttempt(quiz, { score: data.review.score, total: data.review.total, date: isoDate(new Date(st.startTime)) });
          clearDraft();
          // Photos that did not go through stay on this device (and in the widgets) so they can be re-sent.
          if (!st.photosLater) { Object.keys(st.widgets).forEach(function (k) { st.widgets[k].clear(); }); st.widgets = {}; }
          st.phase = "review"; render();
        }, function (err) {
          st.phase = "sendfail"; st.error = (err && err.message) || "Couldn't load your answers."; st.sendStep = "review"; render();
        });
      }

      function renderSending() {
        var kids = [];
        if (st.phase === "sending") {
          kids.push(el("p", { class: "qz-question" }, ["Submitting…"]));
          kids.push(el("div", { class: "qz-progress" }, [st.busy ? "Still saving — lots of results are coming in. Please keep this page open…" : "Sending your answers and photos. Please keep this page open."]));
        } else {
          kids.push(el("p", { class: "qz-question" }, [st.sendStep === "review" ? "Submitted — couldn't load your answers yet" : "Couldn't submit yet"]));
          kids.push(el("div", { class: "qz-error" }, [st.error]));
          var retry = el("button", { class: "qz-next", type: "button" }, [st.sendStep === "review" ? "Show my answers" : "Retry sending"]);
          retry.addEventListener("click", function () { if (st.sendStep === "review") { st.phase = "sending"; render(); fetchReview(); } else sendAnswers(); });
          kids.push(el("div", { class: "qz-actions" }, [retry]));
        }
        root.appendChild(card(kids));
      }

      function renderReview() {
        var rv = st.review, total = rv.total || 0;
        var pct = total ? Math.round((rv.score / total) * 100) : 0;
        var kids = [
          el("div", { class: "qz-summary__score" }, [rv.score + " / " + total]),
          el("div", { class: "qz-summary__label" }, [pct + "% · " + session.student_name + (rv.pending ? " · " + rv.pending + " answer" + (rv.pending > 1 ? "s" : "") + " waiting for your teacher to grade" : "")]),
        ];
        if (st.photosLater) {
          var again = el("button", { class: "qz-next", type: "button" }, ["Send photos again"]);
          again.addEventListener("click", function () {
            again.disabled = true; again.textContent = "Sending\u2026";
            sendPhotos().then(function () { return fetchReview(); });
          });
          kids.push(el("div", { class: "qz-error", dir: "auto" }, ["\u062a\u0645 \u062d\u0641\u0638 \u0625\u062c\u0627\u0628\u0627\u062a\u0643 \u2713 \u0627\u0644\u0635\u0648\u0631\u0629 \u0647\u062a\u062a\u0628\u0639\u062a \u0628\u0639\u062f\u064a\u0646. / Your answers are saved. " + st.photosLater + " photo answer" + (st.photosLater > 1 ? "s" : "") + " didn\u2019t go through yet."]));
          kids.push(again);
        }
        rv.items.forEach(function (it, k) {
          var tagText = it.status === "correct" ? "Correct" : it.status === "pending" ? "Pending grading"
            : it.status === "graded" ? (it.awarded + " / " + it.max) : "Not quite";
          var tagClass = it.status === "correct" || (it.status === "graded" && it.is_correct) ? "pass" : it.status === "pending" ? "pending" : "fail";
          var lines = [];
          if (it.type === "written") {
            lines.push(el("div", { class: "qz-review__line" }, ["Your answer: ", it.your_answer || "no photo attached"]));
            if (it.note) lines.push(el("div", { class: "qz-review__line" }, ["Teacher’s note: ", it.note]));
          } else {
            lines.push(el("div", { class: "qz-review__line" }, ["Your answer: ", it.your_answer || "—"]));
            if (it.status !== "correct") lines.push(el("div", { class: "qz-review__line" }, ["Correct answer: ", it.correct_answer]));
          }
          if (it.explain) lines.push(el("span", { class: "qz-verdict__explain" }, [it.explain]));
          kids.push(el("div", { class: "qz-review__item" }, [
            el("p", { class: "qz-question", html: (k + 1) + ". " + it.question }),
            el("span", { class: "qz-verdict__tag qz-verdict__tag--" + tagClass }, [tagText]),
          ].concat(lines)));
        });
        kids.push(el("div", { class: "qz-nav" }, [
          el("a", { class: "qz-retry", href: "/dashboard/student.html", style: "text-decoration:none" }, ["My mistakes in the dashboard"]),
          (function () {
            var again = el("button", { class: "qz-retry", type: "button" }, ["Try again"]);
            again.addEventListener("click", function () {
              st.phase = "start"; st.review = null; st.answers = {}; st.index = 0; st.clientId = null; st.startTime = null; st.endTime = null; st.draft = null; render();
            });
            return again;
          })(),
        ]));
        root.appendChild(el("div", { class: "qz-summary frame" }, [el("span", { class: "tick-br" }), el("span", { class: "tick-bl" })].concat(kids)));
      }
    }

    function startQuiz(session) {
      var state = {
        index: 0,
        score: 0,
        started: false,
        finished: false,
        studentId: session.student_id,
        studentName: session.student_name,
        startTime: null,
        endTime: null,
        answers: [], // { question, chosen, correct_answer, is_correct, chapter }
        clientId: null, // one id per attempt — lets the server drop re-sent copies
        record: null,   // the finished attempt, kept so it can be re-sent
        syncStatus: null, // null | "pending" | "ok" | "failed" | "not-configured"
      };

      render();

      function render() {
        root.innerHTML = "";
        if (!state.started) { renderStart(); return; }
        if (state.index >= quiz.questions.length) { renderSummary(); return; }
        renderQuestion();
      }

      function renderStart() {
        var errorMsg = el("div", { class: "qz-error" });

        var beginBtn = el("button", { class: "qz-next", type: "button" }, ["Begin quiz \u2192"]);
        beginBtn.addEventListener("click", function () {
          state.startTime = new Date().toISOString();
          state.clientId = newId();
          state.started = true;
          render();
        });

        var cardChildren = [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("p", { class: "qz-question" }, [quiz.title ? (quiz.title + " — before you start") : "Before you start"]),
          el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__explain" }, ["Signed in as " + state.studentName]),
          ]),
        ];

        var last = loadLastAttempt(quiz);
        if (last && typeof last.score === "number" && typeof last.total === "number") {
          var pct = last.total ? Math.round((last.score / last.total) * 100) : 0;
          var whenLabel = last.date ? " \u00b7 " + last.date : "";
          cardChildren.push(el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__tag qz-verdict__tag--pass" }, ["Last attempt"]),
            el("span", { class: "qz-verdict__explain" }, [
              last.score + " / " + last.total + " (" + pct + "%)" + whenLabel +
              ". Starting again will record a new attempt."
            ]),
          ]));
        }

        cardChildren.push(errorMsg);
        cardChildren.push(el("div", { class: "qz-actions" }, [beginBtn]));

        var card = el("div", { class: "qz-card frame" }, cardChildren);
        root.appendChild(card);
      }

      function recordAnswer(q, isCorrect, chosenText, correctText) {
        if (isCorrect) state.score++;
        state.answers.push({
          question: q.prompt,
          type: q.type,
          chosen: chosenText,
          correct_answer: correctText,
          is_correct: isCorrect,
          chapter: (typeof q.chapter !== "undefined") ? q.chapter : null,
        });
      }

      function showVerdict(card, correct, explain) {
        card.appendChild(el("div", { class: "qz-verdict" }, [
          el("span", { class: correct ? "qz-verdict__tag qz-verdict__tag--pass" : "qz-verdict__tag qz-verdict__tag--fail" },
            [correct ? "Correct" : "Not quite"]),
          explain ? el("span", { class: "qz-verdict__explain" }, [explain]) : null,
        ]));
      }

      function appendNextButton(actions) {
        var isLast = state.index + 1 >= quiz.questions.length;
        var nextBtn = el("button", { class: "qz-next", type: "button" }, [isLast ? "See score \u2192" : "Next \u2192"]);
        nextBtn.addEventListener("click", function () {
          if (isLast && !state.endTime) state.endTime = new Date().toISOString();
          state.index++;
          render();
        });
        actions.appendChild(nextBtn);
      }

      // Legacy mcq (single correct answer) and true/false both render as
      // click-an-option-for-instant-feedback — true/false is really just
      // a 2-option single-choice question, so it reuses this unchanged.
      function renderSingleChoice(q, card, optionsWrap, actions) {
        var answered = false;
        q.options.forEach(function (opt, i) {
          var btn = el("button", { class: "qz-option", type: "button" }, [
            el("span", { class: "qz-option__tag" }, [String.fromCharCode(65 + i)]),
            el("span", {}, [opt]),
          ]);
          btn.addEventListener("click", function () {
            if (answered) return;
            answered = true;

            var correct = q.correctIndices.indexOf(i) !== -1;
            recordAnswer(q, correct, opt, q.options[q.correctIndices[0]]);

            Array.prototype.forEach.call(optionsWrap.children, function (child, j) {
              child.disabled = true;
              if (q.correctIndices.indexOf(j) !== -1) child.classList.add("qz-option--correct");
              else if (j === i) child.classList.add("qz-option--incorrect");
            });

            showVerdict(card, correct, q.explain);
            appendNextButton(actions);
          });
          optionsWrap.appendChild(btn);
        });
      }

      // "Select all that apply" mcq — needs an explicit Submit since
      // grading only makes sense once every checkbox has been decided.
      function renderMultiChoice(q, card, optionsWrap, actions) {
        var checks = q.options.map(function (opt) {
          var cb = el("input", { type: "checkbox", value: opt });
          var label = el("label", { class: "qz-graded-check" }, [cb, " " + opt]);
          optionsWrap.appendChild(el("div", { class: "qz-graded-row" }, [label]));
          return { opt: opt, cb: cb, label: label };
        });
        var errorMsg = el("div", { class: "qz-error" });
        var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Submit answer \u2192"]);
        submitBtn.addEventListener("click", function () {
          if (!checks.some(function (c) { return c.cb.checked; })) {
            errorMsg.textContent = "Choose at least one option.";
            return;
          }
          submitBtn.disabled = true;
          checks.forEach(function (c) { c.cb.disabled = true; });

          var chosenOpts = checks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.opt; });
          var correctOpts = q.correctIndices.map(function (i) { return q.options[i]; });
          var isCorrect = chosenOpts.length === correctOpts.length &&
            chosenOpts.slice().sort().every(function (v, i) { return v === correctOpts.slice().sort()[i]; });

          checks.forEach(function (c) {
            var shouldBeChecked = correctOpts.indexOf(c.opt) !== -1;
            if (shouldBeChecked || c.cb.checked) {
              c.label.classList.add(shouldBeChecked ? "qz-graded-check--correct" : "qz-graded-check--incorrect");
            }
          });

          recordAnswer(q, isCorrect, chosenOpts.join(", "), correctOpts.join(", "));
          showVerdict(card, isCorrect, q.explain);
          actions.removeChild(submitBtn);
          appendNextButton(actions);
        });
        actions.appendChild(errorMsg);
        actions.appendChild(submitBtn);
      }

      // Matching — one dropdown per row, all graded together on Submit.
      // Scored as one all-or-nothing question (matches the "Score X/N
      // questions" progress line elsewhere), not per-row.
      function renderMatchChoice(q, card, optionsWrap, actions) {
        var rowSelects = q.rows.map(function (row) {
          var sel = buildSelect(q.options);
          var rowEl = el("div", { class: "qz-graded-row" }, [
            el("span", { class: "qz-graded-row__label" }, [row.label]),
            sel,
          ]);
          optionsWrap.appendChild(rowEl);
          return { select: sel, rowEl: rowEl };
        });
        var errorMsg = el("div", { class: "qz-error" });
        var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Submit answer \u2192"]);
        submitBtn.addEventListener("click", function () {
          if (rowSelects.some(function (r) { return r.select.value === ""; })) {
            errorMsg.textContent = "Match every row before submitting.";
            return;
          }
          submitBtn.disabled = true;
          rowSelects.forEach(function (r) { r.select.disabled = true; });

          var allCorrect = true;
          var chosenParts = [], correctParts = [];
          q.rows.forEach(function (row, i) {
            var chosen = rowSelects[i].select.value;
            var ok = chosen === row.correct;
            if (!ok) allCorrect = false;
            chosenParts.push(row.label + ": " + chosen);
            correctParts.push(row.label + ": " + row.correct);
            rowSelects[i].rowEl.classList.add(ok ? "qz-graded-row--correct" : "qz-graded-row--incorrect");
          });

          recordAnswer(q, allCorrect, chosenParts.join("; "), correctParts.join("; "));
          showVerdict(card, allCorrect, q.explain);
          actions.removeChild(submitBtn);
          appendNextButton(actions);
        });
        actions.appendChild(errorMsg);
        actions.appendChild(submitBtn);
      }

      function renderQuestion() {
        var q = toChoiceForm(quiz.questions[state.index]);

        var progress = el("div", { class: "qz-progress" }, [
          "Question " + (state.index + 1) + " of " + quiz.questions.length +
          "  \u00b7  Score " + state.score + "/" + state.index,
        ]);

        var questionEl = el("p", { class: "qz-question", html: q.prompt });
        var optionsWrap = el("div", { class: "qz-options" });
        var actions = el("div", { class: "qz-actions" });

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          questionEl,
          optionsWrap,
          actions,
        ]);

        if (q.kind === "single") renderSingleChoice(q, card, optionsWrap, actions);
        else if (q.kind === "multi") renderMultiChoice(q, card, optionsWrap, actions);
        else renderMatchChoice(q, card, optionsWrap, actions);

        root.appendChild(progress);
        root.appendChild(card);
      }

      // Posts state.record. Safe to call again for the same attempt (retry
      // button): same client_id, so the server ignores it if the first try
      // actually landed.
      function sendResult() {
        state.syncStatus = "pending";
        state.busy = false;
        // The server says "busy" when many students save at once; the send is
        // repeated automatically (same client_id, so never a duplicate) and the
        // page just says it is still saving.
        postToDrive(Object.assign({ action: "upload_quiz_result" }, state.record), function () { state.busy = true; render(); })
          .then(function () { state.busy = false; state.syncStatus = "ok"; dequeueSubmission(state.record.client_id); render(); })
          .catch(function (err) {
            state.busy = false;
            state.syncStatus = (err && err.message === "not-configured") ? "not-configured" : "failed";
            render();
          });
      }

      function renderSummary() {
        if (!state.finished) {
          state.finished = true;
          if (!state.endTime) state.endTime = new Date().toISOString();

          // Full question list (v2 record shape), not just misses — lets
          // grading aggregate by chapter later. wrong_questions is still
          // sent alongside for Code.gs instances that haven't picked up
          // the v2 handler yet.
          var allQuestions = state.answers.map(function (a) {
            return {
              question: a.question,
              type: a.type,
              your_answer: a.chosen,
              correct_answer: a.correct_answer,
              is_correct: a.is_correct,
              chapter: a.chapter,
            };
          });
          var wrongQuestions = state.answers
            .filter(function (a) { return !a.is_correct; })
            .map(function (a) {
              return { question: a.question, your_answer: a.chosen, correct_answer: a.correct_answer };
            });

          var record = {
            type: "quiz",
            client_id: state.clientId,
            subject: quiz.subject || null,
            lesson: quiz.lesson || null,
            lesson_path: fullLessonPath(),   // for the quiz-gate re-check server-side — see the note above fullLessonPath()
            quiz_title: quiz.title || null,
            student_id: state.studentId,
            name: state.studentName,
            email: null,
            date: isoDate(new Date(state.startTime)),
            start_time: state.startTime,
            end_time: state.endTime,
            score: state.score,
            total: quiz.questions.length,
            questions: allQuestions,
            wrong_questions: wrongQuestions,
          };

          queueSubmission(record);
          saveLastAttempt(quiz, record);
          state.record = record;
          sendResult();
        }

        var total = quiz.questions.length;
        var pct = total ? Math.round((state.score / total) * 100) : 0;
        var summaryChildren = [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__score" }, [state.score + " / " + total]),
          el("div", { class: "qz-summary__label" }, [pct + "% correct \u00b7 " + state.studentName]),
        ];
        // Matches assign.js's existing wording/tone for the same two cases,
        // so a student sees consistent language whether it's a quiz or an
        // assignment that didn't make it to the server.
        if (state.syncStatus === "not-configured") {
          summaryChildren.push(el("div", { class: "qz-error" }, [
            "Saved on this device. Result delivery isn't fully set up yet \u2014 let your instructor know.",
          ]));
        } else if (state.syncStatus === "failed") {
          summaryChildren.push(el("div", { class: "qz-error" }, [
            "Saved on this device, but couldn't reach the server just now. It'll still be here if you check back \u2014 consider letting your instructor know just in case.",
          ]));
        }
        if (state.syncStatus === "pending") {
          summaryChildren.push(el("div", { class: "qz-progress" }, [state.busy ? "Still saving \u2014 lots of results are coming in. Please keep this page open\u2026" : "Saving your result\u2026"]));
        }
        if (state.syncStatus === "failed") {
          var resendBtn = el("button", { class: "qz-next", type: "button" }, ["Retry sending"]);
          resendBtn.addEventListener("click", function () { sendResult(); render(); });
          summaryChildren.push(resendBtn);
        }
        summaryChildren.push(el("button", { class: "qz-retry", type: "button" }, ["Try again"]));

        var summary = el("div", { class: "qz-summary frame" }, summaryChildren);
        summary.querySelector(".qz-retry").addEventListener("click", function () {
          state.index = 0;
          state.score = 0;
          state.started = false;
          state.finished = false;
          state.startTime = null;
          state.endTime = null;
          state.answers = [];
          state.clientId = null;
          state.record = null;
          state.syncStatus = null;
          render();
        });
        root.appendChild(summary);
      }
    }
  }

  window.QuizEngine = { mount: mount };
})();
