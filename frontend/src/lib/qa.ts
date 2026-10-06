// Cloud and quality masks from a scene's quality band.
//  • Sentinel-2 L2A Scene Classification (SCL): masks 0 no data,
//    1 saturated/defective, 3 cloud shadow, 8 cloud (medium probability),
//    9 cloud (high probability), 10 thin cirrus, 11 snow/ice (ESA L2A
//    product definition).
//  • Landsat Collection 2 QA_PIXEL bit flags: bit 0 fill, 1 dilated cloud,
//    2 cirrus, 3 cloud, 4 cloud shadow, 5 snow (USGS LSDS-1619).
import type { Grid, OpenRaster } from './rasterio';

export type QaKind = 'scl' | 'landsat';

export interface QaMask {
  band: number;
  kind: QaKind;
}

export const QA_KINDS: Record<QaKind, { label: string; rule: string }> = {
  scl: { label: 'Sentinel-2 SCL', rule: 'SCL classes 0, 1, 3, 8, 9, 10 and 11 (no data, defective, cloud shadow, clouds, cirrus, snow)' },
  landsat: { label: 'Landsat QA_PIXEL', rule: 'QA_PIXEL bits 0–5 (fill, dilated cloud, cirrus, cloud, cloud shadow, snow)' },
};

const SCL_MASKED = new Set([0, 1, 3, 8, 9, 10, 11]);

export function isMasked(kind: QaKind, v: number): boolean {
  if (Number.isNaN(v)) return true;
  const q = Math.round(v);
  if (kind === 'scl') return SCL_MASKED.has(q);
  return (q & 0b111111) !== 0;
}

/** Reads the quality band and sets masked cells to NaN in every grid; returns the masked share of cells. */
export async function applyQa(raster: OpenRaster, grids: Grid[], qa: QaMask): Promise<{ fraction: number; note: string }> {
  const [q] = await raster.readBands([qa.band]);
  let n = 0;
  for (let k = 0; k < q.data.length; k++) {
    if (isMasked(qa.kind, q.data[k])) {
      n++;
      for (const g of grids) g.data[k] = NaN;
    }
  }
  const fraction = q.data.length ? n / q.data.length : 0;
  return { fraction, note: `Quality mask from band ${qa.band + 1} (${QA_KINDS[qa.kind].rule}) removed ${(fraction * 100).toFixed(1)} % of pixels.` };
}

/** Finds an acquisition date in a file name: 2024-03-15, 2024_03_15, 20240315 or 2024-075 (day of year). */
export function dateFromFilename(name: string): Date | null {
  const s = name.replace(/\.[^.]+$/, '');
  const ymd = s.match(/(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?![\d])/);
  if (ymd) {
    const d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    if (d.getUTCMonth() === Number(ymd[2]) - 1) return d;
  }
  const doy = s.match(/(?:^|[^\d])((?:19|20)\d{2})[-_]?(\d{3})(?![\d])/);
  if (doy) {
    const day = Number(doy[2]);
    if (day >= 1 && day <= 366) return new Date(Date.UTC(Number(doy[1]), 0, day));
  }
  return null;
}
