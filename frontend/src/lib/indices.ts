// Spectral indices with their published definitions (computed on the server, processing/indices.py).
import type { BandRole, SpectralIndex } from './types';

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
}

export const INDICES: IndexDef[] = [
  {
    id: 'ndvi',
    name: 'NDVI — vegetation',
    formula: '(NIR − Red) / (NIR + Red)',
    reference: 'Rouse et al. (1974)',
    needs: ['nir', 'red'],
    needsReflectance: false,
    reading: 'Higher values mean denser, greener vegetation; water and bare surfaces are near or below 0.',
  },
  {
    id: 'evi',
    name: 'EVI — vegetation (less saturation)',
    formula: '2.5 (NIR − Red) / (NIR + 6 Red − 7.5 Blue + 1)',
    reference: 'Huete et al. (2002)',
    needs: ['nir', 'red', 'blue'],
    needsReflectance: true,
    reading: 'Like NDVI but less saturated over dense canopy; typical vegetated range 0.2–0.8.',
  },
  {
    id: 'savi',
    name: 'SAVI — vegetation on bright soil',
    formula: '1.5 (NIR − Red) / (NIR + Red + 0.5)',
    reference: 'Huete (1988), L = 0.5',
    needs: ['nir', 'red'],
    needsReflectance: true,
    reading: 'Reduces soil-brightness effects where vegetation cover is sparse.',
  },
  {
    id: 'ndwi',
    name: 'NDWI — open water',
    formula: '(Green − NIR) / (Green + NIR)',
    reference: 'McFeeters (1996)',
    needs: ['green', 'nir'],
    needsReflectance: false,
    reading: 'Positive values usually indicate open water.',
  },
  {
    id: 'ndmi',
    name: 'NDMI — vegetation moisture',
    formula: '(NIR − SWIR1) / (NIR + SWIR1)',
    reference: 'Gao (1996)',
    needs: ['nir', 'swir1'],
    needsReflectance: false,
    reading: 'Higher values mean more water in the canopy; low values indicate water stress.',
  },
  {
    id: 'nbr',
    name: 'NBR — burn severity',
    formula: '(NIR − SWIR2) / (NIR + SWIR2)',
    reference: 'Key & Benson (2006)',
    needs: ['nir', 'swir2'],
    needsReflectance: false,
    reading: 'Healthy vegetation is high; recently burned areas are low. Compare dates (dNBR) to map burn severity.',
  },
  {
    id: 'ndbi',
    name: 'NDBI — built-up areas',
    formula: '(SWIR1 − NIR) / (SWIR1 + NIR)',
    reference: 'Zha et al. (2003)',
    needs: ['swir1', 'nir'],
    needsReflectance: false,
    reading: 'Positive values often indicate built-up or bare surfaces.',
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
