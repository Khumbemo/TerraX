// Runs heavy raster computations off the main thread so the page stays responsive.
import { flowRouting } from '../lib/tools/hydrology';
import { kmeans } from '../lib/tools/kmeans';

type Msg =
  | { id: number; kind: 'flow'; width: number; height: number; data: Float32Array; dx: Float64Array; dy: Float64Array; area: Float64Array; threshold: number }
  | { id: number; kind: 'kmeans'; points: Float64Array; d: number; k: number; seed: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (m.kind === 'flow') {
      const f = flowRouting(
        { width: m.width, height: m.height, data: m.data, resampleFactor: 1 },
        { spacing: r => ({ dx: m.dx[r], dy: m.dy[r] }), cellArea: r => m.area[r] },
        m.threshold,
      );
      post({ id: m.id, ok: true, result: f }, [f.dir.buffer, f.acc.buffer, f.order.buffer]);
    } else {
      const r = kmeans(m.points, m.d, m.k, m.seed);
      post({ id: m.id, ok: true, result: r }, [r.centroids.buffer]);
    }
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
