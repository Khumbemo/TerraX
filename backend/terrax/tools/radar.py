"""Radar: Sentinel-1 VV/VH backscatter, speckle filtering, indices and change between two dates."""

from __future__ import annotations

import numpy as np

from ..processing.radar import CHANGE, ENL_IW_GRD, analyze_radar, radar_markdown
from ..processing.rio import Raster
from . import tool
from .common import begin_tiles, boundary, class_overlay, clean, finish_tiles, grid_crs, number, raster
from .context import ToolContext, ToolError


def guess_pol(r: Raster) -> tuple[int, int]:
    """VV and VH band indices from the band names, else bands 1 and 2."""
    names = [n.upper() for n in r.meta.band_names]
    vv = next((i for i, n in enumerate(names) if "VV" in n), 0)
    vh = next((i for i, n in enumerate(names) if "VH" in n), 1 if r.meta.bands > 1 else 0)
    return vv, vh


def composite_rgba(vv_db: np.ndarray, vh_db: np.ndarray) -> np.ndarray:
    """The usual Sentinel-1 false colour: R = VV (−25…0 dB), G = VH (−30…−5 dB), B = VV/VH (0…15 dB)."""
    def scale(a: np.ndarray, lo: float, hi: float) -> np.ndarray:
        return np.clip(np.round((np.nan_to_num(a, nan=lo) - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)

    out = np.zeros((*vv_db.shape, 4), dtype=np.uint8)
    out[..., 0] = scale(vv_db, -25, 0)
    out[..., 1] = scale(vh_db, -30, -5)
    out[..., 2] = scale(vv_db - vh_db, 0, 15)
    out[..., 3] = np.where(np.isfinite(vv_db) & np.isfinite(vh_db), 255, 0)
    return out


@tool("radar")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    before = raster(ctx, inputs, "before", full=True)
    after = raster(ctx, inputs, "after", False, full=True)
    images = [before] + ([after] if after else [])
    g_vv, g_vh = guess_pol(before)
    try:
        vv = int(params["vv"]) if params.get("vv") not in (None, "") else g_vv
        vh = int(params["vh"]) if params.get("vh") not in (None, "") else g_vh
        size = int(params.get("window", 5))
    except (TypeError, ValueError):
        raise ToolError("Bands and the filter window must be whole numbers.") from None
    if vv == vh:
        raise ToolError("Choose different bands for VV and VH.")
    scale = params.get("scale") or "auto"
    if scale not in ("auto", "db", "linear"):
        raise ToolError("Units must be auto, dB or linear.")
    enl = number(params, "enl", ENL_IW_GRD, 1, 100, "Set the equivalent number of looks between 1 and 100.")
    thr = number(params, "thresholdDb", 3.0, 0.1, 20, "Set the change threshold between 0.1 and 20 dB.")
    ctx.progress(0.15, "Filtering speckle")
    tiles = begin_tiles(ctx, "composite", before.gw, before.gh, before.transform, grid_crs(before), "uint8", {"kind": "rgba"}, count=4)

    def sink(r0: int, vv_db: np.ndarray, vh_db: np.ndarray) -> None:
        if tiles is not None:
            tiles.write(r0, np.moveaxis(composite_rgba(vv_db, vh_db), -1, 0))

    try:
        res = analyze_radar(images, vv, vh, boundary(params), size, enl, thr, scale, sink=sink)
    except ValueError as e:
        if tiles is not None:
            tiles.close()
        raise ToolError(str(e)) from None
    composite_tiles = finish_tiles(ctx, tiles, "composite", before.meta.latlng_bounds)
    ctx.progress(0.8, "Rendering")
    views = res.pop("views")
    image_url = ctx.png("composite.png", composite_rgba(views["vv"], views["vh"]))
    bounds = before.meta.latlng_bounds
    image = {"url": image_url, "bounds": bounds, "label": "Sentinel-1 false colour (R VV, G VH, B VV/VH)", "legend": [],
             "width": int(views["vv"].shape[1]), "height": int(views["vv"].shape[0]), "tiles": composite_tiles} if bounds else None
    downloads = []
    change_image = None
    ch = res.get("change")
    if ch:
        classes = ch.pop("classes")
        legend = [{"id": c, "label": v["label"], "color": v["color"]} for c, v in CHANGE.items() if c != 2]
        change_image = class_overlay(ctx, "change.png", np.where(classes == 2, 0, classes).astype(np.uint8), legend, before, "Backscatter change (VH)")
        downloads.append(ctx.download("Export change classes (GeoTIFF)", "radar_change.tif", ctx.geotiff("radar_change.tif", classes, before.transform, before.crs, nodata=0), "image/tiff"))
    return clean({"tool": "radar", "name": " → ".join(r.meta.filename for r in images), "radar": res, "bands": {"vv": vv, "vh": vh},
                  "layers": {"composite": image_url, "change": change_image["url"] if change_image else None},
                  "markdown": radar_markdown(res), "downloads": downloads,
                  "map": {"bounds": bounds, "image": change_image or image} if bounds else None})
