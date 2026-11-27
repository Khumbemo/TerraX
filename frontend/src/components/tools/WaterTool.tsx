// Surface water and floods (backend: tools/water.py, processing/water.py, processing/waterbodies.py): a water index
// from optical images or Sentinel-1 backscatter, one date, before/after or a dated series (water occurrence), with an
// automatic (Otsu) threshold, an inventory of water bodies and, optically, turbidity (NDTI) and chlorophyll (NDCI) indices.
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
type Dates = 'one' | 'many';
type Role = 'green' | 'red' | 'nir' | 'swir1' | 'rededge';

const ROLE_LABEL: Record<Role, string> = {
  green: 'Green',
  red: 'Red',
  nir: 'NIR',
  swir1: 'SWIR1',
  rededge: 'Red edge',
};
const ROLE_HINT: Record<Role, string> = {
  green: 'Needed for MNDWI / NDWI and NDTI',
  red: 'For the turbidity index (NDTI) and NDCI',
  nir: 'NDWI when there is no SWIR1 band',
  swir1: 'MNDWI (better against built-up land)',
  rededge: 'About 705 nm (Sentinel-2 B5), for the chlorophyll index (NDCI)',
};
const LAKES_SAMPLE = 'lakes_6band_synthetic.tif';
const RESERVOIR_SAMPLES = ['2023-01-15', '2023-03-12', '2023-05-14', '2023-07-16', '2023-09-10', '2023-11-12'].map(d => `reservoir_mndwi_${d}_synthetic.tif`);
const AXIS = {
  stroke: '#4a6580',
  fontSize: 11,
  fontFamily: 'Space Mono, monospace',
};

interface BodyRow {
  id: number;
  area_ha: number;
  perimeter_m: number;
  shore_dev: number | null;
  lon: number | null;
  lat: number | null;
  size_class: string;
  truncated: boolean;
  [extra: string]: number | string | boolean | null;
}

interface Bodies {
  count: number;
  ha: number;
  largestHa: number;
  truncated: number;
  removed: number;
  sizes: { label: string; count: number; ha: number }[];
  top: BodyRow[];
  columns: { key: string; label: string }[];
}

interface QualityStat {
  pixels: number;
  p10: number;
  median: number;
  p90: number;
}

interface QualityImage {
  url: string;
  min: number;
  max: number;
  colors: string[];
}

interface Quality {
  source: string;
  ndti: QualityStat;
  ndtiImage: QualityImage | null;
  ndci?: QualityStat | null;
  ndciImage?: QualityImage | null;
}

interface SeriesDate {
  date: string;
  file: string;
  observedPct: number;
  waterPixels: number;
  waterHa: number | null;
  waterSharePct: number | null;
}

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
  result: {
    mode: Mode;
    series?: boolean;
    index: string;
    threshold: number;
    unit: string;
    width: number;
    height: number;
    summary?: { observedPixels: number; classes: WaterClass[] };
    classes?: WaterClass[];
    dates: string[] | SeriesDate[];
    notes: string[];
    hand?: { pixels: number; ha: number | null; handMax: number } | null;
    bodies: Bodies | null;
    quality?: Quality | null;
    minObs?: number;
    almostPct?: number;
  };
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

/** The red-edge band (about 705 nm), recognised from its name. */
function redEdgeOf(meta: RasterMeta): number | undefined {
  const i = meta.bandNames.findIndex(n => /red.?edge|\bB0?5\b|705/i.test(n));
  return i >= 0 ? i : undefined;
}

function Ramp({ image, label, low, high }: { image: QualityImage; label: string; low: string; high: string }) {
  return (
    <figcaption>
      <div
        className="legend-bar"
        style={{
          background: `linear-gradient(90deg, ${image.colors.join(', ')})`,
        }}
      />
      <div className="legend-labels">
        <span>
          {fmt(image.min, 3)} ({low})
        </span>
        <span>{label} over interior water</span>
        <span>
          {fmt(image.max, 3)} ({high})
        </span>
      </div>
    </figcaption>
  );
}

function BodiesTable({ bodies, units }: { bodies: Bodies; units: ReturnType<typeof usePrefs>['units'] }) {
  const cell = (v: number | string | boolean | null | undefined, digits = 3) => (v === null || v === undefined ? '—' : typeof v === 'number' ? fmt(v, digits) : String(v));
  return (
    <div className="sub-panel" id="water-bodies">
      <div className="eyebrow">Water bodies</div>
      <div className="stat-grid">
        <Stat label="Water bodies" value={bodies.count.toLocaleString()} />
        <Stat label="Total area" value={areaHa(bodies.ha, units)} />
        <Stat label="Largest" value={areaHa(bodies.largestHa, units)} />
        {bodies.truncated > 0 && <Stat label="Cut by edge or cloud" value={bodies.truncated.toLocaleString()} />}
      </div>
      <div className="tabular-view">
        <table id="water-sizes">
          <thead>
            <tr>
              <th>Size</th>
              <th>Bodies</th>
              <th>Area</th>
            </tr>
          </thead>
          <tbody>
            {bodies.sizes.map(z => (
              <tr key={z.label}>
                <td>{z.label}</td>
                <td>{z.count.toLocaleString()}</td>
                <td>{areaHa(z.ha, units)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bodies.top.length > 0 && (
        <div className="tabular-view">
          <table id="water-bodies-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Area</th>
                <th title="Along the pixel edges: longer than the real shoreline">Perimeter (km)</th>
                <th title="P / (2√(πA)), Hutchinson 1957: 1 for a circle">Shore dev.</th>
                <th>Lat, lon</th>
                {bodies.columns.map(c => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodies.top.map(r => (
                <tr key={r.id}>
                  <td title={r.truncated ? 'Cut by the image edge, the boundary or cloud: only the visible part is measured' : undefined}>
                    {r.id}
                    {r.truncated ? '*' : ''}
                  </td>
                  <td>{areaHa(r.area_ha, units)}</td>
                  <td>{fmt(r.perimeter_m / 1000, 3)}</td>
                  <td>{cell(r.shore_dev)}</td>
                  <td>{r.lat === null || r.lon === null ? '—' : `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`}</td>
                  {bodies.columns.map(c => (
                    <td key={c.key}>{cell(r[c.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint">
        {bodies.top.length < bodies.count ? `The ${bodies.top.length} largest are listed; the CSV and GeoJSON exports hold every body. ` : ''}
        {bodies.truncated > 0 ? '* cut by the image edge, the boundary or cloud: only the visible part is measured. ' : ''}
        Perimeters follow pixel edges, so they run about 27 % longer than a smooth shore.
      </p>
    </div>
  );
}

export default function WaterTool({ onOutput, boundary }: { onOutput: (out: ToolOutput | null) => void; boundary: Boundary | null }) {
  const notify = useToast();
  const { units } = usePrefs();
  const job = useJob();
  const busy = job.busy;
  const files = useUpload<RasterMeta>(['raster'], 'a GeoTIFF raster TerraX can read');
  const [mode, setMode] = useState<Mode>('optical');
  const [dates, setDates] = useState<Dates>('one');
  const [a, setA] = useState<StoredFile<RasterMeta> | null>(null);
  const [b, setB] = useState<StoredFile<RasterMeta> | null>(null);
  const [series, setSeries] = useState<StoredFile<RasterMeta>[]>([]);
  const [dem, setDem] = useState<StoredFile<RasterMeta> | null>(null);
  const [handMax, setHandMax] = useState('15');
  const [streamKm2, setStreamKm2] = useState('0.5');
  const [roles, setRoles] = useState<Partial<Record<Role, number>>>({});
  const [vv, setVv] = useState('1');
  const [dropDb, setDropDb] = useState('3');
  const [threshold, setThreshold] = useState('');
  const [mmuHa, setMmuHa] = useState('0');
  const [minObs, setMinObs] = useState('3');
  const [almostPct, setAlmostPct] = useState('90');
  const [view, setView] = useState<'classes' | 'ndti' | 'ndci'>('classes');
  const [out, setOut] = useState<WaterJob | null>(null);
  const fail = (m: string) => notify(m, 'error');

  const reset = () => {
    job.cancel();
    setA(null);
    setB(null);
    setSeries([]);
    setOut(null);
    onOutput(null);
  };
  const switchMode = (m: Mode) => {
    reset();
    setMode(m);
  };
  const switchDates = (d: Dates) => {
    reset();
    setDates(d);
  };

  const guessRoles = (meta: RasterMeta) => {
    const g = meta.guessedBands;
    setRoles({
      green: g.green,
      red: g.red,
      nir: g.nir,
      swir1: g.swir1,
      rededge: redEdgeOf(meta),
    });
  };

  const load = async (file: File | string, which: 'a' | 'b' | 'dem') => {
    const f = await job.run(which, signal => (typeof file === 'string' ? files.sample(file) : files.upload(file, signal)), fail);
    if (!f) return null;
    (which === 'a' ? setA : which === 'b' ? setB : setDem)(f);
    if (which === 'a') guessRoles(f.meta);
    setOut(null);
    return f;
  };

  const loadSeries = async (picked: (File | string)[]) => {
    const list = await job.run(
      'series',
      async signal => {
        const got: StoredFile<RasterMeta>[] = [];
        for (const p of picked) got.push(typeof p === 'string' ? await files.sample(p) : await files.upload(p, signal));
        return got;
      },
      fail,
    );
    if (!list) return null;
    if (list.length < 3) {
      fail('Water over time needs at least three images of different dates (select several files at once).');
      return null;
    }
    setSeries(list);
    guessRoles(list[0].meta);
    setOut(null);
    return list;
  };

  const run = async (override?: { a?: StoredFile<RasterMeta>; series?: StoredFile<RasterMeta>[]; roles?: Partial<Record<Role, number>> }) => {
    const first = override?.a ?? a;
    const list = override?.series ?? series;
    const many = dates === 'many' || Boolean(override?.series);
    if (many ? list.length < 3 : !first) return;
    const thr = threshold.trim() === '' ? 'auto' : Number(threshold);
    if (thr !== 'auto' && !Number.isFinite(thr)) return fail('Set the threshold as a number, or leave it empty for automatic.');
    const mmu = Number(mmuHa);
    if (!(mmu >= 0 && mmu <= 1000)) return fail('Set the smallest water body between 0 and 1,000 ha.');
    const params: Record<string, unknown> = {
      mode,
      threshold: thr,
      boundary,
      mmuHa: mmu,
    };
    if (dem) {
      const hm = Number(handMax);
      const sk = Number(streamKm2);
      if (!(hm >= 0.5 && hm <= 500)) return fail('Set the HAND limit between 0.5 and 500 m.');
      if (!(sk > 0 && sk <= 100000)) return fail('Set the channel threshold as a positive area in km².');
      params.handMax = hm;
      params.streamKm2 = sk;
    }
    if (mode === 'optical') {
      params.bands = Object.fromEntries(Object.entries(override?.roles ?? roles).filter(([, v]) => v !== undefined));
      const qa = qaOf((many ? list[0] : first!).meta);
      if (qa) params.qa = qa;
    } else {
      params.band = Math.max(0, Number(vv) - 1);
      params.dropDb = Number(dropDb);
    }
    let inputs: Record<string, unknown>;
    if (many) {
      const mo = Number(minObs);
      const ap = Number(almostPct);
      if (!(Number.isInteger(mo) && mo >= 1 && mo <= list.length)) return fail(`Set the minimum observations per pixel between 1 and ${list.length}.`);
      if (!(ap >= 50 && ap <= 100)) return fail('Set “almost always” between 50 and 100 %.');
      params.minObs = mo;
      params.almostPct = ap;
      inputs = { images: list.map(f => f.id), dem: dem?.id };
    } else {
      inputs = { a: first!.id, b: b?.id, dem: dem?.id };
    }
    const r = await job.run(
      'run',
      (signal, onProgress) => runJob<WaterJob>('water', inputs, params, { signal, onProgress }),
      m => {
        fail(m);
        setOut(null);
        onOutput(null);
      },
    );
    if (!r) return;
    setOut(r);
    setView('classes');
    const q = r.result.quality;
    const figures = [
      ...(r.map.image ? [{ title: r.map.image.label, url: r.map.image.url }] : []),
      ...(q?.ndtiImage ? [{ title: 'Turbidity index (NDTI) over water', url: q.ndtiImage.url }] : []),
      ...(q?.ndciImage
        ? [
            {
              title: 'Chlorophyll index (NDCI) over water',
              url: q.ndciImage.url,
            },
          ]
        : []),
    ];
    onOutput({
      tool: 'water',
      name: r.name,
      markdown: r.markdown,
      ...(r.map.image ? { map: r.map, figures } : {}),
    });
  };

  const trySample = async () => {
    if (dates === 'many') {
      const list = await loadSeries(RESERVOIR_SAMPLES);
      if (list) await run({ series: list });
      return;
    }
    const f = await load(LAKES_SAMPLE, 'a');
    if (!f) return;
    const sampleRoles = { green: 1, red: 2, nir: 3, swir1: 4, rededge: 5 };
    setRoles(sampleRoles);
    await run({ a: f, roles: sampleRoles });
  };

  const res = out?.result;
  const classes = res?.series ? (res.classes ?? []) : (res?.summary?.classes ?? []);
  const cls = (label: string) => classes.find(c => c.label === label);
  const area = (c: Pick<WaterClass, 'pixels' | 'ha'> | null | undefined) => (!c ? '—' : c.ha === null ? `${c.pixels.toLocaleString()} px` : areaHa(c.ha, units));
  const bandSource = dates === 'many' ? series[0] : a;
  const bandOptions = bandSource ? Array.from({ length: bandSource.meta.bands }, (_, i) => i) : [];
  const shownRoles: Role[] = dates === 'many' ? ['green', 'nir', 'swir1'] : ['green', 'red', 'nir', 'swir1', 'rededge'];
  const q = res?.quality;
  const seriesDates = res?.series ? (res.dates as SeriesDate[]) : [];
  const ready = dates === 'many' ? series.length >= 3 : Boolean(a);
  const picture = view === 'ndti' && q?.ndtiImage ? q.ndtiImage.url : view === 'ndci' && q?.ndciImage ? q.ndciImage.url : out?.map.image?.url;

  return (
    <div className="tool-body">
      <div className="mode-switch" role="radiogroup" aria-label="Method">
        <button
          type="button"
          id="water-optical"
          role="radio"
          aria-checked={mode === 'optical'}
          className={mode === 'optical' ? 'active' : ''}
          onClick={() => switchMode('optical')}
        >
          Optical (MNDWI / NDWI)
        </button>
        <button type="button" id="water-radar" role="radio" aria-checked={mode === 'radar'} className={mode === 'radar' ? 'active' : ''} onClick={() => switchMode('radar')}>
          Radar (Sentinel-1, through cloud)
        </button>
      </div>
      <div className="mode-switch" role="radiogroup" aria-label="Dates">
        <button type="button" id="water-dates-one" role="radio" aria-checked={dates === 'one'} className={dates === 'one' ? 'active' : ''} onClick={() => switchDates('one')}>
          One or two dates
        </button>
        <button type="button" id="water-dates-many" role="radio" aria-checked={dates === 'many'} className={dates === 'many' ? 'active' : ''} onClick={() => switchDates('many')}>
          Water over time (many dates)
        </button>
      </div>
      <p className="tool-intro">
        {dates === 'many'
          ? 'Upload three or more images of the same area on one grid, with the date in each file name (2024-03-15 or 20240315). TerraX uses one threshold for every date and maps how often each pixel was water when it could be seen (water occurrence), with the water seen on each date.'
          : mode === 'optical'
            ? 'Upload a multispectral image (Sentinel-2, Landsat), or two of the same area on the same grid to map new water. MNDWI is used with a SWIR1 band, NDWI otherwise; with a red band TerraX also gives a turbidity index, and with a red-edge band a chlorophyll index. Every run lists the water bodies it finds.'
            : 'Upload Sentinel-1 backscatter (VV) from before and during a flood on the same grid, or one date for open water. Radar sees through the cloud that usually covers floods. Use the radar tool’s search to download dates that line up.'}
      </p>
      <div className="drop-pair">
        {dates === 'many' ? (
          <FileDrop
            id="water-series"
            compact
            label="Images from several dates"
            accept=".tif,.tiff"
            hint="GeoTIFFs · same grid · date in the file name"
            busy={busy === 'series'}
            loaded={series.length ? `${series.length} images` : null}
            onFile={f => loadSeries([f])}
            onFiles={loadSeries}
          />
        ) : (
          <>
            <FileDrop id="water-a" compact label="Before (or the only image)" accept=".tif,.tiff" hint="GeoTIFF" busy={busy === 'a'} loaded={a?.name} onFile={f => load(f, 'a')} />
            <FileDrop
              id="water-b"
              compact
              label="After (optional)"
              accept=".tif,.tiff"
              hint="GeoTIFF · same grid"
              busy={busy === 'b'}
              loaded={b?.name}
              onFile={f => load(f, 'b')}
            />
          </>
        )}
        <FileDrop
          id="water-dem"
          compact
          label="Elevation (optional)"
          accept=".tif,.tiff"
          hint="DEM · removes water high above streams (HAND)"
          busy={busy === 'dem'}
          loaded={dem?.name}
          onFile={f => load(f, 'dem')}
        />
      </div>
      {mode === 'optical' && (
        <div className="button-row">
          <button type="button" id="water-sample" className="btn btn-small" disabled={Boolean(busy)} onClick={trySample}>
            {dates === 'many' ? 'Try synthetic 6-date reservoir' : 'Try synthetic lakes (6 bands)'}
          </button>
        </div>
      )}
      <div className="param-row">
        {mode === 'optical' && bandSource && bandSource.meta.bands > 1 && (
          <div className="ndvi-controls">
            {shownRoles.map(role => (
              <label key={role} className="inline-select" title={ROLE_HINT[role]}>
                <span>{ROLE_LABEL[role]}</span>
                <select
                  id={`water-${role}`}
                  value={roles[role] ?? ''}
                  onChange={e =>
                    setRoles({
                      ...roles,
                      [role]: e.target.value === '' ? undefined : Number(e.target.value),
                    })
                  }
                >
                  <option value="">{role === 'green' ? '—' : 'none'}</option>
                  {bandOptions.map(i => (
                    <option key={i} value={i}>
                      {bandSource.meta.bandNames[i] ?? `Band ${i + 1}`}
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
            {dates === 'one' && (
              <label className="param" title="With two dates, new water must also have lost this much backscatter">
                <span>Drop (dB)</span>
                <input id="water-drop" type="number" min="0.5" max="20" step="0.5" value={dropDb} onChange={e => setDropDb(e.target.value)} />
              </label>
            )}
          </>
        )}
        {dem && (
          <>
            <label
              className="param"
              title="Water standing more than this above its nearest channel is removed (terrain shadow, steep slopes). Set it from the flood heights expected locally."
            >
              <span>HAND max (m)</span>
              <input id="water-hand" type="number" min="0.5" max="500" step="1" value={handMax} onChange={e => setHandMax(e.target.value)} />
            </label>
            <label className="param" title="A channel starts where at least this area drains to a cell. Smaller values make more, smaller channels.">
              <span>Channel from (km²)</span>
              <input id="water-stream" type="number" min="0.0001" step="0.1" value={streamKm2} onChange={e => setStreamKm2(e.target.value)} />
            </label>
          </>
        )}
        {dates === 'many' && (
          <>
            <label className="param" title="Pixels seen clearly on fewer dates than this are left out">
              <span>Min. clear dates</span>
              <input id="water-min-obs" type="number" min="1" step="1" value={minObs} onChange={e => setMinObs(e.target.value)} />
            </label>
            <label className="param" title="Water in at least this share of clear observations counts as water almost always (a setting, not a calibrated value)">
              <span>Almost always (%)</span>
              <input id="water-almost" type="number" min="50" max="100" step="5" value={almostPct} onChange={e => setAlmostPct(e.target.value)} />
            </label>
          </>
        )}
        <label className="param" title="Water bodies smaller than this are left out of the inventory (0 = keep all)">
          <span>Min. water body (ha)</span>
          <input id="water-mmu" type="number" min="0" max="1000" step="0.1" value={mmuHa} onChange={e => setMmuHa(e.target.value)} />
        </label>
        <label
          className="param"
          title={mode === 'optical' ? 'Water if the index is at least this; empty = automatic (Otsu)' : 'Water if VV (dB) is at most this; empty = automatic (Otsu)'}
        >
          <span>Threshold</span>
          <input id="water-threshold" type="number" step={mode === 'optical' ? '0.05' : '0.5'} placeholder="auto" value={threshold} onChange={e => setThreshold(e.target.value)} />
        </label>
        <button type="button" id="water-run" className="btn btn-primary push-right" disabled={!ready || Boolean(busy)} onClick={() => run()}>
          {busy === 'run' ? 'Mapping…' : dates === 'many' ? 'Map water over time' : b ? 'Map water change' : 'Map water'}
        </button>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {out && res && (
        <div className="result-block">
          <div className="stat-grid">
            {res.series ? (
              <>
                <Stat label={`Water almost always (≥ ${fmt(res.almostPct ?? 90, 3)} %)`} value={area(classes.find(c => c.id === 3))} />
                <Stat label="Water at times" value={area(classes.find(c => c.id === 2))} />
                <Stat label="Never water" value={area(classes.find(c => c.id === 1))} />
              </>
            ) : classes.length > 2 ? (
              <>
                <Stat label="New water (flood)" value={area(cls('New water (flood)'))} tone="bad" />
                <Stat label="Water both dates" value={area(cls('Water both dates'))} />
                <Stat label="Water gone" value={area(cls('Water gone'))} />
              </>
            ) : (
              <Stat label="Water" value={area(cls('Water'))} />
            )}
            {res.hand && <Stat label={`Removed by HAND (> ${fmt(res.hand.handMax, 3)} m)`} value={area(res.hand)} />}
            <Stat label="Threshold" value={`${res.index} ${res.mode === 'optical' ? '≥' : '≤'} ${fmt(res.threshold, 3)}${res.unit ? ` ${res.unit}` : ''}`} />
          </div>
          {q && (
            <div className="stat-grid" id="water-quality">
              <Stat label="Turbidity index NDTI (median)" value={`${fmt(q.ndti.median, 3)} (${fmt(q.ndti.p10, 2)} to ${fmt(q.ndti.p90, 2)})`} />
              {q.ndci && <Stat label="Chlorophyll index NDCI (median)" value={`${fmt(q.ndci.median, 3)} (${fmt(q.ndci.p10, 2)} to ${fmt(q.ndci.p90, 2)})`} />}
            </div>
          )}
          {q && (
            <p className="field-hint">
              Relative indicators over interior water (10th to 90th percentile in brackets), for comparing water bodies and dates. They are not concentrations: converting them to
              turbidity (NTU) or chlorophyll-a (µg/L) needs water samples taken near the image date.
            </p>
          )}
          {out.map.image && picture && (
            <figure className="raster-figure">
              {q && (
                <div className="mode-switch" role="radiogroup" aria-label="Map layer">
                  <button type="button" role="radio" aria-checked={view === 'classes'} className={view === 'classes' ? 'active' : ''} onClick={() => setView('classes')}>
                    Water
                  </button>
                  {q.ndtiImage && (
                    <button
                      type="button"
                      id="water-view-ndti"
                      role="radio"
                      aria-checked={view === 'ndti'}
                      className={view === 'ndti' ? 'active' : ''}
                      onClick={() => setView('ndti')}
                    >
                      Turbidity (NDTI)
                    </button>
                  )}
                  {q.ndciImage && (
                    <button
                      type="button"
                      id="water-view-ndci"
                      role="radio"
                      aria-checked={view === 'ndci'}
                      className={view === 'ndci' ? 'active' : ''}
                      onClick={() => setView('ndci')}
                    >
                      Chlorophyll (NDCI)
                    </button>
                  )}
                </div>
              )}
              <ArtifactImage
                url={picture}
                width={res.width}
                height={res.height}
                label={view === 'classes' ? out.map.image.label : view === 'ndti' ? 'Turbidity index (NDTI)' : 'Chlorophyll index (NDCI)'}
              />
              {view === 'ndti' && q?.ndtiImage ? (
                <Ramp image={q.ndtiImage} label="NDTI" low="clearer" high="more turbid" />
              ) : view === 'ndci' && q?.ndciImage ? (
                <Ramp image={q.ndciImage} label="NDCI" low="less chlorophyll" high="more chlorophyll" />
              ) : (
                <figcaption className="legend-row">
                  {out.legend.map(c => (
                    <span key={c.id}>
                      <i className="class-swatch" style={{ background: `rgb(${c.color.join(',')})` }} /> {c.label}
                    </span>
                  ))}
                </figcaption>
              )}
            </figure>
          )}
          {res.series && seriesDates.length > 0 && (
            <div className="sub-panel" id="water-series-dates">
              <div className="eyebrow">Water on each date</div>
              <div className="render-window">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={seriesDates.map(d => ({
                      date: d.date,
                      share: d.waterSharePct,
                    }))}
                    margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#16283c" />
                    <XAxis dataKey="date" {...AXIS} />
                    <YAxis {...AXIS} width={48} tickFormatter={v => `${fmt(Number(v), 3)} %`} />
                    <Tooltip
                      formatter={v => [`${fmt(Number(v), 3)} %`, 'Water share of what was seen']}
                      contentStyle={{
                        background: '#030814',
                        border: '1px solid #38bdf8',
                      }}
                    />
                    <Bar dataKey="share" fill="#38bdf8" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="tabular-view">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Seen</th>
                      <th>Water seen</th>
                      <th>Share of seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seriesDates.map(d => (
                      <tr key={d.date}>
                        <td title={d.file}>{d.date}</td>
                        <td>{fmt(d.observedPct, 3)} %</td>
                        <td>{d.waterHa === null ? `${d.waterPixels.toLocaleString()} px` : areaHa(d.waterHa, units)}</td>
                        <td>{d.waterSharePct === null ? '—' : `${fmt(d.waterSharePct, 3)} %`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint">Water seen on a cloudy date is only what was visible: compare dates with a similar share seen, or the share of what was seen.</p>
            </div>
          )}
          {res.bodies && <BodiesTable bodies={res.bodies} units={units} />}
          <div className="button-row">
            <span className="push-right">
              <Downloads idPrefix="water" items={out.downloads} />
            </span>
          </div>
          <Notes items={res.notes} />
        </div>
      )}
    </div>
  );
}
