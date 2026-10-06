import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { areaHa } from '../../lib/units';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { BandMap } from '../../lib/types';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

type Mode = 'ndvi' | 'hansen' | 'burn';
interface Slot {
  file: StoredFile<RasterMeta>;
  bands: BandMap;
}

interface AreaUnit {
  ha: number | null;
  pixels: number;
}

interface ForestResult {
  mode: Mode;
  width: number;
  height: number;
  forestBefore: AreaUnit;
  loss: AreaUnit;
  gain: AreaUnit;
  meanDelta: number;
  burned: AreaUnit;
  classAreas: AreaUnit[];
  meanDnbr: number;
  baseline: AreaUnit | null;
  totalLoss: AreaUnit;
  byYear: { year: number; area: AreaUnit }[];
  patches: { count: number; largest: AreaUnit; mmuHa: number; removedPatches: number } | null;
  notes: string[];
}

interface ForestJob {
  name: string;
  markdown: string;
  map: { bounds: LatLngBounds | null; image: ResultImage };
  result: ForestResult;
  legend: { id: number; label: string; color: number[] }[];
  downloads: Download[];
}

const AXIS = { stroke: '#4a6580', fontSize: 11, fontFamily: 'Space Mono, monospace' };
const TIF = '.tif,.tiff';

const ROLE_LABEL = { red: 'Red', nir: 'NIR', swir2: 'SWIR2' } as const;

function BandPicker({ slot, onChange, prefix, burn }: { slot: Slot; onChange: (b: BandMap) => void; prefix: string; burn?: boolean }) {
  if (slot.file.meta.bands < 2) return <p className="field-hint">Single band: read as {burn ? 'NBR' : 'NDVI'}.</p>;
  const opts = Array.from({ length: slot.file.meta.bands }, (_, i) => i);
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
  const job = useJob();
  const busy = job.busy;
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const [forestThr, setForestThr] = useState('0.5');
  const [lossThr, setLossThr] = useState('-0.2');
  const [canopyThr, setCanopyThr] = useState('30');
  const [mmu, setMmu] = useState('0');
  const [out, setOut] = useState<ForestJob | null>(null);
  const result = out?.result ?? null;
  const fail = (m: string) => notify(m, 'error');

  const reset = (m: Mode) => {
    job.cancel();
    setMode(m);
    setA(null);
    setB(null);
    setOut(null);
    onOutput(null);
  };

  const load = async (file: File, which: 'a' | 'b') => {
    const f = await job.run(which, signal => files.upload(file, signal), fail);
    if (!f) return;
    const slot = { file: f, bands: (f.meta.guessedBands ?? {}) as BandMap };
    (which === 'a' ? setA : setB)(slot);
    setOut(null);
    onOutput(null);
  };

  const run = async (sa = a, sb = b, m: Mode = mode) => {
    if (!sa || (m !== 'hansen' && !sb)) return;
    const fThr = Number(forestThr), lThr = Number(lossThr), cThr = Number(canopyThr), mmuHa = Number(mmu);
    if (!Number.isFinite(mmuHa) || mmuHa < 0 || mmuHa > 1000) return fail('Set the minimum mapping unit between 0 (off) and 1,000 ha.');
    if (m === 'ndvi' && (!Number.isFinite(fThr) || !Number.isFinite(lThr) || fThr < -1 || fThr > 1 || lThr >= 0 || lThr < -2)) return fail('Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).');
    if (m === 'hansen' && (!Number.isFinite(cThr) || cThr < 0 || cThr > 100)) return fail('Set the canopy threshold between 0 and 100 %.');
    const r = await job.run(
      'run',
      (signal, onProgress) =>
        runJob<ForestJob>(
          'forest',
          { a: sa.file.id, b: sb?.file.id },
          { mode: m, bandsA: sa.bands, bandsB: sb?.bands ?? {}, forestThreshold: fThr, lossThreshold: lThr, canopyThreshold: cThr, mmuHa, boundary },
          { signal, onProgress },
        ),
      msg => {
        fail(msg);
        setOut(null);
        onOutput(null);
      },
    );
    if (!r) return;
    setOut(r);
    onOutput({ tool: 'forest', name: r.name, markdown: r.markdown, map: r.map, figures: r.map.image ? [{ title: r.map.image.label, url: r.map.image.url }] : [] });
  };

  const loadSample = async () => {
    const m: Mode = mode === 'burn' ? 'burn' : 'ndvi';
    const names = m === 'burn' ? ['burn_nbr_pre_synthetic.tif', 'burn_nbr_post_synthetic.tif'] : ['forest_ndvi_2016_synthetic.tif', 'forest_ndvi_2024_synthetic.tif'];
    const got = await job.run('sample', () => Promise.all(names.map(n => files.sample(n))), fail);
    if (!got) return;
    const [s1, s2] = got.map(f => ({ file: f, bands: {} }));
    setMode(m);
    setA(s1);
    setB(s2);
    await run(s1, s2, m);
  };

  // Re-run with the new boundary when it changes after an analysis.
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const ready = mode === 'hansen' ? Boolean(a) : Boolean(a && b);

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
          <FileDrop id="forest-a" compact label={MODE_TEXT[mode].a} accept={TIF} hint="GeoTIFF" busy={busy === 'a'} loaded={a?.file.name} onFile={f => load(f, 'a')} />
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
            loaded={b?.file.name}
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
      <JobStatus job={job} onCancel={job.cancel} />

      {result && out && (
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
            <ArtifactImage url={out.map.image.url} width={result.width} height={result.height} label={result.mode === 'burn' ? 'Burn severity map' : 'Forest change map'} />
            <figcaption className="legend-row">
              {out.legend.map(c => (
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
            <span className="push-right">
              <Downloads idPrefix="forest" items={out.downloads} ids={['forest-export-polygons']} />
            </span>
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

          <Notes items={result.notes} />
        </div>
      )}
    </div>
  );
}

