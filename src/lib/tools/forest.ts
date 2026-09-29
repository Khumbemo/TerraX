// Forest-loss estimation.
//  1. Two-date NDVI differencing: forest = NDVI(before) ≥ forest threshold;
//     loss = forest pixels whose ΔNDVI = NDVI(after) − NDVI(before) falls
//     at or below the loss threshold. Gain = non-forest pixels that rise
//     by at least the same magnitude.
//  2. Hansen et al. (2013) Global Forest Change "lossyear" layer, with an
//     optional "treecover2000" layer to define the baseline forest.
import { groundGeometry, sameGrid, type Grid, type OpenRaster } from '../rasterio';
import { computeIndexGrid } from '../raster';
import { boundaryMask, applyMask, type Boundary } from '../zonal';
import { fmt } from '../stats';
import type { BandMap } from '../types';

export const CHANGE_CLASSES = [
  { id: 1, label: 'Stable forest', color: [46, 125, 72] },
  { id: 2, label: 'Forest loss', color: [229, 72, 77] },
  { id: 3, label: 'Non-forest', color: [58, 72, 88] },
  { id: 4, label: 'Vegetation gain', color: [126, 211, 132] },
] as const;

export interface AreaUnit {
  /** Area in hectares, or null when the CRS has no ground units. */
  ha: number | null;
  pixels: number;
}

export interface NdviChangeResult {
  mode: 'ndvi';
  forestThreshold: number;
  lossThreshold: number;
  forestBefore: AreaUnit;
  loss: AreaUnit;
  gain: AreaUnit;
  validPixels: number;
  meanDelta: number;
  /** Class per analysis cell: 0 no data, 1–4 as CHANGE_CLASSES. */
  classes: Uint8Array;
  width: number;
  height: number;
  notes: string[];
}

export interface LossYearRow {
  year: number;
  area: AreaUnit;
}

export interface HansenResult {
  mode: 'hansen';
  canopyThreshold: number | null;
  baseline: AreaUnit | null;
  totalLoss: AreaUnit;
  byYear: LossYearRow[];
  classes: Uint8Array;
  width: number;
  height: number;
  notes: string[];
}

export type ForestResult = NdviChangeResult | HansenResult;

export interface ImageInput {
  raster: OpenRaster;
  /** For multi-band files: red and NIR bands used to compute NDVI. Single-band files are read as NDVI. */
  bands: BandMap;
}

async function ndviGrid(input: ImageInput): Promise<{ grid: Grid; note: string }> {
  const { raster, bands } = input;
  if (raster.meta.bands === 1) {
    const [grid] = await raster.readBands([0]);
    return { grid, note: `${raster.meta.filename}: single band read as NDVI.` };
  }
  const { grid } = await computeIndexGrid(raster, { mode: 'index', index: 'ndvi', bands });
  return { grid, note: `${raster.meta.filename}: NDVI from band ${bands.nir! + 1} (NIR) and band ${bands.red! + 1} (red).` };
}

function areaAccumulator(raster: OpenRaster, grid: Grid) {
  const geo = groundGeometry(raster.meta, grid);
  return {
    geo,
    cell: (row: number) => (geo ? geo.cellArea(row) : 0),
    toUnit: (m2: number, pixels: number): AreaUnit => ({ ha: geo ? m2 / 10_000 : null, pixels }),
  };
}

function checkNdviRange(grid: Grid, name: string): string | null {
  let out = 0;
  let n = 0;
  for (let i = 0; i < grid.data.length; i += 7) {
    const v = grid.data[i];
    if (Number.isNaN(v)) continue;
    n++;
    if (v < -1.001 || v > 1.001) out++;
  }
  return n && out / n > 0.01 ? `${name} has values outside −1…1, so it does not look like NDVI. For multi-band imagery, assign the red and NIR bands.` : null;
}

export async function analyzeNdviChange(before: ImageInput, after: ImageInput, forestThreshold: number, lossThreshold: number, boundary?: Boundary | null): Promise<NdviChangeResult> {
  if (!sameGrid(before.raster.meta, after.raster.meta)) {
    throw new Error(
      `The two images are on different grids (${before.raster.meta.width}×${before.raster.meta.height} vs ${after.raster.meta.width}×${after.raster.meta.height}, or different extents or CRS). Export both dates with the same region, scale and CRS so pixels line up.`,
    );
  }
  if (lossThreshold >= 0) throw new Error('The loss threshold must be negative (a drop in NDVI).');
  const b = await ndviGrid(before);
  const a = await ndviGrid(after);
  for (const [g, name] of [
    [b.grid, before.raster.meta.filename],
    [a.grid, after.raster.meta.filename],
  ] as const) {
    const problem = checkNdviRange(g, name);
    if (problem) throw new Error(problem);
  }

  let clipNote: string | null = null;
  if (boundary) {
    const { mask, inside } = boundaryMask(before.raster.meta, b.grid, boundary);
    applyMask(b.grid, mask);
    applyMask(a.grid, mask);
    clipNote = `Limited to the analysis boundary “${boundary.name}” (${(boundary.areaM2 / 10_000).toFixed(2)} ha; ${inside.toLocaleString()} grid cells inside).`;
  }
  const { width, height } = b.grid;
  const acc = areaAccumulator(before.raster, b.grid);
  const classes = new Uint8Array(width * height);
  let forestM2 = 0, lossM2 = 0, gainM2 = 0;
  let forestPx = 0, lossPx = 0, gainPx = 0, valid = 0;
  let deltaSum = 0;
  for (let row = 0; row < height; row++) {
    const cellArea = acc.cell(row);
    for (let col = 0; col < width; col++) {
      const k = row * width + col;
      const v0 = b.grid.data[k];
      const v1 = a.grid.data[k];
      if (Number.isNaN(v0) || Number.isNaN(v1)) continue;
      valid++;
      const d = v1 - v0;
      deltaSum += d;
      if (v0 >= forestThreshold) {
        forestPx++;
        forestM2 += cellArea;
        if (d <= lossThreshold) {
          classes[k] = 2;
          lossPx++;
          lossM2 += cellArea;
        } else classes[k] = 1;
      } else if (d >= -lossThreshold) {
        classes[k] = 4;
        gainPx++;
        gainM2 += cellArea;
      } else classes[k] = 3;
    }
  }

  const notes = [
    b.note,
    a.note,
    `Forest is NDVI ≥ ${forestThreshold} on the earlier image; loss is a drop of ${Math.abs(lossThreshold)} or more (ΔNDVI ≤ ${lossThreshold}); gain is a rise of at least ${Math.abs(lossThreshold)} on non-forest.`,
    'NDVI thresholds are a proxy for forest: they do not apply the FAO definition (≥ 10 % canopy cover, trees ≥ 5 m, ≥ 0.5 ha). Seasonal leaf fall, clouds, haze or different sensors can look like loss, so compare images from the same season and check hotspots against high-resolution imagery.',
  ];
  if (clipNote) notes.unshift(clipNote);
  if (acc.geo) notes.push(acc.geo.note);
  else notes.push('The CRS has no ground units TerraX can use, so results are in pixels only.');
  if (b.grid.resampleFactor > 1) notes.push(`Areas were computed on a resampled grid (each cell = ${fmt(b.grid.resampleFactor, 3)} original pixels); cell areas were scaled to match.`);

  return {
    mode: 'ndvi',
    forestThreshold,
    lossThreshold,
    forestBefore: acc.toUnit(forestM2, forestPx),
    loss: acc.toUnit(lossM2, lossPx),
    gain: acc.toUnit(gainM2, gainPx),
    validPixels: valid,
    meanDelta: valid ? deltaSum / valid : NaN,
    classes,
    width,
    height,
    notes,
  };
}

/** Hansen GFC: lossyear values 1–N mean loss in year 2000 + N; 0 means no loss. */
export async function analyzeHansen(lossYear: OpenRaster, treeCover: OpenRaster | null, canopyThreshold: number, boundary?: Boundary | null): Promise<HansenResult> {
  if (treeCover && !sameGrid(lossYear.meta, treeCover.meta)) {
    throw new Error('The lossyear and treecover2000 files are on different grids. Download the same Hansen tile for both.');
  }
  const [ly] = await lossYear.readBands([0]);
  const tc = treeCover ? (await treeCover.readBands([0]))[0] : null;
  const { width, height } = ly;

  let nonInt = 0;
  let maxV = 0;
  for (let i = 0; i < ly.data.length; i += 11) {
    const v = ly.data[i];
    if (Number.isNaN(v)) continue;
    if (!Number.isInteger(v) || v < 0 || v > 60) nonInt++;
    if (v > maxV) maxV = v;
  }
  if (nonInt > 0) throw new Error(`${lossYear.meta.filename} does not look like a Hansen lossyear layer (values should be whole numbers 0–${new Date().getUTCFullYear() - 2000}).`);

  let clipNote: string | null = null;
  if (boundary) {
    const { mask, inside } = boundaryMask(lossYear.meta, ly, boundary);
    applyMask(ly, mask);
    if (tc) applyMask(tc, mask);
    clipNote = `Limited to the analysis boundary “${boundary.name}” (${(boundary.areaM2 / 10_000).toFixed(2)} ha; ${inside.toLocaleString()} grid cells inside).`;
  }
  const acc = areaAccumulator(lossYear, ly);
  const classes = new Uint8Array(width * height);
  const perYear = new Map<number, { m2: number; px: number }>();
  let baseM2 = 0, basePx = 0, lossM2 = 0, lossPx = 0;
  for (let row = 0; row < height; row++) {
    const cellArea = acc.cell(row);
    for (let col = 0; col < width; col++) {
      const k = row * width + col;
      const v = ly.data[k];
      if (Number.isNaN(v)) continue;
      const cover = tc ? tc.data[k] : NaN;
      const isForest = tc ? cover >= canopyThreshold : true;
      if (tc && Number.isNaN(cover)) continue;
      if (!isForest) {
        classes[k] = 3;
        continue;
      }
      basePx++;
      baseM2 += cellArea;
      if (v >= 1) {
        classes[k] = 2;
        lossPx++;
        lossM2 += cellArea;
        const e = perYear.get(v) ?? { m2: 0, px: 0 };
        e.m2 += cellArea;
        e.px++;
        perYear.set(v, e);
      } else classes[k] = 1;
    }
  }

  const byYear = [...perYear.entries()].sort((x, y) => x[0] - y[0]).map(([v, e]) => ({ year: 2000 + v, area: acc.toUnit(e.m2, e.px) }));
  const notes = [
    'Hansen et al. (2013), Science 342:850–853, Global Forest Change: lossyear = year of stand-replacing tree-cover loss (1 = 2001).',
    tc
      ? `Baseline forest = treecover2000 ≥ ${canopyThreshold} % canopy (Global Forest Watch commonly uses 30 %). Only loss inside the baseline is counted.`
      : 'No treecover2000 layer was given, so every lossyear pixel counts and no baseline forest area or percentage is reported.',
    '"Loss" includes harvest, fire, storm and disease, not only deforestation; year-to-year comparisons across the whole record are affected by algorithm updates (see the GFC version notes).',
  ];
  if (clipNote) notes.unshift(clipNote);
  if (acc.geo) notes.push(acc.geo.note);
  else notes.push('The CRS has no ground units TerraX can use, so results are in pixels only.');
  if (ly.resampleFactor > 1) notes.push(`Areas were computed on a resampled grid (each cell = ${fmt(ly.resampleFactor, 3)} original pixels).`);

  return {
    mode: 'hansen',
    canopyThreshold: tc ? canopyThreshold : null,
    baseline: tc ? acc.toUnit(baseM2, basePx) : null,
    totalLoss: acc.toUnit(lossM2, lossPx),
    byYear,
    classes,
    width,
    height,
    notes,
  };
}

export function formatArea(a: AreaUnit | null): string {
  if (!a) return '—';
  if (a.ha === null) return `${a.pixels.toLocaleString()} px`;
  if (a.ha >= 100) return `${fmt(a.ha, 5)} ha (${fmt(a.ha / 100, 4)} km²)`;
  return `${fmt(a.ha, 4)} ha`;
}

export function forestMarkdown(r: ForestResult, names: string[]): string {
  const lines = ['## Dataset', '', ...names.map(n => `- ${n}`), '', '## Results', ''];
  if (r.mode === 'ndvi') {
    const pct = r.forestBefore.pixels ? (r.loss.pixels / r.forestBefore.pixels) * 100 : NaN;
    lines.push(
      '| Measure | Value |',
      '|---|---|',
      `| Forest at start (NDVI ≥ ${r.forestThreshold}) | ${formatArea(r.forestBefore)} |`,
      `| Forest loss (ΔNDVI ≤ ${r.lossThreshold}) | ${formatArea(r.loss)} |`,
      `| Loss as share of starting forest | ${Number.isFinite(pct) ? pct.toFixed(2) + ' %' : '—'} |`,
      `| Vegetation gain on non-forest | ${formatArea(r.gain)} |`,
      `| Mean ΔNDVI (all valid pixels) | ${fmt(r.meanDelta)} |`,
      `| Valid pixels compared | ${r.validPixels.toLocaleString()} |`,
      '',
    );
  } else {
    const pct = r.baseline && r.baseline.pixels ? (r.totalLoss.pixels / r.baseline.pixels) * 100 : NaN;
    lines.push('| Measure | Value |', '|---|---|');
    if (r.baseline) lines.push(`| Forest in 2000 (canopy ≥ ${r.canopyThreshold} %) | ${formatArea(r.baseline)} |`);
    lines.push(`| Total tree-cover loss | ${formatArea(r.totalLoss)} |`);
    if (Number.isFinite(pct)) lines.push(`| Loss as share of 2000 forest | ${pct.toFixed(2)} % |`);
    lines.push('', '### Loss by year', '', '| Year | Loss |', '|---|---|', ...r.byYear.map(y => `| ${y.year} | ${formatArea(y.area)} |`), '');
  }
  lines.push('## Method and limits', '', ...r.notes.map(n => `- ${n}`));
  return lines.join('\n');
}
