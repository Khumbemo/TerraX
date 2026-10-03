// Climate statistics on monthly aggregates:
//  • Seasonal Kendall trend test and seasonal Theil–Sen slope (Hirsch,
//    Slack & Smith 1982, Water Resources Research 18:107).
//  • Monthly anomalies against the record's own monthly climatology.
//  • Standardized Precipitation Index (McKee, Doesken & Kleist 1993;
//    WMO-No. 1090, 2012): gamma fit per calendar month by Thom's (1958)
//    maximum-likelihood approximation, with zero-rain probability.
import { normalCdf } from './stats';

export interface MonthValue {
  year: number;
  month: number; // 0–11
  /** Mean of the observations in the month. */
  value: number;
  n: number;
  /** Share of the month covered by observations (1 for monthly data). */
  coverage: number;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Aggregates dated values to calendar months. `stepDays` is the typical spacing of the series. */
export function toMonthly(points: { time: Date; value: number }[], stepDays: number | null): MonthValue[] {
  const map = new Map<number, { s: number; n: number; days: Set<number> }>();
  for (const p of points) {
    const y = p.time.getUTCFullYear(), m = p.time.getUTCMonth();
    const key = y * 12 + m;
    const e = map.get(key) ?? { s: 0, n: 0, days: new Set<number>() };
    e.s += p.value;
    e.n++;
    e.days.add(p.time.getUTCDate());
    map.set(key, e);
  }
  const daily = stepDays !== null && stepDays <= 1.5;
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, e]) => {
      const year = Math.floor(key / 12), month = key % 12;
      return { year, month, value: e.s / e.n, n: e.n, coverage: daily ? e.days.size / daysIn(year, month) : 1 };
    });
}

export interface SeasonalKendall {
  s: number;
  varS: number;
  z: number;
  p: number;
  /** Seasonal Theil–Sen slope, units per year. */
  slope: number;
  seasons: number;
  n: number;
  direction: 'increasing' | 'decreasing' | 'no trend';
}

/** Seasonal Kendall on monthly values (seasons = calendar months); months with fewer than 2 years are skipped. */
export function seasonalKendall(monthly: MonthValue[], alpha = 0.05): SeasonalKendall | null {
  let S = 0, V = 0, n = 0, seasons = 0;
  const slopes: number[] = [];
  for (let m = 0; m < 12; m++) {
    const xs = monthly.filter(v => v.month === m).sort((a, b) => a.year - b.year);
    if (xs.length < 2) continue;
    seasons++;
    n += xs.length;
    for (let i = 0; i < xs.length; i++)
      for (let j = i + 1; j < xs.length; j++) {
        const d = xs[j].value - xs[i].value;
        S += Math.sign(d);
        slopes.push(d / (xs[j].year - xs[i].year));
      }
    const k = xs.length;
    let ties = 0;
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x.value, (counts.get(x.value) ?? 0) + 1);
    for (const t of counts.values()) if (t > 1) ties += t * (t - 1) * (2 * t + 5);
    V += (k * (k - 1) * (2 * k + 5) - ties) / 18;
  }
  if (!seasons || V <= 0 || n < 4) return null;
  const z = S > 0 ? (S - 1) / Math.sqrt(V) : S < 0 ? (S + 1) / Math.sqrt(V) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  slopes.sort((a, b) => a - b);
  const mid = slopes.length / 2;
  const slope = slopes.length % 2 ? slopes[Math.floor(mid)] : (slopes[mid - 1] + slopes[mid]) / 2;
  return { s: S, varS: V, z, p, slope, seasons, n, direction: p < alpha ? (S > 0 ? 'increasing' : 'decreasing') : 'no trend' };
}

export interface Anomaly extends MonthValue {
  anomaly: number;
  /** Standardised anomaly (value − mean) / SD of that calendar month; null when SD is undefined. */
  z: number | null;
}

export function monthlyAnomalies(monthly: MonthValue[]): { climatology: { month: number; mean: number; sd: number | null; years: number }[]; rows: Anomaly[] } {
  const climatology = Array.from({ length: 12 }, (_, m) => {
    const xs = monthly.filter(v => v.month === m).map(v => v.value);
    const mean = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, v) => a + (v - mean) ** 2, 0) / (xs.length - 1)) : null;
    return { month: m, mean, sd, years: xs.length };
  });
  const rows = monthly.map(v => {
    const c = climatology[v.month];
    const anomaly = v.value - c.mean;
    return { ...v, anomaly, z: c.sd ? anomaly / c.sd : null };
  });
  return { climatology, rows };
}

// ── Special functions ──────────────────────────────────────────────────────

/** ln Γ(x), Lanczos approximation (g = 7, n = 9). */
export function gammaLn(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaLn(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x) (series or continued fraction). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = gammaLn(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let i = 0; i < 500; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // Lentz's continued fraction for Q(a, x).
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Inverse standard normal CDF (Acklam's rational approximation, |rel. error| < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── SPI ────────────────────────────────────────────────────────────────────

export const SPI_CLASSES = [
  { min: 2, label: 'Extremely wet' },
  { min: 1.5, label: 'Very wet' },
  { min: 1, label: 'Moderately wet' },
  { min: -1, label: 'Near normal' },
  { min: -1.5, label: 'Moderately dry' },
  { min: -2, label: 'Severely dry' },
  { min: -Infinity, label: 'Extremely dry' },
];

export const spiClass = (v: number) => SPI_CLASSES.find(c => v >= c.min)!.label;

export interface SpiResult {
  scale: number;
  rows: { year: number; month: number; total: number | null; spi: number | null }[];
  years: number;
  reliable: boolean;
  notes: string[];
}

/**
 * SPI at a time scale of `scale` months from monthly precipitation (mean per
 * observation, as from toMonthly). Daily data are converted to monthly totals
 * (mean × days in month) when at least 80 % of the month is observed.
 */
export function computeSpi(monthly: MonthValue[], scale: number, dailyInput: boolean): SpiResult {
  if (!monthly.length) return { scale, rows: [], years: 0, reliable: false, notes: ['No monthly precipitation values.'] };
  const first = monthly[0].year * 12 + monthly[0].month;
  const last = monthly[monthly.length - 1].year * 12 + monthly[monthly.length - 1].month;
  const totals: (number | null)[] = new Array(last - first + 1).fill(null);
  for (const v of monthly) {
    if (v.coverage < 0.8 || v.value < 0) continue;
    totals[v.year * 12 + v.month - first] = dailyInput ? v.value * daysIn(v.year, v.month) : v.value;
  }
  // Running sums over `scale` months (missing if any month is missing).
  const acc: (number | null)[] = totals.map((_, i) => {
    if (i + 1 < scale) return null;
    let s = 0;
    for (let j = i - scale + 1; j <= i; j++) {
      if (totals[j] === null) return null;
      s += totals[j]!;
    }
    return s;
  });
  const out: SpiResult['rows'] = totals.map((t, i) => ({ year: Math.floor((first + i) / 12), month: (first + i) % 12, total: acc[i], spi: null }));
  let minYears = Infinity;
  for (let m = 0; m < 12; m++) {
    const idx = out.map((r, i) => (r.month === m && r.total !== null ? i : -1)).filter(i => i >= 0);
    minYears = Math.min(minYears, idx.length);
    const xs = idx.map(i => out[i].total!);
    const pos = xs.filter(x => x > 0);
    if (xs.length < 2 || pos.length < 2) continue;
    const q = (xs.length - pos.length) / xs.length; // probability of zero
    const mean = pos.reduce((a, b) => a + b, 0) / pos.length;
    const A = Math.log(mean) - pos.reduce((a, b) => a + Math.log(b), 0) / pos.length;
    if (!(A > 0)) continue; // all equal: no spread to fit
    const alpha = (1 + Math.sqrt(1 + (4 * A) / 3)) / (4 * A);
    const beta = mean / alpha;
    for (const i of idx) {
      const x = out[i].total!;
      const H = q + (1 - q) * (x > 0 ? gammaP(alpha, x / beta) : 0);
      // Keep extreme values finite (H of exactly 0 or 1 is an artefact of short records).
      out[i].spi = normInv(Math.min(1 - 1e-6, Math.max(1e-6, H)));
    }
  }
  const years = Number.isFinite(minYears) ? minYears : 0;
  const notes = [
    `SPI-${scale}: ${scale}-month precipitation totals fitted with a gamma distribution for each calendar month (Thom 1958 estimator; zero totals handled with their observed probability), then transformed to standard normal values (McKee et al. 1993).`,
    dailyInput
      ? 'Daily data were summed to monthly totals (mean of observed days × days in the month); months with under 80 % of days observed are treated as missing.'
      : 'Each value was taken as a monthly total.',
    'Classes: ≥ 2 extremely wet, 1.5 to 2 very wet, 1 to 1.5 moderately wet, −1 to 1 near normal, −1.5 to −1 moderately dry, −2 to −1.5 severely dry, ≤ −2 extremely dry.',
  ];
  const reliable = years >= 30;
  if (!reliable) notes.push(`Only ${years} years are available for some calendar months; WMO guidance asks for at least 30 years, so these SPI values are indicative only.`);
  return { scale, rows: out, years, reliable, notes };
}
