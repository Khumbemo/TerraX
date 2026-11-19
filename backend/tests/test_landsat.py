"""Landsat Collection 2 Level-2 from the Planetary Computer (mocked catalogue, local files): search, one scene, a composite.

The live catalogue is tested in test_live.py (TERRAX_LIVE=1)."""

import numpy as np
import pytest

from tests.test_tools import run, run_err

E0, N0 = 600000, 2850000
RED, NIR = 0.04, 0.35  # vegetation
BOX = None  # set from the grid below


def _dn(reflectance: float) -> int:
    return round((reflectance + 0.2) / 2.75e-5)  # USGS Collection 2 Level-2: ρ = DN × 0.0000275 − 0.2


@pytest.fixture
def scenes(tmp_path, monkeypatch):
    """Two dates over a 100 × 100 px (3 km) UTM grid. 2010 (Landsat 7, no scale in its metadata) has a fill stripe in
    columns 0–9; 2023 (Landsat 8) has a cloud over rows 0–29, flagged in QA_PIXEL bit 3."""
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import from_origin

    from terrax.services import live

    keys = ["blue", "green", "red", "nir08", "swir16", "swir22", "qa_pixel"]
    values = {"blue": 0.02, "green": 0.05, "red": RED, "nir08": NIR, "swir16": 0.15, "swir22": 0.07}
    href = "https://landsateuwest.blob.core.windows.net/landsat-c2/level-2/{}.TIF"
    local = {}

    def write(key, date, data):
        p = tmp_path / f"{key}_{date}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=100, height=100, count=1, dtype="uint16", crs="EPSG:32646", transform=from_origin(E0, N0, 30, 30), nodata=0) as d:
            d.write(data.astype(np.uint16), 1)
        local[href.format(f"{key}_{date}")] = str(p)

    for date, fill, cloud in (("2010-02-01", True, False), ("2023-02-01", False, True)):
        for k in keys[:-1]:
            dn = np.full((100, 100), _dn(values[k]))
            if fill:
                dn[:, :10] = 0
            if cloud:
                dn[:30] = _dn(0.6)  # bright cloud in every band
            write(k, date, dn)
        qa = np.full((100, 100), 1 << 6)  # clear
        if fill:
            qa[:, :10] = 1  # bit 0: fill
        if cloud:
            qa[:30] = (1 << 3) | (1 << 1)  # cloud and dilated cloud
        write("qa_pixel", date, qa)

    def feature(date, platform, scaled):
        sid = f"{'LE07' if platform == 'landsat-7' else 'LC08'}_L2SP_135042_{date.replace('-', '')}_02_T1"
        assets = {k: {"href": href.format(f"{k}_{date}")} for k in keys}
        if scaled:
            for k in keys[:-1]:
                assets[k]["raster:bands"] = [{"scale": 2.75e-05, "offset": -0.2}]
        return {"id": sid, "properties": {"datetime": f"{date}T04:10:00Z", "eo:cloud_cover": 12.0, "platform": platform, "proj:code": "EPSG:32646"}, "assets": assets}

    feats = [feature("2023-02-01", "landsat-8", True), feature("2010-02-01", "landsat-7", False)]
    sent = []

    def fetch(url, **kw):
        sent.append((url, kw.get("body")))
        return {"token": "sv=2024&sig=x"} if "/sas/" in url else {"features": feats}

    monkeypatch.setattr(live, "fetch_json", fetch)
    monkeypatch.setattr(live, "_sign", lambda h, token: local[h])
    (w, e), (s, n) = Transformer.from_crs(32646, 4326, always_xy=True).transform([E0 + 15, E0 + 2985], [N0 - 2985, N0 - 15])
    return {"bbox": [w, s, e, n], "sent": sent, "href": href}


def _bands(client, fid):
    import rasterio

    from terrax import storage

    with rasterio.open(storage.get_file(fid).path) as d:
        return d.read(), list(d.descriptions)


def test_search_asks_for_tier_1_landsat(client, scenes):
    found = client.post("/api/live/landsat/search", json={"bbox": scenes["bbox"], "start": "2009-01-01", "end": "2024-12-31", "maxCloud": 40}).json()["items"]
    url, body = scenes["sent"][-1]
    assert url.endswith("planetarycomputer.microsoft.com/api/stac/v1/search")
    assert body["collections"] == ["landsat-c2-l2"] and body["query"] == {"eo:cloud_cover": {"lt": 40}, "landsat:collection_category": {"eq": "T1"}}
    assert [i["platform"] for i in found] == ["landsat-8", "landsat-7"] and found[0]["epsg"] == 32646


def test_one_scene_is_surface_reflectance_with_its_qa_band(client, scenes):
    items = client.post("/api/live/landsat/search", json={"bbox": scenes["bbox"], "start": "2009-01-01", "end": "2024-12-31"}).json()["items"]
    l8 = run(client, "landsat", {}, {"item": items[0], "bbox": scenes["bbox"]})
    data, names = _bands(client, l8["file"]["id"])
    assert names == ["blue (B2)", "green (B3)", "red (B4)", "nir (B5)", "swir1 (B6)", "swir2 (B7)", "qa_pixel"]
    clear = data[:, 50, 50]
    assert clear[2] == pytest.approx(RED, abs=3e-5) and clear[3] == pytest.approx(NIR, abs=3e-5) and clear[6] == 1 << 6
    assert "from the STAC raster:bands metadata" in l8["notes"][0] and "Landsat 8 Collection 2 Level-2" in l8["notes"][1]
    assert l8["file"]["name"].startswith("LC08_L2SP_135042_20230201")  # the series tool reads the date from the name

    # Landsat 7 with no scale in its metadata: the USGS factors; TM/ETM+ band numbers; the fill stripe is empty.
    l7 = run(client, "landsat", {}, {"item": items[1], "bbox": scenes["bbox"]})
    data, names = _bands(client, l7["file"]["id"])
    assert names[:4] == ["blue (B1)", "green (B2)", "red (B3)", "nir (B4)"] and names[5] == "swir2 (B7)"
    assert data[2, 50, 50] == pytest.approx(RED, abs=3e-5) and np.isnan(data[2, :, :10]).all()
    assert "USGS Collection 2 Level-2 scale factors" in l7["notes"][0] and any("scan line corrector off" in n for n in l7["notes"])

    # Files anywhere but the Planetary Computer's storage are refused.
    evil = {**items[0], "assets": {**items[0]["assets"], "red": {"href": "https://evil.example.com/red.TIF"}}}
    assert "Planetary Computer's storage" in run_err(client, "landsat", {}, {"item": evil, "bbox": scenes["bbox"]})


def test_median_composite_skips_cloud_and_fill(client, scenes):
    items = client.post("/api/live/landsat/search", json={"bbox": scenes["bbox"], "start": "2009-01-01", "end": "2024-12-31"}).json()["items"]
    res = run(client, "landsat_composite", {}, {"items": items, "bbox": scenes["bbox"]})
    data, names = _bands(client, res["file"]["id"])
    assert names == ["blue", "green", "red", "nir", "swir1", "swir2", "clear observations"]  # mixed sensors: roles only
    clear = data[6]
    # Cloud (2023) in rows 0–29 and fill (2010) in columns 0–9: one clear date there, two elsewhere, none in the corner.
    assert clear[50, 50] == 2 and clear[10, 50] == 1 and clear[50, 5] == 1 and clear[10, 5] == 0
    assert data[2, 10, 50] == pytest.approx(RED, abs=3e-5)  # the 2010 value under the 2023 cloud, not the cloud
    assert np.isnan(data[2, 10, 5])
    notes = " ".join(res["notes"])
    assert "QA_PIXEL bits 0–5" in notes and "mixes TM/ETM+ and OLI" in notes and "scan line corrector off" in notes
    assert res["file"]["name"] == "Landsat_median_2010-02-01_2023-02-01.tif"
