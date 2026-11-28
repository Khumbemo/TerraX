"""Live data: telemetry (solar geometry, planetary Kp), daily weather series and Sentinel-2 search.

The server fetches third-party data, so the browser needs no cross-origin
access, and caches the Kp feed for a few minutes.
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import auth, ratelimit, storage
from ..auth import Principal, principal
from ..services import kp as kp_service
from ..services import live
from ..services.solar import solar_report

router = APIRouter(prefix="/api/live", tags=["live"])

KP_TTL_S = 300
_kp_cache: dict[str, Any] = {"at": 0.0, "value": None, "error": None}
_kp_lock = threading.Lock()


def current_kp() -> tuple[dict | None, str | None]:
    with _kp_lock:
        if time.monotonic() - _kp_cache["at"] < KP_TTL_S and _kp_cache["at"]:
            return _kp_cache["value"], _kp_cache["error"]
        try:
            reading = kp_service.parse_kp_feed(live.fetch_json(kp_service.KP_URL, timeout=15))
            value, error = (reading.public() if reading else None), (None if reading else "No recent value")
        except ValueError as err:
            value, error = None, f"Unavailable ({err})"
        _kp_cache.update(at=time.monotonic(), value=value, error=error)
        return value, error


@router.get("/solar")
def solar(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), at: datetime | None = None) -> dict[str, Any]:
    now = at or datetime.now(UTC)
    out = solar_report(now, lat, lon).public()
    out["at"] = now.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return out


@router.get("/kp")
def kp() -> dict[str, Any]:
    value, error = current_kp()
    return {"reading": value, "error": error}


@router.get("/sky")
def sky_now(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), at: datetime | None = None) -> dict[str, Any]:
    """The Earth and Moon, the Earth's orbit and the planets now (IAU SOFA/ERFA), with NASA's fact sheet."""
    from ..services.planet_facts import LABELS
    from ..services.sky import sky_report

    out = sky_report(at or datetime.now(UTC), lat, lon)
    out["factLabels"] = LABELS
    return out


@router.get("/sky/track")
def sky_track(model: str = Query(..., pattern="^(moon|orbit|system)$"), at: datetime | None = None) -> dict[str, Any]:
    """Positions over time for the animated models (moon: a lunation, orbit: a year, system: 12 years)."""
    from ..services.sky import track

    return {"model": model, "track": track(model, at or datetime.now(UTC))}


@router.get("/telemetry")
def telemetry(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)) -> dict[str, Any]:
    value, error = current_kp()
    return {"solar": solar(lat, lon), "kp": {"reading": value, "error": error}}


@router.get("/variables")
def variables() -> dict[str, Any]:
    return {"openMeteo": live.OPEN_METEO_VARS, "power": live.POWER_VARS}


class WeatherRequest(BaseModel):
    source: Literal["open-meteo", "power"]
    lat: float
    lon: float
    start: str
    end: str
    vars: list[str] = Field(min_length=1, max_length=10)


@router.post("/weather", status_code=201)
def weather(req: WeatherRequest, request: Request, p: Principal = Depends(principal)) -> dict[str, Any]:
    """Fetches a daily series and stores it as a CSV upload, ready for the table tool."""
    ratelimit.check("live", p.owner, auth.client_ip(request))
    try:
        if req.source == "open-meteo":
            csv, note = live.open_meteo_to_csv(live.fetch_json(live.open_meteo_url(req.lat, req.lon, req.start, req.end, req.vars)))
            label = "openmeteo"
        else:
            csv, note = live.power_to_csv(live.fetch_json(live.power_url(req.lat, req.lon, req.start, req.end, req.vars)))
            label = "nasapower"
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    name = f"{label}_{req.lat:.3f}_{req.lon:.3f}_{req.start}_{req.end}.csv"
    f = storage.save_file(name, csv.encode("utf-8"), owner=p.owner)
    return {"file": f.public(), "note": note}


class SearchRequest(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4)
    start: str
    end: str
    maxCloud: float = Field(30, ge=0, le=100)
    limit: int = Field(12, ge=1, le=50)


@router.post("/sentinel/search")
def sentinel_search(req: SearchRequest, request: Request, p: Principal = Depends(principal)) -> dict[str, Any]:
    ratelimit.check("live", p.owner, auth.client_ip(request))
    try:
        body = live.stac_search_body(req.bbox, req.start, req.end, req.maxCloud, req.limit)
        items = live.parse_stac_items(live.fetch_json(f"{live.EARTH_SEARCH}/search", method="POST", body=body))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"items": [i.public() for i in items]}


@router.post("/landsat/search")
def landsat_search(req: SearchRequest, request: Request, p: Principal = Depends(principal)) -> dict[str, Any]:
    """Landsat 4–9 Collection 2 Level-2 (Tier 1) scenes from the Planetary Computer, newest first."""
    ratelimit.check("live", p.owner, auth.client_ip(request))
    try:
        body = live.landsat_search_body(req.bbox, req.start, req.end, req.maxCloud, req.limit)
        items = live.parse_stac_items(live.fetch_json(f"{live.PC_STAC}/search", method="POST", body=body))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"items": [i.public() for i in items]}


class S1SearchRequest(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4)
    start: str
    end: str
    orbit: str | None = None
    limit: int = Field(12, ge=1, le=50)


@router.post("/sentinel1/search")
def sentinel1_search(req: S1SearchRequest, request: Request, p: Principal = Depends(principal)) -> dict[str, Any]:
    ratelimit.check("live", p.owner, auth.client_ip(request))
    try:
        body = live.s1_search_body(req.bbox, req.start, req.end, req.orbit, req.limit)
        items = live.parse_s1_items(live.fetch_json(f"{live.PC_STAC}/search", method="POST", body=body))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"items": [i.public() for i in items]}


# ── Live Earth layers for the map (services/earth.py) ─────────────────────────────────────────────────────────────
# Shared by every viewer and cached here, so the outside services see one request per feed (or grid cell) and
# interval however many people have the map open.

_earth_lock = threading.Lock()
_quake_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_fire_cache: dict[tuple[str, int, str], tuple[float, dict[str, Any]]] = {}
_weather_cache: dict[tuple[float, float], tuple[float, dict[str, Any]]] = {}
_elev_cache: dict[tuple[float, float], float | None] = {}
_ELEV_CACHE_MAX = 5000
_WEATHER_CACHE_MAX = 20000


def _fetch_text(url: str, timeout: float = 60.0) -> tuple[int, str]:
    import httpx

    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": live.USER_AGENT}, follow_redirects=True) as c:
            r = c.get(url)
    except httpx.HTTPError as err:
        raise ValueError(f"Could not reach {httpx.URL(url).host}: {type(err).__name__}") from None
    return r.status_code, r.text


@router.get("/earth/status")
def earth_status() -> dict[str, Any]:
    """Which live layers this server can show (fires need a MAP_KEY), with the choices each layer offers."""
    from .. import site
    from ..services import earth

    return {
        "quakes": {"feeds": list(earth.QUAKE_FEEDS), "default": "2.5_day"},
        "fires": {"available": bool(site.firms_map_key()), "sources": earth.FIRMS_SOURCES, "default": earth.FIRMS_DEFAULT_SOURCE, "maxDays": earth.FIRMS_MAX_DAYS},
        "weather": {"maxPoints": earth.GRID_MAX_POINTS},
    }


@router.get("/earth/quakes")
def earth_quakes(feed: str = "2.5_day") -> dict[str, Any]:
    """A USGS summary feed (magnitude class × window), re-read at most once a minute."""
    from ..services import earth

    try:
        url = earth.quake_url(feed)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    now = time.monotonic()
    with _earth_lock:
        hit = _quake_cache.get(feed)
    if hit and now - hit[0] < earth.QUAKE_TTL_S:
        return hit[1]
    try:
        out = earth.parse_quakes(live.fetch_json(url, timeout=30))
    except ValueError as err:
        if hit:  # an older copy beats nothing
            return {**hit[1], "stale": True}
        raise HTTPException(502, str(err)) from err
    with _earth_lock:
        _quake_cache[feed] = (now, out)
    return out


def _fires(source: str, days: int) -> dict[str, Any]:
    from .. import site
    from ..services import earth

    key = site.firms_map_key()
    if not key:
        raise HTTPException(409, "Active fires need a NASA FIRMS MAP_KEY: an administrator can add one in Admin → Site settings.")
    try:
        url = earth.firms_url(key, source, days)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    ck = (source, days, key[-4:])
    now = time.monotonic()
    with _earth_lock:
        hit = _fire_cache.get(ck)
    if hit and now - hit[0] < earth.FIRMS_TTL_S:
        return hit[1]
    try:
        status, text = _fetch_text(url, timeout=90)
        refused = earth.firms_error(status, text)
        if refused:
            raise ValueError(refused)
        data = earth.parse_firms_csv(text)
    except ValueError as e:
        # The key never appears in a message: FIRMS's own text does not echo it and URLs are not logged here.
        if hit:
            return {**hit[1], "stale": True}
        raise HTTPException(502, str(e)) from None
    data["at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    with _earth_lock:
        _fire_cache[ck] = (now, data)
    return data


@router.get("/earth/fires")
def earth_fires(
    source: str = "VIIRS_NOAA20_NRT",
    days: int = Query(1, ge=1, le=5),
    west: float = Query(-180, ge=-540, le=540),
    south: float = Query(-90, ge=-90, le=90),
    east: float = Query(180, ge=-540, le=540),
    north: float = Query(90, ge=-90, le=90),
) -> dict[str, Any]:
    """FIRMS detections in the view, as columns: [lon, lat, frp MW, confidence, UTC time, D/N]."""
    from ..services import earth

    data = _fires(source, days)
    rows, total = earth.fires_in_view(data["rows"], west, south, east, north)
    return {"source": source, "days": days, "fetched": data.get("at"), "stale": bool(data.get("stale")), "total": total, "rows": rows}


@router.get("/earth/weather")
def earth_weather(
    west: float = Query(..., ge=-540, le=540),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-540, le=540),
    north: float = Query(..., ge=-90, le=90),
) -> dict[str, Any]:
    """Today's weather on a grid over the view (Open-Meteo), each grid point cached for 15 minutes."""
    from ..services import earth

    try:
        step, pts = earth.grid_points(west, south, east, north)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    now = time.monotonic()
    with _earth_lock:
        have = {p: _weather_cache[p][1] for p in pts if p in _weather_cache and now - _weather_cache[p][0] < earth.WEATHER_TTL_S}
    missing = [p for p in pts if p not in have]
    error = None
    for i in range(0, len(missing), earth.WEATHER_BATCH):
        batch = missing[i : i + earth.WEATHER_BATCH]
        try:
            recs = earth.parse_forecast(live.fetch_json(earth.forecast_url(batch), timeout=30), batch)
        except ValueError as err:
            error = str(err)
            break
        with _earth_lock:
            if len(_weather_cache) > _WEATHER_CACHE_MAX:
                _weather_cache.clear()
            for p, r in zip(batch, recs, strict=True):
                _weather_cache[p] = (now, r)
                have[p] = r
    if error and not have:
        raise HTTPException(502, error)
    return {"step": step, "points": [have[p] for p in pts if p in have], "error": error}


@router.get("/earth/elevation")
def earth_elevation(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-540, le=540)) -> dict[str, Any]:
    """Ground height at a point from the Copernicus GLO-90 DEM, through Open-Meteo's elevation API."""
    from ..services import earth

    lon = ((lon + 180) % 360) - 180
    k = (round(lat, 4), round(lon, 4))
    with _earth_lock:
        known = k in _elev_cache
        v = _elev_cache.get(k)
    if not known:
        try:
            v = earth.parse_elevation(live.fetch_json(earth.elevation_url([k]), timeout=20), 1)[0]
        except ValueError as err:
            raise HTTPException(502, str(err)) from err
        with _earth_lock:
            if len(_elev_cache) >= _ELEV_CACHE_MAX:
                _elev_cache.clear()
            _elev_cache[k] = v
    return {"lat": k[0], "lon": k[1], "elevation": v, "source": "Copernicus DEM GLO-90 via Open-Meteo"}
