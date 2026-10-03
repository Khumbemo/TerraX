// Connected patches in a class grid: labelling (8-connectivity), a minimum
// mapping unit filter, and tracing patches into GeoJSON polygons along
// pixel edges.
import type { Feature, FeatureCollection, MultiPolygon, Position } from 'geojson';
import { utmToLatLon } from './geo';
import type { GeoMeta, Grid } from './rasterio';

export interface Labels {
  labels: Int32Array; // 0 = not in the mask, 1..count = patch id
  count: number;
}

/** 8-connected component labelling of cells where `inMask(k)` is true. */
export function labelPatches(width: number, height: number, inMask: (k: number) => boolean): Labels {
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || !inMask(start)) continue;
    count++;
    labels[start] = count;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop()!;
      const r = Math.floor(k / width), c = k - r * width;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= height) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if ((dr === 0 && dc === 0) || cc < 0 || cc >= width) continue;
          const n = rr * width + cc;
          if (!labels[n] && inMask(n)) {
            labels[n] = count;
            stack.push(n);
          }
        }
      }
    }
  }
  return { labels, count };
}

export interface PatchStats {
  count: number;
  /** Area per patch id (index 0 unused), m² or pixels when no ground units. */
  area: Float64Array;
  largest: number;
}

export function patchAreas(l: Labels, width: number, cellArea: (row: number) => number): PatchStats {
  const area = new Float64Array(l.count + 1);
  for (let k = 0; k < l.labels.length; k++) if (l.labels[k]) area[l.labels[k]] += cellArea(Math.floor(k / width));
  let largest = 0;
  for (let i = 1; i <= l.count; i++) largest = Math.max(largest, area[i]);
  return { count: l.count, area, largest };
}

export interface MmuResult {
  /** Patches that were removed (below the MMU). */
  removedPatches: number;
  /** Cell indices that were reclassified. */
  removed: number[];
  kept: PatchStats;
}

/**
 * Removes patches of target classes smaller than `mmu` (same units as
 * cellArea) by setting them to `replaceWith`, in place.
 */
export function applyMmu(classes: Uint8Array, width: number, height: number, isTarget: (cls: number) => boolean, replaceWith: number, mmu: number, cellArea: (row: number) => number): MmuResult {
  const l = labelPatches(width, height, k => isTarget(classes[k]));
  const stats = patchAreas(l, width, cellArea);
  const small = new Uint8Array(l.count + 1);
  let removedPatches = 0;
  for (let i = 1; i <= l.count; i++) if (stats.area[i] < mmu) {
    small[i] = 1;
    removedPatches++;
  }
  const removed: number[] = [];
  for (let k = 0; k < classes.length; k++) if (l.labels[k] && small[l.labels[k]]) {
    classes[k] = replaceWith;
    removed.push(k);
    l.labels[k] = 0;
  }
  // Renumber kept patches so stats describe only them.
  const map = new Int32Array(l.count + 1);
  let n = 0;
  for (let i = 1; i <= l.count; i++) if (!small[i]) map[i] = ++n;
  for (let k = 0; k < l.labels.length; k++) if (l.labels[k]) l.labels[k] = map[l.labels[k]];
  return { removedPatches, removed, kept: patchAreas({ labels: l.labels, count: n }, width, cellArea) };
}

// ── Vectorising ────────────────────────────────────────────────────────────

/** Converts raster CRS coordinates to WGS84 lon/lat, or null when unsupported. */
export function unprojector(meta: GeoMeta): ((x: number, y: number) => [number, number]) | null {
  if (meta.geographic) return (x, y) => [x, y];
  if (meta.epsg === 3857 || meta.epsg === 900913) {
    const R = 6378137;
    return (x, y) => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
  }
  const e = meta.epsg;
  if (e !== null && ((e >= 32601 && e <= 32660) || (e >= 32701 && e <= 32760))) {
    const zone = e % 100, south = e >= 32701;
    return (x, y) => {
      const [lat, lon] = utmToLatLon(x, y, zone, south);
      return [lon, lat];
    };
  }
  return null;
}

function ringArea(ring: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Traces the outline of every patch into rings of grid-corner coordinates
 * (col, row). Outer rings run clockwise on screen (y down); holes run
 * counter-clockwise. Diagonal-only contacts are split into separate rings.
 */
export function traceRings(labels: Int32Array, width: number, height: number): Map<number, [number, number][][]> {
  const W1 = width + 1;
  const vid = (x: number, y: number) => y * W1 + x;
  // Directed boundary edges, keyed by start vertex; each cell is walked clockwise on screen.
  const out = new Map<number, number[]>(); // start vertex → list of end vertices
  const edgeLabel = new Map<string, number>();
  const add = (x0: number, y0: number, x1: number, y1: number, lab: number) => {
    const a = vid(x0, y0), b = vid(x1, y1);
    const list = out.get(a);
    if (list) list.push(b);
    else out.set(a, [b]);
    edgeLabel.set(`${a},${b}`, lab);
  };
  const at = (c: number, r: number) => (c < 0 || r < 0 || c >= width || r >= height ? 0 : labels[r * width + c]);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const lab = labels[r * width + c];
      if (!lab) continue;
      if (at(c, r - 1) !== lab) add(c, r, c + 1, r, lab);
      if (at(c + 1, r) !== lab) add(c + 1, r, c + 1, r + 1, lab);
      if (at(c, r + 1) !== lab) add(c + 1, r + 1, c, r + 1, lab);
      if (at(c - 1, r) !== lab) add(c, r + 1, c, r, lab);
    }
  }
  const rings = new Map<number, [number, number][][]>();
  const xy = (v: number): [number, number] => [v % W1, Math.floor(v / W1)];
  for (const [start, ends] of out) {
    while (ends.length) {
      const first = ends.pop()!;
      const lab = edgeLabel.get(`${start},${first}`)!;
      const ring: [number, number][] = [xy(start)];
      let prev = start, cur = first;
      while (cur !== start) {
        ring.push(xy(cur));
        const choices = out.get(cur)!;
        let pick = 0;
        if (choices.length > 1) {
          // Prefer the right turn (clockwise on screen), which keeps diagonal contacts apart.
          const [px, py] = xy(prev), [cx, cy] = xy(cur);
          const dx = cx - px, dy = cy - py;
          const rank = (v: number) => {
            const [nx, ny] = xy(v);
            const ex = nx - cx, ey = ny - cy;
            if (ex === -dy && ey === dx) return 0; // right
            if (ex === dx && ey === dy) return 1; // straight
            return 2; // left
          };
          pick = choices.reduce((best, v, i) => (rank(v) < rank(choices[best]) ? i : best), 0);
        }
        const next = choices.splice(pick, 1)[0];
        prev = cur;
        cur = next;
      }
      ring.push(ring[0]);
      // Drop collinear vertices.
      const simple: [number, number][] = [ring[0]];
      for (let i = 1; i < ring.length - 1; i++) {
        const [ax, ay] = simple[simple.length - 1], [bx, by] = ring[i], [cx, cy] = ring[i + 1];
        if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) simple.push(ring[i]);
      }
      simple.push(simple[0]);
      const list = rings.get(lab);
      if (list) list.push(simple);
      else rings.set(lab, [simple]);
    }
  }
  return rings;
}

/**
 * GeoJSON polygons (one MultiPolygon feature per patch, WGS84) for the
 * patches in `labels`. Rings are reversed so outer rings run
 * counter-clockwise in lon/lat, as RFC 7946 requires. Returns null when the CRS is not
 * supported. At most `maxPatches` of the largest patches are included.
 */
export function patchesToGeoJson(
  labels: Labels,
  stats: PatchStats,
  meta: GeoMeta,
  grid: Pick<Grid, 'width' | 'height'>,
  props: (id: number, area: number) => Record<string, unknown>,
  maxPatches = 5000,
): { fc: FeatureCollection<MultiPolygon>; truncated: number } | null {
  const inv = unprojector(meta);
  if (!inv || !meta.bbox) return null;
  const [minX, , , maxY] = meta.bbox;
  const cw = (meta.bbox[2] - minX) / grid.width;
  const ch = (maxY - meta.bbox[1]) / grid.height;
  const ids = Array.from({ length: labels.count }, (_, i) => i + 1).sort((a, b) => stats.area[b] - stats.area[a]);
  const keep = new Set(ids.slice(0, maxPatches));
  const lab = new Int32Array(labels.labels.length);
  for (let k = 0; k < lab.length; k++) if (keep.has(labels.labels[k])) lab[k] = labels.labels[k];
  const rings = traceRings(lab, grid.width, grid.height);
  const toLonLat = (p: [number, number]): Position => {
    const [lon, lat] = inv(minX + p[0] * cw, maxY - p[1] * ch);
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };
  const features: Feature<MultiPolygon>[] = [];
  for (const id of ids.slice(0, maxPatches)) {
    const rs = rings.get(id) ?? [];
    const outers = rs.filter(r => ringArea(r) > 0);
    const holes = rs.filter(r => ringArea(r) < 0);
    const polys = outers.map(o => [o]);
    for (const h of holes) {
      // Patch cells lie to the right of every traced edge: test a point just
      // right of the hole's first edge midpoint, which is inside the owner.
      const [x0, y0] = h[0], [x1, y1] = h[1];
      const mx = (x0 + x1) / 2 - (y1 - y0) * 0.25, my = (y0 + y1) / 2 + (x1 - x0) * 0.25;
      const owner = polys.find(p => pointInRing(mx, my, p[0]));
      (owner ?? polys[0])?.push(h);
    }
    features.push({ type: 'Feature', properties: props(id, stats.area[id]), geometry: { type: 'MultiPolygon', coordinates: polys.map(p => p.map(r => r.map(toLonLat).reverse())) } });
  }
  return { fc: { type: 'FeatureCollection', features }, truncated: Math.max(0, labels.count - maxPatches) };
}
