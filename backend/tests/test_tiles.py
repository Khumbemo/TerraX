"""Strip processing gives the same numbers as one whole-grid pass."""

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from terrax.processing import forest, tiles
from terrax.processing.rio import Raster
from terrax.processing.zonal import boundary_in_crs, boundary_mask, rows_mask


def _tif(path, arr, crs="EPSG:4326", origin=(94.0, 26.0), px=0.0005):
    with rasterio.open(path, "w", driver="GTiff", width=arr.shape[1], height=arr.shape[0], count=1, dtype="float32", crs=crs,
                       transform=from_origin(*origin, px, px)) as ds:
        ds.write(arr.astype(np.float32), 1)
    return path


@pytest.fixture()
def pair(tmp_path):
    rng = np.random.default_rng(3)
    h, w = 403, 517  # odd sizes so strips do not divide evenly
    yy, xx = np.mgrid[0:h, 0:w]
    before = 0.55 + 0.3 * np.sin(yy / 40) * np.cos(xx / 55) + rng.normal(0, 0.05, (h, w))
    after = before - 0.45 * (((yy - 200) ** 2 + (xx - 260) ** 2) < 90**2) + rng.normal(0, 0.05, (h, w))
    before[10:20, 30:40] = np.nan
    return Raster(_tif(tmp_path / "a.tif", before)), Raster(_tif(tmp_path / "b.tif", after))


BOUNDARY = {"name": "plot", "areaM2": 1.0, "geojson": {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [[[94.03, 25.95], [94.24, 25.84], [94.2, 25.81], [94.05, 25.83], [94.03, 25.95]]]}}]}}


@pytest.mark.parametrize("boundary", [None, BOUNDARY])
@pytest.mark.parametrize("mmu", [0, 0.5])
def test_ndvi_change_strips_equal_whole_grid(pair, monkeypatch, boundary, mmu):
    a, b = pair
    monkeypatch.setattr(tiles, "TILE_PIXELS", 10**9)
    monkeypatch.setenv("TERRAX_TILE_THREADS", "1")
    whole = forest.analyze_ndvi_change(a, {}, b, {}, 0.5, -0.2, boundary, mmu)
    monkeypatch.setattr(tiles, "TILE_PIXELS", 517 * 13)  # 31 strips of 13 rows
    monkeypatch.setenv("TERRAX_TILE_THREADS", "4")
    strips = forest.analyze_ndvi_change(a, {}, b, {}, 0.5, -0.2, boundary, mmu)
    assert np.array_equal(whole["classes"], strips["classes"])
    for key in ("forestBefore", "loss", "gain"):
        assert strips[key]["pixels"] == whole[key]["pixels"]
        assert strips[key]["ha"] == pytest.approx(whole[key]["ha"], rel=1e-12)
    assert strips["validPixels"] == whole["validPixels"]
    assert strips["meanDelta"] == pytest.approx(whole["meanDelta"], rel=1e-9)
    assert strips["patches"]["count"] == whole["patches"]["count"]
    assert strips["notes"] == whole["notes"]


def test_strip_masks_join_to_the_whole_boundary_mask(pair):
    a, _ = pair
    whole, n = boundary_mask(a, a.read_bands([0])[0], BOUNDARY)
    geoms = boundary_in_crs(a, BOUNDARY)
    joined = np.vstack([rows_mask(a, geoms, r, min(a.gh, r + 7)) for r in range(0, a.gh, 7)])
    assert n > 1000 and np.array_equal(whole, joined)


def test_burn_and_hansen_strips_equal_whole_grid(tmp_path, monkeypatch):
    rng = np.random.default_rng(5)
    h, w = 211, 307
    pre = rng.uniform(0.2, 0.7, (h, w))
    post = pre - rng.uniform(-0.3, 0.9, (h, w))
    ly = rng.integers(0, 24, (h, w)).astype(float)
    tc = rng.uniform(0, 100, (h, w))
    p1, p2 = Raster(_tif(tmp_path / "p.tif", pre)), Raster(_tif(tmp_path / "q.tif", post))
    l1, t1 = Raster(_tif(tmp_path / "l.tif", ly)), Raster(_tif(tmp_path / "t.tif", tc))
    out = {}
    for name, tile, threads in (("whole", 10**9, "1"), ("strips", 307 * 9, "3")):
        monkeypatch.setattr(tiles, "TILE_PIXELS", tile)
        monkeypatch.setenv("TERRAX_TILE_THREADS", threads)
        out[name] = (forest.analyze_burn(p1, {}, p2, {}, BOUNDARY, 0.2), forest.analyze_hansen(l1, t1, 30, None, 0.2))
    for w_res, s_res in zip(out["whole"], out["strips"], strict=True):
        assert np.array_equal(w_res["classes"], s_res["classes"])
        assert s_res["notes"] == w_res["notes"]
    (wb, wh), (sb, sh) = out["whole"], out["strips"]
    assert [c["pixels"] for c in sb["classAreas"]] == [c["pixels"] for c in wb["classAreas"]]
    assert sb["burned"]["ha"] == pytest.approx(wb["burned"]["ha"], rel=1e-12)
    assert [(y["year"], y["area"]["pixels"]) for y in sh["byYear"]] == [(y["year"], y["area"]["pixels"]) for y in wh["byYear"]]
    assert sh["totalLoss"]["ha"] == pytest.approx(wh["totalLoss"]["ha"], rel=1e-12)


def test_satellite_statistics_equal_whole_grid(monkeypatch):
    from terrax.processing.indices import compute_index_grid
    from terrax.processing.rasterset import dataset
    from terrax.processing.stats import histogram, summarize

    from .conftest import SAMPLES

    r = Raster(SAMPLES / "satellite_4band_synthetic.tif")
    bands = {"blue": 0, "green": 1, "red": 2, "nir": 3}
    monkeypatch.setattr(tiles, "TILE_PIXELS", r.gw * 11)
    monkeypatch.setenv("TERRAX_TILE_THREADS", "4")
    for view in ({"mode": "index", "index": "ndvi", "bands": bands}, {"mode": "band", "band": 2}):
        ds, pv = dataset(r, view, None)
        grid = compute_index_grid(r, "ndvi", bands)[0].data if view["mode"] == "index" else r.read_bands([2])[0].data
        valid = grid[np.isfinite(grid)]
        s = summarize(valid)
        for k in ("n", "min", "max", "median", "q1", "q3"):
            assert ds["stats"][k] == getattr(s, k), k
        assert ds["stats"]["mean"] == pytest.approx(s.mean, rel=1e-12) and ds["stats"]["sd"] == pytest.approx(s.sd, rel=1e-9)
        assert ds["histogram"] == histogram(valid, s.min, s.max, 30)
        assert ds["validPixels"] == valid.size and pv.shape[0] <= 512


def test_land_cover_strips_equal_whole_grid(monkeypatch):
    from terrax.processing.landcover import classify_land_cover

    from .conftest import SAMPLES

    r = Raster(SAMPLES / "satellite_4band_synthetic.tif")
    (s_, w_), (n_, e_) = r.meta.latlng_bounds
    ring = [[w_ + 0.2 * (e_ - w_), s_ + 0.1 * (n_ - s_)], [e_ - 0.1 * (e_ - w_), s_ + 0.3 * (n_ - s_)], [w_ + 0.6 * (e_ - w_), n_ - 0.1 * (n_ - s_)], [w_ + 0.2 * (e_ - w_), s_ + 0.1 * (n_ - s_)]]
    plot = {"name": "plot", "areaM2": 1.0, "geojson": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}]}}
    out = []
    for tile, threads in ((10**9, "1"), (r.gw * 7, "4")):
        monkeypatch.setattr(tiles, "TILE_PIXELS", tile)
        monkeypatch.setenv("TERRAX_TILE_THREADS", threads)
        out.append(classify_land_cover(r, [0, 1, 2, 3], 5, {"red": 2, "nir": 3}, plot))
    whole, strips = out
    assert np.array_equal(whole["classes"], strips["classes"]) and whole["iterations"] == strips["iterations"]
    assert [c["pixels"] for c in whole["stats"]] == [c["pixels"] for c in strips["stats"]]
    for a, b in zip(whole["stats"], strips["stats"], strict=True):
        assert a["bandMeans"] == pytest.approx(b["bandMeans"], rel=1e-12) and a["ha"] == pytest.approx(b["ha"], rel=1e-12)
    assert whole["notes"] == strips["notes"]


def test_terrain_strips_equal_whole_grid(tmp_path, monkeypatch):
    from terrax.processing.terrain import analyze_terrain

    rng = np.random.default_rng(9)
    yy, xx = np.mgrid[0:403, 0:517]
    z = 800 + 300 * np.sin(yy / 50) * np.cos(xx / 70) + rng.normal(0, 1, (403, 517))
    z[100:110, 200:230] = np.nan
    r = Raster(_tif(tmp_path / "dem.tif", z))
    out = []
    for tile, threads in ((10**9, "1"), (517 * 9, "4")):
        monkeypatch.setattr(tiles, "TILE_PIXELS", tile)
        monkeypatch.setenv("TERRAX_TILE_THREADS", threads)
        out.append(analyze_terrain(r, BOUNDARY))
    whole, strips = out
    for k in ("_slope", "_hillshade", "_dem"):
        assert np.array_equal(whole[k], strips[k], equal_nan=True), k
    for k in ("slopeClassCounts", "aspectCounts", "flatCount", "notes"):
        assert whole[k] == strips[k], k
    for g in ("elevation", "slope"):
        for k in ("n", "min", "max", "median", "q1", "q3"):
            assert whole[g][k] == strips[g][k]
        assert strips[g]["mean"] == pytest.approx(whole[g]["mean"], rel=1e-12)
