"""Statistics, dates, metrics, climate, hydrology, patches and EXIF (ported from the TypeScript unit tests)."""

import io
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
from terrax.processing.terrain import contour_grid, fill_depressions, flow_routing, nice_interval, snap_outlet, watershed

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
    label = lambda v: c.buckets[c.classify(v)]["label"]  # noqa: E731
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


def test_contours_on_a_plane():
    w, h = 5, 6
    [(level, lines)] = contour_grid(grid(w, h, lambda x, y: x), [1.5])
    assert level == 1.5 and len(lines) == 1 and len(lines[0]) == h
    assert all(abs(p[0] - 2) < 1e-9 for p in lines[0])
    ys = sorted(p[1] for p in lines[0])
    assert (ys[0], ys[-1]) == (0.5, h - 0.5)
    assert (nice_interval(1000), nice_interval(730), nice_interval(18)) == (100, 50, 2)


# ── Patches ──────────────────────────────────────────────────────────────────


def test_eight_connected_labels_and_mmu():
    rows = ["#...", ".#..", "...#", "..##"]
    cls = np.array([[2 if ch == "#" else 1 for ch in r] for r in rows], dtype=np.uint8)
    labels, n = label_patches(cls == 2)
    assert n == 2
    assert sorted(patch_areas(labels, n, np.ones(4))[1:]) == [2, 3]
    m = apply_mmu(cls, cls == 2, 1, 3, np.ones(4))
    assert m["removedPatches"] == 1 and m["removedMask"].sum() == 2 and m["keptCount"] == 1 and (cls == 2).sum() == 3


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
    assert io  # noqa: B018
