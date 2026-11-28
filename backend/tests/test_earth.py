"""Live Earth layers (services/earth.py and /api/live/earth/*), on real responses recorded from each service
(tests/fixtures/earth/README.md lists them). The network is not used: fetching is replaced by the recordings."""

import json
from pathlib import Path

import pytest

from terrax.services import earth
from tests.test_accounts import _admin, new_client

FIX = Path(__file__).parent / "fixtures" / "earth"


def fx(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


def fxj(name: str):
    return json.loads(fx(name))


@pytest.fixture()
def app():
    from terrax.api.main import app as a

    return a


@pytest.fixture(autouse=True)
def _fresh():
    from terrax import site
    from terrax.api import live as api

    for c in (api._quake_cache, api._fire_cache, api._weather_cache, api._elev_cache):
        c.clear()
    yield
    site.update({k: None for k in site.KEYS}, "")


# ── USGS ──────────────────────────────────────────────────────────────────────


def test_quake_feeds_are_the_twenty_listed_by_the_usgs():
    assert len(earth.QUAKE_FEEDS) == 20
    assert earth.quake_url("2.5_day") == "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
    assert earth.quake_url("significant_month").endswith("/summary/significant_month.geojson")
    with pytest.raises(ValueError):
        earth.quake_url("../../etc")


def test_parse_the_real_usgs_feed():
    out = earth.parse_quakes(fxj("usgs_2.5_day.json"))
    assert out["title"] == "USGS Magnitude 2.5+ Earthquakes, Past Day"
    assert out["generated"] == 1795850618000
    assert out["count"] == 4
    by_id = {f["id"]: f for f in out["features"]}
    q = by_id["us6000ue2m"]
    # [longitude, latitude, depth in km] in the feed; the depth moves into the properties
    assert q["geometry"]["coordinates"] == [-103.8251, 31.9967]
    p = q["properties"]
    assert p["mag"] == 2.7 and p["magType"] == "ml" and p["depthKm"] == 8.254
    assert p["place"] == "34 km SE of Malaga, New Mexico"
    assert p["time"] == 1795849848993  # ms since the epoch, UTC
    assert p["alert"] is None and p["tsunami"] is False and p["status"] == "reviewed"
    assert p["url"] == "https://earthquake.usgs.gov/earthquakes/eventpage/us6000ue2m"
    # a magnitude sent as an integer, and a PAGER alert
    assert any(f["properties"]["alert"] == "green" for f in out["features"])
    assert all(isinstance(f["properties"]["mag"], float) for f in out["features"])
    mags = [f["properties"]["mag"] for f in out["features"]]
    assert mags == sorted(mags)  # strongest drawn last


def test_parse_quakes_rejects_other_documents_and_skips_bad_features():
    with pytest.raises(ValueError):
        earth.parse_quakes({"error": "x"})
    j = fxj("usgs_2.5_day.json")
    j["features"][0]["geometry"] = None
    j["features"][1]["properties"]["alert"] = "<script>"
    j["features"][1]["properties"]["url"] = "javascript:alert(1)"
    out = earth.parse_quakes(j)
    assert out["count"] == 3
    assert all(f["properties"]["alert"] in (None, "green") for f in out["features"])
    assert all(f["properties"]["url"] is None or f["properties"]["url"].startswith("https://") for f in out["features"])


def test_quakes_endpoint_caches_for_a_minute(client, monkeypatch):
    from terrax.services import live

    calls = []

    def fake(url, **kw):
        calls.append(url)
        return fxj("usgs_2.5_day.json")

    monkeypatch.setattr(live, "fetch_json", fake)
    r = client.get("/api/live/earth/quakes", params={"feed": "2.5_day"})
    assert r.status_code == 200 and r.json()["count"] == 4
    client.get("/api/live/earth/quakes", params={"feed": "2.5_day"})
    assert len(calls) == 1
    assert client.get("/api/live/earth/quakes", params={"feed": "nope"}).status_code == 400


# ── FIRMS ─────────────────────────────────────────────────────────────────────


def test_firms_url_follows_the_area_api_and_checks_its_parts():
    assert earth.firms_url("abcdef0123456789", "VIIRS_NOAA20_NRT", 2) == "https://firms.modaps.eosdis.nasa.gov/api/area/csv/abcdef0123456789/VIIRS_NOAA20_NRT/world/2"
    for bad in [("abcdef0123456789", "VIIRS_NOAA20_NRT", 6), ("abcdef0123456789", "VIIRS_NOAA20_NRT", 0), ("abcdef0123456789", "X", 1), ("short", "MODIS_NRT", 1), ("abc/../def0123", "MODIS_NRT", 1)]:
        with pytest.raises(ValueError):
            earth.firms_url(*bad)
    assert earth.firms_status_url("abcdef0123456789") == "https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=abcdef0123456789"
    assert earth.FIRMS_DEFAULT_SOURCE == "VIIRS_NOAA20_NRT"  # Suomi NPP stopped on 2 November 2026


def test_parse_real_viirs_csv():
    rows = earth.parse_firms_csv(fx("firms_viirs_noaa20.csv"))["rows"]
    assert len(rows) == 20
    lon, lat, frp, conf, when, dn = rows[0]
    # first data row: -1.51695,29.24614,297.61,0.47,0.48,2026-11-27,0000,N20,nominal,2.0NRT,271.42,0.6,N
    assert (lon, lat, frp, conf, when, dn) == (29.24614, -1.51695, 0.6, "nominal", "2026-11-27T00:00Z", "N")
    assert {r[3] for r in rows} == {"low", "nominal", "high"}
    assert {r[5] for r in rows} == {"D", "N"}


def test_parse_real_modis_csv_keeps_percent_confidence():
    rows = earth.parse_firms_csv(fx("firms_modis.csv"))["rows"]
    assert len(rows) == 10
    # 36.98157,126.69572,307.12,1.06,1.03,2026-11-27,0022,T,61,6.1NRT,286.08,9.84,D
    assert rows[0] == (126.69572, 36.98157, 9.84, 61, "2026-11-27T00:22Z", "D")
    assert all(isinstance(r[3], int) and 0 <= r[3] <= 100 for r in rows)


def test_a_header_only_file_is_no_fires_and_error_texts_are_errors():
    assert earth.parse_firms_csv(fx("firms_viirs_snpp_empty.csv"))["rows"] == []
    assert earth.firms_error(400, fx("firms_invalid_key.txt")) == "FIRMS refused the MAP_KEY: Invalid MAP_KEY."
    assert earth.firms_error(403, fx("firms_status_invalid.txt")).startswith("FIRMS refused the MAP_KEY: MAP_KEY is invalid")
    with pytest.raises(ValueError, match="MAP_KEY"):
        earth.parse_firms_csv(fx("firms_invalid_key.txt"))


def test_fires_in_view_wraps_and_keeps_the_strongest():
    rows = [(179.5, 0.0, 1.0, "low", "", "N"), (-179.5, 0.0, 50.0, "high", "", "D"), (10.0, 45.0, 5.0, "nominal", "", "D"), (10.0, 45.0, None, "nominal", "", "D")]
    hit, total = earth.fires_in_view(rows, 170, -5, 190, 5)  # across the antimeridian
    assert total == 2 and {r[0] for r in hit} == {179.5, -179.5}
    hit, total = earth.fires_in_view(rows, -180, -90, 180, 90, limit=2)
    assert total == 4 and [r[2] for r in hit] == [50.0, 5.0]
    assert earth.fires_in_view(rows, -540, -90, 540, 90)[1] == 4


def test_fires_need_a_key_and_the_key_never_reaches_a_browser(app, monkeypatch):
    from terrax.api import live as api

    anon = new_client(app)
    r = anon.get("/api/live/earth/fires")
    assert r.status_code == 409 and "Site settings" in r.json()["detail"]
    assert anon.get("/api/live/earth/status").json()["fires"]["available"] is False

    adm = _admin(app)
    assert adm.put("/api/admin/settings", json={"firmsMapKey": "not a key!"}).status_code == 400
    key = "0123456789abcdef0123456789abcdef"
    r = adm.put("/api/admin/settings", json={"firmsMapKey": key})
    assert r.status_code == 200 and r.json()["settings"]["firmsMapKey"] == {"set": True, "last4": "cdef"}
    got = adm.get("/api/admin/settings")
    assert key not in got.text and got.json()["settings"]["firmsMapKey"]["last4"] == "cdef"
    # sending the masked value back (as the form does with the rest of the settings) keeps the key
    adm.put("/api/admin/settings", json={"firmsMapKey": {"set": True, "last4": "cdef"}, "announcement": "hi"})
    assert adm.get("/api/admin/settings").json()["settings"]["firmsMapKey"]["set"] is True
    pub = anon.get("/api/site")
    assert key not in pub.text
    assert anon.get("/api/live/earth/status").json()["fires"]["available"] is True

    seen = []

    def fake_text(url, timeout=60.0):
        seen.append(url)
        return 200, fx("firms_viirs_noaa20.csv")

    monkeypatch.setattr(api, "_fetch_text", fake_text)
    r = anon.get("/api/live/earth/fires", params={"source": "VIIRS_NOAA20_NRT", "days": 1, "west": 28, "south": -3, "east": 31, "north": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert key not in r.text
    assert seen == [f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_NOAA20_NRT/world/1"]
    assert body["total"] == len(body["rows"]) > 0
    assert all(28 <= row[0] <= 31 and -3 <= row[1] <= 0 for row in body["rows"])
    anon.get("/api/live/earth/fires", params={"source": "VIIRS_NOAA20_NRT", "days": 1})
    assert len(seen) == 1  # the world file is cached and cut per view

    monkeypatch.setattr(api, "_fetch_text", lambda url, timeout=60.0: (400, fx("firms_invalid_key.txt")))
    r = anon.get("/api/live/earth/fires", params={"source": "MODIS_NRT", "days": 2})
    assert r.status_code == 502 and r.json()["detail"] == "FIRMS refused the MAP_KEY: Invalid MAP_KEY."
    assert key not in r.text
    adm.put("/api/admin/settings", json={"firmsMapKey": None})
    assert anon.get("/api/live/earth/fires").status_code == 409


def test_only_admins_check_a_key(app, monkeypatch):
    import httpx

    assert new_client(app).post("/api/admin/settings/firms-check", json={"key": "0123456789abcdef"}).status_code == 401
    adm = _admin(app)

    class Resp:
        def __init__(self, status, text):
            self.status_code, self.text = status, text

    class FakeClient:
        reply = Resp(403, fx("firms_status_invalid.txt"))

        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url):
            assert url.startswith("https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=")
            return FakeClient.reply

    monkeypatch.setattr(httpx, "Client", FakeClient)
    r = adm.post("/api/admin/settings/firms-check", json={"key": "0123456789abcdef"})
    assert r.json() == {"ok": False, "message": "MAP_KEY is invalid or your have exceeded your transaction/time limit. Please try again later."}
    # the documented JSON reply (no valid key was available to record one)
    FakeClient.reply = Resp(200, json.dumps({"transaction_limit": 5000, "current_transactions": 12, "transaction_interval": "10 minutes"}))
    r = adm.post("/api/admin/settings/firms-check", json={"key": "0123456789abcdef"})
    assert r.json() == {"ok": True, "limit": 5000, "used": 12, "interval": "10 minutes"}
    assert adm.post("/api/admin/settings/firms-check", json={}).status_code == 400  # nothing typed, nothing saved


# ── Open-Meteo ────────────────────────────────────────────────────────────────


def test_forecast_url_asks_for_ten_variables_at_most():
    url = earth.forecast_url([(52.52, 13.41), (-33.87, 151.21)])
    assert url.startswith("https://api.open-meteo.com/v1/forecast?latitude=52.5200%2C-33.8700&longitude=13.4100%2C151.2100&")
    assert len(earth.CURRENT_VARS) + len(earth.DAILY_VARS) <= 10
    assert "timezone=auto" in url and "forecast_days=1" in url


def test_parse_real_forecast_for_three_points():
    pts = [(52.52, 13.41), (-33.87, 151.21), (0.0, -30.0)]
    out = earth.parse_forecast(fxj("openmeteo_forecast_3.json"), pts)
    assert [(o["lat"], o["lon"]) for o in out] == pts
    berlin, sydney, sea = out
    assert berlin["timezone"] == "Europe/Berlin" and berlin["temperature"] == -0.1 and berlin["code"] == 2 and berlin["text"] == "Partly cloudy"
    assert (berlin["tMax"], berlin["tMin"], berlin["dayText"]) == (1.3, -2.4, "Overcast")
    assert berlin["units"] == {"temperature": "°C", "wind": "km/h", "precipitation": "mm"}
    assert sydney["dayCode"] == 95 and sydney["dayText"] == "Thunderstorm" and sydney["precipitation"] == 13.9 and sydney["precipitationProbability"] == 100
    assert sea["isDay"] is False and sea["dayText"] == "Light drizzle"
    # the reply in shuffled order still maps to the right point
    shuffled = list(reversed(fxj("openmeteo_forecast_3.json")))
    assert [o["timezone"] for o in earth.parse_forecast(shuffled, pts)] == [o["timezone"] for o in out]


def test_parse_real_single_forecast_and_errors():
    one = earth.parse_forecast(fxj("openmeteo_forecast_1.json"), [(52.52, 13.41)])
    assert one[0]["windDirection"] == 97
    with pytest.raises(ValueError, match="Daily API request limit exceeded"):
        earth.parse_forecast(fxj("openmeteo_daily_limit_429.json"), [(52.52, 13.41)])
    with pytest.raises(ValueError, match="answered 1 locations for 2"):
        earth.parse_forecast(fxj("openmeteo_forecast_1.json"), [(52.52, 13.41), (0, 0)])


def test_wmo_table_matches_the_docs():
    assert len(earth.WMO_CODES) == 29
    assert earth.WMO_CODES[48] == "Depositing rime fog" and earth.WMO_CODES[99] == "Thunderstorm with heavy hail"


def test_grid_is_bounded_shared_and_wraps():
    for view in [(-180, -85, 180, 85), (-540, -85, 540, 85), (10, 45, 12, 47), (170, -10, 190, 10), (-0.01, 51.5, 0.01, 51.51)]:
        step, pts = earth.grid_points(*view)
        assert 1 <= len(pts) <= earth.GRID_MAX_POINTS
        assert all(-90 < a < 90 and -180 <= b < 180 for a, b in pts)
        assert all(abs((a / step) - round(a / step - 0.5) - 0.5) < 1e-9 for a, _ in pts)  # cell centres on a shared lattice
    assert earth.grid_points(10, 45, 12, 47) == earth.grid_points(10.01, 45.02, 11.99, 46.98)
    with pytest.raises(ValueError):
        earth.grid_points(10, 5, 9, 6)


def test_weather_endpoint_fetches_only_missing_points(client, monkeypatch):
    from terrax.services import live

    asked = []

    def fake(url, **kw):
        from urllib.parse import parse_qs, urlparse

        q = parse_qs(urlparse(url).query)
        lats = q["latitude"][0].split(",")
        asked.append(len(lats))
        one = fxj("openmeteo_forecast_1.json")
        return [dict(one, location_id=i) for i in range(len(lats))] if len(lats) > 1 else one

    monkeypatch.setattr(live, "fetch_json", fake)
    view = {"west": 10, "south": 45, "east": 12, "north": 47}
    r = client.get("/api/live/earth/weather", params=view)
    assert r.status_code == 200, r.text
    n = len(r.json()["points"])
    assert asked == [n] and r.json()["step"] == 0.5
    client.get("/api/live/earth/weather", params=view)
    assert asked == [n]  # all cached
    monkeypatch.setattr(live, "fetch_json", lambda url, **kw: fxj("openmeteo_daily_limit_429.json"))
    r = client.get("/api/live/earth/weather", params={"west": 100, "south": 0, "east": 102, "north": 2})
    assert r.status_code == 502 and "Daily API request limit exceeded" in r.json()["detail"]


def test_real_elevation_reply_and_endpoint(client, monkeypatch):
    pts = [(27.98811, 86.92497), (52.52, 13.41), (0.0, -30.0)]
    assert earth.parse_elevation(fxj("openmeteo_elevation_3.json"), 3) == [8724.0, 38.0, 0.0]
    with pytest.raises(ValueError, match="Latitude must be in range"):
        earth.parse_elevation(fxj("openmeteo_error_400.json"), 1)
    assert earth.elevation_url(pts).startswith("https://api.open-meteo.com/v1/elevation?latitude=27.98811%2C52.52000%2C0.00000&longitude=")
    with pytest.raises(ValueError):
        earth.elevation_url([(95, 0)])

    from terrax.services import live

    calls = []
    monkeypatch.setattr(live, "fetch_json", lambda url, **kw: calls.append(url) or {"elevation": [8724.0]})
    r = client.get("/api/live/earth/elevation", params={"lat": 27.98811, "lon": 86.92497})
    assert r.json()["elevation"] == 8724.0 and "GLO-90" in r.json()["source"]
    client.get("/api/live/earth/elevation", params={"lat": 27.98811, "lon": 86.92497})
    assert len(calls) == 1
    # a longitude past 180 (a wrapped map) is brought back
    r = client.get("/api/live/earth/elevation", params={"lat": 27.98811, "lon": 86.92497 + 360})
    assert r.json()["lon"] == 86.925 and len(calls) == 1  # same rounded point, served from the cache
