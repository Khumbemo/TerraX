import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadText, safeFilename } from '../../lib/download';
import { labelPatches, patchAreas, patchesToGeoJson } from '../../lib/patches';
import { groundGeometry } from '../../lib/rasterio';
import { flowRoutingAsync } from '../../lib/compute';
import { contoursGeoJson, niceInterval, snapOutlet, streamLines, watershed, type FlowResult } from '../../lib/tools/hydrology';
import { makeBoundary } from '../../lib/vector';
import { viridis } from '../../lib/colormap';
import { mapImage } from '../../lib/overlay';
import { openGeoTiff, type OpenRaster } from '../../lib/rasterio';
import { fetchSample } from '../../lib/samples';
import { fmt } from '../../lib/stats';
import { useToast } from '../../lib/toast';
import { usePrefs } from '../../lib/prefs';
import { ACRES_PER_HA, elevationM } from '../../lib/units';
import type { ToolOutput } from '../../lib/tools/registry';
import { ASPECTS, SLOPE_CLASSES, analyzeTerrain, gridToRgba, terrainMarkdown, type TerrainResult } from '../../lib/tools/terrain';
import type { Boundary } from '../../lib/zonal';
import FileDrop from '../FileDrop';
import RgbaCanvas from '../RgbaCanvas';
import { Stat } from './ForestLossTool';

interface Props {
  onOutput: (out: ToolOutput | null) => void;
  boundary: Boundary | null;
  onBoundary?: (b: Boundary) => void;
}

type Layer = 'hillshade' | 'slope' | 'elevation' | 'flow';

interface Basin {
  outlet: number;
  mask: Uint8Array;
  cells: number;
  areaM2: number;
  meanElevation: number;
  meanSlope: number;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function slopeRgba(t: TerrainResult): Uint8ClampedArray {
  const colors = SLOPE_CLASSES.map(c => hexRgb(c.color));
  return gridToRgba(t.slopeGrid, v => colors[SLOPE_CLASSES.findIndex(c => v < c.upTo)]);
}

export default function TerrainTool({ onOutput, boundary, onBoundary }: Props) {
  const notify = useToast();
  const { units } = usePrefs();
  const [busy, setBusy] = useState(false);
  const [raster, setRaster] = useState<OpenRaster | null>(null);
  const [result, setResult] = useState<TerrainResult | null>(null);
  const [layer, setLayer] = useState<Layer>('hillshade');
  const [thresholdKm2, setThresholdKm2] = useState('0.5');
  const [flow, setFlow] = useState<FlowResult | null>(null);
  const [basin, setBasin] = useState<Basin | null>(null);
  const [interval, setInterval_] = useState('');
  const [showContours, setShowContours] = useState(false);
  const baseOutput = useRef<ToolOutput | null>(null);

  const demGrid = (t: TerrainResult) => ({ width: t.width, height: t.height, data: t.elevationGrid, resampleFactor: 1 });
  const geo = useMemo(() => (raster && result ? groundGeometry(raster.meta, result) : null), [raster, result]);

  const analyse = async (file: File | OpenRaster) => {
    setBusy(true);
    try {
      const r = file instanceof File ? await openGeoTiff(file) : file;
      const name = r.meta.filename;
      if (file instanceof File && r.meta.bands > 1) notify(`${name} has ${r.meta.bands} bands; band 1 was read as elevation.`);
      const t = await analyzeTerrain(r, boundary);
      setRaster(r);
      setResult(t);
      setFlow(null);
      setBasin(null);
      setShowContours(false);
      setInterval_(String(niceInterval(t.relief)));
      if (layer === 'flow') setLayer('hillshade');
      publish({
        tool: 'terrain',
        name,
        markdown: terrainMarkdown(t, r.meta) + (r.meta.warnings.length ? `\n\n## Data quality\n\n${r.meta.warnings.map(w => `- ${w}`).join('\n')}` : ''),
        map: { bounds: r.meta.latLngBounds, image: mapImage(slopeRgba(t), t.width, t.height, r.meta.latLngBounds, 'Slope classes', SLOPE_CLASSES.map(c => ({ color: c.color, label: c.label }))) },
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not read ${file instanceof File ? file.name : file.meta.filename}.`, 'error');
      if (!(file instanceof File)) {
        // A re-run (new boundary) failed: do not leave results for the old extent on screen.
        setResult(null);
        setFlow(null);
        setBasin(null);
        baseOutput.current = null;
        onOutput(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = (out: ToolOutput) => {
    baseOutput.current = out;
    onOutput(out);
  };

  const hydroMarkdown = (f: FlowResult | null, b: Basin | null): string => {
    if (!f || !result) return '';
    const validKm2 = (() => {
      if (!geo) return NaN;
      let a = 0;
      for (let k = 0; k < result.elevationGrid.length; k++) if (!Number.isNaN(result.elevationGrid[k])) a += geo.cellArea(Math.floor(k / result.width));
      return a / 1e6;
    })();
    const totalKm = f.lengthByOrder.reduce((x, y) => x + y, 0) / 1000;
    const lines = [
      '',
      '## Hydrology',
      '',
      `- Channels: cells draining at least ${fmt(f.thresholdM2 / 1e6, 3)} km²; highest Strahler order ${f.maxOrder}; total length ${fmt(totalKm, 4)} km; drainage density ${fmt(totalKm / validKm2, 3)} km/km².`,
      ...f.lengthByOrder.slice(1).map((l, i) => `- Order ${i + 1}: ${fmt(l / 1000, 4)} km`),
      `- Depression filling raised ${f.raisedCells.toLocaleString()} cells by more than 1 mm (largest ${fmt(f.maxRaise, 3)} m).`,
    ];
    if (b) lines.push(`- Watershed: ${fmt(b.areaM2 / 1e6, 4)} km² (${fmt(b.areaM2 / 1e4, 4)} ha), mean elevation ${fmt(b.meanElevation)} m, mean slope ${fmt(b.meanSlope, 3)}°.`);
    lines.push(
      '- Method: Priority-Flood depression filling with an ε gradient (Barnes et al. 2014), D8 steepest-descent flow (O’Callaghan & Mark 1984), Strahler (1957) stream order. The threshold sets where channels start and is a choice, not a measurement; D8 cannot split flow, so it draws parallel lines on planar slopes.',
    );
    return lines.join('\n');
  };

  // Keep the report in step with hydrology results.
  useEffect(() => {
    const base = baseOutput.current;
    if (!base || !raster || !result) return;
    const contours = showContours ? contoursGeoJson(demGrid(result), raster.meta, Number(interval)) : null;
    const streams = flow ? streamLines(flow, raster.meta) : null;
    const features = [...(contours?.fc.features ?? []), ...(streams?.features ?? [])];
    onOutput({
      ...base,
      markdown: base.markdown + hydroMarkdown(flow, basin),
      map: { ...base.map, geojson: features.length ? { type: 'FeatureCollection', features } : null },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, basin, showContours, interval]);

  const [flowBusy, setFlowBusy] = useState(false);
  const computeFlow = async () => {
    if (!result || !geo) {
      notify('Flow routing needs a DEM with ground units (WGS84, Web Mercator or UTM).', 'error');
      return;
    }
    const km2 = Number(thresholdKm2);
    if (!Number.isFinite(km2) || km2 <= 0) {
      notify('Set the channel threshold as a positive area in km², for example 0.5.', 'error');
      return;
    }
    setFlowBusy(true);
    try {
      setFlow(await flowRoutingAsync(demGrid(result), geo, km2 * 1e6));
      setBasin(null);
      setLayer('flow');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Flow routing failed.', 'error');
    } finally {
      setFlowBusy(false);
    }
  };

  const pickOutlet = (col: number, row: number) => {
    if (!flow || !result || !geo) return;
    const outlet = snapOutlet(flow, col, row, Math.max(3, Math.round(0.02 * Math.max(flow.width, flow.height))));
    if (outlet < 0) return;
    const { mask, cells } = watershed(flow, outlet);
    let area = 0, zSum = 0, zN = 0, sSum = 0, sN = 0;
    for (let k = 0; k < mask.length; k++) {
      if (!mask[k]) continue;
      area += geo.cellArea(Math.floor(k / result.width));
      const z = result.elevationGrid[k], s = result.slopeGrid[k];
      if (!Number.isNaN(z)) {
        zSum += z;
        zN++;
      }
      if (!Number.isNaN(s)) {
        sSum += s;
        sN++;
      }
    }
    setBasin({ outlet, mask, cells, areaM2: area, meanElevation: zSum / zN, meanSlope: sN ? sSum / sN : NaN });
  };

  const basinPolygon = () => {
    if (!basin || !raster || !result) return null;
    const labels = { labels: Int32Array.from(basin.mask), count: 1 };
    const stats = patchAreas(labels, result.width, row => geo?.cellArea(row) ?? 1);
    return patchesToGeoJson(labels, stats, raster.meta, result, (_id, a) => ({ name: 'Watershed', area_ha: Math.round(a / 100) / 100 }))?.fc ?? null;
  };

  const base = raster ? safeFilename(raster.meta.filename) : 'dem';

  const image = useMemo(() => {
    if (!result) return null;
    if (layer === 'flow' && flow) {
      const maxLog = Math.log10(Math.max(...[flow.acc.reduce((m, v) => Math.max(m, v), 0), 1]));
      const out = new Uint8ClampedArray(result.width * result.height * 4);
      const orderColors: [number, number, number][] = [[125, 211, 252], [56, 189, 248], [14, 165, 233], [2, 132, 199], [3, 105, 161], [30, 64, 175]];
      for (let k = 0; k < flow.acc.length; k++) {
        const hs = result.hillshade[k];
        if (Number.isNaN(result.elevationGrid[k])) continue;
        const shade = Number.isNaN(hs) ? 0.5 : hs;
        let rgb: [number, number, number];
        if (flow.order[k]) rgb = orderColors[Math.min(orderColors.length - 1, flow.order[k] - 1)];
        else {
          const t = Math.log10(Math.max(flow.acc[k], 1)) / (maxLog || 1);
          rgb = [shade * 90 + t * 20, shade * 100 + t * 60, shade * 110 + t * 110];
        }
        if (basin?.mask[k]) rgb = [rgb[0] * 0.5 + 245 * 0.5, rgb[1] * 0.5 + 184 * 0.5, rgb[2] * 0.5 + 61 * 0.5];
        out.set([rgb[0], rgb[1], rgb[2], 255], k * 4);
      }
      if (basin) out.set([255, 255, 255, 255], basin.outlet * 4);
      return out;
    }
    if (layer === 'hillshade') return gridToRgba(result.hillshade, v => [v * 235 + 10, v * 240 + 12, v * 245 + 18]);
    if (layer === 'slope') return slopeRgba(result);
    const { min, max } = result.elevation;
    return gridToRgba(result.elevationGrid, v => viridis((v - min) / (max - min || 1)));
  }, [result, layer, flow, basin]);

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
            <Stat label="Elevation range" value={`${elevationM(result.elevation.min, units)} – ${elevationM(result.elevation.max, units)}`} />
            <Stat label="Relief" value={elevationM(result.relief, units)} />
            <Stat label="Mean slope" value={`${fmt(result.slope.mean)}°`} />
            <Stat label="Hypsometric integral" value={fmt(result.hypsometricIntegral, 3)} />
          </div>

          <div className="view-toggles" role="tablist">
            {((flow ? ['hillshade', 'slope', 'elevation', 'flow'] : ['hillshade', 'slope', 'elevation']) as Layer[]).map(l => (
              <button key={l} type="button" role="tab" aria-selected={layer === l} className={layer === l ? 'active' : ''} onClick={() => setLayer(l)}>
                {l === 'hillshade' ? 'Hillshade' : l === 'slope' ? 'Slope classes' : l === 'elevation' ? 'Elevation' : 'Flow & streams'}
              </button>
            ))}
          </div>
          <figure className="raster-figure">
            <RgbaCanvas rgba={image} width={result.width} height={result.height} label={`${layer} of ${result.filename}`} onPick={layer === 'flow' ? pickOutlet : undefined} />
            {layer === 'flow' && <figcaption className="field-hint">Streams are blue (darker = higher Strahler order). Click a stream to outline the watershed draining to that point.</figcaption>}
            {layer === 'elevation' && (
              <figcaption className="legend-labels">
                <span>{fmt(result.elevation.min)} m</span>
                <span>viridis</span>
                <span>{fmt(result.elevation.max)} m</span>
              </figcaption>
            )}
          </figure>

          <section className="sub-panel" aria-label="Hydrology and contours">
            <div className="eyebrow">Hydrology & contours</div>
            <div className="param-row">
              <label className="param" title="Cells draining at least this area are channels.">
                <span>Channel threshold (km²)</span>
                <input id="terrain-threshold" type="number" step="0.1" min="0.01" value={thresholdKm2} onChange={e => setThresholdKm2(e.target.value)} />
              </label>
              <button type="button" id="terrain-flow" className="btn" onClick={computeFlow} disabled={flowBusy}>
                {flowBusy ? 'Routing flow…' : flow ? 'Recompute flow' : 'Compute flow & streams'}
              </button>
              <label className="param">
                <span>Contour interval (m)</span>
                <input id="terrain-interval" type="number" step="1" min="0.1" value={interval} onChange={e => setInterval_(e.target.value)} />
              </label>
              <label className="check">
                <input id="terrain-contours" type="checkbox" checked={showContours} onChange={e => setShowContours(e.target.checked)} /> Contours on map
              </label>
            </div>
            {flow && (
              <div className="stat-grid">
                <Stat label="Highest stream order" value={String(flow.maxOrder)} />
                <Stat label="Channel length" value={`${fmt(flow.lengthByOrder.reduce((a, b) => a + b, 0) / 1000, 4)} km`} />
                {basin && <Stat label="Watershed area" value={units === 'imperial' ? `${fmt((basin.areaM2 / 1e4) * ACRES_PER_HA / 640, 4)} mi²` : `${fmt(basin.areaM2 / 1e6, 4)} km²`} />}
                {basin && <Stat label="Watershed mean slope" value={`${fmt(basin.meanSlope, 3)}°`} />}
              </div>
            )}
            <div className="button-row">
              {basin && onBoundary && (
                <button
                  type="button"
                  id="watershed-boundary"
                  className="btn btn-primary"
                  onClick={() => {
                    const fc = basinPolygon();
                    const b = fc && makeBoundary(`Watershed of ${result.filename}`, fc, basin.areaM2);
                    if (!b) {
                      notify('This DEM’s CRS cannot be turned into a boundary polygon.', 'error');
                      return;
                    }
                    onBoundary(b);
                    notify('The watershed is now the analysis boundary.', 'success');
                  }}
                >
                  Use watershed as analysis boundary
                </button>
              )}
              {basin && (
                <button type="button" className="btn btn-small" onClick={() => { const fc = basinPolygon(); if (fc) downloadText(JSON.stringify(fc), `${base}_watershed.geojson`, 'application/geo+json'); }}>
                  Export watershed
                </button>
              )}
              {flow && raster && (
                <button type="button" className="btn btn-small" onClick={() => { const fc = streamLines(flow, raster.meta); if (fc) downloadText(JSON.stringify(fc), `${base}_streams.geojson`, 'application/geo+json'); else notify('Streams need a WGS84, Web Mercator or UTM DEM.', 'error'); }}>
                  Export streams
                </button>
              )}
              {raster && (
                <button
                  type="button"
                  id="terrain-export-contours"
                  className="btn btn-small"
                  onClick={() => {
                    const out = contoursGeoJson(demGrid(result), raster.meta, Number(interval));
                    if (!out) notify('Contours need a WGS84, Web Mercator or UTM DEM.', 'error');
                    else if (!out.fc.features.length) notify('No contours at that interval.');
                    else downloadText(JSON.stringify(out.fc), `${base}_contours_${interval}m.geojson`, 'application/geo+json');
                  }}
                >
                  Export contours
                </button>
              )}
            </div>
          </section>

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
