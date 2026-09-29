// Vector helpers: export survey features as GeoJSON, KML or GPX, build an
// analysis boundary from surveyed polygons, and turn drawn vertices into a
// polygon feature.
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import type { Boundary } from './zonal';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function featureName(f: Feature, i: number): string {
  const p = (f.properties ?? {}) as Record<string, unknown>;
  return String(p.name ?? p.Name ?? p.NAME ?? p.id ?? `Feature ${i + 1}`);
}

function kmlCoords(ring: Position[]): string {
  return ring.map(p => (p.length > 2 && Number.isFinite(p[2]) ? `${p[0]},${p[1]},${p[2]}` : `${p[0]},${p[1]}`)).join(' ');
}

function kmlGeometry(g: Geometry): string {
  switch (g.type) {
    case 'Point':
      return `<Point><coordinates>${kmlCoords([g.coordinates])}</coordinates></Point>`;
    case 'LineString':
      return `<LineString><coordinates>${kmlCoords(g.coordinates)}</coordinates></LineString>`;
    case 'Polygon': {
      const [outer, ...holes] = g.coordinates;
      return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(outer)}</coordinates></LinearRing></outerBoundaryIs>${holes
        .map(h => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(h)}</coordinates></LinearRing></innerBoundaryIs>`)
        .join('')}</Polygon>`;
    }
    case 'MultiPoint':
      return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: 'Point', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiLineString':
      return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: 'LineString', coordinates: c })).join('')}</MultiGeometry>`;
    case 'MultiPolygon':
      return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: 'Polygon', coordinates: c })).join('')}</MultiGeometry>`;
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map(kmlGeometry).join('')}</MultiGeometry>`;
  }
}

/** KML 2.2 document; coordinates stay WGS84 lon,lat[,alt]. */
export function toKml(fc: FeatureCollection, name: string): string {
  const placemarks = fc.features
    .filter(f => f.geometry)
    .map((f, i) => `  <Placemark><name>${esc(featureName(f, i))}</name>${kmlGeometry(f.geometry!)}</Placemark>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', `<Document><name>${esc(name)}</name>`, ...placemarks, '</Document>', '</kml>', ''].join('\n');
}

function gpxPt(tag: string, p: Position): string {
  const ele = p.length > 2 && Number.isFinite(p[2]) ? `<ele>${p[2]}</ele>` : '';
  return `<${tag} lat="${p[1]}" lon="${p[0]}">${ele}</${tag}>`;
}

/**
 * GPX 1.1. GPX has no polygon type, so polygon rings are written as closed
 * track segments; points become waypoints.
 */
export function toGpx(fc: FeatureCollection, name: string): string {
  const wpts: string[] = [];
  const trks: string[] = [];
  const addGeom = (g: Geometry, n: string) => {
    switch (g.type) {
      case 'Point':
        wpts.push(gpxPt('wpt', g.coordinates).replace('</wpt>', `<name>${esc(n)}</name></wpt>`));
        break;
      case 'MultiPoint':
        g.coordinates.forEach((c, i) => addGeom({ type: 'Point', coordinates: c }, `${n} ${i + 1}`));
        break;
      case 'LineString':
        trks.push(`<trk><name>${esc(n)}</name><trkseg>${g.coordinates.map(p => gpxPt('trkpt', p)).join('')}</trkseg></trk>`);
        break;
      case 'MultiLineString':
        trks.push(`<trk><name>${esc(n)}</name>${g.coordinates.map(l => `<trkseg>${l.map(p => gpxPt('trkpt', p)).join('')}</trkseg>`).join('')}</trk>`);
        break;
      case 'Polygon':
        trks.push(`<trk><name>${esc(n)}</name>${g.coordinates.map(r => `<trkseg>${r.map(p => gpxPt('trkpt', p)).join('')}</trkseg>`).join('')}</trk>`);
        break;
      case 'MultiPolygon':
        g.coordinates.forEach((c, i) => addGeom({ type: 'Polygon', coordinates: c }, `${n} (${i + 1})`));
        break;
      case 'GeometryCollection':
        g.geometries.forEach((x, i) => addGeom(x, `${n} (${i + 1})`));
        break;
    }
  };
  fc.features.forEach((f, i) => f.geometry && addGeom(f.geometry, featureName(f, i)));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="TerraX" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name></metadata>`,
    ...wpts,
    ...trks,
    '</gpx>',
    '',
  ].join('\n');
}

/** Polygon features only (GeometryCollections are unpacked). */
export function polygonFeatures(fc: FeatureCollection): FeatureCollection<Polygon | MultiPolygon> {
  const out: Feature<Polygon | MultiPolygon>[] = [];
  const add = (g: Geometry, props: Feature['properties']) => {
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') out.push({ type: 'Feature', properties: props, geometry: g });
    else if (g.type === 'GeometryCollection') g.geometries.forEach(x => add(x, props));
  };
  fc.features.forEach(f => f.geometry && add(f.geometry, f.properties));
  return { type: 'FeatureCollection', features: out };
}

/** Builds an analysis boundary; `areaM2` comes from the survey measurement. */
export function makeBoundary(name: string, fc: FeatureCollection, areaM2: number): Boundary | null {
  const polys = polygonFeatures(fc);
  if (!polys.features.length) return null;
  return { name, geojson: polys, areaM2 };
}

/** Closed polygon from drawn vertices given as [lat, lon]. */
export function drawnPolygon(points: [number, number][], name: string): FeatureCollection<Polygon> {
  if (points.length < 3) throw new Error('A polygon needs at least three points.');
  const ring = points.map(([lat, lon]) => [lon, lat]);
  ring.push([...ring[0]]);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}

/** Outer-ring vertices of the first polygon as [lat, lon] (for editing), without the closing point. */
export function editableVertices(fc: FeatureCollection): [number, number][] | null {
  const poly = polygonFeatures(fc).features[0];
  if (!poly) return null;
  const ring = poly.geometry.type === 'Polygon' ? poly.geometry.coordinates[0] : poly.geometry.coordinates[0][0];
  const pts = ring.map(p => [p[1], p[0]] as [number, number]);
  const [f, l] = [pts[0], pts[pts.length - 1]];
  if (pts.length > 1 && f[0] === l[0] && f[1] === l[1]) pts.pop();
  return pts;
}
