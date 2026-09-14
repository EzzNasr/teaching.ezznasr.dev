/* ==========================================================================
   assign.js — assignment submission engine for teaching.ezznasr.dev.

   Reads data-subject / data-lesson / data-mode off the mount container.
   data-mode is one of: "text" | "url" | "file" | "both" | "graded".

   Every submission is queued into localStorage ("teaching_pending_submissions",
   same bucket quiz.js uses) as a durability fallback, AND — when the Drive
   bridge endpoint below is configured — POSTed straight to the Apps Script
   Web App, which saves it into your Drive folder. Students only ever talk
   to this site and the Web App URL; they never see drive.google.com.

   DRIVE_ENDPOINT is baked in at build time by app_main.py's "Sync site
   assets" action (see modules/common.py sync_site_assets). If it's empty,
   url/file/both modes will queue locally but tell the student submission
   isn't fully wired up yet — set it up in the Quiz Maker app first.

   Login (v2): the free-typed name/email fields are gone. auth.js (must be
   loaded first — see assignment.html) gates entry with phone+password and
   hands back { student_id, student_name }, which now identifies every
   submission instead.

   Graded mode (new): a fifth submission type, alongside text/url/file/both
   rather than replacing them. Assignment Maker writes a
   <script type="application/json" id="assign-questions"> block into
   assignment.html (same convention as quiz.html's #quiz-data) containing
   { items: [...] } — each item is "mcq", "truefalse", or "match". Every
   item renders as a question with one or more <select> dropdowns in front
   of it (deliberately different from quiz.js's click-to-answer buttons —
   this mirrors how these question types are usually laid out on paper: a
   dropdown per line). Grading is entirely deterministic and happens
   client-side the instant the student submits — no server round trip
   needed to know the score, though the score is still POSTed up alongside
   the answer breakdown so it shows in the Submissions sheet/dashboard.
   ========================================================================== */

(function () {
  "use strict";

  var QUEUE_KEY = "teaching_pending_submissions";
  var DRIVE_ENDPOINT = "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec";
  var MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB — keep well under Apps Script's request-size ceiling
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

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        // reader.result is "data:<mime>;base64,<data>" — strip the prefix
        var result = String(reader.result || "");
        var comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(new Error("Could not read the file.")); };
      reader.readAsDataURL(file);
    });
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

  function loadGradedQuestions() {
    var node = document.querySelector("#assign-questions");
    if (!node) return null;
    try {
      var data = JSON.parse(node.textContent);
      return (data && Array.isArray(data.items)) ? data : null;
    } catch (e) {
      return null;
    }
  }

  // First option is always the unanswered placeholder (value ""), so a
  // student can't accidentally submit with a dropdown left at its default
  // — onSubmit below checks for value === "" to catch that.
  function buildSelect(options, placeholder) {
    var sel = el("select", { class: "qz-select" }, [
      el("option", { value: "" }, [placeholder || "Choose\u2026"]),
    ].concat(options.map(function (opt) { return el("option", { value: opt }, [opt]); })));
    return sel;
  }

  function mount(rootSelector) {
    var root = document.querySelector(rootSelector);
    if (!root) return;

    var subject = root.getAttribute("data-subject") || null;
    var lesson = root.getAttribute("data-lesson") || null;
    var mode = root.getAttribute("data-mode") || "text";

    if (!window.AuthEngine) {
      root.textContent = "Sign-in couldn't load. Please refresh the page.";
      return;
    }

    window.AuthEngine.mount(rootSelector, function (session) {
      if (mode === "graded") startGraded(session);
      else startAssignment(session);
    });

    function startGraded(session) {
      var data = loadGradedQuestions();
      if (!data || !data.items.length) {
        root.innerHTML = "";
        root.appendChild(el("div", { class: "qz-error" }, [
          "This assignment doesn't have any graded questions configured yet.",
        ]));
        return;
      }

      var state = { submitted: false, score: 0, total: 0, answers: [], syncStatus: null };
      render();

      function render() {
        root.innerHTML = "";
        if (state.submitted) { renderResult(); return; }
        renderForm();
      }

      function renderForm() {
        var errorMsg = el("div", { class: "qz-error" });
        var itemsWrap = el("div", {});
        var entries = []; // { item, select } for mcq/truefalse, { item, rowSelects } for match

        data.items.forEach(function (item) {
          var block = el("div", { class: "qz-graded-item" }, [
            el("p", { class: "qz-question", html: item.prompt }),
          ]);

          if (item.type === "mcq") {
            if (item.correct.length > 1) {
              var checks = item.options.map(function (opt) {
                var cb = el("input", { type: "checkbox", value: opt });
                var label = el("label", { class: "qz-graded-check" }, [cb, " " + opt]);
                return { opt: opt, cb: cb, label: label };
              });
              checks.forEach(function (c) { block.appendChild(el("div", { class: "qz-graded-row" }, [c.label])); });
              entries.push({ item: item, checks: checks });
            } else {
              var sel = buildSelect(item.options);
              block.appendChild(el("div", { class: "qz-graded-row" }, [sel]));
              entries.push({ item: item, select: sel });
            }
          } else if (item.type === "truefalse") {
            var sel = buildSelect(["True", "False"]);
            block.appendChild(el("div", { class: "qz-graded-row" }, [sel]));
            entries.push({ item: item, select: sel });
          } else if (item.type === "match") {
            var rowSelects = [];
            (item.rows || []).forEach(function (row) {
              var rsel = buildSelect(item.options);
              rowSelects.push(rsel);
              block.appendChild(el("div", { class: "qz-graded-row" }, [
                el("span", { class: "qz-graded-row__label" }, [row.label]),
                rsel,
              ]));
            });
            entries.push({ item: item, rowSelects: rowSelects });
          }

          itemsWrap.appendChild(block);
        });

        var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Submit assignment \u2192"]);
        submitBtn.addEventListener("click", function () { onSubmit(); });

        function onSubmit() {
          var incomplete = entries.some(function (e) {
            if (e.checks) return !e.checks.some(function (c) { return c.cb.checked; });
            return e.select ? e.select.value === "" : e.rowSelects.some(function (rs) { return rs.value === ""; });
          });
          if (incomplete) {
            errorMsg.textContent = "Please answer every question before submitting.";
            return;
          }
          submitBtn.disabled = true;
          grade(entries);
        }

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__explain" }, ["Signed in as " + session.student_name]),
          ]),
          itemsWrap,
          errorMsg,
          el("div", { class: "qz-actions" }, [submitBtn]),
        ]);
        root.appendChild(card);
      }

      function grade(entries) {
        var score = 0, total = 0, answers = [];

        entries.forEach(function (e) {
          var item = e.item;
          if (item.type === "match") {
            item.rows.forEach(function (row, i) {
              total++;
              var chosen = e.rowSelects[i].value;
              var isCorrect = chosen === row.correct;
              if (isCorrect) score++;
              answers.push({
                id: item.id + ":" + i, type: "match", prompt: item.prompt + " \u2014 " + row.label,
                chosen: chosen, correct_answer: row.correct, is_correct: isCorrect,
              });
            });
          } else if (item.type === "mcq" && e.checks) {
            total++;
            var chosenOpts = e.checks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.opt; });
            var correctOpts = item.correct.map(function (i) { return item.options[i]; });
            var isCorrect = chosenOpts.length === correctOpts.length &&
              chosenOpts.slice().sort().every(function (v, i) { return v === correctOpts.slice().sort()[i]; });
            if (isCorrect) score++;
            answers.push({
              id: item.id, type: "mcq", prompt: item.prompt,
              chosen: chosenOpts.join(", "), correct_answer: correctOpts.join(", "), is_correct: isCorrect,
            });
          } else {
            total++;
            var chosen = e.select.value;
            var correctAnswer = item.type === "truefalse" ? (item.correct ? "True" : "False") : item.options[item.correct[0]];
            var isCorrect = chosen === correctAnswer;
            if (isCorrect) score++;
            answers.push({
              id: item.id, type: item.type, prompt: item.prompt,
              chosen: chosen, correct_answer: correctAnswer, is_correct: isCorrect,
            });
          }
        });

        state.score = score;
        state.total = total;
        state.answers = answers;
        state.submitted = true;

        var now = new Date();
        var record = {
          type: "assignment",
          subject: subject,
          lesson: lesson,
          student_id: session.student_id,
          name: session.student_name,
          email: null,
          date: isoDate(now),
          submitted_time: now.toISOString(),
          submission_type: "graded",
          score: score,
          total: total,
          answers: answers,
        };

        queueSubmission(record);
        state.syncStatus = "pending";
        render();

        postToDrive(Object.assign({ action: "upload_submission" }, record))
          .then(function () { state.syncStatus = "ok"; render(); })
          .catch(function (err) {
            state.syncStatus = (err && err.message === "not-configured") ? "not-configured" : "failed";
            render();
          });
      }

      function renderResult() {
        var pct = state.total ? Math.round((state.score / state.total) * 100) : 0;
        var children = [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__score" }, [state.score + " / " + state.total]),
          el("div", { class: "qz-summary__label" }, [pct + "% correct \u00b7 " + session.student_name]),
        ];
        if (state.syncStatus === "not-configured") {
          children.push(el("div", { class: "qz-error" }, [
            "Saved on this device. Result delivery isn't fully set up yet \u2014 let your instructor know.",
          ]));
        } else if (state.syncStatus === "failed") {
          children.push(el("div", { class: "qz-error" }, [
            "Saved on this device, but couldn't reach the server just now. It'll still be here if you check back \u2014 consider letting your instructor know just in case.",
          ]));
        }
        // Each attempt is its own new row on the Submissions sheet (Code.gs
        // always appendRow()s, never overwrites) — retaking isn't blocked,
        // so this is just giving that an actual button instead of forcing
        // a page reload to get back to a blank form.
        children.push(el("button", { class: "qz-retry", type: "button" }, ["Submit another attempt"]));

        var summary = el("div", { class: "qz-summary frame" }, children);
        summary.querySelector(".qz-retry").addEventListener("click", function () {
          state.submitted = false;
          state.score = 0;
          state.total = 0;
          state.answers = [];
          state.syncStatus = null;
          render();
        });
        root.appendChild(summary);
      }
    }

    function startAssignment(session) {
      var uiMode = mode === "both" ? "url" : mode; // for "both", start on the link tab

      render();

      function render() {
        root.innerHTML = "";

        var errorMsg = el("div", { class: "qz-error" });

        var fieldsWrap = el("div", {});
        var textArea, urlInput, fileInput, noteArea;

        function buildTextField() {
          textArea = el("textarea", { class: "qz-textarea", rows: "10", placeholder: "Paste your assignment text here\u2026", required: "required" });
          return el("div", { class: "qz-field" }, [textArea]);
        }
        function buildUrlField() {
          urlInput = el("input", { class: "qz-input", type: "url", placeholder: "https:// link to your work (Docs, Drive, GitHub, etc.)", required: "required" });
          noteArea = el("textarea", { class: "qz-textarea", rows: "4", placeholder: "Notes (optional)" });
          return el("div", {}, [
            el("div", { class: "qz-field" }, [urlInput]),
            el("div", { class: "qz-field" }, [noteArea]),
          ]);
        }
        function buildFileField() {
          fileInput = el("input", { class: "qz-input", type: "file", required: "required" });
          noteArea = el("textarea", { class: "qz-textarea", rows: "4", placeholder: "Notes (optional)" });
          return el("div", {}, [
            el("div", { class: "qz-field" }, [fileInput]),
            el("div", { class: "qz-field" }, [noteArea]),
          ]);
        }

        function renderFields() {
          fieldsWrap.innerHTML = "";
          if (uiMode === "text") fieldsWrap.appendChild(buildTextField());
          else if (uiMode === "url") fieldsWrap.appendChild(buildUrlField());
          else if (uiMode === "file") fieldsWrap.appendChild(buildFileField());
        }
        renderFields();

        var toggle = null;
        if (mode === "both") {
          var linkBtn = el("button", { class: "qz-mode-btn" + (uiMode === "url" ? " active" : ""), type: "button" }, ["Submit a link"]);
          var fileBtn = el("button", { class: "qz-mode-btn" + (uiMode === "file" ? " active" : ""), type: "button" }, ["Upload a file"]);
          linkBtn.addEventListener("click", function () { uiMode = "url"; render(); });
          fileBtn.addEventListener("click", function () { uiMode = "file"; render(); });
          toggle = el("div", { class: "qz-mode-toggle" }, [linkBtn, fileBtn]);
        }

        var submitBtn = el("button", { class: "qz-next", type: "button" }, ["Submit assignment \u2192"]);
        submitBtn.addEventListener("click", function () { onSubmit(submitBtn); });

        function onSubmit(btn) {
          if (uiMode === "text") {
            var text = textArea.value.trim();
            if (!text) {
              errorMsg.textContent = "Please paste your assignment text.";
              return;
            }
            submitRecord({ submission_type: "text", text: text });
            return;
          }

          if (uiMode === "url") {
            var url = urlInput.value.trim();
            if (!url) {
              errorMsg.textContent = "Please paste a link to your work.";
              return;
            }
            submitRecord({ submission_type: "url", url: url, note: noteArea.value.trim() || null });
            return;
          }

          if (uiMode === "file") {
            var file = fileInput.files && fileInput.files[0];
            if (!file) {
              errorMsg.textContent = "Please choose a file.";
              return;
            }
            if (file.size > MAX_FILE_BYTES) {
              errorMsg.textContent = "That file is larger than 15MB \u2014 use a link instead (Drive/Docs share link).";
              return;
            }
            btn.disabled = true;
            btn.textContent = "Uploading\u2026";
            fileToBase64(file).then(function (base64) {
              submitRecord({
                submission_type: "file",
                filename: file.name,
                mime_type: file.type || "application/octet-stream",
                data_base64: base64,
                note: noteArea.value.trim() || null,
              });
            }).catch(function (err) {
              btn.disabled = false;
              btn.textContent = "Submit assignment \u2192";
              errorMsg.textContent = err.message || "Could not read that file.";
            });
            return;
          }

          function submitRecord(extra) {
            var now = new Date();
            var base = {
              type: "assignment",
              subject: subject,
              lesson: lesson,
              student_id: session.student_id,
              name: session.student_name,
              email: null,
              date: isoDate(now),
              submitted_time: now.toISOString(),
            };
            var record = Object.assign({}, base, extra);

            queueSubmission(record);

            if (extra.submission_type === "text") {
              renderConfirmation(true, false);
              return;
            }

            postToDrive(Object.assign({ action: "upload_submission" }, record))
              .then(function () { renderConfirmation(true, true); })
              .catch(function (err) {
                var configured = err.message !== "not-configured";
                renderConfirmation(true, false, configured);
              });
          }
        }

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          toggle,
          el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__explain" }, ["Signed in as " + session.student_name]),
          ]),
          fieldsWrap,
          errorMsg,
          el("div", { class: "qz-actions" }, [submitBtn]),
        ]);

        root.appendChild(card);
      }

      function renderConfirmation(ok, synced, driveAttempted) {
        root.innerHTML = "";
        var label;
        if (!ok) {
          label = "Something went wrong saving your submission.";
        } else if (synced) {
          label = "Received \u2014 thank you.";
        } else if (driveAttempted === false) {
          label = "Saved on this device. Submission delivery isn't fully set up yet \u2014 let your instructor know.";
        } else {
          label = "Saved on this device, but couldn't reach the server just now. It'll still be here if you check back \u2014 consider letting your instructor know just in case.";
        }
        var summary = el("div", { class: "qz-summary frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__label" }, [label]),
          el("button", { class: "qz-retry", type: "button" }, ["Submit another"]),
        ]);
        // Same "each attempt is a new row" story as the graded flow above —
        // Code.gs appendRow()s every submission, so resubmitting (a new
        // text paste, a corrected link, a replacement file) just adds
        // another record rather than overwriting the first one.
        summary.querySelector(".qz-retry").addEventListener("click", render);
        root.appendChild(summary);
      }
    }
  }

  window.AssignEngine = { mount: mount };
})();
