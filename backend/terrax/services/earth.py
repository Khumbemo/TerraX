"""Live Earth layers for the map: earthquakes, active fires, today's weather and elevation.

Each format below was read from the service's own documentation and checked against real responses (recorded in
tests/fixtures/earth, retrieved 28 November 2026):

* USGS earthquake summary feeds (GeoJSON), https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php, with the
  field definitions of https://earthquake.usgs.gov/data/comcat/data-eventterms.php: ``time`` is milliseconds since
  the epoch (UTC), depth (the third coordinate) is in kilometres, ``alert`` is the PAGER level (green, yellow, orange,
  red), and ``tsunami`` = 1 only marks a large event in an oceanic region, not that a tsunami happened. Every feed is
  "updated every minute" and served with Cache-Control max-age=60.
* NASA FIRMS Area API, https://firms.modaps.eosdis.nasa.gov/api/area/ (and its OpenAPI file /api/openapi.yaml):
  ``/api/area/csv/[MAP_KEY]/[SOURCE]/[AREA_COORDINATES]/[DAY_RANGE]``, DAY_RANGE 1..5, "most recent data, from TODAY
  to TODAY - (DAY_RANGE-1)". The area is requested as ``world`` because the two documents disagree on the order of a
  bounding box (west,south,east,north on the page, min_lat,min_lon,max_lat,max_lon in the OpenAPI file); the server
  cuts out the view itself. A MAP_KEY allows "5000 transactions / 10-minute interval". Attributes, from NASA
  Earthdata's FIRMS pages: acq_time is the overpass time in UTC (HHMM), FRP is in megawatts, daynight is D or N; VIIRS
  confidence is low, nominal or high, MODIS confidence 0–100 %. Suomi NPP stopped delivering data on 2 November 2026
  (FIRMS FAQ), so NOAA-20 is the default.
* Open-Meteo Forecast API, https://open-meteo.com/en/docs: several comma-separated coordinates return "a list of
  structures"; errors are ``{"error": true, "reason": ...}``. A request with more than 10 variables counts as more
  than one call, so a request here asks for 10. WMO weather codes as tabled on that page.
* Open-Meteo Elevation API, https://open-meteo.com/en/docs/elevation-api: Copernicus DEM 2021 GLO-90 (90 m), up to
  100 coordinates, ``{"elevation": [...]}`` always a list. Over the open sea it answers 0.

The functions here are pure (no network), so they are tested on the recorded responses; api/live.py fetches and caches.
"""

from __future__ import annotations

import csv
import io
import math
import re
from typing import Any
from urllib.parse import quote, urlencode

# ── Earthquakes (USGS) ───────────────────────────────────────────────────────

USGS_FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{feed}.geojson"
#: The summary feeds the USGS lists: magnitude class × time window.
QUAKE_LEVELS = ("significant", "4.5", "2.5", "1.0", "all")
QUAKE_WINDOWS = ("hour", "day", "week", "month")
QUAKE_FEEDS = tuple(f"{m}_{w}" for m in QUAKE_LEVELS for w in QUAKE_WINDOWS)
QUAKE_TTL_S = 60  # "Updated every minute", Cache-Control: max-age=60
PAGER_ALERTS = ("green", "yellow", "orange", "red")


def quake_url(feed: str) -> str:
    if feed not in QUAKE_FEEDS:
        raise ValueError(f"Unknown earthquake feed “{feed}”.")
    return USGS_FEED.format(feed=feed)


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def _int(v: Any) -> int | None:
    x = _num(v)
    return int(x) if x is not None else None


def parse_quakes(j: Any) -> dict[str, Any]:
    """A USGS summary feed → {"generated", "title", "count", "features"} with the fields the map shows."""
    if not isinstance(j, dict) or j.get("type") != "FeatureCollection" or not isinstance(j.get("features"), list):
        raise ValueError("The USGS feed did not return a GeoJSON FeatureCollection.")
    out: list[dict[str, Any]] = []
    for f in j["features"]:
        if not isinstance(f, dict):
            continue
        g = f.get("geometry") or {}
        c = g.get("coordinates") if isinstance(g, dict) else None
        if g.get("type") != "Point" or not isinstance(c, list) or len(c) < 2:
            continue
        lon, lat = _num(c[0]), _num(c[1])
        if lon is None or lat is None:
            continue
        p = f.get("properties") or {}
        alert = p.get("alert") if p.get("alert") in PAGER_ALERTS else None
        out.append(
            {
                "type": "Feature",
                "id": str(f.get("id") or ""),
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": str(f.get("id") or ""),
                    "mag": _num(p.get("mag")),
                    "magType": p.get("magType") if isinstance(p.get("magType"), str) else None,
                    "place": p.get("place") if isinstance(p.get("place"), str) else None,
                    "time": _int(p.get("time")),
                    "depthKm": _num(c[2]) if len(c) > 2 else None,
                    "alert": alert,
                    "tsunami": p.get("tsunami") == 1,
                    "sig": _int(p.get("sig")),
                    "status": p.get("status") if isinstance(p.get("status"), str) else None,
                    "type": p.get("type") if isinstance(p.get("type"), str) else None,
                    "url": p.get("url") if isinstance(p.get("url"), str) and p["url"].startswith("https://") else None,
                },
            }
        )
    # Strongest last, so they are drawn on top.
    out.sort(key=lambda f: f["properties"]["mag"] if f["properties"]["mag"] is not None else -9)
    meta = j.get("metadata") or {}
    return {"generated": _int(meta.get("generated")), "title": meta.get("title") if isinstance(meta.get("title"), str) else None, "count": len(out), "features": out}


# ── Active fires (NASA FIRMS) ────────────────────────────────────────────────

FIRMS_AREA = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/world/{days}"
FIRMS_STATUS = "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/"
#: Near-real-time sources listed on /api/area/ (the *_SP standard products lag by months; Landsat covers the US and
#: Canada only).
FIRMS_SOURCES: dict[str, str] = {
    "VIIRS_NOAA20_NRT": "VIIRS 375 m, NOAA-20",
    "VIIRS_NOAA21_NRT": "VIIRS 375 m, NOAA-21",
    "MODIS_NRT": "MODIS 1 km, Terra and Aqua",
    "VIIRS_SNPP_NRT": "VIIRS 375 m, Suomi NPP (no new data since 2 November 2026)",
}
FIRMS_DEFAULT_SOURCE = "VIIRS_NOAA20_NRT"
FIRMS_MAX_DAYS = 5
FIRMS_TTL_S = 600
#: Most detections sent to the browser for one view; the largest FRP first when there are more.
FIRMS_MAX_POINTS = 20000
_MAP_KEY = re.compile(r"^[A-Za-z0-9]{8,64}$")
_VIIRS_CONF = {"l": "low", "n": "nominal", "h": "high", "low": "low", "nominal": "nominal", "high": "high"}


def check_map_key(key: str) -> str:
    k = key.strip()
    if not _MAP_KEY.match(k):
        raise ValueError("A FIRMS MAP_KEY is a string of letters and digits (as sent by e-mail from FIRMS).")
    return k


def firms_url(key: str, source: str, days: int) -> str:
    if source not in FIRMS_SOURCES:
        raise ValueError(f"Unknown FIRMS source “{source}”.")
    if not 1 <= days <= FIRMS_MAX_DAYS:
        raise ValueError(f"FIRMS returns 1 to {FIRMS_MAX_DAYS} days at a time.")
    return FIRMS_AREA.format(key=quote(check_map_key(key), safe=""), source=source, days=days)


def firms_status_url(key: str) -> str:
    return f"{FIRMS_STATUS}?{urlencode({'MAP_KEY': check_map_key(key)})}"


def firms_error(status: int, text: str) -> str | None:
    """FIRMS answers errors in plain text ("Invalid MAP_KEY.", HTTP 400); a CSV starts with its header row."""
    t = text.strip()
    if t.startswith("latitude,"):
        return None
    msg = t.splitlines()[0][:200] if t else f"HTTP {status}"
    if "map_key" in msg.lower() or "mapkey" in msg.lower():
        return f"FIRMS refused the MAP_KEY: {msg}"
    return f"FIRMS: {msg}"


def parse_firms_csv(text: str) -> dict[str, Any]:
    """FIRMS CSV (VIIRS or MODIS columns) → compact columns: lon, lat, frp (MW), confidence, UTC time, day/night.

    Confidence is "low", "nominal" or "high" for VIIRS and a percentage (0–100) for MODIS, as FIRMS gives it.
    """
    err = firms_error(200, text)
    if err:
        raise ValueError(err)
    rd = csv.DictReader(io.StringIO(text))
    need = {"latitude", "longitude", "acq_date", "acq_time", "frp", "confidence", "daynight"}
    if not rd.fieldnames or not need <= set(rd.fieldnames):
        raise ValueError("FIRMS returned a table without the expected columns.")
    rows: list[tuple[float, float, float | None, str | int | None, str, str]] = []
    for r in rd:
        try:
            lat, lon = float(r["latitude"]), float(r["longitude"])
        except (TypeError, ValueError):
            continue
        if not (abs(lat) <= 90 and abs(lon) <= 180):
            continue
        try:
            frp: float | None = float(r["frp"])
        except (TypeError, ValueError):
            frp = None
        c = (r.get("confidence") or "").strip()
        conf: str | int | None = int(c) if c.isdigit() else _VIIRS_CONF.get(c.lower())
        t = (r.get("acq_time") or "").strip().zfill(4)
        when = f"{r.get('acq_date', '').strip()}T{t[:2]}:{t[2:4]}Z" if t.isdigit() and len(t) == 4 else ""
        rows.append((round(lon, 5), round(lat, 5), frp, conf, when, (r.get("daynight") or "").strip()[:1]))
    return {"rows": rows}


def fires_in_view(rows: list[tuple[Any, ...]], west: float, south: float, east: float, north: float, limit: int = FIRMS_MAX_POINTS) -> tuple[list[tuple[Any, ...]], int]:
    """The detections inside a view (longitudes may run past ±180 when the map wraps), at most `limit`, largest FRP first."""
    if east - west >= 360:
        hit = list(rows)
    else:
        w = ((west + 180) % 360) - 180
        e = w + (east - west)
        hit = [r for r in rows if south <= r[1] <= north and (w <= r[0] <= e or w <= r[0] + 360 <= e)]
    total = len(hit)
    if total > limit:
        hit.sort(key=lambda r: r[2] if r[2] is not None else -1, reverse=True)
        hit = hit[:limit]
    return hit, total


# ── Today's weather (Open-Meteo) ─────────────────────────────────────────────

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_ELEVATION = "https://api.open-meteo.com/v1/elevation"
#: Ten variables in all: more would count as more than one API call (open-meteo.com/en/pricing).
CURRENT_VARS = ("temperature_2m", "weather_code", "is_day", "wind_speed_10m", "wind_direction_10m")
DAILY_VARS = ("weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum", "precipitation_probability_max")
WEATHER_TTL_S = 900  # "current" is based on 15-minutely model data
#: Most points in one request (the API documents no limit for the forecast; the elevation API takes 100).
WEATHER_BATCH = 50
#: Grid steps in degrees, from fine to coarse; points sit on multiples of the step so every viewer shares the cache.
GRID_STEPS = (0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 15.0, 20.0, 30.0, 45.0, 60.0)
GRID_MAX_POINTS = 30

#: WMO weather interpretation codes, as tabled at https://open-meteo.com/en/docs.
WMO_CODES: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    97: "Heavy thunderstorm",
    99: "Thunderstorm with heavy hail",
}


def grid_points(west: float, south: float, east: float, north: float) -> tuple[float, list[tuple[float, float]]]:
    """Points on a regular grid over a view: the finest step that keeps them to GRID_MAX_POINTS, at cell centres."""
    south, north = max(-89.0, south), min(89.0, north)
    if north <= south or east <= west:
        raise ValueError("The view is empty.")
    span = min(east - west, 360.0)
    for step in GRID_STEPS:
        lats = [a for a in _centres(south, north, step) if -90 < a < 90]
        lons = _centres(west, west + span, step)
        if len(lats) * len(lons) <= GRID_MAX_POINTS:
            break
    pts = [(la, ((lo + 180) % 360) - 180) for la in lats for lo in lons]
    return step, list(dict.fromkeys((round(a, 4), round(b, 4)) for a, b in pts))


def _centres(lo: float, hi: float, step: float) -> list[float]:
    k0, k1 = math.floor(lo / step), math.ceil(hi / step)
    return [(k + 0.5) * step for k in range(k0, k1)]


def forecast_url(points: list[tuple[float, float]]) -> str:
    if not 1 <= len(points) <= WEATHER_BATCH:
        raise ValueError(f"Ask for 1 to {WEATHER_BATCH} points at a time.")
    q = {
        "latitude": ",".join(f"{a:.4f}" for a, _ in points),
        "longitude": ",".join(f"{b:.4f}" for _, b in points),
        "current": ",".join(CURRENT_VARS),
        "daily": ",".join(DAILY_VARS),
        "timezone": "auto",
        "forecast_days": 1,
    }
    return f"{OPEN_METEO_FORECAST}?{urlencode(q)}"


def _om_error(j: Any) -> None:
    if isinstance(j, dict) and j.get("error"):
        raise ValueError(f"Open-Meteo: {j.get('reason') or 'request rejected'}")


def _first(v: Any) -> Any:
    return v[0] if isinstance(v, list) and v else None


def parse_forecast(j: Any, points: list[tuple[float, float]]) -> list[dict[str, Any]]:
    """Forecast JSON (one object, or a list for several points) → one record per requested point, in order."""
    _om_error(j)
    items = j if isinstance(j, list) else [j]
    # Every structure after the first carries a location_id (its index in the request); order by it to be safe.
    if all(isinstance(it, dict) for it in items):
        items = sorted(items, key=lambda it: it.get("location_id") or 0)
    if len(items) != len(points):
        raise ValueError(f"Open-Meteo answered {len(items)} locations for {len(points)} requested.")
    out = []
    for (lat, lon), it in zip(points, items, strict=True):
        if not isinstance(it, dict):
            raise ValueError("Open-Meteo returned an unexpected location record.")
        cur, day = it.get("current") or {}, it.get("daily") or {}
        cu, du = it.get("current_units") or {}, it.get("daily_units") or {}
        code = _int(cur.get("weather_code"))
        dcode = _int(_first(day.get("weather_code")))
        out.append(
            {
                "lat": lat,
                "lon": lon,
                "gridLat": _num(it.get("latitude")),
                "gridLon": _num(it.get("longitude")),
                "modelElevation": _num(it.get("elevation")),
                "timezone": it.get("timezone") if isinstance(it.get("timezone"), str) else None,
                "time": cur.get("time") if isinstance(cur.get("time"), str) else None,
                "temperature": _num(cur.get("temperature_2m")),
                "code": code,
                "text": WMO_CODES.get(code) if code is not None else None,
                "isDay": cur.get("is_day") == 1,
                "windSpeed": _num(cur.get("wind_speed_10m")),
                "windDirection": _num(cur.get("wind_direction_10m")),
                "date": _first(day.get("time")),
                "dayCode": dcode,
                "dayText": WMO_CODES.get(dcode) if dcode is not None else None,
                "tMax": _num(_first(day.get("temperature_2m_max"))),
                "tMin": _num(_first(day.get("temperature_2m_min"))),
                "precipitation": _num(_first(day.get("precipitation_sum"))),
                "precipitationProbability": _num(_first(day.get("precipitation_probability_max"))),
                "units": {
                    "temperature": cu.get("temperature_2m") or du.get("temperature_2m_max"),
                    "wind": cu.get("wind_speed_10m"),
                    "precipitation": du.get("precipitation_sum"),
                },
            }
        )
    return out


def elevation_url(points: list[tuple[float, float]]) -> str:
    if not 1 <= len(points) <= 100:
        raise ValueError("The elevation API takes 1 to 100 coordinates.")
    for lat, lon in points:
        if not (abs(lat) <= 90 and abs(lon) <= 180):
            raise ValueError("Latitude must be within ±90° and longitude within ±180°.")
    q = {"latitude": ",".join(f"{a:.5f}" for a, _ in points), "longitude": ",".join(f"{b:.5f}" for _, b in points)}
    return f"{OPEN_METEO_ELEVATION}?{urlencode(q)}"


def parse_elevation(j: Any, n: int) -> list[float | None]:
    _om_error(j)
    e = j.get("elevation") if isinstance(j, dict) else None
    if not isinstance(e, list) or len(e) != n:
        raise ValueError("Open-Meteo returned no elevation.")
    return [_num(v) for v in e]
