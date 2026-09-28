import type { HistogramBin, NumericSummary } from './types';

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Linear-interpolated quantile of an ascending-sorted array (type 7, as in R's default). */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function summarize(values: ArrayLike<number>): NumericSummary | null {
  const n = values.length;
  if (n === 0) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (values[i] - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  return {
    n,
    mean,
    sd,
    min,
    max,
    median: quantileSorted(sorted, 0.5),
    q1: quantileSorted(sorted, 0.25),
    q3: quantileSorted(sorted, 0.75),
  };
}

export function histogram(values: ArrayLike<number>, min: number, max: number, binCount = 30): HistogramBin[] {
  if (!values.length || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [{ x0: min, x1: max, count: values.length }];
  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({ x0: min + i * width, x1: min + (i + 1) * width, count: 0 }));
  for (let i = 0; i < values.length; i++) {
    const idx = Math.min(binCount - 1, Math.floor((values[i] - min) / width));
    bins[idx].count++;
  }
  return bins;
}

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface TrendResult {
  n: number;
  /** Ordinary least-squares slope, units per year. */
  olsSlope: number;
  /** Theil–Sen slope estimator, units per year. */
  senSlope: number;
  /** Mann–Kendall S statistic. */
  s: number;
  z: number;
  /** Two-sided p-value of the Mann–Kendall test. */
  p: number;
  direction: 'increasing' | 'decreasing' | 'no trend';
}

/**
 * Mann–Kendall trend test (with tie correction and continuity correction)
 * plus Theil–Sen and OLS slopes. x must be in years (decimal years) so the
 * slopes are per year. Assumes serially independent observations.
 */
export function trendTest(x: number[], y: number[], alpha = 0.05): TrendResult | null {
  const n = Math.min(x.length, y.length);
  if (n < 4) return null;

  // OLS
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  const olsSlope = sxx > 0 ? sxy / sxx : 0;

  // Mann–Kendall S and Sen slopes (order by x)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
  const xs = order.map(i => x[i]);
  const ys = order.map(i => y[i]);
  let s = 0;
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = ys[j] - ys[i];
      s += d > 0 ? 1 : d < 0 ? -1 : 0;
      if (xs[j] !== xs[i]) slopes.push(d / (xs[j] - xs[i]));
    }
  }
  slopes.sort((a, b) => a - b);
  const senSlope = slopes.length ? quantileSorted(slopes, 0.5) : 0;

  // Variance of S with tie correction
  const counts = new Map<number, number>();
  for (const v of ys) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of counts.values()) if (t > 1) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  const z = varS > 0 ? (s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  const direction = p < alpha ? (s > 0 ? 'increasing' : 'decreasing') : 'no trend';
  return { n, olsSlope, senSlope, s, z, p, direction };
}

/** Evenly spaced subsample of indices, for charting long series. */
export function sampleIndices(length: number, maxPoints: number): number[] {
  if (length <= maxPoints) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => Math.round(i * step));
}

/** Formats a number to a given number of significant figures for display. */
export function fmt(v: number | null | undefined, sig = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) return v.toExponential(2);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(Number(v.toPrecision(sig)));
}

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}
