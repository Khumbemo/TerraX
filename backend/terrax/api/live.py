"""Live data: telemetry (solar geometry, planetary Kp), daily weather series and Sentinel-2 search.

The server fetches third-party data, so the browser needs no cross-origin
access, and caches the Kp feed for a few minutes.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import storage
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
    now = at or datetime.now(timezone.utc)
    out = solar_report(now, lat, lon).public()
    out["at"] = now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return out


@router.get("/kp")
def kp() -> dict[str, Any]:
    value, error = current_kp()
    return {"reading": value, "error": error}


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
def weather(req: WeatherRequest) -> dict[str, Any]:
    """Fetches a daily series and stores it as a CSV upload, ready for the table tool."""
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
    f = storage.save_file(name, csv.encode("utf-8"))
    return {"file": f.public(), "note": note}


class SearchRequest(BaseModel):
    bbox: list[float] = Field(min_length=4, max_length=4)
    start: str
    end: str
    maxCloud: float = Field(30, ge=0, le=100)
    limit: int = Field(12, ge=1, le=50)


@router.post("/sentinel/search")
def sentinel_search(req: SearchRequest) -> dict[str, Any]:
    try:
        body = live.stac_search_body(req.bbox, req.start, req.end, req.maxCloud, req.limit)
        items = live.parse_stac_items(live.fetch_json(f"{live.EARTH_SEARCH}/search", method="POST", body=body))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"items": [i.public() for i in items]}
