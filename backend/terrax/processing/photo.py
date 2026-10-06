"""Ordinary RGB photos (JPG/PNG/WebP) from satellites, drones, aircraft or the ISS.

There is no georeferencing or calibrated reflectance, so only visible-band
indices are possible:

* VARI = (G − R) / (G + R − B)  (Gitelson et al. 2002)
* ExG = 2g − r − b on chromatic coordinates r = R/(R+G+B) …  (Woebbecke et al. 1995)

Vegetation cover is estimated by Otsu (1979) thresholding of ExG. EXIF camera,
time and GPS are read with Pillow (EXIF 2.3 / CIPA DC-008 tags).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .report import format_bytes
from .stats import fmt, summarize

MAX_SIDE = 1024


def otsu(values: np.ndarray, bins: int = 256) -> float:
    lo, hi = float(values.min()), float(values.max())
    if not hi > lo:
        return hi
    w = (hi - lo) / bins
    idx = np.minimum(bins - 1, np.floor((values - lo) / w).astype(int))
    hist = np.bincount(idx, minlength=bins).astype(float)
    total = values.size
    i = np.arange(bins)
    wb = np.cumsum(hist)
    sb = np.cumsum(i * hist)
    s = sb[-1]
    wf = total - wb
    with np.errstate(divide="ignore", invalid="ignore"):
        between = wb * wf * (sb / wb - (s - sb) / wf) ** 2
    between[(wb == 0) | (wf == 0)] = 0
    thr = int(np.argmax(between)) if between.max() > 0 else 0
    return lo + (thr + 1) * w


def read_exif(path: Path) -> dict | None:
    try:
        with Image.open(path) as im:
            ex = im.getexif()
    except Exception:  # malformed EXIF is not fatal
        return None
    if not ex:
        return None
    sub = ex.get_ifd(0x8769) if 0x8769 in ex else {}
    gps = ex.get_ifd(0x8825) if 0x8825 in ex else {}

    def ratio(v):
        try:
            return float(v)
        except (TypeError, ValueError, ZeroDivisionError):
            return None

    def dms(v, ref):
        if not v or len(v) < 3:
            return None
        d, m, s = (ratio(x) for x in v[:3])
        if None in (d, m, s):
            return None
        x = d + m / 60 + s / 3600
        return -x if ref in ("S", "W") else x

    lat = dms(gps.get(2), gps.get(1))
    lon = dms(gps.get(4), gps.get(3))
    alt = ratio(gps.get(6))
    if alt is not None and gps.get(5) in (1, b"\x01"):
        alt = -alt
    info = {
        "make": (str(ex.get(0x010F)).strip("\x00 ") or None) if ex.get(0x010F) else None,
        "model": (str(ex.get(0x0110)).strip("\x00 ") or None) if ex.get(0x0110) else None,
        "dateTime": str(sub.get(0x9003) or ex.get(0x0132) or "").strip("\x00 ") or None,
        "lat": lat if lat is not None and -90 <= lat <= 90 else None,
        "lon": lon if lon is not None and -180 <= lon <= 180 else None,
        "altitude": alt if lat is not None else None,
    }
    return info if any(v is not None for v in info.values()) else None


def analyze_photo(path: Path, filename: str) -> dict:
    try:
        im = Image.open(path)
        im = ImageOps.exif_transpose(im)
        im.load()
    except Exception:
        raise ValueError(f"{filename} could not be decoded as an image. Use JPG, PNG or WebP (for GeoTIFFs use the Satellite imagery tool).") from None
    width, height = im.size
    s = min(1.0, MAX_SIDE / max(width, height))
    aw, ah = max(1, round(width * s)), max(1, round(height * s))
    rgba = np.asarray(im.convert("RGBA").resize((aw, ah), Image.BILINEAR) if (aw, ah) != (width, height) else im.convert("RGBA"))
    opaque = rgba[..., 3] >= 128
    px = rgba[opaque][:, :3].astype(np.float64)
    if not px.size:
        raise ValueError(f"{filename} has no visible pixels.")
    R, G, B = px[:, 0], px[:, 1], px[:, 2]
    L = 0.2126 * R + 0.7152 * G + 0.0722 * B  # Rec. 709 luma (gamma-encoded)
    total = R + G + B
    exg = np.where(total > 0, (2 * G - R - B) / np.where(total > 0, total, 1), 0).astype(np.float32)
    d = G + R - B
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (G - R) / d
    vari = v[(np.abs(d) >= 1) & (v >= -1) & (v <= 1)]
    thr = max(0.0, otsu(exg))
    mask = np.zeros((ah, aw), dtype=bool)
    mask[opaque] = exg > thr
    veg = float((exg > thr).sum() / exg.size)
    return {
        "filename": filename, "sizeBytes": path.stat().st_size, "width": width, "height": height, "aw": aw, "ah": ah,
        "channels": {"r": summarize(R).dict(), "g": summarize(G).dict(), "b": summarize(B).dict()},
        "vari": summarize(vari).dict() if vari.size else None, "exgThreshold": thr, "vegetationFraction": veg,
        "brightness": summarize(L).dict(), "exif": read_exif(path),
        "notes": [
            "VARI = (G − R) / (G + R − B) (Gitelson et al. 2002); ExG = 2g − r − b on chromatic coordinates (Woebbecke et al. 1995).",
            f"Vegetation cover: pixels with ExG above an Otsu (1979) threshold of {thr:.3f} (never below 0).",
            "Ordinary images have no calibrated reflectance, georeferencing or near-infrared band: haze, shadows, white balance and JPEG compression change the result. Treat it as a relative estimate; use the Satellite imagery tool with multispectral GeoTIFFs for NDVI.",
            f"Analysed at {aw}×{ah} (downsampled from {width}×{height})." if width != aw else "Analysed at full resolution.",
        ],
        "_rgba": rgba, "_mask": mask,
    }


def exif_line(e: dict | None) -> str | None:
    if not e:
        return None
    import re

    parts = []
    if e.get("make") or e.get("model"):
        parts.append("camera " + " ".join(x for x in (e.get("make"), e.get("model")) if x))
    if e.get("dateTime"):
        when = re.sub(r"^(\d{4}):(\d{2}):(\d{2})", r"\1-\2-\3", e["dateTime"])
        parts.append(f"taken {when} (camera clock)")
    if e.get("lat") is not None and e.get("lon") is not None:
        alt = f", {fmt(e['altitude'])} m" if e.get("altitude") is not None else ""
        parts.append(f"GPS {e['lat']:.6f}, {e['lon']:.6f}{alt}")
    return f"- EXIF: {'; '.join(parts)}" if parts else None


def photo_markdown(p: dict, q: dict | None) -> str:
    vari = lambda x: f"{fmt(x['vari']['mean'])} ± {fmt(x['vari']['sd'])}" if x["vari"] else "—"
    lines = ["## Dataset", "", f"- File: {p['filename']} ({format_bytes(p['sizeBytes'])}, {p['width']} × {p['height']} px, RGB image without georeferencing)",
             *[x for x in [exif_line(p["exif"])] if x], "", "## Results", "", "| Measure | Value |", "|---|---|",
             f"| Vegetation cover (ExG + Otsu) | {p['vegetationFraction'] * 100:.1f} % of the image |", f"| VARI mean ± SD | {vari(p)} |",
             f"| Mean brightness (0–255) | {fmt(p['brightness']['mean'])} |",
             f"| Mean R / G / B | {fmt(p['channels']['r']['mean'])} / {fmt(p['channels']['g']['mean'])} / {fmt(p['channels']['b']['mean'])} |", ""]
    if q:
        vm = lambda x: fmt(x["vari"]["mean"]) if x["vari"] else "—"
        dv = fmt(q["vari"]["mean"] - p["vari"]["mean"]) if p["vari"] and q["vari"] else "—"
        lines += [f"### Compared with {q['filename']}", "", "| Measure | This photo | Other photo | Change |", "|---|---|---|---|",
                  f"| Vegetation cover | {p['vegetationFraction'] * 100:.1f} % | {q['vegetationFraction'] * 100:.1f} % | {(q['vegetationFraction'] - p['vegetationFraction']) * 100:.1f} percentage points |",
                  f"| VARI mean | {vm(p)} | {vm(q)} | {dv} |",
                  f"| Mean brightness | {fmt(p['brightness']['mean'])} | {fmt(q['brightness']['mean'])} | {fmt(q['brightness']['mean'] - p['brightness']['mean'])} |", "",
                  *[x for x in [exif_line(q["exif"])] if x],
                  "- The comparison is of whole-image fractions; the photos are not co-registered. It is meaningful only for the same scene and framing, similar light and camera settings. A large brightness change is a warning sign.", ""]
    lines += ["## Method and limits", "", *[f"- {n}" for n in p["notes"]]]
    return "\n".join(lines)


def photo_map(photos: list[dict]) -> dict | None:
    pts = [p for p in photos if p["exif"] and p["exif"].get("lat") is not None and p["exif"].get("lon") is not None]
    if not pts:
        return None
    lats = [p["exif"]["lat"] for p in pts]
    lons = [p["exif"]["lon"] for p in pts]
    pad = 0.002
    return {"bounds": [[min(lats) - pad, min(lons) - pad], [max(lats) + pad, max(lons) + pad]],
            "geojson": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": p["filename"]}, "geometry": {"type": "Point", "coordinates": [p["exif"]["lon"], p["exif"]["lat"]]}} for p in pts]}}
