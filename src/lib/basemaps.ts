// Catalogue of free maps TerraX can show. URL templates for OpenStreetMap,
// OpenTopoMap, CARTO, Stadia, MapTiler and Esri follow leaflet-providers 4.0
// (the community-maintained list of tile URLs). NASA GIBS and EOX layers list
// a second URL form that is tried automatically if the first does not load.
// Terms change; each entry links to the provider's own terms.

export type MapKind = 'none' | 'raster' | 'vector' | 'pmtiles' | 'wms';
export type MapGroup = 'Offline' | 'Street maps' | 'Vector maps' | 'Terrain' | 'Satellite' | 'Night lights' | 'Your own';
export type KeyName = 'stadia' | 'maptiler';

export interface MapDef {
  id: string;
  name: string;
  group: MapGroup;
  kind: MapKind;
  /** Tile URL templates, tried in order ({s}, {z}, {x}, {y}, {r}, {key}, {time} are filled in). */
  urls?: string[];
  /** MapLibre style URL for vector maps. */
  style?: string;
  subdomains?: string;
  maxZoom?: number;
  /** Highest zoom the server has; Leaflet enlarges tiles above it. */
  maxNativeZoom?: number;
  tileSize?: number;
  zoomOffset?: number;
  attribution: string;
  needsKey?: KeyName;
  /** Uses the daily date from the map settings. */
  daily?: boolean;
  /** Short note on licence or usage terms. */
  terms: string;
  termsUrl?: string;
  /** Shown with a light surround (affects the map frame colour). */
  light?: boolean;
  /** Mostly transparent; meant to sit on top of another map. */
  overlayOnly?: boolean;
}

const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO = `${OSM} &copy; <a href="https://carto.com/attributions">CARTO</a>`;
const STADIA = '&copy; <a href="https://www.stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> ' + OSM;
const STAMEN = '&copy; <a href="https://www.stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.stamen.com/">Stamen Design</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> ' + OSM;
const MAPTILER = '<a href="https://www.maptiler.com/copyright/">&copy; MapTiler</a> ' + OSM;
const GIBS =
  'Imagery: NASA <a href="https://earthdata.nasa.gov/gibs">Global Imagery Browse Services (GIBS)</a>, ESDIS';
const EOX = (year: number) => `<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data ${year})`;

const carto = (id: string, name: string, variant: string, light: boolean, overlayOnly = false): MapDef => ({
  id,
  name,
  group: 'Street maps',
  kind: 'raster',
  urls: [`https://{s}.basemaps.cartocdn.com/${variant}/{z}/{x}/{y}{r}.png`],
  subdomains: 'abcd',
  maxZoom: 20,
  attribution: CARTO,
  terms: 'Free with limits; commercial use needs a CARTO licence.',
  termsUrl: 'https://carto.com/basemaps',
  light,
  overlayOnly,
});

const stadia = (id: string, name: string, variant: string, opts: Partial<MapDef> = {}): MapDef => ({
  id,
  name,
  group: 'Street maps',
  kind: 'raster',
  urls: [`https://tiles.stadiamaps.com/tiles/${variant}/{z}/{x}/{y}{r}.png?api_key={key}`],
  maxZoom: 20,
  attribution: STADIA,
  needsKey: 'stadia',
  terms: 'Free tier for non-commercial use; needs a Stadia account (an API key, or your domain registered with Stadia).',
  termsUrl: 'https://stadiamaps.com/pricing',
  ...opts,
});

const maptiler = (id: string, name: string, variant: string, ext: 'png' | 'jpg', opts: Partial<MapDef> = {}): MapDef => ({
  id,
  name,
  group: 'Street maps',
  kind: 'raster',
  urls: [`https://api.maptiler.com/maps/${variant}/{z}/{x}/{y}{r}.${ext}?key={key}`],
  tileSize: 512,
  zoomOffset: -1,
  maxZoom: 21,
  attribution: MAPTILER,
  needsKey: 'maptiler',
  terms: 'Free tier with a MapTiler Cloud API key.',
  termsUrl: 'https://www.maptiler.com/cloud/pricing/',
  ...opts,
});

const gibs = (id: string, name: string, layer: string, level: number, ext: 'jpg' | 'png', time: string | null, group: MapGroup): MapDef => ({
  id,
  name,
  group,
  kind: 'raster',
  urls: [
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${time ?? '{time}'}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.${ext}`,
    `https://map1.vis.earthdata.nasa.gov/wmts-webmerc/${layer}/default/${time ?? '{time}'}/GoogleMapsCompatible_Level${level}/{z}/{y}/{x}.${ext}`,
  ],
  maxNativeZoom: level,
  maxZoom: 19,
  attribution: GIBS,
  daily: time === null,
  terms: 'NASA imagery: free and open, no key; please credit NASA GIBS.',
  termsUrl: 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api',
});

const eox = (id: string, name: string, year: number, terms: string): MapDef => ({
  id,
  name,
  group: 'Satellite',
  kind: 'raster',
  urls: [
    `https://tiles.maps.eox.at/wmts?layer=s2cloudless-${year}_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix={z}&TileCol={x}&TileRow={y}`,
    `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/g/{z}/{y}/{x}.jpg`,
  ],
  maxNativeZoom: 15,
  maxZoom: 19,
  attribution: EOX(year),
  terms,
  termsUrl: 'https://s2maps.eu',
});

export const MAPS: MapDef[] = [
  { id: 'offline', name: 'Offline outlines only (Natural Earth)', group: 'Offline', kind: 'none', attribution: 'Natural Earth (public domain)', terms: 'Built into TerraX; works without internet.' },

  carto('carto-dark', 'CARTO Dark Matter', 'dark_all', false),
  carto('carto-light', 'CARTO Positron (light)', 'light_all', true),
  carto('carto-voyager', 'CARTO Voyager', 'rastertiles/voyager', true),
  {
    id: 'osm',
    name: 'OpenStreetMap standard',
    group: 'Street maps',
    kind: 'raster',
    urls: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxZoom: 19,
    attribution: OSM,
    terms: 'Free for light use under the OSM tile usage policy; no guarantee of service.',
    termsUrl: 'https://operations.osmfoundation.org/policies/tiles/',
    light: true,
  },
  stadia('stadia-dark', 'Stadia Alidade Smooth Dark', 'alidade_smooth_dark'),
  stadia('stadia-smooth', 'Stadia Alidade Smooth', 'alidade_smooth', { light: true }),
  stadia('stadia-outdoors', 'Stadia Outdoors', 'outdoors', { light: true }),
  stadia('stamen-toner', 'Stamen Toner (via Stadia)', 'stamen_toner', { attribution: STAMEN, light: true }),
  stadia('stamen-terrain', 'Stamen Terrain (via Stadia)', 'stamen_terrain', { attribution: STAMEN, light: true, group: 'Terrain' }),
  {
    ...stadia('stamen-watercolor', 'Stamen Watercolor (via Stadia)', 'stamen_watercolor', { attribution: STAMEN, light: true }),
    urls: ['https://tiles.stadiamaps.com/tiles/stamen_watercolor/{z}/{x}/{y}.jpg?api_key={key}'],
    maxZoom: 16,
  },
  maptiler('maptiler-streets', 'MapTiler Streets', 'streets-v2', 'png', { light: true }),
  maptiler('maptiler-basic', 'MapTiler Basic', 'basic-v2', 'png', { light: true }),
  maptiler('maptiler-bright', 'MapTiler Bright', 'bright-v2', 'png', { light: true }),
  maptiler('maptiler-positron', 'MapTiler Positron', 'positron', 'png', { light: true }),
  maptiler('maptiler-hybrid', 'MapTiler Hybrid (satellite + labels)', 'hybrid', 'jpg', { group: 'Satellite' }),

  { id: 'ofm-liberty', name: 'OpenFreeMap Liberty', group: 'Vector maps', kind: 'vector', style: 'https://tiles.openfreemap.org/styles/liberty', attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> ${OSM}`, terms: 'Free, no key and no stated usage limit.', termsUrl: 'https://openfreemap.org', light: true },
  { id: 'ofm-positron', name: 'OpenFreeMap Positron', group: 'Vector maps', kind: 'vector', style: 'https://tiles.openfreemap.org/styles/positron', attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> ${OSM}`, terms: 'Free, no key and no stated usage limit.', termsUrl: 'https://openfreemap.org', light: true },
  { id: 'ofm-bright', name: 'OpenFreeMap Bright', group: 'Vector maps', kind: 'vector', style: 'https://tiles.openfreemap.org/styles/bright', attribution: `<a href="https://openfreemap.org">OpenFreeMap</a> ${OSM}`, terms: 'Free, no key and no stated usage limit.', termsUrl: 'https://openfreemap.org', light: true },
  { id: 'protomaps', name: 'Protomaps (your .pmtiles file or URL)', group: 'Vector maps', kind: 'pmtiles', attribution: `<a href="https://protomaps.com">Protomaps</a> ${OSM}`, terms: 'Self-hosted: your own PMTiles extract (vector from maps.protomaps.com/builds, or a raster/satellite extract). A local file works offline.', termsUrl: 'https://docs.protomaps.com/' },

  {
    id: 'opentopomap',
    name: 'OpenTopoMap',
    group: 'Terrain',
    kind: 'raster',
    urls: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'],
    subdomains: 'abc',
    maxZoom: 17,
    attribution: `Map data: ${OSM}, <a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)`,
    terms: 'Free under fair use (CC BY-SA); heavy use is discouraged.',
    termsUrl: 'https://opentopomap.org/about',
    light: true,
  },
  {
    id: 'esri-topo',
    name: 'Esri World Topographic',
    group: 'Terrain',
    kind: 'raster',
    urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
    terms: 'Use is governed by Esri’s terms of use, not an open licence.',
    termsUrl: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
    light: true,
  },

  {
    id: 'esri-imagery',
    name: 'Esri World Imagery',
    group: 'Satellite',
    kind: 'raster',
    urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    terms: 'Very detailed, but use is governed by Esri’s terms of use, not an open licence.',
    termsUrl: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
  },
  eox('eox-2016', 'Sentinel-2 cloudless 2016 (EOX)', 2016, 'CC BY 4.0: free, including commercial use, with credit.'),
  eox('eox-2020', 'Sentinel-2 cloudless 2020 (EOX)', 2020, 'CC BY-NC-SA 4.0: non-commercial use only.'),
  gibs('gibs-modis', 'NASA MODIS Terra true colour (daily)', 'MODIS_Terra_CorrectedReflectance_TrueColor', 9, 'jpg', null, 'Satellite'),
  gibs('gibs-viirs', 'NASA VIIRS SNPP true colour (daily)', 'VIIRS_SNPP_CorrectedReflectance_TrueColor', 9, 'jpg', null, 'Satellite'),
  gibs('gibs-blackmarble', 'NASA Black Marble 2016 (night lights)', 'VIIRS_Black_Marble', 8, 'png', '2016-01-01', 'Night lights'),
  gibs('gibs-citylights', 'NASA Earth at Night 2012 (VIIRS)', 'VIIRS_CityLights_2012', 8, 'jpg', '2012-01-01', 'Night lights'),

  carto('carto-labels-dark', 'Place labels (light text)', 'dark_only_labels', false, true),
  carto('carto-labels-light', 'Place labels (dark text)', 'light_only_labels', true, true),

  { id: 'custom-xyz', name: 'Custom tile URL (XYZ)', group: 'Your own', kind: 'raster', attribution: '', terms: 'Any {z}/{x}/{y} tile service you are allowed to use.' },
  { id: 'custom-wms', name: 'Custom WMS (e.g. ISRO Bhuvan)', group: 'Your own', kind: 'wms', attribution: '', terms: 'Any WMS service you are allowed to use, such as layers from bhuvan.nrsc.gov.in.' },
];

export const mapDef = (id: string): MapDef => MAPS.find(m => m.id === id) ?? MAPS[0];

export interface OverlaySetting {
  id: string;
  opacity: number;
}

export interface MapSettings {
  /** Base map id, or 'auto' (CARTO dark or light following the theme). */
  base: string;
  overlays: OverlaySetting[];
  keys: Partial<Record<KeyName, string>>;
  /** YYYY-MM-DD for daily NASA layers; '' = yesterday (UTC). */
  gibsDate: string;
  customXyz: { url: string; attribution: string; maxZoom: number };
  customWms: { url: string; layers: string; attribution: string; format: 'image/png' | 'image/jpeg' };
  pmtilesUrl: string;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  base: 'auto',
  overlays: [],
  keys: {},
  gibsDate: '',
  customXyz: { url: '', attribution: '', maxZoom: 19 },
  customWms: { url: '', layers: '', attribution: '', format: 'image/png' },
  pmtilesUrl: '',
};

/** Normalises stored settings (unknown ids dropped, opacities clamped). */
export function normaliseMapSettings(raw: unknown): MapSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<MapSettings>;
  const known = new Set(MAPS.map(m => m.id));
  return {
    base: r.base === 'auto' || (typeof r.base === 'string' && known.has(r.base)) ? r.base : 'auto',
    overlays: Array.isArray(r.overlays)
      ? r.overlays
          .filter(o => o && known.has(o.id) && mapDef(o.id).kind !== 'none')
          .map(o => ({ id: o.id, opacity: Math.min(1, Math.max(0.05, Number(o.opacity) || 0.7)) }))
      : [],
    keys: { ...(r.keys ?? {}) },
    gibsDate: typeof r.gibsDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.gibsDate) ? r.gibsDate : '',
    customXyz: { ...DEFAULT_MAP_SETTINGS.customXyz, ...(r.customXyz ?? {}) },
    customWms: { ...DEFAULT_MAP_SETTINGS.customWms, ...(r.customWms ?? {}) },
    pmtilesUrl: typeof r.pmtilesUrl === 'string' ? r.pmtilesUrl : '',
  };
}

/** The base map actually shown: 'auto' follows the theme. */
export function resolveBase(settings: MapSettings, theme: string): MapDef {
  if (settings.base === 'auto') return mapDef(theme === 'light' ? 'carto-light' : 'carto-dark');
  return mapDef(settings.base);
}

/** Yesterday in UTC: today’s daily NASA mosaic is usually still incomplete. */
export function gibsDefaultDate(now = new Date()): string {
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fills the non-Leaflet placeholders of a template ({key}, {time}). Returns
 * null when a required key is missing.
 */
export function fillTemplate(template: string, def: MapDef, s: MapSettings, now = new Date()): string | null {
  let url = template;
  if (url.includes('{key}')) {
    const key = def.needsKey ? s.keys[def.needsKey]?.trim() : '';
    // Stadia also accepts requests from domains registered with it, without a key.
    if (!key && def.needsKey !== 'stadia') return null;
    url = key ? url.replace('{key}', encodeURIComponent(key)) : url.replace(/[?&]api_key=\{key\}/, '');
  }
  if (url.includes('{time}')) url = url.replace('{time}', s.gibsDate || gibsDefaultDate(now));
  return url;
}

/** Tile URL templates for a map with settings applied (custom XYZ included). */
export function tileTemplates(def: MapDef, s: MapSettings, now = new Date()): string[] {
  if (def.id === 'custom-xyz') {
    const u = s.customXyz.url.trim();
    return /^https?:\/\/.+\{z\}.+\{x\}.+\{y\}|^https?:\/\/.+\{z\}.+\{y\}.+\{x\}/i.test(u) ? [u] : [];
  }
  return (def.urls ?? []).map(t => fillTemplate(t, def, s, now)).filter((t): t is string => Boolean(t));
}

/** Why a map cannot be shown yet, or null when it can. */
export function mapProblem(def: MapDef, s: MapSettings): string | null {
  if (def.kind === 'none') return null;
  if (def.id === 'custom-xyz' && !tileTemplates(def, s).length) return 'Enter a tile URL containing {z}, {x} and {y} in Settings → Map.';
  if (def.id === 'custom-wms' && (!/^https?:\/\//i.test(s.customWms.url.trim()) || !s.customWms.layers.trim())) return 'Enter the WMS address and layer name in Settings → Map.';
  if (def.needsKey === 'maptiler' && !s.keys.maptiler?.trim()) return 'MapTiler maps need a free MapTiler Cloud API key (Settings → Map).';
  if (def.kind === 'pmtiles' && !s.pmtilesUrl.trim()) return null; // a local file may be loaded instead
  return null;
}
