"""Request limits: fixed windows per key (a user or guest, and a client address).

With Redis configured (Celery mode) the counters live in Redis, so every API process shares them; otherwise they
are kept in this process. A refused request gets HTTP 429 with Retry-After. TERRAX_RATE_LIMITS=false switches
the limits off.
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


def _hit(key: str, seconds: int) -> tuple[int, int]:
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
        except Exception:  # Redis gone: fall back to this process
            pass
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
    """Clears the in-process counters (tests)."""
    _memory.reset()
