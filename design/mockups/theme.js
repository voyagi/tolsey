// Light, Dark, Device. Device follows the OS, is the default, and changes live when the OS does.
// Loaded in <head> so the resolved theme is on <html> before first paint. The stylesheet only
// knows data-theme="dark"; this script decides what Device resolves to. A ?theme= query overrides
// the stored choice, for screenshots.
(function applyStoredTheme() {
  const KEY = 'tolsey-theme';
  const root = document.documentElement;
  const osDark = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'device';
  try {
    choice = localStorage.getItem(KEY) || 'device';
  } catch {
    choice = 'device';
  }
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'light' || forced === 'dark' || forced === 'device') choice = forced;

  function apply() {
    const resolved = choice === 'device' ? (osDark.matches ? 'dark' : 'light') : choice;
    root.setAttribute('data-theme', resolved);
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === choice));
    });
  }
  apply();
  osDark.addEventListener('change', () => {
    if (choice === 'device') apply();
  });

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        choice = button.dataset.themeChoice;
        try {
          localStorage.setItem(KEY, choice);
        } catch {
          // Storage blocked: the choice still holds for this page view.
        }
        apply();
      });
    });
  });
})();
