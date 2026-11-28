import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import type { LatLngBounds } from './geo';
import type { ToolOutput } from './tools/registry';
import type { ReportRecord } from './types';

/** Most vertices kept for a report's outline; bigger results (thousands of water bodies) keep their bounding box. */
export const MAX_FOOTPRINT_VERTICES = 2000;

const ring = ([[s, w], [n, e]]: LatLngBounds): Position[] => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

function bboxOf(polys: Position[][][]): LatLngBounds | null {
  let s = 90,
    w = 180,
    n = -90,
    e = -180;
  for (const p of polys)
    for (const r of p)
      for (const [x, y] of r) {
        s = Math.min(s, y);
        n = Math.max(n, y);
        w = Math.min(w, x);
        e = Math.max(e, x);
      }
  return s <= n && w <= e
    ? [
        [s, w],
        [n, e],
      ]
    : null;
}

/**
 * Where a result lies, kept with its saved report for the map's "My areas": the result's polygons (a surveyed plot,
 * water bodies), else the analysed raster's footprint as a rectangle. Null when the result has no place (a table).
 */
export function reportFootprint(output: ToolOutput): Polygon | MultiPolygon | null {
  const polys: Position[][][] = [];
  for (const f of output.map?.geojson?.features ?? []) {
    const g = f.geometry as Geometry | null;
    if (g?.type === 'Polygon') polys.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') polys.push(...g.coordinates);
  }
  if (polys.length) {
    const vertices = polys.reduce((k, p) => k + p.reduce((m, r) => m + r.length, 0), 0);
    if (vertices <= MAX_FOOTPRINT_VERTICES) return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    const b = bboxOf(polys);
    return b ? { type: 'Polygon', coordinates: [ring(b)] } : null;
  }
  const b = output.map?.bounds;
  return b ? { type: 'Polygon', coordinates: [ring(b)] } : null;
}

/** Saved reports that know where they lie, as map features (id and title in the properties). */
export function areasFromReports(reports: ReportRecord[]): FeatureCollection {
  const features: Feature[] = reports
    // Imported project files may carry anything: only well-formed polygons are drawn.
    .filter(r => (r.footprint?.type === 'Polygon' || r.footprint?.type === 'MultiPolygon') && Array.isArray(r.footprint.coordinates))
    .map(r => ({ type: 'Feature', properties: { id: r.id, title: r.title }, geometry: r.footprint! }));
  return { type: 'FeatureCollection', features };
}
