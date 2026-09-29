import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, type Lang } from './i18n';
import { getJSON, setJSON } from './storage';
import type { Units } from './units';

export type Theme = 'dark' | 'light';

interface Prefs {
  theme: Theme;
  units: Units;
  lang: Lang;
  setTheme: (t: Theme) => void;
  setUnits: (u: Units) => void;
  setLang: (l: Lang) => void;
  t: (key: string, fallback?: string) => string;
}

const PrefsContext = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = getJSON<unknown>(key, fallback);
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => stored('theme', ['dark', 'light'] as const, 'dark'));
  const [units, setUnitsState] = useState<Units>(() => stored('units', ['metric', 'imperial'] as const, 'metric'));
  const [lang, setLangState] = useState<Lang>(() => stored('lang', ['en', 'hi'] as const, 'en'));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    setJSON('theme', t);
  }, []);
  const setUnits = useCallback((u: Units) => {
    setUnitsState(u);
    setJSON('units', u);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    setJSON('lang', l);
  }, []);
  const t = useCallback((key: string, fallback = '') => translate(lang, key, fallback), [lang]);

  const value = useMemo(() => ({ theme, units, lang, setTheme, setUnits, setLang, t }), [theme, units, lang, setTheme, setUnits, setLang, t]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

const DEFAULTS: Prefs = { theme: 'dark', units: 'metric', lang: 'en', setTheme: () => {}, setUnits: () => {}, setLang: () => {}, t: (key, fallback = '') => translate('en', key, fallback) };

export function usePrefs(): Prefs {
  return useContext(PrefsContext) ?? DEFAULTS;
}
