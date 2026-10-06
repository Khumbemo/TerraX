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

#: Pixel budget for analysis grids; larger rasters are resampled to this size.
ANALYSIS_PIXEL_LIMIT = 4_000_000
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
    """An opened GeoTIFF read onto one analysis grid of at most ANALYSIS_PIXEL_LIMIT cells."""

    def __init__(self, path: Path, filename: str | None = None):
        self.path = Path(path)
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
                except Exception:  # noqa: BLE001 — any CRS failure only loses the footprint
                    warnings.append(f"EPSG:{epsg} could not be converted to WGS84 for the map footprint." if epsg else "The file uses a custom projection that could not be converted to WGS84 for the map footprint.")
            total = ds.width * ds.height
            scale = math.sqrt(ANALYSIS_PIXEL_LIMIT / total) if total > ANALYSIS_PIXEL_LIMIT else 1.0
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

    def read_bands(self, indices: list[int]) -> list[Grid]:
        """Reads 0-based bands onto the analysis grid as float32 with NaN for no data."""
        n = self.meta.bands
        for i in indices:
            if i < 0 or i >= n:
                raise ValueError(f"Band {i + 1} does not exist; the file has {n} band{'' if n == 1 else 's'}.")
        out = []
        with rasterio.open(self.path) as ds:
            for i in indices:
                a = ds.read(i + 1, out_shape=(self.gh, self.gw), resampling=Resampling.nearest, masked=False).astype(np.float32)
                bad = ~np.isfinite(a)
                if self.meta.nodata is not None:
                    bad |= a == np.float32(self.meta.nodata)
                a[bad] = np.nan
                out.append(Grid(self.gw, self.gh, a, (self.meta.width * self.meta.height) / (self.gw * self.gh)))
        return out


def _looks_geographic(bbox) -> bool:
    return -180.001 <= bbox[0] <= 180.001 and -180.001 <= bbox[2] <= 180.001 and -90.001 <= bbox[1] <= 90.001 and -90.001 <= bbox[3] <= 90.001


def same_grid(a: Meta, b: Meta) -> bool:
    """True when two rasters share a grid closely enough for pixel-by-pixel comparison."""
    if a.width != b.width or a.height != b.height:
        return False
    if not a.bbox or not b.bbox:
        return not a.bbox and not b.bbox
    tol = max(a.pixel_size or (0, 0)) / 2
    return all(abs(x - y) <= tol for x, y in zip(a.bbox, b.bbox)) and a.epsg == b.epsg


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
    projected size (scale error < 0.1 % within a zone).
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
    return None


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


def grid_to_lonlat(raster: Raster, width: int, height: int):
    """(col, row) on an analysis grid of width × height → [lon, lat] (7 decimals), or None without a CRS."""
    meta = raster.meta
    if not meta.bbox or (not meta.geographic and raster.crs is None):
        return None
    minx, miny, maxx, maxy = meta.bbox
    cw, ch = (maxx - minx) / width, (maxy - miny) / height
    if meta.geographic:
        return lambda col, row: [round(minx + col * cw, 7), round(maxy - row * ch, 7)]
    from pyproj import Transformer

    tr = Transformer.from_crs(raster.crs, "EPSG:4326", always_xy=True)

    def f(col, row):
        lon, lat = tr.transform(minx + col * cw, maxy - row * ch)
        return [round(lon, 7), round(lat, 7)]

    return f
