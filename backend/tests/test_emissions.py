"""CO₂ emissions from forest loss (processing/emissions.py): IPCC 2006 stock-difference terms with a Monte Carlo interval."""

import csv
import io
import math

import numpy as np
import pytest

from tests.test_tools import run, sample

E0, N0 = 603000.0, 2846000.0  # the forest samples' grid: EPSG:32646, 30 m, 240 × 200 cells


def _tif(path, data, transform, crs, nodata=None):
    import rasterio

    with rasterio.open(path, "w", driver="GTiff", width=data.shape[1], height=data.shape[0], count=1, dtype="float32", crs=crs, transform=transform, nodata=nodata) as d:
        d.write(data.astype(np.float32), 1)
    return path


def _upload(client, path):
    with open(path, "rb") as fh:
        return client.post("/api/files", files={"file": (path.name, fh, "image/tiff")}).json()["id"]


def test_the_formula_and_its_interval():
    from terrax.processing.accuracy import Z95
    from terrax.processing.emissions import estimate

    # 100 ha of tropical moist deciduous forest at 250 t/ha: R = 0.24 (AGB ≥ 125), B = 310 t/ha, C = 0.47 B.
    e = estimate(100, None, 250, None, zone="trop-moist")
    assert e["rootShoot"] == 0.24 and e["totalBiomass"] == pytest.approx(310)
    assert e["co2"] == pytest.approx(100 * 310 * 0.47 * 44 / 12) and e["carbon"] == pytest.approx(100 * 310 * 0.47)
    assert e["co2Low"] == e["co2High"] == e["co2"]  # nothing uncertain: no interval
    assert estimate(100, None, 100, None, zone="trop-moist")["rootShoot"] == 0.20  # below 125 t/ha
    # Biomass left after clearing (e.g. a plantation) is subtracted from the stock.
    assert estimate(100, None, 250, None, after_biomass=60)["co2"] == pytest.approx(100 * 250 * 0.47 * 44 / 12)
    # One uncertain input (area ± 10 %): E is normal with the same relative half-width.
    one = estimate(100, 10, 250, None, zone="trop-moist")
    assert one["co2Low"] == pytest.approx(one["co2"] * 0.9, rel=0.01) and one["co2High"] == pytest.approx(one["co2"] * 1.1, rel=0.01)
    # Two: Approach 1 adds relative uncertainties in quadrature; the Monte Carlo interval of the product agrees closely.
    two = estimate(100, 10, 250, 25, zone="trop-moist")
    assert two["uncertaintyPct"]["approach1"] == pytest.approx(math.hypot(10, 10))
    assert (two["co2High"] - two["co2Low"]) / 2 / two["co2"] == pytest.approx(math.hypot(0.1, 0.1), rel=0.05)
    assert Z95 == pytest.approx(1.96, abs=1e-3)
    with pytest.raises(ValueError, match="more than the forest held"):
        estimate(100, None, 250, None, after_biomass=400)
    with pytest.raises(ValueError, match="Unknown ecological zone"):
        estimate(100, None, 250, None, zone="nowhere")


def test_forest_loss_emissions_from_a_biomass_value(client):
    a, b = sample(client, "forest_ndvi_2016_synthetic.tif"), sample(client, "forest_ndvi_2024_synthetic.tif")
    res = run(client, "forest", {"a": a, "b": b}, {"mode": "ndvi", "emissions": {"agb": 250, "agbCi": 50, "zone": "trop-moist"}})
    e = res["emissions"]
    assert e["areaHa"] == res["result"]["loss"]["ha"] == pytest.approx(184.05) and e["areaSource"] == "map"
    assert e["co2"] == pytest.approx(184.05 * 250 * 1.24 * 0.47 * 44 / 12)
    assert e["co2Low"] == pytest.approx(e["co2"] * 0.8, rel=0.02) and e["co2High"] == pytest.approx(e["co2"] * 1.2, rel=0.02)
    assert "## CO₂ emissions from forest loss" in res["markdown"] and "map's own count of loss pixels" in res["markdown"]
    # Burn severity is not forest loss: fire emissions need combustion factors.
    bad = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": sample(client, "burn_nbr_pre_synthetic.tif"), "b": sample(client, "burn_nbr_post_synthetic.tif")},
                                         "params": {"mode": "burn", "emissions": {"agb": 200}}}).json()
    assert bad["state"] == "error" and "combustion" in bad["message"]
    nothing = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a, "b": b}, "params": {"mode": "ndvi", "emissions": {"zone": "trop-rain"}}}).json()
    assert nothing["state"] == "error" and "biomass" in nothing["message"]


def test_emissions_from_a_biomass_map(client, tmp_path):
    """A 60 m biomass map: 100 t/ha on the western half, 300 t/ha on the eastern half, read onto the 30 m loss grid."""
    import rasterio
    from rasterio.transform import from_origin

    a, b = sample(client, "forest_ndvi_2016_synthetic.tif"), sample(client, "forest_ndvi_2024_synthetic.tif")
    plain = run(client, "forest", {"a": a, "b": b}, {"mode": "ndvi"})
    tif = next(d for d in plain["downloads"] if d["filename"].endswith("_forest_change.tif"))
    with rasterio.open(io.BytesIO(client.get(tif["url"]).content)) as d:
        loss = d.read(1) == 2
    west, east = int(loss[:, :120].sum()), int(loss[:, 120:].sum())
    assert west and east  # the test needs loss on both sides

    agb = np.where(np.arange(120)[None, :] < 60, 100.0, 300.0).repeat(100, axis=0)
    halves = _tif(tmp_path / "agb_halves.tif", agb, from_origin(E0, N0, 60, 60), "EPSG:32646")
    res = run(client, "forest", {"a": a, "b": b, "biomass": _upload(client, halves)}, {"mode": "ndvi", "emissions": {"zone": "trop-moist", "biomassCiPct": 20}})
    e = res["emissions"]
    n = west + east
    assert e["agb"] == pytest.approx((100 * west + 300 * east) / n)
    # The root-to-shoot ratio is applied cell by cell: 0.20 below 125 t/ha, 0.24 above.
    assert e["totalBiomass"] == pytest.approx((100 * 1.20 * west + 300 * 1.24 * east) / n)
    assert e["biomassSource"] == "map" and e["agbCi"] == pytest.approx(e["agb"] * 0.2) and e["biomassMap"]["coveredShare"] == pytest.approx(1)

    # The same constant biomass in geographic coordinates, larger than the scene: reprojected, the mean is unchanged.
    from pyproj import Transformer

    (w, e_), (s, n_) = Transformer.from_crs(32646, 4326, always_xy=True).transform([E0 - 500, E0 + 7700], [N0 - 6500, N0 + 500])
    geo = _tif(tmp_path / "agb_wgs84.tif", np.full((300, 400), 180.0), from_origin(w, n_, (e_ - w) / 400, (n_ - s) / 300), "EPSG:4326")
    g = run(client, "forest", {"a": a, "b": b, "biomass": _upload(client, geo)}, {"mode": "ndvi", "emissions": {"zone": "trop-moist"}})["emissions"]
    assert g["agb"] == pytest.approx(180, rel=1e-5) and g["totalBiomass"] == pytest.approx(180 * 1.24, rel=1e-5)
    assert any("uncertainty" in x for x in g["notes"])  # no map uncertainty was given

    # A map of the western half only: its mean applies to all the loss, and the report says how much it covered.
    part = _tif(tmp_path / "agb_west.tif", np.full((100, 60), 150.0), from_origin(E0, N0, 60, 60), "EPSG:32646")
    p = run(client, "forest", {"a": a, "b": b, "biomass": _upload(client, part)}, {"mode": "ndvi", "emissions": {"zone": "trop-moist"}})["emissions"]
    assert p["agb"] == pytest.approx(150) and p["biomassMap"]["coveredShare"] == pytest.approx(west / n)
    assert f"covers {west / n * 100:.1f} % of the loss area" in p["notes"][0]


def test_validated_emissions_use_the_estimated_area(client, tmp_path):
    """After a reference sample, emissions are recomputed from the estimated loss area and its confidence interval."""
    a, b = sample(client, "forest_ndvi_2016_synthetic.tif"), sample(client, "forest_ndvi_2024_synthetic.tif")
    res = run(client, "forest", {"a": a, "b": b}, {"mode": "ndvi", "emissions": {"agb": 250, "agbCi": 50, "zone": "trop-moist"}})
    jid = res["map"]["image"]["url"].split("/")[3]
    s = client.post(f"/api/jobs/{jid}/validation/sample", json={"total": 200, "minPerClass": 30}).json()
    rows = list(csv.DictReader(io.StringIO(client.get(s["downloads"][-1]["url"]).text)))
    missed = 0
    for r in rows:  # the map, except 3 stable-forest points that are really loss
        r["reference"] = r["map_class"]
        if r["map_class"] == "Stable forest" and missed < 3:
            r["reference"], missed = "Forest loss", missed + 1
    out = tmp_path / "labelled.csv"
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    with out.open("rb") as fh:
        fid = client.post("/api/files", files={"file": ("labelled.csv", fh, "text/csv")}).json()["id"]
    acc = client.post(f"/api/jobs/{jid}/validation/accuracy", json={"file": fid}).json()
    loss = next(c for c in acc["classes"] if c["label"] == "Forest loss")
    e = acc["emissions"]
    assert e["areaSource"] == "sample" and e["areaHa"] == pytest.approx(loss["area"]) and e["areaCi"] == pytest.approx(loss["areaCi"])
    assert e["co2"] == pytest.approx(loss["area"] * 250 * 1.24 * 0.47 * 44 / 12)
    # Both uncertainties now widen the interval beyond the biomass's ± 20 %.
    assert (e["co2High"] - e["co2Low"]) / 2 / e["co2"] > 0.2
    assert e["uncertaintyPct"]["approach1"] == pytest.approx(math.hypot(loss["areaCi"] / loss["area"] * 100, 20))
    assert "CO₂ emissions from the estimated loss area" in acc["markdown"] and "map's own count" not in acc["markdown"]
