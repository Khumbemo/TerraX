def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] and body["eager"] is True and "forest" in body["tools"]


def test_upload_describe_and_forest_job(client, sample):
    with open(sample("forest_ndvi_2016_synthetic.tif"), "rb") as fh:
        a = client.post("/api/files", files={"file": ("before.tif", fh, "image/tiff")}).json()
    assert a["kind"] == "raster" and a["meta"]["bands"] == 1 and a["meta"]["epsg"] == 32646
    b = client.post("/api/samples", json={"name": "forest_ndvi_2024_synthetic.tif"}).json()
    assert b["sample"] is True
    job = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a["id"], "b": b["id"]}, "params": {"mode": "ndvi"}}).json()
    assert job["state"] == "done", job
    res = job["result"]
    assert res["result"]["loss"]["ha"] == 184.05 or abs(res["result"]["loss"]["ha"] - 184.05) < 1e-6
    assert "| Forest loss (ΔNDVI ≤ -0.2) | 184.05 ha (1.841 km²) |" in res["markdown"]
    img = client.get(res["map"]["image"]["url"])
    assert img.status_code == 200 and img.headers["content-type"] == "image/png"
    poly = client.get(res["downloads"][0]["url"]).json()
    assert len(poly["features"]) == 5


def test_job_errors_are_reported(client, sample):
    a = client.post("/api/samples", json={"name": "forest_ndvi_2016_synthetic.tif"}).json()
    job = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a["id"]}, "params": {"mode": "ndvi"}}).json()
    assert job["state"] == "error" and "Choose a file" in job["message"]
    bad = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a["id"], "b": a["id"]}, "params": {"mode": "ndvi", "lossThreshold": 0.3}}).json()
    assert bad["state"] == "error" and "below 0" in bad["message"]
    assert client.get("/api/jobs/" + "0" * 32).status_code == 404
    assert client.post("/api/jobs", json={"tool": "nope"}).status_code == 400
    assert client.post("/api/samples", json={"name": "../../etc/passwd"}).status_code == 404
