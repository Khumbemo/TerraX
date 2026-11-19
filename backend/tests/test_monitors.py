"""Forest-loss monitoring (terrax/monitors.py) with a stand-in catalogue: reference, two-observation confirmation, alerts."""

import shutil
import time
from datetime import UTC, datetime

import numpy as np
import pytest

from tests.test_accounts import new_client, signup, uniq

E0, N0 = 600000.0, 2850000.0  # 100 × 100 px of 10 m in EPSG:32646
NOW = time.time()
DAY = 86400.0


def _date(days: float) -> str:
    return (datetime.fromtimestamp(NOW + days * DAY, UTC)).strftime("%Y-%m-%dT04:30:00Z")


@pytest.fixture()
def app():
    from terrax.api.main import app as a

    return a


@pytest.fixture()
def catalogue(tmp_path, monkeypatch):
    """Five scenes: two before the monitor starts (the reference) and three after. Forest is NDVI 0.8 (red 0.04,
    NIR 0.36); cleared land is NDVI 0.2 (red 0.1, NIR 0.15). Rows 80–99 are non-forest (NDVI 0.2) throughout."""
    import rasterio
    from pyproj import Transformer
    from rasterio.transform import from_origin

    from terrax import monitors
    from terrax.services.live import StacItem

    def scene(name, cleared=(), cloud=()):
        red, nir, scl = np.full((100, 100), 0.04), np.full((100, 100), 0.36), np.full((100, 100), 4.0)
        red[80:], nir[80:] = 0.1, 0.15
        for rows, cols in cleared:
            red[rows, cols], nir[rows, cols] = 0.1, 0.15
        for rows, cols in cloud:
            red[rows, cols], nir[rows, cols], scl[rows, cols] = 0.1, 0.15, 9  # low values under a cloud the SCL flags
        p = tmp_path / f"{name}.tif"
        with rasterio.open(p, "w", driver="GTiff", width=100, height=100, count=5, dtype="float32", crs="EPSG:32646", transform=from_origin(E0, N0, 10, 10), nodata=np.nan) as d:
            for i, a in enumerate([np.full((100, 100), 0.02), np.full((100, 100), 0.05), red, nir, scl], start=1):
                d.write(a.astype(np.float32), i)
        return p

    A = (slice(20, 40), slice(20, 50))  # 600 px = 6 ha
    B = (slice(50, 52), slice(50, 52))  # 4 px, under the 0.5 ha minimum
    C = (slice(60, 70), slice(20, 40))  # under cloud in scene 3
    D = (slice(60, 70), slice(60, 80))  # 200 px = 2 ha, cleared after scene 3
    files = {
        "ref1": (scene("ref1"), -60, 5.0), "ref2": (scene("ref2"), -30, 8.0),
        "s3": (scene("s3", [A, B], [C]), 5, 12.0), "s4": (scene("s4", [A, B, D]), 10, 3.0), "s5": (scene("s5", [A, B, D]), 15, 4.0),
    }
    items = {k: StacItem(id=f"S2B_46RFQ_{k}", datetime=_date(d), cloud=c, epsg=32646) for k, (_, d, c) in files.items()}
    by_id = {it.id: files[k][0] for k, it in items.items()}

    def search(bbox, start, end, max_cloud):
        return [it for it in items.values() if start <= it.datetime[:10] <= end and (it.cloud or 0) < max_cloud]

    def read(item, bbox, out):
        shutil.copy(by_id[item.id], out)
        return [f"Reflectance (test scene {item.id})."]

    monkeypatch.setattr(monitors, "search_scenes", search)
    monkeypatch.setattr(monitors, "read_scene", read)
    sent = []
    monkeypatch.setattr(monitors.mailer, "can_send", lambda: True)
    monkeypatch.setattr(monitors.mailer, "send", lambda to, subject, text: sent.append((to, subject, text)))
    # The watched polygon: px 5–94 across, rows 5–94 (so the non-forest rows 80–94 are inside it too).
    tr = Transformer.from_crs(32646, 4326, always_xy=True)
    xs, ys = tr.transform([E0 + 50, E0 + 950, E0 + 950, E0 + 50, E0 + 50], [N0 - 50, N0 - 50, N0 - 950, N0 - 950, N0 - 50])
    poly = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [list(zip(xs, ys, strict=True))]}}]}
    return {"items": items, "sent": sent, "poly": poly}


def test_reference_confirmation_alerts_and_email(app, catalogue, tmp_path):
    from terrax import monitors, storage

    c = new_client(app)
    email = uniq("watch")
    signup(c, email)
    r = c.post("/api/monitors", json={"name": "Kohima block", "geojson": catalogue["poly"]})
    assert r.status_code == 201, r.text
    m = r.json()
    mid = m["id"]
    # Created and checked at once (eager mode in the tests): the reference comes from the two earlier scenes.
    assert m["status"].startswith("Reference built from 2 scenes") and m["lastScene"] == catalogue["items"]["ref2"].datetime
    assert (storage.root() / "monitors" / mid / "reference.tif").exists()

    # Scene 3: block A and speck B drop for the first time (pending); C is under a cloud; nothing is confirmed yet.
    out = monitors.check(mid, now=NOW + 6 * DAY)
    assert out["alerts"] == [] and "6.04 ha awaits confirmation" in out["status"]

    # Scene 4: A is low again in the next clear scene, so it is confirmed: one alert of 6 ha. B (0.04 ha) is below the
    # minimum patch. D drops for the first time. C was never seen low in a clear scene.
    out = monitors.check(mid, now=NOW + 11 * DAY)
    (a1,) = out["alerts"]
    assert a1["areaHa"] == pytest.approx(6) and a1["patches"] == 1
    assert a1["firstSeen"] == catalogue["items"]["s3"].datetime[:10] and a1["confirmed"] == catalogue["items"]["s4"].datetime[:10]
    alerts_mail = [m for m in catalogue["sent"] if "new forest loss" in m[1]]  # the sign-up's confirmation message is also sent
    assert a1["emailed"] and len(alerts_mail) == 1 and alerts_mail[0][0] == email and "6.00 ha" in alerts_mail[0][2] and "Kohima block" in alerts_mail[0][1]

    # Scene 5: D is confirmed (2 ha). A, already reported, is not reported again.
    out = monitors.check(mid, now=NOW + 16 * DAY)
    (a2,) = out["alerts"]
    assert a2["areaHa"] == pytest.approx(2) and a2["firstSeen"] == catalogue["items"]["s4"].datetime[:10]
    assert monitors.check(mid, now=NOW + 17 * DAY)["status"].startswith("No new scenes")

    got = c.get(f"/api/monitors/{mid}").json()
    assert [a["areaHa"] for a in got["alerts"]] == [pytest.approx(2), pytest.approx(6)]  # newest first
    gj = c.get(f"/api/monitors/{mid}/alerts/{a1['id']}.geojson")
    assert gj.status_code == 200 and "attachment" in gj.headers["content-disposition"]
    assert sum(f["properties"]["area_ha"] for f in gj.json()["features"]) == pytest.approx(6)
    assert c.get("/api/monitors").json()["monitors"][0]["alertCount"] == 2

    # Another account cannot see or change it; a guest cannot keep monitors at all.
    other = new_client(app)
    signup(other, uniq("other"))
    assert other.get(f"/api/monitors/{mid}").status_code == 404 and other.delete(f"/api/monitors/{mid}").status_code == 404
    assert new_client(app).get("/api/monitors").status_code == 401

    # Paused monitors are not due; deleting removes its alerts and files.
    c.patch(f"/api/monitors/{mid}", json={"active": False})
    assert mid not in monitors.due(NOW + 400 * DAY)
    assert c.delete(f"/api/monitors/{mid}").status_code == 204
    assert c.get(f"/api/monitors/{mid}").status_code == 404 and not (storage.root() / "monitors" / mid).exists()


def test_scheduling_and_limits(app, catalogue):
    from terrax import monitors

    c = new_client(app)
    signup(c, uniq("limits"))
    mid = c.post("/api/monitors", json={"name": "a", "geojson": catalogue["poly"], "settings": {"checkHours": 12}}).json()["id"]
    m = monitors.get(mid)
    assert m["next_check"] == pytest.approx(m["last_checked"] + 12 * 3600)
    assert mid not in monitors.due(m["last_checked"] + 11 * 3600) and mid in monitors.due(m["last_checked"] + 13 * 3600)
    # Too large an area, a setting out of range, no polygons.
    big = {"type": "Polygon", "coordinates": [[[94.0, 25.6], [94.3, 25.6], [94.3, 25.9], [94.0, 25.9], [94.0, 25.6]]]}
    assert "up to 14 km" in c.post("/api/monitors", json={"geojson": big}).json()["detail"]
    assert "between 0.05 and 1" in c.post("/api/monitors", json={"geojson": catalogue["poly"], "settings": {"drop": 2}}).json()["detail"]
    assert "polygons" in c.post("/api/monitors", json={"geojson": {"type": "Point", "coordinates": [94, 25]}}).json()["detail"]
    # Rebuilding the reference starts again from the scenes before now.
    r = c.patch(f"/api/monitors/{mid}", json={"rebuildReference": True}).json()
    assert r["status"].startswith("Reference built") and r["reference"]["dates"]


def test_waiting_for_a_reference(app, catalogue, monkeypatch):
    from terrax import monitors

    monkeypatch.setattr(monitors, "search_scenes", lambda *a: [])
    c = new_client(app)
    signup(c, uniq("empty"))
    m = c.post("/api/monitors", json={"geojson": catalogue["poly"]}).json()
    assert m["status"].startswith("Waiting for scenes") and m["reference"] is None
    assert monitors.check(m["id"], now=NOW + DAY)["status"].startswith("Waiting for scenes")  # tried again at each check
