"""Land cover: k-means clusters or a random forest from training shapes, with area per class.

The class map is kept with the job, so a stratified validation sample can be drawn from it and the map's
accuracy and area estimated from reference labels (api/landcover.py).
"""

from __future__ import annotations

import numpy as np

from ..config import settings
from ..processing.landcover import FOREST_SIZES, PALETTE, RadarInput, classify_land_cover, classify_supervised, land_cover_markdown
from ..processing.render import hex_rgb
from ..processing.rio import Raster, same_grid
from ..processing.survey import parse_survey_file
from . import tool
from .common import boundary, class_geotiff, class_overlay, clean, raster, save_npz
from .context import ToolContext, ToolError


def _radar(ctx: ToolContext, inputs: dict, params: dict, optical: Raster) -> RadarInput | None:
    """The radar GeoTIFF's VV and VH on the optical raster's analysis grid (reprojected when it is on another one)."""
    from ..processing.radar import detect_scale

    f = ctx.file(inputs.get("radar"))
    if f is None:
        return None
    if f.kind != "raster":
        raise ToolError(f"{f.name} is not a GeoTIFF raster.")
    rb = params.get("radarBands") or {}
    try:
        vv, vh = int(rb.get("vv", 0)), int(rb.get("vh", 1))
    except (TypeError, ValueError):
        raise ToolError("Radar bands are band numbers.") from None
    src = Raster(f.path, f.name, max_pixels=settings().max_pixels)
    if max(vv, vh) >= src.meta.bands:
        raise ToolError(f"{f.name} has {src.meta.bands} band{'' if src.meta.bands == 1 else 's'}; it needs VV and VH (bands {vv + 1} and {vh + 1}).")
    if optical.crs is None or src.crs is None:
        raise ToolError("Combining radar and optical bands needs both GeoTIFFs to have a coordinate reference system.")
    scale = detect_scale(src, vh)
    if same_grid(optical.meta, src.meta) and (src.gw, src.gh) == (optical.gw, optical.gh):
        return RadarInput(src, vv, vh, scale, f.name, aligned=False)
    ctx.progress(0.12, "Reprojecting the radar onto the optical grid")
    return RadarInput(_aligned(ctx, src, vv, vh, scale, optical), 0, 1, "linear", f.name, aligned=True, source_scale=scale)


def _aligned(ctx: ToolContext, src: Raster, vv: int, vh: int, scale: str, optical: Raster) -> Raster:
    """VV and VH reprojected onto the optical analysis grid, bilinear in linear power (averaging dB would bias low)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.warp import reproject

    from ..processing.radar import to_linear

    out = ctx.dir / "radar_on_optical_grid.tif"
    w, h = optical.gw, optical.gh
    bands = []
    for g in src.read_bands([vv, vh]):
        dst = np.full((h, w), np.nan, dtype=np.float32)
        reproject(to_linear(g.data, scale).astype(np.float32), dst, src_transform=src.transform, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=optical.transform, dst_crs=optical.crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
        bands.append(dst)
    with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=2, dtype="float32", crs=optical.crs, transform=optical.transform, nodata=np.nan) as d:
        for i, b in enumerate(bands, start=1):
            d.write(b, i)
    return Raster(out, "radar_on_optical_grid.tif", max_pixels=w * h)


def radar_note(radar: RadarInput) -> str:
    how = (f"reprojected onto the optical grid (bilinear in linear power, read as {'dB' if radar.source_scale == 'db' else 'linear power'})" if radar.aligned
           else f"on the optical grid, read as {'dB' if radar.scale == 'db' else 'linear power'}")
    return (f"Radar features from {radar.name}: VV and VH backscatter in dB and their ratio VH/VV in dB, {how}. Radar responds to canopy structure, moisture "
            "and built surfaces rather than colour, and sees through cloud; the forest weighs the features itself, so dB and reflectance need no common scale. "
            "Use a radar date close to the optical one (seasonal moisture changes backscatter).")


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
        radar = _radar(ctx, inputs, params, r)
        ctx.progress(0.2, "Training the random forest")
        res = classify_supervised(r, bands, fc, roles, params.get("labelField") or None, boundary(params), params.get("qa"), seed, trees=int(trees),
                                  threads=settings().tile_threads, radar=radar)
        if radar is not None:
            res["notes"].append(radar_note(radar))
        default = res["labels"]
    elif inputs.get("radar"):
        raise ToolError("Radar bands are used by the random forest only: k-means would weigh dB and reflectance by their units. Choose the random forest, with training shapes.")
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
    downloads = [ctx.download("Export classes (CSV)", name, ctx.text(name, csv), "text/csv")]
    tif = class_geotiff(ctx, f"{r.meta.filename.rsplit('.', 1)[0]}_landcover.tif", "class map", res["classes"], legend, r)
    if tif:
        downloads.append(tif)
    return clean({"tool": "landcover", "name": r.meta.filename, "markdown": land_cover_markdown(res, labels), "landcover": res, "labels": labels, "palette": PALETTE,
                  "map": {"bounds": r.meta.latlng_bounds, "image": image}, "file": inputs.get("file"),
                  "downloads": downloads})
