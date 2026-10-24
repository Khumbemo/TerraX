"""The TerraX Processing plugin in a real (headless) QGIS: every algorithm registers, and the main ones run the terrax
command on TerraX's samples and load their outputs with the right rendering.

    QT_QPA_PLATFORM=offscreen python3 -m unittest discover -s qgis-plugin/tests -v

QGIS's own Python (on Ubuntu, /usr/bin/python3.12 with python3-qgis) runs this; the `terrax` command (pip install -e
backend, in any environment) must be on PATH or in TERRAX_COMMAND.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
# Copies of TerraX's samples: QGIS writes .aux.xml statistics next to the rasters it opens.
SAMPLES = Path(tempfile.mkdtemp(prefix="terrax-samples-"))
shutil.copytree(ROOT / "backend" / "data" / "samples", SAMPLES, dirs_exist_ok=True)
sys.path.insert(0, str(HERE.parent))  # the plugin package
for p in ("/usr/share/qgis/python/plugins", "/usr/lib/qgis/python/plugins"):
    if os.path.isdir(p):
        sys.path.append(p)

from qgis.core import QgsApplication, QgsPalettedRasterRenderer, QgsProject, QgsRasterLayer, QgsVectorLayer  # noqa: E402

APP = QgsApplication([], False)
APP.initQgis()

import processing  # noqa: E402
from processing.core.Processing import Processing  # noqa: E402
from processing.core.ProcessingConfig import ProcessingConfig  # noqa: E402

Processing.initialize()

from terrax_processing.plugin import TerraxPlugin  # noqa: E402
from terrax_processing.runner import SETTING  # noqa: E402

PLUGIN = TerraxPlugin()
PLUGIN.initProcessing()
if os.environ.get("TERRAX_COMMAND"):
    ProcessingConfig.setSettingValue(SETTING, os.environ["TERRAX_COMMAND"])


def raster(name: str) -> QgsRasterLayer:
    layer = QgsRasterLayer(str(SAMPLES / name), name)
    assert layer.isValid(), name
    return layer


def loaded(name_part: str):
    return [lyr for lyr in QgsProject.instance().mapLayers().values() if name_part in lyr.name()]


class TerraxProcessing(unittest.TestCase):
    def setUp(self):
        QgsProject.instance().removeAllMapLayers()
        self.out = tempfile.mkdtemp(prefix="terrax-qgis-")

    def tearDown(self):
        shutil.rmtree(self.out, ignore_errors=True)

    def run_alg(self, name: str, params: dict) -> dict:
        return processing.runAndLoadResults(f"terrax:{name}", {**params, "OUTPUT": self.out})

    def test_every_algorithm_is_registered(self):
        ids = {a.id() for a in QgsApplication.processingRegistry().providerById("terrax").algorithms()}
        self.assertEqual(ids, {f"terrax:{n}" for n in ("forestchange", "burnseverity", "hansenloss", "disturbances", "canopy", "landcover", "terrain", "hydrology",
                                                        "contours", "radarchange")})

    def test_forest_loss_loads_a_labelled_class_map_and_polygons(self):
        res = self.run_alg("forestchange", {"BEFORE": raster("forest_ndvi_2016_synthetic.tif"), "AFTER": raster("forest_ndvi_2024_synthetic.tif")})
        result = json.loads(Path(self.out, "result.json").read_text())
        self.assertAlmostEqual(result["result"]["loss"]["ha"], 184.05, places=2)  # the web app's answer
        self.assertIn("184.05 ha", Path(res["REPORT"]).read_text())
        (classes,) = loaded("forest change")
        self.assertIsInstance(classes.renderer(), QgsPalettedRasterRenderer)
        labels = {int(c.value): c.label for c in classes.renderer().classes()}
        self.assertEqual(labels, {1: "Stable forest", 2: "Forest loss", 3: "Non-forest", 4: "Vegetation gain"})
        self.assertEqual(classes.crs().authid(), raster("forest_ndvi_2016_synthetic.tif").crs().authid())
        (polys,) = loaded("loss patches")
        self.assertIsInstance(polys, QgsVectorLayer)
        self.assertEqual(polys.featureCount(), result["result"]["patches"]["count"])

    def test_a_boundary_layer_in_another_crs_limits_the_analysis(self):
        from qgis.core import QgsCoordinateReferenceSystem, QgsFeature, QgsGeometry, QgsRectangle

        before = raster("forest_ndvi_2016_synthetic.tif")
        ext = before.extent()
        west = QgsRectangle(ext.xMinimum(), ext.yMinimum(), (ext.xMinimum() + ext.xMaximum()) / 2, ext.yMaximum())
        layer = QgsVectorLayer(f"Polygon?crs={before.crs().authid()}", "west half", "memory")
        f = QgsFeature()
        f.setGeometry(QgsGeometry.fromRect(west))
        layer.dataProvider().addFeature(f)
        self.assertNotEqual(layer.crs(), QgsCoordinateReferenceSystem("EPSG:4326"))  # the plugin reprojects it to WGS84 for TerraX
        self.run_alg("forestchange", {"BEFORE": before, "AFTER": raster("forest_ndvi_2024_synthetic.tif"), "BOUNDARY": layer})
        loss = json.loads(Path(self.out, "result.json").read_text())["result"]["loss"]["ha"]
        self.assertTrue(0 < loss < 184.05, loss)

    def test_land_cover_random_forest_from_a_training_layer(self):
        training = QgsVectorLayer(str(SAMPLES / "landcover_training_synthetic.geojson"), "training", "ogr")
        self.assertTrue(training.isValid())
        self.run_alg("landcover", {"IMAGE": raster("satellite_4band_synthetic.tif"), "METHOD": 1, "TRAINING": training, "TREES": 50})
        result = json.loads(Path(self.out, "result.json").read_text())
        (classes,) = loaded("landcover")
        labels = {int(c.value): c.label for c in classes.renderer().classes()}
        self.assertEqual(sorted(labels.values()), sorted(result["labels"]))
        self.assertGreater(result["landcover"]["validation"]["overall"], 0.9)

    def test_hydrology_loads_streams_accumulation_and_wetness(self):
        self.run_alg("hydrology", {"DEM": raster("terrain_dem_synthetic.tif"), "METHOD": 1, "THRESHOLD": 0.5})
        names = {lyr.name() for lyr in QgsProject.instance().mapLayers().values()}
        self.assertTrue(any("streams" in n for n in names) and any("flow accumulation" in n for n in names) and any("twi" in n for n in names), names)

    def test_canopy_from_a_point_cloud(self):
        self.run_alg("canopy", {"CLOUD": str(SAMPLES / "lidar_forest_synthetic.laz")})
        result = json.loads(Path(self.out, "result.json").read_text())
        self.assertEqual(result["canopy"]["trees"]["count"], 25)  # as the web app and the browser version
        self.assertTrue(loaded("chm") and loaded("tree tops"))

    def test_disturbances_from_a_series(self):
        layers = [raster(p.name) for p in sorted(SAMPLES.glob("series_ndvi_*_synthetic.tif"))]
        self.run_alg("disturbances", {"IMAGES": layers, "MIN_DROP": 0.15})
        result = json.loads(Path(self.out, "result.json").read_text())
        self.assertAlmostEqual(result["breaks"]["disturbedHa"], 54, delta=0.5)
        (dates,) = loaded("disturbance date")
        labels = {c.label for c in dates.renderer().classes()}
        self.assertIn("Drop first seen 2021-03-09", labels)

    def test_burn_severity_contours_and_radar_change(self):
        self.run_alg("burnseverity", {"PRE": raster("burn_nbr_pre_synthetic.tif"), "POST": raster("burn_nbr_post_synthetic.tif")})
        (burn,) = loaded("burn severity")
        self.assertIn("High severity (≥ 0.66)", {c.label for c in burn.renderer().classes()})
        shutil.rmtree(self.out)
        self.run_alg("contours", {"DEM": raster("terrain_dem_synthetic.tif"), "INTERVAL": 50})
        (lines,) = loaded("contours")
        self.assertGreater(lines.featureCount(), 0)
        shutil.rmtree(self.out)
        self.run_alg("radarchange", {"BEFORE": raster("s1_vv_vh_2023-01-08_synthetic.tif"), "AFTER": raster("s1_vv_vh_2024-01-03_synthetic.tif")})
        result = json.loads(Path(self.out, "result.json").read_text())
        self.assertIn("change", result["radar"])
        self.assertTrue(loaded("radar change"))

    def test_terraxs_message_reaches_qgis(self):
        from qgis.core import QgsProcessingException

        # A DEM given as the later NDVI image: TerraX's own explanation is the error QGIS shows.
        with self.assertRaisesRegex(QgsProcessingException, "does not look like NDVI"):
            self.run_alg("forestchange", {"BEFORE": raster("forest_ndvi_2016_synthetic.tif"), "AFTER": raster("terrain_dem_synthetic.tif")})

    def test_a_missing_command_is_explained(self):
        from qgis.core import QgsProcessingException

        old = ProcessingConfig.getSetting(SETTING)
        ProcessingConfig.setSettingValue(SETTING, "/no/such/terrax")
        try:
            with self.assertRaisesRegex(QgsProcessingException, "Could not start"):
                self.run_alg("terrain", {"DEM": raster("terrain_dem_synthetic.tif")})
        finally:
            ProcessingConfig.setSettingValue(SETTING, old or "")


if __name__ == "__main__":
    unittest.main()
