"""Uploads and results in an S3-compatible bucket (moto's in-process S3), with the storage folder as a cache.

"Another machine" is simulated by deleting the local copy: whatever the API or a worker needs must then come from the
bucket.
"""

import json
import os
import shutil
import time

import pytest

BUCKET = "terrax-test"


@pytest.fixture()
def bucket(monkeypatch):
    moto = pytest.importorskip("moto")
    from terrax import objectstore

    for k in ("AWS_PROFILE", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_S3", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("TERRAX_S3_BUCKET", BUCKET)
    monkeypatch.setenv("TERRAX_S3_PREFIX", "/site/")  # normalised to "site/"
    with moto.mock_aws():
        objectstore._client.cache_clear()
        objectstore.client().create_bucket(Bucket=BUCKET)
        yield objectstore
    objectstore._client.cache_clear()


def use_sample(client, name="terrain_dem_synthetic.tif"):
    r = client.post("/api/samples", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def keys(store, prefix=""):
    return set(store.list_keys(prefix))


def forget(*folders):
    """This machine loses its copies (a restart on a disk that does not survive one, or another machine)."""
    for f in folders:
        shutil.rmtree(f, ignore_errors=True)


def test_uploads_live_in_the_bucket_and_come_back(client, bucket, sample):
    from terrax import storage

    data = sample("terrain_dem_synthetic.tif").read_bytes()
    r = client.post("/api/files", files={"file": ("dem.tif", data, "image/tiff")})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert keys(bucket, f"files/{fid}/") == {f"files/{fid}/meta.json", f"files/{fid}/dem.tif"}
    raw = bucket.client().list_objects_v2(Bucket=BUCKET)["Contents"]
    assert all(o["Key"].startswith("site/") for o in raw)  # under the prefix
    forget(storage.root() / "files" / fid)
    assert client.get(f"/api/files/{fid}").json()["name"] == "dem.tif"
    assert client.get(f"/api/files/{fid}/content").content == data
    assert client.delete(f"/api/files/{fid}").status_code == 204
    assert not keys(bucket, f"files/{fid}/")


def test_results_survive_losing_the_disk(client, bucket):
    from terrax import storage

    dem = use_sample(client)
    job = client.post("/api/jobs", json={"tool": "terrain", "inputs": {"dem": dem}}).json()
    assert job["state"] == "done", job.get("message")
    jid = job["id"]
    stored = keys(bucket, f"jobs/{jid}/")
    assert {f"jobs/{jid}/request.json", f"jobs/{jid}/status.json", f"jobs/{jid}/result.json"} <= stored
    arts = sorted(k.rsplit("/", 1)[1] for k in stored if "/artifacts/" in k)
    assert arts and arts == sorted(p.name for p in (storage.job_dir(jid) / "artifacts").iterdir())
    # The bucket's status is the finished one, written after the result.
    assert json.loads(bucket.read_bytes(f"jobs/{jid}/status.json"))["state"] == "done"
    pic = job["result"]["map"]["image"]["url"]
    before = client.get(pic).content
    forget(storage.job_dir(jid), storage.root() / "files" / dem)
    again = client.get(f"/api/jobs/{jid}").json()
    assert again["state"] == "done" and again["result"]["markdown"] == job["result"]["markdown"]
    assert client.get(pic).content == before


def test_a_worker_on_another_machine(client, bucket):
    """The API stores the request; a worker without the API's disk runs it from the bucket; the API reads the
    finished result from the bucket."""
    from terrax import storage
    from terrax.tasks import run_job

    dem = use_sample(client)
    jid = storage.create_job("terrain", {"dem": dem}, {}, owner="g:test")
    forget(storage.job_dir(jid), storage.root() / "files" / dem)  # the worker's disk has neither
    assert run_job(jid)["state"] == "done"
    forget(storage.job_dir(jid))  # and the API's disk has none of what the worker wrote
    assert storage.job_status(jid)["state"] == "done"
    assert "Hypsometric integral" in storage.job_result(jid)["markdown"]


def test_status_of_a_job_running_elsewhere_is_the_newer_copy(bucket):
    from terrax import storage

    jid = storage.create_job("terrain", {}, {}, owner="g:test")
    local = storage.job_status(jid)
    assert local["state"] == "queued"
    remote = {**local, "state": "running", "progress": 0.4, "message": "Flow routing", "updated": local["updated"] + 5}
    bucket.put_bytes(f"jobs/{jid}/status.json", json.dumps(remote).encode())
    assert storage.job_status(jid)["progress"] == 0.4
    assert storage.read_json(storage.job_dir(jid) / "status.json")["state"] == "queued"  # never written over here
    storage.claim(jid)  # running in this process: this disk is the truth
    try:
        assert storage.job_status(jid)["state"] == "queued"
    finally:
        storage.release(jid)


def test_progress_reaches_the_bucket_at_most_every_few_seconds(bucket, monkeypatch):
    from terrax import storage

    jid = storage.create_job("terrain", {}, {}, owner="g:test")
    storage.update_job(jid, state="running", progress=0.1, message="a")  # a state change always goes
    storage.update_job(jid, progress=0.2, message="b")  # too soon after
    assert json.loads(bucket.read_bytes(f"jobs/{jid}/status.json"))["progress"] == 0.1
    real = time.time
    monkeypatch.setattr(storage.time, "time", lambda: real() + storage.STATUS_EVERY_S + 1)
    storage.update_job(jid, progress=0.3, message="c")
    assert json.loads(bucket.read_bytes(f"jobs/{jid}/status.json"))["progress"] == 0.3
    storage.release(jid)


def test_follow_ups_after_the_disk_is_lost(client, bucket):
    """A watershed click and a validation sample need the job's saved grids, and save new pictures and tables."""
    from terrax import storage

    dem = use_sample(client)
    h = client.post("/api/jobs", json={"tool": "hydrology", "inputs": {"dem": dem}, "params": {"thresholdKm2": 0.5}}).json()["result"]
    jid = h["layer"].split("/")[3]
    forget(storage.job_dir(jid), storage.root() / "files" / dem)
    ws = client.post(f"/api/terrain/{jid}/watershed", json={"col": h["flow"]["width"] // 2, "row": h["flow"]["height"] - 5})
    assert ws.status_code == 200, ws.text
    name = ws.json()["layer"].split("?")[0].rsplit("/", 1)[1]
    assert f"jobs/{jid}/artifacts/{name}" in keys(bucket, f"jobs/{jid}/artifacts/")
    forget(storage.job_dir(jid))
    assert client.get(ws.json()["layer"]).headers["content-type"] == "image/png"

    a, b = use_sample(client, "forest_ndvi_2016_synthetic.tif"), use_sample(client, "forest_ndvi_2024_synthetic.tif")
    res = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a, "b": b}, "params": {"mode": "ndvi"}}).json()["result"]
    fj = res["map"]["image"]["url"].split("/")[3]
    forget(storage.job_dir(fj), storage.root() / "files" / a)
    s = client.post(f"/api/jobs/{fj}/validation/sample", json={"total": 100, "minPerClass": 20})
    assert s.status_code == 200, s.text
    assert f"jobs/{fj}/artifacts/sample.json" in keys(bucket, f"jobs/{fj}/artifacts/")
    forget(storage.job_dir(fj))
    csv_text = client.get(s.json()["downloads"][-1]["url"]).text
    assert csv_text.startswith("id,lon,lat,row,col,map_class,reference")


def test_purge_deletes_expired_objects_and_drops_unused_local_copies(client, bucket, monkeypatch):
    from sqlalchemy import update

    from terrax import db, storage

    gone, kept = use_sample(client), use_sample(client)
    with db.connect() as c:
        c.execute(update(db.files).where(db.files.c.id == gone).values(expires=time.time() - 1))
    old = time.time() - 48 * 3600
    os.utime(storage.root() / "files" / kept, (old, old))
    monkeypatch.setenv("TERRAX_S3_CACHE_HOURS", "24")
    storage.purge_old()
    assert not keys(bucket, f"files/{gone}/") and not (storage.root() / "files" / gone).exists()
    assert not (storage.root() / "files" / kept).exists()  # unused for two days: only the bucket keeps it
    assert keys(bucket, f"files/{kept}/") and storage.get_file(kept).path.is_file()


def test_ready_checks_the_bucket(client, bucket, monkeypatch):
    r = client.get("/api/health/ready").json()
    assert r["checks"]["objectStore"] is True
    assert client.get("/api/health").json()["objectStore"] is True
    monkeypatch.setenv("TERRAX_S3_BUCKET", "no-such-bucket")
    assert client.get("/api/health/ready").status_code == 503
