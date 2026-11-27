import { geoGraticule10, geoOrthographic, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { FeatureCollection } from 'geojson';
import type { Topology, GeometryCollection } from 'topojson-specification';
import { LOGO } from '../components/LogoMark';

/** Natural Earth 1:110m land (world-atlas) as GeoJSON. */
export function landFrom(topo: unknown): FeatureCollection {
  const t = topo as Topology<{ land: GeometryCollection }>;
  return feature(t, t.objects.land) as FeatureCollection;
}

const round = (s: string) => s.replace(/\d+\.\d+/g, n => (+n).toFixed(1));

/** Land and graticule paths for the logo globe seen from `rotate` ([−lon, −lat]). */
export function globePaths(land: FeatureCollection, rotate: [number, number] = LOGO.view): { land: string; graticule: string } {
  const projection = geoOrthographic().scale(LOGO.r).translate([256, 256]).rotate(rotate).clipAngle(90).precision(0.4);
  const path = geoPath(projection);
  return { land: round(path(land) ?? ''), graticule: round(path(geoGraticule10()) ?? '') };
}
