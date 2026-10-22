import { useEffect, useRef, useState } from 'react';
import { request, runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import { downloadText, safeFilename } from '../../lib/download';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

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

interface SampleResult {
  points: number;
  unit: 'ha' | 'px';
  allocation: { label: string; mapped: number; share: number; n: number }[];
  downloads: Download[];
  note: string;
}

interface AccuracyClass {
  label: string;
  samples: number;
  mappedArea: number;
  area: number;
  areaCi: number | null;
  userAccuracy: number | null;
  userCi: number | null;
  producerAccuracy: number | null;
  producerCi: number | null;
}

interface AccuracyResult {
  unit: 'ha' | 'px';
  samples: number;
  unlabelled: number;
  overallAccuracy: number;
  overallCi: number | null;
  classes: AccuracyClass[];
  markdown: string;
}

const jobIdOf = (artifactUrl: string) => artifactUrl.split('/')[3];
const pct = (v: number | null, ci: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %${ci === null ? '' : ` ± ${(ci * 100).toFixed(1)}`}`);

export default function LandCoverTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const shapeFiles = useUpload(['vector'], 'GeoJSON, KML or a zipped shapefile of training shapes');
  const refFiles = useUpload(['table', 'vector'], 'the labelled validation sample (CSV or GeoJSON)');
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
  const [sampleTotal, setSampleTotal] = useState('');
  const [minPerClass, setMinPerClass] = useState('50');
  const [validation, setValidation] = useState<SampleResult | null>(null);
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null);
  const fail = (m: string) => notify(m, 'error');
  const serverLabels = useRef(false);

  const load = async (picked: File | string) => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return null;
    setRaster(f);
    setBands(Array.from({ length: f.meta.bands }, (_, i) => i));
    setOut(null);
    setValidation(null);
    setAccuracy(null);
    onOutput(null);
    if (f.meta.bands < 2) notify(`${f.name} has one band; classes can only split it into value ranges.`);
    return f;
  };

  const loadShapes = async (picked: File | string) => {
    const f = await job.run('shapes', signal => (typeof picked === 'string' ? shapeFiles.sample(picked) : shapeFiles.upload(picked, signal)), fail);
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
    const inputs = m === 'rf' && shapes ? { file: r.id, training: shapes.id } : { file: r.id };
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
      setValidation(null);
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

  const makeSample = async () => {
    if (!out) return;
    const total = sampleTotal.trim() ? Number(sampleTotal) : undefined;
    const min = Number(minPerClass);
    if (total !== undefined && (!Number.isInteger(total) || total < 2)) return fail('Set the sample size as a whole number of points, or leave it empty.');
    if (!Number.isInteger(min) || min < 1) return fail('Set the minimum points per class as a whole number.');
    const s = await job.run('sample', signal => request<SampleResult>(`/api/landcover/${jobIdOf(out.map.image.url)}/sample`, { method: 'POST', json: { total, minPerClass: min, labels }, signal }), fail);
    if (!s) return;
    setValidation(s);
    setAccuracy(null);
    report(out, null);
  };

  const assessFile = async (picked: File) => {
    if (!out) return;
    const f = await job.run('reference', signal => refFiles.upload(picked, signal), fail);
    if (!f) return;
    const a = await job.run('assess', signal => request<AccuracyResult>(`/api/landcover/${jobIdOf(out.map.image.url)}/accuracy`, { method: 'POST', json: { file: f.id }, signal }), fail);
    if (!a) return;
    setAccuracy(a);
    report(out, a);
  };

  const exportCsv = () => {
    if (!result) return;
    const head = ['class', 'label', 'pixels', 'hectares', 'share_percent', 'mean_ndvi', ...result.bands.map(b => `band${b + 1}_mean`)];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = result.stats.map((c, i) => [c.id, q(labels[i] ?? ''), c.pixels, c.ha ?? '', (c.share * 100).toFixed(3), c.ndvi ?? '', ...c.bandMeans].join(','));
    downloadText([head.join(','), ...rows].join('\n'), `${safeFilename(result.filename)}_landcover_classes.csv`, 'text/csv');
  };

  const area = (v: number, unit: 'ha' | 'px') => (unit === 'ha' ? `${fmt(v, 4)} ha` : `${Math.round(v).toLocaleString()} px`);

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
          busy={job.busy === 'shapes'}
          loaded={training?.name}
          onFile={f => loadShapes(f)}
        />
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

          <section className="sub-panel" aria-label="Accuracy assessment">
            <div className="eyebrow">Accuracy and area</div>
            <p className="field-hint">
              Mapped areas include the map’s errors. Draw a stratified random sample, label each point’s true class from field visits or finer imagery (without looking at
              the map), then upload it for accuracy and area estimates with 95 % confidence intervals (Olofsson et al. 2014).
            </p>
            <div className="param-row">
              <label className="param">
                <span>Sample points</span>
                <input id="landcover-sample-total" type="number" min="2" step="1" placeholder={String(100 * result.k)} value={sampleTotal} onChange={e => setSampleTotal(e.target.value)} />
              </label>
              <label className="param">
                <span>Minimum per class</span>
                <input id="landcover-sample-min" type="number" min="1" step="1" value={minPerClass} onChange={e => setMinPerClass(e.target.value)} />
              </label>
              <button type="button" id="landcover-sample" className="btn" disabled={busy} onClick={makeSample}>
                {job.busy === 'sample' ? 'Drawing…' : validation ? 'Draw a new sample' : 'Create validation sample'}
              </button>
            </div>
            {validation && (
              <>
                <div className="tabular-view">
                  <table>
                    <thead>
                      <tr>
                        <th>Class</th>
                        <th>Mapped</th>
                        <th>Share</th>
                        <th>Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.allocation.map(a => (
                        <tr key={a.label}>
                          <td>{a.label}</td>
                          <td className="num">{area(a.mapped, validation.unit)}</td>
                          <td className="num">{(a.share * 100).toFixed(1)} %</td>
                          <td className="num">{a.n}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="button-row">
                  <Downloads idPrefix="landcover-sample" items={validation.downloads} />
                </div>
                <Notes items={[validation.note]} />
                <FileDrop
                  id="landcover-reference"
                  label="Labelled sample"
                  accept=".csv,.geojson,.json"
                  hint="The sample file with its “reference” column filled in"
                  busy={job.busy === 'reference' || job.busy === 'assess'}
                  onFile={f => assessFile(f)}
                />
              </>
            )}
            {accuracy && (
              <>
                <div className="stat-grid">
                  <Stat label="Overall accuracy" value={pct(accuracy.overallAccuracy, accuracy.overallCi)} />
                  <Stat label="Reference points" value={`${accuracy.samples}${accuracy.unlabelled ? ` (${accuracy.unlabelled} unlabelled)` : ''}`} />
                </div>
                <div className="tabular-view">
                  <table id="landcover-accuracy">
                    <thead>
                      <tr>
                        <th>Class</th>
                        <th>Mapped</th>
                        <th>Estimated area (95 % CI)</th>
                        <th>User’s</th>
                        <th>Producer’s</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accuracy.classes.map(c => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td className="num">{area(c.mappedArea, accuracy.unit)}</td>
                          <td className="num">
                            {area(c.area, accuracy.unit)}
                            {c.areaCi === null ? '' : ` ± ${accuracy.unit === 'ha' ? fmt(c.areaCi, 3) : Math.round(c.areaCi).toLocaleString()}`}
                          </td>
                          <td className="num">{pct(c.userAccuracy, c.userCi)}</td>
                          <td className="num">{pct(c.producerAccuracy, c.producerCi)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
