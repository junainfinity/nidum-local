// Nidum Local: apply the saved theme before the first paint (a classic,
// synchronous script so the page doesn't flash the wrong theme).
(function () {
  var choice = 'system';
  try {
    var saved = window.localStorage.getItem('nidum-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') choice = saved;
  } catch (e) { /* storage blocked: follow the system */ }
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme-choice', choice);
})();
