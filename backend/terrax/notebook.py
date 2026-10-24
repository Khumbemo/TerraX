"""TerraX results on an interactive map in Jupyter (ipyleaflet), in the style of geemap and leafmap.

    from terrax.local import run
    from terrax.notebook import show

    res = run("forest", {"a": "ndvi_2016.tif", "b": "ndvi_2024.tif"}, out="forest")
    res            # the report, rendered as Markdown
    show(res)      # the class map, loss polygons and a legend on a zoomable map

`show` draws the GeoTIFFs and GeoJSON files a run wrote to its output folder. Each GeoTIFF is reprojected to Web
Mercator, the projection of the map, so its cells sit where they belong (nearest neighbour for class maps, bilinear
for continuous values). Class maps keep their colour table and get a legend; continuous rasters are drawn with a ramp
from their 2nd to 98th percentile. Install the extra with ``pip install 'terrax[notebook]'``.
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any

import numpy as np

from .local import Result

#: Continuous rasters (slope, wetness, accumulation, canopy height): viridis, low to high.
RAMP = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"]
#: Rasters drawn on a log scale (flow accumulation spans orders of magnitude).
LOG_SCALE = ("flow_accumulation",)


def _hex(h: str) -> tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def _ramp(v: np.ndarray) -> np.ndarray:
    """RGB for values in 0..1 along RAMP."""
    stops = np.array([_hex(c) for c in RAMP], dtype=np.float64)
    x = np.nan_to_num(np.clip(v, 0, 1), nan=0.0) * (len(RAMP) - 1)  # no-data cells are transparent; any colour will do
    i = np.minimum(np.floor(x).astype(int), len(RAMP) - 2)
    f = (x - i)[..., None]
    return (stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8)


def raster_image(path: str | Path, max_side: int = 1024) -> dict[str, Any]:
    """A GeoTIFF as a PNG in Web Mercator for an ImageOverlay: its data URL, lat/lon bounds and (class maps) legend
    colours by value."""
    import rasterio
    from PIL import Image
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT
    from rasterio.warp import transform as warp

    with rasterio.open(path) as src:
        try:
            cmap = src.colormap(1)
        except ValueError:
            cmap = None
        classes = cmap is not None
        nodata = src.nodata
        with WarpedVRT(src, crs="EPSG:3857", resampling=Resampling.nearest if classes else Resampling.bilinear, src_nodata=nodata, nodata=nodata) as vrt:
            scale = max(vrt.width, vrt.height) / max_side
            w, h = max(1, round(vrt.width / max(scale, 1))), max(1, round(vrt.height / max(scale, 1)))
            data = vrt.read(1, out_shape=(h, w), masked=True)
            b = vrt.bounds
    lon, lat = warp("EPSG:3857", "EPSG:4326", [b.left, b.right], [b.bottom, b.top])
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    valid = ~np.ma.getmaskarray(data)
    values = np.ma.getdata(data)
    if classes:
        assert cmap is not None
        for value, color in cmap.items():
            sel = valid & (values == value)
            if value != nodata and sel.any():
                rgba[sel] = color
        colors = {int(v): f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}" for v, c in cmap.items() if v != nodata}
        ramp = None
    else:
        valid &= np.isfinite(values)
        x = values.astype(np.float64)
        if any(k in Path(path).stem for k in LOG_SCALE):
            x = np.log10(np.where(valid & (x > 0), x, np.nan))
            valid &= np.isfinite(x)
        lo, hi = (np.nanpercentile(x[valid], [2, 98]) if valid.any() else (0.0, 1.0))
        rgba[..., :3] = _ramp((x - lo) / ((hi - lo) or 1.0))
        rgba[..., 3] = np.where(valid, 230, 0)
        colors = {}
        ramp = (float(lo), float(hi))
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG")
    return {"url": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), "bounds": ((lat[0], lon[0]), (lat[1], lon[1])),
            "colors": colors, "range": ramp, "width": w, "height": h}


def _labels(res: Result) -> dict[str, dict[int, str]]:
    """Class names by value for each class GeoTIFF the result lists."""
    out = {}
    for d in res.result.get("downloads") or []:
        if d.get("classes"):
            out[d["filename"]] = {int(c["id"]): str(c["label"]) for c in d["classes"]}
    return out


def show(res: Result, layers: list[str] | None = None, max_side: int = 1024, basemap: Any = None) -> Any:
    """An ipyleaflet map of a run's outputs (needs `out` on the run). `layers` picks file names; default: all GeoTIFF
    and GeoJSON outputs."""
    import ipyleaflet as L

    if res.out is None:
        raise ValueError("Run the tool with out=… (an output folder) to show its files on a map.")
    files = [f for f in res.files if f.suffix.lower() in (".tif", ".tiff", ".geojson") and (layers is None or f.name in layers)]
    if not files:
        raise ValueError("This run wrote no GeoTIFF or GeoJSON outputs to show.")
    m = L.Map(basemap=basemap or L.basemaps.Esri.WorldImagery, scroll_wheel_zoom=True)
    m.layout.height = "520px"
    labels = _labels(res)
    south, west, north, east = 90.0, 180.0, -90.0, -180.0
    legend: dict[str, str] = {}
    for f in files:
        name = f.stem.replace("_", " ")
        if f.suffix.lower() == ".geojson":
            data = json.loads(f.read_text(encoding="utf-8"))
            point = any((ft.get("geometry") or {}).get("type") == "Point" for ft in data.get("features", [])[:20])
            m.add(L.GeoJSON(data=data, name=name, style={"color": "#f97316", "weight": 2, "fillOpacity": 0.15},
                            point_style={"radius": 4, "color": "#f97316", "fillColor": "#facc15", "fillOpacity": 0.9, "weight": 1} if point else {}))
            continue
        img = raster_image(f, max_side)
        (s, w), (n, e) = img["bounds"]
        south, west, north, east = min(south, s), min(west, w), max(north, n), max(east, e)
        m.add(L.ImageOverlay(url=img["url"], bounds=img["bounds"], name=name, opacity=0.85))
        for value, label in labels.get(f.name, {}).items():
            if value in img["colors"]:
                legend[label] = img["colors"][value]
    if south <= north:
        m.center, m.zoom = view(south, west, north, east)
    else:  # vectors only: centre on their first coordinates
        first = next(json.loads(f.read_text()) for f in files if f.suffix.lower() == ".geojson")
        coords = _first_coords(first)
        if coords:
            m.center, m.zoom = (coords[1], coords[0]), 14
    if legend:
        m.add(L.LegendControl(legend, title=res.result.get("name") or res.tool, position="bottomright"))
    m.add(L.LayersControl(position="topright"))
    m.add(L.ScaleControl(position="bottomleft"))
    return m


def view(south: float, west: float, north: float, east: float, width_px: int = 900, height_px: int = 520) -> tuple[tuple[float, float], int]:
    """Centre and the largest whole zoom at which the bounds fit a map of about this size. Set directly rather than with
    fit_bounds, which takes effect only once the map is on screen."""
    import math

    def merc(lat: float) -> float:
        lat = max(-85.0511, min(85.0511, lat))
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    dx = max(east - west, 1e-9) / 360.0
    dy = max(merc(north) - merc(south), 1e-12) / (2 * math.pi)
    zoom = math.floor(min(math.log2(width_px / (256 * dx)), math.log2(height_px / (256 * dy))))
    centre_lat = math.degrees(math.atan(math.sinh((merc(north) + merc(south)) / 2)))
    return (centre_lat, (west + east) / 2), max(1, min(18, zoom))


def _first_coords(fc: dict) -> list[float] | None:
    for ft in fc.get("features", []):
        c = (ft.get("geometry") or {}).get("coordinates")
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        if isinstance(c, list) and len(c) >= 2:
            return c
    return None
