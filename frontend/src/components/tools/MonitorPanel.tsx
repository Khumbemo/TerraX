// Forest-loss monitoring (backend: terrax/monitors.py, api/monitors.py): watch the analysis boundary for new loss in new
// Sentinel-2 scenes, with e-mailed alerts. Needs an account, since alerts go to its address.
import { useCallback, useEffect, useState } from 'react';
import { apiUrl, request } from '../../lib/api';
import { useAccount } from '../../lib/account';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import type { Boundary } from '../../lib/zonal';

interface Alert {
  id: string;
  firstSeen: string;
  confirmed: string;
  areaHa: number;
  patches: number;
  emailed: boolean;
}

interface Monitor {
  id: string;
  name: string;
  active: boolean;
  email: boolean;
  status: string;
  lastChecked: number | null;
  nextCheck: number;
  settings: { forestNdvi: number; drop: number; minAreaHa: number; maxCloud: number; checkHours: number; radar?: number; vhDrop?: number };
  alertCount?: number;
  alerts?: Alert[];
}

const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleString() : '—');

export default function MonitorPanel({ boundary }: { boundary: Boundary | null }) {
  const { user, openDialog } = useAccount();
  const notify = useToast();
  const [list, setList] = useState<Monitor[] | null>(null);
  const [canEmail, setCanEmail] = useState(true);
  const [open, setOpen] = useState<Monitor | null>(null);
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState('0.2');
  const [minArea, setMinArea] = useState('0.5');
  const [radar, setRadar] = useState(true);
  const [vhDrop, setVhDrop] = useState('3');
  const fail = (e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error');

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const r = await request<{ monitors: Monitor[]; canEmail: boolean }>('/api/monitors');
      setList(r.monitors);
      setCanEmail(r.canEmail);
    } catch (e) {
      fail(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const show = (id: string) => act(async () => setOpen(await request<Monitor>(`/api/monitors/${id}`)));

  const create = () =>
    act(async () => {
      if (!boundary) throw new Error('Draw or upload the area to watch as the analysis boundary first.');
      const m = await request<Monitor>('/api/monitors', {
        method: 'POST',
        json: { name: boundary.name, geojson: boundary.geojson, settings: { drop: Number(drop), minAreaHa: Number(minArea), radar: radar ? 1 : 0, vhDrop: Number(vhDrop) } },
      });
      setOpen(m);
      notify(`Watching “${m.name}”.`, 'success');
    });

  if (!user) {
    return (
      <details className="param-panel">
        <summary>Watch this area for new loss</summary>
        <p className="field-hint">
          TerraX can check an area as new Sentinel-2 scenes arrive and e-mail you when it finds new forest loss.{' '}
          <button type="button" className="link-btn" onClick={() => openDialog('signin', 'Sign in to watch areas for new forest loss.')}>
            Sign in
          </button>{' '}
          to use it.
        </p>
      </details>
    );
  }

  return (
    <details className="param-panel" id="monitor-panel">
      <summary>Watch an area for new loss{list && list.length ? ` · ${list.length}` : ''}</summary>
      <p className="field-hint">
        TerraX builds a cloud-free reference from recent Sentinel-2 scenes, then checks every new scene (daily by default). A forest pixel (reference NDVI ≥ 0.5) whose
        NDVI falls by the set drop is confirmed when the next clear scene shows it too, as in the GLAD and RADD alerts; patches of at least the set area are
        reported{canEmail ? ' and e-mailed to you' : ' (this server cannot send e-mail, so check here)'}. Areas up to 14 km across. With radar, Sentinel-1 scenes,
        which see through cloud, are checked too: a fall in VH backscatter below its reference median, confirmed by the next radar scene.
      </p>
      <div className="param-row">
        <span className="field-hint">Area: {boundary ? `analysis boundary “${boundary.name}”` : 'draw or upload a boundary first'}.</span>
        <label className="param">
          <span>NDVI drop ≥</span>
          <input id="monitor-drop" type="number" min="0.05" max="1" step="0.05" value={drop} onChange={e => setDrop(e.target.value)} />
        </label>
        <label className="check" title="Sentinel-1 radar sees through the cloud that can hide the ground from Sentinel-2 for weeks">
          <input id="monitor-radar" type="checkbox" checked={radar} onChange={e => setRadar(e.target.checked)} /> Radar too
        </label>
        {radar && (
          <label className="param" title="Fall in VH backscatter below its reference median that marks a radar candidate; a setting, not a calibrated value">
            <span>VH drop ≥ (dB)</span>
            <input id="monitor-vh-drop" type="number" min="0.5" max="15" step="0.5" value={vhDrop} onChange={e => setVhDrop(e.target.value)} />
          </label>
        )}
        <label className="param">
          <span>Min. patch (ha)</span>
          <input id="monitor-min-area" type="number" min="0.01" step="0.1" value={minArea} onChange={e => setMinArea(e.target.value)} />
        </label>
        <button type="button" id="monitor-create" className="btn btn-primary push-right" disabled={busy || !boundary} onClick={create}>
          Watch this area
        </button>
      </div>
      {list && list.length > 0 && (
        <div className="tabular-view">
          <table id="monitor-list">
            <thead>
              <tr>
                <th>Area</th>
                <th>Status</th>
                <th className="num">Alerts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map(m => (
                <tr key={m.id} className={m.active ? '' : 'muted'}>
                  <td>{m.name}</td>
                  <td>{m.active ? m.status : 'Paused'}</td>
                  <td className="num">{m.alertCount ?? 0}</td>
                  <td>
                    <button type="button" className="btn btn-small" disabled={busy} onClick={() => show(m.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <div className="render-window" id="monitor-detail">
          <div className="eyebrow">{open.name}</div>
          <p className="field-hint">
            {open.status} Last checked {when(open.lastChecked)}; next {open.active ? when(open.nextCheck) : 'when resumed'}. Drop ≥ {fmt(open.settings.drop)}, patches ≥ {fmt(open.settings.minAreaHa)} ha,
            scenes under {fmt(open.settings.maxCloud)} % cloud{open.settings.radar ? `; radar on, VH drop ≥ ${fmt(open.settings.vhDrop ?? 3)} dB` : ''}.
          </p>
          <div className="button-row">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => setOpen(await request<Monitor>(`/api/monitors/${open.id}/check`, { method: 'POST', json: {} })))}>
              Check now
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => act(async () => setOpen(await request<Monitor>(`/api/monitors/${open.id}`, { method: 'PATCH', json: { active: !open.active } })))}>
              {open.active ? 'Pause' : 'Resume'}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title="Build a new reference from the latest clear scenes, e.g. when the season has changed"
              onClick={() => act(async () => setOpen(await request<Monitor>(`/api/monitors/${open.id}`, { method: 'PATCH', json: { rebuildReference: true } })))}
            >
              Rebuild reference
            </button>
            <button
              type="button"
              className="btn btn-small push-right"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await request(`/api/monitors/${open.id}`, { method: 'DELETE' });
                  setOpen(null);
                })
              }
            >
              Stop watching
            </button>
          </div>
          {open.alerts && open.alerts.length > 0 ? (
            <div className="tabular-view">
              <table id="monitor-alerts">
                <thead>
                  <tr>
                    <th>First seen</th>
                    <th>Confirmed</th>
                    <th className="num">Area (ha)</th>
                    <th className="num">Patches</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {open.alerts.map(a => (
                    <tr key={a.id}>
                      <td>{a.firstSeen}</td>
                      <td>{a.confirmed}</td>
                      <td className="num">{fmt(a.areaHa, 4)}</td>
                      <td className="num">{a.patches}</td>
                      <td>
                        <a className="btn btn-small" href={apiUrl(`/api/monitors/${open.id}/alerts/${a.id}.geojson`)} download>
                          GeoJSON
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="field-hint">No alerts yet.</p>
          )}
          <p className="field-hint">Alerts come from satellite images: check them on finer imagery or in the field before acting on them.</p>
        </div>
      )}
    </details>
  );
}
