// Residential plot change and encroachment screening.
//
// 1. Images of different dates are put on one grid: for GeoTIFFs, a UTM grid
//    around the property boundary (plus a buffer); for plain photos, a
//    common pixel grid (the photos must show the same framing).
// 2. Relative radiometric normalisation: for each band, the later image is
//    regressed on the earlier one and the fit is repeated on pixels whose
//    residuals are small (pseudo-invariant features; Schott, Salvaggio &
//    Volchok 1988). This removes brightness, contrast and sensor
//    differences without letting the changed areas bias the fit.
// 3. Change magnitude = root-mean-square of the per-band residuals, each
//    divided by its robust SD (a normalised change vector, cf. Malila 1980).
//    Cells are "changed" when the magnitude exceeds median + k × 1.4826 ×
//    MAD (a robust outlier rule that assumes most of the scene is unchanged).
// 4. Changed cells are grouped into 8-connected patches; patches smaller
//    than a minimum area are dropped. Each patch is then placed relative to
//    the property: crossing the boundary line, along the inside edge,
//    elsewhere inside, or outside.
// 5. The change in excess greenness (ExG = 2g − r − b on chromatic
//    coordinates; Woebbecke et al. 1995) marks vegetation loss or gain.
//
// This is a screening aid: it finds where the ground changed, not who is
// legally entitled to it. Boundaries must come from a survey or the land
// record, and image misregistration of a few metres is common.
import { latLonToUtm, utmToLatLon } from '../geo';
import { labelPatches } from '../patches';
import type { GeoMeta, OpenRaster } from '../rasterio';
import { projector, boundaryRings, type Boundary } from '../zonal';
import { fmt } from '../stats';

export interface Layer {
  label: string;
  date: Date | null;
  /** Red, green, blue on the common grid (NaN = no data). */
  rgb: [Float32Array, Float32Array, Float32Array];
}

export interface Stack {
  width: number;
  height: number;
  /** Cell size in metres, or null when unknown (unscaled photos). */
  cellM: number | null;
  layers: Layer[];
  /** 1 inside the property. */
  property: Uint8Array;
  /** Present for georeferenced stacks: the grid as a UTM raster, for polygon export. */
  meta: GeoMeta | null;
  notes: string[];
}

// ── Grid preparation ───────────────────────────────────────────────────────

function nativeCellM(meta: GeoMeta, lat: number): number | null {
  if (!meta.pixelSize) return null;
  const [px, py] = meta.pixelSize;
  if (meta.geographic) return Math.min(px * 111_320 * Math.cos(lat * (Math.PI / 180)), py * 110_574);
  if (meta.epsg === 3857 || meta.epsg === 900913) return Math.min(px, py) * Math.cos(lat * (Math.PI / 180));
  return Math.min(px, py);
}

function rgbBands(bands: number): [number, number, number] {
  if (bands >= 4) return [2, 1, 0]; // B2, B3, B4, B8… (Sentinel-2 / Earth Engine order)
  if (bands === 3) return [0, 1, 2];
  return [0, 0, 0]; // single band: grey
}

/** Rasterises rings given in grid coordinates (col, row) by cell centres, even–odd rule. */
export function rasterizeRings(rings: [number, number][][], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const edges: [number, number, number, number][] = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    if (a[0] !== b[0] || a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
  }
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    const y = row + 0.5;
    xs.length = 0;
    for (const [x1, y1, x2, y2] of edges) if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) mask[row * width + c] = 1;
    }
  }
  return mask;
}

/**
 * Resamples georeferenced images onto a UTM grid covering the boundary plus
 * `bufferM`, at the finest native resolution (limited to `maxSide` cells).
 */
export async function prepareGeoStack(images: { raster: OpenRaster; label: string; date: Date | null }[], boundary: Boundary, bufferM = 20, maxSide = 1600): Promise<Stack> {
  if (images.length < 2) throw new Error('Add at least two images: an earlier one and a current one.');
  const rings = boundaryRings(boundary.geojson);
  if (!rings.length) throw new Error('The property boundary has no polygon.');
  const pts = rings.flat();
  const cLat = pts.reduce((a, p) => a + p[1], 0) / pts.length, cLon = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const zone = latLonToUtm(cLat, cLon).zone, south = cLat < 0;
  const toEN = (lon: number, lat: number): [number, number] => {
    const u = latLonToUtm(lat, lon, zone);
    return [u.easting, south && !u.south ? u.northing + 10_000_000 : !south && u.south ? u.northing - 10_000_000 : u.northing];
  };
  const en = pts.map(p => toEN(p[0], p[1]));
  let minE = Math.min(...en.map(p => p[0])) - bufferM, maxE = Math.max(...en.map(p => p[0])) + bufferM;
  let minN = Math.min(...en.map(p => p[1])) - bufferM, maxN = Math.max(...en.map(p => p[1])) + bufferM;
  const notes: string[] = [];
  const sizes = images.map(i => nativeCellM(i.raster.meta, cLat)).filter((v): v is number => v !== null && v > 0);
  if (sizes.length !== images.length) throw new Error('Every image must be georeferenced (WGS84, Web Mercator or UTM) to be placed on the property.');
  let cell = Math.max(0.1, Math.min(...sizes));
  const span = Math.max(maxE - minE, maxN - minN);
  if (span / cell > maxSide) {
    notes.push(`The finest image is ${fmt(cell, 3)} m per pixel; the analysis grid was coarsened to ${fmt(span / maxSide, 3)} m to stay under ${maxSide} pixels across.`);
    cell = span / maxSide;
  }
  const width = Math.ceil((maxE - minE) / cell), height = Math.ceil((maxN - minN) / cell);
  maxE = minE + width * cell;
  minN = maxN - height * cell;
  if (Math.max(...sizes) > cell * 1.5) notes.push(`Image resolutions differ (${sizes.map(s => `${fmt(s, 3)} m`).join(', ')}); coarser images were resampled (nearest neighbour) onto the ${fmt(cell, 3)} m grid, so their edges are blockier and more change can appear along edges.`);

  // Cell centre → lat/lon, computed once.
  const lats = new Float64Array(width * height), lons = new Float64Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const [lat, lon] = utmToLatLon(minE + (c + 0.5) * cell, maxN - (r + 0.5) * cell, zone, south);
    lats[r * width + c] = lat;
    lons[r * width + c] = lon;
  }

  const layers: Layer[] = [];
  for (const img of images) {
    const meta = img.raster.meta;
    const proj = projector(meta);
    if (!proj || !meta.bbox) throw new Error(`${meta.filename} is not in a supported CRS (WGS84, Web Mercator or UTM).`);
    const idx = rgbBands(meta.bands);
    const uniq = [...new Set(idx)];
    const grids = await img.raster.readBands(uniq);
    const byBand = new Map(uniq.map((b, i) => [b, grids[i]]));
    const g0 = grids[0];
    const [bx0, by0, bx1, by1] = meta.bbox;
    const cw = (bx1 - bx0) / g0.width, ch = (by1 - by0) / g0.height;
    const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
    let inside = 0;
    for (let k = 0; k < width * height; k++) {
      const [x, y] = proj(lons[k], lats[k]);
      const col = Math.floor((x - bx0) / cw), row = Math.floor((by1 - y) / ch);
      const ok = col >= 0 && row >= 0 && col < g0.width && row < g0.height;
      if (ok) inside++;
      for (let b = 0; b < 3; b++) out[b][k] = ok ? byBand.get(idx[b])!.data[row * g0.width + col] : NaN;
    }
    if (inside < width * height * 0.5) throw new Error(`${meta.filename} covers less than half of the property area. Check that it shows this property.`);
    if (inside < width * height) notes.push(`${meta.filename} does not cover the whole analysis area; uncovered cells are ignored.`);
    layers.push({ label: img.label, date: img.date, rgb: out });
  }

  const gridRings = rings.map(r => r.map(p => {
    const [e, n] = toEN(p[0], p[1]);
    return [(e - minE) / cell, (maxN - n) / cell] as [number, number];
  }));
  const property = rasterizeRings(gridRings, width, height);
  const epsg = (south ? 32700 : 32600) + zone;
  const meta: GeoMeta = {
    filename: 'property-grid',
    sizeBytes: 0,
    width,
    height,
    bands: 3,
    noData: null,
    bbox: [minE, minN, maxE, maxN],
    epsg,
    geographic: false,
    latLngBounds: null,
    pixelSize: [cell, cell],
    warnings: [],
  };
  notes.unshift(`Images were resampled onto a ${width} × ${height} grid of ${fmt(cell, 3)} m cells in UTM zone ${zone}${south ? 'S' : 'N'} covering the property plus ${bufferM} m around it.`);
  return { width, height, cellM: cell, layers, property, meta, notes };
}

/**
 * Puts plain photos (RGBA, possibly different sizes) on one pixel grid. They
 * must show the same framing. `property` is the outline traced by the user
 * in the grid's pixel coordinates; `groundWidthM` gives the image width on
 * the ground when known.
 */
export function preparePhotoStack(photos: { label: string; date: Date | null; rgba: Uint8ClampedArray; width: number; height: number }[], outline: [number, number][], groundWidthM: number | null, maxSide = 1200): Stack {
  if (photos.length < 2) throw new Error('Add at least two images: an earlier one and a current one.');
  const ref = photos[photos.length - 1];
  const s = Math.min(1, maxSide / Math.max(ref.width, ref.height));
  const width = Math.max(1, Math.round(ref.width * s)), height = Math.max(1, Math.round(ref.height * s));
  const notes: string[] = [];
  const aspects = photos.map(p => p.width / p.height);
  if (Math.max(...aspects) / Math.min(...aspects) > 1.02) notes.push('The photos have different shapes, so they were stretched to the same size; that suggests different framing, which causes false change.');
  const layers: Layer[] = photos.map(p => {
    const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(width * height), new Float32Array(width * height), new Float32Array(width * height)];
    for (let r = 0; r < height; r++) {
      const sr = Math.min(p.height - 1, Math.floor(((r + 0.5) / height) * p.height));
      for (let c = 0; c < width; c++) {
        const sc = Math.min(p.width - 1, Math.floor(((c + 0.5) / width) * p.width));
        const o = (sr * p.width + sc) * 4, k = r * width + c;
        const a = p.rgba[o + 3] > 127;
        out[0][k] = a ? p.rgba[o] : NaN;
        out[1][k] = a ? p.rgba[o + 1] : NaN;
        out[2][k] = a ? p.rgba[o + 2] : NaN;
      }
    }
    return { label: p.label, date: p.date, rgb: out };
  });
  if (outline.length < 3) throw new Error('Trace the property outline on the current image (at least three corners).');
  const property = rasterizeRings([outline], width, height);
  const cellM = groundWidthM && groundWidthM > 0 ? groundWidthM / width : null;
  notes.unshift(
    `Photos were compared pixel by pixel on a ${width} × ${height} grid; they are not georeferenced, so they must show exactly the same view.${cellM ? ` Scale from the entered ground width: ${fmt(cellM, 3)} m per pixel.` : ' Without a ground width, sizes are in pixels.'}`,
  );
  return { width, height, cellM, layers, property, meta: null, notes };
}

// ── Change analysis ────────────────────────────────────────────────────────

/** Two-pass chamfer (3-4) distance, in cells, from every cell to the nearest cell where `source` is 1. */
export function distanceTo(source: Uint8Array, width: number, height: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = source[i] ? 0 : INF;
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= width || r >= height ? INF : d[r * width + c]);
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const k = r * width + c;
      d[k] = Math.min(d[k], at(c - 1, r) + 3, at(c, r - 1) + 3, at(c - 1, r - 1) + 4, at(c + 1, r - 1) + 4);
    }
  for (let r = height - 1; r >= 0; r--)
    for (let c = width - 1; c >= 0; c--) {
      const k = r * width + c;
      d[k] = Math.min(d[k], at(c + 1, r) + 3, at(c, r + 1) + 3, at(c + 1, r + 1) + 4, at(c - 1, r + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

/**
 * Standardised residuals of `b` against `a` after an iteratively refitted
 * linear normalisation (b ≈ gain × a + offset on pseudo-invariant pixels).
 */
export function normalisedResiduals(a: Float32Array, b: Float32Array, valid: Uint8Array): Float32Array {
  let use = Uint8Array.from(valid);
  let gain = 1, offset = 0, sigma = 1;
  for (let iter = 0; iter < 4; iter++) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k < a.length; k++) if (use[k]) {
      n++;
      sx += a[k];
      sy += b[k];
      sxx += a[k] * a[k];
      sxy += a[k] * b[k];
    }
    if (n < 10) break;
    const vx = sxx - (sx * sx) / n;
    gain = vx > 1e-9 ? (sxy - (sx * sy) / n) / vx : 1;
    offset = (sy - gain * sx) / n;
    const res: number[] = [];
    for (let k = 0; k < a.length; k += a.length > 60_000 ? 3 : 1) if (valid[k]) res.push(b[k] - gain * a[k] - offset);
    const med = median(res);
    sigma = Math.max(1e-6, median(res.map(r => Math.abs(r - med))) * 1.4826);
    const next = new Uint8Array(a.length);
    for (let k = 0; k < a.length; k++) if (valid[k] && Math.abs(b[k] - gain * a[k] - offset - med) < 2.5 * sigma) next[k] = 1;
    use = next;
  }
  // A floor on sigma keeps near-noiseless (synthetic or compressed) images from flagging tiny differences.
  const range = (() => {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < b.length; k++) if (valid[k]) {
      lo = Math.min(lo, b[k]);
      hi = Math.max(hi, b[k]);
    }
    return hi - lo;
  })();
  const sd = Math.max(sigma, range * 0.01, 1e-6);
  return Float32Array.from(b, (v, k) => (valid[k] ? (v - gain * a[k] - offset) / sd : 0));
}

function exg(layer: Layer, k: number): number {
  const [r, g, b] = [layer.rgb[0][k], layer.rgb[1][k], layer.rgb[2][k]];
  const t = r + g + b;
  return t > 0 ? (2 * g - r - b) / t : 0;
}

export type Zone = 'crossing' | 'alignment' | 'edge' | 'inside' | 'outside';

export const ZONES: Record<Zone, { label: string; color: [number, number, number]; meaning: string }> = {
  crossing: { label: 'Crosses the boundary', color: [236, 72, 153], meaning: 'A changed patch that is continuous across the boundary line: the pattern expected when a neighbouring structure, fence or field is extended onto the property.' },
  alignment: { label: 'Thin strip along the line', color: [167, 139, 250], meaning: 'Change hugging the boundary line no deeper than the registration tolerance: usually the images being slightly misaligned (a fence or wall appearing to move), not encroachment.' },
  edge: { label: 'Along the inside edge', color: [239, 68, 68], meaning: 'Change inside the property within the edge strip, not connected across the line.' },
  inside: { label: 'Elsewhere inside', color: [250, 204, 21], meaning: 'Change in the interior of the property (often the owner’s own building or clearing).' },
  outside: { label: 'Outside (neighbours)', color: [96, 165, 250], meaning: 'Change on neighbouring land, shown for context.' },
};

export interface ChangePatch {
  id: number;
  zone: Zone;
  cells: number;
  /** m², or cells when the scale is unknown. */
  area: number;
  areaInside: number;
  /** For crossing patches: other changed area inside that is joined to it but does not touch the line (e.g. growth of an older encroachment). */
  areaJoinedInside: number;
  /** Greatest depth into the property, m (or cells), for crossing and edge patches. */
  depthInside: number;
  kind: 'vegetation loss' | 'vegetation gain' | 'surface change';
  centroid: [number, number]; // grid col, row
}

export interface Comparison {
  from: string;
  to: string;
  threshold: number;
  changedInside: number; // area units
  propertyArea: number;
  byZone: Record<Zone, number>;
  patches: ChangePatch[];
  /** Zone id (1 crossing, 2 edge, 3 inside, 4 outside, 5 alignment) per cell, 0 unchanged/no data. */
  classes: Uint8Array;
}

export interface EncroachmentParams {
  /** Robust threshold in MAD-sigmas (default 3). */
  sensitivity: number;
  /** Minimum patch area, m² (or cells when unscaled). */
  minArea: number;
  /** Width of the inside edge strip, m (or cells). */
  stripWidth: number;
  /** Changed areas closer than this are treated as one patch (bridges fences and walls that did not change), m (or cells). */
  gap: number;
  /** Crossing changes no deeper than this are attributed to image misalignment, m (or cells). */
  tolerance: number;
}

export const DEFAULT_PARAMS: EncroachmentParams = { sensitivity: 3, minArea: 4, stripWidth: 3, gap: 1.5, tolerance: 1 };

/** Square dilation of a 0/1 mask by `r` cells (separable max filter). */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) run = x;
      if (x - run <= r) tmp[y * w + x] = 1;
    }
    run = 1e9;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) run = x;
      if (run - x <= r) tmp[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) run = y;
      if (y - run <= r) out[y * w + x] = 1;
    }
    run = 1e9;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) run = y;
      if (run - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

function median(xs: Float32Array | number[]): number {
  const a = Float64Array.from(xs).sort();
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN;
}

/** Compares two layers of a stack (by index) and places the changes relative to the property. */
export function compareLayers(stack: Stack, fromIdx: number, toIdx: number, p: EncroachmentParams): Comparison {
  const { width: w, height: h, property } = stack;
  const n = w * h;
  const A = stack.layers[fromIdx], B = stack.layers[toIdx];
  const valid = new Uint8Array(n);
  for (let k = 0; k < n; k++) valid[k] = [...A.rgb, ...B.rgb].every(b => !Number.isNaN(b[k])) ? 1 : 0;
  const res = [0, 1, 2].map(b => normalisedResiduals(A.rgb[b], B.rgb[b], valid));
  const mag = new Float32Array(n);
  const sample: number[] = [];
  for (let k = 0; k < n; k++) {
    if (!valid[k]) continue;
    mag[k] = Math.sqrt((res[0][k] ** 2 + res[1][k] ** 2 + res[2][k] ** 2) / 3);
    if (k % 3 === 0 || n < 30_000) sample.push(mag[k]);
  }
  const med = median(sample);
  const mad = median(sample.map(v => Math.abs(v - med))) * 1.4826;
  // Magnitudes are already in robust-SD units; never flag below 2.5 SD even in very uniform scenes.
  const threshold = Math.max(2.5, med + p.sensitivity * Math.max(mad, 0.25));
  const changed = new Uint8Array(n);
  for (let k = 0; k < n; k++) changed[k] = valid[k] && mag[k] > threshold ? 1 : 0;

  const unit = stack.cellM ? stack.cellM * stack.cellM : 1; // area per cell
  const lenUnit = stack.cellM ?? 1;
  // Distance (in cells) from each inside cell to the outside, and from outside cells to the property.
  const outsideMask = Uint8Array.from(property, v => (v ? 0 : 1));
  const depth = distanceTo(outsideMask, w, h); // inside cells: distance to the boundary
  const stripCells = p.stripWidth / lenUnit;

  // Label on a slightly dilated mask so changes separated only by a thin unchanged fence or wall join up;
  // areas are still counted on the changed cells themselves.
  const bridged = dilate(changed, w, h, Math.round(p.gap / lenUnit / 2));
  const labels = labelPatches(w, h, k => bridged[k] === 1);
  const stats = new Map<number, { cells: number; inside: number; outside: number; maxDepth: number; minDepth: number; dExg: number; sc: number; sr: number; touchesLine: boolean }>();
  for (let k = 0; k < n; k++) {
    const id = changed[k] ? labels.labels[k] : 0;
    if (!id) continue;
    const e = stats.get(id) ?? { cells: 0, inside: 0, outside: 0, maxDepth: 0, minDepth: Infinity, dExg: 0, sc: 0, sr: 0, touchesLine: false };
    e.cells++;
    if (property[k]) {
      e.inside++;
      e.maxDepth = Math.max(e.maxDepth, depth[k]);
      e.minDepth = Math.min(e.minDepth, depth[k]);
      if (depth[k] <= 1.01) e.touchesLine = true;
    } else e.outside++;
    e.dExg += exg(B, k) - exg(A, k);
    e.sc += k % w;
    e.sr += Math.floor(k / w);
    stats.set(id, e);
  }
  // For crossing candidates, measure only the unbridged pieces that reach the boundary line, so a
  // separate change nearby (a tree edge, a shadow) does not inflate the depth or area inside.
  const raw = labelPatches(w, h, k => changed[k] === 1);
  const rawReach = new Map<number, { minDepth: number; maxDepth: number; inside: number }>();
  for (let k = 0; k < n; k++) {
    const id = raw.labels[k];
    if (!id || !property[k]) continue;
    const e = rawReach.get(id) ?? { minDepth: Infinity, maxDepth: 0, inside: 0 };
    e.minDepth = Math.min(e.minDepth, depth[k]);
    e.maxDepth = Math.max(e.maxDepth, depth[k]);
    e.inside++;
    rawReach.set(id, e);
  }
  const lineReach = p.gap / lenUnit + 1;
  const reachInside = new Map<number, { maxDepth: number; inside: number; rawIds: Set<number> }>();
  for (let k = 0; k < n; k++) {
    const b = labels.labels[k], r = raw.labels[k];
    if (!b || !r || !property[k]) continue;
    const rr = rawReach.get(r)!;
    if (rr.minDepth > lineReach) continue;
    const e = reachInside.get(b) ?? { maxDepth: 0, inside: 0, rawIds: new Set<number>() };
    if (!e.rawIds.has(r)) {
      e.rawIds.add(r);
      e.maxDepth = Math.max(e.maxDepth, rr.maxDepth);
      e.inside += rr.inside;
    }
    reachInside.set(b, e);
  }

  const classes = new Uint8Array(n);
  const patches: ChangePatch[] = [];
  const zoneCode: Record<Zone, number> = { crossing: 1, edge: 2, inside: 3, outside: 4, alignment: 5 };
  const zoneOf = new Map<number, Zone>();
  for (const [id, e] of stats) {
    if (e.cells * unit < p.minArea) continue;
    let zone: Zone;
    let reach: { maxDepth: number; inside: number } | undefined;
    // A bridged patch crosses when it has changed cells on both sides; its inside part must reach the line (within the gap).
    reach = reachInside.get(id);
    if (e.inside && e.outside && reach) {
      zone = reach.maxDepth * lenUnit <= p.tolerance + 1e-9 ? 'alignment' : 'crossing';
      e.maxDepth = reach.maxDepth;
    }
    else if (e.inside) zone = e.maxDepth <= stripCells + 1e-9 || e.touchesLine ? 'edge' : 'inside';
    else zone = 'outside';
    if (zone !== 'crossing' && zone !== 'alignment') reach = undefined;
    zoneOf.set(id, zone);
    const mean = e.dExg / e.cells;
    patches.push({
      id,
      zone,
      cells: e.cells,
      area: e.cells * unit,
      areaInside: (zone === 'crossing' || zone === 'alignment' ? reach!.inside : e.inside) * unit,
      areaJoinedInside: zone === 'crossing' || zone === 'alignment' ? (e.inside - reach!.inside) * unit : 0,
      depthInside: zone === 'outside' ? 0 : e.maxDepth * lenUnit,
      kind: mean < -0.04 ? 'vegetation loss' : mean > 0.04 ? 'vegetation gain' : 'surface change',
      centroid: [e.sc / e.cells, e.sr / e.cells],
    });
  }
  const byZone: Record<Zone, number> = { crossing: 0, alignment: 0, edge: 0, inside: 0, outside: 0 };
  let changedInside = 0, propertyCells = 0;
  for (let k = 0; k < n; k++) {
    if (property[k]) propertyCells++;
    const z = changed[k] ? zoneOf.get(labels.labels[k]) : undefined;
    if (!z) continue;
    classes[k] = zoneCode[z];
    byZone[z] += unit;
    if (property[k]) changedInside += unit;
  }
  const order: Zone[] = ['crossing', 'edge', 'alignment', 'inside', 'outside'];
  patches.sort((a, b) => order.indexOf(a.zone) - order.indexOf(b.zone) || b.areaInside - a.areaInside);
  return { from: A.label, to: B.label, threshold, changedInside, propertyArea: propertyCells * unit, byZone, patches, classes };
}

export function areaText(v: number, stack: Stack): string {
  if (!stack.cellM) return `${Math.round(v).toLocaleString()} px`;
  return v >= 10_000 ? `${fmt(v / 10_000, 4)} ha` : `${fmt(v, 4)} m²`;
}
const lenText = (v: number, stack: Stack) => (stack.cellM ? `${fmt(v, 3)} m` : `${fmt(v, 3)} px`);

export function encroachmentMarkdown(stack: Stack, cmp: Comparison, timeline: Comparison[], p: EncroachmentParams): string {
  const crossing = cmp.patches.filter(x => x.zone === 'crossing');
  const edge = cmp.patches.filter(x => x.zone === 'edge');
  const lines = [
    '## Dataset',
    '',
    ...stack.layers.map((l, i) => `- Image ${i + 1}: ${l.label}${l.date ? ` (${l.date.toISOString().slice(0, 10)})` : ''}`),
    `- Property area on the grid: ${areaText(cmp.propertyArea, stack)}`,
    '',
    '## Results',
    '',
    `Comparison: **${cmp.from} → ${cmp.to}**.`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Changed area inside the property | ${areaText(cmp.changedInside, stack)} (${cmp.propertyArea ? ((cmp.changedInside / cmp.propertyArea) * 100).toFixed(1) : '—'} %) |`,
    `| Patches crossing the boundary | ${crossing.length} (${areaText(crossing.reduce((a, x) => a + x.areaInside, 0), stack)} of them inside) |`,
    `| Change along the inside edge (${lenText(p.stripWidth, stack)} strip) | ${areaText(cmp.byZone.edge, stack)} in ${edge.length} patch${edge.length === 1 ? '' : 'es'} |`,
    `| Thin strips along the line (≤ ${lenText(p.tolerance, stack)}, likely misalignment) | ${areaText(cmp.byZone.alignment, stack)} |`,
    `| Change elsewhere inside | ${areaText(cmp.byZone.inside, stack)} |`,
    `| Change outside (context) | ${areaText(cmp.byZone.outside, stack)} |`,
    '',
  ];
  if (crossing.length) {
    lines.push(
      '### Possible encroachment (patches crossing the boundary)',
      '',
      '| Patch | Area inside (touching the line) | Joined change further inside | Total area | Depth into the property | Type |',
      '|---|---|---|---|---|---|',
      ...crossing.slice(0, 20).map((x, i) => `| ${i + 1} | ${areaText(x.areaInside, stack)} | ${areaText(x.areaJoinedInside, stack)} | ${areaText(x.area, stack)} | ${lenText(x.depthInside, stack)} | ${x.kind} |`),
      '',
      'Joined change further inside is change within the gap distance of the crossing patch that does not itself touch the line: for example, the newly built part of an older encroachment, or an unrelated change next to it. Inspect it on the images.',
      '',
    );
  } else lines.push('No changed patch crosses the boundary line at these settings.', '');
  if (timeline.length > 1) {
    lines.push('### Timeline (each image compared with the current one)', '', '| From | Changed inside | Crossing patches, inside part (touching the line + joined) |', '|---|---|---|');
    for (const t of timeline) {
      const cr = t.patches.filter(x => x.zone === 'crossing');
      lines.push(`| ${t.from} | ${areaText(t.changedInside, stack)} | ${areaText(cr.reduce((a, x) => a + x.areaInside, 0), stack)} + ${areaText(cr.reduce((a, x) => a + x.areaJoinedInside, 0), stack)} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Method and limits',
    '',
    ...stack.notes.map(n => `- ${n}`),
    `- Each band of the later image was normalised to the earlier one by a linear fit refitted on unchanged-looking pixels (pseudo-invariant features); change magnitude is the RMS of the robustly standardised residuals. Changed = magnitude above ${fmt(cmp.threshold, 3)} (median + ${p.sensitivity} × robust SD, at least 2.5); patches under ${areaText(p.minArea, stack)} were ignored.`,
    `- Changes closer than ${lenText(p.gap, stack)} were joined, so an unchanged fence or wall does not split a structure that spans it. Crossing changes that reach no deeper than ${lenText(p.tolerance, stack)} into the plot are reported separately as likely misalignment.`,
    '- "Crosses the boundary" means one changed patch is continuous across the line, as when a neighbouring roof, wall, fence or cultivated field extends onto the plot. It is a pattern in the imagery, not proof of encroachment.',
    '- Misregistration between images (often 1–5 m for free imagery), shadows, parked vehicles, crops, seasons and roof-top views of tall buildings all create change. Check each flagged patch on the images.',
    '- Use the boundary from a registered survey or the official land record; a hand-traced or GPS-walked outline carries its own error of several metres. For legal matters, get a licensed surveyor’s demarcation.',
  );
  return lines.join('\n');
}
