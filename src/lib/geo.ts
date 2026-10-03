// Coordinate conversions needed to place a GeoTIFF footprint on the map.

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;

/**
 * Inverse UTM (WGS84) using the series in Snyder (1987), "Map Projections —
 * A Working Manual", USGS PP 1395, eqs. 8-12 to 8-25. Sub-metre accuracy
 * within a zone.
 */
export function utmToLatLon(easting: number, northing: number, zone: number, south: boolean): [number, number] {
  const k0 = 0.9996;
  const a = WGS84_A;
  const e2 = WGS84_F * (2 - WGS84_F);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const y = south ? northing - 10000000 : northing;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);

  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const C1 = ep2 * cos1 * cos1;
  const T1 = tan1 * tan1;
  const N1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
  const R1 = (a * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
  const D = x / (N1 * k0);

  const lat =
    phi1 -
    ((N1 * tan1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon =
    lon0 +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / cos1;

  return [(lat * 180) / Math.PI, (lon * 180) / Math.PI];
}

/** Inverse spherical Web Mercator (EPSG:3857). */
export function webMercatorToLatLon(x: number, y: number): [number, number] {
  const lon = (x / WGS84_A) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / WGS84_A)) - Math.PI / 2) * (180 / Math.PI);
  return [lat, lon];
}

export type LatLngBounds = [[number, number], [number, number]];

/**
 * Converts a bounding box in the given EPSG code to WGS84 lat/lon bounds.
 * Supports geographic WGS84 (4326), Web Mercator (3857/900913) and WGS84 UTM
 * zones (326xx north, 327xx south). Returns null for other systems.
 */
export function bboxToLatLng(bbox: [number, number, number, number], epsg: number | null): LatLngBounds | null {
  const [minX, minY, maxX, maxY] = bbox;
  let corners: [number, number][] = [];
  if (epsg === 4326 || epsg === null) {
    if (minX < -180.001 || maxX > 180.001 || minY < -90.001 || maxY > 90.001) return null;
    return [
      [minY, minX],
      [maxY, maxX],
    ];
  } else if (epsg === 3857 || epsg === 900913) {
    corners = [
      [minX, minY],
      [maxX, maxY],
      [minX, maxY],
      [maxX, minY],
    ].map(([x, y]) => webMercatorToLatLon(x, y));
  } else if ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760)) {
    const south = epsg >= 32701;
    const zone = epsg % 100;
    corners = [
      [minX, minY],
      [maxX, maxY],
      [minX, maxY],
      [maxX, minY],
    ].map(([x, y]) => utmToLatLon(x, y, zone, south));
  } else {
    return null;
  }
  const lats = corners.map(c => c[0]);
  const lons = corners.map(c => c[1]);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

/** Forward UTM (WGS84), Krüger series to n⁴ (Karney 2011): sub-millimetre within a zone. */
export function latLonToUtm(lat: number, lon: number, forceZone?: number): { zone: number; south: boolean; easting: number; northing: number; k: number } {
  const zone = forceZone ?? Math.min(60, Math.floor((lon + 180) / 6) + 1);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const f = WGS84_F;
  const n = f / (2 - f);
  const A = (WGS84_A / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const alpha = [n / 2 - (2 / 3) * n * n + (5 / 16) * n ** 3 + (41 / 180) * n ** 4, (13 / 48) * n * n - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4, (61 / 240) * n ** 3 - (103 / 140) * n ** 4, (49561 / 161280) * n ** 4];
  const e = Math.sqrt(f * (2 - f));
  const phi = lat * (Math.PI / 180);
  const L = lon * (Math.PI / 180) - lon0;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(L));
  const eta = Math.atanh(Math.sin(L) / Math.sqrt(1 + t * t));
  let E = eta;
  let N = xi;
  for (let j = 0; j < 4; j++) {
    const i = j + 1;
    E += alpha[j] * Math.cos(2 * i * xi) * Math.sinh(2 * i * eta);
    N += alpha[j] * Math.sin(2 * i * xi) * Math.cosh(2 * i * eta);
  }
  const k0 = 0.9996;
  const easting = k0 * A * E + 500000;
  const south = lat < 0;
  const northing = k0 * A * N + (south ? 10000000 : 0);
  // Point scale factor, second-order approximation (adequate for area/length correction).
  const x = (easting - 500000) / (k0 * 6371000);
  const k = k0 * (1 + (x * x) / 2);
  return { zone, south, easting, northing, k };
}

/** Initial great-circle bearing from point 1 to point 2, degrees clockwise from true north. */
export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

export function toDms(deg: number, pos: string, neg: string): string {
  const hemi = deg >= 0 ? pos : neg;
  let a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - m) * 60 * 100) / 100;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  a = d;
  return `${a}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″ ${hemi}`;
}
