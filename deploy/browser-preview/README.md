# Browser-only TerraX (the claude.ai artifact)

Before the Python server, TerraX ran every analysis in the browser. That
version (commit `0254a69`, PR #1) is still published as a claude.ai artifact,
because an artifact cannot run a server. `terrax-browser.patch` brings it the
fixes made since:

- Survey distances, bearings and areas are geodesic on the WGS84 ellipsoid
  (GeographicLib, Karney 2013), matching the Python server (pyproj) to the
  millimetre; geometries without coordinates no longer crash the survey.
- The carbon 95 % interval uses the exact Student t quantile (it matches
  `scipy.stats.t.ppf` to 1e-10) instead of an interpolated table.
- SPI classes use the McKee et al. (1993) limits (−1.0 is moderately dry).
- Repeated notes are shown once (they gave React duplicate keys).
- The residential plot tool reads each GeoTIFF's window around the property
  at full resolution. It used to coarsen the whole image to 4 MP first, while
  reporting the native cell size (same fix as the server).
- Hydrology draws the highest whole stream orders that fit 250,000 vertices
  on the map, with a note; Export streams keeps every line.
- The build escapes the two U+FFFD string literals of bundled libraries,
  which the artifact publisher otherwise rejects.

Rebuild it:

```bash
git worktree add ../terrax-browser 0254a69
cd ../terrax-browser
git apply ../TerraX/deploy/browser-preview/terrax-browser.patch
npm ci
npx tsx --test tests/*.test.ts      # 90 unit tests
npm run build:preview               # → dist-preview/
```

Publish `dist-preview/index.html` with `maplibre-gl-worker-*.js` and `data/`
next to it. `playwright.artifact.config.ts` runs the end-to-end tests against
that folder; five fail there by design, since the preview disables live data,
the Sentinel-2 search and the offline service worker, and starts the map at
zoom 5 instead of 10.
