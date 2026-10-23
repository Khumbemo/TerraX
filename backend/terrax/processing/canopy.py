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
from scipy.stats import t as stats_t

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


def calibrate_count(field: np.ndarray, detected: np.ndarray, detected_total: int, area_ha: float | None = None) -> dict:
    """Ratio estimate of the true number of trees from field plots (Cochran 1977, sections 6.2-6.4).

    Detected tree tops undercount where crowns overlap. In plots counted on the ground, the ratio
    R = sum(field) / sum(detected) measures that undercount. The total is R x (trees detected over the whole area,
    a known auxiliary total). The variance ignores the finite-population correction, as plots cover a tiny share
    of the area. The interval uses Student's t with n - 1 degrees of freedom.
    """
    from scipy import stats

    y, x = np.asarray(field, dtype=np.float64), np.asarray(detected, dtype=np.float64)
    n = int(y.size)
    if n == 0:
        raise ValueError("No field plot lies on the canopy height model.")
    if np.any(y < 0) or not np.all(np.isfinite(y)):
        raise ValueError("Field counts must be whole numbers of trees, zero or more.")
    sy, sx = float(y.sum()), float(x.sum())
    if sx <= 0:
        raise ValueError("No tree tops were detected inside the field plots, so their counts cannot calibrate the detection. Check that the plots lie on the forest.")
    r = sy / sx
    total = r * detected_total
    out: dict = {"plots": n, "fieldTrees": round(sy), "detectedInPlots": round(sx), "ratio": r, "detectionRate": sx / sy if sy else None,
                 "total": total, "perHa": total / area_ha if area_ha else None, "se": None, "ci95": None}
    if n >= 2:
        xbar = x.mean()
        v = float(np.sum((y - r * x) ** 2) / (n - 1) / (n * xbar**2))
        se = detected_total * math.sqrt(v)
        t = float(stats.t.ppf(0.975, n - 1))
        out |= {"se": se, "ci95": [max(0.0, total - t * se), total + t * se]}
    return out


def _calibrated_row(c: dict) -> str:
    ci = f"; 95 % CI {c['ci95'][0]:,.0f}–{c['ci95'][1]:,.0f}" if c["ci95"] else "; one plot, so no interval"
    per = f", {fmt(c['perHa'], 3)} per ha" if c["perHa"] else ""
    return f"| Trees, calibrated by {c['plots']} field plot{'' if c['plots'] == 1 else 's'} | {c['total']:,.0f}{per}{ci} |"


def _biomass_rows(b: dict) -> list[str]:
    lo, hi = b["ci95Mg"]
    per = f" ({fmt(b['meanMgHa'], 3)} Mg/ha)" if b["meanMgHa"] else ""
    return [f"| Above-ground biomass, from {b['plots']} field plots | {b['totalMg']:,.0f} Mg{per}; 95 % CI {lo:,.0f}–{hi:,.0f} Mg |",
            f"| Carbon / CO₂e | {b['carbonMg']:,.0f} Mg C / {b['co2eMg']:,.0f} Mg CO₂e |"]


def canopy_markdown(name: str, source: str, r: dict, notes: list[str]) -> str:
    hgt, t = r["height"], r["trees"]
    lines = ["## Dataset", "", f"- {name} ({source})", f"- Area with heights: {fmt(r['areaHa'], 4)} ha", "", "## Results", "",
             "| Measure | Value |", "|---|---|",
             f"| Canopy cover (≥ {fmt(r['threshold'], 3)} m) | {r['cover'] * 100:.1f} % |",
             f"| Cover of trees ≥ 5 m (FAO forest height) | {r['coverFao'] * 100:.1f} % |",
             f"| Canopy height, median (quartiles) | {fmt(hgt['median'], 3)} m ({fmt(hgt['q1'], 3)}–{fmt(hgt['q3'], 3)}) |",
             f"| 95th percentile / maximum | {fmt(hgt['p95'], 3)} m / {fmt(hgt['max'], 3)} m |",
             f"| Tree tops ≥ {fmt(t['minHeight'], 3)} m | {t['count']:,} ({fmt(t['perHa'], 3)} per ha; mean height {fmt(t['meanHeight'], 3)} m) |",
             *([_calibrated_row(t["calibrated"])] if t.get("calibrated") else []),
             *(_biomass_rows(r["biomass"]) if r.get("biomass") else []), "",
             "| Height class | Area (ha) |", "|---|---|", *[f"| {c['label']} | {fmt(c['ha'], 4)} |" for c in r["classes"]], "",
             "## Method and limits", "", *[f"- {n}" for n in notes]]
    return "\n".join(lines)


#: IPCC (2006) default carbon fraction of dry biomass, and CO₂ per unit carbon.
CARBON_FRACTION = 0.47
CO2_PER_C = 44 / 12


def biomass_model(tch: np.ndarray, agb: np.ndarray, cells_tch: np.ndarray, cell_ha: np.ndarray, draws: int = 2000, seed: int = 17) -> dict:
    """Above-ground biomass from top-of-canopy height, calibrated on field plots (area-based approach).

    AGB = a·TCHᵇ (Asner & Mascaro 2014), fitted by least squares on ln AGB = ln a + b ln TCH over plots with TCH > 0
    and AGB > 0, back-transformed with Baskerville's (1972) correction exp(σ²/2). It is applied to cells of about plot
    size (`cells_tch`, `cell_ha`), as the model only holds at the scale it was fitted at.

    The total's uncertainty is propagated by Monte Carlo: (ln a, b) drawn from their sampling distribution (bivariate
    t-scaled normal, covariance σ̂²(XᵀX)⁻¹) and an independent residual N(0, σ̂²) on the log scale per cell. Independent
    residuals ignore spatial correlation between neighbouring cells, so the interval is a lower bound of the true one.
    """
    tch, agb = np.asarray(tch, dtype=np.float64), np.asarray(agb, dtype=np.float64)
    use = np.isfinite(tch) & np.isfinite(agb) & (tch > 0) & (agb > 0)
    n = int(use.sum())
    if n < 5:
        raise ValueError(f"Fitting biomass to canopy height needs at least 5 field plots with biomass and canopy over them; {n} usable.")
    x, y = np.log(tch[use]), np.log(agb[use])
    X = np.c_[np.ones(n), x]
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    s2 = float(resid @ resid) / (n - 2)
    cov = s2 * np.linalg.inv(X.T @ X)
    corr = math.exp(s2 / 2)
    fitted = corr * np.exp(X @ beta)
    rmse = float(np.sqrt(np.mean((agb[use] - fitted) ** 2)))
    r2 = 1 - float(resid @ resid) / float(((y - y.mean()) ** 2).sum()) if n > 2 else None
    loo = []
    for i in range(n):  # leave-one-out, on the Mg/ha scale
        m = np.arange(n) != i
        bi, *_ = np.linalg.lstsq(X[m], y[m], rcond=None)
        si = float(((y[m] - X[m] @ bi) ** 2).sum()) / (n - 3) if n > 3 else s2
        loo.append(math.exp(si / 2) * math.exp(float(X[i] @ bi)) - agb[use][i])
    cells = np.asarray(cells_tch, dtype=np.float64)
    ha = np.asarray(cell_ha, dtype=np.float64)
    ok = np.isfinite(cells)
    canopy = ok & (cells >= 0.5)  # below half a metre of mean canopy height a cell is counted as no tree biomass
    lx = np.log(np.where(canopy, cells, 1.0))
    est = np.where(canopy, corr * np.exp(beta[0] + beta[1] * lx), 0.0)
    area = float(ha[ok].sum())
    total = float((est * ha)[ok].sum())
    rng = np.random.default_rng(seed)
    tq = float(stats_t.ppf(0.975, n - 2))
    L = np.linalg.cholesky(cov)
    totals = np.empty(draws)
    cx, ch = lx[canopy], ha[canopy]
    df = n - 2
    for d in range(draws):
        z = rng.standard_normal(2) * math.sqrt(df / rng.chisquare(df))  # multivariate t with n − 2 degrees of freedom
        a_d, b_d = beta + L @ z
        e = rng.standard_normal(cx.size) * math.sqrt(s2)
        totals[d] = float((np.exp(a_d + b_d * cx + e) * ch).sum())
    lo, hi = np.percentile(totals, [2.5, 97.5])
    out_of_range = canopy & ((cells < tch[use].min()) | (cells > tch[use].max()))
    return {
        "plots": n, "a": float(corr * math.exp(beta[0])), "b": float(beta[1]), "sigmaLog": math.sqrt(s2), "r2Log": r2, "rmse": rmse,
        "looRmse": float(np.sqrt(np.mean(np.square(loo)))), "tTwoSided": tq,
        "areaHa": area, "totalMg": total, "meanMgHa": total / area if area else None, "ci95Mg": [float(lo), float(hi)],
        "carbonMg": total * CARBON_FRACTION, "co2eMg": total * CARBON_FRACTION * CO2_PER_C,
        "extrapolatedShare": float(ha[out_of_range].sum() / area) if area else 0.0, "cells": int(ok.sum()), "draws": draws,
        "tchRange": [float(tch[use].min()), float(tch[use].max())], "_cellAgb": est,
    }
