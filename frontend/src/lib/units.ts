// Display units. Reports and exports stay in SI; imperial affects on-screen values only.
import { fmt } from './stats';

export type Units = 'metric' | 'imperial';

export const ACRES_PER_HA = 2.4710538147; // 1 ha = 10,000 m²; 1 acre = 4,046.8564224 m²
export const M_PER_FT = 0.3048;
export const M_PER_MI = 1609.344;
/** Metric tonnes per hectare → US short tons per acre (1 short ton = 907.18474 kg). */
export const T_HA_TO_STON_ACRE = 1000 / 907.18474 / ACRES_PER_HA;
/** m²/ha → ft²/acre. */
export const M2HA_TO_FT2ACRE = 1 / (M_PER_FT * M_PER_FT) / ACRES_PER_HA;

export function areaHa(ha: number | null, u: Units, sig = 4): string {
  if (ha === null || !Number.isFinite(ha)) return '—';
  if (u === 'imperial') {
    const ac = ha * ACRES_PER_HA;
    return ac >= 640 * 10 ? `${fmt(ac / 640, sig)} mi²` : `${fmt(ac, sig)} acres`;
  }
  return ha >= 100 ? `${fmt(ha, sig + 1)} ha (${fmt(ha / 100, sig)} km²)` : `${fmt(ha, sig)} ha`;
}

export function lengthM(m: number | null, u: Units): string {
  if (m === null || !Number.isFinite(m)) return '—';
  if (u === 'imperial') return m >= M_PER_MI ? `${fmt(m / M_PER_MI, 4)} mi` : `${fmt(m / M_PER_FT, 4)} ft`;
  return m >= 1000 ? `${fmt(m / 1000, 4)} km` : `${fmt(m, 4)} m`;
}

export function elevationM(m: number | null, u: Units): string {
  if (m === null || !Number.isFinite(m)) return '—';
  return u === 'imperial' ? `${fmt(m / M_PER_FT)} ft` : `${fmt(m)} m`;
}

export function perHa(v: number, unit: 't' | 'm2' | 'stems', u: Units, suffix = ''): string {
  if (!Number.isFinite(v)) return '—';
  if (u === 'metric') return `${fmt(v, 4)} ${unit === 't' ? `t${suffix}/ha` : unit === 'm2' ? 'm²/ha' : '/ha'}`;
  if (unit === 't') return `${fmt(v * T_HA_TO_STON_ACRE, 4)} US tons${suffix}/acre`;
  if (unit === 'm2') return `${fmt(v * M2HA_TO_FT2ACRE, 4)} ft²/acre`;
  return `${fmt(v / ACRES_PER_HA, 3)} /acre`;
}
