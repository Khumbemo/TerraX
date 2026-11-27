"""Surface water and floods (processing/water.py): optical water indices or Sentinel-1 backscatter, one date, two, or a
series (water occurrence); with an inventory of water bodies and optical water-quality indices (processing/waterbodies.py)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import numpy as np

from ..processing import water as wp
from ..processing import waterbodies as wb
from ..processing.indices import guess_band_map
from ..processing.patches import label_patches, patch_areas, patches_to_geojson
from ..processing.radar import detect_scale, lee_filter, to_linear
from ..processing.rio import Raster, apply_qa, ground_geometry, same_grid
from ..processing.zonal import boundary_mask
from . import tool
from .common import boundary, class_geotiff, class_overlay, clean, display_grid, grid_crs, number, raster
from .context import ToolContext, ToolError

HAND_MAX_DEFAULT = 15.0  # m; TerraX's default, to be set from the terrain and the flood heights expected there
STREAM_KM2_DEFAULT = 0.5  # km² draining to a cell for it to start a channel: the hydrology tool's default


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


def _hand_on_grid(ctx: ToolContext, inputs: dict, a: Raster, stream_km2: float, notes: list[str]) -> np.ndarray:
    """Height above the nearest drainage, computed on the DEM's own grid and warped onto the image's analysis grid
    (bilinear); NaN outside the DEM or where no channel is reached."""
    from rasterio.crs import CRS
    from rasterio.warp import Resampling, reproject

    from ..config import settings
    from ..processing.terrain import height_above_drainage

    dem = raster(ctx, inputs, "dem", pixels=settings().dem_pixels)
    if not dem.meta.crs_wkt or not a.meta.crs_wkt or dem.transform is None or a.transform is None:
        raise ToolError("The DEM and the image both need a known coordinate reference system to be combined.")
    geo = ground_geometry(dem.meta, dem.gw, dem.gh)
    if geo is None:
        raise ToolError("The DEM's pixel size could not be measured in metres; HAND needs ground units.")
    (z,) = dem.read_bands([0])
    ctx.progress(0.3, "Height above the nearest drainage")
    hand, _ = height_above_drainage(z.data.astype(np.float64), geo, stream_km2 * 1e6)
    out = np.full((a.gh, a.gw), np.nan, dtype=np.float32)
    reproject(hand, out, src_transform=dem.transform, src_crs=CRS.from_wkt(dem.meta.crs_wkt), dst_transform=a.transform,
              dst_crs=CRS.from_wkt(a.meta.crs_wkt), src_nodata=np.nan, dst_nodata=np.nan, resampling=Resampling.bilinear)
    covered = float(np.isfinite(out).mean() * 100)
    notes.append(f"Height above the nearest drainage (HAND; Rennó et al. 2008, Nobre et al. 2011) from {dem.meta.filename}: D8 flow on the "
                 f"depression-filled DEM, channels where at least {wp.fmt(stream_km2, 3)} km² drains; "
                 f"known for {wp.fmt(covered, 3)} % of the image (elsewhere the DEM is missing or no channel is reached, and nothing is removed).")
    return out


def _boundary_inside(a: Raster, va: np.ndarray, bnd: dict | None) -> np.ndarray:
    if not bnd:
        return np.ones(va.shape, dtype=bool)
    from ..processing.rio import Grid

    try:
        inside, _ = boundary_mask(a, Grid(width=a.gw, height=a.gh, data=va.astype(np.float32), resample_factor=a.resample_factor), bnd)
    except ValueError as e:
        raise ToolError(str(e)) from None
    return inside


def _hand_mask(ctx: ToolContext, inputs: dict, params: dict, a: Raster, notes: list[str]) -> tuple[np.ndarray | None, float]:
    """Cells too high above their nearest channel to hold water (None without a DEM), and the limit."""
    if not inputs.get("dem"):
        return None, 0.0
    stream_km2 = number(params, "streamKm2", STREAM_KM2_DEFAULT, 0.0001, 100000, "Set the channel threshold as a positive area in km².")
    hand = _hand_on_grid(ctx, inputs, a, stream_km2, notes)
    hand_max = number(params, "handMax", HAND_MAX_DEFAULT, 0.5, 500, "Set the HAND limit between 0.5 and 500 m.")
    with np.errstate(invalid="ignore"):
        return hand > hand_max, hand_max  # NaN (unknown) is not too high


def _hand_note(hand_max: float, amount: str, later: bool) -> str:
    return (f"Water more than {wp.fmt(hand_max, 3)} m above its nearest channel was removed ({amount}{' on the later date' if later else ''}): "
            "dark terrain shadow and steep slopes that look like water. The limit is a setting, not a calibrated value: set it from "
            "the flood heights expected locally; it also removes real water on hilltops and terraces, such as ponds and reservoirs.")


def _method_note(mode: str, name: str) -> str:
    if mode == "optical":
        return (f"{name}: positive over open water (McFeeters 1996; Xu 2006). Shadows of terrain and buildings, dark asphalt and turbid or "
                "vegetated water can be misclassified; MNDWI (with SWIR1) separates water from built-up land better than NDWI.")
    return ("Calm open water is dark to the radar. Flooded vegetation and flooded towns can look brighter instead (double bounce) and are missed; "
            "radar shadow, smooth tarmac and dry sand can look like water. Compare dates from the same orbit.")


def _threshold(params: dict, values: np.ndarray, plausible: tuple[float, float], default: float, unit: str, notes: list[str]) -> float:
    manual = params.get("threshold")
    if manual not in (None, "", "auto"):
        thr = number(params, "threshold", 0, -60, 60, "Set the threshold as a number, or leave it automatic.")
        notes.append(f"Threshold {fmt_unit(thr, unit)} set by hand.")
        return thr
    thr, note = wp.auto_threshold(values, plausible, default, unit)
    notes.append(note)
    return thr


def _quality(r: Raster, params: dict, water: np.ndarray, notes: list[str]) -> dict[str, np.ndarray] | None:
    """NDTI (and NDCI with a red-edge band) of the image, NaN outside interior water; None without a red band."""
    roles = {k: int(v) for k, v in (params.get("bands") or guess_band_map(r.meta.bands)).items() if k in ("green", "red", "rededge") and v is not None}
    if r.meta.bands == 1 or "red" not in roles or "green" not in roles:
        notes.append("Water quality was not estimated: it needs the green and red bands of a multispectral image (name the red band).")
        return None
    if not all(0 <= roles[k] < r.meta.bands for k in roles):
        raise ToolError(f"{r.meta.filename} has {r.meta.bands} bands; choose band numbers between 1 and {r.meta.bands}.")
    use = [k for k in ("green", "red", "rededge") if k in roles]
    grids = dict(zip(use, (g.data for g in r.read_bands([roles[k] for k in use])), strict=True))
    core = wb.interior(water)
    out = {"ndti": np.where(core, wb.normalised_difference(grids["red"], grids["green"]), np.nan)}
    if "rededge" in grids:
        out["ndci"] = np.where(core, wb.normalised_difference(grids["rededge"], grids["red"]), np.nan)
    notes.append("Water quality indices (relative indicators, not concentrations): NDTI = (Red − Green) / (Red + Green), higher in more turbid "
                 "water (Lacaux et al. 2007)" + ("; NDCI = (Red-edge − Red) / (Red-edge + Red), higher with more chlorophyll-a (Mishra & Mishra 2012)"
                                                 if "rededge" in grids else "; NDCI (chlorophyll) needs a red-edge band near 705 nm (Sentinel-2 band 5), which was not given")
                 + f". From {r.meta.filename}, on interior water pixels only (all 8 neighbours water), since shore pixels mix in land. Turning them into "
                 "turbidity (NTU) or chlorophyll-a (µg/L) needs water samples taken near the image date. Shallow clear water (the bottom shows), sun "
                 "glint, floating plants, haze and thin cloud change them; use atmospherically corrected surface reflectance. Sentinel-2 L2A digital "
                 "numbers processed since January 2022 carry an offset of −1000 that must be removed first (TerraX's own downloads already are reflectance).")
    return out


def _quality_image(ctx: ToolContext, name: str, values: np.ndarray, colors: list[str]) -> dict[str, Any] | None:
    from ..processing.render import ramp_rgba

    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return None
    lo, hi = (float(x) for x in np.percentile(finite, [2, 98]))
    if not hi > lo:
        lo, hi = lo - 0.05, hi + 0.05
    url = ctx.png(name, ramp_rgba(display_grid(values), lo, hi, colors))
    return {"url": url, "min": lo, "max": hi, "colors": colors}


def _mean_of(values: np.ndarray, cell_area: np.ndarray) -> Callable[[wb.Inventory], np.ndarray]:
    return lambda inv: wb.body_means(inv.labels, inv.count, values, np.isfinite(values), cell_area)


NDTI_COLORS = ["#0b3d91", "#2a9d8f", "#e9c46a", "#a0522d"]  # clear blue → sediment brown
NDCI_COLORS = ["#0b3d91", "#2a9d8f", "#7ac943", "#1b5e20"]  # blue → green


def _inventory_outputs(ctx: ToolContext, a: Raster, stem: str, water: np.ndarray, unknown: np.ndarray, geo, mmu: float, what: str,
                       extra: dict[str, Callable[[wb.Inventory], np.ndarray]], extra_cols: list[tuple[str, str]], digits: dict[str, int] | None = None) -> tuple[dict[str, Any], list[dict], list[str], str]:
    """Inventory of the water bodies of `water`: summary, downloads, notes and markdown."""
    inv = wb.inventory(water, unknown, geo, a.transform, grid_crs(a), a.meta.geographic, mmu)
    ex = {k: f(inv) for k, f in extra.items()} if extra else {}
    records = wb.rows(inv, ex, digits)
    downloads: list[dict[str, Any]] = []
    if records:
        downloads.append(ctx.download("Export water-body inventory (CSV)", f"{stem}_water_bodies.csv", ctx.text(f"{stem}_water_bodies.csv", wb.to_csv(records)), "text/csv")
                         | {"rows": min(len(records), wb.CSV_MAX)})
        fc = patches_to_geojson(inv.labels, inv.count, inv.area_ha, a, lambda i, ha: records[i - 1])
        if fc and fc["fc"]["features"]:
            name = f"{stem}_water_bodies.geojson"
            downloads.append(ctx.download("Export water bodies (GeoJSON)", name, ctx.json(name, fc["fc"]), "application/geo+json") | {"features": len(fc["fc"]["features"])})
    summary = {"count": inv.count, "ha": float(inv.area_ha[1:].sum()), "largestHa": float(inv.area_ha[1]) if inv.count else 0.0,
               "truncated": int(inv.truncated[1:].sum()), "removed": inv.removed, "sizes": wb.size_summary(inv), "top": records[:15],
               "columns": [{"key": k, "label": lab} for k, lab in extra_cols]}
    return summary, downloads, wb.inventory_notes(inv, mmu, what), wb.inventory_markdown(inv, records, extra_cols)


@tool("water")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    mode = params.get("mode", "optical")
    if mode not in ("optical", "radar"):
        raise ToolError("Choose optical (a water index) or radar (Sentinel-1 backscatter).")
    if inputs.get("images"):
        return _series(ctx, inputs, params, mode)
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
    inside = _boundary_inside(a, va, bnd)
    too_high_or_none, hand_max = _hand_mask(ctx, inputs, params, a, notes)
    too_high = too_high_or_none if too_high_or_none is not None else np.zeros(va.shape, dtype=bool)
    ctx.progress(0.6, "Finding water")
    # One threshold for both dates (from the later image, or the only one), so the dates are judged alike.
    ref = vb if vb is not None else va
    thr = _threshold(params, ref[inside], plausible, default, unit, notes)

    def raw_water(v: np.ndarray) -> np.ndarray:  # above the index threshold, or below the backscatter threshold; never where unobserved
        with np.errstate(invalid="ignore"):
            return np.isfinite(v) & ((v >= thr) if mode == "optical" else (v <= thr))

    def is_water(v: np.ndarray) -> np.ndarray:
        return raw_water(v) & ~too_high

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
    notes.append(_method_note(mode, name))
    if geo:
        notes.append(geo.note)
    hand_removed = None
    if too_high_or_none is not None:
        removed = (raw_water(vb if vb is not None else va) & too_high & inside)
        cells = int(removed.sum())
        hand_removed = {"pixels": cells, "ha": float((removed * geo.cell_area[:, None]).sum()) / 1e4 if geo else None, "handMax": hand_max}
        amount = f"{wp.fmt(hand_removed['ha'], 4)} ha" if hand_removed["ha"] is not None else f"{cells:,} pixels"
        notes.append(_hand_note(hand_max, amount, vb is not None))
    if a.resample_factor > 1:
        notes.append(f"Analysed on a resampled grid (each cell = {wp.fmt(a.resample_factor, 3)} original pixels; TERRAX_GRID_PIXELS sets the limit), so narrow "
                     "channels and small ponds can be missed; areas use the true size of the resampled cells.")
    unobserved = int((cls == 0).sum() - (~inside).sum())
    if unobserved > 0:
        notes.append(f"{unobserved:,} pixels inside the area had no valid observation (cloud or no data) on {'a' if two else 'the'} date and are left out.")

    # Water bodies on the later date (or the only one), with their water quality.
    later = b if b is not None else a
    water_now = (cls == 2) | (cls == 3) if two else cls == 2
    mmu = number(params, "mmuHa", 0, 0, 1000, "Set the minimum patch between 0 and 1,000 ha.")
    quality: dict[str, Any] | None = None
    q_vals: dict[str, np.ndarray] = {}
    if mode == "optical" and params.get("quality", True) is not False:
        ctx.progress(0.7, "Water quality")
        q_vals = _quality(later, params, water_now, notes) or {}
    stem = a.meta.filename.rsplit(".", 1)[0]
    downloads: list[dict[str, Any]] = []
    bodies = None
    inv_md = None
    if geo is not None:
        ctx.progress(0.75, "Listing water bodies")
        extra_f: dict[str, Callable[[wb.Inventory], np.ndarray]] = {}
        cols: list[tuple[str, str]] = []
        if two:
            extra_f["new_water_ha"] = lambda inv: wb.body_areas(inv.labels, inv.count, cls == 3, geo.cell_area)
            cols.append(("new_water_ha", "New water (ha)"))
        for key, label in (("ndti", "NDTI"), ("ndci", "NDCI")):
            if key in q_vals:
                extra_f[key] = _mean_of(q_vals[key], geo.cell_area)
                cols.append((key, f"{label} (mean)"))
        bodies, inv_dl, inv_notes, inv_md = _inventory_outputs(ctx, a, stem, water_now, cls == 0, geo, mmu,
                                                               "water on the later date" if two else "water", extra_f, cols)
        downloads += inv_dl
        notes += inv_notes
    if q_vals:
        q: dict[str, Any] = {"source": later.meta.filename}
        for key, colors in (("ndti", NDTI_COLORS), ("ndci", NDCI_COLORS)):
            if key in q_vals:
                q[key] = wb.quality_stats(q_vals[key], np.isfinite(q_vals[key]))
                q[f"{key}Image"] = _quality_image(ctx, f"water_{key}.png", q_vals[key], colors) if q[key] else None
        if q.get("ndti") is None:
            notes.append("No interior water pixels (water with all 8 neighbours water), so water quality could not be estimated: the water bodies are too small or narrow for this pixel size.")
        else:
            quality = q

    ctx.progress(0.85, "Writing the map")
    label = "Water change" if two else "Surface water"
    image = class_overlay(ctx, "water.png", cls, legend, a, label)
    target = 3 if two else 2  # new water, or water
    if two and geo:
        labels, n = label_patches(cls == target)
        if n:
            area = patch_areas(labels, n, geo.cell_area) / 1e4
            if mmu:
                small = area < mmu
                small[0] = False
                labels = np.where(small[labels], 0, labels)
            fc = patches_to_geojson(labels, n, area, a, lambda i, ha: {"patch": i, "kind": "new water", "area_ha": round(ha, 4)})
            if fc and fc["fc"]["features"]:
                fname = f"{stem}_new_water.geojson"
                downloads.append(ctx.download("Export new water polygons (GeoJSON)", fname, ctx.json(fname, fc["fc"]), "application/geo+json")
                                 | {"features": len(fc["fc"]["features"])})
    tif = class_geotiff(ctx, f"{stem}_water.tif", "water classes", cls, legend, a)
    if tif:
        downloads.append(tif)
    dates = [f"{'Before' if two else 'Image'}: {a.meta.filename}"] + ([f"After: {b.meta.filename}"] if b is not None else [])
    res = {"mode": mode, "index": name, "threshold": thr, "unit": unit.strip(), "summary": summary, "dates": dates, "notes": notes, "mmuHa": mmu,
           "width": a.gw, "height": a.gh, "hand": hand_removed, "bodies": bodies, "quality": quality}
    return clean({"tool": "water", "name": f"{label}: {a.meta.filename}", "markdown": wp.water_markdown(res, inv_md), "map": {"bounds": a.meta.latlng_bounds, "image": image},
                  "result": res, "legend": legend, "downloads": downloads})


MAX_SERIES = 100


def _series(ctx: ToolContext, inputs: dict, params: dict, mode: str) -> dict:
    """Water occurrence over many dated images on one grid."""
    from ..processing.dates import date_from_filename

    ids = inputs.get("images")
    if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
        raise ToolError("List the images of the series by their file ids.")
    if not 3 <= len(ids) <= MAX_SERIES:
        raise ToolError(f"Water over time needs between 3 and {MAX_SERIES} images.")
    rasters: list[Raster] = []
    for fid in ids:
        f = ctx.file(fid)
        if f.kind != "raster":
            raise ToolError(f"{f.name} is not a GeoTIFF raster TerraX can read.")
        rasters.append(Raster(f.path, f.name))
    found = [(r, date_from_filename(r.meta.filename)) for r in rasters]
    undated = [r.meta.filename for r, d in found if d is None]
    if undated:
        raise ToolError(f"No date found in: {', '.join(undated)}. Put the acquisition date in each file name (for example S2_2024-03-15.tif).")
    dated = sorted(((r, d) for r, d in found if d is not None), key=lambda x: x[1])
    if len({d for _, d in dated}) < len(dated):
        raise ToolError("Two images have the same date. Keep one image per date.")
    a = dated[0][0]
    if not all(same_grid(a.meta, r.meta) and (r.gw, r.gh) == (a.gw, a.gh) for r, _ in dated):
        raise ToolError("All images must be on the same grid (same area, pixel size and CRS). Export every date with the same region, scale and CRS.")
    band = int(number(params, "band", 0, 0, 100, "Choose the VV band (1 for Sentinel-1 files from TerraX).")) if mode == "radar" else 0
    n = len(dated)
    min_obs = int(number(params, "minObs", min(3, n), 1, n, f"Set the minimum valid observations per pixel between 1 and {n}."))
    almost = number(params, "almostPct", 90, 50, 100, "Set the share for water almost always between 50 and 100 %.")
    notes: list[str] = []

    def values(r: Raster, keep_notes: bool) -> tuple[np.ndarray, str]:
        sink = notes if keep_notes and not (mode == "optical" and r.meta.bands == 1) else []  # single-band files: one note below
        if mode == "optical":
            return _optical(r, params, sink)
        return _radar_db(r, band, sink), "VV backscatter"

    unit, plausible, default = ("", wp.INDEX_RANGE, wp.INDEX_DEFAULT) if mode == "optical" else (" dB", wp.SAR_RANGE, wp.SAR_DEFAULT)
    bnd = boundary(params)
    inside: np.ndarray | None = None
    manual = params.get("threshold") not in (None, "", "auto")
    # Automatic threshold: pooled from an equal sample of every date's valid values (the dates are read again below,
    # so the whole series is never held in memory).
    pooled: list[np.ndarray] = []
    name = ""
    if not manual:
        rng = np.random.default_rng(0)
        per = max(1000, 2_000_000 // n)
        for i, (r, _) in enumerate(dated):
            ctx.progress(0.05 + 0.3 * i / n, f"Sampling {r.meta.filename}")
            v, name = values(r, False)
            if inside is None:
                inside = _boundary_inside(a, v, bnd)
            x = v[inside & np.isfinite(v)]
            pooled.append(x if x.size <= per else rng.choice(x, per, replace=False))
    pooled_values = np.concatenate(pooled) if pooled else np.zeros(0)
    thr = _threshold(params, pooled_values, plausible, default, unit, notes)
    notes.append("The same threshold is used for every date" + ("" if manual else ", found from an equal sample of every date's valid values") + ", so the dates are judged alike.")
    too_high_or_none, hand_max = _hand_mask(ctx, inputs, params, a, notes)
    geo = ground_geometry(a.meta, a.gw, a.gh)
    cell = geo.cell_area[:, None] if geo else None
    n_water = np.zeros((a.gh, a.gw), dtype=np.int32)
    n_valid = np.zeros((a.gh, a.gw), dtype=np.int32)
    per_date: list[dict[str, Any]] = []
    for i, (r, when) in enumerate(dated):
        ctx.progress(0.35 + 0.35 * i / n, f"Water on {when.isoformat()}")
        v, name = values(r, True)
        if inside is None:
            inside = _boundary_inside(a, v, bnd)
        ok = np.isfinite(v) & inside
        with np.errstate(invalid="ignore"):
            w_ = ok & ((v >= thr) if mode == "optical" else (v <= thr))
        if too_high_or_none is not None:
            w_ &= ~too_high_or_none
        n_water += w_
        n_valid += ok
        n_in = int(inside.sum())
        seen_ha = float((ok * cell).sum()) / 1e4 if cell is not None else None
        w_ha = float((w_ * cell).sum()) / 1e4 if cell is not None else None
        share = float(w_.sum()) / int(ok.sum()) * 100 if ok.any() else None
        if w_ha is not None and seen_ha:
            share = w_ha / seen_ha * 100
        per_date.append({"date": when.isoformat(), "file": r.meta.filename, "observedPct": float(ok.sum()) / max(1, n_in) * 100,
                         "waterPixels": int(w_.sum()), "waterHa": w_ha, "waterSharePct": share})
    assert inside is not None
    single = sum(1 for r, _ in dated if r.meta.bands == 1)
    if mode == "optical" and single:
        who = f"All {n} images have" if single == n else f"{single} of the {n} images {'have' if single > 1 else 'has'}"
        notes.append(f"{who} one band, read as a water index (NDWI or MNDWI) already computed.")
    ctx.progress(0.75, "Water occurrence")
    occ, cls = wb.occurrence(n_water, n_valid, min_obs, almost)
    cls = np.where(inside, cls, 0).astype(np.uint8)
    legend = [dict(c) for c in wb.OCCURRENCE_LEGEND]
    legend[2]["label"] = f"Water almost always (≥ {wp.fmt(almost, 3)} %)"
    classes = []
    for c in legend:
        m = cls == c["id"]
        classes.append({"id": c["id"], "label": c["label"], "pixels": int(m.sum()), "ha": float((m * cell).sum()) / 1e4 if cell is not None else None})
    few = int(((cls == 0) & inside).sum())
    notes.append(f"Water occurrence = observations as water / valid (cloud-free) observations, per pixel (as in Pekel et al. 2016). "
                 f"“Water almost always” is at least {wp.fmt(almost, 3)} % of valid observations and “water at times” anything less but more than none: "
                 "both are TerraX settings, not calibrated values. Whether “at times” means seasonal water, a reservoir drawn down or occasional floods "
                 "depends on when the images were taken; a series from one season says nothing about the others.")
    if few:
        notes.append(f"{few:,} pixels had fewer than {min_obs} valid observations and are left out (shown as no data).")
    notes.append(_method_note(mode, name))
    if too_high_or_none is not None:
        notes.append(_hand_note(hand_max, "on every date", False))
    if geo:
        notes.append(geo.note)
    if a.resample_factor > 1:
        notes.append(f"Analysed on a resampled grid (each cell = {wp.fmt(a.resample_factor, 3)} original pixels; TERRAX_GRID_PIXELS sets the limit).")
    stem = f"{a.meta.filename.rsplit('.', 1)[0]}_series"
    downloads: list[dict[str, Any]] = []
    bodies = None
    inv_md = None
    if geo is not None:
        ctx.progress(0.8, "Listing water bodies")
        ever = (cls == 2) | (cls == 3)
        extra = {"almost_always_ha": lambda inv: wb.body_areas(inv.labels, inv.count, cls == 3, geo.cell_area),
                 "mean_occurrence_pct": lambda inv: wb.body_means(inv.labels, inv.count, occ, ever, geo.cell_area)}
        bodies, inv_dl, inv_notes, inv_md = _inventory_outputs(
            ctx, a, stem, ever, cls == 0, geo, number(params, "mmuHa", 0, 0, 1000, "Set the minimum patch between 0 and 1,000 ha."),
            "water seen at least once", extra, [("almost_always_ha", "Almost always water (ha)"), ("mean_occurrence_pct", "Mean occurrence (%)")],
            {"mean_occurrence_pct": 1})
        downloads += inv_dl
        notes += inv_notes
    ctx.progress(0.9, "Writing the maps")
    image = class_overlay(ctx, "water_occurrence.png", cls, legend, a, "Water occurrence")
    tif = class_geotiff(ctx, f"{stem}_occurrence_classes.tif", "occurrence classes", cls, legend, a)
    if tif:
        downloads.append(tif)
    crs = grid_crs(a)
    if crs is not None:
        url = ctx.geotiff(f"{stem}_occurrence.tif", np.where(inside, occ, np.nan).astype(np.float32), a.transform, crs, nodata=float("nan"),
                          description="water occurrence (% of valid observations)")
        downloads.append(ctx.download("Export water occurrence, % (GeoTIFF)", f"{stem}_occurrence.tif", url, "image/tiff"))
    table = wb.to_csv([{"date": d["date"], "file": d["file"], "observed_pct": round(d["observedPct"], 2), "water_pixels": d["waterPixels"],
                        "water_ha": None if d["waterHa"] is None else round(d["waterHa"], 4),
                        "water_share_of_observed_pct": None if d["waterSharePct"] is None else round(d["waterSharePct"], 3)} for d in per_date])
    downloads.append(ctx.download("Export water on each date (CSV)", f"{stem}_water_by_date.csv", ctx.text(f"{stem}_water_by_date.csv", table), "text/csv"))
    res = {"mode": mode, "series": True, "index": name, "threshold": thr, "unit": unit.strip(), "minObs": min_obs, "almostPct": almost,
           "classes": classes, "dates": per_date, "notes": notes, "width": a.gw, "height": a.gh, "bodies": bodies}
    return clean({"tool": "water", "name": f"Water over time: {n} images, {per_date[0]['date']} to {per_date[-1]['date']}",
                  "markdown": wb.series_markdown(res, inv_md), "map": {"bounds": a.meta.latlng_bounds, "image": image},
                  "result": res, "legend": legend, "downloads": downloads})


def fmt_unit(v: float, unit: str) -> str:
    from ..processing.stats import fmt

    return f"{fmt(v, 3)}{unit}"
