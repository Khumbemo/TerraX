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


def test_sentinel2_reflectance_is_physical(client):
    """Up to three scenes: over pixels the scene classes as vegetation (SCL 4), red reflectance is small and positive and
    NIR is well above it (the red edge). A failure lists each scene's processing baseline, metadata scale/offset and raw
    digital numbers, which is what decides whether the offset is right."""
    import rasterio
    from rasterio.windows import from_bounds

    from terrax import storage

    r = client.post("/api/live/sentinel/search", json={"bbox": BBOX, "start": "2024-01-01", "end": "2024-03-31", "maxCloud": 40, "limit": 10})
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items, "no Sentinel-2 scene under 40 % cloud in three months of the dry season"
    report, ok = [], []
    for item in items[:3]:
        res = run(client, "sentinel", {}, {"item": item, "bbox": BBOX})
        assert res["file"]["meta"]["bands"] == 5
        with rasterio.open(storage.get_file(res["file"]["id"]).path) as d:
            red, nir, scl = d.read(3), d.read(4), d.read(5)
            bounds, crs = d.bounds, d.crs
        with rasterio.open(item["assets"]["red"]["href"]) as src:  # the raw digital numbers of the same window
            assert src.crs == crs
            dn = src.read(1, window=from_bounds(*bounds, src.transform)).astype(float)
        dn = dn[dn > 0]
        veg = scl == 4
        classes = {int(k): int(v) for k, v in zip(*np.unique(scl[np.isfinite(scl)], return_counts=True), strict=True)}
        line = (f"{item['id']} baseline {item['processingBaseline']} red scale/offset {item['assets']['red']['scale']}/{item['assets']['red']['offset']} "
                f"raw DN p5/p50/p95 {np.percentile(dn, [5, 50, 95]).round().tolist()} SCL {classes}")
        if veg.sum() >= 100:
            rv, nv = float(np.nanmedian(red[veg])), float(np.nanmedian(nir[veg]))
            line += f" vegetation red {rv:.4f} nir {nv:.4f}"
            ok.append(0 < rv < 0.15 and nv > rv + 0.1)
        report.append(line)
    assert ok, "no scene had 100 vegetation pixels:\n" + "\n".join(report)
    assert all(ok), "reflectance is not physical:\n" + "\n".join(report)


def test_sentinel2_median_composite_of_real_scenes(client):
    """Several real dry-season scenes over the same area: a composite with few empty pixels and NIR above red."""
    import rasterio

    from terrax import storage

    r = client.post("/api/live/sentinel/search", json={"bbox": BBOX, "start": "2024-01-01", "end": "2024-03-31", "maxCloud": 60, "limit": 10})
    assert r.status_code == 200, r.text
    items = r.json()["items"][:4]
    assert len(items) >= 2, "fewer than two Sentinel-2 scenes in three months"
    res = run(client, "sentinel_composite", {}, {"items": items, "bbox": BBOX})
    comp = res["composite"]
    assert len(comp["scenes"]) >= 2 and comp["emptyShare"] < 0.2, comp
    with rasterio.open(storage.get_file(res["file"]["id"]).path) as d:
        red, nir, clear = d.read(3), d.read(4), d.read(5)
    ok = np.isfinite(red) & np.isfinite(nir)
    assert ok.mean() > 0.8 and 0 < float(np.median(red[ok])) < 0.2 and float(np.median(nir[ok])) > float(np.median(red[ok])) + 0.05
    assert clear.max() <= len(comp["scenes"])
