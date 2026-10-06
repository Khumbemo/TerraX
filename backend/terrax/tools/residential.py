"""Residential plot: compare dated images of a property to screen for encroachment."""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageOps

from ..processing.encroachment import (
    DEFAULT_PARAMS,
    ZONE_ORDER,
    ZONES,
    change_polygons,
    change_rgba,
    compare_layers,
    encroachment_markdown,
    layer_rgba,
    prepare_geo_stack,
    prepare_photo_stack,
    stack_bounds,
)
from ..processing.rio import Raster
from . import tool
from .common import boundary, clean, number
from .context import ToolContext, ToolError


@tool("residential")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    items = params.get("images") or []
    if len(items) < 2:
        raise ToolError("Add at least two images of the property from different dates.")
    items = sorted(items, key=lambda x: (x.get("date") or "", items.index(x)))
    mode = params.get("mode", "geo")
    p = {k: number(params.get("settings") or {}, k, v, 0, 1e6) for k, v in DEFAULT_PARAMS.items()}
    if p["sensitivity"] <= 0:
        raise ToolError("Sensitivity must be above 0.")
    ctx.progress(0.1, "Putting the images on one grid")
    if mode == "geo":
        bnd = boundary(params)
        if not bnd:
            raise ToolError("Set the property boundary first: load it here, or draw it in Land survey and use it as the analysis boundary.")
        imgs = []
        for it in items:
            f = ctx.file(it.get("file"))
            if f.kind != "raster":
                raise ToolError(f"{f.name} is not a GeoTIFF. Use photo mode for plain JPG/PNG images.")
            imgs.append({"raster": Raster(f.path, f.name), "label": it.get("label") or f.name, "date": it.get("date")})
        stack = prepare_geo_stack(imgs, bnd, number(params, "bufferM", 15, 0, 500))
    else:
        photos = []
        for it in items:
            f = ctx.file(it.get("file"))
            try:
                im = ImageOps.exif_transpose(Image.open(f.path)).convert("RGBA")
            except Exception:
                raise ToolError(f"{f.name} could not be decoded as an image.") from None
            s = min(1.0, 1600 / max(im.size))
            if s < 1:
                im = im.resize((round(im.width * s), round(im.height * s)), Image.Resampling.BILINEAR)
            photos.append({"rgba": np.asarray(im), "label": it.get("label") or f.name, "date": it.get("date")})
        gw = params.get("groundWidthM")
        stack = prepare_photo_stack(photos, params.get("outline") or [], float(gw) if gw not in (None, "") else None)
    last = len(stack["layers"]) - 1
    base = min(int(params.get("base", 0)), last - 1)
    ctx.progress(0.45, "Comparing images")
    cmp = compare_layers(stack, base, last, p)
    timeline = [cmp if i == base else compare_layers(stack, i, last, p) for i in range(last)]
    ctx.progress(0.8, "Rendering views")
    views = {"past": ctx.png("past.png", layer_rgba(stack, base, True)), "now": ctx.png("now.png", layer_rgba(stack, last, True)),
             "changes": {z: ctx.png(f"changes_{z}.png", change_rgba(cmp["classes"], [z])) for z in ZONE_ORDER}}
    bounds = stack_bounds(stack)
    image = {"url": ctx.png("changes_all.png", change_rgba(cmp["classes"], ZONE_ORDER)), "bounds": bounds, "label": "Changes since the earlier image",
             "legend": [{"color": f"rgb({','.join(map(str, ZONES[z]['color']))})", "label": ZONES[z]["label"]} for z in ZONE_ORDER]} if bounds else None
    downloads = []
    polys = change_polygons(stack, cmp)
    if polys and polys["fc"]["features"]:
        safe = lambda s: "".join(ch if ch.isalnum() else "_" for ch in s)
        name = f"plot_changes_{safe(cmp['from'])}_to_{safe(cmp['to'])}.geojson"
        downloads.append(ctx.download("Export crossing and edge changes (GeoJSON)", name, ctx.json(name, polys["fc"]), "application/geo+json"))
    strip = lambda c: {k: v for k, v in c.items() if k != "classes"}
    return clean({
        "tool": "residential", "name": f"{cmp['from']} → {cmp['to']}", "markdown": encroachment_markdown(stack, cmp, timeline, p),
        "comparison": strip(cmp), "timeline": [strip(t) for t in timeline], "base": base, "zones": ZONES, "zoneOrder": ZONE_ORDER,
        "grid": {"width": stack["width"], "height": stack["height"], "cellM": stack["cellM"], "layers": [{"label": l["label"], "date": l.get("date")} for l in stack["layers"]], "notes": stack["notes"]},
        "views": views, "settings": p, "map": {"bounds": bounds, "image": image} if bounds else None, "downloads": downloads,
    })
