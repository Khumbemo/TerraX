import { useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { downloadText } from '../../lib/download';
import { mapImage } from '../../lib/overlay';
import { labelPatches, patchAreas, patchesToGeoJson, unprojector } from '../../lib/patches';
import { dateFromFilename } from '../../lib/qa';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import {
  DEFAULT_PARAMS,
  ZONES,
  areaText,
  compareLayers,
  encroachmentMarkdown,
  prepareGeoStack,
  preparePhotoStack,
  type Comparison,
  type EncroachmentParams,
  type Stack,
  type Zone,
} from '../../lib/tools/encroachment';
import type { ToolOutput } from '../../lib/tools/registry';
import { measureSurvey, parseSurveyFile } from '../../lib/tools/survey';
import { makeBoundary } from '../../lib/vector';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import { Stat } from './ForestLossTool';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  onBoundary: (b: Boundary | null) => void;
}

type Mode = 'geo' | 'photo';

interface ImageItem {
  id: string;
  file: File;
  label: string;
  date: string; // YYYY-MM-DD or ''
  raster?: OpenRaster;
  photo?: { rgba: Uint8ClampedArray; width: number; height: number };
}

const ZONE_ORDER: Zone[] = ['crossing', 'edge', 'alignment', 'inside', 'outside'];
const ZONE_BY_CODE: Record<number, Zone> = { 1: 'crossing', 2: 'edge', 3: 'inside', 4: 'outside', 5: 'alignment' };
const SAMPLE_DATES = ['2019-02-10', '2021-02-14', '2024-02-08'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function decodePhoto(file: File): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} is not an image this browser can read.`);
  });
  const s = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0, c.width, c.height);
  return { rgba: g.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}

/** One 1–99 % stretch shared by the three bands (keeps natural colour balance), with the property outline drawn in. */
function layerRgba(stack: Stack, i: number, outline: boolean): Uint8ClampedArray {
  const { width: w, height: h, property } = stack;
  const out = new Uint8ClampedArray(w * h * 4);
  const bands = stack.layers[i].rgb;
  const vals: number[] = [];
  for (const b of bands) for (let k = 0; k < b.length; k += Math.max(1, Math.floor(b.length / 30000))) if (!Number.isNaN(b[k])) vals.push(b[k]);
  vals.sort((x, y) => x - y);
  const shared = vals.length ? [vals[Math.floor(vals.length * 0.01)], vals[Math.floor(vals.length * 0.99)]] : [0, 1];
  const ranges = [shared, shared, shared];
  for (let k = 0; k < w * h; k++) {
    if (Number.isNaN(bands[0][k])) continue;
    for (let c = 0; c < 3; c++) out[k * 4 + c] = ((bands[c][k] - ranges[c][0]) / (ranges[c][1] - ranges[c][0] || 1)) * 255;
    out[k * 4 + 3] = 255;
  }
  if (outline) {
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const k = r * w + c;
        if (!property[k]) continue;
        const edge = c === 0 || r === 0 || c === w - 1 || r === h - 1 || !property[k - 1] || !property[k + 1] || !property[k - w] || !property[k + w];
        if (edge) out.set([255, 214, 0, 255], k * 4);
      }
  }
  return out;
}

function changeRgba(cmp: Comparison, n: number, zones: Set<Zone>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let k = 0; k < n; k++) {
    const z = ZONE_BY_CODE[cmp.classes[k]];
    if (z && zones.has(z)) out.set([...ZONES[z].color, 200], k * 4);
  }
  return out;
}

function Canvas({ rgba, width, height, className }: { rgba: Uint8ClampedArray; width: number; height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    if (!g) return;
    const img = g.createImageData(width, height);
    img.data.set(rgba);
    g.putImageData(img, 0, 0);
  }, [rgba, width, height]);
  return <canvas ref={ref} className={className} />;
}

export default function ResidentialPlotTool({ onOutput, boundary, onBoundary }: Props) {
  const notify = useToast();
  const [mode, setMode] = useState<Mode>('geo');
  const [items, setItems] = useState<ImageItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [params, setParams] = useState<EncroachmentParams>(DEFAULT_PARAMS);
  const [buffer, setBuffer] = useState(15);
  const [outline, setOutline] = useState<[number, number][]>([]);
  const [groundWidth, setGroundWidth] = useState('');
  const [result, setResult] = useState<{ stack: Stack; cmp: Comparison; timeline: Comparison[]; base: number } | null>(null);
  const [swipe, setSwipe] = useState(50);
  const [shown, setShown] = useState<Set<Zone>>(new Set(['crossing', 'edge', 'alignment', 'inside', 'outside']));

  const sorted = useMemo(() => [...items].sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : 0)), [items]);
  const current = sorted[sorted.length - 1];

  const setParam = <K extends keyof EncroachmentParams>(k: K, v: string) => {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) setParams(p => ({ ...p, [k]: n }));
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setItems([]);
    setResult(null);
    setOutline([]);
    onOutput(null);
  };

  const addFiles = async (files: File[]) => {
    setBusy('files');
    try {
      const added: ImageItem[] = [];
      for (const file of files) {
        const d = dateFromFilename(file.name);
        const item: ImageItem = { id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`, file, label: file.name.replace(/\.[^.]+$/, ''), date: d ? iso(d) : '' };
        if (mode === 'geo') {
          if (!/\.tiff?$/i.test(file.name)) throw new Error(`${file.name}: use GeoTIFFs here, or switch to “Photos” for JPG/PNG.`);
          item.raster = await openGeoTiff(file);
        } else item.photo = await decodePhoto(file);
        added.push(item);
      }
      setItems(list => [...list, ...added]);
      setResult(null);
      if (mode === 'photo') setOutline([]);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not read the images.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const loadBoundary = async (file: File) => {
    try {
      const { fc, format, warnings } = await parseSurveyFile(file, true);
      const m = measureSurvey(file.name, format, fc, warnings);
      const area = m.features.reduce((a, f) => a + (f.kind === 'Polygon' && f.area ? f.area : 0), 0);
      const polys = m.features.filter(f => f.kind === 'Polygon');
      const b = makeBoundary(polys.length === 1 ? polys[0].name : file.name, fc, area);
      if (!b) throw new Error(`${file.name} has no polygon to use as the property boundary.`);
      onBoundary(b);
      setResult(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
    }
  };

  const loadSample = async () => {
    setBusy('sample');
    try {
      setMode('geo');
      const bFile = await fetchSample('samples/plot_boundary_synthetic.geojson', 'application/geo+json');
      await loadBoundary(bFile);
      const files = await Promise.all(SAMPLE_DATES.map(d => fetchSample(`samples/plot_${d}_synthetic.tif`)));
      const list: ImageItem[] = [];
      for (let i = 0; i < files.length; i++) list.push({ id: `s${i}`, file: files[i], label: `Plot ${SAMPLE_DATES[i].slice(0, 4)}`, date: SAMPLE_DATES[i], raster: await openGeoTiff(files[i]) });
      setItems(list);
      setResult(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // Photo mode: the outline is traced in the grid of the current (latest) photo.
  const photoGrid = useMemo(() => {
    if (mode !== 'photo' || !current?.photo) return null;
    const s = Math.min(1, 1200 / Math.max(current.photo.width, current.photo.height));
    return { width: Math.max(1, Math.round(current.photo.width * s)), height: Math.max(1, Math.round(current.photo.height * s)) };
  }, [mode, current]);
  const photoPreview = useMemo(() => {
    if (!photoGrid || !current?.photo) return null;
    const st = preparePhotoStack(
      [
        { label: 'x', date: null, ...current.photo },
        { label: 'y', date: null, ...current.photo },
      ],
      [[0, 0], [1, 0], [1, 1]],
      null,
    );
    return layerRgba(st, 1, false);
  }, [photoGrid, current]);

  const run = async (base = 0) => {
    if (sorted.length < 2) {
      notify('Add at least two images of the property from different dates.', 'error');
      return;
    }
    setBusy('run');
    try {
      const layerInfo = sorted.map(i => ({ label: i.date ? `${i.label} (${i.date})` : i.label, date: i.date ? new Date(i.date) : null }));
      let stack: Stack;
      if (mode === 'geo') {
        if (!boundary) throw new Error('Set the property boundary first: load it here, or draw it in Land survey and use it as the analysis boundary.');
        stack = await prepareGeoStack(sorted.map((it, i) => ({ raster: it.raster!, ...layerInfo[i] })), boundary, buffer);
      } else {
        const gw = Number(groundWidth);
        stack = preparePhotoStack(sorted.map((it, i) => ({ ...layerInfo[i], ...it.photo! })), outline, groundWidth.trim() && Number.isFinite(gw) && gw > 0 ? gw : null);
      }
      const last = stack.layers.length - 1;
      const cmp = compareLayers(stack, Math.min(base, last - 1), last, params);
      const timeline = stack.layers.slice(0, last).map((_, i) => (i === Math.min(base, last - 1) ? cmp : compareLayers(stack, i, last, params)));
      setResult({ stack, cmp, timeline, base: Math.min(base, last - 1) });
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The comparison failed.', 'error');
      setResult(null);
      onOutput(null);
    } finally {
      setBusy(null);
    }
  };

  // Re-run when the boundary changes after a result.
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result && mode === 'geo') run(result.base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const views = useMemo(() => {
    if (!result) return null;
    const { stack, cmp, base } = result;
    return {
      past: layerRgba(stack, base, true),
      now: layerRgba(stack, stack.layers.length - 1, true),
      changes: changeRgba(cmp, stack.width * stack.height, shown),
    };
  }, [result, shown]);

  const latLngBounds = useMemo((): [[number, number], [number, number]] | null => {
    const meta = result?.stack.meta;
    const inv = meta && unprojector(meta);
    if (!meta?.bbox || !inv) return null;
    const [x0, y0, x1, y1] = meta.bbox;
    const cs = [inv(x0, y0), inv(x1, y0), inv(x0, y1), inv(x1, y1)];
    return [
      [Math.min(...cs.map(c => c[1])), Math.min(...cs.map(c => c[0]))],
      [Math.max(...cs.map(c => c[1])), Math.max(...cs.map(c => c[0]))],
    ];
  }, [result]);

  useEffect(() => {
    if (!result || !views) return;
    const { stack, cmp, timeline } = result;
    onOutput({
      tool: 'residential',
      name: `${cmp.from} → ${cmp.to}`,
      markdown: encroachmentMarkdown(stack, cmp, timeline, params),
      map: latLngBounds
        ? {
            bounds: latLngBounds,
            image: mapImage(changeRgba(cmp, stack.width * stack.height, new Set(ZONE_ORDER)), stack.width, stack.height, latLngBounds, 'Changes since the earlier image', ZONE_ORDER.map(z => ({ color: `rgb(${ZONES[z].color.join(',')})`, label: ZONES[z].label }))),
          }
        : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const exportPatches = () => {
    if (!result?.stack.meta) return;
    const { stack, cmp } = result;
    const labels = labelPatches(stack.width, stack.height, k => cmp.classes[k] === 1 || cmp.classes[k] === 2);
    const stats = patchAreas(labels, stack.width, () => (stack.cellM ?? 1) ** 2);
    const out = patchesToGeoJson(labels, stats, stack.meta, stack, (id, a) => ({ patch: id, area_m2: Math.round(a * 100) / 100, note: 'change crossing or along the inside of the property boundary' }));
    if (!out || !out.fc.features.length) {
      notify('No crossing or edge changes to export.');
      return;
    }
    downloadText(JSON.stringify(out.fc), `plot_changes_${cmp.from.replace(/\W+/g, '_')}_to_${cmp.to.replace(/\W+/g, '_')}.geojson`, 'application/geo+json');
  };

  const onTrace = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!photoGrid) return;
    const b = e.currentTarget.getBoundingClientRect();
    setOutline(o => [...o, [((e.clientX - b.left) / b.width) * photoGrid.width, ((e.clientY - b.top) / b.height) * photoGrid.height]]);
    setResult(null);
  };

  const s = result?.stack;
  const cmp = result?.cmp;
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
          <FileDrop id="plot-boundary" compact label="Property boundary" accept=".geojson,.json,.kml,.gpx,.zip,.csv" hint="GeoJSON · KML · GPX · CSV · zipped Shapefile" loaded={boundary?.name} onFile={loadBoundary} />
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
                    {it.raster
                      ? `${it.raster.meta.width} × ${it.raster.meta.height} px, ${it.raster.meta.bands} band${it.raster.meta.bands === 1 ? '' : 's'}${it.raster.meta.epsg ? `, EPSG:${it.raster.meta.epsg}` : ''}`
                      : it.photo
                        ? `${it.photo.width} × ${it.photo.height} px`
                        : ''}
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

      {mode === 'photo' && photoGrid && photoPreview && (
        <div className="sub-panel">
          <div className="eyebrow">Trace your plot on the current image · {outline.length} corner{outline.length === 1 ? '' : 's'}</div>
          <div className="trace-wrap">
            <Canvas rgba={photoPreview} width={photoGrid.width} height={photoGrid.height} className="raster-canvas smooth" />
            <svg className="trace-svg" viewBox={`0 0 ${photoGrid.width} ${photoGrid.height}`} preserveAspectRatio="none" onClick={onTrace} role="img" aria-label="Click corners of your plot">
              {outline.length > 1 && <polygon points={outline.map(p => p.join(',')).join(' ')} fill="rgba(255,214,0,0.15)" stroke="#ffd600" strokeWidth={Math.max(1, photoGrid.width / 400)} />}
              {outline.map((p, i) => (
                <circle key={i} cx={p[0]} cy={p[1]} r={Math.max(2, photoGrid.width / 200)} fill="#ffd600" />
              ))}
            </svg>
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

      {result && s && cmp && views && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Crossing the boundary" value={`${crossing.length} patch${crossing.length === 1 ? '' : 'es'} · ${areaText(crossing.reduce((a, x) => a + x.areaInside, 0), s)} inside`} tone={crossing.length ? 'bad' : 'good'} />
            <Stat label="Deepest crossing" value={crossing.length ? `${fmt(Math.max(...crossing.map(x => x.depthInside)), 3)} ${s.cellM ? 'm' : 'px'}` : '—'} />
            <Stat label="Changed inside the plot" value={`${areaText(cmp.changedInside, s)} (${cmp.propertyArea ? ((cmp.changedInside / cmp.propertyArea) * 100).toFixed(1) : '—'} %)`} />
            <Stat label="Plot area (grid)" value={areaText(cmp.propertyArea, s)} />
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
              <Canvas rgba={views.now} width={s.width} height={s.height} className="swipe-layer" />
              <div className="swipe-top" style={{ clipPath: `inset(0 ${100 - swipe}% 0 0)` }}>
                <Canvas rgba={views.past} width={s.width} height={s.height} className="swipe-layer" />
              </div>
              <Canvas rgba={views.changes} width={s.width} height={s.height} className="swipe-layer swipe-changes" />
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
                  <i className="class-swatch" style={{ background: `rgb(${ZONES[z].color.join(',')})` }} /> {ZONES[z].label} ({areaText(cmp.byZone[z], s)})
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
                          <i className="class-swatch" style={{ background: `rgb(${ZONES[p.zone].color.join(',')})` }} /> {ZONES[p.zone].label}
                        </td>
                        <td className="num">{areaText(p.areaInside, s)}</td>
                        <td className="num">{p.areaJoinedInside ? areaText(p.areaJoinedInside, s) : '—'}</td>
                        <td className="num">{p.depthInside ? `${fmt(p.depthInside, 3)} ${s.cellM ? 'm' : 'px'}` : '—'}</td>
                        <td className="num">{areaText(p.area, s)}</td>
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
            {s.meta && (
              <button type="button" id="plot-export" className="btn btn-small push-right" onClick={exportPatches}>
                Export boundary changes (GeoJSON)
              </button>
            )}
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
