// Multi-date image series: one value per image (mean and median of a band
// or spectral index over valid pixels), then a Mann–Kendall / Theil–Sen
// trend over the dates.
import { decimalYear } from './dates';
import { indexDef } from './indices';
import { applyQa, dateFromFilename } from './qa';
import { computeIndexGrid } from './raster';
import { sameGrid, type OpenRaster } from './rasterio';
import { fmt, fmtP, quantileSorted, trendTest, type TrendResult } from './stats';
import type { BandMap, QaMaskRef, SpectralIndex } from './types';
import { clipToBoundary, type Boundary } from './zonal';

export interface StackRow {
  filename: string;
  date: Date;
  mean: number;
  median: number;
  validFraction: number;
  /** Excluded from the trend because too few pixels were valid. */
  sparse: boolean;
}

export interface StackResult {
  label: string;
  rows: StackRow[];
  trend: TrendResult | null;
  notes: string[];
}

export const MIN_VALID = 0.2;

export async function analyzeStack(
  items: { raster: OpenRaster }[],
  opts: { index: SpectralIndex | null; bands: BandMap; qa?: QaMaskRef; boundary?: Boundary | null },
): Promise<StackResult> {
  if (items.length < 2) throw new Error('Add at least two images from different dates.');
  const undated = items.filter(i => !dateFromFilename(i.raster.meta.filename)).map(i => i.raster.meta.filename);
  if (undated.length) throw new Error(`No date found in: ${undated.join(', ')}. Put the acquisition date in each file name (for example S2_2024-03-15_ndvi.tif or LC09_20240315.tif).`);
  const notes: string[] = [];
  const first = items[0].raster.meta;
  if (!items.every(i => sameGrid(first, i.raster.meta))) notes.push('The images are not all on the same grid, so each value covers a slightly different area. Export every date with the same region, scale and CRS for a like-for-like series.');
  const label = opts.index ? indexDef(opts.index).name.split(' —')[0] : 'Band 1';
  const rows: StackRow[] = [];
  for (const { raster } of items) {
    const grid =
      opts.index && raster.meta.bands > 1
        ? (await computeIndexGrid(raster, { mode: 'index', index: opts.index, bands: opts.bands })).grid
        : (await raster.readBands([0]))[0];
    if (opts.qa && opts.qa.band < raster.meta.bands && raster.meta.bands > 1) await applyQa(raster, [grid], opts.qa);
    if (opts.boundary) clipToBoundary(raster.meta, grid, opts.boundary);
    const vals: number[] = [];
    let total = 0;
    for (let k = 0; k < grid.data.length; k++) {
      total++;
      if (!Number.isNaN(grid.data[k])) vals.push(grid.data[k]);
    }
    vals.sort((a, b) => a - b);
    const validFraction = total ? vals.length / total : 0;
    rows.push({
      filename: raster.meta.filename,
      date: dateFromFilename(raster.meta.filename)!,
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN,
      median: vals.length ? quantileSorted(vals, 0.5) : NaN,
      validFraction,
      sparse: validFraction < MIN_VALID,
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  const used = rows.filter(r => !r.sparse && Number.isFinite(r.mean));
  const trend = trendTest(used.map(r => decimalYear(r.date)), used.map(r => r.mean));
  if (opts.index && items.some(i => i.raster.meta.bands === 1)) notes.push(`Single-band files were read as ${label} directly.`);
  if (rows.some(r => r.sparse)) notes.push(`Images with under ${MIN_VALID * 100} % valid pixels (clouds, no data or outside the boundary) are listed but left out of the trend.`);
  if (!trend) notes.push('At least four usable dates are needed for a trend test.');
  notes.push(
    'Each date is summarised by the mean over its valid pixels. Mixing seasons, sensors or cloud amounts changes which pixels are averaged, so compare images from the same season (or use a seasonal test on a long series).',
  );
  return { label, rows, trend, notes };
}

export function stackMarkdown(r: StackResult): string {
  const t = r.trend;
  return [
    '## Dataset',
    '',
    `- ${r.rows.length} images, ${r.rows[0].date.toISOString().slice(0, 10)} to ${r.rows[r.rows.length - 1].date.toISOString().slice(0, 10)}; value: ${r.label}`,
    '',
    '## Results',
    '',
    '| Date | File | Mean | Median | Valid pixels |',
    '|---|---|---|---|---|',
    ...r.rows.map(x => `| ${x.date.toISOString().slice(0, 10)} | ${x.filename} | ${fmt(x.mean)} | ${fmt(x.median)} | ${(x.validFraction * 100).toFixed(0)} %${x.sparse ? ' (excluded)' : ''} |`),
    '',
    t
      ? `Trend (Mann–Kendall, n = ${t.n}): ${t.direction}, Theil–Sen slope ${fmt(t.senSlope)} per year, ${fmtP(t.p).startsWith('<') ? `p ${fmtP(t.p)}` : `p = ${fmtP(t.p)}`}.`
      : 'Trend: not tested (fewer than four usable dates).',
    '',
    '## Method and limits',
    '',
    ...r.notes.map(n => `- ${n}`),
  ].join('\n');
}
