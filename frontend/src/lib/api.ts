// Client for the TerraX Python API (FastAPI). Files are uploaded once and
// referred to by id; analyses run as background jobs (Celery workers) that
// the browser polls until they finish. Result pictures, GeoJSON and CSV
// files are served from /api/jobs/{id}/artifacts/.
import { downloadBlob } from './download';
import type { LatLngBounds } from './geo';

/** Base URL of the API: empty for the same origin (the dev server and nginx proxy /api). */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export const apiUrl = (path: string) => (/^https?:\/\//.test(path) ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`);

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function detail(json: unknown, status: number): string {
  const d = (json as { detail?: unknown })?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d) && d.length) {
    const first = d[0] as { msg?: string; loc?: unknown[] };
    return `Invalid request: ${first.loc?.slice(1).join('.') ?? ''} ${first.msg ?? ''}`.trim();
  }
  return status === 404 ? 'Not found on the server (it may have expired).' : `The server returned HTTP ${status}.`;
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      ...rest,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the TerraX server. Check that the API is running and your connection works.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(detail(body, res.status), res.status);
  return body as T;
}

// ── Files ────────────────────────────────────────────────────────────────

export type FileKind = 'raster' | 'table' | 'image' | 'vector' | 'archive' | 'other';

export interface RasterMeta {
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  bands: number;
  noData: number | null;
  bbox: [number, number, number, number] | null;
  epsg: number | null;
  geographic: boolean;
  latLngBounds: LatLngBounds | null;
  pixelSize: [number, number] | null;
  bandNames: string[];
  dtype: string;
  warnings: string[];
  guessedBands: Partial<Record<string, number>>;
  error?: string;
}

export interface TableMeta {
  kind: 'table';
  filename: string;
  format: string;
  sizeBytes: number;
  columns: { name: string; kind: 'number' | 'date' | 'text'; filled: number }[];
  rowCount: number;
  timeColumn: string | null;
  intervalDays: number | null;
  minIntervalDays: number | null;
  defaultMetric: string | null;
  numericColumns: string[];
  warnings: string[];
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StoredFile<M = Record<string, any>> {
  id: string;
  name: string;
  size: number;
  kind: FileKind;
  created: number;
  meta: M & { error?: string };
  sample: boolean;
}

/** Uploads a file (with progress) and returns what the server found in it. */
export function uploadFile(file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<StoredFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', apiUrl('/api/files'));
    xhr.responseType = 'json';
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(xhr.response as StoredFile) : reject(new ApiError(detail(xhr.response, xhr.status), xhr.status)));
    xhr.onerror = () => reject(new ApiError(`Could not upload ${file.name}: the TerraX server is not reachable.`, 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** Copies a bundled sample into the upload store. */
export const copySample = (name: string) => request<StoredFile>('/api/samples', { method: 'POST', json: { name } });

/** Rejects files the server could not read, with its explanation. */
export function checkFile<M>(f: StoredFile, kinds: FileKind[], what: string): StoredFile<M> {
  if (f.meta?.error) throw new Error(f.meta.error);
  if (!kinds.includes(f.kind)) throw new Error(`${f.name} is not ${what}.`);
  return f as unknown as StoredFile<M>;
}

// ── Jobs ─────────────────────────────────────────────────────────────────

export interface JobStatus<T> {
  id: string;
  tool: string;
  state: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  result?: T;
}

export interface JobProgress {
  state: JobStatus<unknown>['state'];
  progress: number;
  message: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Cancelled', 'AbortError'));
    });
  });

/**
 * Starts a job and polls until it finishes. Rejects with the server's
 * message when the analysis fails.
 */
export async function runJob<T>(
  tool: string,
  inputs: Record<string, unknown>,
  params: Record<string, unknown> = {},
  opts: { onProgress?: (p: JobProgress) => void; signal?: AbortSignal } = {},
): Promise<T> {
  let st = await request<JobStatus<T>>('/api/jobs', { method: 'POST', json: { tool, inputs, params }, signal: opts.signal });
  let wait = 300;
  while (st.state === 'queued' || st.state === 'running') {
    opts.onProgress?.({ state: st.state, progress: st.progress, message: st.message });
    await sleep(wait, opts.signal);
    wait = Math.min(1500, wait * 1.4);
    st = await request<JobStatus<T>>(`/api/jobs/${st.id}`, { signal: opts.signal });
  }
  if (st.state === 'error') throw new Error(st.message || 'The analysis failed.');
  opts.onProgress?.({ state: 'done', progress: 1, message: 'Done' });
  return st.result as T;
}

// ── Shared result shapes ─────────────────────────────────────────────────

export interface Download {
  label: string;
  filename: string;
  url: string;
  mediaType: string;
  features?: number;
  truncated?: number;
}

export interface LegendEntry {
  color: string;
  label: string;
}

export interface ResultImage {
  url: string;
  bounds: LatLngBounds | null;
  label: string;
  legend: LegendEntry[];
  width?: number;
  height?: number;
  ramp?: { min: number; max: number; palette: string };
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  median: number;
  q1: number;
  q3: number;
}

export interface Trend {
  n: number;
  olsSlope: number;
  senSlope: number;
  s: number;
  z: number;
  p: number;
  direction: 'increasing' | 'decreasing' | 'no trend';
}

/** Saves an artifact (GeoJSON, CSV …) under its file name. */
export async function downloadArtifact(d: Pick<Download, 'url' | 'filename'>): Promise<void> {
  const res = await fetch(apiUrl(d.url));
  if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}); the result may have expired. Run the analysis again.`);
  await downloadBlob(await res.blob(), d.filename);
}

// ── Health ───────────────────────────────────────────────────────────────

export interface Health {
  ok: boolean;
  version: string;
  eager: boolean;
  redis: boolean | null;
  tools: string[];
  ai: boolean;
}

export const health = () => request<Health>('/api/health');
