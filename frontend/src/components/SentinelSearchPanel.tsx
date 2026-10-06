import { useState } from 'react';
import { request, runJob, type RasterMeta, type StoredFile } from '../lib/api';
import { useToast } from '../lib/toast';
import { useJob } from '../lib/useJob';
import type { Boundary } from '../lib/zonal';
import JobStatus from './JobStatus';

interface StacItem {
  id: string;
  datetime: string;
  cloud: number | null;
  epsg: number | null;
  assets: Record<string, { href: string; scale?: number | null; offset?: number | null }>;
  processingBaseline: string | null;
}

interface Props {
  target: { lat: number; lon: number; name: string };
  boundary: Boundary | null;
  /** The scene window, stored on the server as a 5-band GeoTIFF (blue, green, red, NIR, SCL). */
  onRaster: (file: StoredFile<RasterMeta>, notes: string[]) => void;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function boundaryBbox(b: Boundary): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      minX = Math.min(minX, c[0] as number);
      maxX = Math.max(maxX, c[0] as number);
      minY = Math.min(minY, c[1] as number);
      maxY = Math.max(maxY, c[1] as number);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  b.geojson.features.forEach(f => visit(f.geometry.coordinates));
  return [minX, minY, maxX, maxY];
}

export default function SentinelSearchPanel({ target, boundary, onRaster }: Props) {
  const notify = useToast();
  const now = new Date();
  const [start, setStart] = useState(iso(new Date(now.getTime() - 120 * 86_400_000)));
  const [end, setEnd] = useState(iso(now));
  const [cloud, setCloud] = useState('20');
  const [km, setKm] = useState('3');
  const [items, setItems] = useState<StacItem[] | null>(null);
  const job = useJob();
  const busy = job.busy;

  const bbox = (): [number, number, number, number] => {
    if (boundary) return boundaryBbox(boundary);
    const half = Math.max(0.1, Math.min(14, Number(km) || 3)) / 2;
    const dLat = half / 111.32, dLon = half / (111.32 * Math.cos((target.lat * Math.PI) / 180));
    return [target.lon - dLon, target.lat - dLat, target.lon + dLon, target.lat + dLat];
  };
  const fail = (m: string) => notify(m, 'error');

  const search = async () => {
    const r = await job.run(
      'search',
      signal => request<{ items: StacItem[] }>('/api/live/sentinel/search', { method: 'POST', json: { bbox: bbox(), start, end, maxCloud: Math.max(0, Math.min(100, Number(cloud) || 20)) }, signal }),
      fail,
    );
    if (!r) return;
    setItems(r.items);
    if (!r.items.length) notify('No scenes match. Widen the dates or raise the cloud limit.');
  };

  const load = async (item: StacItem) => {
    const r = await job.run(item.id, (signal, onProgress) => runJob<{ file: StoredFile<RasterMeta>; notes: string[] }>('sentinel', {}, { item, bbox: bbox() }, { signal, onProgress }), fail);
    if (r) onRaster(r.file, r.notes);
  };

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Search Sentinel-2 scenes (the server downloads them)</summary>
      <div className="param-row">
        <span className="field-hint">
          Area: {boundary ? `analysis boundary “${boundary.name}”` : `${km} km square around ${target.name}`}.
        </span>
        {!boundary && (
          <label className="param">
            <span>Size (km)</span>
            <input id="s2-km" type="number" min="0.1" max="14" step="0.5" value={km} onChange={e => setKm(e.target.value)} />
          </label>
        )}
        <label className="param">
          <span>From</span>
          <input id="s2-start" type="date" value={start} onChange={e => setStart(e.target.value)} />
        </label>
        <label className="param">
          <span>To</span>
          <input id="s2-end" type="date" value={end} onChange={e => setEnd(e.target.value)} />
        </label>
        <label className="param">
          <span>Cloud &lt; (%)</span>
          <input id="s2-cloud" type="number" min="0" max="100" value={cloud} onChange={e => setCloud(e.target.value)} />
        </label>
        <button type="button" id="s2-search" className="btn btn-primary push-right" disabled={Boolean(busy)} onClick={search}>
          {busy === 'search' ? 'Searching…' : 'Search'}
        </button>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />
      {items && items.length > 0 && (
        <div className="tabular-view">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Scene</th>
                <th>Cloud (tile)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id}>
                  <td>{it.datetime.slice(0, 10)}</td>
                  <td>{it.id}</td>
                  <td className="num">{it.cloud === null ? '—' : `${it.cloud.toFixed(1)} %`}</td>
                  <td>
                    <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => load(it)}>
                      {busy === it.id ? 'Reading…' : 'Load'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint">
        Scenes come from the Earth Search catalogue of Sentinel-2 Level-2A surface reflectance on AWS (free, no account). The TerraX server reads only the window over your area:
        B2, B3, B4, B8 at 10 m and the SCL cloud classes, which are applied as a mask.
      </p>
    </details>
  );
}
