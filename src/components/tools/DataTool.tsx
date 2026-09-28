import { Suspense, lazy, useEffect, useState } from 'react';
import { checkSize, isGeoTiff, parseTableFile } from '../../lib/parseFile';
import { readRaster } from '../../lib/raster';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { buildAiContext, buildLocalReport, formatBytes } from '../../lib/report';
import { fetchSample } from '../../lib/samples';
import { useToast } from '../../lib/toast';
import type { ToolId, ToolOutput } from '../../lib/tools/registry';
import type { Dataset, RasterMode } from '../../lib/types';
import FileDrop from '../FileDrop';

const CoreAnalysisDashboard = lazy(() => import('../CoreAnalysisDashboard'));
const RasterPanel = lazy(() => import('../RasterPanel'));

interface Props {
  variant: Extract<ToolId, 'weather' | 'satellite'>;
  onOutput: (out: ToolOutput | null) => void;
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
      { file: 'samples/satellite_4band_synthetic.tif', label: 'Synthetic 4-band scene' },
      { file: 'ndvi_data.csv', label: 'NDVI / EVI series' },
    ],
  },
};

export default function DataTool({ variant, onOutput }: Props) {
  const notify = useToast();
  const v = VARIANTS[variant];
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [raster, setRaster] = useState<OpenRaster | null>(null);
  const [metric, setMetric] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (file: File) => {
    setBusy(true);
    try {
      checkSize(file);
      if (isGeoTiff(file)) {
        const r = await openGeoTiff(file);
        const ds = await readRaster(file, { mode: 'band', band: 0 }, r);
        setRaster(r);
        setDataset(ds);
        setMetric(null);
      } else {
        const ds = await parseTableFile(file);
        setRaster(null);
        setDataset(ds);
        setMetric(ds.defaultMetric);
      }
      notify(`Loaded ${file.name}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const changeView = async (mode: RasterMode) => {
    if (!raster || !dataset) return;
    setBusy(true);
    try {
      setDataset(await readRaster(new File([], dataset.filename), mode, raster));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not compute that layer.', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Keep the report and assistant context in step with what is shown.
  useEffect(() => {
    if (!dataset) {
      onOutput(null);
      return;
    }
    onOutput({
      tool: variant,
      name: dataset.filename,
      markdown: buildLocalReport(dataset, metric),
      extraContext: buildAiContext(dataset, metric),
      dataset,
      focus: metric,
      map: { bounds: dataset.kind === 'raster' ? dataset.latLngBounds : null },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, metric]);

  const typeLabel = dataset
    ? dataset.kind === 'raster'
      ? `GeoTIFF · ${dataset.width}×${dataset.height} px · ${dataset.bands} band${dataset.bands === 1 ? '' : 's'}`
      : `${dataset.format} · ${dataset.rows.length.toLocaleString()} rows · ${dataset.columns.length} columns`
    : '';

  return (
    <div className="tool-body">
      <p className="tool-intro">{v.intro}</p>
      <FileDrop id={`${variant}-file`} label={v.label} accept={v.accept} hint={v.hint} busy={busy && !dataset} loaded={dataset?.filename} onFile={load} />
      <div className="sample-row">
        <div className="eyebrow">Sample data</div>
        <div className="chip-row">
          {v.samples.map(s => (
            <button
              key={s.file}
              type="button"
              className="chip"
              disabled={busy}
              onClick={async () => {
                try {
                  await load(await fetchSample(s.file));
                } catch (err) {
                  notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
                }
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {dataset && (
        <>
          <div className="dataset-strip">
            <span className="status-dot" aria-hidden="true" />
            <span className="report-title">{dataset.filename}</span>
            <span className="muted">
              {typeLabel} · {formatBytes(dataset.sizeBytes)}
            </span>
            <button
              type="button"
              className="btn btn-small push-right"
              onClick={() => {
                setDataset(null);
                setRaster(null);
              }}
            >
              Close
            </button>
          </div>
          {dataset.warnings.length > 0 && (
            <ul className="data-notes" aria-label="Data notes">
              {dataset.warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <Suspense fallback={<div className="loading-block">Loading…</div>}>
            {dataset.kind === 'table' ? (
              metric ? (
                <CoreAnalysisDashboard key={dataset.id} dataset={dataset} metric={metric} onMetricChange={setMetric} />
              ) : (
                <p className="notice">This table has no numeric columns to analyse.</p>
              )
            ) : (
              <RasterPanel key={dataset.filename} dataset={dataset} raster={raster} busy={busy} onChangeView={changeView} />
            )}
          </Suspense>
        </>
      )}
    </div>
  );
}
