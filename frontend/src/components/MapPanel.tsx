import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { mapDef, resolveBase } from '../lib/basemaps';
import { request, type ResultImage } from '../lib/api';
import type { LatLngBounds } from '../lib/geo';
import { onLocalPmtilesChange } from '../lib/pmtiles-store';
import { usePrefs } from '../lib/prefs';
import { fmt } from '../lib/stats';
import type { Boundary } from '../lib/zonal';
import MapChooser from './MapChooser';
import { MapController, PLATE_CLASSES, type DrawState, type LayerStatus, type LayerVis } from './map/MapController';

interface Props {
  target: { lat: number; lon: number; name: string };
  /** Area to fly to and outline (e.g. a raster footprint). */
  bounds: LatLngBounds | null;
  /** Vector features to draw (e.g. a surveyed plot). */
  geojson: FeatureCollection | null;
  /** Result picture over the raster footprint. */
  image?: ResultImage | null;
  boundary?: Boundary | null;
  draw?: DrawState | null;
}

interface LegendItem {
  label: string;
  color: string;
  dashed?: boolean;
}

interface Legends {
  koppen: { code: string; name: string; color: string }[];
  biomes: { name: string; color: string }[];
}

let legendsPromise: Promise<Legends> | null = null;
const loadLegends = () => (legendsPromise ??= request<Legends>('/api/maps/catalog').catch(err => {
  legendsPromise = null;
  throw err;
}));

function ClassLegend({ title, items }: { title: string; items: LegendItem[] }) {
  return (
    <details className="class-legend" open={items.length <= 15}>
      <summary>{title}</summary>
      <div className="map-legend">
        {items.map(l => (
          <span key={l.label} title={l.label}>
            <i className={`class-swatch ${l.dashed ? 'dashed' : ''}`} style={{ background: l.dashed ? 'transparent' : l.color, borderColor: l.color }} /> {l.label}
          </span>
        ))}
      </div>
    </details>
  );
}

function Ramp({ ramp }: { ramp: NonNullable<ResultImage['ramp']> }) {
  return (
    <div className="ramp-legend">
      <span className="num">{fmt(ramp.min, 3)}</span>
      <i className="ramp-bar viridis" />
      <span className="num">{fmt(ramp.max, 3)}</span>
    </div>
  );
}

const START_ZOOM = 10;

export default function MapPanel({ target, bounds, geojson, image = null, boundary = null, draw = null }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  const { theme, map: mapSettings } = usePrefs();
  const [status, setStatus] = useState<Record<string, LayerStatus>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [vis, setVis] = useState<LayerVis>({ tiles: true, outlines: true, image: true, features: true, boundary: true, opacity: 0.75 });
  const [dismissed, setDismissed] = useState('');
  const [legends, setLegends] = useState<Legends | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [pmtilesVersion, setPmtilesVersion] = useState(0);
  useEffect(() => onLocalPmtilesChange(() => setPmtilesVersion(v => v + 1)), []);
  const baseDef = resolveBase(mapSettings, theme);
  const classLayers = mapSettings.overlays.map(o => o.id).filter(id => id === 'koppen' || id === 'biomes');
  const showPlates = mapSettings.overlays.some(o => o.id === 'plates');

  useEffect(() => {
    if (!el.current) return;
    try {
      ctl.current = new MapController(el.current, [target.lat, target.lon], START_ZOOM, setStatus);
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      ctl.current?.destroy();
      ctl.current = null;
    };
    // The map is created once; the target only sets where it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    ctl.current?.update({ settings: mapSettings, theme, vis, bounds, geojson, image, boundary, draw, pmtilesVersion });
  }, [mapSettings, theme, vis, bounds, geojson, image, boundary, draw, pmtilesVersion]);

  useEffect(() => {
    if (classLayers.length && !legends) loadLegends().then(setLegends).catch(() => undefined);
  }, [classLayers.length, legends]);

  const failing = [baseDef.id, ...mapSettings.overlays.map(o => o.id)].filter((id, i) => (i === 0 ? vis.tiles : true) && status[id]?.state === 'error');
  // Tile servers that could not be reached report just the map name; other problems carry a full sentence.
  const unreachable = failing.filter(id => status[id].message === mapDef(id).name || status[id].message === 'Custom WMS').map(id => status[id].message!);
  const other = failing.map(id => status[id].message!).filter(m => !unreachable.includes(m));
  const problemKey = [...unreachable, ...other].join('|');
  const toggle = (k: keyof Omit<LayerVis, 'opacity'>) => setVis(v => ({ ...v, [k]: !v[k] }));

  if (engineError)
    return (
      <div className="map-container map-unavailable" role="alert">
        <p>
          The map needs WebGL, which this browser or device has turned off ({engineError}). Results and reports still work; enable hardware acceleration to see them on the map.
        </p>
      </div>
    );

  return (
    <div className="map-container">
      <div ref={el} className="map-canvas" data-testid="map" />
      {problemKey && problemKey !== dismissed && !draw && (
        <div className="map-status" role="status">
          <div>
            {unreachable.length > 0 && (
              <div>
                Not loading: <strong>{unreachable.join(', ')}</strong> (offline, blocked, or the server needs a key).
              </div>
            )}
            {other.map(m => (
              <div key={m}>{m}</div>
            ))}
            <div className="muted">The offline outlines are shown underneath.</div>
          </div>
          <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setDismissed(problemKey)}>
            ×
          </button>
        </div>
      )}
      <div className="map-layers">
        <button type="button" className="map-layers-toggle" aria-expanded={panelOpen} aria-controls="map-layers-panel" onClick={() => setPanelOpen(o => !o)}>
          Layers
        </button>
        {panelOpen && (
          <div id="map-layers-panel" className="map-layers-panel">
            <MapChooser idPrefix="layers-map" compact />
            {baseDef.kind !== 'none' && (
              <label className="check">
                <input type="checkbox" checked={vis.tiles} onChange={() => toggle('tiles')} /> Show base map ({baseDef.name})
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={vis.outlines} onChange={() => toggle('outlines')} /> Country outlines (offline)
            </label>
            {image && (
              <>
                <label className="check">
                  <input id="layer-image" type="checkbox" checked={vis.image} onChange={() => toggle('image')} /> {image.label}
                </label>
                <label className="range-row">
                  <span>Opacity</span>
                  <input id="layer-opacity" type="range" min="0.1" max="1" step="0.05" value={vis.opacity} onChange={e => setVis(v => ({ ...v, opacity: Number(e.target.value) }))} />
                  <span className="num">{Math.round(vis.opacity * 100)} %</span>
                </label>
              </>
            )}
            {(geojson || bounds) && (
              <label className="check">
                <input type="checkbox" checked={vis.features} onChange={() => toggle('features')} /> {geojson ? 'Result features' : 'Raster footprint'}
              </label>
            )}
            {boundary && (
              <label className="check">
                <input type="checkbox" checked={vis.boundary} onChange={() => toggle('boundary')} /> Analysis boundary
              </label>
            )}
            {image && image.legend.length > 0 && (
              <div className="map-legend">
                {image.legend.map(l => (
                  <span key={l.label}>
                    <i className="class-swatch" style={{ background: l.color }} /> {l.label}
                  </span>
                ))}
              </div>
            )}
            {image?.ramp && <Ramp ramp={image.ramp} />}
            {classLayers.includes('koppen') && legends && <ClassLegend title="Köppen–Geiger climate zones" items={legends.koppen.map(k => ({ label: `${k.code} ${k.name}`, color: k.color }))} />}
            {classLayers.includes('biomes') && legends && <ClassLegend title="Biomes (RESOLVE 2017)" items={legends.biomes.map(b => ({ label: b.name, color: b.color }))} />}
            {showPlates && <ClassLegend title="Plate boundaries (Bird 2003)" items={Object.values(PLATE_CLASSES).map(c => ({ label: c.name, color: c.color, dashed: Boolean(c.dash) }))} />}
            {(classLayers.length > 0 || showPlates) && <p className="field-hint">Click the map to read the climate zone or biome; hover a plate boundary for its type and speed.</p>}
            {image && <p className="field-hint">The overlay is stretched over the raster’s bounding box, not reprojected, so it is approximate at the edges.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
