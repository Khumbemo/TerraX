# TerraX

TerraX is an Earth-observation workbench for climate, forest and land analysis. It reads time-series tables and GeoTIFF rasters in the browser, computes statistics and trend tests, classifies values against stated references, and can add an optional Gemini interpretation.

## Features

- **Uploads:** CSV, TSV, XLSX (first sheet) and GeoTIFF. Files are parsed in the browser. Six sample series for Kohima, Nagaland are included.
- **Time series:** automatic date detection (ISO, day-first or month-first, year-day such as `2014-043`, year columns), summary statistics, Mann–Kendall trend test with the Theil–Sen slope, monthly seasonal cycle, and a paginated table of values.
- **Value classes with a stated basis:** indicative USGS NDVI ranges, IMD 24-hour rainfall categories, °C temperature bands, and ET in mm/day (multi-day totals are converted). Anything else is split into quartiles of the data.
- **GeoTIFF:** per-band statistics that honour no-data values, a histogram, a viridis preview, NDVI from red and NIR bands, and the footprint on the map for WGS84, Web Mercator and WGS84 UTM files.
- **Reports:** every dataset gets a statistics report, with an optional AI interpretation. Save reports in the Reports view and download them as Markdown or PDF.
- **Assistants:** a dataset assistant and an OS Guide. Without AI they answer from the computed statistics and a built-in guide.
- **Telemetry:** UTC, local mean and apparent solar time, sun position, sunrise and sunset, day/night on a globe, and the live NOAA planetary K-index.
- **Earth Engine manual:** scripts to export a Sentinel-2 NDVI GeoTIFF and an NDVI time-series CSV.

## Run locally

Prerequisite: Node.js 20 or later.

```bash
npm install
cp .env.example .env.local   # optional: add GEMINI_API_KEY for AI features
npm run dev                  # http://localhost:3001
```

The Gemini key is read by the server (the Vite dev server in development, `server/index.ts` in production) and is never included in the browser bundle. Users can also add their own key in **Settings**; it is stored only in their browser.

## Production

```bash
npm run build
npm start          # serves dist/ and the /api proxy on PORT (default 3001)
```

## Other scripts

| Command | What it does |
|---|---|
| `npm run lint` | Type-checks the project |
| `npm test` | Runs unit tests for the statistics, dates, metrics, geodesy and solar code |
| `npm run build:preview` | Builds a single self-contained HTML file in `dist-preview/` for sandboxed previews (no server, so AI, tiles and live data are off) |

## Scientific notes

- The Mann–Kendall test assumes independent observations. Seasonal or autocorrelated series can look significant when they are not, so check the seasonal cycle first.
- Class thresholds are indicative and vary with sensor, season and region.
- Solar time uses the NOAA Solar Calculator equations for the equation of time; sun position and times come from SunCalc.
- The bundled sample data is for demonstration only; its original source is not documented.
