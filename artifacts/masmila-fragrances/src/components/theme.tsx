import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const THEME_KEY = 'masmila.theme';

function readTheme(): 'light' | 'dark' {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch { /* storage unavailable */ }
  return 'light';
}

/** Apply the saved theme before first paint (called from main.tsx). */
export function initTheme() {
  document.documentElement.classList.toggle('dark', readTheme() === 'dark');
}

export function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
  }, [theme]);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="icon-button" type="button" onClick={() => setTheme(next)} aria-label={`Switch to ${next} mode`} data-testid="button-theme">
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
