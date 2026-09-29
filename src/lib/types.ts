export interface NumericSummary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  median: number;
  q1: number;
  q3: number;
}

export type ColumnKind = 'number' | 'date' | 'text';

export interface ColumnInfo {
  name: string;
  kind: ColumnKind;
  /** Non-empty cells in the column. */
  filled: number;
}

export type Cell = string | number | boolean | Date | null;

export interface TableDataset {
  kind: 'table';
  id: string;
  filename: string;
  format: 'CSV' | 'TSV' | 'XLSX';
  sizeBytes: number;
  columns: ColumnInfo[];
  rows: Record<string, Cell>[];
  /** Name of the column used as the time axis, if one was found. */
  timeColumn: string | null;
  /** Parsed time value for each row (null where unparseable); null when there is no time column. */
  times: (Date | null)[] | null;
  /** Median spacing between consecutive time steps, in days. */
  intervalDays: number | null;
  /** Smallest spacing between consecutive time steps, in days. */
  minIntervalDays: number | null;
  /** Numeric column chosen as the default metric. */
  defaultMetric: string | null;
  warnings: string[];
}

export interface HistogramBin {
  x0: number;
  x1: number;
  count: number;
}

export type SpectralIndex = 'ndvi' | 'evi' | 'savi' | 'ndwi' | 'ndmi' | 'nbr' | 'ndbi';
export type BandRole = 'blue' | 'green' | 'red' | 'nir' | 'swir1' | 'swir2';
/** 0-based band index for each spectral role the user has assigned. */
export type BandMap = Partial<Record<BandRole, number>>;

/** Optional cloud/quality mask applied to a layer. */
export interface QaMaskRef {
  band: number;
  kind: 'scl' | 'landsat';
}

export type RasterMode = { mode: 'band'; band: number; qa?: QaMaskRef } | { mode: 'index'; index: SpectralIndex; bands: BandMap; qa?: QaMaskRef };

export interface RasterDataset {
  kind: 'raster';
  id: string;
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  bands: number;
  view: RasterMode;
  noData: number | null;
  stats: NumericSummary | null;
  validPixels: number;
  totalPixels: number;
  /** True when statistics were computed on a resampled grid rather than every pixel. */
  statsResampled: boolean;
  histogram: HistogramBin[];
  preview: { data: Float32Array; width: number; height: number };
  bbox: [number, number, number, number] | null;
  epsg: number | null;
  /** [[south, west], [north, east]] in WGS84, when the CRS could be converted. */
  latLngBounds: [[number, number], [number, number]] | null;
  pixelSize: [number, number] | null;
  hints: string[];
  warnings: string[];
}

export type Dataset = TableDataset | RasterDataset;

export interface ReportRecord {
  id: string;
  title: string;
  datasetName: string;
  createdAt: string;
  /** "ai" when a Gemini interpretation is included, "local" for computed statistics only. */
  source: 'ai' | 'local';
  model?: string;
  content: string;
}
