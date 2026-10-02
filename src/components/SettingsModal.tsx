import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_MODEL } from '../lib/gemini-shared';
import { getAiMode, getModel, getOwnKey, refreshAiStatus, setModel, setOwnKey, type AiMode } from '../lib/ai';
import { useToast } from '../lib/toast';
import { idbSet } from '../lib/idb';
import { usePrefs, type Background, type Theme } from '../lib/prefs';
import type { Units } from '../lib/units';
import type { Lang } from '../lib/i18n';
import GEEGuidance from './GEEGuidance';

export interface Target {
  lat: number;
  lon: number;
  name: string;
}

interface Props {
  initialTab?: Tab;
  target: Target;
  onTargetChange: (t: Target) => void;
  onAiChange: () => void;
  onClose: () => void;
  onStartTour?: () => void;
}

type Tab = 'settings' | 'guide' | 'gee' | 'about';

const TABS: [Tab, string][] = [
  ['settings', 'Settings'],
  ['guide', 'How TerraX works'],
  ['gee', 'Earth Engine manual'],
  ['about', 'About'],
];

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

const AI_MODE_TEXT: Record<AiMode, string> = {
  'own-key': 'On — using your API key from this browser',
  server: 'On — using the TerraX server',
  off: 'Off — statistics only',
};

export default function SettingsModal({ initialTab = 'settings', target, onTargetChange, onAiChange, onClose, onStartTour }: Props) {
  const notify = useToast();
  const prefs = usePrefs();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [mode, setMode] = useState<AiMode | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [hasKey, setHasKey] = useState(Boolean(getOwnKey()));
  const [model, setModelInput] = useState(getModel());
  const [lat, setLat] = useState(String(target.lat));
  const [lon, setLon] = useState(String(target.lon));
  const [placeName, setPlaceName] = useState(target.name);

  useEffect(() => {
    getAiMode().then(setMode);
  }, [hasKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) {
      notify('Paste an API key first.', 'error');
      return;
    }
    setOwnKey(keyInput);
    setKeyInput('');
    setHasKey(true);
    refreshAiStatus();
    onAiChange();
    notify('API key saved in this browser.', 'success');
  };

  const removeKey = () => {
    setOwnKey('');
    setHasKey(false);
    refreshAiStatus();
    onAiChange();
    notify('API key removed from this browser.');
  };

  const saveModel = () => {
    setModel(model);
    onAiChange();
    notify(`Model set to ${model || DEFAULT_MODEL}.`, 'success');
  };

  const saveTarget = (e: FormEvent) => {
    e.preventDefault();
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || la < -90 || la > 90 || !Number.isFinite(lo) || lo < -180 || lo > 180) {
      notify('Latitude must be between −90 and 90, and longitude between −180 and 180.', 'error');
      return;
    }
    onTargetChange({ lat: la, lon: lo, name: placeName.trim() || 'Target' });
    notify('Target location updated.', 'success');
  };

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head">
          <h2 id="settings-title">Settings & guide</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="modal-tabs" role="tablist" aria-orientation="vertical">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="modal-content">
            {tab === 'settings' && (
              <div className="settings-stack">
                <section aria-label="Display">
                  <h3>{prefs.t('prefs.display')}</h3>
                  <div className="param-row">
                    <label className="inline-select">
                      <span>{prefs.t('prefs.theme')}</span>
                      <select id="pref-theme" value={prefs.theme} onChange={e => prefs.setTheme(e.target.value as Theme)}>
                        <option value="dark">{prefs.t('prefs.dark')}</option>
                        <option value="light">{prefs.t('prefs.light')}</option>
                        <option value="galaxy">{prefs.t('prefs.galaxy')}</option>
                      </select>
                    </label>
                    <label className="inline-select">
                      <span>{prefs.t('prefs.background')}</span>
                      <select id="pref-background" value={prefs.background} onChange={e => prefs.setBackground(e.target.value as Background)}>
                        <option value="earth-night">{prefs.t('prefs.bg.earthNight')}</option>
                        <option value="earth">{prefs.t('prefs.bg.earth')}</option>
                        <option value="galaxy">{prefs.t('prefs.bg.galaxy')}</option>
                        <option value="custom">{prefs.t('prefs.bg.custom')}</option>
                        <option value="off">{prefs.t('prefs.bg.off')}</option>
                      </select>
                    </label>
                    {prefs.background === 'custom' && (
                      <>
                        <label className="btn btn-small" htmlFor="pref-bg-file">
                          {prefs.t('prefs.bg.choose')}
                        </label>
                        <input
                          id="pref-bg-file"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          hidden
                          onChange={async e => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            if (!f) return;
                            if (f.size > 15 * 1024 * 1024) {
                              notify('Choose an image under 15 MB.', 'error');
                              return;
                            }
                            if (await idbSet('background', f)) {
                              prefs.bumpCustomBg();
                              notify('Background image saved in this browser.', 'success');
                            } else notify('This browser could not store the image.', 'error');
                          }}
                        />
                      </>
                    )}
                    <label className="inline-select">
                      <span>{prefs.t('prefs.units')}</span>
                      <select id="pref-units" value={prefs.units} onChange={e => prefs.setUnits(e.target.value as Units)}>
                        <option value="metric">{prefs.t('prefs.metric')}</option>
                        <option value="imperial">{prefs.t('prefs.imperial')}</option>
                      </select>
                    </label>
                    <label className="inline-select">
                      <span>{prefs.t('prefs.language')}</span>
                      <select id="pref-lang" value={prefs.lang} onChange={e => prefs.setLang(e.target.value as Lang)}>
                        <option value="en">English</option>
                        <option value="hi">हिन्दी (Hindi)</option>
                      </select>
                    </label>
                    {onStartTour && (
                      <button type="button" id="start-tour" className="btn btn-small" onClick={onStartTour}>
                        {prefs.t('prefs.tour')}
                      </button>
                    )}
                  </div>
                  <p className="field-hint">{prefs.t('prefs.unitsNote')}</p>
                  <p className="field-hint">{prefs.t('prefs.bgNote')}</p>
                </section>
                <section>
                  <h3>AI interpretation (Gemini)</h3>
                  <p className="status-line">
                    Status: <strong>{mode ? AI_MODE_TEXT[mode] : 'Checking…'}</strong>
                  </p>
                  {__TERRAX_PREVIEW__ && (
                    <p className="notice">This preview runs in a sandbox that blocks calls to Google, so AI stays off here even with a key. Run TerraX locally to use AI.</p>
                  )}
                  <form onSubmit={saveKey} className="field-row">
                    <label htmlFor="api-key" className="visually-hidden">
                      Gemini API key
                    </label>
                    <input
                      id="api-key"
                      type="password"
                      autoComplete="off"
                      value={keyInput}
                      onChange={e => setKeyInput(e.target.value)}
                      placeholder={hasKey ? 'A key is saved — paste a new one to replace it' : 'Paste your Gemini API key'}
                    />
                    <button type="submit" className="btn btn-primary">
                      Save key
                    </button>
                    {hasKey && (
                      <button type="button" className="btn" onClick={removeKey}>
                        Remove
                      </button>
                    )}
                  </form>
                  <p className="field-hint">
                    Your key is stored only in this browser's local storage and sent only to Google. Anyone with access to this browser profile can read it. To keep a key off
                    user devices, run TerraX with <code>GEMINI_API_KEY</code> set on the server instead.
                  </p>
                  <div className="field-row">
                    <label htmlFor="model" className="field-label">
                      Model
                    </label>
                    <input id="model" list="model-options" value={model} onChange={e => setModelInput(e.target.value)} />
                    <datalist id="model-options">
                      {MODELS.map(m => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <button type="button" className="btn" onClick={saveModel}>
                      Use model
                    </button>
                  </div>
                </section>

                <section>
                  <h3>Telemetry target</h3>
                  <form onSubmit={saveTarget} className="target-form">
                    <label>
                      <span>Name</span>
                      <input id="target-name" value={placeName} maxLength={60} onChange={e => setPlaceName(e.target.value)} />
                    </label>
                    <label>
                      <span>Latitude (°N)</span>
                      <input id="target-lat" inputMode="decimal" value={lat} onChange={e => setLat(e.target.value)} />
                    </label>
                    <label>
                      <span>Longitude (°E)</span>
                      <input id="target-lon" inputMode="decimal" value={lon} onChange={e => setLon(e.target.value)} />
                    </label>
                    <button type="submit" className="btn btn-primary">
                      Update target
                    </button>
                  </form>
                  <p className="field-hint">Used for solar time, sun position and the map marker. Use negative values for south and west.</p>
                </section>
              </div>
            )}

            {tab === 'guide' && (
              <div className="prose">
                <h3>How TerraX works</h3>
                <p>
                  TerraX is a set of tools: Forest loss, Land survey, Weather &amp; climate, Satellite imagery, Terrain, and Space &amp; aerial photos. Each reads your GIS
                  files in the browser; files are not uploaded to a TerraX server. When AI is on and you ask for an interpretation or use an assistant, TerraX sends the
                  computed results (and for tables a sample of up to 150 rows) to Google's Gemini API.
                </p>
                <h4>Forest loss</h4>
                <p>
                  Two-date NDVI change: forest is NDVI above your threshold on the earlier image, loss is a drop in NDVI beyond your threshold. Areas use real ground
                  units for the file's CRS. Hansen Global Forest Change lossyear tiles are summarised by year, optionally inside a treecover2000 baseline.
                </p>
                <h4>Land survey</h4>
                <p>
                  Boundaries and tracks are measured on the WGS84 ellipsoid through UTM with scale-factor correction. Bearings are true (great-circle) bearings; magnetic
                  bearings differ by the local declination.
                </p>
                <h4>Terrain and imagery</h4>
                <p>
                  Slope and aspect use Horn's method. Spectral indices use published formulas with the bands you assign; indices that need absolute reflectance detect
                  values scaled by 10,000. Ordinary photos only support visible-band estimates (ExG, VARI).
                </p>
                <h4>Tables</h4>
                <p>
                  TerraX finds the date column (ISO dates, day-first or month-first dates, year-day such as 2014-043, or a year column) and the numeric columns. For
                  each variable it reports mean, SD, median, IQR and range, runs a two-sided Mann–Kendall trend test with the Theil–Sen slope per year, and shows the
                  mean for each calendar month when the record spans two or more years.
                </p>
                <h4>Value classes</h4>
                <p>
                  Recognised variables are classified with a stated basis: indicative USGS ranges for NDVI, IMD 24-hour categories for daily rainfall, descriptive °C
                  bands for temperature, and indicative ranges for ET, solar radiation and humidity. Anything else is split into quartiles of the data. ET totals over
                  multi-day intervals (such as MODIS 8-day ET) are converted to mm/day first.
                </p>
                <h4>GeoTIFFs</h4>
                <p>
                  Statistics skip no-data and NaN pixels. Rasters over 4 million pixels are resampled for statistics, and TerraX says so. The footprint is drawn on the
                  map for WGS84, Web Mercator and WGS84 UTM files. With two or more bands you can compute NDVI = (NIR − Red) / (NIR + Red).
                </p>
                <h4>Limits</h4>
                <p>
                  The Mann–Kendall test assumes independent observations; seasonal or autocorrelated series can look significant when they are not. Class thresholds are
                  indicative and vary by sensor, season and region.
                </p>
              </div>
            )}

            {tab === 'gee' && <GEEGuidance />}

            {tab === 'about' && (
              <div className="prose">
                <h3>About TerraX</h3>
                <p>TerraX is an Earth-observation workbench for climate, forest and land analysis.</p>
                <h4>Data and services</h4>
                <ul>
                  <li>Basemap: © OpenStreetMap contributors, © CARTO. Globe coastlines: Natural Earth 1:110m (public domain) via world-atlas.</li>
                  <li>Planetary K-index: NOAA Space Weather Prediction Center.</li>
                  <li>Sun position and times: SunCalc; equation of time and declination: NOAA Solar Calculator equations.</li>
                  <li>AI: Google Gemini API (optional).</li>
                </ul>
                <h4>Sample data</h4>
                <p>
                  The six sample series for Kohima, Nagaland are bundled for demonstration. Their original source is not documented in this project, so do not use them
                  as research data.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
