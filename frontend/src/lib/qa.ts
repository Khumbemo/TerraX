// Cloud and quality masks from a scene's quality band (applied on the server, processing/rio.py).
//  • Sentinel-2 L2A Scene Classification (SCL): masks 0 no data,
//    1 saturated/defective, 3 cloud shadow, 8 cloud (medium probability),
//    9 cloud (high probability), 10 thin cirrus, 11 snow/ice (ESA L2A
//    product definition).
//  • Landsat Collection 2 QA_PIXEL bit flags: bit 0 fill, 1 dilated cloud,
//    2 cirrus, 3 cloud, 4 cloud shadow, 5 snow (USGS LSDS-1619).
export type QaKind = 'scl' | 'landsat';

export const QA_KINDS: Record<QaKind, { label: string; rule: string }> = {
  scl: { label: 'Sentinel-2 SCL', rule: 'SCL classes 0, 1, 3, 8, 9, 10 and 11 (no data, defective, cloud shadow, clouds, cirrus, snow)' },
  landsat: { label: 'Landsat QA_PIXEL', rule: 'QA_PIXEL bits 0–5 (fill, dilated cloud, cirrus, cloud, cloud shadow, snow)' },
};
