"""Web Mercator (XYZ) tiles for result overlays at full resolution.

Map pictures are thinned to DISPLAY_SIDE cells a side; a grid larger than that is also kept as a single-band
value GeoTIFF (classes, index values, slope, canopy height) or an RGBA GeoTIFF (composites), with internal
overviews (nearest for classes and RGBA, average for continuous values), and a colour recipe. Each 256 × 256
tile is warped from the overview whose cells best match the tile's, then coloured with the same functions as
the PNG, so the tiles and the overview picture agree.
"""

from __future__ import annotations

import json
import math
import threading
from pathlib import Path
from typing import Any

import numpy as np

TILE = 256
#: Half the Web Mercator world width (m): EPSG:3857 spans ±π R with R = 6,378,137 m.
ORIGIN = math.pi * 6378137.0


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """EPSG:3857 bounds (west, south, east, north) of tile z/x/y (XYZ scheme, y down from the north)."""
    size = 2 * ORIGIN / 2**z
    west, north = -ORIGIN + x * size, ORIGIN - y * size
    return west, north - size, west + size, north


def native_zoom(cell_m: float, lat: float) -> int:
    """Smallest zoom whose tile pixels are no larger than a cell of `cell_m` metres at latitude `lat`."""
    ground = 2 * ORIGIN / TILE * math.cos(math.radians(lat))  # metres per tile pixel at zoom 0
    return max(0, min(24, math.ceil(math.log2(ground / max(cell_m, 1e-6)))))


class TileSource:
    """A value GeoTIFF written strip by strip (from several threads), then given overviews and a colour recipe."""

    def __init__(self, path: Path, width: int, height: int, transform, crs, dtype: str, recipe: dict[str, Any], count: int = 1, nodata: float | None = None):
        import rasterio

        self.path, self.recipe = Path(path), recipe
        self.path.parent.mkdir(parents=True, exist_ok=True)
        profile = {"driver": "GTiff", "width": width, "height": height, "count": count, "dtype": dtype, "crs": crs, "transform": transform, "nodata": nodata,
                   "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "deflate", "BIGTIFF": "IF_SAFER"}
        self._ds = rasterio.open(self.path, "w", **profile)
        self._lock = threading.Lock()
        self.width, self.height = width, height

    def write(self, r0: int, a: np.ndarray) -> None:
        """Rows r0… of the grid: (rows, width) for one band, (count, rows, width) for several."""
        from rasterio.windows import Window

        a = a if a.ndim == 3 else a[None]
        with self._lock:
            self._ds.write(a, window=Window(0, r0, self.width, a.shape[1]))

    def close(self) -> None:
        from rasterio.enums import Resampling

        factors = []
        f = 2
        while max(self.width, self.height) / f >= TILE / 2:
            factors.append(f)
            f *= 2
        with self._lock:
            if factors:
                continuous = self.recipe["kind"] in ("ramp", "slope")
                self._ds.build_overviews(factors, Resampling.average if continuous else Resampling.nearest)
            self._ds.close()
        self.path.with_suffix(".json").write_text(json.dumps(self.recipe), encoding="utf-8")


def colour(a: np.ndarray, recipe: dict[str, Any]) -> np.ndarray:
    """RGBA (h, w, 4) for a tile's values under a recipe; a (bands, h, w)."""
    from .render import classes_rgba, ramp_rgba

    kind = recipe["kind"]
    if kind == "classes":
        return classes_rgba(a[0], {int(k): tuple(v) for k, v in recipe["palette"].items()}, alpha=int(recipe.get("alpha", 255)))
    if kind == "ramp":
        return ramp_rgba(a[0].astype(np.float64), float(recipe["min"]), float(recipe["max"]), recipe.get("colors"))
    if kind == "slope":
        from ..tools.terrain import slope_rgba

        return slope_rgba(a[0])
    if kind == "rgba":
        return np.ascontiguousarray(np.moveaxis(a[:4], 0, -1)).astype(np.uint8)
    raise ValueError(f"Unknown tile recipe “{kind}”.")


def render_tile(path: Path, z: int, x: int, y: int) -> np.ndarray | None:
    """RGBA of tile z/x/y, or None when the tile misses the grid or holds no data."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.transform import from_bounds
    from rasterio.vrt import WarpedVRT
    from rasterio.warp import transform_bounds

    if not (0 <= z <= 24 and 0 <= x < 2**z and 0 <= y < 2**z):
        return None
    recipe = json.loads(Path(path).with_suffix(".json").read_text(encoding="utf-8"))
    tb = tile_bounds(z, x, y)
    with rasterio.open(path) as src:
        try:
            sw, ss, se, sn = transform_bounds("EPSG:3857", src.crs, *tb, densify_pts=21)
        except Exception:  # a tile outside the source CRS's valid area
            return None
        l, b, r, t = src.bounds
        if se <= l or sw >= r or sn <= b or ss >= t:
            return None
        # The overview whose cells are closest to (not larger than) the tile's pixels in the source CRS.
        ratio = ((se - sw) / TILE) / abs(src.transform.a)
        levels = src.overviews(1)
        level = -1
        for i, f in enumerate(levels):
            if f <= ratio:
                level = i
    with rasterio.open(path, overview_level=level) if level >= 0 else rasterio.open(path) as src:
        nodata = src.nodata
        with WarpedVRT(src, crs="EPSG:3857", transform=from_bounds(*tb, TILE, TILE), width=TILE, height=TILE, resampling=Resampling.nearest,
                       src_nodata=nodata, nodata=nodata) as vrt:
            a = vrt.read()
    rgba = colour(a, recipe)
    if recipe["kind"] != "rgba" and nodata is not None and not math.isnan(nodata):
        rgba[a[0] == nodata, 3] = 0
    if not rgba[..., 3].any():
        return None
    return rgba
