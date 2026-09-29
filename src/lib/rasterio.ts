// Shared GeoTIFF access for the raster tools: metadata, band reads on a
// common grid (no-data → NaN), and ground geometry (pixel area and spacing
// in metres) so areas and slopes are computed in real units.
import { bboxToLatLng, type LatLngBounds } from './geo';

/** Pixel budget for analysis grids; larger rasters are resampled to this size. */
export const ANALYSIS_PIXEL_LIMIT = 4_000_000;

/** Mean radius of the WGS84 authalic sphere (equal-area), metres. */
const R_AUTHALIC = 6371007.1809;
const RAD = Math.PI / 180;
const WGS84_E2 = 0.00669437999014;
const WGS84_E = Math.sqrt(WGS84_E2);

function qFn(sinPhi: number): number {
  const es = WGS84_E * sinPhi;
  return (1 - WGS84_E2) * (sinPhi / (1 - es * es) - (1 / (2 * WGS84_E)) * Math.log((1 - es) / (1 + es)));
}
const Q_POLE = qFn(1);

/**
 * sin of the authalic latitude β for geodetic latitude φ (Snyder 1987, eq. 3-11/3-12).
 * Areas between parallels on the WGS84 ellipsoid equal R_q² Δλ (sin β₂ − sin β₁), exactly.
 */
export function sinAuthalic(latDeg: number): number {
  return qFn(Math.sin(latDeg * RAD)) / Q_POLE;
}

export interface GeoMeta {
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  bands: number;
  noData: number | null;
  bbox: [number, number, number, number] | null;
  epsg: number | null;
  geographic: boolean;
  latLngBounds: LatLngBounds | null;
  /** Native pixel size in CRS units. */
  pixelSize: [number, number] | null;
  warnings: string[];
}

export interface Grid {
  width: number;
  height: number;
  /** Row-major values, NaN for no-data. */
  data: Float32Array;
  /** Native pixels represented by one grid cell (1 when not resampled). */
  resampleFactor: number;
}

export interface OpenRaster {
  meta: GeoMeta;
  /** Reads bands (0-based) onto one analysis grid of at most ANALYSIS_PIXEL_LIMIT cells. */
  readBands: (indices: number[]) => Promise<Grid[]>;
}

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

export async function openGeoTiff(file: File): Promise<OpenRaster> {
  const { fromBlob, fromArrayBuffer } = await import('geotiff');
  // fromBlob reads tiles lazily (good for large files) but needs FileReader,
  // which only browsers have; elsewhere read the whole file.
  const tiff = typeof FileReader !== 'undefined' ? await fromBlob(file) : await fromArrayBuffer(await file.arrayBuffer());
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = image.getSamplesPerPixel();
  const noData = image.getGDALNoData();
  const warnings: string[] = [];

  let bbox: GeoMeta['bbox'] = null;
  let pixelSize: GeoMeta['pixelSize'] = null;
  try {
    const b = image.getBoundingBox();
    if (b.length === 4 && b.every(Number.isFinite)) bbox = [b[0], b[1], b[2], b[3]];
    const res = image.getResolution();
    pixelSize = [Math.abs(res[0]), Math.abs(res[1])];
  } catch {
    warnings.push('The file has no georeferencing, so it cannot be placed on the map or measured in real units.');
  }
  const { epsg, geographic, userDefined } = readEpsg(image.getGeoKeys() as Record<string, unknown> | null);
  let latLngBounds: LatLngBounds | null = null;
  if (bbox) {
    if (geographic && epsg !== 4326) warnings.push(`Geographic CRS EPSG:${epsg} was treated as WGS84 (offset is usually under a few metres).`);
    latLngBounds = userDefined ? null : bboxToLatLng(bbox, geographic ? 4326 : epsg);
    if (!latLngBounds) {
      warnings.push(
        userDefined
          ? 'The file uses a custom projection, so its footprint cannot be drawn on the map.'
          : `EPSG:${epsg} is not supported for the map footprint (supported: WGS84, Web Mercator, WGS84 UTM zones).`,
      );
    }
  }

  const total = width * height;
  const scale = total > ANALYSIS_PIXEL_LIMIT ? Math.sqrt(ANALYSIS_PIXEL_LIMIT / total) : 1;
  const gw = Math.max(1, Math.round(width * scale));
  const gh = Math.max(1, Math.round(height * scale));
  if (scale < 1) warnings.push(`The ${width}×${height} raster was resampled to ${gw}×${gh} (nearest neighbour) for analysis.`);

  const meta: GeoMeta = { filename: file.name, sizeBytes: file.size, width, height, bands, noData, bbox, epsg, geographic: geographic || epsg === 4326, latLngBounds, pixelSize, warnings };

  const readBands = async (indices: number[]): Promise<Grid[]> => {
    for (const i of indices) if (i < 0 || i >= bands) throw new Error(`Band ${i + 1} does not exist; the file has ${bands} band${bands === 1 ? '' : 's'}.`);
    const rasters = (await image.readRasters({ samples: indices, width: gw, height: gh, resampleMethod: 'nearest', interleave: false })) as unknown as ArrayLike<number>[];
    return rasters.map(band => {
      const data = new Float32Array(gw * gh);
      for (let k = 0; k < data.length; k++) {
        const v = band[k];
        data[k] = Number.isFinite(v) && (noData === null || v !== noData) ? v : NaN;
      }
      return { width: gw, height: gh, data, resampleFactor: (width * height) / (gw * gh) };
    });
  };

  return { meta, readBands };
}

/** True when two rasters share a grid closely enough for pixel-by-pixel comparison. */
export function sameGrid(a: GeoMeta, b: GeoMeta): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (!a.bbox || !b.bbox) return !a.bbox && !b.bbox;
  const tol = Math.max(a.pixelSize?.[0] ?? 0, a.pixelSize?.[1] ?? 0) / 2;
  return a.bbox.every((v, i) => Math.abs(v - b.bbox![i]) <= tol) && a.epsg === b.epsg;
}

function isUtm(epsg: number | null): boolean {
  return epsg !== null && ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760));
}

/**
 * Ground geometry for an analysis grid, or null when the CRS has no known
 * ground units. Geographic cells use exact WGS84 ellipsoid areas (via
 * authalic latitude); Web Mercator cells are corrected by cos²(latitude);
 * UTM cells use the projected size (scale error < 0.1 % within a zone).
 */
export function groundGeometry(meta: GeoMeta, grid: Pick<Grid, 'width' | 'height'>): { cellArea: (row: number) => number; spacing: (row: number) => { dx: number; dy: number }; note: string } | null {
  if (!meta.bbox || !meta.pixelSize) return null;
  const [minX, minY, maxX, maxY] = meta.bbox;
  const cw = (maxX - minX) / grid.width; // cell size in CRS units
  const ch = (maxY - minY) / grid.height;

  if (meta.geographic) {
    if (minY < -90.001 || maxY > 90.001) return null;
    const rowLat = (row: number) => maxY - (row + 0.5) * ch;
    return {
      cellArea: row => R_AUTHALIC * R_AUTHALIC * cw * RAD * Math.abs(sinAuthalic(maxY - row * ch) - sinAuthalic(maxY - (row + 1) * ch)),
      spacing: row => ({ dx: R_AUTHALIC * cw * RAD * Math.cos(rowLat(row) * RAD), dy: R_AUTHALIC * ch * RAD }),
      note: 'Pixel areas are exact WGS84 ellipsoid cell areas (authalic latitude), varying with latitude.',
    };
  }
  if (meta.epsg === 3857 || meta.epsg === 900913) {
    const rowLat = (row: number) => {
      const y = maxY - (row + 0.5) * ch;
      return 2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2;
    };
    return {
      cellArea: row => cw * ch * Math.cos(rowLat(row)) ** 2,
      spacing: row => ({ dx: cw * Math.cos(rowLat(row)), dy: ch * Math.cos(rowLat(row)) }),
      note: 'Web Mercator pixel sizes were corrected for latitude (× cos φ per side).',
    };
  }
  if (isUtm(meta.epsg)) {
    return {
      cellArea: () => cw * ch,
      spacing: () => ({ dx: cw, dy: ch }),
      note: `Pixel sizes are in metres (EPSG:${meta.epsg}); UTM scale error is below 0.1 % within a zone.`,
    };
  }
  return null;
}
