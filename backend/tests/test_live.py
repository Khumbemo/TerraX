"""The live catalogues, for real: Sentinel-1 RTC from the Microsoft Planetary Computer and Sentinel-2 L2A from Earth Search.

These need the internet, so they run only with TERRAX_LIVE=1 (the "Live data" workflow runs them weekly and when the
code that talks to these services changes). The rest of the suite tests the same code against recorded responses.
"""

import os

import numpy as np
import pytest

from tests.test_tools import run

pytestmark = pytest.mark.skipif(os.environ.get("TERRAX_LIVE") != "1", reason="live services: set TERRAX_LIVE=1")

# About 3 × 3 km of forest and town near Kohima, Nagaland, imaged by both missions on a regular schedule.
BBOX = [94.10, 25.66, 94.13, 25.69]


def _db_median(path, band: int) -> float:
    import rasterio

    with rasterio.open(path) as d:
        a = d.read(band)
    a = a[np.isfinite(a) & (a > 0)]
    assert a.size > 0.5 * d.width * d.height, "more than half the window has no data"
    return float(10 * np.log10(np.median(a)))


def test_sentinel1_search_read_two_dates_and_change(client):
    from terrax import storage

    r = client.post("/api/live/sentinel1/search", json={"bbox": BBOX, "start": "2024-01-01", "end": "2024-03-31", "orbit": "descending", "limit": 20})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) >= 2, items
    assert all(i["orbitState"] == "descending" and set(i["assets"]) == {"vv", "vh"} for i in items)
    # Two dates from the same relative orbit (the same viewing geometry), newest first in the results.
    first = items[0]
    second = next(i for i in items[1:] if i["relativeOrbit"] == first["relativeOrbit"])
    a = run(client, "sentinel1", {}, {"item": second, "bbox": BBOX})
    b = run(client, "sentinel1", {"match": a["file"]["id"]}, {"item": first, "bbox": BBOX, "matchOrbit": second["relativeOrbit"]})
    assert a["file"]["meta"]["bandNames"] == ["VV", "VH"] and a["file"]["meta"]["width"] > 100
    assert (b["file"]["meta"]["width"], b["file"]["meta"]["height"]) == (a["file"]["meta"]["width"], a["file"]["meta"]["height"])
    # Physically sensible γ⁰ over vegetated land (e.g. Ulaby & Long 2014): VV roughly −20 to −2 dB, VH weaker than VV.
    path = storage.get_file(a["file"]["id"]).path
    vv, vh = _db_median(path, 1), _db_median(path, 2)
    assert -20 < vv < -2 and -30 < vh < -8 and vh < vv - 3, (vv, vh)
    res = run(client, "radar", {"before": a["file"]["id"], "after": b["file"]["id"]}, {"vv": 0, "vh": 1})
    assert res["radar"]["dates"][0]["scale"] == "linear" and "change" in res["radar"]


def test_sentinel2_search_and_read(client):
    from terrax import storage

    r = client.post("/api/live/sentinel/search", json={"bbox": BBOX, "start": "2024-01-01", "end": "2024-03-31", "maxCloud": 40, "limit": 10})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "no Sentinel-2 scene under 40 % cloud in three months of the dry season"
    res = run(client, "sentinel", {}, {"item": items[0], "bbox": BBOX})
    meta = res["file"]["meta"]
    assert meta["bands"] == 5 and meta["width"] > 100
    import rasterio

    with rasterio.open(storage.get_file(res["file"]["id"]).path) as d:
        red = d.read(3).astype(float)
    assert np.isfinite(red).mean() > 0.5 and np.nanmedian(red) > 0
