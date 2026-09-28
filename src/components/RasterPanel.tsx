import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { VIRIDIS_CSS, paintGrid } from '../lib/colormap';
import { formatBytes } from '../lib/report';
import { fmt } from '../lib/stats';
import type { RasterDataset, RasterMode } from '../lib/types';

interface Props {
  dataset: RasterDataset;
  busy: boolean;
  onChangeView: (view: RasterMode) => void;
}

const AXIS = { stroke: '#4a6580', fontSize: 10, fontFamily: 'Space Mono, monospace' };

export default function RasterPanel({ dataset: ds, busy, onChangeView }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [red, setRed] = useState(ds.view.mode === 'ndvi' ? ds.view.red : 0);
  const [nir, setNir] = useState(ds.view.mode === 'ndvi' ? ds.view.nir : Math.min(1, ds.bands - 1));

  useEffect(() => {
    if (canvasRef.current && ds.stats) paintGrid(canvasRef.current, ds.preview.data, ds.preview.width, ds.preview.height, ds.stats.min, ds.stats.max);
  }, [ds]);

  const bandOptions = Array.from({ length: ds.bands }, (_, i) => i);
  const histData = ds.histogram.map(b => ({ x: (b.x0 + b.x1) / 2, count: b.count, range: `${fmt(b.x0)} to ${fmt(b.x1)}` }));
  const s = ds.stats;

  return (
    <section className="core-analysis-module" aria-label="Raster analysis">
      <div className="analysis-header">
        <span className="pulse-dot" aria-hidden="true" />
        <span>Raster · {ds.filename}</span>
      </div>

      <div className="raster-controls">
        <label className="inline-select">
          <span>Layer</span>
          <select
            id="raster-band"
            disabled={busy}
            value={ds.view.mode === 'band' ? String(ds.view.band) : 'ndvi'}
            onChange={e => {
              if (e.target.value !== 'ndvi') onChangeView({ mode: 'band', band: Number(e.target.value) });
              else if (ds.bands >= 2) onChangeView({ mode: 'ndvi', red, nir });
            }}
          >
            {bandOptions.map(b => (
              <option key={b} value={b}>
                Band {b + 1}
              </option>
            ))}
            {ds.bands >= 2 && <option value="ndvi">NDVI (computed)</option>}
          </select>
        </label>
        {ds.bands >= 2 && (
          <div className="ndvi-controls">
            <label className="inline-select">
              <span>Red</span>
              <select id="raster-red" value={red} disabled={busy} onChange={e => setRed(Number(e.target.value))}>
                {bandOptions.map(b => (
                  <option key={b} value={b}>
                    Band {b + 1}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-select">
              <span>NIR</span>
              <select id="raster-nir" value={nir} disabled={busy} onChange={e => setNir(Number(e.target.value))}>
                {bandOptions.map(b => (
                  <option key={b} value={b}>
                    Band {b + 1}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-small btn-primary" disabled={busy || red === nir} onClick={() => onChangeView({ mode: 'ndvi', red, nir })}>
              Compute NDVI
            </button>
          </div>
        )}
        {busy && <span className="muted">Reading raster…</span>}
      </div>

      <div className="raster-grid">
        <figure className="raster-figure">
          {s ? <canvas ref={canvasRef} className="raster-canvas" aria-label={`Preview of ${ds.filename}`} /> : <div className="empty-note">No valid pixels to display.</div>}
          {s && (
            <figcaption>
              <div className="legend-bar" style={{ background: VIRIDIS_CSS }} />
              <div className="legend-labels">
                <span>{fmt(s.min)}</span>
                <span>viridis</span>
                <span>{fmt(s.max)}</span>
              </div>
            </figcaption>
          )}
        </figure>

        <dl className="meta-list">
          <dt>Size</dt>
          <dd>
            {ds.width.toLocaleString()} × {ds.height.toLocaleString()} px · {ds.bands} band{ds.bands === 1 ? '' : 's'} · {formatBytes(ds.sizeBytes)}
          </dd>
          <dt>CRS</dt>
          <dd>{ds.epsg ? `EPSG:${ds.epsg}` : 'Unknown'}</dd>
          <dt>Pixel size</dt>
          <dd>{ds.pixelSize ? `${fmt(ds.pixelSize[0])} × ${fmt(ds.pixelSize[1])} (CRS units)` : '—'}</dd>
          <dt>No-data</dt>
          <dd>{ds.noData ?? 'None declared'}</dd>
          <dt>Valid pixels</dt>
          <dd>
            {ds.validPixels.toLocaleString()} of {ds.totalPixels.toLocaleString()} ({((ds.validPixels / Math.max(1, ds.totalPixels)) * 100).toFixed(1)} %)
          </dd>
          <dt>Mean ± SD</dt>
          <dd>
            {fmt(s?.mean)} ± {fmt(s?.sd)}
          </dd>
          <dt>Median (IQR)</dt>
          <dd>
            {fmt(s?.median)} ({fmt(s?.q1)} – {fmt(s?.q3)})
          </dd>
          <dt>Range</dt>
          <dd>
            {fmt(s?.min)} – {fmt(s?.max)}
          </dd>
        </dl>
      </div>

      {histData.length > 0 && (
        <div className="render-window">
          <div className="eyebrow">Histogram · {histData.length} bins</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={histData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
              <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={v => fmt(v, 3)} {...AXIS} />
              <YAxis {...AXIS} width={52} />
              <Tooltip
                cursor={{ fill: 'rgba(56,189,248,0.08)' }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="chart-tooltip">
                      <div className="chart-tooltip-label">{payload[0].payload.range}</div>
                      <div>{payload[0].payload.count.toLocaleString()} pixels</div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="count" fill="#38bdf8" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {ds.hints.length > 0 && (
        <ul className="hint-list">
          {ds.hints.map(h => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
