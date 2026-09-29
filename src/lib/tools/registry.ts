import type { FeatureCollection } from 'geojson';
import type { LatLngBounds } from '../geo';
import type { Dataset } from '../types';

export type ToolId = 'forest' | 'carbon' | 'survey' | 'residential' | 'weather' | 'satellite' | 'landcover' | 'terrain' | 'photo';

export interface ToolInfo {
  id: ToolId;
  name: string;
  /** Short label for the card's category line. */
  group: string;
  summary: string;
  measures: string[];
  formats: string;
  /** A two-letter mark drawn on the card instead of an emoji. */
  mark: string;
}

export const TOOLS: ToolInfo[] = [
  {
    id: 'forest',
    name: 'Forest loss',
    group: 'Forestry',
    summary: 'Estimate where and how much forest was lost between two dates.',
    measures: ['Forest area, loss and regrowth in hectares', 'Hansen loss by year · dNBR burn severity', 'Minimum mapping unit and loss polygons'],
    formats: 'Two NDVI or Red/NIR GeoTIFFs · Hansen lossyear GeoTIFF',
    mark: 'Fo',
  },
  {
    id: 'carbon',
    name: 'Carbon & biomass',
    group: 'Forestry',
    summary: 'Estimate tree biomass, carbon stock and CO₂ from a field inventory.',
    measures: ['Biomass and carbon per hectare with 95 % CI', 'Chave 2014 allometry, IPCC root:shoot', 'Basal area, stems and species shares'],
    formats: 'Forest-Capture CSV · CSV with DBH/GBH and height',
    mark: 'Cb',
  },
  {
    id: 'survey',
    name: 'Land survey',
    group: 'Survey',
    summary: 'Measure a plot boundary, walked traverse or set of points.',
    measures: ['Area (m², ha, acres) and perimeter', 'Leg distances and bearings', 'UTM and DMS coordinates'],
    formats: 'GeoJSON · KML · GPX · CSV (lat/lon) · zipped Shapefile',
    mark: 'Ls',
  },
  {
    id: 'residential',
    name: 'Residential plot',
    group: 'Property',
    summary: 'Compare past and current images of your plot to spot encroachment and neighbouring expansion.',
    measures: ['Past vs current swipe view on your boundary', 'Changes crossing the boundary: area and depth', 'Year-by-year timeline and GeoJSON export'],
    formats: 'GeoTIFF images + boundary · or same-view JPG/PNG',
    mark: 'Rp',
  },
  {
    id: 'weather',
    name: 'Weather & climate',
    group: 'Climate',
    summary: 'Analyse rainfall, temperature, humidity, soil moisture, ET and radiation series.',
    measures: ['Trend test and seasonal cycle', 'IMD rainfall categories and rainy days', 'Soil-moisture and humidity classes'],
    formats: 'CSV · TSV · XLSX · climate GeoTIFF',
    mark: 'Wc',
  },
  {
    id: 'satellite',
    name: 'Satellite imagery',
    group: 'Remote sensing',
    summary: 'Explore multispectral scenes and compute spectral indices.',
    measures: ['Composites, stretch and pixel inspector', 'NDVI, EVI, SAVI, NDWI, NDMI, NBR, NDBI with cloud masks', 'Multi-date index series and trend'],
    formats: 'Multiband GeoTIFF · index time series CSV/XLSX',
    mark: 'Si',
  },
  {
    id: 'landcover',
    name: 'Land cover',
    group: 'Remote sensing',
    summary: 'Group pixels into spectral classes, name them and measure their areas.',
    measures: ['k-means clusters on chosen bands', 'Area and share per class', 'Editable class names and CSV export'],
    formats: 'Multiband GeoTIFF',
    mark: 'Lc',
  },
  {
    id: 'terrain',
    name: 'Terrain',
    group: 'Elevation',
    summary: 'Derive slope, aspect, relief, streams and watersheds from an elevation model.',
    measures: ['Slope, aspect, hillshade and relief', 'Streams, Strahler order and watersheds', 'Contours (GeoJSON)'],
    formats: 'DEM GeoTIFF (SRTM, ASTER, Copernicus)',
    mark: 'Te',
  },
  {
    id: 'photo',
    name: 'Space & aerial photos',
    group: 'Imagery',
    summary: 'Estimate green cover in images from satellites, drones or the ISS.',
    measures: ['Vegetation cover (ExG + Otsu) and VARI', 'EXIF GPS location on the map', 'Compare two photos'],
    formats: 'JPG · PNG · WebP',
    mark: 'Ph',
  },
];

export function toolInfo(id: ToolId): ToolInfo {
  return TOOLS.find(t => t.id === id)!;
}

/** What a tool hands back to the app: report text, AI context and map layers. */
export interface ToolOutput {
  tool: ToolId;
  /** Name of the analysed file(s), used for report titles. */
  name: string;
  /** Computed results as Markdown (the local report). */
  markdown: string;
  /** Extra context for the AI (e.g. a data sample); markdown is always included. */
  extraContext?: string;
  /** Present for table/raster datasets so assistants can answer from statistics offline. */
  dataset?: Dataset;
  focus?: string | null;
  map?: { bounds?: LatLngBounds | null; geojson?: FeatureCollection | null; image?: MapImage | null };
}

/** A result picture placed on the map over the raster footprint. */
export interface MapImage {
  url: string;
  bounds: LatLngBounds;
  label: string;
  legend: { color: string; label: string }[];
}
