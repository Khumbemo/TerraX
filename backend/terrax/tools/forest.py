"""Forest loss: two-date NDVI change, Hansen Global Forest Change and burn severity."""

from __future__ import annotations

from ..processing import forest as fp
from . import tool
from .common import bands, boundary, class_overlay, clean, number, raster
from .context import ToolContext, ToolError

SLOT_NAMES = {
    "ndvi": ("Earlier image", "Later image"),
    "hansen": ("Loss year (lossyear)", "Tree cover 2000"),
    "burn": ("Pre-fire image", "Post-fire image"),
}


@tool("forest")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    mode = params.get("mode", "ndvi")
    if mode not in SLOT_NAMES:
        raise ToolError("Choose a method: ndvi, hansen or burn.")
    mmu = number(params, "mmuHa", 0, 0, 1000, "Set the minimum mapping unit between 0 (off) and 1,000 ha.")
    bnd = boundary(params)
    a = raster(ctx, inputs, "a")
    b = raster(ctx, inputs, "b", required=mode != "hansen")
    ctx.progress(0.15, "Reading rasters")
    if mode == "ndvi":
        f_thr = number(params, "forestThreshold", 0.5, -1, 1, "Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        l_thr = number(params, "lossThreshold", -0.2, -2, 0, "Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        if l_thr >= 0:
            raise ToolError("Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        r = fp.analyze_ndvi_change(a, bands(params, "bandsA"), b, bands(params, "bandsB"), f_thr, l_thr, bnd, mmu)
    elif mode == "burn":
        r = fp.analyze_burn(a, bands(params, "bandsA"), b, bands(params, "bandsB"), bnd, mmu)
    else:
        c_thr = number(params, "canopyThreshold", 30, 0, 100, "Set the canopy threshold between 0 and 100 %.")
        r = fp.analyze_hansen(a, b, c_thr, bnd, mmu)
    ctx.progress(0.7, "Mapping patches")
    names = [x.meta.filename for x in (a, b) if x is not None]
    slot = SLOT_NAMES[mode]
    label = "Burn severity" if mode == "burn" else "Forest change"
    image = class_overlay(ctx, "change.png", r["classes"], fp.legend(mode), a, label)
    downloads = []
    polys = fp.loss_polygons(r, a)
    if polys is not None:
        kind = "burned" if mode == "burn" else "loss"
        fname = f"{a.meta.filename.rsplit('.', 1)[0]}_{kind}_patches.geojson"
        url = ctx.json(fname, polys["fc"])
        downloads.append(ctx.download(f"Export {kind} polygons (GeoJSON)", fname, url, "application/geo+json") | {"features": len(polys["fc"]["features"]), "truncated": polys["truncated"]})
    md = fp.forest_markdown(r, [f"{slot[i]}: {n}" for i, n in enumerate(names)])
    return clean({
        "tool": "forest",
        "name": " vs ".join(names),
        "markdown": md,
        "map": {"bounds": a.meta.latlng_bounds, "image": image},
        "result": r,
        "legend": fp.legend(mode),
        "downloads": downloads,
    })
