import { useEffect } from 'react';
import { MapContainer, Rectangle, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { RasterDataset } from '../lib/types';

interface Props {
  raster: RasterDataset | null;
  target: { lat: number; lon: number; name: string };
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

export default function MapPanel({ raster, target }: Props) {
  const bounds = raster?.latLngBounds ?? null;

  return (
    <div className="map-container">
      <MapContainer center={[target.lat, target.lon]} zoom={10} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
        />
        {bounds && <Rectangle bounds={bounds} pathOptions={{ color: '#5ab0f0', weight: 2, fillOpacity: 0.2 }} />}
        <FitToBounds bounds={bounds} />
      </MapContainer>
    </div>
  );
}
