// Apply a stored theme before first paint so a light/dark/vegas choice doesn't flash the
// system theme while app.js loads. No attribute means "system" (follow prefers-color-scheme).
// This is its own file rather than an inline script so the page also runs under a
// Content-Security-Policy without 'unsafe-inline', which radmagelabs.com/delta/ sends.
(function () {
  try {
    var t = localStorage.getItem('delta_theme');
    if (t === 'light' || t === 'dark' || t === 'vegas') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
