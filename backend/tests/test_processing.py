"""Science checks on synthetic rasters and features with known answers (ported from the TypeScript tool tests)."""

import math
from datetime import date

import numpy as np
import pytest
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin

from terrax.processing import forest, landcover, rasterset, survey, terrain
from terrax.processing.climate import rainfall_summary
from terrax.processing.dates import date_from_filename
from terrax.processing.indices import INDICES
from terrax.processing.metrics import build_classification, detect_metric
from terrax.processing.rio import Raster, ground_geometry, qa_masked, sin_authalic
from terrax.processing.zonal import boundary_mask, clip_to_boundary

from .conftest import SAMPLES

approx = pytest.approx
RAD = math.pi / 180
A, E2 = 6378137.0, 0.00669437999014
E, B = math.sqrt(E2), A * math.sqrt(1 - E2)
UTM46 = Transformer.from_crs(32646, 4326, always_xy=True)


def zone_area_per_radian(lat):
    """Independent closed form: ellipsoid area from the equator to latitude φ, per radian of longitude."""
    s = math.sin(lat * RAD)
    return B * B * (s / (2 * (1 - E2 * s * s)) + 1 / (4 * E) * math.log((1 + E * s) / (1 - E * s)))


def rect_area(lat1, lat2, dlon):
    return abs(zone_area_per_radian(lat2) - zone_area_per_radian(lat1)) * dlon * RAD


def tif(tmp_path, name, bands, res=30.0, epsg=32646, tie=(603000, 2846000)):
    h, w = bands[0].shape
    p = tmp_path / name
    with rasterio.open(p, "w", driver="GTiff", width=w, height=h, count=len(bands), dtype="float32", crs=f"EPSG:{epsg}", transform=from_origin(tie[0], tie[1], res, res), nodata=-9999) as d:
        for i, b in enumerate(bands, 1):
            d.write(b.astype(np.float32), i)
    return Raster(p, name)


def utm_boundary(name, e0, e1, n0, n1):
    ring = [list(UTM46.transform(e, n)) for e, n in [(e0, n0), (e1, n0), (e1, n1), (e0, n1), (e0, n0)]]
    return {"name": name, "areaM2": (e1 - e0) * (n1 - n0), "geojson": {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [ring]}}]}}


def test_authalic_latitude_gives_exact_cell_areas():
    rq = 6371007.1809
    for a, b in [(0, 1), (25, 26), (60, 61)]:
        assert rq * rq * RAD * (sin_authalic(b) - sin_authalic(a)) == approx(rect_area(a, b, 1), rel=1e-9)
    assert rect_area(0, 1, 1) / 1e6 == approx(12309, abs=2)  # 1° × 1° at the equator on WGS84


def test_geographic_raster_cell_areas(tmp_path):
    r = tif(tmp_path, "geo.tif", [np.ones((10, 10))], res=0.1, epsg=4326, tie=(94, 26))
    g = ground_geometry(r.meta, 10, 10)
    assert float((g.cell_area * 10).sum()) == approx(rect_area(25, 26, 1), rel=1e-6)


def test_survey_rectangle_bearings_and_meridian_arc():
    lat, lon, d = 25.67, 94.1, 0.01
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "box"}, "geometry": {"type": "Polygon", "coordinates": [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]}}]}
    f = survey.measure_survey("box.geojson", "GeoJSON", fc, [])["features"][0]
    assert f["area"] == approx(rect_area(lat, lat + d, d), rel=5e-4)
    # Leg 1 runs east (geodesic azimuth ≈ 90°, within 0.01° for 1 km), leg 2 due north.
    assert f["legs"][0]["bearing"] == approx(90, abs=0.01) and f["legs"][1]["bearing"] == approx(0, abs=0.01)
    assert f["legs"][1]["distance"] == approx(1108.0, abs=1.0)  # meridian arc for 0.01° at 25.7°


def test_survey_holes_csv_and_projected_coordinates():
    lat, lon = 25.67, 94.1
    outer = [[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01], [lon, lat]]
    hole = [[lon + 0.004, lat + 0.004], [lon + 0.006, lat + 0.004], [lon + 0.006, lat + 0.006], [lon + 0.004, lat + 0.006], [lon + 0.004, lat + 0.004]]
    r = survey.measure_survey("h", "GeoJSON", {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [outer, hole]}}]}, [])
    assert r["features"][0]["area"] == approx(rect_area(lat, lat + 0.01, 0.01) - rect_area(lat + 0.004, lat + 0.006, 0.002), rel=1e-3)
    csv = b"name,lat,lon,ele\nA,25.67,94.1,1400\nB,25.67,94.11,1410\nC,25.68,94.11,1420\n"
    poly, _ = survey.parse_coordinate_csv(csv, "pts.csv", True)
    line, _ = survey.parse_coordinate_csv(csv, "pts.csv", False)
    assert poly["features"][0]["geometry"]["type"] == "Polygon" and line["features"][0]["geometry"]["type"] == "LineString"
    assert survey.measure_survey("pts.csv", "CSV", poly, [])["features"][0]["elevation"] == {"min": 1400, "max": 1420}
    utm = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [603000, 2846000]}}]}
    with pytest.raises(ValueError, match="WGS84"):
        survey.measure_survey("utm.geojson", "GeoJSON", utm, [])


def test_elevation_profile_and_magnetic_bearings():
    coords = [[94.1 + i * 0.001, 25.67, z] for i, z in enumerate([100, 102, 101, 103, 110, 108, 120])]
    r = survey.measure_survey("walk", "GeoJSON", {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"name": "Walk"}, "geometry": {"type": "LineString", "coordinates": coords}}]}, [])
    p = survey.elevation_profile(r["features"][0])
    assert len(p["points"]) == 7 and p["points"][6]["distance"] == approx(r["features"][0]["length"])
    assert p["gainRaw"] == approx(23) and p["lossRaw"] == approx(3)
    assert p["gain"] == approx(20) and p["loss"] == approx(0)  # 5 m threshold ignores the 2 m wiggles
    assert survey.magnetic_bearing(10, 15) == 355 and survey.magnetic_bearing(350, -15) == 5
    md = survey.survey_markdown(r, -1.2)
    assert "Bearing (magnetic)" in md and "1.2° west" in md and "ascent 20 m" in md
    assert "magnetic) |" not in survey.survey_markdown(r)


def test_ndvi_change_known_clearing(tmp_path):
    w, h = 50, 40
    before = np.full((h, w), 0.8)
    after = np.full((h, w), 0.8)
    after[10:20, 5:15] = 0.2  # 100 px cleared
    before[0, 0] = -9999  # one no-data pixel
    before[39, 40:50] = 0.2  # 10 px non-forest …
    after[39, 40:50] = 0.7  # … that regrow
    rb, ra = tif(tmp_path, "b.tif", [before]), tif(tmp_path, "a.tif", [after])
    r = forest.analyze_ndvi_change(rb, {}, ra, {}, 0.5, -0.2)
    assert r["loss"]["pixels"] == 100 and r["loss"]["ha"] == approx(100 * 900 / 10000)
    assert r["forestBefore"]["pixels"] == w * h - 1 - 10 and r["gain"]["pixels"] == 10 and r["validPixels"] == w * h - 1
    with pytest.raises(ValueError, match="different grids"):
        forest.analyze_ndvi_change(rb, {}, tif(tmp_path, "c.tif", [np.zeros((10, 10))]), {}, 0.5, -0.2)


def test_hansen_loss_by_year(tmp_path):
    ly = np.zeros((10, 20))
    tc = np.full((10, 20), 80.0)
    flat_ly, flat_tc = ly.ravel(), tc.ravel()
    flat_ly[:30] = 5  # 2005
    flat_ly[30:50] = 19  # 2019
    flat_ly[50:60] = 19
    flat_tc[50:60] = 10  # below 30 % canopy: excluded
    r = forest.analyze_hansen(tif(tmp_path, "ly.tif", [ly]), tif(tmp_path, "tc.tif", [tc]), 30)
    assert [(y["year"], y["area"]["pixels"]) for y in r["byYear"]] == [(2005, 30), (2019, 20)]
    assert r["baseline"]["pixels"] == 200 - 10 and r["totalLoss"]["ha"] == approx(50 * 0.09)
    with pytest.raises(ValueError, match="lossyear"):
        forest.analyze_hansen(tif(tmp_path, "bad.tif", [np.full((4, 4), 0.5)]), None, 30)


def test_terrain_tilted_planes(tmp_path):
    w, h, res = 30, 20, 30.0
    x = np.arange(w)[None, :].repeat(h, 0)
    y = np.arange(h)[:, None].repeat(w, 1)
    t = terrain.analyze_terrain(tif(tmp_path, "dem.tif", [1000 + 0.1 * x * res], res=res))
    assert t["slope"]["mean"] == approx(math.atan(0.1) / RAD, abs=1e-4)
    assert t["aspectCounts"][6] == (w - 2) * (h - 2)  # rises eastward → faces west
    assert t["relief"] == approx(0.1 * (w - 1) * res, abs=1e-3)
    t2 = terrain.analyze_terrain(tif(tmp_path, "dem2.tif", [1000 + 0.2 * y * res], res=res))
    assert t2["aspectCounts"][0] == (w - 2) * (h - 2)  # rises southward → faces north
    assert t2["slope"]["mean"] == approx(math.atan(0.2) / RAD, abs=1e-4)


def test_spectral_indices_follow_published_formulas():
    b = {k: np.array([v]) for k, v in dict(blue=0.05, green=0.08, red=0.1, nir=0.5, swir1=0.25, swir2=0.15).items()}
    v = {i.id: float(i.compute(b)[0]) for i in INDICES}
    assert v["ndvi"] == approx(0.4 / 0.6) and v["evi"] == approx(2.5 * 0.4 / (0.5 + 0.6 - 0.375 + 1))
    assert v["savi"] == approx(1.5 * 0.4 / 1.1) and v["ndwi"] == approx((0.08 - 0.5) / 0.58)
    assert v["ndmi"] == approx(0.25 / 0.75) and v["nbr"] == approx(0.35 / 0.65) and v["ndbi"] == approx(-0.25 / 0.75)


def test_rainfall_indices_use_imd_rainy_day_threshold():
    vals = [0, 0, 3, 0, 0, 0, 0, 12, 2.4, 0]
    pts = [{"time": date(2020, 6, i + 1), "value": float(v), "label": f"2020-06-{i + 1:02d}"} for i, v in enumerate(vals)]
    r = rainfall_summary(pts, "precip", 1, pts[0]["time"], pts[-1]["time"])
    assert r["total"] == approx(17.4) and r["rainyDays"] == 2 and r["wettest"]["value"] == 12
    assert r["longestDrySpell"] == 4 and r["missingDays"] == 0


def test_soil_moisture_detection_and_units():
    assert detect_metric("soil_moisture") == "soilMoisture" and detect_metric("SM") == "soilMoisture"
    c = build_classification("soil_moisture", [0.15, 0.25], (1, 1))
    assert "Moist" in c.buckets[c.classify(0.35)]["label"]
    pct = build_classification("soil_moisture", [15, 25, 35], (1, 1))
    assert "Moist" in pct.buckets[pct.classify(35)]["label"]


def test_boundary_mask_geographic_holes_and_errors(tmp_path):
    r = tif(tmp_path, "g.tif", [np.ones((100, 100))], res=0.01, epsg=4326, tie=(94, 26))
    sq = lambda x0, x1, y0, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    fc = lambda *rings: {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": list(rings)}}]}
    grid = r.read_bands([0])[0]
    assert boundary_mask(r, grid, {"name": "sq", "areaM2": 1, "geojson": fc(sq(94.2, 94.5, 25.3, 25.6))})[1] == 900
    holed = {"name": "sq", "areaM2": 1, "geojson": fc(sq(94.2, 94.5, 25.3, 25.6), sq(94.3, 94.4, 25.4, 25.5))}
    assert boundary_mask(r, grid, holed)[1] == 800
    assert "800 grid cells" in clip_to_boundary(r, grid, holed) and int(np.isfinite(grid.data).sum()) == 800
    with pytest.raises(ValueError, match="does not overlap"):
        boundary_mask(r, grid, {"name": "far", "areaM2": 1, "geojson": fc(sq(10, 11, 10, 11))})
    assert clip_to_boundary(r, grid, None) is None


def test_boundary_clipping_ndvi_hansen_terrain(tmp_path):
    before, after = np.full((40, 50), 0.8), np.full((40, 50), 0.8)
    after[10:20, 5:15] = 0.2
    rb, ra = tif(tmp_path, "b.tif", [before]), tif(tmp_path, "a.tif", [after])
    plot = utm_boundary("plot", 603150, 603450, 2845400, 2845700)  # exactly the cleared block
    r = forest.analyze_ndvi_change(rb, {}, ra, {}, 0.5, -0.2, plot)
    assert r["loss"]["pixels"] == 100 and r["forestBefore"]["pixels"] == 100 and "analysis boundary “plot”" in r["notes"][0]
    half = utm_boundary("half", 603000, 603300, 2845400, 2845700)
    r2 = forest.analyze_ndvi_change(rb, {}, ra, {}, 0.5, -0.2, half)
    assert r2["loss"]["pixels"] == 50 and r2["forestBefore"]["pixels"] == 100
    hr = forest.analyze_hansen(tif(tmp_path, "ly.tif", [np.full((10, 20), 10.0)]), None, 30, utm_boundary("p", 603000, 603150, 2845850, 2846000))
    assert hr["totalLoss"]["pixels"] == 25
    x = np.arange(30)[None, :].repeat(20, 0)
    t = terrain.analyze_terrain(tif(tmp_path, "dem.tif", [1000 + 3.0 * x]), utm_boundary("p", 603150, 603450, 2845550, 2845850))
    assert t["elevation"]["n"] == 100 and t["slope"]["mean"] == approx(math.atan(0.1) / RAD, abs=1e-4)
    assert t["slope"]["n"] == 64  # only interior cells have a full 3 × 3 neighbourhood


def test_dnbr_classes_follow_usgs_ranges(tmp_path):
    d = np.array([[-0.3, -0.2, 0, 0.2, 0.3, 0.5, 0.8]])  # one pixel per class
    r = forest.analyze_burn(tif(tmp_path, "pre.tif", [np.full((1, 7), 0.6)]), {}, tif(tmp_path, "post.tif", [0.6 - d]), {})
    assert r["classes"].ravel().tolist() == [1, 2, 3, 4, 5, 6, 7]
    assert r["burned"]["pixels"] == 4 and r["burned"]["ha"] == approx(4 * 0.09) and r["meanDnbr"] == approx(d.mean(), abs=1e-6)


def test_minimum_mapping_unit_and_loss_polygons(tmp_path):
    before, after = np.full((20, 20), 0.8), np.full((20, 20), 0.8)
    after[2:10, 2:10] = 0.2  # 64 px = 5.76 ha
    after[15, 15] = after[16, 16] = 0.2  # diagonal neighbours: one 0.18 ha patch
    rb, ra = tif(tmp_path, "b.tif", [before]), tif(tmp_path, "a.tif", [after])
    full = forest.analyze_ndvi_change(rb, {}, ra, {}, 0.5, -0.2)
    assert full["loss"]["pixels"] == 66 and full["patches"]["count"] == 2 and full["patches"]["largest"]["ha"] == approx(5.76)
    mmu = forest.analyze_ndvi_change(rb, {}, ra, {}, 0.5, -0.2, None, 0.5)
    assert mmu["loss"]["pixels"] == 64 and mmu["patches"]["removedPatches"] == 1 and mmu["forestBefore"]["pixels"] == 400
    assert any("Minimum mapping unit 0.5 ha" in n for n in mmu["notes"])
    ly = np.zeros((20, 20))
    ly[2:10, 2:10] = 5
    ly[15, 15] = 19
    hr = forest.analyze_hansen(tif(tmp_path, "ly.tif", [ly]), None, 30, None, 0.5)
    assert [(y["year"], y["area"]["pixels"]) for y in hr["byYear"]] == [(2005, 64)]
    polys = forest.loss_polygons(full, rb)["fc"]["features"]
    assert len(polys) == 2 and sum(f["properties"]["area_ha"] for f in polys) == approx(66 * 0.09, abs=1e-3)
    ring = polys[0]["geometry"]["coordinates"][0][0]
    lon, lat = ring[0]
    assert 94 < lon < 94.2 and 25.6 < lat < 25.8
    lons = [p[0] for p in ring]
    assert (max(lons) - min(lons)) * 111_320 * math.cos(lat * RAD) == approx(240, abs=3)  # 8 × 30 m


def test_quality_masks_and_file_dates():
    assert qa_masked("scl", np.array([0, 1, 3, 8, 9, 10, 11], float)).all()
    assert not qa_masked("scl", np.array([2, 4, 5, 6, 7], float)).any()
    assert qa_masked("landsat", np.array([21824, 1 << 3, 1 << 4, 1 << 7], float)).tolist() == [False, True, True, False]
    assert qa_masked("scl", np.array([np.nan])).all()
    assert date_from_filename("S2_2024-03-15_ndvi.tif") == date(2024, 3, 15)
    assert date_from_filename("LC09_L2SP_135042_20240315_02_T1.tif") == date(2024, 3, 15)
    assert date_from_filename("ndvi_2024_075.tif") == date(2024, 3, 15)
    assert date_from_filename("scene.tif") is None and date_from_filename("ndvi_20241399.tif") is None


def test_qa_mask_removes_cloudy_pixels(tmp_path):
    v = np.where(np.arange(100).reshape(10, 10) < 50, 1.0, 100.0)
    scl = np.where(np.arange(100).reshape(10, 10) < 50, 4.0, 9.0)  # cloud on the second half
    ds, _ = rasterset.dataset(tif(tmp_path, "qa.tif", [v, scl]), {"mode": "band", "band": 0, "qa": {"band": 1, "kind": "scl"}})
    assert ds["validPixels"] == 50 and ds["stats"]["mean"] == 1 and any("removed 50.0 %" in x for x in ds["hints"])


def test_multi_date_series_declines(tmp_path):
    dates = ["2019-03-10", "2020-03-14", "2021-03-09", "2022-03-12", "2023-03-15", "2024-03-11"]
    rs = [Raster(SAMPLES / f"series_ndvi_{d}_synthetic.tif") for d in reversed(dates)]
    r = rasterset.analyze_stack(rs, "ndvi", {})
    assert [x["date"] for x in r["rows"]] == dates
    assert all(r["rows"][i]["mean"] < r["rows"][i - 1]["mean"] for i in range(1, 6))
    assert r["trend"]["direction"] == "decreasing" and r["trend"]["p"] < 0.05 and r["trend"]["s"] == -15
    with pytest.raises(ValueError, match=r"No date found in: nodate\.tif"):
        rasterset.analyze_stack([rs[0], tif(tmp_path, "nodate.tif", [np.zeros((4, 4))])], None, {})


def test_land_cover_on_synthetic_scene():
    res = landcover.classify_land_cover(Raster(SAMPLES / "satellite_4band_synthetic.tif"), [0, 1, 2, 3], 4, {"blue": 0, "green": 1, "red": 2, "nir": 3})
    st = res["stats"]
    assert len(st) == 4 and sum(c["share"] for c in st) == approx(1) and sum(c["ha"] for c in st) == approx(240 * 200 * 0.09)
    assert st[0]["ndvi"] < 0 and st[0]["suggestion"] == "Water" and st[3]["ndvi"] > 0.5  # sorted by NDVI: the river first
    assert int((res["classes"] == 0).sum()) == 0
