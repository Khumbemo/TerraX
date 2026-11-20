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
