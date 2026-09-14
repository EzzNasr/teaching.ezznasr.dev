/* ==========================================================================
   quiz.js — dependency-free MCQ/Matching engine for teaching.ezznasr.dev
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

   v3 change: the newer bulk-add question format (shared with the
   Assignment Maker's "graded questions" mode) uses "prompt" instead of
   "q", "correct" as an ARRAY of indexes (a single-answer MCQ now looks
   like "correct": [1] instead of "correct": 1, and multi-answer/select-
   all questions are "correct": [1, 3]), and adds a whole new
   "type": "match" question shape ({ prompt, rows: [{label, correct}],
   options: [...] }). None of that rendered before — a match question or
   a "correct": [1] MCQ just silently produced a blank or broken question
   card. This version reads both the old and new shapes, so previously-
   generated quizzes keep working exactly as before.
   ========================================================================== */

(function () {
  "use strict";

  var QUEUE_KEY = "teaching_pending_submissions";
  var LAST_ATTEMPT_PREFIX = "teaching_last_attempt:";
  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";

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
        if (!data || !data.ok)
          throw new Error(
            (data && data.error) || "Drive bridge rejected the result.",
          );
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
      if (c)
        node.appendChild(
          typeof c === "string" ? document.createTextNode(c) : c,
        );
    });
    return node;
  }

  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }

  // Question text lives under "q" (old generator) or "prompt" (newer
  // bulk-add / shared-with-assignments generator) — accept either.
  function questionText(q) {
    return q.q || q.prompt || "";
  }

  // Normalizes "correct" to an array of option indexes regardless of
  // whether the source JSON used a bare number (old format) or an array
  // (new format, which also allows more than one correct index for
  // "select all that apply" questions).
  function correctIndexes(q) {
    if (Array.isArray(q.correct)) return q.correct.slice();
    if (typeof q.correct === "number") return [q.correct];
    return [];
  }

  function lastAttemptKey(quiz) {
    return (
      LAST_ATTEMPT_PREFIX + (quiz.subject || "?") + ":" + (quiz.lesson || "?")
    );
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
      };

      render();

      function render() {
        root.innerHTML = "";
        if (!state.started) {
          renderStart();
          return;
        }
        if (state.index >= quiz.questions.length) {
          renderSummary();
          return;
        }
        renderQuestion();
      }

      function renderStart() {
        var errorMsg = el("div", { class: "qz-error" });

        var beginBtn = el("button", { class: "qz-next", type: "button" }, [
          "Begin quiz \u2192",
        ]);
        beginBtn.addEventListener("click", function () {
          state.startTime = new Date().toISOString();
          state.started = true;
          render();
        });

        var cardChildren = [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("p", { class: "qz-question" }, [
            quiz.title
              ? quiz.title + " — before you start"
              : "Before you start",
          ]),
          el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__explain" }, [
              "Signed in as " + state.studentName,
            ]),
          ]),
        ];

        var last = loadLastAttempt(quiz);
        if (
          last &&
          typeof last.score === "number" &&
          typeof last.total === "number"
        ) {
          var pct = last.total
            ? Math.round((last.score / last.total) * 100)
            : 0;
          var whenLabel = last.date ? " \u00b7 " + last.date : "";
          cardChildren.push(
            el("div", { class: "qz-verdict" }, [
              el("span", { class: "qz-verdict__tag qz-verdict__tag--pass" }, [
                "Last attempt",
              ]),
              el("span", { class: "qz-verdict__explain" }, [
                last.score +
                  " / " +
                  last.total +
                  " (" +
                  pct +
                  "%)" +
                  whenLabel +
                  ". Starting again will record a new attempt.",
              ]),
            ]),
          );
        }

        cardChildren.push(errorMsg);
        cardChildren.push(el("div", { class: "qz-actions" }, [beginBtn]));

        var card = el("div", { class: "qz-card frame" }, cardChildren);
        root.appendChild(card);
      }

      function renderQuestion() {
        var q = quiz.questions[state.index];
        var qType = q.type || "mcq";

        var progress = el("div", { class: "qz-progress" }, [
          "Question " +
            (state.index + 1) +
            " of " +
            quiz.questions.length +
            "  \u00b7  Score " +
            state.score +
            "/" +
            state.index,
        ]);

        var questionEl = el("p", {
          class: "qz-question",
          html: questionText(q),
        });
        var bodyWrap = el("div", {});
        var actions = el("div", { class: "qz-actions" });

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          questionEl,
          bodyWrap,
          actions,
        ]);

        if (qType === "match") renderMatchBody(q, bodyWrap, actions, card);
        else renderMcqBody(q, bodyWrap, actions, card);

        root.appendChild(progress);
        root.appendChild(card);
      }

      function appendNextButton(actions) {
        var isLast = state.index + 1 >= quiz.questions.length;
        var nextBtn = el("button", { class: "qz-next", type: "button" }, [
          isLast ? "See score \u2192" : "Next \u2192",
        ]);
        nextBtn.addEventListener("click", function () {
          if (isLast && !state.endTime) {
            state.endTime = new Date().toISOString();
          }
          state.index++;
          render();
        });
        actions.appendChild(nextBtn);
      }

      function renderMcqBody(q, bodyWrap, actions, card) {
        var correctSet = correctIndexes(q);
        var isMulti = correctSet.length > 1;
        var options = q.options || [];
        var selected = [];
        var answered = false;

        if (isMulti) {
          bodyWrap.appendChild(
            el("p", { class: "qz-progress" }, [
              "Select all that apply, then check your answer.",
            ]),
          );
        }

        var optionsWrap = el("div", { class: "qz-options" });
        options.forEach(function (opt, i) {
          var btn = el("button", { class: "qz-option", type: "button" }, [
            el("span", { class: "qz-option__tag" }, [
              String.fromCharCode(65 + i),
            ]),
            el("span", {}, [opt]),
          ]);
          btn.addEventListener("click", function () {
            if (answered) return;
            if (isMulti) {
              var idx = selected.indexOf(i);
              if (idx >= 0) {
                selected.splice(idx, 1);
                btn.style.borderColor = "";
                btn.style.color = "";
              } else {
                selected.push(i);
                btn.style.borderColor = "var(--accent)";
                btn.style.color = "var(--accent-strong)";
              }
            } else {
              finish([i]);
            }
          });
          optionsWrap.appendChild(btn);
        });
        bodyWrap.appendChild(optionsWrap);

        if (isMulti) {
          var checkBtn = el("button", { class: "qz-next", type: "button" }, [
            "Check answer \u2192",
          ]);
          checkBtn.addEventListener("click", function () {
            if (answered || !selected.length) return;
            finish(selected.slice());
          });
          actions.appendChild(checkBtn);
        }

        function finish(chosenIdx) {
          answered = true;

          var chosenSorted = chosenIdx.slice().sort();
          var correctSorted = correctSet.slice().sort();
          var correct =
            chosenSorted.length === correctSorted.length &&
            chosenSorted.every(function (v, i) {
              return v === correctSorted[i];
            });
          if (correct) state.score++;

          state.answers.push({
            question: questionText(q),
            chosen: chosenIdx
              .map(function (i) {
                return options[i];
              })
              .join(", "),
            correct_answer: correctSet
              .map(function (i) {
                return options[i];
              })
              .join(", "),
            is_correct: correct,
            chapter: typeof q.chapter !== "undefined" ? q.chapter : null,
          });

          Array.prototype.forEach.call(
            optionsWrap.children,
            function (child, j) {
              child.disabled = true;
              if (correctSet.indexOf(j) !== -1)
                child.classList.add("qz-option--correct");
              else if (chosenIdx.indexOf(j) !== -1)
                child.classList.add("qz-option--incorrect");
            },
          );

          actions.innerHTML = "";

          var verdict = el("div", { class: "qz-verdict" }, [
            el(
              "span",
              {
                class: correct
                  ? "qz-verdict__tag qz-verdict__tag--pass"
                  : "qz-verdict__tag qz-verdict__tag--fail",
              },
              [correct ? "Correct" : "Not quite"],
            ),
            q.explain
              ? el("span", { class: "qz-verdict__explain" }, [q.explain])
              : null,
          ]);
          card.appendChild(verdict);

          appendNextButton(actions);
        }
      }

      function renderMatchBody(q, bodyWrap, actions, card) {
        var rows = q.rows || [];
        var options = q.options || [];
        var selects = [];
        var answered = false;

        var rowsWrap = el("div", {});
        rows.forEach(function (row) {
          var select = el("select", { class: "qz-input" }, [
            el("option", { value: "" }, ["Choose an answer\u2026"]),
          ]);
          options.forEach(function (opt) {
            select.appendChild(el("option", { value: opt }, [opt]));
          });
          selects.push(select);
          rowsWrap.appendChild(
            el("div", { class: "qz-field" }, [
              el("p", {}, [row.label]),
              select,
            ]),
          );
        });
        bodyWrap.appendChild(rowsWrap);

        var checkBtn = el("button", { class: "qz-next", type: "button" }, [
          "Check answers \u2192",
        ]);
        checkBtn.addEventListener("click", function () {
          if (answered) return;
          var allChosen = selects.every(function (s) {
            return s.value;
          });
          if (!allChosen) return;
          answered = true;

          var correctCount = 0;
          rows.forEach(function (row, i) {
            var chosen = selects[i].value;
            var ok = chosen === row.correct;
            if (ok) correctCount++;
            selects[i].disabled = true;
            if (!ok) selects[i].style.borderColor = "#c0392b";
          });

          var allCorrect = correctCount === rows.length;
          if (allCorrect) state.score++;

          state.answers.push({
            question: questionText(q),
            chosen: rows
              .map(function (row, i) {
                return row.label + " -> " + selects[i].value;
              })
              .join("; "),
            correct_answer: rows
              .map(function (row) {
                return row.label + " -> " + row.correct;
              })
              .join("; "),
            is_correct: allCorrect,
            chapter: typeof q.chapter !== "undefined" ? q.chapter : null,
          });

          actions.innerHTML = "";
          var verdict = el("div", { class: "qz-verdict" }, [
            el(
              "span",
              {
                class: allCorrect
                  ? "qz-verdict__tag qz-verdict__tag--pass"
                  : "qz-verdict__tag qz-verdict__tag--fail",
              },
              [correctCount + " / " + rows.length + " correct"],
            ),
            q.explain
              ? el("span", { class: "qz-verdict__explain" }, [q.explain])
              : null,
          ]);
          card.appendChild(verdict);

          appendNextButton(actions);
        });
        actions.appendChild(checkBtn);
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
            .filter(function (a) {
              return !a.is_correct;
            })
            .map(function (a) {
              return {
                question: a.question,
                your_answer: a.chosen,
                correct_answer: a.correct_answer,
              };
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

          // Best-effort — same fallback philosophy as the rest of the site:
          // if the Drive bridge isn't configured or unreachable, the result
          // still lives in localStorage via queueSubmission above.
          postToDrive(
            Object.assign({ action: "upload_quiz_result" }, record),
          ).catch(function () {});
        }

        var total = quiz.questions.length;
        var pct = total ? Math.round((state.score / total) * 100) : 0;
        var summary = el("div", { class: "qz-summary frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__score" }, [
            state.score + " / " + total,
          ]),
          el("div", { class: "qz-summary__label" }, [
            pct + "% correct \u00b7 " + state.studentName,
          ]),
          el("button", { class: "qz-retry", type: "button" }, ["Try again"]),
        ]);
        summary
          .querySelector(".qz-retry")
          .addEventListener("click", function () {
            state.index = 0;
            state.score = 0;
            state.started = false;
            state.finished = false;
            state.startTime = null;
            state.endTime = null;
            state.answers = [];
            render();
          });
        root.appendChild(summary);
      }
    }
  }

  window.QuizEngine = { mount: mount };
})();
