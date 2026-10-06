"""Solar geometry for the telemetry panel and the assistant.

The equation of time and the declination follow the NOAA Solar Calculator
(Meeus, *Astronomical Algorithms*). Accuracy is well under a minute of time
and 0.01° of declination for current dates. Altitude, azimuth and the
sunrise and sunset times use the formulas of aa.quae.nl, as SunCalc does.
Sunrise and sunset use an altitude of −0.833°, which allows for refraction
and the solar semi-diameter. Altitude has no refraction correction.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

RAD = math.pi / 180
DAY_S = 86_400.0
J1970 = 2440588
J2000 = 2451545


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


# ── Position and rise/set (aa.quae.nl formulas, as in SunCalc) ───────────────

_E = RAD * 23.4397  # obliquity of the ecliptic
_J0 = 0.0009


def _to_days(dt: datetime) -> float:
    return _unix(dt) / DAY_S - 0.5 + J1970 - J2000


def _from_julian(j: float) -> datetime:
    return datetime.fromtimestamp((j + 0.5 - J1970) * DAY_S, tz=UTC)


def _mean_anomaly(d: float) -> float:
    return RAD * (357.5291 + 0.98560028 * d)


def _ecliptic_longitude(M: float) -> float:
    C = RAD * (1.9148 * math.sin(M) + 0.02 * math.sin(2 * M) + 0.0003 * math.sin(3 * M))
    return M + C + RAD * 102.9372 + math.pi


def _declination(L: float) -> float:
    return math.asin(math.sin(_E) * math.sin(L))


def _right_ascension(L: float) -> float:
    return math.atan2(math.sin(L) * math.cos(_E), math.cos(L))


def sun_position(dt: datetime, lat: float, lon: float) -> tuple[float, float]:
    """(altitude, azimuth from north) in degrees."""
    lw, phi, d = RAD * -lon, RAD * lat, _to_days(dt)
    L = _ecliptic_longitude(_mean_anomaly(d))
    dec, ra = _declination(L), _right_ascension(L)
    H = RAD * (280.16 + 360.9856235 * d) - lw - ra
    az = math.atan2(math.sin(H), math.cos(H) * math.sin(phi) - math.tan(dec) * math.cos(phi))
    alt = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(H))
    # Measured from south, positive westward → from north, clockwise.
    return alt / RAD, ((az / RAD + 180) % 360 + 360) % 360


def sun_times(dt: datetime, lat: float, lon: float, altitude: float = -0.833) -> tuple[datetime | None, datetime | None]:
    """Sunrise and sunset nearest the given instant; None when the sun does not cross that altitude."""
    lw, phi, d = RAD * -lon, RAD * lat, _to_days(dt)
    n = math.floor(d - _J0 - lw / (2 * math.pi) + 0.5)  # JavaScript Math.round
    ds = _J0 + lw / (2 * math.pi) + n
    M = _mean_anomaly(ds)
    L = _ecliptic_longitude(M)
    dec = _declination(L)
    j_noon = J2000 + ds + 0.0053 * math.sin(M) - 0.0069 * math.sin(2 * L)
    cos_w = (math.sin(altitude * RAD) - math.sin(phi) * math.sin(dec)) / (math.cos(phi) * math.cos(dec))
    if not -1 <= cos_w <= 1:
        return None, None
    w = math.acos(cos_w)
    a = _J0 + (w + lw) / (2 * math.pi) + n
    j_set = J2000 + a + 0.0053 * math.sin(M) - 0.0069 * math.sin(2 * L)
    j_rise = j_noon - (j_set - j_noon)
    return _from_julian(j_rise), _from_julian(j_set)


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
