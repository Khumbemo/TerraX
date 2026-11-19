// Surface water and floods (backend: tools/water.py, processing/water.py): a water index from optical images or
// Sentinel-1 backscatter, one date or before/after, with an automatic (Otsu) threshold.
import { useState } from 'react';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { usePrefs } from '../../lib/prefs';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { areaHa } from '../../lib/units';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

type Mode = 'optical' | 'radar';
type Role = 'green' | 'nir' | 'swir1';

interface WaterClass {
  id: number;
  label: string;
  pixels: number;
  ha: number | null;
}

interface WaterJob {
  name: string;
  markdown: string;
  map: { bounds: LatLngBounds | null; image: ResultImage | null };
  result: { mode: Mode; index: string; threshold: number; unit: string; width: number; height: number; summary: { observedPixels: number; classes: WaterClass[] }; notes: string[] };
  legend: { id: number; label: string; color: number[] }[];
  downloads: Download[];
}

/** The scene's own cloud mask, recognised from its band names (TerraX's Sentinel-2 and Landsat windows name them). */
function qaOf(meta: RasterMeta): { band: number; kind: 'scl' | 'landsat' } | null {
  const i = meta.bandNames.findIndex(n => /^qa_pixel/i.test(n));
  if (i >= 0) return { band: i, kind: 'landsat' };
  const j = meta.bandNames.findIndex(n => /^scl$/i.test(n.trim()));
  return j >= 0 ? { band: j, kind: 'scl' } : null;
}

export default function WaterTool({ onOutput, boundary }: { onOutput: (out: ToolOutput | null) => void; boundary: Boundary | null }) {
  const notify = useToast();
  const { units } = usePrefs();
  const job = useJob();
  const busy = job.busy;
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const [mode, setMode] = useState<Mode>('optical');
  const [a, setA] = useState<StoredFile<RasterMeta> | null>(null);
  const [b, setB] = useState<StoredFile<RasterMeta> | null>(null);
  const [roles, setRoles] = useState<Partial<Record<Role, number>>>({});
  const [vv, setVv] = useState('1');
  const [dropDb, setDropDb] = useState('3');
  const [threshold, setThreshold] = useState('');
  const [out, setOut] = useState<WaterJob | null>(null);
  const fail = (m: string) => notify(m, 'error');

  const switchMode = (m: Mode) => {
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
    (which === 'a' ? setA : setB)(f);
    if (which === 'a') {
      const g = f.meta.guessedBands;
      setRoles({ green: g.green, nir: g.nir, swir1: g.swir1 });
    }
    setOut(null);
  };

  const run = async () => {
    if (!a) return;
    const thr = threshold.trim() === '' ? 'auto' : Number(threshold);
    if (thr !== 'auto' && !Number.isFinite(thr)) return fail('Set the threshold as a number, or leave it empty for automatic.');
    const params: Record<string, unknown> = { mode, threshold: thr, boundary };
    if (mode === 'optical') {
      params.bands = Object.fromEntries(Object.entries(roles).filter(([, v]) => v !== undefined));
      const qa = qaOf(a.meta);
      if (qa) params.qa = qa;
    } else {
      params.band = Math.max(0, Number(vv) - 1);
      params.dropDb = Number(dropDb);
    }
    const r = await job.run('run', (signal, onProgress) => runJob<WaterJob>('water', { a: a.id, b: b?.id }, params, { signal, onProgress }), m => {
      fail(m);
      setOut(null);
      onOutput(null);
    });
    if (!r) return;
    setOut(r);
    onOutput({ tool: 'water', name: r.name, markdown: r.markdown, ...(r.map.image ? { map: r.map, figures: [{ title: r.map.image.label, url: r.map.image.url }] } : {}) });
  };

  const cls = (label: string) => out?.result.summary.classes.find(c => c.label === label);
  const area = (c: WaterClass | undefined) => (!c ? '—' : c.ha === null ? `${c.pixels.toLocaleString()} px` : areaHa(c.ha, units));
  const bandOptions = a ? Array.from({ length: a.meta.bands }, (_, i) => i) : [];

  return (
    <div className="tool-body">
      <div className="mode-switch" role="radiogroup" aria-label="Method">
        <button type="button" id="water-optical" role="radio" aria-checked={mode === 'optical'} className={mode === 'optical' ? 'active' : ''} onClick={() => switchMode('optical')}>
          Optical (MNDWI / NDWI)
        </button>
        <button type="button" id="water-radar" role="radio" aria-checked={mode === 'radar'} className={mode === 'radar' ? 'active' : ''} onClick={() => switchMode('radar')}>
          Radar (Sentinel-1, through cloud)
        </button>
      </div>
      <p className="tool-intro">
        {mode === 'optical'
          ? 'Upload a multispectral image (Sentinel-2, Landsat), or two of the same area on the same grid to map new water. MNDWI is used with a SWIR1 band, NDWI otherwise; TerraX’s Sentinel-2 and Landsat downloads are cloud-masked automatically.'
          : 'Upload Sentinel-1 backscatter (VV) from before and during a flood on the same grid, or one date for open water. Radar sees through the cloud that usually covers floods. Use the radar tool’s search to download dates that line up.'}
      </p>
      <div className="drop-pair">
        <FileDrop id="water-a" compact label="Before (or the only image)" accept=".tif,.tiff" hint="GeoTIFF" busy={busy === 'a'} loaded={a?.name} onFile={f => load(f, 'a')} />
        <FileDrop id="water-b" compact label="After (optional)" accept=".tif,.tiff" hint="GeoTIFF · same grid" busy={busy === 'b'} loaded={b?.name} onFile={f => load(f, 'b')} />
      </div>
      <div className="param-row">
        {mode === 'optical' && a && a.meta.bands > 1 && (
          <div className="ndvi-controls">
            {(['green', 'nir', 'swir1'] as Role[]).map(role => (
              <label key={role} className="inline-select">
                <span>{role === 'swir1' ? 'SWIR1' : role === 'nir' ? 'NIR' : 'Green'}</span>
                <select id={`water-${role}`} value={roles[role] ?? ''} onChange={e => setRoles({ ...roles, [role]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                  <option value="">{role === 'green' ? '—' : 'none'}</option>
                  {bandOptions.map(i => (
                    <option key={i} value={i}>
                      {a.meta.bandNames[i] ?? `Band ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        {mode === 'radar' && (
          <>
            <label className="param">
              <span>VV band</span>
              <input id="water-vv" type="number" min="1" step="1" value={vv} onChange={e => setVv(e.target.value)} />
            </label>
            <label className="param" title="With two dates, new water must also have lost this much backscatter">
              <span>Drop (dB)</span>
              <input id="water-drop" type="number" min="0.5" max="20" step="0.5" value={dropDb} onChange={e => setDropDb(e.target.value)} />
            </label>
          </>
        )}
        <label className="param" title={mode === 'optical' ? 'Water if the index is at least this; empty = automatic (Otsu)' : 'Water if VV (dB) is at most this; empty = automatic (Otsu)'}>
          <span>Threshold</span>
          <input id="water-threshold" type="number" step={mode === 'optical' ? '0.05' : '0.5'} placeholder="auto" value={threshold} onChange={e => setThreshold(e.target.value)} />
        </label>
        <button type="button" id="water-run" className="btn btn-primary push-right" disabled={!a || Boolean(busy)} onClick={run}>
          {busy === 'run' ? 'Mapping…' : b ? 'Map water change' : 'Map water'}
        </button>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {out && (
        <div className="result-block">
          <div className="stat-grid">
            {out.result.summary.classes.length > 2 ? (
              <>
                <Stat label="New water (flood)" value={area(cls('New water (flood)'))} tone="bad" />
                <Stat label="Water both dates" value={area(cls('Water both dates'))} />
                <Stat label="Water gone" value={area(cls('Water gone'))} />
              </>
            ) : (
              <Stat label="Water" value={area(cls('Water'))} />
            )}
            <Stat label="Threshold" value={`${out.result.index} ${out.result.mode === 'optical' ? '≥' : '≤'} ${fmt(out.result.threshold, 3)}${out.result.unit ? ` ${out.result.unit}` : ''}`} />
          </div>
          {out.map.image && (
            <figure className="raster-figure">
              <ArtifactImage url={out.map.image.url} width={out.result.width} height={out.result.height} label={out.map.image.label} />
              <figcaption className="legend-row">
                {out.legend.map(c => (
                  <span key={c.id}>
                    <i className="class-swatch" style={{ background: `rgb(${c.color.join(',')})` }} /> {c.label}
                  </span>
                ))}
              </figcaption>
            </figure>
          )}
          <div className="button-row">
            <span className="push-right">
              <Downloads idPrefix="water" items={out.downloads} />
            </span>
          </div>
          <Notes items={out.result.notes} />
        </div>
      )}
    </div>
  );
}
