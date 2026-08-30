(function () {
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  var channel = 'BroadcastChannel' in window ? new BroadcastChannel('teaching-theme') : null;
  var storageKey = 'teaching-theme';

  if (!toggle) return;

  // Crisp inline SVGs instead of emoji glyphs (☾/☀), which render
  // inconsistently across OS emoji sets/fonts (including some Arabic-
  // locale systems) — this looks the same everywhere.
  var ICON_MOON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.4A8.5 8.5 0 1 1 9.6 3.5a7 7 0 0 0 10.9 10.9Z"/></svg>';
  var ICON_SUN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/></svg>';

  function apply(theme, write) {
    if (theme !== 'dark' && theme !== 'light') return;
    root.setAttribute('data-theme', theme);
    toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    var icon = toggle.querySelector('.theme-icon');
    if (icon) icon.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
    if (write !== false) {
      try { localStorage.setItem(storageKey, theme); } catch (e) {}
    }
  }

  function readStoredTheme() {
    try { return localStorage.getItem(storageKey); } catch (e) { return null; }
  }

  var saved = readStoredTheme();
  var initial = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(initial, false);

  toggle.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    apply(next, true);
    if (channel) channel.postMessage(next);
  });

  window.addEventListener('storage', function (event) {
    if (event.key === storageKey && event.newValue) apply(event.newValue, false);
  });

  if (channel) {
    channel.addEventListener('message', function (event) {
      if (event.data === 'dark' || event.data === 'light') apply(event.data, false);
    });
  }

  window.addEventListener('pageshow', function () {
    var current = readStoredTheme();
    if (current) apply(current, false);
  });
})();
