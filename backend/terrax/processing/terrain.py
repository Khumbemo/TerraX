"""Terrain analysis from a DEM.

* Slope and aspect by Horn's (1981) 3×3 method; hillshade (sun azimuth 315°,
  altitude 45°); relief and the hypsometric integral (Strahler 1952).
* Depression filling: Priority-Flood with an epsilon gradient so flats drain
  (Barnes, Lehman & Mulla 2014, Computers & Geosciences 62:117).
* Flow direction: D8 steepest descent (O'Callaghan & Mark 1984) with ground
  distances; flow accumulation as upslope contributing area (m²); Strahler
  (1957) stream order on cells above an area threshold.
* Watersheds above an outlet, stream lines, and contours by marching squares.
"""

from __future__ import annotations

import heapq
import math
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
        raise ValueError("The DEM has no ground units TerraX can use (supported: WGS84, Web Mercator, WGS84 UTM), so slope cannot be computed.")
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


def flow_routing(dem: np.ndarray, geo: Ground, threshold_m2: float) -> dict:
    filled, raised, max_raise = fill_depressions(dem)
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
            "maxOrder": int(max_order), "lengthByOrder": lengths, "raisedCells": int(raised), "maxRaise": float(max_raise)}


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


def contour_grid(z: np.ndarray, levels: list[float]) -> list[tuple[float, list[list[tuple[float, float]]]]]:
    """Marching squares on cell centres (grid coordinates col,row), saddles resolved by the centre value."""
    out = []
    a, b = z[:-1, :-1], z[:-1, 1:]
    cc, d = z[1:, 1:], z[1:, :-1]
    ok = np.isfinite(a) & np.isfinite(b) & np.isfinite(cc) & np.isfinite(d)
    rows, cols = np.nonzero(ok)
    A, B, C, D = a[rows, cols], b[rows, cols], cc[rows, cols], d[rows, cols]
    x0, y0 = cols + 0.5, rows + 0.5
    centre = (A + B + C + D) / 4
    with np.errstate(divide="ignore", invalid="ignore"):
        for lv in levels:
            idx = (A >= lv) * 8 | (B >= lv) * 4 | (C >= lv) * 2 | (D >= lv) * 1
            sel = (idx != 0) & (idx != 15)
            segs: list = []
            for i in np.flatnonzero(sel):
                k = int(idx[i])

                def lerp(v1: float, v2: float, lv: float = lv) -> float:
                    return (lv - v1) / (v2 - v1)

                top = (x0[i] + lerp(A[i], B[i]), y0[i])
                right = (x0[i] + 1, y0[i] + lerp(B[i], C[i]))
                bottom = (x0[i] + lerp(D[i], C[i]), y0[i] + 1)
                left = (x0[i], y0[i] + lerp(A[i], D[i]))
                high = centre[i] >= lv
                if k in (1, 14):
                    segs.append((left, bottom))
                elif k in (2, 13):
                    segs.append((bottom, right))
                elif k in (3, 12):
                    segs.append((left, right))
                elif k in (4, 11):
                    segs.append((top, right))
                elif k in (6, 9):
                    segs.append((top, bottom))
                elif k in (7, 8):
                    segs.append((left, top))
                elif k == 5:
                    segs += [(left, top), (bottom, right)] if high else [(top, right), (left, bottom)]
                elif k == 10:
                    segs += [(top, right), (left, bottom)] if high else [(left, top), (bottom, right)]
            out.append((lv, _chain(segs)))
    return out


def _chain(segs):
    key = lambda p: (round(p[0] * 1e6), round(p[1] * 1e6))
    ends: dict = {}
    for i, (p, q) in enumerate(segs):
        for e in (key(p), key(q)):
            ends.setdefault(e, []).append(i)
    used = [False] * len(segs)
    lines = []

    def extend(line, at_end):
        while True:
            tip = line[-1] if at_end else line[0]
            nxt = next((i for i in ends.get(key(tip), []) if not used[i]), None)
            if nxt is None:
                return
            used[nxt] = True
            p, q = segs[nxt]
            other = q if key(p) == key(tip) else p
            if at_end:
                line.append(other)
            else:
                line.insert(0, other)

    for i, (p, q) in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        line = [p, q]
        extend(line, True)
        extend(line, False)
        lines.append(line)
    return lines


def contours_geojson(z: np.ndarray, to_lonlat, interval: float, max_levels: int = 60) -> dict:
    v = z[np.isfinite(z)]
    if not interval > 0 or not v.size:
        return {"fc": {"type": "FeatureCollection", "features": []}, "levels": 0}
    lo, hi = float(v.min()), float(v.max())
    levels: list[float] = []
    x = math.ceil(lo / interval) * interval
    while x <= hi and len(levels) < max_levels:
        levels.append(round(x * 1e6) / 1e6)
        x += interval
    feats = []
    for level, lines in contour_grid(z, levels):
        for line in lines:
            if len(line) >= 2:
                feats.append({"type": "Feature", "properties": {"elevation": level}, "geometry": {"type": "LineString", "coordinates": [to_lonlat(px, py) for px, py in line]}})
    return {"fc": {"type": "FeatureCollection", "features": feats}, "levels": len(levels)}
