// Unsupervised land-cover classification: k-means (Lloyd 1982) with
// k-means++ seeding (Arthur & Vassilvitskii 2007) on standardised bands.
// Clusters are spectral groups; they become land-cover classes only when
// the user labels them, and their accuracy is unknown until checked
// against reference data (Olofsson et al. 2014).
import { groundGeometry, type OpenRaster } from '../rasterio';
import { fmt } from '../stats';
import type { BandMap, QaMaskRef } from '../types';
import { applyQa } from '../qa';
import { clipToBoundary, type Boundary } from '../zonal';
import { kmeansAsync } from '../compute';
export { kmeans } from './kmeans';
import { rng } from './kmeans';

export const PALETTE = ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#1f78b4', '#b2df8a', '#fb9a99'];

export interface LandCoverClass {
  id: number;
  pixels: number;
  /** Hectares, null when the CRS has no ground units. */
  ha: number | null;
  share: number;
  /** Mean of each input band (original units). */
  bandMeans: number[];
  ndvi: number | null;
  suggestion: string | null;
}

export interface LandCoverResult {
  filename: string;
  bands: number[];
  k: number;
  width: number;
  height: number;
  /** Class id (1..k) per cell, 0 = no data / outside. */
  classes: Uint8Array;
  stats: LandCoverClass[];
  iterations: number;
  trainingPixels: number;
  notes: string[];
}

function suggest(ndvi: number | null): string | null {
  if (ndvi === null) return null;
  if (ndvi < 0) return 'Water';
  if (ndvi < 0.2) return 'Bare soil or built-up';
  if (ndvi < 0.5) return 'Sparse vegetation or cropland';
  return 'Dense vegetation';
}

export async function classifyLandCover(
  raster: OpenRaster,
  opts: { bands: number[]; k: number; roles: BandMap; boundary?: Boundary | null; qa?: QaMaskRef; seed?: number; maxTraining?: number },
): Promise<LandCoverResult> {
  const { bands, k } = opts;
  if (bands.length < 1) throw new Error('Choose at least one band.');
  if (!Number.isInteger(k) || k < 2 || k > PALETTE.length) throw new Error(`Choose between 2 and ${PALETTE.length} classes.`);
  const grids = await raster.readBands(bands);
  const notes: string[] = [];
  if (opts.qa) notes.push((await applyQa(raster, grids, opts.qa)).note);
  if (opts.boundary) {
    const note = clipToBoundary(raster.meta, grids[0], opts.boundary);
    for (let b = 1; b < grids.length; b++) for (let i = 0; i < grids[0].data.length; i++) if (Number.isNaN(grids[0].data[i])) grids[b].data[i] = NaN;
    if (note) notes.unshift(note);
  }
  const { width, height } = grids[0];
  const n = width * height;
  const valid: number[] = [];
  for (let i = 0; i < n; i++) if (grids.every(g => !Number.isNaN(g.data[i]))) valid.push(i);
  if (valid.length < k) throw new Error('Too few valid pixels to classify.');
  // Standardise each band (z-scores) so bands with larger ranges do not dominate.
  const d = bands.length;
  const mean = new Float64Array(d), sd = new Float64Array(d);
  for (let a = 0; a < d; a++) {
    let s = 0, s2 = 0;
    for (const i of valid) {
      const v = grids[a].data[i];
      s += v;
      s2 += v * v;
    }
    mean[a] = s / valid.length;
    sd[a] = Math.sqrt(Math.max(0, s2 / valid.length - mean[a] * mean[a])) || 1;
  }
  const maxTraining = opts.maxTraining ?? 20_000;
  const rand = rng((opts.seed ?? 7) + 101);
  const training = valid.length <= maxTraining ? valid : Array.from({ length: maxTraining }, () => valid[Math.floor(rand() * valid.length)]);
  const pts = new Float64Array(training.length * d);
  training.forEach((i, t) => {
    for (let a = 0; a < d; a++) pts[t * d + a] = (grids[a].data[i] - mean[a]) / sd[a];
  });
  const km = await kmeansAsync(pts, d, k, opts.seed ?? 7);

  // Assign every valid pixel.
  const raw = new Int16Array(n).fill(-1);
  for (const i of valid) {
    let bj = 0, bd = Infinity;
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let a = 0; a < d; a++) {
        const v = (grids[a].data[i] - mean[a]) / sd[a] - km.centroids[j * d + a];
        s += v * v;
      }
      if (s < bd) {
        bd = s;
        bj = j;
      }
    }
    raw[i] = bj;
  }

  const geo = groundGeometry(raster.meta, grids[0]);
  const px = new Float64Array(k), m2 = new Float64Array(k);
  const sums = Array.from({ length: k }, () => new Float64Array(d));
  const redIdx = opts.roles.red !== undefined ? bands.indexOf(opts.roles.red) : -1;
  const nirIdx = opts.roles.nir !== undefined ? bands.indexOf(opts.roles.nir) : -1;
  const ndviSum = new Float64Array(k), ndviN = new Float64Array(k);
  for (const i of valid) {
    const j = raw[i];
    px[j]++;
    if (geo) m2[j] += geo.cellArea(Math.floor(i / width));
    for (let a = 0; a < d; a++) sums[j][a] += grids[a].data[i];
    if (redIdx >= 0 && nirIdx >= 0) {
      const r = grids[redIdx].data[i], nr = grids[nirIdx].data[i];
      if (r + nr !== 0) {
        ndviSum[j] += (nr - r) / (nr + r);
        ndviN[j]++;
      }
    }
  }
  const ndvi = (j: number) => (ndviN[j] ? ndviSum[j] / ndviN[j] : null);
  // Order clusters by NDVI (or overall brightness) so class numbers are stable and readable.
  const order = Array.from({ length: k }, (_, j) => j).sort((x, y) => {
    const nx = ndvi(x), ny = ndvi(y);
    if (nx !== null && ny !== null) return nx - ny;
    return sums[x].reduce((a, b) => a + b, 0) / (px[x] || 1) - sums[y].reduce((a, b) => a + b, 0) / (px[y] || 1);
  });
  const rank = new Int32Array(k);
  order.forEach((j, r) => (rank[j] = r));
  const classes = new Uint8Array(n);
  for (const i of valid) classes[i] = rank[raw[i]] + 1;

  const stats: LandCoverClass[] = order.map((j, r) => ({
    id: r + 1,
    pixels: px[j],
    ha: geo ? m2[j] / 10_000 : null,
    share: px[j] / valid.length,
    bandMeans: Array.from(sums[j], v => v / (px[j] || 1)),
    ndvi: ndvi(j),
    suggestion: suggest(ndvi(j)),
  }));

  notes.push(
    `k-means with k-means++ seeding on ${d} standardised band${d === 1 ? '' : 's'} (${bands.map(b => `band ${b + 1}`).join(', ')}); ${training.length.toLocaleString()} training pixels${training.length < valid.length ? ' sampled at random' : ''}; converged in ${km.iterations} iterations.`,
    'Clusters are groups of similar spectra, not land-cover classes: name them from local knowledge or high-resolution imagery. The suggested names come only from each cluster’s mean NDVI.',
    'Before reporting areas, check the map against reference points and estimate accuracy and area with a stratified sample (Olofsson et al. 2014); unsupervised classes often mix cover types.',
  );
  if (geo) notes.push(geo.note);
  if (grids[0].resampleFactor > 1) notes.push(`Classified on a resampled grid (each cell = ${fmt(grids[0].resampleFactor, 3)} original pixels).`);
  return { filename: raster.meta.filename, bands, k, width, height, classes, stats, iterations: km.iterations, trainingPixels: training.length, notes };
}

export function landCoverMarkdown(r: LandCoverResult, labels: string[]): string {
  return [
    '## Dataset',
    '',
    `- File: ${r.filename}; bands ${r.bands.map(b => b + 1).join(', ')}; ${r.k} clusters`,
    '',
    '## Results',
    '',
    `| Class | Label | Area | Share | Mean NDVI | Band means |`,
    '|---|---|---|---|---|---|',
    ...r.stats.map((c, i) => `| ${c.id} | ${labels[i] || '—'} | ${c.ha === null ? `${c.pixels.toLocaleString()} px` : `${fmt(c.ha, 4)} ha`} | ${(c.share * 100).toFixed(1)} % | ${c.ndvi === null ? '—' : fmt(c.ndvi, 3)} | ${c.bandMeans.map(v => fmt(v, 4)).join(' · ')} |`),
    '',
    '## Method and limits',
    '',
    ...r.notes.map(n => `- ${n}`),
  ].join('\n');
}
