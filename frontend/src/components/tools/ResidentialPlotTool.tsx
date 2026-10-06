import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiUrl, runJob, type Download, type ResultImage, type StoredFile } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { Downloads, Stat, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  onBoundary: (b: Boundary | null) => void;
}

type Mode = 'geo' | 'photo';
type Zone = 'crossing' | 'edge' | 'alignment' | 'inside' | 'outside';

interface EncroachmentParams {
  sensitivity: number;
  minArea: number;
  stripWidth: number;
  gap: number;
  tolerance: number;
}
const DEFAULT_PARAMS: EncroachmentParams = { sensitivity: 3, minArea: 4, stripWidth: 3, gap: 1.5, tolerance: 1 };

interface Patch {
  id: number;
  zone: Zone;
  area: number;
  areaInside: number;
  areaJoinedInside: number;
  depthInside: number;
  kind: string;
}
interface Comparison {
  from: string;
  to: string;
  changedInside: number;
  propertyArea: number;
  byZone: Record<Zone, number>;
  patches: Patch[];
}
interface ResidentialJob {
  name: string;
  markdown: string;
  comparison: Comparison;
  timeline: Comparison[];
  base: number;
  zones: Record<Zone, { label: string; color: number[]; meaning: string }>;
  zoneOrder: Zone[];
  grid: { width: number; height: number; cellM: number | null; layers: { label: string; date: string | null }[]; notes: string[] };
  views: { past: string; now: string; changes: Record<Zone, string> };
  map: { bounds: LatLngBounds; image: ResultImage } | null;
  downloads: Download[];
}

interface ImageItem {
  id: string;
  file: StoredFile;
  /** Local copy for tracing the outline on the current photo. */
  local?: string;
  label: string;
  date: string; // YYYY-MM-DD or ''
}

const ZONE_ORDER: Zone[] = ['crossing', 'edge', 'alignment', 'inside', 'outside'];
const SAMPLE_DATES = ['2019-02-10', '2021-02-14', '2024-02-08'];

/** Date written in a file name: 2024-03-15, 20240315 or 2024_075 (year and day of year). */
function dateFromFilename(name: string): string {
  const m = /(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?!\d)/.exec(name);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCMonth() === +m[2] - 1 && +m[1] > 1900) return d.toISOString().slice(0, 10);
  }
  const j = /(\d{4})[-_](\d{3})(?!\d)/.exec(name);
  if (j && +j[2] >= 1 && +j[2] <= 366) return new Date(Date.UTC(+j[1], 0, +j[2])).toISOString().slice(0, 10);
  return '';
}

function areaText(v: number, cellM: number | null): string {
  if (!cellM) return `${Math.round(v).toLocaleString()} px`;
  return v >= 10_000 ? `${fmt(v / 10_000, 4)} ha` : `${fmt(v, 4)} m²`;
}

const rgb = (c: number[]) => `rgb(${c.join(',')})`;

export default function ResidentialPlotTool({ onOutput, boundary, onBoundary }: Props) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>('geo');
  const job = useJob();
  const busy = job.busy;
  const images = useUpload(['raster', 'image'], 'an image (GeoTIFF, JPG, PNG or WebP)');
  const vectors = useUpload(['vector', 'table', 'archive', 'other'], 'a boundary file');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [params, setParams] = useState<EncroachmentParams>(DEFAULT_PARAMS);
  const [buffer, setBuffer] = useState(15);
  const [outline, setOutline] = useState<[number, number][]>([]);
  const [groundWidth, setGroundWidth] = useState('');
  const [result, setResult] = useState<ResidentialJob | null>(null);
  const [swipe, setSwipe] = useState(50);
  const [shown, setShown] = useState<Set<Zone>>(new Set(ZONE_ORDER));
  const [traceSize, setTraceSize] = useState<{ width: number; height: number } | null>(null);
  const fail = (m: string) => notify(m, 'error');

  const sorted = useMemo(() => [...items].sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : 0)), [items]);
  const current = sorted[sorted.length - 1];

  useEffect(() => () => items.forEach(i => i.local && URL.revokeObjectURL(i.local)), [items]);

  const setParam = <K extends keyof EncroachmentParams>(k: K, v: string) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) setParams(p => ({ ...p, [k]: n }));
  };

  const switchMode = (m: Mode) => {
    job.cancel();
    setMode(m);
    setItems([]);
    setResult(null);
    setOutline([]);
    onOutput(null);
  };

  const addFiles = async (files: File[]) => {
    for (const file of files) {
      if (mode === 'geo' && !/\.tiff?$/i.test(file.name)) return fail(`${file.name}: use GeoTIFFs here, or switch to “Photos” for JPG/PNG.`);
      if (mode === 'photo' && !/\.(jpe?g|png|webp)$/i.test(file.name)) return fail(`${file.name}: use JPG, PNG or WebP photos here.`);
    }
    const added = await job.run('files', async signal => {
      const out: ImageItem[] = [];
      for (const file of files) {
        const f = await images.upload(file, signal);
        out.push({ id: f.id, file: f, local: mode === 'photo' ? URL.createObjectURL(file) : undefined, label: file.name.replace(/\.[^.]+$/, ''), date: dateFromFilename(file.name) });
      }
      return out;
    }, fail);
    if (!added) return;
    setItems(list => [...list, ...added]);
    setResult(null);
    if (mode === 'photo') setOutline([]);
  };

  const boundaryFrom = async (picked: File | string) => {
    const b = await job.run('boundary', async (signal, onProgress) => {
      const f = typeof picked === 'string' ? await vectors.sample(picked) : await vectors.upload(picked, signal);
      const r = await runJob<{ boundary: Boundary | null }>('survey', { file: f.id }, { closeRing: true }, { signal, onProgress });
      if (!r.boundary) throw new Error(`${f.name} has no polygon to use as the property boundary.`);
      return r.boundary;
    }, fail);
    if (b) {
      onBoundary(b);
      setResult(null);
    }
    return b;
  };

  const loadSample = async () => {
    setMode('geo');
    setItems([]);
    if (!(await boundaryFrom('plot_boundary_synthetic.geojson'))) return;
    const list = await job.run('files', () => Promise.all(SAMPLE_DATES.map(d => images.sample(`plot_${d}_synthetic.tif`))), fail);
    if (!list) return;
    setItems(list.map((f, i) => ({ id: f.id, file: f, label: `Plot ${SAMPLE_DATES[i].slice(0, 4)}`, date: SAMPLE_DATES[i] })));
    setResult(null);
  };

  // Photo mode: the outline is traced in the grid the server uses (the current photo scaled to at most 1,200 px).
  const photoGrid = useMemo(() => {
    if (mode !== 'photo' || !traceSize) return null;
    const sc = Math.min(1, 1200 / Math.max(traceSize.width, traceSize.height));
    return { width: Math.max(1, Math.round(traceSize.width * sc)), height: Math.max(1, Math.round(traceSize.height * sc)) };
  }, [mode, traceSize]);

  const run = async (base = 0) => {
    if (sorted.length < 2) return fail('Add at least two images of the property from different dates.');
    if (mode === 'geo' && !boundary) return fail('Set the property boundary first: load it here, or draw it in Land survey and use it as the analysis boundary.');
    const gw = Number(groundWidth);
    const r = await job.run(
      'run',
      (signal, onProgress) =>
        runJob<ResidentialJob>(
          'residential',
          {},
          {
            mode,
            images: sorted.map(i => ({ file: i.file.id, label: i.date ? `${i.label} (${i.date})` : i.label, date: i.date || null })),
            boundary,
            bufferM: buffer,
            outline,
            groundWidthM: groundWidth.trim() && Number.isFinite(gw) && gw > 0 ? gw : null,
            base,
            settings: params,
          },
          { signal, onProgress },
        ),
      msg => {
        fail(msg);
        setResult(null);
        onOutput(null);
      },
    );
    if (!r) return;
    setResult(r);
    onOutput({ tool: 'residential', name: r.name, markdown: r.markdown, map: r.map ?? undefined, summary: { comparison: r.comparison, timeline: r.timeline }, figures: [{ title: 'Current image', url: r.views.now }] });
  };

  // Re-run when the boundary changes after a result.
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result && mode === 'geo') run(result.base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const onTrace = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!photoGrid) return;
    const b = e.currentTarget.getBoundingClientRect();
    setOutline(o => [...o, [((e.clientX - b.left) / b.width) * photoGrid.width, ((e.clientY - b.top) / b.height) * photoGrid.height]]);
    setResult(null);
  };

  const s = result?.grid;
  const cmp = result?.comparison;
  const ZONES = result?.zones;
  const crossing = cmp?.patches.filter(p => p.zone === 'crossing') ?? [];

  return (
    <div className="tool-body">
      <div className="mode-switch" role="radiogroup" aria-label="Image type">
        <button type="button" role="radio" aria-checked={mode === 'geo'} className={mode === 'geo' ? 'active' : ''} onClick={() => switchMode('geo')}>
          Georeferenced images (GeoTIFF)
        </button>
        <button type="button" role="radio" aria-checked={mode === 'photo'} className={mode === 'photo' ? 'active' : ''} onClick={() => switchMode('photo')}>
          Photos / screenshots (JPG, PNG)
        </button>
      </div>
      <p className="tool-intro">
        {mode === 'geo'
          ? 'Upload satellite or drone images of your property from different years (GeoTIFF with coordinates). TerraX lines them up on your plot boundary, shows past and present side by side, and highlights ground that changed: especially changes that cross your boundary line, as when a neighbouring building, wall or field is extended onto your land.'
          : 'Upload two or more images showing exactly the same view (for example Google Earth historical imagery saved at the same zoom and position), then trace your plot on the latest one. Without coordinates, areas need the ground width of the image.'}
      </p>

      {mode === 'geo' && (
        <div className="param-row">
          {boundary ? (
            <span className="field-hint">
              Property boundary: <strong>{boundary.name}</strong> ({(boundary.areaM2 / 10_000).toFixed(3)} ha). Change it in Land survey or load another file here.
            </span>
          ) : (
            <span className="field-hint">No property boundary yet: load one (GeoJSON, KML, GPX, zipped shapefile) or draw it in Land survey.</span>
          )}
        </div>
      )}
      <div className="drop-pair">
        {mode === 'geo' && (
          <FileDrop id="plot-boundary" compact label="Property boundary" accept=".geojson,.json,.kml,.gpx,.zip,.csv" hint="GeoJSON · KML · GPX · CSV · zipped Shapefile" loaded={boundary?.name} busy={busy === 'boundary'} onFile={f => boundaryFrom(f)} />
        )}
        <FileDrop
          id="plot-images"
          compact
          label="Images from different years"
          accept={mode === 'geo' ? '.tif,.tiff' : 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'}
          hint={mode === 'geo' ? 'GeoTIFF · date in the file name helps' : 'JPG · PNG · WebP, same framing'}
          busy={busy === 'files'}
          loaded={items.length ? `${items.length} image${items.length === 1 ? '' : 's'}` : null}
          onFile={f => addFiles([f])}
          onFiles={addFiles}
        />
      </div>

      {sorted.length > 0 && (
        <div className="tabular-view">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Label</th>
                <th>Date</th>
                <th>Details</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((it, i) => (
                <tr key={it.id}>
                  <td>{i === sorted.length - 1 ? 'Current' : `Past ${i + 1}`}</td>
                  <td>
                    <input className="label-input" aria-label="Image label" value={it.label} onChange={e => setItems(l => l.map(x => (x.id === it.id ? { ...x, label: e.target.value } : x)))} />
                  </td>
                  <td>
                    <input type="date" aria-label="Image date" value={it.date} onChange={e => setItems(l => l.map(x => (x.id === it.id ? { ...x, date: e.target.value } : x)))} />
                  </td>
                  <td className="muted">
                    {it.file.kind === 'raster'
                      ? `${it.file.meta.width} × ${it.file.meta.height} px, ${it.file.meta.bands} band${it.file.meta.bands === 1 ? '' : 's'}${it.file.meta.epsg ? `, EPSG:${it.file.meta.epsg}` : ''}`
                      : `${it.file.meta.width} × ${it.file.meta.height} px`}
                  </td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setItems(l => l.filter(x => x.id !== it.id))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.some(i => !i.date) && <p className="field-hint">Enter a date for each image so they are compared in the right order (the latest is treated as current).</p>}
        </div>
      )}

      {mode === 'photo' && current?.local && (
        <div className="sub-panel">
          <div className="eyebrow">Trace your plot on the current image · {outline.length} corner{outline.length === 1 ? '' : 's'}</div>
          <div className="trace-wrap">
            <img src={current.local} alt="Current image" className="raster-canvas smooth" onLoad={e => setTraceSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
            {photoGrid && (
            <svg className="trace-svg" viewBox={`0 0 ${photoGrid.width} ${photoGrid.height}`} preserveAspectRatio="none" onClick={onTrace} role="img" aria-label="Click corners of your plot">
              {outline.length > 1 && <polygon points={outline.map(p => p.join(',')).join(' ')} fill="rgba(255,214,0,0.15)" stroke="#ffd600" strokeWidth={Math.max(1, photoGrid.width / 400)} />}
              {outline.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={Math.max(2, photoGrid.width / 200)} fill="#ffd600" />
              ))}
            </svg>
            )}
          </div>
          <div className="param-row">
            <button type="button" className="btn btn-small" disabled={!outline.length} onClick={() => setOutline(o => o.slice(0, -1))}>
              Undo corner
            </button>
            <button type="button" className="btn btn-small" disabled={!outline.length} onClick={() => setOutline([])}>
              Clear
            </button>
            <label className="param" title="Width of the whole image on the ground, e.g. from Google Earth's ruler. Leave blank to report pixels.">
              <span>Image width on the ground (m)</span>
              <input id="plot-ground-width" type="number" min="1" step="1" placeholder="optional" value={groundWidth} onChange={e => setGroundWidth(e.target.value)} />
            </label>
          </div>
        </div>
      )}

      <details className="param-panel">
        <summary>Detection settings</summary>
        <div className="param-row">
          <label className="param" title="Higher values flag only stronger changes (robust standard deviations).">
            <span>Sensitivity threshold (SD)</span>
            <input id="plot-sensitivity" type="number" min="1" max="10" step="0.5" defaultValue={params.sensitivity} onChange={e => setParam('sensitivity', e.target.value)} />
          </label>
          <label className="param">
            <span>Ignore patches under (m²)</span>
            <input id="plot-minarea" type="number" min="0" step="1" defaultValue={params.minArea} onChange={e => setParam('minArea', e.target.value)} />
          </label>
          <label className="param">
            <span>Edge strip (m)</span>
            <input id="plot-strip" type="number" min="0" step="0.5" defaultValue={params.stripWidth} onChange={e => setParam('stripWidth', e.target.value)} />
          </label>
          <label className="param" title="Changes closer than this are joined, so an unchanged fence or wall does not split them.">
            <span>Join gaps up to (m)</span>
            <input id="plot-gap" type="number" min="0" step="0.5" defaultValue={params.gap} onChange={e => setParam('gap', e.target.value)} />
          </label>
          <label className="param" title="Crossing changes no deeper than this are treated as image misalignment.">
            <span>Alignment tolerance (m)</span>
            <input id="plot-tolerance" type="number" min="0" step="0.5" defaultValue={params.tolerance} onChange={e => setParam('tolerance', e.target.value)} />
          </label>
          {mode === 'geo' && (
            <label className="param">
              <span>Look around the plot (m)</span>
              <input id="plot-buffer" type="number" min="0" max="200" step="5" defaultValue={buffer} onChange={e => Number.isFinite(Number(e.target.value)) && setBuffer(Math.max(0, Math.min(200, Number(e.target.value))))} />
            </label>
          )}
        </div>
        <p className="field-hint">In photo mode without a ground width, the sizes above are in pixels.</p>
      </details>

      <div className="param-row">
        <div className="button-row push-right">
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={loadSample}>
            Try synthetic plot
          </button>
          <button type="button" id="plot-run" className="btn btn-primary" disabled={Boolean(busy) || sorted.length < 2} onClick={() => run(result?.base ?? 0)}>
            {busy === 'run' ? 'Comparing…' : 'Compare images'}
          </button>
        </div>
      </div>

      <JobStatus job={job} onCancel={job.cancel} />
      {result && s && cmp && ZONES && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Crossing the boundary" value={`${crossing.length} patch${crossing.length === 1 ? '' : 'es'} · ${areaText(crossing.reduce((a, x) => a + x.areaInside, 0), s.cellM)} inside`} tone={crossing.length ? 'bad' : 'good'} />
            <Stat label="Deepest crossing" value={crossing.length ? `${fmt(Math.max(...crossing.map(x => x.depthInside)), 3)} ${s.cellM ? 'm' : 'px'}` : '—'} />
            <Stat label="Changed inside the plot" value={`${areaText(cmp.changedInside, s.cellM)} (${cmp.propertyArea ? ((cmp.changedInside / cmp.propertyArea) * 100).toFixed(1) : '—'} %)`} />
            <Stat label="Plot area (grid)" value={areaText(cmp.propertyArea, s.cellM)} />
          </div>

          <div className="param-row">
            <label className="inline-select">
              <span>Compare the current image with</span>
              <select id="plot-base" value={result.base} onChange={e => run(Number(e.target.value))}>
                {s.layers.slice(0, -1).map((l, i) => (
                  <option key={i} value={i}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <figure className="raster-figure">
            <div className="swipe-wrap" style={{ aspectRatio: `${s.width} / ${s.height}` }}>
              <img src={apiUrl(result.views.now)} alt="" className="swipe-layer" />
              <div className="swipe-top" style={{ clipPath: `inset(0 ${100 - swipe}% 0 0)` }}>
                <img src={apiUrl(result.views.past)} alt="" className="swipe-layer" />
              </div>
              {ZONE_ORDER.filter(z => shown.has(z)).map(z => (
                <img key={z} src={apiUrl(result.views.changes[z])} alt="" className="swipe-layer swipe-changes" />
              ))}
              <div className="swipe-line" style={{ left: `${swipe}%` }} aria-hidden="true" />
              <span className="swipe-tag left">{s.layers[result.base].label}</span>
              <span className="swipe-tag right">{s.layers[s.layers.length - 1].label}</span>
            </div>
            <label className="range-row">
              <span>Earlier</span>
              <input id="plot-swipe" type="range" min="0" max="100" value={swipe} onChange={e => setSwipe(Number(e.target.value))} aria-label="Swipe between the earlier and the current image" />
              <span>Current</span>
            </label>
            <figcaption className="legend-row">
              <span>
                <i className="class-swatch" style={{ background: '#ffd600' }} /> Your boundary
              </span>
              {ZONE_ORDER.map(z => (
                <label key={z} className="check" title={ZONES[z].meaning}>
                  <input type="checkbox" checked={shown.has(z)} onChange={e => setShown(prev => { const n = new Set(prev); if (e.target.checked) n.add(z); else n.delete(z); return n; })} />
                  <i className="class-swatch" style={{ background: rgb(ZONES[z].color) }} /> {ZONES[z].label} ({areaText(cmp.byZone[z], s.cellM)})
                </label>
              ))}
            </figcaption>
          </figure>

          {cmp.patches.filter(p => p.zone !== 'outside').length > 0 && (
            <div className="tabular-view">
              <table id="plot-patches">
                <thead>
                  <tr>
                    <th>Where</th>
                    <th>Inside the plot</th>
                    <th>Joined, further in</th>
                    <th>Depth</th>
                    <th>Total</th>
                    <th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {cmp.patches
                    .filter(p => p.zone !== 'outside')
                    .slice(0, 40)
                    .map(p => (
                      <tr key={p.id}>
                        <td>
                          <i className="class-swatch" style={{ background: rgb(ZONES[p.zone].color) }} /> {ZONES[p.zone].label}
                        </td>
                        <td className="num">{areaText(p.areaInside, s.cellM)}</td>
                        <td className="num">{p.areaJoinedInside ? areaText(p.areaJoinedInside, s.cellM) : '—'}</td>
                        <td className="num">{p.depthInside ? `${fmt(p.depthInside, 3)} ${s.cellM ? 'm' : 'px'}` : '—'}</td>
                        <td className="num">{areaText(p.area, s.cellM)}</td>
                        <td>{p.kind}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {result.timeline.length > 1 && (
            <div className="render-window">
              <div className="eyebrow">Change inside the plot, each image compared with the current one ({s.cellM ? 'm²' : 'px'})</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={result.timeline.map(t => {
                    const cross = t.patches.filter(x => x.zone === 'crossing').reduce((a, x) => a + x.areaInside + x.areaJoinedInside, 0);
                    return { name: t.from, crossing: cross, other: Math.max(0, t.changedInside - cross) };
                  })}
                  margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                  <XAxis dataKey="name" stroke="#4a6580" fontSize={11} />
                  <YAxis stroke="#4a6580" fontSize={11} width={56} />
                  <Tooltip formatter={v => fmt(Number(v))} contentStyle={{ background: '#030814', border: '1px solid #38bdf8' }} />
                  <Legend />
                  <Bar dataKey="crossing" name="Crossing patches (incl. joined change)" stackId="a" fill="#ec4899" isAnimationActive={false} />
                  <Bar dataKey="other" name="Other change inside" stackId="a" fill="#facc15" isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="button-row">
            <span className="push-right">
              <Downloads idPrefix="plot" items={result.downloads} ids={['plot-export']} />
            </span>
          </div>

          <p className="notice">
            This screening shows where the ground changed; it cannot establish ownership or prove encroachment. Check every flagged patch on the images, use the boundary from
            your registered survey or land record, and for a dispute ask a licensed surveyor to demarcate the boundary on the ground.
          </p>
          <ul className="hint-list">
            {s.notes.map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
