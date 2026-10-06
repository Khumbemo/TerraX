"""Every tool through the API (eager jobs), with values checked against the TypeScript-era results."""

import json

import pytest


def sample(client, name):
    r = client.post("/api/samples", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def run(client, tool, inputs, params=None):
    job = client.post("/api/jobs", json={"tool": tool, "inputs": inputs, "params": params or {}}).json()
    assert job["state"] == "done", job.get("message")
    return job["result"]


def test_weather_table(client):
    res = run(client, "table", {"file": sample(client, "monthly_climate_1990_2024_synthetic.csv")})
    assert res["dataset"]["timeColumn"] == "date" and res["dataset"]["intervalDays"] == 31
    assert "Seasonal Kendall test on 420 monthly values" in res["markdown"]
    a = res["analyses"]["precipitation_mm"]
    assert len(a["climate"]["spi"]) == 4 and a["trend"]["n"] == 420
    assert "## Data sample" in res["extraContext"]


def test_satellite_index_and_preview(client):
    fid = sample(client, "satellite_4band_synthetic.tif")
    res = run(client, "raster", {"file": fid}, {"view": {"mode": "index", "index": "ndvi", "bands": {"red": 2, "nir": 3}}})
    ds = res["dataset"]
    assert ds["view"]["index"] == "ndvi" and -1 <= ds["stats"]["min"] <= ds["stats"]["max"] <= 1
    assert "Approximate NDVI cover" in res["markdown"]
    assert client.get(ds["preview"]["url"]).headers["content-type"] == "image/png"
    png = client.get(f"/api/rasters/{fid}/composite.png", params={"bands": "2,1,0"})
    assert png.status_code == 200 and png.content[:4] == b"\x89PNG"
    px = client.get(f"/api/rasters/{fid}/pixel", params={"col": 10, "row": 10, "width": ds["preview"]["width"], "height": ds["preview"]["height"]}).json()
    assert len(px["values"]) == 4 and px["lat"] is not None
    bad = run_err(client, "raster", {"file": fid}, {"view": {"mode": "index", "index": "evi", "bands": {"red": 2}}})
    assert "needs these bands assigned" in bad


def run_err(client, tool, inputs, params):
    job = client.post("/api/jobs", json={"tool": tool, "inputs": inputs, "params": params}).json()
    assert job["state"] == "error"
    return job["message"]


def test_series_trend(client):
    dates = ["2019-03-10", "2020-03-14", "2021-03-09", "2022-03-12", "2023-03-15", "2024-03-11"]
    ids = [sample(client, f"series_ndvi_{d}_synthetic.tif") for d in dates]
    res = run(client, "stack", {"files": ids}, {"index": "ndvi"})
    assert res["series"]["trend"]["n"] == 6 and "Trend (Mann–Kendall, n = 6)" in res["markdown"]


def test_survey_geojson_and_drawn(client):
    res = run(client, "survey", {"file": sample(client, "survey_plot_synthetic.geojson")})
    f = res["survey"]["features"][0]
    assert f["kind"] == "Polygon" and f["method"].startswith("geodesic")
    assert res["boundary"]["areaM2"] == pytest.approx(f["area"])
    drawn = run(client, "survey", {}, {"geojson": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[[94.1, 25.67], [94.1, 25.68], [94.11, 25.68], [94.11, 25.67], [94.1, 25.67]]]}}]}})
    # 0.01° × 0.01° at 25.675° N: meridian arc ≈ 1,107.8 m × parallel arc ≈ 1,003.9 m ≈ 1.1121 km².
    assert drawn["survey"]["features"][0]["area"] == pytest.approx(1.1121e6, rel=1e-3)


def test_carbon(client):
    res = run(client, "carbon", {"file": sample(client, "forest_capture_inventory_synthetic.csv")})
    assert res["carbon"]["format"] == "Forest-Capture"
    assert "| Above-ground biomass | 230.3 t/ha" in res["markdown"]


def test_terrain_hydrology_watershed_contours(client):
    dem = sample(client, "terrain_dem_synthetic.tif")
    t = run(client, "terrain", {"dem": dem})
    assert "Hypsometric integral" in t["markdown"] and t["suggestedInterval"] > 0
    h = run(client, "hydrology", {"dem": dem}, {"thresholdKm2": 0.5})
    assert h["flow"]["maxOrder"] == 2 and len(h["streams"]["features"]) == 42
    job_id = h["layer"].split("/")[3]
    ws = client.post(f"/api/terrain/{job_id}/watershed", json={"col": h["flow"]["width"] // 2, "row": h["flow"]["height"] - 5}).json()
    assert ws["cells"] > 1 and ws["areaM2"] > 0 and ws["geojson"]["features"]
    c = run(client, "contours", {"dem": dem}, {"interval": t["suggestedInterval"]})
    assert c["contours"]["lines"] == 23


def test_landcover(client):
    res = run(client, "landcover", {"file": sample(client, "satellite_4band_synthetic.tif")}, {"bands": [0, 1, 2, 3], "k": 4, "roles": {"red": 2, "nir": 3}})
    stats = res["landcover"]["stats"]
    assert [s["suggestion"] for s in stats] == ["Water", "Bare soil or built-up", "Dense vegetation", "Dense vegetation"]
    assert sum(s["share"] for s in stats) == pytest.approx(1)


def test_photo(client):
    res = run(client, "photo", {"photo": sample(client, "aerial_photo_synthetic.png")})
    assert res["photo"]["vegetationFraction"] == pytest.approx(0.776, abs=0.01)


def test_residential_geo(client):
    bnd = run(client, "survey", {"file": sample(client, "plot_boundary_synthetic.geojson")})["boundary"]
    dates = ["2019-02-10", "2021-02-14", "2024-02-08"]
    images = [{"file": sample(client, f"plot_{d}_synthetic.tif"), "label": f"Plot {d[:4]}", "date": d} for d in dates]
    res = run(client, "residential", {}, {"mode": "geo", "images": images, "boundary": bnd, "bufferM": 15})
    assert res["comparison"]["from"] == "Plot 2019" and len(res["timeline"]) == 2
    assert any(p["zone"] == "crossing" for p in res["comparison"]["patches"])
    assert res["downloads"] and client.get(res["downloads"][0]["url"]).json()["features"]


def test_terrain_and_raster_with_boundary(client):
    """Cells outside the boundary are no data; every layer must still render."""
    bnd = run(client, "survey", {"file": sample(client, "survey_plot_synthetic.geojson")})["boundary"]
    t = run(client, "terrain", {"dem": sample(client, "terrain_dem_synthetic.tif")}, {"boundary": bnd})
    assert "Limited to the analysis boundary" in t["markdown"]
    for url in t["layers"].values():
        assert client.get(url).status_code == 200
    h = run(client, "hydrology", {"dem": sample(client, "terrain_dem_synthetic.tif")}, {"boundary": bnd})
    assert h["flow"]["maxOrder"] >= 1 and "## Hydrology" in h["markdown"]
