// Leaflet layers for TerraX's built-in world maps. Images are square Web
// Mercator pictures cut into tiles in the browser; vectors are drawn on canvas.
import L from 'leaflet';
import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson';
import type { MapDef } from '../lib/basemaps';
import { MERCATOR_MAX_LAT, PLATE_CLASSES, obliquityDeg, platePair, worldMapUrl } from '../lib/world-maps';

const cache = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  if (!cache.has(key)) {
    const p = load();
    p.catch(() => cache.delete(key)); // allow a retry after a failure
    cache.set(key, p);
  }
  return cache.get(key) as Promise<T>;
}

export function loadImage(file: string): Promise<HTMLImageElement> {
  return once(`img:${file}`, () => {
    const img = new Image();
    img.decoding = 'async';
    img.src = worldMapUrl(file);
    return img.decode().then(() => img, () => Promise.reject(new Error(`${file} could not be loaded`)));
  });
}

export function loadJson<T>(file: string): Promise<T> {
  return once(`json:${file}`, async () => {
    const res = await fetch(worldMapUrl(file));
    if (!res.ok) throw new Error(`${file} could not be loaded (HTTP ${res.status})`);
    return (await res.json()) as T;
  });
}

/** Pixels of a class image, for reading the class under a click. */
export function loadPixels(file: string): Promise<ImageData> {
  return once(`px:${file}`, async () => {
    const img = await loadImage(file);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  });
}

/** Halves the picture until it is close to the size a tile needs, so low zooms are not aliased. */
function mipmaps(img: HTMLImageElement): (HTMLImageElement | HTMLCanvasElement)[] {
  const levels: (HTMLImageElement | HTMLCanvasElement)[] = [img];
  let src: HTMLImageElement | HTMLCanvasElement = img;
  while (src.width > 512) {
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(src.width / 2);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    levels.push(c);
    src = c;
  }
  return levels;
}

/** A square Web Mercator world picture shown as map tiles. */
const MercatorImageLayer = L.GridLayer.extend({
  initialize(this: L.GridLayer & { _mips?: ReturnType<typeof mipmaps>; _pixelated: boolean }, levels: Promise<ReturnType<typeof mipmaps>>, pixelated: boolean, options: L.GridLayerOptions) {
    (L.GridLayer.prototype as unknown as { initialize: (o: L.GridLayerOptions) => void }).initialize.call(this, options);
    this._pixelated = pixelated;
    levels.then(l => {
      this._mips = l;
      this.redraw();
    });
  },
  createTile(this: L.GridLayer & { _mips?: ReturnType<typeof mipmaps>; _pixelated: boolean }, coords: L.Coords) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;
    const levels = this._mips;
    if (!levels) return tile;
    const n = 2 ** coords.z;
    // Smallest level that still has at least one source pixel per tile pixel; class maps always use the full picture.
    let lvl = levels[0];
    if (!this._pixelated) for (const l of levels) if (l.width / n >= size.x) lvl = l;
    const s = lvl.width / n;
    const ctx = tile.getContext('2d')!;
    ctx.imageSmoothingEnabled = !this._pixelated;
    ctx.drawImage(lvl, coords.x * s, coords.y * s, s, s, 0, 0, size.x, size.y);
    return tile;
  },
}) as unknown as new (levels: Promise<ReturnType<typeof mipmaps>>, pixelated: boolean, options: L.GridLayerOptions) => L.GridLayer;

// GeoJSON passes its options on to each path, so `renderer` works there even though Leaflet's types omit it.
const geo = (data: unknown, o: L.GeoJSONOptions & { renderer?: L.Renderer }) => L.geoJSON(data as never, o as L.GeoJSONOptions);

interface Opts {
  opacity: number;
  zIndex: number;
  dark: boolean;
  base: boolean;
}

/** A map pane of its own, so a vector layer can be ordered and faded as a whole. */
function paneFor(map: L.Map, id: string, o: Opts, interactive: boolean): string {
  const name = `builtin-${id}`;
  const pane = map.getPane(name) ?? map.createPane(name);
  // Base maps sit just above the offline outlines (150) and below tiles (200); overlays sit above all tiles.
  pane.style.zIndex = String(o.base ? 160 : 300 + o.zIndex);
  pane.style.opacity = String(o.opacity);
  // Only the plate boundaries answer the mouse (tooltips); other built-in vectors let clicks through.
  pane.style.pointerEvents = interactive ? 'auto' : 'none';
  return name;
}

/** A pane nested in a built-in pane for its labels: Leaflet gives canvases z-index 100, which would cover markers placed high on the map. */
function labelPane(map: L.Map, pane: string): string {
  const name = `${pane}-labels`;
  const el = map.getPane(name) ?? map.createPane(name, map.getPane(pane));
  el.style.zIndex = '200';
  el.style.pointerEvents = 'none';
  return name;
}

const palette = (dark: boolean) =>
  dark
    ? { sea: '#0b1622', land: '#18242f', border: '#7f97ad', admin1: '#4f6475', water: '#3b82c4', lake: '#0f2236', text: '#dbe6f0', halo: 'rgba(8,14,22,0.85)', grid: 'rgba(148,180,210,0.28)', special: '#f5b84b' }
    : { sea: '#cfe3f1', land: '#f6f3ea', border: '#6b7280', admin1: '#a3a3a3', water: '#4a90c8', lake: '#cfe3f1', text: '#1f2937', halo: 'rgba(255,255,255,0.85)', grid: 'rgba(60,80,110,0.25)', special: '#b45309' };

type Places = [string, number, number, number, number, number][];

/**
 * City labels, filtered by Natural Earth's min_zoom and the visible area. Places come
 * sorted by importance, so a label that would overlap one already placed is skipped.
 */
function placesLayer(map: L.Map, parentPane: string, dark: boolean, places: Places): L.LayerGroup {
  const pane = labelPane(map, parentPane);
  const group = L.layerGroup([], { pane });
  const update = () => {
    group.clearLayers();
    const z = map.getZoom();
    const b = map.getBounds().pad(0.1);
    const taken: [number, number, number, number][] = [];
    let n = 0;
    for (const [name, lat, lon, minZoom, , cap] of places) {
      if (minZoom > z + 1.5) break; // sorted by min_zoom
      if (!b.contains([lat, lon])) continue;
      const pt = map.latLngToContainerPoint([lat, lon]);
      const box: [number, number, number, number] = [pt.x - 4, pt.y - 9, pt.x + 8 + name.length * 6.3, pt.y + 7];
      if (taken.some(t => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
      taken.push(box);
      const icon = L.divIcon({ className: `place-label ${dark ? 'dark' : 'light'} ${cap === 2 ? 'capital' : ''}`, html: `<i></i><span>${name.replace(/[<&>]/g, '')}</span>`, iconSize: [0, 0] });
      L.marker([lat, lon], { icon, pane, interactive: false, keyboard: false }).addTo(group);
      if (++n >= 250) break;
    }
  };
  group.on('add', () => {
    update();
    map.on('moveend', update);
  });
  group.on('remove', () => map.off('moveend', update));
  return group;
}

function graticuleLayer(map: L.Map, pane: string, dark: boolean): L.LayerGroup {
  const labels = labelPane(map, pane);
  const p = palette(dark);
  const renderer = L.canvas({ pane });
  const g = L.layerGroup([], { pane });
  const line = (pts: [number, number][], color: string, weight: number, dash?: string) => L.polyline(pts, { renderer, color, weight, dashArray: dash, interactive: false }).addTo(g);
  for (let lon = -180; lon <= 180; lon += 10) line([[-MERCATOR_MAX_LAT, lon], [MERCATOR_MAX_LAT, lon]], p.grid, lon % 30 === 0 ? 1 : 0.5);
  const lats = (lat: number) => Array.from({ length: 73 }, (_, i) => [lat, -180 + i * 5] as [number, number]);
  for (let lat = -80; lat <= 80; lat += 10) if (lat !== 0) line(lats(lat), p.grid, lat % 30 === 0 ? 1 : 0.5);
  const eps = obliquityDeg(new Date());
  const special: [number, string][] = [
    [0, 'Equator'],
    [eps, `Tropic of Cancer ${eps.toFixed(2)}° N`],
    [-eps, `Tropic of Capricorn ${eps.toFixed(2)}° S`],
    [90 - eps, `Arctic Circle ${(90 - eps).toFixed(2)}° N`],
    [-(90 - eps), `Antarctic Circle ${(90 - eps).toFixed(2)}° S`],
  ];
  for (const [lat, label] of special) {
    line(lats(lat), p.special, 1.2, lat === 0 ? undefined : '6 4');
    for (const lon of [-150, -30, 90])
      L.marker([lat, lon], { pane: labels, interactive: false, keyboard: false, icon: L.divIcon({ className: `grid-label ${dark ? 'dark' : 'light'}`, html: `<span>${label}</span>`, iconSize: [0, 0] }) }).addTo(g);
  }
  return g;
}

interface PlateProps {
  b: string;
  c: string;
  v: number;
}

function platesLayer(pane: string, fc: FeatureCollection<LineString, PlateProps>): L.GeoJSON {
  const renderer = L.canvas({ pane, tolerance: 6 });
  return geo(fc, {
    pane,
    renderer,
    style: f => {
      const c: { color: string; dash?: string } = PLATE_CLASSES[(f as Feature<LineString, PlateProps>).properties.c] ?? { color: '#fff' };
      return { color: c.color, weight: 2.2, dashArray: c.dash, opacity: 0.95 };
    },
    onEachFeature: (f, layer) => {
      const p = f.properties as PlateProps;
      layer.bindTooltip(`<strong>${PLATE_CLASSES[p.c]?.name ?? p.c}</strong><br>${platePair(p.b)} plates<br>Relative speed ≈ ${p.v} mm per year`, { sticky: true });
    },
  });
}

/** Builds one built-in map layer. Rejects with a readable message when its files are missing. */
export async function createBuiltinLayer(def: MapDef, map: L.Map, o: Opts): Promise<L.Layer> {
  const kind = def.builtin!;
  if (kind === 'image' || kind === 'classes') {
    const pixelated = kind === 'classes';
    const levels = loadImage(def.file!).then(img => (pixelated ? [img] : mipmaps(img)));
    await levels;
    return new MercatorImageLayer(levels, pixelated, { opacity: o.opacity, zIndex: o.zIndex, attribution: def.attribution, maxZoom: 22, className: pixelated ? 'pixelated-tiles' : '' } as L.GridLayerOptions);
  }

  const pane = paneFor(map, def.id, o, kind === 'plates');
  const p = palette(o.dark);
  const renderer = L.canvas({ pane });
  const group = L.layerGroup([], { pane, attribution: def.attribution } as L.LayerOptions);
  const lines = (data: unknown, color: string, weight: number, dash?: string) =>
    geo(data as FeatureCollection, { pane, renderer, interactive: false, style: { color, weight, dashArray: dash, opacity: 0.9 } }).addTo(group);

  if (kind === 'plates') {
    platesLayer(pane, await loadJson<FeatureCollection<LineString, PlateProps>>(def.file!)).addTo(group);
    return group;
  }
  if (kind === 'graticule') {
    graticuleLayer(map, pane, o.dark).addTo(group);
    return group;
  }

  const needs = {
    land: kind === 'ne-detailed',
    borders: kind === 'ne-detailed' || kind === 'ne-borders',
    water: kind === 'ne-detailed' || kind === 'ne-water',
    places: kind === 'ne-detailed' || kind === 'ne-places',
  };
  const [countries, admin1, rivers, lakes, places] = await Promise.all([
    needs.land || needs.borders ? Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client')]) : null,
    needs.borders ? loadJson('admin1.json') : null,
    needs.water ? loadJson('rivers.json') : null,
    needs.water ? loadJson('lakes.json') : null,
    needs.places ? loadJson<Places>('places.json') : null,
  ]);
  if (needs.land) {
    L.rectangle(
      [
        [-90, -540],
        [90, 540],
      ],
      { pane, renderer, stroke: false, fillColor: p.sea, fillOpacity: 1, interactive: false },
    ).addTo(group);
  }
  if (countries) {
    const [topo, { feature, mesh }] = countries;
    const t = topo.default;
    if (needs.land) geo(feature(t, t.objects.countries) as unknown as FeatureCollection, { pane, renderer, interactive: false, style: { stroke: false, fillColor: p.land, fillOpacity: 1 } }).addTo(group);
    if (needs.borders) {
      if (admin1) lines(admin1, p.admin1, 0.6, '3 3');
      const borders = mesh(t, t.objects.countries as never, (a, b) => a !== b) as MultiLineString;
      geo(borders, { pane, renderer, interactive: false, style: { color: p.border, weight: 1.1, opacity: 0.95 } }).addTo(group);
    }
  }
  if (lakes) geo(lakes as FeatureCollection, { pane, renderer, interactive: false, style: { color: p.water, weight: 0.6, fillColor: needs.land ? p.lake : p.water, fillOpacity: needs.land ? 1 : 0.35 } }).addTo(group);
  if (rivers) lines(rivers, p.water, 0.9);
  if (places) placesLayer(map, pane, o.dark, places).addTo(group);
  return group;
}
