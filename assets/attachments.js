/**
 * attachments.js — renders the Attachments block on a lesson page.
 *
 * Reads ./attachments.json (co-located with the lesson's index.html),
 * then links/embeds each file straight from drive.google.com. Files must
 * be shared "Anyone with the link — Viewer" (Code.gs does this
 * automatically for new uploads via handleUploadAttachment).
 *
 * No Apps Script involved in serving files — Drive's own preview/view/
 * download URLs are what actually work reliably in an iframe and for
 * downloads, unlike proxying bytes through Apps Script's doGet.
 */
(function () {
  var INLINE_TYPES = { pdf: true, image: true, png: true, jpg: true, jpeg: true, gif: true };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function driveUrls(id) {
    return {
      preview: "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/preview",
      view: "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view",
      download: "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(id),
    };
  }

  function renderItem(item) {
    var urls = driveUrls(item.drive_file_id);
    var inline = !!INLINE_TYPES[String(item.type || "").toLowerCase()];

    var html = '<div class="attach-item frame">';
    html += '<span class="tick-br"></span><span class="tick-bl"></span>';
    html += '<div class="attach-item__title">';
    html += "<span>" + escapeHtml(item.title || "Attachment") + "</span>";
    html += '<span class="attach-item__actions">';
    html += '<a href="' + urls.view + '" target="_blank" rel="noopener">Open</a>';
    html += " &middot; ";
    html += '<a href="' + urls.download + '" target="_blank" rel="noopener">Download</a>';
    html += "</span></div>";
    if (inline) {
      html += '<iframe src="' + urls.preview + '" loading="lazy" title="' + escapeHtml(item.title || "Attachment preview") + '"></iframe>';
    }
    html += "</div>";
    return html;
  }

  function setStamp(stampEl, text, cls) {
    if (!stampEl) return;
    stampEl.textContent = text;
    stampEl.className = "stamp " + cls;
  }

  function mount(selector) {
    var root = document.querySelector(selector);
    if (!root) return;

    var stamp = document.getElementById("attachments-stamp");
    var list = document.getElementById("attachments-list");
    if (!list) return;

    fetch("attachments.json", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("No attachments.json (" + res.status + ")");
        return res.json();
      })
      .then(function (items) {
        if (!Array.isArray(items) || items.length === 0) {
          setStamp(stamp, "None yet", "planned");
          return;
        }
        list.innerHTML = items.map(renderItem).join("");
        setStamp(stamp, items.length + (items.length === 1 ? " file" : " files"), "ready");
      })
      .catch(function () {
        setStamp(stamp, "None yet", "planned");
      });
  }

  window.AttachEngine = { mount: mount };
})();
