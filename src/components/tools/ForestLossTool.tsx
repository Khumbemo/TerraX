import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText, safeFilename } from '../../lib/download';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { guessBandMap } from '../../lib/indices';
import { mapImage } from '../../lib/overlay';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { areaHa } from '../../lib/units';
import type { AreaUnit } from '../../lib/tools/forest';
import { BURN_CLASSES, CHANGE_CLASSES, analyzeBurn, analyzeHansen, analyzeNdviChange, forestMarkdown, lossPolygons, type ForestResult } from '../../lib/tools/forest';
import type { ToolOutput } from '../../lib/tools/registry';
import type { BandMap } from '../../lib/types';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

type Mode = 'ndvi' | 'hansen' | 'burn';
interface Slot {
  raster: OpenRaster;
  bands: BandMap;
}

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };
const TIF = '.tif,.tiff';

const ROLE_LABEL = { red: 'Red', nir: 'NIR', swir2: 'SWIR2' } as const;

function BandPicker({ slot, onChange, prefix, burn }: { slot: Slot; onChange: (b: BandMap) => void; prefix: string; burn?: boolean }) {
  if (slot.raster.meta.bands < 2) return <p className="field-hint">Single band: read as {burn ? 'NBR' : 'NDVI'}.</p>;
  const opts = Array.from({ length: slot.raster.meta.bands }, (_, i) => i);
  const roles = burn ? (['nir', 'swir2'] as const) : (['red', 'nir'] as const);
  return (
    <div className="ndvi-controls">
      {roles.map(role => (
        <label key={role} className="inline-select">
          <span>{ROLE_LABEL[role]}</span>
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

const MODE_TEXT: Record<Mode, { intro: string; a: string; b: string; run: string; busy: string }> = {
  ndvi: {
    intro:
      'Upload an earlier and a later image of the same area, exported on the same grid (region, scale and CRS). Each can be a single-band NDVI GeoTIFF or a multi-band scene with red and NIR bands.',
    a: 'Earlier image',
    b: 'Later image',
    run: 'Estimate forest loss',
    busy: 'Estimating…',
  },
  hansen: {
    intro:
      'Upload a Hansen/UMD “lossyear” tile from Global Forest Watch or Earth Engine (UMD/hansen/global_forest_change). Add the matching “treecover2000” tile to define the baseline forest.',
    a: 'Loss year (lossyear)',
    b: 'Tree cover 2000 (optional)',
    run: 'Estimate forest loss',
    busy: 'Estimating…',
  },
  burn: {
    intro:
      'Upload a pre-fire and a post-fire image on the same grid: single-band NBR GeoTIFFs, or multi-band scenes with NIR and SWIR2 bands (Sentinel-2 B8/B8A and B12; Landsat 8–9 B5 and B7). TerraX maps burn severity from dNBR.',
    a: 'Pre-fire image',
    b: 'Post-fire image',
    run: 'Map burn severity',
    busy: 'Mapping…',
  },
};

export default function ForestLossTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const { units } = usePrefs();
  const formatArea = (a: AreaUnit | null) => (!a ? '—' : a.ha === null ? `${a.pixels.toLocaleString()} px` : areaHa(a.ha, units));
  const [mode, setMode] = useState<Mode>('ndvi');
  const [a, setA] = useState<Slot | null>(null);
  const [b, setB] = useState<Slot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forestThr, setForestThr] = useState('0.5');
  const [lossThr, setLossThr] = useState('-0.2');
  const [canopyThr, setCanopyThr] = useState('30');
  const [mmu, setMmu] = useState('0');
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
    if (!sa || (m !== 'hansen' && !sb)) return;
    const fThr = Number(forestThr), lThr = Number(lossThr), cThr = Number(canopyThr), mmuHa = Number(mmu);
    if (!Number.isFinite(mmuHa) || mmuHa < 0 || mmuHa > 1000) {
      notify('Set the minimum mapping unit between 0 (off) and 1,000 ha.', 'error');
      return;
    }
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
      const opts = { mmuHa };
      const r =
        m === 'ndvi'
          ? await analyzeNdviChange(sa, sb!, fThr, lThr, boundary, opts)
          : m === 'burn'
            ? await analyzeBurn(sa, sb!, boundary, opts)
            : await analyzeHansen(sa.raster, sb?.raster ?? null, cThr, boundary, opts);
      setResult(r);
      const classes = legendFor(r);
      const rgba = changeRgba(r);
      const names = [sa.raster.meta.filename, sb?.raster.meta.filename].filter((n): n is string => Boolean(n));
      onOutput({
        tool: 'forest',
        name: names.join(' vs '),
        markdown: forestMarkdown(r, names.map((n, i) => `${i === 0 ? MODE_TEXT[m].a : MODE_TEXT[m].b.replace(' (optional)', '')}: ${n}`)),
        map: {
          bounds: sa.raster.meta.latLngBounds,
          image: mapImage(rgba, r.width, r.height, sa.raster.meta.latLngBounds, m === 'burn' ? 'Burn severity' : 'Forest change', classes.map(c => ({ color: `rgb(${c.color.join(',')})`, label: c.label }))),
        },
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The analysis failed.', 'error');
      setResult(null);
      onOutput(null);
    } finally {
      setBusy(null);
    }
  };

  const loadSample = async () => {
    setBusy('sample');
    try {
      const m: Mode = mode === 'burn' ? 'burn' : 'ndvi';
      const files = m === 'burn' ? ['samples/burn_nbr_pre_synthetic.tif', 'samples/burn_nbr_post_synthetic.tif'] : ['samples/forest_ndvi_2016_synthetic.tif', 'samples/forest_ndvi_2024_synthetic.tif'];
      const [f1, f2] = await Promise.all(files.map(f => fetchSample(f)));
      const [r1, r2] = await Promise.all([openGeoTiff(f1), openGeoTiff(f2)]);
      const s1 = { raster: r1, bands: {} };
      const s2 = { raster: r2, bands: {} };
      setMode(m);
      setA(s1);
      setB(s2);
      setBusy(null);
      await run(s1, s2, m);
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

  const ready = mode === 'hansen' ? Boolean(a) : Boolean(a && b);

  const exportPolygons = () => {
    if (!result || !a) return;
    const out = lossPolygons(result, a.raster.meta);
    if (!out) {
      notify('Polygons need a WGS84, Web Mercator or UTM raster.', 'error');
      return;
    }
    if (!out.fc.features.length) {
      notify(result.mode === 'burn' ? 'No burned patches to export.' : 'No loss patches to export.');
      return;
    }
    if (out.truncated) notify(`Only the ${out.fc.features.length.toLocaleString()} largest patches were exported (${out.truncated.toLocaleString()} smaller ones left out).`);
    downloadText(JSON.stringify(out.fc), `${safeFilename(a.raster.meta.filename)}_${result.mode === 'burn' ? 'burned' : 'loss'}_patches.geojson`, 'application/geo+json');
  };

  return (
    <div className="tool-body">
      <div className="mode-switch" role="radiogroup" aria-label="Method">
        <button type="button" role="radio" aria-checked={mode === 'ndvi'} className={mode === 'ndvi' ? 'active' : ''} onClick={() => reset('ndvi')}>
          Two-date NDVI change
        </button>
        <button type="button" role="radio" aria-checked={mode === 'hansen'} className={mode === 'hansen' ? 'active' : ''} onClick={() => reset('hansen')}>
          Hansen Global Forest Change
        </button>
        <button type="button" role="radio" aria-checked={mode === 'burn'} className={mode === 'burn' ? 'active' : ''} onClick={() => reset('burn')}>
          Burn severity (dNBR)
        </button>
      </div>

      <p className="tool-intro">{MODE_TEXT[mode].intro}</p>

      <div className="drop-pair">
        <div>
          <FileDrop id="forest-a" compact label={MODE_TEXT[mode].a} accept={TIF} hint="GeoTIFF" busy={busy === 'a'} loaded={a?.raster.meta.filename} onFile={f => load(f, 'a')} />
          {a && mode !== 'hansen' && <BandPicker prefix="forest-a" burn={mode === 'burn'} slot={a} onChange={bands => setA({ ...a, bands })} />}
        </div>
        <div>
          <FileDrop
            id="forest-b"
            compact
            label={MODE_TEXT[mode].b}
            accept={TIF}
            hint="GeoTIFF"
            busy={busy === 'b'}
            loaded={b?.raster.meta.filename}
            onFile={f => load(f, 'b')}
          />
          {b && mode !== 'hansen' && <BandPicker prefix="forest-b" burn={mode === 'burn'} slot={b} onChange={bands => setB({ ...b, bands })} />}
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
        ) : mode === 'hansen' ? (
          <label className="param">
            <span>Forest if canopy ≥ (%)</span>
            <input id="canopy-thr" type="number" step="5" min="1" max="100" value={canopyThr} onChange={e => setCanopyThr(e.target.value)} />
          </label>
        ) : null}
        <label className="param" title="Patches smaller than this are ignored. FAO’s forest definition uses 0.5 ha; 0 keeps every pixel.">
          <span>Min. patch (ha)</span>
          <input id="forest-mmu" type="number" step="0.1" min="0" value={mmu} onChange={e => setMmu(e.target.value)} />
        </label>
        <div className="button-row push-right">
          <button type="button" className="btn" onClick={loadSample} disabled={Boolean(busy)}>
            Try synthetic sample
          </button>
          <button type="button" className="btn btn-primary" onClick={() => run()} disabled={!ready || Boolean(busy)}>
            {busy === 'run' ? MODE_TEXT[mode].busy : MODE_TEXT[mode].run}
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
            ) : result.mode === 'burn' ? (
              <>
                <Stat label="Burned area" value={formatArea(result.burned)} tone="bad" />
                <Stat label="High severity" value={formatArea(result.classAreas[6])} tone="bad" />
                <Stat label="Moderate severity" value={formatArea({ ha: result.classAreas[4].ha === null ? null : result.classAreas[4].ha! + result.classAreas[5].ha!, pixels: result.classAreas[4].pixels + result.classAreas[5].pixels })} />
                <Stat label="Mean dNBR" value={fmt(result.meanDnbr, 3)} />
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
            <RgbaCanvas rgba={changeImage} width={result.width} height={result.height} label={result.mode === 'burn' ? 'Burn severity map' : 'Forest change map'} />
            <figcaption className="legend-row">
              {legendFor(result).map(c => (
                <span key={c.id}>
                  <i className="class-swatch" style={{ background: `rgb(${c.color.join(',')})` }} /> {c.label}
                </span>
              ))}
            </figcaption>
          </figure>

          {result.mode === 'ndvi' && <p className="field-hint">Mean ΔNDVI across all compared pixels: {fmt(result.meanDelta)}.</p>}

          <div className="button-row">
            {result.patches && (
              <span className="muted">
                {result.patches.count.toLocaleString()} {result.mode === 'burn' ? 'burned' : 'loss'} patches · largest {formatArea(result.patches.largest)}
                {result.patches.mmuHa > 0 ? ` · ${result.patches.removedPatches.toLocaleString()} below ${result.patches.mmuHa} ha removed` : ''}
              </span>
            )}
            <button type="button" id="forest-export-polygons" className="btn btn-small push-right" onClick={exportPolygons}>
              Export {result.mode === 'burn' ? 'burned' : 'loss'} polygons (GeoJSON)
            </button>
          </div>

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

function legendFor(r: ForestResult): readonly { id: number; label: string; color: readonly number[] }[] {
  if (r.mode === 'burn') return BURN_CLASSES;
  return CHANGE_CLASSES.filter(c => r.mode === 'ndvi' || c.id !== 4);
}

function changeRgba(result: ForestResult): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(result.width * result.height * 4);
  const classes = result.mode === 'burn' ? BURN_CLASSES : CHANGE_CLASSES;
  for (let i = 0; i < result.classes.length; i++) {
    const c = classes.find(x => x.id === result.classes[i]);
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
