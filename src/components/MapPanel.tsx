import { useEffect, useState } from 'react';
import { GeoJSON, MapContainer, Pane, Rectangle, TileLayer, useMap } from 'react-leaflet';
import type { FeatureCollection, MultiLineString } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { RasterDataset } from '../lib/types';

interface Props {
  raster: RasterDataset | null;
  target: { lat: number; lon: number; name: string };
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

// Without tiles (the sandboxed preview) the 1:50m basemap has no detail at
// city scale, so open at a regional view there.
const START_ZOOM = __TERRAX_PREVIEW__ ? 5 : 10;

export default function MapPanel({ raster, target }: Props) {
  const bounds = raster?.latLngBounds ?? null;
  const [basemap, setBasemap] = useState<Basemap | null>(null);

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
        {basemap && (
          // Below the tile pane (z-index 200): online tiles cover it when they load.
          <Pane name="offline-basemap" style={{ zIndex: 150 }}>
            <GeoJSON data={basemap.land} style={{ stroke: false, fillColor: '#15202b', fillOpacity: 1 }} interactive={false} />
            <GeoJSON data={basemap.borders} style={{ color: '#3a5068', weight: 0.8, opacity: 0.9 }} interactive={false} />
          </Pane>
        )}
        {!__TERRAX_PREVIEW__ && (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            subdomains="abcd"
            maxZoom={19}
          />
        )}
        {bounds && <Rectangle bounds={bounds} pathOptions={{ color: '#5ab0f0', weight: 2, fillOpacity: 0.2 }} />}
        <FitToBounds bounds={bounds} />
      </MapContainer>
    </div>
  );
}
