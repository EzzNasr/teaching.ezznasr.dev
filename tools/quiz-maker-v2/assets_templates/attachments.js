/* ==========================================================================
   attachments.js — renders a lesson's attachments.json as inline previews
   and open/download links straight to Google Drive.

   IMPORTANT: this does NOT go through the Apps Script Drive bridge for
   reading files — Code.gs's doGet() no longer serves file bytes (see its
   header comment), it only answers a health-check ping now. Every file
   uploaded via the Attachment Maker tab is set to "Anyone with the link
   can view" at upload time (Code.gs: handleUploadAttachment), so this
   script can link directly to Drive's own view/download/preview URLs —
   no bridge call needed to read a file, only to upload/delete one.

   Note on the embedded <iframe> preview: Google's /preview endpoint can
   occasionally fail for anonymous viewers whose browser blocks third-party
   cookies (Drive uses cookies to verify "anyone with the link" access
   inside an iframe). The Open/Download links below are plain top-level
   navigations to drive.google.com and are not affected by that — if the
   inline preview ever looks broken, Open/Download are the reliable path.

   ========================================================================== */

(function () {
  "use strict";

  // Phase 2.5 step G: the teacher adds files from his browser page (dashboard/my-lessons.html); that list is kept on
  // the server (get_attachments) and shown after this folder's attachments.json. DRIVE_ENDPOINT is baked in by the
  // Quiz Maker's "Sync site assets", like video.js. If the server cannot be reached, attachments.json alone is shown.
  var DRIVE_ENDPOINT = "{{DRIVE_ENDPOINT}}";

  // Google Drive's /preview endpoint isn't limited to PDFs and images —
  // it renders Office documents too. The original list only had the six
  // below, so a .docx/.pptx/.xlsx attachment silently fell through to
  // Open/Download-only with no inline embed, which is the "it stopped
  // being embedded" symptom this list update fixes.
  var EMBEDDABLE_TYPES = [
    "pdf", "png", "jpg", "jpeg", "gif", "webp",
    "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt",
  ];
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

  function viewUrl(fileId) {
    return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view?usp=drive_link";
  }
  function downloadUrl(fileId) {
    return "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(fileId);
  }
  function previewUrl(fileId) {
    // Google explicitly disallows framing /view — /preview is the one
    // meant to be embedded in an iframe.
    return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/preview";
  }

  // This lesson's key, from the page's own folder: /science/secondary/grade-1-secondary/chapter-1-lesson-1/ -> that path.
  function lessonKey() {
    var parts = location.pathname.split("/").filter(Boolean);
    if (parts.length && /\.html?$/i.test(parts[parts.length - 1])) parts.pop();
    return parts.map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } }).join("/");
  }

  function fromServer() {
    var lesson = lessonKey();
    if (!lesson || !/^https:\/\//.test(DRIVE_ENDPOINT)) return Promise.resolve([]);
    return fetch(DRIVE_ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight against Apps Script; doPost JSON.parses regardless.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "get_attachments", lesson: lesson }),
    })
      .then(function (resp) { return resp.json(); })
      .then(function (data) { return data && data.ok && Array.isArray(data.items) ? data.items : []; })
      .catch(function () { return []; });
  }

  function mount(rootSelector) {
    var root = document.querySelector(rootSelector);
    if (!root) return;

    var stamp = root.querySelector("#attachments-stamp");
    var listWrap = root.querySelector("#attachments-list");
    if (!listWrap) return;

    var fromFile = fetch("attachments.json", { cache: "no-store" })
      .then(function (resp) { return resp.ok ? resp.json() : []; })
      .catch(function () { return []; })
      .then(function (items) { return Array.isArray(items) ? items : []; });
    Promise.all([fromFile, fromServer()]).then(function (lists) {
      var seen = {}, all = [];
      lists[0].concat(lists[1]).forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var id = it.drive_file_id ? String(it.drive_file_id) : "";
        if (id && seen[id]) return;
        if (id) seen[id] = true;
        all.push(it);
      });
      renderList(all);
    });

    function renderList(items) {
      listWrap.innerHTML = "";

      if (!items.length) {
        if (stamp) { stamp.textContent = "Coming soon"; stamp.className = "stamp planned"; }
        listWrap.appendChild(el("div", { class: "attach-empty frame" }, [
          "No files have been added to this lesson yet.",
        ]));
        return;
      }

      if (stamp) { stamp.textContent = items.length + (items.length === 1 ? " file" : " files"); stamp.className = "stamp ready"; }

      items.forEach(function (item) {
        var fileId = item.drive_file_id;
        var type = (item.type || "").toLowerCase();
        var title = item.title || "Untitled";

        if (!fileId) {
          listWrap.appendChild(el("div", { class: "attach-item frame" }, [
            el("div", { class: "attach-item__title" }, [title, el("span", { class: "attach-item__actions" }, ["Not available yet"])]),
          ]));
          return;
        }

        var openLink = el("a", { href: viewUrl(fileId), target: "_blank", rel: "noopener" }, ["Open \u2192"]);
        var downloadLink = el("a", { href: downloadUrl(fileId), target: "_blank", rel: "noopener", style: "margin-left:12px;" }, ["Download"]);
        var row = el("div", { class: "attach-item frame" }, [
          el("div", { class: "attach-item__title" }, [title, el("span", { class: "attach-item__actions" }, [openLink, downloadLink])]),
        ]);

        if (EMBEDDABLE_TYPES.indexOf(type) !== -1) {
          row.appendChild(el("iframe", { src: previewUrl(fileId), title: title, loading: "lazy" }));
        }

        listWrap.appendChild(row);
      });
    }
  }

  window.AttachEngine = { mount: mount };
})();