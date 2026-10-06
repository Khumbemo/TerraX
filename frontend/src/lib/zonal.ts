// The analysis boundary: polygons that limit raster analyses on the server
// (processing/zonal.py), drawn on the map and saved with projects.
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export interface Boundary {
  name: string;
  /** Polygons only, WGS84 longitude/latitude. */
  geojson: FeatureCollection<Polygon | MultiPolygon>;
  /** Area in m² (from the survey measurement). */
  areaM2: number;
}
