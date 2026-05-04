import { useCallback, useEffect, useState } from 'react';

export function useThemeMode() {
  const [theme, setThemeState] = useState(() => window.localStorage.getItem('qbackup.theme') || 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('qbackup.theme', theme);
  }, [theme]);

  const setTheme = useCallback((nextTheme) => {
    document.documentElement.classList.add('theme-transition');
    window.setTimeout(() => document.documentElement.classList.remove('theme-transition'), 700);
    setThemeState(nextTheme);
  }, []);

  return [theme, setTheme];
}

