"""The live Earth layers against the real services: USGS, NASA FIRMS and Open-Meteo.

Run with TERRAX_LIVE=1 (the "Live data" workflow does). The FIRMS Area API is tested only when TERRAX_FIRMS_MAP_KEY
holds a real key (a repository secret in the workflow); without one, the test checks how FIRMS refuses a wrong key and
that its public 24-hour file still has the columns the parser reads.
"""

import os

import httpx
import pytest

from terrax.services import earth
from terrax.services.live import USER_AGENT

pytestmark = pytest.mark.skipif(os.environ.get("TERRAX_LIVE") != "1", reason="live services: set TERRAX_LIVE=1")


@pytest.fixture(autouse=True)
def _fresh():
    from terrax.api import live as api

    for c in (api._quake_cache, api._fire_cache, api._weather_cache, api._elev_cache):
        c.clear()


def test_usgs_feed(client):
    r = client.get("/api/live/earth/quakes", params={"feed": "4.5_week"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["title"] == "USGS Magnitude 4.5+ Earthquakes, Past Week"
    assert j["count"] > 0  # every week has M4.5+ events somewhere
    for f in j["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"]
        assert -180 <= lon <= 180 and -90 <= lat <= 90
        assert p["time"] is None or p["time"] > 1_600_000_000_000  # ms since the epoch
        assert p["depthKm"] is None or -10 <= p["depthKm"] <= 1000


def test_open_meteo_weather_grid_and_elevation(client):
    r = client.get("/api/live/earth/weather", params={"west": 10, "south": 45, "east": 12, "north": 47})
    assert r.status_code == 200, r.text
    pts = r.json()["points"]
    assert len(pts) == 16 and r.json()["error"] is None
    for p in pts:
        assert p["units"]["temperature"] == "°C" and p["units"]["wind"] == "km/h" and p["units"]["precipitation"] == "mm"
        assert -60 < p["temperature"] < 60 and p["tMin"] <= p["tMax"]
        assert p["code"] in earth.WMO_CODES and p["dayCode"] in earth.WMO_CODES
        assert abs(p["gridLat"] - p["lat"]) < 0.5 and abs(p["gridLon"] - p["lon"]) < 0.5
    # Everest's summit: 8724 m when recorded (a 90 m cell averages below the peak).
    r = client.get("/api/live/earth/elevation", params={"lat": 27.98811, "lon": 86.92497})
    assert r.status_code == 200, r.text  # a shared address can hit Open-Meteo's free daily limit (HTTP 429)
    e = r.json()["elevation"]
    assert 8000 < e < 8900


def test_firms_public_file_has_the_parsed_columns():
    url = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv"
    with httpx.Client(timeout=120, headers={"User-Agent": USER_AGENT}) as c:
        r = c.get(url)
    assert r.status_code == 200
    rows = earth.parse_firms_csv(r.text)["rows"]
    assert len(rows) > 100  # thousands on any day
    assert {row[3] for row in rows} <= {"low", "nominal", "high"}
    assert {row[5] for row in rows} <= {"D", "N"}


def test_firms_refuses_a_wrong_key():
    with httpx.Client(timeout=60, headers={"User-Agent": USER_AGENT}) as c:
        r = c.get(earth.firms_url("INVALIDKEY000", "VIIRS_NOAA20_NRT", 1))
    assert earth.firms_error(r.status_code, r.text) == "FIRMS refused the MAP_KEY: Invalid MAP_KEY."


@pytest.mark.skipif(not os.environ.get("TERRAX_FIRMS_MAP_KEY"), reason="needs a real FIRMS MAP_KEY in TERRAX_FIRMS_MAP_KEY")
def test_firms_area_api_with_a_real_key(client):
    r = client.get("/api/live/earth/fires", params={"source": "VIIRS_NOAA20_NRT", "days": 1})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["total"] > 100
    lon, lat, frp, conf, when, dn = j["rows"][0]
    assert frp is None or frp >= 0
    assert -180 <= lon <= 180 and -90 <= lat <= 90 and conf in ("low", "nominal", "high") and dn in ("D", "N")
    assert when.endswith("Z") and len(when) == 17
