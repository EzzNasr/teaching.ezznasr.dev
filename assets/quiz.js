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
  var DRIVE_ENDPOINT = "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec";

  function postToDrive(payload) {
    if (!DRIVE_ENDPOINT) return Promise.reject(new Error("not-configured"));
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight against Apps Script (no
      // doOptions handler there) — see assign.js for the full note.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.json().then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "Drive bridge rejected the result.");
        return data;
      });
    });
  }

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

      function renderQuestion() {
        var q = quiz.questions[state.index];
        var answered = false;

        var progress = el("div", { class: "qz-progress" }, [
          "Question " + (state.index + 1) + " of " + quiz.questions.length +
          "  \u00b7  Score " + state.score + "/" + state.index,
        ]);

        var questionEl = el("p", { class: "qz-question", html: q.q });
        var optionsWrap = el("div", { class: "qz-options" });
        var actions = el("div", { class: "qz-actions" });

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          questionEl,
          optionsWrap,
          actions,
        ]);

        q.options.forEach(function (opt, i) {
          var btn = el("button", { class: "qz-option", type: "button" }, [
            el("span", { class: "qz-option__tag" }, [String.fromCharCode(65 + i)]),
            el("span", {}, [opt]),
          ]);
          btn.addEventListener("click", function () {
            if (answered) return;
            answered = true;

            var correct = i === q.correct;
            if (correct) state.score++;

            state.answers.push({
              question: q.q,
              chosen: opt,
              correct_answer: q.options[q.correct],
              is_correct: correct,
              chapter: (typeof q.chapter !== "undefined") ? q.chapter : null,
            });

            Array.prototype.forEach.call(optionsWrap.children, function (child, j) {
              child.disabled = true;
              if (j === q.correct) child.classList.add("qz-option--correct");
              else if (j === i) child.classList.add("qz-option--incorrect");
            });

            var verdict = el("div", { class: "qz-verdict" }, [
              el("span", { class: correct ? "qz-verdict__tag qz-verdict__tag--pass" : "qz-verdict__tag qz-verdict__tag--fail" },
                [correct ? "Correct" : "Not quite"]),
              q.explain ? el("span", { class: "qz-verdict__explain" }, [q.explain]) : null,
            ]);
            card.appendChild(verdict);

            var isLast = state.index + 1 >= quiz.questions.length;
            var nextBtn = el("button", { class: "qz-next", type: "button" }, [isLast ? "See score \u2192" : "Next \u2192"]);
            nextBtn.addEventListener("click", function () {
              if (isLast && !state.endTime) {
                state.endTime = new Date().toISOString();
              }
              state.index++;
              render();
            });
            actions.appendChild(nextBtn);
          });
          optionsWrap.appendChild(btn);
        });

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