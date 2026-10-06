import Papa from 'papaparse';
import { dateSpacing, detectDayMonthOrder, parseDateCell } from './dates';
import { isKnownMetric, tokenize } from './metrics';
import { isFiniteNumber } from './stats';
import type { Cell, ColumnInfo, TableDataset } from './types';

const MAX_ROWS = 200_000;
const TIME_NAME = /date|time|year|day|period|month|timestamp/i;

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Converts numeric-looking strings ("12.5", " 3 ") to numbers; keeps everything else. */
function normaliseCell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v instanceof Date) return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^(nan|na|n\/a|null|none)$/i.test(s)) return null;
  return s;
}

function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let name = isEmpty(h) ? `column_${i + 1}` : String(h).trim();
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) name = `${name}_${count + 1}`;
    return name;
  });
}

/** Builds a TableDataset from a header row plus data rows. */
export function buildTable(filename: string, format: TableDataset['format'], sizeBytes: number, matrix: unknown[][]): TableDataset {
  const warnings: string[] = [];
  const nonEmpty = matrix.filter(r => r.some(c => !isEmpty(c)));
  if (nonEmpty.length < 2) throw new Error('The file needs a header row and at least one data row.');

  const headers = uniqueHeaders(nonEmpty[0]);
  let body = nonEmpty.slice(1);
  if (body.length > MAX_ROWS) {
    warnings.push(`Only the first ${MAX_ROWS.toLocaleString()} of ${body.length.toLocaleString()} rows were loaded.`);
    body = body.slice(0, MAX_ROWS);
  }

  const rows: Record<string, Cell>[] = body.map(r => {
    const row: Record<string, Cell> = {};
    headers.forEach((h, i) => {
      row[h] = normaliseCell(r[i]);
    });
    return row;
  });

  // Column typing
  const columns: ColumnInfo[] = headers.map(name => {
    const values = rows.map(r => r[name]).filter(v => v !== null);
    const numeric = values.filter(isFiniteNumber).length;
    const dateLike = values.filter(v => v instanceof Date || (typeof v === 'string' && parseDateCell(v) !== null)).length;
    let kind: ColumnInfo['kind'] = 'text';
    if (values.length && dateLike / values.length >= 0.8) kind = 'date';
    else if (values.length && numeric / values.length >= 0.8) kind = 'number';
    return { name, kind, filled: values.length };
  });

  // Time axis: prefer a date-typed column, then a numeric "year" column.
  let timeColumn: string | null = columns.find(c => c.kind === 'date')?.name ?? null;
  const yearColumn = !timeColumn ? columns.find(c => c.kind === 'number' && tokenize(c.name).includes('year')) : undefined;
  if (yearColumn) timeColumn = yearColumn.name;
  if (!timeColumn) {
    const named = columns.find(c => TIME_NAME.test(c.name));
    if (named) warnings.push(`Column "${named.name}" looks like a date column, but most of its values could not be read as dates.`);
  }

  let times: (Date | null)[] | null = null;
  let intervalDays: number | null = null;
  let minIntervalDays: number | null = null;
  if (timeColumn) {
    const col = timeColumn;
    const raw = rows.map(r => r[col]);
    const { order, ambiguous } = detectDayMonthOrder(raw);
    const isYear = Boolean(yearColumn);
    times = raw.map(v => parseDateCell(v, order, isYear));
    const bad = times.filter((t, i) => t === null && raw[i] !== null).length;
    if (bad) warnings.push(`${bad} value${bad === 1 ? '' : 's'} in "${col}" are not valid calendar dates and were left off the time axis.`);
    if (ambiguous && raw.some(v => typeof v === 'string' && /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v.trim()))) {
      warnings.push(`Dates in "${col}" could be day-first or month-first; they were read as day-month-year.`);
    }
    const spacing = dateSpacing(times);
    intervalDays = spacing?.median ?? null;
    minIntervalDays = spacing?.min ?? null;
    const sortedOk = times.every((t, i) => i === 0 || !t || !times![i - 1] || t.getTime() >= times![i - 1]!.getTime());
    if (!sortedOk) warnings.push(`Rows are not in time order; charts plot them in time order.`);
  } else {
    warnings.push('No date or time column was found, so rows are plotted in file order and trend tests are unavailable.');
  }

  const numericColumns = columns.filter(c => c.kind === 'number' && c.name !== timeColumn);
  if (!numericColumns.length) warnings.push('No numeric columns were found to analyse.');
  const idLike = (name: string) => tokenize(name).some(t => t === 'id' || t === 'fid' || t === 'index');
  const defaultMetric =
    numericColumns.find(c => isKnownMetric(c.name))?.name ?? numericColumns.find(c => !idLike(c.name))?.name ?? numericColumns[0]?.name ?? null;

  for (const c of numericColumns) {
    const missing = rows.length - c.filled;
    if (missing > 0) warnings.push(`"${c.name}" has ${missing} empty or non-numeric value${missing === 1 ? '' : 's'}; they are excluded from statistics.`);
  }

  return { kind: 'table', id: newId(), filename, format, sizeBytes, columns, rows, timeColumn, times, intervalDays, minIntervalDays, defaultMetric, warnings };
}

export function parseDelimited(text: string, filename: string, sizeBytes: number, delimiter?: string): TableDataset {
  const result = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy', delimiter });
  if (result.errors.length && !result.data.length) throw new Error(`Could not read the file: ${result.errors[0].message}`);
  const format = delimiter === '\t' ? 'TSV' : 'CSV';
  const table = buildTable(filename, format, sizeBytes, result.data);
  const rowErrors = result.errors.filter(e => e.type !== 'Delimiter');
  if (rowErrors.length) table.warnings.unshift(`${rowErrors.length} row${rowErrors.length === 1 ? ' was' : 's were'} malformed (for example, row ${(rowErrors[0].row ?? 0) + 1}: ${rowErrors[0].message}).`);
  return table;
}

export async function parseXlsx(file: File): Promise<TableDataset> {
  const { readSheet } = await import('read-excel-file/browser');
  const data = await readSheet(file);
  const table = buildTable(file.name, 'XLSX', file.size, data as unknown[][]);
  table.warnings.push('Only the first worksheet was read.');
  return table;
}
