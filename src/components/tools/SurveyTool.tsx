import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { downloadText, safeFilename } from '../../lib/download';
import { toDms } from '../../lib/geo';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { areaHa, elevationM, lengthM } from '../../lib/units';
import type { ToolOutput } from '../../lib/tools/registry';
import { elevationProfile, formatAreaM2, formatLength, magneticBearing, measureSurvey, parseSurveyFile, surveyMarkdown, type SurveyResult } from '../../lib/tools/survey';
import { getJSON, setJSON } from '../../lib/storage';
import { drawnPolygon, editableVertices, makeBoundary, toGpx, toKml } from '../../lib/vector';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import { Stat } from './ForestLossTool';

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
  const [busy, setBusy] = useState(false);
  const [closeRing, setCloseRing] = useState(true);
  const [result, setResult] = useState<SurveyResult | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [declText, setDeclText] = useState<string>(() => getJSON<string>('declination', ''));
  const declNum = Number(declText);
  const declination = declText.trim() !== '' && Number.isFinite(declNum) && Math.abs(declNum) <= 90 ? declNum : null;

  useEffect(() => {
    setJSON('declination', declText);
    if (result) onOutput({ tool: 'survey', name: result.filename, markdown: surveyMarkdown(result, declination), map: { bounds: result.bounds, geojson: result.geojson } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declination]);

  const show = (r: SurveyResult) => {
    setResult(r);
    onOutput({ tool: 'survey', name: r.filename, markdown: surveyMarkdown(r, declination), map: { bounds: r.bounds, geojson: r.geojson } });
  };

  const analyse = async (file: File, close = closeRing) => {
    setBusy(true);
    try {
      const { fc, format, warnings } = await parseSurveyFile(file, close);
      show(measureSurvey(file.name, format, fc, warnings));
      setLastFile(file);
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const finishDrawing = () => {
    if (!drawPoints || drawPoints.length < 3) {
      notify('Click at least three points on the map to make a polygon.', 'error');
      return;
    }
    try {
      const name = result?.format === 'Drawn on map' ? result.filename : 'Drawn plot';
      show(measureSurvey(name, 'Drawn on map', drawnPolygon(drawPoints, name), []));
      setLastFile(null);
      onDraw(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not measure the drawn polygon.', 'error');
    }
  };

  const editVertices = result ? editableVertices(result.geojson) : null;
  const polygonArea = result ? result.features.reduce((a, f) => a + (f.kind === 'Polygon' && f.area !== null ? f.area : 0), 0) : 0;
  const base = result ? safeFilename(result.filename) : 'survey';

  const polys = result ? result.features.filter(f => f.kind === 'Polygon') : [];
  const boundaryName = polys.length === 1 ? polys[0].name : (result?.filename ?? '');
  const isBoundary = Boolean(result && boundary?.name === boundaryName && Math.abs(boundary.areaM2 - polygonArea) < 1e-6);

  const useAsBoundary = () => {
    if (!result) return;
    const b = makeBoundary(boundaryName, result.geojson, polygonArea);
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
      <FileDrop id="survey-file" label="Boundary, track or points" accept={ACCEPT} hint="GeoJSON · KML · GPX · CSV (lat, lon) · zipped Shapefile" busy={busy} loaded={result?.filename} onFile={f => analyse(f)} />
      <div className="param-row">
        <label className="check">
          <input
            id="survey-close"
            type="checkbox"
            checked={closeRing}
            onChange={e => {
              setCloseRing(e.target.checked);
              if (lastFile && /\.(csv|txt)$/i.test(lastFile.name)) analyse(lastFile, e.target.checked);
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
            onClick={async () => {
              try {
                analyse(await fetchSample('samples/survey_plot_synthetic.geojson', 'application/geo+json'));
              } catch (err) {
                notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
              }
            }}
          >
            Try sample plot
          </button>
        </div>
      </div>

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
                const prof = elevationProfile(f);
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
