"""Residential plot change and encroachment screening.

1. Images of different dates are put on one grid: for GeoTIFFs, a UTM grid
   around the property boundary (plus a buffer); for plain photos, a common
   pixel grid (the photos must show the same framing).
2. Relative radiometric normalisation: for each band the later image is
   regressed on the earlier one, and the fit is repeated on pixels with small
   residuals (pseudo-invariant features; Schott, Salvaggio & Volchok 1988).
3. Change magnitude = RMS of the per-band residuals, each divided by its robust
   SD (a normalised change vector, cf. Malila 1980). Cells are "changed" above
   median + k × 1.4826 × MAD.
4. Changed cells form 8-connected patches (small gaps bridged); patches below a
   minimum area are dropped and the rest are placed relative to the property:
   crossing the line, along the inside edge, elsewhere inside, or outside.
5. The change in excess greenness (ExG) marks vegetation loss or gain.

A screening aid: it finds where the ground changed, not who is legally entitled
to it.
"""

from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
from numba import njit
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.transform import from_bounds
from scipy import ndimage

from .patches import EIGHT, label_patches, patch_areas, patches_to_geojson
from .rio import Raster
from .stats import fmt

ZONES = {
    "crossing": {"label": "Crosses the boundary", "color": [236, 72, 153], "meaning": "A changed patch that is continuous across the boundary line: the pattern expected when a neighbouring structure, fence or field is extended onto the property."},
    "alignment": {"label": "Thin strip along the line", "color": [167, 139, 250], "meaning": "Change hugging the boundary line no deeper than the registration tolerance: usually the images being slightly misaligned (a fence or wall appearing to move), not encroachment."},
    "edge": {"label": "Along the inside edge", "color": [239, 68, 68], "meaning": "Change inside the property within the edge strip, not connected across the line."},
    "inside": {"label": "Elsewhere inside", "color": [250, 204, 21], "meaning": "Change in the interior of the property (often the owner’s own building or clearing)."},
    "outside": {"label": "Outside (neighbours)", "color": [96, 165, 250], "meaning": "Change on neighbouring land, shown for context."},
}
ZONE_CODE = {"crossing": 1, "edge": 2, "inside": 3, "outside": 4, "alignment": 5}
ZONE_ORDER = ["crossing", "edge", "alignment", "inside", "outside"]
DEFAULT_PARAMS = {"sensitivity": 3.0, "minArea": 4.0, "stripWidth": 3.0, "gap": 1.5, "tolerance": 1.0}


def _rgb_bands(n: int) -> list[int]:
    if n >= 4:
        return [2, 1, 0]  # B2, B3, B4, B8… (Sentinel-2 / Earth Engine order)
    if n == 3:
        return [0, 1, 2]
    return [0, 0, 0]


def _native_cell_m(r: Raster, lat: float) -> float | None:
    if not r.meta.pixel_size:
        return None
    px, py = r.meta.pixel_size
    if r.meta.geographic:
        return min(px * 111_320 * math.cos(math.radians(lat)), py * 110_574)
    if r.meta.epsg in (3857, 900913):
        return min(px, py) * math.cos(math.radians(lat))
    return min(px, py)


def _rings(fc: dict) -> list[list]:
    rings = []
    for f in fc.get("features", []):
        g = (f or {}).get("geometry") or {}
        if g.get("type") == "Polygon":
            rings += g["coordinates"]
        elif g.get("type") == "MultiPolygon":
            for p in g["coordinates"]:
                rings += p
    return [r for r in rings if len(r) >= 3]


def prepare_geo_stack(images: list[dict], boundary: dict, buffer_m: float = 20, max_side: int = 1600) -> dict:
    """Resamples georeferenced images onto a UTM grid around the boundary (nearest neighbour)."""
    if len(images) < 2:
        raise ValueError("Add at least two images: an earlier one and a current one.")
    rings = _rings(boundary["geojson"])
    if not rings:
        raise ValueError("The property boundary has no polygon.")
    pts = [p for r in rings for p in r]
    clat = sum(p[1] for p in pts) / len(pts)
    clon = sum(p[0] for p in pts) / len(pts)
    zone = min(60, int((clon + 180) // 6) + 1)
    south = clat < 0
    epsg = (32700 if south else 32600) + zone
    to_en = Transformer.from_crs(4326, epsg, always_xy=True)
    en = [to_en.transform(p[0], p[1]) for p in pts]
    min_e, max_e = min(e for e, _ in en) - buffer_m, max(e for e, _ in en) + buffer_m
    min_n, max_n = min(n for _, n in en) - buffer_m, max(n for _, n in en) + buffer_m
    notes: list[str] = []
    sizes = [_native_cell_m(i["raster"], clat) for i in images]
    if any(s is None or s <= 0 for s in sizes):
        raise ValueError("Every image must be georeferenced (WGS84, Web Mercator or UTM) to be placed on the property.")
    cell = max(0.1, min(sizes))
    span = max(max_e - min_e, max_n - min_n)
    if span / cell > max_side:
        notes.append(f"The finest image is {fmt(cell, 3)} m per pixel; the analysis grid was coarsened to {fmt(span / max_side, 3)} m to stay under {max_side} pixels across.")
        cell = span / max_side
    width, height = math.ceil((max_e - min_e) / cell), math.ceil((max_n - min_n) / cell)
    max_e = min_e + width * cell
    min_n = max_n - height * cell
    if max(sizes) > cell * 1.5:
        notes.append(f"Image resolutions differ ({', '.join(f'{fmt(s, 3)} m' for s in sizes)}); coarser images were resampled (nearest neighbour) onto the {fmt(cell, 3)} m grid, so their edges are blockier and more change can appear along edges.")
    ce = min_e + (np.arange(width) + 0.5) * cell
    cn = max_n - (np.arange(height) + 0.5) * cell
    E, N = np.meshgrid(ce, cn)
    layers = []
    for img in images:
        r: Raster = img["raster"]
        if not r.meta.bbox or (not r.meta.geographic and r.crs is None):
            raise ValueError(f"{r.meta.filename} is not in a supported CRS (WGS84, Web Mercator or UTM).")
        idx = _rgb_bands(r.meta.bands)
        uniq = sorted(set(idx))
        grids = dict(zip(uniq, r.read_bands(uniq)))
        g0 = grids[uniq[0]]
        dst = "EPSG:4326" if r.meta.geographic else r.crs
        x, y = Transformer.from_crs(epsg, dst, always_xy=True).transform(E, N)
        bx0, by0, bx1, by1 = r.meta.bbox
        cw, ch = (bx1 - bx0) / g0.width, (by1 - by0) / g0.height
        col = np.floor((x - bx0) / cw).astype(np.int64)
        row = np.floor((by1 - y) / ch).astype(np.int64)
        ok = (col >= 0) & (row >= 0) & (col < g0.width) & (row < g0.height)
        inside = int(ok.sum())
        cc, rr = np.clip(col, 0, g0.width - 1), np.clip(row, 0, g0.height - 1)
        rgb = [np.where(ok, grids[b].data[rr, cc], np.nan).astype(np.float32) for b in idx]
        if inside < width * height * 0.5:
            raise ValueError(f"{r.meta.filename} covers less than half of the property area. Check that it shows this property.")
        if inside < width * height:
            notes.append(f"{r.meta.filename} does not cover the whole analysis area; uncovered cells are ignored.")
        layers.append({"label": img["label"], "date": img.get("date"), "rgb": rgb})
    transform = from_bounds(min_e, min_n, max_e, max_n, width, height)
    geoms = []
    for f in boundary["geojson"]["features"]:
        g = (f or {}).get("geometry")
        if g and g.get("type") in ("Polygon", "MultiPolygon"):
            from rasterio.warp import transform_geom

            geoms.append(transform_geom("EPSG:4326", f"EPSG:{epsg}", g))
    prop = ~geometry_mask(geoms, out_shape=(height, width), transform=transform, all_touched=False)
    notes.insert(0, f"Images were resampled onto a {width} × {height} grid of {fmt(cell, 3)} m cells in UTM zone {zone}{'S' if south else 'N'} covering the property plus {buffer_m:g} m around it.")
    grid = SimpleNamespace(meta=SimpleNamespace(bbox=(min_e, min_n, max_e, max_n), geographic=False), crs=f"EPSG:{epsg}", transform=transform)
    return {"width": width, "height": height, "cellM": cell, "layers": layers, "property": prop, "grid": grid, "notes": notes, "epsg": epsg}


def _rasterize_rings(rings: list[list[tuple[float, float]]], width: int, height: int) -> np.ndarray:
    """Rings in grid coordinates (col, row), filled by cell centres (even–odd)."""
    from shapely.geometry import Polygon

    geoms = [Polygon(r).__geo_interface__ for r in rings if len(r) >= 3]
    return ~geometry_mask(geoms, out_shape=(height, width), transform=from_bounds(0, height, width, 0, width, height), all_touched=False) if geoms else np.zeros((height, width), bool)


def prepare_photo_stack(photos: list[dict], outline: list[list[float]], ground_width_m: float | None, max_side: int = 1200) -> dict:
    """Plain photos (RGBA arrays) on one pixel grid; they must show the same framing."""
    if len(photos) < 2:
        raise ValueError("Add at least two images: an earlier one and a current one.")
    ref = photos[-1]["rgba"]
    s = min(1.0, max_side / max(ref.shape[1], ref.shape[0]))
    width, height = max(1, round(ref.shape[1] * s)), max(1, round(ref.shape[0] * s))
    notes = []
    aspects = [p["rgba"].shape[1] / p["rgba"].shape[0] for p in photos]
    if max(aspects) / min(aspects) > 1.02:
        notes.append("The photos have different shapes, so they were stretched to the same size; that suggests different framing, which causes false change.")
    layers = []
    for p in photos:
        a = p["rgba"]
        sr = np.minimum(a.shape[0] - 1, np.floor((np.arange(height) + 0.5) / height * a.shape[0]).astype(int))
        sc = np.minimum(a.shape[1] - 1, np.floor((np.arange(width) + 0.5) / width * a.shape[1]).astype(int))
        sub = a[sr][:, sc].astype(np.float32)
        opaque = sub[..., 3] > 127
        layers.append({"label": p["label"], "date": p.get("date"), "rgb": [np.where(opaque, sub[..., b], np.nan) for b in range(3)]})
    if len(outline) < 3:
        raise ValueError("Trace the property outline on the current image (at least three corners).")
    prop = _rasterize_rings([[tuple(x) for x in outline]], width, height)
    cell = ground_width_m / width if ground_width_m and ground_width_m > 0 else None
    scale = f" Scale from the entered ground width: {fmt(cell, 3)} m per pixel." if cell else " Without a ground width, sizes are in pixels."
    notes.insert(0, f"Photos were compared pixel by pixel on a {width} × {height} grid; they are not georeferenced, so they must show exactly the same view.{scale}")
    return {"width": width, "height": height, "cellM": cell, "layers": layers, "property": prop, "grid": None, "notes": notes, "epsg": None}


@njit(cache=True)
def _chamfer(source):
    """Two-pass chamfer (3-4) distance in cells to the nearest source cell."""
    h, w = source.shape
    INF = 1e9
    d = np.where(source, 0.0, INF)
    for r in range(h):
        for c in range(w):
            v = d[r, c]
            if c > 0:
                v = min(v, d[r, c - 1] + 3)
            if r > 0:
                v = min(v, d[r - 1, c] + 3)
                if c > 0:
                    v = min(v, d[r - 1, c - 1] + 4)
                if c < w - 1:
                    v = min(v, d[r - 1, c + 1] + 4)
            d[r, c] = v
    for r in range(h - 1, -1, -1):
        for c in range(w - 1, -1, -1):
            v = d[r, c]
            if c < w - 1:
                v = min(v, d[r, c + 1] + 3)
            if r < h - 1:
                v = min(v, d[r + 1, c] + 3)
                if c < w - 1:
                    v = min(v, d[r + 1, c + 1] + 4)
                if c > 0:
                    v = min(v, d[r + 1, c - 1] + 4)
            d[r, c] = v
    return d / 3


def normalised_residuals(a: np.ndarray, b: np.ndarray, valid: np.ndarray) -> np.ndarray:
    af, bf = a.ravel().astype(np.float64), b.ravel().astype(np.float64)
    vf = valid.ravel()
    use = vf.copy()
    gain, offset, sigma = 1.0, 0.0, 1.0
    stride = 3 if af.size > 60_000 else 1
    sample_idx = np.arange(0, af.size, stride)
    sample_idx = sample_idx[vf[sample_idx]]
    for _ in range(4):
        n = int(use.sum())
        if n < 10:
            break
        x, y = af[use], bf[use]
        vx = float((x * x).sum() - x.sum() ** 2 / n)
        gain = float((x * y).sum() - x.sum() * y.sum() / n) / vx if vx > 1e-9 else 1.0
        offset = float(y.sum() - gain * x.sum()) / n
        res = bf[sample_idx] - gain * af[sample_idx] - offset
        med = float(np.median(res))
        sigma = max(1e-6, float(np.median(np.abs(res - med))) * 1.4826)
        use = vf & (np.abs(bf - gain * af - offset - med) < 2.5 * sigma)
    rng = float(bf[vf].max() - bf[vf].min()) if vf.any() else 0.0
    sd = max(sigma, rng * 0.01, 1e-6)  # a floor keeps near-noiseless images from flagging tiny differences
    return np.where(vf, (bf - gain * af - offset) / sd, 0).reshape(a.shape)


def _exg(layer) -> np.ndarray:
    r, g, b = (x.astype(np.float64) for x in layer["rgb"])
    t = r + g + b
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(t > 0, (2 * g - r - b) / np.where(t > 0, t, 1), 0)


def compare_layers(stack: dict, i_from: int, i_to: int, p: dict) -> dict:
    p = {**DEFAULT_PARAMS, **p}
    prop = stack["property"]
    h, w = prop.shape
    A, B = stack["layers"][i_from], stack["layers"][i_to]
    valid = np.all(np.isfinite(np.stack([*A["rgb"], *B["rgb"]])), axis=0)
    res = [normalised_residuals(A["rgb"][k], B["rgb"][k], valid) for k in range(3)]
    mag = np.where(valid, np.sqrt((res[0] ** 2 + res[1] ** 2 + res[2] ** 2) / 3), 0)
    flat_valid = valid.ravel()
    n = h * w
    take = (np.arange(n) % 3 == 0) | (n < 30_000)
    sample = mag.ravel()[flat_valid & take]
    med = float(np.median(sample))
    mad = float(np.median(np.abs(sample - med))) * 1.4826
    threshold = max(2.5, med + p["sensitivity"] * max(mad, 0.25))
    changed = valid & (mag > threshold)
    unit = stack["cellM"] ** 2 if stack["cellM"] else 1.0
    len_unit = stack["cellM"] or 1.0
    depth = _chamfer(np.ascontiguousarray(~prop))
    strip = p["stripWidth"] / len_unit
    r = round(p["gap"] / len_unit / 2)
    bridged = ndimage.binary_dilation(changed, structure=np.ones((2 * r + 1, 2 * r + 1), bool)) if r > 0 else changed
    labels, nb = label_patches(bridged)
    lab_c = np.where(changed, labels, 0)
    dexg = _exg(B) - _exg(A)
    ids = np.arange(nb + 1)
    cells = np.bincount(lab_c.ravel(), minlength=nb + 1)
    inside = np.bincount(lab_c[prop].ravel(), minlength=nb + 1)
    outside = cells - inside
    max_depth = np.zeros(nb + 1)
    np.maximum.at(max_depth, lab_c[prop & changed], depth[prop & changed])
    touches = np.zeros(nb + 1, bool)
    touches[np.unique(lab_c[prop & changed & (depth <= 1.01)])] = True
    dsum = np.bincount(lab_c.ravel(), weights=dexg.ravel(), minlength=nb + 1)
    rows, cols = np.indices((h, w))
    sc = np.bincount(lab_c.ravel(), weights=cols.ravel(), minlength=nb + 1)
    sr = np.bincount(lab_c.ravel(), weights=rows.ravel(), minlength=nb + 1)
    raw, nr = label_patches(changed)
    raw_in = prop & (raw > 0)
    rmin = np.full(nr + 1, np.inf)
    rmax = np.zeros(nr + 1)
    rins = np.bincount(raw[raw_in], minlength=nr + 1)
    np.minimum.at(rmin, raw[raw_in], depth[raw_in])
    np.maximum.at(rmax, raw[raw_in], depth[raw_in])
    line_reach = p["gap"] / len_unit + 1
    reach_ok = rmin <= line_reach
    pair = raw_in & reach_ok[raw] & (labels > 0)
    reach_depth = np.zeros(nb + 1)
    reach_inside = np.zeros(nb + 1)
    has_reach = np.zeros(nb + 1, bool)
    if pair.any():
        pairs = np.unique(np.stack([labels[pair], raw[pair]], axis=1), axis=0)
        for bid, rid in pairs:
            has_reach[bid] = True
            reach_depth[bid] = max(reach_depth[bid], rmax[rid])
            reach_inside[bid] += rins[rid]
    patches = []
    zone_of = {}
    for i in ids[1:]:
        if not cells[i] or cells[i] * unit < p["minArea"]:
            continue
        reach = has_reach[i]
        md = max_depth[i]
        if inside[i] and outside[i] and reach:
            zone = "alignment" if reach_depth[i] * len_unit <= p["tolerance"] + 1e-9 else "crossing"
            md = reach_depth[i]
        elif inside[i]:
            zone = "edge" if md <= strip + 1e-9 or touches[i] else "inside"
        else:
            zone = "outside"
        crossing_like = zone in ("crossing", "alignment")
        zone_of[int(i)] = zone
        mean = dsum[i] / cells[i]
        patches.append({
            "id": int(i), "zone": zone, "cells": int(cells[i]), "area": float(cells[i] * unit),
            "areaInside": float((reach_inside[i] if crossing_like else inside[i]) * unit),
            "areaJoinedInside": float((inside[i] - reach_inside[i]) * unit) if crossing_like else 0.0,
            "depthInside": 0.0 if zone == "outside" else float(md * len_unit),
            "kind": "vegetation loss" if mean < -0.04 else "vegetation gain" if mean > 0.04 else "surface change",
            "centroid": [float(sc[i] / cells[i]), float(sr[i] / cells[i])],
        })
    classes = np.zeros((h, w), dtype=np.uint8)
    by_zone = {z: 0.0 for z in ZONES}
    code_lut = np.zeros(nb + 1, dtype=np.uint8)
    for i, z in zone_of.items():
        code_lut[i] = ZONE_CODE[z]
    classes = np.where(changed, code_lut[labels], 0).astype(np.uint8)
    for z, c in ZONE_CODE.items():
        by_zone[z] = float((classes == c).sum() * unit)
    changed_inside = float(((classes > 0) & prop).sum() * unit)
    patches.sort(key=lambda x: (ZONE_ORDER.index(x["zone"]), -x["areaInside"]))
    return {"from": A["label"], "to": B["label"], "threshold": threshold, "changedInside": changed_inside, "propertyArea": float(prop.sum() * unit),
            "byZone": by_zone, "patches": patches, "classes": classes}


def _date_suffix(layer: dict) -> str:
    return f" ({layer['date']})" if layer.get("date") else ""


def area_text(v: float, stack: dict) -> str:
    if not stack["cellM"]:
        return f"{round(v):,} px"
    return f"{fmt(v / 10_000, 4)} ha" if v >= 10_000 else f"{fmt(v, 4)} m²"


def _len_text(v: float, stack: dict) -> str:
    return f"{fmt(v, 3)} m" if stack["cellM"] else f"{fmt(v, 3)} px"


def encroachment_markdown(stack: dict, cmp: dict, timeline: list[dict], p: dict) -> str:
    p = {**DEFAULT_PARAMS, **p}
    at = lambda v: area_text(v, stack)
    crossing = [x for x in cmp["patches"] if x["zone"] == "crossing"]
    edge = [x for x in cmp["patches"] if x["zone"] == "edge"]
    share = f"{cmp['changedInside'] / cmp['propertyArea'] * 100:.1f}" if cmp["propertyArea"] else "—"
    lines = ["## Dataset", "", *[f"- Image {i + 1}: {l['label']}{_date_suffix(l)}" for i, l in enumerate(stack["layers"])],
             f"- Property area on the grid: {at(cmp['propertyArea'])}", "", "## Results", "", f"Comparison: **{cmp['from']} → {cmp['to']}**.", "",
             "| Measure | Value |", "|---|---|", f"| Changed area inside the property | {at(cmp['changedInside'])} ({share} %) |",
             f"| Patches crossing the boundary | {len(crossing)} ({at(sum(x['areaInside'] for x in crossing))} of them inside) |",
             f"| Change along the inside edge ({_len_text(p['stripWidth'], stack)} strip) | {at(cmp['byZone']['edge'])} in {len(edge)} patch{'' if len(edge) == 1 else 'es'} |",
             f"| Thin strips along the line (≤ {_len_text(p['tolerance'], stack)}, likely misalignment) | {at(cmp['byZone']['alignment'])} |",
             f"| Change elsewhere inside | {at(cmp['byZone']['inside'])} |", f"| Change outside (context) | {at(cmp['byZone']['outside'])} |", ""]
    if crossing:
        lines += ["### Possible encroachment (patches crossing the boundary)", "",
                  "| Patch | Area inside (touching the line) | Joined change further inside | Total area | Depth into the property | Type |", "|---|---|---|---|---|---|",
                  *[f"| {i + 1} | {at(x['areaInside'])} | {at(x['areaJoinedInside'])} | {at(x['area'])} | {_len_text(x['depthInside'], stack)} | {x['kind']} |" for i, x in enumerate(crossing[:20])], "",
                  "Joined change further inside is change within the gap distance of the crossing patch that does not itself touch the line: for example, the newly built part of an older encroachment, or an unrelated change next to it. Inspect it on the images.", ""]
    else:
        lines += ["No changed patch crosses the boundary line at these settings.", ""]
    if len(timeline) > 1:
        lines += ["### Timeline (each image compared with the current one)", "", "| From | Changed inside | Crossing patches, inside part (touching the line + joined) |", "|---|---|---|"]
        for t in timeline:
            cr = [x for x in t["patches"] if x["zone"] == "crossing"]
            lines.append(f"| {t['from']} | {at(t['changedInside'])} | {at(sum(x['areaInside'] for x in cr))} + {at(sum(x['areaJoinedInside'] for x in cr))} |")
        lines.append("")
    lines += ["## Method and limits", "", *[f"- {n}" for n in stack["notes"]],
              f"- Each band of the later image was normalised to the earlier one by a linear fit refitted on unchanged-looking pixels (pseudo-invariant features); change magnitude is the RMS of the robustly standardised residuals. Changed = magnitude above {fmt(cmp['threshold'], 3)} (median + {p['sensitivity']:g} × robust SD, at least 2.5); patches under {at(p['minArea'])} were ignored.",
              f"- Changes closer than {_len_text(p['gap'], stack)} were joined, so an unchanged fence or wall does not split a structure that spans it. Crossing changes that reach no deeper than {_len_text(p['tolerance'], stack)} into the plot are reported separately as likely misalignment.",
              '- "Crosses the boundary" means one changed patch is continuous across the line, as when a neighbouring roof, wall, fence or cultivated field extends onto the plot. It is a pattern in the imagery, not proof of encroachment.',
              "- Misregistration between images (often 1–5 m for free imagery), shadows, parked vehicles, crops, seasons and roof-top views of tall buildings all create change. Check each flagged patch on the images.",
              "- Use the boundary from a registered survey or the official land record; a hand-traced or GPS-walked outline carries its own error of several metres. For legal matters, get a licensed surveyor’s demarcation."]
    return "\n".join(lines)


def layer_rgba(stack: dict, i: int, outline: bool) -> np.ndarray:
    """One 1–99 % stretch shared by the three bands, with the property outline drawn in."""
    bands = stack["layers"][i]["rgb"]
    h, w = bands[0].shape
    step = max(1, (h * w) // 30000)
    vals = np.sort(np.concatenate([b.ravel()[::step] for b in bands]))
    vals = vals[np.isfinite(vals)]
    lo, hi = (vals[int(len(vals) * 0.01)], vals[int(len(vals) * 0.99)]) if vals.size else (0.0, 1.0)
    out = np.zeros((h, w, 4), dtype=np.uint8)
    ok = np.isfinite(bands[0])
    for c in range(3):
        out[..., c] = np.clip(np.round(np.nan_to_num((bands[c] - lo) / ((hi - lo) or 1)) * 255), 0, 255)
    out[..., 3] = np.where(ok, 255, 0)
    if outline:
        prop = stack["property"]
        pad = np.pad(prop, 1, constant_values=False)
        edge = prop & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
        out[edge] = [255, 214, 0, 255]
    return out


def change_rgba(classes: np.ndarray, zones: list[str]) -> np.ndarray:
    out = np.zeros((*classes.shape, 4), dtype=np.uint8)
    for z in zones:
        m = classes == ZONE_CODE[z]
        out[m, :3] = ZONES[z]["color"]
        out[m, 3] = 200
    return out


def change_polygons(stack: dict, cmp: dict) -> dict | None:
    """Crossing and inside-edge change patches as WGS84 polygons (georeferenced stacks only)."""
    if not stack.get("grid"):
        return None
    labels, n = label_patches((cmp["classes"] == 1) | (cmp["classes"] == 2))
    area = patch_areas(labels, n, np.full(stack["height"], (stack["cellM"] or 1) ** 2))
    return patches_to_geojson(labels, n, area, stack["grid"], lambda i, a: {"patch": i, "area_m2": round(a * 100) / 100, "note": "change crossing or along the inside of the property boundary"})


def stack_bounds(stack: dict) -> list[list[float]] | None:
    if not stack.get("grid"):
        return None
    x0, y0, x1, y1 = stack["grid"].meta.bbox
    tr = Transformer.from_crs(stack["epsg"], 4326, always_xy=True)
    cs = [tr.transform(x, y) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    return [[min(c[1] for c in cs), min(c[0] for c in cs)], [max(c[1] for c in cs), max(c[0] for c in cs)]]
