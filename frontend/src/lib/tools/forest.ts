// Forest-loss estimation.
//  1. Two-date NDVI differencing: forest = NDVI(before) ≥ forest threshold;
//     loss = forest pixels whose ΔNDVI = NDVI(after) − NDVI(before) falls
//     at or below the loss threshold. Gain = non-forest pixels that rise
//     by at least the same magnitude.
//  2. Hansen et al. (2013) Global Forest Change "lossyear" layer, with an
//     optional "treecover2000" layer to define the baseline forest.
//  3. Burn severity from the differenced Normalized Burn Ratio,
//     dNBR = NBR(pre) − NBR(post), classed with the USGS FIREMON ranges
//     (Key & Benson 2006).
// Optionally, patches smaller than a minimum mapping unit are removed
// (8-connected), and loss/burn patches can be exported as polygons.
import type { FeatureCollection, MultiPolygon } from 'geojson';
import { applyMmu, labelPatches, patchAreas, patchesToGeoJson } from '../patches';
import { groundGeometry, sameGrid, type GeoMeta, type Grid, type OpenRaster } from '../rasterio';
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

/** dNBR classes; lower bounds from Key & Benson (2006), USGS FIREMON. */
export const BURN_CLASSES = [
  { id: 1, label: 'Enhanced regrowth, high (< −0.25)', upTo: -0.25, color: [122, 135, 55] },
  { id: 2, label: 'Enhanced regrowth, low (−0.25 to −0.1)', upTo: -0.1, color: [172, 190, 77] },
  { id: 3, label: 'Unburned (−0.1 to 0.1)', upTo: 0.1, color: [10, 224, 66] },
  { id: 4, label: 'Low severity (0.1 to 0.27)', upTo: 0.27, color: [255, 247, 11] },
  { id: 5, label: 'Moderate-low severity (0.27 to 0.44)', upTo: 0.44, color: [255, 175, 56] },
  { id: 6, label: 'Moderate-high severity (0.44 to 0.66)', upTo: 0.66, color: [255, 100, 27] },
  { id: 7, label: 'High severity (≥ 0.66)', upTo: Infinity, color: [164, 31, 214] },
] as const;

export interface AnalysisOptions {
  /** Minimum mapping unit in hectares; 0 or undefined keeps every patch. */
  mmuHa?: number;
}

export interface PatchInfo {
  /** Patches after the MMU filter. */
  count: number;
  largest: AreaUnit;
  mmuHa: number;
  removedPatches: number;
  removedArea: AreaUnit;
}

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
  patches: PatchInfo | null;
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
  patches: PatchInfo | null;
  notes: string[];
}

export interface BurnResult {
  mode: 'burn';
  /** Area per BURN_CLASSES entry (same order). */
  classAreas: AreaUnit[];
  burned: AreaUnit;
  meanDnbr: number;
  validPixels: number;
  classes: Uint8Array;
  width: number;
  height: number;
  patches: PatchInfo | null;
  notes: string[];
}

export type ForestResult = NdviChangeResult | HansenResult | BurnResult;

/** Classes counted as loss (or burned) in each mode. */
export function isLossClass(mode: ForestResult['mode'], cls: number): boolean {
  return mode === 'burn' ? cls >= 4 : cls === 2;
}

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

/**
 * Applies the MMU in place (patches of loss classes below it become
 * `replaceWith`) and reports patch statistics. Returns the removed cells.
 */
function patchStep(
  mode: ForestResult['mode'],
  classes: Uint8Array,
  width: number,
  height: number,
  acc: ReturnType<typeof areaAccumulator>,
  replaceWith: number,
  opts: AnalysisOptions | undefined,
  notes: string[],
): { info: PatchInfo | null; removed: number[] } {
  const mmuHa = opts?.mmuHa ?? 0;
  const target = (c: number) => isLossClass(mode, c);
  if (!acc.geo) {
    if (mmuHa > 0) notes.push('The minimum mapping unit was not applied: the CRS has no ground units.');
    return { info: null, removed: [] };
  }
  const cellArea = (row: number) => acc.cell(row);
  let removed: number[] = [];
  let removedPatches = 0;
  let kept;
  if (mmuHa > 0) {
    const m = applyMmu(classes, width, height, target, replaceWith, mmuHa * 10_000, cellArea);
    removed = m.removed;
    removedPatches = m.removedPatches;
    kept = m.kept;
  } else kept = patchAreas(labelPatches(width, height, k => target(classes[k])), width, cellArea);
  let removedM2 = 0;
  for (const k of removed) removedM2 += cellArea(Math.floor(k / width));
  if (mmuHa > 0) {
    notes.push(
      `Minimum mapping unit ${mmuHa} ha: ${removedPatches.toLocaleString()} ${mode === 'burn' ? 'burned' : 'loss'} patches smaller than this (8-connected pixels) were reclassified as ${mode === 'burn' ? 'unburned' : 'stable forest'}${mode === 'burn' ? '' : ' (FAO’s forest definition uses 0.5 ha)'}.`,
    );
  }
  return {
    info: { count: kept.count, largest: acc.toUnit(kept.largest, 0), mmuHa, removedPatches, removedArea: acc.toUnit(removedM2, removed.length) },
    removed,
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

export async function analyzeNdviChange(before: ImageInput, after: ImageInput, forestThreshold: number, lossThreshold: number, boundary?: Boundary | null, opts?: AnalysisOptions): Promise<NdviChangeResult> {
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
  const { info, removed } = patchStep('ndvi', classes, width, height, acc, 1, opts, notes);
  for (const k of removed) lossM2 -= acc.cell(Math.floor(k / width));
  lossPx -= removed.length;

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
    patches: info,
    notes,
  };
}

/** Hansen GFC: lossyear values 1–N mean loss in year 2000 + N; 0 means no loss. */
export async function analyzeHansen(lossYear: OpenRaster, treeCover: OpenRaster | null, canopyThreshold: number, boundary?: Boundary | null, opts?: AnalysisOptions): Promise<HansenResult> {
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

  const mmuNotes: string[] = [];
  const { info, removed } = patchStep('hansen', classes, width, height, acc, 1, opts, mmuNotes);
  for (const k of removed) {
    const a = acc.cell(Math.floor(k / width));
    lossM2 -= a;
    lossPx--;
    const e = perYear.get(ly.data[k])!;
    e.m2 -= a;
    e.px--;
    if (!e.px) perYear.delete(ly.data[k]);
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
  notes.push(...mmuNotes);

  return {
    mode: 'hansen',
    canopyThreshold: tc ? canopyThreshold : null,
    baseline: tc ? acc.toUnit(baseM2, basePx) : null,
    totalLoss: acc.toUnit(lossM2, lossPx),
    byYear,
    classes,
    width,
    height,
    patches: info,
    notes,
  };
}

async function nbrGrid(input: ImageInput): Promise<{ grid: Grid; note: string }> {
  const { raster, bands } = input;
  if (raster.meta.bands === 1) {
    const [grid] = await raster.readBands([0]);
    return { grid, note: `${raster.meta.filename}: single band read as NBR.` };
  }
  const { grid } = await computeIndexGrid(raster, { mode: 'index', index: 'nbr', bands });
  return { grid, note: `${raster.meta.filename}: NBR from band ${bands.nir! + 1} (NIR) and band ${bands.swir2! + 1} (SWIR2).` };
}

/** Burn severity from pre- and post-fire NBR (dNBR = NBR_pre − NBR_post). */
export async function analyzeBurn(pre: ImageInput, post: ImageInput, boundary?: Boundary | null, opts?: AnalysisOptions): Promise<BurnResult> {
  if (!sameGrid(pre.raster.meta, post.raster.meta)) {
    throw new Error('The pre- and post-fire images are on different grids. Export both with the same region, scale and CRS so pixels line up.');
  }
  const b = await nbrGrid(pre);
  const a = await nbrGrid(post);
  for (const [g, name] of [
    [b.grid, pre.raster.meta.filename],
    [a.grid, post.raster.meta.filename],
  ] as const) {
    if (checkNdviRange(g, name)) throw new Error(`${name} has values outside −1…1, so it does not look like NBR. For multi-band imagery, assign the NIR and SWIR2 bands.`);
  }
  let clipNote: string | null = null;
  if (boundary) {
    const { mask, inside } = boundaryMask(pre.raster.meta, b.grid, boundary);
    applyMask(b.grid, mask);
    applyMask(a.grid, mask);
    clipNote = `Limited to the analysis boundary “${boundary.name}” (${(boundary.areaM2 / 10_000).toFixed(2)} ha; ${inside.toLocaleString()} grid cells inside).`;
  }
  const { width, height } = b.grid;
  const acc = areaAccumulator(pre.raster, b.grid);
  const classes = new Uint8Array(width * height);
  const m2 = BURN_CLASSES.map(() => 0);
  const px = BURN_CLASSES.map(() => 0);
  let valid = 0, sum = 0;
  for (let row = 0; row < height; row++) {
    const cellArea = acc.cell(row);
    for (let col = 0; col < width; col++) {
      const k = row * width + col;
      const v0 = b.grid.data[k], v1 = a.grid.data[k];
      if (Number.isNaN(v0) || Number.isNaN(v1)) continue;
      const d = v0 - v1;
      valid++;
      sum += d;
      const i = BURN_CLASSES.findIndex(c => d < c.upTo);
      classes[k] = BURN_CLASSES[i].id;
      m2[i] += cellArea;
      px[i]++;
    }
  }
  const notes = [
    b.note,
    a.note,
    'dNBR = NBR(pre-fire) − NBR(post-fire), NBR = (NIR − SWIR2) / (NIR + SWIR2); classes follow the USGS FIREMON ranges (Key & Benson 2006): low severity from 0.10, moderate-low from 0.27, moderate-high from 0.44, high from 0.66.',
    'These thresholds are generic: severity depends on pre-fire vegetation, and field plots (Composite Burn Index) are needed to calibrate them locally. Use cloud- and smoke-free images from the same season, ideally within a year of the fire.',
  ];
  if (clipNote) notes.unshift(clipNote);
  if (acc.geo) notes.push(acc.geo.note);
  else notes.push('The CRS has no ground units TerraX can use, so results are in pixels only.');
  const { info, removed } = patchStep('burn', classes, width, height, acc, 3, opts, notes);
  for (const k of removed) {
    // Removed cells were burned (classes 4–7); they are now unburned (3).
    const rowArea = acc.cell(Math.floor(k / width));
    m2[2] += rowArea;
    px[2]++;
  }
  if (removed.length) {
    // Recount burned classes from the final class grid for exact totals.
    for (let i = 3; i < 7; i++) {
      m2[i] = 0;
      px[i] = 0;
    }
    for (let k = 0; k < classes.length; k++) {
      const c = classes[k];
      if (c >= 4) {
        m2[c - 1] += acc.cell(Math.floor(k / width));
        px[c - 1]++;
      }
    }
  }
  const burnedM2 = m2.slice(3).reduce((x, y) => x + y, 0);
  const burnedPx = px.slice(3).reduce((x, y) => x + y, 0);
  return {
    mode: 'burn',
    classAreas: BURN_CLASSES.map((_, i) => acc.toUnit(m2[i], px[i])),
    burned: acc.toUnit(burnedM2, burnedPx),
    meanDnbr: valid ? sum / valid : NaN,
    validPixels: valid,
    classes,
    width,
    height,
    patches: info,
    notes,
  };
}

/** Loss (or burned) patches as WGS84 polygons with their area; null when the CRS is unsupported. */
export function lossPolygons(r: ForestResult, meta: GeoMeta): { fc: FeatureCollection<MultiPolygon>; truncated: number } | null {
  const geo = groundGeometry(meta, r);
  const cellArea = (row: number) => (geo ? geo.cellArea(row) : 1);
  const labels = labelPatches(r.width, r.height, k => isLossClass(r.mode, r.classes[k]));
  if (!labels.count) return { fc: { type: 'FeatureCollection', features: [] }, truncated: 0 };
  const stats = patchAreas(labels, r.width, cellArea);
  return patchesToGeoJson(labels, stats, meta, r, (id, area) => ({
    patch: id,
    kind: r.mode === 'burn' ? 'burned (dNBR ≥ 0.1)' : 'forest loss',
    ...(geo ? { area_ha: Math.round((area / 10_000) * 10_000) / 10_000 } : { pixels: area }),
  }));
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
  } else if (r.mode === 'burn') {
    lines.push(
      '| Measure | Value |',
      '|---|---|',
      `| Burned area (dNBR ≥ 0.1) | ${formatArea(r.burned)} |`,
      `| Mean dNBR (all valid pixels) | ${fmt(r.meanDnbr)} |`,
      `| Valid pixels compared | ${r.validPixels.toLocaleString()} |`,
      '',
      '### Severity classes',
      '',
      '| Class | Area | Share |',
      '|---|---|---|',
      ...BURN_CLASSES.map((c, i) => `| ${c.label} | ${formatArea(r.classAreas[i])} | ${r.validPixels ? ((r.classAreas[i].pixels / r.validPixels) * 100).toFixed(2) : '—'} % |`),
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
  if (r.patches) {
    const what = r.mode === 'burn' ? 'Burned' : 'Loss';
    lines.push(`${what} patches (8-connected): ${r.patches.count.toLocaleString()}; largest ${formatArea(r.patches.largest)}.${r.patches.mmuHa > 0 ? ` Minimum mapping unit ${r.patches.mmuHa} ha removed ${r.patches.removedPatches.toLocaleString()} patches (${formatArea(r.patches.removedArea)}).` : ''}`, '');
  }
  lines.push('## Method and limits', '', ...r.notes.map(n => `- ${n}`));
  return lines.join('\n');
}
