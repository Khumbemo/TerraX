// Live data connectors (browser fetch, no keys needed):
//  • Open-Meteo Historical Weather API (ERA5 / ERA5-Land reanalysis),
//    https://open-meteo.com/en/docs/historical-weather-api
//  • NASA POWER daily point API (MERRA-2 / CERES), community AG,
//    https://power.larc.nasa.gov/docs/services/api/temporal/daily/
//  • Earth Search STAC (Element 84) for Sentinel-2 L2A cloud-optimised
//    GeoTIFFs, https://earth-search.aws.element84.com/v1
// Responses are converted to TerraX datasets; the parsing functions are
// pure so they can be tested on recorded responses.
import type { GeoTIFF } from 'geotiff';
import { latLonToUtm } from './geo';
import type { GeoMeta, Grid, OpenRaster } from './rasterio';

// ── Weather series ─────────────────────────────────────────────────────────

export const OPEN_METEO_VARS = [
  { id: 'precipitation_sum', label: 'Precipitation (mm)' },
  { id: 'temperature_2m_mean', label: 'Mean temperature (°C)' },
  { id: 'temperature_2m_max', label: 'Maximum temperature (°C)' },
  { id: 'temperature_2m_min', label: 'Minimum temperature (°C)' },
  { id: 'relative_humidity_2m_mean', label: 'Mean relative humidity (%)' },
  { id: 'et0_fao_evapotranspiration', label: 'Reference ET₀, FAO-56 (mm)' },
  { id: 'shortwave_radiation_sum', label: 'Solar radiation (MJ/m²)' },
] as const;

export const POWER_VARS = [
  { id: 'PRECTOTCORR', label: 'Precipitation, bias-corrected (mm/day)' },
  { id: 'T2M', label: 'Temperature at 2 m (°C)' },
  { id: 'T2M_MAX', label: 'Maximum temperature (°C)' },
  { id: 'T2M_MIN', label: 'Minimum temperature (°C)' },
  { id: 'RH2M', label: 'Relative humidity at 2 m (%)' },
  { id: 'ALLSKY_SFC_SW_DWN', label: 'All-sky solar radiation (MJ/m²/day)' },
] as const;

const isoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function checkRange(lat: number, lon: number, start: string, end: string) {
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) throw new Error('Latitude must be within ±90° and longitude within ±180°.');
  if (!isoDate(start) || !isoDate(end) || start > end) throw new Error('Choose a start date before the end date (YYYY-MM-DD).');
}

export function openMeteoUrl(lat: number, lon: number, start: string, end: string, vars: string[]): string {
  checkRange(lat, lon, start, end);
  if (!vars.length) throw new Error('Choose at least one variable.');
  const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: start, end_date: end, daily: vars.join(','), timezone: 'auto' });
  return `https://archive-api.open-meteo.com/v1/archive?${q}`;
}

export function powerUrl(lat: number, lon: number, start: string, end: string, vars: string[]): string {
  checkRange(lat, lon, start, end);
  if (!vars.length) throw new Error('Choose at least one variable.');
  const q = new URLSearchParams({ parameters: vars.join(','), community: 'AG', latitude: lat.toFixed(4), longitude: lon.toFixed(4), start: start.replace(/-/g, ''), end: end.replace(/-/g, ''), format: 'JSON' });
  return `https://power.larc.nasa.gov/api/temporal/daily/point?${q}`;
}

const csvCell = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '' : String(v));
const colName = (id: string, unit: string | undefined) => (unit ? `${id} (${unit})` : id);

/** Open-Meteo archive JSON → CSV text (date column plus one column per variable). */
export function openMeteoToCsv(json: unknown): { csv: string; note: string } {
  const j = json as { error?: boolean; reason?: string; latitude?: number; longitude?: number; elevation?: number; daily?: Record<string, unknown[]>; daily_units?: Record<string, string> };
  if (j?.error) throw new Error(`Open-Meteo: ${j.reason ?? 'request rejected'}`);
  const daily = j?.daily;
  if (!daily || !Array.isArray(daily.time)) throw new Error('Open-Meteo returned no daily data.');
  const vars = Object.keys(daily).filter(k => k !== 'time');
  const head = ['date', ...vars.map(v => colName(v, j.daily_units?.[v]))];
  const rows = (daily.time as string[]).map((t, i) => [t, ...vars.map(v => csvCell(daily[v][i] as number | null))].join(','));
  return {
    csv: [head.join(','), ...rows].join('\n'),
    note: `Open-Meteo Historical Weather API (ERA5/ERA5-Land reanalysis), grid cell centred near ${j.latitude?.toFixed(3)}°, ${j.longitude?.toFixed(3)}° (model elevation ${j.elevation ?? '?'} m). Reanalysis is a gridded model estimate, not a station record; local rainfall in hilly terrain can differ considerably.`,
  };
}

/** NASA POWER daily point JSON → CSV text; the fill value −999 becomes empty. */
export function powerToCsv(json: unknown): { csv: string; note: string } {
  const j = json as {
    messages?: string[];
    errors?: string[];
    geometry?: { coordinates?: number[] };
    properties?: { parameter?: Record<string, Record<string, number>> };
    parameters?: Record<string, { units?: string; longname?: string }>;
    header?: { fill_value?: number };
  };
  if (j?.errors?.length) throw new Error(`NASA POWER: ${j.errors.join('; ')}`);
  const p = j?.properties?.parameter;
  if (!p || !Object.keys(p).length) throw new Error(`NASA POWER returned no data${j?.messages?.length ? `: ${j.messages.join('; ')}` : '.'}`);
  const fill = j.header?.fill_value ?? -999;
  const vars = Object.keys(p);
  const dates = [...new Set(vars.flatMap(v => Object.keys(p[v])))].sort();
  const head = ['date', ...vars.map(v => colName(v, j.parameters?.[v]?.units))];
  const rows = dates.map(d => {
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    return [iso, ...vars.map(v => {
      const x = p[v][d];
      return x === undefined || x === fill ? '' : csvCell(x);
    })].join(',');
  });
  const [lon, lat] = j.geometry?.coordinates ?? [];
  return {
    csv: [head.join(','), ...rows].join('\n'),
    note: `NASA POWER daily point data (community AG; MERRA-2 meteorology and CERES/GEWEX radiation, about 0.5° × 0.625° grid) for ${lat ?? '?'}°, ${lon ?? '?'}°. Values are grid-cell estimates; −999 fill values were left empty.`,
  };
}

// ── Sentinel-2 via STAC ────────────────────────────────────────────────────

export const EARTH_SEARCH = 'https://earth-search.aws.element84.com/v1';

export interface StacItem {
  id: string;
  datetime: string;
  cloud: number | null;
  epsg: number | null;
  assets: Record<string, { href: string; scale?: number; offset?: number }>;
  processingBaseline: string | null;
}

export function stacSearchBody(bbox: [number, number, number, number], start: string, end: string, maxCloud: number, limit = 12) {
  if (!isoDate(start) || !isoDate(end) || start > end) throw new Error('Choose a start date before the end date.');
  return {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit,
  };
}

/** Parses a STAC ItemCollection into the fields TerraX needs. */
export function parseStacItems(json: unknown): StacItem[] {
  const fc = json as { features?: unknown[] };
  if (!fc || !Array.isArray(fc.features)) throw new Error('The STAC server returned an unexpected response.');
  return fc.features.map(raw => {
    const f = raw as { id: string; properties: Record<string, unknown>; assets: Record<string, { href: string; 'raster:bands'?: { scale?: number; offset?: number }[] }> };
    const props = f.properties ?? {};
    const code = (props['proj:epsg'] as number | undefined) ?? (typeof props['proj:code'] === 'string' ? Number(String(props['proj:code']).replace(/^EPSG:/i, '')) : undefined);
    const assets: StacItem['assets'] = {};
    for (const [k, a] of Object.entries(f.assets ?? {})) {
      if (!a?.href) continue;
      const rb = a['raster:bands']?.[0];
      assets[k] = { href: a.href, scale: rb?.scale, offset: rb?.offset };
    }
    return {
      id: f.id,
      datetime: String(props.datetime ?? ''),
      cloud: typeof props['eo:cloud_cover'] === 'number' ? (props['eo:cloud_cover'] as number) : null,
      epsg: Number.isFinite(code) ? (code as number) : null,
      assets,
      processingBaseline: typeof props['s2:processing_baseline'] === 'string' ? (props['s2:processing_baseline'] as string) : null,
    };
  });
}

/** Scale and offset that turn digital numbers into surface reflectance. */
export function reflectanceTransform(item: StacItem, asset: string): { scale: number; offset: number; note: string } {
  const a = item.assets[asset];
  if (a?.scale !== undefined) return { scale: a.scale, offset: a.offset ?? 0, note: 'Reflectance = DN × scale + offset from the STAC raster:bands metadata.' };
  // ESA processing baseline 04.00 (25 Jan 2022) added BOA_ADD_OFFSET = −1000.
  const pb = item.processingBaseline ? Number(item.processingBaseline) : NaN;
  if (pb >= 4) return { scale: 1e-4, offset: -0.1, note: 'Reflectance = (DN − 1000) / 10,000 (processing baseline ≥ 04.00).' };
  return { scale: 1e-4, offset: 0, note: 'Reflectance = DN / 10,000.' };
}

const S2_ASSETS = [
  { key: 'blue', res: 10 },
  { key: 'green', res: 10 },
  { key: 'red', res: 10 },
  { key: 'nir', res: 10 },
  { key: 'scl', res: 20 },
];

export const S2_MAX_SIDE = 1500;

/**
 * Reads a window of Sentinel-2 bands (B2, B3, B4, B8 at 10 m, SCL at 20 m
 * resampled to 10 m) covering `bbox` (WGS84) and returns an in-memory raster
 * with bands blue, green, red, NIR (reflectance) and SCL.
 */
export async function readS2Window(item: StacItem, bbox: [number, number, number, number], open: (href: string) => Promise<GeoTIFF>): Promise<{ raster: OpenRaster; notes: string[] }> {
  if (!item.epsg || !((item.epsg >= 32601 && item.epsg <= 32660) || (item.epsg >= 32701 && item.epsg <= 32760))) throw new Error('This scene is not in a WGS84 UTM projection.');
  const missing = S2_ASSETS.filter(a => !item.assets[a.key]).map(a => a.key);
  if (missing.length) throw new Error(`The scene lacks assets: ${missing.join(', ')}.`);
  const zone = item.epsg % 100, south = item.epsg >= 32701;
  const corners = [
    [bbox[1], bbox[0]],
    [bbox[1], bbox[2]],
    [bbox[3], bbox[0]],
    [bbox[3], bbox[2]],
  ].map(([lat, lon]) => {
    const u = latLonToUtm(lat, lon, zone);
    return [u.easting, south && !u.south ? u.northing + 10_000_000 : !south && u.south ? u.northing - 10_000_000 : u.northing];
  });
  const minE = Math.min(...corners.map(c => c[0])), maxE = Math.max(...corners.map(c => c[0]));
  const minN = Math.min(...corners.map(c => c[1])), maxN = Math.max(...corners.map(c => c[1]));
  const grids: Float32Array[] = [];
  let gw = 0, gh = 0, x0e = 0, y0n = 0;
  const notes: string[] = [];
  for (const a of S2_ASSETS) {
    const tiff = await open(item.assets[a.key].href);
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution(); // ry is negative for north-up images
    const px0 = Math.max(0, Math.floor((minE - ox) / rx));
    const px1 = Math.min(img.getWidth(), Math.ceil((maxE - ox) / rx));
    const py0 = Math.max(0, Math.floor((maxN - oy) / ry));
    const py1 = Math.min(img.getHeight(), Math.ceil((minN - oy) / ry));
    if (px1 <= px0 || py1 <= py0) throw new Error('The area does not overlap this scene.');
    if (a.res === 10) {
      if (!gw) {
        gw = px1 - px0;
        gh = py1 - py0;
        if (Math.max(gw, gh) > S2_MAX_SIDE) throw new Error(`The area is ${gw} × ${gh} pixels at 10 m; choose an area under ${(S2_MAX_SIDE * 10) / 1000} km across.`);
        x0e = ox + px0 * rx;
        y0n = oy + py0 * ry;
      }
      const [band] = (await img.readRasters({ window: [px0, py0, px0 + gw, py0 + gh], interleave: false })) as unknown as ArrayLike<number>[];
      const t = reflectanceTransform(item, a.key);
      if (a.key === 'blue') notes.push(t.note);
      const out = new Float32Array(gw * gh);
      for (let k = 0; k < out.length; k++) out[k] = band[k] === 0 ? NaN : band[k] * t.scale + t.offset;
      grids.push(out);
    } else {
      // SCL at 20 m: read the matching window and repeat each pixel onto the 10 m grid.
      const sx0 = Math.floor((x0e - ox) / rx), sy0 = Math.floor((y0n - oy) / ry);
      const sw = Math.ceil(gw / 2) + 1, sh = Math.ceil(gh / 2) + 1;
      const win: [number, number, number, number] = [Math.max(0, sx0), Math.max(0, sy0), Math.min(img.getWidth(), sx0 + sw), Math.min(img.getHeight(), sy0 + sh)];
      const [scl] = (await img.readRasters({ window: win, interleave: false })) as unknown as ArrayLike<number>[];
      const ww = win[2] - win[0];
      const out = new Float32Array(gw * gh);
      for (let r = 0; r < gh; r++)
        for (let c = 0; c < gw; c++) {
          const e = x0e + (c + 0.5) * 10, n = y0n - (r + 0.5) * 10;
          const sc = Math.floor((e - ox) / rx) - win[0], sr = Math.floor((n - oy) / ry) - win[1];
          out[r * gw + c] = sc >= 0 && sr >= 0 && sc < ww && sr < win[3] - win[1] ? scl[sr * ww + sc] : NaN;
        }
      grids.push(out);
    }
  }
  const name = `${item.id}.tif`;
  const meta: GeoMeta = {
    filename: name,
    sizeBytes: gw * gh * 4 * grids.length,
    width: gw,
    height: gh,
    bands: grids.length,
    noData: null,
    bbox: [x0e, y0n - gh * 10, x0e + gw * 10, y0n],
    epsg: item.epsg,
    geographic: false,
    latLngBounds: [
      [bbox[1], bbox[0]],
      [bbox[3], bbox[2]],
    ],
    pixelSize: [10, 10],
    warnings: [],
  };
  notes.push(`Sentinel-2 L2A scene ${item.id} (${item.datetime.slice(0, 10)}, ${item.cloud ?? '?'} % cloud over the tile) from Earth Search; bands B2, B3, B4, B8 at 10 m and SCL (band 5, resampled from 20 m).`);
  const raster: OpenRaster = {
    meta,
    readBands: async (indices: number[]): Promise<Grid[]> =>
      indices.map(i => {
        if (i < 0 || i >= grids.length) throw new Error(`Band ${i + 1} does not exist.`);
        return { width: gw, height: gh, data: new Float32Array(grids[i]), resampleFactor: 1 };
      }),
  };
  return { raster, notes };
}
