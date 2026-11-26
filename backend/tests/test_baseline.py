"""Forest at the start from a tree-cover, canopy height or class map (processing/baseline.py) instead of NDVI ≥ 0.5."""

import numpy as np
import pytest

from tests.test_tools import run, run_err

E0, N0 = 600000, 2850000


def _tif(tmp_path, client, name, data, res, nodata=np.nan, dtype="float32"):
    import rasterio
    from rasterio.transform import from_origin

    p = tmp_path / name
    h, w = data.shape
    with rasterio.open(p, "w", driver="GTiff", width=w, height=h, count=1, dtype=dtype, crs="EPSG:32646", transform=from_origin(E0, N0, res, res), nodata=nodata) as d:
        d.write(data.astype(dtype), 1)
    with p.open("rb") as fh:
        return client.post("/api/files", files={"file": (name, fh, "image/tiff")}).json()["id"]


@pytest.fixture()
def scene(client, tmp_path):
    """100 × 100 px of 30 m. West half: dense crops (NDVI 0.8), harvested in rows 0–49 (NDVI 0.2). East half: forest
    (NDVI 0.7), cleared in rows 0–19, columns 50–79 (600 px = 54 ha)."""
    before = np.full((100, 100), 0.8)
    before[:, 50:] = 0.7
    after = before.copy()
    after[:50, :50] = 0.2
    after[:20, 50:80] = 0.2
    return {"a": _tif(tmp_path, client, "ndvi_2018.tif", before, 30), "b": _tif(tmp_path, client, "ndvi_2024.tif", after, 30), "tmp": tmp_path}


def test_ndvi_rule_counts_the_harvest_as_loss(client, scene):
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"]}, {"mode": "ndvi"})["result"]
    assert r["loss"]["ha"] == pytest.approx(54 + 225) and r["forestRule"] == "NDVI ≥ 0.5"


def test_tree_cover_map(client, scene):
    """A 60 m tree-cover map in percent: 60 % over the forest, 0 % over the crops, with a 0.36 ha clump of trees in
    the crops (2 × 2 px of 30 m) that the 0.5 ha rule drops."""
    cover = np.zeros((50, 50))
    cover[:, 25:] = 60
    m = _tif(client=client, tmp_path=scene["tmp"], name="treecover.tif", data=cover, res=60)
    res = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "cover"}})
    r = res["result"]
    assert r["loss"]["ha"] == pytest.approx(54) and r["forestBefore"]["ha"] == pytest.approx(450) and r["forestRule"] == "tree cover ≥ 10 %"
    assert "Forest at start (tree cover ≥ 10 %)" in res["markdown"] and "NDVI thresholds are a proxy" not in res["markdown"]
    # As fractions (0–1), read as percent; a stricter threshold than the map's cover leaves no forest.
    frac = _tif(client=client, tmp_path=scene["tmp"], name="treecover_frac.tif", data=cover / 100, res=60)
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": frac}, {"mode": "ndvi", "forestMap": {"kind": "cover"}})
    assert r["result"]["loss"]["ha"] == pytest.approx(54) and any("as a fraction" in n for n in r["result"]["notes"])
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "cover", "minCover": 70}})
    assert r["result"]["loss"]["ha"] == 0


def test_canopy_height_model_counts_tall_tree_cover(client, scene):
    """A 10 m CHM: 20 m trees over the forest; in the crops, a 0.36 ha clump of trees (removed: under 0.5 ha) and
    4 m bushes on half the cells (dense, but below the 5 m tree height, so not forest)."""
    chm = np.zeros((300, 300))
    chm[:, 150:] = 20
    chm[240:246, 30:36] = 20  # 6 × 6 cells of 10 m = 2 × 2 px of 30 m = 0.36 ha
    chm[:, :100][:, ::2] = 4
    m = _tif(client=client, tmp_path=scene["tmp"], name="chm.tif", data=chm, res=10)
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "height"}})["result"]
    assert r["loss"]["ha"] == pytest.approx(54) and r["forestBefore"]["ha"] == pytest.approx(450)
    assert r["forestRule"] == "cover of trees ≥ 5 m ≥ 10 %" and any("smaller than 0.5 ha" in n for n in r["notes"])
    # Without the minimum area, the clump counts as forest (4 px).
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "height", "minHa": 0}})["result"]
    assert r["forestBefore"]["ha"] == pytest.approx(450 + 0.36)


def test_class_map_and_partial_cover(client, scene):
    """An ESA WorldCover-like map (10 trees, 40 cropland) covering only rows 0–59: the rest is left out."""
    classes = np.full((100, 100), 40)
    classes[:, 50:] = 10
    classes[60:] = 0
    m = _tif(client=client, tmp_path=scene["tmp"], name="worldcover.tif", data=classes, res=30, nodata=0, dtype="uint8")
    r = run(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "classes", "classes": [10]}})["result"]
    assert r["loss"]["ha"] == pytest.approx(54) and r["forestBefore"]["ha"] == pytest.approx(60 * 50 * 0.09) and r["validPixels"] == 6000
    assert r["forestRule"] == "class 10 in the class map" and any("covers 60 %" in n for n in r["notes"])
    assert "Name the forest classes" in run_err(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "classes"}})
    assert "Choose a forest map kind" in run_err(client, "forest", {"a": scene["a"], "b": scene["b"], "forestMap": m}, {"mode": "ndvi", "forestMap": {"kind": "lidar"}})
