/* ==========================================================================
   assign.js — dependency-free text-paste assignment submission for
   teaching.ezznasr.dev. Reads data-subject / data-lesson off the mount
   container. Queues submissions into the same localStorage bucket quiz.js
   uses, tagged with type:"assignment", ready for a future sync step.
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
      return true;
    } catch (e) {
      return false;
    }
  }

  function mount(rootSelector) {
    var root = document.querySelector(rootSelector);
    if (!root) return;

    var subject = root.getAttribute("data-subject") || null;
    var lesson = root.getAttribute("data-lesson") || null;

    render();

    function render() {
      root.innerHTML = "";

      var nameInput = el("input", { class: "qz-input", type: "text", placeholder: "Your name", required: "required" });
      var emailInput = el("input", { class: "qz-input", type: "email", placeholder: "Email (optional)" });
      var textArea = el("textarea", { class: "qz-textarea", rows: "10", placeholder: "Paste your assignment text here\u2026", required: "required" });
      var errorMsg = el("div", { class: "qz-error" });

      var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Submit assignment \u2192"]);
      submitBtn.addEventListener("click", function () {
        var name = nameInput.value.trim();
        var text = textArea.value.trim();
        if (!name || !text) {
          errorMsg.textContent = "Please enter your name and paste your assignment text.";
          return;
        }

        var now = new Date();
        var ok = queueSubmission({
          type: "assignment",
          subject: subject,
          lesson: lesson,
          name: name,
          email: emailInput.value.trim() || null,
          text: text,
          date: isoDate(now),
          submitted_time: now.toISOString(),
        });

        renderConfirmation(ok);
      });

      var card = el("div", { class: "qz-card frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("div", { class: "qz-field" }, [nameInput]),
        el("div", { class: "qz-field" }, [emailInput]),
        el("div", { class: "qz-field" }, [textArea]),
        errorMsg,
        el("div", { class: "qz-actions" }, [submitBtn]),
      ]);

      root.appendChild(card);
    }

    function renderConfirmation(ok) {
      root.innerHTML = "";
      var summary = el("div", { class: "qz-summary frame" }, [
        el("span", { class: "tick-br" }),
        el("span", { class: "tick-bl" }),
        el("div", { class: "qz-summary__label" }, [ok ? "Received \u2014 thank you." : "Something went wrong saving your submission."]),
      ]);
      root.appendChild(summary);
    }
  }

  window.AssignEngine = { mount: mount };
})();
