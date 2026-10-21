import { useState } from 'react';
import { request, runJob, type RasterMeta, type StoredFile } from '../lib/api';
import { useToast } from '../lib/toast';
import { useJob } from '../lib/useJob';
import type { Boundary } from '../lib/zonal';
import JobStatus from './JobStatus';
import { boundaryBbox } from './SentinelSearchPanel';

interface S1Item {
  id: string;
  datetime: string;
  orbitState: string | null;
  relativeOrbit: number | null;
  platform: string | null;
  epsg: number | null;
  assets: Record<string, { href: string }>;
}

interface Props {
  target: { lat: number; lon: number; name: string };
  boundary: Boundary | null;
  /** The first image already loaded: a second scene is read onto its grid so the dates line up for change. */
  match: { file: StoredFile<RasterMeta>; relativeOrbit: number | null } | null;
  /** The scene window, stored on the server as a 2-band GeoTIFF (VV, VH; γ⁰ in linear power). */
  onRaster: (file: StoredFile<RasterMeta>, item: S1Item, notes: string[]) => void;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Sentinel1SearchPanel({ target, boundary, match, onRaster }: Props) {
  const notify = useToast();
  const now = new Date();
  const [start, setStart] = useState(iso(new Date(now.getTime() - 60 * 86_400_000)));
  const [end, setEnd] = useState(iso(now));
  const [orbit, setOrbit] = useState('');
  const [km, setKm] = useState('3');
  const [items, setItems] = useState<S1Item[] | null>(null);
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
      signal => request<{ items: S1Item[] }>('/api/live/sentinel1/search', { method: 'POST', json: { bbox: bbox(), start, end, orbit: orbit || null }, signal }),
      fail,
    );
    if (!r) return;
    setItems(r.items);
    if (!r.items.length) notify('No dual-polarisation scenes match. Widen the dates.');
  };

  const load = async (item: S1Item) => {
    const inputs = match ? { match: match.file.id } : {};
    const params = { item, bbox: bbox(), ...(match ? { matchOrbit: match.relativeOrbit } : {}) };
    const r = await job.run(item.id, (signal, onProgress) => runJob<{ file: StoredFile<RasterMeta>; notes: string[] }>('sentinel1', inputs, params, { signal, onProgress }), fail);
    if (r) onRaster(r.file, item, r.notes);
  };

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Search Sentinel-1 scenes (the server downloads them)</summary>
      <div className="param-row">
        <span className="field-hint">
          Area: {boundary ? `analysis boundary “${boundary.name}”` : `${km} km square around ${target.name}`}.
          {match ? ' The next scene is loaded as the second date, on the first one’s grid.' : ''}
        </span>
        {!boundary && (
          <label className="param">
            <span>Size (km)</span>
            <input id="s1-km" type="number" min="0.1" max="14" step="0.5" value={km} onChange={e => setKm(e.target.value)} />
          </label>
        )}
        <label className="param">
          <span>From</span>
          <input id="s1-start" type="date" value={start} onChange={e => setStart(e.target.value)} />
        </label>
        <label className="param">
          <span>To</span>
          <input id="s1-end" type="date" value={end} onChange={e => setEnd(e.target.value)} />
        </label>
        <label className="param">
          <span>Pass</span>
          <select id="s1-orbit" value={orbit} onChange={e => setOrbit(e.target.value)}>
            <option value="">Any</option>
            <option value="ascending">Ascending</option>
            <option value="descending">Descending</option>
          </select>
        </label>
        <button type="button" id="s1-search" className="btn btn-primary push-right" disabled={Boolean(busy)} onClick={search}>
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
                <th>Pass</th>
                <th>Relative orbit</th>
                <th>Scene</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} className={match && match.relativeOrbit !== null && it.relativeOrbit !== match.relativeOrbit ? 'muted' : undefined}>
                  <td>{it.datetime.slice(0, 10)}</td>
                  <td>{it.orbitState ?? '—'}</td>
                  <td className="num">{it.relativeOrbit ?? '—'}</td>
                  <td>{it.id}</td>
                  <td>
                    <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => load(it)}>
                      {busy === it.id ? 'Reading…' : match ? 'Load as second date' : 'Load'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint">
        Scenes come from the Microsoft Planetary Computer’s Sentinel-1 RTC collection: γ⁰ backscatter, radiometrically terrain corrected, 10 m, in linear power (free, no account).
        The TerraX server reads only the window over your area. For change, use two scenes from the same relative orbit and season.
      </p>
    </details>
  );
}
