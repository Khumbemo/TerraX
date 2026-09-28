// Assistant instructions and the offline answers used when no AI is set up.
import { analyzeMetric, numericColumns } from './analysis';
import { formatDate } from './dates';
import { fmt, fmtP } from './stats';
import type { Dataset } from './types';

export const APP_GUIDE = `TerraX is a browser-based Earth-observation workbench organised as tools. Each tool takes GIS files, computes results in the browser and produces a report.
Tools:
- Forest loss: two-date NDVI change (upload an earlier and a later GeoTIFF on the same grid; single-band NDVI or multi-band with red and NIR). Forest = NDVI ≥ threshold (default 0.5) on the earlier image; loss = ΔNDVI ≤ threshold (default −0.2); reports forest area, loss and gain in hectares and a change map. Also reads Hansen Global Forest Change "lossyear" tiles (optional "treecover2000", default canopy ≥ 30 %) and reports loss by year.
- Land survey: GeoJSON, KML, GPX, CSV with lat/lon columns, or a zipped shapefile. Reports area (m², ha, acres), perimeter or length, a traverse table of leg distances and true bearings, UTM and DMS coordinates, and draws the boundary on the map. Plot-sized features are measured in UTM with scale-factor correction.
- Weather & climate: CSV/TSV/XLSX time series or climate GeoTIFFs. Detects rainfall, temperature, humidity, soil moisture, evapotranspiration and solar radiation; Mann–Kendall trend with Theil–Sen slope, seasonal cycle, value classes (IMD rainfall categories, soil-moisture ranges) and daily rainfall indices (rainy days ≥ 2.5 mm, heaviest day, longest dry spell).
- Satellite imagery: multiband GeoTIFFs with band roles (blue, green, red, NIR, SWIR1, SWIR2); true and false-colour composites; NDVI, EVI, SAVI, NDWI, NDMI, NBR and NDBI; or vegetation-index time series.
- Terrain: DEM GeoTIFF → slope and aspect (Horn 1981), slope classes, hillshade, relief and hypsometric integral.
- Space & aerial photos: JPG/PNG/WebP images → vegetation cover from Excess Green with an Otsu threshold, VARI and colour statistics (no georeferencing).
Every tool has sample data (the forest, terrain, satellite, survey and photo samples are synthetic). Reports can be saved in the Reports view and downloaded as Markdown or PDF. The dataset assistant answers questions about the current results; OS Guide answers questions about TerraX.
Settings: Gemini API key (stored only in this browser) and model; target location for the telemetry panel (default Kohima, 25.674° N, 94.108° E). The Guide tab has an Earth Engine export manual.
Privacy: files stay in the browser. Only when AI is used are the computed results (and for tables a sample of up to 150 rows) sent to Google's Gemini API.`;

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

export const REPORT_PROMPT = `Write a short interpretation (4–6 sentences) of these Earth-observation results for a researcher.
Use only the numbers provided; refer to them rather than inventing any. Cover the main result and what it means on the ground, any trend or seasonal pattern if given, and one caveat about the data or method. Plain prose, no headings.`;

const FAQ: { match: RegExp; answer: string }[] = [
  { match: /forest|deforest|loss|hansen|clearing/i, answer: 'Open Tools → Forest loss. Upload an earlier and a later NDVI (or red/NIR) GeoTIFF on the same grid, set the forest and loss thresholds, and choose “Estimate forest loss”. For Hansen Global Forest Change data, switch the method and upload a lossyear tile (plus treecover2000 for the baseline).' },
  { match: /survey|plot|boundary|area|perimeter|kml|gpx|shapefile|traverse|bearing/i, answer: 'Open Tools → Land survey and upload a GeoJSON, KML, GPX, CSV (lat/lon) or zipped shapefile. TerraX reports area, perimeter, leg distances and bearings, and draws the boundary on the map.' },
  { match: /slope|aspect|dem|terrain|elevation|hillshade/i, answer: 'Open Tools → Terrain and upload a DEM GeoTIFF in metres (SRTM, Copernicus GLO-30, ASTER). TerraX computes slope and aspect with Horn’s method, a hillshade, relief and the hypsometric integral.' },
  { match: /photo|jpg|png|drone|iss|space image/i, answer: 'Open Tools → Space & aerial photos and upload a JPG, PNG or WebP. TerraX estimates green cover from the visible bands (ExG with an Otsu threshold) and reports VARI; it is a relative estimate because ordinary photos lack calibrated reflectance.' },
  { match: /moisture|soil/i, answer: 'Soil-moisture series go in Tools → Weather & climate (volumetric m³/m³ or %). For canopy moisture from imagery, use Satellite imagery → NDMI with NIR and SWIR1 bands.' },
  { match: /upload|file|format|csv|xlsx|excel|tif|tiff/i, answer: 'Drop a CSV, TSV, XLSX or GeoTIFF file on the upload box in the Explore view, or click it to browse. You can also load one of the built-in sample datasets. Files are read in your browser. Legacy .xls files are not supported; save them as .xlsx first.' },
  { match: /ndvi/i, answer: 'For a table, include an NDVI column and a date column; TerraX classifies values using indicative USGS ranges and tests for a trend. For a GeoTIFF with red and near-infrared bands (e.g. Sentinel-2 B4 and B8), choose “Compute NDVI” in the raster panel.' },
  { match: /earth engine|gee|sentinel|export/i, answer: 'Open Settings → Guide → GEE Manual for step-by-step Earth Engine scripts to export a Sentinel-2 NDVI GeoTIFF or an NDVI time-series CSV for TerraX.' },
  { match: /report|pdf|download|save/i, answer: 'Each dataset gets a statistics report. Open it in the Reports view to download it as Markdown or PDF. “Export summary” saves the dataset summary as JSON.' },
  { match: /api key|gemini|ai|key/i, answer: 'Open Settings and paste a Gemini API key (it stays in this browser), or run TerraX with GEMINI_API_KEY set on the server. Without either, TerraX still computes all statistics and reports.' },
  { match: /trend|mann|kendall|sen/i, answer: 'TerraX uses the Mann–Kendall test (two-sided, α = 0.05, tie-corrected) and the Theil–Sen slope per year. The test assumes independent observations, so strongly seasonal series can show spurious significance; check the seasonal cycle chart first.' },
  { match: /solar|lst|time|telemetry|kp|geomagnetic/i, answer: 'The telemetry panel shows UTC, local mean solar time (UTC + longitude/15), apparent solar time (adds the equation of time), sun altitude and azimuth, sunrise and sunset, and the latest NOAA planetary K-index. Change the target location in Settings.' },
  { match: /map|footprint|crs|projection|utm/i, answer: 'GeoTIFF footprints are drawn for WGS84, Web Mercator and WGS84 UTM files. Other projections still get statistics, but no map footprint.' },
];

/** Offline answer for tools without a tabular dataset: quote the computed results. */
export function localResultsAnswer(markdown: string): string {
  const results = markdown.split('## Results')[1]?.split('## Method')[0]?.trim();
  return `${results ? `Here are the computed results:\n\n${results}` : markdown}\n\n_Computed locally. Set up AI in Settings for open-ended questions._`;
}

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
