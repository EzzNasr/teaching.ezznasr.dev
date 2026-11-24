/* ==========================================================================
   grade.js: small extras on a grade page (programming Senior 1/2, science Prep 3/Senior 1).
   Runs after the page has loaded and only ADDS to what the HTML already shows, so the page
   works the same without it. It never touches the HTML file itself: the lesson grid between
   <div class="lessons"> ... </div></div></section> is written by the Quiz Maker
   (tools/quiz-maker-v2/modules/common.py, layout_grid_cards).

     - each chapter heading gets its lesson count and a "seen" bar (n of m opened);
     - the hero gets the totals and one jump link per chapter;
     - a lesson the student opened on this device gets a "seen" tick.
   "Seen" is kept in this browser only (localStorage key handasa:seen), never sent anywhere.
   ========================================================================== */
(function () {
  'use strict';
  var KEY = 'handasa:seen';

  function readSeen() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSeen(map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* private mode: no ticks, nothing breaks */ }
  }
  function pathOf(a) {
    try { return new URL(a.getAttribute('href'), location.href).pathname; } catch (e) { return a.getAttribute('href'); }
  }
  function lessonsWord(n) { return n === 1 ? 'درس واحد' : n === 2 ? 'درسان' : (n >= 3 && n <= 10 ? n + ' دروس' : n + ' درس'); }
  function make(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function init() {
    var grid = document.querySelector('.lessons');
    if (!grid) return;
    var seen = readSeen();
    var cards = grid.querySelectorAll('a.lesson');

    // ---- seen ticks
    for (var i = 0; i < cards.length; i++) {
      var p = pathOf(cards[i]);
      if (seen[p]) cards[i].classList.add('is-seen');
    }
    grid.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a.lesson') : null;
      if (!a) return;
      var map = readSeen();
      map[pathOf(a)] = 1;
      saveSeen(map);
    });

    // ---- chapters: count, seen bar, jump links
    var heads = grid.querySelectorAll('.chapter-head');
    var jump = document.querySelector('[data-grade-jump]');
    var chapters = [];
    for (var h = 0; h < heads.length; h++) {
      var head = heads[h], total = 0, done = 0, n = head.nextElementSibling;
      while (n && !n.classList.contains('chapter-head')) {
        if (n.matches('a.lesson')) { total++; if (n.classList.contains('is-seen')) done++; }
        n = n.nextElementSibling;
      }
      var num = (head.id.match(/chapter-(\d+)/) || [])[1];
      head.setAttribute('data-ch', num || '★');
      var meta = make('b', 'ch-meta');
      meta.appendChild(make('span', 'ch-count', lessonsWord(total)));
      if (total) {
        var bar = make('span', 'ch-bar');
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', 'Opened ' + done + ' of ' + total);
        var fill = make('i');
        fill.style.width = Math.round(100 * done / total) + '%';
        bar.appendChild(fill);
        meta.appendChild(bar);
        meta.appendChild(make('span', 'ch-done', done + '/' + total));
      }
      head.appendChild(meta);
      var title = head.querySelector('span');
      chapters.push({ id: head.id, label: title ? title.textContent : head.id, total: total, done: done });
    }

    var stats = document.querySelector('[data-grade-stats]');
    if (stats && cards.length) {
      var seenCount = grid.querySelectorAll('a.lesson.is-seen').length;
      stats.textContent = '';
      var s1 = make('span', 'gs-item'); s1.appendChild(make('b', null, String(cards.length))); s1.appendChild(document.createTextNode(' درس'));
      var real = chapters.filter(function (c) { return c.id !== 'intro'; }).length;
      var s2 = make('span', 'gs-item'); s2.appendChild(make('b', null, String(real))); s2.appendChild(document.createTextNode(' فصول'));
      stats.appendChild(s1); stats.appendChild(s2);
      if (seenCount) {
        var s3 = make('span', 'gs-item gs-seen'); s3.appendChild(make('b', null, seenCount + '/' + cards.length)); s3.appendChild(document.createTextNode(' شاهدتها'));
        stats.appendChild(s3);
      }
      stats.hidden = false;
    }
    if (jump && chapters.length > 1) {
      for (var c = 0; c < chapters.length; c++) {
        if (!chapters[c].total) continue;
        var a = make('a', 'gj-link');
        a.href = '#' + chapters[c].id;
        a.appendChild(make('span', null, chapters[c].label));
        var all = chapters[c].done === chapters[c].total;
        a.appendChild(make('small', null, all ? '✓' : String(chapters[c].total)));
        if (all) a.classList.add('is-done');
        jump.appendChild(a);
      }
      jump.hidden = false;
    }
    document.documentElement.classList.add('grade-js');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
