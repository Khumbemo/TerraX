"""Solar geometry, Kp, live-data parsers, the Sentinel-2 window reader and the built-in maps."""

from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse

import numpy as np
import pytest
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin

from terrax.processing.table import read_table
from terrax.services import kp, live, solar, worldmaps

approx = pytest.approx
UTC = timezone.utc


def test_equation_of_time_and_declination_match_noaa():
    # Reference values from the NOAA Solar Calculator (±0.2 min, ±0.05°).
    assert solar.solar_angles(datetime(2026, 2, 11, 12, tzinfo=UTC)).equation_of_time == approx(-14.2, abs=0.3)
    assert solar.solar_angles(datetime(2026, 11, 3, 12, tzinfo=UTC)).equation_of_time == approx(16.45, abs=0.3)
    assert solar.solar_angles(datetime(2026, 6, 21, 12, tzinfo=UTC)).declination == approx(23.44, abs=0.05)
    assert solar.solar_angles(datetime(2026, 12, 21, 12, tzinfo=UTC)).declination == approx(-23.44, abs=0.05)
    r = solar.solar_report(datetime(2026, 3, 20, 6, 0, tzinfo=UTC), 25.674, 94.108)
    assert r.mean_solar_time == approx(6 + 94.108 / 15) and 0 <= r.azimuth < 360


def test_solar_matches_suncalc_reference():
    # Values from SunCalc 1.9 (the library the TypeScript app used) for the same instants.
    r = solar.solar_report(datetime(2026, 10, 6, 12, tzinfo=UTC), 51.5, -0.12)
    assert r.altitude == approx(33.397622822903635, abs=1e-9) and r.azimuth == approx(183.27040427909765, abs=1e-9)
    assert r.sunrise.isoformat().startswith("2026-10-06T06:09:59.43") and r.sunset.isoformat().startswith("2026-10-06T17:29:43.27")
    polar = solar.solar_report(datetime(2026, 12, 21, 23, tzinfo=UTC), 69.6, 18.9)
    assert polar.sunrise is None and polar.sunset is None
    assert solar.format_clock(24.26) == "00:15:36" and solar.format_clock(-1) == "23:00:00"


def test_kp_feed_formats():
    arrays = [["time_tag", "Kp", "a_running", "station_count"], ["2026-09-28 09:00:00.000", "2.33", "9", "8"], ["2026-09-28 12:00:00.000", "5.00", "48", "8"]]
    a = kp.parse_kp_feed(arrays)
    assert a.kp == 5 and a.time == datetime(2026, 9, 28, 12, tzinfo=UTC) and a.label == "G1 minor storm"
    assert kp.parse_kp_feed([{"time_tag": "2026-09-28T09:00:00", "Kp": 3.67}]).kp == 3.67
    assert kp.describe_kp(2.33) == "Quiet" and kp.parse_kp_feed([]) is None and kp.parse_kp_feed([["x"], [1]]) is None


def test_open_meteo_response_becomes_dated_table(tmp_path):
    q = parse_qs(urlparse(live.open_meteo_url(25.674, 94.108, "2024-01-01", "2024-01-03", ["precipitation_sum", "temperature_2m_mean"])).query)
    assert q["daily"] == ["precipitation_sum,temperature_2m_mean"]
    j = {
        "latitude": 25.68, "longitude": 94.1, "elevation": 1431,
        "daily_units": {"time": "iso8601", "precipitation_sum": "mm", "temperature_2m_mean": "°C"},
        "daily": {"time": ["2024-01-01", "2024-01-02", "2024-01-03"], "precipitation_sum": [0, 2.4, None], "temperature_2m_mean": [12.1, 11.8, 12.6]},
    }
    csv, note = live.open_meteo_to_csv(j)
    lines = csv.split("\n")
    assert lines[0] == "date,precipitation_sum (mm),temperature_2m_mean (°C)" and lines[1] == "2024-01-01,0,12.1" and lines[3] == "2024-01-03,,12.6"
    assert "ERA5" in note and "1431 m" in note
    p = tmp_path / "om.csv"
    p.write_text(csv, encoding="utf-8")
    ds = read_table(p)
    assert ds.time_column == "date" and len(ds.rows) == 3
    with pytest.raises(ValueError, match="invalid String value foo"):
        live.open_meteo_to_csv({"error": True, "reason": "Cannot initialize WeatherVariable from invalid String value foo"})
    with pytest.raises(ValueError, match="Latitude"):
        live.open_meteo_url(95, 0, "2024-01-01", "2024-01-02", ["precipitation_sum"])
    with pytest.raises(ValueError, match="start date"):
        live.open_meteo_url(0, 0, "2024-02-01", "2024-01-02", ["precipitation_sum"])
    with pytest.raises(ValueError, match="Unknown variable"):
        live.open_meteo_url(0, 0, "2024-01-01", "2024-01-02", ["x"])


def test_nasa_power_dates_units_and_fill():
    q = parse_qs(urlparse(live.power_url(25.674, 94.108, "2024-01-01", "2024-01-02", ["T2M", "PRECTOTCORR"])).query)
    assert q["start"] == ["20240101"] and q["community"] == ["AG"]
    j = {
        "geometry": {"coordinates": [94.108, 25.674, 1400]},
        "header": {"fill_value": -999},
        "properties": {"parameter": {"T2M": {"20240101": 11.2, "20240102": -999}, "PRECTOTCORR": {"20240101": 0.3, "20240102": 5.1}}},
        "parameters": {"T2M": {"units": "C"}, "PRECTOTCORR": {"units": "mm/day"}},
    }
    csv, note = live.power_to_csv(j)
    assert csv.split("\n") == ["date,T2M (C),PRECTOTCORR (mm/day)", "2024-01-01,11.2,0.3", "2024-01-02,,5.1"]
    assert "25.674°, 94.108°" in note
    with pytest.raises(ValueError, match="Invalid parameter"):
        live.power_to_csv({"errors": ["Invalid parameter"]})


def test_stac_items_scaling_and_search_body():
    body = live.stac_search_body([94, 25.6, 94.1, 25.7], "2024-01-01", "2024-03-31", 20)
    assert body["query"] == {"eo:cloud_cover": {"lt": 20}} and body["datetime"] == "2024-01-01T00:00:00Z/2024-03-31T23:59:59Z"
    items = live.parse_stac_items({
        "features": [
            {"id": "S2B", "properties": {"datetime": "2024-03-01T04:25:00Z", "eo:cloud_cover": 3.2, "proj:epsg": 32646, "s2:processing_baseline": "05.10"},
             "assets": {"red": {"href": "https://x/B04.tif", "raster:bands": [{"scale": 0.0001, "offset": -0.1}]}, "nir": {"href": "https://x/B08.tif"}}},
            {"id": "old", "properties": {"datetime": "2021-03-01T04:25:00Z", "proj:code": "EPSG:32646", "s2:processing_baseline": "02.14"}, "assets": {"red": {"href": "https://x/r.tif"}}},
        ]
    })
    assert items[0].epsg == 32646 and items[1].epsg == 32646 and items[1].cloud is None
    assert live.reflectance_transform(items[0], "red")[:2] == (0.0001, -0.1)
    assert live.reflectance_transform(items[0], "nir")[1] == -0.1  # baseline ≥ 04.00 without metadata
    assert live.reflectance_transform(items[1], "red")[1] == 0
    with pytest.raises(ValueError, match="unexpected"):
        live.parse_stac_items({"type": "nope"})
    with pytest.raises(ValueError, match="valid longitude"):
        live.stac_search_body([10, 5, 9, 6], "2024-01-01", "2024-01-02", 20)


def test_sentinel_window_from_local_cogs(tmp_path, monkeypatch):
    # 10 m bands: 200 × 200 px from (600000, 2850000); SCL: 100 × 100 px at 20 m.
    E0, N0 = 600000, 2850000

    def mk(name, w, res, f):
        data = np.fromfunction(lambda r, c: f(c, r), (w, w)).astype(np.uint16)
        p = tmp_path / f"{name}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=w, height=w, count=1, dtype="uint16", crs="EPSG:32646", transform=from_origin(E0, N0, res, res)) as d:
            d.write(data, 1)
        return str(p)

    files = {
        "blue": mk("blue", 200, 10, lambda c, r: 1500 + 0 * c),
        "green": mk("green", 200, 10, lambda c, r: 1800 + 0 * c),
        "red": mk("red", 200, 10, lambda c, r: 1000 + c),
        "nir": mk("nir", 200, 10, lambda c, r: 4000 + 0 * c),
        "scl": mk("scl", 100, 20, lambda c, r: np.where(c < 50, 4, 9)),
    }
    monkeypatch.setattr(live, "_allowed_href", lambda href: True)
    item = live.StacItem(id="T", datetime="2024-03-01T00:00:00Z", cloud=1.5, epsg=32646, assets={k: {"href": v} for k, v in files.items()}, processing_baseline="05.10")
    inv = Transformer.from_crs(32646, 4326, always_xy=True)
    lon_a, lat_a = inv.transform(E0 + 500, N0 - 1500)
    lon_b, lat_b = inv.transform(E0 + 1500, N0 - 500)
    out = tmp_path / "s2.tif"
    notes = live.read_s2_window(item, [lon_a, lat_a, lon_b, lat_b], out)
    with rasterio.open(out) as d:
        assert 100 <= d.width <= 103 and 100 <= d.height <= 103 and d.count == 5
        red, nir, scl = d.read(3), d.read(4), d.read(5)
        col0 = round((d.transform.c - E0) / 10)
        assert d.descriptions[3] == "nir (B8)"
    assert red[0, 0] == approx((1000 + col0) * 1e-4 - 0.1, abs=1e-6)
    assert nir[0, 0] == approx(0.3, abs=1e-6)
    switch = 100 - col0  # SCL changes from 4 to 9 at easting E0 + 1000 m
    assert scl[0, switch - 1] == 4 and scl[0, switch] == 9
    assert any("1000" in n for n in notes) and any("1.5 % cloud" in n for n in notes)
    monkeypatch.setattr(live, "S2_MAX_SIDE", 50)
    with pytest.raises(ValueError, match="pixels at 10 m; choose an area under"):
        live.read_s2_window(item, [lon_a, lat_a, lon_b, lat_b], tmp_path / "big.tif")


def test_sentinel_hrefs_are_restricted():
    assert live._allowed_href("https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/46/R/FQ/2024/3/x/B04.tif")
    assert not live._allowed_href("https://evil.example.com/B04.tif")
    assert not live._allowed_href("file:///etc/passwd")


def test_weather_endpoint_stores_csv(client, monkeypatch):
    j = {"latitude": 25.68, "longitude": 94.1, "elevation": 1431, "daily_units": {"precipitation_sum": "mm"}, "daily": {"time": ["2024-01-01", "2024-01-02"], "precipitation_sum": [0, 3.5]}}
    monkeypatch.setattr(live, "fetch_json", lambda url, **kw: j)
    r = client.post("/api/live/weather", json={"source": "open-meteo", "lat": 25.674, "lon": 94.108, "start": "2024-01-01", "end": "2024-01-02", "vars": ["precipitation_sum"]})
    assert r.status_code == 201, r.text
    f = r.json()["file"]
    assert f["kind"] == "table" and f["meta"]["timeColumn"] == "date" and f["meta"]["rowCount"] == 2
    bad = client.post("/api/live/weather", json={"source": "power", "lat": 99, "lon": 0, "start": "2024-01-01", "end": "2024-01-02", "vars": ["T2M"]})
    assert bad.status_code == 400 and "Latitude" in bad.json()["detail"]


def test_telemetry_endpoint(client, monkeypatch):
    from terrax.api import live as live_api

    monkeypatch.setattr(live, "fetch_json", lambda url, **kw: [["time_tag", "Kp"], ["2026-09-28 12:00:00.000", "4.33"]])
    live_api._kp_cache["at"] = 0.0
    t = client.get("/api/live/telemetry", params={"lat": 25.674, "lon": 94.108}).json()
    assert t["kp"]["reading"]["kp"] == 4.33 and t["kp"]["reading"]["label"] == "Active"
    assert -90 <= t["solar"]["altitude"] <= 90 and "subsolar" in t["solar"]
    s = client.get("/api/live/solar", params={"lat": 51.5, "lon": -0.12, "at": "2026-10-06T12:00:00Z"}).json()
    assert s["altitude"] == approx(33.3976, abs=1e-4) and s["sunrise"].startswith("2026-10-06T06:09")


def test_world_maps_helpers():
    assert worldmaps.obliquity_deg(datetime(2000, 1, 1, 12, tzinfo=UTC)) == approx(23.43928, abs=1e-5)
    assert worldmaps.mercator_pixel(0, 0, 4096) == (2048, 2048) and worldmaps.mercator_pixel(86, 0, 4096) is None
    assert worldmaps.plate_pair("AF-AN") == "Africa – Antarctica" and worldmaps.plate_pair("IN\\EU") == "India – Eurasia"
    assert worldmaps.cell_ids(80, 10, 100, 30) == ["5-1", "6-1"]
    assert worldmaps.cell_ids(170, -10, 190, 10) == ["0-1", "0-2", "7-1", "7-2"]  # wraps the antimeridian
    assert len(worldmaps.cell_ids(-180, -90, 180, 90)) == 32
    koppen = [k["rgb"] for k in worldmaps.KOPPEN]
    assert worldmaps.class_from_color(*koppen[7], 255, worldmaps.KOPPEN) == 8 and worldmaps.class_from_color(0, 0, 0, 0, worldmaps.KOPPEN) == 0


def test_maps_api(client):
    cat = client.get("/api/maps/catalog").json()
    assert cat["pictures"]["relief"]["maxZoom"] == 5 and cat["pictures"]["koppen"]["classes"] and len(cat["koppen"]) == 30
    t = client.get("/api/maps/tiles/relief/4/11/6")
    assert t.status_code == 200 and t.headers["content-type"] == "image/jpeg" and "immutable" in t.headers["cache-control"]
    assert client.get("/api/maps/tiles/koppen/2/2/1").content[:4] == b"\x89PNG"
    assert client.get("/api/maps/tiles/relief/2/9/0").status_code == 404
    assert client.get("/api/maps/tiles/nope/0/0/0").status_code == 404
    i = client.get("/api/maps/identify", params={"lat": -23.7, "lon": 133.9}).json()
    assert i["koppen"]["code"] == "BWh" and i["biome"]["name"] == "Deserts & xeric shrublands"
    d = client.get("/api/maps/detail", params={"west": 80, "south": 10, "east": 100, "north": 30, "layers": "borders,rivers"}).json()
    assert d["cells"] == ["5-1", "6-1"] and d["rivers"]["features"] and "land" not in d
    assert client.get("/api/maps/detail", params={"west": -180, "south": -90, "east": 180, "north": 90}).status_code == 400
    g = client.get("/api/maps/graticule").json()
    labels = [f["properties"]["label"] for f in g["features"] if f["properties"]["kind"] == "special"]
    assert labels[0] == "Equator" and labels[1].startswith("Tropic of Cancer 23.4")
    assert client.get("/api/maps/vector/plates").json()["features"]
