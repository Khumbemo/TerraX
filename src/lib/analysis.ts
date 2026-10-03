import { MONTHS, decimalYear, formatDate } from './dates';
import { computeSpi, monthlyAnomalies, seasonalKendall, toMonthly, type Anomaly, type MonthValue, type SeasonalKendall, type SpiResult } from './climate-stats';
import { buildClassification, detectMetric, type Classification } from './metrics';
import { isFiniteNumber, summarize, trendTest, type TrendResult } from './stats';
import type { NumericSummary, TableDataset } from './types';

export interface SeriesPoint {
  /** Row index in the dataset. */
  row: number;
  time: Date | null;
  label: string;
  value: number;
}

export interface MonthlyMean {
  month: number;
  label: string;
  mean: number;
  n: number;
}

export interface MetricAnalysis {
  column: string;
  points: SeriesPoint[];
  summary: NumericSummary | null;
  trend: TrendResult | null;
  /** Mean per calendar month; only when the series spans at least two years of sub-monthly or monthly data. */
  monthly: MonthlyMean[] | null;
  classification: Classification;
  classCounts: number[];
  /** Set when the trend result should not be read as a long-term trend. */
  trendCaveat: string | null;
  start: Date | null;
  end: Date | null;
  /** Monthly climate statistics; set when the record spans at least two years at monthly or finer spacing. */
  climate: ClimateStats | null;
}

export interface ClimateStats {
  monthly: MonthValue[];
  seasonalKendall: SeasonalKendall | null;
  anomalies: Anomaly[];
  /** SPI at 1, 3, 6 and 12 months for precipitation with at least 10 years; otherwise null. */
  spi: SpiResult[] | null;
  spiNote: string | null;
}

export const SPI_SCALES = [1, 3, 6, 12];
const SPI_MIN_YEARS = 10;

export function numericColumns(ds: TableDataset): string[] {
  return ds.columns.filter(c => c.kind === 'number' && c.name !== ds.timeColumn).map(c => c.name);
}

export function analyzeMetric(ds: TableDataset, column: string): MetricAnalysis {
  const points: SeriesPoint[] = [];
  ds.rows.forEach((row, i) => {
    const v = row[column];
    if (!isFiniteNumber(v)) return;
    const time = ds.times ? ds.times[i] : null;
    if (ds.times && !time) return; // unparseable date: keep it off the time axis
    points.push({ row: i, time, label: time ? formatDate(time) : `Row ${i + 1}`, value: v });
  });
  if (ds.times) points.sort((a, b) => a.time!.getTime() - b.time!.getTime());

  const values = points.map(p => p.value);
  const summary = summarize(values);
  const classification = buildClassification(column, values, ds.intervalDays === null ? null : { median: ds.intervalDays, min: ds.minIntervalDays ?? ds.intervalDays });
  const classCounts = classification.buckets.map(() => 0);
  for (const v of values) {
    const idx = classification.classify(v);
    if (idx >= 0) classCounts[idx]++;
  }

  let trend: TrendResult | null = null;
  let monthly: MonthlyMean[] | null = null;
  let trendCaveat: string | null = null;
  const start = points[0]?.time ?? null;
  const end = points[points.length - 1]?.time ?? null;
  if (ds.times && points.length >= 4) {
    trend = trendTest(points.map(p => decimalYear(p.time!)), values);
    const spanYears = start && end ? (end.getTime() - start.getTime()) / (365.25 * 86_400_000) : 0;
    if (spanYears < 1.9) {
      trendCaveat = `The record covers ${spanYears < 1 ? `${Math.max(1, Math.round(spanYears * 12))} month${Math.round(spanYears * 12) === 1 ? '' : 's'}` : `${spanYears.toFixed(1)} years`}, less than two seasonal cycles, so this trend mostly reflects the seasonal cycle, not a long-term change.`;
    }
    if (spanYears >= 1.9 && (ds.intervalDays ?? 999) <= 31) {
      const sums = new Array(12).fill(0);
      const counts = new Array(12).fill(0);
      for (const p of points) {
        const m = p.time!.getUTCMonth();
        sums[m] += p.value;
        counts[m]++;
      }
      monthly = sums.map((s, m) => ({ month: m, label: MONTHS[m], mean: counts[m] ? s / counts[m] : NaN, n: counts[m] })).filter(m => m.n > 0);
    }
  }

  let climate: ClimateStats | null = null;
  const span = start && end ? (end.getTime() - start.getTime()) / (365.25 * 86_400_000) : 0;
  if (ds.times && span >= 1.9 && (ds.intervalDays ?? 999) <= 31) {
    const monthlyValues = toMonthly(points.map(p => ({ time: p.time!, value: p.value })), ds.intervalDays);
    const usable = monthlyValues.filter(m => m.coverage >= 0.8);
    let spi: SpiResult[] | null = null;
    let spiNote: string | null = null;
    if (detectMetric(column) === 'precip') {
      const years = new Set(usable.map(m => m.year)).size;
      if (years >= SPI_MIN_YEARS) spi = SPI_SCALES.map(k => computeSpi(monthlyValues, k, (ds.intervalDays ?? 30) <= 1.5));
      else spiNote = `The Standardized Precipitation Index needs at least ${SPI_MIN_YEARS} years of monthly data (30 or more recommended); this record has ${years}.`;
    }
    climate = { monthly: usable, seasonalKendall: seasonalKendall(usable), anomalies: monthlyAnomalies(usable).rows, spi, spiNote };
  }

  return { column, points, summary, trend, monthly, classification, classCounts, trendCaveat, start, end, climate };
}
