"""Water bodies from a water map: an inventory of lakes and ponds, water over time, and water-quality indices.

Inventory: each 8-connected patch of water is one water body. For each one TerraX reports:

* **area**: the true ground area of its cells;
* **perimeter**: the length of the pixel edges between the body and anything else. This is a staircase along the
  pixel edges, so it is longer than a smooth shoreline: on average by 4/π ≈ 1.27 for shores running in every direction,
  and by up to √2 ≈ 1.41 on a shore at 45° to the grid. It also depends on the pixel size (a finer grid traces more
  of the shore), so compare perimeters only between maps of the same resolution;
* **shoreline development** D_L = P / (2√(πA)) (Hutchinson 1957): 1 for a circle, larger for elongated or dendritic
  bodies. It carries the perimeter's staircase bias (a pixelated circle gives about 1.27);
* **centroid**: the area-weighted mean position of its cells (for a crescent or a dendritic reservoir it can fall on land);
* whether it touches the image edge, the analysis boundary, cloud or missing data, where its full extent is unknown:
  its area and perimeter are those of the visible part only.

Water over time: from many dated images on one grid, each pixel's **water occurrence** is the number of observations
in which it was water divided by the number of valid (cloud-free) observations, as in the Global Surface Water dataset
(Pekel et al. 2016). Pixels with too few valid observations are left out rather than given an unreliable occurrence.
One threshold, from the pooled values of all dates, is used for every date, so dates are judged alike.

Water quality (optical images only): two normalised-difference indices over water.

* **NDTI** = (Red − Green) / (Red + Green) (Lacaux et al. 2007): higher in more turbid water (suspended sediment);
* **NDCI** = (Red-edge 705 nm − Red) / (Red-edge 705 nm + Red) (Mishra & Mishra 2012): higher with more chlorophyll-a
  (phytoplankton). It needs a red-edge band near 705 nm (Sentinel-2 band 5); without one it is not computed.

They are relative indicators, not concentrations: turning them into turbidity (NTU) or chlorophyll-a (µg/L) needs
water samples taken near the image date to calibrate them locally. They are computed only on interior water pixels
(water pixels whose 8 neighbours are all water), because shore pixels mix land and water reflectance. Shallow clear
water (the bottom shows through), sun glint, floating plants and thin cloud or haze also change them, and the image
should be atmospherically corrected surface reflectance (Sentinel-2 L2A, Landsat Collection 2 Level-2).

References: Hutchinson GE (1957) A Treatise on Limnology, Vol. 1. Wiley. Pekel J-F, Cottam A, Gorelick N, Belward AS
(2016) Nature 540: 418–422. Lacaux JP, Tourre YM, Vignolles C, Ndione JA, Lafaye M (2007) Remote Sensing of
Environment 106: 66–74. Mishra S, Mishra DR (2012) Remote Sensing of Environment 117: 394–406.
"""

from __future__ import annotations

import csv
import io
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy import ndimage

from .patches import EIGHT, label_patches, patch_areas
from .rio import Ground
from .stats import fmt

#: Size classes of water bodies (ha), lower bound inclusive.
SIZE_CLASSES: list[tuple[float, float, str]] = [(0, 1, "under 1 ha"), (1, 10, "1–10 ha"), (10, 100, "10–100 ha"), (100, math.inf, "100 ha or more")]
#: Rows written to the inventory CSV (largest bodies first); single-pixel speckle can make millions of bodies.
CSV_MAX = 50_000

OCCURRENCE_LEGEND = [
    {"id": 1, "label": "Never water", "color": [120, 110, 90]},
    {"id": 2, "label": "Water at times", "color": [110, 200, 250]},
    {"id": 3, "label": "Water almost always", "color": [20, 60, 160]},
]


@dataclass
class Inventory:
    labels: np.ndarray  # int32 body ids 1..count, largest first; 0 elsewhere (and for bodies under the minimum area)
    count: int
    area_ha: np.ndarray  # per id, index 0 unused
    perimeter_m: np.ndarray
    lon: np.ndarray
    lat: np.ndarray
    truncated: np.ndarray  # bool: touches the image edge, the boundary, cloud or missing data
    removed: int  # bodies smaller than the minimum area
    removed_ha: float


def perimeters(labels: np.ndarray, n: int, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """Length (m) of the pixel edges between each patch and anything else, image edges included; index 0 unused.
    `dx`, `dy` are the cell width and height of each row (m); a horizontal edge takes the width of its own cell's row."""
    h, w = labels.shape
    per = np.zeros(n + 1)
    rows_dy = np.broadcast_to(dy[:, None], (h, w - 1))
    left, right = labels[:, :-1], labels[:, 1:]
    diff = left != right
    per += np.bincount(left[diff], weights=rows_dy[diff], minlength=n + 1)
    per += np.bincount(right[diff], weights=rows_dy[diff], minlength=n + 1)
    per += np.bincount(labels[:, 0], weights=dy, minlength=n + 1) + np.bincount(labels[:, -1], weights=dy, minlength=n + 1)
    up, down = labels[:-1], labels[1:]
    diff = up != down
    per += np.bincount(up[diff], weights=np.broadcast_to(dx[:-1, None], (h - 1, w))[diff], minlength=n + 1)
    per += np.bincount(down[diff], weights=np.broadcast_to(dx[1:, None], (h - 1, w))[diff], minlength=n + 1)
    per += np.bincount(labels[0], weights=np.full(w, dx[0]), minlength=n + 1) + np.bincount(labels[-1], weights=np.full(w, dx[-1]), minlength=n + 1)
    per[0] = 0
    return per


def _centroids(labels: np.ndarray, n: int, cell_area: np.ndarray, transform, crs, geographic: bool) -> tuple[np.ndarray, np.ndarray]:
    """Area-weighted mean cell centre of each patch in WGS84 longitude and latitude (NaN without georeferencing)."""
    h, w = labels.shape
    weights = np.broadcast_to(cell_area[:, None], (h, w)).ravel()
    flat = labels.ravel()
    total = np.bincount(flat, weights=weights, minlength=n + 1)
    cols = np.broadcast_to(np.arange(w) + 0.5, (h, w)).ravel()
    rows = np.broadcast_to((np.arange(h) + 0.5)[:, None], (h, w)).ravel()
    with np.errstate(invalid="ignore", divide="ignore"):
        c = np.bincount(flat, weights=cols * weights, minlength=n + 1) / total
        r = np.bincount(flat, weights=rows * weights, minlength=n + 1) / total
    if transform is None or (crs is None and not geographic):
        nan = np.full(n + 1, np.nan)
        return nan, nan.copy()
    xs = transform.c + c * transform.a + r * transform.b
    ys = transform.f + c * transform.d + r * transform.e
    if geographic:
        return xs, ys
    from rasterio.warp import transform as warp

    lon, lat = warp(crs, "EPSG:4326", xs[1:].tolist(), ys[1:].tolist())
    return np.concatenate([[np.nan], lon]), np.concatenate([[np.nan], lat])


def inventory(water: np.ndarray, unknown: np.ndarray, geo: Ground, transform, crs, geographic: bool, min_ha: float = 0.0) -> Inventory:
    """The water bodies of a water mask. `unknown` marks cells whose class is not known (outside the boundary, cloud,
    no data): a body next to one, or to the image edge, is flagged as truncated."""
    labels, n = label_patches(water)
    area = patch_areas(labels, n, geo.cell_area) / 1e4 if n else np.zeros(1)
    keep = np.ones(n + 1, dtype=bool)
    keep[0] = False
    if min_ha > 0 and n:
        keep[1:] = area[1:] >= min_ha
    removed = int(n - keep[1:].sum()) if n else 0
    removed_ha = float(area[1:][~keep[1:]].sum()) if n else 0.0
    old = np.flatnonzero(keep)
    order = old[np.lexsort((old, -area[old]))] if old.size else old  # largest first; ties in raster order
    new_id = np.zeros(n + 1, dtype=np.int32)
    new_id[order] = np.arange(1, order.size + 1, dtype=np.int32)
    labels = new_id[labels]
    k = int(order.size)
    area_k = np.concatenate([[0.0], area[order]])
    per = perimeters(labels, k, geo.dx, geo.dy) if k else np.zeros(1)
    lon, lat = _centroids(labels, k, geo.cell_area, transform, crs, geographic) if k else (np.full(1, np.nan), np.full(1, np.nan))
    near = ndimage.binary_dilation(unknown, structure=EIGHT)
    near[0, :] = near[-1, :] = True
    near[:, 0] = near[:, -1] = True
    truncated = np.zeros(k + 1, dtype=bool)
    truncated[np.unique(labels[near & (labels > 0)])] = True
    truncated[0] = False
    return Inventory(labels, k, area_k, per, lon, lat, truncated, removed, removed_ha)


def body_means(labels: np.ndarray, count: int, values: np.ndarray, where: np.ndarray, cell_area: np.ndarray) -> np.ndarray:
    """Area-weighted mean of `values` over the cells of each body where `where` holds (NaN for bodies with none)."""
    h, w = labels.shape
    ok = where & np.isfinite(values) & (labels > 0)
    wts = np.broadcast_to(cell_area[:, None], (h, w))[ok]
    lab = labels[ok]
    total = np.bincount(lab, weights=wts, minlength=count + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.bincount(lab, weights=values[ok] * wts, minlength=count + 1) / total
    out[total == 0] = np.nan
    return out


def body_areas(labels: np.ndarray, count: int, where: np.ndarray, cell_area: np.ndarray) -> np.ndarray:
    """Area (ha) of the cells of each body where `where` holds."""
    return patch_areas(np.where(where, labels, 0), count, cell_area) / 1e4


def shore_development(area_ha: float, perimeter_m: float) -> float | None:
    a = area_ha * 1e4
    return perimeter_m / (2 * math.sqrt(math.pi * a)) if a > 0 else None


def rows(inv: Inventory, extra: dict[str, np.ndarray] | None = None, digits: dict[str, int] | None = None) -> list[dict[str, Any]]:
    """One record per body, largest first; `extra` adds per-body columns (index = body id)."""
    out = []
    for i in range(1, inv.count + 1):
        a, p = float(inv.area_ha[i]), float(inv.perimeter_m[i])
        d = shore_development(a, p)
        rec: dict[str, Any] = {
            "id": i, "area_ha": round(a, 4), "perimeter_m": round(p, 1), "shore_dev": round(d, 3) if d is not None else None,
            "lon": round(float(inv.lon[i]), 6) if np.isfinite(inv.lon[i]) else None,
            "lat": round(float(inv.lat[i]), 6) if np.isfinite(inv.lat[i]) else None,
            "size_class": size_class(a), "truncated": bool(inv.truncated[i]),
        }
        for key, arr in (extra or {}).items():
            v = float(arr[i])
            rec[key] = round(v, (digits or {}).get(key, 4)) if np.isfinite(v) else None
        out.append(rec)
    return out


def size_class(ha: float) -> str:
    return next(label for lo, hi, label in SIZE_CLASSES if lo <= ha < hi)


def size_summary(inv: Inventory) -> list[dict[str, Any]]:
    a = inv.area_ha[1:]
    return [{"label": label, "count": int(((a >= lo) & (a < hi)).sum()), "ha": float(a[(a >= lo) & (a < hi)].sum())} for lo, hi, label in SIZE_CLASSES]


def to_csv(records: list[dict[str, Any]]) -> str:
    if not records:
        return ""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(records[0].keys()), lineterminator="\n")
    w.writeheader()
    for r in records[:CSV_MAX]:
        w.writerow({k: ("" if v is None else v) for k, v in r.items()})
    return buf.getvalue()


def inventory_notes(inv: Inventory, min_ha: float, what: str) -> list[str]:
    notes = [f"Water bodies are the 8-connected patches of {what}. Perimeters follow the pixel edges, so they are longer than the real "
             "shoreline (on average by about 27 % for shores in every direction, up to 41 % on diagonal shores) and grow with finer pixels; "
             "compare them only between maps of the same resolution. Shoreline development is P / (2√(πA)) (Hutchinson 1957) and carries the "
             "same bias. A centroid is the area-weighted centre and can fall on land for curved bodies."]
    if inv.removed:
        notes.append(f"{inv.removed:,} water bodies smaller than {fmt(min_ha, 3)} ha ({fmt(inv.removed_ha, 4)} ha in all) are left out of the inventory.")
    t = int(inv.truncated[1:].sum())
    if t:
        notes.append(f"{t:,} of {inv.count:,} water bodies touch the image edge, the boundary, cloud or missing data, so their full size is "
                     "unknown: their area and perimeter are those of the visible part (marked truncated).")
    if inv.count > CSV_MAX:
        notes.append(f"The inventory CSV lists the {CSV_MAX:,} largest of {inv.count:,} water bodies; set a minimum area to drop speckle.")
    return notes


def inventory_markdown(inv: Inventory, records: list[dict[str, Any]], extra_cols: list[tuple[str, str]] | None = None, top: int = 15) -> str:
    """Markdown: size classes and the largest bodies."""
    if not inv.count:
        return "No water bodies were found."
    sizes = size_summary(inv)
    cols = extra_cols or []
    head = "| # | Area (ha) | Perimeter (km) | Shoreline dev. | Latitude | Longitude |" + "".join(f" {c[1]} |" for c in cols)
    sep = "|---|---|---|---|---|---|" + "---|" * len(cols)
    def cell(v: Any) -> str:
        return "—" if v is None else fmt(v, 3) if isinstance(v, float) else str(v)

    def coord(v: float | None) -> str:  # 5 decimals ≈ 1 m
        return "—" if v is None else f"{v:.5f}"
    lines = [
        f"{inv.count:,} water bodies, {fmt(float(inv.area_ha[1:].sum()), 4)} ha in all; the largest is {fmt(float(inv.area_ha[1]), 4)} ha.", "",
        "| Size | Bodies | Area (ha) |", "|---|---|---|", *[f"| {s['label']} | {s['count']:,} | {fmt(s['ha'], 4)} |" for s in sizes], "",
        f"Largest {min(top, inv.count)}{' (* = truncated by the image edge, boundary or cloud)' if any(r['truncated'] for r in records[:top]) else ''}:", "",
        head, sep,
    ]
    for r in records[:top]:
        lines.append(f"| {r['id']}{'*' if r['truncated'] else ''} | {fmt(r['area_ha'], 4)} | {fmt(r['perimeter_m'] / 1000, 3)} | {cell(r['shore_dev'])} | "
                     f"{coord(r['lat'])} | {coord(r['lon'])} |" + "".join(f" {cell(r.get(c[0]))} |" for c in cols))
    return "\n".join(lines)


# Water over time ---------------------------------------------------------------------------------------------------


def occurrence(n_water: np.ndarray, n_valid: np.ndarray, min_obs: int, almost_pct: float) -> tuple[np.ndarray, np.ndarray]:
    """Per-pixel water occurrence (%) from the counts of water and valid observations, and classes (0 too few valid
    observations, 1 never water, 2 water at times, 3 water in at least `almost_pct` % of valid observations)."""
    enough = n_valid >= min_obs
    with np.errstate(invalid="ignore", divide="ignore"):
        occ = np.where(enough, n_water / np.maximum(n_valid, 1) * 100, np.nan).astype(np.float32)
    # A small tolerance so that 9 of 10 observations meets 90 % despite floating-point rounding.
    cls = np.where(~enough, 0, np.where(n_water == 0, 1, np.where(occ >= almost_pct - 1e-4, 3, 2))).astype(np.uint8)
    return occ, cls


def series_markdown(r: dict[str, Any], inv_md: str | None) -> str:
    unit = "ha" if r["classes"][0]["ha"] is not None else "pixels"
    def a(v: float | None, px: int) -> str:
        return fmt(v, 4) if v is not None else f"{px:,}"
    lines = [
        "## Dataset", "", f"- {len(r['dates'])} images, {r['dates'][0]['date']} to {r['dates'][-1]['date']}", "",
        "## Results", "",
        f"### Water occurrence ({r['index']}, one threshold for every date)", "",
        f"| Class | Area ({unit}) |", "|---|---|", *[f"| {c['label']} | {a(c['ha'], c['pixels'])} |" for c in r["classes"]], "",
        "### Water on each date", "",
        f"| Date | File | Observed (% of area) | Water seen ({unit}) | Water share of what was seen |", "|---|---|---|---|---|",
        *[f"| {d['date']} | {d['file']} | {d['observedPct']:.1f} % | {a(d['waterHa'], d['waterPixels'])} | "
          + (f"{d['waterSharePct']:.2f} %" if d["waterSharePct"] is not None else "—") + " |" for d in r["dates"]],
        "",
        "Water seen on a date is only what was visible: compare dates with similar observed shares, or compare the water share of what was seen.",
    ]
    if inv_md:
        lines += ["", "### Water bodies (water at least once)", "", inv_md]
    lines += ["", "## Method and limits", "", *[f"- {n}" for n in r["notes"]]]
    return "\n".join(lines)


# Water quality -----------------------------------------------------------------------------------------------------


def normalised_difference(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (a - b) / (a + b)
    return np.where(np.isfinite(v) & (a + b > 0), v, np.nan)


def interior(water: np.ndarray) -> np.ndarray:
    """Water cells whose 8 neighbours are all water (cells on the image edge are not interior)."""
    return ndimage.binary_erosion(water, structure=EIGHT, border_value=0)


def quality_stats(values: np.ndarray, mask: np.ndarray) -> dict[str, Any] | None:
    v = values[mask & np.isfinite(values)]
    if v.size == 0:
        return None
    p10, p50, p90 = (float(x) for x in np.percentile(v, [10, 50, 90]))
    return {"pixels": int(v.size), "p10": p10, "median": p50, "p90": p90}
