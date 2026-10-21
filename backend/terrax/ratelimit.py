"""Request limits: fixed windows per key (a user or guest, and a client address).

The counters must be shared by every API process and machine, or running several would multiply the limits. They
live in Redis when jobs go through Redis (Celery mode), and otherwise in the database (one row per key and window,
incremented atomically), which every process already shares. TERRAX_RATE_LIMIT_STORE=memory keeps them in this
process (one process only). A refused request gets HTTP 429 with Retry-After. TERRAX_RATE_LIMITS=false switches the
limits off.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException

from .config import settings


@dataclass(frozen=True)
class Limit:
    name: str
    count: int
    seconds: int
    what: str  # for the message: "jobs", "uploads", …


def _limits() -> dict[str, Limit]:
    s = settings()
    return {
        "jobs": Limit("jobs", s.jobs_per_minute, 60, "analyses"),
        "uploads": Limit("uploads", s.uploads_per_hour, 3600, "uploads"),
        "login": Limit("login", 10, 900, "sign-in attempts"),  # per address and per e-mail: brute-force guessing
        "signup": Limit("signup", 5, 3600, "new accounts"),
        "mail": Limit("mail", 5, 3600, "e-mails"),  # reset and confirmation links: no mail bombing
        "live": Limit("live", 60, 60, "live-data requests"),  # outside services (Open-Meteo, NASA, STAC) have their own limits
        "ai": Limit("ai", 20, 60, "assistant questions"),  # Gemini costs money per call
        "client_errors": Limit("client_errors", 30, 60, "error reports"),
        "interactive": Limit("interactive", 600, 60, "requests"),  # watershed clicks, pixel inspection, samples
    }


class _MemoryCounter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._windows: dict[str, tuple[int, int]] = {}  # key → (window index, count)

    def hit(self, key: str, seconds: int) -> tuple[int, int]:
        """(count in the current window after this hit, seconds until the window ends)."""
        now = time.time()
        window = int(now // seconds)
        with self._lock:
            w, n = self._windows.get(key, (window, 0))
            n = n + 1 if w == window else 1
            self._windows[key] = (window, n)
            if len(self._windows) > 50_000:  # forget finished windows
                self._windows = {k: v for k, v in self._windows.items() if v[0] == window}
        return n, int((window + 1) * seconds - now) + 1

    def reset(self) -> None:
        with self._lock:
            self._windows.clear()


_memory = _MemoryCounter()
_redis_client = None
_redis_checked = 0.0


def _redis():
    """A Redis client when jobs go through Redis (Celery mode) and it answers; re-checked once a minute."""
    global _redis_client, _redis_checked
    from .tasks import job_mode

    if job_mode() != "celery":
        return None
    now = time.time()
    if _redis_client is None and now - _redis_checked > 60:
        _redis_checked = now
        try:
            import redis

            c = redis.Redis.from_url(settings().redis_url, socket_connect_timeout=0.5, socket_timeout=0.5)
            c.ping()
            _redis_client = c
        except Exception:
            _redis_client = None
    return _redis_client


def _db_hit(key: str, seconds: int) -> tuple[int, int]:
    """Atomic upsert of the window's counter (INSERT … ON CONFLICT DO UPDATE … RETURNING, SQLite ≥ 3.35 and PostgreSQL)."""
    from . import db

    now = time.time()
    start = int(now // seconds) * seconds
    with db.connect() as c:
        dialect = c.dialect.name
        values = {"key": key[:200], "window": start, "count": 1}
        bump = {"count": db.rate_counters.c.count + 1}
        if dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            pg = pg_insert(db.rate_counters).values(**values)
            n = int(c.execute(pg.on_conflict_do_update(index_elements=["key", "window"], set_=bump).returning(db.rate_counters.c.count)).scalar_one())
        else:
            from sqlalchemy.dialects.sqlite import insert as sqlite_insert

            lite = sqlite_insert(db.rate_counters).values(**values)
            n = int(c.execute(lite.on_conflict_do_update(index_elements=["key", "window"], set_=bump).returning(db.rate_counters.c.count)).scalar_one())
    return n, int(start + seconds - now) + 1


def purge_counters() -> int:
    """Deletes counters of windows that ended over a day ago."""
    from sqlalchemy import delete

    from . import db

    with db.connect() as c:
        return int(c.execute(delete(db.rate_counters).where(db.rate_counters.c.window < time.time() - 86400)).rowcount or 0)


def store() -> str:
    """Where the counters live: "redis", "database" or "memory"."""
    choice = settings().rate_limit_store
    if choice in ("memory", "database"):
        return choice
    if choice in ("auto", "redis") and _redis() is not None:
        return "redis"
    return "database"


def _hit(key: str, seconds: int) -> tuple[int, int]:
    where = store()
    if where == "memory":
        return _memory.hit(key, seconds)
    if where == "database":
        try:
            return _db_hit(key, seconds)
        except Exception:  # a database hiccup must not refuse or crash requests: count in this process meanwhile
            return _memory.hit(key, seconds)
    r = _redis()
    if r is not None:
        try:
            window = int(time.time() // seconds)
            k = f"terrax:rl:{key}:{window}"
            pipe = r.pipeline()
            pipe.incr(k)
            pipe.expire(k, seconds + 5)
            n, _ = pipe.execute()
            return int(n), int((window + 1) * seconds - time.time()) + 1
        except Exception:  # Redis gone: fall back to the database
            pass
    try:
        return _db_hit(key, seconds)
    except Exception:
        return _memory.hit(key, seconds)


def check(name: str, *keys: str) -> None:
    """Counts one request against limit `name` for each key; HTTP 429 when any of them is over."""
    if not settings().rate_limits:
        return
    lim = _limits()[name]
    for key in keys:
        if not key:
            continue
        n, retry = _hit(f"{name}:{key}", lim.seconds)
        if n > lim.count:
            from .monitoring import metrics

            metrics.count("rate_limited")
            period = "minute" if lim.seconds == 60 else "hour" if lim.seconds == 3600 else f"{lim.seconds // 60} minutes"
            raise HTTPException(429, f"Too many {lim.what}: at most {lim.count} per {period}. Try again in {retry} s.", headers={"Retry-After": str(retry)})


def reset() -> None:
    """Clears the counters (tests)."""
    _memory.reset()
    from sqlalchemy import delete

    from . import db

    with db.connect() as c:
        c.execute(delete(db.rate_counters))
