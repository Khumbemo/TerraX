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
from typing import TypedDict

import numpy as np

from .indices import IndexPlan, plan_index
from .patches import apply_mmu, label_patches, patch_areas, patches_to_geojson
from .rio import Raster, ground_geometry, same_grid
from .stats import fmt
from .tiles import Strip, StripPlan, class_totals
from .zonal import clip_note


class ChangeClass(TypedDict):
    id: int
    label: str
    color: list[int]


class BurnClass(ChangeClass):
    upTo: float  # dNBR upper bound (exclusive)


CHANGE_CLASSES: list[ChangeClass] = [
    {"id": 1, "label": "Stable forest", "color": [46, 125, 72]},
    {"id": 2, "label": "Forest loss", "color": [229, 72, 77]},
    {"id": 3, "label": "Non-forest", "color": [58, 72, 88]},
    {"id": 4, "label": "Vegetation gain", "color": [126, 211, 132]},
]
BURN_CLASSES: list[BurnClass] = [
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


class _Totals:
    """Cells and area per class code of a finished class map."""

    def __init__(self, plan: StripPlan, classes: np.ndarray, n_classes: int = 8):
        self.geo = plan.geo
        self.counts, self.areas = class_totals(classes, plan.geo.cell_area if plan.geo else None, n_classes, plan.row_blocks())

    def unit(self, *codes: int) -> dict:
        px = int(sum(self.counts[c] for c in codes))
        return {"ha": float(sum(self.areas[c] for c in codes)) / 10_000 if self.areas is not None else None, "pixels": px}


def _patch_step(mode, classes, plan: StripPlan, replace_with, mmu_ha, notes) -> dict | None:
    target = is_loss_class(mode, classes)
    if not plan.geo:
        if mmu_ha > 0:
            notes.append("The minimum mapping unit was not applied: the CRS has no ground units.")
        return None
    rows = plan.geo.cell_area
    removed = {"ha": 0.0, "pixels": 0}
    removed_patches = 0
    if mmu_ha > 0:
        m = apply_mmu(classes, target, replace_with, mmu_ha * 10_000, rows)
        removed = {"ha": m["removedArea"] / 10_000, "pixels": m["removedPixels"]}
        removed_patches = m["removedPatches"]
        count, largest = m["keptCount"], m["keptLargest"]
        what = "burned" if mode == "burn" else "loss"
        into = "unburned" if mode == "burn" else "stable forest"
        extra = "" if mode == "burn" else " (FAO’s forest definition uses 0.5 ha)"
        notes.append(f"Minimum mapping unit {mmu_ha:g} ha: {removed_patches:,} {what} patches smaller than this (8-connected pixels) were reclassified as {into}{extra}.")
    else:
        labels, n = label_patches(target)
        area = patch_areas(labels, n, rows)
        count, largest = n, float(area[1:].max()) if n else 0.0
    return {"count": count, "largest": {"ha": largest / 10_000, "pixels": 0}, "mmuHa": mmu_ha, "removedPatches": removed_patches, "removedArea": removed}


class _Values:
    """Reads one per-pixel value (a band, or a spectral index) for any rows of a raster."""

    def __init__(self, raster: Raster, bands: dict, index: str, roles: tuple[str, str]):
        self.raster = raster
        if raster.meta.bands == 1:
            self.plan: IndexPlan | None = None
            self.note = f"{raster.meta.filename}: single band read as {index.upper()}."
        else:
            self.plan = plan_index(raster, index, bands)
            a, b = roles
            labels = {"nir": "NIR", "red": "red", "swir2": "SWIR2"}
            self.note = f"{raster.meta.filename}: {index.upper()} from band {int(bands[a]) + 1} ({labels[a]}) and band {int(bands[b]) + 1} ({labels[b]})."

    def rows(self, r0: int, r1: int) -> np.ndarray:
        if self.plan is None:
            return self.raster.read_rows([0], r0, r1)[0]
        return self.plan.rows(self.raster, r0, r1)


def _out_of_range(a: np.ndarray, lo: float = -1.001, hi: float = 1.001, every: int = 7) -> tuple[int, int]:
    """(values outside lo…hi, values checked) in a sample of every `every`-th finite value of a strip."""
    v = a.ravel()[::every]
    v = v[np.isfinite(v)]
    return int(((v < lo) | (v > hi)).sum()), int(v.size)


def _clip_rows(st: Strip, *arrays: np.ndarray | None) -> int:
    if st.inside is None:
        return 0
    for a in arrays:
        if a is not None:
            a[~st.inside] = np.nan
    return int(st.inside.sum())


def _finish(plan: StripPlan, notes: list[str], inside: int) -> None:
    plan.check_overlap(inside)
    if plan.boundary:
        notes.insert(0, clip_note(plan.boundary, inside))
    notes.append(plan.geo.note if plan.geo else NO_UNITS)
    if plan.raster.resample_factor > 1:
        notes.append(f"Areas were computed on a resampled grid (each cell = {fmt(plan.raster.resample_factor, 3)} original pixels); cell areas were scaled to match.")


def _range_error(counts: list[tuple[int, int]], name: str, what: str, hint: str) -> None:
    bad, n = sum(c[0] for c in counts), sum(c[1] for c in counts)
    if n and bad / n > 0.01:
        raise ValueError(f"{name} has values outside −1…1, so it does not look like {what}. {hint}")


def analyze_ndvi_change(before: Raster, before_bands: dict, after: Raster, after_bands: dict, forest_thr: float, loss_thr: float, boundary=None, mmu_ha: float = 0) -> dict:
    if not same_grid(before.meta, after.meta):
        raise ValueError(f"The two images are on different grids ({before.meta.width}×{before.meta.height} vs {after.meta.width}×{after.meta.height}, or different extents or CRS). Export both dates with the same region, scale and CRS so pixels line up.")
    if loss_thr >= 0:
        raise ValueError("The loss threshold must be negative (a drop in NDVI).")
    vb = _Values(before, before_bands, "ndvi", ("nir", "red"))
    va = _Values(after, after_bands, "ndvi", ("nir", "red"))
    plan = StripPlan(before, boundary)
    classes = np.zeros((plan.height, plan.width), dtype=np.uint8)

    def work(st: Strip) -> tuple[int, float, int, tuple[int, int], tuple[int, int]]:
        b, a = vb.rows(st.r0, st.r1), va.rows(st.r0, st.r1)
        rb, ra = _out_of_range(b), _out_of_range(a)
        inside = _clip_rows(st, b, a)
        # Compare in float64, as JavaScript did, so values exactly on a threshold are classed the same way.
        v0, v1 = b.astype(np.float64), a.astype(np.float64)
        valid = np.isfinite(v0) & np.isfinite(v1)
        d = np.where(valid, v1 - v0, 0)
        c = np.zeros(v0.shape, dtype=np.uint8)
        forest = valid & (v0 >= forest_thr)
        gain = valid & ~forest & (d >= -loss_thr)
        c[forest] = 1
        c[forest & (d <= loss_thr)] = 2
        c[gain] = 4
        c[valid & ~forest & ~gain] = 3
        classes[st.rows] = c
        return int(valid.sum()), float(d[valid].sum()), inside, rb, ra

    parts = plan.map(work)
    _range_error([p[3] for p in parts], before.meta.filename, "NDVI", "For multi-band imagery, assign the red and NIR bands.")
    _range_error([p[4] for p in parts], after.meta.filename, "NDVI", "For multi-band imagery, assign the red and NIR bands.")
    n_valid = sum(p[0] for p in parts)
    sum_d = sum(p[1] for p in parts)
    notes = [vb.note, va.note,
             f"Forest is NDVI ≥ {forest_thr:g} on the earlier image; loss is a drop of {abs(loss_thr):g} or more (ΔNDVI ≤ {loss_thr:g}); gain is a rise of at least {abs(loss_thr):g} on non-forest.",
             "NDVI thresholds are a proxy for forest: they do not apply the FAO definition (≥ 10 % canopy cover, trees ≥ 5 m, ≥ 0.5 ha). Seasonal leaf fall, clouds, haze or different sensors can look like loss, so compare images from the same season and check hotspots against high-resolution imagery."]
    _finish(plan, notes, sum(p[2] for p in parts))
    patches = _patch_step("ndvi", classes, plan, 1, mmu_ha, notes)
    t = _Totals(plan, classes)
    return {"mode": "ndvi", "forestThreshold": forest_thr, "lossThreshold": loss_thr, "forestBefore": t.unit(1, 2), "loss": t.unit(2),
            "gain": t.unit(4), "validPixels": n_valid, "meanDelta": sum_d / n_valid if n_valid else None,
            "classes": classes, "width": plan.width, "height": plan.height, "patches": patches, "notes": notes}


def analyze_hansen(loss_year: Raster, tree_cover: Raster | None, canopy_thr: float, boundary=None, mmu_ha: float = 0) -> dict:
    if tree_cover and not same_grid(loss_year.meta, tree_cover.meta):
        raise ValueError("The lossyear and treecover2000 files are on different grids. Download the same Hansen tile for both.")
    plan = StripPlan(loss_year, boundary)
    classes = np.zeros((plan.height, plan.width), dtype=np.uint8)
    years = np.zeros((plan.height, plan.width), dtype=np.uint8)

    def work(st: Strip) -> tuple[int, int]:
        ly = loss_year.read_rows([0], st.r0, st.r1)[0]
        tc = tree_cover.read_rows([0], st.r0, st.r1)[0] if tree_cover else None
        s = ly.ravel()[::11]
        s = s[np.isfinite(s)]
        odd = int(((s != np.round(s)) | (s < 0) | (s > 60)).sum())
        inside = _clip_rows(st, ly, tc)
        v = ly.astype(np.float64)
        present = np.isfinite(v)
        if tc is not None:
            cover = tc.astype(np.float64)
            present &= np.isfinite(cover)
            forest = present & (cover >= canopy_thr)
        else:
            forest = present
        c = np.zeros(v.shape, dtype=np.uint8)
        c[present & ~forest] = 3
        c[forest] = 1
        c[forest & (np.nan_to_num(v) >= 1)] = 2
        classes[st.rows] = c
        years[st.rows] = np.clip(np.nan_to_num(v), 0, 255).astype(np.uint8)
        return inside, odd

    parts = plan.map(work)
    inside = sum(p[0] for p in parts)
    if any(p[1] for p in parts):
        raise ValueError(f"{loss_year.meta.filename} does not look like a Hansen lossyear layer (values should be whole numbers 0–{datetime.now(UTC).year - 2000}).")
    mmu_notes: list[str] = []
    plan.check_overlap(inside)
    patches = _patch_step("hansen", classes, plan, 1, mmu_ha, mmu_notes)
    t = _Totals(plan, classes)
    by_year = _loss_by_year(plan, classes, years)
    notes = ["Hansen et al. (2013), Science 342:850–853, Global Forest Change: lossyear = year of stand-replacing tree-cover loss (1 = 2001).",
             f"Baseline forest = treecover2000 ≥ {canopy_thr:g} % canopy (Global Forest Watch commonly uses 30 %). Only loss inside the baseline is counted." if tree_cover is not None
             else "No treecover2000 layer was given, so every lossyear pixel counts and no baseline forest area or percentage is reported.",
             '"Loss" includes harvest, fire, storm and disease, not only deforestation; year-to-year comparisons across the whole record are affected by algorithm updates (see the GFC version notes).']
    _finish(plan, notes, inside)
    notes += mmu_notes
    return {"mode": "hansen", "canopyThreshold": canopy_thr if tree_cover is not None else None, "baseline": t.unit(1, 2) if tree_cover is not None else None,
            "totalLoss": t.unit(2), "byYear": by_year, "classes": classes, "width": plan.width, "height": plan.height, "patches": patches, "notes": notes}


def _loss_by_year(plan: StripPlan, classes: np.ndarray, years: np.ndarray) -> list[dict]:
    """Loss cells and area per Hansen loss year (after the minimum mapping unit)."""
    counts = np.zeros(256, dtype=np.int64)
    areas = np.zeros(256)
    w = plan.width
    for b in plan.row_blocks():
        lost = classes[b] == 2
        y = years[b][lost]
        counts += np.bincount(y, minlength=256)
        if plan.geo:
            areas += np.bincount(y, weights=np.repeat(plan.geo.cell_area[b], w)[lost.ravel()], minlength=256)
    return [{"year": 2000 + int(y), "area": {"ha": float(areas[y]) / 10_000 if plan.geo else None, "pixels": int(counts[y])}} for y in np.flatnonzero(counts)]


def analyze_burn(pre: Raster, pre_bands: dict, post: Raster, post_bands: dict, boundary=None, mmu_ha: float = 0) -> dict:
    if not same_grid(pre.meta, post.meta):
        raise ValueError("The pre- and post-fire images are on different grids. Export both with the same region, scale and CRS so pixels line up.")
    vb = _Values(pre, pre_bands, "nbr", ("nir", "swir2"))
    va = _Values(post, post_bands, "nbr", ("nir", "swir2"))
    plan = StripPlan(pre, boundary)
    classes = np.zeros((plan.height, plan.width), dtype=np.uint8)

    def work(st: Strip) -> tuple[int, float, int, tuple[int, int], tuple[int, int]]:
        b, a = vb.rows(st.r0, st.r1), va.rows(st.r0, st.r1)
        rb, ra = _out_of_range(b), _out_of_range(a)
        inside = _clip_rows(st, b, a)
        pre_v, post_v = b.astype(np.float64), a.astype(np.float64)
        valid = np.isfinite(pre_v) & np.isfinite(post_v)
        d = np.where(valid, pre_v - post_v, np.nan)
        c = np.zeros(d.shape, dtype=np.uint8)
        lower = -np.inf
        for k in BURN_CLASSES:
            c[valid & (d >= lower) & (d < k["upTo"])] = k["id"]
            lower = k["upTo"]
        classes[st.rows] = c
        return int(valid.sum()), float(d[valid].sum()), inside, rb, ra

    parts = plan.map(work)
    hint = "For multi-band imagery, assign the NIR and SWIR2 bands."
    _range_error([p[3] for p in parts], pre.meta.filename, "NBR", hint)
    _range_error([p[4] for p in parts], post.meta.filename, "NBR", hint)
    n_valid = sum(p[0] for p in parts)
    notes = [vb.note, va.note,
             "dNBR = NBR(pre-fire) − NBR(post-fire), NBR = (NIR − SWIR2) / (NIR + SWIR2); classes follow the USGS FIREMON ranges (Key & Benson 2006): low severity from 0.10, moderate-low from 0.27, moderate-high from 0.44, high from 0.66.",
             "These thresholds are generic: severity depends on pre-fire vegetation, and field plots (Composite Burn Index) are needed to calibrate them locally. Use cloud- and smoke-free images from the same season, ideally within a year of the fire."]
    _finish(plan, notes, sum(p[2] for p in parts))
    patches = _patch_step("burn", classes, plan, 3, mmu_ha, notes)
    t = _Totals(plan, classes)
    return {"mode": "burn", "classAreas": [t.unit(k["id"]) for k in BURN_CLASSES], "burned": t.unit(4, 5, 6, 7),
            "meanDnbr": sum(p[1] for p in parts) / n_valid if n_valid else None,
            "validPixels": n_valid, "classes": classes, "width": plan.width, "height": plan.height, "patches": patches, "notes": notes}


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


def legend(mode: str) -> list[ChangeClass]:
    if mode == "burn":
        return list(BURN_CLASSES)
    return [c for c in CHANGE_CLASSES if mode == "ndvi" or c["id"] != 4]
