import { indexDef, missingBands } from './indices';
import { openGeoTiff, type Grid, type OpenRaster } from './rasterio';
import { histogram, quantileSorted, summarize } from './stats';
import { clipToBoundary, type Boundary } from './zonal';
import type { BandRole, RasterDataset, RasterMode } from './types';

const PREVIEW_MAX_SIDE = 512;

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Nearest-neighbour downsample of a grid to at most PREVIEW_MAX_SIDE on its longest side. */
export function previewGrid(grid: Grid): { data: Float32Array; width: number; height: number } {
  const { width: gw, height: gh } = grid;
  const s = Math.min(1, PREVIEW_MAX_SIDE / Math.max(gw, gh));
  const pw = Math.max(1, Math.round(gw * s));
  const ph = Math.max(1, Math.round(gh * s));
  const out = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(gh - 1, Math.floor(y / s));
    for (let x = 0; x < pw; x++) out[y * pw + x] = grid.data[sy * gw + Math.min(gw - 1, Math.floor(x / s))];
  }
  return { data: out, width: pw, height: ph };
}

/** Median of a band's valid values, used to detect reflectance scaled by 10,000. */
function looksScaled(grid: Grid): boolean {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(grid.data.length / 20000));
  for (let i = 0; i < grid.data.length; i += step) if (!Number.isNaN(grid.data[i])) sample.push(grid.data[i]);
  sample.sort((a, b) => a - b);
  return sample.length > 0 && quantileSorted(sample, 0.5) > 1.5;
}

/** Computes a spectral index grid from an opened raster. */
export async function computeIndexGrid(raster: OpenRaster, view: Extract<RasterMode, { mode: 'index' }>): Promise<{ grid: Grid; notes: string[] }> {
  const def = indexDef(view.index);
  const missing = missingBands(view.index, view.bands);
  if (missing.length) throw new Error(`${def.name.split(' —')[0]} needs these bands assigned: ${missing.join(', ')}.`);
  const roles = def.needs;
  const indices = roles.map(r => view.bands[r]!);
  if (new Set(indices).size !== indices.length) throw new Error('Assign a different band to each role.');
  const grids = await raster.readBands(indices);
  const notes: string[] = [];
  let scale = 1;
  if (def.needsReflectance && grids.some(looksScaled)) {
    scale = 1 / 10000;
    notes.push(`${def.name.split(' —')[0]} uses absolute reflectance; band values look scaled by 10,000 (as in Sentinel-2 L2A from Earth Engine) and were divided by 10,000. Raw ESA L2A files from 2022 onward also need the −1000 offset removed first.`);
  }
  const out = new Float32Array(grids[0].data.length);
  const b = {} as Record<BandRole, number>;
  for (let k = 0; k < out.length; k++) {
    let ok = true;
    for (let j = 0; j < roles.length; j++) {
      const v = grids[j].data[k];
      if (Number.isNaN(v)) {
        ok = false;
        break;
      }
      b[roles[j]] = v * scale;
    }
    const v = ok ? def.compute(b) : NaN;
    out[k] = Number.isFinite(v) ? v : NaN;
  }
  const bandText = roles.map((r, j) => `band ${indices[j] + 1} = ${r.toUpperCase()}`).join(', ');
  notes.unshift(`${def.name.split(' —')[0]} = ${def.formula} (${def.reference}); ${bandText}. ${def.reading}`);
  return { grid: { ...grids[0], data: out }, notes };
}

/** Builds a RasterDataset (statistics, histogram, preview) from one grid. */
export function datasetFromGrid(raster: OpenRaster, grid: Grid, view: RasterMode, hints: string[], extraWarnings: string[] = []): RasterDataset {
  const { meta } = raster;
  let validCount = 0;
  for (let i = 0; i < grid.data.length; i++) if (!Number.isNaN(grid.data[i])) validCount++;
  const valid = new Float32Array(validCount);
  for (let i = 0, j = 0; i < grid.data.length; i++) if (!Number.isNaN(grid.data[i])) valid[j++] = grid.data[i];
  const stats = summarize(valid);
  const warnings = [...meta.warnings, ...extraWarnings];
  if (!stats) warnings.push('Every pixel is empty or marked as no-data.');
  return {
    kind: 'raster',
    id: newId(),
    filename: meta.filename,
    sizeBytes: meta.sizeBytes,
    width: meta.width,
    height: meta.height,
    bands: meta.bands,
    view,
    noData: meta.noData,
    stats,
    validPixels: validCount,
    totalPixels: grid.data.length,
    statsResampled: grid.resampleFactor > 1,
    histogram: stats ? histogram(valid, stats.min, stats.max, 30) : [],
    preview: previewGrid(grid),
    bbox: meta.bbox,
    epsg: meta.epsg,
    latLngBounds: meta.latLngBounds,
    pixelSize: meta.pixelSize,
    hints,
    warnings,
  };
}

/**
 * Reads a GeoTIFF band (or a spectral index computed from several bands),
 * computes statistics over valid pixels, and prepares a preview grid.
 */
export async function readRaster(file: File, view: RasterMode = { mode: 'band', band: 0 }, opened?: OpenRaster, boundary?: Boundary | null): Promise<RasterDataset> {
  const raster = opened ?? (await openGeoTiff(file));
  const { meta } = raster;
  if (view.mode === 'band' && (view.band < 0 || view.band >= meta.bands)) view = { mode: 'band', band: 0 };

  if (view.mode === 'index') {
    const { grid, notes } = await computeIndexGrid(raster, view);
    const clip = clipToBoundary(meta, grid, boundary);
    return datasetFromGrid(raster, grid, view, clip ? [clip, ...notes] : notes);
  }

  const [grid] = await raster.readBands([view.band]);
  const clip = clipToBoundary(meta, grid, boundary);
  const ds = datasetFromGrid(raster, grid, view, clip ? [clip] : []);
  const s = ds.stats;
  if (s) {
    if (s.min >= -1 && s.max <= 1) ds.hints.push('Values lie between −1 and 1, consistent with a normalised index such as NDVI.');
    else if (meta.bands >= 2 && s.min >= 0 && s.max <= 12000) ds.hints.push('Values look like surface reflectance scaled by 10,000 (as in Sentinel-2 L2A). Choose a spectral index to derive NDVI, NDWI, NDMI and others.');
  }
  return ds;
}

/**
 * Renders an RGB composite with a 2–98 % percentile stretch per channel.
 * Returns RGBA bytes for a canvas; no-data pixels are transparent.
 */
export async function readComposite(raster: OpenRaster, rgb: [number, number, number]): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const grids = await raster.readBands(rgb);
  const previews = grids.map(previewGrid);
  const { width, height } = previews[0];
  const ranges = previews.map(p => {
    const vals = Array.from(p.data).filter(v => !Number.isNaN(v)).sort((a, b) => a - b);
    return vals.length ? [quantileSorted(vals, 0.02), quantileSorted(vals, 0.98)] : [0, 1];
  });
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let valid = true;
    for (let c = 0; c < 3; c++) {
      const v = previews[c].data[i];
      if (Number.isNaN(v)) {
        valid = false;
        break;
      }
      const [lo, hi] = ranges[c];
      rgba[i * 4 + c] = ((v - lo) / (hi - lo || 1)) * 255;
    }
    rgba[i * 4 + 3] = valid ? 255 : 0;
  }
  return { rgba, width, height };
}
