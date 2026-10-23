"""Canopy height: a CHM from a LAS/LAZ point cloud, from DSM − DTM rasters or as a raster, with cover and tree tops."""

from __future__ import annotations

import math

import numpy as np

from ..config import settings
from ..processing.canopy import analyze_canopy, calibrate_count, canopy_markdown, chm_from_las
from ..processing.render import ramp_rgba
from ..processing.rio import Raster, grid_to_lonlat_arrays, ground_geometry, same_grid
from . import tool
from .common import begin_tiles, clean, display_grid, finish_tiles, number
from .context import ToolContext, ToolError

CHM_COLORS = ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"]
MAP_TREES = 20_000  # tree tops drawn on the map; the export keeps all of them
COUNT_FIELDS = ("trees", "tree_count", "field_count", "count", "stems", "n")


AGB_FIELDS = ("agb", "agb_mg_ha", "agb_t_ha", "biomass", "biomass_mg_ha", "biomass_t_ha")


class FieldPlots:
    """Field plots: polygons with the trees counted on the ground and/or the biomass measured (Mg/ha) in each."""

    def __init__(self, name: str, feats: list[dict], count_key: str | None, agb_key: str | None):
        self.name, self.feats, self.count_key, self.agb_key = name, feats, count_key, agb_key

    def values(self, key: str, what: str, whole: bool) -> list[float]:
        out = []
        for x in self.feats:
            v = (x.get("properties") or {}).get(key)
            if v is None:
                raise ToolError(f"A plot has no “{key}”; give every plot {what}.")
            try:
                num = float(v)
            except (TypeError, ValueError):
                raise ToolError(f"A plot's “{key}” is “{v}”, not {what}.") from None
            if not math.isfinite(num) or num < 0 or (whole and num != int(num)):
                raise ToolError(f"A plot's “{key}” is {v}; {what} must be {'whole numbers, ' if whole else ''}zero or more.")
            out.append(num)
        return out


def _plots(ctx: ToolContext, inputs: dict, params: dict) -> FieldPlots | None:
    from ..processing.survey import parse_survey_file

    f = ctx.file(inputs.get("plots"))
    if f is None:
        return None
    try:
        fc, _, _ = parse_survey_file(f.path, f.name, close_ring=False)
    except ValueError as e:
        raise ToolError(str(e)) from None
    feats = [x for x in fc.get("features", []) if (x.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon")]
    if not feats:
        raise ToolError(f"{f.name} has no polygons. Field plots are polygons, each with the trees counted or the biomass measured in it.")
    keys = {k.lower(): k for x in feats for k in (x.get("properties") or {})}

    def pick(param: str, names: tuple[str, ...]) -> str | None:
        wanted = (params.get(param) or "").strip()
        if wanted:
            if wanted.lower() not in keys:
                raise ToolError(f"{f.name} has no property “{wanted}”.")
            return keys[wanted.lower()]
        return next((keys[k] for k in names if k in keys), None)

    count_key, agb_key = pick("countField", COUNT_FIELDS), pick("agbField", AGB_FIELDS)
    if count_key is None and agb_key is None:
        raise ToolError(f"Name the property with each plot's tree count or biomass (Mg/ha); TerraX looks for {', '.join(COUNT_FIELDS)} or {', '.join(AGB_FIELDS)}.")
    return FieldPlots(f.name, feats, count_key, agb_key)


def _plot_heights(geoms: list[dict], chm: np.ndarray, transform, crs) -> np.ndarray:
    """Mean canopy height (gaps included: top-of-canopy height, TCH) inside each plot; NaN where no cell falls inside."""
    from rasterio.features import geometry_mask
    from rasterio.warp import transform_geom

    out = np.full(len(geoms), np.nan)
    for i, g in enumerate(geoms):
        inside = ~geometry_mask([transform_geom("EPSG:4326", crs, g)], out_shape=chm.shape, transform=transform, all_touched=False)
        v = chm[inside]
        v = v[np.isfinite(v)]
        if v.size:
            out[i] = float(v.mean())
    return out


def _block_heights(chm: np.ndarray, cell_area: np.ndarray, b: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean CHM and ground area (ha) of b × b blocks; blocks under half covered by valid cells are NaN."""
    h, w = chm.shape
    hb, wb = math.ceil(h / b), math.ceil(w / b)
    tch = np.full((hb, wb), np.nan)
    ha = np.zeros((hb, wb))
    for i in range(hb):
        rows = slice(i * b, min(h, (i + 1) * b))
        block = chm[rows]
        area = cell_area[rows][:, None]
        pad = wb * b - w
        if pad:
            block = np.pad(block, ((0, 0), (0, pad)), constant_values=np.nan)
        v = np.isfinite(block)
        vals = np.where(v, block, 0.0).reshape(block.shape[0], wb, b)
        cnt = v.reshape(block.shape[0], wb, b).sum(axis=(0, 2))
        sums = vals.sum(axis=(0, 2))
        ha[i] = (v.reshape(block.shape[0], wb, b) * area[:, :, None]).sum(axis=(0, 2)) / 1e4
        full = block.shape[0] * b
        tch[i] = np.where(cnt >= 0.5 * full, sums / np.maximum(cnt, 1), np.nan)
    return tch, ha


def _raster(ctx: ToolContext, inputs: dict, slot: str) -> Raster | None:
    f = ctx.file(inputs.get(slot))
    if f is None:
        return None
    if f.kind != "raster":
        raise ToolError(f"{f.name} is not a GeoTIFF raster.")
    return Raster(f.path, f.name, max_pixels=settings().dem_pixels)


def _on_grid(geom, transform, crs, chm: np.ndarray) -> bool:
    """Whether a plot (WGS84) lies wholly on the CHM's extent."""
    from rasterio.transform import array_bounds
    from rasterio.warp import transform_bounds

    west, south, east, north = array_bounds(chm.shape[0], chm.shape[1], transform)
    w, s, e, n = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
    gw, gs, ge, gn = geom.bounds
    return w <= gw and ge <= e and s <= gs and gn <= n


@tool("canopy")
def run(ctx: ToolContext, inputs: dict, params: dict) -> dict:
    threshold = number(params, "threshold", 2.0, 0.1, 50, "Set the canopy height threshold between 0.1 and 50 m.")
    min_tree = number(params, "minTree", 5.0, 0.5, 100, "Set the minimum tree height between 0.5 and 100 m.")
    notes: list[str] = []
    cloud = ctx.file(inputs.get("cloud"))
    if cloud is not None:
        if not cloud.name.lower().endswith((".las", ".laz")):
            raise ToolError(f"{cloud.name} is not a LAS or LAZ point cloud.")
        cell = number(params, "cell", 1.0, 0.1, 50, "Set the cell size between 0.1 and 50 m.")
        ctx.progress(0.1, "Gridding the point cloud")
        try:
            g = chm_from_las(cloud.path, cell)
        except ValueError as e:
            raise ToolError(str(e)) from None
        chm, crs, name = g["chm"], g["crs"], cloud.name
        x0, y1, c = g["transform"]
        from rasterio.transform import from_origin

        transform = from_origin(x0, y1, c, c)
        cell_area = np.full(chm.shape[0], cell * cell)
        cell_m = cell
        source = f"{g['points']:,} points, {g['groundPoints']:,} ground (class 2), gridded at {cell:g} m"
        notes.append(f"DSM: highest first return per {cell:g} m cell; DTM: lowest ground return, {g['filledGround']:,} empty cells filled from a TIN of ground cells (nearest outside it). CHM = DSM − DTM, negatives set to 0.")
        if not g["returns"]:
            notes.append("The file has no return numbers, so every point counted as a first return.")
        if crs is None:
            notes.append("The point cloud declares no CRS: coordinates were taken as metres and it cannot be placed on the map.")

        def lonlat(cols: np.ndarray, rows: np.ndarray):
            if crs is None:
                return None
            from pyproj import Transformer

            return Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform(x0 + (cols + 0.5) * c, y1 - (rows + 0.5) * c)
    else:
        chm_r, dsm_r, dtm_r = _raster(ctx, inputs, "chm"), _raster(ctx, inputs, "dsm"), _raster(ctx, inputs, "dtm")
        if chm_r is None and not (dsm_r and dtm_r):
            raise ToolError("Add a LAS/LAZ point cloud, a canopy height model, or both a surface (DSM) and a terrain (DTM) model.")
        ref = chm_r or dsm_r
        assert ref is not None
        if chm_r is None:
            assert dsm_r is not None and dtm_r is not None
            if not same_grid(dsm_r.meta, dtm_r.meta):
                raise ToolError("The DSM and DTM are not on the same grid. Export both with the same extent, cell size and CRS.")
            (dsm,), (dtm,) = dsm_r.read_bands([0]), dtm_r.read_bands([0])
            chm = np.where(np.isfinite(dsm.data) & np.isfinite(dtm.data), np.maximum(dsm.data - dtm.data, 0), np.nan).astype(np.float32)
            name, source = f"{dsm_r.meta.filename} − {dtm_r.meta.filename}", "DSM − DTM rasters"
            notes.append("CHM = DSM − DTM, negatives set to 0.")
        else:
            (grid,) = chm_r.read_bands([0])
            chm, name, source = grid.data.astype(np.float32), chm_r.meta.filename, "canopy height raster"
        geo = ground_geometry(ref.meta, ref.gw, ref.gh)
        if geo is None:
            raise ToolError("The raster has no coordinate reference system, so its cell sizes are unknown.")
        cell_area, cell_m = geo.cell_area, float(np.sqrt(np.mean(geo.dx * geo.dy)))
        transform, crs = ref.transform, ref.crs
        notes.append(geo.note)
        if ref.resample_factor > 1:
            notes.append(f"Analysed on a resampled grid (each cell = {ref.resample_factor:.3g} original pixels); tree tops need the original resolution, so counts are a lower bound.")
        ll = grid_to_lonlat_arrays(ref, chm.shape[1], chm.shape[0])

        def lonlat(cols: np.ndarray, rows: np.ndarray):
            return ll(cols + 0.5, rows + 0.5) if ll else None

    ctx.progress(0.6, "Finding tree tops")
    try:
        res = analyze_canopy(chm, cell_area, cell_m, threshold, min_tree)
    except ValueError as e:
        raise ToolError(str(e)) from None
    notes += [
        f"Tree tops: local maxima of the CHM (Gaussian σ 0.67 cells) at least {min_tree:g} m tall and highest within half the crown width expected for their height, "
        "CW = 3.75 − 0.179 H + 0.0124 H² m (Popescu & Wynne 2004). Suppressed trees under taller crowns are missed, so counts in dense stands are a lower bound.",
        "Canopy cover is the share of cells at or above the height threshold seen from above; FAO’s forest definition uses trees of at least 5 m and more than 10 % cover.",
    ]
    trees = res.pop("trees")
    rows, cols, heights = trees.pop("rows"), trees.pop("cols"), trees.pop("heights")
    res["trees"] = trees
    plots = _plots(ctx, inputs, params)
    biomass_downloads: list[dict] = []
    if plots is not None:
        from shapely import contains_xy
        from shapely.geometry import shape

        if crs is None:
            raise ToolError("Field plots need a point cloud or raster with a coordinate reference system, to place them on it.")
        keep = [i for i, x in enumerate(plots.feats) if _on_grid(shape(x["geometry"]), transform, crs, chm)]
        if len(keep) < len(plots.feats):
            notes.append(f"{len(plots.feats) - len(keep)} of {len(plots.feats)} field plots lie outside the canopy height model and were left out.")
        geoms = [plots.feats[i]["geometry"] for i in keep]
    if plots is not None and plots.agb_key:
        from ..processing.canopy import biomass_model

        agb = np.array(plots.values(plots.agb_key, "biomass in Mg/ha", whole=False))[keep]
        tch = _plot_heights(geoms, chm, transform, crs)
        from pyproj import Geod

        geod = Geod(ellps="WGS84")
        plot_m2 = float(np.median([abs(geod.geometry_area_perimeter(shape(g))[0]) for g in geoms])) if geoms else 0.0
        b = max(1, round(math.sqrt(plot_m2) / cell_m)) if plot_m2 else 1
        cells_tch, cells_ha = _block_heights(chm, np.asarray(cell_area, dtype=np.float64), b)
        try:
            bm = biomass_model(tch, agb, cells_tch.ravel(), cells_ha.ravel())
        except ValueError as e:
            raise ToolError(str(e)) from None
        cell_agb = bm.pop("_cellAgb").reshape(cells_tch.shape)
        bm["cellSideM"] = b * cell_m
        res["biomass"] = bm
        notes.append(
            f"Biomass: AGB = {bm['a']:.3g} × TCH^{bm['b']:.3f} Mg/ha (Asner & Mascaro 2014), fitted on {bm['plots']} field plots by least squares on logs (σ = {bm['sigmaLog']:.3f}, "
            f"back-transformed with Baskerville's correction), where TCH is a plot's mean canopy height gaps included. Leave-one-out RMSE {bm['looRmse']:.1f} Mg/ha. "
            f"Applied to cells of {bm['cellSideM']:.0f} m, about the plots' size, since the model only holds at the scale it was fitted at.")
        notes.append(
            f"95 % interval of the total by Monte Carlo ({bm['draws']:,} draws of the model parameters and of a log-scale residual per cell). Cells are treated as independent, so "
            "spatial correlation is ignored and the interval is narrower than the true one. Carbon = 0.47 × biomass (IPCC 2006); CO₂e = carbon × 44/12. Below-ground biomass is not included.")
        if bm["extrapolatedShare"] > 0.05:
            notes.append(f"{bm['extrapolatedShare'] * 100:.0f} % of the area has a mean canopy height outside the plots' range ({bm['tchRange'][0]:.1f}–{bm['tchRange'][1]:.1f} m): "
                         "the model is extrapolated there. Add plots in shorter or taller stands.")
        if bm["plots"] < 20:
            notes.append(f"With {bm['plots']} plots the model is uncertain; area-based biomass models are usually fitted on 30 or more.")
        from rasterio.transform import Affine

        biomass_downloads.append(ctx.download("Export biomass (GeoTIFF, Mg/ha per cell)", "agb_mg_ha.tif",
                                              ctx.geotiff("agb_mg_ha.tif", np.where(np.isfinite(cells_tch), cell_agb, np.nan).astype(np.float32),
                                                          transform @ Affine.scale(b, b), crs, nodata=float("nan")), "image/tiff"))
    if plots is not None and plots.count_key:
        counts = np.array(plots.values(plots.count_key, "numbers of trees", whole=True))[keep]
        tops = lonlat(cols.astype(np.float64), rows.astype(np.float64)) if rows.size else (np.empty(0), np.empty(0))
        tx, ty = np.asarray(tops[0], dtype=np.float64), np.asarray(tops[1], dtype=np.float64)
        detected = np.array([int(contains_xy(shape(g), tx, ty).sum()) for g in geoms])
        try:
            cal = calibrate_count(counts, detected, trees["count"], res["areaHa"])
        except ValueError as e:
            raise ToolError(str(e)) from None
        trees["calibrated"] = cal
        notes.append(
            f"Calibrated count: in {cal['plots']} field plots, {cal['fieldTrees']:,} trees were counted on the ground and {cal['detectedInPlots']:,} tree tops detected "
            f"({cal['detectionRate'] * 100:.0f} % detected). The ratio estimator (Cochran 1977, ch. 6) scales the {trees['count']:,} detected trees by "
            f"{cal['ratio']:.3g} to {cal['total']:,.0f}"
            + (f" (standard error {cal['se']:,.0f})" if cal["se"] is not None else "")
            + ". It assumes the plots were placed at random over the area and counted the same trees (at least the minimum height)."
            + (f" With {cal['plots']} plots the ratio estimate can be biased; use at least 10." if cal["plots"] < 10 else ""))
    downloads = [ctx.download("Export canopy height model (GeoTIFF)", "chm.tif", ctx.geotiff("chm.tif", chm, transform, crs, nodata=float("nan")), "image/tiff"), *biomass_downloads]
    pts = lonlat(cols.astype(np.float64), rows.astype(np.float64)) if rows.size else None
    fc = None
    if pts is not None:
        lon, lat = pts
        feats = [{"type": "Feature", "properties": {"height_m": round(float(hh), 2)}, "geometry": {"type": "Point", "coordinates": [round(float(x), 7), round(float(y), 7)]}}
                 for x, y, hh in zip(np.asarray(lon), np.asarray(lat), heights, strict=True)]
        downloads.append(ctx.download("Export tree tops (GeoJSON)", "tree_tops.geojson", ctx.json("tree_tops.geojson", {"type": "FeatureCollection", "features": feats}), "application/geo+json"))
        tallest = np.argsort(-heights, kind="stable")[:MAP_TREES]
        fc = {"type": "FeatureCollection", "features": [feats[i] for i in tallest]}
        if len(feats) > MAP_TREES:
            notes.append(f"The map shows the {MAP_TREES:,} tallest of {len(feats):,} tree tops; the export holds all of them.")
    csv = "row,col,height_m\n" + "\n".join(f"{r},{c},{hh:.2f}" for r, c, hh in zip(rows, cols, heights, strict=True))
    downloads.append(ctx.download("Export tree tops (CSV)", "tree_tops.csv", ctx.text("tree_tops.csv", csv), "text/csv"))
    finite = chm[np.isfinite(chm)]
    hi = float(np.quantile(finite, 0.98)) if finite.size else 1.0
    layer = ctx.png("chm.png", ramp_rgba(display_grid(chm), 0.0, max(hi, threshold), CHM_COLORS))
    bounds = None
    if crs is not None:
        from rasterio.transform import array_bounds
        from rasterio.warp import transform_bounds

        west, south, east, north = array_bounds(chm.shape[0], chm.shape[1], transform)
        lo_w, lo_s, lo_e, lo_n = transform_bounds(crs, "EPSG:4326", west, south, east, north, densify_pts=21)
        bounds = [[lo_s, lo_w], [lo_n, lo_e]]
    view = display_grid(chm)
    tiles = begin_tiles(ctx, "chm", chm.shape[1], chm.shape[0], transform, crs, "float32", {"kind": "ramp", "min": 0.0, "max": max(hi, threshold), "colors": CHM_COLORS}, nodata=float("nan"))
    if tiles is not None:
        tiles.write(0, chm.astype(np.float32, copy=False))
    image = {"url": layer, "bounds": bounds, "label": "Canopy height", "legend": [], "width": int(view.shape[1]), "height": int(view.shape[0]),
             "tiles": finish_tiles(ctx, tiles, "chm", bounds)} if bounds else None
    return clean({"tool": "canopy", "name": name, "canopy": res, "source": source, "layer": layer, "range": [0.0, max(hi, threshold)], "colors": CHM_COLORS,
            "width": int(chm.shape[1]), "height": int(chm.shape[0]), "markdown": canopy_markdown(name, source, res, notes), "notes": notes,
            "downloads": downloads, "map": {"bounds": bounds, "image": image, "geojson": fc} if bounds else None})
