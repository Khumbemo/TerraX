import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { runJob, type StoredFile } from '../../lib/api';
import { downloadText, safeFilename } from '../../lib/download';
import { toDms, type LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { areaHa, elevationM, lengthM } from '../../lib/units';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import { getJSON, setJSON } from '../../lib/storage';
import { drawnPolygon, editableVertices, formatAreaM2, formatLength, magneticBearing, toGpx, toKml } from '../../lib/vector';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { Stat, useUpload } from '../ToolKit';

interface Feature {
  name: string;
  kind: 'Polygon' | 'Line' | 'Points';
  area: number | null;
  length: number | null;
  vertices: { index: number; lat: number; lon: number; elevation: number | null; utm: string }[];
  legs: { from: number; to: number; distance: number; bearing: number }[];
  centroid: [number, number];
  method: string;
  elevation: { min: number; max: number } | null;
  profile: { points: { distance: number; elevation: number }[]; gain: number; loss: number; threshold: number } | null;
}
interface SurveyResult {
  filename: string;
  format: string;
  features: Feature[];
  geojson: FeatureCollection;
  bounds: LatLngBounds | null;
  warnings: string[];
}
interface SurveyJob {
  name: string;
  markdown: string;
  survey: SurveyResult;
  boundary: Boundary | null;
  map: { bounds: LatLngBounds | null; geojson: FeatureCollection };
}

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  onBoundary: (b: Boundary | null) => void;
  /** Vertices being drawn on the map ([lat, lon]), or null when not drawing. */
  drawPoints: [number, number][] | null;
  onDraw: (pts: [number, number][] | null) => void;
}

const ACCEPT = '.geojson,.json,.kml,.gpx,.csv,.txt,.zip';

export default function SurveyTool({ onOutput, boundary, onBoundary, drawPoints, onDraw }: Props) {
  const notify = useToast();
  const { units } = usePrefs();
  const job = useJob();
  const busy = Boolean(job.busy);
  const files = useUpload(['vector', 'table', 'archive', 'other'], 'a GeoJSON, KML, GPX, CSV or zipped shapefile');
  const [closeRing, setCloseRing] = useState(true);
  const [out, setOut] = useState<SurveyJob | null>(null);
  const result = out?.survey ?? null;
  const [source, setSource] = useState<{ file: StoredFile } | { geojson: FeatureCollection; name: string } | null>(null);
  const [declText, setDeclText] = useState<string>(() => getJSON<string>('declination', ''));
  const declNum = Number(declText);
  const declination = declText.trim() !== '' && Number.isFinite(declNum) && Math.abs(declNum) <= 90 ? declNum : null;
  const fail = (m: string) => notify(m, 'error');

  const measure = async (src: NonNullable<typeof source>, close = closeRing, decl = declination) => {
    const inputs = 'file' in src ? { file: src.file.id } : {};
    const params = 'file' in src ? { closeRing: close, declination: decl } : { geojson: src.geojson, name: src.name, declination: decl };
    const r = await job.run('run', (signal, onProgress) => runJob<SurveyJob>('survey', inputs, params, { signal, onProgress }), fail);
    if (!r) return;
    setSource(src);
    setOut(r);
    onOutput({ tool: 'survey', name: r.name, markdown: r.markdown, map: r.map, summary: r.survey.features.map(({ vertices: _v, ...f }) => f) });
  };

  const analyse = async (picked: File | string) => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (f) await measure({ file: f });
  };

  // The declination only changes the report's magnetic bearings.
  const firstDecl = useRef(true);
  useEffect(() => {
    setJSON('declination', declText);
    if (firstDecl.current) {
      firstDecl.current = false;
      return;
    }
    if (!source) return;
    const t = setTimeout(() => measure(source), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declination]);

  const finishDrawing = () => {
    if (!drawPoints || drawPoints.length < 3) return fail('Click at least three points on the map to make a polygon.');
    const name = result?.format === 'Drawn on map' ? result.filename : 'Drawn plot';
    onDraw(null);
    measure({ geojson: drawnPolygon(drawPoints, name), name });
  };

  const editVertices = result ? editableVertices(result.geojson) : null;
  const polygonArea = result ? result.features.reduce((a, f) => a + (f.kind === 'Polygon' && f.area !== null ? f.area : 0), 0) : 0;
  const base = result ? safeFilename(result.filename) : 'survey';

  const polys = result ? result.features.filter(f => f.kind === 'Polygon') : [];
  const boundaryName = polys.length === 1 ? polys[0].name : (result?.filename ?? '');
  const isBoundary = Boolean(result && boundary?.name === boundaryName && Math.abs(boundary.areaM2 - polygonArea) < 1e-6);

  const useAsBoundary = () => {
    if (!result) return;
    const b = out?.boundary ? { ...out.boundary, name: boundaryName } : null;
    if (!b) {
      notify('Only polygons can be used as an analysis boundary.', 'error');
      return;
    }
    onBoundary(b);
    notify(`“${boundaryName}” is now the analysis boundary. Forest, terrain and satellite tools will analyse only pixels inside it.`, 'success');
  };

  return (
    <div className="tool-body">
      {drawPoints && (
        <div className="draw-bar" role="region" aria-label="Drawing">
          <span>
            <strong>Drawing:</strong> click the map to add points ({drawPoints.length} so far). Drag a point to move it; double-click it to delete.
          </span>
          <div className="button-row push-right">
            <button type="button" className="btn btn-small" onClick={() => onDraw(drawPoints.slice(0, -1))} disabled={!drawPoints.length}>
              Undo
            </button>
            <button type="button" className="btn btn-small" onClick={() => onDraw(null)}>
              Cancel
            </button>
            <button type="button" id="draw-finish" className="btn btn-small btn-primary" onClick={finishDrawing} disabled={drawPoints.length < 3}>
              Finish polygon
            </button>
          </div>
        </div>
      )}
      <p className="tool-intro">
        Upload a plot boundary, a walked traverse or survey points. Coordinates must be WGS84 longitude/latitude (shapefiles are reprojected from their .prj). The
        boundary is drawn on the map.
      </p>
      <FileDrop id="survey-file" label="Boundary, track or points" accept={ACCEPT} hint="GeoJSON · KML · GPX · CSV (lat, lon) · zipped Shapefile" busy={job.busy === 'upload'} loaded={result?.filename} onFile={f => analyse(f)} />
      <div className="param-row">
        <label className="check">
          <input
            id="survey-close"
            type="checkbox"
            checked={closeRing}
            onChange={e => {
              setCloseRing(e.target.checked);
              if (source && 'file' in source && /\.(csv|txt)$/i.test(source.file.name)) measure(source, e.target.checked);
            }}
          />
          CSV points form a closed boundary
        </label>
        <label className="param" title="Local magnetic declination, east positive. Take it from a current geomagnetic model such as the NOAA WMM calculator.">
          <span>Declination (° E)</span>
          <input id="survey-declination" type="number" step="0.1" min="-90" max="90" placeholder="none" value={declText} onChange={e => setDeclText(e.target.value)} />
        </label>
        <div className="button-row push-right">
          <button type="button" id="draw-start" className="btn" disabled={busy || Boolean(drawPoints)} onClick={() => onDraw([])}>
            Draw on map
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => analyse('survey_plot_synthetic.geojson')}
          >
            Try sample plot
          </button>
        </div>
      </div>

      <JobStatus job={job} />
      {result && (
        <div className="result-block">
          <div className="button-row">
            {polygonArea > 0 && (
              <button type="button" id="use-boundary" className="btn btn-primary" onClick={useAsBoundary} disabled={isBoundary}>
                {isBoundary ? 'Is the analysis boundary' : 'Use as analysis boundary'}
              </button>
            )}
            {editVertices && editVertices.length >= 3 && !drawPoints && (
              <button type="button" id="edit-vertices" className="btn" onClick={() => onDraw(editVertices)}>
                Edit on map
              </button>
            )}
            <span className="push-right muted">Export:</span>
            <button type="button" className="btn btn-small" onClick={() => downloadText(JSON.stringify(result.geojson, null, 2), `${base}.geojson`, 'application/geo+json')}>
              GeoJSON
            </button>
            <button type="button" className="btn btn-small" onClick={() => downloadText(toKml(result.geojson, result.filename), `${base}.kml`, 'application/vnd.google-earth.kml+xml')}>
              KML
            </button>
            <button type="button" className="btn btn-small" onClick={() => downloadText(toGpx(result.geojson, result.filename), `${base}.gpx`, 'application/gpx+xml')}>
              GPX
            </button>
          </div>
          {result.warnings.length > 0 && (
            <ul className="data-notes">
              {result.warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {result.features.map((f, fi) => (
            <section key={`${f.name}-${fi}`} className="feature-card">
              <div className="feature-head">
                <h3>{f.name}</h3>
                <span className="muted">{f.kind === 'Points' ? `${f.vertices.length} point${f.vertices.length === 1 ? '' : 's'}` : f.kind.toLowerCase()}</span>
              </div>
              <div className="stat-grid">
                {f.area !== null && <Stat label="Area" value={units === 'imperial' ? `${areaHa(f.area / 10_000, units)} (${formatAreaM2(f.area).split(' (')[0]})` : formatAreaM2(f.area)} />}
                {f.length !== null && <Stat label={f.kind === 'Polygon' ? 'Perimeter' : 'Length'} value={units === 'imperial' ? lengthM(f.length, units) : formatLength(f.length)} />}
                <Stat label="Centroid" value={`${toDms(f.centroid[0], 'N', 'S')}, ${toDms(f.centroid[1], 'E', 'W')}`} />
                {f.elevation && <Stat label="Elevation (file)" value={`${elevationM(f.elevation.min, units)} – ${elevationM(f.elevation.max, units)}`} />}
              </div>
              <p className="field-hint">Method: {f.method}.</p>
              {(() => {
                const prof = f.profile;
                if (!prof) return null;
                return (
                  <div className="render-window elevation-profile">
                    <div className="eyebrow">
                      Elevation profile · ascent {fmt(prof.gain)} m, descent {fmt(prof.loss)} m (changes over {prof.threshold} m)
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <LineChart data={prof.points.map(p => ({ km: p.distance / 1000, elevation: p.elevation }))} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                        <XAxis dataKey="km" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => `${fmt(v, 3)} km`} stroke="#4a6580" fontSize={11} />
                        <YAxis domain={['auto', 'auto']} width={56} tickFormatter={v => `${fmt(v, 4)}`} stroke="#4a6580" fontSize={11} />
                        <Tooltip formatter={v => `${fmt(Number(v))} m`} labelFormatter={v => `${fmt(Number(v), 4)} km`} contentStyle={{ background: '#030814', border: '1px solid #38bdf8' }} />
                        <Line dataKey="elevation" stroke="#e0a458" dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                );
              })()}

              {f.legs.length > 0 && (
                <details open={f.legs.length <= 12}>
                  <summary>Traverse · {f.legs.length} legs</summary>
                  <div className="tabular-view">
                    <table>
                      <thead>
                        <tr>
                          <th>Leg</th>
                          <th>Distance</th>
                          <th>Bearing (true N)</th>
                          {declination !== null && <th>Bearing (magnetic)</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {f.legs.map(l => (
                          <tr key={`${l.from}-${l.to}`}>
                            <td>
                              {l.from} → {l.to}
                            </td>
                            <td className="num">{units === 'imperial' ? lengthM(l.distance, units) : `${fmt(l.distance, 5)} m`}</td>
                            <td className="num">{l.bearing.toFixed(1)}°</td>
                            {declination !== null && <td className="num">{magneticBearing(l.bearing, declination).toFixed(1)}°</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              <details>
                <summary>Vertices · {f.vertices.length}</summary>
                <div className="tabular-view">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Latitude</th>
                        <th>Longitude</th>
                        <th>UTM</th>
                        {f.elevation && <th>Elev.</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {f.vertices.slice(0, 500).map(v => (
                        <tr key={v.index}>
                          <td>{v.index}</td>
                          <td className="num">{v.lat.toFixed(6)}</td>
                          <td className="num">{v.lon.toFixed(6)}</td>
                          <td>{v.utm}</td>
                          {f.elevation && <td className="num">{v.elevation !== null ? `${fmt(v.elevation)} m` : '—'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {f.vertices.length > 500 && <p className="field-hint">First 500 of {f.vertices.length} vertices shown.</p>}
                </div>
              </details>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
