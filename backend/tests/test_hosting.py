"""One-container hosting: the API serving the web app, and jobs on background threads."""

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from terrax.api.main import mount_web_app


@pytest.fixture()
def site(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>TerraX</title>")
    (tmp_path / "assets" / "app-1a2b.js").write_text("console.log(1)")
    (tmp_path / "sw.js").write_text("self.x = 1")
    (tmp_path.parent / "secret.txt").write_text("not for the web")
    app = FastAPI()

    @app.get("/api/ping")
    def ping() -> dict:
        return {"ok": True}

    mount_web_app(app, tmp_path)
    return TestClient(app)


def test_web_app_files_caching_and_fallback(site):
    r = site.get("/")
    assert r.status_code == 200 and "<title>TerraX</title>" in r.text and r.headers["cache-control"] == "no-cache"
    a = site.get("/assets/app-1a2b.js")
    assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
    assert site.get("/sw.js").headers["cache-control"] == "no-cache"
    head = site.head("/")
    assert head.status_code == 200 and head.headers["content-type"].startswith("text/html")
    deep = site.get("/some/client/view")
    assert deep.status_code == 200 and "<title>TerraX</title>" in deep.text


def test_web_app_leaves_api_alone_and_stays_in_its_folder(site):
    assert site.get("/api/ping").json() == {"ok": True}
    assert site.get("/api/unknown").status_code == 404
    leak = site.get("/%2E%2E/secret.txt")
    assert "not for the web" not in leak.text


def test_mount_needs_a_built_app(tmp_path):
    with pytest.raises(RuntimeError, match=r"index\.html"):
        mount_web_app(FastAPI(), tmp_path)


def test_jobs_on_background_threads(client, monkeypatch):
    from terrax import tasks

    monkeypatch.setenv("TERRAX_EAGER", "false")
    monkeypatch.setenv("TERRAX_JOB_THREADS", "2")
    assert tasks.job_mode() == "threads"
    assert client.get("/api/health").json()["jobs"] == "threads"
    a = client.post("/api/samples", json={"name": "forest_ndvi_2016_synthetic.tif"}).json()
    b = client.post("/api/samples", json={"name": "forest_ndvi_2024_synthetic.tif"}).json()
    job = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a["id"], "b": b["id"]}, "params": {"mode": "ndvi"}}).json()
    assert job["state"] in ("queued", "running", "done")
    for _ in range(200):
        st = client.get(f"/api/jobs/{job['id']}").json()
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert st["state"] == "done", st
    assert abs(st["result"]["result"]["loss"]["ha"] - 184.05) < 1e-6


def test_time_limit_and_memory_errors_are_readable(client, monkeypatch):
    from celery.exceptions import SoftTimeLimitExceeded

    from terrax import tools

    a = client.post("/api/samples", json={"name": "forest_ndvi_2016_synthetic.tif"}).json()
    for exc, text in ((SoftTimeLimitExceeded(), "minute limit"), (MemoryError(), "ran out of memory")):
        def boom(*_args, exc=exc):
            raise exc

        monkeypatch.setitem(tools.load_all(), "forest", boom)
        job = client.post("/api/jobs", json={"tool": "forest", "inputs": {"a": a["id"]}, "params": {}}).json()
        assert job["state"] == "error" and text in job["message"], job
