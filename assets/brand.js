/* ==========================================================================
   brand.js — the Handasa logo redraws itself on hover (every page; linked by
   the BRAND block that tools/seo/seo_build.py stamps into each <head>).

   The <img> logos (header .brand-logo, the home hero, the sign-in screens)
   are swapped for an inline copy of assets/brand/handasa-mark.svg so the «هـ»
   and the amber arc can be drawn again with a stroke, then filled. The tile
   colour comes from CSS (--logo-tile, see brand.css) so dark mode just works.
   No JavaScript, a failed fetch or prefers-reduced-motion = the plain <img>,
   which already looks right. Never blocks anything.
   ========================================================================== */
(function () {
  'use strict';
  var SRC = '/assets/brand/handasa-mark.svg';
  var SEL = 'img.brand-logo, img.brand-hero-logo, .aew-brand img';
  var markup = null;

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function build(img) {
    var wrap = document.createElement('span');
    wrap.innerHTML = markup;
    var svg = wrap.querySelector('svg');
    if (!svg) return;
    var title = svg.querySelector('title');
    if (title) title.parentNode.removeChild(title);
    svg.setAttribute('class', (img.getAttribute('class') || '') + ' brand-svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (img.getAttribute('width')) svg.setAttribute('width', img.getAttribute('width'));
    if (img.getAttribute('height')) svg.setAttribute('height', img.getAttribute('height'));
    var rect = svg.querySelector('rect');
    if (rect) rect.setAttribute('class', 'logo-tile');
    var paths = svg.querySelectorAll('path');
    for (var i = 0; i < paths.length; i++) {
      paths[i].setAttribute('pathLength', '1');
      paths[i].setAttribute('class', paths[i].parentNode.tagName.toLowerCase() === 'g' ? 'logo-glyph' : 'logo-arc');
    }
    img.parentNode.replaceChild(svg, img);
    var host = svg.closest('a') || svg.parentNode;
    host.addEventListener('mouseenter', function () { replay(svg); });
    host.addEventListener('focusin', function () { replay(svg); });
  }

  function replay(svg) {
    if (svg.classList.contains('is-drawing')) return;
    svg.classList.add('is-drawing');
    setTimeout(function () { svg.classList.remove('is-drawing'); }, 1100);
  }

  function upgrade(root) {
    if (!markup) return;
    var imgs = (root || document).querySelectorAll(SEL);
    for (var i = 0; i < imgs.length; i++) build(imgs[i]);
  }

  function start() {
    if (reducedMotion() || !window.fetch || !document.querySelector) return;
    fetch(SRC, { credentials: 'same-origin' }).then(function (r) {
      return r.ok ? r.text() : null;
    }).then(function (text) {
      if (!text || text.indexOf('<svg') === -1) return;
      markup = text;
      upgrade(document);
      // the sign-in screens are added later by auth.js
      if (window.MutationObserver) {
        new MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) {
            for (var j = 0; j < list[i].addedNodes.length; j++) {
              var n = list[i].addedNodes[j];
              if (n.nodeType === 1 && (n.matches(SEL) || n.querySelector(SEL))) upgrade(n.parentNode || n);
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      }
    }).catch(function () { /* keep the <img> */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
