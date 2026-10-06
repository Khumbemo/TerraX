import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeSpi, gammaLn, gammaP, monthlyAnomalies, normInv, seasonalKendall, spiClass, toMonthly, type MonthValue } from '../src/lib/climate-stats';

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) + 0.5) / 4294967296;
}

test('special functions match reference values', () => {
  close(normInv(0.975), 1.959964, 1e-6);
  close(normInv(0.5), 0, 1e-12);
  close(normInv(0.001), -3.090232, 1e-6);
  close(normInv(0.9999), 3.719016, 1e-5);
  close(gammaLn(10), Math.log(362880), 1e-10);
  close(gammaLn(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10);
  close(gammaP(1, 2), 1 - Math.exp(-2), 1e-12);
  close(gammaP(2, 1), 1 - 2 / Math.E, 1e-12);
  close(gammaP(0.5, 1), 0.8427007929, 1e-9); // erf(1)
  close(gammaP(5, 10), 0.9707473119, 1e-9);
  close(gammaP(3, 20), 1 - Math.exp(-20) * (1 + 20 + 200), 1e-12);
});

const monthlySeries = (years: number, f: (y: number, m: number) => number): MonthValue[] => {
  const out: MonthValue[] = [];
  for (let y = 0; y < years; y++) for (let m = 0; m < 12; m++) out.push({ year: 2000 + y, month: m, value: f(y, m), n: 1, coverage: 1 });
  return out;
};

test('Seasonal Kendall separates a trend from the seasonal cycle', () => {
  const r = lcg(1);
  const up = seasonalKendall(monthlySeries(10, (y, m) => 10 * Math.sin((m / 12) * 2 * Math.PI) + 0.5 * y + (r() - 0.5)))!;
  assert.equal(up.direction, 'increasing');
  assert.ok(up.p < 0.001);
  close(up.slope, 0.5, 0.1);
  assert.equal(up.seasons, 12);
  // 12 seasons × C(10, 2) = 540 pairs, all increasing when noise < trend step.
  const flat = seasonalKendall(monthlySeries(10, (_y, m) => 10 * Math.sin((m / 12) * 2 * Math.PI) + (r() - 0.5)))!;
  assert.equal(flat.direction, 'no trend', `p = ${flat.p}`);
  // Variance without ties: 12 × 10·9·25/18.
  close(flat.varS, 12 * (10 * 9 * 25) / 18, 1e-9);
});

test('monthly aggregation and anomalies', () => {
  const pts = [];
  for (let d = 1; d <= 31; d++) pts.push({ time: new Date(Date.UTC(2020, 0, d)), value: 2 });
  for (let d = 1; d <= 10; d++) pts.push({ time: new Date(Date.UTC(2020, 1, d)), value: 4 });
  const m = toMonthly(pts, 1);
  assert.deepEqual(m.map(x => [x.month, x.value, x.n]), [[0, 2, 31], [1, 4, 10]]);
  close(m[1].coverage, 10 / 29, 1e-12); // 2020 is a leap year
  const a = monthlyAnomalies(monthlySeries(3, (y) => y));
  assert.deepEqual(a.rows.filter(x => x.month === 0).map(x => x.anomaly), [-1, 0, 1]);
  assert.equal(a.rows[0].z, -1);
});

test('SPI of gamma-distributed rainfall is standard normal', () => {
  const r = lcg(7);
  const series = monthlySeries(60, () => -30 * (Math.log(r()) + Math.log(r()))); // gamma(2, 30)
  const spi = computeSpi(series, 1, false);
  const vals = spi.rows.map(x => x.spi!).filter(v => v !== null);
  assert.equal(vals.length, 720);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (vals.length - 1));
  close(mean, 0, 0.05);
  close(sd, 1, 0.05);
  assert.equal(spi.reliable, true);
  const spi3 = computeSpi(series.slice(0, 120), 3, false);
  assert.equal(spi3.rows[0].spi, null);
  assert.equal(spi3.rows[1].spi, null);
  assert.notEqual(spi3.rows[2].spi, null);
  assert.equal(spi3.reliable, false);
  assert.equal(spiClass(-2.3), 'Extremely dry');
  assert.equal(spiClass(0.2), 'Near normal');
  assert.equal(spiClass(1.7), 'Very wet');
  // Zero months: probability of zero enters H, so a dry month gets a negative SPI.
  const dry = computeSpi(monthlySeries(40, (y, m) => (m === 0 && y % 4 === 0 ? 0 : 50 + ((y * 7 + m * 3) % 11))), 1, false);
  const jan0 = dry.rows.find(x => x.month === 0 && x.year === 2000)!;
  assert.ok(jan0.spi! < -0.5, `${jan0.spi}`);
});
