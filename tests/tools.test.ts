import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { analyzeMetric } from '../src/lib/analysis';
import { utmToLatLon } from '../src/lib/geo';
import { INDICES } from '../src/lib/indices';
import { buildClassification, detectMetric } from '../src/lib/metrics';
import { groundGeometry, openGeoTiff, sinAuthalic } from '../src/lib/rasterio';
import { parseDelimited } from '../src/lib/table';
import { rainfallSummary } from '../src/lib/tools/climate';
import { analyzeHansen, analyzeNdviChange } from '../src/lib/tools/forest';
import { measureSurvey, parseCoordinateCsv } from '../src/lib/tools/survey';
import { analyzeTerrain } from '../src/lib/tools/terrain';
import { drawnPolygon, editableVertices, makeBoundary, polygonFeatures, toGpx, toKml } from '../src/lib/vector';
import { boundaryMask, clipToBoundary, type Boundary } from '../src/lib/zonal';
import type { GeoMeta, Grid } from '../src/lib/rasterio';

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const rel = (a: number, b: number, tolRel: number, msg?: string) => close(a, b, Math.abs(b) * tolRel, msg);

const RAD = Math.PI / 180;
const A = 6378137;
const E2 = 0.00669437999014;
const E = Math.sqrt(E2);
const B = A * Math.sqrt(1 - E2);
/** Independent closed form: ellipsoid area from the equator to latitude φ, per radian of longitude. */
function zoneAreaPerRadian(latDeg: number): number {
  const s = Math.sin(latDeg * RAD);
  return B * B * (s / (2 * (1 - E2 * s * s)) + (1 / (4 * E)) * Math.log((1 + E * s) / (1 - E * s)));
}
function rectArea(lat1: number, lat2: number, dLonDeg: number): number {
  return Math.abs(zoneAreaPerRadian(lat2) - zoneAreaPerRadian(lat1)) * dLonDeg * RAD;
}

// Minimal GeoTIFF writer for tests (UTM 46N, 30 m pixels unless given).
async function tif(name: string, w: number, h: number, bands: Float32Array[], opts: { res?: number; epsg?: number; tie?: [number, number] } = {}) {
  const n = w * h;
  const data = new Float32Array(n * bands.length);
  for (let i = 0; i < n; i++) for (let b = 0; b < bands.length; b++) data[i * bands.length + b] = bands[b][i];
  const res = opts.res ?? 30;
  const geographic = opts.epsg === 4326;
  const buf = await writeArrayBuffer(data, {
    width: w,
    height: h,
    SamplesPerPixel: bands.length,
    BitsPerSample: bands.map(() => 32),
    SampleFormat: bands.map(() => 3),
    PlanarConfiguration: 1,
    ModelPixelScale: [res, res, 0],
    ModelTiepoint: [0, 0, 0, ...(opts.tie ?? [603000, 2846000]), 0],
    GTModelTypeGeoKey: geographic ? 2 : 1,
    GTRasterTypeGeoKey: 1,
    ...(geographic ? { GeographicTypeGeoKey: 4326 } : { ProjectedCSTypeGeoKey: opts.epsg ?? 32646 }),
    GDAL_NODATA: '-9999',
  });
  return openGeoTiff(new File([buf], name));
}

test('authalic latitude gives exact WGS84 cell areas', () => {
  const Rq = 6371007.1809;
  for (const [a, b] of [
    [0, 1],
    [25, 26],
    [60, 61],
  ]) {
    const ours = Rq * Rq * RAD * (sinAuthalic(b) - sinAuthalic(a));
    rel(ours, rectArea(a, b, 1), 1e-9, `${a}–${b}°`);
  }
  // 1°×1° at the equator ≈ 12,309 km² on WGS84.
  close(rectArea(0, 1, 1) / 1e6, 12309, 2);
});

test('geographic raster cell areas match the ellipsoid', async () => {
  const r = await tif('geo.tif', 10, 10, [new Float32Array(100).fill(1)], { epsg: 4326, res: 0.1, tie: [94, 26] });
  const [g] = await r.readBands([0]);
  const geo = groundGeometry(r.meta, g)!;
  let total = 0;
  for (let row = 0; row < 10; row++) total += geo.cellArea(row) * 10;
  rel(total, rectArea(25, 26, 1), 1e-6, '1°×1° raster');
});

test('survey area of a lat/lon rectangle matches the ellipsoid formula', () => {
  const lat = 25.67, lon = 94.1, d = 0.01;
  const fc = {
    type: 'FeatureCollection' as const,
    features: [{ type: 'Feature' as const, properties: { name: 'box' }, geometry: { type: 'Polygon' as const, coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] } }],
  };
  const r = measureSurvey('box.geojson', 'GeoJSON', fc, []);
  const f = r.features[0];
  rel(f.area!, rectArea(lat, lat + d, d), 5e-4, 'area');
  // Leg 1 runs due east; leg 2 due north (bearing ≈ 90° and 0°).
  close(f.legs[0].bearing, 90, 0.01);
  close(f.legs[1].bearing, 0, 0.01);
  // North–south leg length = meridian arc ≈ 1108 m for 0.01° at 25.7°.
  close(f.legs[1].distance, 1108.0, 1.0);
});

test('survey handles holes and CSV boundaries', () => {
  const lat = 25.67, lon = 94.1;
  const outer = [[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat]];
  const hole = [[lon + 0.004, lat + 0.004], [lon + 0.006, lat + 0.004], [lon + 0.006, lat + 0.006], [lon + 0.004, lat + 0.006], [lon + 0.004, lat + 0.004]];
  const r = measureSurvey('h.geojson', 'GeoJSON', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [outer, hole] } }] }, []);
  rel(r.features[0].area!, rectArea(lat, lat + 0.01, 0.01) - rectArea(lat + 0.004, lat + 0.006, 0.002), 1e-3);
  const csv = 'name,lat,lon,ele\nA,25.67,94.1,1400\nB,25.67,94.11,1410\nC,25.68,94.11,1420\n';
  const poly = parseCoordinateCsv(csv, 'pts.csv', true);
  assert.equal(poly.features[0].geometry.type, 'Polygon');
  const line = parseCoordinateCsv(csv, 'pts.csv', false);
  assert.equal(line.features[0].geometry.type, 'LineString');
  const m = measureSurvey('pts.csv', 'CSV', poly, []);
  assert.deepEqual(m.features[0].elevation, { min: 1400, max: 1420 });
  assert.throws(() => parseCoordinateCsv('x,y\n1,2', 'bad.csv', true) && measureSurvey('bad.csv', 'CSV', parseCoordinateCsv('easting,northing\n600000,2840000', 'bad.csv', true), []));
});

test('survey rejects projected coordinates in GeoJSON', () => {
  const fc = { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: [603000, 2846000] } }] };
  assert.throws(() => measureSurvey('utm.geojson', 'GeoJSON', fc, []), /WGS84/);
});

test('NDVI change: a known clearing gives the known loss area', async () => {
  const w = 50, h = 40;
  const before = new Float32Array(w * h).fill(0.8);
  const after = new Float32Array(w * h).fill(0.8);
  for (let y = 10; y < 20; y++) for (let x = 5; x < 15; x++) after[y * w + x] = 0.2; // 100 px cleared
  before[0] = -9999; // one no-data pixel
  for (let x = 40; x < 50; x++) {
    before[39 * w + x] = 0.2; // 10 px non-forest…
    after[39 * w + x] = 0.7; // …that regrow
  }
  const rb = await tif('b.tif', w, h, [before]);
  const ra = await tif('a.tif', w, h, [after]);
  const r = await analyzeNdviChange({ raster: rb, bands: {} }, { raster: ra, bands: {} }, 0.5, -0.2);
  assert.equal(r.loss.pixels, 100);
  close(r.loss.ha!, 100 * 900 / 10000, 1e-9, 'loss ha');
  assert.equal(r.forestBefore.pixels, w * h - 1 - 10);
  assert.equal(r.gain.pixels, 10);
  assert.equal(r.validPixels, w * h - 1);
  await assert.rejects(analyzeNdviChange({ raster: rb, bands: {} }, { raster: await tif('c.tif', 10, 10, [new Float32Array(100)]), bands: {} }, 0.5, -0.2), /different grids/);
});

test('Hansen lossyear: loss by year inside the canopy baseline', async () => {
  const w = 20, h = 10;
  const ly = new Float32Array(w * h);
  const tc = new Float32Array(w * h).fill(80);
  for (let i = 0; i < 30; i++) ly[i] = 5; // 2005
  for (let i = 30; i < 50; i++) ly[i] = 19; // 2019
  for (let i = 50; i < 60; i++) {
    ly[i] = 19;
    tc[i] = 10; // below 30 % canopy: excluded
  }
  const r = await analyzeHansen(await tif('ly.tif', w, h, [ly]), await tif('tc.tif', w, h, [tc]), 30);
  assert.deepEqual(r.byYear.map(y => [y.year, y.area.pixels]), [
    [2005, 30],
    [2019, 20],
  ]);
  assert.equal(r.baseline!.pixels, w * h - 10);
  close(r.totalLoss.ha!, 50 * 0.09, 1e-9);
  await assert.rejects(analyzeHansen(await tif('bad.tif', 4, 4, [new Float32Array(16).fill(0.5)]), null, 30), /lossyear/);
});

test('terrain: a tilted plane has the expected slope and aspect', async () => {
  const w = 30, h = 20, res = 30;
  const dem = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dem[y * w + x] = 1000 + 0.1 * x * res; // rises eastward
  const t = await analyzeTerrain(await tif('dem.tif', w, h, [dem], { res }));
  close(t.slope.mean, Math.atan(0.1) / RAD, 1e-4, 'slope');
  // Faces west (downhill toward the west): all non-flat cells in the W sector.
  assert.equal(t.aspectCounts[6], (w - 2) * (h - 2));
  close(t.relief, 0.1 * (w - 1) * res, 1e-3);
  const north = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) north[y * w + x] = 1000 + 0.2 * y * res; // rises southward → faces north
  const t2 = await analyzeTerrain(await tif('dem2.tif', w, h, [north], { res }));
  assert.equal(t2.aspectCounts[0], (w - 2) * (h - 2));
  close(t2.slope.mean, Math.atan(0.2) / RAD, 1e-4);
});

test('spectral indices follow their published formulas', () => {
  const b = { blue: 0.05, green: 0.08, red: 0.1, nir: 0.5, swir1: 0.25, swir2: 0.15 };
  const v = Object.fromEntries(INDICES.map(i => [i.id, i.compute(b)]));
  close(v.ndvi, 0.4 / 0.6, 1e-12);
  close(v.evi, (2.5 * 0.4) / (0.5 + 0.6 - 0.375 + 1), 1e-12);
  close(v.savi, (1.5 * 0.4) / 1.1, 1e-12);
  close(v.ndwi, (0.08 - 0.5) / 0.58, 1e-12);
  close(v.ndmi, 0.25 / 0.75, 1e-12);
  close(v.nbr, 0.35 / 0.65, 1e-12);
  close(v.ndbi, -0.25 / 0.75, 1e-12);
});

test('rainfall indices use the IMD 2.5 mm rainy-day threshold', () => {
  const rows = ['date,precipitation'];
  const vals = [0, 0, 3, 0, 0, 0, 0, 12, 2.4, 0];
  vals.forEach((v, i) => rows.push(`2020-06-${String(i + 1).padStart(2, '0')},${v}`));
  const ds = parseDelimited(rows.join('\n'), 'rain.csv', 1);
  const a = analyzeMetric(ds, 'precipitation');
  const r = rainfallSummary(a, ds.minIntervalDays)!;
  close(r.total, 3 + 12 + 2.4, 1e-9);
  assert.equal(r.rainyDays, 2);
  assert.equal(r.wettest.value, 12);
  assert.equal(r.longestDrySpell, 4);
  assert.equal(r.missingDays, 0);
});

test('soil moisture detection and unit handling', () => {
  assert.equal(detectMetric('soil_moisture'), 'soilMoisture');
  assert.equal(detectMetric('SM'), 'soilMoisture');
  const c = buildClassification('soil_moisture', [0.15, 0.25], { median: 1, min: 1 });
  assert.match(c.buckets[c.classify(0.35)].label, /Moist/);
  const pct = buildClassification('soil_moisture', [15, 25, 35], { median: 1, min: 1 });
  assert.match(pct.buckets[pct.classify(35)].label, /Moist/);
});

test('synthetic sample rasters load and analyse', async () => {
  const load = (f: string) => openGeoTiff(new File([readFileSync(new URL(`../public/data/samples/${f}`, import.meta.url))], f));
  const r = await analyzeNdviChange({ raster: await load('forest_ndvi_2016_synthetic.tif'), bands: {} }, { raster: await load('forest_ndvi_2024_synthetic.tif'), bands: {} }, 0.5, -0.2);
  assert.ok(r.loss.ha! > 10 && r.loss.ha! < r.forestBefore.ha!, `loss ${r.loss.ha}`);
  const t = await analyzeTerrain(await load('terrain_dem_synthetic.tif'));
  assert.ok(t.elevation.min > 1000 && t.elevation.max < 2400);
  const s = await load('satellite_4band_synthetic.tif');
  assert.equal(s.meta.bands, 4);
  const [lat] = utmToLatLon(603000, 2846000, 46, false);
  assert.ok(lat > 25.6 && lat < 25.8);
});

// ── Analysis boundary (zonal statistics) ───────────────────────────────────

function utmBoundary(name: string, e0: number, e1: number, n0: number, n1: number, zone = 46): Boundary {
  const ring = [[e0, n0], [e1, n0], [e1, n1], [e0, n1], [e0, n0]].map(([e, n]) => {
    const [lat, lon] = utmToLatLon(e, n, zone, false);
    return [lon, lat];
  });
  return { name, areaM2: (e1 - e0) * (n1 - n0), geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] } };
}

test('boundary mask: geographic grid, cell centres and holes', () => {
  const meta: GeoMeta = { filename: 'g.tif', sizeBytes: 0, width: 100, height: 100, bands: 1, noData: null, bbox: [94, 25, 95, 26], epsg: 4326, geographic: true, latLngBounds: [[25, 94], [26, 95]], pixelSize: [0.01, 0.01], warnings: [] };
  const grid: Grid = { width: 100, height: 100, data: new Float32Array(10_000).fill(1), resampleFactor: 1 };
  const sq = (x0: number, x1: number, y0: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const b: Boundary = { name: 'sq', areaM2: 1, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sq(94.2, 94.5, 25.3, 25.6)] } }] } };
  assert.equal(boundaryMask(meta, grid, b).inside, 900); // 30 × 30 cells
  const holed: Boundary = { ...b, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sq(94.2, 94.5, 25.3, 25.6), sq(94.3, 94.4, 25.4, 25.5)] } }] } };
  assert.equal(boundaryMask(meta, grid, holed).inside, 800);
  const note = clipToBoundary(meta, grid, holed);
  assert.match(note!, /800 grid cells/);
  assert.equal(Array.from(grid.data).filter(v => !Number.isNaN(v)).length, 800);
  const far: Boundary = { ...b, geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sq(10, 11, 10, 11)] } }] } };
  assert.throws(() => boundaryMask(meta, grid, far), /does not overlap/);
  assert.throws(() => boundaryMask({ ...meta, geographic: false, epsg: 27700 }, grid, b), /EPSG:27700/);
  assert.equal(clipToBoundary(meta, grid, null), null);
});

test('boundary clipping: NDVI loss counted only inside a UTM plot', async () => {
  const w = 50, h = 40;
  const before = new Float32Array(w * h).fill(0.8);
  const after = new Float32Array(w * h).fill(0.8);
  for (let y = 10; y < 20; y++) for (let x = 5; x < 15; x++) after[y * w + x] = 0.2; // 100 px cleared
  const rb = await tif('b.tif', w, h, [before]);
  const ra = await tif('a.tif', w, h, [after]);
  // Plot = exactly the cleared 10 × 10 block (tie point 603000 E, 2846000 N; 30 m pixels).
  const plot = utmBoundary('plot', 603150, 603450, 2845400, 2845700);
  const r = await analyzeNdviChange({ raster: rb, bands: {} }, { raster: ra, bands: {} }, 0.5, -0.2, plot);
  assert.equal(r.loss.pixels, 100);
  assert.equal(r.forestBefore.pixels, 100);
  assert.match(r.notes[0], /analysis boundary “plot”/);
  // Left half of the clearing plus uncleared forest to its west.
  const half = utmBoundary('half', 603000, 603300, 2845400, 2845700);
  const r2 = await analyzeNdviChange({ raster: rb, bands: {} }, { raster: ra, bands: {} }, 0.5, -0.2, half);
  assert.equal(r2.loss.pixels, 50);
  assert.equal(r2.forestBefore.pixels, 100);
});

test('boundary clipping: Hansen and terrain', async () => {
  const w = 20, h = 10;
  const ly = new Float32Array(w * h).fill(10);
  const r = await analyzeHansen(await tif('ly.tif', w, h, [ly]), null, 30, utmBoundary('p', 603000, 603150, 2845850, 2846000));
  assert.equal(r.totalLoss.pixels, 25); // 5 × 5 cells
  const dem = new Float32Array(30 * 20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) dem[y * 30 + x] = 1000 + 3 * x;
  const t = await analyzeTerrain(await tif('dem.tif', 30, 20, [dem]), utmBoundary('p', 603000 + 5 * 30, 603000 + 15 * 30, 2846000 - 15 * 30, 2846000 - 5 * 30));
  assert.equal(t.elevation.n, 100);
  close(t.slope.mean, Math.atan(0.1) / RAD, 1e-4);
  // Interior cells only have a full 3 × 3 neighbourhood: 8 × 8.
  assert.equal(t.slope.n, 64);
});

test('vector exports and drawn polygons', () => {
  const fc = drawnPolygon([[25.6, 94.1], [25.6, 94.2], [25.7, 94.2]], 'Plot <A>');
  const ring = (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.deepEqual(ring[0], [94.1, 25.6]);
  assert.deepEqual(editableVertices(fc), [[25.6, 94.1], [25.6, 94.2], [25.7, 94.2]]);
  assert.throws(() => drawnPolygon([[1, 2], [3, 4]], 'x'), /three points/);
  const kml = toKml(fc, 'Plot <A>');
  assert.match(kml, /<name>Plot &lt;A&gt;<\/name>/);
  assert.match(kml, /<outerBoundaryIs><LinearRing><coordinates>94.1,25.6 94.2,25.6 94.2,25.7 94.1,25.6<\/coordinates>/);
  const gpx = toGpx({ type: 'FeatureCollection', features: [...fc.features, { type: 'Feature', properties: { name: 'W1' }, geometry: { type: 'Point', coordinates: [94.15, 25.65, 1200] } }] }, 'x');
  assert.match(gpx, /<wpt lat="25.65" lon="94.15"><ele>1200<\/ele><name>W1<\/name><\/wpt>/);
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 4);
  const m = measureSurvey('d', 'Drawn on map', fc, []);
  const b = makeBoundary('d', fc, m.features[0].area!)!;
  assert.equal(b.geojson.features.length, 1);
  assert.equal(makeBoundary('pts', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }] }, 0), null);
  assert.equal(polygonFeatures({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'GeometryCollection', geometries: [fc.features[0].geometry] } }] }).features.length, 1);
});
