import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile, type Trend } from '../lib/api';
import type { LatLngBounds } from '../lib/geo';
import { INDICES } from '../lib/indices';
import { fmt, fmtP } from '../lib/stats';
import { useToast } from '../lib/toast';
import { useJob } from '../lib/useJob';
import type { ToolOutput } from '../lib/tools/registry';
import type { SpectralIndex } from '../lib/types';
import type { Boundary } from '../lib/zonal';
import FileDrop from './FileDrop';
import JobStatus from './JobStatus';
import { Downloads, Notes, useUpload } from './ToolKit';

interface StackResult {
  label: string;
  rows: { filename: string; date: string; mean: number; median: number; validFraction: number; sparse: boolean }[];
  trend: Trend | null;
  notes: string[];
}

interface BreaksResult {
  label: string;
  dates: string[];
  minDrop: number;
  analysedPixels: number;
  disturbedPixels: number;
  disturbedHa: number | null;
  byDate: { date: string; previous: string; pixels: number; ha: number | null }[];
  legend: { id: number; label: string; color: number[] }[];
  notes: string[];
}

interface StackJob {
  name: string;
  markdown: string;
  series: StackResult;
  breaks?: BreaksResult;
  map?: { bounds: LatLngBounds | null; image: ResultImage | null };
  downloads?: Download[];
}

interface Props {
  onOutput: (out: ToolOutput) => void;
  boundary: Boundary | null;
}

const SERIES_SAMPLES = ['2019-03-10', '2020-03-14', '2021-03-09', '2022-03-12', '2023-03-15', '2024-03-11'].map(d => `series_ndvi_${d}_synthetic.tif`);

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };

export default function StackPanel({ onOutput, boundary }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const uploads = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster');
  const [index, setIndex] = useState<SpectralIndex>('ndvi');
  const [files, setFiles] = useState<StoredFile<RasterMeta>[]>([]);
  const [result, setResult] = useState<StackResult | null>(null);
  const [mapBreaks, setMapBreaks] = useState(false);
  const [minDrop, setMinDrop] = useState('0.15');
  const [breaks, setBreaks] = useState<StackJob | null>(null);
  const fail = (m: string) => notify(m, 'error');

  const run = async (list: StoredFile<RasterMeta>[], idx: SpectralIndex = index) => {
    const drop = Number(minDrop);
    if (mapBreaks && !(drop > 0 && drop <= 2)) return fail('Set the smallest drop to map between 0 and 2 (for NDVI, 0.15 is common).');
    const params = { index: idx, bands: list[0].meta.guessedBands, boundary, ...(mapBreaks ? { mapBreaks: true, minDrop: drop } : {}) };
    const r = await job.run('run', (signal, onProgress) => runJob<StackJob>('stack', { files: list.map(f => f.id) }, params, { signal, onProgress }), fail);
    if (!r) return;
    setFiles(list);
    setResult(r.series);
    setBreaks(r.breaks ? r : null);
    onOutput({ tool: 'satellite', name: r.name, markdown: r.markdown, summary: r.series, ...(r.map?.image ? { map: r.map, figures: [{ title: 'Disturbance date', url: r.map.image.url }] } : {}) });
  };

  const add = async (picked: File[] | string[]) => {
    const list = await job.run('upload', async signal => {
      const out: StoredFile<RasterMeta>[] = [];
      for (const p of picked) out.push(typeof p === 'string' ? await uploads.sample(p) : await uploads.upload(p, signal));
      return out;
    }, fail);
    if (!list) return;
    if (list.length < 2) return fail('Add at least two images from different dates (select several files at once).');
    await run(list);
  };

  const t = result?.trend;
  return (
    <section className="sub-panel" aria-label="Multi-date series">
      <div className="eyebrow">Time series from several images</div>
      <p className="field-hint">
        Upload two or more GeoTIFFs of the same area from different dates, with the date in each file name (2024-03-15, 20240315 or 2024_075). Single-band files are
        read as the index directly; multi-band files use bands in wavelength order (B2, B3, B4, B8…).
      </p>
      <div className="param-row">
        <label className="inline-select">
          <span>Index</span>
          <select id="stack-index" value={index} onChange={e => setIndex(e.target.value as SpectralIndex)}>
            {INDICES.map(i => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => add(SERIES_SAMPLES)}
        >
          Try synthetic 6-date series
        </button>
        <label className="inline-check" title="Test every pixel for one abrupt drop on its trend and map when it happened. Needs at least 5 dates on one grid.">
          <input id="stack-breaks" type="checkbox" checked={mapBreaks} onChange={e => setMapBreaks(e.target.checked)} /> Map disturbances per pixel
        </label>
        {mapBreaks && (
          <label className="param">
            <span>Smallest drop</span>
            <input id="stack-min-drop" type="number" min="0.01" max="2" step="0.05" value={minDrop} onChange={e => setMinDrop(e.target.value)} />
          </label>
        )}
        {files.length > 1 && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(files)}>
            Recompute
          </button>
        )}
      </div>
      <FileDrop id="stack-files" compact label="Images from several dates" accept=".tif,.tiff" hint="GeoTIFFs · date in the file name" busy={job.busy === 'upload'} loaded={files.length ? `${files.length} images` : null} onFile={f => add([f])} onFiles={add} />
      <JobStatus job={job} onCancel={job.cancel} />
      {result && (
        <>
          <div className="render-window">
            <div className="eyebrow">{result.label} · mean per image</div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={result.rows.filter(r => !r.sparse).map(r => ({ date: r.date, mean: r.mean }))} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                <XAxis dataKey="date" {...AXIS} />
                <YAxis {...AXIS} width={56} domain={['auto', 'auto']} tickFormatter={v => fmt(v, 3)} />
                <Tooltip formatter={v => fmt(Number(v))} contentStyle={{ background: '#030814', border: '1px solid #38bdf8' }} />
                <Line dataKey="mean" stroke="#34d399" dot isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="field-hint" id="stack-trend">
            {t ? `Mann–Kendall (n = ${t.n}): ${t.direction}; Theil–Sen ${fmt(t.senSlope)} per year; p ${fmtP(t.p).startsWith('<') ? fmtP(t.p) : `= ${fmtP(t.p)}`}.` : 'Four or more usable dates are needed for a trend test.'}
          </p>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>File</th>
                  <th>Mean</th>
                  <th>Median</th>
                  <th>Valid</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map(r => (
                  <tr key={r.filename} className={r.sparse ? 'muted' : ''}>
                    <td>{r.date}</td>
                    <td>{r.filename}</td>
                    <td className="num">{fmt(r.mean)}</td>
                    <td className="num">{fmt(r.median)}</td>
                    <td className="num">
                      {(r.validFraction * 100).toFixed(0)} %{r.sparse ? ' (excluded)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Notes items={result.notes} />
          {breaks?.breaks && (
            <div className="sub-panel" aria-label="Disturbances">
              <div className="eyebrow">Disturbances per pixel</div>
              <p className="field-hint" id="stack-breaks-total">
                Disturbed (drop of at least {fmt(breaks.breaks.minDrop)}): {breaks.breaks.disturbedHa !== null ? `${fmt(breaks.breaks.disturbedHa, 4)} ha` : `${breaks.breaks.disturbedPixels.toLocaleString()} pixels`} of{' '}
                {breaks.breaks.analysedPixels.toLocaleString()} pixels with enough clear dates.
              </p>
              {breaks.breaks.byDate.length > 0 && (
                <div className="tabular-view">
                  <table id="stack-breaks-table">
                    <thead>
                      <tr>
                        <th>Drop first seen</th>
                        <th>Previous date</th>
                        <th className="num">{breaks.breaks.disturbedHa !== null ? 'Area (ha)' : 'Pixels'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breaks.breaks.byDate.map(x => (
                        <tr key={x.date}>
                          <td>
                            <i className="class-swatch" style={{ background: `rgb(${(breaks.breaks!.legend.find(l => l.label.endsWith(x.date))?.color ?? [200, 200, 200]).join(',')})` }} /> {x.date}
                          </td>
                          <td>{x.previous}</td>
                          <td className="num">{x.ha !== null ? fmt(x.ha, 4) : x.pixels.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {breaks.downloads && <Downloads idPrefix="stack-breaks" items={breaks.downloads} />}
              <Notes items={breaks.breaks.notes} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
