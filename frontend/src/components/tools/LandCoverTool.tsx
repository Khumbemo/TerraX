import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText, safeFilename } from '../../lib/download';
import { guessBandMap } from '../../lib/indices';
import { mapImage } from '../../lib/overlay';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { PALETTE, classifyLandCover, landCoverMarkdown, type LandCoverResult } from '../../lib/tools/landcover';
import type { ToolOutput } from '../../lib/tools/registry';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function classRgba(r: LandCoverResult): Uint8ClampedArray {
  const colors = PALETTE.map(hexRgb);
  const out = new Uint8ClampedArray(r.classes.length * 4);
  for (let i = 0; i < r.classes.length; i++) {
    const c = r.classes[i];
    if (c) out.set([...colors[c - 1], 255], i * 4);
  }
  return out;
}

export default function LandCoverTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [raster, setRaster] = useState<OpenRaster | null>(null);
  const [bands, setBands] = useState<number[]>([]);
  const [k, setK] = useState('5');
  const [result, setResult] = useState<LandCoverResult | null>(null);
  const [labels, setLabels] = useState<string[]>([]);

  const load = async (file: File) => {
    setBusy(true);
    try {
      const r = await openGeoTiff(file);
      setRaster(r);
      setBands(Array.from({ length: r.meta.bands }, (_, i) => i));
      setResult(null);
      onOutput(null);
      if (r.meta.bands < 2) notify(`${file.name} has one band; clusters will split it into value ranges only.`);
      return r;
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file.name}.`, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const run = async (r = raster, b = bands) => {
    if (!r) return;
    const kk = Number(k);
    if (!Number.isInteger(kk) || kk < 2 || kk > PALETTE.length) {
      notify(`Choose a whole number of classes from 2 to ${PALETTE.length}.`, 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await classifyLandCover(r, { bands: b, k: kk, roles: guessBandMap(r.meta.bands), boundary });
      setResult(res);
      setLabels(res.stats.map(c => (c.suggestion ? `${c.suggestion} (suggested)` : `Class ${c.id}`)));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Classification failed.', 'error');
      setResult(null);
      onOutput(null);
    } finally {
      setBusy(false);
    }
  };

  const image = useMemo(() => (result ? classRgba(result) : null), [result]);

  useEffect(() => {
    if (!result || !raster || !image) return;
    onOutput({
      tool: 'landcover',
      name: result.filename,
      markdown: landCoverMarkdown(result, labels),
      map: {
        bounds: raster.meta.latLngBounds,
        image: mapImage(image, result.width, result.height, raster.meta.latLngBounds, 'Land-cover clusters', result.stats.map((c, i) => ({ color: PALETTE[c.id - 1], label: labels[i] || `Class ${c.id}` }))),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, labels]);

  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (result) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const exportCsv = () => {
    if (!result) return;
    const head = ['class', 'label', 'pixels', 'hectares', 'share_percent', 'mean_ndvi', ...result.bands.map(b => `band${b + 1}_mean`)];
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = result.stats.map((c, i) => [c.id, q(labels[i] ?? ''), c.pixels, c.ha ?? '', (c.share * 100).toFixed(3), c.ndvi ?? '', ...c.bandMeans].join(','));
    downloadText([head.join(','), ...rows].join('\n'), `${safeFilename(result.filename)}_landcover_classes.csv`, 'text/csv');
  };

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload a multispectral GeoTIFF (for example Sentinel-2 B2, B3, B4, B8, B11, B12). TerraX groups pixels with similar spectra into clusters (k-means), maps them and
        reports their areas. You then name each cluster.
      </p>
      <FileDrop id="landcover-file" label="Multispectral image" accept=".tif,.tiff" hint="Multiband GeoTIFF" busy={busy && !raster} loaded={raster?.meta.filename} onFile={load} />
      <div className="param-row">
        {raster && raster.meta.bands > 1 && (
          <fieldset className="band-checks">
            <legend>Bands</legend>
            {Array.from({ length: raster.meta.bands }, (_, i) => (
              <label key={i} className="check">
                <input type="checkbox" checked={bands.includes(i)} onChange={e => setBands(b => (e.target.checked ? [...b, i].sort((x, y) => x - y) : b.filter(x => x !== i)))} /> {i + 1}
              </label>
            ))}
          </fieldset>
        )}
        <label className="param">
          <span>Clusters</span>
          <input id="landcover-k" type="number" min="2" max={PALETTE.length} step="1" value={k} onChange={e => setK(e.target.value)} />
        </label>
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              try {
                const r = await load(await fetchSample('samples/satellite_4band_synthetic.tif'));
                if (r) await run(r, Array.from({ length: r.meta.bands }, (_, i) => i));
              } catch (err) {
                notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
              }
            }}
          >
            Try synthetic scene
          </button>
          <button type="button" id="landcover-run" className="btn btn-primary" disabled={!raster || busy || !bands.length} onClick={() => run()}>
            {busy && raster ? 'Classifying…' : 'Classify'}
          </button>
        </div>
      </div>

      {result && image && (
        <div className="result-block">
          <figure className="raster-figure">
            <RgbaCanvas rgba={image} width={result.width} height={result.height} label="Land-cover clusters" />
          </figure>
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Label (edit)</th>
                  <th>Area</th>
                  <th>Share</th>
                  <th>Mean NDVI</th>
                </tr>
              </thead>
              <tbody>
                {result.stats.map((c, i) => (
                  <tr key={c.id}>
                    <td>
                      <i className="class-swatch" style={{ background: PALETTE[c.id - 1] }} /> {c.id}
                    </td>
                    <td>
                      <input
                        className="label-input"
                        id={`landcover-label-${c.id}`}
                        aria-label={`Label for class ${c.id}`}
                        value={labels[i] ?? ''}
                        onChange={e => setLabels(l => l.map((x, j) => (j === i ? e.target.value : x)))}
                      />
                    </td>
                    <td className="num">{c.ha === null ? `${c.pixels.toLocaleString()} px` : `${fmt(c.ha, 4)} ha`}</td>
                    <td className="num">{(c.share * 100).toFixed(1)} %</td>
                    <td className="num">{c.ndvi === null ? '—' : fmt(c.ndvi, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <button type="button" className="btn btn-small push-right" onClick={exportCsv}>
              Export class table (CSV)
            </button>
          </div>
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
