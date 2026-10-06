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
    this.updatePlaces();
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
    this.put('image', key, { [`${P}image`]: { type: 'image', url: apiUrl(img.url), coordinates: [[w, n], [e, n], [e, s], [w, s]] } }, [
      { id: `${P}image-r`, type: 'raster', source: `${P}image`, paint: { 'raster-opacity': opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } },
    ]);
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
