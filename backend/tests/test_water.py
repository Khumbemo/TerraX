"""Surface water and floods (processing/water.py, tools/water.py): thresholds, optical and radar, one date and two."""

import numpy as np
import pytest

from tests.test_tools import run, run_err

E0, N0 = 600000, 2850000


def _tif(tmp_path, client, name, bands, res, nodata=np.nan):
    import rasterio
    from rasterio.transform import from_origin

    p = tmp_path / name
    h, w = bands[0].shape
    with rasterio.open(p, "w", driver="GTiff", width=w, height=h, count=len(bands), dtype="float32", crs="EPSG:32646", transform=from_origin(E0, N0, res, res), nodata=nodata) as d:
        for i, b in enumerate(bands, start=1):
            d.write(b.astype(np.float32), i)
    with p.open("rb") as fh:
        return client.post("/api/files", files={"file": (name, fh, "image/tiff")}).json()["id"]


def test_otsu_only_when_the_histogram_splits():
    from terrax.processing.water import INDEX_DEFAULT, INDEX_RANGE, auto_threshold

    rng = np.random.default_rng(0)
    split = np.concatenate([rng.normal(0.5, 0.05, 3000), rng.normal(-0.4, 0.05, 7000)])
    thr, note = auto_threshold(split, INDEX_RANGE, INDEX_DEFAULT, "")
    assert -0.3 < thr < 0.3 and "Otsu" in note and "clearly apart" in note
    # All land: Otsu still splits the one peak, but it is not bimodal, so the standard 0 is used. The Gaussian mixture
    # must decide this: the two halves of one bell curve, cut at Otsu's threshold, are D ≈ 2.6 apart.
    from terrax.processing.water import ashman_d

    land = rng.normal(-0.4, 0.05, 10000)
    assert ashman_d(land) < 2 and ashman_d(split) > 5
    land = land * 0.5  # centred at −0.2, inside the plausible range: only the bimodality test can reject it
    thr, note = auto_threshold(land, INDEX_RANGE, INDEX_DEFAULT, "")
    assert thr == 0 and "not clearly bimodal" in note


def test_optical_flood_from_two_dates_with_a_cloud_mask(client, tmp_path, monkeypatch):
    """Landsat-like 7-band files at 30 m (QA_PIXEL in band 7). A river in columns 40–49 widens to 30–59; rows 0–9 are
    cloudy on the second date. MNDWI over water ≈ 0.71, over land ≈ −0.43."""
    def scene(water_cols, cloud_rows=None):
        land = {"green": 0.08, "nir": 0.3, "swir1": 0.2}
        wet = {"green": 0.06, "nir": 0.02, "swir1": 0.01}
        b = {k: np.full((100, 100), v) for k, v in land.items()}
        for k in b:
            b[k][:, water_cols] = wet[k]
        qa = np.full((100, 100), 64.0)
        if cloud_rows is not None:
            qa[cloud_rows] = 8.0  # bit 3: cloud
            for k in b:
                b[k][cloud_rows] = 0.5
        return [np.full((100, 100), 0.03), b["green"], np.full((100, 100), 0.04), b["nir"], b["swir1"], np.full((100, 100), 0.1), qa]

    a = _tif(tmp_path, client, "before.tif", scene(slice(40, 50)), 30)
    b = _tif(tmp_path, client, "after.tif", scene(slice(30, 60), slice(0, 10)), 30)
    params = {"mode": "optical", "bands": {"green": 1, "nir": 3, "swir1": 4}, "qa": {"band": 6, "kind": "landsat"}}
    res = run(client, "water", {"a": a, "b": b}, params)
    r = res["result"]
    # Noise-free water (0.71) and land (−0.43) leave an empty gap: Otsu takes its middle, not an edge next to a peak.
    assert r["index"] == "MNDWI" and r["threshold"] == pytest.approx(0.14, abs=0.01) and any("by Otsu's method" in n for n in r["notes"])
    by = {c["label"]: c for c in r["summary"]["classes"]}
    # 90 clear rows × 10 river columns × 0.09 ha, and 90 × 20 newly flooded columns.
    assert by["Water both dates"]["ha"] == pytest.approx(81, rel=1e-6) and by["New water (flood)"]["ha"] == pytest.approx(162, rel=1e-6)
    assert by["Water gone"]["pixels"] == 0 and r["summary"]["observedPixels"] == 9000
    assert any("removed 10.0 % of pixels" in n for n in r["notes"])
    poly = next(d for d in res["downloads"] if d["filename"].endswith("_new_water.geojson"))
    assert poly["features"] == 2  # the two banks of the flood
    # Water bodies on the later date: the widened river (columns 30–59) below the cloud, 90 × 30 × 0.09 ha, of which
    # 90 × 20 cells are new; it touches the cloud and the image edge, so its full extent is unknown.
    river = res["result"]["bodies"]
    assert river["count"] == 1 and river["truncated"] == 1
    assert river["top"][0]["area_ha"] == pytest.approx(243) and river["top"][0]["new_water_ha"] == pytest.approx(162)
    assert "New water (flood)" in res["markdown"] and "Xu 2006" in res["markdown"]
    # Read on a coarser grid (2 × 2 original pixels a cell), the report says so; the river's edges fall on cell edges, so
    # the areas are unchanged.
    monkeypatch.setenv("TERRAX_GRID_PIXELS", "2500")
    coarse = run(client, "water", {"a": a, "b": b}, params)["result"]
    monkeypatch.delenv("TERRAX_GRID_PIXELS")
    assert any("resampled grid (each cell = 4 original pixels" in n for n in coarse["notes"]) and not any("resampled" in n for n in r["notes"])
    assert {c["label"]: c["ha"] for c in coarse["summary"]["classes"]} == pytest.approx({c["label"]: c["ha"] for c in r["summary"]["classes"]})
    # One date: water only; NDWI when no SWIR band is named.
    one = run(client, "water", {"a": a}, {"mode": "optical", "bands": {"green": 1, "nir": 3}})["result"]
    assert one["index"] == "NDWI" and next(c for c in one["summary"]["classes"] if c["label"] == "Water")["ha"] == pytest.approx(90, rel=1e-6)


def test_radar_flood_excludes_permanently_dark_ground(client, tmp_path):
    """Sentinel-1-like VV at 10 m with speckle: land −10 dB, calm water −23 dB. A river in columns 40–49 floods to
    30–59 (20 ha new water); columns 80–89 are tarmac, dark on both dates, which must not count as flood."""
    rng = np.random.default_rng(4)

    def vv(water_cols):
        mean = np.full((100, 100), 0.1)
        mean[:, water_cols] = 0.005
        mean[:, 80:90] = 0.005
        return mean * rng.gamma(4.4, 1 / 4.4, mean.shape)  # speckle, ENL 4.4

    a = _tif(tmp_path, client, "s1_before.tif", [vv(slice(40, 50)), vv(slice(40, 50)) * 0.2], 10)
    b = _tif(tmp_path, client, "s1_after.tif", [vv(slice(30, 60)), vv(slice(30, 60)) * 0.2], 10)
    res = run(client, "water", {"a": a, "b": b}, {"mode": "radar"})
    r = res["result"]
    assert r["unit"] == "dB" and -24 <= r["threshold"] <= -12 and any("Otsu" in n for n in r["notes"])
    by = {c["label"]: c["ha"] for c in r["summary"]["classes"]}
    assert by["New water (flood)"] == pytest.approx(20, rel=0.05)
    assert by["Water both dates"] == pytest.approx(20, rel=0.05)  # the river and the tarmac: dark before and after
    assert "double bounce" in res["markdown"]
    # Images on different grids are refused.
    c = _tif(tmp_path, client, "other.tif", [np.full((50, 50), 0.1)], 10)
    assert "same grid" in run_err(client, "water", {"a": a, "b": c}, {"mode": "radar"})
    assert "optical" in run_err(client, "water", {"a": a}, {"mode": "lidar"})


def _valley(res, cols, rows):
    """A straight valley along easting E0 + 1500 m (column 50 at 30 m), sides rising 1 m every 6 m across, the floor
    falling 0.5 m every 30 m southwards: water drains straight across to the river, so HAND is exactly |dx| / 6."""
    x = E0 + (np.arange(cols) + 0.5) * res
    y = N0 - (np.arange(rows) + 0.5) * res
    return np.abs(x[None, :] - (E0 + 1515)) / 6 + (y[:, None] - (N0 - rows * res)) * 0.5 / 30


def test_hand_is_the_height_above_the_channel():
    from terrax.processing.rio import Ground
    from terrax.processing.terrain import height_above_drainage

    z = _valley(30, 101, 100)
    geo = Ground(np.full(100, 900.0), np.full(100, 30.0), np.full(100, 30.0), "")
    hand, flow = height_above_drainage(z, geo, 0.05e6)
    assert flow["acc"][99, 50] > 0.05e6
    np.testing.assert_allclose(hand[:, 47:54], np.tile([15, 10, 5, 0, 5, 10, 15], (100, 1)), atol=1e-6)
    np.testing.assert_allclose(hand[50, 80], 150, atol=1e-6)


def test_hand_removes_water_on_hillsides(client, tmp_path):
    """A river (columns 48–52, at most 10 m above the channel) and a dark, water-like patch on the hillside (columns
    70–75, 100–125 m up). With the DEM, only the patch is removed, also with a coarser DEM on its own grid. Channels
    start at 0.1 km²: a whole hillside drains less (0.045 km² at 30 m, 0.09 km² at 60 m), so only the river is a channel;
    a smaller threshold would turn the long planar hillsides into channels themselves (HAND 0)."""
    land = {"green": 0.08, "nir": 0.3, "swir1": 0.2}
    wet = {"green": 0.06, "nir": 0.02, "swir1": 0.01}
    b = {k: np.full((100, 100), v) for k, v in land.items()}
    for k in b:
        b[k][:, 48:53] = wet[k]
        b[k][10:20, 70:76] = wet[k]
    img = _tif(tmp_path, client, "valley.tif", [b["green"], b["nir"], b["swir1"]], 30)
    params = {"mode": "optical", "bands": {"green": 0, "nir": 1, "swir1": 2}, "threshold": 0}
    plain = run(client, "water", {"a": img}, params)["result"]
    assert plain["summary"]["classes"][1]["ha"] == pytest.approx(45 + 5.4, rel=1e-6) and plain["hand"] is None
    for res, size in ((30, 100), (60, 50)):
        dem = _tif(tmp_path, client, f"dem{res}.tif", [_valley(res, size, size)], res)
        r = run(client, "water", {"a": img, "dem": dem}, {**params, "streamKm2": 0.1})["result"]
        assert r["summary"]["classes"][1]["ha"] == pytest.approx(45, rel=1e-6), res
        assert r["hand"]["ha"] == pytest.approx(5.4, rel=1e-6) and r["hand"]["handMax"] == 15
        assert any("above its nearest channel was removed (5.4 ha)" in n for n in r["notes"]) and any("HAND" in n and "known for 100 %" in n for n in r["notes"])
    # A higher limit keeps the patch.
    assert run(client, "water", {"a": img, "dem": dem}, {**params, "streamKm2": 0.1, "handMax": 200})["result"]["summary"]["classes"][1]["ha"] == pytest.approx(50.4, rel=1e-6)


def test_water_body_inventory_known_shapes():
    """Perimeter, area, centroid, size class and truncation of hand-made bodies on a 30 m UTM grid."""
    from rasterio.transform import from_origin
    from rasterio.warp import transform as warp

    from terrax.processing.rio import Ground
    from terrax.processing.waterbodies import inventory, rows, shore_development

    w = np.zeros((40, 40), dtype=bool)
    w[5:15, 5:15] = True  # 10 × 10 square: 9 ha, 40 edges of 30 m
    w[20, 20] = True  # one pixel: 0.09 ha
    w[25, 25] = w[26, 26] = True  # diagonal neighbours: one body (8-connected), 8 exposed edges
    w[30:40, 0:3] = True  # against the image edge: truncated
    w[2, 30:33] = True  # next to unknown cells: truncated
    unknown = np.zeros_like(w)
    unknown[1, 31] = True
    geo = Ground(np.full(40, 900.0), np.full(40, 30.0), np.full(40, 30.0), "")
    t = from_origin(E0, N0, 30, 30)
    inv = inventory(w, unknown, geo, t, "EPSG:32646", False)
    assert inv.count == 5 and inv.removed == 0
    r = {x["id"]: x for x in rows(inv)}
    assert r[1]["area_ha"] == pytest.approx(9) and r[1]["perimeter_m"] == pytest.approx(1200) and not r[1]["truncated"]
    assert r[1]["shore_dev"] == pytest.approx(1200 / (2 * np.sqrt(np.pi * 90000)), abs=1e-3) and r[1]["size_class"] == "1–10 ha"
    lon, lat = warp("EPSG:32646", "EPSG:4326", [E0 + 300], [N0 - 300])  # the square's centre, 10 pixels from the corner
    assert r[1]["lon"] == pytest.approx(lon[0], abs=1e-6) and r[1]["lat"] == pytest.approx(lat[0], abs=1e-6)
    assert r[2]["area_ha"] == pytest.approx(2.7) and r[2]["truncated"]  # 10 × 3 at the edge
    by_area = sorted(r.values(), key=lambda x: x["area_ha"])
    one, pair, strip = by_area[0], by_area[1], by_area[2]
    assert one["area_ha"] == pytest.approx(0.09) and one["perimeter_m"] == pytest.approx(120) and not one["truncated"]
    assert pair["area_ha"] == pytest.approx(0.18) and pair["perimeter_m"] == pytest.approx(240)
    assert strip["area_ha"] == pytest.approx(0.27) and strip["truncated"]
    assert shore_development(0.09, 120) == pytest.approx(4 / (2 * np.sqrt(np.pi)))
    # A minimum area drops the single pixel and the diagonal pair; ids stay largest first.
    small = inventory(w, unknown, geo, t, "EPSG:32646", False, min_ha=0.2)
    assert small.count == 3 and small.removed == 2 and small.removed_ha == pytest.approx(0.27)
    assert list(small.area_ha[1:]) == pytest.approx([9, 2.7, 0.27])


def _lakes():
    """Six bands (blue, green, red, NIR, SWIR1, red-edge 705 nm) at 30 m. Lake A (rows 10–29, cols 10–29) is clear:
    NDTI = (0.03 − 0.06) / 0.09 = −1/3, NDCI = (0.02 − 0.03) / 0.05 = −0.2. Lake B (rows 50–59, cols 60–79) is turbid
    and green: NDTI = 0.02 / 0.18 = 1/9, NDCI = 0.02 / 0.22 = 1/11; its shore ring is mixed (red 0.2), which interior-only
    statistics must ignore."""
    land = {"blue": 0.05, "green": 0.08, "red": 0.06, "nir": 0.3, "swir1": 0.2, "re": 0.15}
    b = {k: np.full((100, 100), v) for k, v in land.items()}
    for k, v in {"blue": 0.04, "green": 0.06, "red": 0.03, "nir": 0.02, "swir1": 0.01, "re": 0.02}.items():
        b[k][10:30, 10:30] = v
    for k, v in {"blue": 0.05, "green": 0.08, "red": 0.10, "nir": 0.04, "swir1": 0.01, "re": 0.12}.items():
        b[k][50:60, 60:80] = v
    ring = np.zeros((100, 100), dtype=bool)
    ring[50:60, 60:80] = True
    ring[51:59, 61:79] = False
    b["red"][ring] = 0.2
    return [b[k] for k in ("blue", "green", "red", "nir", "swir1", "re")]


def test_water_bodies_and_quality_from_one_image(client, tmp_path):
    img = _tif(tmp_path, client, "lakes.tif", _lakes(), 30)
    params = {"mode": "optical", "bands": {"green": 1, "red": 2, "nir": 3, "swir1": 4, "rededge": 5}}
    res = run(client, "water", {"a": img}, params)
    r = res["result"]
    bodies = r["bodies"]
    assert bodies["count"] == 2 and bodies["ha"] == pytest.approx(54) and bodies["truncated"] == 0
    a, b = bodies["top"]
    assert a["area_ha"] == pytest.approx(36) and a["perimeter_m"] == pytest.approx(2400)
    assert b["area_ha"] == pytest.approx(18) and b["perimeter_m"] == pytest.approx(1800)
    assert a["ndti"] == pytest.approx(-1 / 3, abs=1e-4) and a["ndci"] == pytest.approx(-0.2, abs=1e-4)
    assert b["ndti"] == pytest.approx(1 / 9, abs=1e-4) and b["ndci"] == pytest.approx(1 / 11, abs=1e-4)  # the mixed shore is left out
    assert {s["label"]: s["count"] for s in bodies["sizes"]} == {"under 1 ha": 0, "1–10 ha": 0, "10–100 ha": 2, "100 ha or more": 0}
    q = r["quality"]
    # 324 interior pixels of lake A, 144 of lake B.
    assert q["ndti"]["pixels"] == 468 and q["ndti"]["median"] == pytest.approx(-1 / 3, abs=1e-4) and q["ndti"]["p90"] == pytest.approx(1 / 9, abs=1e-4)
    assert q["ndci"]["pixels"] == 468 and q["ndtiImage"]["url"] and q["ndciImage"]["url"]
    md = res["markdown"]
    assert "### Water bodies" in md and "### Water quality indicators" in md and "Lacaux" in md and "Mishra & Mishra 2012" in md
    csv_dl = next(d for d in res["downloads"] if d["filename"] == "lakes_water_bodies.csv")
    text = client.get(csv_dl["url"]).text.splitlines()
    assert text[0] == "id,area_ha,perimeter_m,shore_dev,lon,lat,size_class,truncated,ndti,ndci" and len(text) == 3
    gj = client.get(next(d for d in res["downloads"] if d["filename"] == "lakes_water_bodies.geojson")["url"]).json()
    assert [f["properties"]["id"] for f in gj["features"]] == [1, 2] and gj["features"][0]["properties"]["area_ha"] == pytest.approx(36)
    # Without a red-edge band only NDTI; without red, no quality at all.
    no_re = run(client, "water", {"a": img}, {**params, "bands": {"green": 1, "red": 2, "swir1": 4}})["result"]
    assert no_re["quality"]["ndti"] and "ndci" not in no_re["quality"] and any("needs a red-edge band" in n for n in no_re["notes"])
    no_red = run(client, "water", {"a": img}, {**params, "bands": {"green": 1, "swir1": 4}})["result"]
    assert no_red["quality"] is None and any("not estimated" in n for n in no_red["notes"]) and no_red["bodies"]["count"] == 2
    # A minimum area larger than lake B leaves only lake A.
    big = run(client, "water", {"a": img}, {**params, "mmuHa": 20})["result"]["bodies"]
    assert big["count"] == 1 and big["removed"] == 1


def _index(tmp_path, client, name, wet_cols, cloud_rows=None):
    v = np.full((50, 50), -0.4)
    v[:, 0:10] = 0.6
    v[:, wet_cols] = 0.6
    if cloud_rows is not None:
        v[cloud_rows] = np.nan
    return _tif(tmp_path, client, name, [v], 30)


def test_water_over_time(client, tmp_path):
    """Five dated water-index images on a 50 × 50 grid at 30 m. Columns 0–9 are always water; columns 10–19 only on
    two dates; the 2024-05-01 image is cloudy over rows 0–24. Occurrence: 100 % in columns 0–9; in columns 10–19,
    2 of 4 valid observations (50 %) in the cloudy rows and 2 of 5 (40 %) below."""
    seasonal = slice(10, 20)
    none = slice(0, 0)
    ids = [_index(tmp_path, client, "lake_2024-01-15.tif", none), _index(tmp_path, client, "lake_2024-03-01.tif", none),
           _index(tmp_path, client, "lake_2024-05-01.tif", none, slice(0, 25)), _index(tmp_path, client, "lake_2024-07-15.tif", seasonal),
           _index(tmp_path, client, "lake_2024-09-01.tif", seasonal)]
    res = run(client, "water", {"images": ids[::-1]}, {"mode": "optical"})  # any order: sorted by date
    r = res["result"]
    assert r["series"] and -0.3 < r["threshold"] < 0.3 and r["minObs"] == 3
    by = {c["id"]: c["ha"] for c in r["classes"]}
    assert by[3] == pytest.approx(45) and by[2] == pytest.approx(45) and by[1] == pytest.approx(135)
    d = r["dates"]
    assert [x["date"] for x in d] == ["2024-01-15", "2024-03-01", "2024-05-01", "2024-07-15", "2024-09-01"]
    assert d[2]["observedPct"] == pytest.approx(50) and d[2]["waterHa"] == pytest.approx(22.5) and d[2]["waterSharePct"] == pytest.approx(20)
    assert d[3]["waterHa"] == pytest.approx(90) and d[0]["waterSharePct"] == pytest.approx(20)
    body = r["bodies"]["top"][0]
    assert r["bodies"]["count"] == 1 and body["area_ha"] == pytest.approx(90) and body["almost_always_ha"] == pytest.approx(45)
    assert body["mean_occurrence_pct"] == pytest.approx((100 * 500 + 50 * 250 + 40 * 250) / 1000, abs=0.05) and body["truncated"]
    import io

    import rasterio

    tif = next(x for x in res["downloads"] if x["filename"].endswith("_occurrence.tif"))
    with rasterio.open(io.BytesIO(client.get(tif["url"]).content)) as ds:
        occ = ds.read(1)
    assert occ[0, 0] == 100 and occ[0, 15] == pytest.approx(50) and occ[40, 15] == pytest.approx(40) and occ[40, 40] == 0
    csv_text = client.get(next(x for x in res["downloads"] if x["filename"].endswith("_water_by_date.csv"))["url"]).text
    assert csv_text.splitlines()[3].startswith("2024-05-01,lake_2024-05-01.tif,50.0,250,22.5,20.0")
    assert "Pekel et al. 2016" in res["markdown"] and "### Water on each date" in res["markdown"]
    # Requiring 5 valid observations leaves the cloudy rows out.
    strict = run(client, "water", {"images": ids}, {"mode": "optical", "minObs": 5})["result"]
    assert {c["id"]: c["ha"] for c in strict["classes"]}[1] == pytest.approx(135 / 2)
    # Refusals: too few images, an undated file, two images of one date, another grid.
    assert "between 3 and" in run_err(client, "water", {"images": ids[:2]}, {"mode": "optical"})
    undated = _index(tmp_path, client, "lake.tif", none)
    assert "No date found in: lake.tif" in run_err(client, "water", {"images": [*ids[:2], undated]}, {"mode": "optical"})
    twin = _index(tmp_path, client, "lake_20240115_b.tif", none)
    assert "same date" in run_err(client, "water", {"images": [*ids[:2], twin]}, {"mode": "optical"})
    other = _tif(tmp_path, client, "lake_2024-11-01.tif", [np.full((40, 40), 0.5)], 30)
    assert "same grid" in run_err(client, "water", {"images": [*ids[:2], other]}, {"mode": "optical"})
