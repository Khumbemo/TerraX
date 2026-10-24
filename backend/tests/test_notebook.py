"""TerraX in Jupyter: results on an ipyleaflet map (terrax.notebook), and the quickstart notebook running top to bottom."""

import base64
import io
import math
from pathlib import Path

import numpy as np
import pytest

L = pytest.importorskip("ipyleaflet")

ROOT = Path(__file__).resolve().parent.parent.parent
SAMPLES = ROOT / "backend" / "data" / "samples"


def _png(url: str) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA"))


def test_forest_result_on_a_map(tmp_path):
    import rasterio
    from rasterio.warp import transform_bounds

    from terrax.local import run
    from terrax.notebook import raster_image, show

    res = run("forest", {"a": SAMPLES / "forest_ndvi_2016_synthetic.tif", "b": SAMPLES / "forest_ndvi_2024_synthetic.tif"}, {"mode": "ndvi"}, out=tmp_path)
    assert res._repr_markdown_() == res.markdown and "184.05 ha" in res.markdown
    m = show(res)
    overlays = [lyr for lyr in m.layers if isinstance(lyr, L.ImageOverlay)]
    shapes = [lyr for lyr in m.layers if isinstance(lyr, L.GeoJSON)]
    assert [o.name for o in overlays] == ["forest ndvi 2016 synthetic forest change"] and [g.name for g in shapes] == ["forest ndvi 2016 synthetic loss patches"]
    legend = next(c for c in m.controls if isinstance(c, L.LegendControl))
    colors = {c["label"]: "#{:02x}{:02x}{:02x}".format(*c["color"]) for c in res["legend"]}
    assert legend.legend == colors  # the four classes, in the class map's colours
    # Reprojected to Web Mercator for the map, the picture covers the raster's own footprint.
    tif = tmp_path / "forest_ndvi_2016_synthetic_forest_change.tif"
    with rasterio.open(tif) as d:
        w, s, e, n = transform_bounds(d.crs, "EPSG:4326", *d.bounds)
    (s2, w2), (n2, e2) = overlays[0].bounds
    cell_deg = 30 / 111_320
    assert abs(s2 - s) < 2 * cell_deg and abs(n2 - n) < 2 * cell_deg and abs(w2 - w) < 2 * cell_deg and abs(e2 - e) < 2 * cell_deg
    (lat, lon), zoom = m.center, m.zoom
    assert s < lat < n and w < lon < e and zoom == 13
    # Class colours are kept exactly (nearest neighbour), and only the legend's colours appear.
    img = _png(raster_image(tif)["url"])
    seen = {tuple(px[:3]) for px in img.reshape(-1, 4) if px[3]}
    assert seen <= {tuple(c["color"]) for c in res["legend"]} and len(seen) == 4
    # The picture and the loss polygons line up: inside each patch (a point on its surface, in Web Mercator) the
    # overlay shows the loss colour.
    from shapely.geometry import shape

    (south, west), (north, east) = overlays[0].bounds
    merc = lambda lat: math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    h_px, w_px = img.shape[:2]
    hits = total = 0
    for f in shapes[0].data["features"]:
        pt = shape(f["geometry"]).representative_point()
        col = int((pt.x - west) / (east - west) * w_px)
        row = int((merc(north) - merc(pt.y)) / (merc(north) - merc(south)) * h_px)
        total += 1
        hits += tuple(img[min(row, h_px - 1), min(col, w_px - 1), :3]) == tuple(res["legend"][1]["color"])
    assert total >= 3 and hits == total, (hits, total)
    loss = np.all(img[..., :3] == res["legend"][1]["color"], axis=-1).sum()
    assert loss / (img[..., 3] > 0).sum() == pytest.approx(2045 / 48000, rel=0.1)  # share of loss pixels, after resampling


def test_continuous_rasters_and_points(tmp_path):
    from terrax.local import run
    from terrax.notebook import raster_image, show

    h = run("hydrology", {"dem": SAMPLES / "terrain_dem_synthetic.tif"}, {"method": "dinf", "thresholdKm2": 0.5}, out=tmp_path / "h")
    m = show(h)
    names = {lyr.name for lyr in m.layers}
    assert {"flow accumulation m2", "twi"} <= names and any("streams" in n for n in names)
    acc = raster_image(tmp_path / "h" / "flow_accumulation_m2.tif")
    lo, hi = acc["range"]
    assert lo >= math.log10(900) - 0.01 and hi > lo  # log10 of m², from one 30 m cell upwards
    twi = raster_image(tmp_path / "h" / "twi.tif")
    assert twi["range"][0] < h["wetness"]["summary"]["median"] < twi["range"][1]
    c = run("canopy", {"cloud": SAMPLES / "lidar_forest_synthetic.laz"}, {}, out=tmp_path / "c")
    tops = next(lyr for lyr in show(c).layers if isinstance(lyr, L.GeoJSON) and "tree tops" in lyr.name)
    assert len(tops.data["features"]) == 25 and tops.point_style["radius"] == 4


def test_show_needs_an_output_folder():
    from terrax.local import run
    from terrax.notebook import show

    res = run("terrain", {"dem": SAMPLES / "terrain_dem_synthetic.tif"}, {})
    with pytest.raises(ValueError, match="out="):
        show(res)


def test_the_quickstart_notebook_runs(tmp_path):
    nbformat = pytest.importorskip("nbformat")
    nbclient = pytest.importorskip("nbclient")
    pytest.importorskip("ipykernel")
    nb = nbformat.read(ROOT / "notebooks" / "terrax_quickstart.ipynb", as_version=4)
    work = tmp_path / "notebooks"
    work.mkdir()
    (tmp_path / "backend").symlink_to(ROOT / "backend")  # the notebook finds the samples next to its folder
    nbclient.NotebookClient(nb, timeout=300, kernel_name="python3", resources={"metadata": {"path": str(work)}}).execute()
    text = "\n".join(o.get("text", "") for c in nb.cells if c.cell_type == "code" for o in c.outputs if o.output_type == "stream")
    assert "Forest loss: 184.05 ha" in text and "25 tree tops" in text and "2021-03-09 18.0 ha" in text
    maps = [o for c in nb.cells if c.cell_type == "code" for o in c.outputs if "application/vnd.jupyter.widget-view+json" in o.get("data", {})]
    assert len(maps) == 4
