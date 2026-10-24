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
- Hydrology can also run D∞ flow (Tarboton 1997) with the topographic wetness
  index; it passes the server's analytic tests (cone a = r/2, planes, mass
  balance).
- Radar (Sentinel-1): Lee speckle filter in linear power, VV, VH, VH/VV and
  RVI, and the VH log-ratio change between two dates.
- Canopy height: LAS/LAZ point clouds (LAZ through laz-perf, with its
  WebAssembly embedded in the page), DSM + DTM or a CHM; cover, height
  classes and tree tops. On the sample it gives exactly the server's grid,
  cover, heights and 25 trees.
- Land cover: a random forest from training shapes (50 trees and at most
  2,000 pixels per class in the browser; the server uses 100 and 5,000),
  cross-validated by shape, and the stratified validation sample with
  Olofsson et al. (2014) accuracy and area estimates (the paper's worked
  example is a test).
- Any projected CRS a GeoTIFF declares (EPSG code or its own parameters)
  through proj4 and geotiff-geokeys-to-proj4, with ground units measured
  geodesically per row as on the server (they agree to 1e-6).
- The build escapes the two U+FFFD string literals of bundled libraries,
  which the artifact publisher otherwise rejects.
- Analysis resolution is a setting (4, 16 or 36 MP; 4 MP by default), for
  files opened after the change. Everything stays in the tab, so 36 MP needs
  about 150 MB for each band read.
- Map pictures stay at 1,024 px; a result grid wider than that is also drawn
  as 256 px Web Mercator tiles from the full grid once zoomed in, each pixel
  reprojected through the file's CRS (a canvas Leaflet GridLayer). On a
  1 m-pixel tile of a UTM grid, 99 % of pixels match the cell beneath them;
  only ties on cell edges differ.
- Contours join marching-squares segments through the grid edges they share
  (so lines never branch) and simplify them to a quarter cell (Douglas &
  Peucker 1973), as on the server.
- With D∞ flow, a clicked watershed adds the D∞ upslope dependence (TauDEM
  DinfUpDependence): the share of each cell's flow reaching the outlet. Its
  area-weighted sum equals the outlet's D∞ area, and a brute-force push of
  flow down the facets gives the same shares; the cells sending at least half
  export as a polygon.
- Image series map disturbances per pixel: one abrupt drop on a linear trend (the single-break model of BFAST,
  Verbesselt et al. 2010), chosen over a trend alone by BIC, dated by the clear observations around it. On 3,000
  random cloudy series it gives the server's dates and drop sizes exactly; on the synthetic 6-date series, the same
  three fronts and 54 ha.
- Forest change and burn severity maps get the stratified validation sample and Olofsson et al. (2014) accuracy
  and area estimates that land cover already had (one shared component, as on the server).
- Canopy height takes field plots: a tree count calibrated by the ratio estimator (Cochran 1977), and above-ground
  biomass AGB = a·TCHᵇ (Asner & Mascaro 2014) with Baskerville's correction, applied to plot-sized cells, a Monte
  Carlo 95 % interval, carbon and CO₂e. The fit, totals and leave-one-out error equal the server's to 1e-9; the
  interval comes from this page's own random numbers and agrees within 0.4 %. On the server's test files the total
  is the same 1,615 Mg.
- Land cover's random forest can add a Sentinel-1 file's VV, VH and VH/VV (dB) as features. A radar file on
  another grid is reprojected onto the image bilinearly in linear power; on a WGS84 file warped onto a UTM grid it
  agrees with rasterio to 2e-5 of the backscatter.

- Projects saved to your claude.ai account. On claude.ai, the Reports view
  can save the boundary, target, reports and preferences to the viewer's
  account, then open or delete them from any device where they sign in.
  - The page uses the artifact's `user` and `db` capabilities. The data sits
    under `data/users/<id>/terrax/projects/`, a subtree only that viewer can
    read, not even the page's owner.
  - Each report is its own document, under the store's 256 KiB limit. A
    report's figures that do not fit are left out, and the app says how many.
  - Viewers need Contributor access to save. Outside claude.ai (a local build
    or a saved file) the panel does not appear, and project files work as
    before.

Rebuild it:

```bash
git worktree add ../terrax-browser 0254a69
cd ../terrax-browser
git apply ../TerraX/deploy/browser-preview/terrax-browser.patch
cp ../TerraX/backend/data/samples/{s1_vv_vh_2023-01-08,s1_vv_vh_2024-01-03}_synthetic.tif \
   ../TerraX/backend/data/samples/{lidar_forest_synthetic.laz,landcover_training_synthetic.geojson} public/data/samples/
npm ci
npx tsx --test tests/*.test.ts      # 116 unit tests
npm run build:preview               # → dist-preview/
```

Publish `dist-preview/index.html` with `maplibre-gl-worker-*.js` and `data/`
next to it, declaring the capabilities `{"downloads": {}, "db": {}, "user": {}}`. `playwright.artifact.config.ts` runs the end-to-end tests against
that folder; five fail there by design, since the preview disables live data,
the Sentinel-2 search and the offline service worker, and starts the map at
zoom 5 instead of 10.
