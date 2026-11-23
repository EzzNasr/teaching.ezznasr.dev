/* ==========================================================================
   teachers.js: who teaches each subject, and their photo.

   THIS IS THE ONE FILE TO EDIT WHEN A REAL PHOTO ARRIVES (docs/teacher-photos.md):
     1. put the photo in assets/teachers/ (for example assets/teachers/programming.jpg,
        portrait, about 600 x 800, under 200 KB);
     2. below, set that subject's `photo` to its path and `placeholder` to false.
   The home page transition and the photo on each subject's front page both read
   from here. The <img> written in each subject page is only the no-JavaScript
   fallback (it shows the placeholder); this file replaces it on load.

   The repo is PUBLIC: only add a photo the owner has approved for publishing.

   It also plays the home-page transition: clicking a subject card marked
   data-teacher="..." shows that teacher big for about a second, then opens the
   link. It never blocks the link:
     - without JavaScript, or if anything here fails, the plain href just works;
     - prefers-reduced-motion, or a modified click (Ctrl, Shift, middle button,
       new tab), goes straight to the page;
     - Esc, a click or a tap during the transition skips it.
   ========================================================================== */
(function () {
  'use strict';

  var TEACHERS = {
    programming: {
      name: 'Ezz Nasr', nameAr: 'عز نصر',
      subject: 'Programming', subjectAr: 'البرمجة',
      photo: '/assets/teachers/placeholder-programming.svg', placeholder: true
    },
    math: {
      name: 'Ezz Nasr', nameAr: 'عز نصر',
      subject: 'Math', subjectAr: 'الرياضيات',
      photo: '/assets/teachers/placeholder-math.svg', placeholder: true
    },
    science: {
      name: 'Mr. Adam', nameAr: 'أ. آدم',
      subject: 'Science', subjectAr: 'العلوم',
      photo: '/assets/teachers/placeholder-science.svg', placeholder: true
    },
    english: {
      name: 'Ezz Nasr', nameAr: 'عز نصر',
      subject: 'English', subjectAr: 'الإنجليزية',
      photo: '/assets/teachers/placeholder-english.svg', placeholder: true
    }
  };

  // Symbols that burst around the teacher in the home-page transition.
  var GLYPHS = {
    programming: ['{ }', '</>', '=>', '()', ';', '01', '[ ]', '#'],
    math: ['π', '∑', '√', '∞', '∫', 'Δ', 'x²', '≠'],
    science: ['⚛', 'H₂O', 'CO₂', 'Na', 'Δ', 'e⁻', 'O₂', 'Fe'],
    english: ['Aa', '“ ”', '?', '!', 'ABC', '&', '…', 'Hi']
  };
  var GLYPH_SPOTS = [[10, 16, 1.0], [84, 12, .8], [6, 62, .9], [90, 56, 1.1], [18, 86, .7], [78, 84, .9], [30, 6, .6], [64, 4, .7]];

  // How long the home-page transition shows the teacher before opening the page (ms).
  var INTRO_MS = 1000;

  window.TEACHERS = TEACHERS;

  function altFor(t) {
    return t.placeholder ? 'Photo placeholder for the ' + t.subject + ' teacher' : t.name + ', ' + t.subject + ' teacher';
  }

  // ---- 1. photo slots on the subject front pages: <aside data-teacher-slot="math">
  function fillSlots() {
    var slots = document.querySelectorAll('[data-teacher-slot]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i], t = TEACHERS[slot.getAttribute('data-teacher-slot')];
      if (!t) continue;
      var img = slot.querySelector('[data-teacher-img]');
      if (img && img.getAttribute('src') !== t.photo) img.setAttribute('src', t.photo);
      if (img) img.setAttribute('alt', altFor(t));
      var nm = slot.querySelectorAll('[data-teacher-name]');
      for (var j = 0; j < nm.length; j++) nm[j].textContent = nm[j].getAttribute('lang') === 'ar' ? t.nameAr : t.name;
      slot.classList.toggle('is-placeholder', !!t.placeholder);
    }
  }

  // ---- 2. the home-page transition
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  var overlay = null, leaving = false, timer = 0;

  function buildOverlay() {
    var el = document.createElement('div');
    el.className = 'ti-overlay';
    el.setAttribute('data-teacher-intro', '');
    el.innerHTML =
      '<div class="ti-backdrop"></div>' +
      '<div class="ti-rays" aria-hidden="true"></div>' +
      '<div class="ti-glyphs" aria-hidden="true"></div>' +
      '<div class="ti-stage">' +
        '<div class="ti-figure"><span class="ti-halo" aria-hidden="true"></span>' +
          '<img class="ti-photo" alt="" decoding="async"></div>' +
        '<div class="ti-caption"><span class="ti-kicker"></span><strong class="ti-name"></strong>' +
          '<span class="ti-placeholder-tag">Photo placeholder</span></div>' +
      '</div>' +
      '<p class="ti-live" role="status" aria-live="polite"></p>' +
      '<p class="ti-skip" aria-hidden="true">Esc or tap to skip</p>';
    document.body.appendChild(el);
    return el;
  }

  function go(href) {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    // Tests and screenshots: <html data-teacher-intro-hold> keeps the overlay up instead of leaving.
    if (document.documentElement.hasAttribute('data-teacher-intro-hold')) { window.__teacherIntro.wentTo = href; return; }
    window.location.assign(href);
  }

  function play(link, key, t) {
    var href = link.href;
    overlay = overlay || buildOverlay();
    overlay.setAttribute('data-subject', key);
    overlay.classList.toggle('is-placeholder', !!t.placeholder);
    overlay.querySelector('.ti-photo').src = t.photo;
    overlay.querySelector('.ti-kicker').textContent = t.subject;
    overlay.querySelector('.ti-name').textContent = t.name;
    var gl = overlay.querySelector('.ti-glyphs'), sy = GLYPHS[key] || [];
    gl.innerHTML = '';
    for (var i = 0; i < sy.length && i < GLYPH_SPOTS.length; i++) {
      var g = document.createElement('span'), at = GLYPH_SPOTS[i];
      g.textContent = sy[i];
      g.style.left = at[0] + '%'; g.style.top = at[1] + '%';
      g.style.fontSize = 'calc(' + at[2] + ' * clamp(28px, 6vw, 72px))';
      g.style.animationDelay = 'calc(var(--ti-ms) * ' + (0.12 + i * 0.03).toFixed(2) + ')';
      gl.appendChild(g);
    }
    overlay.querySelector('.ti-live').textContent = 'Opening ' + t.subject + '…';
    overlay.style.setProperty('--ti-ms', INTRO_MS + 'ms');
    var r = link.getBoundingClientRect();
    var cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth);
    var cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight);
    overlay.style.setProperty('--ti-x', Math.round(cx) + 'px');   // the burst starts from the card that was clicked
    overlay.style.setProperty('--ti-y', Math.round(cy) + 'px');
    overlay.onclick = function () { go(href); };
    leaving = false;
    overlay.classList.remove('is-on');
    void overlay.offsetWidth;            // restart the CSS animation
    overlay.classList.add('is-on');
    document.documentElement.classList.add('ti-active');
    timer = setTimeout(function () { go(href); }, INTRO_MS);
    window.__teacherIntro = { subject: key, href: href, ms: INTRO_MS };
  }

  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a[data-teacher]') : null;
    if (!link || e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (link.target && link.target !== '_self') return;
    if (reducedMotion() || document.documentElement.hasAttribute('data-no-teacher-intro')) return;
    var key = link.getAttribute('data-teacher'), t = TEACHERS[key];
    if (!t) return;
    try {
      e.preventDefault();
      play(link, key, t);
    } catch (err) {
      go(link.href);                      // never strand the visitor
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && overlay.classList.contains('is-on') && window.__teacherIntro) go(window.__teacherIntro.href);
  });

  // Back button from the subject page (page restored from the back/forward cache): hide the overlay again.
  window.addEventListener('pageshow', function () {
    leaving = false;
    clearTimeout(timer);
    if (overlay) overlay.classList.remove('is-on');
    document.documentElement.classList.remove('ti-active');
  });

  // Warm the photo up when a card is hovered or focused, so it is there when the transition starts.
  function warm(e) {
    var link = e.target && e.target.closest ? e.target.closest('a[data-teacher]') : null;
    var t = link && TEACHERS[link.getAttribute('data-teacher')];
    if (t && !t._warm) { t._warm = new Image(); t._warm.src = t.photo; }
  }
  document.addEventListener('pointerover', warm);
  document.addEventListener('focusin', warm);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillSlots);
  else fillSlots();
})();
