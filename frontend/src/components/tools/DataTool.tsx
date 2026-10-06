import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { runJob, type RasterMeta, type ResultImage, type StoredFile, type TableMeta } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { formatBytes } from '../../lib/report';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolId, ToolOutput } from '../../lib/tools/registry';
import type { BandMap, RasterMode } from '../../lib/types';
import type { Boundary } from '../../lib/zonal';
import type { MetricAnalysis } from '../CoreAnalysisDashboard';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import type { RasterDataset } from '../RasterPanel';
import { useUpload } from '../ToolKit';

const CoreAnalysisDashboard = lazy(() => import('../CoreAnalysisDashboard'));
const RasterPanel = lazy(() => import('../RasterPanel'));
const StackPanel = lazy(() => import('../StackPanel'));
const LiveDataPanel = lazy(() => import('../LiveDataPanel'));
const SentinelSearchPanel = lazy(() => import('../SentinelSearchPanel'));

interface Props {
  variant: Extract<ToolId, 'weather' | 'satellite'>;
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  target: { lat: number; lon: number; name: string };
}

const VARIANTS = {
  weather: {
    intro:
      'Upload station or reanalysis time series (for example IMD, CHIRPS, ERA5, SMAP or MODIS exports) with a date column: rainfall, temperature, humidity, soil moisture, evapotranspiration or radiation. A climate GeoTIFF (one variable per band) also works.',
    label: 'Climate time series or grid',
    hint: 'CSV · TSV · XLSX · GeoTIFF',
    accept: '.csv,.tsv,.txt,.xlsx,.tif,.tiff',
    samples: [
      { file: 'precipitation_data.csv', label: 'Rainfall' },
      { file: 'monthly_climate_1990_2024_synthetic.csv', label: 'Monthly climate 1990–2024' },
      { file: 'temp_humidity_data.csv', label: 'Temperature & humidity' },
      { file: 'evapotranspiration_data.csv', label: 'Evapotranspiration' },
      { file: 'solar_radiation_data.csv', label: 'Solar radiation' },
      { file: 'lst_data.csv', label: 'Land surface temperature' },
    ],
  },
  satellite: {
    intro:
      'Upload a multispectral GeoTIFF (Sentinel-2, Landsat, PlanetScope…) to view composites and compute spectral indices, or a vegetation-index time series (CSV/XLSX) for trend analysis.',
    label: 'Satellite scene or index series',
    hint: 'Multiband GeoTIFF · CSV · XLSX',
    accept: '.tif,.tiff,.csv,.tsv,.txt,.xlsx',
    samples: [
      { file: 'satellite_4band_synthetic.tif', label: 'Synthetic 4-band scene' },
      { file: 'ndvi_data.csv', label: 'NDVI / EVI series' },
    ],
  },
};

interface TableJob {
  name: string;
  markdown: string;
  extraContext: string;
  dataset: TableMeta;
  focus: string | null;
  analyses: Record<string, MetricAnalysis>;
}

interface RasterJob {
  name: string;
  markdown: string;
  dataset: RasterDataset;
  map: { bounds: LatLngBounds | null; image: ResultImage | null };
}

type Loaded = { kind: 'table'; file: StoredFile<TableMeta>; job: TableJob; note?: string } | { kind: 'raster'; file: StoredFile<RasterMeta>; job: RasterJob; notes?: string[] };

const MAX_MB = 500;

export default function DataTool({ variant, onOutput, boundary, target }: Props) {
  const notify = useToast();
  const v = VARIANTS[variant];
  const job = useJob();
  const files = useUpload(['table', 'raster'], 'a table (CSV, TSV, XLSX) or GeoTIFF');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const busy = Boolean(job.busy);
  const fail = (m: string) => notify(m, 'error');

  const openTable = async (f: StoredFile<TableMeta>, focus: string | null, note?: string) => {
    const r = await job.run('run', (signal, onProgress) => runJob<TableJob>('table', { file: f.id }, { focus }, { signal, onProgress }), fail);
    if (!r) return false;
    setLoaded({ kind: 'table', file: f, job: r, note });
    setMetric(r.focus);
    return true;
  };

  const openRaster = async (f: StoredFile<RasterMeta>, view: RasterMode, notes?: string[], clearOnError = false) => {
    const r = await job.run('run', (signal, onProgress) => runJob<RasterJob>('raster', { file: f.id }, { view, boundary }, { signal, onProgress }), msg => {
      fail(msg);
      if (clearOnError) setLoaded(null);
    });
    if (!r) return false;
    if (notes) r.dataset.hints.unshift(...notes);
    setLoaded({ kind: 'raster', file: f, job: r, notes });
    setMetric(null);
    return true;
  };

  const open = async (f: StoredFile) => {
    if (f.kind === 'raster') return openRaster(f as StoredFile<RasterMeta>, { mode: 'band', band: 0 });
    return openTable(f as StoredFile<TableMeta>, (f.meta as TableMeta).defaultMetric);
  };

  const load = async (picked: File | string) => {
    if (typeof picked !== 'string' && picked.size > MAX_MB * 1024 * 1024) return fail(`${picked.name} is larger than ${MAX_MB} MB.`);
    const f = await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (f && (await open(f))) notify(`Loaded ${f.name}.`, 'success');
  };

  const loadTable = async (f: StoredFile, note: string) => {
    if (await openTable(f as StoredFile<TableMeta>, (f.meta as TableMeta).defaultMetric, note)) notify(`Loaded ${((f.meta as TableMeta).rowCount ?? 0).toLocaleString()} days of data.`, 'success');
  };

  const loadLiveRaster = async (f: StoredFile<RasterMeta>, notes: string[]) => {
    if (await openRaster(f, { mode: 'index', index: 'ndvi', bands: { blue: 0, green: 1, red: 2, nir: 3 }, qa: { band: 4, kind: 'scl' } }, notes)) notify(`Loaded ${f.name}.`, 'success');
  };

  const changeView = (mode: RasterMode, clearOnError = false) => {
    if (loaded?.kind === 'raster') openRaster(loaded.file, mode, loaded.notes, clearOnError);
  };

  const changeMetric = (m: string) => {
    setMetric(m);
    // The report leads with the chosen variable.
    if (loaded?.kind === 'table') openTable(loaded.file, m, loaded.note);
  };

  // Keep the report and assistant context in step with what is shown.
  useEffect(() => {
    if (!loaded) {
      onOutput(null);
      return;
    }
    if (loaded.kind === 'table') {
      const j = loaded.job;
      const note = loaded.note ? `## Source\n\n- ${loaded.note}\n\n` : '';
      onOutput({ tool: variant, name: j.name, markdown: note + j.markdown, extraContext: note + j.extraContext, fileId: loaded.file.id, focus: metric, summary: { dataset: j.dataset, analyses: Object.fromEntries(Object.entries(j.analyses).map(([k, a]) => [k, { summary: a.summary, trend: a.trend, start: a.start, end: a.end, classes: a.classification.basis }])) }, map: { bounds: null } });
    } else {
      const j = loaded.job;
      const { preview: _p, ...summary } = j.dataset;
      onOutput({ tool: variant, name: j.name, markdown: j.markdown, summary, map: j.map, figures: j.map.image ? [{ title: j.map.image.label, url: j.map.image.url }] : [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // Re-read the current layer when the analysis boundary changes.
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (loaded?.kind === 'raster') changeView(loaded.job.dataset.view, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const ds = loaded?.kind === 'table' ? loaded.job.dataset : loaded?.job.dataset;
  const typeLabel = !loaded
    ? ''
    : loaded.kind === 'raster'
      ? `GeoTIFF · ${loaded.job.dataset.width}×${loaded.job.dataset.height} px · ${loaded.job.dataset.bands} band${loaded.job.dataset.bands === 1 ? '' : 's'}`
      : `${loaded.job.dataset.format} · ${loaded.job.dataset.rowCount.toLocaleString()} rows · ${loaded.job.dataset.columns.length} columns`;
  const warnings = loaded ? [...(loaded.kind === 'table' && loaded.note ? [`Source: ${loaded.note}`] : []), ...(ds?.warnings ?? [])] : [];

  return (
    <div className="tool-body">
      <p className="tool-intro">{v.intro}</p>
      <FileDrop id={`${variant}-file`} label={v.label} accept={v.accept} hint={v.hint} busy={job.busy === 'upload'} loaded={loaded?.file.name} onFile={f => load(f)} />
      <div className="sample-row">
        <div className="eyebrow">Sample data</div>
        <div className="chip-row">
          {v.samples.map(s => (
            <button key={s.file} type="button" className="chip" disabled={busy} onClick={() => load(s.file)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {loaded && ds && (
        <>
          <div className="dataset-strip">
            <span className="status-dot" aria-hidden="true" />
            <span className="report-title">{loaded.file.name}</span>
            <span className="muted">
              {typeLabel} · {formatBytes(loaded.file.size)}
            </span>
            <button type="button" className="btn btn-small push-right" onClick={() => setLoaded(null)}>
              Close
            </button>
          </div>
          {warnings.length > 0 && (
            <ul className="data-notes" aria-label="Data notes">
              {warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <Suspense fallback={<div className="loading-block">Loading…</div>}>
            {loaded.kind === 'table' ? (
              metric && loaded.job.analyses[metric] ? (
                <CoreAnalysisDashboard key={loaded.file.id} dataset={loaded.job.dataset} analyses={loaded.job.analyses} metric={metric} onMetricChange={changeMetric} />
              ) : (
                <p className="notice">This table has no numeric columns to analyse.</p>
              )
            ) : (
              <RasterPanel key={loaded.file.id} dataset={loaded.job.dataset} fileId={loaded.file.id} guessedBands={(loaded.file.meta.guessedBands ?? {}) as BandMap} busy={busy} onChangeView={changeView} />
            )}
          </Suspense>
        </>
      )}
      {variant === 'satellite' && (
        <Suspense fallback={<div className="loading-block">Loading…</div>}>
          <SentinelSearchPanel target={target} boundary={boundary} onRaster={loadLiveRaster} />
          <StackPanel onOutput={onOutput} boundary={boundary} />
        </Suspense>
      )}
      {variant === 'weather' && (
        <Suspense fallback={<div className="loading-block">Loading…</div>}>
          <LiveDataPanel target={target} onTable={loadTable} />
        </Suspense>
      )}
    </div>
  );
}
