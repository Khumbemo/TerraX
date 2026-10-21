"""Statistics, dates, metrics, climate, hydrology, patches and EXIF (ported from the TypeScript unit tests)."""

import io
import itertools
import math
from datetime import date

import numpy as np
import pytest
from PIL import Image

from terrax.processing.analysis import analyze_metric
from terrax.processing.climate import MonthValue, compute_spi, monthly_anomalies, seasonal_kendall, spi_class, to_monthly
from terrax.processing.dates import date_spacing, detect_day_month_order, parse_date_cell
from terrax.processing.metrics import build_classification, detect_metric
from terrax.processing.patches import apply_mmu, label_patches, patch_areas
from terrax.processing.photo import read_exif
from terrax.processing.rio import Ground
from terrax.processing.stats import histogram, normal_cdf, quantile_sorted, summarize, trend_test
from terrax.processing.table import read_table
from terrax.processing.terrain import contour_grid, fill_depressions, flow_routing, nice_interval, snap_outlet, stream_lines, watershed

from .conftest import SAMPLES

approx = pytest.approx


def test_quantiles_type7_and_summary():
    assert quantile_sorted([1, 2, 3, 4], 0.5) == 2.5
    assert quantile_sorted([1, 2, 3, 4], 0.25) == 1.75
    s = summarize([2, 4, 4, 4, 5, 5, 7, 9])
    assert s.mean == 5 and s.sd == approx(2.138, abs=1e-3)


def test_normal_cdf():
    assert normal_cdf(1.96) == approx(0.975, abs=1e-4)
    assert normal_cdf(0) == approx(0.5, abs=1e-9)
    assert normal_cdf(-1) == approx(0.158655, abs=1e-5)


def test_mann_kendall_increasing():
    x = [2000 + i for i in range(10)]
    r = trend_test(x, [2 * (v - 2000) + 1 for v in x])
    assert r.s == 45 and r.z == approx(44 / math.sqrt(125), abs=1e-9) and r.p == approx(8.3e-5, abs=1e-5)
    assert r.sen_slope == approx(2) and r.ols_slope == approx(2) and r.direction == "increasing"


def test_theil_sen_resists_outlier_and_flat_noise():
    x = list(range(10))
    y = list(range(10))
    y[9] = 100
    assert trend_test(x, y).sen_slope == approx(1)
    assert trend_test(x, [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]).direction == "no trend"


def test_histogram_constant_and_bins():
    assert histogram(np.array([5.0, 5, 5]), 5, 5) == [{"x0": 5, "x1": 5, "count": 3}]
    assert [b["count"] for b in histogram(np.array([0, 0.5, 1]), 0, 1, 2)] == [1, 2]


def test_date_parsing():
    assert parse_date_cell("2014-02-43") is None
    assert parse_date_cell("2014-043") == date(2014, 2, 12)
    assert parse_date_cell("2016-02-29") == date(2016, 2, 29)
    assert parse_date_cell("2015-02-29") is None
    assert parse_date_cell("25-01-2014", "DMY") == date(2014, 1, 25)
    assert detect_day_month_order(["01-02-2014", "25-02-2014"]) == ("DMY", False)
    assert detect_day_month_order(["02-25-2014"]) == ("MDY", False)
    assert parse_date_cell(2014, "DMY", True) == date(2014, 1, 1)
    assert date_spacing([parse_date_cell(s) for s in ["2020-01-01", "2020-01-09", "2020-01-17"]])[0] == 8


@pytest.mark.parametrize(
    "name,metric",
    [("NDVI", "ndvi"), ("LST_C", "lst"), ("temp_C", "airTemp"), ("Solar_Radiation_MJ", "solar"), ("Evapotranspiration", "et"), ("precipitation", "precip"), ("gradient", "generic"), ("humidity", "humidity")],
)
def test_metric_detection_uses_whole_words(name, metric):
    assert detect_metric(name) == metric


def test_imd_rainfall_categories():
    c = build_classification("precipitation", [0, 1, 20], (2, 1))
    label = lambda v: c.buckets[c.classify(v)]["label"]
    assert "No rain" in label(0.05) and "Very light" in label(2.4)
    assert label(2.5).startswith("Light") and label(15.5).startswith("Light")
    assert "Moderate" in label(15.6) and label(64.5).startswith("Heavy") and "Extremely heavy" in label(204.5)
    assert c.note and "gaps" in c.note
    assert "Quartiles" in build_classification("precipitation", [1, 2, 3, 4], (8, 8)).basis


def test_et_and_temperature_and_scaled_ndvi():
    et = build_classification("Evapotranspiration", [16, 24], (8, 8))
    assert et.convert(16) == approx(2) and "Low (1–3" in et.buckets[et.classify(16)]["label"] and et.note
    t = build_classification("temp_C", [12, 14], (1, 1))
    assert "Freezing" in t.buckets[t.classify(-0.5)]["label"] and "Cold" in t.buckets[t.classify(5)]["label"]
    k = build_classification("LST", [290, 300], (8, 8))
    assert k.convert(273.15) == approx(0, abs=1e-9) and "Warm" in k.buckets[k.classify(300)]["label"]
    n = build_classification("NDVI", [6500, 7000, 8000], (16, 16))
    assert "Dense" in n.buckets[n.classify(7000)]["label"]


def test_bundled_series_parse_cleanly():
    for f in ["ndvi_data.csv", "lst_data.csv", "precipitation_data.csv", "temp_humidity_data.csv", "evapotranspiration_data.csv", "solar_radiation_data.csv"]:
        ds = read_table(SAMPLES / f)
        assert ds.time_column == "date" and ds.default_metric, f
        assert not any("not valid calendar dates" in w for w in ds.warnings), f
        assert all(t is not None for t in ds.times), f
    ndvi = read_table(SAMPLES / "ndvi_data.csv")
    assert ndvi.default_metric == "NDVI" and ndvi.interval_days == approx(16, abs=0.01)
    precip = read_table(SAMPLES / "precipitation_data.csv")
    assert "India Meteorological Department" in analyze_metric(precip, "precipitation").classification.basis
    et = read_table(SAMPLES / "evapotranspiration_data.csv")
    assert et.interval_days == approx(8, abs=0.01) and "seasonal cycle" in (analyze_metric(et, "Evapotranspiration").trend_caveat or "")
    a = analyze_metric(ndvi, "NDVI")
    assert a.summary.n == 31 and a.monthly and len(a.monthly) >= 10 and a.trend_caveat is None


# ── Climate ──────────────────────────────────────────────────────────────────


def lcg(seed):
    state = [seed]

    def r():
        state[0] = (state[0] * 1664525 + 1013904223) % 4294967296
        return (state[0] + 0.5) / 4294967296

    return r


def monthly_series(years, f):
    return [MonthValue(year=2000 + y, month=m, value=f(y, m), n=1, coverage=1) for y in range(years) for m in range(12)]


def test_seasonal_kendall_separates_trend_from_cycle():
    r = lcg(1)
    up = seasonal_kendall(monthly_series(10, lambda y, m: 10 * math.sin(m / 12 * 2 * math.pi) + 0.5 * y + (r() - 0.5)))
    assert up["direction"] == "increasing" and up["p"] < 0.001 and up["slope"] == approx(0.5, abs=0.1) and up["seasons"] == 12
    flat = seasonal_kendall(monthly_series(10, lambda y, m: 10 * math.sin(m / 12 * 2 * math.pi) + (r() - 0.5)))
    assert flat["direction"] == "no trend"
    assert flat["varS"] == approx(12 * (10 * 9 * 25) / 18)


def test_monthly_aggregation_and_anomalies():
    pts = [(date(2020, 1, d), 2.0) for d in range(1, 32)] + [(date(2020, 2, d), 4.0) for d in range(1, 11)]
    m = to_monthly(pts, 1)
    assert [(x.month, x.value, x.n) for x in m] == [(0, 2, 31), (1, 4, 10)]
    assert m[1].coverage == approx(10 / 29)  # 2020 is a leap year
    a = monthly_anomalies(monthly_series(3, lambda y, m: y))
    assert [x["anomaly"] for x in a["rows"] if x["month"] == 0] == [-1, 0, 1]
    assert a["rows"][0]["z"] == -1


def test_spi_of_gamma_rainfall_is_standard_normal():
    r = lcg(7)
    series = monthly_series(60, lambda y, m: -30 * (math.log(r()) + math.log(r())))  # gamma(2, 30)
    spi = compute_spi(series, 1, False)
    vals = np.array([x["spi"] for x in spi["rows"] if x["spi"] is not None])
    assert vals.size == 720 and abs(vals.mean()) < 0.05 and abs(vals.std(ddof=1) - 1) < 0.05 and spi["reliable"]
    spi3 = compute_spi(series[:120], 3, False)
    assert spi3["rows"][0]["spi"] is None and spi3["rows"][1]["spi"] is None and spi3["rows"][2]["spi"] is not None and not spi3["reliable"]
    assert spi_class(-2.3) == "Extremely dry" and spi_class(0.2) == "Near normal" and spi_class(1.7) == "Very wet"
    # Class limits of McKee et al. (1993): -1.0 to -1.49 moderately dry, -1.5 to -1.99 severely dry, -2 and below extremely dry.
    boundaries = {2.0: "Extremely wet", 1.5: "Very wet", 1.0: "Moderately wet", 0.99: "Near normal", -0.99: "Near normal",
                  -1.0: "Moderately dry", -1.49: "Moderately dry", -1.5: "Severely dry", -1.99: "Severely dry", -2.0: "Extremely dry"}
    assert {v: spi_class(v) for v in boundaries} == boundaries
    dry = compute_spi(monthly_series(40, lambda y, m: 0 if m == 0 and y % 4 == 0 else 50 + (y * 7 + m * 3) % 11), 1, False)
    jan0 = next(x for x in dry["rows"] if x["month"] == 0 and x["year"] == 2000)
    assert jan0["spi"] < -0.5


# ── Hydrology ────────────────────────────────────────────────────────────────


def unit_ground(h):
    return Ground(cell_area=np.full(h, 100.0), dx=np.full(h, 10.0), dy=np.full(h, 10.0), note="")


def grid(w, h, f):
    return np.array([[f(x, y) for x in range(w)] for y in range(h)], dtype=np.float32)


def test_priority_flood_fills_pit_to_spill_level():
    g = grid(5, 5, lambda x, y: 0 if (x, y) == (2, 2) else 5 if x in (0, 4) or y in (0, 4) else 10)
    filled, raised, _ = fill_depressions(g)
    assert 10 <= filled[2, 2] < 10.001 and raised == 1
    f = flow_routing(g, unit_ground(5), 1e9)
    assert (f["dir"] < 0).sum() <= 16


def test_d8_on_tilted_plane():
    f = flow_routing(grid(6, 4, lambda x, y: 100 - x), unit_ground(4), 1e9)
    assert (f["dir"][:, :-1] == 4).all()  # east
    assert (f["acc"][:, -1] == 600).all()


def test_strahler_and_watershed_on_y_valley():
    w, h = 13, 22

    def seg(px, py, ax, ay, bx, by):
        t = max(0, min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        return math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay))

    g = grid(w, h, lambda x, y: 200 - 2 * y + 8 * min(seg(x, y, 2, 0, 6, 10), seg(x, y, 10, 0, 6, 10), seg(x, y, 6, 10, 6, 21)))
    f = flow_routing(g, unit_ground(h), 900)
    assert f["maxOrder"] == 2 and f["order"][20, 6] == 2
    assert f["order"][6, 4] == 1 or f["order"][6, 3] == 1
    outlet = snap_outlet(f["acc"], 6, 21, 1)
    mask, cells = watershed(f["dir"], outlet)
    assert cells > w * 10 and mask[2, 3] == 1 and mask[0, 2] == 0
    assert f["lengthByOrder"][1] > 0 and f["lengthByOrder"][2] > 0



def test_stream_lines_split_at_junctions_like_the_cell_walk():
    w, h = 13, 22

    def seg(px, py, ax, ay, bx, by):
        t = max(0, min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
        return math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay))

    g = grid(w, h, lambda x, y: 200 - 2 * y + 8 * min(seg(x, y, 2, 0, 6, 10), seg(x, y, 10, 0, 6, 10), seg(x, y, 6, 10, 6, 21)))
    f = flow_routing(g, unit_ground(h), 900)
    fc = stream_lines(f, lambda c, r: (np.asarray(c, dtype=float), np.asarray(r, dtype=float)))
    # Reference: walk each source or junction cell downstream in plain Python.
    d, o = f["dir"], f["order"]
    DR, DC = (-1, -1, -1, 0, 0, 1, 1, 1), (-1, 0, 1, -1, 1, -1, 0, 1)

    def down(r, c):
        k = d[r, c]
        rr, cc = r + DR[k], c + DC[k]
        return None if k < 0 or not (0 <= rr < h and 0 <= cc < w) else (rr, cc)

    inflow = np.zeros((h, w), int)
    for r, c in zip(*np.nonzero(o), strict=True):
        m = down(r, c)
        if m and o[m]:
            inflow[m] += 1
    ref = []
    for r, c in zip(*np.nonzero(o), strict=True):
        if inflow[r, c] == 1:
            continue
        pts, cur = [(r, c)], (r, c)
        while (m := down(*cur)) and o[m]:
            pts.append(m)
            if inflow[m] != 1:
                break
            cur = m
        if len(pts) >= 2:
            ref.append((int(o[r, c]), [[cc + 0.5, rr + 0.5] for rr, cc in pts]))
    got = [(ft["properties"]["strahler"], ft["geometry"]["coordinates"]) for ft in fc["features"]]
    assert got == ref
    assert {s for s, _ in got} == {1, 2}
    covered = {tuple(p) for _, line in got for p in line}
    assert all((c + 0.5, r + 0.5) in covered for r, c in zip(*np.nonzero(o), strict=True))

def test_contours_on_a_plane():
    w, h = 5, 6
    [(level, lines)] = contour_grid(grid(w, h, lambda x, y: x), [1.5])
    assert level == 1.5 and len(lines) == 1 and len(lines[0]) == h
    assert all(abs(p[0] - 2) < 1e-9 for p in lines[0])
    ys = sorted(p[1] for p in lines[0])
    assert (ys[0], ys[-1]) == (0.5, h - 0.5)
    assert (nice_interval(1000), nice_interval(730), nice_interval(18)) == (100, 50, 2)


def test_contours_join_and_simplify():
    # A cone: each level is one closed ring, its points at the level's radius (within the linear interpolation).
    n = 61
    yy, xx = np.mgrid[0:n, 0:n] + 0.5
    r = np.hypot(xx - n / 2, yy - n / 2)
    for level, lines in contour_grid(-r, [-5.0, -20.0]):
        assert len(lines) == 1 and lines[0][0] == lines[0][-1]
        assert all(abs(math.hypot(x - n / 2, y - n / 2) + level) < 0.15 for x, y in lines[0])
    full = contour_grid(-r, [-20.0])[0][1][0]
    simple = contour_grid(-r, [-20.0], tol=0.25)[0][1][0]
    assert simple[0] == simple[-1] and 8 < len(simple) < len(full)
    # every dropped vertex stays within the tolerance of the simplified ring
    segs = list(itertools.pairwise(simple))
    dist = lambda p, a, b: abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / math.hypot(b[0] - a[0], b[1] - a[1])
    assert all(min(dist(p, a, b) for a, b in segs) <= 0.25 + 1e-9 for p in full)
    # a gap of no data splits a line in two, and saddles never cross
    z = np.tile(np.arange(8.0), (6, 1))
    z[2, :] = np.nan
    assert len(contour_grid(z, [5.5])[0][1]) == 2
    sad = np.array([[1.0, 0.0], [0.0, 1.0]])
    assert len(contour_grid(sad, [0.5])[0][1]) == 2


# ── Patches ──────────────────────────────────────────────────────────────────


def test_eight_connected_labels_and_mmu():
    rows = ["#...", ".#..", "...#", "..##"]
    cls = np.array([[2 if ch == "#" else 1 for ch in r] for r in rows], dtype=np.uint8)
    labels, n = label_patches(cls == 2)
    assert n == 2
    assert sorted(patch_areas(labels, n, np.ones(4))[1:]) == [2, 3]
    m = apply_mmu(cls, cls == 2, 1, 3, np.ones(4))
    assert m["removedPatches"] == 1 and m["removedPixels"] == 2 and m["keptCount"] == 1 and (cls == 2).sum() == 3


# ── EXIF ─────────────────────────────────────────────────────────────────────


def _jpeg_with_exif(tmp_path, lat, lon, alt):
    ex = Image.Exif()
    ex[0x010F], ex[0x0110] = "DJI", "FC3170"
    gps = {1: "N" if lat >= 0 else "S", 2: _dms(abs(lat)), 3: "E" if lon >= 0 else "W", 4: _dms(abs(lon)), 5: 0 if alt >= 0 else 1, 6: abs(alt)}
    ex[0x8825] = gps
    ex.get_ifd(0x8769)[0x9003] = "2025:03:14 10:22:05"
    p = tmp_path / "x.jpg"
    Image.new("RGB", (8, 8), (40, 120, 40)).save(p, exif=ex)
    return p


def _dms(v):
    d = int(v)
    m = int((v - d) * 60)
    return (d, m, round((v - d - m / 60) * 3600, 4))


def test_exif_gps_camera_and_time(tmp_path):
    info = read_exif(_jpeg_with_exif(tmp_path, 25.6742, 94.1086, 1493.2))
    assert info["make"] == "DJI" and info["model"] == "FC3170" and info["dateTime"] == "2025:03:14 10:22:05"
    assert info["lat"] == approx(25.6742, abs=1e-5) and info["lon"] == approx(94.1086, abs=1e-5) and info["altitude"] == approx(1493.2)
    sw = read_exif(_jpeg_with_exif(tmp_path, -33.9, -70.6, -12))
    assert sw["lat"] < 0 and sw["lon"] < 0 and sw["altitude"] == approx(-12)


def test_images_without_exif(tmp_path):
    p = tmp_path / "plain.png"
    Image.new("RGB", (4, 4)).save(p)
    assert read_exif(p) is None
    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image at all")
    assert read_exif(bad) is None
    assert io


def test_plot_images_are_read_at_full_resolution_around_the_property(monkeypatch):
    """The plot grid samples each file's own pixels, whatever the whole-raster budget."""
    import json
    from pathlib import Path

    from terrax.processing.encroachment import prepare_geo_stack
    from terrax.processing.rio import Raster

    samples = Path(__file__).resolve().parents[1] / "data" / "samples"
    bnd = {"geojson": json.loads((samples / "plot_boundary_synthetic.geojson").read_text())}
    files = [samples / f"plot_{d}_synthetic.tif" for d in ("2019-02-10", "2024-02-08")]

    def stack():
        return prepare_geo_stack([{"raster": Raster(f), "label": f.stem} for f in files], bnd, 15)

    full = stack()
    monkeypatch.setenv("TERRAX_GRID_PIXELS", "1000")  # would coarsen a whole-raster read about 100×
    small = stack()
    assert (full["width"], full["height"], full["cellM"]) == (small["width"], small["height"], small["cellM"])
    for a, b in zip(full["layers"], small["layers"], strict=True):
        for x, y in zip(a["rgb"], b["rgb"], strict=True):
            np.testing.assert_array_equal(x, y)


def test_read_window_decimates_to_every_step_th_pixel(monkeypatch):
    from pathlib import Path

    from terrax.processing.rio import Raster

    path = Path(__file__).resolve().parents[1] / "data" / "samples" / "plot_2024-02-08_synthetic.tif"
    r = Raster(path)
    (full,), step = r.read_window([0], 5, 7, r.meta.width - 3, r.meta.height - 2)
    assert step == 1 and full.shape == (r.meta.height - 9, r.meta.width - 8)
    (thin,), step = r.read_window([0], 5, 7, r.meta.width - 3, r.meta.height - 2, max_pixels=full.size // 10)
    assert step == 4
    np.testing.assert_array_equal(thin, full[::step, ::step])


@pytest.mark.parametrize(("crs", "metres_per_unit"), [("EPSG:7755", 1.0), ("+proj=lcc +lat_0=24 +lon_0=80 +lat_1=12.47 +lat_2=35.17 +x_0=4000000 +y_0=4000000 +datum=WGS84 +units=us-ft", 1200 / 3937)])
def test_any_projected_crs_has_ground_units(tmp_path, crs, metres_per_unit):
    """A national LCC grid (metres, or US survey feet) gets true cell sizes: the same ground as a UTM file of the area."""
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import from_origin

    from terrax.processing.rio import Raster, ground_geometry

    lon, lat = 91.7, 26.15  # Guwahati
    x, y = Transformer.from_crs(4326, crs, always_xy=True).transform(lon, lat)
    cell = 30 / metres_per_unit  # about 30 m on the ground
    path = tmp_path / "lcc.tif"
    with rasterio.open(path, "w", driver="GTiff", width=200, height=150, count=1, dtype="float32", crs=crs, transform=from_origin(x, y, cell, cell)) as d:
        d.write(np.ones((1, 150, 200), np.float32))
    r = Raster(path)
    g = ground_geometry(r.meta, 200, 150)
    assert g is not None and "WGS84 ellipsoid" in g.note
    # Ground distance of one cell edge, from geodesics of the projected corners.
    from pyproj import Geod

    back = Transformer.from_crs(crs, 4326, always_xy=True)
    lo0, la0 = back.transform(x, y)
    lo1, la1 = back.transform(x + cell * 200, y)
    true_dx = Geod(ellps="WGS84").inv(lo0, la0, lo1, la1)[2] / 200
    assert g.dx[0] == pytest.approx(true_dx, rel=1e-5)
    assert g.cell_area.sum() * 200 == pytest.approx(200 * 150 * g.dx.mean() * g.dy.mean(), rel=2e-3)
    assert 29 < g.dx.mean() < 31 and 29 < g.dy.mean() < 31


def test_plot_images_in_a_national_grid_are_placed_on_the_property(tmp_path):
    import json
    from pathlib import Path

    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    from terrax.processing.encroachment import compare_layers, prepare_geo_stack
    from terrax.processing.rio import Raster

    samples = Path(__file__).resolve().parents[1] / "data" / "samples"
    bnd = {"geojson": json.loads((samples / "plot_boundary_synthetic.geojson").read_text())}
    dst_crs = "+proj=lcc +lat_0=24 +lon_0=80 +lat_1=12.47 +lat_2=35.17 +x_0=4000000 +y_0=4000000 +datum=WGS84 +units=us-ft"
    imgs = []
    for d in ("2019-02-10", "2024-02-08"):
        src_path, out = samples / f"plot_{d}_synthetic.tif", tmp_path / f"{d}.tif"
        with rasterio.open(src_path) as src:
            tr, w, h = calculate_default_transform(src.crs, dst_crs, src.width, src.height, *src.bounds, resolution=0.5 * 3937 / 1200)
            with rasterio.open(out, "w", driver="GTiff", width=w, height=h, count=3, dtype=src.dtypes[0], crs=dst_crs, transform=tr, nodata=0) as dst:
                for b in range(1, 4):
                    reproject(rasterio.band(src, b), rasterio.band(dst, b), dst_transform=tr, dst_crs=dst_crs, resampling=Resampling.nearest)
        imgs.append({"raster": Raster(out), "label": d})
    stack = prepare_geo_stack(imgs, bnd, 15)
    # 0.5 m of LCC grid is 0.5 / k_lcc m of ground, and k_utm × that on the property's UTM grid (PROJ's own scale factors).
    from pyproj import Proj

    ring = bnd["geojson"]["features"][0]["geometry"]["coordinates"][0]
    lon, lat = (sum(p[i] for p in ring[:-1]) / (len(ring) - 1) for i in (0, 1))
    k_lcc = Proj(dst_crs).get_factors(lon, lat).meridional_scale
    k_utm = Proj(f"EPSG:{stack['epsg']}").get_factors(lon, lat).meridional_scale
    assert stack["cellM"] == pytest.approx(0.5 / k_lcc * k_utm, rel=2e-3)
    cmp = compare_layers(stack, 0, 1, {})
    utm = compare_layers(prepare_geo_stack([{"raster": Raster(samples / f"plot_{d}_synthetic.tif"), "label": d} for d in ("2019-02-10", "2024-02-08")], bnd, 15), 0, 1, {})
    # The same extension as from the original UTM images (the ≈ 50 m² shed). Resampling twice with nearest neighbour moves
    # edges by up to a cell, so the 0.5 m fence-shift strip can land either side of the 1 m alignment tolerance.
    biggest = max((p for p in cmp["patches"] if p["zone"] == "crossing"), key=lambda p: p["areaInside"])
    ref = max((p for p in utm["patches"] if p["zone"] == "crossing"), key=lambda p: p["areaInside"])
    assert biggest["areaInside"] == pytest.approx(ref["areaInside"], rel=0.1) and biggest["depthInside"] == pytest.approx(ref["depthInside"], abs=0.6)
    assert cmp["changedInside"] == pytest.approx(utm["changedInside"], rel=0.1)


def test_dinf_specific_catchment_area_on_a_cone_and_planes():
    """Outward cone: a = πr² / 2πr = r/2; uniform plane: a = upslope flow length (Tarboton 1997's test surfaces)."""
    import math

    from terrax.processing.rio import Ground
    from terrax.processing.terrain import dinf_flow, fill_depressions, flow_routing

    n, c0 = 201, 100
    g = Ground(np.ones(n), np.ones(n), np.ones(n), "")
    rr, cc = np.mgrid[0:n, 0:n]
    rad = np.hypot(rr - c0, cc - c0)
    cone = (1000 - rad).astype(np.float64)
    d = dinf_flow(fill_depressions(cone)[0], g)
    ring = (rad > 10) & (rad < 80)
    err = (d["sca"][ring] - rad[ring] / 2) / (rad[ring] / 2)
    d8 = (flow_routing(cone, g, 1e12)["acc"][ring] - rad[ring] / 2) / (rad[ring] / 2)
    assert abs(err.mean()) < 0.02 and np.median(np.abs(err)) < 0.1
    assert np.median(np.abs(err)) < np.median(np.abs(d8)) / 4  # D8 cannot spread flow on divergent slopes
    # Wetness rises outward on the cone: catchment grows while the slope stays 45°.
    twi = d["twi"]
    assert np.nanmean(twi[(rad > 60) & (rad < 70)]) > np.nanmean(twi[(rad > 20) & (rad < 30)]) + 0.9  # ln(65/25) ≈ 0.96
    for deg in (0, 30, 45, 60):
        t = math.radians(deg)
        x, y = cc.astype(float), -rr.astype(float)
        d = dinf_flow(fill_depressions(-(x * math.cos(t) + y * math.sin(t)))[0], g)
        length = np.full(x.shape, np.inf)
        if math.cos(t) > 1e-9:
            length = np.minimum(length, (x + 0.5) / math.cos(t))
        if math.sin(t) > 1e-9:
            length = np.minimum(length, (n - 0.5 + y) / math.sin(t))
        inner = (rr > 20) & (rr < n - 20) & (cc > 20) & (cc < n - 20)
        assert np.median(np.abs(d["sca"][inner] / length[inner] - 1)) < 0.02, deg
        # Mass balance: everything leaves through outlet cells (no lower facet), and nothing is lost on the way.
        outlets = d["tanb"] == 0
        assert d["acc"][outlets].sum() == pytest.approx(n * n, rel=1e-9), deg


def _three_class_scene(tmp_path, n=240, seed=3):
    """A 4-band UTM scene: water (west), forest (centre), bare soil (east), with noise; and its true class map."""
    import rasterio
    from rasterio.transform import from_origin

    rng = np.random.default_rng(seed)
    truth = np.ones((n, n), np.uint8)
    truth[:, n // 3 :] = 2
    truth[:, 2 * n // 3 :] = 3
    means = {1: [0.06, 0.05, 0.03, 0.02], 2: [0.03, 0.06, 0.04, 0.40], 3: [0.12, 0.14, 0.18, 0.22]}  # blue, green, red, NIR
    img = np.stack([np.choose(truth - 1, [means[c][b] for c in (1, 2, 3)]) + rng.normal(0, 0.012, truth.shape) for b in range(4)]).astype(np.float32)
    path = tmp_path / "scene.tif"
    tr = from_origin(500000, 3000000, 10, 10)
    with rasterio.open(path, "w", driver="GTiff", width=n, height=n, count=4, dtype="float32", crs="EPSG:32646", transform=tr) as d:
        d.write(img)
    return path, truth, tr


def _box(tr, c0, r0, c1, r1, label):
    from pyproj import Transformer

    t = Transformer.from_crs(32646, 4326, always_xy=True)
    ring = [t.transform(*(tr @ (c, r))) for c, r in ((c0, r0), (c1, r0), (c1, r1), (c0, r1), (c0, r0))]
    return {"type": "Feature", "properties": {"Class": label}, "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ring]]}}


def test_random_forest_learns_a_known_scene_and_validates_by_shape(tmp_path):
    from terrax.processing.landcover import classify_supervised
    from terrax.processing.rio import Raster

    path, truth, tr = _three_class_scene(tmp_path)
    shapes = [_box(tr, 10, 10, 30, 30, "Water"), _box(tr, 20, 150, 40, 170, "Water"),
              _box(tr, 100, 20, 120, 40, "Forest"), _box(tr, 110, 180, 130, 200, "Forest"),
              _box(tr, 190, 60, 210, 80, "Bare"), _box(tr, 200, 200, 220, 220, "Bare")]
    res = classify_supervised(Raster(path), [0, 1, 2, 3], {"type": "FeatureCollection", "features": shapes}, {"red": 2, "nir": 3})
    assert res["labels"] == ["Bare", "Forest", "Water"] and res["labelField"] == "Class"
    want = np.choose(truth - 1, [3, 2, 1])  # Water→3, Forest→2, Bare→1 in the alphabetical codes
    assert (res["classes"] == want).mean() > 0.995
    v = res["validation"]
    assert v["folds"] == 2 and v["overall"] > 0.99 and np.array(v["confusion"]).sum() == res["trainingPixels"]
    forest = next(c for c in res["stats"] if c["label"] == "Forest")
    assert forest["ndvi"] > 0.7 and forest["ha"] == pytest.approx((want == 2).sum() * 0.01, rel=0.01)
    assert "not the map’s accuracy" in " ".join(res["notes"])
    # One shape per class: no cross-validation, and the notes say why.
    one = classify_supervised(Raster(path), [0, 1, 2, 3], {"type": "FeatureCollection", "features": shapes[::2]}, {})
    assert one["validation"] is None and "only one training shape" in " ".join(one["notes"])
    with pytest.raises(ValueError, match="property that holds"):
        classify_supervised(Raster(path), [0, 1, 2, 3], {"type": "FeatureCollection", "features": shapes}, {}, label_field="kind")


def test_stratified_sample_and_area_estimates_recover_the_truth(tmp_path):
    """A map with a known error: estimates from a stratified sample bracket the true areas (Olofsson et al. 2014)."""
    from terrax.processing.accuracy import allocate, assess, stratified_sample

    rng = np.random.default_rng(5)
    n = 600
    truth = np.where(rng.random((n, n)) < 0.08, 1, 2).astype(np.uint8)  # 8 % class 1
    mapped = truth.copy()
    flip = rng.random((n, n)) < 0.1  # 10 % of cells mislabelled
    mapped[flip] = 3 - mapped[flip]
    areas = np.array([(mapped == 1).sum(), (mapped == 2).sum()], float)
    sizes = allocate(areas, 400, 100)
    assert sizes.sum() == 400 and sizes.min() >= 100
    pts = stratified_sample(mapped, [1, 2], sizes, seed=9)
    assert len(pts) == 400 and len({(r, c) for r, c, _ in pts}) == 400
    assert all(mapped[r, c] == k for r, c, k in pts)
    cm = np.zeros((2, 2), int)
    for r, c, k in pts:
        cm[k - 1, truth[r, c] - 1] += 1
    res = assess(cm, areas, ["A", "B"])
    true_a = float((truth == 1).sum())
    a = res["classes"][0]
    assert abs(a["area"] - true_a) <= 2.5 * a["areaCi"] / 1.96  # within 2.5 SE of the truth
    assert abs(a["area"] - true_a) < abs(areas[0] - true_a)  # better than counting mapped pixels
    assert 0.85 < res["overallAccuracy"] < 0.95


def test_accuracy_matches_olofsson_2014_worked_example():
    """Olofsson et al. (2014), section 5 (Tables 8–9): 30 m pixels, areas in ha."""
    from terrax.processing.accuracy import assess

    counts = np.array([[66, 0, 5, 4], [0, 55, 8, 12], [1, 0, 153, 11], [2, 1, 9, 313]])
    pixels = np.array([200_000, 150_000, 3_200_000, 6_450_000])
    r = assess(counts, pixels * 0.09, ["Deforestation", "Forest gain", "Stable forest", "Stable non-forest"])
    # Area estimates ± 95 % CI as published: 21,158 ± 6,158; 11,686 ± 3,756; 285,770 ± 15,510; 581,386 ± 16,282 ha.
    for c, (area, ci) in zip(r["classes"], [(21_158, 6_158), (11_686, 3_756), (285_770, 15_510), (581_386, 16_282)], strict=True):
        assert c["area"] == pytest.approx(area, abs=1) and c["areaCi"] == pytest.approx(ci, abs=2)
    assert r["overallAccuracy"] == pytest.approx(0.95, abs=0.005) and r["overallCi"] == pytest.approx(0.02, abs=0.005)
    assert r["classes"][0]["userAccuracy"] == pytest.approx(0.88, abs=0.005) and r["classes"][0]["userCi"] == pytest.approx(0.07, abs=0.005)
    assert r["classes"][0]["producerAccuracy"] == pytest.approx(0.75, abs=0.005)


def _s1_pair(tmp_path, n=200, enl=4.4, seed=2, db=True):
    """Two Sentinel-1-like VV/VH images with gamma speckle; a 60 × 50 px clearing appears in the second (VH −13 → −20 dB)."""
    import rasterio
    from rasterio.transform import from_origin

    rng = np.random.default_rng(seed)
    paths = []
    for t in (0, 1):
        vv = np.full((n, n), -7.5)
        vh = np.full((n, n), -13.0)
        if t:
            vv[40:100, 50:100], vh[40:100, 50:100] = -11.0, -20.0
        bands = []
        for mean_db in (vv, vh):
            lin = 10 ** (mean_db / 10) * rng.gamma(enl, 1 / enl, (n, n))  # multiplicative speckle, mean 1
            bands.append(10 * np.log10(lin) if db else lin)
        p = tmp_path / f"s1_{t}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=n, height=n, count=2, dtype="float32", crs="EPSG:32646", transform=from_origin(500000, 3000000, 10, 10)) as d:
            d.write(np.stack(bands).astype(np.float32))
        paths.append(p)
    return paths


def test_lee_filter_reduces_speckle_and_keeps_the_mean():
    from terrax.processing.radar import lee_filter

    rng = np.random.default_rng(1)
    z = 0.05 * rng.gamma(4.4, 1 / 4.4, (300, 300))
    f = lee_filter(z, 7, 4.4)
    assert f.mean() == pytest.approx(0.05, rel=0.01)
    assert f.std() / f.mean() < (z.std() / z.mean()) / 4  # 49-pixel window on a homogeneous area: CV falls about √49-fold
    step = np.hstack([z[:, :150], 4 * z[:, 150:]])  # a 6 dB edge
    fs = lee_filter(step, 7, 4.4)
    assert fs[:, 140:146].mean() == pytest.approx(0.05, rel=0.05) and fs[:, 154:160].mean() == pytest.approx(0.2, rel=0.05)


def test_hist_stats_quartiles_exact_after_the_second_pass():
    from terrax.processing.radar import HistStats

    rng = np.random.default_rng(4)
    for v in (rng.normal(-12, 3, 200_001).astype(np.float32), rng.normal(-12, 3, 10).astype(np.float32), np.full(1000, -7.5, np.float32),
              np.r_[rng.normal(-12, 3, 5000), [-80.0, 55.0]].astype(np.float32)):  # values beyond the bins too
        h = HistStats(-60, 40, 0.01)
        parts = np.array_split(v, 7)
        for part in parts:
            h.add(part)
        approx_d = h.dict()
        assert approx_d is not None and not approx_d["exactQuartiles"]
        for key, p in (("q1", 0.25), ("median", 0.5), ("q3", 0.75)):
            assert abs(approx_d[key] - float(np.quantile(v.astype(np.float64), p))) <= 0.005 + 1e-6
        assert h.wants_second_pass()
        for part in parts[::-1]:  # any order
            h.collect(part)
        d = h.dict()
        assert d is not None and d["exactQuartiles"] and d["n"] == v.size and d["mean"] == pytest.approx(float(v.astype(np.float64).mean()), abs=1e-9)
        for key, p in (("q1", 0.25), ("median", 0.5), ("q3", 0.75)):
            assert d[key] == pytest.approx(float(np.quantile(v.astype(np.float64), p)), abs=1e-12)
    small = HistStats(-60, 40, 0.01, max_collect=10)
    small.add(np.full(100, -3.0, np.float32))
    sd = small.dict()
    assert not small.wants_second_pass() and sd is not None and sd["exactQuartiles"] is False


@pytest.mark.parametrize("db", [True, False])
def test_radar_change_finds_the_clearing_and_strips_equal_whole_grid(tmp_path, monkeypatch, db):
    from terrax.processing import radar, tiles
    from terrax.processing.rio import Raster

    paths = _s1_pair(tmp_path, db=db)
    monkeypatch.setattr(tiles, "TILE_PIXELS", 10**9)
    whole = radar.analyze_radar([Raster(p) for p in paths], 0, 1, size=5)
    monkeypatch.setattr(tiles, "TILE_PIXELS", 200 * 13)  # 16 strips with 2-row halos
    monkeypatch.setenv("TERRAX_TILE_THREADS", "4")
    res = radar.analyze_radar([Raster(p) for p in paths], 0, 1, size=5)
    assert np.array_equal(whole["change"]["classes"], res["change"]["classes"])
    assert res["dates"][0]["scale"] == ("db" if db else "linear")
    # The clearing is 60 × 50 px = 3,000 px = 30 ha at 10 m: a 7 dB VH drop against ±3 dB.
    cls = res["change"]["classes"]
    assert (cls[45:95, 55:95] == 1).mean() > 0.97  # inside, away from the edges
    assert (cls[120:, 120:] == 1).mean() < 0.01  # false alarms in the unchanged forest
    assert res["change"]["ha"]["1"] == pytest.approx(30, rel=0.12)
    vh = res["dates"][0]["vh"]
    assert vh["median"] == pytest.approx(-13 - 0.4, abs=0.6)  # filtered speckle: the dB median sits a little below the linear mean
    assert "Lee (1980)" in radar.radar_markdown(res)
    # Exact quartiles: the same in strips as on the whole grid, and equal to numpy's on every filtered pixel.
    r0 = Raster(paths[0])
    (a,) = r0.read_rows([1], 0, r0.gh)
    ref = radar._db(radar.lee_filter(radar.to_linear(a, res["dates"][0]["scale"]), 5))
    ref = ref[np.isfinite(ref)].astype(np.float64)
    for d in (whole, res):
        assert d["dates"][0]["vh"]["exactQuartiles"] and d["change"]["logRatio"]["exactQuartiles"]
        for key, p in (("q1", 0.25), ("median", 0.5), ("q3", 0.75)):
            assert d["dates"][0]["vh"][key] == pytest.approx(float(np.quantile(ref, p)), abs=1e-12)
            assert d["change"]["logRatio"][key] == whole["change"]["logRatio"][key]


def _forest_cloud(path, unit=1.0, crs="EPSG:32646", seed=8):
    """A 100 m × 100 m LAS: ground z = 120 + 0.05x (class 2) and 16 cone crowns of known heights on a 25 m grid.

    unit converts metres to the file's units (feet: 3937/1200), applied to x, y and z.
    """
    import laspy
    from pyproj import CRS

    rng = np.random.default_rng(seed)
    trees = [(12.5 + 25 * i, 12.5 + 25 * j, 8.0 + 2.0 * (4 * i + j) % 17) for i in range(4) for j in range(4)]
    n = 200_000  # 20 returns per m², typical of current airborne LiDAR
    x, y = rng.uniform(0, 100, n), rng.uniform(0, 100, n)
    ground = 120 + 0.05 * x
    top = np.zeros(n)
    for tx, ty, th in trees:
        r = 0.25 * th  # crown radius grows with height
        d = np.hypot(x - tx, y - ty)
        top = np.maximum(top, np.where(d < r, th * (1 - 0.4 * d / r), 0))
    canopy = top > 0
    # First returns: crown surface where there is canopy, ground elsewhere; under crowns some last returns reach the ground.
    under = canopy & (rng.random(n) < 0.3)
    xs = [x, x[under]]
    ys = [y, y[under]]
    zs = [ground + top, ground[under]]
    cls = [np.where(canopy, 5, 2), np.full(under.sum(), 2)]
    ret = [np.ones(n, int), np.full(under.sum(), 2)]
    hdr = laspy.LasHeader(point_format=1, version="1.4")
    hdr.offsets = [500000 * unit, 3000000 * unit, 0]
    hdr.scales = [0.001, 0.001, 0.001]
    hdr.add_crs(CRS.from_user_input(crs), keep_compatibility=False)  # LAS 1.4 WKT (custom CRSs have no EPSG GeoKeys)
    las = laspy.LasData(hdr)
    las.x = (500000 + np.concatenate(xs)) * unit
    las.y = (3000000 + np.concatenate(ys)) * unit
    las.z = np.concatenate(zs) * unit
    las.classification = np.concatenate(cls).astype(np.uint8)
    las.return_number = np.concatenate(ret).astype(np.uint8)
    las.number_of_returns = np.where(np.concatenate(ret) == 2, 2, 1).astype(np.uint8)
    las.write(str(path))
    return trees


@pytest.mark.parametrize(("unit", "crs"), [(1.0, "EPSG:32646"), (3937 / 1200, "+proj=tmerc +lat_0=0 +lon_0=93 +k=0.9996 +x_0=500000 +y_0=0 +datum=WGS84 +units=us-ft +vunits=us-ft")])
def test_canopy_height_from_a_point_cloud(tmp_path, unit, crs):
    from terrax.processing.canopy import analyze_canopy, chm_from_las

    path = tmp_path / ("forest.laz" if unit == 1 else "forest_ft.las")
    trees = _forest_cloud(path, unit, crs)
    g = chm_from_las(path, cell=1.0)
    assert (g["width"], g["height"]) == (100, 100) or abs(g["width"] - 100) <= 1
    chm = g["chm"]
    for tx, ty, th in trees:
        c, r = int(tx), int(100 - ty)
        peak = np.nanmax(chm[max(0, r - 1) : r + 2, max(0, c - 1) : c + 2])
        # The highest return in a cell is never above the apex and, at 20 points/m², rarely more than 0.6 m below it.
        assert th - 0.6 <= peak <= th + 0.01, (tx, ty, th, peak)  # in metres whatever the file's units
    res = analyze_canopy(chm, np.full(chm.shape[0], 1.0), 1.0, threshold=2.0, min_tree=5.0)
    assert res["trees"]["count"] == len(trees)
    # Crown height falls from h at the centre to 0.6 h at the edge (≥ 4.8 m here), so the whole disc of radius h/4 is above 2 m.
    crown = sum(math.pi * (0.25 * th) ** 2 for _, _, th in trees)
    assert res["cover"] == pytest.approx(crown / 1e4, abs=0.02)
    assert res["height"]["max"] == pytest.approx(max(t[2] for t in trees), abs=0.6)
