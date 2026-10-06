/// <reference types="vite/client" />

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

declare module 'world-atlas/land-50m.json' {
  const topology: import('topojson-specification').Topology;
  export default topology;
}

interface ImportMetaEnv {
  /** Base URL of the TerraX API when it is not on the same origin (default: same origin, /api). */
  readonly VITE_API_BASE?: string;
}
