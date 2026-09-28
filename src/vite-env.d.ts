/// <reference types="vite/client" />

/** True in the single-file preview build (no server, sandboxed network). */
declare const __TERRAX_PREVIEW__: boolean;

declare module 'world-atlas/land-110m.json' {
  const topology: import('topojson-specification').Topology;
  export default topology;
}
declare module 'world-atlas/countries-110m.json' {
  const topology: import('topojson-specification').Topology;
  export default topology;
}
declare module 'world-atlas/countries-50m.json' {
  const topology: import('topojson-specification').Topology;
  export default topology;
}
declare module 'shpjs' {
  import type { FeatureCollection } from 'geojson';
  type Out = FeatureCollection & { fileName?: string };
  export default function shp(input: ArrayBuffer | string): Promise<Out | Out[]>;
}
