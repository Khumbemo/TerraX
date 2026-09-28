// Recognises common Earth-observation variables from a column name and
// assigns value classes with a stated basis. Where no recognised standard
// applies, values are split into data-driven quartiles instead of invented
// thresholds.
import type { Spacing } from './dates';
import { quantileSorted } from './stats';

export type MetricId = 'ndvi' | 'evi' | 'lst' | 'airTemp' | 'precip' | 'et' | 'solar' | 'humidity' | 'generic';

interface ClassDef {
  /** Values strictly below this bound fall in the class (the last class uses Infinity). */
  upTo: number;
  label: string;
  color: string;
}

interface Profile {
  id: MetricId;
  name: string;
  unit: string;
  basis: string;
  classes: ClassDef[];
}

const VEG = ['#8c6d4f', '#b59b6b', '#d8cf7a', '#9cc45f', '#4f9d4a', '#1f6f3a'];
const HEAT = ['#5a8fd8', '#62b5d6', '#7dc9a0', '#e3c65b', '#e88a3c', '#d0433a'];
const WET = ['#6b7280', '#bcd7ef', '#86b8e3', '#4f8fd0', '#2f6cb5', '#1f4b8f', '#172f63'];

const PROFILES: Record<Exclude<MetricId, 'generic'>, Profile> = {
  ndvi: {
    id: 'ndvi',
    name: 'NDVI',
    unit: '',
    basis: 'Indicative NDVI ranges (USGS). Thresholds vary with sensor, season and biome.',
    classes: [
      { upTo: 0, label: 'Water / non-vegetated (< 0)', color: '#5b7fa6' },
      { upTo: 0.1, label: 'Barren (0–0.1)', color: VEG[0] },
      { upTo: 0.2, label: 'Very sparse (0.1–0.2)', color: VEG[1] },
      { upTo: 0.4, label: 'Sparse to moderate (0.2–0.4)', color: VEG[2] },
      { upTo: 0.6, label: 'Moderate to dense (0.4–0.6)', color: VEG[3] },
      { upTo: Infinity, label: 'Dense (≥ 0.6)', color: VEG[5] },
    ],
  },
  evi: {
    id: 'evi',
    name: 'EVI',
    unit: '',
    basis: 'Indicative EVI ranges. EVI saturates less than NDVI, so the same canopy scores lower.',
    classes: [
      { upTo: 0.1, label: 'Very low (< 0.1)', color: VEG[0] },
      { upTo: 0.2, label: 'Low (0.1–0.2)', color: VEG[2] },
      { upTo: 0.4, label: 'Moderate (0.2–0.4)', color: VEG[3] },
      { upTo: Infinity, label: 'High (≥ 0.4)', color: VEG[5] },
    ],
  },
  lst: {
    id: 'lst',
    name: 'Land surface temperature',
    unit: '°C',
    basis: 'Descriptive temperature bands in °C (0 °C = freezing).',
    classes: tempClasses(),
  },
  airTemp: {
    id: 'airTemp',
    name: 'Air temperature',
    unit: '°C',
    basis: 'Descriptive temperature bands in °C (0 °C = freezing).',
    classes: tempClasses(),
  },
  precip: {
    id: 'precip',
    name: 'Precipitation',
    unit: 'mm',
    basis: 'India Meteorological Department 24-hour rainfall categories.',
    classes: [
      { upTo: 0.1, label: 'No rain (< 0.1 mm)', color: WET[0] },
      { upTo: 2.5, label: 'Very light (0.1–2.4 mm)', color: WET[1] },
      { upTo: 15.6, label: 'Light (2.5–15.5 mm)', color: WET[2] },
      { upTo: 64.5, label: 'Moderate (15.6–64.4 mm)', color: WET[3] },
      { upTo: 115.6, label: 'Heavy (64.5–115.5 mm)', color: WET[4] },
      { upTo: 204.5, label: 'Very heavy (115.6–204.4 mm)', color: WET[5] },
      { upTo: Infinity, label: 'Extremely heavy (≥ 204.5 mm)', color: WET[6] },
    ],
  },
  et: {
    id: 'et',
    name: 'Evapotranspiration',
    unit: 'mm/day',
    basis: 'Indicative daily ET ranges, in line with FAO-56 reference ET magnitudes.',
    classes: [
      { upTo: 1, label: 'Very low (< 1 mm/day)', color: WET[1] },
      { upTo: 3, label: 'Low (1–3 mm/day)', color: WET[2] },
      { upTo: 5, label: 'Moderate (3–5 mm/day)', color: WET[3] },
      { upTo: 7, label: 'High (5–7 mm/day)', color: WET[4] },
      { upTo: Infinity, label: 'Very high (≥ 7 mm/day)', color: WET[6] },
    ],
  },
  solar: {
    id: 'solar',
    name: 'Solar radiation',
    unit: 'MJ m⁻² day⁻¹',
    basis: 'Indicative daily global radiation ranges. Clear-sky maxima depend on latitude and season.',
    classes: [
      { upTo: 8, label: 'Low (< 8)', color: HEAT[0] },
      { upTo: 16, label: 'Moderate (8–16)', color: HEAT[2] },
      { upTo: 24, label: 'High (16–24)', color: HEAT[3] },
      { upTo: Infinity, label: 'Very high (≥ 24)', color: HEAT[5] },
    ],
  },
  humidity: {
    id: 'humidity',
    name: 'Relative humidity',
    unit: '%',
    basis: 'Descriptive relative-humidity bands.',
    classes: [
      { upTo: 30, label: 'Dry (< 30 %)', color: HEAT[4] },
      { upTo: 60, label: 'Moderate (30–60 %)', color: HEAT[3] },
      { upTo: 80, label: 'Humid (60–80 %)', color: WET[2] },
      { upTo: Infinity, label: 'Very humid (≥ 80 %)', color: WET[4] },
    ],
  },
};

function tempClasses(): ClassDef[] {
  return [
    { upTo: 0, label: 'Freezing (< 0 °C)', color: HEAT[0] },
    { upTo: 10, label: 'Cold (0–10 °C)', color: HEAT[1] },
    { upTo: 20, label: 'Cool (10–20 °C)', color: HEAT[2] },
    { upTo: 30, label: 'Warm (20–30 °C)', color: HEAT[3] },
    { upTo: 40, label: 'Hot (30–40 °C)', color: HEAT[4] },
    { upTo: Infinity, label: 'Very hot (≥ 40 °C)', color: HEAT[5] },
  ];
}

/** Splits a column name into lowercase word tokens ("Solar_Radiation_MJ" → ["solar","radiation","mj"]). */
export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function detectMetric(columnName: string): MetricId {
  const tokens = tokenize(columnName);
  const has = (...words: string[]) => tokens.some(t => words.includes(t));
  const starts = (...prefixes: string[]) => tokens.some(t => prefixes.some(p => t.startsWith(p)));
  if (has('ndvi')) return 'ndvi';
  if (has('evi', 'evi2')) return 'evi';
  if (has('lst') || (starts('land') && starts('surface') && starts('temp'))) return 'lst';
  if (starts('precip', 'rain', 'prcp') || has('pr', 'ppt')) return 'precip';
  if (starts('evapo') || has('et', 'aet', 'pet', 'eto', 'et0')) return 'et';
  if (starts('solar', 'irradian', 'radiation') || has('srad', 'ssrd', 'ghi', 'rs')) return 'solar';
  if (starts('humid') || has('rh')) return 'humidity';
  if (starts('temp') || has('t2m', 'tmean', 'tmax', 'tmin', 'tavg')) return 'airTemp';
  return 'generic';
}

/** True when the metric is one this module has named classes for (used to pick a default column). */
export function isKnownMetric(columnName: string): boolean {
  return detectMetric(columnName) !== 'generic';
}

export interface ClassBucket {
  label: string;
  color: string;
}

export interface Classification {
  metric: MetricId;
  name: string;
  /** Unit of the classified value (after any conversion). */
  unit: string;
  basis: string;
  /** Explains any conversion applied before classifying (e.g. Kelvin → °C). */
  note: string | null;
  buckets: ClassBucket[];
  /** Returns the bucket index for a raw value from the column, or -1 for non-numeric input. */
  classify: (raw: number) => number;
  /** Converts a raw value into the unit the classes use. */
  convert: (raw: number) => number;
}

const QUARTILE_COLORS = ['#3b5b7a', '#4f86a8', '#6fb3c8', '#a6dcd6'];

/**
 * Builds the classification for one column.
 * @param values finite values from the column, used for unit checks and quartiles
 * @param spacing time steps of the series in days, if it has a time axis
 */
export function buildClassification(columnName: string, values: number[], spacing: Spacing | null): Classification {
  const intervalDays = spacing?.median ?? null;
  const metric = detectMetric(columnName);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted.length ? quantileSorted(sorted, 0.5) : NaN;

  const fromProfile = (profile: Profile, convert: (v: number) => number, note: string | null, unit = profile.unit): Classification => ({
    metric: profile.id,
    name: profile.name,
    unit,
    basis: profile.basis,
    note,
    buckets: profile.classes.map(c => ({ label: c.label, color: c.color })),
    convert,
    classify: raw => {
      if (!Number.isFinite(raw)) return -1;
      const v = convert(raw);
      return profile.classes.findIndex(c => v < c.upTo);
    },
  });

  switch (metric) {
    case 'ndvi':
    case 'evi': {
      const profile = PROFILES[metric];
      // Some products store indices scaled by 10,000 (e.g. MODIS MOD13).
      if (median > 1.5 && median <= 10000) {
        return fromProfile(profile, v => v / 10000, 'Values look scaled by 10,000 (as in MODIS MOD13) and were divided by 10,000 before classifying.');
      }
      return fromProfile(profile, v => v, null);
    }
    case 'lst':
    case 'airTemp': {
      const profile = PROFILES[metric];
      if (median > 150) return fromProfile(profile, v => v - 273.15, 'Values look like Kelvin and were converted to °C (K − 273.15) before classifying.');
      return fromProfile(profile, v => v, null);
    }
    case 'precip': {
      // IMD categories apply to 24-hour totals. A series whose closest records
      // are one day apart holds daily totals, even if some days are missing.
      if (spacing && (spacing.min < 0.75 || spacing.min > 1.25)) break;
      const note = !spacing
        ? 'No time column found; values were assumed to be 24-hour totals.'
        : spacing.median > 1.25
          ? 'Records are daily totals with gaps between some days; each value was classified as a 24-hour total.'
          : null;
      return fromProfile(PROFILES.precip, v => v, note);
    }
    case 'et': {
      if (intervalDays !== null && intervalDays > 1.5) {
        const days = intervalDays;
        return fromProfile(
          PROFILES.et,
          v => v / days,
          `Records are ${Math.round(days)} days apart. Values were treated as totals per interval (as in MODIS MOD16A2 8-day ET) and divided by ${Math.round(days * 10) / 10} to get mm/day.`,
        );
      }
      return fromProfile(PROFILES.et, v => v, null);
    }
    case 'solar':
      return fromProfile(PROFILES.solar, v => v, null);
    case 'humidity':
      return fromProfile(PROFILES.humidity, v => v, null);
    default:
      break;
  }

  // Data-driven quartiles: honest when no recognised standard applies.
  const q1 = quantileSorted(sorted, 0.25);
  const q2 = median;
  const q3 = quantileSorted(sorted, 0.75);
  const f = (v: number) => (Number.isFinite(v) ? String(Number(v.toPrecision(3))) : '—');
  const reason =
    metric === 'precip'
      ? `The closest records are ${spacing ? Math.round(spacing.min * 10) / 10 : '?'} days apart, but rainfall categories are defined for 24-hour totals, so quartiles are shown instead.`
      : null;
  return {
    metric,
    name: metric === 'precip' ? PROFILES.precip.name : columnName,
    unit: '',
    basis: 'Quartiles of this dataset (no standard classes apply).',
    note: reason,
    buckets: [
      { label: `Lowest 25 % (< ${f(q1)})`, color: QUARTILE_COLORS[0] },
      { label: `25–50 % (${f(q1)}–${f(q2)})`, color: QUARTILE_COLORS[1] },
      { label: `50–75 % (${f(q2)}–${f(q3)})`, color: QUARTILE_COLORS[2] },
      { label: `Highest 25 % (≥ ${f(q3)})`, color: QUARTILE_COLORS[3] },
    ],
    convert: v => v,
    classify: raw => {
      if (!Number.isFinite(raw)) return -1;
      if (raw < q1) return 0;
      if (raw < q2) return 1;
      if (raw < q3) return 2;
      return 3;
    },
  };
}
