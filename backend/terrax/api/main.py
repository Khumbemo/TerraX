"""TerraX HTTP API.

Run with ``uvicorn terrax.api.main:app``. Jobs go to Celery workers through
Redis, or run in this process (TERRAX_EAGER=true inline, TERRAX_JOB_THREADS=n on
background threads). With TERRAX_STATIC set it also serves the built web app.

Every request passes one middleware (``observe``): it gives the request an ID,
works out who is asking (an account's session, or a guest cookie; see
terrax.auth), refuses cross-site writes, times the request for the metrics,
logs it, and records unexpected errors. Uploads, jobs and their results are
only visible to their owner (and admins).
"""

from __future__ import annotations

import logging
import mimetypes
import tempfile
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import __version__, auth, db, ratelimit, storage
from ..auth import Principal, principal
from ..config import settings
from ..monitoring import configure_logging, init_sentry, metrics, new_request_id, record_exception, render_metrics, request_id
from ..tasks import job_mode, start_purge_thread, submit
from .limits import BodyLimitMiddleware, BodyTooLarge

log = logging.getLogger("terrax.api")
app = FastAPI(title="TerraX API", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origins=list(settings().cors_origins), allow_methods=["*"], allow_headers=["*"], allow_credentials=True,
                   expose_headers=["X-Request-ID", "Retry-After"])
app.add_middleware(BodyLimitMiddleware)  # added last, so it runs first: before CORS, logging and the routes

_started = threading.Event()
_start_lock = threading.Lock()


def _startup() -> None:
    """Once per process, on the first request: logging, Sentry, the database and the configured admin account."""
    if _started.is_set():
        return
    with _start_lock:
        if _started.is_set():
            return
        configure_logging()
        init_sentry("api")
        db.engine()
        auth.ensure_admin()
        s = settings()
        if s.auth_mode not in ("off", "optional", "required"):
            log.warning("TERRAX_AUTH=%s is not off, optional or required; treating it as required.", s.auth_mode)
        _started.set()


_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def _same_site(request: Request) -> bool:
    """Whether a state-changing request comes from this site (or an allowed origin): the browser's Origin header,
    which a cross-site page cannot forge. Requests without one (scripts, curl) are not browsers' cross-site posts."""
    origin = request.headers.get("origin")
    if not origin:
        return True
    if origin in settings().cors_origins:
        return True
    host = request.headers.get("x-forwarded-host") if settings().trusted_proxies else None
    host = (host or request.headers.get("host") or "").split(",")[0].strip()
    return urlsplit(origin).netloc == host


@app.middleware("http")
async def observe(request: Request, call_next):
    _startup()
    rid = new_request_id(request.headers.get("x-request-id"))
    token = request_id.set(rid)
    started = time.perf_counter()
    status = 500
    new_guest: str | None = None
    try:
        if request.url.path.startswith("/api/"):
            if request.method in _UNSAFE and not _same_site(request):
                response: Response = JSONResponse({"detail": "Cross-site requests are not accepted."}, status_code=403)
            else:
                p, new_guest = auth.resolve(request)
                request.state.principal = p
                response = await call_next(request)
        else:
            response = await call_next(request)
        status = response.status_code
    except BodyTooLarge:  # answered with 413 by BodyLimitMiddleware; not a server error
        request_id.reset(token)
        raise
    except Exception as exc:  # anything a route did not handle: recorded, and answered with the request ID
        p0: Principal | None = getattr(request.state, "principal", None)
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        record_exception("server", exc, path=f"{request.method} {request.url.path}", owner=p0.owner if p0 else "")
        response = JSONResponse({"detail": f"Something went wrong on the server. Quote this reference if you report it: {rid}.", "requestId": rid}, status_code=500)
        status = 500
    elapsed = time.perf_counter() - started
    route = getattr(request.scope.get("route"), "path", None) or ("/api/*" if request.url.path.startswith("/api/") else "static")
    metrics.request(request.method, route, status, elapsed)
    response.headers["X-Request-ID"] = rid
    if new_guest:
        auth.set_cookie(response, request, auth.GUEST_COOKIE, new_guest, 400 * 86400)
    if request.url.path.startswith("/api/") and route not in ("/api/health", "/api/metrics"):
        p1: Principal | None = getattr(request.state, "principal", None)
        log.info("%s %s %d %.0f ms", request.method, request.url.path, status, elapsed * 1000,
                 extra={"method": request.method, "path": request.url.path, "status": status, "ms": round(elapsed * 1000, 1), "owner": p1.owner if p1 else ""})
    request_id.reset(token)
    return response

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
    if job_mode() == "celery":
        try:
            import redis

            redis_ok = bool(redis.Redis.from_url(s.redis_url, socket_connect_timeout=1).ping())
        except Exception:
            redis_ok = False
    from ..tools import load_all

    return {"ok": True, "version": __version__, "eager": s.eager, "jobs": job_mode(), "redis": redis_ok, "tools": sorted(load_all()), "ai": bool(s.gemini_api_key),
            "auth": s.auth_mode, "signup": s.signup}


@app.get("/api/health/ready")
def ready() -> JSONResponse:
    """Readiness for a load balancer or orchestrator: the database answers, the storage folder takes writes, and
    (with Celery) Redis answers. 503 when any of them fails."""
    checks: dict[str, bool] = {"database": db.ping()}
    try:
        probe = storage.root() / f".ready-{storage.new_id()}"
        probe.write_bytes(b"ok")
        probe.unlink()
        checks["storage"] = True
    except OSError:
        checks["storage"] = False
    if job_mode() == "celery":
        try:
            import redis

            checks["redis"] = bool(redis.Redis.from_url(settings().redis_url, socket_connect_timeout=1).ping())
        except Exception:
            checks["redis"] = False
    ok = all(checks.values())
    return JSONResponse({"ok": ok, "checks": checks}, status_code=200 if ok else 503)


@app.get("/api/metrics", include_in_schema=False)
def prometheus_metrics(request: Request) -> PlainTextResponse:
    """Prometheus metrics: with TERRAX_METRICS_TOKEN as a bearer token, or for a signed-in admin."""
    import hmac

    tok = settings().metrics_token
    given = request.headers.get("authorization", "")
    p: Principal | None = getattr(request.state, "principal", None)
    if not ((tok and hmac.compare_digest(given.encode(), f"Bearer {tok}".encode())) or (p is not None and p.is_admin)):
        raise HTTPException(401, "Metrics need the TERRAX_METRICS_TOKEN bearer token or an admin sign-in.")
    return PlainTextResponse(render_metrics(), media_type="text/plain; version=0.0.4; charset=utf-8")


class ClientError(BaseModel):
    kind: str = Field("Error", max_length=120)
    message: str = Field(..., max_length=4000)
    stack: str = Field("", max_length=8000)
    page: str = Field("", max_length=300)


@app.post("/api/client-errors", status_code=204)
def client_error(err: ClientError, request: Request) -> Response:
    """An error the web app caught in a browser (window errors, failed renders), kept for the admin panel."""
    from ..monitoring import record_error

    p: Principal | None = getattr(request.state, "principal", None)
    ratelimit.check("client_errors", p.owner if p else "", auth.client_ip(request))
    record_error("client", err.kind, err.message, err.stack, urlsplit(err.page).path[:300], p.owner if p else "")
    return Response(status_code=204)


# ── Files ────────────────────────────────────────────────────────────────────


def _check_quota(p: Principal, adding: int) -> None:
    s = settings()
    quota_mb = s.user_quota_mb if not p.is_guest else s.guest_quota_mb
    if quota_mb and storage.bytes_used(p.owner) + adding > quota_mb * 1024 * 1024:
        hint = "Delete older uploads from your history" if not p.is_guest else "Sign in for more space, or wait for older uploads to expire"
        raise HTTPException(413, f"This would go over your {quota_mb:,} MB of storage. {hint}.")


@app.post("/api/files", status_code=201)
async def upload(request: Request, file: UploadFile = File(...), p: Principal = Depends(principal)) -> dict:
    ratelimit.check("uploads", p.owner, auth.client_ip(request))
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
        _check_quota(p, size)
        f = storage.save_file(file.filename or "upload", Path(tmp.name), owner=p.owner)
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    metrics.count("uploads")
    metrics.count("upload_bytes", size)
    return _with_token(f.public())


@app.get("/api/samples")
def samples() -> list[str]:
    return _all_samples()


class SampleRequest(BaseModel):
    name: str


@app.post("/api/samples", status_code=201)
def use_sample(req: SampleRequest, request: Request, p: Principal = Depends(principal)) -> dict:
    ratelimit.check("interactive", p.owner, auth.client_ip(request))
    name = storage.safe_name(req.name)
    path = _samples_dir() / name
    if name not in _all_samples() or not path.is_file():
        raise HTTPException(404, f"There is no sample called {name}.")
    return _with_token(storage.save_file(name, path, sample=True, owner=p.owner).public())


@app.get("/api/files")
def my_files(p: Principal = Depends(principal), limit: int = Query(100, ge=1, le=500)) -> dict:
    """The caller's stored uploads, newest first, and the space they use."""
    with db.connect() as c:
        rows = c.execute(select(db.files).where(db.files.c.owner == p.owner, db.files.c.purged.is_(False)).order_by(db.files.c.created.desc()).limit(limit)).all()
    s = settings()
    quota_mb = s.user_quota_mb if not p.is_guest else s.guest_quota_mb
    return {"files": [{"id": r.id, "name": r.name, "size": r.size, "kind": r.kind, "sample": r.sample, "created": r.created, "expires": r.expires} for r in rows],
            "usedBytes": storage.bytes_used(p.owner), "quotaBytes": quota_mb * 1024 * 1024 if quota_mb else None}


@app.get("/api/files/{file_id}")
def file_info(file_id: str, p: Principal = Depends(principal)) -> dict:
    auth.own_file(p, file_id)
    return _with_token(storage.get_file(file_id).public())


def _with_token(d: dict) -> dict:
    """A file's description with a signed token for its picture endpoints (composites), for <img> without cookies."""
    from ..signing import sign

    return d | {"token": sign("file", d["id"])}


@app.delete("/api/files/{file_id}", status_code=204)
def delete_file(file_id: str, p: Principal = Depends(principal)) -> Response:
    auth.own_file(p, file_id)
    storage.delete_file(file_id)
    return Response(status_code=204)


@app.get("/api/files/{file_id}/content")
def file_content(file_id: str, p: Principal = Depends(principal)) -> FileResponse:
    auth.own_file(p, file_id)
    f = storage.get_file(file_id)
    return FileResponse(f.path, filename=f.name, media_type=mimetypes.guess_type(f.name)[0] or "application/octet-stream")


# ── Jobs ─────────────────────────────────────────────────────────────────────


class JobRequest(BaseModel):
    tool: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


@app.post("/api/jobs", status_code=202)
def create_job(req: JobRequest, request: Request, p: Principal = Depends(principal)) -> dict:
    from ..tools import load_all

    if req.tool not in load_all():
        raise HTTPException(400, f"Unknown tool “{req.tool}”.")
    ratelimit.check("jobs", p.owner, auth.client_ip(request))
    for v in _file_ids(req.inputs):
        auth.own_file(p, v)  # 404 for missing uploads, and for anyone else's
        storage.get_file(v)
    jid = storage.create_job(req.tool, req.inputs, req.params, owner=p.owner)
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
    from ..signing import sign_urls

    st = storage.job_status(jid)
    st.pop("trace", None)
    if st["state"] == "done":
        st["result"] = sign_urls(storage.job_result(jid), jid)  # pictures and tiles load without cookies too (signed, expiring)
    return st


def _media_access(request: Request, kind: str, ident: str, t: str | None) -> None:
    """A valid signed link (from the owner's result), or the owner (or an admin) by session; else 404."""
    from ..signing import check

    if t is not None and check(kind, ident, t):
        return
    p = principal(request)
    (auth.own_job if kind == "job" else auth.own_file)(p, ident)


@app.get("/api/jobs")
def history(p: Principal = Depends(principal), limit: int = Query(50, ge=1, le=200), before: float | None = None, tool: str | None = None) -> dict:
    """The caller's jobs, newest first (rows outlive the purged results: "expired" tells which can still be opened)."""
    q = select(db.jobs).where(db.jobs.c.owner == p.owner)
    if before is not None:
        q = q.where(db.jobs.c.created < before)
    if tool:
        q = q.where(db.jobs.c.tool == tool)
    with db.connect() as c:
        rows = c.execute(q.order_by(db.jobs.c.created.desc()).limit(limit)).all()
    return {"jobs": [{"id": r.id, "tool": r.tool, "state": r.state, "message": r.message, "name": r.name, "inputs": r.inputs, "params": r.params,
                      "created": r.created, "updated": r.updated, "seconds": r.seconds, "expires": r.expires, "expired": bool(r.purged)} for r in rows]}


@app.get("/api/jobs/{job_id}")
def job(job_id: str, p: Principal = Depends(principal)) -> dict:
    auth.own_job(p, job_id)
    return _status_with_result(job_id)


@app.delete("/api/jobs/{job_id}", status_code=204)
def delete_job(job_id: str, p: Principal = Depends(principal)) -> Response:
    with db.connect() as c:
        r = c.execute(select(db.jobs.c.owner).where(db.jobs.c.id == job_id)).first()
    if r is None or not auth.can_read(p, r.owner):
        raise KeyError(job_id)
    storage.delete_job(job_id)
    return Response(status_code=204)


@app.get("/api/jobs/{job_id}/artifacts/{name}")
def artifact(job_id: str, name: str, request: Request, t: str | None = Query(None, max_length=80)) -> FileResponse:
    _media_access(request, "job", job_id, t)
    with db.connect() as c:  # a signed link stops working once the result has been deleted or has expired
        r = c.execute(select(db.jobs.c.purged).where(db.jobs.c.id == job_id)).first()
    if r is None or r.purged:
        raise KeyError(job_id)
    path = storage.artifact_path(job_id, name)
    media = mimetypes.guess_type(path.name)[0] or ("application/geo+json" if path.suffix == ".geojson" else "application/octet-stream")
    return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/jobs/{job_id}/tiles/{name}/{z}/{x}/{y}.png")
def tile(job_id: str, name: str, z: int, x: int, y: int, request: Request, t: str | None = Query(None, max_length=80)) -> Response:
    """A 256 × 256 Web Mercator tile of a full-resolution result layer (204 when it holds no data)."""
    from ..processing.maptiles import render_tile
    from ..processing.render import png_bytes

    _media_access(request, "job", job_id, t)
    path = storage.artifact_path(job_id, f"tiles_{name}.tif")
    rgba = render_tile(path, z, x, y)
    headers = {"Cache-Control": "private, max-age=86400"}
    if rgba is None:
        return Response(status_code=204, headers=headers)
    return Response(png_bytes(rgba), media_type="image/png", headers=headers)


def include_routers() -> None:
    """Optional routers (agents, live data, maps) register here."""
    import importlib

    for mod in ("agents", "live", "maps", "rasters", "landcover", "accounts", "admin"):
        try:
            m = importlib.import_module(f"{__package__}.{mod}")
        except ModuleNotFoundError as err:
            if err.name != f"{__package__}.{mod}":
                raise
            continue
        # The built-in world maps are public reference data; everything else needs a principal (401 when signed out on a required-auth server).
        app.include_router(m.router, dependencies=[] if mod in ("maps", "accounts") else [Depends(principal)])
        if hasattr(m, "media"):  # pictures that also open by a signed link; the route checks the link or the owner itself
            app.include_router(m.media)


include_routers()


_NO_CACHE = {"Cache-Control": "no-cache"}
_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


def mount_web_app(target: FastAPI, folder: Path) -> None:
    """Serves the built web app (frontend/dist) from the API, as nginx does in docker-compose.

    Hashed files under assets/ are cached for a year; the app shell, service
    worker and manifest are revalidated so updates arrive; any other path that
    is not a file (and not /api) gets index.html.
    """
    root = folder.resolve()
    index = root / "index.html"
    if not index.is_file():
        raise RuntimeError(f"TERRAX_STATIC={folder} has no index.html; build the web app first (npm run build).")

    @target.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def web_app(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Not found.")
        f = (root / path).resolve()
        if path and f.is_file() and f.is_relative_to(root):
            headers = _IMMUTABLE if path.startswith("assets/") else _NO_CACHE if f.name in ("index.html", "sw.js", "manifest.webmanifest") else None
            return FileResponse(f, headers=headers)
        return FileResponse(index, headers=_NO_CACHE)


if (_static := settings().static_dir) is not None:
    mount_web_app(app, _static)
if job_mode() == "threads":
    start_purge_thread()
