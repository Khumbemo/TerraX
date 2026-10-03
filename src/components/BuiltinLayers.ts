// Leaflet layers for TerraX's built-in world maps. Images are square Web
// Mercator pictures cut into tiles in the browser; vectors are drawn on canvas.
import L from 'leaflet';
import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson';
import type { MapDef } from '../lib/basemaps';
import { MERCATOR_MAX_LAT, PLATE_CLASSES, cellIds, obliquityDeg, platePair, worldMapUrl } from '../lib/world-maps';

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

/** Chunk size of the full-detail pictures (see scripts/make-world-maps.py). */
const CHUNK = 4096;
/** Pixels each chunk file overlaps its neighbours by on every side. */
const PAD = 4;
/** Decoded full-detail chunks kept in memory (each 4096² ≈ 64 MB of pixels). */
const MAX_CHUNKS = 6;
const chunks = new Map<string, Promise<ImageBitmap>>();

function loadChunk(file: string): Promise<ImageBitmap> {
  const hit = chunks.get(file);
  if (hit) {
    // Most recently used goes last.
    chunks.delete(file);
    chunks.set(file, hit);
    return hit;
  }
  const p = fetch(worldMapUrl(file)).then(async res => {
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    return createImageBitmap(await res.blob());
  });
  p.catch(() => chunks.delete(file));
  chunks.set(file, p);
  while (chunks.size > MAX_CHUNKS) {
    const [oldest, bmp] = chunks.entries().next().value!;
    chunks.delete(oldest);
    bmp.then(b => b.close(), () => undefined);
  }
  return p;
}

/**
 * Draws the square source region (sx, sy, size) onto a square canvas of `out` pixels. The
 * region is widened by `margin` source pixels and the canvas clips the excess, so smoothing
 * at a tile's edge blends with the real neighbouring pixels instead of leaving a seam.
 */
function drawRegion(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, sx: number, sy: number, size: number, out: number, margin: number) {
  const m = Math.max(0, Math.min(margin, sx, sy, img.width - sx - size, img.height - sy - size));
  const k = out / size;
  ctx.drawImage(img, sx - m, sy - m, size + 2 * m, size + 2 * m, -m * k, -m * k, out + 2 * m * k, out + 2 * m * k);
}

interface ImageSource {
  mips: (HTMLImageElement | HTMLCanvasElement)[];
  pixelated: boolean;
  /** Width of the full-detail picture, cut into CHUNK-sized files in `folder`. */
  full?: number;
  folder?: string;
}

type ImageLayer = L.GridLayer & { _src: ImageSource };

/**
 * A square Web Mercator world picture shown as map tiles, drawn at the screen's pixel
 * density. Low zooms come from the overview; closer in, each tile is first drawn from the
 * overview and then redrawn from the full-detail chunk once that has loaded.
 */
const MercatorImageLayer = L.GridLayer.extend({
  initialize(this: ImageLayer, src: ImageSource, options: L.GridLayerOptions) {
    (L.GridLayer.prototype as unknown as { initialize: (o: L.GridLayerOptions) => void }).initialize.call(this, options);
    this._src = src;
  },
  createTile(this: ImageLayer, coords: L.Coords, done: L.DoneCallback) {
    const { mips, pixelated, full, folder } = this._src;
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    tile.width = Math.round(size.x * dpr);
    tile.height = Math.round(size.y * dpr);
    const ctx = tile.getContext('2d')!;
    ctx.imageSmoothingEnabled = !pixelated;
    ctx.imageSmoothingQuality = 'high';
    const n = 2 ** coords.z;
    // Smallest overview level that still has a source pixel for every canvas pixel.
    let lvl = mips[0];
    if (!pixelated) for (const l of mips) if (l.width / n >= tile.width) lvl = l;
    const s = lvl.width / n;
    drawRegion(ctx, lvl, coords.x * s, coords.y * s, s, tile.width, pixelated ? 0 : 2);
    setTimeout(() => done(undefined, tile), 0);

    if (full && folder && (n * tile.width) > mips[0].width * 1.01) {
      const fs = full / n; // full-detail pixels per tile (never more than one chunk)
      const fx = coords.x * fs, fy = coords.y * fs;
      const cx = Math.floor(fx / CHUNK), cy = Math.floor(fy / CHUNK);
      loadChunk(`${folder}/${cx}-${cy}.jpg`)
        .then(bmp => {
          drawRegion(ctx, bmp, fx - cx * CHUNK + PAD, fy - cy * CHUNK + PAD, fs, tile.width, Math.min(2, PAD));
          tile.dataset.detail = 'full';
        })
        .catch(() => undefined); // keep the overview if a chunk is missing or was released meanwhile
    }
    return tile;
  },
}) as unknown as new (src: ImageSource, options: L.GridLayerOptions) => L.GridLayer;

// GeoJSON passes its options on to each path, so `renderer` works there even though Leaflet's types omit it.
const geo = (data: unknown, o: L.GeoJSONOptions & { renderer?: L.Renderer }) => L.geoJSON(data as never, o as L.GeoJSONOptions);

/** Zoom from which the 1:10m Natural Earth cells replace the 1:50m layers. */
const DETAIL_ZOOM = 5;
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
    const img = await loadImage(def.file!);
    const src: ImageSource = { mips: pixelated ? [img] : mipmaps(img), pixelated, full: def.fullSize, folder: def.fullSize ? def.file!.replace(/\.\w+$/, '') : undefined };
    return new MercatorImageLayer(src, { opacity: o.opacity, zIndex: o.zIndex, attribution: def.attribution, maxZoom: 22, className: pixelated ? 'pixelated-tiles' : '' } as L.GridLayerOptions);
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
  // Fills, water and lines each get a canvas in a nested pane, so their order holds across 1:10m cells.
  const sub = (name: string, z: number) => {
    const full = `${pane}-${name}`;
    const el = map.getPane(full) ?? map.createPane(full, map.getPane(pane));
    el.style.zIndex = String(z);
    el.style.pointerEvents = 'none';
    return { pane: full, renderer: L.canvas({ pane: full, padding: 0.3 }) };
  };
  const fill = sub('land', 10), water = sub('water', 20), line = sub('lines', 30);
  const style = {
    land: { stroke: false, fillColor: p.land, fillOpacity: 1 },
    lake: { color: p.water, weight: 0.6, fillColor: needs.land ? p.lake : p.water, fillOpacity: needs.land ? 1 : 0.35 },
    river: { color: p.water, weight: 0.9, opacity: 0.9 },
    admin1: { color: p.admin1, weight: 0.6, dashArray: '3 3', opacity: 0.9 },
    border: { color: p.border, weight: 1.1, opacity: 0.95 },
  };
  const draw = (data: unknown, target: { pane: string; renderer: L.Renderer }, st: L.PathOptions) => geo(data, { ...target, interactive: false, style: st });

  const [countries, admin1, rivers, lakes, places] = await Promise.all([
    needs.land || needs.borders ? Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client')]) : null,
    needs.borders ? loadJson('admin1.json') : null,
    needs.water ? loadJson('rivers.json') : null,
    needs.water ? loadJson('lakes.json') : null,
    needs.places ? loadJson<Places>('places.json') : null,
  ]);
  if (needs.land) L.rectangle([[-90, -540], [90, 540]], { ...fill, stroke: false, fillColor: p.sea, fillOpacity: 1, interactive: false }).addTo(group);

  // 1:50m for the world view …
  const coarse = L.layerGroup();
  const coarseLand = L.layerGroup(); // stays under the 1:10m cells while they load
  if (countries) {
    const [topo, { feature, mesh }] = countries;
    const t = topo.default;
    if (needs.land) draw(feature(t, t.objects.countries), fill, style.land).addTo(coarseLand);
    if (needs.borders) {
      if (admin1) draw(admin1, line, style.admin1).addTo(coarse);
      draw(mesh(t, t.objects.countries as never, (a, b) => a !== b), line, style.border).addTo(coarse);
    }
  }
  if (lakes) draw(lakes, water, style.lake).addTo(coarse);
  if (rivers) draw(rivers, water, style.river).addTo(coarse);

  // … and 1:10m from zoom DETAIL_ZOOM, loaded per 45° cell as the view moves.
  const fine = L.layerGroup();
  const cells = new Map<string, L.LayerGroup>();
  const addCell = (id: string) => {
    if (cells.has(id)) return;
    const g = L.layerGroup().addTo(fine);
    cells.set(id, g);
    loadJson<Record<'land' | 'borders' | 'admin1' | 'rivers' | 'lakes', FeatureCollection>>(`vector/${id}.json`)
      .then(c => {
        if (needs.land) draw(c.land, fill, style.land).addTo(g);
        if (needs.water) {
          draw(c.lakes, water, style.lake).addTo(g);
          draw(c.rivers, water, style.river).addTo(g);
        }
        if (needs.borders) {
          draw(c.admin1, line, style.admin1).addTo(g);
          draw(c.borders, line, style.border).addTo(g);
        }
      })
      .catch(() => cells.delete(id)); // the 1:50m layers are still underneath
  };
  const update = () => {
    const detail = map.getZoom() >= DETAIL_ZOOM;
    if (detail) {
      if (!group.hasLayer(fine)) group.addLayer(fine);
      if (group.hasLayer(coarse)) group.removeLayer(coarse);
      const b = map.getBounds().pad(0.25);
      for (const id of cellIds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())) addCell(id);
    } else {
      if (group.hasLayer(fine)) group.removeLayer(fine);
      if (!group.hasLayer(coarse)) group.addLayer(coarse);
    }
  };
  coarseLand.addTo(group);
  coarse.addTo(group);
  group.on('add', () => {
    update();
    map.on('moveend', update);
  });
  group.on('remove', () => map.off('moveend', update));
  if (places) placesLayer(map, pane, o.dark, places).addTo(group);
  return group;
}
