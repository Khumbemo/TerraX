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
