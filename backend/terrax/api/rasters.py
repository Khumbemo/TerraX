"""Quick interactive raster requests: composites, the pixel inspector and watersheds."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from .. import storage
from ..processing.render import composite_rgba, png_bytes, preview
from ..processing.rio import Raster, apply_qa, ground_geometry, qa_masked

router = APIRouter()


def _raster(file_id: str) -> Raster:
    f = storage.get_file(file_id)
    if f.kind != "raster":
        raise HTTPException(400, f"{f.name} is not a raster.")
    return Raster(f.path, f.name)


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
    grids = r.read_bands(idx)
    if qaBand is not None and qaKind in ("scl", "landsat") and 0 <= qaBand < r.meta.bands:
        apply_qa(r, grids, {"band": qaBand, "kind": qaKind})
    rgba, _ = composite_rgba([preview(g.data) for g in grids], (lo / 100, hi / 100))
    return Response(png_bytes(rgba), media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/api/rasters/{file_id}/pixel")
def pixel(file_id: str, col: float, row: float, width: int, height: int, qaBand: int | None = None, qaKind: str | None = None) -> dict:
    """Values of every band at a point given in preview-grid coordinates (width × height)."""
    r = _raster(file_id)
    gc = int(min(r.gw - 1, max(0, col / width * r.gw)))
    gr = int(min(r.gh - 1, max(0, row / height * r.gh)))
    grids = r.read_bands(list(range(r.meta.bands)))
    values = [None if not np.isfinite(g.data[gr, gc]) else float(g.data[gr, gc]) for g in grids]
    lat = lon = None
    if r.meta.bbox:
        from ..processing.rio import grid_to_lonlat

        ll = grid_to_lonlat(r, r.gw, r.gh)
        if ll:
            lon, lat = ll(gc + 0.5, gr + 0.5)
    masked = None
    if qaBand is not None and qaKind in ("scl", "landsat") and 0 <= qaBand < r.meta.bands:
        masked = bool(qa_masked(qaKind, np.array([grids[qaBand].data[gr, gc]]))[0])
    return {"col": gc, "row": gr, "values": values, "bandNames": r.meta.band_names, "lat": lat, "lon": lon, "masked": masked}


class OutletRequest(BaseModel):
    col: float
    row: float


@router.post("/api/terrain/{job_id}/watershed")
def watershed(job_id: str, req: OutletRequest) -> dict:
    """Watershed draining to the clicked cell (snapped to the strongest flow nearby) of a hydrology job."""
    from ..processing.patches import patches_to_geojson
    from ..processing.terrain import snap_outlet, watershed as basin_mask
    from ..tools.terrain import flow_rgba

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
    area = float((mask * cell[:, None]).sum())
    z, s = d["dem"][mask], d["slope"][mask]
    n = len([p for p in (storage.job_dir(job_id) / "artifacts").glob("basin_*.png")])
    name = f"basin_{n + 1}.png"
    png = flow_rgba(d["dem"], d["hillshade"], acc, d["order"], mask, outlet)
    from ..processing.render import save_png

    save_png(png, storage.job_dir(job_id) / "artifacts" / name)
    r = _raster(res["demFile"])
    fc = None
    out = patches_to_geojson(mask.astype(np.int32), 1, np.array([0.0, area]), r, lambda _i, a: {"name": "Watershed", "area_ha": round(a / 100) / 100})
    if out and r.gw == w and r.gh == h:
        fc = out["fc"]
    return {
        "outlet": [int(outlet[1]), int(outlet[0])], "cells": cells, "areaM2": area,
        "meanElevation": float(np.nanmean(z)) if np.isfinite(z).any() else None, "meanSlope": float(np.nanmean(s)) if np.isfinite(s).any() else None,
        "layer": f"/api/jobs/{job_id}/artifacts/{name}", "geojson": fc,
    }
