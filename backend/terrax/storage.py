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
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

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
    with db.connect() as c:
        c.execute(db.files.insert().values(id=fid, owner=owner, name=name, size=f.size, kind=kind, sample=sample, created=f.created, expires=expiry(owner, f.created), purged=False))
    return f


def get_file(fid: str) -> StoredFile:
    p = root() / "files" / check_id(fid) / "meta.json"
    if not p.exists():
        raise KeyError(fid)
    d = read_json(p)
    d.pop("owner", None)
    return StoredFile(**d)


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
    with db.connect() as c:
        c.execute(db.jobs.insert().values(id=jid, owner=owner, tool=tool, state="queued", message="Waiting for a worker", inputs=inputs, params=_history_params(params),
                                          created=now, updated=now, expires=expiry(owner, now), purged=False))
    return jid


def _history_params(params: dict[str, Any]) -> dict[str, Any]:
    """Settings kept in the history row; drawn boundaries and other large values are left out."""
    return {k: v for k, v in params.items() if len(json.dumps(v, default=str)) <= 500}


#: Status fields mirrored into the jobs table (progress stays in the status file; it changes too often to matter later).
_DB_FIELDS = ("state", "message", "seconds", "name")


def update_job(jid: str, **changes: Any) -> dict[str, Any]:
    p = job_dir(jid) / "status.json"
    status = read_json(p)
    status.update(changes)
    status["updated"] = time.time()
    write_json(p, status)
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
    p = job_dir(jid) / "status.json"
    if not p.exists():
        raise KeyError(jid)
    return read_json(p)


def job_request(jid: str) -> dict[str, Any]:
    return read_json(job_dir(jid) / "request.json")


def job_owner(jid: str) -> str:
    return str(job_request(jid).get("owner") or "")


def job_result(jid: str) -> dict[str, Any] | None:
    p = job_dir(jid) / "result.json"
    return read_json(p) if p.exists() else None


def artifact_path(jid: str, name: str) -> Path:
    name = safe_name(name)
    p = job_dir(jid) / "artifacts" / name
    if not p.is_file():
        raise KeyError(name)
    return p


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
                gone += 1
            if ids:
                c.execute(update(table).where(table.c.id.in_(ids)).values(purged=True))
        known = {sub: {r[0] for r in c.execute(select(t.c.id))} for t, sub in ((db.files, "files"), (db.jobs, "jobs"))}
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


def delete_file(fid: str) -> None:
    from sqlalchemy import update

    from . import db

    shutil.rmtree(root() / "files" / check_id(fid), ignore_errors=True)
    with db.connect() as c:
        c.execute(update(db.files).where(db.files.c.id == fid).values(purged=True))


def delete_job(jid: str) -> None:
    from sqlalchemy import delete

    from . import db

    shutil.rmtree(job_dir(jid), ignore_errors=True)
    with db.connect() as c:
        c.execute(delete(db.jobs).where(db.jobs.c.id == jid))
