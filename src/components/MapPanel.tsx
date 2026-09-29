import L from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { GeoJSON, ImageOverlay, MapContainer, Marker, Pane, Polygon, Polyline, Rectangle, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import type { FeatureCollection, MultiLineString } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { LatLngBounds } from '../lib/geo';
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

interface LayerVis {
  tiles: boolean;
  outlines: boolean;
  image: boolean;
  features: boolean;
  boundary: boolean;
  opacity: number;
}

// Without tiles (the sandboxed preview) the 1:50m basemap has no detail at
// city scale, so open at a regional view there.
const START_ZOOM = __TERRAX_PREVIEW__ ? 5 : 10;

export default function MapPanel({ target, bounds, geojson, image = null, boundary = null, draw = null }: Props) {
  const [basemap, setBasemap] = useState<Basemap | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [vis, setVis] = useState<LayerVis>({ tiles: true, outlines: true, image: true, features: true, boundary: true, opacity: 0.75 });
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
      <MapContainer center={[target.lat, target.lon]} zoom={START_ZOOM} style={{ height: '100%', width: '100%' }}>
        {basemap && vis.outlines && (
          // Below the tile pane (z-index 200): online tiles cover it when they load.
          <Pane name="offline-basemap" style={{ zIndex: 150 }}>
            <GeoJSON data={basemap.land} style={{ stroke: false, fillColor: '#15202b', fillOpacity: 1 }} interactive={false} />
            <GeoJSON data={basemap.borders} style={{ color: '#3a5068', weight: 0.8, opacity: 0.9 }} interactive={false} />
          </Pane>
        )}
        {!__TERRAX_PREVIEW__ && vis.tiles && (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            subdomains="abcd"
            maxZoom={19}
          />
        )}
        {image && vis.image && <ImageOverlay key={image.url.length + image.label} url={image.url} bounds={image.bounds} opacity={vis.opacity} className="pixelated-overlay" />}
        {boundary && vis.boundary && (
          <GeoJSON key={`b-${boundary.name}-${boundary.areaM2}`} data={boundary.geojson} style={{ color: '#f5b83d', weight: 2, dashArray: '6 4', fill: false }} interactive={false} />
        )}
        {bounds && !geojson && vis.features && <Rectangle bounds={bounds} pathOptions={{ color: '#5ab0f0', weight: 2, fillOpacity: 0.2 }} />}
        {geojson && vis.features && (
          <GeoJSON
            key={JSON.stringify(bounds)}
            data={geojson}
            style={{ color: '#5ab0f0', weight: 2, fillColor: '#5ab0f0', fillOpacity: 0.18 }}
            pointToLayer={(_f, latlng) => L.circleMarker(latlng, { radius: 5, color: '#5ab0f0', weight: 2, fillOpacity: 0.6 })}
          />
        )}
        {draw && <DrawLayer draw={draw} />}
        <FitToBounds bounds={bounds} />
      </MapContainer>
      <div className="map-layers">
        <button type="button" className="map-layers-toggle" aria-expanded={panelOpen} aria-controls="map-layers-panel" onClick={() => setPanelOpen(o => !o)}>
          Layers
        </button>
        {panelOpen && (
          <div id="map-layers-panel" className="map-layers-panel">
            {!__TERRAX_PREVIEW__ && (
              <label className="check">
                <input type="checkbox" checked={vis.tiles} onChange={() => toggle('tiles')} /> Street basemap (online)
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
            {image && <p className="field-hint">The overlay is stretched over the raster’s bounding box, not reprojected, so it is approximate at the edges.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
