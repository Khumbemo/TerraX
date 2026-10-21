"""Canopy height: a CHM from a LAS/LAZ point cloud, from DSM − DTM rasters or as a raster, with cover and tree tops."""

from __future__ import annotations

import numpy as np

from ..config import settings
from ..processing.canopy import analyze_canopy, canopy_markdown, chm_from_las
from ..processing.render import ramp_rgba
from ..processing.rio import Raster, grid_to_lonlat_arrays, ground_geometry, same_grid
from . import tool
from .common import begin_tiles, clean, display_grid, finish_tiles, number
from .context import ToolContext, ToolError

CHM_COLORS = ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"]
MAP_TREES = 20_000  # tree tops drawn on the map; the export keeps all of them


def _raster(ctx: ToolContext, inputs: dict, slot: str) -> Raster | None:
    f = ctx.file(inputs.get(slot))
    if f is None:
        return None
    if f.kind != "raster":
        raise ToolError(f"{f.name} is not a GeoTIFF raster.")
    return Raster(f.path, f.name, max_pixels=settings().dem_pixels)


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
    downloads = [ctx.download("Export canopy height model (GeoTIFF)", "chm.tif", ctx.geotiff("chm.tif", chm, transform, crs, nodata=float("nan")), "image/tiff")]
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
