import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { latLonToUtm, utmToLatLon } from '../src/lib/geo';
import { openMeteoToCsv, openMeteoUrl, parseStacItems, powerToCsv, powerUrl, readS2Window, reflectanceTransform, stacSearchBody } from '../src/lib/live';
import { parseDelimited } from '../src/lib/table';

test('Open-Meteo archive response becomes a dated table', () => {
  const url = new URL(openMeteoUrl(25.674, 94.108, '2024-01-01', '2024-01-03', ['precipitation_sum', 'temperature_2m_mean']));
  assert.equal(url.hostname, 'archive-api.open-meteo.com');
  assert.equal(url.searchParams.get('daily'), 'precipitation_sum,temperature_2m_mean');
  const json = {
    latitude: 25.68, longitude: 94.1, elevation: 1431,
    daily_units: { time: 'iso8601', precipitation_sum: 'mm', temperature_2m_mean: '°C' },
    daily: { time: ['2024-01-01', '2024-01-02', '2024-01-03'], precipitation_sum: [0, 2.4, null], temperature_2m_mean: [12.1, 11.8, 12.6] },
  };
  const { csv, note } = openMeteoToCsv(json);
  assert.equal(csv.split('\n')[0], 'date,precipitation_sum (mm),temperature_2m_mean (°C)');
  assert.equal(csv.split('\n')[3], '2024-01-03,,12.6');
  assert.match(note, /ERA5/);
  const ds = parseDelimited(csv, 'om.csv', csv.length);
  assert.equal(ds.timeColumn, 'date');
  assert.equal(ds.rows.length, 3);
  assert.throws(() => openMeteoToCsv({ error: true, reason: 'Cannot initialize WeatherVariable from invalid String value foo' }), /invalid String value foo/);
  assert.throws(() => openMeteoUrl(95, 0, '2024-01-01', '2024-01-02', ['x']), /Latitude/);
  assert.throws(() => openMeteoUrl(0, 0, '2024-02-01', '2024-01-02', ['x']), /start date/);
});

test('NASA POWER response: dates, units and the −999 fill value', () => {
  const url = new URL(powerUrl(25.674, 94.108, '2024-01-01', '2024-01-02', ['T2M', 'PRECTOTCORR']));
  assert.equal(url.searchParams.get('start'), '20240101');
  assert.equal(url.searchParams.get('community'), 'AG');
  const json = {
    geometry: { coordinates: [94.108, 25.674, 1400] },
    header: { fill_value: -999 },
    properties: { parameter: { T2M: { '20240101': 11.2, '20240102': -999 }, PRECTOTCORR: { '20240101': 0.3, '20240102': 5.1 } } },
    parameters: { T2M: { units: 'C', longname: 'Temperature at 2 Meters' }, PRECTOTCORR: { units: 'mm/day' } },
  };
  const { csv } = powerToCsv(json);
  assert.deepEqual(csv.split('\n'), ['date,T2M (C),PRECTOTCORR (mm/day)', '2024-01-01,11.2,0.3', '2024-01-02,,5.1']);
  assert.throws(() => powerToCsv({ errors: ['Invalid parameter'] }), /Invalid parameter/);
});

test('STAC items, reflectance scaling and search body', () => {
  const body = stacSearchBody([94, 25.6, 94.1, 25.7], '2024-01-01', '2024-03-31', 20);
  assert.deepEqual(body.query, { 'eo:cloud_cover': { lt: 20 } });
  assert.equal(body.datetime, '2024-01-01T00:00:00Z/2024-03-31T23:59:59Z');
  const items = parseStacItems({
    features: [
      { id: 'S2B_46RFQ_20240301_0_L2A', properties: { datetime: '2024-03-01T04:25:00Z', 'eo:cloud_cover': 3.2, 'proj:epsg': 32646, 's2:processing_baseline': '05.10' }, assets: { red: { href: 'https://x/B04.tif', 'raster:bands': [{ scale: 0.0001, offset: -0.1 }] }, nir: { href: 'https://x/B08.tif' } } },
      { id: 'old', properties: { datetime: '2021-03-01T04:25:00Z', 'proj:code': 'EPSG:32646', 's2:processing_baseline': '02.14' }, assets: { red: { href: 'https://x/r.tif' } } },
    ],
  });
  assert.equal(items[0].epsg, 32646);
  assert.equal(items[1].epsg, 32646);
  assert.equal(items[1].cloud, null);
  assert.deepEqual(reflectanceTransform(items[0], 'red'), { scale: 0.0001, offset: -0.1, note: reflectanceTransform(items[0], 'red').note });
  assert.equal(reflectanceTransform(items[0], 'nir').offset, -0.1); // baseline ≥ 04.00 without metadata
  assert.equal(reflectanceTransform(items[1], 'red').offset, 0);
  assert.throws(() => parseStacItems({ type: 'nope' }), /unexpected/);
});

test('Sentinel-2 window read from COG-like GeoTIFFs', async () => {
  // 10 m bands: 200 × 200 px from (600000, 2850000); SCL: 100 × 100 px at 20 m.
  const E0 = 600000, N0 = 2850000;
  const mk = async (w: number, res: number, f: (c: number, r: number) => number) => {
    const data = new Uint16Array(w * w);
    for (let r = 0; r < w; r++) for (let c = 0; c < w; c++) data[r * w + c] = f(c, r);
    const buf = await writeArrayBuffer(data, { width: w, height: w, ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, E0, N0, 0], GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32646, BitsPerSample: [16], SampleFormat: [1], SamplesPerPixel: 1 });
    return buf;
  };
  const files: Record<string, ArrayBuffer> = {
    blue: await mk(200, 10, () => 1500),
    green: await mk(200, 10, () => 1800),
    red: await mk(200, 10, c => 1000 + c), // DN varies with column
    nir: await mk(200, 10, () => 4000),
    scl: await mk(100, 20, (c) => (c < 50 ? 4 : 9)), // cloud on the east half
  };
  const item = parseStacItems({ features: [{ id: 'T', properties: { datetime: '2024-03-01T00:00:00Z', 'proj:epsg': 32646, 's2:processing_baseline': '05.10' }, assets: Object.fromEntries(Object.keys(files).map(k => [k, { href: k }])) }] })[0];
  // AOI: columns 50–150, rows 50–150 of the 10 m grid.
  const [latA, lonA] = utmToLatLon(E0 + 500, N0 - 1500, 46, false);
  const [latB, lonB] = utmToLatLon(E0 + 1500, N0 - 500, 46, false);
  const { raster, notes } = await readS2Window(item, [lonA, latA, lonB, latB], async href => fromArrayBuffer(files[href]));
  const { width, height } = raster.meta;
  assert.ok(width >= 100 && width <= 103 && height >= 100 && height <= 103, `${width}×${height}`);
  const [red, nir, scl] = await raster.readBands([2, 3, 4]);
  const col0 = Math.round((raster.meta.bbox![0] - E0) / 10);
  assert.ok(Math.abs(red.data[0] - ((1000 + col0) * 1e-4 - 0.1)) < 1e-6, `red ${red.data[0]}`);
  assert.ok(Math.abs(nir.data[0] - 0.3) < 1e-6);
  // SCL switches from 4 to 9 at easting E0 + 1000 m (10 m column 100).
  const switchCol = 100 - col0;
  assert.equal(scl.data[switchCol - 1], 4);
  assert.equal(scl.data[switchCol], 9);
  assert.ok(notes.some(n => /1000/.test(n)));
  const u = latLonToUtm(latA, lonA, 46);
  assert.ok(Math.abs(u.easting - (E0 + 500)) < 0.01);
});
