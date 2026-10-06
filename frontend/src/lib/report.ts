// Builds reports and AI context from computed statistics. Every number in a
// report comes from these calculations; an AI interpretation, when present,
// is added as a separate, clearly labelled section.
import { analyzeMetric, numericColumns, type MetricAnalysis } from './analysis';
import { spiClass, type Anomaly } from './climate-stats';
import { MONTHS, formatDate } from './dates';
import { indexDef } from './indices';
import { rainfallMarkdown, rainfallSummary } from './tools/climate';
import { fmt, fmtP } from './stats';
import type { Dataset, RasterDataset, TableDataset } from './types';

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}
export { bytes as formatBytes };

function intervalText(days: number | null, minDays: number | null = null): string {
  if (days === null) return 'irregular or unknown';
  if (minDays !== null && Math.abs(minDays - 1) < 0.25 && days > 1.25) return 'daily, with gaps between some records';
  if (Math.abs(days - 1) < 0.1) return 'daily';
  if (Math.abs(days - 7) < 0.5) return 'weekly';
  if (days >= 28 && days <= 31) return 'monthly';
  if (days >= 365 && days <= 366) return 'yearly';
  return `every ${fmt(days, 3)} days`;
}

function trendSentence(a: MetricAnalysis): string {
  const t = a.trend;
  if (!t) return 'Not enough dated observations for a trend test (at least 4 are needed).';
  const unit = a.classification.unit && a.classification.convert(1) === 1 ? ` ${a.classification.unit}` : '';
  const verdict =
    t.direction === 'no trend'
      ? `no statistically significant monotonic trend (Mann–Kendall p = ${fmtP(t.p)})`
      : `a statistically significant ${t.direction} trend (Mann–Kendall p = ${fmtP(t.p)})`;
  const sentence = `The series shows ${verdict}. Theil–Sen slope: ${fmt(t.senSlope)}${unit} per year (least-squares slope ${fmt(t.olsSlope)}${unit} per year), n = ${t.n}.`;
  return a.trendCaveat ? `${sentence} **Caution:** ${a.trendCaveat}` : sentence;
}

function climateMarkdown(a: MetricAnalysis): string {
  const c = a.climate!;
  const out: string[] = [];
  const sk = c.seasonalKendall;
  if (sk) {
    out.push(
      `Seasonal Kendall test on ${sk.n} monthly values (${sk.seasons} calendar months; Hirsch et al. 1982): ${sk.direction === 'no trend' ? 'no significant trend' : `${sk.direction} trend`}, seasonal Theil–Sen slope ${fmt(sk.slope)} per year, ${fmtP(sk.p).startsWith('<') ? `p ${fmtP(sk.p)}` : `p = ${fmtP(sk.p)}`}. Unlike the plain Mann–Kendall test, it compares each month only with the same month in other years, so the seasonal cycle cannot pose as a trend. Serial correlation between months is not corrected for.`,
    );
  }
  const withZ = c.anomalies.filter(x => x.z !== null);
  if (withZ.length) {
    const hi = withZ.reduce((x, y) => (y.z! > x.z! ? y : x));
    const lo = withZ.reduce((x, y) => (y.z! < x.z! ? y : x));
    const years = new Set(c.monthly.map(m => m.year)).size;
    const name = (x: Anomaly) => `${MONTHS[x.month]} ${x.year}`;
    out.push(
      '',
      `Monthly anomalies against this record’s own ${years}-year monthly means: largest positive ${name(hi)} (${fmt(hi.anomaly)}, ${fmt(hi.z!, 2)} SD), largest negative ${name(lo)} (${fmt(lo.anomaly)}, ${fmt(lo.z!, 2)} SD).${years < 30 ? ' The WMO climate normal period is 30 years; a shorter baseline makes anomalies less stable.' : ''}`,
    );
  }
  if (c.spi) {
    out.push('', '| SPI scale | Latest value | Months ≤ −1 (moderately dry or worse) | Months ≤ −2 |', '|---|---|---|---|');
    for (const r of c.spi) {
      const vals = r.rows.filter(x => x.spi !== null);
      const last = vals[vals.length - 1];
      out.push(`| SPI-${r.scale} | ${last ? `${fmt(last.spi!, 2)} (${MONTHS[last.month]} ${last.year}, ${spiClass(last.spi!)})` : '—'} | ${vals.filter(x => x.spi! <= -1).length} | ${vals.filter(x => x.spi! <= -2).length} |`);
    }
    out.push('', ...c.spi[0].notes.slice(1).map(n => `- ${n}`), `- SPI method: ${c.spi[0].notes[0].replace(/^SPI-1: /, '')}`);
  } else if (c.spiNote) out.push('', c.spiNote);
  return out.join('\n');
}

function metricSection(ds: TableDataset, a: MetricAnalysis): string {
  const s = a.summary;
  if (!s) return `### ${a.column}\n\nNo numeric values.\n`;
  const lines = [
    `### ${a.column}`,
    '',
    `| Statistic | Value |`,
    `|---|---|`,
    `| Valid values | ${s.n} |`,
    `| Mean ± SD | ${fmt(s.mean)} ± ${fmt(s.sd)} |`,
    `| Median (IQR) | ${fmt(s.median)} (${fmt(s.q1)}–${fmt(s.q3)}) |`,
    `| Range | ${fmt(s.min)} to ${fmt(s.max)} |`,
  ];
  if (ds.times) lines.push(`| Period | ${formatDate(a.start)} to ${formatDate(a.end)} |`);
  lines.push('');
  if (ds.times) lines.push(trendSentence(a), '');
  const rain = rainfallSummary(a, ds.minIntervalDays);
  if (rain) lines.push(rainfallMarkdown(rain, a.start, a.end));
  if (a.monthly && a.monthly.length >= 6) {
    const valid = a.monthly.filter(m => Number.isFinite(m.mean));
    const hi = valid.reduce((x, y) => (y.mean > x.mean ? y : x));
    const lo = valid.reduce((x, y) => (y.mean < x.mean ? y : x));
    lines.push(`Seasonal cycle: highest mean in ${hi.label} (${fmt(hi.mean)}), lowest in ${lo.label} (${fmt(lo.mean)}).`, '');
  }
  if (a.climate) lines.push(climateMarkdown(a), '');
  const total = a.classCounts.reduce((x, y) => x + y, 0);
  if (total) {
    lines.push(`Class distribution (${a.classification.basis.replace(/\.$/, '')}):`, '');
    a.classification.buckets.forEach((b, i) => {
      if (a.classCounts[i]) lines.push(`- ${b.label}: ${a.classCounts[i]} (${((a.classCounts[i] / total) * 100).toFixed(1)} %)`);
    });
    if (a.classification.note) lines.push('', `Note: ${a.classification.note}`);
    lines.push('');
  }
  return lines.join('\n');
}

function tableReport(ds: TableDataset, focus: string | null): string {
  const cols = numericColumns(ds);
  const ordered = focus && cols.includes(focus) ? [focus, ...cols.filter(c => c !== focus)] : cols;
  const parts = [
    `## Dataset`,
    '',
    `- File: ${ds.filename} (${ds.format}, ${bytes(ds.sizeBytes)})`,
    `- Records: ${ds.rows.length}; numeric columns: ${cols.join(', ') || 'none'}`,
    ds.timeColumn ? `- Time column: ${ds.timeColumn}; sampling ${intervalText(ds.intervalDays, ds.minIntervalDays)}` : '- No time column',
    '',
    `## Results`,
    '',
    ...ordered.slice(0, 6).map(c => metricSection(ds, analyzeMetric(ds, c))),
  ];
  if (ordered.length > 6) parts.push(`(${ordered.length - 6} further columns not summarised.)`, '');
  return parts.join('\n');
}

function rasterReport(ds: RasterDataset): string {
  const s = ds.stats;
  const layer = ds.view.mode === 'index' ? `${indexDef(ds.view.index).name} computed from the assigned bands` : `band ${ds.view.band + 1} of ${ds.bands}`;
  const lines = [
    `## Dataset`,
    '',
    `- File: ${ds.filename} (GeoTIFF, ${bytes(ds.sizeBytes)})`,
    `- Size: ${ds.width} × ${ds.height} pixels, ${ds.bands} band${ds.bands === 1 ? '' : 's'}; analysed layer: ${layer}`,
    `- CRS: ${ds.epsg ? `EPSG:${ds.epsg}` : 'unknown'}${ds.pixelSize ? `; pixel size ${fmt(ds.pixelSize[0])} × ${fmt(ds.pixelSize[1])} (CRS units)` : ''}`,
    ds.latLngBounds
      ? `- Extent (WGS84): ${ds.latLngBounds[0][0].toFixed(4)}° to ${ds.latLngBounds[1][0].toFixed(4)}° N, ${ds.latLngBounds[0][1].toFixed(4)}° to ${ds.latLngBounds[1][1].toFixed(4)}° E`
      : '- Extent: not available in WGS84',
    `- No-data value: ${ds.noData ?? 'none declared'}; valid pixels ${ds.validPixels.toLocaleString()} of ${ds.totalPixels.toLocaleString()} (${((ds.validPixels / Math.max(1, ds.totalPixels)) * 100).toFixed(1)} %)`,
    '',
    `## Results`,
    '',
  ];
  if (s) {
    lines.push(
      `| Statistic | Value |`,
      `|---|---|`,
      `| Mean ± SD | ${fmt(s.mean)} ± ${fmt(s.sd)} |`,
      `| Median (IQR) | ${fmt(s.median)} (${fmt(s.q1)}–${fmt(s.q3)}) |`,
      `| Range | ${fmt(s.min)} to ${fmt(s.max)} |`,
      '',
    );
    if (ds.view.mode === 'index' && ds.view.index === 'ndvi') {
      const bins = ds.histogram;
      const share = (lo: number, hi: number) => bins.filter(b => (b.x0 + b.x1) / 2 >= lo && (b.x0 + b.x1) / 2 < hi).reduce((n, b) => n + b.count, 0);
      const total = Math.max(1, ds.validPixels);
      lines.push(
        `Approximate NDVI cover (from histogram bins; indicative USGS ranges): below 0.2: ${((share(-Infinity, 0.2) / total) * 100).toFixed(1)} %, 0.2–0.6: ${((share(0.2, 0.6) / total) * 100).toFixed(1)} %, 0.6 and above: ${((share(0.6, Infinity) / total) * 100).toFixed(1)} %.`,
        '',
      );
    }
  } else {
    lines.push('No valid pixels.', '');
  }
  ds.hints.forEach(h => lines.push(`- ${h}`));
  return lines.join('\n');
}

const METHOD_NOTE = [
  '## Method and limits',
  '',
  '- Statistics are computed in the browser from the uploaded values; empty, non-numeric and no-data values are excluded.',
  '- Trend: Mann–Kendall test (two-sided, α = 0.05, tie-corrected) with the Theil–Sen slope. It assumes independent observations; strong seasonality or autocorrelation can make p-values too small, so check the seasonal cycle before reading a trend as real.',
  '- Value classes are indicative and depend on sensor, season and region; the basis for each is stated with it.',
].join('\n');

export function buildLocalReport(ds: Dataset, focus: string | null): string {
  const body = ds.kind === 'table' ? tableReport(ds, focus) : rasterReport(ds);
  const warnings = ds.warnings.length ? ['## Data quality', '', ...ds.warnings.map(w => `- ${w}`), ''].join('\n') : '';
  return [body, warnings, METHOD_NOTE].filter(Boolean).join('\n');
}

/**
 * Compact dataset description for the AI: the computed report plus a
 * sample of rows, so answers can be grounded in the actual values.
 */
export function buildAiContext(ds: Dataset, focus: string | null, maxRows = 150): string {
  const parts = [buildLocalReport(ds, focus)];
  if (ds.kind === 'table') {
    const cols = [ds.timeColumn, ...numericColumns(ds)].filter((c): c is string => Boolean(c)).slice(0, 8);
    const step = Math.max(1, Math.ceil(ds.rows.length / maxRows));
    const sample = ds.rows.filter((_, i) => i % step === 0).slice(0, maxRows);
    const csv = [cols.join(','), ...sample.map(r => cols.map(c => {
      const v = r[c];
      return v instanceof Date ? formatDate(v) : v === null ? '' : String(v);
    }).join(','))].join('\n');
    parts.push(`## Data sample (${sample.length} of ${ds.rows.length} rows${step > 1 ? `, every ${step}th row` : ''})`, '```csv', csv, '```');
  }
  return parts.join('\n\n');
}
