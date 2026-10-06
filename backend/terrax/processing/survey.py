"""Land survey: reads boundary, traverse and point files and measures them.

Areas, perimeters, leg distances and bearings are geodesic values on the WGS84
ellipsoid (Karney 2013, "Algorithms for geodesics", via PROJ/pyproj), valid for
features of any size. Shapefiles are read with GeoPandas and reprojected to
WGS84 from their .prj.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from pyproj import Geod, Transformer

from .stats import fmt

GEOD = Geod(ellps="WGS84")
ACRE_M2 = 4046.8564224
LAT_NAMES = ["lat", "latitude", "y", "lat_dd", "northing_dd"]
LON_NAMES = ["lon", "lng", "long", "longitude", "x", "lon_dd"]
ELE_NAMES = ["ele", "elev", "elevation", "alt", "altitude", "z", "height"]


# ── Parsing ──────────────────────────────────────────────────────────────────


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _all(root, name):
    return [e for e in root.iter() if _local(e.tag) == name]


def _first(root, name):
    return next(iter(_all(root, name)), None)


def _text(e) -> str:
    return (e.text or "").strip() if e is not None else ""


def _xml(src: bytes, filename: str):
    try:
        return ET.fromstring(src)
    except ET.ParseError:
        raise ValueError(f"{filename} is not valid XML.") from None


def _kml_coords(s: str) -> list[list[float]]:
    out = []
    for t in s.split():
        p = t.split(",")
        try:
            v = [float(x) for x in p]
        except ValueError:
            continue
        if len(v) >= 2 and all(math.isfinite(x) for x in v[:2]):
            out.append(v[:3] if len(v) >= 3 and math.isfinite(v[2]) else v[:2])
    return out


def parse_kml(src: bytes, filename: str) -> dict:
    root = _xml(src, filename)
    feats = []
    for i, pm in enumerate(_all(root, "Placemark")):
        name = _text(_first(pm, "name")) or f"Placemark {i + 1}"
        for poly in _all(pm, "Polygon"):
            outer_el = _first(poly, "outerBoundaryIs") or poly
            outer = _first(outer_el, "coordinates")
            inners = [_kml_coords(_text(_first(ib, "coordinates"))) for ib in _all(poly, "innerBoundaryIs")]
            if outer is not None:
                feats.append({"type": "Feature", "properties": {"name": name}, "geometry": {"type": "Polygon", "coordinates": [_kml_coords(_text(outer)), *inners]}})
        for ls in _all(pm, "LineString"):
            feats.append({"type": "Feature", "properties": {"name": name}, "geometry": {"type": "LineString", "coordinates": _kml_coords(_text(_first(ls, "coordinates")))}})
        for pt in _all(pm, "Point"):
            c = _kml_coords(_text(_first(pt, "coordinates")))
            if c:
                feats.append({"type": "Feature", "properties": {"name": name}, "geometry": {"type": "Point", "coordinates": c[0]}})
    return {"type": "FeatureCollection", "features": feats}


def parse_gpx(src: bytes, filename: str) -> dict:
    root = _xml(src, filename)

    def pt(e):
        lat, lon = float(e.get("lat")), float(e.get("lon"))
        ele = _text(_first(e, "ele"))
        try:
            z = float(ele)
            return [lon, lat, z] if ele != "" and math.isfinite(z) else [lon, lat]
        except ValueError:
            return [lon, lat]

    feats = []
    for i, trk in enumerate(_all(root, "trk")):
        name = _text(_first(trk, "name")) or f"Track {i + 1}"
        for seg in _all(trk, "trkseg"):
            feats.append({"type": "Feature", "properties": {"name": name}, "geometry": {"type": "LineString", "coordinates": [pt(p) for p in _all(seg, "trkpt")]}})
    for i, rte in enumerate(_all(root, "rte")):
        feats.append({"type": "Feature", "properties": {"name": _text(_first(rte, "name")) or f"Route {i + 1}"}, "geometry": {"type": "LineString", "coordinates": [pt(p) for p in _all(rte, "rtept")]}})
    wpts = [w for w in _all(root, "wpt")]
    if wpts:
        feats.append({"type": "Feature", "properties": {"name": "Waypoints"}, "geometry": {"type": "MultiPoint", "coordinates": [pt(w) for w in wpts]}})
    return {"type": "FeatureCollection", "features": feats}


def parse_coordinate_csv(src: bytes, filename: str, close_ring: bool) -> tuple[dict, list[str]]:
    rows = list(csv.DictReader(io.StringIO(src.decode("utf-8-sig", errors="replace"))))
    fields = [f.strip() for f in (rows[0].keys() if rows else [])] if rows else []
    keys = list(rows[0].keys()) if rows else []
    find = lambda names: next((k for k in keys if k and k.strip().lower() in names), None)
    lat_k, lon_k, ele_k = find(LAT_NAMES), find(LON_NAMES), find(ELE_NAMES)
    if not lat_k or not lon_k:
        raise ValueError(f'{filename} needs latitude and longitude columns (for example "lat" and "lon"). Found: {", ".join(fields) or "no header"}.')
    pts, bad = [], 0
    for r in rows:
        try:
            lat, lon = float(r[lat_k]), float(r[lon_k])
        except (TypeError, ValueError):
            bad += 1
            continue
        if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 90 or abs(lon) > 180:
            bad += 1
            continue
        try:
            z = float(r[ele_k]) if ele_k and r[ele_k] != "" else math.nan
        except ValueError:
            z = math.nan
        pts.append([lon, lat, z] if math.isfinite(z) else [lon, lat])
    if not pts:
        raise ValueError(f"{filename} has no valid decimal-degree coordinates.")
    name = re.sub(r"\.[^.]+$", "", filename)
    geom: dict[str, Any]
    if close_ring and len(pts) >= 3:
        geom = {"type": "Polygon", "coordinates": [[*pts, pts[0]]]}
    elif len(pts) >= 2:
        geom = {"type": "LineString", "coordinates": pts}
    else:
        geom = {"type": "Point", "coordinates": pts[0]}
    warn = [f"{bad} row{'' if bad == 1 else 's'} without valid coordinates were skipped."] if bad else []
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": name}, "geometry": geom}]}, warn


def parse_shapefile_zip(path: Path, filename: str) -> tuple[dict, list[str]]:
    import geopandas as gpd

    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except zipfile.BadZipFile:
        raise ValueError(f"{filename} is not a valid zip file.") from None
    need = [x for x in (".shp", ".shx", ".dbf") if not any(n.lower().endswith(x) for n in names)]
    if need:
        raise ValueError(f"{filename} is missing {', '.join(need)}. Zip the .shp, .shx, .dbf and .prj files of the shapefile together.")
    shp = next(n for n in names if n.lower().endswith(".shp"))
    try:
        gdf = gpd.read_file(f"zip://{path}!{shp}")
    except Exception as err:
        raise ValueError(f"{filename} could not be read as a shapefile: {err}") from None
    warnings = []
    if gdf.crs is None:
        warnings.append("The shapefile has no .prj file, so its coordinates were assumed to be WGS84 longitude/latitude.")
    else:
        gdf = gdf.to_crs(4326)
        warnings.append(f"Shapefile coordinates were reprojected from {gdf.crs.name if hasattr(gdf.crs, 'name') else 'its CRS'} to WGS84 using the .prj file.")
    return json.loads(gdf.to_json(drop_id=True)), warnings


def parse_survey_file(path: Path, filename: str, close_ring: bool) -> tuple[dict, str, list[str]]:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    src = path.read_bytes()
    warnings: list[str] = []
    if ext in ("geojson", "json"):
        try:
            j = json.loads(src)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError(f"{filename} is not valid JSON.") from None
        crs = ((j.get("crs") or {}).get("properties") or {}).get("name") if isinstance(j, dict) else None
        if crs and not re.search(r"4326|CRS84", crs, re.I):
            raise ValueError(f'{filename} declares CRS "{crs}". GeoJSON must be in WGS84 longitude/latitude (RFC 7946); re-export it as EPSG:4326.')
        t = j.get("type") if isinstance(j, dict) else None
        if t == "FeatureCollection":
            fc = j
        elif t == "Feature":
            fc = {"type": "FeatureCollection", "features": [j]}
        elif t:
            fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": j}]}
        else:
            raise ValueError(f"{filename} is JSON but not GeoJSON.")
        fmt_name = "GeoJSON"
    elif ext == "kml":
        fc, fmt_name = parse_kml(src, filename), "KML"
    elif ext == "kmz":
        raise ValueError("KMZ is a zipped KML. Unzip it and upload the .kml file inside.")
    elif ext == "gpx":
        fc, fmt_name = parse_gpx(src, filename), "GPX"
    elif ext in ("csv", "txt"):
        fc, warnings = parse_coordinate_csv(src, filename, close_ring)
        fmt_name = "CSV"
    elif ext == "zip":
        fc, warnings = parse_shapefile_zip(path, filename)
        fmt_name = "Shapefile"
    elif ext == "shp":
        raise ValueError("Upload the shapefile as a .zip containing the .shp, .shx, .dbf and .prj files together.")
    else:
        raise ValueError(f"“.{ext or '?'}” is not a supported survey format. Use GeoJSON, KML, GPX, CSV (lat/lon) or a zipped shapefile.")
    if not fc.get("features"):
        raise ValueError(f"{filename} contains no features.")
    return fc, fmt_name, warnings


# ── Measurement ──────────────────────────────────────────────────────────────


def _open_ring(r: list) -> list:
    return r[:-1] if len(r) > 1 and r[0][0] == r[-1][0] and r[0][1] == r[-1][1] else r


def _utm_label(lat: float, lon: float) -> str:
    zone = min(60, int((lon + 180) // 6) + 1)
    south = lat < 0
    tr = _utm_transformer(zone, south)
    e, n = tr.transform(lon, lat)
    return f"{zone}{'S' if south else 'N'} {round(e)} E {round(n)} N"


_UTM: dict = {}


def _utm_transformer(zone: int, south: bool) -> Transformer:
    key = (zone, south)
    if key not in _UTM:
        _UTM[key] = Transformer.from_crs(4326, (32700 if south else 32600) + zone, always_xy=True)
    return _UTM[key]


def _vertices(points: list) -> list[dict]:
    all_zero = all(len(q) >= 3 and q[2] == 0 for q in points)
    return [{"index": i + 1, "lat": p[1], "lon": p[0],
             "elevation": p[2] if len(p) >= 3 and math.isfinite(p[2]) and not all_zero else None, "utm": _utm_label(p[1], p[0])} for i, p in enumerate(points)]


def _legs(points: list, closed: bool) -> list[dict]:
    out = []
    n = len(points)
    for i in range(n if closed else n - 1):
        j = (i + 1) % n if closed else i + 1
        az, _, d = GEOD.inv(points[i][0], points[i][1], points[j][0], points[j][1])
        out.append({"from": i + 1, "to": j + 1, "distance": d, "bearing": az % 360})
    return out


def _elev_range(points: list) -> dict | None:
    e = [p[2] for p in points if len(p) >= 3 and math.isfinite(p[2])]
    if not e or all(v == 0 for v in e):  # all-zero altitudes are placeholders (e.g. KML clampToGround)
        return None
    return {"min": min(e), "max": max(e)}


def _centroid(points: list) -> list[float]:
    n = len(points) or 1
    return [sum(p[1] for p in points) / n, sum(p[0] for p in points) / n]


METHOD = "geodesic on the WGS84 ellipsoid (Karney 2013)"


def _ring_area(ring: list) -> float:
    r = _open_ring(ring)
    area, _ = GEOD.polygon_area_perimeter([p[0] for p in r], [p[1] for p in r])
    return abs(area)


def measure_geometry(name: str, g: dict) -> list[dict]:
    t = g.get("type")
    raw = g.get("coordinates")
    c: list = raw if isinstance(raw, list) else []  # a geometry without coordinates measures as nothing
    if t == "Polygon":
        outer = _open_ring(c[0] if c else [])
        if len(outer) < 3:
            return []
        holes = [h for h in c[1:] if len(_open_ring(h)) >= 3]
        legs = _legs(outer, True)
        return [{"name": name, "kind": "Polygon", "area": max(0.0, _ring_area(outer) - sum(_ring_area(h) for h in holes)), "length": sum(l["distance"] for l in legs),
                 "vertices": _vertices(outer), "legs": legs, "centroid": _centroid(outer), "holes": len(holes), "method": METHOD, "elevation": _elev_range(outer)}]
    if t == "MultiPolygon":
        return [x for i, p in enumerate(c) for x in measure_geometry(f"{name} (part {i + 1})", {"type": "Polygon", "coordinates": p})]
    if t == "LineString":
        if len(c) < 2:
            return []
        legs = _legs(c, False)
        return [{"name": name, "kind": "Line", "area": None, "length": sum(l["distance"] for l in legs), "vertices": _vertices(c), "legs": legs,
                 "centroid": _centroid(c), "holes": 0, "method": METHOD, "elevation": _elev_range(c)}]
    if t == "MultiLineString":
        return [x for i, l in enumerate(c) for x in measure_geometry(f"{name} (part {i + 1})", {"type": "LineString", "coordinates": l})]
    if t in ("Point", "MultiPoint"):
        pts = [c] if t == "Point" else c
        if not pts or not all(isinstance(q, list) and len(q) >= 2 for q in pts):
            return []
        return [{"name": name, "kind": "Points", "area": None, "length": None, "vertices": _vertices(pts), "legs": [], "centroid": _centroid(pts), "holes": 0, "method": "point positions", "elevation": _elev_range(pts)}]
    if t == "GeometryCollection":
        return [x for i, sub in enumerate(g.get("geometries", [])) for x in measure_geometry(f"{name} ({i + 1})", sub)]
    return []


def measure_survey(filename: str, fmt_name: str, fc: dict, warnings: list[str]) -> dict:
    feats = []
    for i, f in enumerate(fc.get("features", [])):
        g = (f or {}).get("geometry")
        if not g:
            continue
        p = f.get("properties") or {}
        name = str(p.get("name") or p.get("Name") or p.get("NAME") or p.get("id") or f"Feature {i + 1}")
        # Guard projected coordinates before measuring them as degrees.
        _check_degrees(g, filename)
        feats += measure_geometry(name, g)
    if not feats:
        raise ValueError(f"{filename} has no measurable polygons, lines or points.")
    lats = [v["lat"] for f in feats for v in f["vertices"]]
    lons = [v["lon"] for f in feats for v in f["vertices"]]
    return {"filename": filename, "format": fmt_name, "features": feats, "geojson": fc, "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]], "warnings": warnings}


def _check_degrees(g: dict, filename: str) -> None:
    def walk(c):
        if isinstance(c, (list, tuple)) and c and isinstance(c[0], (int, float)):
            if abs(c[0]) > 180 or abs(c[1]) > 90:
                raise ValueError(f"{filename} has coordinates outside longitude/latitude ranges; it is probably in a projected CRS. Re-export it in WGS84 (EPSG:4326).")
        elif isinstance(c, (list, tuple)):
            for x in c:
                walk(x)

    walk(g.get("coordinates", []))
    for sub in g.get("geometries", []) or []:
        _check_degrees(sub, filename)


def format_area_m2(m2: float) -> str:
    if m2 < 10_000:
        return f"{fmt(m2, 5)} m² ({fmt(m2 / 10_000, 4)} ha, {fmt(m2 / ACRE_M2, 4)} acres)"
    km = f", {fmt(m2 / 1e6, 4)} km²" if m2 >= 1e6 else ""
    return f"{fmt(m2 / 10_000, 5)} ha ({fmt(m2 / ACRE_M2, 5)} acres{km})"


def format_length(m: float) -> str:
    return f"{fmt(m / 1000, 5)} km" if m >= 1000 else f"{fmt(m, 5)} m"


def to_dms(deg: float, pos: str, neg: str) -> str:
    hemi = pos if deg >= 0 else neg
    a = abs(deg)
    d = math.floor(a)
    m = math.floor((a - d) * 60)
    s = round(((a - d) * 60 - m) * 60 * 100) / 100
    if s >= 60:
        s -= 60
        m += 1
    if m >= 60:
        m -= 60
        d += 1
    return f"{d}°{m:02d}′{s:05.2f}″ {hemi}"


def elevation_profile(f: dict, threshold: float = 5) -> dict | None:
    if f["kind"] != "Line" or len(f["vertices"]) < 2 or any(v["elevation"] is None for v in f["vertices"]):
        return None
    pts = [{"distance": 0.0, "elevation": f["vertices"][0]["elevation"]}]
    for i, leg in enumerate(f["legs"]):
        pts.append({"distance": pts[i]["distance"] + leg["distance"], "elevation": f["vertices"][i + 1]["elevation"]})
    gain_raw = loss_raw = gain = loss = 0.0
    ref = pts[0]["elevation"]
    for i in range(1, len(pts)):
        d = pts[i]["elevation"] - pts[i - 1]["elevation"]
        if d > 0:
            gain_raw += d
        else:
            loss_raw -= d
        e = pts[i]["elevation"]
        if e - ref >= threshold:
            gain += e - ref
            ref = e
        elif ref - e >= threshold:
            loss += ref - e
            ref = e
    return {"points": pts, "gainRaw": gain_raw, "lossRaw": loss_raw, "gain": gain, "loss": loss, "threshold": threshold}


def magnetic_bearing(true_bearing: float, declination: float) -> float:
    return ((true_bearing - declination) % 360 + 360) % 360


def survey_markdown(r: dict, declination: float | None = None) -> str:
    n = len(r["features"])
    lines = ["## Dataset", "", f"- File: {r['filename']} ({r['format']}); {n} feature{'' if n == 1 else 's'}", "", "## Results", ""]
    any_profile = False
    for f in r["features"]:
        lines += [f"### {f['name']} ({f['kind'].lower()})", ""]
        if f["area"] is not None:
            holes = f" (after subtracting {f['holes']} hole{'' if f['holes'] == 1 else 's'})" if f["holes"] else ""
            lines.append(f"- Area: {format_area_m2(f['area'])}{holes}")
        if f["length"] is not None:
            lines.append(f"- {'Perimeter' if f['kind'] == 'Polygon' else 'Length'}: {format_length(f['length'])}")
        lines.append(f"- Vertices: {len(f['vertices'])}; centroid {to_dms(f['centroid'][0], 'N', 'S')}, {to_dms(f['centroid'][1], 'E', 'W')}")
        if f["elevation"]:
            lines.append(f"- Elevation range: {fmt(f['elevation']['min'])}–{fmt(f['elevation']['max'])} m (from the file)")
        lines += [f"- Method: {f['method']}", ""]
        prof = elevation_profile(f)
        if prof:
            any_profile = True
            lines += [f"- Elevation profile: ascent {fmt(prof['gain'])} m and descent {fmt(prof['loss'])} m counting changes over {prof['threshold']:g} m (all changes: +{fmt(prof['gainRaw'])} / −{fmt(prof['lossRaw'])} m)", ""]
        if f["legs"] and len(f["legs"]) <= 60:
            if declination is None:
                lines += ["| Leg | Distance | Bearing (true) |", "|---|---|---|", *[f"| {l['from']} → {l['to']} | {fmt(l['distance'], 5)} m | {l['bearing']:.1f}° |" for l in f["legs"]], ""]
            else:
                lines += ["| Leg | Distance | Bearing (true) | Bearing (magnetic) |", "|---|---|---|---|",
                          *[f"| {l['from']} → {l['to']} | {fmt(l['distance'], 5)} m | {l['bearing']:.1f}° | {magnetic_bearing(l['bearing'], declination):.1f}° |" for l in f["legs"]], ""]
    lines += ["## Method and limits", "",
              "- Areas, perimeters, distances and bearings are geodesic values on the WGS84 ellipsoid (Karney 2013, via PROJ), exact for features of any size.",
              "- Bearings are initial geodesic azimuths from true north; magnetic bearings differ by the local declination." if declination is None else
              f"- Bearings are initial geodesic azimuths from true north. Magnetic bearings use the declination entered by the user ({abs(declination):g}° {'east' if declination >= 0 else 'west'}): magnetic = true − declination. Declination changes with place and year; take it from a current geomagnetic model (for example the NOAA World Magnetic Model calculator)."]
    if any_profile:
        lines.append("- Elevations come from the file (GPS or a DEM in the source software). GPS heights are typically about 1.5–3 times less precise than horizontal positions, and that noise inflates a summed ascent, so a 5 m threshold is also shown.")
    lines.append("- Accuracy is limited by the input coordinates: consumer GPS is typically 3–10 m, so small plots can carry large relative area errors.")
    lines += [f"- {w}" for w in r["warnings"]]
    return "\n".join(lines)


def boundary_from_survey(r: dict) -> dict | None:
    """The polygons of a survey as an analysis boundary (name, WGS84 GeoJSON, area)."""
    polys = [f for f in r["geojson"]["features"] if (f.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon")]
    if not polys:
        return None
    area = sum(f["area"] for f in r["features"] if f["kind"] == "Polygon" and f["area"])
    return {"name": r["filename"], "geojson": {"type": "FeatureCollection", "features": polys}, "areaM2": area}
