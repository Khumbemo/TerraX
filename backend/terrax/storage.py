"""File and job storage on a shared folder.

Layout (under ``Settings.storage_dir``)::

    files/<file_id>/meta.json        what was uploaded, and what it contains
    files/<file_id>/<original name>  the bytes
    jobs/<job_id>/status.json        state, progress and message
    jobs/<job_id>/result.json        the tool's result (when done)
    jobs/<job_id>/artifacts/...      pictures, GeoJSON and CSV files the result links to

The API and the Celery workers share this folder, the database (terrax.db)
and Redis, so a job can run on any worker. Writes go through a temporary file
and an atomic rename, so readers never see half-written JSON.

The database indexes every upload and job: who owns it (``u:<user id>`` or
``g:<guest>``), when it expires, and, after the folder is purged, the job's
history row. Owners decide retention: TERRAX_RETENTION_HOURS for guests,
TERRAX_USER_RETENTION_DAYS for accounts.

With TERRAX_S3_BUCKET (see objectstore.py) the folder is a cache of a bucket: uploads and finished results are copied
there, and whatever is missing here is fetched from it on first use, so machines need not share a disk and a restart
on a host whose disk does not survive one loses nothing.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import objectstore
from .config import settings

_SAFE = re.compile(r"[^A-Za-z0-9._ -]+")
_ID = re.compile(r"^[a-f0-9]{32}$")


def safe_name(name: str) -> str:
    """A file name without folders or unusual characters (keeps the extension)."""
    base = _SAFE.sub("_", os.path.basename(name.replace("\\", "/")).strip())
    if not base.strip("."):  # "", "." and ".." are not file names
        base = "file"
    return base[:180]


def new_id() -> str:
    return uuid.uuid4().hex


def check_id(value: str) -> str:
    if not _ID.match(value):
        raise KeyError(value)
    return value


def root() -> Path:
    p = settings().storage_dir
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, allow_nan=False, default=_json_default), encoding="utf-8")
    os.replace(tmp, path)


def _json_default(o: Any) -> Any:
    import numpy as np

    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, Path):
        return str(o)
    raise TypeError(f"{type(o).__name__} is not JSON serialisable")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


# ── Files ────────────────────────────────────────────────────────────────────


@dataclass
class StoredFile:
    id: str
    name: str
    size: int
    kind: str  # raster | vector | table | image | pointcloud | archive | other
    created: float
    meta: dict[str, Any] = field(default_factory=dict)
    sample: bool = False

    @property
    def folder(self) -> Path:
        return root() / "files" / self.id

    @property
    def path(self) -> Path:
        return self.folder / self.name

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        return d


def expiry(owner: str, now: float | None = None) -> float | None:
    """When an owner's new upload or job expires (None: kept until deleted)."""
    s = settings()
    now = time.time() if now is None else now
    if owner.startswith("u:"):
        return now + s.user_retention_days * 86400 if s.user_retention_days > 0 else None
    return now + s.retention_hours * 3600 if s.retention_hours > 0 else None


def bytes_used(owner: str) -> int:
    from sqlalchemy import func, select

    from . import db

    with db.connect() as c:
        return int(c.execute(select(func.coalesce(func.sum(db.files.c.size), 0)).where(db.files.c.owner == owner, db.files.c.purged.is_(False))).scalar_one())


def save_file(name: str, data_or_path: bytes | Path, sample: bool = False, owner: str = "") -> StoredFile:
    """Stores bytes (or copies a bundled file) for an owner and describes what it contains."""
    from . import db
    from .inspect import describe

    fid = new_id()
    name = safe_name(name)
    folder = root() / "files" / fid
    folder.mkdir(parents=True)
    dest = folder / name
    if isinstance(data_or_path, Path):
        shutil.copyfile(data_or_path, dest)
    else:
        dest.write_bytes(data_or_path)
    kind, meta = describe(dest)
    f = StoredFile(id=fid, name=name, size=dest.stat().st_size, kind=kind, created=time.time(), meta=meta, sample=sample)
    write_json(folder / "meta.json", f.public() | {"owner": owner})
    if objectstore.enabled():
        try:
            objectstore.upload_tree(folder)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
    with db.connect() as c:
        c.execute(db.files.insert().values(id=fid, owner=owner, name=name, size=f.size, kind=kind, sample=sample, created=f.created, expires=expiry(owner, f.created), purged=False))
    return f


def get_file(fid: str) -> StoredFile:
    folder = root() / "files" / check_id(fid)
    p = folder / "meta.json"
    if not p.exists() and not (objectstore.enabled() and objectstore.download(f"files/{fid}/meta.json")):
        raise KeyError(fid)
    d = read_json(p)
    d.pop("owner", None)
    f = StoredFile(**d)
    if objectstore.enabled():
        if not f.path.exists() and not objectstore.download(f"files/{fid}/{f.name}"):
            raise KeyError(fid)
        _touch(folder)
    return f


def _touch(folder: Path) -> None:
    """Marks a cached folder as used now (the clean-up drops local copies by this time)."""
    try:
        os.utime(folder)
    except FileNotFoundError:
        pass


# ── Jobs ─────────────────────────────────────────────────────────────────────


def job_dir(jid: str) -> Path:
    return root() / "jobs" / check_id(jid)


def create_job(tool: str, inputs: dict[str, Any], params: dict[str, Any], owner: str = "") -> str:
    from . import db

    jid = new_id()
    d = job_dir(jid)
    (d / "artifacts").mkdir(parents=True)
    now = time.time()
    write_json(d / "request.json", {"tool": tool, "inputs": inputs, "params": params, "owner": owner})
    write_json(d / "status.json", {"id": jid, "tool": tool, "state": "queued", "progress": 0.0, "message": "Waiting for a worker", "created": now, "updated": now})
    if objectstore.enabled():  # a worker on another machine reads the request from the bucket
        objectstore.upload_tree(d)
    with db.connect() as c:
        c.execute(db.jobs.insert().values(id=jid, owner=owner, tool=tool, state="queued", message="Waiting for a worker", inputs=inputs, params=_history_params(params),
                                          created=now, updated=now, expires=expiry(owner, now), purged=False))
    return jid


def _history_params(params: dict[str, Any]) -> dict[str, Any]:
    """Settings kept in the history row; drawn boundaries and other large values are left out."""
    return {k: v for k, v in params.items() if len(json.dumps(v, default=str)) <= 500}


#: Status fields mirrored into the jobs table (progress stays in the status file; it changes too often to matter later).
_DB_FIELDS = ("state", "message", "seconds", "name")


#: Finished job states: the status and result no longer change.
FINAL = ("done", "error")
#: With a bucket, progress-only status changes are copied there at most this often per job, seconds.
STATUS_EVERY_S = 3.0
_status_sent: dict[str, float] = {}
_local: set[str] = set()
_lock = threading.Lock()


def claim(jid: str) -> None:
    """Records that this process runs a job, so its status is read from this machine's disk, not the bucket."""
    with _lock:
        _local.add(jid)


def release(jid: str) -> None:
    with _lock:
        _local.discard(jid)
        _status_sent.pop(jid, None)


def fetch_job(jid: str) -> None:
    """Makes sure a job's request and status are on this disk (a worker on another machine than the API)."""
    d = job_dir(jid)
    if objectstore.enabled():
        for name in ("request.json", "status.json"):
            if not (d / name).exists() and not objectstore.download(f"jobs/{jid}/{name}"):
                raise KeyError(jid)
    (d / "artifacts").mkdir(parents=True, exist_ok=True)


def publish_job(jid: str) -> None:
    """Copies a finished job's result and artifacts to the bucket, before its status says it is done."""
    if objectstore.enabled():
        objectstore.upload_tree(job_dir(jid), skip=("status.json", "request.json"))


def save_artifacts(jid: str, *names: str) -> None:
    """Copies artifacts written after the job finished (validation samples, watersheds) to the bucket."""
    if objectstore.enabled():
        for n in names:
            objectstore.upload(job_dir(jid) / "artifacts" / safe_name(n))


def update_job(jid: str, **changes: Any) -> dict[str, Any]:
    p = job_dir(jid) / "status.json"
    status = read_json(p)
    status.update(changes)
    status["updated"] = time.time()
    write_json(p, status)
    if objectstore.enabled():
        with _lock:
            due = "state" in changes or status["updated"] - _status_sent.get(jid, 0.0) >= STATUS_EVERY_S
            if due:
                _status_sent[jid] = status["updated"]
        if due:
            objectstore.upload(p)
    mirror = {k: changes[k] for k in _DB_FIELDS if k in changes}
    if mirror:
        from sqlalchemy import update

        from . import db

        if "message" in mirror:
            mirror["message"] = str(mirror["message"])[:2000]
        with db.connect() as c:
            c.execute(update(db.jobs).where(db.jobs.c.id == jid).values(updated=status["updated"], **mirror))
    return status


def job_status(jid: str) -> dict[str, Any]:
    """A job's status. With a bucket, a job that has not finished on this disk and does not run in this process may
    be running on another machine: the newer of this disk's and the bucket's copies counts (the bucket's is not
    written here, so a job running on this machine in another process is never set back)."""
    p = job_dir(jid) / "status.json"
    local = read_json(p) if p.exists() else None
    if objectstore.enabled():
        with _lock:
            mine = jid in _local
        if not mine and (local is None or local.get("state") not in FINAL):
            raw = objectstore.read_bytes(f"jobs/{jid}/status.json")
            remote = json.loads(raw) if raw else None
            if remote is not None and (local is None or remote.get("updated", 0) >= local.get("updated", 0)):
                local = remote
        if p.exists():
            _touch(job_dir(jid))
    if local is None:
        raise KeyError(jid)
    return local


def job_request(jid: str) -> dict[str, Any]:
    p = job_dir(jid) / "request.json"
    if not p.exists() and not (objectstore.enabled() and objectstore.download(f"jobs/{jid}/request.json")):
        raise KeyError(jid)
    return read_json(p)


def job_owner(jid: str) -> str:
    return str(job_request(jid).get("owner") or "")


def job_result(jid: str) -> dict[str, Any] | None:
    p = job_dir(jid) / "result.json"
    if not p.exists() and not (objectstore.enabled() and objectstore.download(f"jobs/{check_id(jid)}/result.json")):
        return None
    return read_json(p)


def artifact_path(jid: str, name: str) -> Path:
    """A result file on this disk (fetched from the bucket on first use); KeyError when there is none."""
    name = safe_name(name)
    p = job_dir(jid) / "artifacts" / name
    if not p.is_file() and not (objectstore.enabled() and objectstore.download(f"jobs/{jid}/artifacts/{name}")):
        raise KeyError(name)
    return p


def has_artifact(jid: str, name: str) -> bool:
    try:
        artifact_path(jid, name)
        return True
    except KeyError:
        return False


def purge_old(hours: int | None = None) -> int:
    """Deletes expired uploads and job folders; returns how many folders went.

    Expiry comes from the database (by owner: guests after TERRAX_RETENTION_HOURS, accounts after
    TERRAX_USER_RETENTION_DAYS). A job's history row stays, marked purged. Folders the database does not know (left
    by an older version) go by age, after `hours` (TERRAX_RETENTION_HOURS).
    """
    from sqlalchemy import select, update

    from . import db

    now = time.time()
    gone = 0
    with db.connect() as c:
        for table, sub in ((db.files, "files"), (db.jobs, "jobs")):
            ids = [r[0] for r in c.execute(select(table.c.id).where(table.c.purged.is_(False), table.c.expires.is_not(None), table.c.expires < now))]
            for i in ids:
                shutil.rmtree(root() / sub / i, ignore_errors=True)
                if objectstore.enabled():
                    objectstore.delete_tree(f"{sub}/{i}")
                gone += 1
            if ids:
                c.execute(update(table).where(table.c.id.in_(ids)).values(purged=True))
        known = {sub: {r[0] for r in c.execute(select(t.c.id))} for t, sub in ((db.files, "files"), (db.jobs, "jobs"))}
        unfinished = {r[0] for r in c.execute(select(db.jobs.c.id).where(db.jobs.c.state.not_in(FINAL)))}
    if objectstore.enabled():
        _evict(now - settings().s3_cache_hours * 3600, unfinished)
    hours = settings().retention_hours if hours is None else hours
    if hours > 0:
        cutoff = now - hours * 3600
        for sub in ("files", "jobs"):
            base = root() / sub
            if not base.exists():
                continue
            for d in base.iterdir():
                try:
                    if d.is_dir() and d.name not in known[sub] and d.stat().st_mtime < cutoff:
                        shutil.rmtree(d, ignore_errors=True)
                        gone += 1
                except FileNotFoundError:
                    pass
    for t in root().glob("*.upload"):  # interrupted uploads
        try:
            if t.stat().st_mtime < now - 86400:
                t.unlink()
        except FileNotFoundError:
            pass
    return gone


def _evict(cutoff: float, unfinished: set[str]) -> int:
    """Drops local copies of bucket objects not used since `cutoff` (never a job that has not finished)."""
    n = 0
    for sub in ("files", "jobs"):
        base = root() / sub
        if not base.exists():
            continue
        for d in base.iterdir():
            try:
                if d.is_dir() and d.name not in unfinished and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
                    n += 1
            except FileNotFoundError:
                pass
    return n


def delete_file(fid: str) -> None:
    from sqlalchemy import update

    from . import db

    shutil.rmtree(root() / "files" / check_id(fid), ignore_errors=True)
    if objectstore.enabled():
        objectstore.delete_tree(f"files/{fid}")
    with db.connect() as c:
        c.execute(update(db.files).where(db.files.c.id == fid).values(purged=True))


def delete_job(jid: str) -> None:
    from sqlalchemy import delete

    from . import db

    shutil.rmtree(job_dir(jid), ignore_errors=True)
    if objectstore.enabled():
        objectstore.delete_tree(f"jobs/{jid}")
    with db.connect() as c:
        c.execute(delete(db.jobs).where(db.jobs.c.id == jid))
