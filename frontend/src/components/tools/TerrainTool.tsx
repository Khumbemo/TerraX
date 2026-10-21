import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { request, runJob, type Download, type RasterMeta, type ResultImage, type StoredFile, type Summary } from '../../lib/api';
import { downloadText, safeFilename } from '../../lib/download';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { ACRES_PER_HA, elevationM } from '../../lib/units';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  onBoundary?: (b: Boundary) => void;
}

type Layer = 'hillshade' | 'slope' | 'elevation' | 'flow' | 'wetness';
type FlowMethod = 'd8' | 'dinf';

interface TerrainJob {
  name: string;
  markdown: string;
  terrain: {
    filename: string;
    elevation: Summary;
    relief: number;
    hypsometricIntegral: number | null;
    slope: Summary;
    slopeClassCounts: number[];
    aspectCounts: number[];
    width: number;
    height: number;
    notes: string[];
  };
  layers: Record<'hillshade' | 'slope' | 'elevation', string>;
  suggestedInterval: number;
  slopeClasses: { label: string; color: string }[];
  aspects: string[];
  warnings: string[];
  map: { bounds: LatLngBounds | null; image: ResultImage | null };
}

interface HydroJob {
  flow: { width: number; height: number; thresholdM2: number; maxOrder: number; lengthByOrder: number[]; raisedCells: number; maxRaise: number };
  layer: string;
  streams: FeatureCollection | null;
  downloads: Download[];
  notes?: string[];
  method?: FlowMethod;
  /** Topographic wetness index from D∞ flow (method "dinf" only). */
  wetness?: { layer: string; summary: { median: number; q1: number; q3: number; min: number; max: number } | null; range: [number, number]; colors: string[] } | null;
  markdown: string;
}

interface ContourJob {
  contours: { levels: number; lines: number; interval: number; points: number };
  geojson: FeatureCollection;
  downloads: Download[];
  notes?: string[];
}

interface Basin {
  outlet: [number, number];
  cells: number;
  areaM2: number;
  meanElevation: number | null;
  meanSlope: number | null;
  layer: string;
  geojson: FeatureCollection | null;
  markdown: string;
  /** With D∞ flow: the area whose flow reaches the outlet (Σ cell area × share) and the cells sending at least half. */
  dinf?: { contributingM2: number; majorityM2: number; partialCells: number; geojson: FeatureCollection | null };
}

const jobIdOf = (artifactUrl: string) => artifactUrl.split('/')[3];

export default function TerrainTool({ onOutput, boundary, onBoundary }: Props) {
  const notify = useToast();
  const { units } = usePrefs();
  const job = useJob();
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF elevation model');
  const [dem, setDem] = useState<StoredFile<RasterMeta> | null>(null);
  const [out, setOut] = useState<TerrainJob | null>(null);
  const [layer, setLayer] = useState<Layer>('hillshade');
  const [thresholdKm2, setThresholdKm2] = useState('0.5');
  const [flowMethod, setFlowMethod] = useState<FlowMethod>('d8');
  const [flow, setFlow] = useState<HydroJob | null>(null);
  const [basin, setBasin] = useState<Basin | null>(null);
  const [interval, setInterval_] = useState('');
  const [contours, setContours] = useState<ContourJob | null>(null);
  const [showContours, setShowContours] = useState(false);
  const result = out?.terrain ?? null;
  const fail = (m: string) => notify(m, 'error');

  const analyse = async (f: StoredFile<RasterMeta>) => {
    if (f.meta.bands > 1) notify(`${f.name} has ${f.meta.bands} bands; band 1 is read as elevation.`);
    const r = await job.run('run', (signal, onProgress) => runJob<TerrainJob>('terrain', { dem: f.id }, { boundary }, { signal, onProgress }), msg => {
      fail(msg);
      // A re-run (new boundary) failed: do not leave results for the old extent on screen.
      setOut(null);
      onOutput(null);
    });
    if (!r) return;
    setDem(f);
    setOut(r);
    setFlow(null);
    setBasin(null);
    setContours(null);
    pendingContours.current = null;
    setShowContours(false);
    setInterval_(String(r.suggestedInterval));
    if (layer === 'flow' || layer === 'wetness') setLayer('hillshade');
  };

  const pick = async (picked: File | string) => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (f) await analyse(f);
  };

  // Keep the report and map in step with hydrology and contour results.
  useEffect(() => {
    if (!out) return;
    const features = [...(showContours && contours ? contours.geojson.features : []), ...(flow?.streams?.features ?? [])];
    onOutput({
      tool: 'terrain',
      name: out.name,
      markdown: out.markdown + (flow ? flow.markdown + (basin ? `\n${basin.markdown}` : '') : ''),
      map: { ...out.map, geojson: features.length ? { type: 'FeatureCollection', features } : null },
      summary: out.terrain,
      figures: [
        { title: 'Slope classes', url: out.layers.slope },
        { title: 'Hillshade', url: out.layers.hillshade },
        ...(flow ? [{ title: 'Flow and streams', url: basin?.layer ?? flow.layer }] : []),
        ...(flow?.wetness ? [{ title: 'Topographic wetness index (D∞)', url: flow.wetness.layer }] : []),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out, flow, basin, contours, showContours]);

  const computeFlow = async () => {
    if (!dem) return;
    const km2 = Number(thresholdKm2);
    if (!Number.isFinite(km2) || km2 <= 0) return fail('Set the channel threshold as a positive area in km², for example 0.5.');
    const r = await job.run('flow', (signal, onProgress) => runJob<HydroJob>('hydrology', { dem: dem.id }, { thresholdKm2: km2, method: flowMethod, boundary }, { signal, onProgress }), fail);
    if (!r) return;
    setFlow(r);
    setBasin(null);
    setLayer('flow');
  };

  const pickOutlet = async (col: number, row: number) => {
    if (!flow) return;
    const b = await job.run('basin', signal => request<Basin>(`/api/terrain/${jobIdOf(flow.layer)}/watershed`, { method: 'POST', json: { col, row }, signal }), fail);
    if (b) setBasin(b);
  };

  // The contour job in flight, so "Export contours" pressed while the map is
  // still loading them waits for that job instead of cancelling it.
  const pendingContours = useRef<{ iv: number; promise: Promise<ContourJob | null> } | null>(null);

  const loadContours = async (iv: number): Promise<ContourJob | null> => {
    if (!dem) return null;
    if (contours && contours.contours.interval === iv) return contours;
    if (!Number.isFinite(iv) || iv <= 0) {
      fail('Set a positive contour interval in metres.');
      return null;
    }
    if (pendingContours.current?.iv === iv) return pendingContours.current.promise;
    const promise = job.run('contours', (signal, onProgress) => runJob<ContourJob>('contours', { dem: dem.id }, { interval: iv, boundary }, { signal, onProgress }), fail);
    pendingContours.current = { iv, promise };
    const r = await promise;
    if (pendingContours.current?.promise === promise) pendingContours.current = null;
    if (r) setContours(r);
    return r;
  };

  // Contours on the map follow the interval.
  useEffect(() => {
    if (!showContours) return;
    const t = setTimeout(() => loadContours(Number(interval)), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showContours, interval]);

  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (dem) analyse(dem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const base = dem ? safeFilename(dem.name) : 'dem';
  const busy = Boolean(job.busy);
  const slopeTotal = result ? result.slopeClassCounts.reduce((a, b) => a + b, 0) || 1 : 1;
  const aspTotal = result ? result.aspectCounts.reduce((a, b) => a + b, 0) || 1 : 1;
  const image = !out
    ? null
    : layer === 'flow' && flow
      ? (basin?.layer ?? flow.layer)
      : layer === 'wetness' && flow?.wetness
        ? flow.wetness.layer
        : out.layers[layer === 'flow' || layer === 'wetness' ? 'hillshade' : layer];

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload a digital elevation model (single-band GeoTIFF in metres), for example SRTM (USGS/SRTMGL1_003), Copernicus GLO-30 or ASTER GDEM exported from Earth
        Engine, in any coordinate reference system: pixel sizes are measured in metres on the ground.
      </p>
      <FileDrop id="terrain-file" label="Elevation model (DEM)" accept=".tif,.tiff" hint="GeoTIFF · elevation in metres" busy={job.busy === 'upload'} loaded={dem?.name} onFile={f => pick(f)} />
      <div className="param-row">
        <div className="button-row push-right">
          <button type="button" className="btn" disabled={busy} onClick={() => pick('terrain_dem_synthetic.tif')}>
            Try synthetic DEM
          </button>
        </div>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {result && out && image && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Elevation range" value={`${elevationM(result.elevation.min, units)} – ${elevationM(result.elevation.max, units)}`} />
            <Stat label="Relief" value={elevationM(result.relief, units)} />
            <Stat label="Mean slope" value={`${fmt(result.slope.mean)}°`} />
            <Stat label="Hypsometric integral" value={fmt(result.hypsometricIntegral, 3)} />
          </div>

          <div className="view-toggles" role="tablist">
            {(['hillshade', 'slope', 'elevation', ...(flow ? ['flow'] : []), ...(flow?.wetness ? ['wetness'] : [])] as Layer[]).map(l => (
              <button key={l} type="button" role="tab" aria-selected={layer === l} className={layer === l ? 'active' : ''} onClick={() => setLayer(l)}>
                {l === 'hillshade' ? 'Hillshade' : l === 'slope' ? 'Slope classes' : l === 'elevation' ? 'Elevation' : l === 'flow' ? 'Flow & streams' : 'Wetness (TWI)'}
              </button>
            ))}
          </div>
          <figure className="raster-figure">
            <ArtifactImage url={image} width={result.width} height={result.height} label={`${layer} of ${result.filename}`} onPick={layer === 'flow' ? pickOutlet : undefined} />
            {layer === 'flow' && <figcaption className="field-hint">Streams are blue (darker = higher Strahler order). Click a stream to outline the watershed draining to that point.</figcaption>}
            {layer === 'wetness' && flow?.wetness && (
              <figcaption>
                <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${flow.wetness.colors.join(', ')})` }} />
                <div className="legend-labels">
                  <span>{fmt(flow.wetness.range[0], 3)} dry</span>
                  <span>ln(a / tan β)</span>
                  <span>wet {fmt(flow.wetness.range[1], 3)}</span>
                </div>
              </figcaption>
            )}
            {layer === 'elevation' && (
              <figcaption className="legend-labels">
                <span>{fmt(result.elevation.min)} m</span>
                <span>viridis</span>
                <span>{fmt(result.elevation.max)} m</span>
              </figcaption>
            )}
          </figure>

          <section className="sub-panel" aria-label="Hydrology and contours">
            <div className="eyebrow">Hydrology & contours</div>
            <div className="param-row">
              <label className="param" title="Cells draining at least this area are channels.">
                <span>Channel threshold (km²)</span>
                <input id="terrain-threshold" type="number" step="0.1" min="0.01" value={thresholdKm2} onChange={e => setThresholdKm2(e.target.value)} />
              </label>
              <label className="param" title="D8 sends all flow to one neighbour; D∞ splits it between two, which also gives the topographic wetness index.">
                <span>Flow accumulation</span>
                <select id="terrain-flow-method" value={flowMethod} onChange={e => setFlowMethod(e.target.value as FlowMethod)}>
                  <option value="d8">D8 (streams)</option>
                  <option value="dinf">D∞ + wetness index</option>
                </select>
              </label>
              <button type="button" id="terrain-flow" className="btn" onClick={computeFlow} disabled={busy}>
                {job.busy === 'flow' ? 'Routing flow…' : flow ? 'Recompute flow' : 'Compute flow & streams'}
              </button>
              <label className="param">
                <span>Contour interval (m)</span>
                <input id="terrain-interval" type="number" step="1" min="0.1" value={interval} onChange={e => setInterval_(e.target.value)} />
              </label>
              <label className="check">
                <input id="terrain-contours" type="checkbox" checked={showContours} onChange={e => setShowContours(e.target.checked)} /> Contours on map
              </label>
            </div>
            {flow && (
              <div className="stat-grid">
                <Stat label="Highest stream order" value={String(flow.flow.maxOrder)} />
                <Stat label="Channel length" value={`${fmt(flow.flow.lengthByOrder.reduce((a, b) => a + b, 0) / 1000, 4)} km`} />
                {flow.wetness?.summary && <Stat label="Median wetness index" value={fmt(flow.wetness.summary.median, 3)} />}
                {basin && <Stat label="Watershed area" value={units === 'imperial' ? `${fmt(((basin.areaM2 / 1e4) * ACRES_PER_HA) / 640, 4)} mi²` : `${fmt(basin.areaM2 / 1e6, 4)} km²`} />}
                {basin && <Stat label="Watershed mean slope" value={`${fmt(basin.meanSlope, 3)}°`} />}
                {basin?.dinf && <Stat label="D∞ area reaching the outlet" value={units === 'imperial' ? `${fmt(((basin.dinf.contributingM2 / 1e4) * ACRES_PER_HA) / 640, 4)} mi²` : `${fmt(basin.dinf.contributingM2 / 1e6, 4)} km²`} />}
              </div>
            )}
            {flow && <Notes items={flow.notes ?? []} />}
            {showContours && contours && <Notes items={contours.notes ?? []} />}
            <div className="button-row">
              {basin && onBoundary && (
                <button
                  type="button"
                  id="watershed-boundary"
                  className="btn btn-primary"
                  onClick={() => {
                    if (!basin.geojson) return fail('This DEM’s CRS cannot be turned into a boundary polygon.');
                    onBoundary({ name: `Watershed of ${result.filename}`, geojson: basin.geojson as Boundary['geojson'], areaM2: basin.areaM2 });
                    notify('The watershed is now the analysis boundary.', 'success');
                  }}
                >
                  Use watershed as analysis boundary
                </button>
              )}
              {basin?.geojson && (
                <button type="button" className="btn btn-small" onClick={() => downloadText(JSON.stringify(basin.geojson), `${base}_watershed.geojson`, 'application/geo+json')}>
                  Export watershed
                </button>
              )}
              {basin?.dinf?.geojson && (
                <button type="button" className="btn btn-small" onClick={() => downloadText(JSON.stringify(basin.dinf!.geojson), `${base}_watershed_dinf.geojson`, 'application/geo+json')}>
                  Export D∞ watershed (≥ 50 % of flow)
                </button>
              )}
              <Downloads idPrefix="terrain-streams" items={flow?.downloads} ids={['terrain-export-streams']} />
              <button
                type="button"
                id="terrain-export-contours"
                className="btn btn-small"
                disabled={busy}
                onClick={async () => {
                  const c = await loadContours(Number(interval));
                  if (!c) return;
                  if (!c.geojson.features.length) notify('No contours at that interval.');
                  else downloadText(JSON.stringify(c.geojson), c.downloads[0]?.filename ?? `${base}_contours_${interval}m.geojson`, 'application/geo+json');
                }}
              >
                Export contours
              </button>
            </div>
          </section>

          <div className="two-col">
            <div className="class-bars">
              <div className="eyebrow">Slope classes (descriptive)</div>
              {out.slopeClasses.map((c, i) => (
                <div key={c.label} className="class-row">
                  <span className="class-swatch" style={{ background: c.color }} aria-hidden="true" />
                  <span className="class-name">{c.label}</span>
                  <span className="class-bar-track">
                    <span className="class-bar" style={{ width: `${(result.slopeClassCounts[i] / slopeTotal) * 100}%`, background: c.color }} />
                  </span>
                  <span className="class-count">{((result.slopeClassCounts[i] / slopeTotal) * 100).toFixed(1)} %</span>
                </div>
              ))}
            </div>
            <div className="class-bars">
              <div className="eyebrow">Aspect of non-flat slopes</div>
              {out.aspects.map((a, i) => (
                <div key={a} className="class-row aspect-row">
                  <span className="class-name">{a}</span>
                  <span className="class-bar-track">
                    <span className="class-bar" style={{ width: `${(result.aspectCounts[i] / aspTotal) * 100}%`, background: '#38bdf8' }} />
                  </span>
                  <span className="class-count">{((result.aspectCounts[i] / aspTotal) * 100).toFixed(1)} %</span>
                </div>
              ))}
            </div>
          </div>

          <Notes items={[...result.notes, ...out.warnings]} />
        </div>
      )}
    </div>
  );
}
