"""TerraX HTTP API.

Run with ``uvicorn terrax.api.main:app``. Jobs go to Celery workers through
Redis (or run in-process with TERRAX_EAGER=true).
"""

from __future__ import annotations

import mimetypes
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from .. import __version__, storage
from ..config import settings
from ..tasks import submit

app = FastAPI(title="TerraX API", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origins=list(settings().cors_origins), allow_methods=["*"], allow_headers=["*"])

SAMPLES = {
    "forest_ndvi_2016_synthetic.tif", "forest_ndvi_2024_synthetic.tif", "burn_nbr_pre_synthetic.tif", "burn_nbr_post_synthetic.tif",
    "terrain_dem_synthetic.tif", "satellite_4band_synthetic.tif", "monthly_climate_1990_2024_synthetic.csv", "survey_plot_synthetic.geojson",
    "aerial_photo_synthetic.png", "forest_capture_inventory_synthetic.csv", "plot_boundary_synthetic.geojson",
}


def _samples_dir() -> Path:
    return settings().data_dir / "samples"


def _all_samples() -> list[str]:
    d = _samples_dir()
    return sorted(p.name for p in d.iterdir() if p.is_file()) if d.exists() else []


@app.exception_handler(KeyError)
async def not_found(_: Request, exc: KeyError) -> JSONResponse:
    return JSONResponse({"detail": "Not found (it may have expired)."}, status_code=404)


@app.get("/api/health")
def health() -> dict[str, Any]:
    s = settings()
    redis_ok: bool | None = None
    if not s.eager:
        try:
            import redis

            redis_ok = bool(redis.Redis.from_url(s.redis_url, socket_connect_timeout=1).ping())
        except Exception:
            redis_ok = False
    from ..tools import load_all

    return {"ok": True, "version": __version__, "eager": s.eager, "redis": redis_ok, "tools": sorted(load_all()), "ai": bool(s.gemini_api_key)}


# ── Files ────────────────────────────────────────────────────────────────────


@app.post("/api/files", status_code=201)
async def upload(file: UploadFile = File(...)) -> dict:
    limit = settings().max_upload
    with tempfile.NamedTemporaryFile(delete=False, dir=storage.root(), suffix=".upload") as tmp:
        size = 0
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > limit:
                tmp.close()
                Path(tmp.name).unlink(missing_ok=True)
                raise HTTPException(413, f"The file is larger than the {limit // (1024 * 1024)} MB upload limit.")
            tmp.write(chunk)
    try:
        f = storage.save_file(file.filename or "upload", Path(tmp.name))
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    return f.public()


@app.get("/api/samples")
def samples() -> list[str]:
    return _all_samples()


class SampleRequest(BaseModel):
    name: str


@app.post("/api/samples", status_code=201)
def use_sample(req: SampleRequest) -> dict:
    name = storage.safe_name(req.name)
    p = _samples_dir() / name
    if name not in _all_samples() or not p.is_file():
        raise HTTPException(404, f"There is no sample called {name}.")
    return storage.save_file(name, p, sample=True).public()


@app.get("/api/files/{file_id}")
def file_info(file_id: str) -> dict:
    return storage.get_file(file_id).public()


@app.get("/api/files/{file_id}/content")
def file_content(file_id: str) -> FileResponse:
    f = storage.get_file(file_id)
    return FileResponse(f.path, filename=f.name, media_type=mimetypes.guess_type(f.name)[0] or "application/octet-stream")


# ── Jobs ─────────────────────────────────────────────────────────────────────


class JobRequest(BaseModel):
    tool: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/jobs", status_code=202)
def create_job(req: JobRequest) -> dict:
    from ..tools import load_all

    if req.tool not in load_all():
        raise HTTPException(400, f"Unknown tool “{req.tool}”.")
    for v in _file_ids(req.inputs):
        storage.get_file(v)  # 404 early for missing uploads
    jid = storage.create_job(req.tool, req.inputs, req.params)
    try:
        submit(jid)
    except Exception as err:  # broker down
        storage.update_job(jid, state="error", message=f"The job queue is not reachable ({err}). Check that Redis and a worker are running.")
    return _status_with_result(jid)


def _file_ids(inputs: dict[str, Any]) -> list[str]:
    out = []
    for v in inputs.values():
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            out += [x for x in v if isinstance(x, str)]
    return out


def _status_with_result(jid: str) -> dict:
    st = storage.job_status(jid)
    st.pop("trace", None)
    if st["state"] == "done":
        st["result"] = storage.job_result(jid)
    return st


@app.get("/api/jobs/{job_id}")
def job(job_id: str) -> dict:
    return _status_with_result(job_id)


@app.get("/api/jobs/{job_id}/artifacts/{name}")
def artifact(job_id: str, name: str) -> FileResponse:
    p = storage.artifact_path(job_id, name)
    media = mimetypes.guess_type(p.name)[0] or ("application/geo+json" if p.suffix == ".geojson" else "application/octet-stream")
    return FileResponse(p, media_type=media, headers={"Cache-Control": "private, max-age=86400"})


def include_routers() -> None:
    """Optional routers (agents, live data, maps) register here."""
    import importlib

    for mod in ("agents", "live", "maps", "rasters"):
        try:
            m = importlib.import_module(f"{__package__}.{mod}")
        except ModuleNotFoundError as err:
            if err.name != f"{__package__}.{mod}":
                raise
            continue
        app.include_router(m.router)


include_routers()
