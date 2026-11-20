"""Surface water and floods (processing/water.py): optical water indices or Sentinel-1 backscatter, one date or two."""

from __future__ import annotations

from typing import Any

import numpy as np

from ..processing import water as wp
from ..processing.indices import guess_band_map
from ..processing.patches import label_patches, patch_areas, patches_to_geojson
from ..processing.radar import detect_scale, lee_filter, to_linear
from ..processing.rio import Raster, apply_qa, ground_geometry, same_grid
from ..processing.zonal import boundary_mask
from . import tool
from .common import boundary, class_geotiff, class_overlay, clean, number, raster
from .context import ToolContext, ToolError


def _optical(r: Raster, params: dict, notes: list[str]) -> tuple[np.ndarray, str]:
    """The water index of one image (NaN where cloudy or no data)."""
    if r.meta.bands == 1:
        (g,) = r.read_bands([0])
        notes.append(f"{r.meta.filename}: one band, read as a water index (NDWI or MNDWI) already computed.")
        return g.data.astype(np.float64), "Water index (band 1)"
    roles = {k: int(v) for k, v in (params.get("bands") or guess_band_map(r.meta.bands)).items() if k in ("green", "nir", "swir1") and v is not None}
    if "green" not in roles or not ({"nir", "swir1"} & set(roles)):
        raise ToolError("Name the green band and a NIR or SWIR1 band (MNDWI uses SWIR1, NDWI uses NIR).")
    use = ["green", "swir1" if "swir1" in roles else "nir"]
    grids = r.read_bands([roles[k] for k in use])
    qa = params.get("qa")
    if qa and isinstance(qa, dict) and qa.get("kind") in ("scl", "landsat"):
        _, note = apply_qa(r, grids, qa)
        notes.append(f"{r.meta.filename}: {note}")
    v, name = wp.water_index({k: g.data for k, g in zip(use, grids, strict=True)})
    return v, name


def _radar_db(r: Raster, band: int, notes: list[str]) -> np.ndarray:
    if not 0 <= band < r.meta.bands:
        raise ToolError(f"{r.meta.filename} has {r.meta.bands} band(s); choose the VV band between 1 and {r.meta.bands}.")
    (g,) = r.read_bands([band])
    scale = detect_scale(r, band)
    lin = to_linear(g.data.astype(np.float64), scale)
    bad = ~np.isfinite(lin) | (lin <= 0)
    filt = lee_filter(np.where(bad, np.nan, lin))
    with np.errstate(divide="ignore", invalid="ignore"):
        db = 10 * np.log10(filt)
    notes.append(f"{r.meta.filename}: band {band + 1} read as {'dB' if scale == 'db' else 'linear power'}; Lee (1980) 5 × 5 speckle filter in linear power, then dB.")
    return np.where(bad | ~np.isfinite(db), np.nan, db)


@tool("water")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    mode = params.get("mode", "optical")
    if mode not in ("optical", "radar"):
        raise ToolError("Choose optical (a water index) or radar (Sentinel-1 backscatter).")
    a = raster(ctx, inputs, "a")
    b = raster(ctx, inputs, "b", required=False)
    if b is not None and not same_grid(a.meta, b.meta):
        raise ToolError("The two images must be on the same grid (same area, pixel size and CRS) to be compared pixel by pixel.")
    bnd = boundary(params)
    notes: list[str] = []
    ctx.progress(0.2, "Reading the images")
    if mode == "optical":
        va, name = _optical(a, params, notes)
        vb = _optical(b, params, notes)[0] if b is not None else None
        unit, plausible, default = "", wp.INDEX_RANGE, wp.INDEX_DEFAULT
    else:
        band = int(number(params, "band", 0, 0, 100, "Choose the VV band (1 for Sentinel-1 files from TerraX)."))
        va, name = _radar_db(a, band, notes), "VV backscatter"
        vb = _radar_db(b, band, notes) if b is not None else None
        unit, plausible, default = " dB", wp.SAR_RANGE, wp.SAR_DEFAULT
    inside = np.ones(va.shape, dtype=bool)
    if bnd:
        from ..processing.rio import Grid

        try:
            inside, _ = boundary_mask(a, Grid(width=a.gw, height=a.gh, data=va.astype(np.float32), resample_factor=a.resample_factor), bnd)
        except ValueError as e:
            raise ToolError(str(e)) from None
    ctx.progress(0.6, "Finding water")
    # One threshold for both dates (from the later image, or the only one), so the dates are judged alike.
    ref = vb if vb is not None else va
    manual = params.get("threshold")
    if manual not in (None, "", "auto"):
        thr = number(params, "threshold", 0, -60, 60, "Set the threshold as a number, or leave it automatic.")
        notes.append(f"Threshold {fmt_unit(thr, unit)} set by hand.")
    else:
        thr, note = wp.auto_threshold(ref[inside], plausible, default, unit)
        notes.append(note)
    def is_water(v: np.ndarray) -> np.ndarray:  # above the index threshold, or below the backscatter threshold; never where unobserved
        with np.errstate(invalid="ignore"):
            return np.isfinite(v) & ((v >= thr) if mode == "optical" else (v <= thr))

    valid_a = np.isfinite(va) & inside
    extra = None
    if vb is not None:
        valid_b = np.isfinite(vb) & inside
        if mode == "radar":
            drop = number(params, "dropDb", 3, 0.5, 20, "Set the backscatter drop between 0.5 and 20 dB.")
            with np.errstate(invalid="ignore"):
                extra = vb - va <= -drop
            notes.append(f"New water must also have lost at least {fmt_unit(drop, ' dB')} of backscatter since the first date, so permanently dark surfaces are not counted as flood.")
        cls = wp.classify(is_water(va) & valid_a, valid_a, is_water(vb) & valid_b, valid_b, extra)
    else:
        cls = wp.classify(is_water(va) & valid_a, valid_a)
    geo = ground_geometry(a.meta, a.gw, a.gh)
    two = vb is not None
    legend = wp.TWO_DATES if two else wp.ONE_DATE
    summary = wp.summarise(cls, geo.cell_area if geo else None, two)
    if mode == "optical":
        notes.append(f"{name}: positive over open water (McFeeters 1996; Xu 2006). Shadows of terrain and buildings, dark asphalt and turbid or "
                     "vegetated water can be misclassified; MNDWI (with SWIR1) separates water from built-up land better than NDWI.")
    else:
        notes.append("Calm open water is dark to the radar. Flooded vegetation and flooded towns can look brighter instead (double bounce) and are missed; "
                     "radar shadow, smooth tarmac and dry sand can look like water. Compare dates from the same orbit.")
    if geo:
        notes.append(geo.note)
    if a.resample_factor > 1:
        notes.append(f"Analysed on a resampled grid (each cell = {wp.fmt(a.resample_factor, 3)} original pixels; TERRAX_GRID_PIXELS sets the limit), so narrow "
                     "channels and small ponds can be missed; areas use the true size of the resampled cells.")
    unobserved = int((cls == 0).sum() - (~inside).sum())
    if unobserved > 0:
        notes.append(f"{unobserved:,} pixels inside the area had no valid observation (cloud or no data) on {'a' if two else 'the'} date and are left out.")

    ctx.progress(0.8, "Writing the map")
    label = "Water change" if two else "Surface water"
    image = class_overlay(ctx, "water.png", cls, legend, a, label)
    downloads: list[dict[str, Any]] = []
    target = 3 if two else 2  # new water, or water
    labels, n = label_patches(cls == target)
    mmu = number(params, "mmuHa", 0, 0, 1000, "Set the minimum patch between 0 and 1,000 ha.")
    if n and geo:
        area = patch_areas(labels, n, geo.cell_area) / 1e4
        if mmu:
            small = area < mmu
            small[0] = False
            labels = np.where(small[labels], 0, labels)
        fc = patches_to_geojson(labels, n, area, a, lambda i, ha: {"patch": i, "kind": "new water" if two else "water", "area_ha": round(ha, 4)})
        if fc and fc["fc"]["features"]:
            fname = f"{a.meta.filename.rsplit('.', 1)[0]}_{'new_water' if two else 'water'}.geojson"
            downloads.append(ctx.download(f"Export {'new water' if two else 'water'} polygons (GeoJSON)", fname, ctx.json(fname, fc["fc"]), "application/geo+json")
                             | {"features": len(fc["fc"]["features"])})
    tif = class_geotiff(ctx, f"{a.meta.filename.rsplit('.', 1)[0]}_water.tif", "water classes", cls, legend, a)
    if tif:
        downloads.append(tif)
    dates = [f"{'Before' if two else 'Image'}: {a.meta.filename}"] + ([f"After: {b.meta.filename}"] if b is not None else [])
    res = {"mode": mode, "index": name, "threshold": thr, "unit": unit.strip(), "summary": summary, "dates": dates, "notes": notes, "mmuHa": mmu,
           "width": a.gw, "height": a.gh}
    return clean({"tool": "water", "name": f"{label}: {a.meta.filename}", "markdown": wp.water_markdown(res), "map": {"bounds": a.meta.latlng_bounds, "image": image},
                  "result": res, "legend": legend, "downloads": downloads})


def fmt_unit(v: float, unit: str) -> str:
    from ..processing.stats import fmt

    return f"{fmt(v, 3)}{unit}"
