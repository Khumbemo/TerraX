"""Forest at the start, from a map closer to the FAO definition than an NDVI threshold.

FAO (Global Forest Resources Assessment) defines forest as land of more than 0.5 ha with trees taller than 5 m and a
canopy cover of more than 10 %. An NDVI threshold only measures greenness, so dense crops and grass pass as forest
and open woodland does not. With one of these maps, forest is decided per pixel of the analysis grid:

* **cover**: a tree-cover map in % (Hansen treecover2000, Copernicus tree cover density …), averaged onto the
  grid: forest where cover ≥ `minCover` (10 %).
* **height**: a canopy height model in metres, usually much finer than the image: the share of its cells at least
  `minHeight` (5 m) tall within each pixel is the canopy cover, and forest is cover ≥ `minCover` (10 %). This counts
  tall-tree cover, as the definition does, rather than averaging heights.
* **classes**: a class map (TerraX land cover, ESA WorldCover …): forest is the class values given, the most common
  class within each pixel (mode).

Then forest patches smaller than `minHa` (0.5 ha) are dropped. Pixels the map does not cover are left out of the
analysis rather than counted as non-forest. Land use is not part of any of these maps (an orchard is "forest").
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .patches import label_patches, patch_areas
from .rio import Ground, Raster
from .stats import fmt

FAO_COVER = 10.0
FAO_HEIGHT = 5.0
FAO_MIN_HA = 0.5


@dataclass
class Baseline:
    forest: np.ndarray  # bool, analysis grid
    known: np.ndarray  # bool: the map covers this pixel
    rule: str  # one line for tables ("tree cover ≥ 10 %")
    notes: list[str]


def _warp(path, band: int, target: Raster, resampling, data: np.ndarray | None = None, src_transform=None, src_crs=None) -> np.ndarray:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.warp import reproject

    out = np.full((target.gh, target.gw), np.nan, dtype=np.float32)
    dst = {"dst_transform": target.transform, "dst_crs": CRS.from_wkt(target.meta.crs_wkt or ""), "dst_nodata": np.nan, "resampling": resampling}
    if data is not None:
        reproject(data, out, src_transform=src_transform, src_crs=src_crs, src_nodata=np.nan, **dst)
        return out
    with rasterio.open(path) as ds:
        if ds.crs is None:
            raise ValueError(f"{path.name} has no coordinate reference system, so it cannot be laid over the image.")
        reproject(rasterio.band(ds, band), out, src_nodata=ds.nodata, **dst)
    return out


def forest_baseline(src: Raster, kind: str, target: Raster, geo: Ground | None, *, min_cover: float = FAO_COVER,
                    min_height: float = FAO_HEIGHT, classes: list[float] | None = None, min_ha: float = FAO_MIN_HA) -> Baseline:
    from rasterio.enums import Resampling

    if target.meta.crs_wkt is None or target.transform is None:
        raise ValueError("The image needs a known coordinate reference system to be combined with a forest map.")
    name = src.meta.filename
    notes: list[str] = []
    if kind == "cover":
        cover = _warp(src.path, 1, target, Resampling.average)
        finite = cover[np.isfinite(cover)]
        if finite.size and float(np.nanpercentile(finite, 99)) <= 1.0:
            cover = cover * 100  # given as a fraction
            notes.append(f"{name} holds tree cover as a fraction (0–1); read as percent.")
        known = np.isfinite(cover)
        with np.errstate(invalid="ignore"):
            forest = known & (cover >= min_cover)
        rule = f"tree cover ≥ {fmt(min_cover, 3)} %"
        notes.append(f"Forest at the start: tree cover ≥ {fmt(min_cover, 3)} % in {name}, averaged onto the image grid. "
                     "A tree-cover map's own date (Hansen treecover2000 is the year 2000) may differ from the earlier image's.")
    elif kind == "height":
        import rasterio

        from ..config import settings

        with rasterio.open(src.path) as ds:
            if ds.crs is None:
                raise ValueError(f"{name} has no coordinate reference system, so it cannot be laid over the image.")
            scale = min(1.0, (settings().max_pixels / max(1, ds.width * ds.height)) ** 0.5)
            w, h = max(1, round(ds.width * scale)), max(1, round(ds.height * scale))
            chm = ds.read(1, out_shape=(h, w), resampling=Resampling.average, masked=True).astype(np.float32).filled(np.nan)
            transform = ds.transform @ ds.transform.scale(ds.width / w, ds.height / h)
            crs = ds.crs
        tall = np.where(np.isfinite(chm), (chm >= min_height).astype(np.float32), np.nan)
        cover = _warp(None, 1, target, Resampling.average, data=tall, src_transform=transform, src_crs=crs) * 100
        known = np.isfinite(cover)
        with np.errstate(invalid="ignore"):
            forest = known & (cover >= min_cover)
        rule = f"cover of trees ≥ {fmt(min_height, 3)} m ≥ {fmt(min_cover, 3)} %"
        notes.append(f"Forest at the start: in each image pixel, at least {fmt(min_cover, 3)} % of {name}'s cells are {fmt(min_height, 3)} m tall or more "
                     "(the canopy cover of trees, as in the FAO definition).")
        if scale < 1:
            notes.append(f"{name} was read at {w}×{h} cells (averaged) to stay within TERRAX_MAX_PIXELS, which smooths the tallest crowns.")
    elif kind == "classes":
        if not classes:
            raise ValueError("Name the forest classes of the class map (their values, for example 10 for ESA WorldCover tree cover).")
        values = _warp(src.path, 1, target, Resampling.mode)
        known = np.isfinite(values)
        forest = known & np.isin(values, np.asarray(classes, dtype=np.float32))
        shown = ", ".join(fmt(c, 6) for c in classes)
        rule = f"class {shown} in the class map"
        notes.append(f"Forest at the start: class value{'s' if len(classes) > 1 else ''} {shown} of {name} (the most common class within each image pixel). "
                     "A class map is only as good as its own accuracy; its date may differ from the earlier image's.")
    else:
        raise ValueError("Choose a forest map kind: cover (tree cover %), height (canopy height model) or classes (a class map).")
    if not known.any():
        raise ValueError(f"{name} does not overlap the images.")
    if min_ha > 0 and geo is not None:
        labels, n = label_patches(forest)
        if n:
            small = patch_areas(labels, n, geo.cell_area) / 1e4 < min_ha
            small[0] = False
            removed = int(small[1:].sum())
            forest = forest & ~small[labels]
            if removed:
                notes.append(f"{removed:,} forest patches smaller than {fmt(min_ha, 3)} ha (the FAO minimum area) were not counted as forest.")
    share = float(known.mean() * 100)
    if share < 99.5:
        notes.append(f"{name} covers {fmt(share, 3)} % of the image; pixels it does not cover are left out of the analysis.")
    return Baseline(forest, known, rule, notes)
