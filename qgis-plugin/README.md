# TerraX Processing (QGIS plugin)

TerraX's tools in the QGIS Processing Toolbox, on your own layers. The analyses are TerraX's own code, the same as the
web app's, so the numbers match it (the tests check the web app's answers).

| Algorithm | Inputs | Loads |
|---|---|---|
| Forest loss (two-date NDVI) | earlier and later image (NDVI, or red and NIR bands), thresholds, minimum mapping unit | class map (stable forest, loss, non-forest, gain), loss polygons |
| Burn severity (dNBR) | pre- and post-fire image (NBR, or NIR and SWIR2 bands) | severity classes (Key & Benson 2006), burned polygons |
| Forest loss by year (Hansen GFC) | treecover2000, lossyear | loss classes, loss polygons |
| Disturbance dating (image series) | 5 or more dated images on one grid | date of the drop per pixel, drop size |
| Canopy height, trees and biomass | LAS/LAZ, a DSM and DTM, or a CHM; optional field plots | CHM, tree tops; with plots, a calibrated tree count and biomass per cell |
| Land cover (k-means or random forest) | image; for the forest, training polygons or points and an optional Sentinel-1 image | class map labelled with your classes |
| Terrain (slope, hillshade) | DEM | slope (degrees), hillshade |
| Hydrology (flow, streams, wetness) | DEM, D8 or D∞, stream threshold | streams, flow accumulation (m²), wetness index (D∞) |
| Contours | DEM, interval | contour lines |
| Radar backscatter and change (Sentinel-1) | one or two VV/VH images | with two dates, the change classes |

Every raster algorithm also takes an analysis boundary (a polygon layer in any CRS). Each run writes `result.json`,
`report.md` and the output files to the output folder; the report's table appears in the log.

## Install

1. Install TerraX in a Python 3.11 or newer environment with GDAL (its own, so it does not depend on the GDAL QGIS ships):

   ```bash
   python3 -m venv ~/terrax-env
   ~/terrax-env/bin/pip install -e path/to/TerraX/backend
   ~/terrax-env/bin/terrax tools          # checks the install
   ```

2. Build the plugin: `python3 qgis-plugin/build.py` writes `qgis-plugin/dist/terrax_processing.zip`. In QGIS:
   **Plugins → Manage and Install Plugins → Install from ZIP**.
3. If `terrax` is not on the PATH QGIS sees, set it under **Settings → Options → Processing → Providers → TerraX**, for
   example `~/terrax-env/bin/terrax` (or `C:\terrax-env\Scripts\terrax.exe` on Windows).

The algorithms are under **TerraX** in the Processing Toolbox, and work in the graphical modeler, batch mode and
`processing.run("terrax:forestchange", {...})` from the Python console.

## Tests

The tests run the plugin in a real, headless QGIS with the `terrax` command on PATH:

```bash
QT_QPA_PLATFORM=offscreen /usr/bin/python3 -m unittest discover -s qgis-plugin/tests -v
```

CI (`.github/workflows/ci.yml`, job "QGIS plugin") runs them on QGIS 3.34 LTR.
