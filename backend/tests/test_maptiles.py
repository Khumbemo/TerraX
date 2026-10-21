"""Full-resolution XYZ tiles: tile geometry, overview choice and agreement with the grid they come from."""

import math

import numpy as np
import pytest
from pyproj import Transformer
from rasterio.transform import from_origin

from terrax.processing.maptiles import ORIGIN, TileSource, native_zoom, render_tile, tile_bounds


def test_tile_bounds_and_native_zoom():
    assert tile_bounds(0, 0, 0) == pytest.approx((-ORIGIN, -ORIGIN, ORIGIN, ORIGIN))
    w, s, e, n = tile_bounds(1, 1, 0)  # north-east quarter
    assert (w, s, e, n) == pytest.approx((0, 0, ORIGIN, ORIGIN))
    # 10 m cells at the equator: zoom 14 pixels are 9.55 m, zoom 13 19.1 m.
    assert native_zoom(10, 0) == 14 and native_zoom(30, 0) == 13 and native_zoom(10, 60) == 13


def _lonlat_to_tile(lon, lat, z):
    n = 2**z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y)


def test_tiles_match_the_class_grid_at_full_resolution(tmp_path):
    # 3,000 × 2,000 cells of 10 m in UTM 46N: 1-cell stripes no 4096-px picture could show at this size.
    h, w = 2000, 3000
    rr, cc = np.mgrid[0:h, 0:w]
    classes = (1 + (cc % 2) + 2 * ((rr // 50) % 2)).astype(np.uint8)
    classes[:100, :100] = 0  # no data
    tr = from_origin(500000, 3000000, 10, 10)
    palette = {"1": [255, 0, 0], "2": [0, 255, 0], "3": [0, 0, 255], "4": [255, 255, 0]}
    src = TileSource(tmp_path / "tiles_c.tif", w, h, tr, "EPSG:32646", "uint8", {"kind": "classes", "palette": palette}, nodata=0)
    for r0 in range(0, h, 700):
        src.write(r0, classes[r0 : r0 + 700])
    src.close()
    to_ll = Transformer.from_crs(32646, 4326, always_xy=True)
    to_utm = Transformer.from_crs(3857, 32646, always_xy=True)
    lon, lat = to_ll.transform(500000 + 15000, 3000000 - 10000)  # the grid centre
    z = 17  # 1.07 m pixels at 26.7°: well inside one cell
    x, y = _lonlat_to_tile(lon, lat, z)
    rgba = render_tile(tmp_path / "tiles_c.tif", z, x, y)
    assert rgba is not None and rgba.shape == (256, 256, 4)
    wb, sb, eb, nb = tile_bounds(z, x, y)
    px = wb + (np.arange(256) + 0.5) * (eb - wb) / 256
    py = nb - (np.arange(256) + 0.5) * (nb - sb) / 256
    PX, PY = np.meshgrid(px, py)
    ex, ny = to_utm.transform(PX, PY)
    col = np.floor((ex - 500000) / 10).astype(int)
    row = np.floor((3000000 - ny) / 10).astype(int)
    want = np.array([palette[str(v)] for v in range(1, 5)], dtype=np.uint8)[classes[row, col] - 1]
    assert (rgba[..., :3] == want).all(axis=-1).mean() > 0.99  # nearest neighbour; only ties on cell edges may differ
    # Zoomed out, the tile is read from an overview and still covers the grid; outside it there is no tile.
    zx, zy = _lonlat_to_tile(lon, lat, 9)
    out = render_tile(tmp_path / "tiles_c.tif", 9, zx, zy)
    assert out is not None and out[..., 3].any() and not out[..., 3].all()  # the 30 km grid fills part of a 78 km tile
    assert render_tile(tmp_path / "tiles_c.tif", 17, 0, 0) is None
    assert render_tile(tmp_path / "tiles_c.tif", 3, 99, 0) is None
    # The no-data corner is transparent.
    clon, clat = to_ll.transform(500000 + 500, 3000000 - 500)
    cx, cy = _lonlat_to_tile(clon, clat, 17)
    corner = render_tile(tmp_path / "tiles_c.tif", 17, cx, cy)
    assert corner is None or not corner[..., 3].any()


def test_ramp_tiles_keep_nan_transparent(tmp_path):
    h, w = 600, 600
    v = np.tile(np.linspace(0, 1, w, dtype=np.float32), (h, 1))
    v[:, :300] = np.nan
    src = TileSource(tmp_path / "tiles_v.tif", w, h, from_origin(94.0, 26.0, 0.0001, 0.0001), "EPSG:4326", "float32", {"kind": "ramp", "min": 0, "max": 1}, nodata=float("nan"))
    src.write(0, v)
    src.close()
    x, y = _lonlat_to_tile(94.03, 25.97, 15)
    rgba = render_tile(tmp_path / "tiles_v.tif", 15, x, y)
    assert rgba is not None
    wb, _, eb, _ = tile_bounds(15, x, y)
    lon = Transformer.from_crs(3857, 4326, always_xy=True).transform(wb + (np.arange(256) + 0.5) * (eb - wb) / 256, np.zeros(256))[0]
    alpha = rgba[..., 3]
    west, east = lon < 94.03 - 1e-4, lon > 94.03 + 1e-4  # a cell of margin on either side of the NaN edge
    assert west.any() and east.any() and alpha[:, west].max() == 0 and alpha[:, east].min() == 255


@pytest.mark.parametrize("tool,inputs,params", [
    ("forest", {"a": "forest_ndvi_2016_synthetic.tif", "b": "forest_ndvi_2024_synthetic.tif"}, {"mode": "ndvi"}),
    ("landcover", {"file": "satellite_4band_synthetic.tif"}, {"bands": [0, 1, 2, 3], "k": 4, "roles": {"red": 2, "nir": 3}}),
    ("raster", {"file": "satellite_4band_synthetic.tif"}, {"view": {"mode": "index", "index": "ndvi", "bands": {"red": 2, "nir": 3}}}),
    ("terrain", {"dem": "terrain_dem_synthetic.tif"}, {}),
    ("radar", {"before": "s1_vv_vh_2023-01-08_synthetic.tif", "after": "s1_vv_vh_2024-01-03_synthetic.tif"}, {"vv": 0, "vh": 1}),
    ("canopy", {"cloud": "lidar_forest_synthetic.laz"}, {"cell": 1, "threshold": 2, "minTree": 5}),
])
def test_tools_publish_tiles_for_grids_larger_than_the_picture(client, monkeypatch, tool, inputs, params):
    from terrax.tools import common

    monkeypatch.setattr(common, "TILES_MIN_SIDE", 32)
    ids = {k: client.post("/api/samples", json={"name": v}).json()["id"] for k, v in inputs.items()}
    job = client.post("/api/jobs", json={"tool": tool, "inputs": ids, "params": params}).json()
    assert job["state"] == "done", job.get("message")
    t = job["result"]["map"]["image"]["tiles"]
    assert t and t["minzoom"] <= t["maxzoom"] and "{z}/{x}/{y}.png" in t["url"]
    w, s, e, n = t["bounds"]
    z = t["maxzoom"]
    while z > 0:  # a zoom where the layer spans a few tiles
        (x0, y0), (x1, y1) = _lonlat_to_tile(w, n, z), _lonlat_to_tile(e, s, z)
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= 16:
            break
        z -= 1
    codes = []
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            r = client.get(t["url"].format(z=z, x=x, y=y))
            codes.append(r.status_code)
            if r.status_code == 200:
                assert r.headers["content-type"] == "image/png" and r.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert 200 in codes and set(codes) <= {200, 204}
    assert client.get(t["url"].format(z=z, x=0, y=0)).status_code == 204  # far from the layer
    assert client.get(t["url"].replace("/tiles/", "/tiles/nope").format(z=1, x=0, y=0)).status_code == 404
