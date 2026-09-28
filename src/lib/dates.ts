// Date parsing for tabular time series. All dates are UTC midnight so that
// day arithmetic is unaffected by the viewer's time zone.

const DAY_MS = 86_400_000;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function utc(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

export type DayMonthOrder = 'DMY' | 'MDY';

const ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;
const YEAR_MONTH = /^(\d{4})[-/.](\d{1,2})$/;
const YEAR_DOY = /^(\d{4})[-.]?(\d{3})$/;
const YEAR_ONLY = /^(\d{4})$/;
const SHORT_FIRST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;

/**
 * Decides whether "dd-mm-yyyy"-style values in a column are day-first or
 * month-first. Returns ambiguous=true when no value has a part above 12.
 */
export function detectDayMonthOrder(values: unknown[]): { order: DayMonthOrder; ambiguous: boolean } {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = SHORT_FIRST.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (firstOver12) return { order: 'DMY', ambiguous: false };
  if (secondOver12) return { order: 'MDY', ambiguous: false };
  return { order: 'DMY', ambiguous: true };
}

/** Parses one cell into a UTC date, or null if it isn't a recognisable date. */
export function parseDateCell(value: unknown, order: DayMonthOrder = 'DMY', yearColumn = false): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (yearColumn && Number.isInteger(value) && value >= 1000 && value <= 3000) return utc(value, 1, 1);
    return null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  let m = ISO.exec(s);
  if (m) return utc(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SHORT_FIRST.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return order === 'DMY' ? utc(Number(m[3]), b, a) : utc(Number(m[3]), a, b);
  }
  m = YEAR_DOY.exec(s);
  if (m) {
    const year = Number(m[1]);
    const doy = Number(m[2]);
    const daysInYear = utc(year, 2, 29) ? 366 : 365;
    if (doy < 1 || doy > daysInYear) return null;
    return new Date(Date.UTC(year, 0, 1) + (doy - 1) * DAY_MS);
  }
  m = YEAR_MONTH.exec(s);
  if (m) return utc(Number(m[1]), Number(m[2]), 1);
  m = YEAR_ONLY.exec(s);
  if (m) return utc(Number(m[1]), 1, 1);
  return null;
}

/** Decimal year (e.g. 2014.5), used as the x variable for trend slopes per year. */
export function decimalYear(d: Date): number {
  const year = d.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (d.getTime() - start) / (end - start);
}

export function formatDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

export interface Spacing {
  /** Median gap between consecutive distinct dates, in days. */
  median: number;
  /** Smallest gap between consecutive distinct dates, in days. */
  min: number;
}

/** Spacing of a date series (sorted, duplicates ignored), or null with fewer than two distinct dates. */
export function dateSpacing(dates: (Date | null)[]): Spacing | null {
  const t = dates.filter((d): d is Date => d !== null).map(d => d.getTime()).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) gaps.push((t[i] - t[i - 1]) / DAY_MS);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return { median: gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2, min: gaps[0] };
}

export function medianIntervalDays(dates: (Date | null)[]): number | null {
  return dateSpacing(dates)?.median ?? null;
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
