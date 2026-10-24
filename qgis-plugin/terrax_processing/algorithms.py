"""TerraX's tools as Processing algorithms. Each turns its parameters into the tool's inputs and parameters, runs the
``terrax`` command (runner.py) and loads what it wrote: GeoTIFFs (class maps with their colours and labels) and
GeoJSON layers, with the report in the log and as an output."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from qgis.core import (
    QgsPalettedRasterRenderer,
    QgsProcessing,
    QgsProcessingAlgorithm,
    QgsProcessingContext,
    QgsProcessingException,
    QgsProcessingLayerPostProcessorInterface,
    QgsProcessingOutputFile,
    QgsProcessingOutputFolder,
    QgsProcessingParameterBand,
    QgsProcessingParameterEnum,
    QgsProcessingParameterField,
    QgsProcessingParameterFile,
    QgsProcessingParameterFolderDestination,
    QgsProcessingParameterMultipleLayers,
    QgsProcessingParameterNumber,
    QgsProcessingParameterRasterLayer,
    QgsProcessingParameterVectorLayer,
    QgsRasterLayer,
)

from . import runner

INDICES = ["ndvi", "evi", "savi", "ndwi", "ndmi", "nbr", "ndbi"]

# Post-processors must outlive the algorithm run that created them (QGIS calls them after it returns).
_KEEP: list = []


class _ClassLabels(QgsProcessingLayerPostProcessorInterface):
    """Draws a class GeoTIFF with its colour table and TerraX's class names."""

    def __init__(self, labels: dict[int, str]):
        super().__init__()
        self.labels = labels

    def postProcessLayer(self, layer, context, feedback):
        if not isinstance(layer, QgsRasterLayer) or not layer.isValid():
            return
        table = QgsPalettedRasterRenderer.colorTableToClassData(layer.dataProvider().colorTable(1))
        classes = [QgsPalettedRasterRenderer.Class(c.value, c.color, self.labels.get(int(c.value), c.label)) for c in table if int(c.value) in self.labels]
        if classes:
            layer.setRenderer(QgsPalettedRasterRenderer(layer.dataProvider(), 1, classes))
            layer.triggerRepaint()


class TerraxAlgorithm(QgsProcessingAlgorithm):
    TOOL = ""
    NAME = ""
    TITLE = ""
    GROUP = ""
    HELP = ""
    #: Whether the tool takes an analysis boundary (polygons that limit it).
    BOUNDARY = True

    def name(self):
        return self.NAME

    def displayName(self):
        return self.TITLE

    def group(self):
        return self.GROUP

    def groupId(self):
        return self.GROUP.lower().replace(" ", "_")

    def shortHelpString(self):
        return self.HELP + "\n\nRuns TerraX's own code (the same as its web app) through the terrax command; outputs go to the folder and are loaded."

    def createInstance(self):
        return type(self)()

    # Subclasses: add their parameters, then turn them into (inputs, params).
    def add_parameters(self) -> None:
        raise NotImplementedError

    def collect(self, parameters, context, work: str) -> tuple[dict, dict]:
        raise NotImplementedError

    def initAlgorithm(self, config=None):
        self.add_parameters()
        if self.BOUNDARY:
            self.addParameter(QgsProcessingParameterVectorLayer("BOUNDARY", "Analysis boundary (optional)", [QgsProcessing.TypeVectorPolygon], optional=True))
        self.addParameter(QgsProcessingParameterFolderDestination("OUTPUT", "Output folder"))
        self.addOutput(QgsProcessingOutputFile("REPORT", "Report (Markdown)"))
        self.addOutput(QgsProcessingOutputFolder("FOLDER", "Output folder"))

    # Helpers for subclasses.
    def raster(self, parameters, name, context, what, required=True):
        layer = self.parameterAsRasterLayer(parameters, name, context)
        if layer is None:
            if required:
                raise QgsProcessingException(f"Choose the {what}.")
            return None
        return runner.raster_path(layer, what)

    def vector(self, parameters, name, context, work, required=False):
        layer = self.parameterAsVectorLayer(parameters, name, context)
        if layer is None:
            if required:
                raise QgsProcessingException(f"Choose the {name.lower().replace('_', ' ')} layer.")
            return None
        return runner.vector_to_geojson(layer, work, name.lower(), context)

    @staticmethod
    def band(value) -> int | None:
        """A Processing band number (1-based, 0 or None when unset) as TerraX's 0-based band."""
        return int(value) - 1 if value not in (None, "", 0) else None

    def processAlgorithm(self, parameters, context, feedback):
        out = self.parameterAsString(parameters, "OUTPUT", context)
        with tempfile.TemporaryDirectory(prefix="terrax-") as work:
            inputs, params = self.collect(parameters, context, work)
            boundary = self.vector(parameters, "BOUNDARY", context, work) if self.BOUNDARY else None
            res = runner.run(self.TOOL, inputs, params, out, feedback, boundary=boundary)
        report = os.path.join(out, "report.md")
        md = Path(report).read_text(encoding="utf-8") if os.path.isfile(report) else ""
        for line in md.splitlines():
            if line.startswith("| ") and "---" not in line:
                feedback.pushInfo(line.strip("| ").replace(" | ", ": "))
        self.load_outputs(out, res, context)
        return {"REPORT": report, "FOLDER": out, "OUTPUT": out}

    def load_outputs(self, out: str, res: dict, context) -> None:
        labels = {}
        for d in res.get("downloads") or []:
            if d.get("classes"):
                labels[d["filename"]] = {int(c["id"]): str(c["label"]) for c in d["classes"]}
        for f in sorted(Path(out).iterdir()):
            if f.suffix.lower() not in (".tif", ".tiff", ".geojson"):
                continue
            title = f"{self.TITLE}: {f.stem.replace('_', ' ')}"
            details = QgsProcessingContext.LayerDetails(title, context.project(), f.stem)
            if f.name in labels:
                pp = _ClassLabels(labels[f.name])
                _KEEP.append(pp)
                details.setPostProcessor(pp)
            context.addLayerToLoadOnCompletion(str(f), details)


class ForestChange(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "forest", "forestchange", "Forest loss (two-date NDVI)", "Forest"
    HELP = ("Forest at the start (NDVI ≥ threshold), loss (a drop of NDVI) and regrowth between two images of the same grid. Single-band images are read as NDVI; "
            "for multi-band images give the red and NIR bands. Outputs a class map, loss polygons and the areas in hectares.")

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("BEFORE", "Earlier image"))
        self.addParameter(QgsProcessingParameterRasterLayer("AFTER", "Later image"))
        self.addParameter(QgsProcessingParameterBand("RED", "Red band (multi-band images)", None, "BEFORE", optional=True))
        self.addParameter(QgsProcessingParameterBand("NIR", "NIR band (multi-band images)", None, "BEFORE", optional=True))
        self.addParameter(QgsProcessingParameterNumber("FOREST", "Forest if NDVI ≥", QgsProcessingParameterNumber.Double, 0.5, minValue=-1, maxValue=1))
        self.addParameter(QgsProcessingParameterNumber("LOSS", "Loss if ΔNDVI ≤", QgsProcessingParameterNumber.Double, -0.2, minValue=-2, maxValue=0))
        self.addParameter(QgsProcessingParameterNumber("MMU", "Minimum mapping unit (ha, 0 = off)", QgsProcessingParameterNumber.Double, 0, minValue=0, maxValue=1000))

    def collect(self, parameters, context, work):
        roles = {k: v for k, v in (("red", self.band(self.parameterAsInt(parameters, "RED", context))), ("nir", self.band(self.parameterAsInt(parameters, "NIR", context)))) if v is not None}
        params = {"mode": "ndvi", "forestThreshold": self.parameterAsDouble(parameters, "FOREST", context), "lossThreshold": self.parameterAsDouble(parameters, "LOSS", context),
                  "mmuHa": self.parameterAsDouble(parameters, "MMU", context), "bandsA": roles, "bandsB": roles}
        return {"a": self.raster(parameters, "BEFORE", context, "earlier image"), "b": self.raster(parameters, "AFTER", context, "later image")}, params


class BurnSeverity(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "forest", "burnseverity", "Burn severity (dNBR)", "Forest"
    HELP = "dNBR between a pre-fire and a post-fire image, in the USGS FIREMON severity classes (Key & Benson 2006). Single-band images are read as NBR."

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("PRE", "Pre-fire image"))
        self.addParameter(QgsProcessingParameterRasterLayer("POST", "Post-fire image"))
        self.addParameter(QgsProcessingParameterBand("NIR", "NIR band (multi-band images)", None, "PRE", optional=True))
        self.addParameter(QgsProcessingParameterBand("SWIR2", "SWIR2 band (multi-band images)", None, "PRE", optional=True))
        self.addParameter(QgsProcessingParameterNumber("MMU", "Minimum mapping unit (ha, 0 = off)", QgsProcessingParameterNumber.Double, 0, minValue=0, maxValue=1000))

    def collect(self, parameters, context, work):
        roles = {k: v for k, v in (("nir", self.band(self.parameterAsInt(parameters, "NIR", context))), ("swir2", self.band(self.parameterAsInt(parameters, "SWIR2", context)))) if v is not None}
        params = {"mode": "burn", "mmuHa": self.parameterAsDouble(parameters, "MMU", context), "bandsA": roles, "bandsB": roles}
        return {"a": self.raster(parameters, "PRE", context, "pre-fire image"), "b": self.raster(parameters, "POST", context, "post-fire image")}, params


class HansenLoss(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "forest", "hansenloss", "Forest loss by year (Hansen GFC)", "Forest"
    HELP = "Tree-cover loss by year from the Hansen et al. (2013) Global Forest Change treecover2000 and lossyear layers."

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("TREECOVER", "treecover2000"))
        self.addParameter(QgsProcessingParameterRasterLayer("LOSSYEAR", "lossyear"))
        self.addParameter(QgsProcessingParameterNumber("CANOPY", "Forest if canopy cover ≥ (%)", QgsProcessingParameterNumber.Double, 30, minValue=0, maxValue=100))

    def collect(self, parameters, context, work):
        return ({"a": self.raster(parameters, "TREECOVER", context, "treecover2000 layer"), "b": self.raster(parameters, "LOSSYEAR", context, "lossyear layer")},
                {"mode": "hansen", "canopyThreshold": self.parameterAsDouble(parameters, "CANOPY", context)})


class LandCover(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "landcover", "landcover", "Land cover (k-means or random forest)", "Land cover"
    HELP = ("k-means clusters of the image's bands, or a random forest trained on labelled polygons or points (cross-validated by shape). "
            "A Sentinel-1 VV/VH image adds radar features to the random forest. Outputs the class map and a class table.")
    METHODS = ("k-means clusters (unsupervised)", "Random forest (training shapes)")

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("IMAGE", "Multispectral image"))
        self.addParameter(QgsProcessingParameterEnum("METHOD", "Method", list(self.METHODS), defaultValue=0))
        self.addParameter(QgsProcessingParameterNumber("CLASSES", "Clusters (k-means)", QgsProcessingParameterNumber.Integer, 5, minValue=2, maxValue=12))
        self.addParameter(QgsProcessingParameterVectorLayer("TRAINING", "Training shapes (random forest)", [QgsProcessing.TypeVectorPolygon, QgsProcessing.TypeVectorPoint], optional=True))
        self.addParameter(QgsProcessingParameterField("CLASS_FIELD", "Class field", None, "TRAINING", optional=True))
        self.addParameter(QgsProcessingParameterRasterLayer("RADAR", "Sentinel-1 VV/VH image (random forest, optional)", optional=True))
        self.addParameter(QgsProcessingParameterNumber("TREES", "Trees (random forest)", QgsProcessingParameterNumber.Integer, 100, minValue=10, maxValue=500))

    def collect(self, parameters, context, work):
        image = self.parameterAsRasterLayer(parameters, "IMAGE", context)
        if image is None:
            raise QgsProcessingException("Choose the multispectral image.")
        rf = self.parameterAsEnum(parameters, "METHOD", context) == 1
        params = {"method": "rf" if rf else "kmeans", "k": self.parameterAsInt(parameters, "CLASSES", context), "bands": list(range(image.bandCount())),
                  "trees": self.parameterAsInt(parameters, "TREES", context)}
        inputs = {"file": runner.raster_path(image, "multispectral image")}
        if rf:
            inputs["training"] = self.vector(parameters, "TRAINING", context, work, required=True)
            field = self.parameterAsString(parameters, "CLASS_FIELD", context)
            if field:
                params["labelField"] = field
            inputs["radar"] = self.raster(parameters, "RADAR", context, "radar image", required=False)
        return inputs, params


class Terrain(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "terrain", "terrain", "Terrain (slope, hillshade)", "Terrain"
    HELP = "Slope (degrees, with ground cell sizes in any CRS), aspect classes, hillshade, the elevation distribution and the hypsometric integral of a DEM."

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("DEM", "Elevation model (metres)"))

    def collect(self, parameters, context, work):
        return {"dem": self.raster(parameters, "DEM", context, "elevation model")}, {}


class Hydrology(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "hydrology", "hydrology", "Hydrology (flow, streams, wetness)", "Terrain"
    HELP = "Depression filling, D8 or D∞ (Tarboton 1997) flow, flow accumulation, Strahler streams and (D∞) the topographic wetness index."
    METHODS = ("D8", "D∞ (adds the wetness index)")

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("DEM", "Elevation model (metres)"))
        self.addParameter(QgsProcessingParameterEnum("METHOD", "Flow method", list(self.METHODS), defaultValue=0))
        self.addParameter(QgsProcessingParameterNumber("THRESHOLD", "Stream threshold (km² upslope)", QgsProcessingParameterNumber.Double, 0.5, minValue=0.0001))

    def collect(self, parameters, context, work):
        return ({"dem": self.raster(parameters, "DEM", context, "elevation model")},
                {"method": "dinf" if self.parameterAsEnum(parameters, "METHOD", context) == 1 else "d8", "thresholdKm2": self.parameterAsDouble(parameters, "THRESHOLD", context)})


class Contours(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "contours", "contours", "Contours", "Terrain"
    HELP = "Contour lines of a DEM at a fixed interval (marching squares, joined and simplified to a quarter cell)."

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("DEM", "Elevation model (metres)"))
        self.addParameter(QgsProcessingParameterNumber("INTERVAL", "Interval (m)", QgsProcessingParameterNumber.Double, 10, minValue=0.01))

    def collect(self, parameters, context, work):
        return {"dem": self.raster(parameters, "DEM", context, "elevation model")}, {"interval": self.parameterAsDouble(parameters, "INTERVAL", context)}


class Canopy(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "canopy", "canopy", "Canopy height, trees and biomass", "Forest"
    HELP = ("Canopy height from a LAS/LAZ point cloud, a DSM and DTM, or a canopy height model: cover, height classes and tree tops (Popescu & Wynne 2004). "
            "Field plots (polygons) with a tree count calibrate the count (ratio estimator); with biomass in Mg/ha they fit AGB = a·TCHᵇ (Asner & Mascaro 2014) "
            "for biomass, carbon and CO₂e with a 95 % interval.")

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("CHM", "Canopy height model", optional=True))
        self.addParameter(QgsProcessingParameterRasterLayer("DSM", "Surface model (with a DTM, instead of a CHM)", optional=True))
        self.addParameter(QgsProcessingParameterRasterLayer("DTM", "Terrain model", optional=True))
        self.addParameter(QgsProcessingParameterFile("CLOUD", "Point cloud (LAS/LAZ, instead of rasters)", QgsProcessingParameterFile.File, "las", optional=True,
                                                     fileFilter="LiDAR point clouds (*.las *.laz)"))
        self.addParameter(QgsProcessingParameterVectorLayer("PLOTS", "Field plots (optional)", [QgsProcessing.TypeVectorPolygon], optional=True))
        self.addParameter(QgsProcessingParameterField("COUNT_FIELD", "Tree count field", None, "PLOTS", optional=True))
        self.addParameter(QgsProcessingParameterField("AGB_FIELD", "Biomass field (Mg/ha)", None, "PLOTS", optional=True))
        self.addParameter(QgsProcessingParameterNumber("CELL", "Cell size for point clouds (m)", QgsProcessingParameterNumber.Double, 1, minValue=0.1))
        self.addParameter(QgsProcessingParameterNumber("THRESHOLD", "Canopy from (m)", QgsProcessingParameterNumber.Double, 2, minValue=0.1))
        self.addParameter(QgsProcessingParameterNumber("MIN_TREE", "Trees from (m)", QgsProcessingParameterNumber.Double, 5, minValue=0.5))

    def collect(self, parameters, context, work):
        cloud = self.parameterAsFile(parameters, "CLOUD", context)
        inputs = {"cloud": cloud or None, "chm": self.raster(parameters, "CHM", context, "canopy height model", required=False),
                  "dsm": self.raster(parameters, "DSM", context, "surface model", required=False), "dtm": self.raster(parameters, "DTM", context, "terrain model", required=False),
                  "plots": self.vector(parameters, "PLOTS", context, work)}
        if not (inputs["cloud"] or inputs["chm"] or (inputs["dsm"] and inputs["dtm"])):
            raise QgsProcessingException("Give a point cloud, a canopy height model, or a surface and a terrain model.")
        params = {"cell": self.parameterAsDouble(parameters, "CELL", context), "threshold": self.parameterAsDouble(parameters, "THRESHOLD", context),
                  "minTree": self.parameterAsDouble(parameters, "MIN_TREE", context)}
        for key, name in (("countField", "COUNT_FIELD"), ("agbField", "AGB_FIELD")):
            value = self.parameterAsString(parameters, name, context)
            if value:
                params[key] = value
        return inputs, params


class RadarChange(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "radar", "radarchange", "Radar backscatter and change (Sentinel-1)", "Radar"
    HELP = "VV and VH backscatter with a Lee speckle filter in linear power, VH/VV and RVI, and the VH log-ratio change between two dates."

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterRasterLayer("BEFORE", "Sentinel-1 image (VV and VH)"))
        self.addParameter(QgsProcessingParameterRasterLayer("AFTER", "Later image (for change, optional)", optional=True))
        self.addParameter(QgsProcessingParameterBand("VV", "VV band", 1, "BEFORE"))
        self.addParameter(QgsProcessingParameterBand("VH", "VH band", 2, "BEFORE"))
        self.addParameter(QgsProcessingParameterNumber("WINDOW", "Lee filter window (cells, odd; 1 = off)", QgsProcessingParameterNumber.Integer, 5, minValue=1, maxValue=15))
        self.addParameter(QgsProcessingParameterNumber("THRESHOLD", "Change threshold (dB)", QgsProcessingParameterNumber.Double, 3, minValue=0.1))

    def collect(self, parameters, context, work):
        return ({"before": self.raster(parameters, "BEFORE", context, "Sentinel-1 image"), "after": self.raster(parameters, "AFTER", context, "later image", required=False)},
                {"vv": self.band(self.parameterAsInt(parameters, "VV", context)) or 0, "vh": self.band(self.parameterAsInt(parameters, "VH", context)) or 0,
                 "window": self.parameterAsInt(parameters, "WINDOW", context), "thresholdDb": self.parameterAsDouble(parameters, "THRESHOLD", context)})


class Disturbances(TerraxAlgorithm):
    TOOL, NAME, TITLE, GROUP = "stack", "disturbances", "Disturbance dating (image series)", "Forest"
    HELP = ("Per pixel, one abrupt drop on a linear trend (the single-break model of BFAST, Verbesselt et al. 2010) against a trend alone, by BIC, "
            "dated by the clear observations around it. Needs at least 5 dates on one grid, the date in each file name (2024-03-15, 20240315 or 2024_075).")

    def add_parameters(self):
        self.addParameter(QgsProcessingParameterMultipleLayers("IMAGES", "Images (one per date)", QgsProcessing.TypeRaster))
        self.addParameter(QgsProcessingParameterEnum("INDEX", "Index (multi-band images)", [i.upper() for i in INDICES], defaultValue=0))
        self.addParameter(QgsProcessingParameterNumber("MIN_DROP", "Smallest drop to map", QgsProcessingParameterNumber.Double, 0.15, minValue=0.01, maxValue=2))

    def collect(self, parameters, context, work):
        layers = self.parameterAsLayerList(parameters, "IMAGES", context)
        if len(layers) < 5:
            raise QgsProcessingException("Mapping disturbances needs at least 5 dates.")
        files = [runner.raster_path(lyr, "series image") for lyr in layers]
        return {"files": files}, {"index": INDICES[self.parameterAsEnum(parameters, "INDEX", context)], "mapBreaks": True, "minDrop": self.parameterAsDouble(parameters, "MIN_DROP", context)}


ALGORITHMS = [ForestChange, BurnSeverity, HansenLoss, Disturbances, Canopy, LandCover, Terrain, Hydrology, Contours, RadarChange]

