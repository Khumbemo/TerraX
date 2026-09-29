// Worker-backed versions of the heaviest computations, with a same-thread
// fallback where workers are unavailable (tests, very old browsers).
import type { Grid } from './rasterio';
import { flowRouting, type FlowResult, type Spacing } from './tools/hydrology';
import { kmeans } from './tools/kmeans';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

async function getWorker(): Promise<Worker | null> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const { default: ComputeWorker } = await import('../workers/compute.worker?worker&inline');
    worker = new ComputeWorker() as Worker;
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? 'The computation failed.'));
    };
    worker.onerror = e => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'The computation worker failed.'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function run<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...msg, id }, transfer);
  });
}

export async function flowRoutingAsync(dem: Grid, geo: Spacing, thresholdM2: number): Promise<FlowResult> {
  const w = await getWorker();
  if (!w) return flowRouting(dem, geo, thresholdM2);
  const dx = new Float64Array(dem.height), dy = new Float64Array(dem.height), area = new Float64Array(dem.height);
  for (let r = 0; r < dem.height; r++) {
    const s = geo.spacing(r);
    dx[r] = s.dx;
    dy[r] = s.dy;
    area[r] = geo.cellArea(r);
  }
  const data = new Float32Array(dem.data); // copy: the caller keeps its grid
  return run<FlowResult>(w, { kind: 'flow', width: dem.width, height: dem.height, data, dx, dy, area, threshold: thresholdM2 }, [data.buffer, dx.buffer, dy.buffer, area.buffer]);
}

export async function kmeansAsync(points: Float64Array, d: number, k: number, seed: number): Promise<ReturnType<typeof kmeans>> {
  const w = await getWorker();
  if (!w) return kmeans(points, d, k, seed);
  return run(w, { kind: 'kmeans', points, d, k, seed }, [points.buffer]);
}
