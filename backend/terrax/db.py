"""The TerraX database: accounts, sessions, the index of uploads and jobs (history), projects and recorded errors.

SQLite in the storage folder by default (one file, no server, fine for one machine with the API and the workers
sharing a disk); set DATABASE_URL to a PostgreSQL URL (``postgresql+psycopg://user:pass@host/db``, with
``pip install 'terrax[postgres]'``) when the API and workers run on several machines. Tables are created on first
use, and later schema changes are applied by the numbered migrations below, recorded in ``schema_version``.

The bytes of uploads and results stay in the storage folder; the database says who owns them, keeps them findable
after the folder is purged (job history), and decides when they expire.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Connection,
    Engine,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    create_engine,
    event,
    select,
)

from .config import settings

metadata = MetaData()

users = Table(
    "users", metadata,
    Column("id", String(32), primary_key=True),
    Column("email", String(254), nullable=False, unique=True),  # stored lower-case
    Column("name", String(120), nullable=False, default=""),
    Column("password_hash", String(255), nullable=False),
    Column("role", String(16), nullable=False, default="user"),  # user | admin
    Column("disabled", Boolean, nullable=False, default=False),
    Column("created", Float, nullable=False),
    Column("last_login", Float),
)

sessions = Table(
    "sessions", metadata,
    Column("token_hash", String(64), primary_key=True),  # SHA-256 of the cookie value; the token itself is never stored
    Column("user_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("created", Float, nullable=False),
    Column("expires", Float, nullable=False),
    Column("last_seen", Float, nullable=False),
    Column("ip", String(64), nullable=False, default=""),
    Column("user_agent", String(300), nullable=False, default=""),
)

files = Table(
    "files", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner", String(70), nullable=False, index=True),  # "u:<user id>" or "g:<guest hash>"
    Column("name", String(200), nullable=False),
    Column("size", Integer, nullable=False),
    Column("kind", String(20), nullable=False),
    Column("sample", Boolean, nullable=False, default=False),
    Column("created", Float, nullable=False),
    Column("expires", Float),  # None: kept until deleted
    Column("purged", Boolean, nullable=False, default=False),
)

jobs = Table(
    "jobs", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner", String(70), nullable=False),
    Column("tool", String(40), nullable=False),
    Column("state", String(12), nullable=False),  # queued | running | done | error
    Column("message", Text, nullable=False, default=""),
    Column("name", String(300), nullable=False, default=""),  # what the result was called (file names), for the history list
    Column("inputs", JSON, nullable=False),
    Column("params", JSON, nullable=False),
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
    Column("seconds", Float),
    Column("expires", Float),
    Column("purged", Boolean, nullable=False, default=False),
    Index("ix_jobs_owner_created", "owner", "created"),
)

projects = Table(
    "projects", metadata,
    Column("id", String(32), primary_key=True),
    Column("owner", String(32), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("name", String(200), nullable=False),
    Column("data", JSON, nullable=False),  # the same document the web app exports as .terrax.json
    Column("created", Float, nullable=False),
    Column("updated", Float, nullable=False),
)

project_shares = Table(
    "project_shares", metadata,
    Column("project_id", String(32), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", String(32), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("can_edit", Boolean, nullable=False, default=False),
)

errors = Table(
    "errors", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("at", Float, nullable=False, index=True),
    Column("source", String(12), nullable=False),  # server | worker | client
    Column("kind", String(120), nullable=False),  # exception type, or the browser's error name
    Column("message", Text, nullable=False),
    Column("detail", Text, nullable=False, default=""),  # traceback or stack (trimmed)
    Column("path", String(300), nullable=False, default=""),  # request path, job tool, or page URL path
    Column("request_id", String(40), nullable=False, default=""),
    Column("owner", String(70), nullable=False, default=""),
)

schema_version = Table("schema_version", metadata, Column("version", Integer, primary_key=True), Column("applied", Float, nullable=False))

#: Schema changes after the first release, in order: (version, SQL statements). Version 1 is ``create_all``.
MIGRATIONS: list[tuple[int, list[str]]] = []

_engines: dict[str, Engine] = {}
_lock = threading.Lock()


def database_url() -> str:
    s = settings()
    return s.database_url or f"sqlite:///{s.storage_dir / 'terrax.db'}"


def engine() -> Engine:
    """The engine for the configured database, created (with its tables) on first use."""
    url = database_url()
    eng = _engines.get(url)
    if eng is not None:
        return eng
    with _lock:
        if url in _engines:
            return _engines[url]
        if url.startswith("sqlite"):
            settings().storage_dir.mkdir(parents=True, exist_ok=True)
            eng = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

            @event.listens_for(eng, "connect")
            def _sqlite_pragmas(conn, _record) -> None:
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")  # readers do not block the writer (API and workers share the file)
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=30000")
                cur.close()
        else:
            eng = create_engine(url, pool_pre_ping=True)
        _migrate(eng)
        _engines[url] = eng
        return eng


def _migrate(eng: Engine) -> None:
    metadata.create_all(eng)
    with eng.begin() as c:
        done = {r[0] for r in c.execute(select(schema_version.c.version))}
        if 1 not in done:
            c.execute(schema_version.insert().values(version=1, applied=time.time()))
        for version, statements in MIGRATIONS:
            if version in done:
                continue
            for sql in statements:
                c.exec_driver_sql(sql)
            c.execute(schema_version.insert().values(version=version, applied=time.time()))


@contextmanager
def connect() -> Iterator[Connection]:
    """A connection in one transaction (committed on success, rolled back on error)."""
    with engine().begin() as c:
        yield c


def ping() -> bool:
    try:
        with engine().connect() as c:
            c.exec_driver_sql("SELECT 1")
        return True
    except Exception:
        return False


def row(r: Any) -> dict[str, Any] | None:
    return dict(r._mapping) if r is not None else None


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
