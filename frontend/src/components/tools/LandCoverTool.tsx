import { useEffect, useRef, useState } from 'react';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import { downloadText, safeFilename } from '../../lib/download';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Notes, Stat, useUpload } from '../ToolKit';
import MapValidation, { type AccuracyResult } from './MapValidation';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

const MAX_K = 10;
type Method = 'kmeans' | 'rf';

interface LandCoverJob {
  name: string;
  markdown: string;
  labels: string[];
  landcover: {
    filename: string;
    bands: number[];
    k: number;
    width: number;
    height: number;
    method: Method;
    stats: { id: number; pixels: number; ha: number | null; share: number; bandMeans: number[]; ndvi: number | null; suggestion?: string | null; label?: string }[];
    validation?: { folds: number; overall: number } | null;
    notes: string[];
  };
  palette: string[];
  map: { bounds: LatLngBounds | null; image: ResultImage };
  downloads: Download[];
}

const jobIdOf = (artifactUrl: string) => artifactUrl.split('/')[3];

export default function LandCoverTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const job = useJob();
  // Training shapes and radar upload on their own jobs, so neither cancels an upload still running on another.
  const shapesJob = useJob();
  const radarJob = useJob();
  const radarFiles = useUpload<RasterMeta>(['raster'], 'a Sentinel-1 GeoTIFF with VV and VH bands');
  const [radar, setRadar] = useState<StoredFile<RasterMeta> | null>(null);
  const busy = Boolean(job.busy || shapesJob.busy || radarJob.busy);
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const shapeFiles = useUpload(['vector'], 'GeoJSON, KML or a zipped shapefile of training shapes');
  const [raster, setRaster] = useState<StoredFile<RasterMeta> | null>(null);
  const [bands, setBands] = useState<number[]>([]);
  const [method, setMethod] = useState<Method>('kmeans');
  const [k, setK] = useState('5');
  const [training, setTraining] = useState<StoredFile | null>(null);
  const [labelField, setLabelField] = useState('');
  const [trees, setTrees] = useState('100');
  const [out, setOut] = useState<LandCoverJob | null>(null);
  const result = out?.landcover ?? null;
  const [labels, setLabels] = useState<string[]>([]);
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null);
  const fail = (m: string) => notify(m, 'error');
  const serverLabels = useRef(false);

  const load = async (picked: File | string) => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return null;
    setRaster(f);
    setBands(Array.from({ length: f.meta.bands }, (_, i) => i));
    setOut(null);
    setAccuracy(null);
    onOutput(null);
    if (f.meta.bands < 2) notify(`${f.name} has one band; classes can only split it into value ranges.`);
    return f;
  };

  const loadShapes = async (picked: File | string) => {
    const f = await shapesJob.run('shapes', signal => (typeof picked === 'string' ? shapeFiles.sample(picked) : shapeFiles.upload(picked, signal)), fail);
    if (f) setTraining(f);
    return f;
  };

  const report = (res: LandCoverJob, acc: AccuracyResult | null) =>
    onOutput({
      tool: 'landcover',
      name: res.name,
      markdown: res.markdown + (acc ? acc.markdown : ''),
      map: res.map,
      summary: res.landcover,
      figures: [{ title: res.landcover.method === 'rf' ? 'Land-cover classes' : 'Land-cover clusters', url: res.map.image.url }],
    });

  const run = async (r = raster, b = bands, names: string[] = [], m = method, shapes = training) => {
    if (!r) return;
    const kk = Number(k);
    if (m === 'kmeans' && (!Number.isInteger(kk) || kk < 2 || kk > MAX_K)) return fail(`Choose a whole number of classes from 2 to ${MAX_K}.`);
    if (m === 'rf' && !shapes) return fail('Add training shapes first: polygons or points with a property naming each one’s class.');
    const inputs = m === 'rf' && shapes ? { file: r.id, training: shapes.id, ...(radar ? { radar: radar.id } : {}) } : { file: r.id };
    const params = { method: m, bands: b, k: kk, roles: r.meta.guessedBands, boundary, labels: names, labelField: labelField.trim() || undefined, trees: Number(trees), seed: 7 };
    const res = await job.run('run', (signal, onProgress) => runJob<LandCoverJob>('landcover', inputs, params, { signal, onProgress }), msg => {
      fail(msg);
      setOut(null);
      onOutput(null);
    });
    if (!res) return;
    setOut(res);
    if (!names.length) {
      serverLabels.current = true;
      setLabels(res.landcover.method === 'rf' ? res.labels : res.landcover.stats.map(c => (c.suggestion ? `${c.suggestion} (suggested)` : `Class ${c.id}`)));
      setAccuracy(null);
    }
    report(res, names.length ? accuracy : null);
  };

  // Renamed classes go into the report and map legend (same seed, so the classes do not change).
  useEffect(() => {
    if (serverLabels.current || !out) {
      serverLabels.current = false;
      return;
    }
    const t = setTimeout(() => run(raster, out.landcover.bands, labels, out.landcover.method), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels]);

  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const exportCsv = () => {
    if (!result) return;
    const head = ['class', 'label', 'pixels', 'hectares', 'share_percent', 'mean_ndvi', ...result.bands.map(b => `band${b + 1}_mean`)];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = result.stats.map((c, i) => [c.id, q(labels[i] ?? ''), c.pixels, c.ha ?? '', (c.share * 100).toFixed(3), c.ndvi ?? '', ...c.bandMeans].join(','));
    downloadText([head.join(','), ...rows].join('\n'), `${safeFilename(result.filename)}_landcover_classes.csv`, 'text/csv');
  };


  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload a multispectral GeoTIFF (for example Sentinel-2 B2, B3, B4, B8, B11, B12). TerraX either groups pixels with similar spectra into clusters (k-means) for you to
        name, or learns your classes from training shapes (random forest). Then check the map with a stratified sample to get its accuracy and area estimates with
        confidence intervals.
      </p>
      <FileDrop id="landcover-file" label="Multispectral image" accept=".tif,.tiff" hint="Multiband GeoTIFF" busy={job.busy === 'upload'} loaded={raster?.name} onFile={f => load(f)} />
      <div className="param-row">
        <label className="param">
          <span>Method</span>
          <select id="landcover-method" value={method} onChange={e => setMethod(e.target.value as Method)}>
            <option value="kmeans">k-means clusters (unsupervised)</option>
            <option value="rf">Random forest (training shapes)</option>
          </select>
        </label>
        {raster && raster.meta.bands > 1 && (
          <fieldset className="band-checks">
            <legend>Bands</legend>
            {Array.from({ length: raster.meta.bands }, (_, i) => (
              <label key={i} className="check">
                <input type="checkbox" checked={bands.includes(i)} onChange={e => setBands(b => (e.target.checked ? [...b, i].sort((x, y) => x - y) : b.filter(x => x !== i)))} /> {i + 1}
              </label>
            ))}
          </fieldset>
        )}
        {method === 'kmeans' && (
          <label className="param">
            <span>Clusters</span>
            <input id="landcover-k" type="number" min="2" max={MAX_K} step="1" value={k} onChange={e => setK(e.target.value)} />
          </label>
        )}
        {method === 'rf' && (
          <label className="param" title="The property naming each shape's class; left empty, TerraX looks for class, label, landcover, type or name.">
            <span>Class property</span>
            <input id="landcover-label-field" placeholder="class" value={labelField} onChange={e => setLabelField(e.target.value)} />
          </label>
        )}
        {method === 'rf' && (
          <label className="param" title="Time grows with the number of trees; accuracy barely changes beyond about 100 (Probst & Boulesteix 2018). 50 runs in half the time.">
            <span>Trees</span>
            <select id="landcover-trees" value={trees} onChange={e => setTrees(e.target.value)}>
              <option value="50">50 (about twice as fast)</option>
              <option value="100">100</option>
              <option value="200">200</option>
            </select>
          </label>
        )}
      </div>
      {method === 'rf' && (
        <FileDrop
          id="landcover-training"
          label="Training shapes"
          accept=".geojson,.json,.kml,.zip"
          hint="Polygons or points with a class property · GeoJSON, KML or zipped shapefile · at least two shapes per class"
          busy={Boolean(shapesJob.busy)}
          loaded={training?.name}
          onFile={f => loadShapes(f)}
        />
      )}
      {method === 'rf' && (
        <FileDrop
          id="landcover-radar"
          label="Radar (optional)"
          accept=".tif,.tiff"
          compact
          hint="Sentinel-1 VV and VH (bands 1 and 2), dB or linear · added as VV, VH and VH/VV in dB · reprojected onto the image’s grid if needed"
          busy={Boolean(radarJob.busy)}
          loaded={radar?.name}
          onFile={async f => {
            const up = await radarJob.run('radar', signal => radarFiles.upload(f, signal), m => notify(m, 'error'));
            if (up) setRadar(up);
          }}
        />
      )}
      {method === 'rf' && radar && (
        <button type="button" className="btn btn-small" onClick={() => setRadar(null)}>
          Remove radar
        </button>
      )}
      <div className="param-row">
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              const r = await load('satellite_4band_synthetic.tif');
              if (!r) return;
              const b = Array.from({ length: r.meta.bands }, (_, i) => i);
              if (method === 'rf') {
                const s = await loadShapes('landcover_training_synthetic.geojson');
                if (s) await run(r, b, [], 'rf', s);
              } else await run(r, b);
            }}
          >
            Try synthetic scene
          </button>
          <button type="button" id="landcover-run" className="btn btn-primary" disabled={!raster || busy || !bands.length || (method === 'rf' && !training)} onClick={() => run()}>
            {job.busy === 'run' ? 'Classifying…' : 'Classify'}
          </button>
        </div>
      </div>

      <JobStatus job={job} onCancel={job.cancel} />
      {result && out && (
        <div className="result-block">
          <figure className="raster-figure">
            <ArtifactImage url={out.map.image.url} width={result.width} height={result.height} label={result.method === 'rf' ? 'Land-cover classes' : 'Land-cover clusters'} />
          </figure>
          {result.method === 'rf' && result.validation && (
            <div className="stat-grid">
              <Stat label="Cross-validated by shape" value={`${(result.validation.overall * 100).toFixed(1)} %`} />
              <Stat label="Folds" value={String(result.validation.folds)} />
            </div>
          )}
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Label (edit)</th>
                  <th>Mapped area</th>
                  <th>Share</th>
                  <th>Mean NDVI</th>
                </tr>
              </thead>
              <tbody>
                {result.stats.map((c, i) => (
                  <tr key={c.id}>
                    <td>
                      <i className="class-swatch" style={{ background: out.palette[c.id - 1] }} /> {c.id}
                    </td>
                    <td>
                      <input
                        className="label-input"
                        id={`landcover-label-${c.id}`}
                        aria-label={`Label for class ${c.id}`}
                        value={labels[i] ?? ''}
                        onChange={e => setLabels(l => l.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                    </td>
                    <td className="num">{c.ha === null ? `${c.pixels.toLocaleString()} px` : `${fmt(c.ha, 4)} ha`}</td>
                    <td className="num">{(c.share * 100).toFixed(1)} %</td>
                    <td className="num">{c.ndvi === null ? '—' : fmt(c.ndvi, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button type="button" className="btn btn-small push-right" onClick={exportCsv}>
              Export class table (CSV)
            </button>
          </div>
          <Notes items={result.notes} />

          <MapValidation
            key={jobIdOf(out.map.image.url)}
            jobId={jobIdOf(out.map.image.url)}
            idPrefix="landcover"
            labels={labels}
            classes={result.k}
            intro="Mapped areas include the map’s errors. Draw a stratified random sample, label each point’s true class from field visits or finer imagery (without looking at the map), then upload it for accuracy and area estimates with 95 % confidence intervals (Olofsson et al. 2014)."
            onAccuracy={a => {
              setAccuracy(a);
              report(out, a);
            }}
          />
        </div>
      )}
    </div>
  );
}
