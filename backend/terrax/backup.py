"""Database backups: a consistent copy of every lasting table, as gzipped JSON lines, kept in rotation.

A backup is logical (rows, not database pages), so one made on SQLite restores into PostgreSQL and back. Every
TERRAX_BACKUP_HOURS the hourly clean-up (the Celery beat task, or the API's own thread without Celery) makes one when
the newest is older than that, and keeps the newest TERRAX_BACKUP_KEEP. They go to ``<prefix>backups/`` in the bucket
when there is one (see objectstore.py), else to TERRAX_BACKUP_DIR (default storage/backups, which is only safe from
losing the server's disk when that folder is on another disk or is copied off the machine).

``python -m terrax.manage backup`` makes one now, ``backups`` lists them and ``restore NAME --yes`` replaces every
row of the database with a backup's. With TERRAX_BACKUP_RESTORE_EMPTY=true, a server that starts with an empty
database (a host whose disk does not survive a restart, with SQLite) restores the newest backup by itself.

The file: a header line ``{"format": "terrax-backup", "version": 1, "revision": …, "created": …, "tables": {…}}``
with the row count of each table, then one ``{"t": table, "r": {column: value}}`` line per row, parents before the
tables that refer to them. Short-lived tables (rate-limit counters, single-sign-on round trips) are left out. Uploads
and results are not in it: the bucket keeps those, and the database only indexes them.
"""

from __future__ import annotations

import calendar
import gzip
import io
import json
import logging
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, Engine, Integer, Table, create_engine, delete, func, insert, inspect, select, text

from . import db, objectstore
from .config import settings

log = logging.getLogger("terrax.backup")

FORMAT = "terrax-backup"
VERSION = 1
PREFIX = "terrax-db-"
SUFFIX = ".jsonl.gz"
#: Tables whose rows only matter for minutes (counters, sign-in round trips): not backed up, emptied on restore.
TRANSIENT = ("rate_counters", "oidc_states")


def tables() -> list[Table]:
    """The tables a backup holds, parents first (so rows can be inserted in this order)."""
    return [t for t in db.metadata.sorted_tables if t.name not in TRANSIENT]


def _revision(c: Connection) -> str | None:
    from alembic.runtime.migration import MigrationContext

    return MigrationContext.configure(c).get_current_revision()


@contextmanager
def _snapshot(eng: Engine) -> Iterator[Connection]:
    """A connection that sees one moment of the database for all its reads. SQLite: a copy made with its online
    backup API (pysqlite runs SELECTs outside a transaction, so separate reads would not share a snapshot); other
    databases: a REPEATABLE READ transaction."""
    if eng.dialect.name != "sqlite":
        with eng.connect().execution_options(isolation_level="REPEATABLE READ") as c, c.begin():
            yield c
        return
    import sqlite3

    with tempfile.TemporaryDirectory(dir=settings().storage_dir) as tmp:
        copy = Path(tmp) / "snapshot.db"
        raw = eng.raw_connection()
        try:
            src = raw.driver_connection
            if not isinstance(src, sqlite3.Connection):
                raise RuntimeError("expected the sqlite3 driver")
            dst = sqlite3.connect(copy)
            src.backup(dst)
            dst.close()
        finally:
            raw.close()
        snap = create_engine(f"sqlite:///{copy}")
        try:
            with snap.connect() as c:
                yield c
        finally:
            snap.dispose()


def dump(eng: Engine | None = None) -> tuple[bytes, dict[str, Any]]:
    """The backup file's bytes and its header."""
    eng = eng or db.engine()
    raw = io.BytesIO()
    with _snapshot(eng) as c:
        counts = {t.name: int(c.execute(select(func.count()).select_from(t)).scalar_one()) for t in tables()}
        header = {"format": FORMAT, "version": VERSION, "revision": _revision(c), "created": time.time(), "dialect": eng.dialect.name, "tables": counts}
        with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
            gz.write((json.dumps(header) + "\n").encode())
            for t in tables():
                pk = list(t.primary_key.columns)
                for r in c.execute(select(t).order_by(*pk)):
                    gz.write((json.dumps({"t": t.name, "r": dict(r._mapping)}, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    return raw.getvalue(), header


def _read(data: bytes) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    lines = gzip.decompress(data).decode("utf-8").splitlines()
    if not lines:
        raise ValueError("The backup is empty.")
    header = json.loads(lines[0])
    if header.get("format") != FORMAT:
        raise ValueError("This is not a TerraX database backup.")
    if int(header.get("version", 0)) > VERSION:
        raise ValueError("The backup was made by a newer TerraX; upgrade this server first.")
    rows: dict[str, list[dict[str, Any]]] = {}
    for line in lines[1:]:
        if line:
            d = json.loads(line)
            rows.setdefault(d["t"], []).append(d["r"])
    for name, n in header.get("tables", {}).items():
        if len(rows.get(name, [])) != n:
            raise ValueError(f"The backup is incomplete: {name} has {len(rows.get(name, []))} rows of {n}.")
    return header, rows


def _known_revisions() -> list[str]:
    """Schema revisions, oldest first."""
    from alembic.script import ScriptDirectory

    return [r.revision for r in reversed(list(ScriptDirectory.from_config(db.alembic_config()).walk_revisions()))]


def load(data: bytes, eng: Engine | None = None) -> dict[str, int]:
    """Replaces every row of the backed-up (and short-lived) tables with the backup's, in one transaction; returns
    the rows restored per table. A backup from an older schema revision restores (TerraX's revisions only add
    tables and columns, which take their defaults); one from a newer revision is refused."""
    eng = eng or db.engine()
    header, rows = _read(data)
    with eng.begin() as c:
        known, here = _known_revisions(), _revision(c)
        rev = header.get("revision")
        if rev not in known:
            raise ValueError(f"The backup's schema revision {rev} is unknown to this TerraX; upgrade the server first.")
        if here in known and known.index(rev) > known.index(here):
            raise ValueError(f"The backup is at schema revision {rev}, newer than this database ({here}); upgrade the server first.")
        present = set(inspect(c).get_table_names())
        everything = [t for t in db.metadata.sorted_tables if t.name in present]
        for t in reversed(everything):  # children first
            c.execute(delete(t))
        out = {}
        for t in tables():
            batch = rows.get(t.name, [])
            if t.name not in present:
                continue
            cols = set(t.columns.keys())
            batch = [{k: v for k, v in r.items() if k in cols} for r in batch]
            for i in range(0, len(batch), 500):
                c.execute(insert(t), batch[i : i + 500])
            out[t.name] = len(batch)
        if eng.dialect.name == "postgresql":  # explicit ids leave the serial sequences behind; move them past the rows
            for t in tables():
                pk = list(t.primary_key.columns)
                if len(pk) == 1 and isinstance(pk[0].type, Integer):
                    col = pk[0]
                    c.execute(text(f"SELECT setval(pg_get_serial_sequence('{t.name}', '{col.name}'), COALESCE(MAX({col.name}), 1), MAX({col.name}) IS NOT NULL) FROM {t.name}"))
    return out


# ── Where backups live ───────────────────────────────────────────────────────


def _folder() -> Path:
    s = settings()
    p = s.backup_dir or s.storage_dir / "backups"
    p.mkdir(parents=True, exist_ok=True)
    return p


def list_backups() -> list[dict[str, Any]]:
    """Backups, newest first: name, size (bytes, local only) and when it was made (from the name)."""
    if objectstore.enabled():
        names = [k.rsplit("/", 1)[-1] for k in objectstore.list_keys("backups/")]
        sizes: dict[str, int | None] = dict.fromkeys(names)
    else:
        files = list(_folder().glob(f"{PREFIX}*{SUFFIX}"))
        names = [f.name for f in files]
        sizes = {f.name: f.stat().st_size for f in files}
    out = []
    for n in sorted((n for n in names if n.startswith(PREFIX) and n.endswith(SUFFIX)), reverse=True):
        try:
            made = float(calendar.timegm(time.strptime(n[len(PREFIX) : -len(SUFFIX)], "%Y%m%dT%H%M%SZ")))
        except ValueError:
            continue
        out.append({"name": n, "size": sizes.get(n), "created": made})
    return out


def _name(when: float) -> str:
    return f"{PREFIX}{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(when))}{SUFFIX}"


def create() -> dict[str, Any]:
    """Makes a backup now, stores it and deletes the oldest beyond TERRAX_BACKUP_KEEP; returns what was made."""
    data, header = dump()
    name = _name(header["created"])
    if objectstore.enabled():
        objectstore.put_bytes(f"backups/{name}", data)
    else:
        p = _folder() / name
        tmp = p.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)
    removed = []
    for old in list_backups()[settings().backup_keep :]:
        if objectstore.enabled():
            objectstore.delete(f"backups/{old['name']}")
        else:
            (_folder() / old["name"]).unlink(missing_ok=True)
        removed.append(old["name"])
    log.info("database backup %s (%d bytes, %d rows)", name, len(data), sum(header["tables"].values()))
    return {"name": name, "size": len(data), "rows": header["tables"], "revision": header["revision"], "removed": removed}


def read(name: str) -> bytes:
    """A stored backup's bytes, by name, or a backup file's by path."""
    p = Path(name)
    if p.is_file():
        return p.read_bytes()
    if Path(name).name != name or not (name.startswith(PREFIX) and name.endswith(SUFFIX)):
        raise KeyError(name)
    if objectstore.enabled():
        data = objectstore.read_bytes(f"backups/{name}")
        if data is None:
            raise KeyError(name)
        return data
    f = _folder() / name
    if not f.is_file():
        raise KeyError(name)
    return f.read_bytes()


def due(now: float | None = None) -> bool:
    """Whether the schedule calls for a backup: on, and the newest is at least TERRAX_BACKUP_HOURS old (or none)."""
    hours = settings().backup_hours
    if hours <= 0:
        return False
    newest = list_backups()[:1]
    now = time.time() if now is None else now
    return not newest or now - newest[0]["created"] >= hours * 3600 - 60  # a minute's slack for the hourly tick


def run_if_due() -> dict[str, Any] | None:
    return create() if due() else None


def restore_if_empty(eng: Engine) -> dict[str, int] | None:
    """At start-up (TERRAX_BACKUP_RESTORE_EMPTY): the newest backup goes into a database that has no rows at all."""
    with eng.connect() as c:
        if any(c.execute(select(func.count()).select_from(t)).scalar_one() for t in tables()):
            return None
    newest = list_backups()[:1]
    if not newest:
        return None
    out = load(read(newest[0]["name"]), eng)
    log.warning("restored the empty database from backup %s (%d rows)", newest[0]["name"], sum(out.values()))
    return out
