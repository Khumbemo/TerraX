// Assistant instructions and the offline answers used when no AI is set up.
import { analyzeMetric, numericColumns } from './analysis';
import { formatDate } from './dates';
import { fmt, fmtP } from './stats';
import type { Dataset } from './types';

export const APP_GUIDE = `TerraX is a browser-based Earth-observation workbench.
Features:
- Explore view: a map (OpenStreetMap-based dark basemap with an offline world outline), a file uploader and six built-in sample datasets from Kohima, Nagaland (NDVI/EVI, land surface temperature, rainfall, temperature & humidity, evapotranspiration, solar radiation).
- Supported uploads: CSV, TSV, XLSX (first sheet) and GeoTIFF (.tif/.tiff). Files are parsed in the browser.
- Tables: TerraX finds the date column and numeric columns, charts any column over time, runs a Mann–Kendall trend test with a Theil–Sen slope, shows a monthly seasonal cycle, classifies values (e.g. NDVI ranges, IMD rainfall categories) and shows the raw values.
- GeoTIFFs: per-band statistics, histogram, a viridis preview, the footprint on the map (WGS84, Web Mercator or UTM), and NDVI computed from red and near-infrared bands.
- Reports: every analysis produces a statistics report; if AI is set up, a Gemini interpretation is added. Reports are kept in the Reports view and can be downloaded as Markdown or PDF.
- Dataset assistant (below each dataset) answers questions about the loaded data. OS Guide (right panel) answers questions about using TerraX.
- Settings: Gemini API key (stored only in this browser) and model, and the target location for the telemetry panel (default Kohima, 25.674° N, 94.108° E).
- Planetary telemetry: UTC, local mean and apparent solar time, sun position, sunrise/sunset, and the live NOAA planetary K-index.
- Google Earth Engine manual (Guide tab in Settings) explains exporting Sentinel-2 imagery and NDVI time series for TerraX.
Privacy: files stay in the browser. Only when AI is used, a summary and a sample of up to 150 rows are sent to Google's Gemini API.`;

export const GUIDE_SYSTEM_PROMPT = `You are the TerraX OS Guide. Help users use the TerraX app and plan geospatial work.
Use this description of the app as the source of truth about its features; do not invent features it does not have:
${APP_GUIDE}
Be concise: short paragraphs or brief lists. For general remote-sensing or GIS questions, give accurate, well-established answers and say when something depends on sensor, region or season.`;

export const DATA_SYSTEM_PROMPT = `You are the TerraX dataset assistant, an expert in remote sensing, climatology and ecology.
The user's dataset is described below with statistics computed by TerraX and a sample of rows.
Rules:
1. Treat the computed statistics as correct. Do not recompute them from the sample or invent numbers.
2. If the answer is not supported by the data provided, say so and suggest what data would answer it.
3. Distinguish what the data shows from general scientific context, and flag uncertainty (sensor limits, autocorrelation, short records).
4. Be concise and answer the question asked.`;

export const REPORT_PROMPT = `Write a short interpretation (4–6 sentences) of this Earth-observation dataset for a researcher.
Use only the statistics provided; refer to them rather than inventing numbers. Cover the main pattern, the trend result and what it means, the seasonal cycle if given, and one caveat about the data or method. Plain prose, no headings.`;

const FAQ: { match: RegExp; answer: string }[] = [
  { match: /upload|file|format|csv|xlsx|excel|tif|tiff/i, answer: 'Drop a CSV, TSV, XLSX or GeoTIFF file on the upload box in the Explore view, or click it to browse. You can also load one of the built-in sample datasets. Files are read in your browser. Legacy .xls files are not supported; save them as .xlsx first.' },
  { match: /ndvi/i, answer: 'For a table, include an NDVI column and a date column; TerraX classifies values using indicative USGS ranges and tests for a trend. For a GeoTIFF with red and near-infrared bands (e.g. Sentinel-2 B4 and B8), choose “Compute NDVI” in the raster panel.' },
  { match: /earth engine|gee|sentinel|export/i, answer: 'Open Settings → Guide → GEE Manual for step-by-step Earth Engine scripts to export a Sentinel-2 NDVI GeoTIFF or an NDVI time-series CSV for TerraX.' },
  { match: /report|pdf|download|save/i, answer: 'Each dataset gets a statistics report. Open it in the Reports view to download it as Markdown or PDF. “Export summary” saves the dataset summary as JSON.' },
  { match: /api key|gemini|ai|key/i, answer: 'Open Settings and paste a Gemini API key (it stays in this browser), or run TerraX with GEMINI_API_KEY set on the server. Without either, TerraX still computes all statistics and reports.' },
  { match: /trend|mann|kendall|sen/i, answer: 'TerraX uses the Mann–Kendall test (two-sided, α = 0.05, tie-corrected) and the Theil–Sen slope per year. The test assumes independent observations, so strongly seasonal series can show spurious significance; check the seasonal cycle chart first.' },
  { match: /solar|lst|time|telemetry|kp|geomagnetic/i, answer: 'The telemetry panel shows UTC, local mean solar time (UTC + longitude/15), apparent solar time (adds the equation of time), sun altitude and azimuth, sunrise and sunset, and the latest NOAA planetary K-index. Change the target location in Settings.' },
  { match: /map|footprint|crs|projection|utm/i, answer: 'GeoTIFF footprints are drawn for WGS84, Web Mercator and WGS84 UTM files. Other projections still get statistics, but no map footprint.' },
];

export function localGuideAnswer(question: string): string {
  const hit = FAQ.find(f => f.match.test(question));
  const base = hit ? hit.answer : 'I can explain uploads, NDVI, Earth Engine exports, reports, trends, telemetry and AI setup. Try asking about one of those.';
  return `${base}\n\n_Offline answer: AI is not set up, so this came from the built-in guide._`;
}

/** Answers simple questions about the loaded dataset from computed statistics. */
export function localDataAnswer(question: string, ds: Dataset | null, focus: string | null): string {
  const footer = '\n\n_Computed locally. Set up AI in Settings for open-ended questions._';
  if (!ds) return `Load a dataset first.${footer}`;
  if (ds.kind === 'raster') {
    const s = ds.stats;
    if (!s) return `This raster has no valid pixels.${footer}`;
    return `**${ds.filename}** (${ds.width}×${ds.height}, ${ds.bands} band${ds.bands === 1 ? '' : 's'}): mean ${fmt(s.mean)} ± ${fmt(s.sd)}, median ${fmt(s.median)}, range ${fmt(s.min)} to ${fmt(s.max)}, ${ds.validPixels.toLocaleString()} valid pixels.${footer}`;
  }
  const cols = numericColumns(ds);
  const q = question.toLowerCase();
  const column = cols.find(c => q.includes(c.toLowerCase())) ?? focus ?? cols[0];
  if (!column) return `This table has no numeric columns.${footer}`;
  const a = analyzeMetric(ds, column);
  const s = a.summary;
  if (!s) return `"${column}" has no numeric values.${footer}`;
  const maxPt = a.points.reduce((x, y) => (y.value > x.value ? y : x));
  const minPt = a.points.reduce((x, y) => (y.value < x.value ? y : x));
  if (/trend|increas|decreas|chang|slope/.test(q)) {
    if (!a.trend) return `There are not enough dated values in "${column}" for a trend test.${footer}`;
    return `**${column}**: Mann–Kendall p = ${fmtP(a.trend.p)} (${a.trend.direction}); Theil–Sen slope ${fmt(a.trend.senSlope)} per year over ${formatDate(a.start)} to ${formatDate(a.end)}.${footer}`;
  }
  if (/max|peak|high|largest/.test(q)) return `The highest **${column}** is ${fmt(maxPt.value)} (${maxPt.label}).${footer}`;
  if (/min|low|smallest/.test(q)) return `The lowest **${column}** is ${fmt(minPt.value)} (${minPt.label}).${footer}`;
  if (/how many|count|records|rows/.test(q)) return `The file has ${ds.rows.length} rows; "${column}" has ${s.n} numeric values.${footer}`;
  return `**${column}**: mean ${fmt(s.mean)} ± ${fmt(s.sd)} (SD), median ${fmt(s.median)}, range ${fmt(minPt.value)} (${minPt.label}) to ${fmt(maxPt.value)} (${maxPt.label}), n = ${s.n}.${footer}`;
}
