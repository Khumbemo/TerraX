"""Quick interactive raster requests: composites, the pixel inspector and watersheds."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from .. import storage
from ..config import settings
from ..processing.render import PREVIEW_MAX_SIDE, composite_rgba, png_bytes
from ..processing.rio import Raster, qa_masked

router = APIRouter()


def _raster(file_id: str, max_pixels: int | None = None) -> Raster:
    f = storage.get_file(file_id)
    if f.kind != "raster":
        raise HTTPException(400, f"{f.name} is not a raster.")
    return Raster(f.path, f.name, max_pixels=max_pixels)


@router.get("/api/rasters/{file_id}/composite.png")
def composite(file_id: str, bands: str = Query(..., description="three 0-based band indices, e.g. 2,1,0"), lo: float = 2, hi: float = 98,
              qaBand: int | None = None, qaKind: str | None = None) -> Response:
    r = _raster(file_id)
    try:
        idx = [int(b) for b in bands.split(",")]
    except ValueError:
        raise HTTPException(400, "bands must be three numbers such as 2,1,0") from None
    if len(idx) != 3 or any(i < 0 or i >= r.meta.bands for i in idx):
        raise HTTPException(400, f"Choose three bands between 1 and {r.meta.bands}.")
    if not 0 <= lo < hi <= 100:
        raise HTTPException(400, "Set the stretch as two percentiles between 0 and 100, low below high (for example 2 and 98).")
    # A preview needs only a decimated read, not the whole bands.
    grids = r.overview(idx, max_side=PREVIEW_MAX_SIDE)
    if qaBand is not None and qaKind in ("scl", "landsat") and 0 <= qaBand < r.meta.bands:
        bad = qa_masked(qaKind, r.overview([qaBand], max_side=PREVIEW_MAX_SIDE)[0])
        for g in grids:
            g[bad] = np.nan
    rgba, _ = composite_rgba(grids, (lo / 100, hi / 100))
    return Response(png_bytes(rgba), media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/rasters/{file_id}/pixel")
def pixel(file_id: str, col: float, row: float, width: int, height: int, qaBand: int | None = None, qaKind: str | None = None) -> dict:
    """Values of every band at a point given in preview-grid coordinates (width × height), read from the full-resolution file."""
    r = _raster(file_id)
    W, H = r.meta.width, r.meta.height
    gc = int(min(W - 1, max(0, col / width * W)))
    gr = int(min(H - 1, max(0, row / height * H)))
    values = r.pixel(gc, gr)
    lat = lon = None
    if r.meta.bbox:
        from ..processing.rio import grid_to_lonlat

        ll = grid_to_lonlat(r, W, H)
        if ll:
            lon, lat = ll(gc + 0.5, gr + 0.5)
    masked = None
    if qaBand is not None and qaKind in ("scl", "landsat") and 0 <= qaBand < r.meta.bands:
        q = values[qaBand]
        masked = bool(qa_masked(qaKind, np.array([np.nan if q is None else q]))[0])
    return {"col": gc, "row": gr, "values": values, "bandNames": r.meta.band_names, "lat": lat, "lon": lon, "masked": masked}


class OutletRequest(BaseModel):
    col: float
    row: float


@router.post("/api/terrain/{job_id}/watershed")
def watershed(job_id: str, req: OutletRequest) -> dict:
    """Watershed draining to the clicked cell (snapped to the strongest flow nearby) of a hydrology job."""
    from ..processing.patches import patches_to_geojson
    from ..processing.terrain import snap_outlet
    from ..processing.terrain import watershed as basin_mask
    from ..tools.common import display_grid
    from ..tools.terrain import flow_png

    st = storage.job_status(job_id)
    res = storage.job_result(job_id)
    if st["tool"] != "hydrology" or not res:
        raise HTTPException(400, "Run the hydrology step first.")
    npz = storage.job_dir(job_id) / "artifacts" / "flow.npz"
    d = np.load(npz)
    acc, direction = d["acc"], d["dir"]
    h, w = acc.shape
    radius = max(3, round(0.02 * max(w, h)))
    outlet = snap_outlet(acc, int(req.col), int(req.row), radius)
    mask, cells = basin_mask(direction, outlet)
    cell = d["cell"]
    area = float(mask.sum(axis=1) @ cell)
    z, s = d["dem"][mask], d["slope"][mask]
    n = len([p for p in (storage.job_dir(job_id) / "artifacts").glob("basin_*.png")])
    name = f"basin_{n + 1}.png"
    shade = d["shade"] if "shade" in d else display_grid(d["hillshade"])  # jobs saved before the display-size shade
    flow_png(storage.job_dir(job_id) / "artifacts", name, d["dem"], shade, acc, d["order"], mask, outlet)
    r = _raster(res["demFile"], max_pixels=settings().dem_pixels)
    fc = None
    out = patches_to_geojson(mask.astype(np.int32), 1, np.array([0.0, area]), r, lambda _i, a: {"name": "Watershed", "area_ha": round(a / 100) / 100})
    if out and r.gw == w and r.gh == h:
        fc = out["fc"]
    from ..tools.terrain import watershed_line

    mean_z = float(np.nanmean(z)) if np.isfinite(z).any() else None
    mean_s = float(np.nanmean(s)) if np.isfinite(s).any() else None
    return {
        "outlet": [int(outlet[1]), int(outlet[0])], "cells": cells, "areaM2": area, "meanElevation": mean_z, "meanSlope": mean_s,
        "markdown": watershed_line(area, mean_z, mean_s),
        "layer": f"/api/jobs/{job_id}/artifacts/{name}", "geojson": fc,
    }
