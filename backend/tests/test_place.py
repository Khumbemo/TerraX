"""The map's place card: coordinates, nearest places, climate zone, biome and the sun, checked against independent
calculations (pyproj's geodesics on the WGS84 ellipsoid and the solar tests' reference values)."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from pyproj import Geod

from terrax.services import place


def test_coordinates_in_three_forms():
    assert place.dms(25.674, "N", "S") == "25°40′26.4″N"
    assert place.dms(-0.5, "N", "S") == "0°30′00.0″S"
    assert place.dms(94.99999, "E", "W") == "95°00′00.0″E"  # 59.96″ carries over, not 60.0″
    u = place.utm(25.674, 94.108)
    assert u and u["zone"] == 46 and u["hemisphere"] == "N"
    from terrax.processing.survey import _utm_label

    assert u["label"] == _utm_label(25.674, 94.108)
    assert place.utm(85, 0) is None and place.utm(-81, 0) is None  # outside UTM's range
    assert place.wrap_lon(200) == -160 and place.wrap_lon(-190) == 170


def test_nearest_places_agree_with_ellipsoidal_geodesics():
    geod = Geod(ellps="WGS84")
    for lat, lon in [(25.674, 94.108), (51.5, -0.12), (-33.9, 18.4), (64.1, -21.9), (-12.0, -77.0)]:
        near = place.nearest_places(lat, lon)
        assert len(near) == 3 and near[0]["distanceKm"] <= near[1]["distanceKm"] <= near[2]["distanceKm"]
        for p in near:
            az, _, dist_m = geod.inv(p["lon"], p["lat"], lon, lat)
            # The sphere is within 0.5 % of the ellipsoid in distance; bearings agree within a degree away from the place.
            assert abs(p["distanceKm"] - dist_m / 1000) <= max(0.005 * dist_m / 1000, 0.2), (p, dist_m)
            if dist_m > 5000:
                assert abs((p["bearing"] - az % 360 + 180) % 360 - 180) <= 1.0, (p, az)
    kohima = place.nearest_places(25.674, 94.108)[0]
    assert kohima["name"] == "Kohima" and kohima["distanceKm"] < 5


def test_sun_today_and_polar_day_and_night():
    s = place.sun_today(51.5074, -0.1278, datetime(2026, 10, 6, 12, tzinfo=UTC))
    assert s["sunrise"].startswith("2026-10-06T06:0") and s["sunset"].startswith("2026-10-06T17:") and s["polar"] is None
    assert place.sun_today(69.65, 18.96, datetime(2026, 12, 21, 12, tzinfo=UTC))["polar"] == "night"
    assert place.sun_today(69.65, 18.96, datetime(2026, 6, 21, 12, tzinfo=UTC))["polar"] == "day"


@pytest.fixture()
def client():
    from terrax.api.main import app

    return TestClient(app)


def test_place_endpoint(client):
    r = client.get("/api/maps/place", params={"lat": 25.674, "lon": 94.108})
    assert r.status_code == 200
    d = r.json()
    assert d["nearest"][0]["name"] == "Kohima" and d["utm"]["zone"] == 46 and d["dms"].startswith("25°40′26.4″N")
    assert d["koppen"] and d["koppen"]["code"].startswith("C")  # Kohima is subtropical highland (Cwa/Cwb)
    assert d["biome"] and d["sun"]["sunrise"] and "Beck et al. 2018" in d["sources"]["koppen"]
    sea = client.get("/api/maps/place", params={"lat": 0, "lon": -140}).json()
    assert sea["koppen"] is None and sea["nearest"][0]["distanceKm"] > 500
    assert client.get("/api/maps/place", params={"lat": 95, "lon": 0}).status_code == 422
