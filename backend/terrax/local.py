"""Run TerraX tools from Python, without the web server: the same tools and results as the web app.

    from terrax.local import run

    res = run("forest", {"a": "ndvi_2016.tif", "b": "ndvi_2024.tif"}, {"mode": "ndvi"}, out="forest_result")
    res.result["result"]["loss"]["ha"]      # the numbers, as the web app's job result
    res.markdown                            # the report
    res.files                               # GeoTIFF, GeoJSON, CSV and PNG outputs copied to `out`

Inputs map each of the tool's input slots (see ``terrax tools`` or TOOLS below) to a file path, or a list of paths for
slots that take several files. Parameters are the same JSON the web app sends. Each run works in a cache folder
(TERRAX_STORAGE, else ~/.cache/terrax-local) that it empties afterwards; with `out`, the result (result.json,
report.md and every output file, with links rewritten to the copied files' names) is written there.

The command line (``terrax run …``, terrax/cli.py) and the QGIS plugin (qgis/terrax_processing) call this.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

#: Input slots and the main parameters of each tool, for ``terrax tools`` and the QGIS plugin. Every slot named here
#: is read by the tool (tests/test_local.py checks the table against the tool sources).
TOOLS: dict[str, dict[str, Any]] = {
    "forest": {"summary": "Forest loss between two dates (NDVI change), Hansen loss by year, or burn severity (dNBR)",
               "inputs": {"a": "earlier image (NDVI, or red/NIR bands; the Hansen treecover2000 or pre-fire NBR)", "b": "later image (the Hansen lossyear or post-fire NBR)"},
               "params": {"mode": "ndvi | hansen | burn", "forestThreshold": "0.5", "lossThreshold": "-0.2", "canopyThreshold": "30 (Hansen, %)", "mmuHa": "0 (minimum mapping unit, ha)"}},
    "raster": {"summary": "Spectral index or band statistics of one GeoTIFF", "inputs": {"file": "GeoTIFF"},
               "params": {"view": '{"mode": "index", "index": "ndvi", "bands": {"red": 2, "nir": 3}}'}},
    "stack": {"summary": "Multi-date series: trend per image, and disturbances dated per pixel", "inputs": {"files": "several GeoTIFFs, the date in each file name"},
              "params": {"index": "ndvi", "mapBreaks": "true", "minDrop": "0.15"}},
    "landcover": {"summary": "Land-cover classification: k-means clusters or a random forest from training shapes",
                  "inputs": {"file": "multispectral GeoTIFF", "training": "training polygons or points (random forest)", "radar": "optional Sentinel-1 VV/VH GeoTIFF"},
                  "params": {"method": "kmeans | rf", "k": "4", "bands": "[0, 1, 2, 3]", "labelField": "class", "trees": "100"}},
    "terrain": {"summary": "Slope, aspect, hillshade and elevation statistics of a DEM", "inputs": {"dem": "DEM GeoTIFF (metres)"}, "params": {}},
    "hydrology": {"summary": "Flow direction and accumulation (D8 or D∞), streams and wetness index", "inputs": {"dem": "DEM GeoTIFF"},
                  "params": {"method": "d8 | dinf", "thresholdKm2": "0.5"}},
    "contours": {"summary": "Contour lines of a DEM", "inputs": {"dem": "DEM GeoTIFF"}, "params": {"interval": "10 (m)"}},
    "canopy": {"summary": "Canopy height, cover and tree tops from LiDAR, DSM − DTM or a CHM; biomass from field plots",
               "inputs": {"cloud": "LAS/LAZ point cloud", "dsm": "surface model", "dtm": "terrain model", "chm": "canopy height model", "plots": "optional field plots (polygons with trees and/or agb)"},
               "params": {"cell": "1 (m, point clouds)", "threshold": "2 (m)", "minTree": "5 (m)", "countField": "trees", "agbField": "agb"}},
    "radar": {"summary": "Sentinel-1 backscatter (Lee filter), VH/VV and change between two dates", "inputs": {"before": "VV/VH GeoTIFF", "after": "optional later VV/VH GeoTIFF"},
              "params": {"vv": "0", "vh": "1", "window": "5", "thresholdDb": "3"}},
    "carbon": {"summary": "Tree biomass and carbon from a field inventory (Chave 2014)", "inputs": {"file": "inventory CSV (DBH, height, species)"},
               "params": {"forestType": "moist | dry | wet"}},
    "survey": {"summary": "Areas, perimeters, distances and bearings of surveyed shapes (geodesic)", "inputs": {"file": "GeoJSON, KML, GPX, CSV or zipped shapefile"}, "params": {}},
    "table": {"summary": "Climate and other time-series tables: trends, seasonality, SPI", "inputs": {"file": "CSV or Excel table"}, "params": {}},
    "photo": {"summary": "Aerial and space photo metadata, colour statistics and comparison", "inputs": {"photo": "image", "other": "optional second image"}, "params": {}},
}

#: Tools that run from the web app only: live satellite catalogues (they need the internet and STAC items), and the
#: residential plot tool, whose images are listed with their dates inside its parameters.
WEB_ONLY = ("sentinel", "sentinel1", "sentinel_composite", "residential")


class TerraxError(RuntimeError):
    """A tool refused the inputs (the message says why) or failed."""


@dataclass
class Result:
    tool: str
    #: The tool's result, as the web app receives it, with links to outputs rewritten to their file names in `out`.
    result: dict[str, Any]
    markdown: str
    out: Path | None = None
    files: list[Path] = field(default_factory=list)
    seconds: float | None = None

    def __getitem__(self, key: str) -> Any:
        return self.result[key]

    def _repr_markdown_(self) -> str:
        """Jupyter shows a result as its report; terrax.notebook.show(result) puts its outputs on a map."""
        return self.markdown


def cache_dir() -> Path:
    return Path(os.environ.get("TERRAX_STORAGE") or Path.home() / ".cache" / "terrax-local")


@contextmanager
def _local_env(storage: Path | None) -> Iterator[None]:
    """The settings a run without the web server needs, restored afterwards."""
    wanted = {"TERRAX_STORAGE": str(storage or cache_dir()), "TERRAX_EAGER": "true", "TERRAX_RATE_LIMITS": "false", "TERRAX_JOB_THREADS": "0"}
    old = {k: os.environ.get(k) for k in wanted}
    os.environ.update(wanted)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


_LINK = re.compile(r"/api/jobs/[0-9a-f]{32}/(?:artifacts/([^\"?#\s]+)|tiles/[^\"\s]*)(?:\?[^\"\s]*)?")


def _rewrite(value: Any) -> Any:
    """Links to a job's artifacts become the copied file's name; tile links (web map only) are dropped."""
    if isinstance(value, str):
        m = _LINK.fullmatch(value)
        if m:
            return m.group(1)
        return value
    if isinstance(value, list):
        return [_rewrite(v) for v in value]
    if isinstance(value, dict):
        out = {k: _rewrite(v) for k, v in value.items()}
        if out.get("tiles") is None and "tiles" in value:
            out.pop("tiles")
        return out
    return value


def _paths(value: Any, slot: str) -> list[Path]:
    items = value if isinstance(value, list | tuple) else [value]
    out = []
    for v in items:
        p = Path(v).expanduser()
        if not p.is_file():
            raise FileNotFoundError(f"{slot}: no file {p}")
        out.append(p)
    return out


def run(tool: str, inputs: dict[str, Any] | None = None, params: dict[str, Any] | None = None, out: str | Path | None = None,
        storage: str | Path | None = None, keep: bool = False, progress: Callable[[float, str], None] | None = None) -> Result:
    """Runs one tool on local files and returns its result (and writes it to `out`, when given). `progress` is called
    with (fraction 0–1, message) as the tool works."""
    if tool in WEB_ONLY:
        raise TerraxError(f"“{tool}” runs from the web app (or its API) only.")
    with _local_env(Path(storage) if storage else None):
        from . import storage as st
        from .tasks import run_job
        from .tools import load_all
        from .tools.context import PROGRESS_HOOK

        if tool not in load_all():
            raise TerraxError(f"Unknown tool “{tool}”. Tools: {', '.join(sorted(TOOLS))}.")
        stored: list[str] = []
        job_inputs: dict[str, Any] = {}
        jid = None
        try:
            for slot, value in (inputs or {}).items():
                if value in (None, "", []):
                    continue
                ids = [st.save_file(p.name, p, owner="local").id for p in _paths(value, slot)]
                stored += ids
                job_inputs[slot] = ids if isinstance(value, list | tuple) else ids[0]
            jid = st.create_job(tool, job_inputs, params or {}, owner="local")
            token = PROGRESS_HOOK.set(progress)
            try:
                status = run_job(jid)
            finally:
                PROGRESS_HOOK.reset(token)
            if status.get("state") != "done":
                raise TerraxError(str(status.get("message") or "The analysis failed."))
            raw = st.job_result(jid) or {}
            result = _rewrite(raw)
            md = str(result.get("markdown") or "")
            res = Result(tool, result, md, seconds=status.get("seconds"))
            if out is not None:
                dest = Path(out).expanduser()
                dest.mkdir(parents=True, exist_ok=True)
                art = st.job_dir(jid) / "artifacts"
                for f in sorted(art.iterdir()) if art.exists() else []:
                    if f.is_file() and not f.name.startswith("tiles_") and f.suffix not in (".npz",):
                        shutil.copy2(f, dest / f.name)
                        res.files.append(dest / f.name)
                (dest / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                (dest / "report.md").write_text(md, encoding="utf-8")
                res.out = dest
            return res
        finally:
            if not keep:
                if jid is not None:
                    st.delete_job(jid)
                for fid in stored:
                    st.delete_file(fid)


def boundary_from_file(path: str | Path) -> dict[str, Any]:
    """An analysis boundary (the ``boundary`` parameter every raster tool takes) from a GeoJSON, KML or zipped shapefile
    of polygons: they limit the analysis to their inside."""
    from pyproj import Geod
    from shapely.geometry import shape

    from .processing.survey import parse_survey_file

    p = Path(path).expanduser()
    fc, _, _ = parse_survey_file(p, p.name, close_ring=True)
    feats = [f for f in fc.get("features", []) if (f.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon")]
    if not feats:
        raise TerraxError(f"{p.name} has no polygons to use as the analysis boundary.")
    geod = Geod(ellps="WGS84")
    area = sum(abs(geod.geometry_area_perimeter(shape(f["geometry"]))[0]) for f in feats)
    return {"name": p.stem, "geojson": {"type": "FeatureCollection", "features": feats}, "areaM2": area}


def tools() -> dict[str, dict[str, Any]]:
    """The tools that run on local files: summary, input slots and main parameters."""
    return TOOLS
