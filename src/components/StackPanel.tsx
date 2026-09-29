import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { INDICES, guessBandMap } from '../lib/indices';
import { openGeoTiff } from '../lib/rasterio';
import { fetchSample } from '../lib/samples';
import { analyzeStack, stackMarkdown, type StackResult } from '../lib/stack';
import { fmt, fmtP } from '../lib/stats';
import { useToast } from '../lib/toast';
import type { ToolOutput } from '../lib/tools/registry';
import type { SpectralIndex } from '../lib/types';
import type { Boundary } from '../lib/zonal';
import FileDrop from './FileDrop';

interface Props {
  onOutput: (out: ToolOutput) => void;
  boundary: Boundary | null;
}

const SERIES_SAMPLES = ['2019-03-10', '2020-03-14', '2021-03-09', '2022-03-12', '2023-03-15', '2024-03-11'].map(d => `series_ndvi_${d}_synthetic.tif`);

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };

export default function StackPanel({ onOutput, boundary }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState<SpectralIndex>('ndvi');
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<StackResult | null>(null);

  const run = async (list: File[], idx: SpectralIndex = index) => {
    setBusy(true);
    try {
      const rasters = await Promise.all(list.map(f => openGeoTiff(f)));
      const r = await analyzeStack(
        rasters.map(raster => ({ raster })),
        { index: idx, bands: guessBandMap(rasters[0].meta.bands), boundary },
      );
      setFiles(list);
      setResult(r);
      onOutput({ tool: 'satellite', name: `${r.rows.length}-date ${r.label} series`, markdown: stackMarkdown(r) });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not build the series.', 'error');
    } finally {
      setBusy(false);
    }
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
          onClick={async () => {
            try {
              run(await Promise.all(SERIES_SAMPLES.map(f => fetchSample(`samples/${f}`))));
            } catch (err) {
              notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
            }
          }}
        >
          Try synthetic 6-date series
        </button>
        {files.length > 1 && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(files)}>
            Recompute
          </button>
        )}
      </div>
      <FileDrop id="stack-files" compact label="Images from several dates" accept=".tif,.tiff" hint="GeoTIFFs · date in the file name" busy={busy} loaded={files.length ? `${files.length} images` : null} onFile={f => run([f])} onFiles={run} />
      {result && (
        <>
          <div className="render-window">
            <div className="eyebrow">{result.label} · mean per image</div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={result.rows.filter(r => !r.sparse).map(r => ({ date: r.date.toISOString().slice(0, 10), mean: r.mean }))} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
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
                    <td>{r.date.toISOString().slice(0, 10)}</td>
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
          <ul className="hint-list">
            {result.notes.map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
