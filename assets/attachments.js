/* ==========================================================================
   attachments.js — renders a lesson's attachments.json as inline previews
   and download links, linking straight to Drive's own file URLs.

   Files are expected to be shared "Anyone with the link / Viewer" (the
   Attachment Maker tab + Code.gs's handleUploadAttachment set this
   automatically on upload). No Apps Script proxy is involved in serving
   files back out anymore — Code.gs's doGet is just a health check now.
   See the note at the top of Code.gs for why (the old base64 data-URI
   proxy lived inside the Apps Script HTML sandbox, which blocks
   downloads outright).
   ========================================================================== */

(function () {
  "use strict";

  // Types Drive's own /preview endpoint can render inline in an iframe.
  // Covers images/PDF plus Office formats, which Drive converts on the fly.
  var EMBEDDABLE_TYPES = ["pdf", "png", "jpg", "jpeg", "gif", "webp",
    "pptx", "ppt", "docx", "doc", "xlsx", "xls"];

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

  function previewUrl(fileId) {
    // Drive's own inline-embed endpoint — works in an <iframe> without
    // the file ever needing "download" permission, just "view".
    return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/preview";
  }

  function viewUrl(fileId) {
    // Drive's normal viewer page — what "Open" should point at.
    return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view";
  }

  function downloadUrl(fileId) {
    // Direct download. Works for anyone-with-link files under Drive's
    // per-file daily quota; large/heavily-hit files may show Drive's
    // "can't scan for viruses" interstitial with a "Download anyway" link
    // instead of streaming immediately — that's Drive's own behavior,
    // not a bug here.
    return "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(fileId);
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
          el("span", { class: "tick-br" }),
          el("span", { class: "tick-bl" }),
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
          row.appendChild(el("iframe", { src: previewUrl(fileId), title: title, loading: "lazy", allow: "autoplay" }));
        }

        listWrap.appendChild(row);
      });
    }
  }

  window.AttachEngine = { mount: mount };
})();
