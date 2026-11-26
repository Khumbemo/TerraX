// Reference labelling in the app (Olofsson et al. 2014 good practice): each sample point is shown over imagery finer
// than the map, with its pixel outlined and without the map's class, and labelled with one of the map's classes or
// left as "can't tell". Labels are kept in this browser until the accuracy is computed.
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { mapDef } from '../../lib/basemaps';
import * as maplibregl from '../../lib/maplibre';

export interface SampleLocation {
  id: string;
  lon: number;
  lat: number;
  cell: [number, number][];
}

const IMAGERY = [
  { id: 'esri-imagery', label: 'Esri World Imagery (recent, very detailed; dates vary by place)' },
  { id: 'eox-2016', label: 'Sentinel-2 cloudless 2016 (EOX)' },
  { id: 'eox-2020', label: 'Sentinel-2 cloudless 2020 (EOX)' },
];

interface Props {
  idPrefix: string;
  locations: SampleLocation[];
  classes: string[];
  labels: Record<string, string>;
  onLabel: (id: string, label: string) => void;
}

export default function ReferenceLabeller({ idPrefix, locations, classes, labels, onLabel }: Props) {
  const box = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const firstOpen = locations.findIndex(l => !labels[l.id]);
  const [i, setI] = useState(firstOpen >= 0 ? firstOpen : 0);
  const [imagery, setImagery] = useState('esri-imagery');
  const here = locations[i];
  const done = locations.filter(l => labels[l.id]).length;

  useEffect(() => {
    if (!box.current) return;
    const m = new maplibregl.Map({
      container: box.current,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1622' } }] },
      center: [locations[0]?.lon ?? 0, locations[0]?.lat ?? 0],
      zoom: 16,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      m.addSource('cell', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'cell-halo', type: 'line', source: 'cell', paint: { 'line-color': '#000', 'line-width': 4, 'line-opacity': 0.6 } });
      m.addLayer({ id: 'cell-line', type: 'line', source: 'cell', paint: { 'line-color': '#ffd60a', 'line-width': 2 } });
      setReady(true);
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // The map is made once; points and imagery are updated below.
  }, []);

  // The imagery, under the pixel outline.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const def = mapDef(imagery);
    if (m.getLayer('imagery')) m.removeLayer('imagery');
    if (m.getSource('imagery')) m.removeSource('imagery');
    m.addSource('imagery', { type: 'raster', tiles: def.urls ?? [], tileSize: 256, maxzoom: def.maxNativeZoom ?? 19, attribution: def.attribution });
    m.addLayer({ id: 'imagery', type: 'raster', source: 'imagery' }, 'cell-halo');
  }, [imagery, ready]);

  // The current point: its pixel outlined, with enough around it to judge the land cover.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !here) return;
    (m.getSource('cell') as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [here.cell] } });
    const lons = here.cell.map(c => c[0]);
    const lats = here.cell.map(c => c[1]);
    m.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 140, maxZoom: 18, duration: 0 });
  }, [here, ready]);

  // Keyboard: 1–9 label, 0 can't tell, ← → move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.key === 'ArrowRight') setI(v => Math.min(locations.length - 1, v + 1));
      else if (e.key === 'ArrowLeft') setI(v => Math.max(0, v - 1));
      else if (/^[0-9]$/.test(e.key) && here) {
        const k = Number(e.key);
        if (k === 0) label('');
        else if (k <= classes.length) label(classes[k - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const label = (value: string) => {
    if (!here) return;
    onLabel(here.id, value);
    // On to the next unlabelled point after this one, if any.
    const next = locations.findIndex((l, j) => j > i && !labels[l.id] && l.id !== here.id);
    if (value && next >= 0) setI(next);
    else if (value) setI(v => Math.min(locations.length - 1, v + 1));
  };

  if (!here) return null;
  return (
    <div className="labeller" id={`${idPrefix}-labeller`}>
      <div className="param-row">
        <strong id={`${idPrefix}-label-progress`}>
          Point {i + 1} of {locations.length} · {done} labelled
        </strong>
        <label className="inline-select push-right">
          <span>Imagery</span>
          <select id={`${idPrefix}-label-imagery`} value={imagery} onChange={e => setImagery(e.target.value)}>
            {IMAGERY.map(o => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div ref={box} className="labeller-map" aria-label={`Imagery around sample point ${here.id}`} />
      <div className="button-row labeller-classes" role="group" aria-label="Reference class">
        {classes.map((c, k) => (
          <button key={c} type="button" className={`btn ${labels[here.id] === c ? 'btn-primary' : ''}`} aria-pressed={labels[here.id] === c} onClick={() => label(c)}>
            {k < 9 ? `${k + 1} · ` : ''}
            {c}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => label('')} title="Leave this point out: it is left out of the accuracy, not counted as wrong">
          0 · Can’t tell
        </button>
      </div>
      <div className="button-row">
        <button type="button" className="btn btn-small" disabled={i === 0} onClick={() => setI(i - 1)}>
          ← Previous
        </button>
        <button type="button" className="btn btn-small" disabled={i >= locations.length - 1} onClick={() => setI(i + 1)}>
          Next →
        </button>
        <span className="field-hint">
          {here.id} · {here.lat.toFixed(5)}° N, {here.lon.toFixed(5)}° E · keys 1–{Math.min(9, classes.length)}, 0, ← →
        </span>
      </div>
      <p className="field-hint">
        Judge the land inside the yellow pixel. For change, compare imagery from before and after the two dates of the map (switch the imagery above); if the
        imagery dates do not cover the period, or you cannot tell, choose “Can’t tell”. Points left out are not counted; if many are left out,
        especially in one class, the estimates can be biased, so check those with a field visit or better imagery rather than skipping them all.
      </p>
    </div>
  );
}
