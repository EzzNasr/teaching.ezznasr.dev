(function () {
  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  var channel = 'BroadcastChannel' in window ? new BroadcastChannel('teaching-theme') : null;
  var storageKey = 'teaching-theme';

  if (!toggle) return;

  function apply(theme, write) {
    if (theme !== 'dark' && theme !== 'light') return;
    root.setAttribute('data-theme', theme);
    toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    var icon = toggle.querySelector('.theme-icon');
    if (icon) icon.textContent = theme === 'dark' ? '\u2600' : '\u263E';
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
