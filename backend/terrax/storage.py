"""File and job storage on a shared folder.

Layout (under ``Settings.storage_dir``)::

    files/<file_id>/meta.json        what was uploaded, and what it contains
    files/<file_id>/<original name>  the bytes
    jobs/<job_id>/status.json        state, progress and message
    jobs/<job_id>/result.json        the tool's result (when done)
    jobs/<job_id>/artifacts/...      pictures, GeoJSON and CSV files the result links to

The API and the Celery workers only share this folder (and Redis), so a job
can run on any worker. Writes go through a temporary file and an atomic
rename, so readers never see half-written JSON.
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
    kind: str  # raster | vector | table | image | archive | other
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


def save_file(name: str, data_or_path: bytes | Path, sample: bool = False) -> StoredFile:
    """Stores bytes (or copies a bundled file) and describes what it contains."""
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
    write_json(folder / "meta.json", f.public())
    return f


def get_file(fid: str) -> StoredFile:
    p = root() / "files" / check_id(fid) / "meta.json"
    if not p.exists():
        raise KeyError(fid)
    d = read_json(p)
    return StoredFile(**d)


# ── Jobs ─────────────────────────────────────────────────────────────────────


def job_dir(jid: str) -> Path:
    return root() / "jobs" / check_id(jid)


def create_job(tool: str, inputs: dict[str, Any], params: dict[str, Any]) -> str:
    jid = new_id()
    d = job_dir(jid)
    (d / "artifacts").mkdir(parents=True)
    now = time.time()
    write_json(d / "request.json", {"tool": tool, "inputs": inputs, "params": params})
    write_json(d / "status.json", {"id": jid, "tool": tool, "state": "queued", "progress": 0.0, "message": "Waiting for a worker", "created": now, "updated": now})
    return jid


def update_job(jid: str, **changes: Any) -> dict[str, Any]:
    p = job_dir(jid) / "status.json"
    status = read_json(p)
    status.update(changes)
    status["updated"] = time.time()
    write_json(p, status)
    return status


def job_status(jid: str) -> dict[str, Any]:
    p = job_dir(jid) / "status.json"
    if not p.exists():
        raise KeyError(jid)
    return read_json(p)


def job_request(jid: str) -> dict[str, Any]:
    return read_json(job_dir(jid) / "request.json")


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
    """Deletes uploads and jobs older than the retention period; returns how many folders went."""
    hours = settings().retention_hours if hours is None else hours
    if hours <= 0:
        return 0
    cutoff = time.time() - hours * 3600
    gone = 0
    for sub in ("files", "jobs"):
        base = root() / sub
        if not base.exists():
            continue
        for d in base.iterdir():
            try:
                if d.is_dir() and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
                    gone += 1
            except FileNotFoundError:
                pass
    return gone
