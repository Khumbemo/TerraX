import { useEffect, useMemo, useRef, useState } from 'react';
import { viridis } from '../../lib/colormap';
import { mapImage } from '../../lib/overlay';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import type { ToolOutput } from '../../lib/tools/registry';
import { ASPECTS, SLOPE_CLASSES, analyzeTerrain, gridToRgba, terrainMarkdown, type TerrainResult } from '../../lib/tools/terrain';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';
import { Stat } from './ForestLossTool';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
}

type Layer = 'hillshade' | 'slope' | 'elevation';

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function slopeRgba(t: TerrainResult): Uint8ClampedArray {
  const colors = SLOPE_CLASSES.map(c => hexRgb(c.color));
  return gridToRgba(t.slopeGrid, v => colors[SLOPE_CLASSES.findIndex(c => v < c.upTo)]);
}

export default function TerrainTool({ onOutput, boundary }: Props) {
  const notify = useToast();
  const [busy, setBusy] = useState(false);
  const [raster, setRaster] = useState<OpenRaster | null>(null);
  const [result, setResult] = useState<TerrainResult | null>(null);
  const [layer, setLayer] = useState<Layer>('hillshade');

  const analyse = async (file: File | OpenRaster) => {
    setBusy(true);
    try {
      const r = file instanceof File ? await openGeoTiff(file) : file;
      const name = r.meta.filename;
      if (file instanceof File && r.meta.bands > 1) notify(`${name} has ${r.meta.bands} bands; band 1 was read as elevation.`);
      const t = await analyzeTerrain(r, boundary);
      setRaster(r);
      setResult(t);
      onOutput({
        tool: 'terrain',
        name,
        markdown: terrainMarkdown(t, r.meta) + (r.meta.warnings.length ? `\n\n## Data quality\n\n${r.meta.warnings.map(w => `- ${w}`).join('\n')}` : ''),
        map: { bounds: r.meta.latLngBounds, image: mapImage(slopeRgba(t), t.width, t.height, r.meta.latLngBounds, 'Slope classes', SLOPE_CLASSES.map(c => ({ color: c.color, label: c.label }))) },
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file instanceof File ? file.name : file.meta.filename}.`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const image = useMemo(() => {
    if (!result) return null;
    if (layer === 'hillshade') return gridToRgba(result.hillshade, v => [v * 235 + 10, v * 240 + 12, v * 245 + 18]);
    if (layer === 'slope') return slopeRgba(result);
    const { min, max } = result.elevation;
    return gridToRgba(result.elevationGrid, v => viridis((v - min) / (max - min || 1)));
  }, [result, layer]);

  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (lastBoundary.current === boundary) return;
    lastBoundary.current = boundary;
    if (raster) analyse(raster);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const slopeTotal = result ? result.slopeClassCounts.reduce((a, b) => a + b, 0) || 1 : 1;
  const aspTotal = result ? result.aspectCounts.reduce((a, b) => a + b, 0) || 1 : 1;

  return (
    <div className="tool-body">
      <p className="tool-intro">
        Upload a digital elevation model (single-band GeoTIFF in metres), for example SRTM (USGS/SRTMGL1_003), Copernicus GLO-30 or ASTER GDEM exported from Earth
        Engine. Use a projected CRS (UTM) or WGS84.
      </p>
      <FileDrop id="terrain-file" label="Elevation model (DEM)" accept=".tif,.tiff" hint="GeoTIFF · elevation in metres" busy={busy} loaded={raster?.meta.filename} onFile={analyse} />
      <div className="param-row">
        <div className="button-row push-right">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              try {
                await analyse(await fetchSample('samples/terrain_dem_synthetic.tif'));
              } catch (err) {
                notify(err instanceof Error ? err.message : 'Could not load the sample.', 'error');
              }
            }}
          >
            Try synthetic DEM
          </button>
        </div>
      </div>

      {result && image && (
        <div className="result-block">
          <div className="stat-grid">
            <Stat label="Elevation range" value={`${fmt(result.elevation.min)}–${fmt(result.elevation.max)} m`} />
            <Stat label="Relief" value={`${fmt(result.relief)} m`} />
            <Stat label="Mean slope" value={`${fmt(result.slope.mean)}°`} />
            <Stat label="Hypsometric integral" value={fmt(result.hypsometricIntegral, 3)} />
          </div>

          <div className="view-toggles" role="tablist">
            {(['hillshade', 'slope', 'elevation'] as Layer[]).map(l => (
              <button key={l} type="button" role="tab" aria-selected={layer === l} className={layer === l ? 'active' : ''} onClick={() => setLayer(l)}>
                {l === 'hillshade' ? 'Hillshade' : l === 'slope' ? 'Slope classes' : 'Elevation'}
              </button>
            ))}
          </div>
          <figure className="raster-figure">
            <RgbaCanvas rgba={image} width={result.width} height={result.height} label={`${layer} of ${result.filename}`} />
            {layer === 'elevation' && (
              <figcaption className="legend-labels">
                <span>{fmt(result.elevation.min)} m</span>
                <span>viridis</span>
                <span>{fmt(result.elevation.max)} m</span>
              </figcaption>
            )}
          </figure>

          <div className="two-col">
            <div className="class-bars">
              <div className="eyebrow">Slope classes (descriptive)</div>
              {SLOPE_CLASSES.map((c, i) => (
                <div key={c.label} className="class-row">
                  <span className="class-swatch" style={{ background: c.color }} aria-hidden="true" />
                  <span className="class-name">{c.label}</span>
                  <span className="class-bar-track">
                    <span className="class-bar" style={{ width: `${(result.slopeClassCounts[i] / slopeTotal) * 100}%`, background: c.color }} />
                  </span>
                  <span className="class-count">{((result.slopeClassCounts[i] / slopeTotal) * 100).toFixed(1)} %</span>
                </div>
              ))}
            </div>
            <div className="class-bars">
              <div className="eyebrow">Aspect of non-flat slopes</div>
              {ASPECTS.map((a, i) => (
                <div key={a} className="class-row aspect-row">
                  <span className="class-name">{a}</span>
                  <span className="class-bar-track">
                    <span className="class-bar" style={{ width: `${(result.aspectCounts[i] / aspTotal) * 100}%`, background: '#38bdf8' }} />
                  </span>
                  <span className="class-count">{((result.aspectCounts[i] / aspTotal) * 100).toFixed(1)} %</span>
                </div>
              ))}
            </div>
          </div>

          <ul className="hint-list">
            {[...result.notes, ...(raster?.meta.warnings ?? [])].map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
