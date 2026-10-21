"""Raster access for the tools: metadata, band reads on a common analysis grid
(no-data → NaN), WGS84 footprint and ground geometry (pixel area and spacing in
metres) so areas and slopes are computed in real units."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds
from rasterio.windows import Window

from ..config import settings

#: Mean radius of the WGS84 authalic sphere (equal-area), metres.
R_AUTHALIC = 6371007.1809
RAD = math.pi / 180
WGS84_E2 = 0.00669437999014
WGS84_E = math.sqrt(WGS84_E2)


def _q(sin_phi):
    es = WGS84_E * sin_phi
    return (1 - WGS84_E2) * (sin_phi / (1 - es * es) - (1 / (2 * WGS84_E)) * np.log((1 - es) / (1 + es)))


Q_POLE = float(_q(1.0))


def sin_authalic(lat_deg):
    """sin β (authalic latitude) for geodetic latitude φ (Snyder 1987, eqs. 3-11/3-12)."""
    return _q(np.sin(np.asarray(lat_deg) * RAD)) / Q_POLE


@dataclass
class Meta:
    filename: str
    size_bytes: int
    width: int
    height: int
    bands: int
    nodata: float | None
    bbox: tuple[float, float, float, float] | None
    epsg: int | None
    geographic: bool
    crs_wkt: str | None
    #: [[south, west], [north, east]]
    latlng_bounds: list[list[float]] | None
    pixel_size: tuple[float, float] | None
    band_names: list[str]
    dtype: str
    warnings: list[str] = field(default_factory=list)

    def public(self) -> dict:
        return {
            "filename": self.filename, "sizeBytes": self.size_bytes, "width": self.width, "height": self.height, "bands": self.bands,
            "noData": self.nodata, "bbox": self.bbox, "epsg": self.epsg, "geographic": self.geographic, "latLngBounds": self.latlng_bounds,
            "pixelSize": self.pixel_size, "bandNames": self.band_names, "dtype": self.dtype, "warnings": self.warnings,
        }


@dataclass
class Grid:
    width: int
    height: int
    data: np.ndarray  # float32 (height, width), NaN = no data
    resample_factor: float


class Raster:
    """An opened GeoTIFF read onto one analysis grid of at most `max_pixels` cells.

    Tools that hold the whole grid in memory use the default budget
    (TERRAX_GRID_PIXELS); tools that work in strips pass the larger
    full-resolution budget (TERRAX_MAX_PIXELS) and read with `read_rows`.
    """

    def __init__(self, path: Path, filename: str | None = None, max_pixels: int | None = None):
        self.path = Path(path)
        limit = max_pixels or settings().grid_pixels
        with rasterio.open(self.path) as ds:
            warnings: list[str] = []
            bbox = pixel = None
            georef = ds.transform is not None and not ds.transform.is_identity
            if georef:
                b = ds.bounds
                bbox = (b.left, b.bottom, b.right, b.top)
                pixel = (abs(ds.transform.a), abs(ds.transform.e))
            else:
                warnings.append("The file has no georeferencing, so it cannot be placed on the map or measured in real units.")
            crs = ds.crs
            epsg = crs.to_epsg() if crs else None
            geographic = bool(crs and crs.is_geographic) or (crs is None and bbox is not None and _looks_geographic(bbox))
            latlng = None
            if bbox:
                try:
                    if geographic:
                        if epsg not in (4326, None):
                            warnings.append(f"Geographic CRS EPSG:{epsg} was treated as WGS84 (offset is usually under a few metres).")
                        if bbox[0] < -180.001 or bbox[2] > 180.001 or bbox[1] < -90.001 or bbox[3] > 90.001:
                            raise ValueError("outside the globe")
                        latlng = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]]
                    elif crs is not None:
                        w, s, e, n = transform_bounds(crs, "EPSG:4326", *bbox, densify_pts=21)
                        latlng = [[s, w], [n, e]]
                    else:
                        warnings.append("The file declares no coordinate reference system, so its footprint cannot be drawn on the map.")
                except Exception:  # any CRS failure only loses the footprint
                    warnings.append(f"EPSG:{epsg} could not be converted to WGS84 for the map footprint." if epsg else "The file uses a custom projection that could not be converted to WGS84 for the map footprint.")
            total = ds.width * ds.height
            scale = math.sqrt(limit / total) if total > limit else 1.0
            self.gw = max(1, round(ds.width * scale))
            self.gh = max(1, round(ds.height * scale))
            if scale < 1:
                warnings.append(f"The {ds.width}×{ds.height} raster was resampled to {self.gw}×{self.gh} (nearest neighbour) for analysis.")
            self.crs = crs
            self.meta = Meta(
                filename=filename or self.path.name, size_bytes=self.path.stat().st_size, width=ds.width, height=ds.height, bands=ds.count,
                nodata=None if ds.nodata is None or (isinstance(ds.nodata, float) and math.isnan(ds.nodata)) else float(ds.nodata),
                bbox=bbox, epsg=epsg, geographic=geographic or epsg == 4326, crs_wkt=crs.to_wkt() if crs else None, latlng_bounds=latlng,
                pixel_size=pixel, band_names=[d or f"Band {i + 1}" for i, d in enumerate(ds.descriptions)], dtype=ds.dtypes[0], warnings=warnings,
            )
            self._nan_nodata = ds.nodata is not None and isinstance(ds.nodata, float) and math.isnan(ds.nodata)

    @property
    def transform(self):
        """Affine transform of the analysis grid."""
        if not self.meta.bbox:
            return None
        return from_bounds(*self.meta.bbox, self.gw, self.gh)

    @property
    def resample_factor(self) -> float:
        """Original pixels per analysis-grid cell (1 at full resolution)."""
        return (self.meta.width * self.meta.height) / (self.gw * self.gh)

    def _check_bands(self, indices: list[int]) -> None:
        n = self.meta.bands
        for i in indices:
            if i < 0 or i >= n:
                raise ValueError(f"Band {i + 1} does not exist; the file has {n} band{'' if n == 1 else 's'}.")

    def _clean(self, a: np.ndarray) -> np.ndarray:
        a = a.astype(np.float32, copy=False)
        bad = ~np.isfinite(a)
        if self.meta.nodata is not None:
            bad |= a == np.float32(self.meta.nodata)
        a[bad] = np.nan
        return a

    def read_bands(self, indices: list[int]) -> list[Grid]:
        """Reads 0-based bands onto the whole analysis grid as float32 with NaN for no data."""
        self._check_bands(indices)
        out = []
        with rasterio.open(self.path) as ds:
            for i in indices:
                a = self._clean(ds.read(i + 1, out_shape=(self.gh, self.gw), resampling=Resampling.nearest, masked=False))
                out.append(Grid(self.gw, self.gh, a, self.resample_factor))
        return out

    def pixel(self, col: int, row: int) -> list[float | None]:
        """Every band's value at one full-resolution pixel (None for no data)."""
        with rasterio.open(self.path) as ds:
            v = self._clean(ds.read(window=Window(col, row, 1, 1), masked=False)).reshape(-1)
        return [None if not np.isfinite(x) else float(x) for x in v]

    def overview(self, indices: list[int], max_side: int = 1024) -> list[np.ndarray]:
        """A decimated read of whole bands (at most `max_side` cells a side), for checks that only need a sample."""
        self._check_bands(indices)
        k = max(1.0, max(self.meta.width, self.meta.height) / max_side)
        shape = (max(1, round(self.meta.height / k)), max(1, round(self.meta.width / k)))
        with rasterio.open(self.path) as ds:
            return [self._clean(ds.read(i + 1, out_shape=shape, resampling=Resampling.nearest, masked=False)) for i in indices]

    def read_window(self, indices: list[int], col0: int, row0: int, col1: int, row1: int, max_pixels: int | None = None) -> tuple[list[np.ndarray], int]:
        """Full-resolution pixels [row0:row1, col0:col1] (clipped to the file) of 0-based bands, and the decimation step.

        The step is 1 unless the window exceeds `max_pixels` (default TERRAX_MAX_PIXELS); then every step-th
        pixel is read, so array index (i, j) is file pixel (row0 + i * step, col0 + j * step).
        """
        self._check_bands(indices)
        col0, row0 = max(0, col0), max(0, row0)
        col1, row1 = min(self.meta.width, col1), min(self.meta.height, row1)
        if col1 <= col0 or row1 <= row0:
            return [np.full((0, 0), np.nan, np.float32) for _ in indices], 1
        limit = max_pixels or settings().max_pixels
        w, h = col1 - col0, row1 - row0
        step = max(1, math.ceil(math.sqrt(w * h / limit))) if w * h > limit else 1
        with rasterio.open(self.path) as ds:
            if step == 1:
                return [self._clean(ds.read(i + 1, window=Window(col0, row0, w, h), masked=False)) for i in indices], 1
            # Strips of whole step-aligned rows at full resolution, keeping every step-th row and column.
            rows = max(step, (4_000_000 // w) // step * step)
            out = []
            for i in indices:
                parts = [ds.read(i + 1, window=Window(col0, r, w, min(rows, row1 - r)), masked=False)[::step, ::step] for r in range(row0, row1, rows)]
                out.append(self._clean(np.concatenate(parts)))
            return out, step

    def read_rows(self, indices: list[int], r0: int, r1: int) -> list[np.ndarray]:
        """Analysis-grid rows r0..r1 (exclusive) of 0-based bands, float32 with NaN for no data.

        Each call opens its own dataset handle, so strips can be read from
        several threads at once. At full resolution this is a plain windowed
        read; on a resampled grid the window covers the same fraction of the
        file, so the strips together equal one whole-grid read.
        """
        self._check_bands(indices)
        sy = self.meta.height / self.gh
        window = Window(0, r0 * sy, self.meta.width, (r1 - r0) * sy)
        with rasterio.open(self.path) as ds:
            return [self._clean(ds.read(i + 1, window=window, out_shape=(r1 - r0, self.gw), resampling=Resampling.nearest, masked=False)) for i in indices]


def _looks_geographic(bbox) -> bool:
    return -180.001 <= bbox[0] <= 180.001 and -180.001 <= bbox[2] <= 180.001 and -90.001 <= bbox[1] <= 90.001 and -90.001 <= bbox[3] <= 90.001


def same_grid(a: Meta, b: Meta) -> bool:
    """True when two rasters share a grid closely enough for pixel-by-pixel comparison."""
    if a.width != b.width or a.height != b.height:
        return False
    if not a.bbox or not b.bbox:
        return not a.bbox and not b.bbox
    tol = max(a.pixel_size or (0, 0)) / 2
    return all(abs(x - y) <= tol for x, y in zip(a.bbox, b.bbox, strict=True)) and a.epsg == b.epsg


def is_utm(epsg: int | None) -> bool:
    return epsg is not None and (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760)


@dataclass
class Ground:
    """Cell area (m²) and spacing (m) per analysis-grid row."""

    cell_area: np.ndarray  # (height,)
    dx: np.ndarray  # (height,)
    dy: np.ndarray  # (height,)
    note: str

    def area_grid(self, width: int) -> np.ndarray:
        return np.repeat(self.cell_area[:, None], width, axis=1)


def ground_geometry(meta: Meta, width: int, height: int) -> Ground | None:
    """Ground geometry, or None when the CRS has no known ground units.

    Geographic cells use exact WGS84 ellipsoid areas (via authalic latitude);
    Web Mercator cells are corrected by cos²(latitude); UTM cells use the
    projected size (scale error < 0.1 % within a zone); any other projected
    CRS is measured geodesically row by row.
    """
    if not meta.bbox or not meta.pixel_size:
        return None
    minx, miny, maxx, maxy = meta.bbox
    cw = (maxx - minx) / width
    ch = (maxy - miny) / height
    rows = np.arange(height)
    if meta.geographic:
        if miny < -90.001 or maxy > 90.001:
            return None
        top = maxy - rows * ch
        bottom = maxy - (rows + 1) * ch
        lat = maxy - (rows + 0.5) * ch
        area = R_AUTHALIC * R_AUTHALIC * cw * RAD * np.abs(sin_authalic(top) - sin_authalic(bottom))
        return Ground(area, R_AUTHALIC * cw * RAD * np.cos(lat * RAD), np.full(height, R_AUTHALIC * ch * RAD),
                      "Pixel areas are exact WGS84 ellipsoid cell areas (authalic latitude), varying with latitude.")
    if meta.epsg in (3857, 900913):
        y = maxy - (rows + 0.5) * ch
        lat = 2 * np.arctan(np.exp(y / 6378137)) - math.pi / 2
        c = np.cos(lat)
        return Ground(cw * ch * c**2, cw * c, ch * c, "Web Mercator pixel sizes were corrected for latitude (× cos φ per side).")
    if is_utm(meta.epsg):
        return Ground(np.full(height, cw * ch), np.full(height, cw), np.full(height, ch),
                      f"Pixel sizes are in metres (EPSG:{meta.epsg}); UTM scale error is below 0.1 % within a zone.")
    if meta.crs_wkt:
        return _geodesic_ground(meta, width, height, cw, ch)
    return None


def _geodesic_ground(meta: Meta, width: int, height: int, cw: float, ch: float, samples: int = 17) -> Ground | None:
    """Ground geometry for any other projected CRS, measured on the WGS84 ellipsoid.

    In each row, cells at `samples` columns are mapped to longitude/latitude; the geodesic lengths of their
    east and north sides give the spacing, and side lengths × sin(angle between them) the area. The row mean is
    used, so this handles any linear unit (metres, feet) and the projection's own scale distortion.
    """
    from pyproj import CRS, Geod, Transformer

    try:
        tr = Transformer.from_crs(CRS.from_wkt(meta.crs_wkt or ""), "EPSG:4326", always_xy=True)
    except Exception:
        return None
    minx, _, _, maxy = meta.bbox or (0.0, 0.0, 0.0, 0.0)
    cols = np.unique(np.linspace(0, width - 1, min(samples, width)).round()).astype(np.float64)
    rows = np.arange(height, dtype=np.float64)
    c, r = np.meshgrid(cols, rows)
    x, y = minx + c * cw, maxy - r * ch  # each cell's north-west corner
    lon0, lat0 = tr.transform(x, y)
    lon_e, lat_e = tr.transform(x + cw, y)
    lon_s, lat_s = tr.transform(x, y - ch)
    if not (np.isfinite(lon0).all() and np.isfinite(lon_e).all() and np.isfinite(lon_s).all()):
        return None
    geod = Geod(ellps="WGS84")
    az_e, _, dx = geod.inv(lon0, lat0, lon_e, lat_e)
    az_s, _, dy = geod.inv(lon0, lat0, lon_s, lat_s)
    area = dx * dy * np.abs(np.sin(np.radians(np.asarray(az_s) - np.asarray(az_e))))
    spread = float(area.max(axis=1).max() / area.min(axis=1).min() - 1) if area.size and area.min() > 0 else 0.0
    unit = CRS.from_wkt(meta.crs_wkt or "").axis_info[0].unit_name if meta.crs_wkt else "unit"
    note = (f"Pixel sizes were measured on the WGS84 ellipsoid from the file's projection ({f'EPSG:{meta.epsg}' if meta.epsg else 'custom CRS'}, units: {unit}), "
            f"per row; cell areas vary by {spread * 100:.2g} % across the raster.")
    return Ground(area.mean(axis=1), np.asarray(dx).mean(axis=1), np.asarray(dy).mean(axis=1), note)


# ── Cloud and quality masks ──────────────────────────────────────────────────
# Sentinel-2 L2A Scene Classification (SCL): 0 no data, 1 saturated/defective,
# 3 cloud shadow, 8/9 cloud, 10 thin cirrus, 11 snow/ice (ESA L2A product definition).
# Landsat Collection 2 QA_PIXEL bits 0–5: fill, dilated cloud, cirrus, cloud,
# cloud shadow, snow (USGS LSDS-1619).

QA_KINDS = {
    "scl": {"label": "Sentinel-2 SCL", "rule": "SCL classes 0, 1, 3, 8, 9, 10 and 11 (no data, defective, cloud shadow, clouds, cirrus, snow)"},
    "landsat": {"label": "Landsat QA_PIXEL", "rule": "QA_PIXEL bits 0–5 (fill, dilated cloud, cirrus, cloud, cloud shadow, snow)"},
}
SCL_MASKED = np.array([0, 1, 3, 8, 9, 10, 11])


def qa_masked(kind: str, q: np.ndarray) -> np.ndarray:
    bad = ~np.isfinite(q)
    qi = np.where(bad, 0, np.round(q)).astype(np.int64)
    if kind == "scl":
        return bad | np.isin(qi, SCL_MASKED)
    return bad | ((qi & 0b111111) != 0)


def apply_qa(raster: Raster, grids: list[Grid], qa: dict) -> tuple[float, str]:
    """Sets masked cells to NaN in every grid; returns the masked share and a note."""
    (q,) = raster.read_bands([qa["band"]])
    m = qa_masked(qa["kind"], q.data)
    for g in grids:
        g.data[m] = np.nan
    frac = float(m.mean()) if m.size else 0.0
    return frac, f"Quality mask from band {qa['band'] + 1} ({QA_KINDS[qa['kind']]['rule']}) removed {frac * 100:.1f} % of pixels."


def grid_to_lonlat_arrays(raster: Raster, width: int, height: int):
    """Vectorised (cols, rows) on an analysis grid of width × height → (lon, lat) arrays (unrounded), or None without a CRS."""
    meta = raster.meta
    if not meta.bbox or (not meta.geographic and raster.crs is None):
        return None
    minx, miny, maxx, maxy = meta.bbox
    cw, ch = (maxx - minx) / width, (maxy - miny) / height
    if meta.geographic:
        return lambda cols, rows: (minx + np.asarray(cols, dtype=np.float64) * cw, maxy - np.asarray(rows, dtype=np.float64) * ch)
    from pyproj import Transformer

    tr = Transformer.from_crs(raster.crs, "EPSG:4326", always_xy=True)

    def f(cols, rows):
        lon, lat = tr.transform(minx + np.asarray(cols, dtype=np.float64) * cw, maxy - np.asarray(rows, dtype=np.float64) * ch)
        return np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64)

    return f


def grid_to_lonlat(raster: Raster, width: int, height: int):
    """(col, row) on an analysis grid of width × height → [lon, lat] (7 decimals), or None without a CRS."""
    many = grid_to_lonlat_arrays(raster, width, height)
    if many is None:
        return None

    def f(col, row):
        lon, lat = many([col], [row])
        return [round(float(lon[0]), 7), round(float(lat[0]), 7)]

    return f
