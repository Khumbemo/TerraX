import { useState } from 'react';
import { OPEN_METEO_VARS, POWER_VARS, openMeteoToCsv, openMeteoUrl, powerToCsv, powerUrl } from '../lib/live';
import { useToast } from '../lib/toast';

interface Props {
  target: { lat: number; lon: number; name: string };
  onTable: (csv: string, filename: string, note: string) => void;
}

type Source = 'open-meteo' | 'power';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function LiveDataPanel({ target, onTable }: Props) {
  const notify = useToast();
  const [source, setSource] = useState<Source>('open-meteo');
  const [lat, setLat] = useState(String(target.lat));
  const [lon, setLon] = useState(String(target.lon));
  const end0 = new Date(Date.now() - 7 * 86_400_000);
  const [end, setEnd] = useState(iso(end0));
  const [start, setStart] = useState(iso(new Date(Date.UTC(end0.getUTCFullYear() - 10, end0.getUTCMonth(), end0.getUTCDate()))));
  const [vars, setVars] = useState<Record<Source, string[]>>({ 'open-meteo': ['precipitation_sum', 'temperature_2m_mean'], power: ['PRECTOTCORR', 'T2M'] });
  const [busy, setBusy] = useState(false);
  const list = source === 'open-meteo' ? OPEN_METEO_VARS : POWER_VARS;

  const fetchData = async () => {
    if (__TERRAX_PREVIEW__) {
      notify('Live data needs the full TerraX app; this sandboxed preview cannot reach outside servers.', 'error');
      return;
    }
    setBusy(true);
    let host = '';
    try {
      const la = Number(lat), lo = Number(lon);
      const url = source === 'open-meteo' ? openMeteoUrl(la, lo, start, end, vars[source]) : powerUrl(la, lo, start, end, vars[source]);
      host = new URL(url).hostname;
      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        throw new Error(`Could not reach ${host}. Check the internet connection; some networks block this service.`);
      }
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`${host} returned HTTP ${res.status} without data.`);
      const { csv, note } = source === 'open-meteo' ? openMeteoToCsv(json) : powerToCsv(json);
      if (!res.ok && !csv) throw new Error(`${host} returned HTTP ${res.status}.`);
      onTable(csv, `${source === 'open-meteo' ? 'open-meteo_era5' : 'nasa-power'}_${la.toFixed(3)}_${lo.toFixed(3)}_${start}_${end}.csv`, note);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The request failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Fetch data for a location (internet)</summary>
      <div className="param-row">
        <label className="inline-select">
          <span>Source</span>
          <select id="live-source" value={source} onChange={e => setSource(e.target.value as Source)}>
            <option value="open-meteo">Open-Meteo · ERA5 reanalysis (1940–)</option>
            <option value="power">NASA POWER · MERRA-2 (1981–)</option>
          </select>
        </label>
        <label className="param">
          <span>Lat</span>
          <input id="live-lat" type="number" step="0.001" value={lat} onChange={e => setLat(e.target.value)} />
        </label>
        <label className="param">
          <span>Lon</span>
          <input id="live-lon" type="number" step="0.001" value={lon} onChange={e => setLon(e.target.value)} />
        </label>
        <label className="param">
          <span>From</span>
          <input id="live-start" type="date" value={start} onChange={e => setStart(e.target.value)} />
        </label>
        <label className="param">
          <span>To</span>
          <input id="live-end" type="date" value={end} onChange={e => setEnd(e.target.value)} />
        </label>
      </div>
      <fieldset className="band-checks">
        <legend>Daily variables</legend>
        {list.map(v => (
          <label key={v.id} className="check">
            <input
              type="checkbox"
              checked={vars[source].includes(v.id)}
              onChange={e => setVars(x => ({ ...x, [source]: e.target.checked ? [...x[source], v.id] : x[source].filter(y => y !== v.id) }))}
            />{' '}
            {v.label}
          </label>
        ))}
      </fieldset>
      <div className="button-row">
        <span className="field-hint">
          Default location: {target.name} (change it in Settings). Values are gridded model estimates, not station measurements.
        </span>
        <button type="button" id="live-fetch" className="btn btn-primary push-right" disabled={busy} onClick={fetchData}>
          {busy ? 'Fetching…' : 'Fetch daily data'}
        </button>
      </div>
    </details>
  );
}
