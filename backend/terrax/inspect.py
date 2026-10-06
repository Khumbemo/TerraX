"""Describes an uploaded file so the UI can offer the right choices (bands, columns, layers)."""

from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Any

RASTER_EXT = {".tif", ".tiff", ".vrt", ".img", ".jp2"}
TABLE_EXT = {".csv", ".tsv", ".txt", ".xlsx", ".xlsm"}
VECTOR_EXT = {".geojson", ".json", ".kml", ".gpx", ".shp", ".gpkg"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def describe(path: Path) -> tuple[str, dict[str, Any]]:
    ext = path.suffix.lower()
    try:
        if ext in RASTER_EXT:
            from .processing.indices import guess_band_map
            from .processing.rio import Raster

            r = Raster(path)
            m = r.meta.public()
            m["guessedBands"] = guess_band_map(r.meta.bands)
            return "raster", m
        if ext in TABLE_EXT:
            from .processing.table import read_table

            return "table", read_table(path).summary()
        if ext in IMAGE_EXT:
            from PIL import Image

            with Image.open(path) as im:
                exif = bool(im.getexif())
                return "image", {"width": im.width, "height": im.height, "mode": im.mode, "format": im.format, "hasExif": exif}
        if ext == ".zip":
            with zipfile.ZipFile(path) as z:
                names = z.namelist()
            kind = "vector" if any(n.lower().endswith(".shp") for n in names) else "archive"
            return kind, {"entries": names[:50]}
        if ext in VECTOR_EXT:
            return "vector", {"format": ext.lstrip(".").upper()}
    except Exception as err:  # noqa: BLE001 — unreadable files are reported, not fatal
        return "other", {"error": f"{path.name} could not be read: {err}"}
    return "other", {}
