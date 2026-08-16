/* ==========================================================================
   quiz.js — dependency-free MCQ engine for teaching.ezznasr.dev
   Renders into a container from a <script type="application/json"> block.
   Scoring is client-side. Results are queued into localStorage under
   "teaching_pending_submissions" so a future sync step can POST them.
   ========================================================================== */

(function () {
  "use strict";

  var QUEUE_KEY = "teaching_pending_submissions";

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

    var state = {
      index: 0,
      score: 0,
      started: false,
      finished: false,
      name: "",
      email: "",
      startTime: null,
      endTime: null,
    };

    function render() {
      root.innerHTML = "";
      if (!state.started) { renderStart(); return; }
      if (state.index >= quiz.questions.length) { renderSummary(); return; }
      renderQuestion();
    }

    function renderStart() {
      var nameInput = el("input", { class: "qz-input", type: "text", placeholder: "Your name", required: "required" });
      var emailInput = el("input", { class: "qz-input", type: "email", placeholder: "Email (optional)" });

      var errorMsg = el("div", { class: "qz-error" });

      var beginBtn = el("button", { class: "qz-next", type: "button" }, ["Begin quiz \u2192"]);
      beginBtn.addEventListener("click", function () {
        var name = nameInput.value.trim();
        if (!name) {
          errorMsg.textContent = "Please enter your name to start.";
          nameInput.focus();
          return;
        }
        state.name = name;
        state.email = emailInput.value.trim();
        state.startTime = new Date().toISOString();
        state.started = true;
        render();
      });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("p", { class: "qz-question" }, [quiz.title ? (quiz.title + " — before you start") : "Before you start"]),
        el("div", { class: "qz-field" }, [nameInput]),
        el("div", { class: "qz-field" }, [emailInput]),
        errorMsg,
        el("div", { class: "qz-actions" }, [beginBtn]),
      ]);

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

        queueSubmission({
          type: "quiz",
          subject: quiz.subject || null,
          lesson: quiz.lesson || null,
          quiz_title: quiz.title || null,
          name: state.name,
          email: state.email || null,
          date: isoDate(new Date(state.startTime)),
          start_time: state.startTime,
          end_time: state.endTime,
          score: state.score,
          total: quiz.questions.length,
        });
      }

      var total = quiz.questions.length;
      var pct = total ? Math.round((state.score / total) * 100) : 0;
      var summary = el("div", { class: "qz-summary frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("div", { class: "qz-summary__score" }, [state.score + " / " + total]),
        el("div", { class: "qz-summary__label" }, [pct + "% correct \u00b7 " + state.name]),
        el("button", { class: "qz-retry", type: "button" }, ["Try again"]),
      ]);
      summary.querySelector(".qz-retry").addEventListener("click", function () {
        state.index = 0;
        state.score = 0;
        state.started = false;
        state.finished = false;
        state.startTime = null;
        state.endTime = null;
        render();
      });
      root.appendChild(summary);
    }

    render();
  }

  window.QuizEngine = { mount: mount };
})();
