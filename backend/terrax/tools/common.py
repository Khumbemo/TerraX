"""Helpers shared by tool runners: parameters, rasters and map overlays."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any, Literal, overload

import numpy as np

from ..config import settings
from ..processing.render import classes_rgba
from ..processing.rio import Raster
from .context import ToolContext, ToolError


def number(params: dict, key: str, default: float, lo: float | None = None, hi: float | None = None, message: str | None = None) -> float:
    v = params.get(key, default)
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise ToolError(message or f"“{key}” must be a number.") from None
    if not math.isfinite(v) or (lo is not None and v < lo) or (hi is not None and v > hi):
        raise ToolError(message or f"“{key}” must be between {lo} and {hi}.")
    return v


def bands(params: dict, key: str) -> dict:
    raw = params.get(key) or {}
    if not isinstance(raw, dict):
        raise ToolError("Band roles must be a mapping such as {\"red\": 2, \"nir\": 3}.")
    out = {}
    for role, i in raw.items():
        if i is None or i == "":
            continue
        try:
            out[str(role)] = int(i)
        except (TypeError, ValueError):
            raise ToolError(f"Band for {role} must be a band number.") from None
    return out


def boundary(params: dict) -> dict | None:
    b = params.get("boundary")
    if not b:
        return None
    if not isinstance(b, dict) or not isinstance(b.get("geojson"), dict):
        raise ToolError("The analysis boundary is not valid GeoJSON.")
    return {"name": str(b.get("name") or "boundary"), "geojson": b["geojson"], "areaM2": float(b.get("areaM2") or 0)}


@overload
def raster(ctx: ToolContext, inputs: dict, slot: str, required: Literal[True] = ..., *, full: bool = ..., pixels: int | None = ...) -> Raster: ...
@overload
def raster(ctx: ToolContext, inputs: dict, slot: str, required: bool, *, full: bool = ..., pixels: int | None = ...) -> Raster | None: ...
def raster(ctx: ToolContext, inputs: dict, slot: str, required: bool = True, *, full: bool = False, pixels: int | None = None) -> Raster | None:
    """An input GeoTIFF; `full` opens it at full resolution (up to TERRAX_MAX_PIXELS) for tools that work in strips, `pixels` with another budget."""
    fid = inputs.get(slot)
    if not fid:
        if required:
            raise ToolError(f"Choose a file for “{slot}”.")
        return None
    f = ctx.file(str(fid))
    if f.kind != "raster":
        raise ToolError(f"{f.name} is not a GeoTIFF raster TerraX can read.")
    return Raster(f.path, f.name, max_pixels=pixels or (settings().max_pixels if full else None))


#: Longest side of map overlay pictures; full-resolution class maps are thinned to this for display only.
DISPLAY_SIDE = 4096


def display_grid(a: np.ndarray, side: int = DISPLAY_SIDE) -> np.ndarray:
    """Every k-th cell of a grid so its longest side is at most `side` (a view; nearest neighbour)."""
    k = max(1, -(-max(a.shape[:2]) // side))
    return a[::k, ::k] if k > 1 else a


#: Grids with a longer side than this also get full-resolution map tiles (the picture is thinned beyond it);
#: None reads TERRAX_TILES_MIN_SIDE.
TILES_MIN_SIDE: int | None = None


def grid_crs(r: Raster):
    """The CRS of a raster's analysis grid (WGS84 for geographic files that declare none), or None."""
    if r.crs is not None:
        return r.crs
    return "EPSG:4326" if r.meta.geographic else None


def class_geotiff(ctx: ToolContext, name: str, label: str, classes: np.ndarray, legend: Sequence[Mapping[str, Any]], r: Raster) -> dict | None:
    """A class map as a GeoTIFF on the raster's analysis grid, with its colour table (0 = no data), as a download; None
    when the raster has no georeferencing or the map is on another grid."""
    crs = grid_crs(r)
    if crs is None or classes.shape != (r.gh, r.gw):
        return None
    cmap: dict[int, tuple[int, int, int]] = {0: (0, 0, 0)}
    for c in legend:
        red, green, blue = (int(x) for x in c["color"][:3])
        cmap[int(c["id"])] = (red, green, blue)
    url = ctx.geotiff(name, np.asarray(classes, dtype=np.uint8), r.transform, crs, nodata=0, colormap=cmap,
                      description="; ".join(f"{c['id']} = {c['label']}" for c in legend))
    return ctx.download(f"Export {label} (GeoTIFF)", name, url, "image/tiff") | {"classes": [{"id": int(c["id"]), "label": c["label"]} for c in legend]}


def begin_tiles(ctx: ToolContext, name: str, width: int, height: int, transform, crs, dtype: str, recipe: dict, count: int = 1, nodata: float | None = None):
    """A TileSource for a grid too large for one picture, or None (small grid, or no georeferencing)."""
    from ..processing.maptiles import TileSource

    limit = TILES_MIN_SIDE if TILES_MIN_SIDE is not None else settings().tiles_min_side
    if max(width, height) <= limit or transform is None or crs is None:
        return None
    return TileSource(ctx.dir / f"tiles_{name}.tif", width, height, transform, crs, dtype, recipe, count, nodata)


def finish_tiles(ctx: ToolContext, src, name: str, bounds) -> dict | None:
    """Closes a TileSource and describes its tiles for the map: URL template and the zoom range where they add detail."""
    if src is None:
        return None
    from ..processing.maptiles import native_zoom

    src.close()
    if not bounds:
        return None
    (s, w), (n, e) = bounds
    lat = (s + n) / 2
    cell_m = (e - w) * 111_320 * math.cos(math.radians(lat)) / src.width
    k = max(1, -(-max(src.width, src.height) // DISPLAY_SIDE))
    return {"url": f"/api/jobs/{ctx.job_id}/tiles/{name}/{{z}}/{{x}}/{{y}}.png", "minzoom": native_zoom(cell_m * k, lat), "maxzoom": native_zoom(cell_m, lat),
            "bounds": [w, s, e, n]}


def class_tiles(ctx: ToolContext, name: str, classes: np.ndarray, legend: Sequence[Mapping[str, Any]], r: Raster) -> dict | None:
    """Full-resolution tiles of a whole class grid (when it is larger than the picture)."""
    if classes.shape != (r.gh, r.gw):
        return None
    palette = {str(c["id"]): list(c["color"]) for c in legend}
    src = begin_tiles(ctx, name, classes.shape[1], classes.shape[0], r.transform, grid_crs(r), "uint8", {"kind": "classes", "palette": palette}, nodata=0)
    if src is None:
        return None
    step = 4096
    for r0 in range(0, classes.shape[0], step):
        src.write(r0, classes[r0 : r0 + step].astype(np.uint8))
    return finish_tiles(ctx, src, name, r.meta.latlng_bounds)


def class_overlay(ctx: ToolContext, name: str, classes: np.ndarray, legend: Sequence[Mapping[str, Any]], r: Raster, label: str) -> dict | None:
    """Saves a class map as PNG and returns the map-image description (None without a WGS84 footprint)."""
    tiles = class_tiles(ctx, name.rsplit(".", 1)[0], classes, legend, r)
    classes = display_grid(classes)
    palette = {c["id"]: tuple(c["color"]) for c in legend}
    url = ctx.png(name, classes_rgba(classes, palette, alpha=255))
    bounds = r.meta.latlng_bounds
    return {
        "url": url,
        "bounds": bounds,
        "label": label,
        "legend": [{"color": f"rgb({','.join(str(x) for x in c['color'])})", "label": c["label"]} for c in legend],
        "width": int(classes.shape[1]),
        "height": int(classes.shape[0]),
        "tiles": tiles,
    } if bounds else {"url": url, "bounds": None, "label": label, "legend": [], "width": int(classes.shape[1]), "height": int(classes.shape[0])}


def clean(obj: Any) -> Any:
    """Drops private keys (leading underscore) and arrays before a result is stored."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if not str(k).startswith("_") and not isinstance(v, np.ndarray)}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def save_npz(path, arrays: dict[str, np.ndarray]) -> None:
    """np.savez with deflate only for integer grids: float grids barely compress, and deflating them costs most of the save time."""
    import zipfile

    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for key, a in arrays.items():
            info = zipfile.ZipInfo(key + ".npy")
            info.compress_type = zipfile.ZIP_DEFLATED if a.dtype.kind in "iub" else zipfile.ZIP_STORED
            with z.open(info, "w", force_zip64=True) as fh:
                np.lib.format.write_array(fh, np.ascontiguousarray(a), allow_pickle=False)
