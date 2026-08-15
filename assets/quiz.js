/* ==========================================================================
   quiz.js — dependency-free MCQ engine for teaching.ezznasr.dev
   Renders into a container from a <script type="application/json"> block.
   Scoring is entirely client-side; nothing is sent to any server.

   Timing/result data:
   - Captured: date (YYYY-MM-DD), startedAt (quiz mounted), firstAnsweredAt
     (moment the very first option is clicked, across the whole quiz — this
     doubles as "when the student actually started answering", easier to
     capture than per-question timing), finishedAt (last question scored).
   - Persisted to sessionStorage under "quizResult:<pathname>" so a sibling
     assignment.html in the same lesson folder can read it and show it back
     to the student before they submit.
   - Also dispatched as a "quiz:completed" CustomEvent on document, in case
     a page wants to react without polling sessionStorage.
   ========================================================================== */

(function () {
  "use strict";

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

  function nowIso() {
    return new Date().toISOString();
  }

  function fmtClock(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch (e) {
      return iso;
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

    var storageKey = "quizResult:" + location.pathname;

    var state = { index: 0, score: 0, answered: false };
    var timing = {
      date: new Date().toISOString().slice(0, 10),
      startedAt: nowIso(),
      firstAnsweredAt: null,
      finishedAt: null,
    };

    function recordFirstAnswer() {
      if (!timing.firstAnsweredAt) timing.firstAnsweredAt = nowIso();
    }

    function saveResult() {
      timing.finishedAt = nowIso();
      var result = {
        path: location.pathname,
        title: quiz.title || document.title,
        date: timing.date,
        startedAt: timing.startedAt,
        firstAnsweredAt: timing.firstAnsweredAt,
        finishedAt: timing.finishedAt,
        score: state.score,
        total: quiz.questions.length,
      };
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(result));
      } catch (e) {
        /* storage unavailable (private mode etc.) — degrade silently */
      }
      try {
        document.dispatchEvent(new CustomEvent("quiz:completed", { detail: result }));
      } catch (e) {
        /* older browsers without CustomEvent support — ignore */
      }
      return result;
    }

    function render() {
      root.innerHTML = "";

      if (state.index >= quiz.questions.length) {
        renderSummary();
        return;
      }

      var q = quiz.questions[state.index];
      state.answered = false;

      var progress = el("div", { class: "qz-progress" }, [
        "Question " + (state.index + 1) + " of " + quiz.questions.length +
        "  ·  Score " + state.score + "/" + state.index,
      ]);

      var questionEl = el("p", { class: "qz-question", html: q.q });

      var optionsWrap = el("div", { class: "qz-options" });
      q.options.forEach(function (opt, i) {
        var btn = el("button", { class: "qz-option", type: "button" }, [
          el("span", { class: "qz-option__tag" }, [String.fromCharCode(65 + i)]),
          el("span", {}, [opt]),
        ]);
        btn.addEventListener("click", function () {
          if (state.answered) return;
          state.answered = true;
          recordFirstAnswer();
          var correct = i === q.correct;
          if (correct) state.score++;

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

          var nextBtn = el("button", { class: "qz-next", type: "button" }, [
            state.index + 1 < quiz.questions.length ? "Next \u2192" : "See score \u2192",
          ]);
          nextBtn.addEventListener("click", function () {
            state.index++;
            render();
          });
          actions.appendChild(nextBtn);
        });
        optionsWrap.appendChild(btn);
      });

      var actions = el("div", { class: "qz-actions" });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        questionEl,
        optionsWrap,
        actions,
      ]);

      root.appendChild(progress);
      root.appendChild(card);
    }

    function renderSummary() {
      var result = saveResult();
      var total = quiz.questions.length;
      var pct = Math.round((state.score / total) * 100);

      var timestamp = el("div", { class: "qz-timestamp" }, [
        result.date + "  ·  started " + fmtClock(result.startedAt) +
        "  ·  finished " + fmtClock(result.finishedAt),
      ]);

      var summary = el("div", { class: "qz-summary frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("div", { class: "qz-summary__score" }, [state.score + " / " + total]),
        el("div", { class: "qz-summary__label" }, [pct + "% correct"]),
        timestamp,
        el("button", { class: "qz-retry", type: "button" }, ["Try again"]),
      ]);
      summary.querySelector(".qz-retry").addEventListener("click", function () {
        state.index = 0;
        state.score = 0;
        timing.startedAt = nowIso();
        timing.firstAnsweredAt = null;
        timing.finishedAt = null;
        render();
      });
      root.appendChild(summary);
    }

    render();
  }

  window.QuizEngine = { mount: mount };
})();
