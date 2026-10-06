"""Zonal statistics: restrict raster analyses to an analysis boundary.

The boundary (WGS84 GeoJSON polygons) is projected into the raster's CRS and
rasterised: a cell is inside when its centre is inside a polygon (holes are
excluded), the same rule GDAL uses for ``all_touched=False``.
"""

from __future__ import annotations

import numpy as np
from rasterio.features import geometry_mask
from rasterio.warp import transform_geom

from .rio import Grid, Raster


def boundary_geoms(fc: dict) -> list[dict]:
    geoms = []
    for f in fc.get("features", []):
        g = (f or {}).get("geometry")
        if g and g.get("type") in ("Polygon", "MultiPolygon"):
            geoms.append(g)
    return geoms


def boundary_mask(raster: Raster, grid: Grid, boundary: dict) -> tuple[np.ndarray, int]:
    """Boolean mask (True inside) on the analysis grid; raises when there is no overlap."""
    meta = raster.meta
    if not meta.bbox:
        raise ValueError("This raster has no georeferencing, so it cannot be clipped to a boundary.")
    geoms = boundary_geoms(boundary["geojson"])
    if not geoms:
        raise ValueError("The boundary has no polygons.")
    if not meta.geographic:
        if raster.crs is None:
            raise ValueError("Clipping to a boundary needs a raster with a declared coordinate reference system.")
        geoms = [transform_geom("EPSG:4326", raster.crs, g) for g in geoms]
    inside = ~geometry_mask(geoms, out_shape=(grid.height, grid.width), transform=raster.transform, all_touched=False, invert=False)
    n = int(inside.sum())
    if not n:
        raise ValueError(f"The boundary “{boundary['name']}” does not overlap {meta.filename}. Check that both cover the same area.")
    return inside, n


def apply_mask(grid: Grid, inside: np.ndarray) -> Grid:
    grid.data[~inside] = np.nan
    return grid


def clip_note(boundary: dict, inside: int) -> str:
    return f"Limited to the analysis boundary “{boundary['name']}” ({boundary['areaM2'] / 10_000:.2f} ha; {inside:,} grid cells inside)."


def clip_to_boundary(raster: Raster, grid: Grid, boundary: dict | None) -> str | None:
    if not boundary:
        return None
    inside, n = boundary_mask(raster, grid, boundary)
    apply_mask(grid, inside)
    return f"Limited to the analysis boundary “{boundary['name']}” ({boundary['areaM2'] / 10_000:.2f} ha; {n:,} grid cells whose centres fall inside)."
