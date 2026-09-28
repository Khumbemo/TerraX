import { useState } from 'react';
import { toDms } from '../../lib/geo';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import type { ToolOutput } from '../../lib/tools/registry';
import { formatAreaM2, formatLength, measureSurvey, parseSurveyFile, surveyMarkdown, type SurveyResult } from '../../lib/tools/survey';
import FileDrop from '../FileDrop';
import { Stat } from './ForestLossTool';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
}

const ACCEPT = '.geojson,.json,.kml,.gpx,.csv,.txt,.zip';

export default function SurveyTool({ onOutput }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [closeRing, setCloseRing] = useState(true);
  const [result, setResult] = useState<SurveyResult | null>(null);
  const [lastFile, setLastFile] = useState<File | null>(null);

  const analyse = async (file: File, close = closeRing) => {
    setBusy(true);
    try {
      const { fc, format, warnings } = await parseSurveyFile(file, close);
      const r = measureSurvey(file.name, format, fc, warnings);
      setResult(r);
      setLastFile(file);
      onOutput({ tool: 'survey', name: file.name, markdown: surveyMarkdown(r), map: { bounds: r.bounds, geojson: r.geojson } });
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tool-body">
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
        <div className="button-row push-right">
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
                {f.area !== null && <Stat label="Area" value={formatAreaM2(f.area)} />}
                {f.length !== null && <Stat label={f.kind === 'Polygon' ? 'Perimeter' : 'Length'} value={formatLength(f.length)} />}
                <Stat label="Centroid" value={`${toDms(f.centroid[0], 'N', 'S')}, ${toDms(f.centroid[1], 'E', 'W')}`} />
                {f.elevation && <Stat label="Elevation (file)" value={`${fmt(f.elevation.min)}–${fmt(f.elevation.max)} m`} />}
              </div>
              <p className="field-hint">Method: {f.method}.</p>

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
                        </tr>
                      </thead>
                      <tbody>
                        {f.legs.map(l => (
                          <tr key={`${l.from}-${l.to}`}>
                            <td>
                              {l.from} → {l.to}
                            </td>
                            <td className="num">{fmt(l.distance, 5)} m</td>
                            <td className="num">{l.bearing.toFixed(1)}°</td>
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
