"""TerraX's built-in world maps (backend/data/maps, made by scripts/make-world-maps.py).

* Pictures are square Web Mercator images: a 4096² overview plus, for some,
  full-detail chunks of 4096² (with a 4-pixel overlap on every side) in a
  folder named after the picture. They are served as 512-pixel XYZ tiles.
* Class pictures (Köppen–Geiger zones, biomes) are read at a point.
* Vectors are Natural Earth GeoJSON (1:50m for the world, 1:10m in 45° cells).
"""

from __future__ import annotations

import io
import json
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from ..config import settings

TILE = 512
CHUNK = 4096
PAD = 4
CELL = 45  # degrees, 1:10m cells
MERCATOR_MAX_LAT = math.degrees(math.atan(math.sinh(math.pi)))


@dataclass(frozen=True)
class Picture:
    file: str
    full: int | None  # width of the full-detail picture, when chunked
    classes: bool = False  # nearest-neighbour, PNG output

    @property
    def folder(self) -> str:
        return self.file.rsplit(".", 1)[0]

    @property
    def max_zoom(self) -> int:
        """Deepest zoom with at least one source pixel per tile pixel."""
        return int(math.log2((self.full or 4096) / TILE))


PICTURES: dict[str, Picture] = {
    "relief": Picture("relief.jpg", 16384),
    "etopo": Picture("etopo.jpg", 8192),
    "bluemarble": Picture("bluemarble.jpg", 8192),
    "blackmarble-local": Picture("blackmarble.jpg", 16384),
    "koppen": Picture("koppen.png", None, classes=True),
    "biomes": Picture("biomes.png", None, classes=True),
}


def maps_dir() -> Path:
    return settings().data_dir / "maps"


# ── Classes ──────────────────────────────────────────────────────────────────

_KOPPEN_DEFS: dict[str, tuple[str, tuple[int, int, int]]] = {
    "Af": ("Tropical rainforest", (0, 0, 255)),
    "Am": ("Tropical monsoon", (0, 120, 255)),
    "Aw": ("Tropical savanna, dry winter", (70, 170, 250)),
    "BWh": ("Hot desert", (255, 0, 0)),
    "BWk": ("Cold desert", (255, 150, 150)),
    "BSh": ("Hot semi-arid (steppe)", (245, 165, 0)),
    "BSk": ("Cold semi-arid (steppe)", (255, 220, 100)),
    "Csa": ("Temperate, dry hot summer (Mediterranean)", (255, 255, 0)),
    "Csb": ("Temperate, dry warm summer", (200, 200, 0)),
    "Csc": ("Temperate, dry cold summer", (150, 150, 0)),
    "Cwa": ("Temperate, dry winter, hot summer", (150, 255, 150)),
    "Cwb": ("Temperate, dry winter, warm summer", (100, 200, 100)),
    "Cwc": ("Temperate, dry winter, cold summer", (50, 150, 50)),
    "Cfa": ("Temperate, no dry season, hot summer", (200, 255, 80)),
    "Cfb": ("Temperate, no dry season, warm summer (oceanic)", (100, 255, 80)),
    "Cfc": ("Temperate, no dry season, cold summer", (50, 200, 0)),
    "Dsa": ("Cold, dry hot summer", (255, 0, 255)),
    "Dsb": ("Cold, dry warm summer", (200, 0, 200)),
    "Dsc": ("Cold, dry cold summer", (150, 50, 150)),
    "Dsd": ("Cold, dry summer, very cold winter", (150, 100, 150)),
    "Dwa": ("Cold, dry winter, hot summer", (170, 175, 255)),
    "Dwb": ("Cold, dry winter, warm summer", (90, 120, 220)),
    "Dwc": ("Cold, dry winter, cold summer", (75, 80, 180)),
    "Dwd": ("Cold, dry winter, very cold winter", (50, 0, 135)),
    "Dfa": ("Cold, no dry season, hot summer", (0, 255, 255)),
    "Dfb": ("Cold, no dry season, warm summer", (55, 200, 255)),
    "Dfc": ("Cold, no dry season, cold summer (subarctic)", (0, 125, 125)),
    "Dfd": ("Cold, no dry season, very cold winter", (0, 70, 95)),
    "ET": ("Polar tundra", (178, 178, 178)),
    "EF": ("Polar ice cap", (102, 102, 102)),
}
# Raster value v (1-based) is KOPPEN_VALUES[v - 1] (see the build script).
_KOPPEN_VALUES = ["Af", "Am", "Aw", "Cwc", "BSh", "Cwb", "Cwa", "BWh", "Cfa", "Csb", "Dsa", "Csc", "Cfb", "Csa", "BWk", "Dsb", "BSk", "Dwa", "Dfa", "Dwb", "Cfc", "Dfb", "Dwc", "ET", "Dfc", "Dsc", "Dwd", "Dfd", "Dsd", "EF"]


def _rgb(c: tuple[int, int, int]) -> str:
    return f"rgb({c[0]}, {c[1]}, {c[2]})"


KOPPEN = [{"code": c, "name": _KOPPEN_DEFS[c][0], "color": _rgb(_KOPPEN_DEFS[c][1]), "rgb": _KOPPEN_DEFS[c][1]} for c in _KOPPEN_VALUES]
#: Legend order: the conventional A, B, C, D, E sequence.
KOPPEN_LEGEND = [next(k for k in KOPPEN if k["code"] == c) for c in _KOPPEN_DEFS]

#: RESOLVE Ecoregions 2017 biomes (Dinerstein et al. 2017), in raster order; colours are TerraX's own.
BIOMES = [
    {"code": str(i + 1), "name": n, "color": _rgb(c), "rgb": c}
    for i, (n, c) in enumerate(
        [
            ("Tropical & subtropical moist broadleaf forests", (38, 115, 0)),
            ("Mangroves", (230, 0, 169)),
            ("Tropical & subtropical grasslands, savannas & shrublands", (204, 204, 102)),
            ("Tropical & subtropical dry broadleaf forests", (152, 196, 82)),
            ("Flooded grasslands & savannas", (115, 223, 255)),
            ("Tropical & subtropical coniferous forests", (90, 160, 90)),
            ("Deserts & xeric shrublands", (232, 196, 140)),
            ("Montane grasslands & shrublands", (200, 150, 110)),
            ("Mediterranean forests, woodlands & scrub", (255, 120, 60)),
            ("Temperate grasslands, savannas & shrublands", (245, 230, 120)),
            ("Temperate broadleaf & mixed forests", (60, 180, 110)),
            ("Temperate conifer forests", (0, 120, 110)),
            ("Boreal forests/taiga", (100, 150, 200)),
            ("Tundra", (180, 200, 220)),
            ("Rock & ice", (240, 240, 245)),
        ]
    )
]

#: Boundary classes of Bird (2003), Table 1.
PLATE_CLASSES = {
    "SUB": {"name": "Subduction zone", "color": "#ef4444"},
    "OCB": {"name": "Oceanic convergent boundary", "color": "#f97316"},
    "CCB": {"name": "Continental convergent boundary (collision)", "color": "#fb923c", "dash": [5, 3]},
    "OSR": {"name": "Oceanic spreading ridge", "color": "#22d3ee"},
    "CRB": {"name": "Continental rift boundary", "color": "#a78bfa", "dash": [5, 3]},
    "OTF": {"name": "Oceanic transform fault", "color": "#facc15"},
    "CTF": {"name": "Continental transform fault", "color": "#fde047", "dash": [5, 3]},
}

#: The 52 plates of the PB2002 model (Bird 2003).
PLATES = {
    "AF": "Africa", "AM": "Amur", "AN": "Antarctica", "AP": "Altiplano", "AR": "Arabia", "AS": "Aegean Sea", "AT": "Anatolia", "AU": "Australia",
    "BH": "Birds Head", "BR": "Balmoral Reef", "BS": "Banda Sea", "BU": "Burma", "CA": "Caribbean", "CL": "Caroline", "CO": "Cocos", "CR": "Conway Reef",
    "EA": "Easter", "EU": "Eurasia", "FT": "Futuna", "GP": "Galápagos", "IN": "India", "JF": "Juan de Fuca", "JZ": "Juan Fernández", "KE": "Kermadec",
    "MA": "Mariana", "MN": "Manus", "MO": "Maoke", "MS": "Molucca Sea", "NA": "North America", "NB": "North Bismarck", "ND": "North Andes", "NH": "New Hebrides",
    "NI": "Niuafo’ou", "NZ": "Nazca", "OK": "Okhotsk", "ON": "Okinawa", "PA": "Pacific", "PM": "Panama", "PS": "Philippine Sea", "RI": "Rivera",
    "SA": "South America", "SB": "South Bismarck", "SC": "Scotia", "SL": "Shetland", "SO": "Somalia", "SS": "Solomon Sea", "SU": "Sunda", "SW": "Sandwich",
    "TI": "Timor", "TO": "Tonga", "WL": "Woodlark", "YA": "Yangtze",
}


def plate_pair(code: str) -> str:
    """"AF-AN" (or with / or \\ for subduction polarity) → "Africa – Antarctica"."""
    import re

    return " – ".join(PLATES.get(c, c) for c in re.split(r"[-/\\]", code))


def obliquity_deg(dt: datetime) -> float:
    """Mean obliquity of the ecliptic (IAU 2006, Capitaine et al. 2003), degrees."""
    u = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    T = (u.timestamp() / 86_400 + 2_440_587.5 - 2_451_545.0) / 36_525
    arcsec = 84_381.406 - 46.836769 * T - 0.0001831 * T**2 + 0.0020034 * T**3 - 0.000000576 * T**4 - 0.0000000434 * T**5
    return arcsec / 3600


def mercator_pixel(lat: float, lon: float, size: int) -> tuple[int, int] | None:
    """Pixel (column, row) in a square Web Mercator world image, or None outside ±85.05°."""
    if not abs(lat) < MERCATOR_MAX_LAT:
        return None
    x = (((lon + 180) % 360) + 360) % 360 / 360
    phi = math.radians(lat)
    y = (1 - math.log(math.tan(math.pi / 4 + phi / 2)) / math.pi) / 2
    return min(size - 1, math.floor(x * size)), min(size - 1, math.floor(y * size))


def class_from_color(r: int, g: int, b: int, a: int, classes: list[dict]) -> int:
    """Class index (1-based) whose colour is nearest to an RGBA sample; 0 for transparent (no data)."""
    if a < 128:
        return 0
    best, best_d = 0, math.inf
    for i, c in enumerate(classes):
        cr, cg, cb = c["rgb"]
        d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2
        if d < best_d:
            best, best_d = i + 1, d
    return best


@lru_cache(maxsize=2)
def _class_pixels(file: str):
    from PIL import Image

    with Image.open(maps_dir() / file) as im:
        return im.convert("RGBA").load(), im.size


def identify(lat: float, lon: float) -> dict[str, Any]:
    """Köppen–Geiger zone and biome at a point."""
    out: dict[str, Any] = {"lat": lat, "lon": lon}
    for key, file, classes in (("koppen", "koppen.png", KOPPEN), ("biome", "biomes.png", BIOMES)):
        try:
            px, (w, _h) = _class_pixels(file)
        except FileNotFoundError:
            out[key] = None
            continue
        p = mercator_pixel(lat, lon, w)
        c = class_from_color(*px[p[0], p[1]], classes) if p else 0
        out[key] = {"code": classes[c - 1]["code"], "name": classes[c - 1]["name"], "color": classes[c - 1]["color"]} if c else None
    return out


def legends() -> dict[str, Any]:
    strip = lambda items: [{k: v for k, v in i.items() if k != "rgb"} for i in items]  # noqa: E731
    return {"koppen": strip(KOPPEN_LEGEND), "biomes": strip(BIOMES), "plateClasses": PLATE_CLASSES, "plates": PLATES}


# ── Tiles ────────────────────────────────────────────────────────────────────

_lock = threading.Lock()
_images: OrderedDict[str, Any] = OrderedDict()
MAX_IMAGES = 4  # decoded 4096² pictures kept in memory (about 50 MB each)


def _image(rel: str):
    from PIL import Image

    with _lock:
        if rel in _images:
            _images.move_to_end(rel)
            return _images[rel]
    p = maps_dir() / rel
    if not p.is_file():
        raise FileNotFoundError(rel)
    im = Image.open(p)
    im.load()
    with _lock:
        _images[rel] = im
        while len(_images) > MAX_IMAGES:
            _images.popitem(last=False)
    return im


@lru_cache(maxsize=512)
def tile(layer: str, z: int, x: int, y: int) -> tuple[bytes, str]:
    """One 512-pixel XYZ tile as (bytes, media type)."""
    from PIL import Image

    pic = PICTURES.get(layer)
    if pic is None:
        raise KeyError(layer)
    n = 2**z
    if not (0 <= z <= 22 and 0 <= x < n and 0 <= y < n):
        raise KeyError(f"{z}/{x}/{y}")
    resample = Image.NEAREST if pic.classes else Image.LANCZOS
    over = _image(pic.file)
    if pic.full and over.width / n < TILE:
        fs = pic.full / n  # full-detail pixels per tile (never more than one chunk)
        fx, fy = x * fs, y * fs
        cx, cy = int(fx // CHUNK), int(fy // CHUNK)
        try:
            src = _image(f"{pic.folder}/{cx}-{cy}.jpg")
            ox, oy = fx - cx * CHUNK + PAD, fy - cy * CHUNK + PAD
            box = (ox, oy, ox + fs, oy + fs)
        except FileNotFoundError:
            src, s = over, over.width / n
            box = (x * s, y * s, x * s + s, y * s + s)
    else:
        src, s = over, over.width / n
        box = (x * s, y * s, x * s + s, y * s + s)
    # Resampling reads past the box edge into real neighbouring pixels, so tiles join without seams.
    img = src.resize((TILE, TILE), resample, box=box)
    buf = io.BytesIO()
    if pic.classes:
        img.save(buf, "PNG", optimize=True)
        return buf.getvalue(), "image/png"
    img.convert("RGB").save(buf, "JPEG", quality=88, optimize=True, progressive=True)
    return buf.getvalue(), "image/jpeg"


# ── Vectors ──────────────────────────────────────────────────────────────────

VECTOR_FILES = {"admin1": "admin1.json", "rivers": "rivers.json", "lakes": "lakes.json", "places": "places.json", "plates": "plates.json"}


def cell_ids(west: float, south: float, east: float, north: float) -> list[str]:
    """Ids ("col-row") of the 1:10m cells covering a box; longitudes wrap, latitudes are clamped."""
    n_cols, n_rows = 360 // CELL, 180 // CELL
    r0 = max(0, math.floor((90 - min(90, north)) / CELL))
    r1 = min(n_rows - 1, math.floor((90 - max(-90, south)) / CELL - 1e-9))
    c0 = math.floor((west + 180) / CELL)
    c1 = c0 + n_cols - 1 if east - west >= 360 else math.floor((east + 180) / CELL - 1e-9)
    cols = sorted({((c % n_cols) + n_cols) % n_cols for c in range(c0, c1 + 1)})
    return [f"{c}-{r}" for c in cols for r in range(r0, r1 + 1)]


@lru_cache(maxsize=32)
def _cell(cid: str) -> dict[str, Any]:
    p = maps_dir() / "vector" / f"{cid}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}


def detail(west: float, south: float, east: float, north: float, layers: list[str]) -> dict[str, Any]:
    """1:10m features of the cells covering a box, merged per layer."""
    ids = cell_ids(west, south, east, north)
    if len(ids) > 12:
        raise ValueError("The area is too large for 1:10m detail; zoom in.")
    out: dict[str, Any] = {"cells": ids}
    for layer in layers:
        feats = []
        for cid in ids:
            feats += (_cell(cid).get(layer) or {}).get("features", [])
        out[layer] = {"type": "FeatureCollection", "features": feats}
    return out


def graticule(dt: datetime | None = None) -> dict[str, Any]:
    """10° grid plus the equator, tropics and polar circles (from today's obliquity), with label points."""
    eps = obliquity_deg(dt or datetime.now(timezone.utc))
    feats: list[dict[str, Any]] = []
    for lon in range(-180, 181, 10):
        feats.append({"type": "Feature", "properties": {"kind": "grid", "major": lon % 30 == 0}, "geometry": {"type": "LineString", "coordinates": [[lon, -MERCATOR_MAX_LAT], [lon, MERCATOR_MAX_LAT]]}})
    line = lambda lat: [[-180 + i * 5, lat] for i in range(73)]  # noqa: E731
    for lat in range(-80, 81, 10):
        if lat:
            feats.append({"type": "Feature", "properties": {"kind": "grid", "major": lat % 30 == 0}, "geometry": {"type": "LineString", "coordinates": line(lat)}})
    special = [
        (0.0, "Equator"),
        (eps, f"Tropic of Cancer {eps:.2f}° N"),
        (-eps, f"Tropic of Capricorn {eps:.2f}° S"),
        (90 - eps, f"Arctic Circle {90 - eps:.2f}° N"),
        (-(90 - eps), f"Antarctic Circle {90 - eps:.2f}° S"),
    ]
    for lat, label in special:
        feats.append({"type": "Feature", "properties": {"kind": "special", "label": label, "equator": lat == 0}, "geometry": {"type": "LineString", "coordinates": line(lat)}})
        for lon in (-150, -30, 90):
            feats.append({"type": "Feature", "properties": {"kind": "label", "label": label}, "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    return {"type": "FeatureCollection", "features": feats, "obliquity": eps}
