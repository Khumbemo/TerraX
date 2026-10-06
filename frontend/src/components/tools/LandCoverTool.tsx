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
import { ArtifactImage, Notes, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

const MAX_K = 10;

interface LandCoverJob {
  name: string;
  markdown: string;
  landcover: {
    filename: string;
    bands: number[];
    k: number;
    width: number;
    height: number;
    stats: { id: number; pixels: number; ha: number | null; share: number; bandMeans: number[]; ndvi: number | null; suggestion: string | null }[];
    notes: string[];
  };
  palette: string[];
  map: { bounds: LatLngBounds | null; image: ResultImage };
  downloads: Download[];
}

export default function LandCoverTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const [raster, setRaster] = useState<StoredFile<RasterMeta> | null>(null);
  const [bands, setBands] = useState<number[]>([]);
  const [k, setK] = useState('5');
  const [out, setOut] = useState<LandCoverJob | null>(null);
  const result = out?.landcover ?? null;
  const [labels, setLabels] = useState<string[]>([]);
  const fail = (m: string) => notify(m, 'error');
  const serverLabels = useRef(false);

  const load = async (picked: File | string) => {
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return null;
    setRaster(f);
    setBands(Array.from({ length: f.meta.bands }, (_, i) => i));
    setOut(null);
    onOutput(null);
    if (f.meta.bands < 2) notify(`${f.name} has one band; clusters will split it into value ranges only.`);
    return f;
  };

  const run = async (r = raster, b = bands, names: string[] = []) => {
    if (!r) return;
    const kk = Number(k);
    if (!Number.isInteger(kk) || kk < 2 || kk > MAX_K) return fail(`Choose a whole number of classes from 2 to ${MAX_K}.`);
    const res = await job.run(
      'run',
      (signal, onProgress) => runJob<LandCoverJob>('landcover', { file: r.id }, { bands: b, k: kk, roles: r.meta.guessedBands, boundary, labels: names, seed: 7 }, { signal, onProgress }),
      msg => {
        fail(msg);
        setOut(null);
        onOutput(null);
      },
    );
    if (!res) return;
    setOut(res);
    if (!names.length) {
      serverLabels.current = true;
      setLabels(res.landcover.stats.map(c => (c.suggestion ? `${c.suggestion} (suggested)` : `Class ${c.id}`)));
    }
    onOutput({ tool: 'landcover', name: res.name, markdown: res.markdown, map: res.map, summary: res.landcover, figures: [{ title: 'Land-cover clusters', url: res.map.image.url }] });
  };

  // Renamed classes go into the report and map legend (same seed, so the clusters do not change).
  useEffect(() => {
    if (serverLabels.current || !out) {
      serverLabels.current = false;
      return;
    }
    const t = setTimeout(() => run(raster, out.landcover.bands, labels), 800);
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
        Upload a multispectral GeoTIFF (for example Sentinel-2 B2, B3, B4, B8, B11, B12). TerraX groups pixels with similar spectra into clusters (k-means), maps them and
        reports their areas. You then name each cluster.
      </p>
      <FileDrop id="landcover-file" label="Multispectral image" accept=".tif,.tiff" hint="Multiband GeoTIFF" busy={job.busy === 'upload'} loaded={raster?.name} onFile={f => load(f)} />
      <div className="param-row">
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
        <label className="param">
          <span>Clusters</span>
          <input id="landcover-k" type="number" min="2" max={MAX_K} step="1" value={k} onChange={e => setK(e.target.value)} />
        </label>
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              const r = await load('satellite_4band_synthetic.tif');
              if (r) await run(r, Array.from({ length: r.meta.bands }, (_, i) => i));
            }}
          >
            Try synthetic scene
          </button>
          <button type="button" id="landcover-run" className="btn btn-primary" disabled={!raster || busy || !bands.length} onClick={() => run()}>
            {job.busy === 'run' ? 'Classifying…' : 'Classify'}
          </button>
        </div>
      </div>

      <JobStatus job={job} onCancel={job.cancel} />
      {result && out && (
        <div className="result-block">
          <figure className="raster-figure">
            <ArtifactImage url={out.map.image.url} width={result.width} height={result.height} label="Land-cover clusters" />
          </figure>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Label (edit)</th>
                  <th>Area</th>
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
        </div>
      )}
    </div>
  );
}
