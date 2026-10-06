"""Spectral indices with their published definitions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np

from .rio import Grid, Raster
from .stats import quantile_sorted

BAND_ROLES = [
    {"role": "blue", "label": "Blue", "s2": "B2", "l8": "B2"},
    {"role": "green", "label": "Green", "s2": "B3", "l8": "B3"},
    {"role": "red", "label": "Red", "s2": "B4", "l8": "B4"},
    {"role": "nir", "label": "NIR", "s2": "B8", "l8": "B5"},
    {"role": "swir1", "label": "SWIR 1", "s2": "B11", "l8": "B6"},
    {"role": "swir2", "label": "SWIR 2", "s2": "B12", "l8": "B7"},
]


def _nd(a, b):
    with np.errstate(divide="ignore", invalid="ignore"):
        s = a + b
        return np.where(s == 0, np.nan, (a - b) / np.where(s == 0, 1, s))


def _ratio(num, den):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den == 0, np.nan, num / np.where(den == 0, 1, den))


@dataclass(frozen=True)
class IndexDef:
    id: str
    name: str
    formula: str
    reference: str
    needs: tuple[str, ...]
    needs_reflectance: bool
    reading: str
    compute: Callable[[dict], np.ndarray]

    @property
    def short(self) -> str:
        return self.name.split(" —")[0]

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "formula": self.formula, "reference": self.reference, "needs": list(self.needs), "needsReflectance": self.needs_reflectance, "reading": self.reading}


INDICES = [
    IndexDef("ndvi", "NDVI — vegetation", "(NIR − Red) / (NIR + Red)", "Rouse et al. (1974)", ("nir", "red"), False,
             "Higher values mean denser, greener vegetation; water and bare surfaces are near or below 0.", lambda b: _nd(b["nir"], b["red"])),
    IndexDef("evi", "EVI — vegetation (less saturation)", "2.5 (NIR − Red) / (NIR + 6 Red − 7.5 Blue + 1)", "Huete et al. (2002)", ("nir", "red", "blue"), True,
             "Like NDVI but less saturated over dense canopy; typical vegetated range 0.2–0.8.",
             lambda b: _ratio(2.5 * (b["nir"] - b["red"]), b["nir"] + 6 * b["red"] - 7.5 * b["blue"] + 1)),
    IndexDef("savi", "SAVI — vegetation on bright soil", "1.5 (NIR − Red) / (NIR + Red + 0.5)", "Huete (1988), L = 0.5", ("nir", "red"), True,
             "Reduces soil-brightness effects where vegetation cover is sparse.", lambda b: _ratio(1.5 * (b["nir"] - b["red"]), b["nir"] + b["red"] + 0.5)),
    IndexDef("ndwi", "NDWI — open water", "(Green − NIR) / (Green + NIR)", "McFeeters (1996)", ("green", "nir"), False,
             "Positive values usually indicate open water.", lambda b: _nd(b["green"], b["nir"])),
    IndexDef("ndmi", "NDMI — vegetation moisture", "(NIR − SWIR1) / (NIR + SWIR1)", "Gao (1996)", ("nir", "swir1"), False,
             "Higher values mean more water in the canopy; low values indicate water stress.", lambda b: _nd(b["nir"], b["swir1"])),
    IndexDef("nbr", "NBR — burn severity", "(NIR − SWIR2) / (NIR + SWIR2)", "Key & Benson (2006)", ("nir", "swir2"), False,
             "Healthy vegetation is high; recently burned areas are low. Compare dates (dNBR) to map burn severity.", lambda b: _nd(b["nir"], b["swir2"])),
    IndexDef("ndbi", "NDBI — built-up areas", "(SWIR1 − NIR) / (SWIR1 + NIR)", "Zha et al. (2003)", ("swir1", "nir"), False,
             "Positive values often indicate built-up or bare surfaces.", lambda b: _nd(b["swir1"], b["nir"])),
]
BY_ID = {d.id: d for d in INDICES}


def index_def(i: str) -> IndexDef:
    if i not in BY_ID:
        raise ValueError(f"Unknown spectral index “{i}”.")
    return BY_ID[i]


def missing_bands(i: str, bands: dict) -> list[str]:
    return [r for r in index_def(i).needs if bands.get(r) is None]


def guess_band_map(n: int) -> dict:
    """Band roles guessed from the band count for common export orders (always confirmed by the user)."""
    if n == 2:
        return {"red": 0, "nir": 1}
    if n in (4, 5):
        return {"blue": 0, "green": 1, "red": 2, "nir": 3}
    if n >= 6:
        return {"blue": 0, "green": 1, "red": 2, "nir": 3, "swir1": 4, "swir2": 5}
    if n == 3:
        return {"red": 0, "green": 1, "blue": 2}
    return {}


def looks_scaled(g: Grid) -> bool:
    """Median of valid values above 1.5: reflectance scaled by 10,000."""
    flat = g.data.ravel()
    step = max(1, flat.size // 20000)
    s = flat[::step]
    s = np.sort(s[np.isfinite(s)])
    return s.size > 0 and quantile_sorted(s, 0.5) > 1.5


def compute_index_grid(raster: Raster, index: str, bands: dict) -> tuple[Grid, list[str]]:
    d = index_def(index)
    miss = missing_bands(index, bands)
    if miss:
        raise ValueError(f"{d.short} needs these bands assigned: {', '.join(miss)}.")
    idx = [int(bands[r]) for r in d.needs]
    if len(set(idx)) != len(idx):
        raise ValueError("Assign a different band to each role.")
    grids = raster.read_bands(idx)
    notes: list[str] = []
    scale = 1.0
    if d.needs_reflectance and any(looks_scaled(g) for g in grids):
        scale = 1 / 10000
        notes.append(f"{d.short} uses absolute reflectance; band values look scaled by 10,000 (as in Sentinel-2 L2A from Earth Engine) and were divided by 10,000. Raw ESA L2A files from 2022 onward also need the −1000 offset removed first.")
    b = {r: g.data.astype(np.float64) * scale for r, g in zip(d.needs, grids)}
    with np.errstate(all="ignore"):
        out = d.compute(b)
    out = np.where(np.isfinite(out), out, np.nan).astype(np.float32)
    band_text = ", ".join(f"band {i + 1} = {r.upper()}" for r, i in zip(d.needs, idx))
    notes.insert(0, f"{d.short} = {d.formula} ({d.reference}); {band_text}. {d.reading}")
    g0 = grids[0]
    return Grid(g0.width, g0.height, out, g0.resample_factor), notes
