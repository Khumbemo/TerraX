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


def class_overlay(ctx: ToolContext, name: str, classes: np.ndarray, legend: Sequence[Mapping[str, Any]], r: Raster, label: str) -> dict | None:
    """Saves a class map as PNG and returns the map-image description (None without a WGS84 footprint)."""
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
