import { bboxToLatLng } from './geo';
import { histogram, summarize } from './stats';
import type { RasterDataset, RasterMode } from './types';

/** Pixel budget for statistics; larger rasters are resampled to this size. */
const STATS_PIXEL_LIMIT = 4_000_000;
const PREVIEW_MAX_SIDE = 512;

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

type NumArray = ArrayLike<number>;

function readEpsg(geoKeys: Record<string, unknown> | null): { epsg: number | null; geographic: boolean; userDefined: boolean } {
  if (!geoKeys) return { epsg: null, geographic: false, userDefined: false };
  const projected = Number(geoKeys.ProjectedCSTypeGeoKey);
  const geographicCode = Number(geoKeys.GeographicTypeGeoKey);
  const model = Number(geoKeys.GTModelTypeGeoKey);
  if (Number.isFinite(projected) && projected > 0) {
    return projected === 32767 ? { epsg: null, geographic: false, userDefined: true } : { epsg: projected, geographic: false, userDefined: false };
  }
  if (Number.isFinite(geographicCode) && geographicCode > 0 && geographicCode !== 32767) return { epsg: geographicCode, geographic: true, userDefined: false };
  if (model === 2) return { epsg: 4326, geographic: true, userDefined: false };
  return { epsg: null, geographic: false, userDefined: model === 1 };
}

/**
 * Reads a GeoTIFF band (or an NDVI computed from two bands), computes
 * statistics over valid pixels, and prepares a preview grid.
 */
export async function readRaster(file: File, view: RasterMode = { mode: 'band', band: 0 }): Promise<RasterDataset> {
  const { fromBlob } = await import('geotiff');
  const tiff = await fromBlob(file);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  const noData = image.getGDALNoData();
  const warnings: string[] = [];
  const hints: string[] = [];

  if (view.mode === 'band' && (view.band < 0 || view.band >= bands)) view = { mode: 'band', band: 0 };
  if (view.mode === 'ndvi' && (view.red >= bands || view.nir >= bands || view.red === view.nir)) {
    throw new Error('Choose two different bands for red and near-infrared.');
  }

  // Statistics grid: full resolution when affordable, otherwise resampled.
  const total = width * height;
  const scale = total > STATS_PIXEL_LIMIT ? Math.sqrt(STATS_PIXEL_LIMIT / total) : 1;
  const gw = Math.max(1, Math.round(width * scale));
  const gh = Math.max(1, Math.round(height * scale));
  const statsResampled = scale < 1;
  const samples = view.mode === 'band' ? [view.band] : [view.red, view.nir];
  const rasters = (await image.readRasters({ samples, width: gw, height: gh, resampleMethod: 'nearest', interleave: false })) as unknown as NumArray[];

  const isValid = (v: number) => Number.isFinite(v) && (noData === null || v !== noData);
  const grid = new Float32Array(gw * gh);
  if (view.mode === 'band') {
    const band = rasters[0];
    for (let i = 0; i < grid.length; i++) grid[i] = isValid(band[i]) ? band[i] : NaN;
  } else {
    const red = rasters[0];
    const nir = rasters[1];
    for (let i = 0; i < grid.length; i++) {
      const r = red[i];
      const n = nir[i];
      grid[i] = isValid(r) && isValid(n) && n + r !== 0 ? (n - r) / (n + r) : NaN;
    }
  }

  let validCount = 0;
  for (let i = 0; i < grid.length; i++) if (!Number.isNaN(grid[i])) validCount++;
  const valid = new Float32Array(validCount);
  for (let i = 0, j = 0; i < grid.length; i++) if (!Number.isNaN(grid[i])) valid[j++] = grid[i];
  const stats = summarize(valid);
  if (!stats) warnings.push('Every pixel is empty or marked as no-data.');

  // Preview grid (nearest-neighbour downsample of the statistics grid).
  const pScale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(gw, gh));
  const pw = Math.max(1, Math.round(gw * pScale));
  const ph = Math.max(1, Math.round(gh * pScale));
  const preview = new Float32Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(gh - 1, Math.floor(y / pScale));
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(gw - 1, Math.floor(x / pScale));
      preview[y * pw + x] = grid[sy * gw + sx];
    }
  }

  // Georeferencing
  let bbox: RasterDataset['bbox'] = null;
  let pixelSize: RasterDataset['pixelSize'] = null;
  try {
    const b = image.getBoundingBox();
    if (b.length === 4 && b.every(Number.isFinite)) bbox = [b[0], b[1], b[2], b[3]];
    const res = image.getResolution();
    pixelSize = [Math.abs(res[0]), Math.abs(res[1])];
  } catch {
    warnings.push('The file has no georeferencing, so it cannot be placed on the map.');
  }
  const { epsg, geographic, userDefined } = readEpsg(image.getGeoKeys() as Record<string, unknown> | null);
  let latLngBounds: RasterDataset['latLngBounds'] = null;
  if (bbox) {
    const code = geographic ? 4326 : epsg;
    if (geographic && epsg !== 4326) warnings.push(`Geographic CRS EPSG:${epsg} was treated as WGS84 for the map footprint (offset is usually under a few metres).`);
    latLngBounds = userDefined ? null : bboxToLatLng(bbox, code);
    if (!latLngBounds) warnings.push(userDefined ? 'The file uses a custom projection, so its footprint cannot be drawn on the map.' : `EPSG:${epsg} is not supported for the map footprint (supported: WGS84, Web Mercator, WGS84 UTM zones).`);
  }

  if (statsResampled) warnings.push(`Statistics were computed on a ${gw}×${gh} nearest-neighbour resample of the ${width}×${height} raster.`);
  if (stats && view.mode === 'band') {
    if (stats.min >= -1 && stats.max <= 1) hints.push('Values lie between −1 and 1, consistent with a normalised index such as NDVI.');
    else if (bands >= 2 && stats.min >= 0 && stats.max <= 12000) hints.push('Values look like surface reflectance scaled by 10,000 (as in Sentinel-2 L2A). Use “Compute NDVI” with the red and near-infrared bands.');
  }
  if (view.mode === 'ndvi') hints.push(`NDVI = (NIR − Red) / (NIR + Red), using band ${view.nir + 1} as NIR and band ${view.red + 1} as red.`);

  return {
    kind: 'raster',
    id: newId(),
    filename: file.name,
    sizeBytes: file.size,
    width,
    height,
    bands,
    view,
    noData,
    stats,
    validPixels: validCount,
    totalPixels: grid.length,
    statsResampled,
    histogram: stats ? histogram(valid, stats.min, stats.max, 30) : [],
    preview: { data: preview, width: pw, height: ph },
    bbox,
    epsg,
    latLngBounds,
    pixelSize,
    hints,
    warnings,
  };
}
