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

  // Retries once if Apps Script returns an HTML page instead of JSON — a
  // transient Google-side hiccup (seen right after redeploys, under load),
  // not a code bug.
  function postToDrive(payload, isRetry) {
    if (!DRIVE_ENDPOINT) return Promise.reject(new Error("not-configured"));
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.text().then(function (raw) {
        var data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          if (!isRetry) return postToDrive(payload, true);
          throw new Error("The server sent back something unexpected. Please try again.");
        }
        if (!data || !data.ok) throw new Error((data && data.error) || "Drive bridge rejected the request.");
        return data;
      });
    });
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
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

    var quiz;
    try {
      quiz = JSON.parse(dataNode.textContent);
    } catch (e) {
      root.textContent = "Quiz data could not be loaded.";
      return;
    }

    if (!window.AuthEngine) {
      root.textContent = "Sign-in couldn't load. Please refresh the page.";
      return;
    }

    window.AuthEngine.mount(rootSelector, function (session) {
      startQuiz(session);
    });

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
            subject: quiz.subject || null,
            lesson: quiz.lesson || null,
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

          // Was a silent no-op catch before — the student had no way to
          // know a result never reached the server. state.syncStatus
          // drives the note rendered below; render() gets called again
          // once the promise settles (safe — the `!state.finished` guard
          // above means this whole block won't run a second time).
          state.syncStatus = "pending";
          postToDrive(Object.assign({ action: "upload_quiz_result" }, record))
            .then(function () { state.syncStatus = "ok"; render(); })
            .catch(function (err) {
              state.syncStatus = (err && err.message === "not-configured") ? "not-configured" : "failed";
              render();
            });
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
          state.syncStatus = null;
          render();
        });
        root.appendChild(summary);
      }
    }
  }

  window.QuizEngine = { mount: mount };
})();