import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { VIRIDIS_CSS, paintGrid } from '../lib/colormap';
import { BAND_ROLES, INDICES, guessBandMap, indexDef } from '../lib/indices';
import { unprojector } from '../lib/patches';
import { QA_KINDS, isMasked, type QaKind } from '../lib/qa';
import { readComposite } from '../lib/raster';
import type { Grid, OpenRaster } from '../lib/rasterio';
import { formatBytes } from '../lib/report';
import { fmt } from '../lib/stats';
import { useToast } from '../lib/toast';
import type { BandMap, BandRole, QaMaskRef, RasterDataset, RasterMode, SpectralIndex } from '../lib/types';
import RgbaCanvas from './RgbaCanvas';

interface Props {
  dataset: RasterDataset;
  raster: OpenRaster | null;
  busy: boolean;
  onChangeView: (view: RasterMode) => void;
}

const AXIS = { stroke: '#4a6580', fontSize: 10, fontFamily: 'Space Mono, monospace' };

export default function RasterPanel({ dataset: ds, raster, busy, onChangeView }: Props) {
  const notify = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bands, setBands] = useState<BandMap>(() => (ds.view.mode === 'index' ? ds.view.bands : guessBandMap(ds.bands)));
  const [index, setIndex] = useState<SpectralIndex>(ds.view.mode === 'index' ? ds.view.index : 'ndvi');
  const [layerKind, setLayerKind] = useState<'band' | 'index'>(ds.view.mode);
  const [composite, setComposite] = useState<{ rgba: Uint8ClampedArray; width: number; height: number; label: string } | null>(null);
  const [compositeBusy, setCompositeBusy] = useState(false);
  const [compositeKind, setCompositeKind] = useState<'true' | 'false' | null>(null);
  const [stretch, setStretch] = useState({ lo: '2', hi: '98' });
  const qa = ds.view.qa;
  const [qaKind, setQaKind] = useState<QaKind>(qa?.kind ?? (ds.bands >= 12 ? 'scl' : 'landsat'));
  const [pick, setPick] = useState<{ col: number; row: number; values: number[]; lat: number | null; lon: number | null; masked: boolean | null } | null>(null);
  const allBands = useRef<{ raster: OpenRaster; grids: Grid[] } | null>(null);

  useEffect(() => {
    if (canvasRef.current && ds.stats) paintGrid(canvasRef.current, ds.preview.data, ds.preview.width, ds.preview.height, ds.stats.min, ds.stats.max);
  }, [ds]);

  const bandOptions = Array.from({ length: ds.bands }, (_, i) => i);
  const histData = ds.histogram.map(b => ({ x: (b.x0 + b.x1) / 2, count: b.count, range: `${fmt(b.x0)} to ${fmt(b.x1)}` }));
  const s = ds.stats;
  const def = indexDef(index);
  const available = INDICES.filter(i => i.needs.length <= ds.bands);

  const stretchValue = (): [number, number] | null => {
    const lo = Number(stretch.lo), hi = Number(stretch.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 100 || lo >= hi) {
      notify('Set the stretch as two percentiles between 0 and 100, low below high (for example 2 and 98).', 'error');
      return null;
    }
    return [lo / 100, hi / 100];
  };

  const setQa = (next: QaMaskRef | undefined) => {
    onChangeView({ ...ds.view, qa: next });
    if (compositeKind) showComposite(compositeKind, next);
  };

  const inspect = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!raster) return;
    const b = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - b.left) / b.width, py = (e.clientY - b.top) / b.height;
    if (px < 0 || py < 0 || px >= 1 || py >= 1) return;
    try {
      if (allBands.current?.raster !== raster) {
        allBands.current = { raster, grids: await raster.readBands(Array.from({ length: ds.bands }, (_, i) => i)) };
      }
      const grids = allBands.current.grids;
      const gw = grids[0].width, gh = grids[0].height;
      const col = Math.min(gw - 1, Math.floor(px * gw)), row = Math.min(gh - 1, Math.floor(py * gh));
      const k = row * gw + col;
      let lat: number | null = null, lon: number | null = null;
      const inv = unprojector(raster.meta);
      if (inv && raster.meta.bbox) {
        const [minX, minY, maxX, maxY] = raster.meta.bbox;
        [lon, lat] = inv(minX + ((col + 0.5) * (maxX - minX)) / gw, maxY - ((row + 0.5) * (maxY - minY)) / gh);
      }
      setPick({ col, row, values: grids.map(g => g.data[k]), lat, lon, masked: qa ? isMasked(qa.kind, grids[qa.band].data[k]) : null });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not read that pixel.', 'error');
    }
  };

  const showComposite = async (kind: 'true' | 'false', qaOverride: QaMaskRef | undefined = qa) => {
    if (!raster) return;
    const st = stretchValue();
    if (!st) return;
    const rgb: (number | undefined)[] = kind === 'true' ? [bands.red, bands.green, bands.blue] : [bands.nir, bands.red, bands.green];
    if (rgb.some(v => v === undefined)) {
      notify(kind === 'true' ? 'Assign red, green and blue bands first.' : 'Assign NIR, red and green bands first.', 'error');
      return;
    }
    setCompositeBusy(true);
    try {
      const c = await readComposite(raster, rgb as [number, number, number], st, qaOverride);
      setCompositeKind(kind);
      setComposite({ ...c, label: `${kind === 'true' ? 'True colour (R G B)' : 'False colour (NIR R G): vegetation appears red'}; ${stretch.lo}–${stretch.hi} % stretch per channel${qaOverride ? '; masked pixels transparent' : ''}` });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not build the composite.', 'error');
    } finally {
      setCompositeBusy(false);
    }
  };

  const roleSelect = (role: BandRole, label: string) => (
    <label key={role} className="inline-select">
      <span>{label}</span>
      <select id={`band-${role}`} value={bands[role] ?? ''} disabled={busy} onChange={e => setBands(b => ({ ...b, [role]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
        <option value="">—</option>
        {bandOptions.map(b => (
          <option key={b} value={b}>
            Band {b + 1}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="core-analysis-module" aria-label="Raster analysis">
      <div className="analysis-header">
        <span className="pulse-dot" aria-hidden="true" />
        <span>Raster · {ds.filename}</span>
      </div>

      <div className="raster-controls">
        <label className="inline-select">
          <span>Show</span>
          <select
            id="raster-layer"
            disabled={busy}
            value={layerKind === 'band' && ds.view.mode === 'band' ? String(ds.view.band) : 'index'}
            onChange={e => {
              if (e.target.value === 'index') setLayerKind('index');
              else {
                setLayerKind('band');
                onChangeView({ mode: 'band', band: Number(e.target.value), qa });
              }
            }}
          >
            {bandOptions.map(b => (
              <option key={b} value={b}>
                Band {b + 1}
              </option>
            ))}
            {ds.bands >= 2 && <option value="index">Spectral index…</option>}
          </select>
        </label>
        {busy && <span className="muted">Reading raster…</span>}
      </div>

      {ds.bands >= 2 && (
        <details className="band-setup" open={layerKind === 'index'}>
          <summary>Band roles and spectral indices</summary>
          <p className="field-hint">
            Tell TerraX which band is which. Sentinel-2: B2 blue, B3 green, B4 red, B8 NIR, B11 SWIR1, B12 SWIR2. Landsat 8/9: B2–B4 visible, B5 NIR, B6 SWIR1, B7 SWIR2.
            The guess below assumes bands were exported in wavelength order.
          </p>
          <div className="ndvi-controls">{BAND_ROLES.map(r => roleSelect(r.role, r.label))}</div>
          <div className="ndvi-controls">
            <label className="inline-select">
              <span>Index</span>
              <select id="raster-index" value={index} onChange={e => setIndex(e.target.value as SpectralIndex)}>
                {available.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy}
              onClick={() => {
                setLayerKind('index');
                onChangeView({ mode: 'index', index, bands, qa });
              }}
            >
              Compute {def.name.split(' —')[0]}
            </button>
          </div>
          <p className="field-hint">
            {def.formula} · {def.reference}. Needs: {def.needs.map(r => BAND_ROLES.find(b => b.role === r)!.label).join(', ')}.
          </p>
          {ds.bands >= 3 && (
            <div className="button-row">
              <button type="button" className="btn btn-small" disabled={compositeBusy || !raster} onClick={() => showComposite('true')}>
                True colour
              </button>
              <button type="button" className="btn btn-small" disabled={compositeBusy || !raster} onClick={() => showComposite('false')}>
                False colour (NIR)
              </button>
              {composite && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    setComposite(null);
                    setCompositeKind(null);
                  }}
                >
                  Hide composite
                </button>
              )}
              <label className="param">
                <span>Stretch (%)</span>
                <input id="stretch-lo" type="number" min="0" max="49" step="0.5" value={stretch.lo} onChange={e => setStretch(v => ({ ...v, lo: e.target.value }))} />
                <span>to</span>
                <input id="stretch-hi" type="number" min="51" max="100" step="0.5" value={stretch.hi} onChange={e => setStretch(v => ({ ...v, hi: e.target.value }))} />
              </label>
              {composite && compositeKind && (
                <button type="button" className="btn btn-small" disabled={compositeBusy} onClick={() => showComposite(compositeKind)}>
                  Apply stretch
                </button>
              )}
            </div>
          )}
          <div className="ndvi-controls">
            <label className="inline-select">
              <span>Cloud / quality band</span>
              <select
                id="qa-band"
                value={qa ? String(qa.band) : ''}
                disabled={busy}
                onChange={e => setQa(e.target.value === '' ? undefined : { band: Number(e.target.value), kind: qaKind })}
              >
                <option value="">None</option>
                {bandOptions.map(b => (
                  <option key={b} value={b}>
                    Band {b + 1}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-select">
              <span>Type</span>
              <select
                id="qa-kind"
                value={qaKind}
                disabled={busy}
                onChange={e => {
                  const k = e.target.value as QaKind;
                  setQaKind(k);
                  if (qa) setQa({ band: qa.band, kind: k });
                }}
              >
                {(Object.keys(QA_KINDS) as QaKind[]).map(k => (
                  <option key={k} value={k}>
                    {QA_KINDS[k].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="field-hint">Masks {QA_KINDS[qaKind].rule}. Export the SCL or QA_PIXEL band with the scene to use it.</p>
        </details>
      )}

      {composite && (
        <figure className="raster-figure">
          <RgbaCanvas rgba={composite.rgba} width={composite.width} height={composite.height} label={composite.label} />
          <figcaption className="field-hint">{composite.label}.</figcaption>
        </figure>
      )}

      <div className="raster-grid">
        <figure className="raster-figure">
          {s ? (
            <canvas ref={canvasRef} className={`raster-canvas ${raster ? 'pickable' : ''}`} aria-label={`Preview of ${ds.filename}; click a pixel to inspect its values`} onClick={inspect} />
          ) : (
            <div className="empty-note">No valid pixels to display.</div>
          )}
          {s && (
            <figcaption>
              <div className="legend-bar" style={{ background: VIRIDIS_CSS }} />
              <div className="legend-labels">
                <span>{fmt(s.min)}</span>
                <span>{ds.view.mode === 'index' ? indexDef(ds.view.index).name.split(' —')[0] : `Band ${ds.view.band + 1}`}</span>
                <span>{fmt(s.max)}</span>
              </div>
            </figcaption>
          )}
        </figure>

        <dl className="meta-list">
          {pick && (
            <>
              <dt>Pixel</dt>
              <dd id="pixel-inspector">
                column {pick.col + 1}, row {pick.row + 1}
                {pick.lat !== null && pick.lon !== null ? ` · ${pick.lat.toFixed(5)}, ${pick.lon.toFixed(5)}` : ''}
                <br />
                {pick.values.map((v, i) => `B${i + 1} ${Number.isNaN(v) ? 'no data' : fmt(v)}`).join(' · ')}
                {pick.masked !== null ? ` · ${pick.masked ? 'masked by quality band' : 'clear'}` : ''}
              </dd>
            </>
          )}
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

      {raster && !pick && <p className="field-hint">Click the preview to read every band at a pixel.</p>}
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
