"""Canopy height from a point cloud (LAS/LAZ) or from surface and terrain models.

- Point clouds: the surface model (DSM) is the highest first return in each cell; the terrain model (DTM)
  the lowest ground return (ASPRS class 2), with empty cells filled by linear interpolation on a Delaunay
  triangulation of the ground cells (nearest ground cell outside their hull). CHM = DSM − DTM, negatives
  set to 0.
- Canopy cover: the share of cells at or above a height threshold (2 m by default; FAO's forest definition
  uses trees of at least 5 m, so that share is reported too).
- Tree tops: local maxima of the lightly smoothed CHM, each the highest cell within half its expected crown
  width CW = 3.75105 − 0.17919 H + 0.01241 H² (m), Popescu & Wynne (2004), for pines and hardwoods together.
  Local maxima find dominant trees well and miss suppressed ones under them, so counts in dense stands are a
  lower bound.
"""

from __future__ import annotations

import math

import numpy as np
from numba import njit
from scipy.ndimage import gaussian_filter

from .stats import fmt

HEIGHT_CLASSES = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 30), (30, math.inf)]


@njit(cache=True)
def _bin_max(ix, iy, z, w, h, out):
    for i in range(z.size):
        c, r = ix[i], iy[i]
        if 0 <= c < w and 0 <= r < h and (np.isnan(out[r, c]) or z[i] > out[r, c]):
            out[r, c] = z[i]


@njit(cache=True)
def _bin_min(ix, iy, z, w, h, out):
    for i in range(z.size):
        c, r = ix[i], iy[i]
        if 0 <= c < w and 0 <= r < h and (np.isnan(out[r, c]) or z[i] < out[r, c]):
            out[r, c] = z[i]


def _fill_ground(dtm: np.ndarray) -> tuple[np.ndarray, int]:
    """Empty DTM cells from a TIN of the ground cells (nearest ground cell outside the hull); returns the filled count."""
    from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator

    have = np.isfinite(dtm)
    holes = ~have
    n = int(holes.sum())
    if not n or have.sum() < 3:
        return dtm, n
    rr, cc = np.nonzero(have)
    pts, vals = np.column_stack([cc + 0.5, rr + 0.5]), dtm[have]
    hr, hc = np.nonzero(holes)
    q = np.column_stack([hc + 0.5, hr + 0.5])
    filled = LinearNDInterpolator(pts, vals)(q)
    out_of_hull = ~np.isfinite(filled)
    if out_of_hull.any():
        filled[out_of_hull] = NearestNDInterpolator(pts, vals)(q[out_of_hull])
    out = dtm.copy()
    out[hr, hc] = filled
    return out, n


def chm_from_las(path, cell: float = 1.0, chunk: int = 5_000_000) -> dict:
    """DSM (highest first return), DTM (lowest ground return, TIN-filled) and CHM on a `cell`-metre grid, read in chunks."""
    import laspy

    if not 0.1 <= cell <= 50:
        raise ValueError("Choose a cell size between 0.1 and 50 m.")
    with laspy.open(str(path)) as f:
        hdr = f.header
        try:
            crs = hdr.parse_crs()
        except Exception:  # an unreadable CRS record: treated as no CRS (metres assumed, and the notes say so)
            crs = None
        if crs is not None and crs.is_geographic:
            raise ValueError("The point cloud is in longitude/latitude. Reproject it to a projected CRS in metres or feet (for example UTM) first.")
        units = 1.0
        if crs is not None and crs.axis_info:
            units = crs.axis_info[0].unit_conversion_factor or 1.0
        c = cell / units  # cell in the file's horizontal units
        x0, y0, x1, y1 = hdr.mins[0], hdr.mins[1], hdr.maxs[0], hdr.maxs[1]
        w, h = max(1, math.ceil((x1 - x0) / c)), max(1, math.ceil((y1 - y0) / c))
        if w * h > 100_000_000:
            raise ValueError(f"A {fmt(cell, 3)} m grid over this point cloud would have {w * h:,} cells; choose a larger cell size.")
        dsm = np.full((h, w), np.nan)
        dtm = np.full((h, w), np.nan)
        points = ground = 0
        has_returns = True
        for pts in f.chunk_iterator(chunk):
            x, y, z = np.asarray(pts.x), np.asarray(pts.y), np.asarray(pts.z)
            ix = np.minimum(((x - x0) / c).astype(np.int64), w - 1)
            iy = np.minimum(((y1 - y) / c).astype(np.int64), h - 1)
            try:
                first = np.asarray(pts.return_number) == 1
            except Exception:  # point formats without returns: every point counts as a first return
                first, has_returns = np.ones(x.size, bool), False
            _bin_max(ix[first], iy[first], z[first], w, h, dsm)
            g = np.asarray(pts.classification) == 2
            _bin_min(ix[g], iy[g], z[g], w, h, dtm)
            points += int(x.size)
            ground += int(g.sum())
    if ground == 0:
        raise ValueError("The point cloud has no ground points (ASPRS class 2). Classify ground first (for example with PDAL's SMRF or lasground), then upload it again.")
    z_units = 1.0
    if crs is not None:
        sub = getattr(crs, "sub_crs_list", None) or []
        vert = next((s for s in sub if s.is_vertical), None)
        if vert is not None and vert.axis_info:
            z_units = vert.axis_info[0].unit_conversion_factor or 1.0
        elif units != 1.0:
            z_units = units  # a projected CRS in feet usually means elevations in feet as well
    dtm, filled = _fill_ground(dtm)
    chm = np.where(np.isfinite(dsm) & np.isfinite(dtm), np.maximum(dsm - dtm, 0.0), np.nan) * z_units
    transform = (x0, y1, c)
    return {"chm": chm.astype(np.float32), "dsm": dsm.astype(np.float32), "dtm": dtm.astype(np.float32), "width": w, "height": h, "cell": cell, "transform": transform,
            "crs": crs, "points": points, "groundPoints": ground, "filledGround": filled, "returns": has_returns}


def crown_width(h: np.ndarray | float) -> np.ndarray | float:
    """Expected crown width (m) for tree height h (m): Popescu & Wynne (2004), pines and hardwoods combined."""
    return 3.75105 - 0.17919 * h + 0.01241 * h * h


@njit(cache=True)
def _tree_tops(chm, min_h, cell):
    h, w = chm.shape
    rows, cols = [], []
    for r in range(h):
        for c in range(w):
            v = chm[r, c]
            if not v >= min_h:
                continue
            cw = 3.75105 - 0.17919 * v + 0.01241 * v * v
            rad = max(1, int(cw / 2 / cell + 0.5))  # crown radius in cells, rounded (cw > 0)
            top = True
            for dr in range(-rad, rad + 1):
                rr = r + dr
                if rr < 0 or rr >= h:
                    continue
                for dc in range(-rad, rad + 1):
                    cc = c + dc
                    if cc < 0 or cc >= w or (dr == 0 and dc == 0) or dr * dr + dc * dc > rad * rad:
                        continue
                    u = chm[rr, cc]
                    # Ties go to the first cell in scan order, so a flat top gives one tree.
                    if u > v or (u == v and (dr < 0 or (dr == 0 and dc < 0))):
                        top = False
                        break
                if not top:
                    break
            if top:
                rows.append(r)
                cols.append(c)
    return np.array(rows, dtype=np.int64), np.array(cols, dtype=np.int64)


def analyze_canopy(chm: np.ndarray, cell_area: np.ndarray, cell_m: float, threshold: float = 2.0, min_tree: float = 5.0, smooth: float = 0.67) -> dict:
    """Height statistics, cover and tree tops of a CHM (metres); cell_area is the ground area per row (m²)."""
    if threshold <= 0 or min_tree <= 0:
        raise ValueError("Set positive height thresholds in metres.")
    valid = np.isfinite(chm)
    if not valid.any():
        raise ValueError("The canopy height model has no valid cells.")
    area_rows = valid.sum(axis=1) @ cell_area
    canopy = valid & (chm >= threshold)
    fao = valid & (chm >= 5.0)
    heights = chm[canopy]
    classes = []
    for lo, hi in HEIGHT_CLASSES:
        m = valid & (chm >= lo) & (chm < hi)
        classes.append({"label": f"{lo}–{hi:g} m" if math.isfinite(hi) else f"≥ {lo} m", "ha": float(m.sum(axis=1) @ cell_area) / 1e4})
    # Tree tops on a lightly smoothed CHM (σ ≈ 0.67 cells), which removes single-cell spikes without merging crowns.
    s = gaussian_filter(np.where(valid, chm, 0.0), smooth) if smooth > 0 else np.where(valid, chm, 0.0)
    s[~valid] = np.nan
    tr, tc = _tree_tops(s.astype(np.float64), float(min_tree), float(cell_m))
    tree_h = chm[tr, tc] if tr.size else np.empty(0)
    area_ha = float(area_rows) / 1e4

    def q(a: np.ndarray, p: float) -> float | None:
        return float(np.quantile(a, p)) if a.size else None

    return {
        "areaHa": area_ha, "threshold": threshold, "cover": float(canopy.sum(axis=1) @ cell_area / area_rows), "coverFao": float(fao.sum(axis=1) @ cell_area / area_rows),
        "height": {"mean": float(heights.mean()) if heights.size else None, "q1": q(heights, 0.25), "median": q(heights, 0.5), "q3": q(heights, 0.75),
                   "p95": q(heights, 0.95), "max": float(heights.max()) if heights.size else None},
        "classes": classes, "trees": {"rows": tr, "cols": tc, "heights": tree_h, "count": int(tr.size), "perHa": float(tr.size / area_ha) if area_ha else None,
                                       "minHeight": min_tree, "meanHeight": float(tree_h.mean()) if tree_h.size else None},
    }


def canopy_markdown(name: str, source: str, r: dict, notes: list[str]) -> str:
    hgt, t = r["height"], r["trees"]
    lines = ["## Dataset", "", f"- {name} ({source})", f"- Area with heights: {fmt(r['areaHa'], 4)} ha", "", "## Results", "",
             "| Measure | Value |", "|---|---|",
             f"| Canopy cover (≥ {fmt(r['threshold'], 3)} m) | {r['cover'] * 100:.1f} % |",
             f"| Cover of trees ≥ 5 m (FAO forest height) | {r['coverFao'] * 100:.1f} % |",
             f"| Canopy height, median (quartiles) | {fmt(hgt['median'], 3)} m ({fmt(hgt['q1'], 3)}–{fmt(hgt['q3'], 3)}) |",
             f"| 95th percentile / maximum | {fmt(hgt['p95'], 3)} m / {fmt(hgt['max'], 3)} m |",
             f"| Tree tops ≥ {fmt(t['minHeight'], 3)} m | {t['count']:,} ({fmt(t['perHa'], 3)} per ha; mean height {fmt(t['meanHeight'], 3)} m) |", "",
             "| Height class | Area (ha) |", "|---|---|", *[f"| {c['label']} | {fmt(c['ha'], 4)} |" for c in r["classes"]], "",
             "## Method and limits", "", *[f"- {n}" for n in notes]]
    return "\n".join(lines)
