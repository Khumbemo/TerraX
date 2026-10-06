"""Carbon allometry and encroachment screening (ported from the TypeScript unit tests)."""

import math

import numpy as np
import pytest
from scipy.stats import t as student_t

from terrax.processing import carbon
from terrax.processing import encroachment as enc

from .conftest import SAMPLES

approx = pytest.approx


def test_allometric_equations_match_hand_computed_values():
    agb, eq = carbon.tree_agb(30, 25, 0.6, carbon.DEFAULT_PARAMS)  # Chave 2014 eq. 4
    assert eq == "chave2014-h" and agb == approx(723.137, abs=0.01)
    agb, eq = carbon.tree_agb(30, None, 0.6, carbon.DEFAULT_PARAMS)  # Chave 2005 moist
    assert eq == "chave2005" and agb == approx(724.109, abs=0.01)
    agb, eq = carbon.tree_agb(30, None, 0.6, {**carbon.DEFAULT_PARAMS, "stressE": 0.5})  # Chave 2014 eq. 7
    assert eq == "chave2014-e" and agb == approx(386.042, abs=0.01)
    assert carbon.basal_area_m2(30) == approx(0.0706858, abs=1e-6)


def test_per_hectare_biomass_root_shoot_and_carbon():
    csv = "\n".join(["Plot,Size,Species,DBH,Height,Status", "A,400,Sp1,30,25,live", "B,400,Sp1,30,25,live", "B,400,Sp2,30,25,live", "B,400,Sp2,3,2,live", "B,400,Sp2,40,20,dead"])
    inv = carbon.parse_inventory(csv, "t.csv")
    assert inv["format"] == "Generic"
    r = carbon.compute_carbon(inv, {**carbon.DEFAULT_PARAMS, "defaultDensity": 0.6})
    one = 723.1374 / 1000 / 0.04  # t/ha from one tree in 400 m²
    assert r["live"]["trees"] == 3 and r["excluded"]["small"] == 1 and r["excluded"]["dead"] == 1
    agb = r["perHa"]["agb"]
    assert agb["mean"] == approx(1.5 * one, abs=1e-3) and agb["sd"] == approx(math.sqrt(0.5) * one, abs=1e-3)
    # Exact Student t (the TypeScript version used a table: 12.706 for 1 df).
    half = student_t.ppf(0.975, 1) * math.sqrt(0.5) * one / math.sqrt(2)
    assert agb["ci95"][1] == approx(1.5 * one + half, abs=1e-3)
    assert r["perHa"]["rootShoot"] == 0.2  # 27 t/ha < 125 → tropical moist deciduous ratio 0.20
    assert r["perHa"]["carbon"]["mean"] == approx(1.5 * one * 1.2 * 0.47, abs=1e-3)
    assert r["perHa"]["co2e"]["mean"] == approx(1.5 * one * 1.2 * 0.47 * 44 / 12, abs=1e-3)
    assert r["perHa"]["stems"]["mean"] == approx(37.5)
    r2 = carbon.compute_carbon(inv, {**carbon.DEFAULT_PARAMS, "defaultDensity": 0.6, "densities": {"Sp2": 0.3}})
    assert next(s for s in r2["species"] if s["species"] == "Sp2")["agb"] == approx(723.1374 * 0.5**0.976, abs=1e-3)
    assert "Above-ground biomass | 27.12 t/ha (95 % CI" in carbon.carbon_markdown(r)


def test_forest_capture_export():
    inv = carbon.parse_inventory((SAMPLES / "forest_capture_inventory_synthetic.csv").read_text(encoding="utf-8"), "fc.csv")
    assert inv["format"] == "Forest-Capture"
    assert not any("Imperata" in t["species"] for t in inv["trees"])  # transect rows are ignored
    assert any(t["dbhFrom"] == "GBH" for t in inv["trees"])
    r = carbon.compute_carbon(inv, carbon.DEFAULT_PARAMS)
    assert len(r["plots"]) == 5 and all(p["areaM2"] == 400 for p in r["plots"])
    assert r["excluded"]["noDiameter"] == 60 and r["excluded"]["dead"] > 0  # 12 seedlings × 5 quadrats
    assert r["equations"]["chave2005"] > 0 and r["equations"]["chave2014-h"] > 0
    assert 20 < r["perHa"]["agb"]["mean"] < 600


def test_inventory_without_plot_sizes_and_bad_files():
    r = carbon.compute_carbon(carbon.parse_inventory("Species,GBH\nA,94.2478\n", "g.csv"), carbon.DEFAULT_PARAMS)
    assert r["qmd"] == approx(30, abs=1e-4) and r["perHa"] is None and any("root-to-shoot" in w for w in r["warnings"])
    with_area = carbon.compute_carbon(carbon.parse_inventory("Species,GBH\nA,94.2478\n", "g.csv"), {**carbon.DEFAULT_PARAMS, "plotAreaM2": 1000})
    assert with_area["perHa"]["plots"] == 1
    with pytest.raises(ValueError, match="no DBH or girth"):
        carbon.parse_inventory("a,b\n1,2", "x.csv")
    with pytest.raises(ValueError, match="no tree rows"):
        carbon.parse_inventory("DBH\n", "x.csv")


# ── Encroachment ─────────────────────────────────────────────────────────────


def lcg(seed):
    s = [seed]

    def r():
        s[0] = (s[0] * 1664525 + 1013904223) % 4294967296
        return s[0] / 4294967296

    return r


def scene(after, bright=1.0):
    """60 × 60 m at 1 m: grass everywhere; the property is columns 10–39, rows 10–49."""
    w = h = 60
    r = lcg(2 if after else 1)
    rgb = [np.zeros((h, w), np.float32) for _ in range(3)]
    for y in range(h):
        for x in range(w):
            c = (70, 120, 50)
            if x >= 50 and 10 <= y < 20:
                c = (150, 150, 155)  # neighbour's existing house (unchanged)
            if after:
                if 35 <= x < 46 and 20 <= y < 30:
                    c = (190, 185, 180)  # neighbour extension, 5 m into the plot
                if 20 <= x < 26 and 30 <= y < 36:
                    c = (200, 170, 140)  # owner's patio
                if 50 <= x < 56 and 45 <= y < 51:
                    c = (120, 90, 60)  # cleared field outside
            for b in range(3):
                rgb[b][y, x] = (c[b] + (r() - 0.5) * 8) * bright
    return rgb


def test_neighbour_extension_crossing_the_boundary():
    prop = enc._rasterize_rings([[(10, 10), (40, 10), (40, 50), (10, 50)]], 60, 60)
    assert prop.sum() == 30 * 40
    stack = {"width": 60, "height": 60, "cellM": 1.0, "layers": [{"label": "2019", "date": None, "rgb": scene(False)}, {"label": "2024", "date": None, "rgb": scene(True, 1.1)}],
             "property": prop, "grid": None, "notes": [], "epsg": None}
    cmp = enc.compare_layers(stack, 0, 1, enc.DEFAULT_PARAMS)
    crossing = [p for p in cmp["patches"] if p["zone"] == "crossing"]
    assert len(crossing) == 1
    assert crossing[0]["areaInside"] == 50 and crossing[0]["areaJoinedInside"] == 0 and crossing[0]["area"] == 110
    assert crossing[0]["depthInside"] == approx(5, abs=0.01)
    inside = [p for p in cmp["patches"] if p["zone"] == "inside"]
    assert len(inside) == 1 and inside[0]["area"] == 36
    assert cmp["byZone"]["outside"] == 36 and cmp["changedInside"] == 86
    assert len(cmp["patches"]) == 3  # a 10 % brighter image did not register as change elsewhere
    md = enc.encroachment_markdown(stack, cmp, [cmp], enc.DEFAULT_PARAMS)
    assert "Patches crossing the boundary | 1 (50 m² of them inside)" in md and "not proof of encroachment" in md
    same = enc.compare_layers({**stack, "layers": [stack["layers"][0], {**stack["layers"][0], "label": "copy"}]}, 0, 1, enc.DEFAULT_PARAMS)
    assert not same["patches"]


def test_survey_geometry_without_coordinates_is_a_readable_error():
    import pytest

    from terrax.processing import survey

    for g in ({"type": "Polygon"}, {"type": "LineString", "coordinates": None}, {"type": "Point", "coordinates": []}, {"type": "MultiPoint", "coordinates": [[]]}):
        assert survey.measure_geometry("x", g) == []
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon"}}]}
    with pytest.raises(ValueError, match="no measurable"):
        survey.measure_survey("plot.geojson", "GeoJSON", fc, [])
