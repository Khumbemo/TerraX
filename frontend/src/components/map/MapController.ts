// Imperative MapLibre map for TerraX: base map, stacked overlays, built-in
// world maps (tiles and vectors from the TerraX API), result layers, polygon
// drawing and point identification. MapPanel.tsx owns one controller and
// passes it the current React state with update().
import type { GeoJSONSource, LayerSpecification, Map as MlMap, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import * as maplibregl from '../../lib/maplibre';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { mapDef, resolveBase, tileTemplates, type MapDef, type MapSettings } from '../../lib/basemaps';
import { apiUrl, request, type ResultImage } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { getLocalPmtiles, loadLocalPmtiles } from '../../lib/pmtiles-store';
import type { Boundary } from '../../lib/zonal';
import { DEPTH_CLASSES, FRP_CLASSES, fireHtml, quakeHtml, weatherGlyph, weatherHtml, type QuakeProps, type WeatherPoint } from '../../lib/earth';

export type LayerStatus = { state: 'loading' | 'ok' | 'error'; message?: string };

export interface DrawState {
  /** Vertices as [lat, lon]. */
  points: [number, number][];
  onAdd: (p: [number, number]) => void;
  onMove: (index: number, p: [number, number]) => void;
  onRemove: (index: number) => void;
}

export interface LayerVis {
  tiles: boolean;
  outlines: boolean;
  image: boolean;
  features: boolean;
  boundary: boolean;
  /** Saved reports' footprints ("My areas"). */
  areas: boolean;
  opacity: number;
}

export interface MapState {
  settings: MapSettings;
  theme: string;
  vis: LayerVis;
  bounds: LatLngBounds | null;
  geojson: FeatureCollection | null;
  image: ResultImage | null;
  boundary: Boundary | null;
  draw: DrawState | null;
  /** Bumped when the local .pmtiles file changes. */
  pmtilesVersion: number;
  /** Footprints of saved reports ("My areas"): polygons with an `id` and a `title` property. */
  areas?: FeatureCollection | null;
  /** The point whose place card is open. */
  pick?: { lat: number; lon: number } | null;
  /** Live Earth layers (lib/earth.ts): null hides one. */
  live?: LiveData;
}

export interface LiveData {
  quakes: FeatureCollection | null;
  fires: FeatureCollection | null;
  /** Label of the fire source, for the popup. */
  fireLabel: string;
  weather: WeatherPoint[] | null;
}

export interface MapView {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

export interface MapHandlers {
  /** A click on the map away from any area (not while drawing). */
  onPick?: (lat: number, lon: number) => void;
  /** A click on a saved area. */
  onArea?: (id: string) => void;
  /** The view after it moved (and once at the start). */
  onView?: (v: MapView) => void;
}

export interface PlateLegend {
  name: string;
  color: string;
  dash?: number[];
}

/** Boundary classes of Bird (2003), Table 1 (the server's /api/maps/catalog has the same list). */
export const PLATE_CLASSES: Record<string, PlateLegend> = {
  SUB: { name: 'Subduction zone', color: '#ef4444' },
  OCB: { name: 'Oceanic convergent boundary', color: '#f97316' },
  CCB: { name: 'Continental convergent boundary (collision)', color: '#fb923c', dash: [5, 3] },
  OSR: { name: 'Oceanic spreading ridge', color: '#22d3ee' },
  CRB: { name: 'Continental rift boundary', color: '#a78bfa', dash: [5, 3] },
  OTF: { name: 'Oceanic transform fault', color: '#facc15' },
  CTF: { name: 'Continental transform fault', color: '#fde047', dash: [5, 3] },
};

const P = 'tx-'; // prefix of every source and layer the app adds
const DETAIL_ZOOM = 5;
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

const palette = (dark: boolean) =>
  dark
    ? { sea: '#0b1622', land: '#18242f', border: '#7f97ad', admin1: '#4f6475', water: '#3b82c4', lake: '#0f2236', grid: 'rgba(148,180,210,0.28)', special: '#f5b84b', outlineLand: '#15202b', outlineBorder: '#3a5068' }
    : { sea: '#cfe3f1', land: '#f6f3ea', border: '#6b7280', admin1: '#a3a3a3', water: '#4a90c8', lake: '#cfe3f1', grid: 'rgba(60,80,110,0.25)', special: '#b45309', outlineLand: '#f2f4f6', outlineBorder: '#9aa9ba' };

// ── Data shared by every map instance ──────────────────────────────────────

const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = load();
    p.catch(() => cache.delete(key)); // allow a retry after a failure
    cache.set(key, p);
  }
  return cache.get(key) as Promise<T>;
}

/** Natural Earth 1:50m land and borders (public domain), bundled with the app so the map is readable offline. */
const countries = () =>
  once('countries', async () => {
    const [topo, { feature, mesh }] = await Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client')]);
    const t = topo.default as unknown as Parameters<typeof feature>[0] & { objects: { countries: never } };
    return { land: feature(t, t.objects.countries) as unknown as FeatureCollection, borders: mesh(t, t.objects.countries, (a, b) => a !== b) as unknown as Geometry };
  });

const vector = <T,>(name: string) => once(`v:${name}`, () => request<T>(`/api/maps/vector/${name}`));
const graticule = () => once('graticule', () => request<FeatureCollection & { obliquity: number }>('/api/maps/graticule'));

type Places = [string, number, number, number, number, number][];

let protocolReady: Promise<typeof import('pmtiles')> | null = null;
let pmProtocol: import('pmtiles').Protocol | null = null;
function pmtiles() {
  if (!protocolReady)
    protocolReady = import('pmtiles').then(pm => {
      pmProtocol = new pm.Protocol();
      maplibregl.addProtocol('pmtiles', pmProtocol.tile);
      return pm;
    });
  return protocolReady;
}

// ── Tiles from outside servers ─────────────────────────────────────────────
// MapLibre treats a missing tile (HTTP 404) as empty and reports nothing, so
// catalogue tiles go through the txr:// protocol, which fetches them and
// tells the map which source succeeded or failed. That drives the switch to a
// map's second URL form and the "not loading" notice.

type TileReport = (sourceId: string, ok: boolean) => void;
const tileReporters = new Map<string, TileReport>();
let txrReady = false;

function ensureTxr() {
  if (txrReady) return;
  txrReady = true;
  maplibregl.addProtocol('txr', async (params, abort) => {
    const rest = params.url.slice('txr://'.length);
    const bar = rest.indexOf('|');
    const sid = decodeURIComponent(rest.slice(0, bar));
    const url = rest.slice(bar + 1);
    try {
      const res = await fetch(url, { signal: abort.signal, mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      tileReporters.get(sid)?.(sid, true);
      return { data };
    } catch (err) {
      if (!abort.signal.aborted) tileReporters.get(sid)?.(sid, false);
      throw err;
    }
  });
}

const viaTxr = (sid: string, urls: string[]) => urls.map(u => `txr://${encodeURIComponent(sid)}|${u}`);

// ── Sources for catalogue maps ─────────────────────────────────────────────

/** Each URL template expanded to MapLibre's list form ({s} → every subdomain, {r} → @2x on dense screens). */
function tileAlternatives(def: MapDef, s: MapSettings): string[][] {
  const retina = (window.devicePixelRatio || 1) > 1 ? '@2x' : '';
  return tileTemplates(def, s).map(t => {
    const u = t.replace('{r}', retina);
    if (!u.includes('{s}')) return [u];
    return [...(def.subdomains ?? 'abc')].map(sd => u.replace('{s}', sd));
  });
}

function wmsTiles(s: MapSettings): string[] {
  const w = s.customWms;
  const base = w.url.trim();
  const sep = base.includes('?') ? '&' : '?';
  const q = `SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${encodeURIComponent(w.layers.trim())}&STYLES=&FORMAT=${encodeURIComponent(w.format)}&TRANSPARENT=true&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}`;
  return [`${base}${sep}${q}`];
}

/** Deepest zoom a built-in picture has detail for (512-pixel tiles). */
function pictureMaxZoom(def: MapDef): number {
  return def.builtin === 'classes' ? 3 : Math.round(Math.log2((def.fullSize ?? 4096) / 512));
}

const isVectorStyle = (def: MapDef) => def.kind === 'vector';

/** Tile results for one raster source and its alternative URL forms. */
interface TileTry {
  alts: string[][];
  i: number;
  ok: number;
  bad: number;
  name: string;
  def: MapDef;
  opacity: number;
  key: string;
  /** Tiles go through the txr:// protocol, which reports each result. */
  txr?: boolean;
  timer?: number;
  done?: boolean;
}

/** A request in flight for each map, so a newer update can supersede it. */
interface Slot {
  key: string;
  ids: string[];
  sources: string[];
  dispose?: () => void;
}

export class MapController {
  readonly map: MlMap;
  private state: MapState | null = null;
  private styleKey = '';
  private slots = new Map<string, Slot>();
  private status: Record<string, LayerStatus> = {};
  private markers: maplibregl.Marker[] = [];
  private placeMarkers = new Map<string, maplibregl.Marker[]>();
  private popup: maplibregl.Popup | null = null;
  private pickMarker: maplibregl.Marker | null = null;
  private weatherMarkers: maplibregl.Marker[] = [];
  private weatherKey: WeatherPoint[] | null = null;
  handlers: MapHandlers = {};
  private lastBounds: LatLngBounds | null = null;
  private styleReady = false;
  private pending = false;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    center: [number, number],
    zoom: number,
    private readonly onStatus: (s: Record<string, LayerStatus>) => void,
  ) {
    this.map = new maplibregl.Map({
      container,
      style: this.emptyStyle(true),
      center: [center[1], center[0]],
      zoom,
      attributionControl: { compact: true },
      renderWorldCopies: true,
      maxPitch: 60,
      cooperativeGestures: false,
    });
    // A handle for debugging and end-to-end tests.
    (window as unknown as { __terraxMap?: MlMap }).__terraxMap = this.map;
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.map.on('style.load', () => {
      // A newly loaded style has none of our layers (even a late one from a previous base map), so rebuild them all.
      this.clearSlots();
      this.styleReady = true;
      this.render();
    });
    this.map.on('click', e => this.onClick(e));
    this.map.on('moveend', () => this.onMove());
    this.map.on('load', () => this.emitView());
    this.map.on('error', e => this.onError(e as unknown as { sourceId?: string; error?: Error }));
    this.map.on('sourcedata', e => {
      const ev = e as unknown as { sourceId?: string; tile?: unknown };
      if (ev.tile && ev.sourceId) this.tileLoaded(ev.sourceId);
    });
  }

  destroy() {
    this.destroyed = true;
    for (const sid of this.tries.keys()) tileReporters.delete(sid);
    for (const s of this.slots.values()) s.dispose?.();
    this.markers.forEach(m => m.remove());
    this.pickMarker?.remove();
    this.weatherMarkers.forEach(m => m.remove());
    for (const list of this.placeMarkers.values()) list.forEach(m => m.remove());
    this.map.remove();
  }

  private emptyStyle(dark: boolean): StyleSpecification {
    return { version: 8, sources: {}, layers: [{ id: `${P}background`, type: 'background', paint: { 'background-color': palette(dark).sea } }] };
  }

  private setStatus(id: string, s: LayerStatus) {
    const prev = this.status[id];
    if (prev?.state === s.state && prev?.message === s.message) return;
    this.status = { ...this.status, [id]: s };
    this.onStatus(this.status);
  }

  // ── Update from React ────────────────────────────────────────────────────

  update(next: MapState) {
    const prev = this.state;
    this.state = next;
    const dark = next.theme !== 'light';
    const base = resolveBase(next.settings, next.theme);
    const styleKey = isVectorStyle(base) && next.vis.tiles ? `vector:${base.id}` : base.kind === 'pmtiles' && next.vis.tiles ? `pmtiles:${next.settings.pmtilesUrl}:${next.pmtilesVersion}:${dark}` : `empty:${dark}`;
    if (styleKey !== this.styleKey) {
      this.styleKey = styleKey;
      this.styleReady = false;
      this.clearSlots();
      this.loadStyle(base, dark);
    } else this.render();

    if (next.bounds && next.bounds !== this.lastBounds) {
      this.lastBounds = next.bounds;
      const [[s, w], [n, e]] = next.bounds;
      this.map.fitBounds([[w, s], [e, n]], { padding: 32, maxZoom: 14, duration: prev ? 800 : 0 });
    }
    this.map.getCanvas().style.cursor = next.draw ? 'crosshair' : '';
    if (next.draw) this.map.doubleClickZoom.disable();
    else this.map.doubleClickZoom.enable();
  }

  private async loadStyle(base: MapDef, dark: boolean) {
    const key = this.styleKey;
    if (key.startsWith('vector:')) {
      this.setStatus(base.id, { state: 'loading' });
      this.map.setStyle(base.style!, { diff: false });
      return;
    }
    if (key.startsWith('pmtiles:')) {
      const style = await this.pmtilesStyle(base, dark).catch(err => {
        this.setStatus(base.id, { state: 'error', message: err instanceof Error ? err.message : String(err) });
        return null;
      });
      if (key !== this.styleKey || this.destroyed) return;
      if (style) {
        this.map.setStyle(style, { diff: false });
        return;
      }
    }
    this.map.setStyle(this.emptyStyle(dark), { diff: false });
  }

  /** A vector PMTiles extract becomes the whole style (Protomaps basemap layers); raster extracts are ordinary layers. */
  private async pmtilesStyle(def: MapDef, dark: boolean): Promise<StyleSpecification | null> {
    const pm = await pmtiles();
    await loadLocalPmtiles();
    const file = getLocalPmtiles();
    const url = this.state!.settings.pmtilesUrl.trim();
    if (!file && !url) throw new Error('Choose a .pmtiles file or enter its URL in Settings → Map.');
    const archive = file ? new pm.PMTiles(new pm.FileSource(file)) : new pm.PMTiles(url);
    pmProtocol!.add(archive);
    const header = await archive.getHeader().catch(err => {
      throw new Error(`${file ? file.name : url} is not a readable PMTiles file (${err instanceof Error ? err.message : String(err)}).`);
    });
    if (header.tileType !== pm.TileType.Mvt) return null; // raster: drawn as a layer in render()
    const { layers, namedFlavor } = await import('@protomaps/basemaps');
    const online = navigator.onLine;
    this.setStatus(def.id, { state: 'ok' });
    return {
      version: 8,
      // Labels need fonts from the Protomaps asset site; offline the map is drawn without them.
      glyphs: online ? 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf' : undefined,
      sprite: online ? `https://protomaps.github.io/basemaps-assets/sprites/v4/${dark ? 'dark' : 'light'}` : undefined,
      sources: { protomaps: { type: 'vector', url: `pmtiles://${file ? file.name : url}`, attribution: def.attribution } },
      layers: layers('protomaps', namedFlavor(dark ? 'dark' : 'light'), online ? { lang: 'en' } : undefined) as LayerSpecification[],
    };
  }

  // ── Layer stack ──────────────────────────────────────────────────────────

  private clearSlots() {
    for (const s of this.slots.values()) s.dispose?.();
    this.slots.clear();
    for (const list of this.placeMarkers.values()) list.forEach(m => m.remove());
    this.placeMarkers.clear();
  }

  /** Removes a group's layers and sources from the map. */
  private drop(name: string) {
    const slot = this.slots.get(name);
    if (!slot) return;
    slot.dispose?.();
    for (const id of slot.ids) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of slot.sources) if (this.map.getSource(id)) this.map.removeSource(id);
    this.slots.delete(name);
  }

  /** Adds layers (bottom to top) for a group in its place in the stack. */
  private put(name: string, key: string, sources: Record<string, SourceSpecification>, layers: LayerSpecification[], dispose?: () => void): boolean {
    const old = this.slots.get(name);
    if (old && old.key === key) return false;
    this.drop(name);
    for (const [id, src] of Object.entries(sources)) if (!this.map.getSource(id)) this.map.addSource(id, src);
    for (const l of layers) this.map.addLayer(l);
    this.slots.set(name, { key, ids: layers.map(l => l.id), sources: Object.keys(sources), dispose });
    return true;
  }

  /** Re-applies the whole stack in order; groups whose key did not change are kept and only moved. */
  private render() {
    if (!this.state || !this.styleReady || this.destroyed) return;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      try {
        this.renderNow();
      } catch (err) {
        console.warn('TerraX map:', err);
      }
    });
  }

  private renderNow() {
    const st = this.state!;
    const dark = st.theme !== 'light';
    const base = resolveBase(st.settings, st.theme);
    const order: string[] = [];
    const want = (name: string, build: () => void) => {
      order.push(name);
      build();
    };

    want('outlines', () => this.outlines(st.vis.outlines, dark));
    const styleBase = this.styleKey.startsWith('vector:') || (this.styleKey.startsWith('pmtiles:') && this.map.getSource('protomaps'));
    if (!styleBase) want('base', () => this.catalogLayer('base', st.vis.tiles ? base : null, 1, dark, true));
    else this.drop('base');
    st.settings.overlays.forEach(o => want(`ov:${o.id}`, () => this.catalogLayer(`ov:${o.id}`, mapDef(o.id), o.opacity, dark, false)));
    want('image', () => this.resultImage(st.vis.image ? st.image : null, st.vis.opacity));
    want('boundary', () => this.boundaryLayer(st.vis.boundary ? st.boundary : null));
    want('features', () => this.features(st.vis.features ? st.geojson : null, st.vis.features && !st.geojson ? st.bounds : null));
    want('areas', () => this.areasLayer(st.vis.areas ? (st.areas ?? null) : null));
    want('fires', () => this.firesLayer(st.live?.fires ?? null));
    want('quakes', () => this.quakesLayer(st.live?.quakes ?? null));
    want('draw', () => this.drawLayer(st.draw));

    for (const name of [...this.slots.keys()]) if (!order.includes(name)) this.drop(name);
    // Move every kept group to the top in order, so the stack matches `order`.
    for (const name of order) for (const id of this.slots.get(name)?.ids ?? []) if (this.map.getLayer(id)) this.map.moveLayer(id);
    // Under a vector style the offline outlines go beneath the style's own layers.
    if (styleBase) {
      const first = this.map.getStyle().layers.find(l => !l.id.startsWith(P))?.id;
      if (first) for (const id of this.slots.get('outlines')?.ids ?? []) this.map.moveLayer(id, first);
    }
    for (const [id, s] of Object.entries(this.status)) if (s.state === 'error' && !order.some(n => n === `ov:${id}`) && id !== base.id) delete this.status[id];
    this.drawMarkers(st.draw);
    this.updatePick(st.pick ?? null);
    this.updateWeather(st.live?.weather ?? null);
    this.updatePlaces();
  }

  // ── Live Earth layers ────────────────────────────────────────────────────

  private emitView() {
    if (!this.handlers.onView || this.destroyed) return;
    const b = this.map.getBounds();
    this.handlers.onView({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: this.map.getZoom() });
  }

  private quakesLayer(fc: FeatureCollection | null) {
    if (!fc) return this.drop('quakes');
    const sid = `${P}quakes`;
    const color: unknown[] = ['step', ['coalesce', ['get', 'depthKm'], 0], DEPTH_CLASSES[0].color];
    DEPTH_CLASSES.slice(1).forEach((c, i) => color.push(DEPTH_CLASSES[i].max, c.color));
    const key = `quakes:${this.keyOf(fc)}`;
    const src = this.map.getSource(sid) as GeoJSONSource | undefined;
    if (src && this.slots.get('quakes')) {
      // New data for the same layer: swap it in place (no flicker).
      src.setData(fc);
      this.slots.get('quakes')!.key = key;
      return;
    }
    this.put('quakes', key, { [sid]: { type: 'geojson', data: fc, attribution: '<a href="https://earthquake.usgs.gov/earthquakes/feed/" target="_blank" rel="noopener">USGS earthquakes</a>' } }, [
      {
        id: `${P}quakes-circle`,
        type: 'circle',
        source: sid,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 0], 0, 2, 3, 4, 5, 8, 7, 16, 9, 26],
          'circle-color': color as never,
          'circle-opacity': 0.75,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1,
        },
      },
    ]);
  }

  private firesLayer(fc: FeatureCollection | null) {
    if (!fc) return this.drop('fires');
    const sid = `${P}fires`;
    const color: unknown[] = ['step', ['get', 'frp'], FRP_CLASSES[0].color];
    FRP_CLASSES.slice(1).forEach((c, i) => color.push(FRP_CLASSES[i].max, c.color));
    const key = `fires:${this.keyOf(fc)}`;
    const src = this.map.getSource(sid) as GeoJSONSource | undefined;
    if (src && this.slots.get('fires')) {
      src.setData(fc);
      this.slots.get('fires')!.key = key;
      return;
    }
    this.put('fires', key, { [sid]: { type: 'geojson', data: fc, attribution: '<a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noopener">NASA FIRMS</a>' } }, [
      {
        id: `${P}fires-circle`,
        type: 'circle',
        source: sid,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.5, 5, 2.5, 9, 4.5, 13, 7],
          'circle-color': color as never,
          'circle-opacity': 0.85,
        },
      },
    ]);
  }

  /** Today's weather as small HTML markers (a few dozen at most), so no glyph server is needed. */
  private updateWeather(points: WeatherPoint[] | null) {
    if (points === this.weatherKey) return;
    this.weatherKey = points;
    this.weatherMarkers.forEach(m => m.remove());
    this.weatherMarkers = [];
    for (const p of points ?? []) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'wx-marker';
      el.title = `${p.text ?? 'Weather'}: ${p.temperature ?? '—'} ${p.units.temperature ?? '°C'}`;
      el.setAttribute('aria-label', el.title);
      el.innerHTML = `<span class="wx-glyph" aria-hidden="true">${weatherGlyph(p.code, p.isDay)}</span><span class="num">${p.temperature === null ? '—' : Math.round(p.temperature)}°</span>`;
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        this.showPopup([p.lon, p.lat], `${weatherHtml(p)}<div class="muted"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a></div>`, 'weather');
      });
      this.weatherMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(this.map));
    }
  }

  /** Moves the view to a point (place search, place card). */
  flyTo(lat: number, lon: number, zoom?: number) {
    this.map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(this.map.getZoom(), 8), duration: 1200, essential: true });
  }

  private updatePick(p: { lat: number; lon: number } | null) {
    if (!p) {
      this.pickMarker?.remove();
      this.pickMarker = null;
      return;
    }
    if (!this.pickMarker) {
      const el = document.createElement('div');
      el.className = 'pick-marker';
      el.setAttribute('aria-hidden', 'true');
      this.pickMarker = new maplibregl.Marker({ element: el });
    }
    this.pickMarker.setLngLat([p.lon, p.lat]).addTo(this.map);
  }

  private areasLayer(fc: FeatureCollection | null) {
    if (!fc || !fc.features.length) return this.drop('areas');
    const violet = '#c084fc';
    this.put('areas', `areas:${this.keyOf(fc)}`, { [`${P}areas`]: { type: 'geojson', data: fc } }, [
      { id: `${P}areas-fill`, type: 'fill', source: `${P}areas`, paint: { 'fill-color': violet, 'fill-opacity': 0.12 } },
      { id: `${P}areas-line`, type: 'line', source: `${P}areas`, paint: { 'line-color': violet, 'line-width': 1.5 } },
    ]);
  }

  private outlines(on: boolean, dark: boolean) {
    if (!on) return this.drop('outlines');
    const key = `outlines:${dark}`;
    if (this.slots.get('outlines')?.key === key) return;
    countries()
      .then(c => {
        if (!this.state?.vis.outlines || this.destroyed || !this.styleReady) return;
        const p = palette(dark);
        const added = this.put('outlines', key, { [`${P}countries`]: { type: 'geojson', data: c.land }, [`${P}borders`]: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: c.borders } } }, [
          { id: `${P}countries-fill`, type: 'fill', source: `${P}countries`, paint: { 'fill-color': p.outlineLand } },
          { id: `${P}borders-line`, type: 'line', source: `${P}borders`, paint: { 'line-color': p.outlineBorder, 'line-width': 0.8 } },
        ]);
        if (added) this.render();
      })
      .catch(err => console.warn('TerraX: offline outlines unavailable', err));
  }

  /** One catalogue map (base or overlay). */
  private catalogLayer(name: string, def: MapDef | null, opacity: number, dark: boolean, base: boolean) {
    if (!def || def.kind === 'none') return this.drop(name);
    const s = this.state!.settings;
    const sid = `${P}${name}`;
    const fade = (key: string) => (this.slots.get(name)?.key === key ? this.setOpacity(name, opacity) : null);

    if (def.kind === 'raster' || def.kind === 'wms') {
      const alts = def.kind === 'wms' ? (/^https?:\/\//i.test(s.customWms.url.trim()) && s.customWms.layers.trim() ? [wmsTiles(s)] : []) : tileAlternatives(def, s);
      if (!alts.length) {
        this.drop(name);
        this.setStatus(def.id, { state: 'error', message: def.kind === 'wms' ? 'Enter the WMS address and layer name in Settings → Map.' : `${def.name} needs more settings (Settings → Map).` });
        return;
      }
      const key = `${def.id}:${JSON.stringify(alts)}`;
      if (fade(key) !== null) return;
      this.addRaster(name, key, sid, def, alts, 0, opacity);
      return;
    }
    if (def.kind === 'builtin') return this.builtinLayer(name, def, opacity, dark, base);
    if (def.kind === 'vector') {
      this.drop(name);
      this.setStatus(def.id, { state: 'error', message: `${def.name} is a full vector map: choose it as the base map, not an overlay.` });
      return;
    }
    if (def.kind === 'pmtiles') {
      // Raster extracts as layers (vector extracts became the style in loadStyle).
      const key = `${def.id}:${s.pmtilesUrl}:${this.state!.pmtilesVersion}`;
      if (fade(key) !== null) return;
      this.drop(name);
      pmtiles()
        .then(async pm => {
          await loadLocalPmtiles();
          const file = getLocalPmtiles();
          const url = s.pmtilesUrl.trim();
          if (!file && !url) throw new Error('Choose a .pmtiles file or enter its URL in Settings → Map.');
          const archive = file ? new pm.PMTiles(new pm.FileSource(file)) : new pm.PMTiles(url);
          pmProtocol!.add(archive);
          const h = await archive.getHeader().catch(err => {
            throw new Error(`${file ? file.name : url} is not a readable PMTiles file (${err instanceof Error ? err.message : String(err)}).`);
          });
          if (h.tileType === pm.TileType.Mvt) {
            if (!base) throw new Error('A vector PMTiles extract can only be the base map.');
            return;
          }
          if (this.destroyed || !this.styleReady) return;
          this.put(name, key, { [sid]: { type: 'raster', url: `pmtiles://${file ? file.name : url}`, tileSize: 256, attribution: def.attribution } }, [
            { id: `${sid}-r`, type: 'raster', source: sid, paint: { 'raster-opacity': opacity } },
          ]);
          this.setStatus(def.id, { state: 'ok' });
          this.render();
        })
        .catch(err => this.setStatus(def.id, { state: 'error', message: err instanceof Error ? err.message : String(err) }));
    }
  }

  private tries = new Map<string, TileTry>();

  private addRaster(name: string, key: string, sid: string, def: MapDef, alts: string[][], i: number, opacity: number) {
    const s = this.state!.settings;
    const maxzoom = def.maxNativeZoom ?? def.maxZoom ?? (def.id === 'custom-xyz' ? s.customXyz.maxZoom : 19);
    this.put(
      name,
      `${key}#${i}`,
      { [sid]: { type: 'raster', tiles: viaTxr(sid, alts[i]), tileSize: def.tileSize ?? 256, maxzoom: Math.min(22, maxzoom), attribution: def.id === 'custom-xyz' ? s.customXyz.attribution : def.kind === 'wms' ? s.customWms.attribution : def.attribution } },
      [{ id: `${sid}-r`, type: 'raster', source: sid, paint: { 'raster-opacity': opacity, 'raster-fade-duration': 150 } }],
    );
    this.slots.get(name)!.key = key;
    clearTimeout(this.tries.get(sid)?.timer);
    const t: TileTry = { alts, i, ok: 0, bad: 0, name, def, opacity, key, txr: true };
    this.tries.set(sid, t);
    ensureTxr();
    tileReporters.set(sid, (id, ok) => (ok ? this.tileLoaded(id, true) : this.onError({ sourceId: id }, true)));
    this.setStatus(def.id, { state: 'loading' });
  }

  private tileLoaded(sourceId: string, fromTxr = false) {
    const t = this.tries.get(sourceId);
    if (!t || (t.txr && !fromTxr)) return;
    t.ok++;
    this.setStatus(t.def.id, { state: 'ok' });
  }

  private onError(e: { sourceId?: string; error?: Error }, fromTxr = false) {
    const sid = e.sourceId;
    if (!sid) {
      if (this.styleKey.startsWith('vector:') && !this.styleReady) {
        const base = resolveBase(this.state!.settings, this.state!.theme);
        this.setStatus(base.id, { state: 'error', message: `${base.name} did not load (${e.error?.message ?? 'network error'}).` });
        // Fall back to the plain style so overlays and results still show.
        this.styleKey = `empty:${this.state!.theme !== 'light'}`;
        this.map.setStyle(this.emptyStyle(this.state!.theme !== 'light'), { diff: false });
      }
      return;
    }
    const t = this.tries.get(sid);
    if (!t || (t.txr && !fromTxr)) return; // txr sources report through the protocol
    t.bad++;
    // Give up on this URL form after three failures, or when only one or two tiles
    // were needed and all failed (checked once the burst of requests has settled).
    if (t.ok === 0 && t.bad < 3) {
      clearTimeout(t.timer);
      t.timer = window.setTimeout(() => this.tries.get(sid) === t && t.ok === 0 && this.giveUp(sid, t), 1500);
      return;
    }
    if (t.ok === 0) this.giveUp(sid, t);
  }

  private giveUp(sid: string, t: TileTry) {
    clearTimeout(t.timer);
    if (this.destroyed || t.done) return;
    t.done = true;
    if (t.i + 1 < t.alts.length) {
      // The next URL form of the same map (NASA GIBS and EOX list two).
      this.slots.delete(t.name);
      if (this.map.getLayer(`${sid}-r`)) this.map.removeLayer(`${sid}-r`);
      if (this.map.getSource(sid)) this.map.removeSource(sid);
      this.addRaster(t.name, t.key, sid, t.def, t.alts, t.i + 1, t.opacity);
      this.render();
    } else this.setStatus(t.def.id, { state: 'error', message: t.def.kind === 'wms' ? 'Custom WMS' : t.def.name });
  }

  private setOpacity(name: string, opacity: number) {
    for (const id of this.slots.get(name)?.ids ?? []) {
      const l = this.map.getLayer(id);
      if (!l) continue;
      const prop = l.type === 'raster' ? 'raster-opacity' : l.type === 'line' ? 'line-opacity' : l.type === 'fill' ? 'fill-opacity' : l.type === 'circle' ? 'circle-opacity' : null;
      if (prop) this.map.setPaintProperty(id, prop, l.type === 'fill' ? opacity * ((l.metadata as { fill?: number })?.fill ?? 1) : opacity);
    }
    const markers = this.placeMarkers.get(name);
    if (markers) for (const m of markers) m.getElement().style.opacity = String(opacity);
  }

  // ── Built-in world maps ──────────────────────────────────────────────────

  private builtinLayer(name: string, def: MapDef, opacity: number, dark: boolean, base: boolean) {
    const sid = `${P}${name}`;
    const kind = def.builtin!;
    const key = `${def.id}:${dark}`;
    if (this.slots.get(name)?.key === key) return void this.setOpacity(name, opacity);

    if (kind === 'image' || kind === 'classes') {
      this.put(name, key, { [sid]: { type: 'raster', tiles: [apiUrl(`/api/maps/tiles/${def.id}/{z}/{x}/{y}`)], tileSize: 512, maxzoom: pictureMaxZoom(def), attribution: def.attribution } }, [
        { id: `${sid}-r`, type: 'raster', source: sid, paint: { 'raster-opacity': opacity, 'raster-resampling': kind === 'classes' ? 'nearest' : 'linear' } },
      ]);
      this.tries.set(sid, { alts: [[]], i: 0, ok: 0, bad: 0, name, def, opacity, key });
      return;
    }

    const p = palette(dark);
    const load = async (): Promise<{ sources: Record<string, SourceSpecification>; layers: LayerSpecification[]; dispose?: () => void }> => {
      if (kind === 'plates') {
        const fc = await vector<FeatureCollection>('plates');
        const dashed = Object.entries(PLATE_CLASSES).filter(([, c]) => c.dash).map(([k]) => k);
        const color = ['match', ['get', 'c'], ...Object.entries(PLATE_CLASSES).flatMap(([k, c]) => [k, c.color]), '#ffffff'] as unknown as string;
        const hover = (e: maplibregl.MapLayerMouseEvent) => {
          const f = e.features?.[0];
          if (!f) return;
          const pr = f.properties as { b: string; c: string; v: number };
          this.map.getCanvas().style.cursor = this.state?.draw ? 'crosshair' : 'pointer';
          this.showPopup(e.lngLat, `<strong>${PLATE_CLASSES[pr.c]?.name ?? pr.c}</strong><br>${platePair(pr.b)} plates<br>Relative speed ≈ ${pr.v} mm per year`, 'plate');
        };
        const leave = () => {
          this.map.getCanvas().style.cursor = this.state?.draw ? 'crosshair' : '';
          if (this.popup && (this.popup as unknown as { _kind?: string })._kind === 'plate') this.popup.remove();
        };
        for (const id of [`${sid}-solid`, `${sid}-dash`]) {
          this.map.on('mousemove', id, hover);
          this.map.on('mouseleave', id, leave);
        }
        return {
          sources: { [sid]: { type: 'geojson', data: fc, attribution: def.attribution } },
          layers: [
            { id: `${sid}-solid`, type: 'line', source: sid, filter: ['!', ['in', ['get', 'c'], ['literal', dashed]]], paint: { 'line-color': color, 'line-width': 2.2, 'line-opacity': opacity } },
            { id: `${sid}-dash`, type: 'line', source: sid, filter: ['in', ['get', 'c'], ['literal', dashed]], paint: { 'line-color': color, 'line-width': 2.2, 'line-dasharray': [2.5, 1.5], 'line-opacity': opacity } },
          ],
          dispose: () => {
            for (const id of [`${sid}-solid`, `${sid}-dash`]) {
              this.map.off('mousemove', id, hover);
              this.map.off('mouseleave', id, leave);
            }
          },
        };
      }
      if (kind === 'graticule') {
        const fc = await graticule();
        const lines: FeatureCollection = { type: 'FeatureCollection', features: fc.features.filter(f => f.geometry.type === 'LineString') };
        this.placeMarkers.get(name)?.forEach(m => m.remove());
        this.placeMarkers.set(
          name,
          fc.features
            .filter(f => f.properties?.kind === 'label')
            .map(f => {
              const el = document.createElement('div');
              el.className = `grid-label ${dark ? 'dark' : 'light'}`;
              el.innerHTML = `<span>${escapeHtml(String(f.properties!.label))}</span>`;
              el.style.opacity = String(opacity);
              const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
              return new maplibregl.Marker({ element: el, anchor: 'bottom-left' }).setLngLat([lon, lat]).addTo(this.map);
            }),
        );
        return {
          sources: { [sid]: { type: 'geojson', data: lines } },
          layers: [
            { id: `${sid}-grid`, type: 'line', source: sid, filter: ['==', ['get', 'kind'], 'grid'], paint: { 'line-color': p.grid, 'line-width': ['case', ['get', 'major'], 1, 0.5], 'line-opacity': opacity } },
            { id: `${sid}-special`, type: 'line', source: sid, filter: ['==', ['get', 'kind'], 'special'], paint: { 'line-color': p.special, 'line-width': 1.2, 'line-dasharray': ['case', ['get', 'equator'], ['literal', [1, 0]], ['literal', [4, 3]]] as unknown as number[], 'line-opacity': opacity } },
          ],
          dispose: () => {
            this.placeMarkers.get(name)?.forEach(m => m.remove());
            this.placeMarkers.delete(name);
          },
        };
      }
      // Natural Earth: 1:50m for the world view, 1:10m cells from zoom 5.
      const needs = {
        land: kind === 'ne-detailed',
        borders: kind === 'ne-detailed' || kind === 'ne-borders',
        water: kind === 'ne-detailed' || kind === 'ne-water',
        places: kind === 'ne-detailed' || kind === 'ne-places',
      };
      const [c, admin1, rivers, lakes] = await Promise.all([
        needs.land || needs.borders ? countries() : null,
        needs.borders ? vector<FeatureCollection>('admin1') : null,
        needs.water ? vector<FeatureCollection>('rivers') : null,
        needs.water ? vector<FeatureCollection>('lakes') : null,
      ]);
      if (needs.places) vector<Places>('places').then(() => this.updatePlaces()).catch(() => undefined);
      const sources: Record<string, SourceSpecification> = {};
      const layers: LayerSpecification[] = [];
      const coarse = { maxzoom: DETAIL_ZOOM };
      const fine = { minzoom: DETAIL_ZOOM };
      const src = (id: string, data: unknown) => (sources[`${sid}-${id}`] = { type: 'geojson', data: data as FeatureCollection, attribution: def.attribution });
      const lineOpacity = opacity;
      if (needs.land) {
        layers.push({ id: `${sid}-sea`, type: 'background', paint: { 'background-color': p.sea, 'background-opacity': base ? 1 : opacity } });
        src('land', c!.land);
        src('fine-land', EMPTY);
        layers.push({ id: `${sid}-land`, type: 'fill', source: `${sid}-land`, paint: { 'fill-color': p.land, 'fill-opacity': opacity } });
        layers.push({ id: `${sid}-fine-land`, type: 'fill', source: `${sid}-fine-land`, ...fine, paint: { 'fill-color': p.land, 'fill-opacity': opacity } });
      }
      if (needs.water) {
        src('lakes', lakes);
        src('rivers', rivers);
        src('fine-lakes', EMPTY);
        src('fine-rivers', EMPTY);
        const lakePaint = { 'fill-color': needs.land ? p.lake : p.water, 'fill-opacity': (needs.land ? 1 : 0.35) * opacity, 'fill-outline-color': p.water };
        layers.push({ id: `${sid}-lakes`, type: 'fill', source: `${sid}-lakes`, ...coarse, paint: lakePaint, metadata: { fill: needs.land ? 1 : 0.35 } });
        layers.push({ id: `${sid}-fine-lakes`, type: 'fill', source: `${sid}-fine-lakes`, ...fine, paint: lakePaint, metadata: { fill: needs.land ? 1 : 0.35 } });
        layers.push({ id: `${sid}-rivers`, type: 'line', source: `${sid}-rivers`, ...coarse, paint: { 'line-color': p.water, 'line-width': 0.9, 'line-opacity': 0.9 * lineOpacity } });
        layers.push({ id: `${sid}-fine-rivers`, type: 'line', source: `${sid}-fine-rivers`, ...fine, paint: { 'line-color': p.water, 'line-width': 0.9, 'line-opacity': 0.9 * lineOpacity } });
      }
      if (needs.borders) {
        src('admin1', admin1);
        src('borders', { type: 'Feature', properties: {}, geometry: c!.borders });
        src('fine-admin1', EMPTY);
        src('fine-borders', EMPTY);
        const admin = { 'line-color': p.admin1, 'line-width': 0.6, 'line-dasharray': [3, 3], 'line-opacity': lineOpacity };
        const border = { 'line-color': p.border, 'line-width': 1.1, 'line-opacity': lineOpacity };
        layers.push({ id: `${sid}-admin1`, type: 'line', source: `${sid}-admin1`, ...coarse, paint: admin });
        layers.push({ id: `${sid}-fine-admin1`, type: 'line', source: `${sid}-fine-admin1`, ...fine, paint: admin });
        layers.push({ id: `${sid}-borders`, type: 'line', source: `${sid}-borders`, ...coarse, paint: border });
        layers.push({ id: `${sid}-fine-borders`, type: 'line', source: `${sid}-fine-borders`, ...fine, paint: border });
      }
      return { sources, layers };
    };

    // Mark the slot as taken so the stack keeps its place while the data loads.
    this.drop(name);
    this.slots.set(name, { key: `${key}:loading`, ids: [], sources: [] });
    this.setStatus(def.id, { state: 'loading' });
    load()
      .then(({ sources, layers, dispose }) => {
        if (this.destroyed || !this.styleReady || this.slots.get(name)?.key !== `${key}:loading`) return dispose?.();
        this.slots.delete(name);
        this.put(name, key, sources, layers, dispose);
        this.setStatus(def.id, { state: 'ok' });
        this.detailKey = '';
        this.onMove();
        this.render();
      })
      .catch(err => {
        if (this.slots.get(name)?.key === `${key}:loading`) this.slots.delete(name);
        this.setStatus(def.id, { state: 'error', message: `${def.name} could not be loaded (${err instanceof Error ? err.message : String(err)}).` });
      });
  }

  private detailKey = '';

  /** Loads the 1:10m Natural Earth cells for the view once zoomed in. */
  private onMove() {
    this.emitView();
    this.updatePlaces();
    if (this.map.getZoom() < DETAIL_ZOOM) return;
    const names = [...this.slots.entries()].filter(([, s]) => s.sources.some(id => id.endsWith('-fine-land') || id.endsWith('-fine-rivers') || id.endsWith('-fine-borders'))).map(([n]) => n);
    if (!names.length) return;
    const b = this.map.getBounds();
    const dx = (b.getEast() - b.getWest()) * 0.25, dy = (b.getNorth() - b.getSouth()) * 0.25;
    const w = Math.max(-540, b.getWest() - dx), e = Math.min(540, b.getEast() + dx);
    const s = Math.max(-90, b.getSouth() - dy), n = Math.min(90, b.getNorth() + dy);
    const q = `west=${w.toFixed(2)}&south=${s.toFixed(2)}&east=${e.toFixed(2)}&north=${n.toFixed(2)}`;
    const want = `${q}|${names.join(',')}`;
    if (want === this.detailKey) return;
    this.detailKey = want;
    request<{ cells: string[] } & Record<string, FeatureCollection>>(`/api/maps/detail?${q}`)
      .then(d => {
        if (this.detailKey !== want) return; // the view moved on
        for (const nm of names)
          for (const layer of ['land', 'rivers', 'lakes', 'admin1', 'borders']) {
            const src = this.map.getSource(`${P}${nm}-fine-${layer}`) as GeoJSONSource | undefined;
            src?.setData(d[layer] ?? EMPTY);
          }
      })
      .catch(() => undefined); // the 1:50m layers stay underneath
  }

  /** City labels as HTML markers, filtered by Natural Earth's min_zoom and placed without overlaps. */
  private updatePlaces() {
    const names = [...this.slots.entries()].filter(([n]) => {
      const id = n.startsWith('ov:') ? n.slice(3) : n === 'base' ? resolveBase(this.state!.settings, this.state!.theme).id : '';
      const d = mapDef(id);
      return d.builtin === 'ne-detailed' || d.builtin === 'ne-places';
    });
    const dark = this.state?.theme !== 'light';
    for (const [name] of this.placeMarkers) if (!names.some(([n]) => n === name) && !name.startsWith('ov:graticule') && mapDef(name.replace(/^ov:/, '')).builtin !== 'graticule') {
      this.placeMarkers.get(name)!.forEach(m => m.remove());
      this.placeMarkers.delete(name);
    }
    if (!names.length) return;
    vector<Places>('places')
      .then(places => {
        for (const [name] of names) {
          if (!this.slots.has(name)) continue;
          this.placeMarkers.get(name)?.forEach(m => m.remove());
          const z = this.map.getZoom();
          const b = this.map.getBounds();
          const taken: [number, number, number, number][] = [];
          const out: maplibregl.Marker[] = [];
          const opacity = name === 'base' ? 1 : (this.state!.settings.overlays.find(o => `ov:${o.id}` === name)?.opacity ?? 1);
          for (const [label, lat, lon, minZoom, , cap] of places) {
            if (minZoom > z + 1.5) break; // sorted by min_zoom
            if (!b.contains([lon, lat])) continue;
            const pt = this.map.project([lon, lat]);
            const box: [number, number, number, number] = [pt.x - 4, pt.y - 9, pt.x + 8 + label.length * 6.3, pt.y + 7];
            if (taken.some(t => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
            taken.push(box);
            const el = document.createElement('div');
            el.className = `place-label ${dark ? 'dark' : 'light'} ${cap === 2 ? 'capital' : ''}`;
            el.innerHTML = `<i></i><span>${escapeHtml(label)}</span>`;
            el.style.opacity = String(opacity);
            out.push(new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat([lon, lat]).addTo(this.map));
            if (out.length >= 250) break;
          }
          this.placeMarkers.set(name, out);
        }
      })
      .catch(() => undefined);
  }

  // ── Results ──────────────────────────────────────────────────────────────

  private resultImage(img: ResultImage | null, opacity: number) {
    if (!img?.bounds) return this.drop('image');
    const key = `${img.url}`;
    if (this.slots.get('image')?.key === key) return void this.setOpacity('image', opacity);
    const [[s, w], [n, e]] = img.bounds;
    const paint = { 'raster-opacity': opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } as const;
    const t = img.tiles;
    const sources: Record<string, SourceSpecification> = { [`${P}image`]: { type: 'image', url: apiUrl(img.url), coordinates: [[w, n], [e, n], [e, s], [w, s]] } };
    // The picture is thinned to at most 4096 cells a side; from the zoom where that shows, full-resolution tiles take over.
    const layers: LayerSpecification[] = [{ id: `${P}image-r`, type: 'raster', source: `${P}image`, paint, ...(t ? { maxzoom: t.minzoom } : {}) }];
    if (t) {
      // An absolute template (tiles may load off the main thread), keeping {z}/{x}/{y} unencoded.
      const tmpl = apiUrl(t.url);
      sources[`${P}image-tiles`] = { type: 'raster', tiles: [/^https?:/.test(tmpl) ? tmpl : `${location.origin}${tmpl}`], tileSize: 256, bounds: t.bounds, minzoom: Math.max(0, t.minzoom), maxzoom: t.maxzoom };
      layers.push({ id: `${P}image-tiles-r`, type: 'raster', source: `${P}image-tiles`, minzoom: t.minzoom, paint });
    }
    this.put('image', key, sources, layers);
  }

  private boundaryLayer(b: Boundary | null) {
    if (!b) return this.drop('boundary');
    this.put('boundary', `${b.name}:${b.areaM2}:${JSON.stringify(b.geojson).length}`, { [`${P}boundary`]: { type: 'geojson', data: b.geojson as FeatureCollection } }, [
      { id: `${P}boundary-line`, type: 'line', source: `${P}boundary`, paint: { 'line-color': '#f5b83d', 'line-width': 2, 'line-dasharray': [3, 2] } },
    ]);
  }

  private featureKey = new WeakMap<object, number>();
  private nextKey = 1;
  private keyOf(o: object) {
    let k = this.featureKey.get(o);
    if (!k) this.featureKey.set(o, (k = this.nextKey++));
    return k;
  }

  private features(fc: FeatureCollection | null, footprint: LatLngBounds | null) {
    if (!fc && !footprint) return this.drop('features');
    const data: FeatureCollection = fc ?? {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[[footprint![0][1], footprint![0][0]], [footprint![1][1], footprint![0][0]], [footprint![1][1], footprint![1][0]], [footprint![0][1], footprint![1][0]], [footprint![0][1], footprint![0][0]]]] },
        },
      ],
    };
    const key = fc ? `fc:${this.keyOf(fc)}` : `fp:${footprint!.flat().join(',')}`;
    const blue = '#5ab0f0';
    this.put('features', key, { [`${P}features`]: { type: 'geojson', data } }, [
      { id: `${P}features-fill`, type: 'fill', source: `${P}features`, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': blue, 'fill-opacity': fc ? 0.18 : 0.2 } },
      { id: `${P}features-line`, type: 'line', source: `${P}features`, filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': ['coalesce', ['get', 'stroke'], blue], 'line-width': ['coalesce', ['get', 'stroke-width'], 2] } },
      { id: `${P}features-point`, type: 'circle', source: `${P}features`, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': blue, 'circle-opacity': 0.6, 'circle-stroke-color': blue, 'circle-stroke-width': 2 } },
    ]);
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private drawLayer(draw: DrawState | null) {
    if (!draw || draw.points.length < 2) return this.drop('draw');
    const ring = draw.points.map(([lat, lon]) => [lon, lat]);
    const feature: Feature =
      draw.points.length >= 3
        ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }
        : { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } };
    const key = `draw:${JSON.stringify(ring)}`;
    if (this.slots.get('draw')) {
      const src = this.map.getSource(`${P}draw`) as GeoJSONSource | undefined;
      if (src) {
        src.setData(feature);
        this.slots.get('draw')!.key = key;
        return;
      }
    }
    this.put('draw', key, { [`${P}draw`]: { type: 'geojson', data: feature } }, [
      { id: `${P}draw-fill`, type: 'fill', source: `${P}draw`, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#f5b83d', 'fill-opacity': 0.12 } },
      { id: `${P}draw-line`, type: 'line', source: `${P}draw`, paint: { 'line-color': '#f5b83d', 'line-width': 2, 'line-dasharray': [3, 2] } },
    ]);
  }

  private drawMarkers(draw: DrawState | null) {
    const pts = draw?.points ?? [];
    while (this.markers.length > pts.length) this.markers.pop()!.remove();
    pts.forEach(([lat, lon], i) => {
      let m = this.markers[i];
      if (!m) {
        const el = document.createElement('div');
        el.className = 'vertex-handle';
        el.addEventListener('dblclick', ev => {
          ev.stopPropagation();
          ev.preventDefault();
          this.state?.draw?.onRemove(Number(el.dataset.index));
        });
        el.addEventListener('click', ev => ev.stopPropagation());
        m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([lon, lat]).addTo(this.map);
        m.on('dragend', () => {
          const ll = m.getLngLat();
          this.state?.draw?.onMove(Number(el.dataset.index), [ll.lat, ll.lng]);
        });
        this.markers[i] = m;
      } else m.setLngLat([lon, lat]);
      const el = m.getElement();
      el.dataset.index = String(i);
      el.title = `Vertex ${i + 1}: drag to move, double-click to delete`;
    });
  }

  // ── Clicks ───────────────────────────────────────────────────────────────

  private onClick(e: maplibregl.MapMouseEvent) {
    const st = this.state;
    if (!st) return;
    if (st.draw) {
      st.draw.onAdd([e.lngLat.lat, ((((e.lngLat.lng + 180) % 360) + 360) % 360) - 180]);
      return;
    }
    // Live points first: a small box around the click, since they are only a few pixels wide.
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [e.point.x - 5, e.point.y - 5],
      [e.point.x + 5, e.point.y + 5],
    ];
    if (this.map.getLayer(`${P}quakes-circle`)) {
      const hit = this.map.queryRenderedFeatures(box, { layers: [`${P}quakes-circle`] });
      if (hit.length) {
        // The strongest under the cursor (they are drawn strongest on top).
        const top = hit.reduce((a, b) => ((b.properties?.mag ?? -9) > (a.properties?.mag ?? -9) ? b : a));
        const g = top.geometry as unknown as { coordinates: [number, number] };
        this.showPopup(g.coordinates, quakeHtml(top.properties as unknown as QuakeProps), 'quake');
        return;
      }
    }
    if (this.map.getLayer(`${P}fires-circle`)) {
      const hit = this.map.queryRenderedFeatures(box, { layers: [`${P}fires-circle`] })[0];
      if (hit) {
        const g = hit.geometry as unknown as { coordinates: [number, number] };
        const more = this.map.queryRenderedFeatures(box, { layers: [`${P}fires-circle`] }).length - 1;
        this.showPopup(g.coordinates, fireHtml(hit.properties as never, st.live?.fireLabel ?? 'NASA FIRMS') + (more > 0 ? `<div class="muted">and ${more} more here; zoom in</div>` : ''), 'fire');
        return;
      }
    }
    if (this.handlers.onArea && this.map.getLayer(`${P}areas-fill`)) {
      const hit = this.map.queryRenderedFeatures(e.point, { layers: [`${P}areas-fill`] })[0];
      const id = hit?.properties?.id;
      if (typeof id === 'string') {
        this.handlers.onArea(id);
        return;
      }
    }
    if (this.handlers.onPick) {
      // The place card shows the climate zone and biome too, so no separate popup.
      this.handlers.onPick(e.lngLat.lat, ((((e.lngLat.lng + 180) % 360) + 360) % 360) - 180);
      return;
    }
    const ids = st.settings.overlays.map(o => o.id).filter(id => id === 'koppen' || id === 'biomes');
    if (!ids.length) return;
    const lat = e.lngLat.lat;
    const lon = ((((e.lngLat.lng + 180) % 360) + 360) % 360) - 180;
    request<{ koppen: { code: string; name: string } | null; biome: { name: string } | null }>(`/api/maps/identify?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`)
      .then(r => {
        const rows: string[] = [];
        if (ids.includes('koppen')) rows.push(`<div><span class="muted">Climate (Köppen–Geiger):</span> <strong>${r.koppen ? `${r.koppen.code} · ${escapeHtml(r.koppen.name)}` : 'none (sea or no data)'}</strong></div>`);
        if (ids.includes('biomes')) rows.push(`<div><span class="muted">Biome:</span> <strong>${r.biome ? escapeHtml(r.biome.name) : 'none (sea or no data)'}</strong></div>`);
        this.showPopup(e.lngLat, `<div class="muted">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</div>${rows.join('')}`, 'identify');
      })
      .catch(err => this.showPopup(e.lngLat, `<div>${escapeHtml(err instanceof Error ? err.message : 'Could not read the class here.')}</div>`, 'identify'));
  }

  private showPopup(at: maplibregl.LngLatLike, html: string, kind: string) {
    if (!this.popup) this.popup = new maplibregl.Popup({ className: 'class-popup', maxWidth: '280px', closeOnClick: true });
    (this.popup as unknown as { _kind?: string })._kind = kind;
    this.popup.setLngLat(at).setHTML(html).addTo(this.map);
  }
}

const PLATES: Record<string, string> = {
  AF: 'Africa', AM: 'Amur', AN: 'Antarctica', AP: 'Altiplano', AR: 'Arabia', AS: 'Aegean Sea', AT: 'Anatolia', AU: 'Australia',
  BH: 'Birds Head', BR: 'Balmoral Reef', BS: 'Banda Sea', BU: 'Burma', CA: 'Caribbean', CL: 'Caroline', CO: 'Cocos', CR: 'Conway Reef',
  EA: 'Easter', EU: 'Eurasia', FT: 'Futuna', GP: 'Galápagos', IN: 'India', JF: 'Juan de Fuca', JZ: 'Juan Fernández', KE: 'Kermadec',
  MA: 'Mariana', MN: 'Manus', MO: 'Maoke', MS: 'Molucca Sea', NA: 'North America', NB: 'North Bismarck', ND: 'North Andes', NH: 'New Hebrides',
  NI: 'Niuafo’ou', NZ: 'Nazca', OK: 'Okhotsk', ON: 'Okinawa', PA: 'Pacific', PM: 'Panama', PS: 'Philippine Sea', RI: 'Rivera',
  SA: 'South America', SB: 'South Bismarck', SC: 'Scotia', SL: 'Shetland', SO: 'Somalia', SS: 'Solomon Sea', SU: 'Sunda', SW: 'Sandwich',
  TI: 'Timor', TO: 'Tonga', WL: 'Woodlark', YA: 'Yangtze',
};

/** "AF-AN" (or with / or \ for subduction polarity) → "Africa – Antarctica". */
function platePair(code: string): string {
  return code
    .split(/[-/\\]/)
    .map(c => PLATES[c] ?? c)
    .join(' – ');
}

function escapeHtml(s: string): string {
  return s.replace(/[<&>"]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' })[c]!);
}
