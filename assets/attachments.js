/* ==========================================================================
   attachments.js — renders a lesson's attachments.json as inline previews
   and download links, proxied through the Drive bridge Web App so the
   student's browser only ever sees this site + the Apps Script URL —
   never drive.google.com or the folder it lives in.

   DRIVE_ENDPOINT is baked in at build time (see assign.js header comment).
   ========================================================================== */

(function () {
  "use strict";

  var DRIVE_ENDPOINT = "https://script.google.com/macros/s/AKfycbzpyJWSI9aRseig5JBmydzo34ogfNYv9qQH1HrzIUGcgETF1rk4pE8qO8j7Hp3FrVjCvw/exec";
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

  function fileUrl(fileId) {
    return DRIVE_ENDPOINT + (DRIVE_ENDPOINT.indexOf("?") >= 0 ? "&" : "?") + "action=file&id=" + encodeURIComponent(fileId);
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

        if (!fileId || !DRIVE_ENDPOINT) {
          listWrap.appendChild(el("div", { class: "attach-item frame" }, [
            el("div", { class: "attach-item__title" }, [title, el("span", { class: "attach-item__actions" }, ["Not available yet"])]),
          ]));
          return;
        }

        var url = fileUrl(fileId);
        var openLink = el("a", { href: url, target: "_blank", rel: "noopener" }, ["Open \u2192"]);
        var row = el("div", { class: "attach-item frame" }, [
          el("div", { class: "attach-item__title" }, [title, el("span", { class: "attach-item__actions" }, [openLink])]),
        ]);

        if (EMBEDDABLE_TYPES.indexOf(type) !== -1) {
          row.appendChild(el("iframe", { src: url, title: title, loading: "lazy" }));
        }

        listWrap.appendChild(row);
      });
    }
  }

  window.AttachEngine = { mount: mount };
})();
