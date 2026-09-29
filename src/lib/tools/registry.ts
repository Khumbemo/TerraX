import type { FeatureCollection } from 'geojson';
import type { LatLngBounds } from '../geo';
import type { Dataset } from '../types';

export type ToolId = 'forest' | 'survey' | 'weather' | 'satellite' | 'terrain' | 'photo';

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
    measures: ['Forest area and loss in hectares', 'Loss share and regrowth', 'Hansen loss by year'],
    formats: 'Two NDVI or Red/NIR GeoTIFFs · Hansen lossyear GeoTIFF',
    mark: 'Fo',
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
    measures: ['True and false-colour composites', 'NDVI, EVI, SAVI, NDWI, NDMI, NBR, NDBI', 'Vegetation-index time series'],
    formats: 'Multiband GeoTIFF · index time series CSV/XLSX',
    mark: 'Si',
  },
  {
    id: 'terrain',
    name: 'Terrain',
    group: 'Elevation',
    summary: 'Derive slope, aspect and relief from an elevation model.',
    measures: ['Slope classes and aspect', 'Hillshade', 'Relief and hypsometric integral'],
    formats: 'DEM GeoTIFF (SRTM, ASTER, Copernicus)',
    mark: 'Te',
  },
  {
    id: 'photo',
    name: 'Space & aerial photos',
    group: 'Imagery',
    summary: 'Estimate green cover in images from satellites, drones or the ISS.',
    measures: ['Vegetation cover (ExG + Otsu)', 'VARI greenness', 'Colour and brightness statistics'],
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
