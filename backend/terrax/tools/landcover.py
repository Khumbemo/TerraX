"""Land cover: k-means clusters or a random forest from training shapes, with area per class.

The class map is kept with the job, so a stratified validation sample can be drawn from it and the map's
accuracy and area estimated from reference labels (api/landcover.py).
"""

from __future__ import annotations

import numpy as np

from ..config import settings
from ..processing.landcover import FOREST_SIZES, PALETTE, classify_land_cover, classify_supervised, land_cover_markdown
from ..processing.render import hex_rgb
from ..processing.survey import parse_survey_file
from . import tool
from .common import boundary, class_overlay, clean, raster, save_npz
from .context import ToolContext, ToolError


@tool("landcover")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "file", full=True)
    try:
        bands = [int(b) for b in params.get("bands") or []]
        k = int(params.get("k", 4))
        seed = int(params.get("seed", 7))
    except (TypeError, ValueError):
        raise ToolError("Bands must be band numbers and k a whole number.") from None
    roles = {kk: int(v) for kk, v in (params.get("roles") or {}).items() if v not in (None, "")}
    method = params.get("method") or "kmeans"
    if method == "rf":
        f = ctx.file(inputs.get("training"))
        if f is None:
            raise ToolError("Add training shapes: polygons or points with a property naming each one’s class (GeoJSON, KML or a zipped shapefile).")
        try:
            fc, _, _ = parse_survey_file(f.path, f.name, close_ring=False)
        except ValueError as e:
            raise ToolError(str(e)) from None
        trees = params.get("trees", 100)
        if trees not in FOREST_SIZES:
            raise ToolError(f"Choose {', '.join(map(str, FOREST_SIZES))} trees.")
        ctx.progress(0.2, "Training the random forest")
        res = classify_supervised(r, bands, fc, roles, params.get("labelField") or None, boundary(params), params.get("qa"), seed, trees=int(trees),
                                  threads=settings().tile_threads)
        default = res["labels"]
    elif method == "kmeans":
        ctx.progress(0.2, "Clustering pixels")
        res = classify_land_cover(r, bands, k, roles, boundary(params), params.get("qa"), seed)
        default = [c["suggestion"] or f"Class {c['id']}" for c in res["stats"]]
    else:
        raise ToolError("Choose k-means or random forest.")
    given = list(params.get("labels") or [])
    labels = [given[i] if i < len(given) and given[i] else default[i] for i in range(len(res["stats"]))]
    legend = [{"id": c["id"], "label": labels[i], "color": list(hex_rgb(PALETTE[i]))} for i, c in enumerate(res["stats"])]
    image = class_overlay(ctx, "classes.png", res["classes"], legend, r, "Land-cover classes" if method == "rf" else "Land-cover clusters")
    # Kept for the validation sample and the accuracy assessment.
    row_area = res["_rowArea"] if res["_rowArea"] is not None else np.ones(res["height"])
    save_npz(ctx.dir / "classes.npz", {"classes": res["classes"], "rowArea": np.asarray(row_area, dtype=np.float64)})
    csv = "class,label,pixels,area_ha,share_pct,mean_ndvi\n" + "\n".join(
        f"{c['id']},{labels[i]},{c['pixels']},{'' if c['ha'] is None else round(c['ha'], 4)},{round(c['share'] * 100, 2)},{'' if c['ndvi'] is None else round(c['ndvi'], 4)}"
        for i, c in enumerate(res["stats"]))
    name = f"{r.meta.filename.rsplit('.', 1)[0]}_landcover.csv"
    return clean({"tool": "landcover", "name": r.meta.filename, "markdown": land_cover_markdown(res, labels), "landcover": res, "labels": labels, "palette": PALETTE,
                  "map": {"bounds": r.meta.latlng_bounds, "image": image}, "file": inputs.get("file"),
                  "downloads": [ctx.download("Export classes (CSV)", name, ctx.text(name, csv), "text/csv")]})
