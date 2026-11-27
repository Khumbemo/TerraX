import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translate, type Lang } from './i18n';
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
  t: (key: string, fallback?: string) => string;
}

const PrefsContext = createContext<Prefs | null>(null);

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = getJSON<unknown>(key, fallback);
  return allowed.includes(v as T) ? (v as T) : fallback;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => stored('theme', ['dark', 'light', 'galaxy'] as const, 'dark'));
  const [units, setUnitsState] = useState<Units>(() => stored('units', ['metric', 'imperial'] as const, 'metric'));
  const [lang, setLangState] = useState<Lang>(() => stored('lang', ['en', 'hi'] as const, 'en'));
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

  const value = useMemo(
    () => ({ theme, units, lang, background, panels, setPanels, telemetryView, setTelemetryView, map, updateMap, intro, setIntro, customBgVersion, setBackground, bumpCustomBg, setTheme, setUnits, setLang, t }),
    [theme, units, lang, background, panels, setPanels, telemetryView, setTelemetryView, map, updateMap, intro, setIntro, customBgVersion, setBackground, bumpCustomBg, setTheme, setUnits, setLang, t],
  );
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

const DEFAULTS: Prefs = { theme: 'dark', units: 'metric', lang: 'en', background: 'off', panels: 'balanced', setPanels: () => {}, telemetryView: 'earth', setTelemetryView: () => {}, intro: true, setIntro: () => {}, map: DEFAULT_MAP_SETTINGS, updateMap: () => {}, customBgVersion: 0, setBackground: () => {}, bumpCustomBg: () => {}, setTheme: () => {}, setUnits: () => {}, setLang: () => {}, t: (key, fallback = '') => translate('en', key, fallback) };

export function usePrefs(): Prefs {
  return useContext(PrefsContext) ?? DEFAULTS;
}
