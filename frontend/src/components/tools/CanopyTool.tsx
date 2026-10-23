import { useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { runJob, type Download, type RasterMeta, type ResultImage, type StoredFile } from '../../lib/api';
import type { LatLngBounds } from '../../lib/geo';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { useJob } from '../../lib/useJob';
import type { ToolOutput } from '../../lib/tools/registry';
import FileDrop from '../FileDrop';
import JobStatus from '../JobStatus';
import { ArtifactImage, Downloads, Notes, Stat, useUpload } from '../ToolKit';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
}

type Source = 'cloud' | 'chm' | 'dsm';

interface CanopyJob {
  name: string;
  source: string;
  markdown: string;
  notes: string[];
  layer: string;
  range: [number, number];
  colors: string[];
  width: number;
  height: number;
  canopy: {
    areaHa: number;
    threshold: number;
    cover: number;
    coverFao: number;
    height: { mean: number | null; median: number | null; q1: number | null; q3: number | null; p95: number | null; max: number | null };
    classes: { label: string; ha: number }[];
    /** Plot-calibrated AGB = a·TCH^b on plot-sized cells, with a Monte Carlo 95 % interval. */
    biomass?: { plots: number; a: number; b: number; looRmse: number; totalMg: number; meanMgHa: number | null; ci95Mg: [number, number]; carbonMg: number; co2eMg: number; cellSideM: number };
    trees: {
      count: number;
      perHa: number | null;
      minHeight: number;
      meanHeight: number | null;
      /** Ratio estimate from field plots (Cochran 1977, ch. 6), when plots were given. */
      calibrated?: { plots: number; fieldTrees: number; detectedInPlots: number; ratio: number; detectionRate: number | null; total: number; perHa: number | null; se: number | null; ci95: [number, number] | null };
    };
  };
  downloads: Download[];
  map: { bounds: LatLngBounds | null; image: ResultImage | null; geojson: FeatureCollection | null } | null;
}

const SAMPLE = 'lidar_forest_synthetic.laz';

export default function CanopyTool({ onOutput }: Props) {
  const notify = useToast();
  const job = useJob();
  // The plots upload has its own job: starting it must not cancel a model file still uploading on `job`.
  const plotJob = useJob();
  const busy = Boolean(job.busy || plotJob.busy);
  const clouds = useUpload(['pointcloud'], 'a LAS or LAZ point cloud');
  const rasters = useUpload<RasterMeta>(['raster'], 'a GeoTIFF elevation or height model');
  const plotFiles = useUpload(['vector'], 'field plots as polygons (GeoJSON, KML or a zipped shapefile)');
  const [plots, setPlots] = useState<StoredFile | null>(null);
  const [countField, setCountField] = useState('');
  const [agbField, setAgbField] = useState('');
  const [source, setSource] = useState<Source>('cloud');
  const [files, setFiles] = useState<Partial<Record<'cloud' | 'chm' | 'dsm' | 'dtm', StoredFile>>>({});
  const [cell, setCell] = useState('1');
  const [threshold, setThreshold] = useState('2');
  const [minTree, setMinTree] = useState('5');
  const [out, setOut] = useState<CanopyJob | null>(null);
  const fail = (m: string) => notify(m, 'error');

  const load = async (picked: File | string, slot: 'cloud' | 'chm' | 'dsm' | 'dtm') => {
    const up = slot === 'cloud' ? clouds : rasters;
    const f = await job.run('upload', signal => (typeof picked === 'string' ? up.sample(picked) : up.upload(picked, signal)), fail);
    if (!f) return null;
    const next = { ...files, [slot]: f };
    setFiles(next);
    setOut(null);
    onOutput(null);
    return next;
  };

  const run = async (src = source, fs = files) => {
    const inputs = src === 'cloud' ? { cloud: fs.cloud?.id } : src === 'chm' ? { chm: fs.chm?.id } : { dsm: fs.dsm?.id, dtm: fs.dtm?.id };
    if (Object.values(inputs).some(v => !v)) return fail(src === 'dsm' ? 'Add both the surface (DSM) and the terrain (DTM) model.' : 'Add the file first.');
    const params = { cell: Number(cell), threshold: Number(threshold), minTree: Number(minTree) };
    const withPlots = plots ? { ...inputs, plots: plots.id } : inputs;
    if (Object.values(params).some(v => !Number.isFinite(v) || v <= 0)) return fail('Cell size and heights must be positive numbers of metres.');
    const res = await job.run('run', (signal, onProgress) => runJob<CanopyJob>('canopy', withPlots, { ...params, ...(countField.trim() ? { countField: countField.trim() } : {}), ...(agbField.trim() ? { agbField: agbField.trim() } : {}) }, { signal, onProgress }), fail);
    if (!res) return;
    setOut(res);
    onOutput({ tool: 'canopy', name: res.name, markdown: res.markdown, map: res.map ?? undefined, summary: res.canopy, figures: [{ title: 'Canopy height', url: res.layer }] });
  };

  const c = out?.canopy;
  return (
    <div className="tool-body">
      <p className="tool-intro">
        Measure canopy height from airborne LiDAR (LAS/LAZ with ground points classified, ASPRS class 2), from a surface and a terrain model, or from a canopy height
        model you already have. TerraX reports canopy cover, the height distribution and individual tree tops.
      </p>
      <div className="param-row">
        <label className="param">
          <span>Input</span>
          <select id="canopy-source" value={source} onChange={e => setSource(e.target.value as Source)}>
            <option value="cloud">Point cloud (LAS/LAZ)</option>
            <option value="dsm">Surface + terrain models (DSM, DTM)</option>
            <option value="chm">Canopy height model (CHM)</option>
          </select>
        </label>
        {source === 'cloud' && (
          <label className="param">
            <span>Cell size (m)</span>
            <input id="canopy-cell" type="number" min="0.1" step="0.5" value={cell} onChange={e => setCell(e.target.value)} />
          </label>
        )}
        <label className="param" title="Cells at least this tall count as canopy.">
          <span>Canopy from (m)</span>
          <input id="canopy-threshold" type="number" min="0.1" step="0.5" value={threshold} onChange={e => setThreshold(e.target.value)} />
        </label>
        <label className="param" title="Tree tops lower than this are ignored.">
          <span>Trees from (m)</span>
          <input id="canopy-min-tree" type="number" min="0.5" step="0.5" value={minTree} onChange={e => setMinTree(e.target.value)} />
        </label>
      </div>
      {source === 'cloud' && (
        <FileDrop id="canopy-cloud" label="Point cloud" accept=".las,.laz" hint="LAS or LAZ · projected CRS · ground classified" busy={job.busy === 'upload'} loaded={files.cloud?.name} onFile={f => load(f, 'cloud')} />
      )}
      {source === 'chm' && <FileDrop id="canopy-chm" label="Canopy height model" accept=".tif,.tiff" hint="GeoTIFF · heights in metres" busy={job.busy === 'upload'} loaded={files.chm?.name} onFile={f => load(f, 'chm')} />}
      {source === 'dsm' && (
        <>
          <FileDrop id="canopy-dsm" label="Surface model (DSM)" accept=".tif,.tiff" hint="GeoTIFF · first-return or photogrammetric heights" busy={job.busy === 'upload'} loaded={files.dsm?.name} onFile={f => load(f, 'dsm')} />
          <FileDrop id="canopy-dtm" label="Terrain model (DTM)" accept=".tif,.tiff" hint="Same grid as the DSM" compact loaded={files.dtm?.name} onFile={f => load(f, 'dtm')} />
        </>
      )}
      <FileDrop
        id="canopy-plots"
        label="Field plots (optional)"
        accept=".geojson,.json,.kml,.zip"
        hint="Polygons with the trees counted (corrects the count) and/or the biomass measured in Mg/ha (fits biomass to canopy height) in each"
        compact
        busy={Boolean(plotJob.busy)}
        loaded={plots?.name}
        onFile={async f => {
          const up = await plotJob.run('plots', signal => plotFiles.upload(f, signal), fail);
          if (up) setPlots(up);
        }}
      />
      {plots && (
        <div className="param-row">
          <label className="param" title="The property with each plot's tree count; left empty, TerraX looks for trees, tree_count, field_count, count, stems or n.">
            <span>Count property</span>
            <input id="canopy-count-field" placeholder="trees" value={countField} onChange={e => setCountField(e.target.value)} />
          </label>
          <label className="param" title="The property with each plot's above-ground biomass in Mg/ha; left empty, TerraX looks for agb, agb_mg_ha, agb_t_ha, biomass, biomass_mg_ha or biomass_t_ha.">
            <span>Biomass property</span>
            <input id="canopy-agb-field" placeholder="agb" value={agbField} onChange={e => setAgbField(e.target.value)} />
          </label>
          <button type="button" className="btn btn-small" onClick={() => setPlots(null)}>
            Remove plots
          </button>
        </div>
      )}
      <div className="param-row">
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setSource('cloud');
              const fs = await load(SAMPLE, 'cloud');
              if (fs) await run('cloud', fs);
            }}
          >
            Try synthetic LiDAR
          </button>
          <button type="button" id="canopy-run" className="btn btn-primary" disabled={busy} onClick={() => run()}>
            {job.busy === 'run' ? 'Measuring…' : 'Measure canopy'}
          </button>
        </div>
      </div>
      <JobStatus job={job} onCancel={job.cancel} />

      {c && out && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label={`Canopy cover (≥ ${fmt(c.threshold, 3)} m)`} value={`${(c.cover * 100).toFixed(1)} %`} />
            <Stat label="Cover of trees ≥ 5 m" value={`${(c.coverFao * 100).toFixed(1)} %`} />
            <Stat label="Median canopy height" value={c.height.median === null ? '—' : `${fmt(c.height.median, 3)} m`} />
            <Stat label="95th percentile height" value={c.height.p95 === null ? '—' : `${fmt(c.height.p95, 3)} m`} />
            <Stat label="Tree tops" value={`${c.trees.count.toLocaleString()}${c.trees.perHa === null ? '' : ` (${fmt(c.trees.perHa, 3)}/ha)`}`} />
            {c.biomass && (
              <>
                <Stat
                  label={`Above-ground biomass (${c.biomass.plots} plots)`}
                  value={`${Math.round(c.biomass.totalMg).toLocaleString()} Mg${c.biomass.meanMgHa === null ? '' : ` (${fmt(c.biomass.meanMgHa, 3)} Mg/ha)`}; 95 % CI ${Math.round(c.biomass.ci95Mg[0]).toLocaleString()}–${Math.round(c.biomass.ci95Mg[1]).toLocaleString()}`}
                />
                <Stat label="Carbon / CO₂e" value={`${Math.round(c.biomass.carbonMg).toLocaleString()} Mg C / ${Math.round(c.biomass.co2eMg).toLocaleString()} Mg CO₂e`} />
              </>
            )}
            {c.trees.calibrated && (
              <Stat
                label={`Trees, calibrated by ${c.trees.calibrated.plots} plot${c.trees.calibrated.plots === 1 ? '' : 's'}`}
                value={`${Math.round(c.trees.calibrated.total).toLocaleString()}${c.trees.calibrated.ci95 ? ` (95 % CI ${Math.round(c.trees.calibrated.ci95[0]).toLocaleString()}–${Math.round(c.trees.calibrated.ci95[1]).toLocaleString()})` : ''}`}
              />
            )}
          </div>
          <figure className="raster-figure">
            <ArtifactImage url={out.layer} width={out.width} height={out.height} label="Canopy height" />
            <figcaption>
              <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${out.colors.join(', ')})` }} />
              <div className="legend-labels">
                <span>{fmt(out.range[0], 3)} m</span>
                <span>canopy height</span>
                <span>{fmt(out.range[1], 3)} m</span>
              </div>
            </figcaption>
          </figure>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Height class</th>
                  <th>Area</th>
                </tr>
              </thead>
              <tbody>
                {c.classes.map(k => (
                  <tr key={k.label}>
                    <td>{k.label}</td>
                    <td className="num">{fmt(k.ha, 4)} ha</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <Downloads idPrefix="canopy" items={out.downloads} />
          </div>
          <Notes items={out.notes} />
        </div>
      )}
    </div>
  );
}
