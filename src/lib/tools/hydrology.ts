// Terrain hydrology and contours from a DEM grid.
//  • Depression filling: Priority-Flood with an epsilon gradient so flats
//    drain (Barnes, Lehman & Mulla 2014, Computers & Geosciences 62:117).
//  • Flow direction: D8 steepest descent (O'Callaghan & Mark 1984), with
//    ground distances from the raster geometry.
//  • Flow accumulation: upslope contributing area (m²), and Strahler (1957)
//    stream order on cells above an area threshold.
//  • Contours: marching squares on cell centres, chained into lines.
import type { Feature, FeatureCollection, LineString } from 'geojson';
import { unprojector } from '../patches';
import type { GeoMeta, Grid } from '../rasterio';

const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];

/** Minimal binary min-heap of cell indices keyed by a priority array. */
class MinHeap {
  private idx: number[] = [];
  constructor(private key: Float64Array) {}
  get size() {
    return this.idx.length;
  }
  push(i: number) {
    const a = this.idx, k = this.key;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (k[a[p]] <= k[a[c]]) break;
      [a[p], a[c]] = [a[c], a[p]];
      c = p;
    }
  }
  pop(): number {
    const a = this.idx, k = this.key;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < a.length && k[a[l]] < k[a[m]]) m = l;
        if (r < a.length && k[a[r]] < k[a[m]]) m = r;
        if (m === p) break;
        [a[p], a[m]] = [a[m], a[p]];
        p = m;
      }
    }
    return top;
  }
}

/**
 * Priority-Flood+ε: raises every pit to its spill level plus a tiny
 * gradient so all valid cells drain to the grid edge or a no-data cell.
 */
export function fillDepressions(z: ArrayLike<number>, w: number, h: number): { filled: Float64Array; raisedCells: number; maxRaise: number } {
  const n = w * h;
  const filled = new Float64Array(n);
  for (let i = 0; i < n; i++) filled[i] = z[i];
  const done = new Uint8Array(n);
  const heap = new MinHeap(filled);
  const isNaN_ = (k: number) => Number.isNaN(filled[k]);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      if (isNaN_(k)) {
        done[k] = 1;
        continue;
      }
      let edge = r === 0 || c === 0 || r === h - 1 || c === w - 1;
      for (let d = 0; d < 8 && !edge; d++) if (isNaN_((r + DR[d]) * w + c + DC[d])) edge = true;
      if (edge) {
        done[k] = 1;
        heap.push(k);
      }
    }
  let raised = 0, maxRaise = 0;
  while (heap.size) {
    const k = heap.pop();
    const r = Math.floor(k / w), c = k - r * w;
    for (let d = 0; d < 8; d++) {
      const rr = r + DR[d], cc = c + DC[d];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const m = rr * w + cc;
      if (done[m]) continue;
      done[m] = 1;
      // Smallest representable step above the neighbour, so flats drain.
      const floor = filled[k] + Math.max(1e-6, Math.abs(filled[k]) * 1e-12);
      if (filled[m] < floor) {
        const lift = floor - filled[m];
        if (lift > 1e-3) {
          raised++;
          maxRaise = Math.max(maxRaise, lift);
        }
        filled[m] = floor;
      }
      heap.push(m);
    }
  }
  return { filled, raisedCells: raised, maxRaise };
}

export interface FlowResult {
  width: number;
  height: number;
  /** D8 direction 0–7 (index into the neighbour table), −1 = flows off the grid or into no-data. */
  dir: Int8Array;
  /** Upslope contributing area including the cell itself, m². */
  acc: Float64Array;
  /** Strahler order on stream cells (acc ≥ threshold), 0 elsewhere. */
  order: Uint8Array;
  thresholdM2: number;
  maxOrder: number;
  /** Channel length per Strahler order (index = order), metres. */
  lengthByOrder: number[];
  raisedCells: number;
  maxRaise: number;
}

export interface Spacing {
  spacing: (row: number) => { dx: number; dy: number };
  cellArea: (row: number) => number;
}

function stepLength(d: number, sp: { dx: number; dy: number }): number {
  const dr = DR[d], dc = DC[d];
  return dr && dc ? Math.hypot(sp.dx, sp.dy) : dr ? sp.dy : sp.dx;
}

export function flowRouting(dem: Grid, geo: Spacing, thresholdM2: number): FlowResult {
  const { width: w, height: h, data: z } = dem;
  const { filled, raisedCells, maxRaise } = fillDepressions(z, w, h);
  const n = w * h;
  const dir = new Int8Array(n).fill(-1);
  const indeg = new Uint8Array(n);
  for (let r = 0; r < h; r++) {
    const sp = geo.spacing(r);
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      if (Number.isNaN(filled[k])) continue;
      let best = -1, bestSlope = 0;
      for (let d = 0; d < 8; d++) {
        const rr = r + DR[d], cc = c + DC[d];
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const m = rr * w + cc;
        if (Number.isNaN(filled[m])) continue;
        const s = (filled[k] - filled[m]) / stepLength(d, sp);
        if (s > bestSlope) {
          bestSlope = s;
          best = d;
        }
      }
      dir[k] = best;
      if (best >= 0) indeg[(r + DR[best]) * w + c + DC[best]]++;
    }
  }
  // Kahn traversal from ridges downstream.
  const acc = new Float64Array(n);
  const order = new Uint8Array(n);
  const maxIn = new Uint8Array(n); // highest stream order flowing in
  const maxInCount = new Uint8Array(n);
  const queue: number[] = [];
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(filled[k])) continue;
    acc[k] = geo.cellArea(Math.floor(k / w));
    if (!indeg[k]) queue.push(k);
  }
  const lengthByOrder: number[] = [0];
  let maxOrder = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    const r = Math.floor(k / w), c = k - r * w;
    if (acc[k] >= thresholdM2) {
      const o = maxIn[k] === 0 ? 1 : maxInCount[k] >= 2 ? maxIn[k] + 1 : maxIn[k];
      order[k] = Math.min(255, o);
      maxOrder = Math.max(maxOrder, order[k]);
    }
    const d = dir[k];
    if (d < 0) continue;
    const m = (r + DR[d]) * w + c + DC[d];
    acc[m] += acc[k];
    if (order[k]) {
      lengthByOrder[order[k]] = (lengthByOrder[order[k]] ?? 0) + stepLength(d, geo.spacing(r));
      if (order[k] > maxIn[m]) {
        maxIn[m] = order[k];
        maxInCount[m] = 1;
      } else if (order[k] === maxIn[m]) maxInCount[m]++;
    }
    if (--indeg[m] === 0) queue.push(m);
  }
  for (let o = 0; o <= maxOrder; o++) lengthByOrder[o] = lengthByOrder[o] ?? 0;
  // A junction on the last cell before the grid edge has no channel length
  // of its own; report the highest order that forms an actual channel.
  while (maxOrder > 0 && lengthByOrder[maxOrder] === 0) lengthByOrder.pop(), maxOrder--;
  return { width: w, height: h, dir, acc, order, thresholdM2, maxOrder, lengthByOrder, raisedCells, maxRaise };
}

/** Snaps a clicked cell to the highest-accumulation cell within `radius` cells. */
export function snapOutlet(f: FlowResult, col: number, row: number, radius = 3): number {
  let best = -1, bestAcc = -1;
  for (let r = Math.max(0, row - radius); r <= Math.min(f.height - 1, row + radius); r++)
    for (let c = Math.max(0, col - radius); c <= Math.min(f.width - 1, col + radius); c++) {
      const k = r * f.width + c;
      if (f.acc[k] > bestAcc) {
        bestAcc = f.acc[k];
        best = k;
      }
    }
  return best;
}

/** Cells draining to `outlet` (inclusive), as a 0/1 mask. */
export function watershed(f: FlowResult, outlet: number): { mask: Uint8Array; cells: number } {
  const { width: w, height: h, dir } = f;
  const mask = new Uint8Array(w * h);
  const stack = [outlet];
  mask[outlet] = 1;
  let cells = 1;
  while (stack.length) {
    const k = stack.pop()!;
    const r = Math.floor(k / w), c = k - r * w;
    for (let d = 0; d < 8; d++) {
      const rr = r + DR[d], cc = c + DC[d];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const m = rr * w + cc;
      if (mask[m]) continue;
      const dm = dir[m];
      // Neighbour m flows into k when its direction is the opposite offset.
      if (dm >= 0 && rr + DR[dm] === r && cc + DC[dm] === c) {
        mask[m] = 1;
        cells++;
        stack.push(m);
      }
    }
  }
  return { mask, cells };
}

type ToLonLat = (col: number, row: number) => [number, number];

function gridToLonLat(meta: GeoMeta, w: number, h: number): ToLonLat | null {
  const inv = unprojector(meta);
  if (!inv || !meta.bbox) return null;
  const [minX, minY, maxX, maxY] = meta.bbox;
  const cw = (maxX - minX) / w, ch = (maxY - minY) / h;
  return (col, row) => {
    const [lon, lat] = inv(minX + col * cw, maxY - row * ch);
    return [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };
}

/** Stream network as lines between sources, junctions and outlets. */
export function streamLines(f: FlowResult, meta: GeoMeta): FeatureCollection<LineString> | null {
  const ll = gridToLonLat(meta, f.width, f.height);
  if (!ll) return null;
  const { width: w, height: h, dir, order } = f;
  const streamIn = new Uint8Array(w * h);
  const down = (k: number) => {
    const d = dir[k];
    if (d < 0) return -1;
    const r = Math.floor(k / w) + DR[d], c = (k % w) + DC[d];
    return r < 0 || c < 0 || r >= h || c >= w ? -1 : r * w + c;
  };
  for (let k = 0; k < w * h; k++) if (order[k]) {
    const m = down(k);
    if (m >= 0 && order[m]) streamIn[m]++;
  }
  const centre = (k: number) => ll((k % w) + 0.5, Math.floor(k / w) + 0.5);
  const features: Feature<LineString>[] = [];
  for (let k = 0; k < w * h; k++) {
    if (!order[k] || streamIn[k] === 1) continue; // lines start at sources and junctions
    const coords = [centre(k)];
    let cur = k;
    for (;;) {
      const m = down(cur);
      if (m < 0 || !order[m]) break;
      coords.push(centre(m));
      if (streamIn[m] !== 1) break; // reached a junction
      cur = m;
    }
    if (coords.length >= 2) features.push({ type: 'Feature', properties: { strahler: order[k] }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features };
}

/** A "nice" contour interval giving about `target` levels over the relief. */
export function niceInterval(relief: number, target = 10): number {
  if (!(relief > 0)) return 1;
  const raw = relief / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Contour lines by marching squares on cell centres. Returns lines in grid
 * coordinates (col, row) per level.
 */
export function contourGrid(z: ArrayLike<number>, w: number, h: number, levels: number[]): { level: number; lines: [number, number][][] }[] {
  const out: { level: number; lines: [number, number][][] }[] = [];
  for (const lv of levels) {
    const segs: [[number, number], [number, number]][] = [];
    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const a = z[r * w + c], b = z[r * w + c + 1], cc = z[(r + 1) * w + c + 1], d = z[(r + 1) * w + c];
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(cc) || Number.isNaN(d)) continue;
        const idx = (a >= lv ? 8 : 0) | (b >= lv ? 4 : 0) | (cc >= lv ? 2 : 0) | (d >= lv ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const x0 = c + 0.5, y0 = r + 0.5;
        const lerp = (v1: number, v2: number) => (lv - v1) / (v2 - v1);
        const top: [number, number] = [x0 + lerp(a, b), y0];
        const right: [number, number] = [x0 + 1, y0 + lerp(b, cc)];
        const bottom: [number, number] = [x0 + lerp(d, cc), y0 + 1];
        const left: [number, number] = [x0, y0 + lerp(a, d)];
        const centreHigh = (a + b + cc + d) / 4 >= lv;
        switch (idx) {
          case 1: case 14: segs.push([left, bottom]); break;
          case 2: case 13: segs.push([bottom, right]); break;
          case 3: case 12: segs.push([left, right]); break;
          case 4: case 11: segs.push([top, right]); break;
          case 6: case 9: segs.push([top, bottom]); break;
          case 7: case 8: segs.push([left, top]); break;
          case 5: // a, c low; b, d high (saddle)
            if (centreHigh) segs.push([left, top], [bottom, right]);
            else segs.push([top, right], [left, bottom]);
            break;
          case 10: // a, c high; b, d low (saddle)
            if (centreHigh) segs.push([top, right], [left, bottom]);
            else segs.push([left, top], [bottom, right]);
            break;
        }
      }
    }
    out.push({ level: lv, lines: chain(segs) });
  }
  return out;
}

function chain(segs: [[number, number], [number, number]][]): [number, number][][] {
  const key = (p: [number, number]) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  const ends = new Map<string, number[]>();
  segs.forEach(([p, q], i) => {
    for (const e of [key(p), key(q)]) {
      const l = ends.get(e);
      if (l) l.push(i);
      else ends.set(e, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const lines: [number, number][][] = [];
  const extend = (line: [number, number][], atEnd: boolean) => {
    for (;;) {
      const tip = atEnd ? line[line.length - 1] : line[0];
      const next = (ends.get(key(tip)) ?? []).find(i => !used[i]);
      if (next === undefined) return;
      used[next] = 1;
      const [p, q] = segs[next];
      const other = key(p) === key(tip) ? q : p;
      if (atEnd) line.push(other);
      else line.unshift(other);
    }
  };
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: [number, number][] = [segs[i][0], segs[i][1]];
    extend(line, true);
    extend(line, false);
    lines.push(line);
  }
  return lines;
}

/** Contours as WGS84 GeoJSON lines with an `elevation` property. */
export function contoursGeoJson(dem: Grid, meta: GeoMeta, interval: number, maxLevels = 60): { fc: FeatureCollection<LineString>; levels: number } | null {
  const ll = gridToLonLat(meta, dem.width, dem.height);
  if (!ll) return null;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < dem.data.length; i++) {
    const v = dem.data[i];
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(interval > 0) || !Number.isFinite(min)) return { fc: { type: 'FeatureCollection', features: [] }, levels: 0 };
  const levels: number[] = [];
  for (let v = Math.ceil(min / interval) * interval; v <= max && levels.length < maxLevels; v += interval) levels.push(Math.round(v * 1e6) / 1e6);
  const features: Feature<LineString>[] = [];
  for (const { level, lines } of contourGrid(dem.data, dem.width, dem.height, levels)) {
    for (const line of lines) if (line.length >= 2) features.push({ type: 'Feature', properties: { elevation: level }, geometry: { type: 'LineString', coordinates: line.map(p => ll(p[0], p[1])) } });
  }
  return { fc: { type: 'FeatureCollection', features }, levels: levels.length };
}
