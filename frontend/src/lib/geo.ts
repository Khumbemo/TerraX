// Coordinate types and display helpers (projections run on the server with pyproj).

/** [[south, west], [north, east]] in WGS84 degrees. */
export type LatLngBounds = [[number, number], [number, number]];

/** Degrees as D°MM′SS.ss″ with a hemisphere letter. */
export function toDms(deg: number, pos: string, neg: string): string {
  const hemi = deg >= 0 ? pos : neg;
  let a = Math.abs(deg);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - m) * 60 * 100) / 100;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  a = d;
  return `${a}°${String(m).padStart(2, '0')}′${s.toFixed(2).padStart(5, '0')}″ ${hemi}`;
}
