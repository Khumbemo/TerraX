"""Connected patches (8-connected), minimum mapping unit and patch polygons."""

from __future__ import annotations

import numpy as np
from rasterio.features import shapes
from rasterio.warp import transform_geom
from scipy import ndimage
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.geometry.polygon import orient

EIGHT = np.ones((3, 3), dtype=int)


def label_patches(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """8-connected component labels (0 outside, 1..n patch ids in raster-scan order)."""
    labels, n = ndimage.label(mask, structure=EIGHT)
    return labels.astype(np.int32), int(n)


def patch_areas(labels: np.ndarray, n: int, cell_area_rows: np.ndarray) -> np.ndarray:
    """Area per patch id (index 0 unused), same unit as the row cell areas."""
    w = np.broadcast_to(cell_area_rows[:, None], labels.shape)
    return np.bincount(labels.ravel(), weights=w.ravel(), minlength=n + 1)


def apply_mmu(classes: np.ndarray, is_target: np.ndarray, replace_with: int, mmu: float, cell_area_rows: np.ndarray) -> dict:
    """Patches of target cells smaller than `mmu` become `replace_with` (in place)."""
    labels, n = label_patches(is_target)
    area = patch_areas(labels, n, cell_area_rows)
    small = area < mmu
    small[0] = False
    removed_mask = small[labels]
    classes[removed_mask] = replace_with
    kept_ids = np.flatnonzero(~small)[1:] if n else np.array([], dtype=int)
    kept_area = area[kept_ids] if kept_ids.size else np.array([])
    return {
        "removedPatches": int(small.sum()),
        "removedMask": removed_mask,
        "keptCount": int(kept_ids.size),
        "keptLargest": float(kept_area.max()) if kept_area.size else 0.0,
    }


def patches_to_geojson(labels: np.ndarray, n: int, area: np.ndarray, raster, props, max_patches: int = 5000) -> dict | None:
    """One WGS84 MultiPolygon per patch (largest first, at most `max_patches`).

    Rings follow RFC 7946 (outer rings counter-clockwise). Pixels that only touch
    diagonally become separate polygons of the same patch.
    """
    meta = raster.meta
    if not meta.bbox or (not meta.geographic and raster.crs is None):
        return None
    ids = sorted(range(1, n + 1), key=lambda i: -area[i])[:max_patches]
    keep = np.zeros(n + 1, dtype=bool)
    keep[ids] = True
    lab = np.where(keep[labels], labels, 0).astype(np.int32)
    parts: dict[int, list] = {}
    for geom, value in shapes(lab, mask=lab > 0, connectivity=4, transform=raster.transform):
        parts.setdefault(int(value), []).append(shape(geom))
    features = []
    for i in ids:
        polys = parts.get(i, [])
        if not polys:
            continue
        mp = MultiPolygon(polys)
        g = mapping(mp)
        if not meta.geographic:
            g = transform_geom(raster.crs, "EPSG:4326", g)
        geom = shape(g)
        geoms = getattr(geom, "geoms", [geom])
        mp = MultiPolygon([orient(p, sign=1.0) for p in geoms])
        coords = [[[[round(x, 7), round(y, 7)] for x, y in ring.coords] for ring in [p.exterior, *p.interiors]] for p in mp.geoms]
        features.append({"type": "Feature", "properties": props(i, float(area[i])), "geometry": {"type": "MultiPolygon", "coordinates": coords}})
    return {"fc": {"type": "FeatureCollection", "features": features}, "truncated": max(0, n - max_patches)}
