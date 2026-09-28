// Terrain analysis from a DEM: slope and aspect by Horn's (1981) 3×3
// method, hillshade (sun azimuth 315°, altitude 45°), relief and the
// hypsometric integral (Strahler 1952).
import { groundGeometry, type Grid, type OpenRaster } from '../rasterio';
import { fmt, summarize } from '../stats';
import type { NumericSummary } from '../types';

export const SLOPE_CLASSES = [
  { upTo: 2, label: 'Flat (< 2°)', color: '#2f6c5a' },
  { upTo: 5, label: 'Gentle (2–5°)', color: '#6aa84f' },
  { upTo: 15, label: 'Moderate (5–15°)', color: '#d8c558' },
  { upTo: 30, label: 'Steep (15–30°)', color: '#e69138' },
  { upTo: 45, label: 'Very steep (30–45°)', color: '#cc4125' },
  { upTo: Infinity, label: 'Extreme (≥ 45°)', color: '#7f1d1d' },
];

export const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export interface TerrainResult {
  filename: string;
  elevation: NumericSummary;
  relief: number;
  hypsometricIntegral: number;
  slope: NumericSummary;
  slopeClassCounts: number[];
  aspectCounts: number[];
  flatCount: number;
  width: number;
  height: number;
  hillshade: Float32Array;
  slopeGrid: Float32Array;
  elevationGrid: Float32Array;
  notes: string[];
}

export async function analyzeTerrain(raster: OpenRaster): Promise<TerrainResult> {
  const [dem] = await raster.readBands([0]);
  const geo = groundGeometry(raster.meta, dem);
  if (!geo) throw new Error('The DEM has no ground units TerraX can use (supported: WGS84, Web Mercator, WGS84 UTM), so slope cannot be computed.');
  const { width: w, height: h, data: z } = dem;
  const slope = new Float32Array(w * h).fill(NaN);
  const shade = new Float32Array(w * h).fill(NaN);
  const aspectCounts = new Array(8).fill(0);
  const slopeClassCounts = SLOPE_CLASSES.map(() => 0);
  let flat = 0;

  // Hillshade constants (ESRI convention): zenith 45°, azimuth 315°.
  const zenith = (45 * Math.PI) / 180;
  const azimuthMath = ((360 - 315 + 90) % 360) * (Math.PI / 180);

  for (let r = 1; r < h - 1; r++) {
    const { dx, dy } = geo.spacing(r);
    for (let c = 1; c < w - 1; c++) {
      const k = r * w + c;
      const a = z[k - w - 1], b = z[k - w], cc = z[k - w + 1];
      const d = z[k - 1], f = z[k + 1];
      const g = z[k + w - 1], hh = z[k + w], i = z[k + w + 1];
      if ([a, b, cc, d, z[k], f, g, hh, i].some(Number.isNaN)) continue;
      // Horn (1981): rows run north (a b c) to south (g h i).
      const dzdx = (cc + 2 * f + i - (a + 2 * d + g)) / (8 * dx);
      const dzdy = (g + 2 * hh + i - (a + 2 * b + cc)) / (8 * dy);
      const s = Math.atan(Math.hypot(dzdx, dzdy));
      const sDeg = (s * 180) / Math.PI;
      slope[k] = sDeg;
      slopeClassCounts[SLOPE_CLASSES.findIndex(x => sDeg < x.upTo)]++;
      // Aspect, degrees clockwise from north (direction the slope faces).
      let asp = Math.atan2(dzdy, -dzdx); // ESRI math angle
      if (sDeg < 2) flat++;
      else {
        let deg = (asp * 180) / Math.PI;
        deg = deg < 0 ? 90 - deg : deg > 90 ? 360 - deg + 90 : 90 - deg;
        aspectCounts[Math.round(deg / 45) % 8]++;
      }
      if (dzdx === 0 && dzdy === 0) asp = 0;
      shade[k] = Math.max(0, Math.cos(zenith) * Math.cos(s) + Math.sin(zenith) * Math.sin(s) * Math.cos(azimuthMath - asp));
    }
  }

  const elevVals: number[] = [];
  for (let k = 0; k < z.length; k++) if (!Number.isNaN(z[k])) elevVals.push(z[k]);
  const slopeVals: number[] = [];
  for (let k = 0; k < slope.length; k++) if (!Number.isNaN(slope[k])) slopeVals.push(slope[k]);
  const elevation = summarize(elevVals);
  const slopeStats = summarize(slopeVals);
  if (!elevation || !slopeStats) throw new Error('The DEM has too few valid pixels to compute slope (a 3×3 neighbourhood is needed).');
  const relief = elevation.max - elevation.min;

  const notes = [
    'Slope and aspect: Horn (1981) 3×3 finite differences; aspect is the compass direction the slope faces (slopes under 2° counted as flat).',
    'Hillshade: sun from the north-west (azimuth 315°) at 45° altitude.',
    'Hypsometric integral HI = (mean − min) / (max − min) (Strahler 1952): above ~0.6 suggests a youthful, less eroded landscape; below ~0.35 a mature one.',
    `Elevation values are assumed to be metres. ${geo.note}`,
  ];
  if (dem.resampleFactor > 1) notes.push('The DEM was resampled for analysis; slopes on a coarser grid are gentler than at full resolution.');
  if (elevation.max > 9000 || elevation.min < -500) notes.push('Some elevations are outside −500 to 9,000 m; check the file for unmasked no-data values.');

  return {
    filename: raster.meta.filename,
    elevation,
    relief,
    hypsometricIntegral: relief > 0 ? (elevation.mean - elevation.min) / relief : NaN,
    slope: slopeStats,
    slopeClassCounts,
    aspectCounts,
    flatCount: flat,
    width: w,
    height: h,
    hillshade: shade,
    slopeGrid: slope,
    elevationGrid: z,
    notes,
  };
}

export function terrainMarkdown(t: TerrainResult, meta: { epsg: number | null; width: number; height: number }): string {
  const total = t.slopeClassCounts.reduce((a, b) => a + b, 0) || 1;
  const aspTotal = t.aspectCounts.reduce((a, b) => a + b, 0) || 1;
  return [
    '## Dataset',
    '',
    `- File: ${t.filename} (DEM, ${meta.width} × ${meta.height} px, ${meta.epsg ? `EPSG:${meta.epsg}` : 'CRS unknown'})`,
    '',
    '## Results',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Elevation mean ± SD | ${fmt(t.elevation.mean)} ± ${fmt(t.elevation.sd)} m |`,
    `| Elevation range | ${fmt(t.elevation.min)} to ${fmt(t.elevation.max)} m (relief ${fmt(t.relief)} m) |`,
    `| Slope mean (median) | ${fmt(t.slope.mean)}° (${fmt(t.slope.median)}°) |`,
    `| Steepest slope | ${fmt(t.slope.max)}° |`,
    `| Hypsometric integral | ${fmt(t.hypsometricIntegral, 3)} |`,
    '',
    'Slope classes (descriptive):',
    '',
    ...SLOPE_CLASSES.map((c, i) => `- ${c.label}: ${((t.slopeClassCounts[i] / total) * 100).toFixed(1)} %`),
    '',
    `Aspect of non-flat slopes: ${ASPECTS.map((a, i) => `${a} ${((t.aspectCounts[i] / aspTotal) * 100).toFixed(0)} %`).join(', ')}.`,
    '',
    '## Method and limits',
    '',
    ...t.notes.map(n => `- ${n}`),
  ].join('\n');
}

/** Shared helper: grid → RGBA with a per-value colour function (NaN transparent). */
export function gridToRgba(grid: ArrayLike<number>, color: (v: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(grid.length * 4);
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (Number.isNaN(v)) continue;
    const [r, g, b] = color(v);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

export type { Grid };
