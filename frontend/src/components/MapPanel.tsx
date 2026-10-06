import L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { GeoJSON, ImageOverlay, MapContainer, Marker, Pane, Polygon, Polyline, Rectangle, useMap, useMapEvents } from 'react-leaflet';
import { mapDef, resolveBase } from '../lib/basemaps';
import { BIOMES, KOPPEN, KOPPEN_LEGEND, PLATE_CLASSES, classFromColor, mercatorPixel } from '../lib/world-maps';
import MapChooser from './MapChooser';
import MapLayer, { type LayerStatus } from './MapLayers';
import type { FeatureCollection, MultiLineString } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { LatLngBounds } from '../lib/geo';
import { usePrefs } from '../lib/prefs';
import type { MapImage } from '../lib/tools/registry';
import type { Boundary } from '../lib/zonal';

/** Polygon drawing/editing: vertices as [lat, lon]. */
export interface DrawState {
  points: [number, number][];
  onAdd: (p: [number, number]) => void;
  onMove: (index: number, p: [number, number]) => void;
  onRemove: (index: number) => void;
}

interface Props {
  target: { lat: number; lon: number; name: string };
  /** Area to fly to and outline (e.g. a raster footprint). */
  bounds: LatLngBounds | null;
  /** Vector features to draw (e.g. a surveyed plot). */
  geojson: FeatureCollection | null;
  /** Result picture over the raster footprint. */
  image?: MapImage | null;
  boundary?: Boundary | null;
  draw?: DrawState | null;
}

interface Basemap {
  land: FeatureCollection;
  borders: MultiLineString;
}

// Natural Earth 1:50m countries (public domain), bundled and loaded on
// demand. It sits under the online tiles, so the map is still readable
// offline, in sandboxed previews, or whenever the tile server fails.
let basemapPromise: Promise<Basemap> | null = null;
function loadBasemap(): Promise<Basemap> {
  if (!basemapPromise) {
    basemapPromise = Promise.all([import('world-atlas/countries-50m.json'), import('topojson-client')]).then(([topo, { feature, mesh }]) => {
      const t = topo.default;
      const countries = t.objects.countries;
      return {
        land: feature(t, countries) as unknown as FeatureCollection,
        borders: mesh(t, countries as never, (a, b) => a !== b) as MultiLineString,
      };
    });
  }
  return basemapPromise;
}

// Flies to a loaded GeoTIFF once when its bounds change, then leaves
// panning and zooming to the user.
function FitToBounds({ bounds }: { bounds: [[number, number], [number, number]] | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  }, [map, bounds]);
  return null;
}

function DrawLayer({ draw }: { draw: DrawState }) {
  const map = useMap();
  useMapEvents({
    click: e => draw.onAdd([e.latlng.lat, e.latlng.lng]),
  });
  useEffect(() => {
    const el = map.getContainer();
    el.classList.add('drawing');
    map.doubleClickZoom.disable();
    return () => {
      el.classList.remove('drawing');
      map.doubleClickZoom.enable();
    };
  }, [map]);
  const icon = useMemo(() => L.divIcon({ className: 'vertex-handle', iconSize: [14, 14] }), []);
  const pts = draw.points;
  return (
    <>
      {pts.length >= 3 ? (
        <Polygon positions={pts} pathOptions={{ color: '#f5b83d', weight: 2, dashArray: '6 4', fillOpacity: 0.12 }} interactive={false} />
      ) : pts.length === 2 ? (
        <Polyline positions={pts} pathOptions={{ color: '#f5b83d', weight: 2, dashArray: '6 4' }} interactive={false} />
      ) : null}
      {pts.map((p, i) => (
        <Marker
          key={i}
          position={p}
          icon={icon}
          draggable
          title={`Vertex ${i + 1}: drag to move, double-click to delete`}
          eventHandlers={{
            dragend: e => {
              const ll = (e.target as L.Marker).getLatLng();
              draw.onMove(i, [ll.lat, ll.lng]);
            },
            dblclick: () => draw.onRemove(i),
          }}
        />
      ))}
    </>
  );
}

interface LegendItem {
  label: string;
  color: string;
  short?: string;
  dashed?: boolean;
}

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

/** Reads the Köppen zone and/or biome under a click from the built-in class pictures. */
function ClassIdentify({ ids }: { ids: string[] }) {
  const map = useMap();
  useMapEvents({
    click: async e => {
      const { lat, lng } = e.latlng;
      const lon = ((((lng + 180) % 360) + 360) % 360) - 180;
      const { loadPixels } = await import('./BuiltinLayers');
      const rows: string[] = [];
      for (const id of ids) {
        const info = id === 'koppen' ? KOPPEN : BIOMES;
        const px = await loadPixels(id === 'koppen' ? 'koppen.png' : 'biomes.png').catch(() => null);
        if (!px) continue;
        const at = mercatorPixel(lat, lon, px.width);
        if (!at) continue;
        const o = (at[1] * px.width + at[0]) * 4;
        const c = classFromColor(px.data[o], px.data[o + 1], px.data[o + 2], px.data[o + 3], info);
        const label = id === 'koppen' ? 'Climate (Köppen–Geiger)' : 'Biome';
        rows.push(`<div><span class="muted">${label}:</span> <strong>${c ? (id === 'koppen' ? `${info[c - 1].code} · ` : '') + info[c - 1].name : 'none (sea or no data)'}</strong></div>`);
      }
      if (rows.length)
        L.popup({ className: 'class-popup', maxWidth: 280 })
          .setLatLng(e.latlng)
          .setContent(`<div class="muted">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</div>${rows.join('')}`)
          .openOn(map);
    },
  });
  return null;
}

interface LayerVis {
  tiles: boolean;
  outlines: boolean;
  image: boolean;
  features: boolean;
  boundary: boolean;
  opacity: number;
}

// react-leaflet's GeoJSON layer does not update its data, so give each
// feature collection object its own key.
const layerIds = new WeakMap<object, number>();
let nextLayerId = 1;
function layerKey(o: object): number {
  let id = layerIds.get(o);
  if (!id) {
    id = nextLayerId++;
    layerIds.set(o, id);
  }
  return id;
}

// Without tiles (the sandboxed preview) the 1:50m basemap has no detail at
// city scale, so open at a regional view there.
const START_ZOOM = __TERRAX_PREVIEW__ ? 5 : 10;

export default function MapPanel({ target, bounds, geojson, image = null, boundary = null, draw = null }: Props) {
  const [basemap, setBasemap] = useState<Basemap | null>(null);
  const { theme, map: mapSettings } = usePrefs();
  const light = theme === 'light';
  // In the sandboxed preview no map server is reachable, so 'automatic' means the built-in Natural Earth map there.
  const baseDef = __TERRAX_PREVIEW__ && mapSettings.base === 'auto' ? mapDef('ne-detailed') : resolveBase(mapSettings, theme);
  const classLayers = mapSettings.overlays.map(o => o.id).filter(id => id === 'koppen' || id === 'biomes');
  const showPlates = mapSettings.overlays.some(o => o.id === 'plates');
  const [status, setStatus] = useState<Record<string, LayerStatus>>({});
  const report = (id: string) => (s: LayerStatus) => setStatus(prev => (prev[id]?.state === s.state && prev[id]?.message === s.message ? prev : { ...prev, [id]: s }));
  const [panelOpen, setPanelOpen] = useState(false);
  const [vis, setVis] = useState<LayerVis>({ tiles: true, outlines: true, image: true, features: true, boundary: true, opacity: 0.75 });
  const [dismissed, setDismissed] = useState('');
  const failing = [baseDef.id, ...mapSettings.overlays.map(o => o.id)].filter((id, i) => (i === 0 ? vis.tiles : true) && status[id]?.state === 'error');
  // Tile servers that could not be reached report just the map name; other problems carry a full sentence.
  const unreachable = failing.filter(id => status[id].message === mapDef(id).name || status[id].message === 'Custom WMS').map(id => status[id].message!);
  const other = failing.map(id => status[id].message!).filter(m => !unreachable.includes(m));
  const problemKey = [...unreachable, ...other].join('|');
  const toggle = (k: keyof Omit<LayerVis, 'opacity'>) => setVis(v => ({ ...v, [k]: !v[k] }));

  useEffect(() => {
    let alive = true;
    loadBasemap()
      .then(b => alive && setBasemap(b))
      .catch(err => console.warn('TerraX: offline basemap unavailable', err));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="map-container">
      <MapContainer center={[target.lat, target.lon]} zoom={START_ZOOM} worldCopyJump style={{ height: '100%', width: '100%' }}>
        {basemap && vis.outlines && (
          // Below the tile pane (z-index 200): online tiles cover it when they load.
          <Pane name="offline-basemap" style={{ zIndex: 150 }}>
            <GeoJSON key={`land-${theme}`} data={basemap.land} style={{ stroke: false, fillColor: light ? '#f2f4f6' : '#15202b', fillOpacity: 1 }} interactive={false} />
            <GeoJSON key={`borders-${theme}`} data={basemap.borders} style={{ color: light ? '#9aa9ba' : '#3a5068', weight: 0.8, opacity: 0.9 }} interactive={false} />
          </Pane>
        )}
        {vis.tiles && baseDef.kind !== 'none' && <MapLayer key={`base-${baseDef.id}`} def={baseDef} settings={mapSettings} opacity={1} zIndex={1} dark={!light} base onStatus={report(baseDef.id)} />}
        {mapSettings.overlays.map((o, i) => (
          <MapLayer key={`ov-${o.id}`} def={mapDef(o.id)} settings={mapSettings} opacity={o.opacity} zIndex={10 + i} dark={!light} onStatus={report(o.id)} />
        ))}
        {image && vis.image && <ImageOverlay key={image.url.length + image.label} url={image.url} bounds={image.bounds} opacity={vis.opacity} className="pixelated-overlay" />}
        {boundary && vis.boundary && (
          <GeoJSON key={`b-${layerKey(boundary.geojson)}`} data={boundary.geojson} style={{ color: '#f5b83d', weight: 2, dashArray: '6 4', fill: false }} interactive={false} />
        )}
        {bounds && !geojson && vis.features && <Rectangle bounds={bounds} pathOptions={{ color: '#5ab0f0', weight: 2, fillOpacity: 0.2 }} />}
        {geojson && vis.features && (
          <GeoJSON
            key={layerKey(geojson)}
            data={geojson}
            style={{ color: '#5ab0f0', weight: 2, fillColor: '#5ab0f0', fillOpacity: 0.18 }}
            pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 5, color: '#5ab0f0', weight: 2, fillOpacity: 0.6 })}
          />
        )}
        {draw && <DrawLayer draw={draw} />}
        {!draw && classLayers.length > 0 && <ClassIdentify ids={classLayers} />}
        <FitToBounds bounds={bounds} />
      </MapContainer>
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
                  <input
                    id="layer-opacity"
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    value={vis.opacity}
                    onChange={e => setVis(v => ({ ...v, opacity: Number(e.target.value) }))}
                  />
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
            {classLayers.includes('koppen') && <ClassLegend title="Köppen–Geiger climate zones" items={KOPPEN_LEGEND.map(k => ({ label: `${k.code} ${k.name}`, short: k.code, color: k.color }))} />}
            {classLayers.includes('biomes') && <ClassLegend title="Biomes (RESOLVE 2017)" items={BIOMES.map(b => ({ label: b.name, color: b.color }))} />}
            {showPlates && (
              <ClassLegend
                title="Plate boundaries (Bird 2003)"
                items={Object.values(PLATE_CLASSES).map(c => ({ label: c.name, color: c.color, dashed: Boolean(c.dash) }))}
              />
            )}
            {(classLayers.length > 0 || showPlates) && <p className="field-hint">Click the map to read the climate zone or biome; hover a plate boundary for its type and speed.</p>}
            {image && <p className="field-hint">The overlay is stretched over the raster’s bounding box, not reprojected, so it is approximate at the edges.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
