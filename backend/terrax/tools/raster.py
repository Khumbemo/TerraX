"""Satellite imagery: one band or spectral index of a GeoTIFF, and multi-date series."""

from __future__ import annotations

from ..processing.indices import INDICES
from ..processing.rasterset import analyze_stack, dataset, raster_report, stack_markdown
from ..processing.render import preview, ramp_rgba
from ..processing.report import with_quality
from ..processing.rio import Raster
from . import tool
from .common import bands, boundary, clean, raster
from .context import ToolContext, ToolError


@tool("raster")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "file")
    view = params.get("view") or {"mode": "band", "band": 0}
    if view.get("mode") == "index":
        view = {**view, "bands": bands(view, "bands")}
    ds, grid = dataset(r, view, boundary(params))
    ctx.progress(0.6, "Rendering preview")
    s = ds["stats"]
    image = None
    if s:
        pv = preview(grid.data)
        url = ctx.png("preview.png", ramp_rgba(pv, s["min"], s["max"]))
        ds["preview"] = {"url": url, "width": int(pv.shape[1]), "height": int(pv.shape[0]), "min": s["min"], "max": s["max"]}
        if r.meta.latlng_bounds:
            label = next((d.short for d in INDICES if d.id == view.get("index")), f"Band {ds['view'].get('band', 0) + 1}") if view.get("mode") == "index" else f"Band {ds['view']['band'] + 1}"
            image = {"url": url, "bounds": r.meta.latlng_bounds, "label": label, "legend": [], "ramp": {"min": s["min"], "max": s["max"], "palette": "viridis"}}
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
        rasters.append(Raster(f.path, f.name))
        ctx.progress(0.1 + 0.6 * i / len(ids), f"Reading {f.name}")
    qa = params.get("qa")
    r = analyze_stack(rasters, params.get("index"), bands(params, "bands"), qa, boundary(params))
    return clean({"tool": "satellite", "name": f"{len(r['rows'])}-date {r['label']} series", "markdown": stack_markdown(r), "series": r})
