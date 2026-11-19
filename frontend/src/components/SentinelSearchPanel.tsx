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
  platform?: string | null;
}

export type Mission = 's2' | 'landsat';

/** What differs between the two optical catalogues. */
const MISSIONS = {
  s2: { label: 'Sentinel-2', search: '/api/live/sentinel/search', scene: 'sentinel', composite: 'sentinel_composite', maxKm: 14, cloud: 'Cloud (tile)' },
  landsat: { label: 'Landsat', search: '/api/live/landsat/search', scene: 'landsat', composite: 'landsat_composite', maxKm: 44, cloud: 'Cloud (scene)' },
} as const;

interface Props {
  target: { lat: number; lon: number; name: string };
  boundary: Boundary | null;
  /** A scene window or a median composite, stored on the server. Sentinel-2: blue, green, red, NIR, then SCL (scene) or the
   *  clear-observation count (composite). Landsat: blue, green, red, NIR, SWIR1, SWIR2, then QA_PIXEL or the count. */
  onRaster: (file: StoredFile<RasterMeta>, notes: string[], kind: 'scene' | 'composite', mission: Mission) => void;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function boundaryBbox(b: Boundary): [number, number, number, number] {
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
  const [mission, setMission] = useState<Mission>('s2');
  const m = MISSIONS[mission];
  const [items, setItems] = useState<StacItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const job = useJob();
  const busy = job.busy;

  const bbox = (): [number, number, number, number] => {
    if (boundary) return boundaryBbox(boundary);
    const half = Math.max(0.1, Math.min(m.maxKm, Number(km) || 3)) / 2;
    const dLat = half / 111.32, dLon = half / (111.32 * Math.cos((target.lat * Math.PI) / 180));
    return [target.lon - dLon, target.lat - dLat, target.lon + dLon, target.lat + dLat];
  };
  const fail = (m: string) => notify(m, 'error');

  const search = async () => {
    const r = await job.run(
      'search',
      signal => request<{ items: StacItem[] }>(m.search, { method: 'POST', json: { bbox: bbox(), start, end, maxCloud: Math.max(0, Math.min(100, Number(cloud) || 20)) }, signal }),
      fail,
    );
    if (!r) return;
    setItems(r.items);
    setPicked(new Set());
    if (!r.items.length) notify('No scenes match. Widen the dates or raise the cloud limit.');
  };

  const load = async (item: StacItem) => {
    const r = await job.run(item.id, (signal, onProgress) => runJob<{ file: StoredFile<RasterMeta>; notes: string[] }>(m.scene, {}, { item, bbox: bbox() }, { signal, onProgress }), fail);
    if (r) onRaster(r.file, r.notes, 'scene', mission);
  };

  const MAX_COMPOSITE = 12;
  const composite = async () => {
    const chosen = (items ?? []).filter(it => picked.has(it.id));
    if (chosen.length < 2 || chosen.length > MAX_COMPOSITE) return fail(`Tick between 2 and ${MAX_COMPOSITE} scenes to combine.`);
    const r = await job.run('composite', (signal, onProgress) => runJob<{ file: StoredFile<RasterMeta>; notes: string[] }>(m.composite, {}, { items: chosen, bbox: bbox() }, { signal, onProgress }), fail);
    if (r) onRaster(r.file, r.notes, 'composite', mission);
  };
  const switchMission = (next: Mission) => {
    job.cancel();
    setMission(next);
    setItems(null);
    setPicked(new Set());
  };
  const toggle = (id: string) =>
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Search Sentinel-2 or Landsat scenes (the server downloads them)</summary>
      <div className="mode-switch" role="radiogroup" aria-label="Satellite">
        {(Object.keys(MISSIONS) as Mission[]).map(k => (
          <button key={k} type="button" id={`mission-${k}`} role="radio" aria-checked={mission === k} className={mission === k ? 'active' : ''} onClick={() => switchMission(k)}>
            {k === 's2' ? 'Sentinel-2 (2015–, 10 m)' : 'Landsat 4–9 (1982–, 30 m)'}
          </button>
        ))}
      </div>
      <div className="param-row">
        <span className="field-hint">
          Area: {boundary ? `analysis boundary “${boundary.name}”` : `${km} km square around ${target.name}`}.
        </span>
        {!boundary && (
          <label className="param">
            <span>Size (km)</span>
            <input id="s2-km" type="number" min="0.1" max={m.maxKm} step="0.5" value={km} onChange={e => setKm(e.target.value)} />
          </label>
        )}
        <label className="param">
          <span>From</span>
          <input id="s2-start" type="date" min={mission === 'landsat' ? '1982-07-16' : '2015-06-23'} value={start} onChange={e => setStart(e.target.value)} />
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
                {mission === 'landsat' && <th>Satellite</th>}
                <th>{m.cloud}</th>
                <th>Combine</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id}>
                  <td>{it.datetime.slice(0, 10)}</td>
                  <td>{it.id}</td>
                  {mission === 'landsat' && <td>{(it.platform ?? '').replace('landsat-', 'Landsat ')}</td>}
                  <td className="num">{it.cloud === null ? '—' : `${it.cloud.toFixed(1)} %`}</td>
                  <td>
                    <input type="checkbox" className="s2-pick" aria-label={`Combine ${it.id}`} checked={picked.has(it.id)} onChange={() => toggle(it.id)} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" disabled={Boolean(busy)} onClick={() => load(it)}>
                      {busy === it.id ? 'Reading…' : 'Load'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-small"
              disabled={Boolean(busy)}
              onClick={() => setPicked(picked.size ? new Set() : new Set(items.slice(0, MAX_COMPOSITE).map(it => it.id)))}
            >
              {picked.size ? 'Clear ticks' : `Tick ${Math.min(items.length, MAX_COMPOSITE)}`}
            </button>
            <button type="button" id="s2-composite" className="btn btn-primary push-right" disabled={Boolean(busy) || picked.size < 2 || picked.size > MAX_COMPOSITE} onClick={composite}>
              {busy === 'composite' ? 'Combining…' : `Cloud-free composite of ${picked.size} scene${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>
          <p className="field-hint">
            A composite takes, for each pixel, the median of the scenes’ cloud-free observations (each scene’s own cloud {mission === 'landsat' ? 'flags, QA_PIXEL' : 'classification, SCL'}), so
            cloudy months still give a full image. Band {mission === 'landsat' ? 7 : 5} of the result counts the clear observations per pixel.
          </p>
        </div>
      )}
      {mission === 's2' ? (
        <p className="field-hint">
          Scenes come from the Earth Search catalogue of Sentinel-2 Level-2A surface reflectance on AWS (free, no account). The TerraX server reads only the window over your area:
          B2, B3, B4, B8 at 10 m and the SCL cloud classes, which are applied as a mask.
        </p>
      ) : (
        <p className="field-hint">
          Scenes come from the Microsoft Planetary Computer’s copy of USGS Landsat Collection 2 Level-2 surface reflectance (Tier 1, free, no account): Landsat 4–5 TM, 7 ETM+ and 8–9 OLI.
          The TerraX server reads only the window over your area: blue, green, red, NIR, SWIR1 and SWIR2 at 30 m and QA_PIXEL, whose cloud, shadow and snow flags are applied as a mask.
          Landsat 7 scenes after May 2003 have missing stripes; TM/ETM+ and OLI reflectances differ slightly.
        </p>
      )}
    </details>
  );
}
