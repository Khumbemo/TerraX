import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { browserLang, EN, LANG_CODES, loadMessages, RTL, translate, type Lang, type Messages } from './i18n';
import { getJSON, setJSON } from './storage';
import type { Units } from './units';
import { DEFAULT_MAP_SETTINGS, normaliseMapSettings, type MapSettings } from './basemaps';
import { SPACE_IMAGE_IDS, type SpaceImage } from './backgrounds';

export type Theme = 'dark' | 'light' | 'galaxy';
export type Background = 'earth-night' | 'earth' | 'galaxy' | SpaceImage | 'custom' | 'off';
/** How see-through panels are over the background. */
export type PanelStyle = 'clear' | 'balanced' | 'solid';
/** What the Planetary telemetry panel shows. */
export type TelemetryView = 'earth' | 'moon' | 'orbit' | 'system';

interface Prefs {
  theme: Theme;
  units: Units;
  lang: Lang;
  background: Background;
  panels: PanelStyle;
  setPanels: (p: PanelStyle) => void;
  telemetryView: TelemetryView;
  setTelemetryView: (v: TelemetryView) => void;
  map: MapSettings;
  updateMap: (patch: Partial<MapSettings>) => void;
  /** Whether the opening animation plays when TerraX opens. */
  intro: boolean;
  setIntro: (on: boolean) => void;
  /** Bumped when the custom background image changes. */
  customBgVersion: number;
  setBackground: (b: Background) => void;
  bumpCustomBg: () => void;
  setTheme: (t: Theme) => void;
  setUnits: (u: Units) => void;
  setLang: (l: Lang) => void;
  /** Direction of the chosen language's script, for elements that show translated text. The page layout stays left to
   *  right, so English content and numbers (tool screens, readings, the assistant) keep their order. */
  dir: 'ltr' | 'rtl';
  /** Translation of a key, in the chosen language; {name} placeholders are filled from vars. */
  t: (key: string, fallback?: string, vars?: Record<string, string>) => string;
}

const PrefsContext = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = getJSON<unknown>(key, fallback);
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => stored('theme', ['dark', 'light', 'galaxy'] as const, 'dark'));
  const [units, setUnitsState] = useState<Units>(() => stored('units', ['metric', 'imperial'] as const, 'metric'));
  // First visit: the browser's language if TerraX has it; afterwards the one chosen.
  const [lang, setLangState] = useState<Lang>(() => stored<Lang>('lang', LANG_CODES, browserLang()));
  const [messages, setMessages] = useState<Messages>(EN);
  useEffect(() => {
    let alive = true;
    loadMessages(lang)
      .then(m => alive && setMessages(m))
      .catch(err => console.warn('TerraX: language unavailable', err));
    return () => {
      alive = false;
    };
  }, [lang]);
  const [background, setBgState] = useState<Background>(() => {
    // Version 2 made the night view the default; move people off the old daytime default once.
    if (getJSON<number>('bg_version', 1) < 2) {
      setJSON('bg_version', 2);
      if (getJSON<unknown>('background', null) === 'earth') setJSON('background', 'earth-night');
    }
    return stored<Background>('background', ['earth-night', 'earth', 'galaxy', ...SPACE_IMAGE_IDS, 'custom', 'off'], 'earth-night');
  });
  const [map, setMapState] = useState<MapSettings>(() => normaliseMapSettings(getJSON<unknown>('map', null)));
  const updateMap = useCallback((patch: Partial<MapSettings>) => {
    setMapState(m => {
      const next = normaliseMapSettings({ ...m, ...patch });
      setJSON('map', next);
      return next;
    });
  }, []);
  const [panels, setPanelsState] = useState<PanelStyle>(() => stored('panels', ['clear', 'balanced', 'solid'] as const, 'balanced'));
  const setPanels = useCallback((p: PanelStyle) => {
    setPanelsState(p);
    setJSON('panels', p);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.panels = panels;
  }, [panels]);
  const [telemetryView, setTelemetryViewState] = useState<TelemetryView>(() => stored('telemetry_view', ['earth', 'moon', 'orbit', 'system'] as const, 'earth'));
  const setTelemetryView = useCallback((v: TelemetryView) => {
    setTelemetryViewState(v);
    setJSON('telemetry_view', v);
  }, []);
  const [intro, setIntroState] = useState<boolean>(() => getJSON<unknown>('intro', true) !== false);
  const setIntro = useCallback((on: boolean) => {
    setIntroState(on);
    setJSON('intro', on);
  }, []);
  const [customBgVersion, setCustomBgVersion] = useState(0);
  const setBackground = useCallback((b: Background) => {
    setBgState(b);
    setJSON('background', b);
  }, []);
  const bumpCustomBg = useCallback(() => setCustomBgVersion(v => v + 1), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.bg = background !== 'off' && theme !== 'light' ? 'on' : 'off';
  }, [background, theme]);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = 'ltr';
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
  const dir: 'ltr' | 'rtl' = RTL.includes(lang) ? 'rtl' : 'ltr';
  const t = useCallback((key: string, fallback = '', vars?: Record<string, string>) => translate(messages, key, fallback, vars), [messages]);

  const value = useMemo(
    () => ({ theme, units, lang, background, panels, setPanels, telemetryView, setTelemetryView, map, updateMap, intro, setIntro, customBgVersion, setBackground, bumpCustomBg, setTheme, setUnits, setLang, dir, t }),
    [theme, units, lang, background, panels, setPanels, telemetryView, setTelemetryView, map, updateMap, intro, setIntro, customBgVersion, setBackground, bumpCustomBg, setTheme, setUnits, setLang, dir, t],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

const DEFAULTS: Prefs = { theme: 'dark', units: 'metric', lang: 'en', background: 'off', panels: 'balanced', setPanels: () => {}, telemetryView: 'earth', setTelemetryView: () => {}, intro: true, setIntro: () => {}, map: DEFAULT_MAP_SETTINGS, updateMap: () => {}, customBgVersion: 0, setBackground: () => {}, bumpCustomBg: () => {}, setTheme: () => {}, setUnits: () => {}, setLang: () => {}, dir: 'ltr', t: (key, fallback = '', vars) => translate(EN, key, fallback, vars) };

export function usePrefs(): Prefs {
  return useContext(PrefsContext) ?? DEFAULTS;
}
