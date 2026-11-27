"""Solar geometry for the telemetry panel and the assistant.

The equation of time and the declination follow the NOAA Solar Calculator
(Meeus, *Astronomical Algorithms*). Altitude and azimuth come from the same
declination and the hour angle that the equation of time gives, and sunrise
and sunset are found by searching for the instant the sun's centre is at
−0.833° (which allows for refraction and the solar semi-diameter). Altitude
has no refraction correction.

Checked against astropy (IAU SOFA/ERFA) for 2000–2045 at the equator, Kohima,
Sydney, London and Tromsø: declination within 0.003°, equation of time within
about a second; see tests/test_services.py for the reference values.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

RAD = math.pi / 180
DAY_S = 86_400.0


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _unix(dt: datetime) -> float:
    return _utc(dt).timestamp()


def julian_century(dt: datetime) -> float:
    jd = _unix(dt) / DAY_S + 2440587.5
    return (jd - 2451545) / 36525


@dataclass
class SolarAngles:
    equation_of_time: float  # minutes (apparent − mean solar time)
    declination: float  # degrees


def solar_angles(dt: datetime) -> SolarAngles:
    T = julian_century(dt)
    L0 = math.fmod(280.46646 + T * (36000.76983 + T * 0.0003032), 360)
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    C = (
        math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
        + math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
        + math.sin(3 * M * RAD) * 0.000289
    )
    true_long = L0 + C
    omega = 125.04 - 1934.136 * T
    app_long = true_long - 0.00569 - 0.00478 * math.sin(omega * RAD)
    eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = eps0 + 0.00256 * math.cos(omega * RAD)
    declination = math.asin(math.sin(eps * RAD) * math.sin(app_long * RAD)) / RAD
    y = math.tan((eps / 2) * RAD) ** 2
    eot = (
        y * math.sin(2 * L0 * RAD)
        - 2 * e * math.sin(M * RAD)
        + 4 * e * y * math.sin(M * RAD) * math.cos(2 * L0 * RAD)
        - 0.5 * y * y * math.sin(4 * L0 * RAD)
        - 1.25 * e * e * math.sin(2 * M * RAD)
    )
    return SolarAngles(equation_of_time=(4 * eot) / RAD, declination=declination)


def utc_hours(dt: datetime) -> float:
    u = _utc(dt)
    return u.hour + u.minute / 60 + (u.second + u.microsecond / 1e6) / 3600


def format_clock(hours: float) -> str:
    """Hours of the day (any real number) as HH:MM:SS, wrapping at 24 h."""
    total = _js_round((((hours % 24) + 24) % 24) * 3600) % 86400
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


# ── Position and rise/set, from the same NOAA (Meeus) sun ──────────────────

def _hour_angle(dt: datetime, lon: float, eot_minutes: float) -> float:
    """Local hour angle of the sun, degrees (0 at local apparent noon, positive in the afternoon)."""
    return (utc_hours(dt) + lon / 15 + eot_minutes / 60 - 12) * 15


def sun_position(dt: datetime, lat: float, lon: float) -> tuple[float, float]:
    """(altitude, azimuth from north) in degrees: geometric (no refraction), from the NOAA declination and
    the hour angle given by the equation of time."""
    a = solar_angles(dt)
    phi, dec, H = lat * RAD, a.declination * RAD, _hour_angle(dt, lon, a.equation_of_time) * RAD
    alt = math.asin(max(-1.0, min(1.0, math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(H))))
    az = math.atan2(math.sin(H), math.cos(H) * math.sin(phi) - math.tan(dec) * math.cos(phi)) if abs(lat) < 90 else 0.0
    # atan2 gives the azimuth from south, positive westward → from north, clockwise.
    return alt / RAD, ((az / RAD + 180) % 360 + 360) % 360


def _solar_noon(dt: datetime, lon: float) -> datetime:
    """The local apparent noon nearest the given instant (UTC)."""
    day = _utc(dt).replace(hour=0, minute=0, second=0, microsecond=0)
    best = None
    for k in (-1, 0, 1):
        noon = day + timedelta(days=k, hours=12 - lon / 15)
        for _ in range(3):  # the equation of time changes by < 30 s a day: three steps settle it
            noon = day + timedelta(days=k, hours=12 - lon / 15 - solar_angles(noon).equation_of_time / 60)
        if best is None or abs((noon - dt).total_seconds()) < abs((best - dt).total_seconds()):
            best = noon
    assert best is not None
    return best


def _crossing(f, t0: datetime, t1: datetime) -> datetime | None:
    """The first instant in [t0, t1] where f changes sign: 6-minute steps, then bisection to under a second."""
    step = timedelta(minutes=6)
    a, fa = t0, f(t0)
    while a < t1:
        b = min(a + step, t1)
        fb = f(b)
        if (fa <= 0) != (fb <= 0):
            for _ in range(20):  # 6 min / 2^20 ≪ 1 s
                m = a + (b - a) / 2
                fm = f(m)
                if (fa <= 0) != (fm <= 0):
                    b, fb = m, fm
                else:
                    a, fa = m, fm
            return a + (b - a) / 2
        a, fa = b, fb
    return None


def sun_times(dt: datetime, lat: float, lon: float, altitude: float = -0.833) -> tuple[datetime | None, datetime | None]:
    """Sunrise and sunset of the solar day nearest the given instant: when the sun's centre crosses `altitude`
    (−0.833°: refraction and the semi-diameter). None when it does not cross that altitude that day (polar night
    or midnight sun)."""
    noon = _solar_noon(dt, lon)

    def above(t: datetime) -> float:
        return sun_position(t, lat, lon)[0] - altitude

    rise = _crossing(above, noon - timedelta(hours=12), noon)
    sset = _crossing(above, noon, noon + timedelta(hours=12))
    if rise is None or sset is None:
        return None, None
    return rise, sset


@dataclass
class SolarReport:
    mean_solar_time: float
    apparent_solar_time: float
    equation_of_time: float
    declination: float
    altitude: float
    zenith: float
    azimuth: float
    sunrise: datetime | None
    sunset: datetime | None
    subsolar_lat: float
    subsolar_lon: float

    def public(self) -> dict:
        iso = lambda d: d.isoformat().replace("+00:00", "Z") if d else None
        return {
            "meanSolarTime": self.mean_solar_time,
            "apparentSolarTime": self.apparent_solar_time,
            "equationOfTime": self.equation_of_time,
            "declination": self.declination,
            "altitude": self.altitude,
            "zenith": self.zenith,
            "azimuth": self.azimuth,
            "sunrise": iso(self.sunrise),
            "sunset": iso(self.sunset),
            "subsolar": {"lat": self.subsolar_lat, "lon": self.subsolar_lon},
        }


def solar_report(dt: datetime, lat: float, lon: float) -> SolarReport:
    ang = solar_angles(dt)
    h = utc_hours(dt)
    mean = h + lon / 15
    alt, az = sun_position(dt, lat, lon)
    rise, sset = sun_times(dt, lat, lon)
    sub_lon = math.fmod(-15 * (h - 12 + ang.equation_of_time / 60) + 540, 360) - 180
    return SolarReport(
        mean_solar_time=mean,
        apparent_solar_time=mean + ang.equation_of_time / 60,
        equation_of_time=ang.equation_of_time,
        declination=ang.declination,
        altitude=alt,
        zenith=90 - alt,
        azimuth=az,
        sunrise=rise,
        sunset=sset,
        subsolar_lat=ang.declination,
        subsolar_lon=sub_lon,
    )


def day_length_minutes(rise: datetime | None, sset: datetime | None) -> int | None:
    if not rise or not sset:
        return None
    return _js_round((sset - rise) / timedelta(minutes=1))
