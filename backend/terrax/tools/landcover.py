"""Land cover: k-means (scikit-learn) on chosen bands, with area per class."""

from __future__ import annotations

from ..processing.landcover import PALETTE, classify_land_cover, land_cover_markdown
from ..processing.render import hex_rgb
from . import tool
from .common import boundary, class_overlay, clean, raster
from .context import ToolContext, ToolError


@tool("landcover")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    r = raster(ctx, inputs, "file")
    try:
        bands = [int(b) for b in params.get("bands") or []]
        k = int(params.get("k", 4))
    except (TypeError, ValueError):
        raise ToolError("Bands must be band numbers and k a whole number.") from None
    roles = {kk: int(v) for kk, v in (params.get("roles") or {}).items() if v not in (None, "")}
    ctx.progress(0.2, "Clustering pixels")
    res = classify_land_cover(r, bands, k, roles, boundary(params), params.get("qa"), int(params.get("seed", 7)))
    labels = list(params.get("labels") or [])
    legend = [{"id": c["id"], "label": (labels[i] if i < len(labels) and labels[i] else c["suggestion"] or f"Class {c['id']}"), "color": list(hex_rgb(PALETTE[i]))} for i, c in enumerate(res["stats"])]
    image = class_overlay(ctx, "classes.png", res["classes"], legend, r, "Land-cover clusters")
    csv = "class,label,pixels,area_ha,share_pct,mean_ndvi\n" + "\n".join(
        f"{c['id']},{(labels[i] if i < len(labels) else '') or ''},{c['pixels']},{'' if c['ha'] is None else round(c['ha'], 4)},{round(c['share'] * 100, 2)},{'' if c['ndvi'] is None else round(c['ndvi'], 4)}"
        for i, c in enumerate(res["stats"]))
    name = f"{r.meta.filename.rsplit('.', 1)[0]}_landcover.csv"
    return clean({"tool": "landcover", "name": r.meta.filename, "markdown": land_cover_markdown(res, labels), "landcover": res, "palette": PALETTE,
                  "map": {"bounds": r.meta.latlng_bounds, "image": image}, "downloads": [ctx.download("Export classes (CSV)", name, ctx.text(name, csv), "text/csv")]})
