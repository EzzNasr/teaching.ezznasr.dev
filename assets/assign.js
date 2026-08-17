/* ==========================================================================
   assign.js — assignment submission engine for teaching.ezznasr.dev.

   Reads data-subject / data-lesson / data-mode off the mount container.
   data-mode is one of: "text" | "url" | "file" | "both".

   Every submission is queued into localStorage ("teaching_pending_submissions",
   same bucket quiz.js uses) as a durability fallback, AND — when the Drive
   bridge endpoint below is configured — POSTed straight to the Apps Script
   Web App, which saves it into your Drive folder. Students only ever talk
   to this site and the Web App URL; they never see drive.google.com.

   DRIVE_ENDPOINT is baked in at build time by app_main.py's "Sync site
   assets" action (see modules/common.py sync_site_assets). If it's empty,
   url/file/both modes will queue locally but tell the student submission
   isn't fully wired up yet — set it up in the Quiz Maker app first.
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
        if (!data || !data.ok) throw new Error((data && data.error) || "Drive bridge rejected the submission.");
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

    var uiMode = mode === "both" ? "url" : mode; // for "both", start on the link tab

    render();

    function render() {
      root.innerHTML = "";

      var nameInput = el("input", { class: "qz-input", type: "text", placeholder: "Your name", required: "required" });
      var emailInput = el("input", { class: "qz-input", type: "email", placeholder: "Email (optional)" });
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
        var name = nameInput.value.trim();
        if (!name) {
          errorMsg.textContent = "Please enter your name.";
          return;
        }

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
            name: name,
            email: emailInput.value.trim() || null,
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
        el("div", { class: "qz-field" }, [nameInput]),
        el("div", { class: "qz-field" }, [emailInput]),
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
      ]);
      root.appendChild(summary);
    }
  }

  window.AssignEngine = { mount: mount };
})();
