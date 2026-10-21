import { lazy, Suspense, useState } from 'react';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

const Sentinel1SearchPanel = lazy(() => import('../Sentinel1SearchPanel'));

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  target: { lat: number; lon: number; name: string };
}

interface Quartiles {
  median: number;
  q1: number;
  q3: number;
}

interface RadarJob {
  name: string;
  markdown: string;
  bands: { vv: number; vh: number };
  radar: {
    width: number;
    height: number;
    dates: { name: string; scale: 'db' | 'linear'; vv: Quartiles | null; vh: Quartiles | null; ratio: Quartiles | null; rvi: Quartiles | null }[];
    change?: { ha: Record<'1' | '2' | '3', number> | null; counts: Record<'1' | '2' | '3', number>; share: Record<'1' | '2' | '3', number> };
    notes: string[];
  };
  layers: { composite: string; change: string | null };
  downloads: Download[];
  map: { bounds: LatLngBounds | null; image: ResultImage | null } | null;
}

type View = 'composite' | 'change';
const BEFORE = 's1_vv_vh_2023-01-08_synthetic.tif';
const AFTER = 's1_vv_vh_2024-01-03_synthetic.tif';

export default function RadarTool({ onOutput, boundary, target }: Props) {
  const notify = useToast();
  const job = useJob();
  const busy = Boolean(job.busy);
  const files = useUpload<RasterMeta>(['raster'], 'a Sentinel-1 GeoTIFF (VV and VH bands)');
  const [before, setBefore] = useState<StoredFile<RasterMeta> | null>(null);
  const [after, setAfter] = useState<StoredFile<RasterMeta> | null>(null);
  const [vv, setVv] = useState('');
  const [vh, setVh] = useState('');
  const [win, setWin] = useState('5');
  const [threshold, setThreshold] = useState('3');
  const [out, setOut] = useState<RadarJob | null>(null);
  const [view, setView] = useState<View>('composite');
  const [firstOrbit, setFirstOrbit] = useState<number | null>(null);
  const [liveNotes, setLiveNotes] = useState<string[]>([]);
  const fail = (m: string) => notify(m, 'error');

  const load = async (picked: File | string | StoredFile<RasterMeta>, slot: 'before' | 'after') => {
    const f = typeof picked === 'object' && 'id' in picked ? picked : await job.run('upload', signal => (typeof picked === 'string' ? files.sample(picked) : files.upload(picked, signal)), fail);
    if (!f) return null;
    if (typeof picked !== 'object' || !('id' in picked)) {
      setLiveNotes([]);
      if (slot === 'before') setFirstOrbit(null);
    }
    if (slot === 'before') {
      setBefore(f);
      const names = f.meta.bandNames.map(n => n.toUpperCase());
      setVv(String(Math.max(0, names.findIndex(n => n.includes('VV')))));
      setVh(String(names.findIndex(n => n.includes('VH')) >= 0 ? names.findIndex(n => n.includes('VH')) : Math.min(1, f.meta.bands - 1)));
    } else setAfter(f);
    setOut(null);
    onOutput(null);
    return f;
  };

  const run = async (a = before, b = after) => {
    if (!a) return fail('Add a Sentinel-1 image first.');
    const thr = Number(threshold);
    if (!Number.isFinite(thr) || thr <= 0) return fail('Set the change threshold as a positive number of dB, for example 3.');
    const inputs = b ? { before: a.id, after: b.id } : { before: a.id };
    const res = await job.run('run', (signal, onProgress) => runJob<RadarJob>('radar', inputs, { vv, vh, window: Number(win), thresholdDb: thr, boundary }, { signal, onProgress }), fail);
    if (!res) return;
    setOut(res);
    setView(res.layers.change ? 'change' : 'composite');
    onOutput({
      tool: 'radar',
      name: res.name,
      markdown: res.markdown,
      map: res.map ?? undefined,
      summary: res.radar,
      figures: [{ title: 'Sentinel-1 false colour', url: res.layers.composite }, ...(res.layers.change ? [{ title: 'Backscatter change (VH)', url: res.layers.change }] : [])],
    });
  };

  const r = out?.radar;
  const bandOptions = before ? before.meta.bandNames.map((n, i) => ({ i, label: `${i + 1}${n ? ` · ${n}` : ''}` })) : [];
  const area = (k: '1' | '2' | '3') => (r?.change?.ha ? `${fmt(r.change.ha[k], 4)} ha` : `${(r?.change?.counts[k] ?? 0).toLocaleString()} px`);
  const q = (s: Quartiles | null, unit = ' dB') => (s ? `${fmt(s.median, 3)}${unit}` : '—');

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload Sentinel-1 backscatter with VV and VH bands (for example COPERNICUS/S1_GRD exported from Earth Engine in dB, or ASF RTC in linear power). Radar sees
        through cloud. Add a second image from the same relative orbit to map change: a drop in VH is the usual sign of clearing.
      </p>
      <Suspense fallback={null}>
        <Sentinel1SearchPanel
          target={target}
          boundary={boundary}
          match={before && !after ? { file: before, relativeOrbit: firstOrbit } : null}
          onRaster={async (file, item, notes) => {
            const slot = before && !after ? 'after' : 'before';
            if (slot === 'before') {
              setAfter(null);
              setFirstOrbit(item.relativeOrbit);
              setLiveNotes(notes);
            } else setLiveNotes(n => [...n, ...notes]);
            await load(file, slot);
            notify(slot === 'before' ? 'First date loaded. Load a second scene for change, or Analyse.' : 'Second date loaded on the first one’s grid.', 'success');
          }}
        />
      </Suspense>
      {liveNotes.length > 0 && <Notes items={liveNotes} />}
      <FileDrop id="radar-before" label="Image (before, or the only one)" accept=".tif,.tiff" hint="GeoTIFF · VV and VH bands" busy={job.busy === 'upload'} loaded={before?.name} onFile={f => load(f, 'before')} />
      <FileDrop id="radar-after" label="Second image (after, optional)" accept=".tif,.tiff" hint="Same grid and relative orbit" compact loaded={after?.name} onFile={f => load(f, 'after')} />
      <div className="param-row">
        {before && (
          <>
            <label className="param">
              <span>VV band</span>
              <select id="radar-vv" value={vv} onChange={e => setVv(e.target.value)}>
                {bandOptions.map(o => (
                  <option key={o.i} value={o.i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="param">
              <span>VH band</span>
              <select id="radar-vh" value={vh} onChange={e => setVh(e.target.value)}>
                {bandOptions.map(o => (
                  <option key={o.i} value={o.i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="param" title="Lee speckle filter window (pixels); 1 switches the filter off.">
          <span>Filter window</span>
          <select id="radar-window" value={win} onChange={e => setWin(e.target.value)}>
            {['1', '3', '5', '7', '9'].map(v => (
              <option key={v} value={v}>
                {v === '1' ? 'off' : `${v} × ${v}`}
              </option>
            ))}
          </select>
        </label>
        <label className="param">
          <span>Change threshold (dB)</span>
          <input id="radar-threshold" type="number" min="0.1" step="0.5" value={threshold} onChange={e => setThreshold(e.target.value)} />
        </label>
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              const a = await load(BEFORE, 'before');
              const b = a && (await load(AFTER, 'after'));
              if (a && b) await run(a, b);
            }}
          >
            Try synthetic pair
          </button>
          <button type="button" id="radar-run" className="btn btn-primary" disabled={!before || busy} onClick={() => run()}>
            {job.busy === 'run' ? 'Filtering…' : after ? 'Analyse change' : 'Analyse'}
          </button>
        </div>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {r && out && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Median VH" value={q(r.dates[r.dates.length - 1].vh)} />
            <Stat label="Median VV" value={q(r.dates[r.dates.length - 1].vv)} />
            {r.change && <Stat label="VH decrease" value={`${area('1')} (${(r.change.share['1'] * 100).toFixed(1)} %)`} tone={r.change.share['1'] > 0.01 ? 'bad' : undefined} />}
            {r.change && <Stat label="VH increase" value={`${area('3')} (${(r.change.share['3'] * 100).toFixed(1)} %)`} />}
          </div>
          {out.layers.change && (
            <div className="view-toggles" role="tablist">
              {(['change', 'composite'] as View[]).map(v => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
                  {v === 'change' ? 'Change' : 'False colour'}
                </button>
              ))}
            </div>
          )}
          <figure className="raster-figure">
            <ArtifactImage url={view === 'change' && out.layers.change ? out.layers.change : out.layers.composite} width={r.width} height={r.height} label={view === 'change' ? 'Backscatter change' : 'Sentinel-1 false colour'} />
            <figcaption className="field-hint">
              {view === 'change' ? 'Red: VH decrease beyond the threshold; blue: increase; unchanged cells are clear.' : 'Red VV, green VH, blue VV/VH: vegetation looks green, bare and built ground magenta to white, water dark.'}
            </figcaption>
          </figure>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Image</th>
                  <th>VV (dB)</th>
                  <th>VH (dB)</th>
                  <th>VH/VV (dB)</th>
                  <th>RVI</th>
                </tr>
              </thead>
              <tbody>
                {r.dates.map(d => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td className="num">{q(d.vv, '')}</td>
                    <td className="num">{q(d.vh, '')}</td>
                    <td className="num">{q(d.ratio, '')}</td>
                    <td className="num">{q(d.rvi, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <Downloads idPrefix="radar" items={out.downloads} />
          </div>
          <Notes items={r.notes} />
        </div>
      )}
    </div>
  );
}
