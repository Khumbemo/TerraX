import { useState } from 'react';
import { EARTH_SEARCH, parseStacItems, readS2Window, stacSearchBody, type StacItem } from '../lib/live';
import type { OpenRaster } from '../lib/rasterio';
import { useToast } from '../lib/toast';
import type { Boundary } from '../lib/zonal';

interface Props {
  target: { lat: number; lon: number; name: string };
  boundary: Boundary | null;
  onRaster: (raster: OpenRaster, notes: string[]) => void;
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
  const [busy, setBusy] = useState<string | null>(null);

  const bbox = (): [number, number, number, number] => {
    if (boundary) return boundaryBbox(boundary);
    const half = Math.max(0.1, Math.min(14, Number(km) || 3)) / 2;
    const dLat = half / 111.32, dLon = half / (111.32 * Math.cos((target.lat * Math.PI) / 180));
    return [target.lon - dLon, target.lat - dLat, target.lon + dLon, target.lat + dLat];
  };

  const offline = () => {
    if (__TERRAX_PREVIEW__) {
      notify('Scene search needs the full TerraX app; this sandboxed preview cannot reach outside servers.', 'error');
      return true;
    }
    return false;
  };

  const search = async () => {
    if (offline()) return;
    setBusy('search');
    try {
      const body = stacSearchBody(bbox(), start, end, Math.max(0, Math.min(100, Number(cloud) || 20)));
      let res: Response;
      try {
        res = await fetch(`${EARTH_SEARCH}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        throw new Error('Could not reach earth-search.aws.element84.com. Check the internet connection; some networks block it.');
      }
      if (!res.ok) throw new Error(`The scene catalogue returned HTTP ${res.status}.`);
      const found = parseStacItems(await res.json());
      setItems(found);
      if (!found.length) notify('No scenes match. Widen the dates or raise the cloud limit.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The search failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const load = async (item: StacItem) => {
    if (offline()) return;
    setBusy(item.id);
    try {
      const { fromUrl } = await import('geotiff');
      const { raster, notes } = await readS2Window(item, bbox(), href => fromUrl(href));
      onRaster(raster, notes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(/fetch|network|Failed/i.test(msg) ? 'The image files could not be read from this browser (network or cross-origin restriction).' : msg, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Search Sentinel-2 scenes (internet)</summary>
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
        Scenes come from the Earth Search catalogue of Sentinel-2 Level-2A surface reflectance on AWS (free, no account). Only the window over your area is downloaded:
        B2, B3, B4, B8 at 10 m and the SCL cloud classes, which are applied as a mask.
      </p>
    </details>
  );
}
