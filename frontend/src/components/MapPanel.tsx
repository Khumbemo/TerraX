import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FeatureCollection } from 'geojson';
import { mapDef, resolveBase } from '../lib/basemaps';
import { request, type ResultImage } from '../lib/api';
import type { LatLngBounds } from '../lib/geo';
import { onLocalPmtilesChange } from '../lib/pmtiles-store';
import { usePrefs } from '../lib/prefs';
import { fmt } from '../lib/stats';
import type { Boundary } from '../lib/zonal';
import { DEFAULT_LIVE, DEPTH_CLASSES, FRP_CLASSES, QUAKE_LEVEL_LABELS, QUAKE_WINDOW_LABELS, fireCollection, viewKey, type EarthStatus, type FireView, type LiveLayers, type QuakeFeed, type WeatherGrid } from '../lib/earth';
import MapChooser from './MapChooser';
import { MapController, PLATE_CLASSES, type DrawState, type LayerStatus, type LayerVis, type LiveData, type MapView } from './map/MapController';

interface Props {
  target: { lat: number; lon: number; name: string };
  /** Area to fly to and outline (e.g. a raster footprint). */
  bounds: LatLngBounds | null;
  /** Vector features to draw (e.g. a surveyed plot). */
  geojson: FeatureCollection | null;
  /** Result picture over the raster footprint. */
  image?: ResultImage | null;
  boundary?: Boundary | null;
  draw?: DrawState | null;
  /** Footprints of saved reports ("My areas"). */
  areas?: FeatureCollection | null;
  /** The point whose place card is open (a marker is shown there). */
  pick?: { lat: number; lon: number } | null;
  onPick?: (lat: number, lon: number) => void;
  onArea?: (id: string) => void;
  /** Fly here whenever `n` changes (place search, card). */
  focus?: { lat: number; lon: number; zoom?: number; n: number } | null;
  /** Drawn over the map: the search box and the place card. */
  children?: ReactNode;
}

interface LegendItem {
  label: string;
  color: string;
  dashed?: boolean;
}

interface Legends {
  koppen: { code: string; name: string; color: string }[];
  biomes: { name: string; color: string }[];
}

let legendsPromise: Promise<Legends> | null = null;
const loadLegends = () => (legendsPromise ??= request<Legends>('/api/maps/catalog').catch(err => {
  legendsPromise = null;
  throw err;
}));

function ClassLegend({ title, items }: { title: string; items: LegendItem[] }) {
  return (
    <details className="class-legend" open={items.length <= 15}>
      <summary>{title}</summary>
      <div className="map-legend">
        {items.map(l => (
          <span key={l.label} title={l.label}>
            <i className={`class-swatch ${l.dashed ? 'dashed' : ''}`} style={{ background: l.dashed ? 'transparent' : l.color, borderColor: l.color }} /> {l.label}
          </span>
        ))}
      </div>
    </details>
  );
}

function Ramp({ ramp }: { ramp: NonNullable<ResultImage['ramp']> }) {
  return (
    <div className="ramp-legend">
      <span className="num">{fmt(ramp.min, 3)}</span>
      <i className="ramp-bar viridis" />
      <span className="num">{fmt(ramp.max, 3)}</span>
    </div>
  );
}

const START_ZOOM = 10;
const LIVE_KEY = 'terrax.liveLayers';
const QUAKE_REFRESH_MS = 60_000; // the USGS feeds are updated every minute
const FIRE_REFRESH_MS = 600_000;
const WEATHER_REFRESH_MS = 900_000; // Open-Meteo's current conditions are 15-minutely

function loadLive(): LiveLayers {
  try {
    const v = JSON.parse(localStorage.getItem(LIVE_KEY) ?? 'null');
    return v && typeof v === 'object' ? { ...DEFAULT_LIVE, ...v } : DEFAULT_LIVE;
  } catch {
    return DEFAULT_LIVE;
  }
}

type Loaded<T> = { data: T | null; error: string | null; loading: boolean };
const idle = <T,>(): Loaded<T> => ({ data: null, error: null, loading: false });

/** Fetches `url` (null: nothing), again every `every` ms while it stays the same; keeps the last data on a failed refresh. */
function usePolled<T>(url: string | null, every: number): Loaded<T> {
  const [st, setSt] = useState<Loaded<T>>(idle);
  useEffect(() => {
    if (!url) {
      setSt(idle());
      return;
    }
    let alive = true;
    const load = () => {
      setSt(s => ({ ...s, loading: true }));
      request<T>(url)
        .then(data => alive && setSt({ data, error: null, loading: false }))
        .catch(err => alive && setSt(s => ({ data: s.data, error: err instanceof Error ? err.message : String(err), loading: false })));
    };
    // A new view keeps the points already shown until the new ones arrive.
    setSt(s => ({ ...s, error: null }));
    load();
    const t = window.setInterval(load, every);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [url, every]);
  return st;
}

export default function MapPanel({ target, bounds, geojson, image = null, boundary = null, draw = null, areas = null, pick = null, onPick, onArea, focus = null, children }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  const { theme, map: mapSettings } = usePrefs();
  const [status, setStatus] = useState<Record<string, LayerStatus>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [vis, setVis] = useState<LayerVis>({ tiles: true, outlines: true, image: true, features: true, boundary: true, areas: true, opacity: 0.75 });
  const [dismissed, setDismissed] = useState('');
  const [legends, setLegends] = useState<Legends | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [pmtilesVersion, setPmtilesVersion] = useState(0);
  const [live, setLive] = useState<LiveLayers>(loadLive);
  const [view, setView] = useState<MapView | null>(null);
  const [earth, setEarth] = useState<EarthStatus | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(LIVE_KEY, JSON.stringify(live));
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  }, [live]);
  useEffect(() => {
    if ((panelOpen || live.fires) && !earth)
      request<EarthStatus>('/api/live/earth/status')
        .then(setEarth)
        .catch(() => undefined);
  }, [panelOpen, live.fires, earth]);
  const vk = view ? viewKey(view) : null;
  const quakes = usePolled<QuakeFeed>(live.quakes ? `/api/live/earth/quakes?feed=${encodeURIComponent(live.quakeFeed)}` : null, QUAKE_REFRESH_MS);
  const firesOn = live.fires && earth?.fires.available === true;
  const fires = usePolled<FireView>(firesOn && vk ? `/api/live/earth/fires?source=${encodeURIComponent(live.fireSource)}&days=${live.fireDays}&${vk}` : null, FIRE_REFRESH_MS);
  const weather = usePolled<WeatherGrid>(live.weather && vk ? `/api/live/earth/weather?${vk}` : null, WEATHER_REFRESH_MS);
  const fireFc = useMemo(() => (fires.data ? fireCollection(fires.data.rows) : null), [fires.data]);
  const fireLabel = earth?.fires.sources[live.fireSource] ?? live.fireSource;
  const liveData = useMemo<LiveData>(
    () => ({
      quakes: live.quakes && quakes.data ? ({ type: 'FeatureCollection', features: quakes.data.features } as FeatureCollection) : null,
      fires: firesOn ? fireFc : null,
      fireLabel: `NASA FIRMS, ${fireLabel}`,
      weather: live.weather ? (weather.data?.points ?? null) : null,
    }),
    [live.quakes, live.weather, quakes.data, firesOn, fireFc, fireLabel, weather.data],
  );
  const setL = (p: Partial<LiveLayers>) => setLive(l => ({ ...l, ...p }));
  useEffect(() => onLocalPmtilesChange(() => setPmtilesVersion(v => v + 1)), []);
  const baseDef = resolveBase(mapSettings, theme);
  const classLayers = mapSettings.overlays.map(o => o.id).filter(id => id === 'koppen' || id === 'biomes');
  const showPlates = mapSettings.overlays.some(o => o.id === 'plates');

  useEffect(() => {
    if (!el.current) return;
    try {
      ctl.current = new MapController(el.current, [target.lat, target.lon], START_ZOOM, setStatus);
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      ctl.current?.destroy();
      ctl.current = null;
    };
    // The map is created once; the target only sets where it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ctl.current?.update({ settings: mapSettings, theme, vis, bounds, geojson, image, boundary, draw, pmtilesVersion, areas, pick, live: liveData });
  }, [mapSettings, theme, vis, bounds, geojson, image, boundary, draw, pmtilesVersion, areas, pick, liveData]);

  useEffect(() => {
    if (ctl.current) ctl.current.handlers = { onPick, onArea, onView: setView };
  }, [onPick, onArea]);

  useEffect(() => {
    if (focus) ctl.current?.flyTo(focus.lat, focus.lon, focus.zoom);
    // Only a new request (n) moves the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.n]);

  useEffect(() => {
    if (classLayers.length && !legends) loadLegends().then(setLegends).catch(() => undefined);
  }, [classLayers.length, legends]);

  const failing = [baseDef.id, ...mapSettings.overlays.map(o => o.id)].filter((id, i) => (i === 0 ? vis.tiles : true) && status[id]?.state === 'error');
  // Tile servers that could not be reached report just the map name; other problems carry a full sentence.
  const unreachable = failing.filter(id => status[id].message === mapDef(id).name || status[id].message === 'Custom WMS').map(id => status[id].message!);
  const other = failing.map(id => status[id].message!).filter(m => !unreachable.includes(m));
  const problemKey = [...unreachable, ...other].join('|');
  const toggle = (k: keyof Omit<LayerVis, 'opacity'>) => setVis(v => ({ ...v, [k]: !v[k] }));

  if (engineError)
    return (
      <div className="map-container map-unavailable" role="alert">
        <p>
          The map needs WebGL, which this browser or device has turned off ({engineError}). Results and reports still work; enable hardware acceleration to see them on the map.
        </p>
      </div>
    );

  return (
    <div className="map-container">
      <div ref={el} className="map-canvas" data-testid="map" />
      {problemKey && problemKey !== dismissed && !draw && (
        <div className="map-status" role="status">
          <div>
            {unreachable.length > 0 && (
              <div>
                Not loading: <strong>{unreachable.join(', ')}</strong> (offline, blocked, or the server needs a key).
              </div>
            )}
            {other.map(m => (
              <div key={m}>{m}</div>
            ))}
            <div className="muted">The offline outlines are shown underneath.</div>
          </div>
          <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setDismissed(problemKey)}>
            ×
          </button>
        </div>
      )}
      {children}
      <div className="map-layers">
        <button type="button" className="map-layers-toggle" aria-expanded={panelOpen} aria-controls="map-layers-panel" onClick={() => setPanelOpen(o => !o)}>
          Layers
        </button>
        {panelOpen && (
          <div id="map-layers-panel" className="map-layers-panel">
            <MapChooser idPrefix="layers-map" compact />
            {baseDef.kind !== 'none' && (
              <label className="check">
                <input type="checkbox" checked={vis.tiles} onChange={() => toggle('tiles')} /> Show base map ({baseDef.name})
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={vis.outlines} onChange={() => toggle('outlines')} /> Country outlines (offline)
            </label>
            {image && (
              <>
                <label className="check">
                  <input id="layer-image" type="checkbox" checked={vis.image} onChange={() => toggle('image')} /> {image.label}
                </label>
                <label className="range-row">
                  <span>Opacity</span>
                  <input id="layer-opacity" type="range" min="0.1" max="1" step="0.05" value={vis.opacity} onChange={e => setVis(v => ({ ...v, opacity: Number(e.target.value) }))} />
                  <span className="num">{Math.round(vis.opacity * 100)} %</span>
                </label>
              </>
            )}
            {(geojson || bounds) && (
              <label className="check">
                <input type="checkbox" checked={vis.features} onChange={() => toggle('features')} /> {geojson ? 'Result features' : 'Raster footprint'}
              </label>
            )}
            {boundary && (
              <label className="check">
                <input type="checkbox" checked={vis.boundary} onChange={() => toggle('boundary')} /> Analysis boundary
              </label>
            )}
            {areas && areas.features.length > 0 && (
              <label className="check">
                <input id="layer-areas" type="checkbox" checked={vis.areas} onChange={() => toggle('areas')} /> My areas ({areas.features.length} saved report{areas.features.length === 1 ? '' : 's'})
              </label>
            )}
            <fieldset className="live-layers" aria-label="Live Earth">
              <legend>Live Earth</legend>
              <label className="check">
                <input id="layer-quakes" type="checkbox" checked={live.quakes} onChange={() => setL({ quakes: !live.quakes })} /> Earthquakes (USGS)
              </label>
              {live.quakes && (
                <div className="live-opts">
                  <select aria-label="Earthquake magnitudes" value={live.quakeFeed.split('_')[0]} onChange={e => setL({ quakeFeed: `${e.target.value}_${live.quakeFeed.split('_')[1]}` })}>
                    {Object.entries(QUAKE_LEVEL_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Earthquake period" value={live.quakeFeed.split('_')[1]} onChange={e => setL({ quakeFeed: `${live.quakeFeed.split('_')[0]}_${e.target.value}` })}>
                    {Object.entries(QUAKE_WINDOW_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint" id="quake-status">
                    {quakes.error
                      ? `Not loading: ${quakes.error}`
                      : quakes.data
                        ? `${quakes.data.count} event${quakes.data.count === 1 ? '' : 's'}${quakes.data.generated ? `, feed of ${new Date(quakes.data.generated).toISOString().slice(11, 16)} UTC` : ''}${quakes.data.stale ? ' (an older copy: the USGS did not answer)' : ''}. Size: magnitude; colour: depth.`
                        : 'Loading…'}
                  </p>
                  <ClassLegend title="Depth" items={DEPTH_CLASSES.map(c => ({ label: c.label, color: c.color }))} />
                </div>
              )}
              <label className="check">
                <input id="layer-fires" type="checkbox" checked={live.fires} onChange={() => setL({ fires: !live.fires })} /> Active fires (NASA FIRMS)
              </label>
              {live.fires && (
                <div className="live-opts">
                  {earth && !earth.fires.available ? (
                    <p className="field-hint" id="fire-status">
                      This server has no FIRMS MAP_KEY yet. An administrator can add one (free from NASA FIRMS) in Admin → Site settings.
                    </p>
                  ) : (
                    <>
                      <select aria-label="Fire satellite" value={live.fireSource} onChange={e => setL({ fireSource: e.target.value })}>
                        {Object.entries(earth?.fires.sources ?? { [live.fireSource]: live.fireSource }).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <select aria-label="Fire days" value={live.fireDays} onChange={e => setL({ fireDays: Number(e.target.value) })}>
                        {Array.from({ length: earth?.fires.maxDays ?? 5 }, (_, i) => i + 1).map(d => (
                          <option key={d} value={d}>
                            {d === 1 ? 'Today (UTC)' : `Last ${d} days (UTC)`}
                          </option>
                        ))}
                      </select>
                      <p className="field-hint" id="fire-status">
                        {fires.error
                          ? `Not loading: ${fires.error}`
                          : fires.data
                            ? `${fires.data.total.toLocaleString()} detection${fires.data.total === 1 ? '' : 's'} in view${fires.data.total > fires.data.rows.length ? ` (the ${fires.data.rows.length.toLocaleString()} strongest shown; zoom in for all)` : ''}${fires.data.stale ? ' (an older copy: FIRMS did not answer)' : ''}. Colour: fire radiative power.`
                            : 'Loading…'}
                      </p>
                      <ClassLegend title="Fire radiative power" items={FRP_CLASSES.map(c => ({ label: c.label, color: c.color }))} />
                    </>
                  )}
                </div>
              )}
              <label className="check">
                <input id="layer-weather" type="checkbox" checked={live.weather} onChange={() => setL({ weather: !live.weather })} /> Today’s weather (Open-Meteo)
              </label>
              {live.weather && (
                <p className="field-hint" id="weather-status">
                  {weather.error
                    ? `Not loading: ${weather.error}`
                    : weather.data
                      ? `${weather.data.points.length} forecast points, every ${weather.data.step}°${weather.data.error ? ` (some missing: ${weather.data.error})` : ''}. Click one for today’s range, rain and wind.`
                      : 'Loading…'}
                </p>
              )}
            </fieldset>
            {image && image.legend.length > 0 && (
              <div className="map-legend">
                {image.legend.map(l => (
                  <span key={l.label}>
                    <i className="class-swatch" style={{ background: l.color }} /> {l.label}
                  </span>
                ))}
              </div>
            )}
            {image?.ramp && <Ramp ramp={image.ramp} />}
            {classLayers.includes('koppen') && legends && <ClassLegend title="Köppen–Geiger climate zones" items={legends.koppen.map(k => ({ label: `${k.code} ${k.name}`, color: k.color }))} />}
            {classLayers.includes('biomes') && legends && <ClassLegend title="Biomes (RESOLVE 2017)" items={legends.biomes.map(b => ({ label: b.name, color: b.color }))} />}
            {showPlates && <ClassLegend title="Plate boundaries (Bird 2003)" items={Object.values(PLATE_CLASSES).map(c => ({ label: c.name, color: c.color, dashed: Boolean(c.dash) }))} />}
            {(classLayers.length > 0 || showPlates) && <p className="field-hint">Click the map to read the climate zone, biome and more; hover a plate boundary for its type and speed.</p>}
            {image && <p className="field-hint">The overlay is stretched over the raster’s bounding box, not reprojected, so it is approximate at the edges.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
