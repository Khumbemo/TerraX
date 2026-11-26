"""Forest loss: two-date NDVI change, Hansen Global Forest Change and burn severity."""

from __future__ import annotations

from typing import TypedDict

import numpy as np

from ..processing import emissions as em
from ..processing import forest as fp
from ..processing.rio import Raster, ground_geometry
from . import tool
from .common import bands, boundary, class_geotiff, class_overlay, clean, number, raster, save_npz
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
    a = raster(ctx, inputs, "a", full=True)
    b = raster(ctx, inputs, "b", required=mode != "hansen", full=True)
    ctx.progress(0.15, "Reading rasters")
    if mode == "ndvi":
        f_thr = number(params, "forestThreshold", 0.5, -1, 1, "Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        l_thr = number(params, "lossThreshold", -0.2, -2, 0, "Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        if l_thr >= 0:
            raise ToolError("Set the forest threshold between −1 and 1, and the loss threshold below 0 (for example −0.2).")
        base = _baseline(ctx, inputs, params, a) if inputs.get("forestMap") else None
        try:
            r = fp.analyze_ndvi_change(a, bands(params, "bandsA"), b, bands(params, "bandsB"), f_thr, l_thr, bnd, mmu, baseline=base)
        except ValueError as e:
            raise ToolError(str(e)) from None
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
    # Kept for the stratified validation sample and the area estimates (api/landcover.py, Olofsson et al. 2014).
    geo = ground_geometry(a.meta, r["width"], r["height"])
    save_npz(ctx.dir / "classes.npz", {"classes": r["classes"], "rowArea": np.asarray(geo.cell_area if geo else np.ones(r["height"]), dtype=np.float64)})
    downloads = []
    base = a.meta.filename.rsplit(".", 1)[0]
    tif = class_geotiff(ctx, f"{base}_{'burn_severity' if mode == 'burn' else 'forest_change'}.tif", "burn severity classes" if mode == "burn" else "change classes",
                        r["classes"], fp.legend(mode), a)
    polys = fp.loss_polygons(r, a)
    if polys is not None:
        kind = "burned" if mode == "burn" else "loss"
        fname = f"{a.meta.filename.rsplit('.', 1)[0]}_{kind}_patches.geojson"
        url = ctx.json(fname, polys["fc"])
        downloads.append(ctx.download(f"Export {kind} polygons (GeoJSON)", fname, url, "application/geo+json") | {"features": len(polys["fc"]["features"]), "truncated": polys["truncated"]})
    if tif:  # after the polygons, whose button the web app addresses by position
        downloads.append(tif)
    md = fp.forest_markdown(r, [f"{slot[i]}: {n}" for i, n in enumerate(names)])
    emissions = _emissions(ctx, inputs, params, mode, r, a, geo)
    if emissions:
        md += "\n\n" + em.emissions_markdown(emissions)
    return clean({
        "tool": "forest",
        "name": " vs ".join(names),
        "markdown": md,
        "map": {"bounds": a.meta.latlng_bounds, "image": image},
        "result": r,
        "legend": fp.legend(mode),
        "labels": [c["label"] for c in fp.legend(mode)],
        "file": inputs.get("a"),
        "filename": a.meta.filename,
        "downloads": downloads,
        "emissions": emissions,
    })


def _baseline(ctx: ToolContext, inputs: dict, params: dict, a):
    """Forest at the start from a tree-cover, canopy height or class map (processing/baseline.py)."""
    from ..processing.baseline import FAO_COVER, FAO_HEIGHT, FAO_MIN_HA, forest_baseline

    spec = params.get("forestMap") or {}
    if not isinstance(spec, dict):
        raise ToolError("Describe the forest map as {kind, minCover, minHeight, classes, minHa}.")
    kind = spec.get("kind", "cover")
    m = raster(ctx, inputs, "forestMap")
    cover = number(spec, "minCover", FAO_COVER, 0, 100, "Set the minimum tree cover between 0 and 100 %.")
    height = number(spec, "minHeight", FAO_HEIGHT, 0, 200, "Set the minimum tree height between 0 and 200 m.")
    min_ha = number(spec, "minHa", FAO_MIN_HA, 0, 1000, "Set the minimum forest area between 0 and 1,000 ha.")
    classes = spec.get("classes") or []
    if not isinstance(classes, list) or not all(isinstance(c, int | float) and not isinstance(c, bool) for c in classes):
        raise ToolError("List the forest classes as numbers, for example [10] for ESA WorldCover tree cover.")
    ctx.progress(0.2, "Forest at the start from the forest map")
    try:
        return forest_baseline(m, kind, a, ground_geometry(a.meta, a.gw, a.gh), min_cover=cover, min_height=height, classes=[float(c) for c in classes], min_ha=min_ha)
    except ValueError as e:
        raise ToolError(str(e)) from None


class EmissionSettings(TypedDict):
    agb: float | None
    agbCi: float | None
    biomassCiPct: float | None
    zone: str
    ratio: float | None
    carbonFraction: float
    carbonFractionCi: float | None
    afterBiomass: float


def emission_params(params: dict) -> EmissionSettings | None:
    """The emissions settings (forest tool's `emissions` parameter), checked; None when emissions are not asked for."""
    e = params.get("emissions")
    if not e:
        return None
    if not isinstance(e, dict):
        raise ToolError("“emissions” must be an object, e.g. {\"agb\": 250, \"agbCi\": 50, \"zone\": \"trop-moist\"}.")

    def opt(key: str, lo: float, hi: float, message: str) -> float | None:
        return None if e.get(key) in (None, "") else number(e, key, 0, lo, hi, message)

    out: EmissionSettings = {
        "agb": opt("agb", 0, 2000, "Set the above-ground biomass between 0 and 2,000 t/ha."),
        "agbCi": opt("agbCi", 0, 2000, "Set the biomass uncertainty (± t/ha, 95 %) between 0 and 2,000."),
        "biomassCiPct": opt("biomassCiPct", 0, 200, "Set the biomass map's uncertainty (± %, 95 %) between 0 and 200."),
        "zone": str(e.get("zone") or "trop-moist"),
        "ratio": opt("rootShootRatio", 0, 5, "Set the root-to-shoot ratio between 0 and 5."),
        "carbonFraction": number(e, "carbonFraction", em.DEFAULT_CARBON_FRACTION, 0.01, 1, "Set the carbon fraction between 0 and 1 (IPCC default 0.47)."),
        "carbonFractionCi": opt("carbonFractionCi", 0, 1, "Set the carbon fraction's uncertainty (± , 95 %) between 0 and 1."),
        "afterBiomass": number(e, "afterBiomass", 0, 0, 2000, "Set the biomass left after clearing between 0 and 2,000 t/ha."),
    }
    if out["ratio"] is None:
        em.root_shoot(out["zone"], 0)  # rejects an unknown zone before the analysis runs
    return out


def _emissions(ctx: ToolContext, inputs: dict, params: dict, mode: str, r: dict, a: Raster, geo) -> dict | None:
    s = emission_params(params)
    bio = raster(ctx, inputs, "biomass", required=False, full=True)
    if s is None and bio is None:
        return None
    s = s or emission_params({"emissions": {"zone": "trop-moist"}})
    assert s is not None
    if mode == "burn":
        raise ToolError("Emissions are estimated for forest loss (NDVI change or Hansen). Fire emissions need combustion and emission factors, which TerraX does not have.")
    if geo is None:
        raise ToolError("Emissions need areas in hectares, and this image's CRS has no ground units.")
    area = r["loss"]["ha"] if mode == "ndvi" else r["totalLoss"]["ha"]
    total = None
    if bio is not None:
        ctx.progress(0.85, "Reading the biomass map over the loss")
        m = em.biomass_from_map(*_biomass_on_loss(bio, a, fp.is_loss_class(mode, r["classes"]), geo.cell_area), s["zone"], s["ratio"])
        agb, total = m["agb"], m["total"]
        agb_ci = agb * s["biomassCiPct"] / 100 if s["biomassCiPct"] else None
        source = "map"
    elif s["agb"] is None:
        raise ToolError("For emissions, give the above-ground biomass of the lost forest (t/ha) or a biomass map.")
    else:
        agb, agb_ci, source = s["agb"], s["agbCi"], "value"
    try:
        e = em.estimate(area, None, agb, agb_ci, zone=s["zone"], ratio=s["ratio"], total_biomass=total, carbon_fraction=s["carbonFraction"],
                        carbon_fraction_ci=s["carbonFractionCi"], after_biomass=s["afterBiomass"], biomass_source=source)
    except ValueError as err:
        raise ToolError(str(err)) from None
    if bio is not None:
        e["biomassMap"] = {"file": bio.meta.filename, "coveredShare": m["coveredShare"]}
        if m["coveredShare"] < 0.999:
            e["notes"].insert(0, f"{bio.meta.filename} covers {m['coveredShare'] * 100:.1f} % of the loss area; its mean biomass there is applied to all of it.")
        if not s["biomassCiPct"]:
            e["notes"].append("Give the biomass map's uncertainty (± % at 95 %, from its own validation) to include it in the interval.")
    # Kept for the validated estimate (api/landcover.py), which replaces the mapped area with the sample's.
    e["settings"] = {"agb": agb, "agbCi": agb_ci, "totalBiomass": total, "biomassSource": source} | {k: s[k] for k in ("zone", "ratio", "carbonFraction", "carbonFractionCi", "afterBiomass")}
    return e


def _biomass_on_loss(bio: Raster, grid: Raster, loss: np.ndarray, row_area: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Each loss cell's biomass, read from `bio` resampled onto the loss map's grid (area-weighted average), and its area."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.vrt import WarpedVRT
    from rasterio.windows import Window

    if grid.transform is None or grid.crs is None or not bio.meta.bbox or bio.crs is None:
        raise ToolError("The biomass map and the forest images both need georeferencing (a CRS) so they can be lined up.")
    h, w = loss.shape
    values, areas = [], []
    with rasterio.open(bio.path) as ds, WarpedVRT(ds, crs=grid.crs, transform=grid.transform, width=w, height=h, resampling=Resampling.average,
                                                  src_nodata=ds.nodata, nodata=np.nan, dtype="float32") as vrt:
        step = max(1, 4_000_000 // max(1, w))
        for r0 in range(0, h, step):
            r1 = min(h, r0 + step)
            mask = loss[r0:r1]
            if not mask.any():
                continue
            block = vrt.read(1, window=Window(0, r0, w, r1 - r0))
            values.append(block[mask])
            areas.append(np.broadcast_to(row_area[r0:r1, None], mask.shape)[mask])
    if not values:
        raise ToolError("There is no forest loss to estimate emissions for.")
    return np.concatenate(values).astype(np.float64), np.concatenate(areas)
