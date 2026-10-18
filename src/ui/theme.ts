// The pre-paint script in index.html owns the theme: it resolves Device against the OS, stores the
// choice and sets data-theme. The page only asks it for a choice and reads back what it applied, so
// the rule lives in one place.
export type ThemeChoice = 'light' | 'dark' | 'device';

export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'device'];

function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice);
}

export function chooseTheme(choice: ThemeChoice): void {
  document.dispatchEvent(new CustomEvent('tolsey-theme', { detail: choice }));
}

export function currentThemeChoice(): ThemeChoice {
  if (typeof document === 'undefined') return 'device';
  const applied = document.documentElement.dataset.themeChoice;
  return isThemeChoice(applied) ? applied : 'device';
}
