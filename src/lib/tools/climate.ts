// Rainfall indices for daily series, following IMD conventions
// (a "rainy day" has at least 2.5 mm) and ETCCDI-style spell counts.
import type { MetricAnalysis } from '../analysis';
import { formatDate } from '../dates';
import { fmt } from '../stats';

export const RAINY_DAY_MM = 2.5;

export interface RainfallSummary {
  total: number;
  days: number;
  rainyDays: number;
  wettest: { value: number; label: string };
  /** Longest run of consecutive recorded days with less than 2.5 mm. */
  longestDrySpell: number | null;
  /** Days missing between the first and last record. */
  missingDays: number;
}

/** Only for daily series; returns null otherwise. */
export function rainfallSummary(a: MetricAnalysis, minIntervalDays: number | null): RainfallSummary | null {
  if (a.classification.metric !== 'precip' || minIntervalDays === null || Math.abs(minIntervalDays - 1) > 0.25 || !a.start || !a.end) return null;
  const pts = a.points;
  let total = 0;
  let rainy = 0;
  let wettest = pts[0];
  let run = 0;
  let longest = 0;
  let prevTime: number | null = null;
  for (const p of pts) {
    total += p.value;
    if (p.value >= RAINY_DAY_MM) rainy++;
    if (p.value > wettest.value) wettest = p;
    const t = p.time!.getTime();
    const consecutive = prevTime !== null && Math.round((t - prevTime) / 86_400_000) === 1;
    if (p.value < RAINY_DAY_MM) run = consecutive ? run + 1 : 1;
    else run = 0;
    if (run > longest) longest = run;
    prevTime = t;
  }
  const spanDays = Math.round((a.end.getTime() - a.start.getTime()) / 86_400_000) + 1;
  return {
    total,
    days: pts.length,
    rainyDays: rainy,
    wettest: { value: wettest.value, label: wettest.label },
    longestDrySpell: longest,
    missingDays: spanDays - pts.length,
  };
}

export function rainfallMarkdown(r: RainfallSummary, start: Date | null, end: Date | null): string {
  return [
    '### Rainfall indices',
    '',
    '| Index | Value |',
    '|---|---|',
    `| Total rainfall (recorded days) | ${fmt(r.total)} mm |`,
    `| Rainy days (≥ ${RAINY_DAY_MM} mm, IMD definition) | ${r.rainyDays} of ${r.days} recorded days |`,
    `| Heaviest one-day rainfall | ${fmt(r.wettest.value)} mm (${r.wettest.label}) |`,
    `| Longest dry spell (consecutive days < ${RAINY_DAY_MM} mm) | ${r.longestDrySpell ?? '—'} days |`,
    '',
    r.missingDays > 0
      ? `Note: ${r.missingDays} days between ${formatDate(start)} and ${formatDate(end)} have no record, so the total and spells describe recorded days only.`
      : `Complete daily record from ${formatDate(start)} to ${formatDate(end)}.`,
    '',
  ].join('\n');
}
