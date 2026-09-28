import { parseDelimited, parseXlsx } from './table';
import type { TableDataset } from './types';

const MAX_BYTES = 300 * 1024 * 1024;

export function fileExt(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? '';
}

export function isGeoTiff(file: File): boolean {
  return ['tif', 'tiff'].includes(fileExt(file));
}

export function checkSize(file: File): void {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is larger than 300 MB. Clip or resample it before uploading.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
}

/** Parses a tabular file (CSV, TSV, TXT, XLSX). */
export async function parseTableFile(file: File): Promise<TableDataset> {
  checkSize(file);
  switch (fileExt(file)) {
    case 'csv':
    case 'txt':
      return parseDelimited(await file.text(), file.name, file.size);
    case 'tsv':
      return parseDelimited(await file.text(), file.name, file.size, '\t');
    case 'xlsx':
      return parseXlsx(file);
    case 'xls':
      throw new Error('Legacy .xls files are not supported. Open the file in a spreadsheet app and save it as .xlsx or .csv.');
    default:
      throw new Error(`“.${fileExt(file) || '?'}” files are not supported here. Use CSV, TSV, XLSX or GeoTIFF.`);
  }
}
