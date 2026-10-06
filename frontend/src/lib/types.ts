// Types shared by the UI (results come from the TerraX API, see lib/api.ts).

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

export interface ReportRecord {
  id: string;
  title: string;
  datasetName: string;
  createdAt: string;
  /** "ai" when a Gemini interpretation is included, "local" for computed statistics only. */
  source: 'ai' | 'local';
  model?: string;
  content: string;
  /** PNG figures (result map and charts) captured when the report was saved. */
  figures?: { title: string; dataUrl: string; width: number; height: number }[];
}
