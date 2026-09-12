/* ==========================================================================
   common.js — tiny shared helpers for teaching.ezznasr.dev's client-side
   engines (auth.js, quiz.js, assign.js, attachments.js). Must load BEFORE
   all four — see quiz.html/assignment.html's <script> order.

   No DRIVE_ENDPOINT baked in here (unlike the other engines) — this file
   is static and copied byte-for-byte by sync_site_assets(), no per-site
   token substitution needed. Callers pass their own endpoint into
   postToDrive() instead.
   ========================================================================== */

window.TeachingCommon = (function () {
  "use strict";

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

  // Shared by every engine that talks to the Apps Script Web App. Sends
  // as text/plain (CORS-safelisted, so no preflight OPTIONS — Apps
  // Script has no doOptions() handler; doPost still JSON.parses the body
  // regardless of declared Content-Type). Retries once if Apps Script
  // returns an HTML page instead of JSON — a transient Google-side
  // hiccup (seen right after redeploys, under load), not a code bug.
  function postToDrive(driveEndpoint, payload, isRetry) {
    if (!driveEndpoint) return Promise.reject(new Error("not-configured"));
    return fetch(driveEndpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }).then(function (resp) {
      return resp.text().then(function (raw) {
        var data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          if (!isRetry) return postToDrive(driveEndpoint, payload, true);
          throw new Error("The server sent back something unexpected. Please try again.");
        }
        if (!data || !data.ok) throw new Error((data && data.error) || "Drive bridge rejected the request.");
        return data;
      });
    });
  }

  return { el: el, postToDrive: postToDrive };
})();
