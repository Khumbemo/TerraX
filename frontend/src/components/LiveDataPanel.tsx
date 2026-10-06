import { useState } from 'react';
import { request, type StoredFile } from '../lib/api';
import { useToast } from '../lib/toast';

interface Props {
  target: { lat: number; lon: number; name: string };
  /** The fetched series, stored on the server as a CSV upload. */
  onTable: (file: StoredFile, note: string) => void;
}

// The variables the server accepts (services/live.py).
const OPEN_METEO_VARS = [
  { id: 'precipitation_sum', label: 'Precipitation (mm)' },
  { id: 'temperature_2m_mean', label: 'Mean temperature (°C)' },
  { id: 'temperature_2m_max', label: 'Maximum temperature (°C)' },
  { id: 'temperature_2m_min', label: 'Minimum temperature (°C)' },
  { id: 'relative_humidity_2m_mean', label: 'Mean relative humidity (%)' },
  { id: 'et0_fao_evapotranspiration', label: 'Reference ET₀, FAO-56 (mm)' },
  { id: 'shortwave_radiation_sum', label: 'Solar radiation (MJ/m²)' },
];
const POWER_VARS = [
  { id: 'PRECTOTCORR', label: 'Precipitation, bias-corrected (mm/day)' },
  { id: 'T2M', label: 'Temperature at 2 m (°C)' },
  { id: 'T2M_MAX', label: 'Maximum temperature (°C)' },
  { id: 'T2M_MIN', label: 'Minimum temperature (°C)' },
  { id: 'RH2M', label: 'Relative humidity at 2 m (%)' },
  { id: 'ALLSKY_SFC_SW_DWN', label: 'All-sky solar radiation (MJ/m²/day)' },
];

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
    setBusy(true);
    try {
      const r = await request<{ file: StoredFile; note: string }>('/api/live/weather', {
        method: 'POST',
        json: { source, lat: Number(lat), lon: Number(lon), start, end, vars: vars[source] },
      });
      onTable(r.file, r.note);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The request failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="sub-panel live-panel">
      <summary className="eyebrow">Fetch data for a location (the server downloads it)</summary>
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
