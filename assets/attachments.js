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

  var EMBEDDABLE_TYPES = ["pdf", "png", "jpg", "jpeg", "gif", "webp"];

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

  function mount(rootSelector) {
    var root = document.querySelector(rootSelector);
    if (!root) return;

    var stamp = root.querySelector("#attachments-stamp");
    var listWrap = root.querySelector("#attachments-list");
    if (!listWrap) return;

    fetch("attachments.json", { cache: "no-store" })
      .then(function (resp) { return resp.ok ? resp.json() : []; })
      .catch(function () { return []; })
      .then(function (items) {
        renderList(Array.isArray(items) ? items : []);
      });

    function renderList(items) {
      listWrap.innerHTML = "";

      if (!items.length) {
        if (stamp) { stamp.textContent = "Coming soon"; stamp.className = "stamp planned"; }
        listWrap.appendChild(el("div", { class: "attach-empty frame" }, [
          "No attachments for this lesson yet.",
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
