import { useEffect, useMemo } from 'react';
import { CircleMarker, GeoJSON, ImageOverlay, MapContainer, Pane, Rectangle, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { feature } from 'topojson-client';
import countries from 'world-atlas/countries-110m.json';
import 'leaflet/dist/leaflet.css';
import { paintGrid } from '../lib/colormap';
import type { RasterDataset } from '../lib/types';

interface Props {
  raster: RasterDataset | null;
  target: { lat: number; lon: number; name: string };
}

// Natural Earth 1:110m country outlines, bundled so the map works offline.
const WORLD = feature(countries, countries.objects.countries);

function FitToBounds({ bounds }: { bounds: [[number, number], [number, number]] | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  }, [map, bounds]);
  return null;
}

export default function MapPanel({ raster, target }: Props) {
  const bounds = raster?.latLngBounds ?? null;

  const overlayUrl = useMemo(() => {
    if (!raster?.latLngBounds || !raster.stats) return null;
    const canvas = document.createElement('canvas');
    paintGrid(canvas, raster.preview.data, raster.preview.width, raster.preview.height, raster.stats.min, raster.stats.max);
    return canvas.toDataURL('image/png');
  }, [raster]);

  return (
    <div className="map-container">
      <MapContainer center={[target.lat, target.lon]} zoom={8} minZoom={2} worldCopyJump style={{ height: '100%', width: '100%' }}>
        {/* Below the tile pane (z-index 200) so tiles and overlays draw on top. */}
        <Pane name="world-outline" style={{ zIndex: 150 }}>
          <GeoJSON data={WORLD} style={{ color: '#2c4a66', weight: 0.8, fillColor: '#0c1a2a', fillOpacity: 1 }} interactive={false} />
        </Pane>
        {!__TERRAX_PREVIEW__ && (
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            subdomains="abcd"
            maxZoom={19}
          />
        )}
        {bounds && overlayUrl && <ImageOverlay url={overlayUrl} bounds={bounds} opacity={0.8} className="pixelated" />}
        {bounds && <Rectangle bounds={bounds} pathOptions={{ color: '#38bdf8', weight: 1.5, fillOpacity: 0 }} />}
        <CircleMarker center={[target.lat, target.lon]} radius={5} pathOptions={{ color: '#34d399', fillColor: '#34d399', fillOpacity: 0.9 }}>
          <Tooltip>{target.name}</Tooltip>
        </CircleMarker>
        <FitToBounds bounds={bounds} />
      </MapContainer>
    </div>
  );
}
