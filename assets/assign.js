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
   url/file/both/graded modes will queue locally but tell the student
   submission isn't fully wired up yet — set it up in the Quiz Maker app
   first.

   Login (v2): the free-typed name/email fields are gone. auth.js (must be
   loaded first — see assignment.html) gates entry with phone+password and
   hands back { student_id, student_name }, which now identifies every
   submission instead.

   v3 change — "graded" mode added: previously this file only understood
   "text"/"url"/"file"/"both" and had no idea "graded" was a valid mode at
   all, so a graded assignment page rendered an empty card with a "Submit"
   button that silently did nothing when clicked (no questions, no error).
   "graded" mode reads the same kind of question JSON the Quiz Maker
   writes (a <script type="application/json"> block — "#assign-questions"
   by default, or whatever data-questions points at), walks through the
   items one at a time the same way quiz.js does, and submits a scored
   record ({ type: "assignment", submission_type: "graded", score, total,
   answers }) at the end instead of a text/url/file payload. Unlike the
   practice quiz, a graded assignment does NOT offer a "try again" — it's
   a one-shot submission, matching how the other three assignment modes
   already behave.
   ========================================================================== */

(function () {
  "use strict";

  var QUEUE_KEY = "teaching_pending_submissions";
  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";
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

  // Question text lives under "q" (quiz.js's older shape) or "prompt"
  // (the shared bulk-add generator) — accept either, same as quiz.js.
  function questionText(q) {
    return q.q || q.prompt || "";
  }

  // "correct" is an array of option indexes for mcq items (length 1 for
  // a normal single-answer question, length >1 for "select all that
  // apply") — but tolerate a bare number too, just in case.
  function correctIndexes(q) {
    if (Array.isArray(q.correct)) return q.correct.slice();
    if (typeof q.correct === "number") return [q.correct];
    return [];
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
      reader.onerror = function () {
        reject(new Error("Could not read the file."));
      };
      reader.readAsDataURL(file);
    });
  }

  function postToDrive(payload) {
    if (!DRIVE_ENDPOINT) {
      return Promise.reject(new Error("not-configured"));
    }
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain is CORS-safelisted, so the browser skips the preflight
      // OPTIONS request. Apps Script has no doOptions() handler, so a
      // preflighted request (e.g. Content-Type: application/json) gets
      // silently blocked by the browser before doPost ever runs. doPost
      // still JSON.parses e.postData.contents regardless of the declared
      // type, so this is a pure client-side header change.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.json().then(function (data) {
        if (!data || !data.ok)
          throw new Error(
            (data && data.error) || "Drive bridge rejected the submission.",
          );
        return data;
      });
    });
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

    if (mode === "graded") {
      var questionsSelector =
        root.getAttribute("data-questions") || "#assign-questions";
      var dataNode = document.querySelector(questionsSelector);
      var gradedData = null;
      if (dataNode) {
        try {
          gradedData = JSON.parse(dataNode.textContent);
        } catch (e) {
          gradedData = null;
        }
      }
      if (
        !gradedData ||
        !Array.isArray(gradedData.items) ||
        !gradedData.items.length
      ) {
        root.textContent = "This assignment's questions could not be loaded.";
        return;
      }
      window.AuthEngine.mount(rootSelector, function (session) {
        startGraded(session, gradedData.items);
      });
      return;
    }

    window.AuthEngine.mount(rootSelector, function (session) {
      startAssignment(session);
    });

    function startAssignment(session) {
      var uiMode = mode === "both" ? "url" : mode; // for "both", start on the link tab

      render();

      function render() {
        root.innerHTML = "";

        var errorMsg = el("div", { class: "qz-error" });

        var fieldsWrap = el("div", {});
        var textArea, urlInput, fileInput, noteArea;

        function buildTextField() {
          textArea = el("textarea", {
            class: "qz-textarea",
            rows: "10",
            placeholder: "Paste your assignment text here\u2026",
            required: "required",
          });
          return el("div", { class: "qz-field" }, [textArea]);
        }
        function buildUrlField() {
          urlInput = el("input", {
            class: "qz-input",
            type: "url",
            placeholder:
              "https:// link to your work (Docs, Drive, GitHub, etc.)",
            required: "required",
          });
          noteArea = el("textarea", {
            class: "qz-textarea",
            rows: "4",
            placeholder: "Notes (optional)",
          });
          return el("div", {}, [
            el("div", { class: "qz-field" }, [urlInput]),
            el("div", { class: "qz-field" }, [noteArea]),
          ]);
        }
        function buildFileField() {
          fileInput = el("input", {
            class: "qz-input",
            type: "file",
            required: "required",
          });
          noteArea = el("textarea", {
            class: "qz-textarea",
            rows: "4",
            placeholder: "Notes (optional)",
          });
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
          var linkBtn = el(
            "button",
            {
              class: "qz-mode-btn" + (uiMode === "url" ? " active" : ""),
              type: "button",
            },
            ["Submit a link"],
          );
          var fileBtn = el(
            "button",
            {
              class: "qz-mode-btn" + (uiMode === "file" ? " active" : ""),
              type: "button",
            },
            ["Upload a file"],
          );
          linkBtn.addEventListener("click", function () {
            uiMode = "url";
            render();
          });
          fileBtn.addEventListener("click", function () {
            uiMode = "file";
            render();
          });
          toggle = el("div", { class: "qz-mode-toggle" }, [linkBtn, fileBtn]);
        }

        var submitBtn = el("button", { class: "qz-next", type: "button" }, [
          "Submit assignment \u2192",
        ]);
        submitBtn.addEventListener("click", function () {
          onSubmit(submitBtn);
        });

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
            submitRecord({
              submission_type: "url",
              url: url,
              note: noteArea.value.trim() || null,
            });
            return;
          }

          if (uiMode === "file") {
            var file = fileInput.files && fileInput.files[0];
            if (!file) {
              errorMsg.textContent = "Please choose a file.";
              return;
            }
            if (file.size > MAX_FILE_BYTES) {
              errorMsg.textContent =
                "That file is larger than 15MB \u2014 use a link instead (Drive/Docs share link).";
              return;
            }
            btn.disabled = true;
            btn.textContent = "Uploading\u2026";
            fileToBase64(file)
              .then(function (base64) {
                submitRecord({
                  submission_type: "file",
                  filename: file.name,
                  mime_type: file.type || "application/octet-stream",
                  data_base64: base64,
                  note: noteArea.value.trim() || null,
                });
              })
              .catch(function (err) {
                btn.disabled = false;
                btn.textContent = "Submit assignment \u2192";
                errorMsg.textContent =
                  err.message || "Could not read that file.";
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
              .then(function () {
                renderConfirmation(true, true);
              })
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
            el("span", { class: "qz-verdict__explain" }, [
              "Signed in as " + session.student_name,
            ]),
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
          label =
            "Saved on this device. Submission delivery isn't fully set up yet \u2014 let your instructor know.";
        } else {
          label =
            "Saved on this device, but couldn't reach the server just now. It'll still be here if you check back \u2014 consider letting your instructor know just in case.";
        }
        var summary = el("div", { class: "qz-summary frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__label" }, [label]),
        ]);
        root.appendChild(summary);
      }
    }

    // -- graded mode: MCQ/Matching questions rendered and scored the same
    // way quiz.js does, but submitted as a graded assignment record
    // instead of a quiz result, and with no "try again" once finished. --
    function startGraded(session, items) {
      var state = {
        index: 0,
        score: 0,
        started: false,
        finished: false,
        answers: [],
      };

      render();

      function render() {
        root.innerHTML = "";
        if (!state.started) {
          renderStart();
          return;
        }
        if (state.index >= items.length) {
          renderSummary();
          return;
        }
        renderQuestion();
      }

      function renderStart() {
        var beginBtn = el("button", { class: "qz-next", type: "button" }, [
          "Begin assignment \u2192",
        ]);
        beginBtn.addEventListener("click", function () {
          state.started = true;
          render();
        });

        var card = el("div", { class: "qz-card frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("p", { class: "qz-question" }, ["Before you start"]),
          el("div", { class: "qz-verdict" }, [
            el("span", { class: "qz-verdict__explain" }, [
              "Signed in as " + session.student_name,
            ]),
          ]),
          el("div", { class: "qz-actions" }, [beginBtn]),
        ]);
        root.appendChild(card);
      }

      function renderQuestion() {
        var q = items[state.index];
        var qType = q.type || "mcq";

        var progress = el("div", { class: "qz-progress" }, [
          "Question " +
            (state.index + 1) +
            " of " +
            items.length +
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
        var isLast = state.index + 1 >= items.length;
        var nextBtn = el("button", { class: "qz-next", type: "button" }, [
          isLast ? "See score \u2192" : "Next \u2192",
        ]);
        nextBtn.addEventListener("click", function () {
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

          card.appendChild(
            el("div", { class: "qz-verdict" }, [
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
            ]),
          );

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
          });

          actions.innerHTML = "";
          card.appendChild(
            el("div", { class: "qz-verdict" }, [
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
            ]),
          );

          appendNextButton(actions);
        });
        actions.appendChild(checkBtn);
      }

      function renderSummary() {
        if (!state.finished) {
          state.finished = true;
          var now = new Date();
          var record = {
            type: "assignment",
            submission_type: "graded",
            subject: subject,
            lesson: lesson,
            student_id: session.student_id,
            name: session.student_name,
            email: null,
            date: isoDate(now),
            submitted_time: now.toISOString(),
            score: state.score,
            total: items.length,
            answers: state.answers,
          };

          queueSubmission(record);

          // Best-effort, same fallback philosophy as the rest of the site —
          // the record already lives in localStorage via queueSubmission.
          postToDrive(
            Object.assign({ action: "upload_submission" }, record),
          ).catch(function () {});
        }

        var total = items.length;
        var pct = total ? Math.round((state.score / total) * 100) : 0;
        var summary = el("div", { class: "qz-summary frame" }, [
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
          el("div", { class: "qz-summary__score" }, [
            state.score + " / " + total,
          ]),
          el("div", { class: "qz-summary__label" }, [
            pct +
              "% correct \u00b7 " +
              session.student_name +
              " \u00b7 submitted",
          ]),
        ]);
        root.appendChild(summary);
      }
    }
  }

  window.AssignEngine = { mount: mount };
})();
