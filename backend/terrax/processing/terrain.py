"""Terrain analysis from a DEM.

* Slope and aspect by Horn's (1981) 3×3 method; hillshade (sun azimuth 315°,
  altitude 45°); relief and the hypsometric integral (Strahler 1952).
* Depression filling: Priority-Flood with an epsilon gradient so flats drain
  (Barnes, Lehman & Mulla 2014, Computers & Geosciences 62:117).
* Flow direction: D8 steepest descent (O'Callaghan & Mark 1984) with ground
  distances; flow accumulation as upslope contributing area (m²); Strahler
  (1957) stream order on cells above an area threshold.
* Watersheds above an outlet, stream lines, and contours by marching squares
  (simplified by Douglas & Peucker 1973 to a quarter cell).
"""

from __future__ import annotations

import heapq
import math
from concurrent.futures import ThreadPoolExecutor
from typing import TypedDict

import numpy as np
from numba import njit

from .rio import Ground, Raster
from .stats import ValueBuffer, fmt, summarize_large
from .tiles import Strip, StripPlan
from .zonal import clip_note


class SlopeClass(TypedDict):
    upTo: float
    label: str
    color: str


SLOPE_CLASSES: list[SlopeClass] = [
    {"upTo": 2, "label": "Flat (< 2°)", "color": "#2f6c5a"},
    {"upTo": 5, "label": "Gentle (2–5°)", "color": "#6aa84f"},
    {"upTo": 15, "label": "Moderate (5–15°)", "color": "#d8c558"},
    {"upTo": 30, "label": "Steep (15–30°)", "color": "#e69138"},
    {"upTo": 45, "label": "Very steep (30–45°)", "color": "#cc4125"},
    {"upTo": math.inf, "label": "Extreme (≥ 45°)", "color": "#7f1d1d"},
]
ASPECTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
DR = np.array([-1, -1, -1, 0, 0, 1, 1, 1], dtype=np.int64)
DC = np.array([-1, 0, 1, -1, 1, -1, 0, 1], dtype=np.int64)


def _slope_rows(top: np.ndarray, mid: np.ndarray, bot: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> dict:
    """Horn (1981) slope, aspect and hillshade for the inner columns of rows `mid` (with their neighbours above and below)."""
    a, b, c = top[:, :-2], top[:, 1:-1], top[:, 2:]
    d, e, f = mid[:, :-2], mid[:, 1:-1], mid[:, 2:]
    g, hh, i = bot[:, :-2], bot[:, 1:-1], bot[:, 2:]
    ok = np.isfinite(a) & np.isfinite(b) & np.isfinite(c) & np.isfinite(d) & np.isfinite(e) & np.isfinite(f) & np.isfinite(g) & np.isfinite(hh) & np.isfinite(i)
    with np.errstate(invalid="ignore"):
        dzdx = (c + 2 * f + i - (a + 2 * d + g)) / (8 * dx)  # rows run north (a b c) to south (g h i)
        dzdy = (g + 2 * hh + i - (a + 2 * b + c)) / (8 * dy)
    s = np.arctan(np.hypot(dzdx, dzdy))
    sdeg = np.degrees(s)
    class_counts = []
    lower = -math.inf
    for cl in SLOPE_CLASSES:
        class_counts.append(int((ok & (sdeg >= lower) & (sdeg < cl["upTo"])).sum()))
        lower = cl["upTo"]
    asp = np.arctan2(dzdy, -dzdx)
    flat_m = ok & (sdeg < 2)
    deg = np.degrees(asp)
    comp = np.where(deg < 0, 90 - deg, np.where(deg > 90, 360 - deg + 90, 90 - deg))
    steep = ok & ~flat_m
    # Compass sector (N, NE, … NW) of each counted cell; cells outside the DEM or the boundary have no aspect.
    sector = np.round(comp[steep] / 45).astype(np.int64) % 8
    asp = np.where((dzdx == 0) & (dzdy == 0), 0, asp)
    zen = math.radians(45)
    az = math.radians((360 - 315 + 90) % 360)
    sh = np.maximum(0, math.cos(zen) * np.cos(s) + math.sin(zen) * np.sin(s) * np.cos(az - asp))
    return {"slope": np.where(ok, sdeg, np.nan), "shade": np.where(ok, sh, np.nan), "classes": class_counts,
            "flat": int(flat_m.sum()), "aspects": np.bincount(sector, minlength=8)}


def analyze_terrain(raster: Raster, boundary=None) -> dict:
    """Elevation, slope, aspect and hillshade of a DEM, computed in strips with one halo row above and below.

    Results equal one whole-grid pass; the grids kept for rendering and
    hydrology are float32 (the DEM itself is read as float32).
    """
    plan = StripPlan(raster, boundary)
    geo = plan.geo
    if not geo:
        raise ValueError("The DEM has no coordinate reference system (or one PROJ cannot convert to WGS84), so its ground units are unknown and slope cannot be computed.")
    h, w = plan.height, plan.width
    dem = np.full((h, w), np.nan, dtype=np.float32)
    slope = np.full((h, w), np.nan, dtype=np.float32)
    shade = np.full((h, w), np.nan, dtype=np.float32)
    elev_vals = ValueBuffer(h * w)
    slope_vals = ValueBuffer(max(0, h - 2) * max(0, w - 2), dtype=np.float64)

    def work(st: Strip) -> tuple[list[int], int, np.ndarray, int]:
        e0, e1 = max(0, st.r0 - 1), min(h, st.r1 + 1)
        z = raster.read_rows([0], e0, e1)[0]
        m = plan.mask(e0, e1)
        inside = 0
        if m is not None:
            z[~m] = np.nan
            inside = int(m[st.r0 - e0 : st.r1 - e0].sum())
        rows = z[st.r0 - e0 : st.r1 - e0]
        dem[st.rows] = rows
        elev_vals.add(rows[np.isfinite(rows)])
        o0, o1 = max(st.r0, 1), min(st.r1, h - 1)  # rows with a neighbour above and below
        if w < 3 or o0 >= o1:
            return [0] * len(SLOPE_CLASSES), 0, np.zeros(8, dtype=np.int64), inside
        zz = z.astype(np.float64)
        r = _slope_rows(zz[o0 - 1 - e0 : o1 - 1 - e0], zz[o0 - e0 : o1 - e0], zz[o0 + 1 - e0 : o1 + 1 - e0], geo.dx[o0:o1, None], geo.dy[o0:o1, None])
        slope[o0:o1, 1:-1] = r["slope"]
        shade[o0:o1, 1:-1] = r["shade"]
        sv = r["slope"]
        slope_vals.add(sv[np.isfinite(sv)])
        return r["classes"], r["flat"], r["aspects"], inside

    parts = plan.map(work)
    inside = sum(p[3] for p in parts)
    plan.check_overlap(inside)
    class_counts = [sum(p[0][k] for p in parts) for k in range(len(SLOPE_CLASSES))]
    flat = sum(p[1] for p in parts)
    aspects = np.zeros(8, dtype=np.int64)
    for p in parts:
        aspects += p[2]
    aspect_counts = [int(x) for x in aspects]
    clip = clip_note(boundary, inside, centres=True) if boundary else None
    elev = summarize_large(elev_vals.values)
    sstats = summarize_large(slope_vals.values)
    if not elev or not sstats:
        raise ValueError("The DEM has too few valid pixels to compute slope (a 3×3 neighbourhood is needed).")
    relief = elev.max - elev.min
    notes = [
        "Slope and aspect: Horn (1981) 3×3 finite differences; aspect is the compass direction the slope faces (slopes under 2° counted as flat).",
        "Hillshade: sun from the north-west (azimuth 315°) at 45° altitude.",
        "Hypsometric integral HI = (mean − min) / (max − min) (Strahler 1952): above ~0.6 suggests a youthful, less eroded landscape; below ~0.35 a mature one.",
        f"Elevation values are assumed to be metres. {geo.note}",
    ]
    if clip:
        notes.insert(0, clip)
    if raster.resample_factor > 1:
        notes.append(f"The DEM was resampled for analysis (each cell = {fmt(raster.resample_factor, 3)} original pixels; TERRAX_DEM_PIXELS sets the limit); slopes on a coarser grid are gentler than at full resolution.")
    if elev.max > 9000 or elev.min < -500:
        notes.append("Some elevations are outside −500 to 9,000 m; check the file for unmasked no-data values.")
    return {"filename": raster.meta.filename, "elevation": elev.dict(), "relief": relief, "hypsometricIntegral": (elev.mean - elev.min) / relief if relief > 0 else None,
            "slope": sstats.dict(), "slopeClassCounts": class_counts, "aspectCounts": aspect_counts, "flatCount": flat, "width": w, "height": h,
            "notes": notes, "_hillshade": shade, "_slope": slope, "_dem": dem, "_geo": geo}


def terrain_markdown(t: dict, meta) -> str:
    total = sum(t["slopeClassCounts"]) or 1
    asp_total = sum(t["aspectCounts"]) or 1
    e, s = t["elevation"], t["slope"]
    return "\n".join([
        "## Dataset", "", f"- File: {t['filename']} (DEM, {meta.width} × {meta.height} px, {f'EPSG:{meta.epsg}' if meta.epsg else 'CRS unknown'})", "",
        "## Results", "", "| Measure | Value |", "|---|---|",
        f"| Elevation mean ± SD | {fmt(e['mean'])} ± {fmt(e['sd'])} m |",
        f"| Elevation range | {fmt(e['min'])} to {fmt(e['max'])} m (relief {fmt(t['relief'])} m) |",
        f"| Slope mean (median) | {fmt(s['mean'])}° ({fmt(s['median'])}°) |",
        f"| Steepest slope | {fmt(s['max'])}° |",
        f"| Hypsometric integral | {fmt(t['hypsometricIntegral'], 3)} |", "",
        "Slope classes (descriptive):", "",
        *[f"- {c['label']}: {n / total * 100:.1f} %" for c, n in zip(SLOPE_CLASSES, t["slopeClassCounts"], strict=True)], "",
        "Aspect of non-flat slopes: " + ", ".join(f"{a} {n / asp_total * 100:.0f} %" for a, n in zip(ASPECTS, t["aspectCounts"], strict=True)) + ".", "",
        "## Method and limits", "", *[f"- {n}" for n in t["notes"]],
    ])


# ── Hydrology ────────────────────────────────────────────────────────────────


def fill_depressions(z: np.ndarray) -> tuple[np.ndarray, int, float]:
    """Priority-Flood+ε: raises every pit to its spill level plus a tiny gradient."""
    return _fill(np.ascontiguousarray(z, dtype=np.float64))


@njit(cache=True)
def _fill(z):
    h, w = z.shape
    filled = z.copy()
    done = np.zeros((h, w), dtype=np.uint8)
    heap = [(0.0, np.int64(0))]  # typed seed for Numba, removed below
    heap.pop()
    for r in range(h):
        for c in range(w):
            if np.isnan(filled[r, c]):
                done[r, c] = 1
                continue
            edge = r == 0 or c == 0 or r == h - 1 or c == w - 1
            d = 0
            while d < 8 and not edge:
                if np.isnan(filled[r + DR[d], c + DC[d]]):
                    edge = True
                d += 1
            if edge:
                done[r, c] = 1
                heapq.heappush(heap, (filled[r, c], np.int64(r * w + c)))
    raised = 0
    max_raise = 0.0
    while len(heap) > 0:
        _, k = heapq.heappop(heap)
        r, c = k // w, k % w
        for d in range(8):
            rr, cc = r + DR[d], c + DC[d]
            if rr < 0 or cc < 0 or rr >= h or cc >= w or done[rr, cc]:
                continue
            done[rr, cc] = 1
            floor = filled[r, c] + max(1e-6, abs(filled[r, c]) * 1e-12)
            if filled[rr, cc] < floor:
                lift = floor - filled[rr, cc]
                if lift > 1e-3:
                    raised += 1
                    max_raise = max(max_raise, lift)
                filled[rr, cc] = floor
            heapq.heappush(heap, (filled[rr, cc], np.int64(rr * w + cc)))
    return filled, raised, max_raise


@njit(cache=True)
def _step(d, dx, dy):
    if DR[d] != 0 and DC[d] != 0:
        return math.hypot(dx, dy)
    return dy if DR[d] != 0 else dx


@njit(cache=True)
def _route(filled, dxr, dyr, area_r, threshold, queue):
    h, w = filled.shape
    direction = np.full((h, w), -1, dtype=np.int8)
    indeg = np.zeros((h, w), dtype=np.uint8)  # at most 8 neighbours drain into a cell
    for r in range(h):
        for c in range(w):
            if np.isnan(filled[r, c]):
                continue
            best = -1
            best_slope = 0.0
            for d in range(8):
                rr, cc = r + DR[d], c + DC[d]
                if rr < 0 or cc < 0 or rr >= h or cc >= w or np.isnan(filled[rr, cc]):
                    continue
                s = (filled[r, c] - filled[rr, cc]) / _step(d, dxr[r], dyr[r])
                if s > best_slope:
                    best_slope = s
                    best = d
            direction[r, c] = best
            if best >= 0:
                indeg[r + DR[best], c + DC[best]] += 1
    acc = np.zeros((h, w))
    order = np.zeros((h, w), dtype=np.uint8)
    max_in = np.zeros((h, w), dtype=np.uint8)
    max_in_n = np.zeros((h, w), dtype=np.uint8)
    qn = 0
    for r in range(h):
        for c in range(w):
            if np.isnan(filled[r, c]):
                continue
            acc[r, c] = area_r[r]
            if indeg[r, c] == 0:
                queue[qn] = r * w + c
                qn += 1
    length = np.zeros(256)
    max_order = 0
    qi = 0
    while qi < qn:
        k = queue[qi]
        qi += 1
        r, c = k // w, k % w
        if acc[r, c] >= threshold:
            if max_in[r, c] == 0:
                o = 1
            elif max_in_n[r, c] >= 2:
                o = max_in[r, c] + 1
            else:
                o = max_in[r, c]
            order[r, c] = min(255, o)
            max_order = max(max_order, int(order[r, c]))
        d = direction[r, c]
        if d < 0:
            continue
        rr, cc = r + DR[d], c + DC[d]
        acc[rr, cc] += acc[r, c]
        if order[r, c]:
            length[order[r, c]] += _step(d, dxr[r], dyr[r])
            if order[r, c] > max_in[rr, cc]:
                max_in[rr, cc] = order[r, c]
                max_in_n[rr, cc] = 1
            elif order[r, c] == max_in[rr, cc]:
                max_in_n[rr, cc] += 1
        indeg[rr, cc] -= 1
        if indeg[rr, cc] == 0:
            queue[qn] = rr * w + cc
            qn += 1
    return direction, acc, order, max_order, length


# D∞ facets (Tarboton 1997, Table 1): cardinal neighbour e1, diagonal neighbour e2, and the
# constants giving the flow angle (counter-clockwise from east) as ac·π/2 + af·r.
_F_R1 = np.array([0, -1, -1, 0, 0, 1, 1, 0], dtype=np.int64)
_F_C1 = np.array([1, 0, 0, -1, -1, 0, 0, 1], dtype=np.int64)
_F_R2 = np.array([-1, -1, -1, -1, 1, 1, 1, 1], dtype=np.int64)
_F_C2 = np.array([1, 1, -1, -1, -1, -1, 1, 1], dtype=np.int64)
_F_AC = np.array([0, 1, 1, 2, 2, 3, 3, 4], dtype=np.float64)
_F_AF = np.array([1, -1, 1, -1, 1, -1, 1, -1], dtype=np.float64)
TAN_FLOOR = 0.001  # slope floor for the wetness index: filled flats keep only an ε gradient


@njit(cache=True)
def _dinf(filled, dx, dy, area_r, order):
    """D∞ flow (Tarboton 1997): steepest of eight triangular facets, split between its two cells by angle.

    Returns upslope area (m²), specific catchment area (m² per m of contour across the flow), tan β of the
    steepest facet, and each cell's facet (−1 for none) with the share p2 of its flow sent to the facet's diagonal
    cell (the rest goes to its cardinal cell). `order` lists cells by descending filled elevation, so donors come
    before receivers.
    """
    h, w = filled.shape
    acc = np.zeros((h, w), dtype=np.float64)
    tanb = np.zeros((h, w), dtype=np.float32)
    width = np.ones((h, w), dtype=np.float32)
    facet = np.full((h, w), -1, dtype=np.int8)
    share = np.zeros((h, w), dtype=np.float32)
    for r in range(h):
        for c in range(w):
            if not np.isnan(filled[r, c]):
                acc[r, c] = area_r[r]
    for idx in order:
        r, c = idx // w, idx % w
        e0 = filled[r, c]
        if np.isnan(e0):
            continue
        best_s, best_k, best_r, best_rmax = 0.0, -1, 0.0, 0.0
        for k in range(8):
            r1, c1, r2, c2 = r + _F_R1[k], c + _F_C1[k], r + _F_R2[k], c + _F_C2[k]
            if r2 < 0 or r2 >= h or c2 < 0 or c2 >= w or r1 < 0 or r1 >= h or c1 < 0 or c1 >= w:
                continue
            e1, e2 = filled[r1, c1], filled[r2, c2]
            if np.isnan(e1) or np.isnan(e2):
                continue
            d1 = dx[r] if _F_R1[k] == 0 else dy[r]  # to the cardinal neighbour
            d2 = dy[r] if _F_R1[k] == 0 else dx[r]  # from it to the diagonal one
            s1, s2 = (e0 - e1) / d1, (e1 - e2) / d2
            rmax = math.atan2(d2, d1)
            ang = math.atan2(s2, s1)
            if ang < 0:
                ang, sl = 0.0, s1
            elif ang > rmax:
                ang, sl = rmax, (e0 - e2) / math.hypot(d1, d2)
            else:
                sl = math.hypot(s1, s2)
            if sl > best_s:
                best_s, best_k, best_r, best_rmax = sl, k, ang, rmax
        if best_k < 0:
            continue  # outlet: nothing lower inside the grid
        k = best_k
        tanb[r, c] = best_s
        d2 = dy[r] if _F_R1[k] == 0 else dx[r]
        width[r, c] = d2 * math.cos(best_r)  # cell width across the flow
        p2 = best_r / best_rmax
        facet[r, c] = k
        share[r, c] = p2
        a = acc[r, c]
        if p2 < 1.0:
            acc[r + _F_R1[k], c + _F_C1[k]] += a * (1.0 - p2)
        if p2 > 0.0:
            acc[r + _F_R2[k], c + _F_C2[k]] += a * p2
    sca = np.empty((h, w), dtype=np.float32)
    for r in range(h):
        for c in range(w):
            sca[r, c] = np.nan if np.isnan(filled[r, c]) else acc[r, c] / width[r, c]
    return acc, sca, tanb, facet, share


@njit(cache=True)
def dinf_dependence(facet: np.ndarray, share: np.ndarray, orow: int, ocol: int) -> np.ndarray:
    """D∞ upslope dependence on one outlet cell (TauDEM DinfUpDependence; Tarboton 1997): the fraction of each
    cell's flow that reaches the outlet, 1 at the outlet and 0 outside its upslope area.

    The cells upslope of the outlet are found first; then, receivers before donors (Kahn's order on the flow
    graph, which descends strictly), each cell takes the shares of its two receivers' dependence. Σ area ×
    dependence equals the D∞ upslope area at the outlet.
    """
    h, w = facet.shape
    up = np.zeros((h, w), dtype=np.uint8)
    up[orow, ocol] = 1
    stack = [(orow, ocol)]
    while len(stack) > 0:  # every cell that sends any flow into the set
        r, c = stack.pop()
        for d in range(8):
            rr, cc = r + DR[d], c + DC[d]
            if rr < 0 or cc < 0 or rr >= h or cc >= w or up[rr, cc]:
                continue
            k = facet[rr, cc]
            if k < 0:
                continue
            p2 = share[rr, cc]
            if (p2 < 1.0 and rr + _F_R1[k] == r and cc + _F_C1[k] == c) or (p2 > 0.0 and rr + _F_R2[k] == r and cc + _F_C2[k] == c):
                up[rr, cc] = 1
                stack.append((rr, cc))
    # receivers inside the set still to be finished, per cell
    pending = np.zeros((h, w), dtype=np.uint8)
    for r in range(h):
        for c in range(w):
            if up[r, c] and not (r == orow and c == ocol):
                k = facet[r, c]
                p2 = share[r, c]
                if p2 < 1.0 and up[r + _F_R1[k], c + _F_C1[k]]:
                    pending[r, c] += 1
                if p2 > 0.0 and up[r + _F_R2[k], c + _F_C2[k]]:
                    pending[r, c] += 1
    dep = np.zeros((h, w), dtype=np.float32)
    acc = np.zeros((h, w), dtype=np.float64)  # dependence gathered from the receivers so far
    acc[orow, ocol] = 1.0
    ready = [(orow, ocol)]
    while len(ready) > 0:
        r, c = ready.pop()
        dep[r, c] = acc[r, c]
        for d in range(8):
            rr, cc = r + DR[d], c + DC[d]
            if rr < 0 or cc < 0 or rr >= h or cc >= w or not up[rr, cc] or (rr == orow and cc == ocol):
                continue
            k = facet[rr, cc]
            p2 = share[rr, cc]
            got = False
            if p2 < 1.0 and rr + _F_R1[k] == r and cc + _F_C1[k] == c:
                acc[rr, cc] += (1.0 - p2) * acc[r, c]
                got = True
            if p2 > 0.0 and rr + _F_R2[k] == r and cc + _F_C2[k] == c:
                acc[rr, cc] += p2 * acc[r, c]
                got = True
            if got:
                pending[rr, cc] -= 1
                if pending[rr, cc] == 0:
                    ready.append((rr, cc))
    return dep


def dinf_flow(filled: np.ndarray, geo: Ground) -> dict:
    """D∞ upslope area, specific catchment area and topographic wetness index ln(a / tan β) on a filled DEM."""
    flat = np.where(np.isnan(filled), -np.inf, filled).ravel()
    order = np.argsort(-flat, kind="stable")
    order = order.astype(np.int32 if order.size < 2**31 else np.int64)
    acc, sca, tanb, facet, share = _dinf(np.ascontiguousarray(filled, dtype=np.float64), geo.dx.astype(np.float64), geo.dy.astype(np.float64), geo.cell_area.astype(np.float64), order)
    del order
    with np.errstate(invalid="ignore", divide="ignore"):
        twi = np.log(sca / np.maximum(tanb, TAN_FLOOR)).astype(np.float32)
    twi[np.isnan(filled)] = np.nan
    return {"acc": acc, "sca": sca, "twi": twi, "tanb": tanb, "facet": facet, "share": share}


def flow_routing(dem: np.ndarray, geo: Ground, threshold_m2: float, dinf: bool = False) -> dict:
    """D8 directions, accumulation, Strahler streams; with `dinf`, also D∞ upslope area and wetness (key "dinf")."""
    filled, raised, max_raise = fill_depressions(dem)
    extra = dinf_flow(filled, geo) if dinf else None
    n = filled.size
    # Cells in topological order; int32 indices halve this array whenever the grid allows it.
    queue = np.empty(n, dtype=np.int32 if n < 2**31 else np.int64)
    direction, acc, order, max_order, length = _route(filled, geo.dx.astype(np.float64), geo.dy.astype(np.float64), geo.cell_area.astype(np.float64), float(threshold_m2), queue)
    del queue
    lengths = [float(x) for x in length[: max_order + 1]]
    # A junction on the last cell before the grid edge has no channel length of its own;
    # report the highest order that forms an actual channel.
    while max_order > 0 and lengths[max_order] == 0:
        lengths.pop()
        max_order -= 1
    return {"width": dem.shape[1], "height": dem.shape[0], "dir": direction, "acc": acc, "order": order, "thresholdM2": threshold_m2,
            "maxOrder": int(max_order), "lengthByOrder": lengths, "raisedCells": int(raised), "maxRaise": float(max_raise), "dinf": extra}


def snap_outlet(acc: np.ndarray, col: int, row: int, radius: int = 3) -> tuple[int, int]:
    """The highest-accumulation cell within `radius` cells of a click (first in scan order on ties)."""
    h, w = acc.shape
    r0, r1 = max(0, row - radius), min(h - 1, row + radius)
    c0, c1 = max(0, col - radius), min(w - 1, col + radius)
    win = acc[r0 : r1 + 1, c0 : c1 + 1]
    k = int(np.argmax(win))
    return r0 + k // win.shape[1], c0 + k % win.shape[1]


@njit(cache=True)
def _watershed(direction, orow, ocol):
    h, w = direction.shape
    mask = np.zeros((h, w), dtype=np.uint8)
    stack = [(orow, ocol)]
    mask[orow, ocol] = 1
    cells = 1
    while len(stack) > 0:
        r, c = stack.pop()
        for d in range(8):
            rr, cc = r + DR[d], c + DC[d]
            if rr < 0 or cc < 0 or rr >= h or cc >= w or mask[rr, cc]:
                continue
            dm = direction[rr, cc]
            if dm >= 0 and rr + DR[dm] == r and cc + DC[dm] == c:
                mask[rr, cc] = 1
                cells += 1
                stack.append((rr, cc))
    return mask, cells


def watershed(direction: np.ndarray, outlet: tuple[int, int]) -> tuple[np.ndarray, int]:
    m, n = _watershed(direction, int(outlet[0]), int(outlet[1]))
    return m.astype(bool), int(n)


@njit(cache=True)
def _down(direction, r, c, h, w):
    """Flat index of the cell (r, c) drains to, or -1 at a sink or the grid edge."""
    d = direction[r, c]
    if d < 0:
        return -1
    rr, cc = r + DR[d], c + DC[d]
    if rr < 0 or cc < 0 or rr >= h or cc >= w:
        return -1
    return rr * w + cc


@njit(cache=True)
def _trace_streams(direction, order):
    """Stream lines from every source or junction cell, in row-major order: flat cell indices, line offsets, Strahler orders."""
    h, w = order.shape
    stream_in = np.zeros((h, w), dtype=np.uint8)
    starts = 0
    for r in range(h):
        for c in range(w):
            if order[r, c]:
                m = _down(direction, r, c, h, w)
                if m >= 0 and order[m // w, m % w]:
                    stream_in[m // w, m % w] += 1
    for r in range(h):
        for c in range(w):
            if order[r, c] and stream_in[r, c] != 1:
                starts += 1
    total = 0
    cells = np.empty(0, dtype=np.int64)
    offsets = np.zeros(starts + 1, dtype=np.int64)
    strahler = np.zeros(starts, dtype=np.int64)
    for p in range(2):  # pass 0 counts points, pass 1 fills them
        if p == 1:
            cells = np.empty(total, dtype=np.int64)
        offsets = np.zeros(starts + 1, dtype=np.int64)
        strahler = np.zeros(starts, dtype=np.int64)
        k = 0
        total = 0
        for r in range(h):
            for c in range(w):
                if not order[r, c] or stream_in[r, c] == 1:
                    continue
                cur = r * w + c
                if p == 1:
                    cells[total] = cur
                total += 1
                while True:
                    m = _down(direction, cur // w, cur % w, h, w)
                    if m < 0 or not order[m // w, m % w]:
                        break
                    if p == 1:
                        cells[total] = m
                    total += 1
                    if stream_in[m // w, m % w] != 1:
                        break
                    cur = m
                strahler[k] = order[r, c]
                k += 1
                offsets[k] = total
    return cells, offsets, strahler


def stream_lines(flow: dict, to_lonlat_arrays) -> dict:
    """Stream network as lines between sources, junctions and outlets (to_lonlat_arrays: vectorised grid → lon/lat)."""
    w = flow["order"].shape[1]
    cells, offsets, strahler = _trace_streams(flow["dir"], flow["order"])
    lon, lat = to_lonlat_arrays(cells % w + 0.5, cells // w + 0.5)
    bad = np.concatenate([[0], np.cumsum(~(np.isfinite(lon) & np.isfinite(lat)))])  # lines with a point the CRS cannot place are left out
    pts = [[round(x, 7), round(y, 7)] for x, y in zip(lon.tolist(), lat.tolist(), strict=True)]
    feats = []
    for i, o in enumerate(strahler.tolist()):
        a, b = int(offsets[i]), int(offsets[i + 1])
        if b - a >= 2 and bad[b] == bad[a]:
            feats.append({"type": "Feature", "properties": {"strahler": o}, "geometry": {"type": "LineString", "coordinates": pts[a:b]}})
    return {"type": "FeatureCollection", "features": feats}


def nice_interval(relief: float, target: int = 10) -> float:
    if not relief or not relief > 0:
        return 1
    raw = relief / target
    p = 10 ** math.floor(math.log10(raw))
    m = raw / p
    return (1 if m < 1.5 else 2 if m < 3.5 else 5 if m < 7.5 else 10) * p


@njit(cache=True, nogil=True)
def _segments(z, lv):
    """Marching-squares segments at one level: (x1, y1, x2, y2) in grid coordinates and the ids of the two grid edges
    each endpoint lies on (horizontal edge r,c→r,c+1 = 2(rW+c), vertical r,c→r+1,c = 2(rW+c)+1)."""
    h, w = z.shape
    cap = 1024
    xy = np.empty((cap, 4))
    ed = np.empty((cap, 2), dtype=np.int64)
    n = 0
    for r in range(h - 1):
        for c in range(w - 1):
            A, B, C, D = z[r, c], z[r, c + 1], z[r + 1, c + 1], z[r + 1, c]
            if not (np.isfinite(A) and np.isfinite(B) and np.isfinite(C) and np.isfinite(D)):
                continue
            k = (8 if A >= lv else 0) | (4 if B >= lv else 0) | (2 if C >= lv else 0) | (1 if D >= lv else 0)
            if k == 0 or k == 15:
                continue
            x0, y0 = c + 0.5, r + 0.5
            # edges: 0 top (A-B), 1 right (B-C), 2 bottom (D-C), 3 left (A-D)
            if k == 1 or k == 14:
                pa, pb, m = 3, 2, 1
            elif k == 2 or k == 13:
                pa, pb, m = 2, 1, 1
            elif k == 3 or k == 12:
                pa, pb, m = 3, 1, 1
            elif k == 4 or k == 11:
                pa, pb, m = 0, 1, 1
            elif k == 6 or k == 9:
                pa, pb, m = 0, 2, 1
            elif k == 7 or k == 8:
                pa, pb, m = 3, 0, 1
            else:
                m = 2
                high = (A + B + C + D) / 4 >= lv
                pa, pb = (3, 0) if (k == 5) == high else (0, 1)
            for s in range(m):
                if s == 1:
                    if (pa, pb) == (3, 0):
                        pa, pb = 2, 1
                    else:
                        pa, pb = 3, 2
                if n == cap:
                    cap *= 2
                    xy2 = np.empty((cap, 4))
                    xy2[:n] = xy[:n]
                    ed2 = np.empty((cap, 2), dtype=np.int64)
                    ed2[:n] = ed[:n]
                    xy, ed = xy2, ed2
                for j in range(2):
                    e = pa if j == 0 else pb
                    if e == 0:
                        px, py, eid = x0 + (lv - A) / (B - A), y0, 2 * (r * w + c)
                    elif e == 1:
                        px, py, eid = x0 + 1, y0 + (lv - B) / (C - B), 2 * (r * w + c + 1) + 1
                    elif e == 2:
                        px, py, eid = x0 + (lv - D) / (C - D), y0 + 1, 2 * ((r + 1) * w + c)
                    else:
                        px, py, eid = x0, y0 + (lv - A) / (D - A), 2 * (r * w + c) + 1
                    xy[n, 2 * j] = px
                    xy[n, 2 * j + 1] = py
                    ed[n, j] = eid
                n += 1
    return xy[:n], ed[:n]


@njit(cache=True, nogil=True)
def _chain_lines(xy, ed):
    """Joins segments that share a grid edge into lines; returns the points (x, y) and each line's start offset."""
    n = ed.shape[0]
    keys = ed.ravel()
    order = np.argsort(keys, kind="mergesort")
    partner = np.full(2 * n, -1, dtype=np.int64)  # endpoint slot (2·segment + end) → the other segment's slot on that edge
    for i in range(2 * n - 1):
        a, b = order[i], order[i + 1]
        if keys[a] == keys[b]:
            partner[a], partner[b] = b, a
    used = np.zeros(n, dtype=np.bool_)
    pts = np.empty((n + 2 * n, 2))
    starts = np.empty(n + 1, dtype=np.int64)
    npts, nl = 0, 0
    for phase in range(2):  # open lines from a free end first, then closed rings
        for s0 in range(n):
            if used[s0]:
                continue
            if phase == 0:
                if partner[2 * s0] == -1:
                    end = 0
                elif partner[2 * s0 + 1] == -1:
                    end = 1
                else:
                    continue
            else:
                end = 0
            starts[nl] = npts
            nl += 1
            s = s0
            pts[npts, 0], pts[npts, 1] = xy[s, 2 * end], xy[s, 2 * end + 1]
            npts += 1
            while True:
                used[s] = True
                out = 1 - end
                pts[npts, 0], pts[npts, 1] = xy[s, 2 * out], xy[s, 2 * out + 1]
                npts += 1
                q = partner[2 * s + out]
                if q == -1 or used[q // 2]:
                    break
                s, end = q // 2, q % 2
    starts[nl] = npts
    return pts[:npts], starts[: nl + 1]


@njit(cache=True, nogil=True)
def _simplify(pts, starts, tol):
    """Douglas–Peucker (1973) on each line: keeps the vertices that lie more than `tol` from the chord of their span."""
    keep = np.zeros(pts.shape[0], dtype=np.bool_)
    stack = np.empty((pts.shape[0], 2), dtype=np.int64)
    t2 = tol * tol
    for li in range(starts.size - 1):
        a0, b0 = starts[li], starts[li + 1] - 1
        keep[a0] = keep[b0] = True
        top = 0
        if b0 - a0 > 1:
            # a ring's chord is a point: split it at its farthest vertex first
            if pts[a0, 0] == pts[b0, 0] and pts[a0, 1] == pts[b0, 1]:
                far, fd = a0 + 1, -1.0
                for i in range(a0 + 1, b0):
                    d = (pts[i, 0] - pts[a0, 0]) ** 2 + (pts[i, 1] - pts[a0, 1]) ** 2
                    if d > fd:
                        far, fd = i, d
                keep[far] = True
                stack[0, 0], stack[0, 1], stack[1, 0], stack[1, 1] = a0, far, far, b0
                top = 2
            else:
                stack[0, 0], stack[0, 1] = a0, b0
                top = 1
        while top:
            top -= 1
            a, b = stack[top, 0], stack[top, 1]
            if b - a < 2:
                continue
            ax, ay = pts[a, 0], pts[a, 1]
            dx, dy = pts[b, 0] - ax, pts[b, 1] - ay
            L2 = dx * dx + dy * dy
            far, fd = -1, t2
            for i in range(a + 1, b):
                px, py = pts[i, 0] - ax, pts[i, 1] - ay
                cr = px * dy - py * dx
                d = cr * cr / L2 if L2 > 0 else px * px + py * py
                if d > fd:
                    far, fd = i, d
            if far >= 0:
                keep[far] = True
                stack[top, 0], stack[top, 1] = a, far
                stack[top + 1, 0], stack[top + 1, 1] = far, b
                top += 2
    idx = np.flatnonzero(keep)
    new_starts = np.searchsorted(idx, starts)
    return pts[idx], new_starts


def contour_grid(z: np.ndarray, levels: list[float], tol: float = 0.0) -> list[tuple[float, list[list[tuple[float, float]]]]]:
    """Marching squares on cell centres (grid coordinates col,row), saddles resolved by the centre value; segments
    are joined through the grid edges they share, and `tol` > 0 simplifies the lines (Douglas–Peucker, in cells)."""
    out = []
    zz = np.ascontiguousarray(z, dtype=np.float64)
    for lv in levels:
        pts, starts = _level_lines(zz, lv, tol)
        out.append((lv, [[(float(x), float(y)) for x, y in pts[starts[i] : starts[i + 1]].tolist()] for i in range(starts.size - 1)]))
    return out


def _level_lines(z: np.ndarray, lv: float, tol: float) -> tuple[np.ndarray, np.ndarray]:
    xy, ed = _segments(z, lv)
    pts, starts = _chain_lines(xy, ed)
    return _simplify(pts, starts, tol) if tol > 0 else (pts, starts)


#: Douglas–Peucker tolerance for exported contours, in cells: a quarter cell is below what a DEM can place.
CONTOUR_TOLERANCE = 0.25
#: Most vertices one contour export may hold (about 30 bytes each in GeoJSON).
CONTOUR_MAX_POINTS = 3_000_000


def contours_geojson(z: np.ndarray, to_lonlat_arrays, interval: float, max_levels: int = 60, tol: float = CONTOUR_TOLERANCE) -> dict:
    """Contour lines every `interval` (at most `max_levels`) as GeoJSON; to_lonlat_arrays: vectorised grid → lon/lat."""
    v = z[np.isfinite(z)]
    if not interval > 0 or not v.size:
        return {"fc": {"type": "FeatureCollection", "features": []}, "levels": 0, "points": 0}
    lo, hi = float(v.min()), float(v.max())
    levels: list[float] = []
    x = math.ceil(lo / interval) * interval
    while x <= hi and len(levels) < max_levels:
        levels.append(round(x * 1e6) / 1e6)
        x += interval
    zz = np.ascontiguousarray(z, dtype=np.float64)
    with ThreadPoolExecutor() as pool:  # the kernels release the GIL
        per_level = list(pool.map(lambda lv: _level_lines(zz, lv, tol), levels))
    total = sum(p.shape[0] for p, _ in per_level)
    if total > CONTOUR_MAX_POINTS:
        raise ValueError(f"These contours would hold {total:,} vertices (the limit is {CONTOUR_MAX_POINTS:,}); choose a larger interval.")
    feats = []
    for level, (pts, starts) in zip(levels, per_level, strict=True):
        if not pts.shape[0]:
            continue
        lon, lat = to_lonlat_arrays(pts[:, 0], pts[:, 1])
        bad = np.concatenate([[0], np.cumsum(~(np.isfinite(lon) & np.isfinite(lat)))])  # lines with a point the CRS cannot place are left out
        coords = np.column_stack([np.round(lon, 7), np.round(lat, 7)]).tolist()
        for i in range(starts.size - 1):
            a, b = int(starts[i]), int(starts[i + 1])
            if b - a >= 2 and bad[b] == bad[a]:
                feats.append({"type": "Feature", "properties": {"elevation": level}, "geometry": {"type": "LineString", "coordinates": coords[a:b]}})
    return {"fc": {"type": "FeatureCollection", "features": feats}, "levels": len(levels), "points": total}
