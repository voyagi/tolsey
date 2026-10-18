import { useState } from 'react';
import { chooseTheme, currentThemeChoice, THEME_CHOICES, type ThemeChoice } from './theme';
import { KEPT_IN_BROWSER } from './wall-copy';

const LABELS: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', device: 'Device' };

export function ThemeSwitch() {
  const [pressed, setPressed] = useState<ThemeChoice>(currentThemeChoice);
  return (
    <div className="theme">
      <div className="theme-switch" role="group" aria-label="Theme" aria-describedby="theme-kept">
        {THEME_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={pressed === choice}
            onClick={() => {
              chooseTheme(choice);
              setPressed(currentThemeChoice());
            }}
          >
            {LABELS[choice]}
          </button>
        ))}
      </div>
      <span id="theme-kept" className="fine">
        {KEPT_IN_BROWSER}
      </span>
    </div>
  );
}
