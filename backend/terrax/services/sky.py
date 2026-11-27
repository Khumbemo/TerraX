"""The sky for the telemetry panel's models: the Earth and Moon, the Earth's orbit, and the planets.

Positions come from ERFA, the open-source edition of the IAU's SOFA routines:

* Earth: eraEpv00 (VSOP2000, simplified): heliocentric position within 11 km of JPL DE405 over 1900–2100.
* Moon: eraMoon98 (Meeus): geocentric direction within 2.9 arcsec RMS (18 arcsec worst) of ELP/MPP02, 1950–2100.
* Planets: eraPlan94 (Simon et al.): within 4–86 arcsec of JPL DE102 over 1800–2050.

Apparent directions add light time (planets) and annual aberration (eraAb); they are turned into the Earth's frame
with the IAU 2006/2000A precession-nutation (eraC2i06a) and the Earth rotation angle (eraEra00, with UT1 taken as
UTC: under 0.9 s), seen from the observer's place on the WGS84 ellipsoid (eraGd2gc). Altitudes are geometric (no
refraction); rise and set are when the upper limb meets the standard horizon: the centre at −0.5667° (refraction)
minus the body's semi-diameter. Polar motion is ignored (under 0.5 arcsec).

Equinoxes and solstices are when the Sun's apparent geocentric longitude (true ecliptic and equinox of date) is a
multiple of 90°; new, first-quarter, full and last-quarter Moon when the Moon's apparent longitude minus the Sun's is
0, 90, 180 and 270°; perihelion and aphelion are the extremes of the Earth's (not the Earth–Moon barycentre's) distance.

Physical facts (sizes, rotation periods, axial tilts, moons …) are from NASA's Planetary Fact Sheet; see
planet_facts.py.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any

import erfa
import numpy as np

AU_KM = 149_597_870.7  # IAU 2012
C_AU_PER_DAY = 299_792.458 * 86_400 / AU_KM
LIGHT_S_PER_AU = AU_KM / 299_792.458
MOON_RADIUS_KM = 3475 / 2  # NASA fact sheet diameter
SUN_RADIUS_KM = 695_700  # IAU 2015 nominal solar radius
#: Rotations of the Earth per UT1 day relative to the stars, from the IAU 2000 Earth rotation angle (eraEra00).
ERA_RATE = 1.00273781191135448
PLANETS = ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]
_PLAN94 = {"Mercury": 1, "Venus": 2, "Mars": 4, "Jupiter": 5, "Saturn": 6, "Uranus": 7, "Neptune": 8}
DEG = math.pi / 180


# ── Time ─────────────────────────────────────────────────────────────────────


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _two_part(dt: datetime) -> tuple[tuple[float, float], tuple[float, float]]:
    """(UTC as UT1, TT) two-part Julian dates."""
    u = _utc(dt)
    sec = u.second + u.microsecond / 1e6
    u1, u2 = erfa.dtf2d("UTC", u.year, u.month, u.day, u.hour, u.minute, sec)
    a1, a2 = erfa.utctai(u1, u2)
    t1, t2 = erfa.taitt(a1, a2)
    return (float(u1), float(u2)), (float(t1), float(t2))


# ── Positions ────────────────────────────────────────────────────────────────


def _earth(tt: tuple[float, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Earth heliocentric position (au), heliocentric velocity and barycentric velocity (au/d)."""
    pvh, pvb = erfa.epv00(*tt)
    return np.array(pvh["p"]), np.array(pvh["v"]), np.array(pvb["v"])


def _planet_helio(name: str, tt: tuple[float, float]) -> tuple[np.ndarray, np.ndarray]:
    if name == "Earth":
        p, v, _ = _earth(tt)
        return p, v
    pv = erfa.plan94(tt[0], tt[1], _PLAN94[name])
    return np.array(pv["p"]), np.array(pv["v"])


def _apparent(geo: np.ndarray, tt: tuple[float, float]) -> np.ndarray:
    """Unit vector of a geocentric GCRS position (au) after annual aberration."""
    p, _, vb = _earth(tt)
    v = vb / C_AU_PER_DAY
    bm1 = math.sqrt(1 - float(v @ v))
    n = geo / np.linalg.norm(geo)
    return np.array(erfa.ab(n, v, float(np.linalg.norm(p)), bm1))


def _sun_geo(tt: tuple[float, float]) -> np.ndarray:
    return -_earth(tt)[0]


def _moon_geo(tt: tuple[float, float]) -> np.ndarray:
    return np.array(erfa.moon98(*tt)["p"])


def _planet_geo(name: str, tt: tuple[float, float]) -> np.ndarray:
    """Geocentric position of a planet as seen now: where it was a light time ago."""
    e = _earth(tt)[0]
    tau = 0.0
    for _ in range(3):
        p, _ = _planet_helio(name, (tt[0], tt[1] - tau))
        geo = p - e
        tau = float(np.linalg.norm(geo)) / C_AU_PER_DAY
    return geo


def _ecliptic_lon(vec: np.ndarray, tt: tuple[float, float], true: bool = True) -> float:
    """Ecliptic longitude of a GCRS vector, degrees: of date, true equinox (with nutation) or mean."""
    x, y, _ = np.array(erfa.ecm06(*tt)) @ vec
    lon = math.atan2(y, x) / DEG
    if true:
        dpsi, _ = erfa.nut06a(*tt)
        lon += dpsi / DEG
    return float(lon % 360)


def _sun_lon(tt: tuple[float, float]) -> float:
    return _ecliptic_lon(_apparent(_sun_geo(tt), tt), tt)


def _moon_lon(tt: tuple[float, float]) -> float:
    return _ecliptic_lon(_apparent(_moon_geo(tt), tt), tt)


def topocentric(geo_au: np.ndarray, dt: datetime, lat: float, lon: float, aberrate: bool = True) -> tuple[float, float, float]:
    """(altitude°, azimuth° from north, distance km) of a geocentric GCRS position seen from (lat, lon) at sea level."""
    ut1, tt = _two_part(dt)
    d_km = float(np.linalg.norm(geo_au)) * AU_KM
    direction = _apparent(geo_au, tt) if aberrate else geo_au / np.linalg.norm(geo_au)
    cirs = np.array(erfa.c2i06a(*tt)) @ (direction * d_km)
    era = float(erfa.era00(*ut1))
    c, s = math.cos(era), math.sin(era)
    tirs = np.array([c * cirs[0] + s * cirs[1], -s * cirs[0] + c * cirs[1], cirs[2]])
    obs = np.array(erfa.gd2gc(1, lon * DEG, lat * DEG, 0.0)) / 1000  # WGS84, km
    t = tirs - obs
    sl, cl, sp, cp = math.sin(lon * DEG), math.cos(lon * DEG), math.sin(lat * DEG), math.cos(lat * DEG)
    up = np.array([cp * cl, cp * sl, sp])
    east = np.array([-sl, cl, 0.0])
    north = np.array([-sp * cl, -sp * sl, cp])
    r = float(np.linalg.norm(t))
    alt = math.asin(max(-1.0, min(1.0, float(up @ t) / r))) / DEG
    az = math.atan2(float(east @ t), float(north @ t)) / DEG % 360
    return alt, az, r


# ── Searching in time ───────────────────────────────────────────────────────


def _tt(dt: datetime) -> tuple[float, float]:
    return _two_part(dt)[1]


def _bisect(f: Callable[[datetime], float], a: datetime, b: datetime, fa: float) -> datetime:
    for _ in range(40):
        m = a + (b - a) / 2
        fm = f(m)
        if (fa < 0) == (fm < 0):
            a, fa = m, fm
        else:
            b = m
        if b - a < timedelta(seconds=1):
            break
    return a + (b - a) / 2


def _next_root(f: Callable[[datetime], float], start: datetime, step: timedelta, limit: timedelta) -> datetime | None:
    """First upward or downward zero of f after `start` (f wrapped to (−180, 180] for angles)."""
    a, fa = start, f(start)
    t = start
    while t - start < limit:
        t = t + step
        ft = f(t)
        if (fa < 0) != (ft < 0) and abs(fa - ft) < 180:  # a real crossing, not the wrap from +180 to −180
            return _bisect(f, a, t, fa)
        a, fa = t, ft
    return None


def _wrap(x: float) -> float:
    return (x + 180) % 360 - 180


def _angle_event(angle: Callable[[tuple[float, float]], float], target: float, start: datetime, step: timedelta, limit: timedelta) -> datetime | None:
    return _next_root(lambda d: _wrap(angle(_tt(d)) - target), start, step, limit)


def _moon_minus_sun(tt: tuple[float, float]) -> float:
    return (_moon_lon(tt) - _sun_lon(tt)) % 360


SEASON_EVENTS = [(0, "March equinox"), (90, "June solstice"), (180, "September equinox"), (270, "December solstice")]
MOON_EVENTS = [(0, "New Moon"), (90, "First quarter"), (180, "Full Moon"), (270, "Last quarter")]


@lru_cache(maxsize=64)
def _season_events(hour_key: datetime) -> list[tuple[str, datetime]]:
    out = []
    for target, name in SEASON_EVENTS:
        t = _angle_event(_sun_lon, target, hour_key, timedelta(days=4), timedelta(days=370))
        if t:
            out.append((name, t))
    return sorted(out, key=lambda x: x[1])


@lru_cache(maxsize=64)
def _moon_events(hour_key: datetime) -> list[tuple[str, datetime]]:
    out = []
    for target, name in MOON_EVENTS:
        t = _angle_event(_moon_minus_sun, target, hour_key, timedelta(hours=12), timedelta(days=31))
        if t:
            out.append((name, t))
    return sorted(out, key=lambda x: x[1])


@lru_cache(maxsize=64)
def _last_new_moon(hour_key: datetime) -> datetime | None:
    """The new moon before `hour_key` (searched backwards over 31 days)."""
    start = hour_key - timedelta(days=31)
    best = None
    t = start
    while True:
        n = _angle_event(_moon_minus_sun, 0, t, timedelta(hours=12), hour_key - t)
        if n is None or n > hour_key:
            return best
        best = n
        t = n + timedelta(days=2)


def _extreme(f: Callable[[datetime], float], a: datetime, b: datetime, largest: bool) -> datetime:
    """Golden-section search for the extreme of f in [a, b], to the minute."""
    sign = -1 if largest else 1
    g = (math.sqrt(5) - 1) / 2
    c, d = b - (b - a) * g, a + (b - a) * g
    fc, fd = sign * f(c), sign * f(d)
    while b - a > timedelta(minutes=1):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - (b - a) * g
            fc = sign * f(c)
        else:
            a, c, fc = c, d, fd
            d = a + (b - a) * g
            fd = sign * f(d)
    return a + (b - a) / 2


def _earth_distance(dt: datetime) -> float:
    return float(np.linalg.norm(_earth(_tt(dt))[0]))


@lru_cache(maxsize=16)
def _apsides(year: int) -> dict[str, tuple[datetime, float]]:
    """Perihelion (early January) and aphelion (early July) of a calendar year: days sampled, then refined."""
    out = {}
    for name, centre, largest in (("perihelion", datetime(year, 1, 3, tzinfo=UTC), False), ("aphelion", datetime(year, 7, 4, tzinfo=UTC), True)):
        days = [centre + timedelta(days=k) for k in range(-12, 13)]
        vals = [_earth_distance(d) for d in days]
        i = int(np.argmax(vals) if largest else np.argmin(vals))
        t = _extreme(_earth_distance, days[max(0, i - 1)], days[min(len(days) - 1, i + 1)], largest)
        out[name] = (t, _earth_distance(t) * AU_KM)
    return out


def _rise_set(geo: Callable[[datetime], np.ndarray], radius_km: float, now: datetime, lat: float, lon: float) -> dict[str, datetime | None]:
    """The next rise and set after `now` (within 36 h): the upper limb on the standard horizon."""

    def above(d: datetime) -> float:
        alt, _, dist = topocentric(geo(d), d, lat, lon)
        return alt + 0.5667 + math.asin(min(1.0, radius_km / dist)) / DEG

    out: dict[str, datetime | None] = {"rise": None, "set": None}
    a, fa = now, above(now)
    t = now
    while t - now < timedelta(hours=36) and (out["rise"] is None or out["set"] is None):
        t = t + timedelta(minutes=10)
        ft = above(t)
        if (fa < 0) != (ft < 0):
            when = _bisect(above, a, t, fa)
            key = "rise" if fa < 0 else "set"
            if out[key] is None:
                out[key] = when
        a, fa = t, ft
    return out


# ── Reports ──────────────────────────────────────────────────────────────────


def _iso(d: datetime | None) -> str | None:
    return d.astimezone(UTC).isoformat().replace("+00:00", "Z") if d else None


def phase_name(elongation: float) -> str:
    """Moon phase from the Moon's longitude minus the Sun's (0 new, 180 full), in the usual eight names."""
    names = ["New Moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full Moon", "Waning gibbous", "Last quarter", "Waning crescent"]
    return names[int(((elongation % 360) + 22.5) // 45) % 8]


def earth_report(now: datetime, lat: float, lon: float) -> dict[str, Any]:
    now = _utc(now)
    ut1, tt = _two_part(now)
    p, v, _ = _earth(tt)
    key = now.replace(minute=0, second=0, microsecond=0)
    stellar_day_s = 86_400 / ERA_RATE
    obs = np.array(erfa.gd2gc(1, lon * DEG, lat * DEG, 0.0)) / 1000
    axis_km = math.hypot(obs[0], obs[1])
    eps = float(erfa.obl06(*tt) + erfa.nut06a(*tt)[1]) / DEG
    sun_lon = _sun_lon(tt)
    season_n = ["spring", "summer", "autumn", "winter"][int(sun_lon // 90) % 4]
    season_s = ["autumn", "winter", "spring", "summer"][int(sun_lon // 90) % 4]
    this, nxt = _apsides(now.year), _apsides(now.year + 1)
    apsides = {k: (this[k] if this[k][0] > now else nxt[k]) for k in ("perihelion", "aphelion")}
    helio_lon = _ecliptic_lon(p, tt, true=False)
    return {
        "rotationHours": stellar_day_s / 3600,
        "spinSpeedKmh": 2 * math.pi * axis_km / stellar_day_s * 3600,
        "axialTilt": eps,
        "distanceSunKm": float(np.linalg.norm(p)) * AU_KM,
        "distanceSunAu": float(np.linalg.norm(p)),
        "orbitalSpeedKms": float(np.linalg.norm(v)) * AU_KM / 86_400,
        "heliocentricLongitude": helio_lon,
        "sunLongitude": sun_lon,
        "lightMinutes": float(np.linalg.norm(p)) * LIGHT_S_PER_AU / 60,
        "season": {"north": season_n, "south": season_s},
        "events": [{"name": n, "at": _iso(t)} for n, t in _season_events(key)],
        "perihelion": {"at": _iso(apsides["perihelion"][0]), "distanceKm": apsides["perihelion"][1]},
        "aphelion": {"at": _iso(apsides["aphelion"][0]), "distanceKm": apsides["aphelion"][1]},
        "eraDegrees": float(erfa.era00(*ut1)) / DEG,
    }


def moon_report(now: datetime, lat: float, lon: float) -> dict[str, Any]:
    now = _utc(now)
    _, tt = _two_part(now)
    m, s = _moon_geo(tt), _sun_geo(tt)
    elong = _moon_minus_sun(tt)
    # Phase angle at the Moon between the Sun and the Earth; illuminated fraction (1 + cos i) / 2.
    to_sun, to_earth = s - m, -m
    i = math.acos(float(to_sun @ to_earth) / (float(np.linalg.norm(to_sun)) * float(np.linalg.norm(to_earth))))
    alt, az, dist = topocentric(m, now, lat, lon)
    key = now.replace(minute=0, second=0, microsecond=0)
    last_new = _last_new_moon(key)
    events = [(n, t) for n, t in _moon_events(key) if t > now]
    rs = _rise_set(lambda d: _moon_geo(_tt(d)), MOON_RADIUS_KM, now, lat, lon)
    nxt_new = next((t for n, t in _moon_events(key) if n == "New Moon"), None)
    return {
        "distanceKm": float(np.linalg.norm(m)) * AU_KM,
        "illuminationPct": (1 + math.cos(i)) / 2 * 100,
        "elongation": elong,
        "phase": phase_name(elong),
        "waxing": bool(elong < 180),
        "ageDays": (now - last_new).total_seconds() / 86_400 if last_new else None,
        "lastNewMoon": _iso(last_new),
        "lunationDays": ((nxt_new - last_new).total_seconds() / 86_400) if (nxt_new and last_new and nxt_new > last_new) else None,
        "events": [{"name": n, "at": _iso(t)} for n, t in events],
        "altitude": alt,
        "azimuth": az,
        "topocentricKm": dist,
        "rise": _iso(rs["rise"]),
        "set": _iso(rs["set"]),
        "moonLongitude": _moon_lon(tt),
        "sunLongitude": _sun_lon(tt),
    }


def planets_report(now: datetime, lat: float, lon: float) -> list[dict[str, Any]]:
    now = _utc(now)
    _, tt = _two_part(now)
    out = []
    for name in PLANETS:
        p, v = _planet_helio(name, tt)
        row: dict[str, Any] = {
            "name": name,
            "distanceSunAu": float(np.linalg.norm(p)),
            "orbitalSpeedKms": float(np.linalg.norm(v)) * AU_KM / 86_400,
            "heliocentricLongitude": _ecliptic_lon(p, tt, true=False),
        }
        if name != "Earth":
            geo = _planet_geo(name, tt)
            alt, az, _ = topocentric(geo, now, lat, lon)
            d = float(np.linalg.norm(geo))
            row |= {"distanceEarthAu": d, "lightMinutes": d * LIGHT_S_PER_AU / 60, "altitude": alt, "azimuth": az}
        out.append(row)
    return out


def sky_report(now: datetime, lat: float, lon: float) -> dict[str, Any]:
    from .planet_facts import FACTS, SOURCE

    sun_alt, sun_az, _ = topocentric(_sun_geo(_tt(now)), now, lat, lon)
    return {"at": _iso(_utc(now)), "earth": earth_report(now, lat, lon), "moon": moon_report(now, lat, lon), "planets": planets_report(now, lat, lon),
            "sun": {"altitude": sun_alt, "azimuth": sun_az}, "facts": FACTS, "factsSource": SOURCE}


def track(model: str, now: datetime) -> list[dict[str, Any]]:
    """Positions over time for the animated models: the Moon over a lunation (every 6 h), the Earth over a year
    (every 2 days), the planets over 12 years (every 30 days). Ecliptic longitudes in degrees, distances in au."""
    now = _utc(now).replace(minute=0, second=0, microsecond=0)
    rows: list[dict[str, Any]] = []
    if model == "moon":
        for k in range(0, 30 * 4 + 1):
            d = now + timedelta(hours=6 * k)
            tt = _tt(d)
            rows.append({"t": _iso(d), "moon": _moon_lon(tt), "sun": _sun_lon(tt), "dist": float(np.linalg.norm(_moon_geo(tt))) * AU_KM})
    elif model == "orbit":
        for k in range(0, 184):
            d = now + timedelta(days=2 * k)
            tt = _tt(d)
            p = _earth(tt)[0]
            rows.append({"t": _iso(d), "lon": _ecliptic_lon(p, tt, true=False), "dist": float(np.linalg.norm(p))})
    elif model == "system":
        for k in range(0, 12 * 12 + 1):
            d = now + timedelta(days=30 * k)
            tt = _tt(d)
            rows.append({"t": _iso(d), **{n: _ecliptic_lon(_planet_helio(n, tt)[0], tt, true=False) for n in PLANETS}})
    else:
        raise ValueError("The model is moon, orbit or system.")
    return rows
