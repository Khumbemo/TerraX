import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { utmToLatLon } from '../src/lib/geo';
import { openGeoTiff } from '../src/lib/rasterio';
import { DEFAULT_PARAMS, compareLayers, distanceTo, encroachmentMarkdown, prepareGeoStack, preparePhotoStack, rasterizeRings, type Stack } from '../src/lib/tools/encroachment';

function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** 60 × 60 m scene at 1 m: grass everywhere; property = columns 10–39, rows 10–49. */
function scene(after: boolean, bright = 1) {
  const w = 60, h = 60, r = lcg(after ? 2 : 1);
  const rgb = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] as [Float32Array, Float32Array, Float32Array];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    let c = [70, 120, 50]; // grass
    if (x >= 50 && y >= 10 && y < 20) c = [150, 150, 155]; // neighbour's existing house (unchanged)
    if (after) {
      if (x >= 35 && x < 46 && y >= 20 && y < 30) c = [190, 185, 180]; // neighbour extension, 5 m into the plot
      if (x >= 20 && x < 26 && y >= 30 && y < 36) c = [200, 170, 140]; // owner's patio
      if (x >= 50 && x < 56 && y >= 45 && y < 51) c = [120, 90, 60]; // cleared field outside
    }
    for (let b = 0; b < 3; b++) rgb[b][k] = (c[b] + (r() - 0.5) * 8) * bright;
  }
  return rgb;
}

const box = (c0: number, r0: number, c1: number, r1: number): [number, number][] => [[c0, r0], [c1, r0], [c1, r1], [c0, r1]];

test('encroachment: a neighbour extension crossing the boundary is found and measured', () => {
  const w = 60, h = 60;
  const stack: Stack = { width: w, height: h, cellM: 1, layers: [{ label: '2019', date: null, rgb: scene(false) }, { label: '2024', date: null, rgb: scene(true, 1.1) }], property: rasterizeRings([box(10, 10, 40, 50)], w, h), meta: null, notes: [] };
  assert.equal(stack.property.reduce((a, v) => a + v, 0), 30 * 40);
  const cmp = compareLayers(stack, 0, 1, DEFAULT_PARAMS);
  const crossing = cmp.patches.filter(p => p.zone === 'crossing');
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0].areaInside, 50); // columns 35–39 × rows 20–29
  assert.equal(crossing[0].areaJoinedInside, 0);
  assert.equal(crossing[0].area, 110);
  assert.ok(Math.abs(crossing[0].depthInside - 5) < 0.01, `depth ${crossing[0].depthInside}`);
  const inside = cmp.patches.filter(p => p.zone === 'inside');
  assert.equal(inside.length, 1);
  assert.equal(inside[0].area, 36);
  assert.equal(cmp.byZone.outside, 36);
  assert.equal(cmp.changedInside, 86);
  // A 10 % brighter current image did not register as change anywhere else.
  assert.equal(cmp.patches.length, 3);
  const md = encroachmentMarkdown(stack, cmp, [cmp], DEFAULT_PARAMS);
  assert.match(md, /Patches crossing the boundary \| 1 \(50 m² of them inside\)/);
  assert.match(md, /not proof of encroachment/);
  // No change between identical dates.
  const same = compareLayers({ ...stack, layers: [stack.layers[0], { ...stack.layers[0], label: 'copy' }] }, 0, 1, DEFAULT_PARAMS);
  assert.equal(same.patches.length, 0);
});

test('distance transform and photo stacks', () => {
  const src = new Uint8Array(25);
  src[12] = 1; // centre of 5 × 5
  const d = distanceTo(src, 5, 5);
  assert.equal(d[12], 0);
  assert.equal(d[13], 1);
  assert.ok(Math.abs(d[18] - 4 / 3) < 1e-6); // diagonal (chamfer 3-4)
  const rgba = (g: number) => {
    const a = new Uint8ClampedArray(40 * 20 * 4);
    for (let i = 0; i < 800; i++) a.set([60, g, 40, 255], i * 4);
    return a;
  };
  const s = preparePhotoStack([{ label: 'a', date: null, rgba: rgba(120), width: 40, height: 20 }, { label: 'b', date: null, rgba: rgba(120), width: 80, height: 40 }], [[5, 5], [30, 5], [30, 15], [5, 15]], 40);
  assert.equal(s.width, 80);
  assert.equal(s.cellM, 0.5);
  assert.throws(() => preparePhotoStack([{ label: 'a', date: null, rgba: rgba(1), width: 40, height: 20 }, { label: 'b', date: null, rgba: rgba(1), width: 40, height: 20 }], [[1, 1]], null), /Trace the property outline/);
});

test('georeferenced images on different grids are co-registered to the property', async () => {
  // Two UTM 46N RGB GeoTIFFs of the same 80 m area: 0.5 m and 1 m pixels, different origins.
  const E0 = 605000, N0 = 2840000;
  const make = async (res: number, e0: number, n0: number, after: boolean) => {
    const w = Math.round(80 / res), h = w;
    const data = new Uint8Array(w * h * 3);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const e = e0 + (c + 0.5) * res, n = n0 - (r + 0.5) * res;
      const ext = after && e >= E0 + 45 && e < E0 + 56 && n <= N0 - 20 && n > N0 - 30; // extension
      const col = ext ? [190, 185, 180] : [70, 120, 50];
      data.set(col, (r * w + c) * 3);
    }
    const buf = await writeArrayBuffer(data, { width: w, height: h, SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], SampleFormat: [1, 1, 1], PlanarConfiguration: 1, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, e0, n0, 0], GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32646 });
    return openGeoTiff(new File([buf], `${after ? 'now' : 'then'}.tif`));
  };
  const past = await make(1, E0 - 5, N0 + 5, false);
  const now = await make(0.5, E0, N0, true);
  // Property: 30 m × 40 m, east edge at E0 + 50 (the extension reaches 5 m in).
  const ring = [[E0 + 20, N0 - 10], [E0 + 50, N0 - 10], [E0 + 50, N0 - 50], [E0 + 20, N0 - 50], [E0 + 20, N0 - 10]].map(([e, n]) => {
    const [lat, lon] = utmToLatLon(e, n, 46, false);
    return [lon, lat];
  });
  const boundary = { name: 'Plot', areaM2: 1200, geojson: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } }] } };
  const stack = await prepareGeoStack([{ raster: past, label: 'then', date: null }, { raster: now, label: 'now', date: null }], boundary, 10);
  assert.equal(stack.cellM, 0.5);
  const area = stack.property.reduce((a, v) => a + v, 0) * 0.25;
  assert.ok(Math.abs(area - 1200) < 12, `property ${area} m²`);
  const cmp = compareLayers(stack, 0, 1, DEFAULT_PARAMS);
  const crossing = cmp.patches.filter(p => p.zone === 'crossing');
  assert.equal(crossing.length, 1);
  assert.ok(Math.abs(crossing[0].areaInside - 50) < 3, `inside ${crossing[0].areaInside}`);
  assert.ok(Math.abs(crossing[0].depthInside - 5) < 0.6, `depth ${crossing[0].depthInside}`);
});

test('synthetic residential sample: shed grows across the east boundary; fence shift is set aside', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = new URL('../public/data/samples/', import.meta.url);
  const boundary = { name: 'p', areaM2: 0, geojson: JSON.parse(readFileSync(new URL('plot_boundary_synthetic.geojson', dir), 'utf8')) };
  const imgs = await Promise.all(
    ['2019-02-10', '2021-02-14', '2024-02-08'].map(async d => ({ raster: await openGeoTiff(new File([readFileSync(new URL(`plot_${d}_synthetic.tif`, dir))], `plot_${d}.tif`)), label: d, date: new Date(d) })),
  );
  const stack = await prepareGeoStack(imgs, boundary, 15);
  const full = compareLayers(stack, 0, 2, DEFAULT_PARAMS);
  const c = full.patches.filter(p => p.zone === 'crossing');
  assert.equal(c.length, 1);
  assert.ok(c[0].areaInside > 45 && c[0].areaInside < 60, `2019→2024 inside ${c[0].areaInside}`); // true ≈ 50 m²
  assert.ok(c[0].depthInside >= 4 && c[0].depthInside <= 5.5, `depth ${c[0].depthInside}`); // true ≈ 5 m
  assert.ok(full.byZone.alignment > 0, 'the 0.5 m image shift shows as a thin strip, not encroachment');
  assert.ok(full.patches.some(p => p.zone === 'inside' && p.area > 50 && p.area < 65), 'carport (56 m²) inside');
  const early = compareLayers(stack, 0, 1, DEFAULT_PARAMS).patches.filter(p => p.zone === 'crossing');
  assert.equal(early.length, 1);
  assert.ok(early[0].depthInside >= 2 && early[0].depthInside <= 3, `2021 depth ${early[0].depthInside}`); // true 2.5 m
});
