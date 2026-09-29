import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { guessBandMap } from '../../lib/indices';
import { mapImage } from '../../lib/overlay';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { CHANGE_CLASSES, analyzeHansen, analyzeNdviChange, forestMarkdown, formatArea, type ForestResult } from '../../lib/tools/forest';
import type { ToolOutput } from '../../lib/tools/registry';
import type { BandMap } from '../../lib/types';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

type Mode = 'ndvi' | 'hansen';
interface Slot {
  raster: OpenRaster;
  bands: BandMap;
}

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };
const TIF = '.tif,.tiff';

function BandPicker({ slot, onChange, prefix }: { slot: Slot; onChange: (b: BandMap) => void; prefix: string }) {
  if (slot.raster.meta.bands < 2) return <p className="field-hint">Single band: read as NDVI.</p>;
  const opts = Array.from({ length: slot.raster.meta.bands }, (_, i) => i);
  return (
    <div className="ndvi-controls">
      {(['red', 'nir'] as const).map(role => (
        <label key={role} className="inline-select">
          <span>{role === 'red' ? 'Red' : 'NIR'}</span>
          <select id={`${prefix}-${role}`} value={slot.bands[role] ?? ''} onChange={e => onChange({ ...slot.bands, [role]: Number(e.target.value) })}>
            <option value="" disabled>
              —
            </option>
            {opts.map(i => (
              <option key={i} value={i}>
                Band {i + 1}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

export default function ForestLossTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>('ndvi');
  const [a, setA] = useState<Slot | null>(null);
  const [b, setB] = useState<Slot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forestThr, setForestThr] = useState('0.5');
  const [lossThr, setLossThr] = useState('-0.2');
  const [canopyThr, setCanopyThr] = useState('30');
  const [result, setResult] = useState<ForestResult | null>(null);

  const reset = (m: Mode) => {
    setMode(m);
    setA(null);
    setB(null);
    setResult(null);
    onOutput(null);
  };

  const load = async (file: File, which: 'a' | 'b') => {
    setBusy(which);
    try {
      const raster = await openGeoTiff(file);
      const slot = { raster, bands: guessBandMap(raster.meta.bands) };
      (which === 'a' ? setA : setB)(slot);
      setResult(null);
      onOutput(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const run = async (sa = a, sb = b, m: Mode = mode) => {
    if (!sa || (m === 'ndvi' && !sb)) return;
    const fThr = Number(forestThr), lThr = Number(lossThr), cThr = Number(canopyThr);
    if (m === 'ndvi' && (!Number.isFinite(fThr) || !Number.isFinite(lThr) || fThr < -1 || fThr > 1 || lThr >= 0 || lThr < -2)) {
      notify('Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).', 'error');
      return;
    }
    if (m === 'hansen' && (!Number.isFinite(cThr) || cThr < 0 || cThr > 100)) {
      notify('Set the canopy threshold between 0 and 100 %.', 'error');
      return;
    }
    setBusy('run');
    try {
      const r =
        m === 'ndvi'
          ? await analyzeNdviChange(sa, sb!, fThr, lThr, boundary)
          : await analyzeHansen(sa.raster, sb?.raster ?? null, cThr, boundary);
      setResult(r);
      const classes = CHANGE_CLASSES.filter(c => m === 'ndvi' || c.id !== 4);
      const rgba = changeRgba(r);
      const names = [sa.raster.meta.filename, sb?.raster.meta.filename].filter((n): n is string => Boolean(n));
      onOutput({
        tool: 'forest',
        name: names.join(' vs '),
        markdown: forestMarkdown(r, names.map((n, i) => (m === 'ndvi' ? `${i === 0 ? 'Earlier' : 'Later'} image: ${n}` : i === 0 ? `Loss year: ${n}` : `Tree cover 2000: ${n}`))),
        map: {
          bounds: sa.raster.meta.latLngBounds,
          image: mapImage(rgba, r.width, r.height, sa.raster.meta.latLngBounds, 'Forest change', classes.map(c => ({ color: `rgb(${c.color.join(',')})`, label: c.label }))),
        },
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The analysis failed.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const loadSample = async () => {
    setBusy('sample');
    try {
      const [f1, f2] = await Promise.all([fetchSample('samples/forest_ndvi_2016_synthetic.tif'), fetchSample('samples/forest_ndvi_2024_synthetic.tif')]);
      const [r1, r2] = await Promise.all([openGeoTiff(f1), openGeoTiff(f2)]);
      const s1 = { raster: r1, bands: {} };
      const s2 = { raster: r2, bands: {} };
      setMode('ndvi');
      setA(s1);
      setB(s2);
      setBusy(null);
      await run(s1, s2, 'ndvi');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
      setBusy(null);
    }
  };

  const changeImage = useMemo(() => (result ? changeRgba(result) : null), [result]);

  // Re-run with the new boundary when it changes after an analysis.
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const ready = mode === 'ndvi' ? Boolean(a && b) : Boolean(a);

  return (
    <div className="tool-body">
      <div className="mode-switch" role="radiogroup" aria-label="Method">
        <button type="button" role="radio" aria-checked={mode === 'ndvi'} className={mode === 'ndvi' ? 'active' : ''} onClick={() => reset('ndvi')}>
          Two-date NDVI change
        </button>
        <button type="button" role="radio" aria-checked={mode === 'hansen'} className={mode === 'hansen' ? 'active' : ''} onClick={() => reset('hansen')}>
          Hansen Global Forest Change
        </button>
      </div>

      <p className="tool-intro">
        {mode === 'ndvi'
          ? 'Upload an earlier and a later image of the same area, exported on the same grid (region, scale and CRS). Each can be a single-band NDVI GeoTIFF or a multi-band scene with red and NIR bands.'
          : 'Upload a Hansen/UMD “lossyear” tile from Global Forest Watch or Earth Engine (UMD/hansen/global_forest_change). Add the matching “treecover2000” tile to define the baseline forest.'}
      </p>

      <div className="drop-pair">
        <div>
          <FileDrop id="forest-a" compact label={mode === 'ndvi' ? 'Earlier image' : 'Loss year (lossyear)'} accept={TIF} hint="GeoTIFF" busy={busy === 'a'} loaded={a?.raster.meta.filename} onFile={f => load(f, 'a')} />
          {a && mode === 'ndvi' && <BandPicker prefix="forest-a" slot={a} onChange={bands => setA({ ...a, bands })} />}
        </div>
        <div>
          <FileDrop
            id="forest-b"
            compact
            label={mode === 'ndvi' ? 'Later image' : 'Tree cover 2000 (optional)'}
            accept={TIF}
            hint="GeoTIFF"
            busy={busy === 'b'}
            loaded={b?.raster.meta.filename}
            onFile={f => load(f, 'b')}
          />
          {b && mode === 'ndvi' && <BandPicker prefix="forest-b" slot={b} onChange={bands => setB({ ...b, bands })} />}
        </div>
      </div>

      <div className="param-row">
        {mode === 'ndvi' ? (
          <>
            <label className="param">
              <span>Forest if NDVI ≥</span>
              <input id="forest-thr" type="number" step="0.05" min="0" max="1" value={forestThr} onChange={e => setForestThr(e.target.value)} />
            </label>
            <label className="param">
              <span>Loss if ΔNDVI ≤</span>
              <input id="loss-thr" type="number" step="0.05" min="-1" max="-0.01" value={lossThr} onChange={e => setLossThr(e.target.value)} />
            </label>
          </>
        ) : (
          <label className="param">
            <span>Forest if canopy ≥ (%)</span>
            <input id="canopy-thr" type="number" step="5" min="1" max="100" value={canopyThr} onChange={e => setCanopyThr(e.target.value)} />
          </label>
        )}
        <div className="button-row push-right">
          <button type="button" className="btn" onClick={loadSample} disabled={Boolean(busy)}>
            Try synthetic sample
          </button>
          <button type="button" className="btn btn-primary" onClick={() => run()} disabled={!ready || Boolean(busy)}>
            {busy === 'run' ? 'Estimating…' : 'Estimate forest loss'}
          </button>
        </div>
      </div>

      {result && changeImage && (
        <div className="result-block">
          <div className="stat-grid">
            {result.mode === 'ndvi' ? (
              <>
                <Stat label="Forest at start" value={formatArea(result.forestBefore)} />
                <Stat label="Forest loss" value={formatArea(result.loss)} tone="bad" />
                <Stat label="Share of forest lost" value={result.forestBefore.pixels ? `${((result.loss.pixels / result.forestBefore.pixels) * 100).toFixed(2)} %` : '—'} tone="bad" />
                <Stat label="Vegetation gain" value={formatArea(result.gain)} tone="good" />
              </>
            ) : (
              <>
                <Stat label="Forest in 2000" value={formatArea(result.baseline)} />
                <Stat label="Total loss" value={formatArea(result.totalLoss)} tone="bad" />
                <Stat label="Share lost" value={result.baseline?.pixels ? `${((result.totalLoss.pixels / result.baseline.pixels) * 100).toFixed(2)} %` : '—'} tone="bad" />
                <Stat label="Years with loss" value={String(result.byYear.length)} />
              </>
            )}
          </div>

          <figure className="raster-figure">
            <RgbaCanvas rgba={changeImage} width={result.width} height={result.height} label="Forest change map" />
            <figcaption className="legend-row">
              {CHANGE_CLASSES.filter(c => result.mode === 'ndvi' || c.id !== 4).map(c => (
                <span key={c.id}>
                  <i className="class-swatch" style={{ background: `rgb(${c.color.join(',')})` }} /> {c.label}
                </span>
              ))}
            </figcaption>
          </figure>

          {result.mode === 'ndvi' && <p className="field-hint">Mean ΔNDVI across all compared pixels: {fmt(result.meanDelta)}.</p>}

          {result.mode === 'hansen' && result.byYear.length > 0 && (
            <div className="render-window">
              <div className="eyebrow">Loss by year {result.byYear[0].area.ha === null ? '(pixels)' : '(hectares)'}</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={result.byYear.map(y => ({ year: y.year, value: y.area.ha ?? y.area.pixels }))} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                  <XAxis dataKey="year" {...AXIS} />
                  <YAxis {...AXIS} width={60} tickFormatter={v => fmt(v, 3)} />
                  <Tooltip formatter={v => fmt(Number(v))} contentStyle={{ background: '#030814', border: '1px solid #38bdf8' }} />
                  <Bar dataKey="value" name="Loss" fill="#e5484d" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <ul className="hint-list">
            {result.notes.map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function changeRgba(result: ForestResult): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(result.width * result.height * 4);
  for (let i = 0; i < result.classes.length; i++) {
    const c = CHANGE_CLASSES.find(x => x.id === result.classes[i]);
    if (!c) continue;
    rgba.set([...c.color, 255], i * 4);
  }
  return rgba;
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</div>
    </div>
  );
}
