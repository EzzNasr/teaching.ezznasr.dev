/* ==========================================================================
   capture.js — photo answers for teaching.ezznasr.dev (Phase 2, Session 3).

   A student answers a "written" question on paper and photographs it. This
   file is the whole client side of that:
     - live camera (getUserMedia) with preview, "Use photo" / "Retake";
     - the plain file input (capture="environment") when there is no camera
       API or permission is refused, plus a "From gallery" choice;
     - compression in the browser (long edge ~1600 px, JPEG) so a 12 MP
       phone photo is a few hundred KB, not 5 MB, on a weak connection;
     - the photos are kept in IndexedDB while the student works, so a reload,
       a closed tab or a dropped connection does not lose them;
     - uploading is one photo at a time and idempotent (each photo has its own
       id; the server ignores a re-sent one), with per-photo status.

   quiz.js / assign.js load this lazily (only when a page has a "written"
   question), so lesson pages generated before this file existed need no edit.
   No dependencies; styles are injected so no stylesheet has to change.

   Everything that can be tested without a browser (fitSize, runUploads) is
   exported for Node as well: require("./capture.js").
   ========================================================================== */

(function (root) {
  "use strict";

  var MAX_EDGE = 1600;
  var QUALITY_STEPS = [0.8, 0.65, 0.5];
  var MAX_BYTES = 2.4 * 1024 * 1024;          // server refuses > 2.5 MB
  var DB_NAME = "teaching-capture", STORE = "drafts";

  // ---- pure helpers --------------------------------------------------------

  // Scale (w,h) so the long edge is at most `max`; never upscales.
  function fitSize(w, h, max) {
    max = max || MAX_EDGE;
    var long = Math.max(w, h);
    if (!(long > max)) return { w: w, h: h };
    var k = max / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function newId() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  // Sends items one at a time. send(item) must return a Promise. An item that
  // is already "ok" is skipped, so calling this again after a failure only
  // re-sends what is left. Resolves { ok, failed:[item], error } and never rejects.
  function runUploads(items, send, onChange) {
    var failed = [], firstError = null;
    function note() { if (onChange) { try { onChange(); } catch (e) { /* display only */ } } }
    return items.reduce(function (chain, item) {
      return chain.then(function () {
        if (item.status === "ok") return null;
        item.status = "uploading"; item.error = ""; note();
        return Promise.resolve().then(function () { return send(item); }).then(
          function () { item.status = "ok"; note(); },
          function (err) {
            item.status = "failed"; item.error = (err && err.message) || "Upload failed.";
            if (!firstError) firstError = item.error;
            failed.push(item); note();
          }
        );
      });
    }, Promise.resolve()).then(function () { return { ok: failed.length === 0, failed: failed, error: firstError }; });
  }

  // ---- image -> compressed JPEG blob (browser only) --------------------------

  function decode(source) {
    if (root.createImageBitmap) {
      return root.createImageBitmap(source, { imageOrientation: "from-image" }).catch(function () {
        return root.createImageBitmap(source);
      }).catch(function () { return viaImg(source); });
    }
    return viaImg(source);
  }
  function viaImg(source) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(source), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That file isn't a photo this browser can open.")); };
      img.src = url;
    });
  }
  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) { canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("Couldn't prepare the photo.")); }, "image/jpeg", q); return; }
      try {
        var d = canvas.toDataURL("image/jpeg", q), bin = atob(d.split(",")[1]), a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        resolve(new Blob([a], { type: "image/jpeg" }));
      } catch (e) { reject(new Error("Couldn't prepare the photo.")); }
    });
  }
  // Blob/File (or a <video> frame source) -> JPEG Blob, long edge <= MAX_EDGE, under MAX_BYTES.
  function compress(source) {
    return decode(source).then(function (img) {
      var w = img.width || img.videoWidth, h = img.height || img.videoHeight;
      if (!w || !h) throw new Error("That photo looks empty.");
      var edge = MAX_EDGE;
      function attempt(qi) {
        var s = fitSize(w, h, edge), c = document.createElement("canvas");
        c.width = s.w; c.height = s.h;
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s.w, s.h);   // transparent PNGs would turn black as JPEG
        ctx.drawImage(img, 0, 0, s.w, s.h);
        return toBlob(c, QUALITY_STEPS[qi]).then(function (b) {
          if (b.size <= MAX_BYTES) return b;
          if (qi + 1 < QUALITY_STEPS.length) return attempt(qi + 1);
          if (edge > 1000) { edge = 1000; return attempt(0); }
          throw new Error("That photo is too large. Retake it a little further away.");
        });
      }
      return attempt(0);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ""), i = s.indexOf(","); resolve(i >= 0 ? s.slice(i + 1) : s); };
      r.onerror = function () { reject(new Error("Couldn't read the photo.")); };
      r.readAsDataURL(blob);
    });
  }

  // ---- IndexedDB draft (best effort: no IndexedDB just means no draft) ---------

  function openDb() {
    return new Promise(function (resolve) {
      try {
        var req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE, { keyPath: "key" }); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function dbDo(mode, fn) {
    return openDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
          tx.oncomplete = function () { db.close(); resolve(req ? req.result : null); };
          tx.onerror = tx.onabort = function () { db.close(); resolve(null); };
        } catch (e) { try { db.close(); } catch (e2) { /* ignore */ } resolve(null); }
      });
    });
  }
  function draftLoad(key) { return dbDo("readonly", function (s) { return s.get(key); }); }
  function draftSave(key, items) {
    var keep = items.map(function (i) { return { id: i.id, blob: i.blob, status: i.status === "ok" ? "ok" : "local" }; });
    return keep.length ? dbDo("readwrite", function (s) { return s.put({ key: key, items: keep, saved_at: Date.now() }); })
                       : dbDo("readwrite", function (s) { return s.delete(key); });
  }
  function draftClear(key) { return dbDo("readwrite", function (s) { return s.delete(key); }); }

  // ---- widget ---------------------------------------------------------------

  var cssDone = false;
  function injectCss() {
    if (cssDone || !root.document) return;
    cssDone = true;
    var st = document.createElement("style");
    st.textContent =
      ".tc{margin:12px 0}" +
      ".tc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}" +
      ".tc-btn{font:inherit;font-size:13.5px;padding:10px 14px;border:1px solid var(--line,#c9c9c9);border-radius:9px;background:var(--panel-soft,transparent);color:var(--ink,inherit);cursor:pointer;min-height:44px}" +
      ".tc-btn:hover:not(:disabled){border-color:var(--accent,#2563eb)}.tc-btn:disabled{opacity:.5;cursor:default}" +
      ".tc-btn--primary{border-color:var(--accent,#2563eb);color:var(--accent-strong,var(--accent,#2563eb))}" +
      ".tc-cam{position:relative;margin-bottom:10px;border:1px solid var(--line,#c9c9c9);border-radius:10px;overflow:hidden;background:#000}" +
      ".tc-cam video{display:block;width:100%;max-height:60vh;object-fit:contain}" +
      ".tc-cam .tc-actions{position:absolute;left:0;right:0;bottom:0;margin:0;padding:10px;justify-content:center;background:linear-gradient(transparent,rgba(0,0,0,.6))}" +
      ".tc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}" +
      ".tc-thumb{position:relative;border:1px solid var(--line,#c9c9c9);border-radius:10px;overflow:hidden;background:var(--panel-soft,transparent)}" +
      ".tc-thumb img{display:block;width:100%;height:120px;object-fit:cover}" +
      ".tc-thumb__bar{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:4px 6px;font-size:11.5px}" +
      ".tc-thumb__x{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:6px}" +
      ".tc-st--ok{color:var(--status-shipped,#15803d)}.tc-st--failed{color:var(--status-fail,#b91c1c)}" +
      ".tc-msg{font-size:13px;margin:8px 0;color:var(--ink-dim,inherit)}.tc-msg--err{color:var(--status-fail,#b91c1c)}";
    document.head.appendChild(st);
  }

  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === "class") n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === "object" ? c : document.createTextNode(String(c))); });
    return n;
  }

  // opts: { key: draft key (lesson+student+question), max: 3, onChange: fn }
  function createWidget(opts) {
    injectCss();
    opts = opts || {};
    var max = opts.max || 3, key = opts.key || "", items = [], stream = null, busy = false;
    var wrap = h("div", { "class": "tc" });
    var camBox = h("div", { "class": "tc-cam", hidden: "hidden" });
    var grid = h("div", { "class": "tc-grid" });
    var msg = h("div", { "class": "tc-msg", "aria-live": "polite" });
    var camBtn = h("button", { type: "button", "class": "tc-btn tc-btn--primary" }, ["📷 Take photo"]);
    var galBtn = h("button", { type: "button", "class": "tc-btn" }, ["From gallery"]);
    var fileCam = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: "hidden" });
    var fileGal = h("input", { type: "file", accept: "image/*", hidden: "hidden" });
    wrap.appendChild(h("div", { "class": "tc-actions" }, [camBtn, galBtn, fileCam, fileGal]));
    wrap.appendChild(camBox); wrap.appendChild(grid); wrap.appendChild(msg);

    function say(text, err) { msg.textContent = text || ""; msg.className = "tc-msg" + (err ? " tc-msg--err" : ""); }
    function changed() {
      draftSave(key, items);
      camBtn.disabled = galBtn.disabled = items.length >= max || busy;
      if (opts.onChange) { try { opts.onChange(); } catch (e) { /* display only */ } }
    }

    function render() {
      grid.innerHTML = "";
      items.forEach(function (it, idx) {
        if (!it.url) it.url = URL.createObjectURL(it.blob);
        var rm = h("button", { type: "button", "class": "tc-thumb__x", "aria-label": "Remove photo " + (idx + 1) }, ["✕ Remove"]);
        rm.disabled = busy;
        rm.addEventListener("click", function () { removeAt(idx); });
        var st = it.status === "ok" ? h("span", { "class": "tc-st--ok" }, ["✓ sent"])
               : it.status === "failed" ? h("span", { "class": "tc-st--failed", title: it.error || "" }, ["⚠ not sent"])
               : it.status === "uploading" ? h("span", {}, ["sending…"]) : h("span", {}, ["#" + (idx + 1)]);
        grid.appendChild(h("div", { "class": "tc-thumb" }, [
          h("img", { src: it.url, alt: "Your photo " + (idx + 1) }),
          h("div", { "class": "tc-thumb__bar" }, [st, rm]),
        ]));
      });
    }

    function removeAt(idx) {
      var it = items.splice(idx, 1)[0];
      if (it && it.url) { try { URL.revokeObjectURL(it.url); } catch (e) { /* ignore */ } }
      say(""); render(); changed();
    }

    function addBlob(blob) {
      if (items.length >= max) { say("You can attach up to " + max + " photos.", true); return; }
      items.push({ id: newId(), blob: blob, status: "local", error: "" });
      say(""); render(); changed();
    }

    function addFile(file) {
      if (!file) return;
      say("Preparing photo…");
      compress(file).then(addBlob, function (e) { say(e.message || "Couldn't use that photo.", true); });
    }
    fileCam.addEventListener("change", function () { addFile(fileCam.files && fileCam.files[0]); fileCam.value = ""; });
    fileGal.addEventListener("change", function () { addFile(fileGal.files && fileGal.files[0]); fileGal.value = ""; });
    galBtn.addEventListener("click", function () { fileGal.click(); });

    function stopCamera() {
      if (stream) { stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } }); stream = null; }
      camBox.hidden = true; camBox.innerHTML = "";
    }
    function openCamera() {
      var md = root.navigator && root.navigator.mediaDevices;
      if (!md || !md.getUserMedia || !root.isSecureContext) { fileCam.click(); return; }
      md.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } }, audio: false }).then(function (s) {
        stream = s;
        var video = h("video", { playsinline: "playsinline", autoplay: "autoplay", muted: "muted" });
        video.muted = true; video.srcObject = s;
        var snap = h("button", { type: "button", "class": "tc-btn tc-btn--primary" }, ["Use photo"]);
        var cancel = h("button", { type: "button", "class": "tc-btn" }, ["Cancel"]);
        snap.addEventListener("click", function () {
          if (!video.videoWidth) { say("The camera isn't ready yet — wait a second.", true); return; }
          compress(video).then(function (b) { stopCamera(); addBlob(b); }, function (e) { say(e.message || "Couldn't take the photo.", true); });
        });
        cancel.addEventListener("click", stopCamera);
        camBox.innerHTML = ""; camBox.hidden = false;
        camBox.appendChild(video); camBox.appendChild(h("div", { "class": "tc-actions" }, [snap, cancel]));
        var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay blocked: user taps Use photo anyway */ });
      }, function () {
        say("Camera not available — opening your photo picker instead.");
        fileCam.click();
      });
    }
    camBtn.addEventListener("click", function () { if (!camBox.hidden) return; openCamera(); });

    // restore a draft left by a reload / closed tab
    if (key) {
      draftLoad(key).then(function (d) {
        if (!d || !d.items || !d.items.length || items.length) return;
        items = d.items.slice(0, max).map(function (i) { return { id: i.id, blob: i.blob, status: i.status === "ok" ? "ok" : "local", error: "" }; });
        say("Restored your photo" + (items.length > 1 ? "s" : "") + " from before."); render(); changed();
      });
    }

    return {
      el: wrap,
      count: function () { return items.length; },
      pending: function () { return items.filter(function (i) { return i.status !== "ok"; }).length; },
      // send(item, base64) -> Promise. Resolves { ok, failed, error }.
      upload: function (send) {
        busy = true; say("Sending photos…"); render(); changed();
        return runUploads(items, function (it) { return blobToBase64(it.blob).then(function (b64) { return send(it, b64); }); }, render)
          .then(function (r) {
            busy = false; render(); changed();
            say(r.ok ? "" : (r.error || "Some photos weren't sent.") + " Tap Submit again to retry.", !r.ok);
            return r;
          });
      },
      stop: stopCamera,
      clear: function () { items.forEach(function (i) { if (i.url) { try { URL.revokeObjectURL(i.url); } catch (e) { /* ignore */ } } }); items = []; stopCamera(); render(); return draftClear(key); },
    };
  }

  var api = { fitSize: fitSize, runUploads: runUploads, compress: compress, blobToBase64: blobToBase64, createWidget: createWidget,
              draftClear: draftClear, newId: newId, MAX_EDGE: MAX_EDGE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.TeachingCapture = api;
})(typeof window !== "undefined" ? window : globalThis);
