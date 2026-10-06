// Number formatting for display (the statistics themselves are computed on the server).
/** Formats a number to a given number of significant figures for display. */
export function fmt(v: number | null | undefined, sig = 4): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) return v.toExponential(2);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(Number(v.toPrecision(sig)));
}

export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p < 0.001 ? '< 0.001' : p.toFixed(3);
}
