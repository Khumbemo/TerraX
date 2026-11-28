// Live Earth layers for the map: data from /api/live/earth/* (backend services/earth.py), turned into GeoJSON for
// MapLibre and into the text of the popups. Pure functions, so they are unit-tested.
import type { Feature, FeatureCollection, Point } from 'geojson';

export interface EarthStatus {
  quakes: { feeds: string[]; default: string };
  fires: { available: boolean; sources: Record<string, string>; default: string; maxDays: number };
  weather: { maxPoints: number };
}

export interface QuakeProps {
  id: string;
  mag: number | null;
  magType: string | null;
  place: string | null;
  /** Origin time, ms since the epoch (UTC). */
  time: number | null;
  depthKm: number | null;
  /** PAGER impact alert. */
  alert: 'green' | 'yellow' | 'orange' | 'red' | null;
  /** USGS: set for large events in oceanic regions; it does not mean a tsunami happened. */
  tsunami: boolean;
  sig: number | null;
  status: string | null;
  type: string | null;
  url: string | null;
}

export interface QuakeFeed {
  generated: number | null;
  title: string | null;
  count: number;
  features: Feature<Point, QuakeProps>[];
  stale?: boolean;
}

/** [lon, lat, FRP in MW, confidence (low/nominal/high for VIIRS, 0–100 % for MODIS), UTC time, D or N]. */
export type FireRow = [number, number, number | null, string | number | null, string, string];

export interface FireView {
  source: string;
  days: number;
  fetched: string | null;
  stale: boolean;
  /** Detections in the view; `rows` holds at most 20 000 of them, the largest FRP first. */
  total: number;
  rows: FireRow[];
}

export interface WeatherPoint {
  lat: number;
  lon: number;
  gridLat: number | null;
  gridLon: number | null;
  modelElevation: number | null;
  timezone: string | null;
  /** Local time of the current conditions (ISO, no offset: in `timezone`). */
  time: string | null;
  temperature: number | null;
  code: number | null;
  text: string | null;
  isDay: boolean;
  windSpeed: number | null;
  windDirection: number | null;
  date: string | null;
  dayCode: number | null;
  dayText: string | null;
  tMax: number | null;
  tMin: number | null;
  precipitation: number | null;
  precipitationProbability: number | null;
  units: { temperature: string | null; wind: string | null; precipitation: string | null };
}

export interface WeatherGrid {
  step: number;
  points: WeatherPoint[];
  error: string | null;
}

export interface LiveLayers {
  quakes: boolean;
  quakeFeed: string;
  fires: boolean;
  fireSource: string;
  fireDays: number;
  weather: boolean;
}

export const DEFAULT_LIVE: LiveLayers = { quakes: false, quakeFeed: '2.5_day', fires: false, fireSource: 'VIIRS_NOAA20_NRT', fireDays: 1, weather: false };

/** The USGS feed names: "<class>_<window>". */
export const QUAKE_LEVEL_LABELS: Record<string, string> = { significant: 'Significant', '4.5': 'M4.5+', '2.5': 'M2.5+', '1.0': 'M1.0+', all: 'All' };
export const QUAKE_WINDOW_LABELS: Record<string, string> = { hour: 'past hour', day: 'past day', week: 'past 7 days', month: 'past 30 days' };

export function quakeFeedLabel(feed: string): string {
  const [lvl, win] = feed.split('_');
  return `${QUAKE_LEVEL_LABELS[lvl] ?? lvl}, ${QUAKE_WINDOW_LABELS[win] ?? win}`;
}

/** Display bins for the colour by depth (km): a choice for reading the map, not a seismological classification. */
export const DEPTH_CLASSES: { max: number; label: string; color: string }[] = [
  { max: 35, label: '0–35 km deep', color: '#facc15' },
  { max: 100, label: '35–100 km', color: '#fb923c' },
  { max: 300, label: '100–300 km', color: '#ef4444' },
  { max: Infinity, label: 'Over 300 km', color: '#a855f7' },
];

/** Display bins for the colour by fire radiative power (MW). */
export const FRP_CLASSES: { max: number; label: string; color: string }[] = [
  { max: 10, label: 'Under 10 MW', color: '#fde047' },
  { max: 50, label: '10–50 MW', color: '#fb923c' },
  { max: 200, label: '50–200 MW', color: '#ef4444' },
  { max: Infinity, label: 'Over 200 MW', color: '#a21caf' },
];

export function fireCollection(rows: FireRow[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: rows.map(([lon, lat, frp, conf, when, dn], i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { frp: frp ?? 0, hasFrp: frp !== null, conf: conf === null ? '' : String(conf), when, dn },
    })),
  };
}

export function weatherCollection(points: WeatherPoint[]): FeatureCollection<Point, WeatherPoint> {
  return { type: 'FeatureCollection', features: points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: p })) };
}

/** A plain symbol for a WMO weather code group (the code table of open-meteo.com/en/docs). */
export function weatherGlyph(code: number | null, isDay = true): string {
  if (code === null) return '·';
  if (code === 0 || code === 1) return isDay ? '☀' : '☾';
  if (code === 2) return '⛅';
  if (code === 3) return '☁';
  if (code === 45 || code === 48) return '≡';
  if (code >= 95) return '⚡';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '❄';
  if (code >= 51 && code <= 82) return '☂';
  return '·';
}

const esc = (s: string) => s.replace(/[<&>"]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: number | null, d = 1) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(d));

/** "2026-11-28 07:15 UTC" from ms since the epoch. */
export function utc(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "12 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number | null, now = Date.now()): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const min = Math.max(0, Math.round((now - ms) / 60000));
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function quakeHtml(p: QuakeProps, now = Date.now()): string {
  const rows = [
    `<strong>M ${num(p.mag)}${p.magType ? ` <span class="muted">(${esc(p.magType)})</span>` : ''}</strong>${p.type && p.type !== 'earthquake' ? ` · ${esc(p.type)}` : ''}`,
    p.place ? `<div>${esc(p.place)}</div>` : '',
    `<div class="muted">${utc(p.time)}${p.time ? ` · ${ago(p.time, now)}` : ''}</div>`,
    `<div>Depth ${num(p.depthKm)} km${p.status ? ` · ${esc(p.status)}` : ''}</div>`,
    p.alert ? `<div>PAGER alert: <strong>${esc(p.alert)}</strong></div>` : '',
    p.tsunami ? '<div class="muted">Tsunami flag: a large event in an oceanic region; see tsunami.gov for any warning.</div>' : '',
    p.url ? `<div><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">USGS event page</a></div>` : '',
  ];
  return rows.filter(Boolean).join('');
}

export function fireHtml(props: { frp: number; hasFrp: boolean; conf: string; when: string; dn: string }, sourceLabel: string): string {
  const c = props.conf;
  const conf = c === '' ? '—' : /^\d+$/.test(c) ? `${c} %` : c;
  const when = props.when ? `${props.when.slice(0, 10)} ${props.when.slice(11, 16)} UTC` : '—';
  return [
    `<strong>Active fire (thermal anomaly)</strong>`,
    `<div>FRP ${props.hasFrp ? `${num(props.frp)} MW` : '—'} · confidence ${esc(conf)}</div>`,
    `<div class="muted">${esc(when)} · ${props.dn === 'D' ? 'day' : props.dn === 'N' ? 'night' : '—'} overpass</div>`,
    `<div class="muted">${esc(sourceLabel)}</div>`,
  ].join('');
}

export function weatherHtml(p: WeatherPoint): string {
  const tu = p.units.temperature ?? '°C';
  const rows = [
    `<strong>${weatherGlyph(p.code, p.isDay)} ${num(p.temperature)} ${esc(tu)}</strong> · ${esc(p.text ?? '—')}`,
    `<div>Today${p.date ? ` (${esc(p.date)})` : ''}: ${esc(p.dayText ?? '—')}, ${num(p.tMin)} to ${num(p.tMax)} ${esc(tu)}</div>`,
    `<div>Precipitation ${num(p.precipitation)} ${esc(p.units.precipitation ?? 'mm')}${p.precipitationProbability !== null ? ` · chance up to ${num(p.precipitationProbability, 0)} %` : ''}</div>`,
    `<div>Wind ${num(p.windSpeed)} ${esc(p.units.wind ?? 'km/h')}${p.windDirection !== null ? ` from ${num(p.windDirection, 0)}°` : ''}</div>`,
    `<div class="muted">Model grid cell at ${num(p.gridLat, 2)}°, ${num(p.gridLon, 2)}°${p.modelElevation !== null ? `, ${num(p.modelElevation, 0)} m` : ''}; ${p.time ? `${esc(p.time.replace('T', ' '))} local time` : ''}${p.timezone ? ` (${esc(p.timezone)})` : ''}</div>`,
  ];
  return rows.join('');
}

/** Views are rounded before asking for weather, so small pans reuse the answer. */
export function viewKey(b: { west: number; south: number; east: number; north: number }): string {
  const r = (v: number) => (Math.round(v * 4) / 4).toFixed(2);
  return `west=${r(b.west)}&south=${r(Math.max(-90, b.south))}&east=${r(b.east)}&north=${r(Math.min(90, b.north))}`;
}
