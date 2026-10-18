import { chooseTheme, currentThemeChoice, THEME_CHOICES } from './theme';

// The notice is static HTML; its only script work is the theme switch, which hands the choice to the
// pre-paint script exactly as the wall's switch does and then shows what that script applied.
function showPressed(): void {
  const applied = currentThemeChoice();
  for (const button of document.querySelectorAll<HTMLButtonElement>('.theme-switch button[data-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.choice === applied));
  }
}

for (const choice of THEME_CHOICES) {
  document.querySelector(`.theme-switch button[data-choice="${choice}"]`)?.addEventListener('click', () => {
    chooseTheme(choice);
    showPressed();
  });
}

showPressed();
