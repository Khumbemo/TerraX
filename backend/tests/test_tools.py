"""Every tool through the API (eager jobs), with values checked against the TypeScript-era results."""


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
    # D∞ adds a wetness layer; the D8 stream network and its numbers stay the same.
    d = run(client, "hydrology", {"dem": dem}, {"thresholdKm2": 0.5, "method": "dinf"})
    assert d["method"] == "dinf" and d["flow"] == h["flow"] and len(d["streams"]["features"]) == 42
    w = d["wetness"]["summary"]
    assert w["q1"] < w["median"] < w["q3"] and client.get(d["wetness"]["layer"]).status_code == 200
    assert "Topographic wetness index" in d["markdown"] and h["wetness"] is None
    assert "D8 or D∞" in run_err(client, "hydrology", {"dem": dem}, {"method": "mfd"})


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


def test_map_streams_keeps_whole_highest_orders_within_the_budget():
    from terrax.tools.terrain import MAP_STREAM_POINTS, map_streams

    def line(order, n):
        return {"type": "Feature", "properties": {"strahler": order}, "geometry": {"type": "LineString", "coordinates": [[0.0, 0.0]] * n}}

    small = {"type": "FeatureCollection", "features": [line(1, 10), line(2, 5)]}
    assert map_streams(small) == (small, None)
    fc, note = map_streams({"type": "FeatureCollection", "features": [line(1, MAP_STREAM_POINTS), line(2, 40), line(3, 5)]})
    assert [f["properties"]["strahler"] for f in fc["features"]] == [2, 3] and note and "order 2 and above (2 of 3 lines)" in note
    fc, note = map_streams({"type": "FeatureCollection", "features": [line(4, MAP_STREAM_POINTS + 1)]})
    assert fc["features"] == [] and note and "too large to draw" in note


def test_landcover_random_forest_sample_and_accuracy(client):
    """Train on the sample shapes, draw a stratified sample, label it from the scene's true geometry, estimate accuracy."""
    import csv
    import io

    img = sample(client, "satellite_4band_synthetic.tif")
    shapes = sample(client, "landcover_training_synthetic.geojson")
    res = run(client, "landcover", {"file": img, "training": shapes}, {"method": "rf", "bands": [0, 1, 2, 3], "roles": {"red": 2, "nir": 3}})
    lc = res["landcover"]
    assert res["labels"] == ["Built-up", "Forest", "Water"] and lc["method"] == "rf" and lc["validation"]["overall"] > 0.95
    assert "Cross-validation by training shape" in res["markdown"]
    job_id = res["map"]["image"]["url"].split("/")[3]
    s = client.post(f"/api/landcover/{job_id}/sample", json={"total": 150, "minPerClass": 30}).json()
    assert s["points"] == 150 and [a["n"] >= 30 for a in s["allocation"]] == [True] * 3 and s["unit"] == "ha"
    gj = client.get(s["downloads"][0]["url"]).json()
    assert len(gj["features"]) == 150 and gj["features"][0]["properties"]["reference"] == ""
    rows = list(csv.DictReader(io.StringIO(client.get(s["downloads"][1]["url"]).text)))

    def truth(r: int, c: int) -> str:  # scripts/make_samples.py: river, town, forest
        x, y = c + 0.5, r + 0.5
        return "Water" if abs(x - 60 - y * 0.2) < 4 else "Built-up" if (x - 200) ** 2 + (y - 40) ** 2 < 22**2 else "Forest"

    for row in rows:
        row["reference"] = truth(int(row["row"]), int(row["col"]))
    rows[0]["reference"] = ""  # one point left unlabelled
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    up = client.post("/api/files", files={"file": ("labelled.csv", buf.getvalue().encode(), "text/csv")}).json()
    a = client.post(f"/api/landcover/{job_id}/accuracy", json={"file": up["id"]}).json()
    assert a["samples"] == 149 and a["unlabelled"] == 1 and a["overallAccuracy"] > 0.9
    total_ha = 240 * 200 * 0.09
    assert sum(c["area"] for c in a["classes"]) == pytest.approx(total_ha, rel=1e-9)
    water = next(c for c in a["classes"] if c["label"] == "Water")
    true_water = sum(truth(r, c) == "Water" for r in range(200) for c in range(240)) * 0.09
    assert abs(water["area"] - true_water) <= water["areaCi"] * 1.5
    assert "## Accuracy and area (stratified sample)" in a["markdown"]
    # Labels outside the legend are refused with the allowed names.
    rows[1]["reference"] = "Swamp"
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    up = client.post("/api/files", files={"file": ("bad.csv", buf.getvalue().encode(), "text/csv")}).json()
    bad = client.post(f"/api/landcover/{job_id}/accuracy", json={"file": up["id"]})
    assert bad.status_code == 400 and "Built-up, Forest, Water" in bad.json()["detail"]
