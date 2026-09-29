import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMmu, labelPatches, patchAreas, patchesToGeoJson, traceRings } from '../src/lib/patches';
import type { GeoMeta } from '../src/lib/rasterio';

const grid = (rows: string[]) => {
  const h = rows.length, w = rows[0].length;
  const cls = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => (cls[y * w + x] = ch === '#' ? 2 : 1)));
  return { w, h, cls };
};
const shoelace = (r: number[][]) => r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0) / 2;

test('8-connected labels and minimum mapping unit', () => {
  const { w, h, cls } = grid(['#...', '.#..', '...#', '..##']);
  const l = labelPatches(w, h, k => cls[k] === 2);
  assert.equal(l.count, 2); // diagonal pair joins; the L of three cells is the other
  const st = patchAreas(l, w, () => 1);
  assert.deepEqual([st.area[1], st.area[2]].sort(), [2, 3]);
  const m = applyMmu(cls, w, h, c => c === 2, 1, 3, () => 1);
  assert.equal(m.removedPatches, 1);
  assert.equal(m.removed.length, 2);
  assert.equal(m.kept.count, 1);
  assert.equal(cls.filter(v => v === 2).length, 3);
});

test('ring tracing: single cell, diagonal contact and a hole', () => {
  const one = traceRings(Int32Array.from([1]), 1, 1).get(1)!;
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  const diag = traceRings(Int32Array.from([1, 0, 0, 1]), 2, 2).get(1)!;
  assert.equal(diag.length, 2, 'diagonal cells become two rings');
  assert.ok(diag.every(r => shoelace(r) === 1));
  const donut = traceRings(Int32Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3).get(1)!;
  assert.deepEqual(donut.map(shoelace).sort((a, b) => a - b), [-1, 9]);
});

test('patch polygons in WGS84 follow RFC 7946 winding', () => {
  const meta: GeoMeta = { filename: 'g', sizeBytes: 0, width: 3, height: 3, bands: 1, noData: null, bbox: [90, 20, 90.3, 20.3], epsg: 4326, geographic: true, latLngBounds: null, pixelSize: [0.1, 0.1], warnings: [] };
  const l = labelPatches(3, 3, k => k !== 4);
  const st = patchAreas(l, 3, () => 1);
  const out = patchesToGeoJson(l, st, meta, { width: 3, height: 3 }, (id, a) => ({ id, cells: a }))!;
  assert.equal(out.fc.features.length, 1);
  const poly = out.fc.features[0].geometry.coordinates;
  assert.equal(poly.length, 1);
  assert.equal(poly[0].length, 2, 'outer ring and hole');
  const [outer, hole] = poly[0];
  assert.ok(shoelace(outer) > 0, 'outer counter-clockwise');
  assert.ok(shoelace(hole) < 0, 'hole clockwise');
  assert.deepEqual(outer[0], [90, 20.3]);
  close(Math.abs(shoelace(outer)), 0.09);
  close(Math.abs(shoelace(hole)), 0.01);
  assert.equal(out.fc.features[0].properties!.cells, 8);
  assert.equal(patchesToGeoJson(l, st, { ...meta, geographic: false, epsg: 2193 }, { width: 3, height: 3 }, () => ({})), null);
});

function close(a: number, b: number, tol = 1e-9) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
}
