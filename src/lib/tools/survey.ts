// Land survey: reads boundary / traverse files and measures them.
// Plot-sized features are measured in UTM (the zone of the feature's
// centroid) with a point-scale-factor correction; large features (over 3°
// of longitude) use spherical geometry on the authalic sphere.
import Papa from 'papaparse';
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import { initialBearing, latLonToUtm, toDms } from '../geo';
import { fmt } from '../stats';

const R_AUTHALIC = 6371007.2;
const ACRE_M2 = 4046.8564224;
const RAD = Math.PI / 180;

export type SurveyFormat = 'GeoJSON' | 'KML' | 'GPX' | 'CSV' | 'Shapefile';

export interface Leg {
  from: number;
  to: number;
  distance: number;
  bearing: number;
}

export interface Vertex {
  index: number;
  lat: number;
  lon: number;
  elevation: number | null;
  utm: string;
}

export interface MeasuredFeature {
  name: string;
  kind: 'Polygon' | 'Line' | 'Points';
  /** m² (polygons only) */
  area: number | null;
  /** Perimeter (polygons) or length (lines), metres. */
  length: number | null;
  vertices: Vertex[];
  legs: Leg[];
  centroid: [number, number];
  holes: number;
  method: string;
  elevation: { min: number; max: number } | null;
}

export interface SurveyResult {
  filename: string;
  format: SurveyFormat;
  features: MeasuredFeature[];
  geojson: FeatureCollection;
  bounds: [[number, number], [number, number]];
  warnings: string[];
}

// ── Parsing ────────────────────────────────────────────────────────────────

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
}

function parseKmlCoords(s: string): Position[] {
  return s
    .trim()
    .split(/\s+/)
    .map(t => t.split(',').map(Number))
    .filter(p => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(p => (p.length >= 3 && Number.isFinite(p[2]) ? [p[0], p[1], p[2]] : [p[0], p[1]]));
}

function parseXml(src: string, filename: string): Document {
  const doc = new DOMParser().parseFromString(src, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${filename} is not valid XML.`);
  return doc;
}

function byTag(root: Element | Document, tag: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', tag));
}

export function parseKml(src: string, filename: string): FeatureCollection {
  const doc = parseXml(src, filename);
  const features: Feature[] = [];
  byTag(doc, 'Placemark').forEach((pm, i) => {
    const name = text(byTag(pm, 'name')[0]) || `Placemark ${i + 1}`;
    for (const poly of byTag(pm, 'Polygon')) {
      const outer = byTag(byTag(poly, 'outerBoundaryIs')[0] ?? poly, 'coordinates')[0];
      const inners = byTag(poly, 'innerBoundaryIs').map(ib => parseKmlCoords(text(byTag(ib, 'coordinates')[0])));
      if (outer) features.push({ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [parseKmlCoords(text(outer)), ...inners] } });
    }
    for (const ls of byTag(pm, 'LineString')) features.push({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates: parseKmlCoords(text(byTag(ls, 'coordinates')[0])) } });
    for (const pt of byTag(pm, 'Point')) {
      const c = parseKmlCoords(text(byTag(pt, 'coordinates')[0]))[0];
      if (c) features.push({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: c } });
    }
  });
  return { type: 'FeatureCollection', features };
}

export function parseGpx(src: string, filename: string): FeatureCollection {
  const doc = parseXml(src, filename);
  const pt = (el: Element): Position => {
    const lat = Number(el.getAttribute('lat'));
    const lon = Number(el.getAttribute('lon'));
    const ele = Number(text(byTag(el, 'ele')[0]));
    return Number.isFinite(ele) && text(byTag(el, 'ele')[0]) !== '' ? [lon, lat, ele] : [lon, lat];
  };
  const features: Feature[] = [];
  byTag(doc, 'trk').forEach((trk, i) => {
    const name = text(byTag(trk, 'name')[0]) || `Track ${i + 1}`;
    byTag(trk, 'trkseg').forEach(seg => features.push({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates: byTag(seg, 'trkpt').map(pt) } }));
  });
  byTag(doc, 'rte').forEach((rte, i) => {
    features.push({ type: 'Feature', properties: { name: text(byTag(rte, 'name')[0]) || `Route ${i + 1}` }, geometry: { type: 'LineString', coordinates: byTag(rte, 'rtept').map(pt) } });
  });
  const wpts = byTag(doc, 'wpt');
  if (wpts.length) features.push({ type: 'Feature', properties: { name: 'Waypoints' }, geometry: { type: 'MultiPoint', coordinates: wpts.map(pt) } });
  return { type: 'FeatureCollection', features };
}

const LAT_NAMES = ['lat', 'latitude', 'y', 'lat_dd', 'northing_dd'];
const LON_NAMES = ['lon', 'lng', 'long', 'longitude', 'x', 'lon_dd'];
const ELE_NAMES = ['ele', 'elev', 'elevation', 'alt', 'altitude', 'z', 'height'];

/** CSV of coordinates in decimal degrees. With closeRing, three or more points form a boundary polygon. */
export function parseCoordinateCsv(src: string, filename: string, closeRing: boolean): FeatureCollection {
  const res = Papa.parse<Record<string, string>>(src, { header: true, skipEmptyLines: 'greedy' });
  const fields = (res.meta.fields ?? []).map(f => f.trim());
  const find = (names: string[]) => (res.meta.fields ?? []).find(f => names.includes(f.trim().toLowerCase()));
  const latKey = find(LAT_NAMES);
  const lonKey = find(LON_NAMES);
  const eleKey = find(ELE_NAMES);
  if (!latKey || !lonKey) throw new Error(`${filename} needs latitude and longitude columns (for example "lat" and "lon"). Found: ${fields.join(', ') || 'no header'}.`);
  const pts: Position[] = [];
  let bad = 0;
  for (const row of res.data) {
    const lat = Number(row[latKey]);
    const lon = Number(row[lonKey]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      bad++;
      continue;
    }
    const ele = eleKey ? Number(row[eleKey]) : NaN;
    pts.push(Number.isFinite(ele) && row[eleKey!] !== '' ? [lon, lat, ele] : [lon, lat]);
  }
  if (!pts.length) throw new Error(`${filename} has no valid decimal-degree coordinates.`);
  const name = filename.replace(/\.[^.]+$/, '');
  const geometry: Geometry =
    closeRing && pts.length >= 3 ? { type: 'Polygon', coordinates: [[...pts, pts[0]]] } : pts.length >= 2 ? { type: 'LineString', coordinates: pts } : { type: 'Point', coordinates: pts[0] };
  const fc: FeatureCollection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name }, geometry }] };
  if (bad) (fc as FeatureCollection & { warnings?: string[] }).warnings = [`${bad} row${bad === 1 ? '' : 's'} without valid coordinates were skipped.`];
  return fc;
}

export async function parseSurveyFile(file: File, closeRing: boolean): Promise<{ fc: FeatureCollection; format: SurveyFormat; warnings: string[] }> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const warnings: string[] = [];
  let fc: FeatureCollection;
  let format: SurveyFormat;
  if (ext === 'geojson' || ext === 'json') {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} is not valid JSON.`);
    }
    const j = json as { type?: string; crs?: { properties?: { name?: string } } };
    if (j.crs?.properties?.name && !/4326|CRS84/i.test(j.crs.properties.name)) {
      throw new Error(`${file.name} declares CRS "${j.crs.properties.name}". GeoJSON must be in WGS84 longitude/latitude (RFC 7946); re-export it as EPSG:4326.`);
    }
    if (j.type === 'FeatureCollection') fc = json as FeatureCollection;
    else if (j.type === 'Feature') fc = { type: 'FeatureCollection', features: [json as Feature] };
    else if (j.type) fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: json as Geometry }] };
    else throw new Error(`${file.name} is JSON but not GeoJSON.`);
    format = 'GeoJSON';
  } else if (ext === 'kml') {
    fc = parseKml(await file.text(), file.name);
    format = 'KML';
  } else if (ext === 'kmz') {
    throw new Error('KMZ is a zipped KML. Unzip it and upload the .kml file inside.');
  } else if (ext === 'gpx') {
    fc = parseGpx(await file.text(), file.name);
    format = 'GPX';
  } else if (ext === 'csv' || ext === 'txt') {
    fc = parseCoordinateCsv(await file.text(), file.name, closeRing);
    warnings.push(...((fc as FeatureCollection & { warnings?: string[] }).warnings ?? []));
    format = 'CSV';
  } else if (ext === 'zip') {
    const buf = await file.arrayBuffer();
    const members = zipMembers(buf, file.name);
    const need = ['.shp', '.shx', '.dbf'].filter(x => !members.some(m => m.toLowerCase().endsWith(x)));
    if (need.length) throw new Error(`${file.name} is missing ${need.join(', ')}. Zip the .shp, .shx, .dbf and .prj files of the shapefile together.`);
    fc = { type: 'FeatureCollection', features: await parseShapefileInWorker(buf, file.name) };
    format = 'Shapefile';
    warnings.push('Shapefile coordinates were reprojected to WGS84 using the .prj file in the zip (assumed WGS84 if none was included).');
  } else if (ext === 'shp') {
    throw new Error('Upload the shapefile as a .zip containing the .shp, .shx, .dbf and .prj files together.');
  } else {
    throw new Error(`“.${ext || '?'}” is not a supported survey format. Use GeoJSON, KML, GPX, CSV (lat/lon) or a zipped shapefile.`);
  }
  if (!fc.features.length) throw new Error(`${file.name} contains no features.`);
  return { fc, format, warnings };
}

/**
 * Lists the file names in a zip by reading its central directory, and
 * rejects anything that is not a structurally valid zip.
 */
export function zipMembers(buf: ArrayBuffer, filename: string): string[] {
  const v = new DataView(buf);
  const bad = () => new Error(`${filename} is not a valid zip file.`);
  if (buf.byteLength < 22 || v.getUint32(0, true) !== 0x04034b50) throw bad();
  // End-of-central-directory record: within the last 65,557 bytes.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.byteLength || v.getUint32(p, true) !== 0x02014b50) throw bad();
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const comment = v.getUint16(p + 32, true);
    if (p + 46 + nameLen > buf.byteLength) throw bad();
    names.push(dec.decode(new Uint8Array(buf, p + 46, nameLen)));
    p += 46 + nameLen + extra + comment;
  }
  return names;
}

const SHAPEFILE_TIMEOUT_MS = 20_000;

async function parseShapefileInWorker(buf: ArrayBuffer, filename: string): Promise<Feature[]> {
  if (typeof Worker === 'undefined') {
    const { default: shp } = await import('shpjs');
    const out = await shp(buf);
    return (Array.isArray(out) ? out : [out]).flatMap(x => x.features);
  }
  const { default: ShapefileWorker } = await import('../../workers/shapefile.worker?worker&inline');
  const worker: Worker = new ShapefileWorker();
  try {
    return await new Promise<Feature[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${filename} took too long to read and was stopped. Check that the shapefile is not corrupted.`)), SHAPEFILE_TIMEOUT_MS);
      worker.onmessage = (e: MessageEvent<{ ok: boolean; features?: Feature[]; error?: string }>) => {
        clearTimeout(timer);
        if (e.data.ok) resolve(e.data.features ?? []);
        else reject(new Error(`${filename} could not be read as a shapefile: ${e.data.error}`));
      };
      worker.onerror = e => {
        clearTimeout(timer);
        reject(new Error(`${filename} could not be read as a shapefile: ${e.message}`));
      };
      worker.postMessage(buf);
    });
  } finally {
    worker.terminate();
  }
}

// ── Measurement ────────────────────────────────────────────────────────────

function ringIsClosed(r: Position[]): boolean {
  return r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1];
}

function openRing(r: Position[]): Position[] {
  return ringIsClosed(r) ? r.slice(0, -1) : r;
}

/** Spherical polygon area (Chamberlain & Duquette 2007) on the authalic sphere, m². */
function sphericalRingArea(ring: Position[]): number {
  const r = openRing(ring);
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    const prev = r[(i - 1 + r.length) % r.length];
    const next = r[(i + 1) % r.length];
    sum += (next[0] - prev[0]) * RAD * Math.sin(r[i][1] * RAD);
  }
  return Math.abs((sum * R_AUTHALIC * R_AUTHALIC) / 2);
}

function haversine(a: Position, b: Position): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_AUTHALIC * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Planar {
  zone: number;
  project: (p: Position) => { x: number; y: number; k: number };
}

function planarFor(points: Position[]): Planar | null {
  const lons = points.map(p => p[0]);
  if (Math.max(...lons) - Math.min(...lons) > 3) return null;
  const lat = points.reduce((s, p) => s + p[1], 0) / points.length;
  const lon = lons.reduce((s, v) => s + v, 0) / lons.length;
  const zone = latLonToUtm(lat, lon).zone;
  return {
    zone,
    project: p => {
      const u = latLonToUtm(p[1], p[0], zone);
      // Northern-hemisphere style northing keeps rings continuous across the equator.
      return { x: u.easting, y: u.south ? u.northing - 10000000 : u.northing, k: u.k };
    },
  };
}

function ringMeasure(ring: Position[], planar: Planar | null): { area: number; perimeter: number; legs: number[] } {
  const r = openRing(ring);
  if (planar) {
    const xy = r.map(planar.project);
    let a2 = 0;
    let per = 0;
    const legs: number[] = [];
    for (let i = 0; i < xy.length; i++) {
      const p = xy[i];
      const q = xy[(i + 1) % xy.length];
      a2 += p.x * q.y - q.x * p.y;
      const k = (p.k + q.k) / 2;
      const d = Math.hypot(q.x - p.x, q.y - p.y) / k;
      legs.push(d);
      per += d;
    }
    const kMean = xy.reduce((s, p) => s + p.k, 0) / xy.length;
    return { area: Math.abs(a2 / 2) / (kMean * kMean), perimeter: per, legs };
  }
  const legs = r.map((p, i) => haversine(p, r[(i + 1) % r.length]));
  return { area: sphericalRingArea(r), perimeter: legs.reduce((s, v) => s + v, 0), legs };
}

function lineMeasure(line: Position[], planar: Planar | null): number[] {
  const legs: number[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    if (planar) {
      const p = planar.project(line[i]);
      const q = planar.project(line[i + 1]);
      legs.push(Math.hypot(q.x - p.x, q.y - p.y) / ((p.k + q.k) / 2));
    } else legs.push(haversine(line[i], line[i + 1]));
  }
  return legs;
}

function vertexList(points: Position[]): Vertex[] {
  return points.map((p, i) => {
    const u = latLonToUtm(p[1], p[0]);
    return {
      index: i + 1,
      lat: p[1],
      lon: p[0],
      elevation: p.length >= 3 && Number.isFinite(p[2]) && !points.every(q => q[2] === 0) ? p[2] : null,
      utm: `${u.zone}${u.south ? 'S' : 'N'} ${Math.round(u.easting)} E ${Math.round(u.northing)} N`,
    };
  });
}

function legsFor(points: Position[], distances: number[], closed: boolean): Leg[] {
  return distances.map((d, i) => {
    const j = closed ? (i + 1) % points.length : i + 1;
    return { from: i + 1, to: j + 1, distance: d, bearing: initialBearing(points[i][1], points[i][0], points[j][1], points[j][0]) };
  });
}

function elevRange(points: Position[]): { min: number; max: number } | null {
  const e = points.map(p => p[2]).filter((v): v is number => Number.isFinite(v));
  // All-zero altitudes are placeholders (e.g. KML clampToGround), not measurements.
  if (!e.length || e.every(v => v === 0)) return null;
  return { min: Math.min(...e), max: Math.max(...e) };
}

function centroidOf(points: Position[]): [number, number] {
  const n = points.length || 1;
  return [points.reduce((s, p) => s + p[1], 0) / n, points.reduce((s, p) => s + p[0], 0) / n];
}

const METHOD_PLANAR = (zone: number) => `UTM zone ${zone} (WGS84) with point-scale-factor correction`;
const METHOD_SPHERE = 'spherical geometry on the WGS84 authalic sphere (feature spans more than 3° of longitude)';

function measureGeometry(name: string, g: Geometry): MeasuredFeature[] {
  switch (g.type) {
    case 'Polygon': {
      const outer = g.coordinates[0] ?? [];
      if (openRing(outer).length < 3) return [];
      const planar = planarFor(outer);
      const o = ringMeasure(outer, planar);
      const holes = g.coordinates.slice(1).filter(h => openRing(h).length >= 3);
      const holeArea = holes.reduce((s, h) => s + ringMeasure(h, planar).area, 0);
      const pts = openRing(outer);
      return [
        {
          name,
          kind: 'Polygon',
          area: Math.max(0, o.area - holeArea),
          length: o.perimeter,
          vertices: vertexList(pts),
          legs: legsFor(pts, o.legs, true),
          centroid: centroidOf(pts),
          holes: holes.length,
          method: planar ? METHOD_PLANAR(planar.zone) : METHOD_SPHERE,
          elevation: elevRange(pts),
        },
      ];
    }
    case 'MultiPolygon':
      return g.coordinates.flatMap((poly, i) => measureGeometry(`${name} (part ${i + 1})`, { type: 'Polygon', coordinates: poly }));
    case 'LineString': {
      if (g.coordinates.length < 2) return [];
      const planar = planarFor(g.coordinates);
      const legs = lineMeasure(g.coordinates, planar);
      return [
        {
          name,
          kind: 'Line',
          area: null,
          length: legs.reduce((s, v) => s + v, 0),
          vertices: vertexList(g.coordinates),
          legs: legsFor(g.coordinates, legs, false),
          centroid: centroidOf(g.coordinates),
          holes: 0,
          method: planar ? METHOD_PLANAR(planar.zone) : METHOD_SPHERE,
          elevation: elevRange(g.coordinates),
        },
      ];
    }
    case 'MultiLineString':
      return g.coordinates.flatMap((l, i) => measureGeometry(`${name} (part ${i + 1})`, { type: 'LineString', coordinates: l }));
    case 'Point':
    case 'MultiPoint': {
      const pts = g.type === 'Point' ? [g.coordinates] : g.coordinates;
      return [{ name, kind: 'Points', area: null, length: null, vertices: vertexList(pts), legs: [], centroid: centroidOf(pts), holes: 0, method: 'point positions', elevation: elevRange(pts) }];
    }
    case 'GeometryCollection':
      return g.geometries.flatMap((x, i) => measureGeometry(`${name} (${i + 1})`, x));
    default:
      return [];
  }
}

export function measureSurvey(filename: string, format: SurveyFormat, fc: FeatureCollection, warnings: string[]): SurveyResult {
  const features: MeasuredFeature[] = [];
  fc.features.forEach((f, i) => {
    if (!f.geometry) return;
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const name = String(props.name ?? props.Name ?? props.NAME ?? props.id ?? `Feature ${i + 1}`);
    features.push(...measureGeometry(name, f.geometry));
  });
  if (!features.length) throw new Error(`${filename} has no measurable polygons, lines or points.`);
  const all = features.flatMap(f => f.vertices);
  const lats = all.map(v => v.lat);
  const lons = all.map(v => v.lon);
  if (lats.some(v => Math.abs(v) > 90) || lons.some(v => Math.abs(v) > 180)) {
    throw new Error(`${filename} has coordinates outside longitude/latitude ranges; it is probably in a projected CRS. Re-export it in WGS84 (EPSG:4326).`);
  }
  return {
    filename,
    format,
    features,
    geojson: fc,
    bounds: [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ],
    warnings,
  };
}

export function formatAreaM2(m2: number): string {
  if (m2 < 10_000) return `${fmt(m2, 5)} m² (${fmt(m2 / 10_000, 4)} ha, ${fmt(m2 / ACRE_M2, 4)} acres)`;
  return `${fmt(m2 / 10_000, 5)} ha (${fmt(m2 / ACRE_M2, 5)} acres${m2 >= 1e6 ? `, ${fmt(m2 / 1e6, 4)} km²` : ''})`;
}

export function formatLength(m: number): string {
  return m >= 1000 ? `${fmt(m / 1000, 5)} km` : `${fmt(m, 5)} m`;
}

export function surveyMarkdown(r: SurveyResult): string {
  const lines = ['## Dataset', '', `- File: ${r.filename} (${r.format}); ${r.features.length} feature${r.features.length === 1 ? '' : 's'}`, '', '## Results', ''];
  for (const f of r.features) {
    lines.push(`### ${f.name} (${f.kind.toLowerCase()})`, '');
    if (f.area !== null) lines.push(`- Area: ${formatAreaM2(f.area)}${f.holes ? ` (after subtracting ${f.holes} hole${f.holes === 1 ? '' : 's'})` : ''}`);
    if (f.length !== null) lines.push(`- ${f.kind === 'Polygon' ? 'Perimeter' : 'Length'}: ${formatLength(f.length)}`);
    lines.push(`- Vertices: ${f.vertices.length}; centroid ${toDms(f.centroid[0], 'N', 'S')}, ${toDms(f.centroid[1], 'E', 'W')}`);
    if (f.elevation) lines.push(`- Elevation range: ${fmt(f.elevation.min)}–${fmt(f.elevation.max)} m (from the file)`);
    lines.push(`- Method: ${f.method}`, '');
    if (f.legs.length && f.legs.length <= 60) {
      lines.push('| Leg | Distance | Bearing (true) |', '|---|---|---|', ...f.legs.map(l => `| ${l.from} → ${l.to} | ${fmt(l.distance, 5)} m | ${l.bearing.toFixed(1)}° |`), '');
    }
  }
  lines.push(
    '## Method and limits',
    '',
    '- Areas and distances are on the WGS84 ellipsoid via UTM with scale-factor correction (error well under 0.1 % for plots), or on the authalic sphere for very large features.',
    '- Bearings are initial great-circle bearings from true north; magnetic bearings differ by the local declination.',
    '- Accuracy is limited by the input coordinates: consumer GPS is typically 3–10 m, so small plots can carry large relative area errors.',
    ...r.warnings.map(w => `- ${w}`),
  );
  return lines.join('\n');
}
