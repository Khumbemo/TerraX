// Spectral indices with their published definitions.
import type { BandMap, BandRole, SpectralIndex } from './types';

export interface IndexDef {
  id: SpectralIndex;
  name: string;
  formula: string;
  reference: string;
  needs: BandRole[];
  /** Uses absolute reflectance (not a pure ratio), so scaled integers must be converted first. */
  needsReflectance: boolean;
  /** What high values mean, for the reader. */
  reading: string;
  compute: (b: Record<BandRole, number>) => number;
}

const nd = (a: number, b: number) => (a + b === 0 ? NaN : (a - b) / (a + b));

export const INDICES: IndexDef[] = [
  {
    id: 'ndvi',
    name: 'NDVI — vegetation',
    formula: '(NIR − Red) / (NIR + Red)',
    reference: 'Rouse et al. (1974)',
    needs: ['nir', 'red'],
    needsReflectance: false,
    reading: 'Higher values mean denser, greener vegetation; water and bare surfaces are near or below 0.',
    compute: b => nd(b.nir, b.red),
  },
  {
    id: 'evi',
    name: 'EVI — vegetation (less saturation)',
    formula: '2.5 (NIR − Red) / (NIR + 6 Red − 7.5 Blue + 1)',
    reference: 'Huete et al. (2002)',
    needs: ['nir', 'red', 'blue'],
    needsReflectance: true,
    reading: 'Like NDVI but less saturated over dense canopy; typical vegetated range 0.2–0.8.',
    compute: b => {
      const d = b.nir + 6 * b.red - 7.5 * b.blue + 1;
      return d === 0 ? NaN : (2.5 * (b.nir - b.red)) / d;
    },
  },
  {
    id: 'savi',
    name: 'SAVI — vegetation on bright soil',
    formula: '1.5 (NIR − Red) / (NIR + Red + 0.5)',
    reference: 'Huete (1988), L = 0.5',
    needs: ['nir', 'red'],
    needsReflectance: true,
    reading: 'Reduces soil-brightness effects where vegetation cover is sparse.',
    compute: b => {
      const d = b.nir + b.red + 0.5;
      return d === 0 ? NaN : (1.5 * (b.nir - b.red)) / d;
    },
  },
  {
    id: 'ndwi',
    name: 'NDWI — open water',
    formula: '(Green − NIR) / (Green + NIR)',
    reference: 'McFeeters (1996)',
    needs: ['green', 'nir'],
    needsReflectance: false,
    reading: 'Positive values usually indicate open water.',
    compute: b => nd(b.green, b.nir),
  },
  {
    id: 'ndmi',
    name: 'NDMI — vegetation moisture',
    formula: '(NIR − SWIR1) / (NIR + SWIR1)',
    reference: 'Gao (1996)',
    needs: ['nir', 'swir1'],
    needsReflectance: false,
    reading: 'Higher values mean more water in the canopy; low values indicate water stress.',
    compute: b => nd(b.nir, b.swir1),
  },
  {
    id: 'nbr',
    name: 'NBR — burn severity',
    formula: '(NIR − SWIR2) / (NIR + SWIR2)',
    reference: 'Key & Benson (2006)',
    needs: ['nir', 'swir2'],
    needsReflectance: false,
    reading: 'Healthy vegetation is high; recently burned areas are low. Compare dates (dNBR) to map burn severity.',
    compute: b => nd(b.nir, b.swir2),
  },
  {
    id: 'ndbi',
    name: 'NDBI — built-up areas',
    formula: '(SWIR1 − NIR) / (SWIR1 + NIR)',
    reference: 'Zha et al. (2003)',
    needs: ['swir1', 'nir'],
    needsReflectance: false,
    reading: 'Positive values often indicate built-up or bare surfaces.',
    compute: b => nd(b.swir1, b.nir),
  },
];

export const BAND_ROLES: { role: BandRole; label: string; s2: string; l8: string }[] = [
  { role: 'blue', label: 'Blue', s2: 'B2', l8: 'B2' },
  { role: 'green', label: 'Green', s2: 'B3', l8: 'B3' },
  { role: 'red', label: 'Red', s2: 'B4', l8: 'B4' },
  { role: 'nir', label: 'NIR', s2: 'B8', l8: 'B5' },
  { role: 'swir1', label: 'SWIR 1', s2: 'B11', l8: 'B6' },
  { role: 'swir2', label: 'SWIR 2', s2: 'B12', l8: 'B7' },
];

export function indexDef(id: SpectralIndex): IndexDef {
  return INDICES.find(i => i.id === id)!;
}

export function missingBands(id: SpectralIndex, map: BandMap): BandRole[] {
  return indexDef(id).needs.filter(r => map[r] === undefined);
}

/**
 * Guesses band roles from the band count, for common export orders.
 * Always shown to the user for confirmation.
 */
export function guessBandMap(bands: number): BandMap {
  if (bands === 2) return { red: 0, nir: 1 }; // e.g. Sentinel-2 B4, B8 (TerraX GEE manual)
  if (bands === 4) return { blue: 0, green: 1, red: 2, nir: 3 }; // B2, B3, B4, B8
  if (bands >= 6) return { blue: 0, green: 1, red: 2, nir: 3, swir1: 4, swir2: 5 }; // B2, B3, B4, B8, B11, B12
  if (bands === 3) return { red: 0, green: 1, blue: 2 };
  return {};
}
