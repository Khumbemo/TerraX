// Data and helpers for TerraX's built-in world maps (public/data/maps/, made by
// scripts/make-world-maps.py). Pure functions only, so they can be unit-tested.

export interface ClassInfo {
  code: string;
  name: string;
  color: string;
}

const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/** Köppen–Geiger classes with the colours of Beck et al. (2018), indexed by raster value − 1 (see the build script). */
const KOPPEN_DEFS: Record<string, [string, [number, number, number]]> = {
  Af: ['Tropical rainforest', [0, 0, 255]],
  Am: ['Tropical monsoon', [0, 120, 255]],
  Aw: ['Tropical savanna, dry winter', [70, 170, 250]],
  BWh: ['Hot desert', [255, 0, 0]],
  BWk: ['Cold desert', [255, 150, 150]],
  BSh: ['Hot semi-arid (steppe)', [245, 165, 0]],
  BSk: ['Cold semi-arid (steppe)', [255, 220, 100]],
  Csa: ['Temperate, dry hot summer (Mediterranean)', [255, 255, 0]],
  Csb: ['Temperate, dry warm summer', [200, 200, 0]],
  Csc: ['Temperate, dry cold summer', [150, 150, 0]],
  Cwa: ['Temperate, dry winter, hot summer', [150, 255, 150]],
  Cwb: ['Temperate, dry winter, warm summer', [100, 200, 100]],
  Cwc: ['Temperate, dry winter, cold summer', [50, 150, 50]],
  Cfa: ['Temperate, no dry season, hot summer', [200, 255, 80]],
  Cfb: ['Temperate, no dry season, warm summer (oceanic)', [100, 255, 80]],
  Cfc: ['Temperate, no dry season, cold summer', [50, 200, 0]],
  Dsa: ['Cold, dry hot summer', [255, 0, 255]],
  Dsb: ['Cold, dry warm summer', [200, 0, 200]],
  Dsc: ['Cold, dry cold summer', [150, 50, 150]],
  Dsd: ['Cold, dry summer, very cold winter', [150, 100, 150]],
  Dwa: ['Cold, dry winter, hot summer', [170, 175, 255]],
  Dwb: ['Cold, dry winter, warm summer', [90, 120, 220]],
  Dwc: ['Cold, dry winter, cold summer', [75, 80, 180]],
  Dwd: ['Cold, dry winter, very cold winter', [50, 0, 135]],
  Dfa: ['Cold, no dry season, hot summer', [0, 255, 255]],
  Dfb: ['Cold, no dry season, warm summer', [55, 200, 255]],
  Dfc: ['Cold, no dry season, cold summer (subarctic)', [0, 125, 125]],
  Dfd: ['Cold, no dry season, very cold winter', [0, 70, 95]],
  ET: ['Polar tundra', [178, 178, 178]],
  EF: ['Polar ice cap', [102, 102, 102]],
};
const KOPPEN_VALUES = ['Af', 'Am', 'Aw', 'Cwc', 'BSh', 'Cwb', 'Cwa', 'BWh', 'Cfa', 'Csb', 'Dsa', 'Csc', 'Cfb', 'Csa', 'BWk', 'Dsb', 'BSk', 'Dwa', 'Dfa', 'Dwb', 'Cfc', 'Dfb', 'Dwc', 'ET', 'Dfc', 'Dsc', 'Dwd', 'Dfd', 'Dsd', 'EF'];

/** Raster value v (1-based) is KOPPEN[v - 1]. */
export const KOPPEN: ClassInfo[] = KOPPEN_VALUES.map(code => ({ code, name: KOPPEN_DEFS[code][0], color: rgb(...KOPPEN_DEFS[code][1]) }));
/** Legend order: the conventional A, B, C, D, E sequence. */
export const KOPPEN_LEGEND: ClassInfo[] = Object.keys(KOPPEN_DEFS).map(code => KOPPEN.find(k => k.code === code)!);

/** RESOLVE Ecoregions 2017 biomes (Dinerstein et al. 2017), in raster order; colours are TerraX's own. */
export const BIOMES: ClassInfo[] = (
  [
    ['Tropical & subtropical moist broadleaf forests', [38, 115, 0]],
    ['Mangroves', [230, 0, 169]],
    ['Tropical & subtropical grasslands, savannas & shrublands', [204, 204, 102]],
    ['Tropical & subtropical dry broadleaf forests', [152, 196, 82]],
    ['Flooded grasslands & savannas', [115, 223, 255]],
    ['Tropical & subtropical coniferous forests', [90, 160, 90]],
    ['Deserts & xeric shrublands', [232, 196, 140]],
    ['Montane grasslands & shrublands', [200, 150, 110]],
    ['Mediterranean forests, woodlands & scrub', [255, 120, 60]],
    ['Temperate grasslands, savannas & shrublands', [245, 230, 120]],
    ['Temperate broadleaf & mixed forests', [60, 180, 110]],
    ['Temperate conifer forests', [0, 120, 110]],
    ['Boreal forests/taiga', [100, 150, 200]],
    ['Tundra', [180, 200, 220]],
    ['Rock & ice', [240, 240, 245]],
  ] as [string, [number, number, number]][]
).map(([name, c], i) => ({ code: String(i + 1), name, color: rgb(...c) }));

/** Boundary classes of Bird (2003), Table 1. */
export const PLATE_CLASSES: Record<string, { name: string; color: string; dash?: string }> = {
  SUB: { name: 'Subduction zone', color: '#ef4444' },
  OCB: { name: 'Oceanic convergent boundary', color: '#f97316' },
  CCB: { name: 'Continental convergent boundary (collision)', color: '#fb923c', dash: '5 3' },
  OSR: { name: 'Oceanic spreading ridge', color: '#22d3ee' },
  CRB: { name: 'Continental rift boundary', color: '#a78bfa', dash: '5 3' },
  OTF: { name: 'Oceanic transform fault', color: '#facc15' },
  CTF: { name: 'Continental transform fault', color: '#fde047', dash: '5 3' },
};

/** The 52 plates of the PB2002 model (Bird 2003). */
export const PLATES: Record<string, string> = {
  AF: 'Africa', AM: 'Amur', AN: 'Antarctica', AP: 'Altiplano', AR: 'Arabia', AS: 'Aegean Sea', AT: 'Anatolia', AU: 'Australia',
  BH: 'Birds Head', BR: 'Balmoral Reef', BS: 'Banda Sea', BU: 'Burma', CA: 'Caribbean', CL: 'Caroline', CO: 'Cocos', CR: 'Conway Reef',
  EA: 'Easter', EU: 'Eurasia', FT: 'Futuna', GP: 'Galápagos', IN: 'India', JF: 'Juan de Fuca', JZ: 'Juan Fernández', KE: 'Kermadec',
  MA: 'Mariana', MN: 'Manus', MO: 'Maoke', MS: 'Molucca Sea', NA: 'North America', NB: 'North Bismarck', ND: 'North Andes', NH: 'New Hebrides',
  NI: 'Niuafo’ou', NZ: 'Nazca', OK: 'Okhotsk', ON: 'Okinawa', PA: 'Pacific', PM: 'Panama', PS: 'Philippine Sea', RI: 'Rivera',
  SA: 'South America', SB: 'South Bismarck', SC: 'Scotia', SL: 'Shetland', SO: 'Somalia', SS: 'Solomon Sea', SU: 'Sunda', SW: 'Sandwich',
  TI: 'Timor', TO: 'Tonga', WL: 'Woodlark', YA: 'Yangtze',
};

/** "AF-AN" (or with / or \ for subduction polarity) → "Africa – Antarctica". */
export function platePair(code: string): string {
  return code
    .split(/[-/\\]/)
    .map(c => PLATES[c] ?? c)
    .join(' – ');
}

/**
 * Mean obliquity of the ecliptic (IAU 2006, Capitaine et al. 2003), in degrees.
 * The tropics lie at ±ε and the polar circles at ±(90° − ε).
 */
export function obliquityDeg(date: Date): number {
  const T = (date.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0) / 36_525;
  const arcsec = 84_381.406 - 46.836769 * T - 0.0001831 * T ** 2 + 0.0020034 * T ** 3 - 0.000000576 * T ** 4 - 0.0000000434 * T ** 5;
  return arcsec / 3600;
}

/** Highest latitude a square Web Mercator world reaches. */
export const MERCATOR_MAX_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

/** Pixel (column, row) in a square Web Mercator world image of `size` pixels, or null outside ±85.05°. */
export function mercatorPixel(lat: number, lon: number, size: number): [number, number] | null {
  if (!(Math.abs(lat) < MERCATOR_MAX_LAT)) return null;
  const x = ((((lon + 180) % 360) + 360) % 360) / 360;
  const phi = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
  return [Math.min(size - 1, Math.floor(x * size)), Math.min(size - 1, Math.floor(y * size))];
}

/** Class index (1-based) whose colour is nearest to an RGBA sample; 0 for transparent (no data). */
export function classFromColor(r: number, g: number, b: number, a: number, classes: ClassInfo[]): number {
  if (a < 128) return 0;
  let best = 0, bestD = Infinity;
  classes.forEach((c, i) => {
    const [cr, cg, cb] = c.color.match(/\d+/g)!.map(Number);
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  });
  return best;
}

/** URL of a built-in map file, relative to the app so it works under any base path. */
export const worldMapUrl = (file: string) => new URL(`data/maps/${file}`, document.baseURI).href;
