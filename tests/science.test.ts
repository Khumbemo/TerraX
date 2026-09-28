import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { detectDayMonthOrder, medianIntervalDays, parseDateCell } from '../src/lib/dates';
import { bboxToLatLng, utmToLatLon } from '../src/lib/geo';
import { parseKpFeed, describeKp } from '../src/lib/kp';
import { buildClassification, detectMetric } from '../src/lib/metrics';
import { solarAngles, solarReport } from '../src/lib/solar';
import { histogram, normalCdf, quantileSorted, summarize, trendTest } from '../src/lib/stats';
import { parseDelimited } from '../src/lib/table';
import { analyzeMetric } from '../src/lib/analysis';
import { sanitizeRequest, RequestValidationError } from '../src/lib/gemini-shared';

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

// Forward UTM (Krüger series, as used in Forest Capture) for round-trip checks.
function toUTM(lat: number, lng: number) {
  const latR = (lat * Math.PI) / 180;
  const z = Math.floor((lng + 180) / 6) + 1;
  const cm = (((z - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const alpha = [n / 2 - (2 / 3) * n * n + (5 / 16) * n ** 3, (13 / 48) * n * n - (3 / 5) * n ** 3, (61 / 240) * n ** 3];
  const L = (lng * Math.PI) / 180 - cm;
  const t = Math.sinh(Math.atanh(Math.sin(latR)) - Math.sqrt(e2) * Math.atanh(Math.sqrt(e2) * Math.sin(latR)));
  const xi = Math.atan(t / Math.cos(L));
  const eta = Math.atanh(Math.sin(L) / Math.sqrt(1 + t * t));
  let E = eta, N = xi;
  for (let j = 0; j < 3; j++) {
    E += alpha[j] * Math.cos(2 * (j + 1) * xi) * Math.sinh(2 * (j + 1) * eta);
    N += alpha[j] * Math.sin(2 * (j + 1) * xi) * Math.cosh(2 * (j + 1) * eta);
  }
  return { zone: z, easting: k0 * A * E + 500000, northing: k0 * A * N + (lat < 0 ? 10000000 : 0) };
}

test('quantiles follow the type-7 definition', () => {
  const s = [1, 2, 3, 4];
  assert.equal(quantileSorted(s, 0.5), 2.5);
  assert.equal(quantileSorted(s, 0.25), 1.75);
  const sum = summarize([2, 4, 4, 4, 5, 5, 7, 9])!;
  assert.equal(sum.mean, 5);
  close(sum.sd, 2.138, 0.001, 'sample SD');
});

test('normal CDF matches reference values', () => {
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(0), 0.5, 1e-9);
  close(normalCdf(-1), 0.158655, 1e-5);
});

test('Mann–Kendall on a strictly increasing series', () => {
  const x = Array.from({ length: 10 }, (_, i) => 2000 + i);
  const y = x.map(v => 2 * (v - 2000) + 1);
  const r = trendTest(x, y)!;
  assert.equal(r.s, 45);
  close(r.z, 44 / Math.sqrt(125), 1e-9, 'z');
  close(r.p, 8.3e-5, 1e-5, 'p');
  close(r.senSlope, 2, 1e-12);
  close(r.olsSlope, 2, 1e-12);
  assert.equal(r.direction, 'increasing');
});

test('Theil–Sen slope resists an outlier; flat noise shows no trend', () => {
  const x = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const y = x.map(v => v);
  y[9] = 100;
  close(trendTest(x, y)!.senSlope, 1, 1e-12);
  const flat = trendTest(x, [3, 1, 4, 1, 5, 9, 2, 6, 5, 3])!;
  assert.equal(flat.direction, 'no trend');
});

test('histogram handles a constant raster without NaN bins', () => {
  const h = histogram([5, 5, 5], 5, 5);
  assert.deepEqual(h, [{ x0: 5, x1: 5, count: 3 }]);
  const h2 = histogram([0, 0.5, 1], 0, 1, 2);
  assert.deepEqual(h2.map(b => b.count), [1, 2]);
});

test('date parsing rejects impossible dates and reads year-day', () => {
  assert.equal(parseDateCell('2014-02-43'), null);
  assert.equal(parseDateCell('2014-043')!.toISOString().slice(0, 10), '2014-02-12');
  assert.equal(parseDateCell('2016-02-29')!.toISOString().slice(0, 10), '2016-02-29');
  assert.equal(parseDateCell('2015-02-29'), null);
  assert.equal(parseDateCell('25-01-2014', 'DMY')!.toISOString().slice(0, 10), '2014-01-25');
  assert.deepEqual(detectDayMonthOrder(['01-02-2014', '25-02-2014']), { order: 'DMY', ambiguous: false });
  assert.deepEqual(detectDayMonthOrder(['02-25-2014']), { order: 'MDY', ambiguous: false });
  assert.equal(parseDateCell(2014, 'DMY', true)!.toISOString().slice(0, 10), '2014-01-01');
  const d = ['2020-01-01', '2020-01-09', '2020-01-17'].map(s => parseDateCell(s));
  assert.equal(medianIntervalDays(d), 8);
});

test('metric detection uses whole words', () => {
  assert.equal(detectMetric('NDVI'), 'ndvi');
  assert.equal(detectMetric('LST_C'), 'lst');
  assert.equal(detectMetric('temp_C'), 'airTemp');
  assert.equal(detectMetric('Solar_Radiation_MJ'), 'solar');
  assert.equal(detectMetric('Evapotranspiration'), 'et');
  assert.equal(detectMetric('precipitation'), 'precip');
  assert.equal(detectMetric('gradient'), 'generic');
  assert.equal(detectMetric('humidity'), 'humidity');
});

test('IMD rainfall categories use the published boundaries', () => {
  const c = buildClassification('precipitation', [0, 1, 20], { median: 2, min: 1 });
  const label = (v: number) => c.buckets[c.classify(v)].label;
  assert.match(label(0.05), /No rain/);
  assert.match(label(2.4), /Very light/);
  assert.match(label(2.5), /^Light/);
  assert.match(label(15.5), /^Light/);
  assert.match(label(15.6), /Moderate/);
  assert.match(label(64.5), /^Heavy/);
  assert.match(label(204.5), /Extremely heavy/);
  // Not daily → quartiles instead of IMD classes
  assert.ok(c.note && /gaps/.test(c.note));
  // 8-day totals → quartiles instead of IMD classes
  assert.match(buildClassification('precipitation', [1, 2, 3, 4], { median: 8, min: 8 }).basis, /Quartiles/);
});

test('ET totals over 8-day intervals are converted to mm/day', () => {
  const c = buildClassification('Evapotranspiration', [16, 24], { median: 8, min: 8 });
  close(c.convert(16), 2, 1e-12);
  assert.match(c.buckets[c.classify(16)].label, /Low \(1–3/);
  assert.ok(c.note);
});

test('temperature classes: freezing is below 0 °C, Kelvin is converted', () => {
  const c = buildClassification('temp_C', [12, 14], { median: 1, min: 1 });
  assert.match(c.buckets[c.classify(-0.5)].label, /Freezing/);
  assert.match(c.buckets[c.classify(5)].label, /Cold/);
  const k = buildClassification('LST', [290, 300], { median: 8, min: 8 });
  close(k.convert(273.15), 0, 1e-9);
  assert.match(k.buckets[k.classify(300)].label, /Warm/);
});

test('NDVI scaled by 10,000 is rescaled before classification', () => {
  const c = buildClassification('NDVI', [6500, 7000, 8000], { median: 16, min: 16 });
  assert.match(c.buckets[c.classify(7000)].label, /Dense/);
});

test('inverse UTM round-trips with forward UTM to < 1 mm', () => {
  for (const [lat, lon] of [
    [25.674, 94.108],
    [-33.86, 151.21],
    [60.1, 10.7],
    [0.5, 36.9],
  ]) {
    const u = toUTM(lat, lon);
    const [la, lo] = utmToLatLon(u.easting, u.northing, u.zone, lat < 0);
    close(la, lat, 1e-8, 'lat');
    close(lo, lon, 1e-8, 'lon');
  }
  const sw = toUTM(25.62, 94.05);
  const ne = toUTM(25.72, 94.16);
  const b = bboxToLatLng([sw.easting, sw.northing, ne.easting, ne.northing], 32646)!;
  close(b[0][0], 25.62, 0.002, 'south');
  close(b[1][0], 25.72, 0.002, 'north');
  close(b[0][1], 94.05, 0.002, 'west');
  close(b[1][1], 94.16, 0.002, 'east');
});

test('equation of time and declination match the NOAA calculator', () => {
  // Reference values from the NOAA Solar Calculator (±0.2 min, ±0.05°).
  close(solarAngles(new Date(Date.UTC(2026, 1, 11, 12))).equationOfTime, -14.2, 0.3, 'EoT Feb 11');
  close(solarAngles(new Date(Date.UTC(2026, 10, 3, 12))).equationOfTime, 16.45, 0.3, 'EoT Nov 3');
  close(solarAngles(new Date(Date.UTC(2026, 5, 21, 12))).declination, 23.44, 0.05, 'June solstice');
  close(solarAngles(new Date(Date.UTC(2026, 11, 21, 12))).declination, -23.44, 0.05, 'December solstice');
  const r = solarReport(new Date(Date.UTC(2026, 2, 20, 6, 0)), 25.674, 94.108);
  close(r.meanSolarTime, 6 + 94.108 / 15, 1e-9, 'mean solar time');
  assert.ok(r.azimuth >= 0 && r.azimuth < 360);
});

test('Kp feed parser accepts both SWPC formats', () => {
  const arrays = [['time_tag', 'Kp', 'a_running', 'station_count'], ['2026-09-28 09:00:00.000', '2.33', '9', '8'], ['2026-09-28 12:00:00.000', '5.00', '48', '8']];
  const a = parseKpFeed(arrays)!;
  assert.equal(a.kp, 5);
  assert.equal(a.time.toISOString(), '2026-09-28T12:00:00.000Z');
  const objects = [{ time_tag: '2026-09-28T09:00:00', Kp: 3.67 }];
  assert.equal(parseKpFeed(objects)!.kp, 3.67);
  assert.equal(describeKp(5), 'G1 minor storm');
  assert.equal(describeKp(2.33), 'Quiet');
});

test('bundled sample data parses cleanly', () => {
  const files = ['ndvi_data.csv', 'lst_data.csv', 'precipitation_data.csv', 'temp_humidity_data.csv', 'evapotranspiration_data.csv', 'solar_radiation_data.csv'];
  for (const f of files) {
    const text = readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8');
    const ds = parseDelimited(text, f, text.length);
    assert.equal(ds.timeColumn, 'date', f);
    assert.ok(ds.defaultMetric, f);
    assert.ok(!ds.warnings.some(w => /not valid calendar dates/.test(w)), `${f}: ${ds.warnings.join(' | ')}`);
    assert.equal(ds.times!.filter(t => t === null).length, 0, f);
  }
  const ndvi = parseDelimited(readFileSync(new URL('../public/data/ndvi_data.csv', import.meta.url), 'utf8'), 'ndvi_data.csv', 1);
  assert.equal(ndvi.defaultMetric, 'NDVI');
  close(ndvi.intervalDays!, 16, 0.01, 'NDVI interval');
  const precip = parseDelimited(readFileSync(new URL('../public/data/precipitation_data.csv', import.meta.url), 'utf8'), 'precipitation_data.csv', 1);
  assert.match(analyzeMetric(precip, 'precipitation').classification.basis, /India Meteorological Department/);
  const et = parseDelimited(readFileSync(new URL('../public/data/evapotranspiration_data.csv', import.meta.url), 'utf8'), 'evapotranspiration_data.csv', 1);
  close(et.intervalDays!, 8, 0.01, 'ET interval');
  const a = analyzeMetric(ndvi, 'NDVI');
  assert.equal(a.summary!.n, 31);
  assert.ok(a.monthly && a.monthly.length >= 10);
});

test('AI request validation rejects malformed bodies', () => {
  assert.throws(() => sanitizeRequest({}), RequestValidationError);
  assert.throws(() => sanitizeRequest({ turns: [{ role: 'model', text: 'hi' }] }), RequestValidationError);
  assert.throws(() => sanitizeRequest({ turns: [{ role: 'user', text: 'x'.repeat(200_000) }] }), RequestValidationError);
  const ok = sanitizeRequest({ turns: [{ role: 'user', text: 'hi' }], model: 'evil; drop', temperature: 9 });
  assert.equal(ok.model, 'gemini-2.5-flash');
  assert.equal(ok.temperature, 0.4);
});
