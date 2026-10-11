"""Full-resolution processing of large rasters in horizontal strips.

A raster is split into strips of whole analysis-grid rows (about
TILE_PIXELS cells each). Strips are read and processed on several threads
(GDAL reads and NumPy array maths release the GIL), so memory grows with the
strips in flight rather than with the raster: tools keep only small per-cell
results (a uint8 class map) and running totals for the whole grid.

Strips give the same numbers as one whole-grid pass: reads and boundary
masks are exact per row, and cell areas depend only on the row.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import TypeVar

import numpy as np

from ..config import settings
from .rio import Ground, Raster, ground_geometry
from .zonal import boundary_in_crs, no_overlap, rows_mask

#: Target cells per strip: large enough for fast vectorised maths, small enough
#: that a few strips of several float64 arrays stay in the low hundreds of MB.
TILE_PIXELS = 4_000_000

T = TypeVar("T")


@dataclass
class Strip:
    """Rows r0..r1 (exclusive) of the analysis grid."""

    r0: int
    r1: int
    inside: np.ndarray | None  # (rows, width) boundary mask; None when there is no boundary
    area: np.ndarray | None  # (rows,) cell area in m²; None when the CRS has no ground units

    @property
    def rows(self) -> slice:
        return slice(self.r0, self.r1)


class StripPlan:
    """How one raster is cut into strips, with its boundary and ground geometry."""

    def __init__(self, raster: Raster, boundary: dict | None = None, tile_pixels: int | None = None, threads: int | None = None):
        self.raster = raster
        self.width, self.height = raster.gw, raster.gh
        step = max(1, (tile_pixels or TILE_PIXELS) // max(1, self.width))
        self.bounds = [(r, min(self.height, r + step)) for r in range(0, self.height, step)]
        self.geo: Ground | None = ground_geometry(raster.meta, self.width, self.height)
        self.boundary = boundary
        self._geoms = boundary_in_crs(raster, boundary) if boundary else None
        self.threads = threads or settings().tile_threads

    def strip(self, r0: int, r1: int) -> Strip:
        inside = rows_mask(self.raster, self._geoms, r0, r1) if self._geoms else None
        return Strip(r0, r1, inside, self.geo.cell_area[r0:r1] if self.geo else None)

    def map(self, fn: Callable[[Strip], T]) -> list[T]:
        """fn on every strip, in order; strips run on up to `threads` threads."""
        work = lambda b: fn(self.strip(*b))
        if self.threads <= 1 or len(self.bounds) == 1:
            return [work(b) for b in self.bounds]
        with ThreadPoolExecutor(max_workers=self.threads, thread_name_prefix="terrax-strip") as pool:
            return list(pool.map(work, self.bounds))

    def check_overlap(self, inside_cells: int) -> None:
        if self.boundary and not inside_cells:
            raise no_overlap(self.boundary, self.raster)

    def row_blocks(self) -> Iterator[slice]:
        for r0, r1 in self.bounds:
            yield slice(r0, r1)


def class_totals(classes: np.ndarray, area_rows: np.ndarray | None, n_classes: int, blocks: Iterator[slice]) -> tuple[np.ndarray, np.ndarray | None]:
    """Cells and area (m²) per class code 0..n_classes-1 of a class map, counted block by block."""
    counts = np.zeros(n_classes, dtype=np.int64)
    areas = np.zeros(n_classes) if area_rows is not None else None
    w = classes.shape[1]
    for b in blocks:
        c = classes[b].ravel()
        counts += np.bincount(c, minlength=n_classes)[:n_classes]
        if areas is not None and area_rows is not None:
            areas += np.bincount(c, weights=np.repeat(area_rows[b], w), minlength=n_classes)[:n_classes]
    return counts, areas
