"""TerraX on local files without the server: the Python API (terrax.local), the `terrax` command, and the GeoTIFFs
other GIS software reads (class maps with their colour tables, slope, flow accumulation, wetness)."""

import json
import re
from pathlib import Path

import numpy as np
import pytest
import rasterio

SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


def test_the_tool_table_matches_the_tools():
    from terrax.local import TOOLS, WEB_ONLY
    from terrax.tools import load_all

    registered = set(load_all())
    assert set(TOOLS) | set(WEB_ONLY) == registered
    sources = {name: Path(__import__(fn.__module__, fromlist=["x"]).__file__).read_text() for name, fn in load_all().items()}
    for name, t in TOOLS.items():
        for slot in t["inputs"]:
            assert re.search(rf'["\']{slot}["\']', sources[name]), f"{name} does not read the input “{slot}”"


def test_forest_loss_from_python_with_a_georeferenced_class_map(tmp_path):
    from terrax import storage
    from terrax.local import run

    res = run("forest", {"a": SAMPLES / "forest_ndvi_2016_synthetic.tif", "b": SAMPLES / "forest_ndvi_2024_synthetic.tif"}, {"mode": "ndvi"}, out=tmp_path / "out")
    assert res["result"]["loss"]["ha"] == pytest.approx(184.05)  # the web app's answer
    assert res.result["map"]["image"]["url"] == "change.png" and "tiles" not in res.result["map"]["image"]
    names = {f.name for f in res.files}
    assert {"change.png", "forest_ndvi_2016_synthetic_forest_change.tif", "forest_ndvi_2016_synthetic_loss_patches.geojson"} <= names
    assert json.loads((tmp_path / "out" / "result.json").read_text())["result"]["loss"]["pixels"] == res["result"]["loss"]["pixels"]
    assert (tmp_path / "out" / "report.md").read_text().startswith("## Dataset")
    with rasterio.open(SAMPLES / "forest_ndvi_2016_synthetic.tif") as src, rasterio.open(tmp_path / "out" / "forest_ndvi_2016_synthetic_forest_change.tif") as d:
        assert d.crs == src.crs and d.transform == src.transform and d.nodata == 0 and d.dtypes[0] == "uint8"
        classes = d.read(1)
        cmap = d.colormap(1)
    assert int((classes == 2).sum()) == res["result"]["loss"]["pixels"]
    assert cmap[2][:3] == tuple(res["legend"][1]["color"])  # "Forest loss" in the legend's colour
    # The run leaves nothing behind: its job is deleted and its copies of the inputs are gone.
    from sqlalchemy import select

    from terrax import db

    with db.connect() as c:
        assert not c.execute(select(db.jobs.c.id).where(db.jobs.c.owner == "local")).first()
        left = c.execute(select(db.files.c.id).where(db.files.c.owner == "local", db.files.c.purged.is_(False))).all()
    assert not left and not any((storage.root() / "files" / r.id).exists() for r in left)


def test_land_cover_class_map_matches_its_class_table(tmp_path):
    from terrax.local import run

    res = run("landcover", {"file": SAMPLES / "satellite_4band_synthetic.tif"}, {"method": "kmeans", "k": 4, "bands": [0, 1, 2, 3]}, out=tmp_path)
    tif = next(f for f in res.files if f.name.endswith("_landcover.tif"))
    with rasterio.open(tif) as d:
        classes = d.read(1)
        assert set(d.colormap(1)) >= {1, 2, 3, 4}
    for c in res["landcover"]["stats"]:
        assert int((classes == c["id"]).sum()) == c["pixels"]


def test_terrain_and_hydrology_rasters(tmp_path):
    from terrax.local import run

    dem = SAMPLES / "terrain_dem_synthetic.tif"
    t = run("terrain", {"dem": dem}, {}, out=tmp_path / "t")
    with rasterio.open(tmp_path / "t" / "slope_deg.tif") as d, rasterio.open(dem) as src:
        slope = d.read(1)
        assert d.crs == src.crs and d.transform == src.transform
    assert float(np.nanmean(slope)) == pytest.approx(t["terrain"]["slope"]["mean"], rel=1e-4)
    h = run("hydrology", {"dem": dem}, {"thresholdKm2": 0.5, "method": "dinf"}, out=tmp_path / "h")
    with rasterio.open(tmp_path / "h" / "flow_accumulation_m2.tif") as d:
        acc = d.read(1)
    with rasterio.open(tmp_path / "h" / "twi.tif") as d:
        twi = d.read(1)
    cell = abs(src.transform.a * src.transform.e)
    assert np.nanmin(acc) == pytest.approx(cell, rel=1e-3)  # a ridge cell drains only itself
    assert np.nanmax(acc) <= np.isfinite(acc).sum() * cell * 1.0001  # no cell drains more than the whole DEM
    assert h["wetness"]["summary"]["mean"] == pytest.approx(float(np.nanmean(twi)), rel=1e-4)


def test_series_takes_several_files(tmp_path):
    from terrax.local import run

    files = sorted(SAMPLES.glob("series_ndvi_*_synthetic.tif"))
    res = run("stack", {"files": files}, {"index": "ndvi", "mapBreaks": True, "minDrop": 0.15}, out=tmp_path)
    assert res["breaks"]["disturbedHa"] == pytest.approx(54, rel=0.01)  # the web app's three fronts of 18 ha
    assert {"disturbance_date.tif", "disturbance_by_date.csv"} <= {f.name for f in res.files}


def test_command_line(tmp_path, capsys):
    from terrax.cli import _inputs, _params, main

    assert _params(["mode=ndvi", "mmuHa=0.5", "view.mode=index", "view.bands.red=2", "labels=[\"a\",\"b\"]"], None) == {
        "mode": "ndvi", "mmuHa": 0.5, "view": {"mode": "index", "bands": {"red": 2}}, "labels": ["a", "b"]}
    assert _inputs(["a=x.tif", "files=1.tif,2.tif", "files2=one.tif"]) == {"a": "x.tif", "files": ["1.tif", "2.tif"], "files2": "one.tif"}
    assert main(["tools"]) == 0 and "forest" in capsys.readouterr().out
    assert main(["tools", "--json"]) == 0 and "a" in json.loads(capsys.readouterr().out)["tools"]["forest"]["inputs"]
    out = tmp_path / "terrain"
    assert main(["run", "terrain", "-i", f"dem={SAMPLES / 'terrain_dem_synthetic.tif'}", "-o", str(out)]) == 0
    assert "Hypsometric integral" in capsys.readouterr().out and (out / "slope_deg.tif").is_file()
    # A boundary file limits the analysis: the western half of the forest image holds part of its 184.05 ha of loss.
    from rasterio.warp import transform_bounds

    with rasterio.open(SAMPLES / "forest_ndvi_2016_synthetic.tif") as d:
        w, s_, e, n = transform_bounds(d.crs, "EPSG:4326", *d.bounds)
    half = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [
        [[w, s_], [(w + e) / 2, s_], [(w + e) / 2, n], [w, n], [w, s_]]]}}]}
    (tmp_path / "west.geojson").write_text(json.dumps(half))
    assert main(["run", "forest", "-i", f"a={SAMPLES / 'forest_ndvi_2016_synthetic.tif'}", "-i", f"b={SAMPLES / 'forest_ndvi_2024_synthetic.tif'}",
                 "--boundary", str(tmp_path / "west.geojson"), "--json"]) == 0
    west = json.loads(capsys.readouterr().out)["result"]["loss"]["ha"]
    assert 0 < west < 184.05
    assert main(["run", "forest", "-i", "a=/no/such.tif"]) == 1 and "no file" in capsys.readouterr().err
    assert main(["run", "sentinel", "-p", "bbox=[1,2,3,4]"]) == 1 and "web app" in capsys.readouterr().err
    assert main(["run", "nope"]) == 1 and "Unknown tool" in capsys.readouterr().err


def test_a_tool_error_is_reported(tmp_path):
    from terrax.local import TerraxError, run

    with pytest.raises(TerraxError, match="loss threshold"):
        run("forest", {"a": SAMPLES / "forest_ndvi_2016_synthetic.tif", "b": SAMPLES / "forest_ndvi_2024_synthetic.tif"}, {"mode": "ndvi", "lossThreshold": 0.3})
