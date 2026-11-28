"""What TerraX knows about a point on the map, from data bundled with it (no internet needed).

* Coordinates as decimal degrees, degrees–minutes–seconds and UTM (WGS84, the standard 6° zones; the Norway and
  Svalbard exceptions are not applied).
* The nearest named places: Natural Earth 1:10m populated places (public domain, 7,342 places), with the great-circle
  distance on a sphere of the IUGG mean radius (6,371.0088 km, Moritz 2000) and the initial bearing from the place to
  the point. Natural Earth lists important places, so in sparsely populated areas the nearest one can be far away.
* The Köppen–Geiger climate zone and the biome (worldmaps.identify).
* The sun today: sunrise, sunset and day length (services/solar.py), or polar day / polar night.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import numpy as np
from numpy.typing import NDArray

from . import worldmaps
from .solar import day_length_minutes, sun_position, sun_times

#: IUGG mean Earth radius R1 = (2a + b) / 3 for WGS84, in km.
EARTH_RADIUS_KM = 6371.0088

_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


@lru_cache(maxsize=1)
def places() -> tuple[list[str], NDArray[np.float64], NDArray[np.float64], NDArray[np.int64]]:
    """Names, latitudes, longitudes (degrees) and populations of the bundled Natural Earth places."""
    rows = json.loads((worldmaps.maps_dir() / "places.json").read_text(encoding="utf-8"))
    return (
        [str(r[0]) for r in rows],
        np.array([float(r[1]) for r in rows]),
        np.array([float(r[2]) for r in rows]),
        np.array([int(r[4]) for r in rows], dtype=np.int64),
    )


def wrap_lon(lon: float) -> float:
    return ((lon + 180) % 360 + 360) % 360 - 180


def dms(value: float, pos: str, neg: str) -> str:
    """Degrees, minutes and seconds to 0.1″, e.g. 25°40′26.4″N."""
    hemi = pos if value >= 0 else neg
    total = round(abs(value) * 36000)  # tenths of a second, rounded once so 59.95″ carries over
    d, rest = divmod(total, 36000)
    m, s10 = divmod(rest, 600)
    return f"{d}°{m:02d}′{s10 // 10:02d}.{s10 % 10}″{hemi}"


def utm(lat: float, lon: float) -> dict[str, Any] | None:
    """UTM zone, easting and northing (metres); None outside 80°S–84°N, where UTM is not defined."""
    if not -80 <= lat <= 84:
        return None
    from pyproj import Transformer

    zone = min(60, int((lon + 180) // 6) + 1)
    south = lat < 0
    tr = Transformer.from_crs(4326, (32700 if south else 32600) + zone, always_xy=True)
    e, n = tr.transform(lon, lat)
    return {"zone": zone, "hemisphere": "S" if south else "N", "easting": round(e), "northing": round(n), "label": f"{zone}{'S' if south else 'N'} {round(e)} E {round(n)} N"}


def nearest_places(lat: float, lon: float, count: int = 3) -> list[dict[str, Any]]:
    """The closest bundled places: name, distance (km), and the compass bearing from the place to the point."""
    names, plat, plon, pop = places()
    p1, p2 = np.radians(plat), math.radians(lat)
    dl = np.radians(lon) - np.radians(plon)
    # Haversine distance (stable for short distances).
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * math.cos(p2) * np.sin(dl / 2) ** 2
    dist = 2 * EARTH_RADIUS_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    out = []
    for i in np.argsort(dist)[:count]:
        # Initial great-circle bearing from the place to the point.
        y = math.sin(dl[i]) * math.cos(p2)
        x = math.cos(p1[i]) * math.sin(p2) - math.sin(p1[i]) * math.cos(p2) * math.cos(dl[i])
        brg = (math.degrees(math.atan2(y, x)) + 360) % 360
        d = float(dist[i])
        out.append(
            {
                "name": names[i],
                "lat": float(plat[i]),
                "lon": float(plon[i]),
                "population": int(pop[i]) or None,
                "distanceKm": round(d, 1),
                "bearing": round(brg),
                "direction": _COMPASS[round(brg / 22.5) % 16] if d >= 0.5 else None,
            }
        )
    return out


def sun_today(lat: float, lon: float, now: datetime) -> dict[str, Any]:
    """Sunrise and sunset on the UTC date of `now`, or polar day / polar night when the sun does not cross the horizon."""
    day = datetime(now.year, now.month, now.day, tzinfo=UTC)
    rise, sset = sun_times(day, lat, lon)
    iso = lambda d: d.isoformat().replace("+00:00", "Z") if d else None
    out: dict[str, Any] = {"date": day.date().isoformat(), "sunrise": iso(rise), "sunset": iso(sset), "dayLengthMin": day_length_minutes(rise, sset), "polar": None}
    if not rise and not sset:
        # Local solar noon is near 12:00 − longitude/15 h UTC; the sun's height then says which.
        noon = day + timedelta(hours=12 - lon / 15)
        alt, _ = sun_position(noon, lat, lon)
        out["polar"] = "day" if alt > -0.833 else "night"
    alt_now, az_now = sun_position(now, lat, lon)
    out["altitudeNow"], out["azimuthNow"] = round(alt_now, 2), round(az_now, 2)
    return out


def place_report(lat: float, lon: float, now: datetime | None = None) -> dict[str, Any]:
    lon = wrap_lon(lon)
    now = now or datetime.now(UTC)
    ident = worldmaps.identify(lat, lon)
    return {
        "lat": lat,
        "lon": lon,
        "dms": f"{dms(lat, 'N', 'S')} {dms(lon, 'E', 'W')}",
        "utm": utm(lat, lon),
        "nearest": nearest_places(lat, lon),
        "koppen": ident.get("koppen"),
        "biome": ident.get("biome"),
        "sun": sun_today(lat, lon, now),
        "sources": {
            "places": "Natural Earth 1:10m populated places (public domain)",
            "koppen": "Köppen–Geiger zones 1980–2016, Beck et al. 2018, Sci. Data 5:180214 (CC BY 4.0), at about 10 km",
            "biome": "RESOLVE Ecoregions 2017 biomes, Dinerstein et al. 2017 (CC BY 4.0), at about 10 km",
            "sun": "NOAA solar equations (services/solar.py)",
        },
    }
