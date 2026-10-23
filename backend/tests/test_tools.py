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
    # A watershed click on the D∞ run adds the upslope dependence; the D8 basin itself is unchanged.
    click = {"col": h["flow"]["width"] // 2, "row": h["flow"]["height"] - 5}
    wd = client.post(f"/api/terrain/{d['layer'].split('/')[3]}/watershed", json=click).json()
    assert wd["areaM2"] == ws["areaM2"] and "dinf" not in ws
    dd = wd["dinf"]
    # On this smooth surface D8 gathers flow into single-cell lines (46,800 m² at the outlet) where D∞ spreads it
    # across the slope (23,460 m², its own upslope area at that cell: the identity is checked in test_science).
    assert dd["contributingM2"] == pytest.approx(23460, rel=1e-3) and 0 < dd["majorityM2"] <= ws["areaM2"] and dd["geojson"]["features"]
    assert "D∞ (Tarboton 1997)" in wd["markdown"]


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
    assert "Cross-validation by training shape" in res["markdown"] and any("100 trees" in n for n in lc["notes"])
    small = run(client, "landcover", {"file": img, "training": shapes}, {"method": "rf", "bands": [0, 1, 2, 3], "roles": {"red": 2, "nir": 3}, "trees": 50})["landcover"]
    assert any("50 trees" in n for n in small["notes"]) and small["validation"]["overall"] > 0.95
    assert "Choose 50, 100, 200 trees" in run_err(client, "landcover", {"file": img, "training": shapes}, {"method": "rf", "bands": [0, 1], "trees": 7})
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


def test_radar_single_and_change(client):
    a = sample(client, "s1_vv_vh_2023-01-08_synthetic.tif")
    b = sample(client, "s1_vv_vh_2024-01-03_synthetic.tif")
    one = run(client, "radar", {"before": a})
    assert one["bands"] == {"vv": 0, "vh": 1} and one["radar"]["dates"][0]["scale"] == "db" and "change" not in one["radar"]
    assert client.get(one["layers"]["composite"]).status_code == 200
    res = run(client, "radar", {"before": a, "after": b}, {"window": 5, "thresholdDb": 3})
    ch = res["radar"]["change"]
    assert ch["ha"]["1"] == pytest.approx(30, rel=0.15)  # the 600 m × 500 m clearing
    assert ch["share"]["3"] < 0.01 and "Change (VH log ratio)" in res["markdown"]
    tif = client.get(res["downloads"][0]["url"])
    assert tif.status_code == 200 and tif.content[:2] in (b"II", b"MM")
    assert "different bands" in run_err(client, "radar", {"before": a}, {"vv": 1, "vh": 1})


def test_canopy_from_point_cloud_and_rasters(client, tmp_path):
    import rasterio

    cloud = sample(client, "lidar_forest_synthetic.laz")
    res = run(client, "canopy", {"cloud": cloud}, {"cell": 1, "threshold": 2, "minTree": 5})
    c = res["canopy"]
    assert c["trees"]["count"] == 25 and 8 <= c["height"]["max"] <= 30.5 and 0.05 < c["cover"] < 0.6
    assert res["map"]["geojson"]["features"] and "Popescu & Wynne" in res["markdown"]
    # The CHM picture sits where the tree tops are (its bounds once had west/south swapped).
    (s_, w_), (n_, e_) = res["map"]["image"]["bounds"]
    assert all(w_ <= f["geometry"]["coordinates"][0] <= e_ and s_ <= f["geometry"]["coordinates"][1] <= n_ for f in res["map"]["geojson"]["features"])
    chm_url = next(d["url"] for d in res["downloads"] if d["filename"].endswith(".tif"))
    p = tmp_path / "chm.tif"
    p.write_bytes(client.get(chm_url).content)
    with rasterio.open(p) as d:
        assert d.crs.to_epsg() == 32646 and d.res == (1.0, 1.0)
    # The exported CHM as input gives the same answer.
    with p.open("rb") as fh:
        fid = client.post("/api/files", files={"file": ("chm.tif", fh, "image/tiff")}).json()["id"]
    again = run(client, "canopy", {"chm": fid}, {"threshold": 2, "minTree": 5})
    assert again["canopy"]["trees"]["count"] == 25 and again["canopy"]["cover"] == pytest.approx(c["cover"], abs=1e-9)
    assert "point cloud, a canopy height model" in run_err(client, "canopy", {}, {})


def test_canopy_count_calibrated_by_field_plots(client, tmp_path):
    """Ratio estimator (Cochran 1977, ch. 6): three plots around single detected tops, counted 2, 1 and 3 on the ground."""
    import json
    import math

    from terrax.processing.canopy import calibrate_count

    c = calibrate_count([2, 1, 3], [1, 1, 1], 25, 2.0)
    assert c["ratio"] == 2 and c["total"] == 50 and c["perHa"] == 25 and c["detectionRate"] == 0.5
    assert c["se"] == pytest.approx(25 * math.sqrt(1 / 3)) and c["ci95"][0] == 0 and c["ci95"][1] == pytest.approx(50 + 4.302653 * 25 * math.sqrt(1 / 3), rel=1e-6)
    assert calibrate_count([4], [2], 10)["se"] is None
    with pytest.raises(ValueError, match="No tree tops were detected"):
        calibrate_count([3, 4], [0, 0], 10)

    cloud = sample(client, "lidar_forest_synthetic.laz")
    tops = run(client, "canopy", {"cloud": cloud}, {"cell": 1, "threshold": 2, "minTree": 5})["map"]["geojson"]["features"]
    d = 4e-6  # about ±0.4 m: each square holds one tree top (tops are a crown radius apart)

    def square(x, y, n):
        return {"type": "Feature", "properties": {"trees": n}, "geometry": {"type": "Polygon", "coordinates": [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]]}}

    feats = [square(*f["geometry"]["coordinates"], n) for f, n in zip(tops[:3], (2, 1, 3), strict=True)] + [square(10.0, 10.0, 5)]  # the last is far off the data
    p = tmp_path / "plots.geojson"
    p.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    with p.open("rb") as fh:
        plots = client.post("/api/files", files={"file": ("plots.geojson", fh, "application/geo+json")}).json()["id"]
    res = run(client, "canopy", {"cloud": cloud, "plots": plots}, {"cell": 1, "threshold": 2, "minTree": 5})
    cal = res["canopy"]["trees"]["calibrated"]
    assert cal["plots"] == 3 and cal["detectedInPlots"] == 3 and cal["total"] == pytest.approx(50) and cal["se"] == pytest.approx(25 * math.sqrt(1 / 3))
    assert "calibrated by 3 field plots | 50" in res["markdown"] and any("1 of 4 field plots lie outside" in n for n in res["notes"])
    assert any("use at least 10" in n for n in res["notes"])
    bad = tmp_path / "bad.geojson"
    bad.write_text(json.dumps({"type": "FeatureCollection", "features": [{**feats[0], "properties": {"trees": 2.5}}]}))
    with bad.open("rb") as fh:
        bid = client.post("/api/files", files={"file": ("bad.geojson", fh, "application/geo+json")}).json()["id"]
    assert "whole numbers" in run_err(client, "canopy", {"cloud": cloud, "plots": bid}, {"cell": 1})


def test_sentinel1_search_load_and_radar_change(client, monkeypatch, tmp_path):
    """Search (mocked catalogue), read two dates through the sentinel1 tool (local files), then radar change on them."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    from terrax.services import live

    E0, N0 = 600000, 2850000
    rng = np.random.default_rng(2)

    def mk(name, vh_level, clear):
        p = tmp_path / f"{name}.tif"
        vh = rng.gamma(4.4, vh_level / 4.4, (200, 200)).astype(np.float32)  # speckle, ENL 4.4
        if clear:
            vh[50:100, 50:100] *= 0.2  # a 7 dB drop
        with rasterio.open(p, "w", driver="GTiff", width=200, height=200, count=1, dtype="float32", crs="EPSG:32646", transform=from_origin(E0, N0, 10, 10)) as d:
            d.write(vh * 5 if name.startswith("vv") else vh, 1)
        return str(p)

    href = "https://sentinel1euwestrtc.blob.core.windows.net/rtc/{}.tiff"
    feats = [{"id": f"S1A_{d}", "properties": {"datetime": f"{d}T23:41:00Z", "sat:orbit_state": "descending", "sat:relative_orbit": 77, "proj:epsg": 32646},
              "assets": {"vv": {"href": href.format(f"vv{d}")}, "vh": {"href": href.format(f"vh{d}")}}} for d in ("2024-01-03", "2024-03-03")]
    local = {href.format(f"{b}{d}"): mk(f"{b}{d}", 0.03, d == "2024-03-03") for d in ("2024-01-03", "2024-03-03") for b in ("vv", "vh")}
    calls = []
    monkeypatch.setattr(live, "fetch_json", lambda url, **kw: calls.append(url) or ({"token": "sig=x"} if "sas" in url else {"features": feats}))
    monkeypatch.setattr(live, "_sign", lambda h, token: local[h])
    found = client.post("/api/live/sentinel1/search", json={"bbox": [94.0, 25.7, 94.02, 25.72], "start": "2024-01-01", "end": "2024-03-31", "orbit": "descending"}).json()["items"]
    assert [i["id"] for i in found] == ["S1A_2024-01-03", "S1A_2024-03-03"] and calls[0].endswith("/api/stac/v1/search")
    from pyproj import Transformer

    (w, e), (s, n) = Transformer.from_crs(32646, 4326, always_xy=True).transform([E0 + 100, E0 + 1900], [N0 - 1900, N0 - 100])
    first = run(client, "sentinel1", {}, {"item": found[0], "bbox": [w, s, e, n]})
    second = run(client, "sentinel1", {"match": first["file"]["id"]}, {"item": found[1], "bbox": [w, s, e, n], "matchOrbit": 77})
    assert first["file"]["meta"]["bandNames"] == ["VV", "VH"] and any("first image's grid" in x for x in second["notes"])
    res = run(client, "radar", {"before": first["file"]["id"], "after": second["file"]["id"]}, {"vv": 0, "vh": 1})
    assert res["radar"]["dates"][0]["scale"] == "linear" and res["radar"]["change"]["ha"]["1"] == pytest.approx(25, rel=0.2)  # 50 × 50 px at 10 m
    other = run_err(client, "sentinel1", {}, {"item": {**found[0], "assets": {"vv": {"href": "https://evil.example.com/a.tif"}, "vh": {"href": "https://evil.example.com/b.tif"}}}, "bbox": [w, s, e, n]})
    assert "Planetary Computer's storage" in other


def test_forest_loss_area_estimate_from_a_stratified_sample(client, tmp_path):
    """Olofsson et al. (2014) on a forest-change map: loss the map missed in stable forest raises the estimated loss area."""
    import csv
    import io

    a, b = sample(client, "forest_ndvi_2016_synthetic.tif"), sample(client, "forest_ndvi_2024_synthetic.tif")
    res = run(client, "forest", {"a": a, "b": b}, {"mode": "ndvi"})
    jid = res["map"]["image"]["url"].split("/")[3]
    s = client.post(f"/api/jobs/{jid}/validation/sample", json={"total": 200, "minPerClass": 30}).json()
    alloc = {x["label"]: x for x in s["allocation"]}
    assert s["unit"] == "ha" and alloc["Forest loss"]["mapped"] == pytest.approx(184.05) and alloc["Forest loss"]["n"] >= 30
    rows = list(csv.DictReader(io.StringIO(client.get(s["downloads"][-1]["url"]).text)))
    assert len(rows) == s["points"] and {r["map_class"] for r in rows} <= set(alloc)
    # Reference = map, except 3 of the stable-forest points turn out to be loss (omission errors).
    missed = 0
    for r in rows:
        r["reference"] = r["map_class"]
        if r["map_class"] == "Stable forest" and missed < 3:
            r["reference"], missed = "Forest loss", missed + 1
    p = tmp_path / "labelled.csv"
    with p.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    with p.open("rb") as fh:
        fid = client.post("/api/files", files={"file": ("labelled.csv", fh, "text/csv")}).json()["id"]
    acc = client.post(f"/api/jobs/{jid}/validation/accuracy", json={"file": fid}).json()
    loss = next(c for c in acc["classes"] if c["label"] == "Forest loss")
    # p̂(loss) = Σᵢ Wᵢ nᵢ,loss / nᵢ·, times the total mapped area (eq. 4 and 9).
    total = sum(x["mapped"] for x in alloc.values())
    n_stable = sum(r["map_class"] == "Stable forest" for r in rows)
    expected = total * (alloc["Forest loss"]["share"] + alloc["Stable forest"]["share"] * 3 / n_stable)
    assert loss["area"] == pytest.approx(expected, rel=1e-9) and loss["area"] > loss["mappedArea"] and loss["areaCi"] > 0
    assert loss["userAccuracy"] == 1 and loss["producerAccuracy"] < 1
    assert "Estimated area" in acc["markdown"]
    # Validation needs a classified map.
    terrain = run(client, "terrain", {"dem": sample(client, "terrain_dem_synthetic.tif")}, {})
    tid = terrain["layers"]["slope"].split("/")[3]
    assert client.post(f"/api/jobs/{tid}/validation/sample", json={}).status_code == 400


def test_series_maps_disturbance_dates_per_pixel(client, tmp_path):
    """Six dates of NDVI at 10 m: a 30 × 40 px block cleared between the third and fourth date (12 ha)."""
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    rng = np.random.default_rng(5)
    dates = ["2019-02-10", "2020-02-12", "2021-02-09", "2022-02-14", "2023-02-11", "2024-02-13"]
    ids = []
    for i, d in enumerate(dates):
        a = (0.78 + 0.004 * i + rng.normal(0, 0.03, (100, 100))).astype(np.float32)
        if i >= 3:
            a[20:50, 30:70] -= 0.4
        if i == 4:
            a[:10, :] = np.nan  # a cloudy strip on one date
        p = tmp_path / f"ndvi_{d}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=100, height=100, count=1, dtype="float32", crs="EPSG:32646", transform=from_origin(600000, 2850000, 10, 10), nodata=np.nan) as f:
            f.write(a, 1)
        with p.open("rb") as fh:
            ids.append(client.post("/api/files", files={"file": (p.name, fh, "image/tiff")}).json()["id"])
    res = run(client, "stack", {"files": ids}, {"mapBreaks": True, "minDrop": 0.15})
    b = res["breaks"]
    by = {x["date"]: x for x in b["byDate"]}
    assert by["2022-02-14"]["previous"] == "2021-02-09" and by["2022-02-14"]["ha"] == pytest.approx(12, rel=0.03)
    assert b["disturbedHa"] - by["2022-02-14"]["ha"] < 0.1  # false positives over the 88 ha of stable forest: under 0.1 ha
    assert "Drop first seen 2022-02-14" in [x["label"] for x in b["legend"]] and res["map"]["image"]["url"]
    assert "## Disturbances (per pixel)" in res["markdown"] and "BFAST" in res["markdown"]
    tif = next(d["url"] for d in res["downloads"] if d["filename"] == "disturbance_date.tif")
    p = tmp_path / "dates.tif"
    p.write_bytes(client.get(tif).content)
    with rasterio.open(p) as f:
        cls = f.read(1)
    assert (cls[20:50, 30:70] == 3).mean() > 0.97 and cls[80, 80] == 1
    # Too few dates, or dates on different grids, are refused.
    assert "at least 5 dates" in run_err(client, "stack", {"files": ids[:4]}, {"mapBreaks": True})


def test_canopy_biomass_from_field_plots(client, tmp_path):
    """A 1 m CHM of 25 m stands of different heights; 30 plots of 25 m with AGB = 4.5·TCH^1.3 × lognormal noise."""
    import json

    import numpy as np
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import from_origin

    rng = np.random.default_rng(8)
    E0, N0, side, n = 600000.0, 2850000.0, 25, 16  # 16 × 16 stands of 25 m
    stand_h = rng.uniform(4, 30, (n, n))
    chm = np.kron(stand_h, np.ones((side, side))).astype(np.float32) + rng.normal(0, 1.0, (n * side, n * side)).astype(np.float32)
    chm = np.maximum(chm, 0)
    p = tmp_path / "chm.tif"
    with rasterio.open(p, "w", driver="GTiff", width=n * side, height=n * side, count=1, dtype="float32", crs="EPSG:32646", transform=from_origin(E0, N0, 1, 1), nodata=np.nan) as f:
        f.write(chm, 1)
    with p.open("rb") as fh:
        fid = client.post("/api/files", files={"file": ("chm.tif", fh, "image/tiff")}).json()["id"]
    to_ll = Transformer.from_crs(32646, 4326, always_xy=True)
    feats, truth_total = [], float((4.5 * stand_h**1.3 * np.exp(0.15**2 / 2)).sum() * 0.0625)
    cells = rng.choice(n * n, 30, replace=False)
    for c in cells:
        i, j = divmod(int(c), n)
        x0, y1 = E0 + j * side, N0 - i * side
        ring = [to_ll.transform(x, y) for x, y in [(x0, y1), (x0 + side, y1), (x0 + side, y1 - side), (x0, y1 - side), (x0, y1)]]
        tch = float(chm[i * side : (i + 1) * side, j * side : (j + 1) * side].mean())
        feats.append({"type": "Feature", "properties": {"agb": round(4.5 * tch**1.3 * float(np.exp(rng.normal(0, 0.15))), 2)}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
    plots = tmp_path / "plots.geojson"
    plots.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    with plots.open("rb") as fh:
        pid = client.post("/api/files", files={"file": ("plots.geojson", fh, "application/geo+json")}).json()["id"]
    res = run(client, "canopy", {"chm": fid, "plots": pid}, {"threshold": 2, "minTree": 5})
    bm = res["canopy"]["biomass"]
    assert bm["plots"] == 30 and bm["cellSideM"] == pytest.approx(25, abs=1)
    assert bm["b"] == pytest.approx(1.3, abs=0.12) and bm["a"] == pytest.approx(4.5, rel=0.35)
    assert bm["totalMg"] == pytest.approx(truth_total, rel=0.08) and bm["ci95Mg"][0] < bm["totalMg"] < bm["ci95Mg"][1]
    assert bm["carbonMg"] == pytest.approx(0.47 * bm["totalMg"]) and bm["co2eMg"] == pytest.approx(bm["carbonMg"] * 44 / 12)
    assert "Above-ground biomass, from 30 field plots" in res["markdown"] and "Asner & Mascaro" in res["markdown"]
    assert any(d["filename"] == "agb_mg_ha.tif" for d in res["downloads"])
    assert "trees" not in res["canopy"] or "calibrated" not in res["canopy"]["trees"]  # no count column: no count calibration


def test_landcover_random_forest_with_radar_separates_spectral_twins(client, tmp_path):
    """Forest and plantation with the same optical spectra but VH 6 dB apart: optical alone is near chance, radar fixes it."""
    import json

    import numpy as np
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import from_origin

    rng = np.random.default_rng(12)
    E0, N0, n = 600000.0, 2850000.0, 120
    plantation = np.arange(n)[None, :].repeat(n, 0) >= n // 2
    opt = np.stack([0.03 + rng.normal(0, 0.004, (n, n)), 0.06 + rng.normal(0, 0.006, (n, n)), 0.04 + rng.normal(0, 0.005, (n, n)), 0.32 + rng.normal(0, 0.02, (n, n))]).astype(np.float32)
    vh_db = np.where(plantation, -20.0, -14.0) + rng.normal(0, 1.0, (n, n))  # speckle after multilooking, ~1 dB
    vv_db = vh_db + 7 + rng.normal(0, 0.8, (n, n))

    def write(name, data, res, origin_shift=0.0):
        p = tmp_path / name
        with rasterio.open(p, "w", driver="GTiff", width=data.shape[2], height=data.shape[1], count=data.shape[0], dtype="float32", crs="EPSG:32646",
                           transform=from_origin(E0 + origin_shift, N0 - origin_shift, res, res), nodata=np.nan) as d:
            d.write(data.astype(np.float32))
        with p.open("rb") as fh:
            return client.post("/api/files", files={"file": (name, fh, "image/tiff")}).json()["id"]

    optical = write("optical.tif", opt, 10)
    radar_same = write("s1_same_grid.tif", np.stack([10 ** (vv_db / 10), 10 ** (vh_db / 10)]), 10)  # linear power, same grid
    coarse = np.stack([vv_db, vh_db])[:, ::2, ::2]  # dB, 20 m, offset by 5 m: reprojected
    radar_other = write("s1_20m_db.tif", coarse, 20, origin_shift=5.0)
    to_ll = Transformer.from_crs(32646, 4326, always_xy=True)
    feats = []
    for k, (r0, c0) in enumerate([(10, 10), (60, 15), (95, 30), (10, 70), (55, 85), (95, 100)]):
        x0, y1 = E0 + c0 * 10, N0 - r0 * 10
        ring = [list(to_ll.transform(x, y)) for x, y in [(x0, y1), (x0 + 150, y1), (x0 + 150, y1 - 150), (x0, y1 - 150), (x0, y1)]]
        feats.append({"type": "Feature", "properties": {"class": "Forest" if k < 3 else "Plantation"}, "geometry": {"type": "Polygon", "coordinates": [ring]}})
    p = tmp_path / "train.geojson"
    p.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    with p.open("rb") as fh:
        train = client.post("/api/files", files={"file": ("train.geojson", fh, "application/geo+json")}).json()["id"]
    base = {"method": "rf", "bands": [0, 1, 2, 3], "roles": {"red": 2, "nir": 3}, "trees": 50}
    alone = run(client, "landcover", {"file": optical, "training": train}, base)["landcover"]
    fused = run(client, "landcover", {"file": optical, "training": train, "radar": radar_same}, base)["landcover"]
    other = run(client, "landcover", {"file": optical, "training": train, "radar": radar_other}, base)["landcover"]
    assert alone["validation"]["overall"] < 0.65  # spectral twins: about chance
    assert fused["validation"]["overall"] > 0.95 and other["validation"]["overall"] > 0.95
    assert fused["features"][-3:] == ["VV (dB)", "VH (dB)", "VH/VV (dB)"] and len(fused["stats"][0]["bandMeans"]) == 4
    vh_means = {c["label"]: c["radarMeans"][1] for c in fused["stats"]}
    assert vh_means["Forest"] == pytest.approx(-14, abs=0.5) and vh_means["Plantation"] == pytest.approx(-20, abs=0.5)
    assert any("read as linear power" in n for n in fused["notes"]) and any("reprojected onto the optical grid" in n and "read as dB" in n for n in other["notes"])
    assert "random forest only" in run_err(client, "landcover", {"file": optical, "radar": radar_same}, {"method": "kmeans", "bands": [0, 1, 2, 3], "k": 2})
