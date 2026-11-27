"""The telemetry panel's sky models (services/sky.py): checked against astropy 8.0 (IAU SOFA/ERFA, its own coordinate
pipeline) and NASA's Planetary Fact Sheet."""

from datetime import UTC, datetime

import pytest

from terrax.services import planet_facts, sky

KOHIMA = (25.674, 94.108)


def test_equinoxes_and_solstices_match_astropy():
    # Instants when astropy's apparent geocentric solar longitude (true ecliptic of date) is 270, 0, 90 and 180°.
    ref = {"December solstice": datetime(2026, 12, 21, 20, 50, 13, tzinfo=UTC), "March equinox": datetime(2027, 3, 20, 20, 24, 41, tzinfo=UTC),
           "June solstice": datetime(2027, 6, 21, 14, 10, 50, tzinfo=UTC), "September equinox": datetime(2027, 9, 23, 6, 1, 43, tzinfo=UTC)}
    got = dict(sky._season_events(datetime(2026, 11, 27, tzinfo=UTC)))
    assert set(got) == set(ref)
    for name, when in ref.items():
        assert abs((got[name] - when).total_seconds()) < 5, name


def test_positions_seen_from_kohima_match_astropy():
    # astropy AltAz (no refraction) for 10 Jan 2026 14:00 UTC; TerraX agrees to a few arcsec (Moon: ~20″, the Moon
    # model's own documented error).
    import astropy.units as u
    from astropy.coordinates import AltAz, EarthLocation, get_body, solar_system_ephemeris
    from astropy.time import Time
    from astropy.utils import iers

    iers.conf.auto_download = False
    iers.conf.iers_degraded_accuracy = "ignore"
    solar_system_ephemeris.set("builtin")
    dt = datetime(2026, 1, 10, 14, tzinfo=UTC)
    loc = EarthLocation.from_geodetic(KOHIMA[1] * u.deg, KOHIMA[0] * u.deg, 0 * u.m)
    frame = AltAz(obstime=Time(dt), location=loc, pressure=0 * u.hPa)
    _, tt = sky._two_part(dt)
    for body, geo, tol in (("sun", sky._sun_geo(tt), 10), ("moon", sky._moon_geo(tt), 40), ("jupiter", sky._planet_geo("Jupiter", tt), 10)):
        ref = get_body(body, Time(dt), loc).transform_to(frame)
        alt, az, _ = sky.topocentric(geo, dt, *KOHIMA)
        assert alt == pytest.approx(ref.alt.deg, abs=tol / 3600), body
        assert ((az - ref.az.deg + 180) % 360 - 180) * abs(__import__("math").cos(ref.alt.radian)) == pytest.approx(0, abs=tol / 3600), body


def test_moon_phase_and_events_are_consistent():
    m = sky.moon_report(datetime(2026, 11, 27, 12, tzinfo=UTC), *KOHIMA)
    assert m["phase"] == "Waning gibbous" and not m["waxing"] and 80 < m["illuminationPct"] < 95
    assert 17 < m["ageDays"] < 19.5 and 29.2 < m["lunationDays"] < 29.9  # a lunation is 29.27–29.83 days
    assert 356_000 < m["distanceKm"] < 407_000  # between perigee and apogee
    assert [e["name"] for e in m["events"]] == ["Last quarter", "New Moon", "First quarter", "Full Moon"]
    assert m["rise"] and m["set"]
    full = sky.moon_report(datetime(2026, 12, 24, 1, 28, tzinfo=UTC), *KOHIMA)
    assert full["illuminationPct"] > 99 and full["phase"] == "Full Moon"


def test_earth_orbit_and_rotation():
    e = sky.earth_report(datetime(2026, 11, 27, 12, tzinfo=UTC), *KOHIMA)
    # The stellar day (rotation relative to the stars) from the IAU 2000 Earth rotation rate: 86164.0989 s.
    assert e["rotationHours"] * 3600 == pytest.approx(86_400 / 1.00273781191135448, abs=1e-6) == pytest.approx(86_164.0989, abs=1e-4)
    assert e["spinSpeedKmh"] == pytest.approx(1674.4 * 0.9016, rel=0.003)  # 1674 km/h at the equator × cos(25.67°)
    assert 23.43 < e["axialTilt"] < 23.45 and e["season"] == {"north": "autumn", "south": "spring"}
    assert e["perihelion"]["at"].startswith("2027-01-0") and 147.0e6 < e["perihelion"]["distanceKm"] < 147.2e6
    assert e["aphelion"]["at"].startswith("2027-07-0") and 152.0e6 < e["aphelion"]["distanceKm"] < 152.2e6
    assert 29.2 < e["orbitalSpeedKms"] < 30.3


def test_planets_and_the_nasa_fact_sheet():
    rows = {p["name"]: p for p in sky.planets_report(datetime(2026, 11, 27, 12, tzinfo=UTC), *KOHIMA)}
    assert list(rows) == sky.PLANETS
    # Each planet stays between NASA's perihelion and aphelion (10^6 km).
    for name, p in rows.items():
        f = planet_facts.FACTS[name]
        assert f["perihelion"] * 0.995 <= p["distanceSunAu"] * sky.AU_KM / 1e6 <= f["aphelion"] * 1.005, name
    assert rows["Saturn"]["lightMinutes"] == pytest.approx(rows["Saturn"]["distanceEarthAu"] * 8.3168, rel=1e-3)
    # The fact sheet as printed (spot checks against the source).
    assert planet_facts.FACTS["Venus"]["rotationPeriod"] == -5832.5 and planet_facts.FACTS["Uranus"]["obliquity"] == 97.8
    assert planet_facts.FACTS["Saturn"]["moons"] == 274 and planet_facts.FACTS["Jupiter"]["surfacePressure"] is None


def test_sky_endpoints(client):
    r = client.get("/api/live/sky", params={"lat": KOHIMA[0], "lon": KOHIMA[1], "at": "2026-11-27T12:00:00Z"}).json()
    assert {"earth", "moon", "planets", "sun", "facts", "factsSource", "factLabels"} <= set(r)
    assert r["factsSource"]["url"].startswith("https://nssdc.gsfc.nasa.gov")
    for model, n in (("moon", 121), ("orbit", 184), ("system", 145)):
        t = client.get("/api/live/sky/track", params={"model": model, "at": "2026-11-27T12:00:00Z"}).json()["track"]
        assert len(t) == n
    assert client.get("/api/live/sky/track", params={"model": "galaxy"}).status_code == 422
