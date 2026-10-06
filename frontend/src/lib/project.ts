// Project files: the analysis boundary, target location, saved reports and
// display preferences, exported as one JSON file and imported again.
// API keys and the session are never included.
import type { ReportRecord } from './types';
import type { Boundary } from './zonal';

export const PROJECT_FORMAT = 'terrax-project';
export const PROJECT_VERSION = 1;

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: number;
  exportedAt: string;
  target: { lat: number; lon: number; name: string } | null;
  boundary: Boundary | null;
  reports: ReportRecord[];
  preferences: Record<string, unknown>;
}

export function buildProject(p: Omit<Project, 'format' | 'version' | 'exportedAt'>): Project {
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, exportedAt: new Date().toISOString(), ...p };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validReport(r: unknown): r is ReportRecord {
  const x = r as ReportRecord;
  return Boolean(x) && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.content === 'string' && typeof x.createdAt === 'string' && typeof x.datasetName === 'string';
}

function validBoundary(b: unknown): b is Boundary {
  const x = b as Boundary;
  return (
    Boolean(x) &&
    typeof x.name === 'string' &&
    isNum(x.areaM2) &&
    x.geojson?.type === 'FeatureCollection' &&
    Array.isArray(x.geojson.features) &&
    x.geojson.features.every(f => f?.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'))
  );
}

/** Validates a parsed project file; throws with a clear message when it is not one. */
export function parseProject(json: unknown): Project {
  const p = json as Partial<Project>;
  if (!p || p.format !== PROJECT_FORMAT) throw new Error('This is not a TerraX project file.');
  if (!isNum(p.version) || p.version > PROJECT_VERSION) throw new Error(`This project was saved by a newer TerraX (format ${p.version}); update the app to open it.`);
  const target = p.target && isNum(p.target.lat) && isNum(p.target.lon) && Math.abs(p.target.lat) <= 90 && Math.abs(p.target.lon) <= 180 ? { lat: p.target.lat, lon: p.target.lon, name: String(p.target.name ?? 'Target') } : null;
  return {
    format: PROJECT_FORMAT,
    version: p.version,
    exportedAt: String(p.exportedAt ?? ''),
    target,
    boundary: validBoundary(p.boundary) ? p.boundary : null,
    reports: Array.isArray(p.reports) ? p.reports.filter(validReport) : [],
    preferences: p.preferences && typeof p.preferences === 'object' ? (p.preferences as Record<string, unknown>) : {},
  };
}

/** Merges imported reports into the current list: same id keeps the newer copy; newest first. */
export function mergeReports(current: ReportRecord[], incoming: ReportRecord[]): { reports: ReportRecord[]; added: number } {
  const byId = new Map(current.map(r => [r.id, r]));
  let added = 0;
  for (const r of incoming) {
    const old = byId.get(r.id);
    if (!old) added++;
    if (!old || r.createdAt > old.createdAt) byId.set(r.id, r);
  }
  return { reports: [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), added };
}
