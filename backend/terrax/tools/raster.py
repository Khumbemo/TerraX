"""Satellite imagery: one band or spectral index of a GeoTIFF, and multi-date series."""

from __future__ import annotations

from typing import Any

from ..config import settings
from ..processing.indices import INDICES
from ..processing.rasterset import analyze_breaks, analyze_stack, breaks_markdown, dataset, raster_report, stack_markdown
from ..processing.render import ramp_rgba
from ..processing.report import with_quality
from ..processing.rio import Raster
from . import tool
from .common import bands, begin_tiles, boundary, class_overlay, clean, finish_tiles, grid_crs, number, raster
from .context import ToolContext, ToolError


@tool("raster")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "file", full=True)
    view = params.get("view") or {"mode": "band", "band": 0}
    if view.get("mode") == "index":
        view = {**view, "bands": bands(view, "bands")}
    tiles = begin_tiles(ctx, "layer", r.gw, r.gh, r.transform, grid_crs(r), "float32", {"kind": "ramp", "min": 0.0, "max": 1.0}, nodata=float("nan"))
    ds, pv = dataset(r, view, boundary(params), sink=tiles.write if tiles else None)
    ctx.progress(0.6, "Rendering preview")
    s = ds["stats"]
    image = None
    tile_info = None
    if tiles is not None:
        tiles.recipe = {"kind": "ramp", "min": s["min"], "max": s["max"]} if s else tiles.recipe
        tile_info = finish_tiles(ctx, tiles, "layer", r.meta.latlng_bounds)
    if s:
        url = ctx.png("preview.png", ramp_rgba(pv, s["min"], s["max"]))
        ds["preview"] = {"url": url, "width": int(pv.shape[1]), "height": int(pv.shape[0]), "min": s["min"], "max": s["max"]}
        if r.meta.latlng_bounds:
            label = next((d.short for d in INDICES if d.id == view.get("index")), f"Band {ds['view'].get('band', 0) + 1}") if view.get("mode") == "index" else f"Band {ds['view']['band'] + 1}"
            image = {"url": url, "bounds": r.meta.latlng_bounds, "label": label, "legend": [], "ramp": {"min": s["min"], "max": s["max"], "palette": "viridis"}, "tiles": tile_info}
    md = with_quality(raster_report(ds), ds["warnings"])
    return clean({"tool": "satellite", "name": r.meta.filename, "markdown": md, "dataset": ds, "map": {"bounds": r.meta.latlng_bounds, "image": image}})


@tool("stack")
def run_stack(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    ids = inputs.get("files") or []
    if len(ids) < 2:
        raise ToolError("Add at least two images from different dates.")
    rasters = []
    for i, fid in enumerate(ids):
        f = ctx.file(fid)
        if f.kind != "raster":
            raise ToolError(f"{f.name} is not a GeoTIFF raster.")
        rasters.append(Raster(f.path, f.name, max_pixels=settings().max_pixels))
        ctx.progress(0.1 + 0.6 * i / len(ids), f"Reading {f.name}")
    qa = params.get("qa")
    r = analyze_stack(rasters, params.get("index"), bands(params, "bands"), qa, boundary(params))
    out = {"tool": "satellite", "name": f"{len(r['rows'])}-date {r['label']} series", "markdown": stack_markdown(r), "series": r}
    if params.get("mapBreaks"):
        ctx.progress(0.75, "Testing every pixel for a disturbance")
        min_drop = number(params, "minDrop", 0.15, 0.01, 2, "Set the smallest drop to map between 0.01 and 2 (for NDVI, 0.15 is a common choice).")
        try:
            b = analyze_breaks(rasters, params.get("index"), bands(params, "bands"), qa, boundary(params), min_drop)
        except ValueError as e:
            raise ToolError(str(e)) from None
        extra = _breaks_outputs(ctx, b, rasters[0])  # every date is on one grid (checked)
        report = extra.pop("markdown")
        out.update(extra)
        out["markdown"] += "\n\n" + report
    return clean(out)


BREAK_COLORS = ["#ffd166", "#f8961e", "#f3722c", "#e5484d", "#b5179e", "#7209b7", "#3a0ca3", "#4361ee", "#4cc9f0", "#2a9d8f"]


def _breaks_outputs(ctx: ToolContext, b: dict, ref: Raster) -> dict:
    from ..processing.render import hex_rgb

    dates = b["dates"]
    legend: list[dict[str, Any]] = [{"id": 1, "label": "No disturbance", "color": [72, 96, 84]}] + [
        {"id": k, "label": f"Drop first seen {dates[k]}", "color": list(hex_rgb(BREAK_COLORS[(k - 2) % len(BREAK_COLORS)]))} for k in range(2, len(dates) - 1)]
    image = class_overlay(ctx, "breaks.png", b["classes"], legend, ref, "Disturbance date")
    downloads = [
        ctx.download("Export disturbance dates (GeoTIFF; value = index of the first date after the drop, 1 = none)", "disturbance_date.tif",
                     ctx.geotiff("disturbance_date.tif", b["classes"], ref.transform, ref.crs, nodata=0, colormap={int(c["id"]): (c["color"][0], c["color"][1], c["color"][2]) for c in legend},
                                 description="; ".join(f"{c['id']} = {c['label']}" for c in legend)), "image/tiff") | {"classes": [{"id": c["id"], "label": c["label"]} for c in legend]},
        ctx.download("Export drop size (GeoTIFF)", "disturbance_magnitude.tif", ctx.geotiff("disturbance_magnitude.tif", b["magnitude"], ref.transform, ref.crs, nodata=float("nan")), "image/tiff"),
    ]
    csv = "first_seen,previous_date,pixels,area_ha\n" + "\n".join(f"{x['date']},{x['previous']},{x['pixels']},{'' if x['ha'] is None else round(x['ha'], 4)}" for x in b["byDate"])
    downloads.append(ctx.download("Export disturbed area by date (CSV)", "disturbance_by_date.csv", ctx.text("disturbance_by_date.csv", csv), "text/csv"))
    pub = {k: v for k, v in b.items() if k not in ("classes", "magnitude", "_rowArea")}
    return {"breaks": pub | {"legend": legend}, "markdown": breaks_markdown(b).replace("## Dataset", "## Disturbances (per pixel)", 1), "map": {"bounds": ref.meta.latlng_bounds, "image": image}, "downloads": downloads}
