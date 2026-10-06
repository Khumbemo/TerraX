// Zonal statistics: restrict raster analyses to an analysis boundary.
// The boundary (WGS84 GeoJSON polygons) is projected into the raster's CRS
// and rasterised with a scanline fill: a cell is inside when its centre is
// inside the polygon (even-odd rule, so holes are excluded).
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import { latLonToUtm } from './geo';
import type { GeoMeta, Grid } from './rasterio';

export interface Boundary {
  name: string;
  /** Polygons only, WGS84 longitude/latitude. */
  geojson: FeatureCollection<Polygon | MultiPolygon>;
  /** Area in m² (from the survey measurement). */
  areaM2: number;
}

const R_MERC = 6378137;

function isUtm(epsg: number | null): epsg is number {
  return epsg !== null && ((epsg >= 32601 && epsg <= 32660) || (epsg >= 32701 && epsg <= 32760));
}

/** Converts WGS84 lon/lat to the raster's CRS, or returns null when unsupported. */
export function projector(meta: GeoMeta): ((lon: number, lat: number) => [number, number]) | null {
  if (meta.geographic) return (lon, lat) => [lon, lat];
  if (meta.epsg === 3857 || meta.epsg === 900913) {
    return (lon, lat) => [R_MERC * lon * (Math.PI / 180), R_MERC * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  }
  if (isUtm(meta.epsg)) {
    const zone = meta.epsg % 100;
    const south = meta.epsg >= 32701;
    return (lon, lat) => {
      const u = latLonToUtm(lat, lon, zone);
      // Keep the raster's hemisphere convention even for points across the equator.
      return [u.easting, south ? (u.south ? u.northing : u.northing + 10_000_000) : u.south ? u.northing - 10_000_000 : u.northing];
    };
  }
  return null;
}

/** All rings (outer and holes) of every polygon, in WGS84. */
export function boundaryRings(fc: FeatureCollection): Position[][] {
  const rings: Position[][] = [];
  for (const f of fc.features as Feature[]) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') rings.push(...g.coordinates);
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) rings.push(...p);
  }
  return rings.filter(r => r.length >= 3);
}

export interface MaskResult {
  /** 1 inside the boundary, 0 outside, per grid cell. */
  mask: Uint8Array;
  inside: number;
}

/**
 * Rasterises the boundary onto an analysis grid. Throws when the CRS is not
 * supported or the boundary does not overlap the raster.
 */
export function boundaryMask(meta: GeoMeta, grid: Grid, boundary: Boundary): MaskResult {
  if (!meta.bbox) throw new Error('This raster has no georeferencing, so it cannot be clipped to a boundary.');
  const proj = projector(meta);
  if (!proj) throw new Error(`Clipping to a boundary needs a WGS84, Web Mercator or UTM raster (this one is ${meta.epsg ? `EPSG:${meta.epsg}` : 'in an unknown CRS'}).`);
  const [minX, minY, maxX, maxY] = meta.bbox;
  const cw = (maxX - minX) / grid.width;
  const ch = (maxY - minY) / grid.height;
  const rings = boundaryRings(boundary.geojson).map(r => r.map(p => proj(p[0], p[1])));
  // Edges in grid coordinates (col, row as continuous values).
  const edges: [number, number, number, number][] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      edges.push([(a[0] - minX) / cw, (maxY - a[1]) / ch, (b[0] - minX) / cw, (maxY - b[1]) / ch]);
    }
  }
  const mask = new Uint8Array(grid.width * grid.height);
  let inside = 0;
  const xs: number[] = [];
  for (let row = 0; row < grid.height; row++) {
    const y = row + 0.5;
    xs.length = 0;
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Cells whose centre (col + 0.5) lies in [xs[k], xs[k+1]).
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(grid.width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let c = c0; c <= c1; c++) {
        const idx = row * grid.width + c;
        if (!mask[idx]) {
          mask[idx] = 1;
          inside++;
        }
      }
    }
  }
  if (!inside) throw new Error(`The boundary “${boundary.name}” does not overlap ${meta.filename}. Check that both cover the same area.`);
  return { mask, inside };
}

/** Sets every cell outside the mask to NaN (in place) and returns the grid. */
export function applyMask(grid: Grid, mask: Uint8Array): Grid {
  for (let i = 0; i < grid.data.length; i++) if (!mask[i]) grid.data[i] = NaN;
  return grid;
}

/** Convenience: clip a grid to the boundary when one is set; returns a note for the report. */
export function clipToBoundary(meta: GeoMeta, grid: Grid, boundary: Boundary | null | undefined): string | null {
  if (!boundary) return null;
  const { mask, inside } = boundaryMask(meta, grid, boundary);
  applyMask(grid, mask);
  return `Limited to the analysis boundary “${boundary.name}” (${(boundary.areaM2 / 10_000).toFixed(2)} ha; ${inside.toLocaleString()} grid cells whose centres fall inside).`;
}
