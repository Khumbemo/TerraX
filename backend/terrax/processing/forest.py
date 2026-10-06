"""Forest-loss estimation.

1. Two-date NDVI differencing: forest = NDVI(before) ≥ forest threshold; loss =
   forest pixels whose ΔNDVI = NDVI(after) − NDVI(before) is at or below the loss
   threshold. Gain = non-forest pixels that rise by at least the same magnitude.
2. Hansen et al. (2013) Global Forest Change "lossyear", with an optional
   "treecover2000" layer to define the baseline forest.
3. Burn severity from the differenced Normalized Burn Ratio, dNBR = NBR(pre) −
   NBR(post), classed with the USGS FIREMON ranges (Key & Benson 2006).

Patches smaller than a minimum mapping unit can be removed (8-connected), and
loss/burn patches are exported as polygons.
"""

from __future__ import annotations

from datetime import UTC, datetime

import numpy as np

from .indices import compute_index_grid
from .patches import apply_mmu, label_patches, patch_areas, patches_to_geojson
from .rio import Grid, Raster, ground_geometry, same_grid
from .stats import fmt
from .zonal import apply_mask, boundary_mask, clip_note

CHANGE_CLASSES = [
    {"id": 1, "label": "Stable forest", "color": [46, 125, 72]},
    {"id": 2, "label": "Forest loss", "color": [229, 72, 77]},
    {"id": 3, "label": "Non-forest", "color": [58, 72, 88]},
    {"id": 4, "label": "Vegetation gain", "color": [126, 211, 132]},
]
BURN_CLASSES = [
    {"id": 1, "label": "Enhanced regrowth, high (< −0.25)", "upTo": -0.25, "color": [122, 135, 55]},
    {"id": 2, "label": "Enhanced regrowth, low (−0.25 to −0.1)", "upTo": -0.1, "color": [172, 190, 77]},
    {"id": 3, "label": "Unburned (−0.1 to 0.1)", "upTo": 0.1, "color": [10, 224, 66]},
    {"id": 4, "label": "Low severity (0.1 to 0.27)", "upTo": 0.27, "color": [255, 247, 11]},
    {"id": 5, "label": "Moderate-low severity (0.27 to 0.44)", "upTo": 0.44, "color": [255, 175, 56]},
    {"id": 6, "label": "Moderate-high severity (0.44 to 0.66)", "upTo": 0.66, "color": [255, 100, 27]},
    {"id": 7, "label": "High severity (≥ 0.66)", "upTo": float("inf"), "color": [164, 31, 214]},
]
NO_UNITS = "The CRS has no ground units TerraX can use, so results are in pixels only."


def is_loss_class(mode: str, classes: np.ndarray) -> np.ndarray:
    return classes >= 4 if mode == "burn" else classes == 2


class _Acc:
    def __init__(self, raster: Raster, grid: Grid):
        self.geo = ground_geometry(raster.meta, grid.width, grid.height)
        self.rows = self.geo.cell_area if self.geo else np.zeros(grid.height)
        self.grid = np.broadcast_to(self.rows[:, None], (grid.height, grid.width))

    def unit(self, mask: np.ndarray) -> dict:
        px = int(mask.sum())
        return {"ha": float(self.grid[mask].sum()) / 10_000 if self.geo else None, "pixels": px}


def _patch_step(mode, classes, acc: _Acc, replace_with, mmu_ha, notes) -> dict | None:
    target = is_loss_class(mode, classes)
    if not acc.geo:
        if mmu_ha > 0:
            notes.append("The minimum mapping unit was not applied: the CRS has no ground units.")
        return None
    removed = np.zeros(classes.shape, dtype=bool)
    removed_patches = 0
    if mmu_ha > 0:
        m = apply_mmu(classes, target, replace_with, mmu_ha * 10_000, acc.rows)
        removed = m["removedMask"]
        removed_patches = m["removedPatches"]
        count, largest = m["keptCount"], m["keptLargest"]
        what = "burned" if mode == "burn" else "loss"
        into = "unburned" if mode == "burn" else "stable forest"
        extra = "" if mode == "burn" else " (FAO’s forest definition uses 0.5 ha)"
        notes.append(f"Minimum mapping unit {mmu_ha:g} ha: {removed_patches:,} {what} patches smaller than this (8-connected pixels) were reclassified as {into}{extra}.")
    else:
        labels, n = label_patches(target)
        area = patch_areas(labels, n, acc.rows)
        count, largest = n, float(area[1:].max()) if n else 0.0
    return {"count": count, "largest": {"ha": largest / 10_000, "pixels": 0}, "mmuHa": mmu_ha, "removedPatches": removed_patches,
            "removedArea": acc.unit(removed), "_removed": removed}


def _check_range(g: Grid, name: str, what: str = "NDVI", hint: str = "For multi-band imagery, assign the red and NIR bands.") -> None:
    v = g.data.ravel()[::7]
    v = v[np.isfinite(v)]
    if v.size and ((v < -1.001) | (v > 1.001)).mean() > 0.01:
        raise ValueError(f"{name} has values outside −1…1, so it does not look like {what}. {hint}")


def _index(raster: Raster, bands: dict, index: str, roles: tuple[str, str]) -> tuple[Grid, str]:
    if raster.meta.bands == 1:
        (g,) = raster.read_bands([0])
        return g, f"{raster.meta.filename}: single band read as {index.upper()}."
    g, _ = compute_index_grid(raster, index, bands)
    a, b = roles
    labels = {"nir": "NIR", "red": "red", "swir2": "SWIR2"}
    return g, f"{raster.meta.filename}: {index.upper()} from band {int(bands[a]) + 1} ({labels[a]}) and band {int(bands[b]) + 1} ({labels[b]})."


def _clip(raster, boundary, *grids) -> str | None:
    if not boundary:
        return None
    inside, n = boundary_mask(raster, grids[0], boundary)
    for g in grids:
        if g is not None:
            apply_mask(g, inside)
    return clip_note(boundary, n)


def _finish_notes(notes, acc, grid, clip):
    if clip:
        notes.insert(0, clip)
    notes.append(acc.geo.note if acc.geo else NO_UNITS)


def analyze_ndvi_change(before: Raster, before_bands: dict, after: Raster, after_bands: dict, forest_thr: float, loss_thr: float, boundary=None, mmu_ha: float = 0) -> dict:
    if not same_grid(before.meta, after.meta):
        raise ValueError(f"The two images are on different grids ({before.meta.width}×{before.meta.height} vs {after.meta.width}×{after.meta.height}, or different extents or CRS). Export both dates with the same region, scale and CRS so pixels line up.")
    if loss_thr >= 0:
        raise ValueError("The loss threshold must be negative (a drop in NDVI).")
    b, nb = _index(before, before_bands, "ndvi", ("nir", "red"))
    a, na = _index(after, after_bands, "ndvi", ("nir", "red"))
    _check_range(b, before.meta.filename)
    _check_range(a, after.meta.filename)
    clip = _clip(before, boundary, b, a)
    acc = _Acc(before, b)
    # Compare in float64, as JavaScript did, so values exactly on a threshold are classed the same way.
    v0, v1 = b.data.astype(np.float64), a.data.astype(np.float64)
    valid = np.isfinite(v0) & np.isfinite(v1)
    d = np.where(valid, v1 - v0, 0)
    classes = np.zeros(v0.shape, dtype=np.uint8)
    forest = valid & (v0 >= forest_thr)
    loss = forest & (d <= loss_thr)
    gain = valid & ~forest & (d >= -loss_thr)
    classes[forest] = 1
    classes[loss] = 2
    classes[gain] = 4
    classes[valid & ~forest & ~gain] = 3
    notes = [nb, na,
             f"Forest is NDVI ≥ {forest_thr:g} on the earlier image; loss is a drop of {abs(loss_thr):g} or more (ΔNDVI ≤ {loss_thr:g}); gain is a rise of at least {abs(loss_thr):g} on non-forest.",
             "NDVI thresholds are a proxy for forest: they do not apply the FAO definition (≥ 10 % canopy cover, trees ≥ 5 m, ≥ 0.5 ha). Seasonal leaf fall, clouds, haze or different sensors can look like loss, so compare images from the same season and check hotspots against high-resolution imagery."]
    _finish_notes(notes, acc, b, clip)
    if b.resample_factor > 1:
        notes.append(f"Areas were computed on a resampled grid (each cell = {fmt(b.resample_factor, 3)} original pixels); cell areas were scaled to match.")
    patches = _patch_step("ndvi", classes, acc, 1, mmu_ha, notes)
    n_valid = int(valid.sum())
    return {"mode": "ndvi", "forestThreshold": forest_thr, "lossThreshold": loss_thr, "forestBefore": acc.unit(forest), "loss": acc.unit(classes == 2),
            "gain": acc.unit(gain), "validPixels": n_valid, "meanDelta": float(d[valid].mean()) if n_valid else None,
            "classes": classes, "width": b.width, "height": b.height, "patches": patches, "notes": notes}


def analyze_hansen(loss_year: Raster, tree_cover: Raster | None, canopy_thr: float, boundary=None, mmu_ha: float = 0) -> dict:
    if tree_cover and not same_grid(loss_year.meta, tree_cover.meta):
        raise ValueError("The lossyear and treecover2000 files are on different grids. Download the same Hansen tile for both.")
    (ly,) = loss_year.read_bands([0])
    tc = tree_cover.read_bands([0])[0] if tree_cover else None
    s = ly.data.ravel()[::11]
    s = s[np.isfinite(s)]
    if s.size and ((s != np.round(s)) | (s < 0) | (s > 60)).any():
        raise ValueError(f"{loss_year.meta.filename} does not look like a Hansen lossyear layer (values should be whole numbers 0–{datetime.now(UTC).year - 2000}).")
    clip = _clip(loss_year, boundary, ly, tc)
    acc = _Acc(loss_year, ly)
    v = ly.data.astype(np.float64)
    present = np.isfinite(v)
    if tc is not None:
        cover = tc.data.astype(np.float64)
        present &= np.isfinite(cover)
        forest = present & (cover >= canopy_thr)
    else:
        forest = present
    classes = np.zeros(v.shape, dtype=np.uint8)
    classes[present & ~forest] = 3
    lost = forest & (np.nan_to_num(v) >= 1)
    classes[forest] = 1
    classes[lost] = 2
    mmu_notes: list[str] = []
    patches = _patch_step("hansen", classes, acc, 1, mmu_ha, mmu_notes)
    lost = classes == 2
    years = np.nan_to_num(v).astype(int)
    by_year = [{"year": 2000 + int(y), "area": acc.unit(lost & (years == y))} for y in np.unique(years[lost])]
    notes = ["Hansen et al. (2013), Science 342:850–853, Global Forest Change: lossyear = year of stand-replacing tree-cover loss (1 = 2001).",
             f"Baseline forest = treecover2000 ≥ {canopy_thr:g} % canopy (Global Forest Watch commonly uses 30 %). Only loss inside the baseline is counted." if tc is not None
             else "No treecover2000 layer was given, so every lossyear pixel counts and no baseline forest area or percentage is reported.",
             '"Loss" includes harvest, fire, storm and disease, not only deforestation; year-to-year comparisons across the whole record are affected by algorithm updates (see the GFC version notes).']
    _finish_notes(notes, acc, ly, clip)
    if ly.resample_factor > 1:
        notes.append(f"Areas were computed on a resampled grid (each cell = {fmt(ly.resample_factor, 3)} original pixels).")
    notes += mmu_notes
    return {"mode": "hansen", "canopyThreshold": canopy_thr if tc is not None else None, "baseline": acc.unit(forest) if tc is not None else None,
            "totalLoss": acc.unit(lost), "byYear": by_year, "classes": classes, "width": ly.width, "height": ly.height, "patches": patches, "notes": notes}


def analyze_burn(pre: Raster, pre_bands: dict, post: Raster, post_bands: dict, boundary=None, mmu_ha: float = 0) -> dict:
    if not same_grid(pre.meta, post.meta):
        raise ValueError("The pre- and post-fire images are on different grids. Export both with the same region, scale and CRS so pixels line up.")
    b, nb = _index(pre, pre_bands, "nbr", ("nir", "swir2"))
    a, na = _index(post, post_bands, "nbr", ("nir", "swir2"))
    for g, name in ((b, pre.meta.filename), (a, post.meta.filename)):
        _check_range(g, name, "NBR", "For multi-band imagery, assign the NIR and SWIR2 bands.")
    clip = _clip(pre, boundary, b, a)
    acc = _Acc(pre, b)
    pre_v, post_v = b.data.astype(np.float64), a.data.astype(np.float64)
    valid = np.isfinite(pre_v) & np.isfinite(post_v)
    d = np.where(valid, pre_v - post_v, np.nan)
    classes = np.zeros(d.shape, dtype=np.uint8)
    lower = -np.inf
    for c in BURN_CLASSES:
        classes[valid & (d >= lower) & (d < c["upTo"])] = c["id"]
        lower = c["upTo"]
    notes = [nb, na,
             "dNBR = NBR(pre-fire) − NBR(post-fire), NBR = (NIR − SWIR2) / (NIR + SWIR2); classes follow the USGS FIREMON ranges (Key & Benson 2006): low severity from 0.10, moderate-low from 0.27, moderate-high from 0.44, high from 0.66.",
             "These thresholds are generic: severity depends on pre-fire vegetation, and field plots (Composite Burn Index) are needed to calibrate them locally. Use cloud- and smoke-free images from the same season, ideally within a year of the fire."]
    _finish_notes(notes, acc, b, clip)
    patches = _patch_step("burn", classes, acc, 3, mmu_ha, notes)
    n_valid = int(valid.sum())
    areas = [acc.unit(classes == c["id"]) for c in BURN_CLASSES]
    return {"mode": "burn", "classAreas": areas, "burned": acc.unit(classes >= 4), "meanDnbr": float(np.nanmean(d)) if n_valid else None,
            "validPixels": n_valid, "classes": classes, "width": b.width, "height": b.height, "patches": patches, "notes": notes}


def loss_polygons(r: dict, raster: Raster) -> dict | None:
    geo = ground_geometry(raster.meta, r["width"], r["height"])
    rows = geo.cell_area if geo else np.ones(r["height"])
    labels, n = label_patches(is_loss_class(r["mode"], r["classes"]))
    if not n:
        return {"fc": {"type": "FeatureCollection", "features": []}, "truncated": 0}
    area = patch_areas(labels, n, rows)
    kind = "burned (dNBR ≥ 0.1)" if r["mode"] == "burn" else "forest loss"
    return patches_to_geojson(labels, n, area, raster,
                              lambda i, a: {"patch": i, "kind": kind, **({"area_ha": round(a / 10_000, 4)} if geo else {"pixels": a})})


def _share(px: int, total: int) -> str:
    return f"{px / total * 100:.2f}" if total else "—"


def format_area(a: dict | None) -> str:
    if not a:
        return "—"
    if a["ha"] is None:
        return f"{a['pixels']:,} px"
    if a["ha"] >= 100:
        return f"{fmt(a['ha'], 5)} ha ({fmt(a['ha'] / 100, 4)} km²)"
    return f"{fmt(a['ha'], 4)} ha"


def forest_markdown(r: dict, names: list[str]) -> str:
    lines = ["## Dataset", "", *[f"- {n}" for n in names], "", "## Results", ""]
    fa = format_area
    if r["mode"] == "ndvi":
        pct = r["loss"]["pixels"] / r["forestBefore"]["pixels"] * 100 if r["forestBefore"]["pixels"] else None
        lines += ["| Measure | Value |", "|---|---|", f"| Forest at start (NDVI ≥ {r['forestThreshold']:g}) | {fa(r['forestBefore'])} |",
                  f"| Forest loss (ΔNDVI ≤ {r['lossThreshold']:g}) | {fa(r['loss'])} |",
                  f"| Loss as share of starting forest | {f'{pct:.2f} %' if pct is not None else '—'} |", f"| Vegetation gain on non-forest | {fa(r['gain'])} |",
                  f"| Mean ΔNDVI (all valid pixels) | {fmt(r['meanDelta'])} |", f"| Valid pixels compared | {r['validPixels']:,} |", ""]
    elif r["mode"] == "burn":
        v = r["validPixels"]
        lines += ["| Measure | Value |", "|---|---|", f"| Burned area (dNBR ≥ 0.1) | {fa(r['burned'])} |", f"| Mean dNBR (all valid pixels) | {fmt(r['meanDnbr'])} |",
                  f"| Valid pixels compared | {v:,} |", "", "### Severity classes", "", "| Class | Area | Share |", "|---|---|---|",
                  *[f"| {c['label']} | {fa(a)} | {_share(a['pixels'], v)} % |" for c, a in zip(BURN_CLASSES, r["classAreas"], strict=True)], ""]
    else:
        base = r["baseline"]
        pct = r["totalLoss"]["pixels"] / base["pixels"] * 100 if base and base["pixels"] else None
        lines += ["| Measure | Value |", "|---|---|"]
        if base:
            lines.append(f"| Forest in 2000 (canopy ≥ {r['canopyThreshold']:g} %) | {fa(base)} |")
        lines.append(f"| Total tree-cover loss | {fa(r['totalLoss'])} |")
        if pct is not None:
            lines.append(f"| Loss as share of 2000 forest | {pct:.2f} % |")
        lines += ["", "### Loss by year", "", "| Year | Loss |", "|---|---|", *[f"| {y['year']} | {fa(y['area'])} |" for y in r["byYear"]], ""]
    p = r["patches"]
    if p:
        what = "Burned" if r["mode"] == "burn" else "Loss"
        mmu = f" Minimum mapping unit {p['mmuHa']:g} ha removed {p['removedPatches']:,} patches ({fa(p['removedArea'])})." if p["mmuHa"] > 0 else ""
        lines += [f"{what} patches (8-connected): {p['count']:,}; largest {fa(p['largest'])}.{mmu}", ""]
    lines += ["## Method and limits", "", *[f"- {n}" for n in r["notes"]]]
    return "\n".join(lines)


def legend(mode: str) -> list[dict]:
    if mode == "burn":
        return BURN_CLASSES
    return [c for c in CHANGE_CLASSES if mode == "ndvi" or c["id"] != 4]
